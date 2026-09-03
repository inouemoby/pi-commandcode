import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "commandcode";
const DISPLAY_NAME = "Command Code";
const PROVIDER_API_BASE = "https://api.commandcode.ai/provider/v1";
const DEFAULT_MODELS_URL = `${PROVIDER_API_BASE}/models`;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 65_536;
const REQUEST_TIMEOUT_MS = 15_000;

type ModelRecord = Record<string, unknown>;

type ModelApi = "openai-completions" | "anthropic-messages";

interface ModelsResponse {
  object?: unknown;
  data?: unknown;
  error?: unknown;
}

function isRecord(value: unknown): value is ModelRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function modelApi(record: ModelRecord, id: string): ModelApi {
  return record.api === "anthropic-messages" || /^claude(?:-|$)/i.test(id)
    ? "anthropic-messages"
    : "openai-completions";
}

function modelHasImageInput(record: ModelRecord): boolean {
  const capabilities = isRecord(record.capabilities) ? record.capabilities : undefined;
  const architecture = isRecord(record.architecture) ? record.architecture : undefined;
  const values = [
    ...stringArray(record.input_modalities),
    ...stringArray(record.modalities),
    ...stringArray(architecture?.input_modalities),
    ...stringArray(capabilities?.input_modalities),
  ].map((value) => value.toLowerCase());
  return values.some((value) => value === "image" || value.includes("image"));
}

function modelIsReasoning(record: ModelRecord, id: string): boolean {
  if (record.reasoning === true || record.supports_reasoning === true) return true;
  const capabilities = isRecord(record.capabilities) ? record.capabilities : undefined;
  if (capabilities?.reasoning === true || capabilities?.thinking === true) return true;
  return /(?:reason|thinking|^o[134](?:-|$)|gpt-5|claude|gemini|deepseek|qwen|kimi|glm)/i.test(id);
}

function toProviderModel(record: ModelRecord): ProviderModelConfig | undefined {
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return undefined;

  const api = modelApi(record, id);
  const contextWindow = positiveNumber(
    record.context_length,
    record.context_window,
    record.max_context_length,
  ) ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = Math.min(
    positiveNumber(record.max_output_tokens, record.max_tokens) ?? DEFAULT_MAX_TOKENS,
    contextWindow,
  );
  const reasoning = modelIsReasoning(record, id);
  const efforts = stringArray(record.reasoning_efforts);

  const model: ProviderModelConfig = {
    id,
    name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : id,
    api,
    baseUrl: api === "anthropic-messages"
      ? PROVIDER_API_BASE.replace(/\/v1\/?$/, "")
      : PROVIDER_API_BASE,
    reasoning,
    input: modelHasImageInput(record) ? ["text", "image"] : ["text"],
    // Command Code's /models endpoint does not currently publish billing rates.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    ...(efforts.length > 0 ? {
      thinkingLevelMap: Object.fromEntries(
        ["minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [
          level,
          efforts.includes(level) ? level : null,
        ]),
      ),
    } : {}),
    compat: api === "openai-completions"
      ? {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: efforts.length > 0,
          supportsUsageInStreaming: true,
          maxTokensField: "max_tokens",
        }
      : {
          supportsEagerToolInputStreaming: false,
          supportsLongCacheRetention: false,
          supportsCacheControlOnTools: false,
          forceAdaptiveThinking: false,
        },
  };
  return model;
}

async function fetchCommandCodeModels(
  apiKey: string,
  signal: AbortSignal,
): Promise<ProviderModelConfig[]> {
  const url = process.env.COMMANDCODE_MODELS_URL?.trim() || DEFAULT_MODELS_URL;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "pi-commandcode",
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  const text = await response.text();
  let payload: ModelsResponse | undefined;
  try { payload = JSON.parse(text) as ModelsResponse; } catch {
    // The status/error below remains useful when the server returns HTML.
  }
  if (!response.ok) {
    const error = isRecord(payload?.error) ? payload.error : undefined;
    const detail = String(error?.message ?? error?.type ?? text.slice(0, 500));
    throw new Error(`Command Code model discovery failed (HTTP ${response.status}): ${detail}`);
  }
  if (!Array.isArray(payload?.data)) {
    throw new Error("Command Code /models response has no data array.");
  }
  const models = payload.data
    .filter(isRecord)
    .map(toProviderModel)
    .filter((model): model is ProviderModelConfig => !!model);
  if (!models.length) throw new Error("Command Code returned an empty model catalog.");
  return models;
}

function zdrHeaders(): Record<string, string> | undefined {
  return process.env.CMD_ZDR === "1" || process.env.COMMANDCODE_ZDR === "1"
    ? { "x-cmd-zdr": "1" }
    : undefined;
}

export default function piCommandCode(pi: ExtensionAPI): void {
  // Deliberately mirror pi-ollama-cloud: no static models. Pi's native /login
  // API-key flow stores the key and then calls refreshModels automatically.
  pi.registerProvider(PROVIDER_ID, {
    name: DISPLAY_NAME,
    baseUrl: PROVIDER_API_BASE,
    apiKey: "$COMMAND_CODE_API_KEY",
    authHeader: true,
    api: "openai-completions",
    headers: zdrHeaders(),
    models: [],
    refreshModels: async (context) => {
      const key = context.credential?.type === "api_key" ? context.credential.key?.trim() : "";
      if (!key || !context.allowNetwork || context.signal.aborted) return [];
      return fetchCommandCodeModels(key, context.signal);
    },
  });

}
