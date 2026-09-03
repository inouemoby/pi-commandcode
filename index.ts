import type { ExtensionAPI, ProviderModelConfig, ProviderConfig } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

const PROVIDER_ID = "commandcode";
const DISPLAY_NAME = "Command Code";
const PROVIDER_API_BASE = "https://api.commandcode.ai/provider/v1";
const DEFAULT_MODELS_URL = `${PROVIDER_API_BASE}/models`;
const DEFAULT_CACHE_PATH = "commandcode-models.json";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 65_536;
const STARTUP_TIMEOUT_MS = 3_000;
const REFRESH_TIMEOUT_MS = 15_000;

type ModelRecord = Record<string, unknown>;
type ModelApi = "openai-completions" | "anthropic-messages";

// Command Code's live /models response is authoritative for model existence,
// while its public CLI catalog supplies capability metadata that /models does
// not currently include (reasoning efforts and image input).
const REASONING_EFFORTS: Record<string, readonly string[]> = {
  "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4-6": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "deepseek/deepseek-v4-flash": ["high", "max"],
  "deepseek/deepseek-v4-flash-fast": ["low", "high", "max"],
  "deepseek/deepseek-v4-flash-vision-exp": ["high", "max"],
  "deepseek/deepseek-v4-pro": ["high", "max"],
  "google/gemini-3.1-flash-lite": ["low", "medium", "high"],
  "google/gemini-3.5-flash": ["low", "medium", "high"],
  "google/gemini-3.5-flash-lite": ["low", "medium", "high"],
  "google/gemini-3.6-flash": ["low", "medium", "high"],
  "google/gemini-3.7-flash": ["low", "medium", "high"],
  "google/gemini-3.8-flash": ["low", "medium", "high"],
  "gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max"],
  "meta/muse-spark-1.1": ["low", "medium", "high"],
  "meta/muse-spark-1.2": ["low", "medium", "high"],
  "meta/muse-spark-1.2-contributor": ["low", "medium", "high"],
  "meta/muse-spark-1.3": ["low", "medium", "high"],
  "meta/muse-spark-1.3-contributor": ["low", "medium", "high"],
  "minimaxai/minimax-m3": ["low", "medium", "high"],
  "moonshotai/kimi-k2.7-code": ["low", "high", "max"],
  "moonshotai/kimi-k3": ["low", "high", "max"],
  "qwen/qwen3.6-plus": ["low", "medium", "high"],
  "qwen/qwen3.7-flash": ["low", "medium", "xhigh"],
  "qwen/qwen3.7-plus": ["low", "medium", "high"],
  "qwen/qwen3.8-27b": ["low", "medium", "xhigh"],
  "qwen/qwen3.8-flash": ["low", "medium", "xhigh"],
  "qwen/qwen3.8-max": ["low", "medium", "xhigh"],
  "qwen/qwen3.8-max-0902": ["low", "medium", "xhigh"],
  "sakana/fugu-ultra": ["high", "xhigh"],
  "stepfun/step-3.7-flash": ["high", "xhigh"],
  "xai/grok-4.5": ["low", "medium", "high"],
  "xai/grok-4.6": ["low", "medium", "high", "xhigh"],
  "z-ai/glm-5.3-flash": ["low", "high", "max"],
  "zai-org/glm-5.2": ["high", "max"],
  "zai-org/glm-5.3": ["low", "high", "max"],
};

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

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR
    || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".pi", "agent");
}

function cachePath(): string {
  return process.env.COMMANDCODE_MODELS_CACHE?.trim()
    || path.join(agentDir(), DEFAULT_CACHE_PATH);
}

function readApiKeyFromDisk(): string {
  const envKey = process.env.COMMAND_CODE_API_KEY?.trim() || process.env.COMMANDCODE_API_KEY?.trim();
  if (envKey) return envKey;
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(agentDir(), "auth.json"), "utf8"));
    const credential = auth[PROVIDER_ID] || auth["command-code"];
    if (credential?.type === "api_key" && typeof credential.key === "string") return credential.key.trim();
    if (credential?.type === "api" && typeof credential.key === "string") return credential.key.trim();
    if (typeof credential === "string") return credential.trim();
  } catch {
    // No readable stored credential.
  }
  return "";
}

function readCachedModels(): ProviderModelConfig[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
    const models = Array.isArray(parsed) ? parsed : parsed?.models;
    if (!Array.isArray(models)) return [];
    return models.filter((model): model is ProviderModelConfig => isRecord(model)
      && typeof model.id === "string"
      && typeof model.name === "string"
      && typeof model.contextWindow === "number"
      && typeof model.maxTokens === "number"
      && typeof model.reasoning === "boolean"
      && Array.isArray(model.input));
  } catch {
    return [];
  }
}

function writeCachedModels(models: readonly ProviderModelConfig[]): void {
  try {
    const file = cachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, checkedAt: Date.now(), models }, null, 2) + "\n", "utf8");
    fs.renameSync(temporary, file);
  } catch {
    // Cache is best-effort; it must never prevent provider use.
  }
}

function modelIdKey(id: string): string {
  return id.toLowerCase();
}

