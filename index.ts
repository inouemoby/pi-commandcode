import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
// NOTE: jiti aliases rewrite every "@earendil-works/pi-ai/<subpath>" import to
// the compat entrypoint's directory (dist/compat.js/<subpath>), which does not
// exist. Importing the concrete file relatively bypasses the alias table.
// @ts-expect-error compiled JS subpath without bundled type declarations
import { convertMessages } from "./node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
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

function zdrHeaders(): Record<string, string> | undefined {
  return process.env.CMD_ZDR === "1" || process.env.COMMANDCODE_ZDR === "1"
    ? { "x-cmd-zdr": "1" }
    : undefined;
}

function commandCodeCompat(model: Model<"openai-completions">): Record<string, unknown> {
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    supportsUsageInStreaming: false,
    supportsFinishReason: true,
    maxTokensField: "max_tokens",
    ...(model.compat ?? {}),
  };
}

function reasoningTextFromMessage(message: Record<string, unknown>): string {
  if (typeof message.reasoning === "string" && message.reasoning.trim()) {
    return message.reasoning;
  }
  if (!Array.isArray(message.reasoning_details)) return "";
  return message.reasoning_details
    .filter(isRecord)
    .map((detail) => {
      if (typeof detail.text === "string") return detail.text;
      if (typeof detail.summary === "string") return detail.summary;
      return "";
    })
    .filter(Boolean)
    .join("\\n\\n");
}

