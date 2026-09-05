import { createHash } from "node:crypto";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { fetchProxyModels } from "./catalog.js";
import { dispatchCommand } from "./commands.js";
import { parseConfig, readProxyToken } from "./config.js";
import { createProxyService, type ProxyServiceDependencies } from "./proxy-service.js";
import { createOnchainRouterTools } from "./tools.js";
import type {
  PluginApi,
  PluginService,
  ProviderConfig,
  ProviderPlugin,
  UnifiedCatalogPlugin,
} from "./types.js";

export const VERSION = "0.2.0";

export function stableTurnIdempotencyKey(
  sessionId: string | undefined,
  turnId: string,
  modelId: string,
): string {
  const digest = createHash("sha256")
    .update([sessionId ?? "", turnId, modelId].join("\0"), "utf8")
    .digest("hex");
  return `openclaw-${digest}`;
}

export function registerOnchainRouter(
  api: PluginApi,
  dependencies: {
    readonly fetch?: typeof fetch;
    readonly proxyService?: ProxyServiceDependencies;
  } = {},
): void {
  const config = parseConfig(api.pluginConfig);
  const provider: ProviderPlugin = {
    id: "onchain-router",
    label: "Onchain Router",
    docsPath: "https://onchainrouter.dev/docs",
    aliases: ["ocr"],
    envVars: [],
    catalog: {
      order: "simple",
      run: async () => ({
        provider: await buildProviderCatalog(config, dependencies),
      }),
    },
    auth: [],
    resolveTransportTurnState: (context) => ({
      headers: {
        "Idempotency-Key": stableTurnIdempotencyKey(
          context.sessionId,
          context.turnId,
          context.modelId,
        ),
        "Cache-Control": "no-store",
      },
    }),
  };
  api.registerProvider(provider);
  const unifiedCatalog: UnifiedCatalogPlugin = {
    provider: "onchain-router",
    kinds: ["text"],
    liveCatalog: async () => {
      const models = await fetchConfiguredModels(config, dependencies);
      return models.map((model) => ({
        kind: "text" as const,
        provider: "onchain-router",
        model: model.id,
        label: model.id,
        source: "live" as const,
      }));
    },
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
      text: await dispatchCommand(config, context.args, { fetch: dependencies.fetch }),
    }),
  });
  api.registerService(createProxyService(config, dependencies.proxyService));
  api.logger.info(
    `Onchain Router registered its policy-filtered catalog through ${config.proxyOrigin}.`,
  );
}

export async function buildProviderCatalog(
  config: ReturnType<typeof parseConfig>,
  dependencies: { readonly fetch?: typeof fetch } = {},
): Promise<ProviderConfig> {
  const token = readProxyToken(config.tokenFile);
  const models = await fetchConfiguredModels(config, dependencies, token);
  return {
    baseUrl: `${config.proxyOrigin}/v1`,
    apiKey: token,
    api: "openai-completions" as const,
    models: models.map((model) => ({
      id: model.id,
      name: model.id,
      reasoning: true,
      input: model.capabilities.includes("vision")
        ? ["text", "image"]
        : ["text"],
      // OpenClaw display metadata only. Buyer Runtime uses request-bound integer quotes.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // Output budget is not context size. The host permits unknown context metadata;
      // leave it absent until discovery advertises a verified provider context window.
      maxTokens: model.maxOutputTokens,
    })),
  };
}

async function fetchConfiguredModels(
  config: ReturnType<typeof parseConfig>,
  dependencies: { readonly fetch?: typeof fetch },
  token = readProxyToken(config.tokenFile),
) {
  return await fetchProxyModels(config.proxyOrigin, token, dependencies.fetch);
}

const plugin = definePluginEntry({
  id: "onchain-router",
  name: "Onchain Router",
  description: "Policy-bounded, receipt-backed LLM calls through Buyer Runtime",
  register(api) {
    registerOnchainRouter(api);
  },
});

export { fetchProxyModels } from "./catalog.js";
export { getFree, postPaid } from "./api.js";
export { COMMAND_HELP, dispatchCommand } from "./commands.js";
export { parseConfig, readProxyToken, type AdapterConfig } from "./config.js";
export {
  createProxyService,
  resolveProxyEntrypoint,
  type ManagedChild,
  type ProxyServiceDependencies,
} from "./proxy-service.js";
export {
  validateImage,
  validateSpeech,
  validateTranscription,
} from "./schemas.js";
export { createOnchainRouterTools } from "./tools.js";
export type {
  PluginApi,
  PluginService,
  ProviderConfig,
  ProviderPlugin,
  ProxyModel,
  UnifiedCatalogPlugin,
} from "./types.js";
export default plugin;
