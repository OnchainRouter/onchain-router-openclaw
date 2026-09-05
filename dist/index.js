// src/index.ts
import { createHash } from "crypto";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// src/catalog.ts
var MAX_CATALOG_BYTES = 4 * 1024 * 1024;
var MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
async function boundedJson(response) {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && BigInt(declared) > BigInt(MAX_CATALOG_BYTES))
    throw new Error("buyer proxy catalog exceeds the size limit");
  if (!response.body) throw new Error("buyer proxy catalog is empty");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CATALOG_BYTES) {
      await reader.cancel();
      throw new Error("buyer proxy catalog exceeds the size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("buyer proxy catalog is malformed");
  }
}
async function fetchProxyModels(origin, token, fetchImplementation = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1e4);
  timer.unref();
  let value;
  try {
    const response = await fetchImplementation(`${origin}/v1/models`, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok)
      throw new Error(`buyer proxy catalog returned HTTP ${response.status}`);
    value = await boundedJson(response);
  } finally {
    clearTimeout(timer);
  }
  if (typeof value !== "object" || value === null || !Array.isArray(value.data))
    throw new Error("buyer proxy catalog is malformed");
  const models = [];
  for (const item of value.data) {
    if (typeof item !== "object" || item === null)
      throw new Error("buyer proxy model is malformed");
    const entry = item;
    if (typeof entry["id"] !== "string" || !MODEL.test(entry["id"]) || !Array.isArray(entry["supported_endpoints"]) || !entry["supported_endpoints"].every(
      (endpoint) => typeof endpoint === "string"
    ))
      throw new Error("buyer proxy model is malformed");
    if (!entry["supported_endpoints"].includes("/v1/chat/completions"))
      continue;
    if (models.some((model) => model.id === entry["id"]))
      throw new Error("buyer proxy model is duplicated");
    const rawMaximum = entry["max_output_tokens"];
    const maximum = typeof rawMaximum === "number" ? rawMaximum : typeof rawMaximum === "string" && /^\d+$/.test(rawMaximum) ? Number(rawMaximum) : 8192;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1e6)
      throw new Error("buyer proxy model output limit is invalid");
    const capabilities = Array.isArray(entry["capabilities"]) ? entry["capabilities"].filter(
      (item2) => typeof item2 === "string"
    ) : ["text"];
    models.push({ id: entry["id"], capabilities, maxOutputTokens: maximum });
  }
  if (models.length === 0)
    throw new Error("buyer proxy exposes no chat models");
  return Object.freeze(
    models.sort((left, right) => left.id.localeCompare(right.id))
  );
}