function effortsForModel(record: ModelRecord, id: string): readonly string[] {
  const fromApi = stringArray(record.reasoning_efforts);
  if (fromApi.length) return fromApi;
  return REASONING_EFFORTS[modelIdKey(id)] ?? [];
}

function thinkingLevelMap(efforts: readonly string[]): Record<string, string | null> | undefined {
  if (!efforts.length) return undefined;
  return Object.fromEntries(
    ["minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [
      level,
      efforts.includes(level) ? level : null,
    ]),
  );
}

function modelApi(record: ModelRecord, id: string): ModelApi {
  return record.api === "anthropic-messages" || /^claude(?:-|$)/i.test(id)
    ? "anthropic-messages"
    : "openai-completions";
}

function modelHasImageInput(record: ModelRecord): boolean {
  const architecture = isRecord(record.architecture) ? record.architecture : undefined;
  const capabilities = isRecord(record.capabilities) ? record.capabilities : undefined;
  const values = [
    ...stringArray(record.input_modalities),
    ...stringArray(record.modalities),
    ...stringArray(architecture?.input_modalities),
    ...stringArray(capabilities?.input_modalities),
  ].map((value) => value.toLowerCase());
  return values.some((value) => value === "image" || value.includes("image"));
}

function modelIsReasoning(record: ModelRecord, id: string, efforts: readonly string[]): boolean {
  if (record.reasoning === true || record.supports_reasoning === true) return true;
  const capabilities = isRecord(record.capabilities) ? record.capabilities : undefined;
  return efforts.length > 0 || capabilities?.reasoning === true || capabilities?.thinking === true
    || /(?:reason|thinking|^o[134](?:-|$)|gpt-5|claude|gemini|deepseek|qwen|kimi|glm)/i.test(id);
}

function toProviderModel(record: ModelRecord): ProviderModelConfig | undefined {
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return undefined;
  const api = modelApi(record, id);
  const contextWindow = positiveNumber(record.context_length, record.context_window, record.max_context_length)
    ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = Math.min(
    positiveNumber(record.max_output_tokens, record.max_tokens) ?? DEFAULT_MAX_TOKENS,
    contextWindow,
  );
  const efforts = effortsForModel(record, id);
  const reasoning = modelIsReasoning(record, id, efforts);

  return {
    id,
    name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : id,
    api,
    baseUrl: api === "anthropic-messages"
      ? PROVIDER_API_BASE.replace(/\/v1\/?$/, "")
      : PROVIDER_API_BASE,
    reasoning,
    ...(thinkingLevelMap(efforts) ? { thinkingLevelMap: thinkingLevelMap(efforts) } : {}),
    input: modelHasImageInput(record) ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
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
          forceAdaptiveThinking: reasoning,
        },
  };
}

async function fetchModels(apiKey: string, signal: AbortSignal, timeoutMs: number): Promise<ProviderModelConfig[]> {
  const url = process.env.COMMANDCODE_MODELS_URL?.trim() || DEFAULT_MODELS_URL;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "pi-commandcode",
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
  const text = await response.text();
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { payload = undefined; }
  if (!response.ok) {
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
    const detail = String(error?.message ?? error?.type ?? text.slice(0, 500));
    throw new Error(`Command Code model discovery failed (HTTP ${response.status}): ${detail}`);
  }
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("Command Code /models response has no data array.");
  }
  const models = payload.data
    .filter(isRecord)
    .map(toProviderModel)
    .filter((model): model is ProviderModelConfig => !!model);
  if (!models.length) throw new Error("Command Code returned an empty model catalog.");
  return models;
}

async function loadInitialModels(apiKey: string): Promise<ProviderModelConfig[]> {
  const cached = readCachedModels();
  if (!apiKey) return [];
  try {
    const live = await fetchModels(apiKey, AbortSignal.timeout(STARTUP_TIMEOUT_MS), STARTUP_TIMEOUT_MS);
    writeCachedModels(live);
    return live;
  } catch {
    return cached;
  }
}

function zdrHeaders(): Record<string, string> | undefined {
  return process.env.CMD_ZDR === "1" || process.env.COMMANDCODE_ZDR === "1"
    ? { "x-cmd-zdr": "1" }
    : undefined;
}

export default async function piCommandCode(pi: ExtensionAPI): Promise<void> {
  const apiKey = readApiKeyFromDisk();
  const initialModels = await loadInitialModels(apiKey);

  const provider: ProviderConfig = {
    name: DISPLAY_NAME,
    baseUrl: PROVIDER_API_BASE,
    // This creates Pi's native two-stage API-key login flow, like Ollama Cloud.
    apiKey: "$COMMAND_CODE_API_KEY",
    authHeader: true,
    api: "openai-completions",
    headers: zdrHeaders(),
    models: initialModels,
    refreshModels: async (context) => {
      if (!context.allowNetwork || context.signal.aborted) return [];
      const key = context.credential?.type === "api_key"
        ? context.credential.key?.trim()
        : readApiKeyFromDisk();
      if (!key) return [];
      const models = await fetchModels(key, context.signal, REFRESH_TIMEOUT_MS);
      writeCachedModels(models);
      return models;
    },
  };

  pi.registerProvider(PROVIDER_ID, provider);
}