function commandCodeUsage(raw: unknown): AssistantMessage["usage"] {
  const usage = isRecord(raw) ? raw : {};
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
  const input = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const output = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  const cacheRead = typeof promptDetails.cached_tokens === "number" ? promptDetails.cached_tokens : 0;
  const reasoning = typeof completionDetails.reasoning_tokens === "number" ? completionDetails.reasoning_tokens : 0;
  return {
    input: Math.max(0, input - cacheRead),
    output,
    cacheRead,
    cacheWrite: 0,
    reasoning,
    totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function streamCommandCodeBuffered(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const run = async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: commandCodeUsage(undefined),
      stopReason: "pending",
      timestamp: Date.now(),
    };

    try {
      if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
      const compat = commandCodeCompat(model as Model<"openai-completions">);
      const messages = convertMessages(model as Model<"openai-completions">, context, compat as any);
      const body: Record<string, unknown> = {
        model: model.id,
        messages,
        stream: false,
        max_tokens: Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens),
      };
      if (options?.temperature !== undefined) body.temperature = options.temperature;
      if (context.tools?.length) {
        body.tools = context.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));
      }
      if (options?.toolChoice) body.tool_choice = options.toolChoice;
      if (options?.reasoning && model.reasoning && compat.supportsReasoningEffort) {
        const effort = model.thinkingLevelMap?.[options.reasoning] ?? options.reasoning;
        if (typeof effort === "string") body.reasoning_effort = effort;
      }
      if (model.samplingParams) Object.assign(body, model.samplingParams);
      if (options?.samplingParams) Object.assign(body, options.samplingParams);
      const nextBody = await options?.onPayload?.(body, model);
      const payload = (nextBody && typeof nextBody === "object" ? nextBody : body) as Record<string, unknown>;

      stream.push({ type: "start", partial: output });
      const fetchImpl = options.fetch ?? fetch;
      const response = await fetchImpl(`${model.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...options.headers,
        },
        body: JSON.stringify(payload),
        signal: options.signal,
      });
      await options.onResponse?.({
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      }, model);
      const text = await response.text();
      if (!response.ok) throw new Error(`Command Code HTTP ${response.status}: ${text.slice(0, 1000)}`);
      const result = JSON.parse(text) as Record<string, unknown>;
      const choice = Array.isArray(result.choices) && isRecord(result.choices[0]) ? result.choices[0] : {};
      const message = isRecord(choice.message) ? choice.message : {};

      const reasoning = reasoningTextFromMessage(message);
      const reasoningDetails = Array.isArray(message.reasoning_details) ? message.reasoning_details : undefined;
      if (reasoning) {
        const block: any = {
          type: "thinking",
          thinking: reasoning,
          ...(reasoningDetails ? { thinkingSignature: JSON.stringify(reasoningDetails) } : {}),
        };
        output.content.push(block);
        const contentIndex = output.content.length - 1;
        stream.push({ type: "thinking_start", contentIndex, partial: output });
        stream.push({ type: "thinking_delta", contentIndex, delta: reasoning, partial: output });
        stream.push({ type: "thinking_end", contentIndex, content: reasoning, partial: output });
      }

      const content = typeof message.content === "string" ? message.content : "";
      if (content) {
        const block = { type: "text" as const, text: content };
        output.content.push(block);
        const contentIndex = output.content.length - 1;
        stream.push({ type: "text_start", contentIndex, partial: output });
        stream.push({ type: "text_delta", contentIndex, delta: content, partial: output });
        stream.push({ type: "text_end", contentIndex, content, partial: output });
      }

      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const rawCall of toolCalls) {
        if (!isRecord(rawCall)) continue;
        const fn = isRecord(rawCall.function) ? rawCall.function : {};
        const id = typeof rawCall.id === "string" ? rawCall.id : `call_${Date.now()}`;
        const name = typeof fn.name === "string" ? fn.name : "";
        let args: Record<string, unknown> = {};
        if (typeof fn.arguments === "string") {
          try { args = JSON.parse(fn.arguments); } catch { /* keep empty object */ }
        } else if (isRecord(fn.arguments)) {
          args = fn.arguments;
        }
        const toolCall: any = { type: "toolCall", id, name, arguments: args };
        output.content.push(toolCall);
        const contentIndex = output.content.length - 1;
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
        stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(args), partial: output });
        stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
      }

      output.usage = commandCodeUsage(result.usage);
      output.stopReason = toolCalls.length > 0
        ? "toolUse"
        : choice.finish_reason === "length" ? "length" : "stop";
      stream.push({ type: "done", reason: output.stopReason, message: output });
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
    } finally {
      stream.end();
    }
  };
  void run();
  return stream;
}

export default function piCommandCode(pi: ExtensionAPI): void {
  // Register synchronously from the last successful cache so Pi can restore
  // commandcode/<model> before any network refresh runs.
  const initialModels = readApiKeyFromDisk() ? readCachedModels() : [];

  const provider: ProviderConfig = {
    name: DISPLAY_NAME,
    baseUrl: PROVIDER_API_BASE,
    // This creates Pi's native two-stage API-key login flow, like Ollama Cloud.
    apiKey: "$COMMAND_CODE_API_KEY",
    authHeader: true,
    api: "openai-completions",
    streamSimple: streamCommandCodeBuffered,
    headers: zdrHeaders(),
    models: initialModels,
    refreshModels: async (context) => {
      // Return undefined (not []) when the catalog cannot be refreshed: an
      // empty array would be published as the new model list and wipe the
      // synchronously registered cached models during offline startup refresh.
      if (!context.allowNetwork || context.signal.aborted) return undefined;
      const key = context.credential?.type === "api_key"
        ? context.credential.key?.trim()
        : readApiKeyFromDisk();
      if (!key) return undefined;
      const models = await fetchModels(key, context.signal, REFRESH_TIMEOUT_MS);
      writeCachedModels(models);
      return models;
    },
  };

  pi.registerProvider(PROVIDER_ID, provider);

  // Pi's native login flow also calls refreshModels after saving a key. This
  // session hook refreshes the live catalog after the cached models are ready.
  pi.on("session_start", async (_event, ctx) => {
    if (!readApiKeyFromDisk()) return;
    try {
      await ctx.modelRegistry.refresh({
        providers: [PROVIDER_ID],
        force: true,
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
    } catch {
      // Cached models remain available when the live catalog is unreachable.
    }
  });
}