// src/config.ts
import { lstatSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
var TOKEN = /^[A-Za-z0-9_-]{43}$/;
function parseConfig(value) {
  const configuredOrigin = value?.["proxyOrigin"] ?? "http://127.0.0.1:8402";
  if (typeof configuredOrigin !== "string") throw new Error("proxyOrigin must be a string");
  let url;
  try {
    url = new URL(configuredOrigin);
  } catch {
    throw new Error("proxyOrigin is invalid");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || configuredOrigin.endsWith("/"))
    throw new Error("proxyOrigin must be a credential-free 127.0.0.1 HTTP origin");
  const configuredToken = value?.["tokenFile"];
  if (configuredToken !== void 0 && typeof configuredToken !== "string")
    throw new Error("tokenFile must be a string");
  const tokenFile = configuredToken ?? join(homedir(), ".onchain-router", "proxy-token");
  const absolute = isAbsolute(tokenFile) ? resolve(tokenFile) : resolve(tokenFile);
  const configuredProfile = value?.["profileDirectory"];
  if (configuredProfile !== void 0 && typeof configuredProfile !== "string")
    throw new Error("profileDirectory must be a string");
  const profileDirectory = resolve(configuredProfile ?? dirname(absolute));
  const configuredManagement = value?.["manageProxy"] ?? true;
  if (typeof configuredManagement !== "boolean") throw new Error("manageProxy must be boolean");
  if (configuredManagement && absolute !== join(profileDirectory, "proxy-token"))
    throw new Error("managed proxy tokenFile must be profileDirectory/proxy-token");
  return {
    proxyOrigin: url.origin,
    tokenFile: absolute,
    profileDirectory,
    manageProxy: configuredManagement
  };
}
function readProxyToken(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error("proxy token must be a regular non-symlink file");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    throw new Error("proxy token must be owned by the current user");
  if ((metadata.mode & 63) !== 0) throw new Error("proxy token permissions must be 0600");
  if (metadata.size < 43 || metadata.size > 128) throw new Error("proxy token file size is invalid");
  const token = readFileSync(path, "utf8").trim();
  if (!TOKEN.test(token)) throw new Error("proxy token is malformed");
  return token;
}

// src/api.ts
var MAX_FREE_RESPONSE_BYTES = 4 * 1024 * 1024;
var MAX_PAID_RESPONSE_BYTES = 32 * 1024 * 1024;
var SAFE_HEADERS = [
  "x-onchain-router-idempotency-key",
  "x-onchain-router-outcome",
  "x-onchain-router-retry",
  "x-onchain-router-cache",
  "x-onchain-router-charge-atomic",
  "x-onchain-router-source-receipt-id",
  "x-receipt-id",
  "x-payment-network",
  "x-payment-maximum-atomic",
  "x-payment-actual-atomic",
  "x-payment-transaction"
];
var FREE_PATHS = /* @__PURE__ */ new Set(["/v1/models", "/v1/pricing", "/v1/audio/voices"]);
var PAID_PATHS = /* @__PURE__ */ new Set([
  "/v1/images/generations",
  "/v1/audio/speech",
  "/v1/audio/transcriptions"
]);
var IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
async function readBoundedJson(response, maximum) {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maximum)
    throw new Error("buyer proxy response exceeds its byte limit");
  if (!response.body) throw new Error("buyer proxy response has no body");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      throw new Error("buyer proxy response exceeds its byte limit");
    }
    chunks.push(part.value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new Error("buyer proxy response is not valid JSON");
  }
}
function safeError(value, status) {
  let code = "buyer_proxy_error";
  if (typeof value === "object" && value !== null) {
    const error = value["error"];
    if (typeof error === "object" && error !== null) {
      const candidate = error["code"];
      if (typeof candidate === "string" && candidate.length <= 128 && /^[A-Za-z0-9_]+$/.test(candidate))
        code = candidate;
    }
  }
  return { code, message: `buyer proxy returned HTTP ${status}` };
}
function projectedHeaders(headers) {
  const result2 = {};
  for (const name of SAFE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) result2[name] = value;
  }
  return result2;
}
function authHeaders(config, readToken) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${readToken(config.tokenFile)}`
  };
}
async function getFree(config, path, options = {}) {
  if (!FREE_PATHS.has(path)) throw new Error("unsupported free proxy path");
  const fetchImpl = options.fetch ?? fetch;
  const readToken = options.readToken ?? readProxyToken;
  try {
    const response = await fetchImpl(`${config.proxyOrigin}${path}`, {
      method: "GET",
      headers: authHeaders(config, readToken),
      redirect: "error",
      cache: "no-store",
      signal: options.signal ?? null
    });
    const value = await readBoundedJson(response, MAX_FREE_RESPONSE_BYTES);
    if (response.status !== 200)
      return { ok: false, status: response.status, error: safeError(value, response.status) };
    return { ok: true, result: value };
  } catch {
    return { ok: false, outcome: "transport_unknown", retry: "human_review" };
  }
}
async function postPaid(config, path, body, idempotencyKey, options = {}) {
  if (!PAID_PATHS.has(path)) throw new Error("unsupported paid proxy path");
  if (!IDEMPOTENCY.test(idempotencyKey)) throw new Error("idempotency_key is invalid");
  const fetchImpl = options.fetch ?? fetch;
  const readToken = options.readToken ?? readProxyToken;
  try {
    const response = await fetchImpl(`${config.proxyOrigin}${path}`, {
      method: "POST",
      headers: {
        ...authHeaders(config, readToken),
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey
      },
      body: JSON.stringify(body),
      redirect: "error",
      cache: "no-store",
      signal: options.signal ?? null
    });
    const value = await readBoundedJson(response, MAX_PAID_RESPONSE_BYTES);
    const metadata = projectedHeaders(response.headers);
    if (!response.ok) {
      const retry = metadata["x-onchain-router-retry"] === "never" ? "never" : "human_review";
      return {
        ok: false,
        status: response.status,
        error: safeError(value, response.status),
        metadata,
        retry
      };
    }
    return { ok: true, result: value, metadata, retry: "never" };
  } catch {
    return {
      ok: false,
      outcome: "transport_unknown",
      message: "local proxy outcome is unknown; inspect receipts and recover with the same key",
      retry: "human_review"
    };
  }
}

// src/proxy-service.ts
import { spawn } from "child_process";
import { lstatSync as lstatSync2, readFileSync as readFileSync2, realpathSync } from "fs";
import { createRequire } from "module";
import { dirname as dirname2, isAbsolute as isAbsolute2, resolve as resolve2, sep } from "path";
import process2 from "process";
var PROXY_PACKAGE = "@onchainrouter/proxy";
var PROXY_VERSION = "0.2.0";
var START_TIMEOUT_MS = 15e3;
var PROBE_INTERVAL_MS = 100;
var MAX_PACKAGE_JSON_BYTES = 16 * 1024;
function safeChildEnvironment() {
  const allowed = [
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TMPDIR",
    "USER",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME"
  ];
  const environment = {};
  for (const name of allowed) {
    const value = process2.env[name];
    if (value !== void 0) environment[name] = value;
  }
  return environment;
}
function resolveProxyEntrypoint() {
  const require2 = createRequire(import.meta.url);
  const packageJsonPath = realpathSync(require2.resolve(`${PROXY_PACKAGE}/package.json`));
  const metadata = lstatSync2(packageJsonPath);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_PACKAGE_JSON_BYTES)
    throw new Error("installed buyer proxy package metadata is invalid");
  const parsed = JSON.parse(readFileSync2(packageJsonPath, "utf8"));
  if (parsed["name"] !== PROXY_PACKAGE || parsed["version"] !== PROXY_VERSION)
    throw new Error(`buyer proxy must be exactly ${PROXY_PACKAGE}@${PROXY_VERSION}`);
  const bin = parsed["bin"];
  const relative = typeof bin === "object" && bin !== null ? bin["onchain-router-proxy"] : void 0;
  if (typeof relative !== "string" || isAbsolute2(relative))
    throw new Error("installed buyer proxy package has no safe executable");
  const packageDirectory = dirname2(packageJsonPath);
  const entrypoint = realpathSync(resolve2(packageDirectory, relative));
  if (!entrypoint.startsWith(`${realpathSync(packageDirectory)}${sep}`))
    throw new Error("installed buyer proxy executable escapes its package");
  const executable = lstatSync2(entrypoint);
  if (!executable.isFile()) throw new Error("installed buyer proxy executable is not a file");
  if (typeof process2.getuid === "function" && executable.uid !== process2.getuid())
    throw new Error("installed buyer proxy executable must be owned by the current user");
  return entrypoint;
}
async function defaultProbe(config) {
  try {
    const token = readProxyToken(config.tokenFile);
    await fetchProxyModels(config.proxyOrigin, token);
    return true;
  } catch {
    return false;
  }
}
function defaultSpawn(entrypoint, args, env) {
  return spawn(process2.execPath, [entrypoint, ...args], {
    env,
    stdio: "ignore"
  });
}
function createProxyService(config, dependencies = {}) {
  const probe = dependencies.probe ?? defaultProbe;
  const resolveEntrypoint = dependencies.resolveEntrypoint ?? resolveProxyEntrypoint;
  const spawnChild = dependencies.spawnChild ?? defaultSpawn;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  const now = dependencies.now ?? Date.now;
  let child;
  let stopping = false;
  let startPromise;
  let generation = 0;
  async function startInternal(context) {
    stopping = false;
    const startGeneration = ++generation;
    if (await probe(config)) {
      context.serviceHealth?.clearFailure();
      context.logger.info(`Onchain Router reused the buyer proxy at ${config.proxyOrigin}.`);
      return;
    }
    if (!config.manageProxy)
      throw new Error("buyer proxy is unavailable; start onchain-router-proxy in a human terminal");
    const entrypoint = resolveEntrypoint();
    const port = new URL(config.proxyOrigin).port || "80";
    const startedChild = spawnChild(
      entrypoint,
      ["--profile", config.profileDirectory, "--port", port],
      safeChildEnvironment()
    );
    child = startedChild;
    startedChild.once("exit", () => {
      if (child === startedChild) child = void 0;
      if (!stopping)
        context.serviceHealth?.reportFailure(
          new Error("managed buyer proxy exited; paid requests were not replayed")
        );
    });
    const deadline = now() + START_TIMEOUT_MS;
    while (now() < deadline) {
      if (stopping || generation !== startGeneration || startedChild.exitCode !== null) break;
      if (await probe(config)) {
        if (stopping || generation !== startGeneration) break;
        context.serviceHealth?.clearFailure();
        context.logger.info(`Onchain Router started the buyer proxy at ${config.proxyOrigin}.`);
        return;
      }
      await sleep(PROBE_INTERVAL_MS);
    }
    if (startedChild.exitCode === null) startedChild.kill("SIGTERM");
    if (child === startedChild) child = void 0;
    if (stopping || generation !== startGeneration)
      throw new Error("buyer proxy startup was cancelled; no paid request was attempted");
    throw new Error("buyer proxy failed to become ready; no paid request was attempted");
  }
  return {
    id: "onchain-router-buyer-proxy",
    async start(context) {
      if (!startPromise) {
        const pending = startInternal(context);
        startPromise = pending;
        void pending.catch((error) => {
          context.serviceHealth?.reportFailure(error);
          if (startPromise === pending) startPromise = void 0;
        });
      }
      await startPromise;
    },
    async stop() {
      stopping = true;
      generation += 1;
      if (child?.exitCode === null) child.kill("SIGTERM");
      child = void 0;
      startPromise = void 0;
    }
  };
}

// src/commands.ts
var COMMAND_HELP = [
  "Onchain Router commands:",
  "  /onchain-router status    Show local proxy readiness",
  "  /onchain-router doctor    Run redacted local checks",
  "  /onchain-router models    Show policy-filtered models",
  "  /onchain-router pricing   Show current pass-through pricing",
  "  /onchain-router voices    Show available speech voices",
  "  /onchain-router recovery  Explain safe same-key recovery",
  "  /onchain-router help      Show this message",
  "",
  "Wallet setup, unlock, funding, policy, backup, and recovery actions remain human-terminal operations."
].join("\n");
function display(value) {
  const text2 = JSON.stringify(value, null, 2);
  return text2.length <= 16e3 ? text2 : `${text2.slice(0, 16e3)}
