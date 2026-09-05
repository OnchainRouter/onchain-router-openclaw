import type { ProxyModel } from "./types.js";

const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared &&
    /^\d+$/.test(declared) &&
    BigInt(declared) > BigInt(MAX_CATALOG_BYTES)
  )
    throw new Error("buyer proxy catalog exceeds the size limit");
  if (!response.body) throw new Error("buyer proxy catalog is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
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

export async function fetchProxyModels(
  origin: string,
  token: string,
  fetchImplementation: typeof fetch = globalThis.fetch,
): Promise<readonly ProxyModel[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  timer.unref();
  let value: unknown;
  try {
    const response = await fetchImplementation(`${origin}/v1/models`, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`buyer proxy catalog returned HTTP ${response.status}`);
    value = await boundedJson(response);
  } finally {
    clearTimeout(timer);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { data?: unknown }).data)
  )
    throw new Error("buyer proxy catalog is malformed");
  const models: ProxyModel[] = [];
  for (const item of (value as { data: unknown[] }).data) {
    if (typeof item !== "object" || item === null)
      throw new Error("buyer proxy model is malformed");
    const entry = item as Record<string, unknown>;
    if (
      typeof entry["id"] !== "string" ||
      !MODEL.test(entry["id"]) ||
      !Array.isArray(entry["supported_endpoints"]) ||
      !entry["supported_endpoints"].every(
        (endpoint) => typeof endpoint === "string",
      )
    )
      throw new Error("buyer proxy model is malformed");
    // The proxy catalog is multimodal; this picker is specifically for chat models.
    if (!entry["supported_endpoints"].includes("/v1/chat/completions"))
      continue;
    if (models.some((model) => model.id === entry["id"]))
      throw new Error("buyer proxy model is duplicated");
    const rawMaximum = entry["max_output_tokens"];
    const maximum =
      typeof rawMaximum === "number"
        ? rawMaximum
        : typeof rawMaximum === "string" && /^\d+$/.test(rawMaximum)
          ? Number(rawMaximum)
          : 8_192;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_000_000)
      throw new Error("buyer proxy model output limit is invalid");
    const capabilities = Array.isArray(entry["capabilities"])
      ? entry["capabilities"].filter(
          (item): item is string => typeof item === "string",
        )
      : ["text"];
    models.push({ id: entry["id"], capabilities, maxOutputTokens: maximum });
  }
  if (models.length === 0)
    throw new Error("buyer proxy exposes no chat models");
  return Object.freeze(
    models.sort((left, right) => left.id.localeCompare(right.id)),
  );
}