\u2026output truncated`;
}
async function dispatchCommand(config, rawArgs, dependencies = {}) {
  const command = (rawArgs ?? "").trim().toLowerCase();
  if (command === "" || command === "help" || command === "?") return COMMAND_HELP;
  if (command === "recovery")
    return [
      "Ambiguous paid-call recovery:",
      "1. Do not retry with a new key or a different model.",
      "2. Inspect Buyer Runtime receipts from a human terminal.",
      "3. Recover with the original idempotency key and identical request.",
      "4. Never paste a receipt capability, proxy bearer, or wallet secret into chat."
    ].join("\n");
  if (command === "doctor") {
    const checks = [];
    try {
      (dependencies.readToken ?? readProxyToken)(config.tokenFile);
      checks.push("PASS owner_only_bearer: owner-only token is valid");
    } catch {
      checks.push("FAIL owner_only_bearer: token is missing or unsafe");
    }
    if (config.manageProxy) {
      try {
        resolveProxyEntrypoint();
        checks.push("PASS exact_proxy: exact pinned entrypoint is valid");
      } catch {
        checks.push("FAIL exact_proxy: package is missing, unsafe, or the wrong version");
      }
    } else {
      checks.push("PASS exact_proxy: externally managed by explicit configuration");
    }
    const current = await getFree(config, "/v1/models", dependencies);
    checks.push(`${current["ok"] === true ? "PASS" : "FAIL"} proxy_reachable: ${config.proxyOrigin}`);
    return checks.join("\n");
  }
  const paths = {
    status: "/v1/models",
    models: "/v1/models",
    pricing: "/v1/pricing",
    voices: "/v1/audio/voices"
  };
  const path = paths[command];
  if (!path) return `Unknown subcommand: ${JSON.stringify(command)}
${COMMAND_HELP}`;
  const response = await getFree(config, path, dependencies);
  if (command === "status")
    return [
      "Onchain Router local proxy",
      `  Origin:    ${config.proxyOrigin}`,
      `  Reachable: ${String(response["ok"] === true)}`,
      `  Managed:   ${String(config.manageProxy)}`,
      `  Error:     ${response["ok"] === true ? "\u2014" : String(response["outcome"] ?? "unavailable")}`
    ].join("\n");
  return display(response);
}

// src/schemas.ts
import { Buffer } from "buffer";
import { Type } from "typebox";
var IDEMPOTENCY_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
var MODEL_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$";
var ASPECT_PATTERN = "^\\d{1,2}:\\d{1,2}$";
var VOICE_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";
var IDEMPOTENCY2 = new RegExp(IDEMPOTENCY_PATTERN);
var MODEL2 = new RegExp(MODEL_PATTERN);
var ASPECT = new RegExp(ASPECT_PATTERN);
var VOICE = new RegExp(VOICE_PATTERN);
var MAX_TOOL_BODY_BYTES = 1114112;
var MAX_TRANSCRIPTION_BASE64 = 1048576;
var strict = (properties) => Type.Object(properties, { additionalProperties: false });
var common = {
  idempotency_key: Type.String({
    pattern: IDEMPOTENCY_PATTERN,
    description: "Stable caller key. Reuse only for the identical logical request."
  }),
  model: Type.String({
    pattern: MODEL_PATTERN,
    description: "Exact model returned by the live Onchain Router catalog."
  })
};
var EMPTY_SCHEMA = Type.Object({}, { additionalProperties: false });
var IMAGE_SCHEMA = strict({
  ...common,
  prompt: Type.String({ minLength: 1, maxLength: 4e3 }),
  image_size: Type.Optional(Type.Union(["0.5K", "1K", "2K", "4K"].map((value) => Type.Literal(value)))),
  aspect_ratio: Type.Optional(Type.String({ pattern: ASPECT_PATTERN })),
  response_format: Type.Optional(Type.Literal("url"))
});
var SPEECH_SCHEMA = strict({
  ...common,
  input: Type.String({ minLength: 1, maxLength: 5e3 }),
  voice: Type.Optional(Type.String({ pattern: VOICE_PATTERN })),
  response_format: Type.Optional(Type.Literal("mp3")),
  speed: Type.Optional(Type.Number({ minimum: 0.7, maximum: 1.2 }))
});
var TRANSCRIPTION_SCHEMA = strict({
  ...common,
  audio_base64: Type.String({ minLength: 4, maxLength: MAX_TRANSCRIPTION_BASE64 }),
  acknowledge_provider_retention: Type.Literal(true),
  language: Type.Optional(Type.String({ pattern: "^[a-z]{2,3}(?:-[A-Z]{2})?$" })),
  diarize: Type.Optional(Type.Boolean()),
  num_speakers: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
  timestamps: Type.Optional(Type.Union(["none", "word", "character"].map((value) => Type.Literal(value)))),
  tag_audio_events: Type.Optional(Type.Boolean()),
  response_format: Type.Optional(Type.Union(["json", "verbose_json"].map((value) => Type.Literal(value))))
});
function object(value, allowed, required) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("tool input must be an object");
  const result2 = { ...value };
  if (Object.keys(result2).some((key) => !allowed.includes(key)))
    throw new Error("unsupported tool input field");
  if (required.some((key) => !(key in result2)))
    throw new Error("required tool input field is missing");
  if (typeof result2["idempotency_key"] !== "string" || !IDEMPOTENCY2.test(result2["idempotency_key"]))
    throw new Error("idempotency_key is invalid");
  if (typeof result2["model"] !== "string" || !MODEL2.test(result2["model"]))
    throw new Error("model is invalid");
  return result2;
}
function text(value, maximum, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > maximum)
    throw new Error(`${label} is empty, malformed, or too long`);
}
function bounded(value) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_TOOL_BODY_BYTES)
    throw new Error("tool request exceeds its byte limit");
  return value;
}
function validateImage(value) {
  const result2 = object(
    value,
    ["idempotency_key", "model", "prompt", "image_size", "aspect_ratio", "response_format"],
    ["idempotency_key", "model", "prompt"]
  );
  text(result2["prompt"], 4e3, "prompt");
  if (!["0.5K", "1K", "2K", "4K"].includes(String(result2["image_size"] ?? "1K")))
    throw new Error("image_size is not supported");
  if (typeof (result2["aspect_ratio"] ?? "1:1") !== "string" || !ASPECT.test(String(result2["aspect_ratio"] ?? "1:1")))
    throw new Error("aspect_ratio is invalid");
  if ((result2["response_format"] ?? "url") !== "url")
    throw new Error("only hosted image URLs are supported by this tool");
  const key = String(result2["idempotency_key"]);
  delete result2["idempotency_key"];
  return [key, bounded(result2)];
}
function validateSpeech(value) {
  const result2 = object(
    value,
    ["idempotency_key", "model", "input", "voice", "response_format", "speed"],
    ["idempotency_key", "model", "input"]
  );
  text(result2["input"], 5e3, "speech input");
  if (result2["voice"] !== void 0 && (typeof result2["voice"] !== "string" || !VOICE.test(result2["voice"])))
    throw new Error("voice is invalid");
  if ((result2["response_format"] ?? "mp3") !== "mp3")
    throw new Error("only MP3 speech output is supported by this tool");
  const speed = result2["speed"] ?? 1;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0.7 || speed > 1.2 || !Number.isInteger(speed * 1e3))
    throw new Error("speech speed is invalid");
  const key = String(result2["idempotency_key"]);
  delete result2["idempotency_key"];
  return [key, bounded(result2)];
}
function validateTranscription(value) {
  const result2 = object(
    value,
    [
      "idempotency_key",
      "model",
      "audio_base64",
      "acknowledge_provider_retention",
      "language",
      "diarize",
      "num_speakers",
      "timestamps",
      "tag_audio_events",
      "response_format"
    ],
    ["idempotency_key", "model", "audio_base64", "acknowledge_provider_retention"]
  );
  if (result2["acknowledge_provider_retention"] !== true)
    throw new Error("provider-retention acknowledgement is required before audio upload");
  const encoded = result2["audio_base64"];
  if (typeof encoded !== "string" || encoded.length > MAX_TRANSCRIPTION_BASE64 || encoded.length % 4 !== 0)
    throw new Error("audio must be bounded canonical MP3 Base64");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== encoded || !(decoded.subarray(0, 3).toString("ascii") === "ID3" || decoded[0] === 255 && ((decoded[1] ?? 0) & 224) === 224))
    throw new Error("only bounded canonical MP3 Base64 is supported");
  if (result2["num_speakers"] !== void 0 && result2["diarize"] !== true)
    throw new Error("num_speakers requires diarize=true");
  if (result2["language"] !== void 0 && (typeof result2["language"] !== "string" || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(result2["language"])))
    throw new Error("transcription language is invalid");
  for (const flag of ["diarize", "tag_audio_events"]) {
    if (result2[flag] !== void 0 && typeof result2[flag] !== "boolean")
      throw new Error(`${flag} must be boolean`);
  }
  if (result2["num_speakers"] !== void 0 && (typeof result2["num_speakers"] !== "number" || !Number.isInteger(result2["num_speakers"]) || result2["num_speakers"] < 1 || result2["num_speakers"] > 32))
    throw new Error("num_speakers is invalid");
  if (!["none", "word", "character"].includes(String(result2["timestamps"] ?? "none")))
    throw new Error("transcription timestamps are invalid");
  if (!["json", "verbose_json"].includes(String(result2["response_format"] ?? "json")))
    throw new Error("transcription response_format is invalid");
  const key = String(result2["idempotency_key"]);
  delete result2["idempotency_key"];
  delete result2["acknowledge_provider_retention"];
  return [key, bounded(result2)];
}

// src/tools.ts
function result(details) {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details
  };
}
function invalid(error) {
  return result({
    ok: false,
    outcome: "invalid_input",
    message: error instanceof Error ? error.message : "invalid tool input",
    retry: "never"
  });
}
function createOnchainRouterTools(config, dependencies = {}) {
  return [
    {
      name: "onchain_router_models",
      label: "Onchain Router Models",
      description: "List live policy-filtered Onchain Router models without spending.",
      parameters: EMPTY_SCHEMA,
      execute: async (_id, _params, signal) => result(await getFree(config, "/v1/models", { ...dependencies, signal }))
    },
    {
      name: "onchain_router_pricing",
      label: "Onchain Router Pricing",
      description: "Inspect current Onchain Router model pricing without spending.",
      parameters: EMPTY_SCHEMA,
      execute: async (_id, _params, signal) => result(await getFree(config, "/v1/pricing", { ...dependencies, signal }))
    },
    {
      name: "onchain_router_voices",
      label: "Onchain Router Voices",
      description: "List public speech voices and compatibility without spending.",
      parameters: EMPTY_SCHEMA,
      execute: async (_id, _params, signal) => result(await getFree(config, "/v1/audio/voices", { ...dependencies, signal }))
    },
    {
      name: "onchain_router_image_generate",
      label: "Onchain Router Image Generation",
      description: "Generate one paid image through Buyer Runtime. Returns a hosted URL and seven-day expiry.",
      parameters: IMAGE_SCHEMA,
      execute: async (_id, params, signal) => {
        try {
          const [key, body] = validateImage(params);
          return result(await postPaid(config, "/v1/images/generations", body, key, { ...dependencies, signal }));
        } catch (error) {
          return invalid(error);
        }
      }
    },
    {
      name: "onchain_router_speech_generate",
      label: "Onchain Router Speech Generation",
      description: "Generate paid MP3 speech through Buyer Runtime.",
      parameters: SPEECH_SCHEMA,
      execute: async (_id, params, signal) => {
        try {
          const [key, body] = validateSpeech(params);
          return result(await postPaid(config, "/v1/audio/speech", body, key, { ...dependencies, signal }));
        } catch (error) {
          return invalid(error);
        }
      }
    },
    {
      name: "onchain_router_transcribe",
      label: "Onchain Router Transcription",
      description: "Transcribe bounded MP3 Base64 after explicit provider-retention acknowledgement.",
      parameters: TRANSCRIPTION_SCHEMA,
      execute: async (_id, params, signal) => {
        try {
          const [key, body] = validateTranscription(params);
          return result(await postPaid(config, "/v1/audio/transcriptions", body, key, { ...dependencies, signal }));
        } catch (error) {
          return invalid(error);
        }
      }
    }
  ];
}

// src/index.ts
var VERSION = "0.2.0";
function stableTurnIdempotencyKey(sessionId, turnId, modelId) {
  const digest = createHash("sha256").update([sessionId ?? "", turnId, modelId].join("\0"), "utf8").digest("hex");
  return `openclaw-${digest}`;
}
function registerOnchainRouter(api, dependencies = {}) {
  const config = parseConfig(api.pluginConfig);
  const provider = {
    id: "onchain-router",
    label: "Onchain Router",
    docsPath: "https://onchainrouter.dev/docs",
    aliases: ["ocr"],
    envVars: [],
    catalog: {
      order: "simple",
      run: async () => ({
        provider: await buildProviderCatalog(config, dependencies)
      })
    },
    auth: [],
    resolveTransportTurnState: (context) => ({
      headers: {
        "Idempotency-Key": stableTurnIdempotencyKey(
          context.sessionId,
          context.turnId,
          context.modelId
        ),
        "Cache-Control": "no-store"
      }
    })
  };
  api.registerProvider(provider);
  const unifiedCatalog = {
    provider: "onchain-router",
    kinds: ["text"],
    liveCatalog: async () => {
      const models = await fetchConfiguredModels(config, dependencies);
      return models.map((model) => ({
        kind: "text",
        provider: "onchain-router",
        model: model.id,
        label: model.id,
        source: "live"
      }));
    }
  };
  api.registerModelCatalogProvider(unifiedCatalog);
  for (const tool of createOnchainRouterTools(config, { fetch: dependencies.fetch }))
    api.registerTool(tool);
  api.registerCommand({
    name: "onchain-router",
    description: "Onchain Router status, discovery, diagnostics, and recovery help",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (context) => ({
      text: await dispatchCommand(config, context.args, { fetch: dependencies.fetch })
    })
  });
  api.registerService(createProxyService(config, dependencies.proxyService));
  api.logger.info(
    `Onchain Router registered its policy-filtered catalog through ${config.proxyOrigin}.`
  );
}
async function buildProviderCatalog(config, dependencies = {}) {
  const token = readProxyToken(config.tokenFile);
  const models = await fetchConfiguredModels(config, dependencies, token);
  return {
    baseUrl: `${config.proxyOrigin}/v1`,
    apiKey: token,
    api: "openai-completions",
    models: models.map((model) => ({
      id: model.id,
      name: model.id,
      reasoning: true,
      input: model.capabilities.includes("vision") ? ["text", "image"] : ["text"],
      // OpenClaw display metadata only. Buyer Runtime uses request-bound integer quotes.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // Output budget is not context size. The host permits unknown context metadata;
      // leave it absent until discovery advertises a verified provider context window.
      maxTokens: model.maxOutputTokens
    }))
  };
}
async function fetchConfiguredModels(config, dependencies, token = readProxyToken(config.tokenFile)) {
  return await fetchProxyModels(config.proxyOrigin, token, dependencies.fetch);
}
var plugin = definePluginEntry({
  id: "onchain-router",
  name: "Onchain Router",
  description: "Policy-bounded, receipt-backed LLM calls through Buyer Runtime",
  register(api) {
    registerOnchainRouter(api);
  }
});
var index_default = plugin;
export {
  COMMAND_HELP,
  VERSION,
  buildProviderCatalog,
  createOnchainRouterTools,
  createProxyService,
  index_default as default,
  dispatchCommand,
  fetchProxyModels,
  getFree,
  parseConfig,
  postPaid,
  readProxyToken,
  registerOnchainRouter,
  resolveProxyEntrypoint,
  stableTurnIdempotencyKey,
  validateImage,
  validateSpeech,
  validateTranscription
};
