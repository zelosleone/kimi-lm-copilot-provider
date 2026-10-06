import * as vscode from "vscode";
import {
	KimiApiClient,
	KimiApiError,
	summarizeErrorResponse,
	type KimiMessage,
	type KimiTool,
	type KimiUsage,
} from "./api.js";
import { getApiBaseUrl } from "./config.js";
import {
	buildCatalogModels,
	toLanguageModelChatInformation,
	type CatalogModel,
} from "./models.js";
import {
	resolveModelsDev,
	resolveReasoningChoice,
	reasoningRequestFields,
	type ModelsDevCache,
} from "./modelsDev.js";
import { assistantToolCallThinkingPayload } from "./reasoning.js";

// Copilot sends its system prompt with the proposed System role, which the stable typings lack.
const SYSTEM_ROLE = 3 as vscode.LanguageModelChatMessageRole;

interface ToolCallBuilder {
	id: string;
	name: string;
	arguments: string;
}

function getObjectProperty(
	source: unknown,
	key: string,
): unknown {
	if (!source || typeof source !== "object") {
		return undefined;
	}

	return (source as Record<string, unknown>)[key];
}

function getApiKey(
	options: vscode.PrepareLanguageModelChatModelOptions,
): string | undefined {
	// VS Code 1.120+ passes provider config as modelConfiguration
	const modelConfig = getObjectProperty(options, "modelConfiguration");
	const fromModelConfig = getStringProperty(modelConfig, "apiKey");
	if (fromModelConfig) {
		return fromModelConfig;
	}

	// VS Code <=1.119 passes provider config as configuration
	const configuration = getObjectProperty(options, "configuration");
	const fromLegacyConfig = getStringProperty(configuration, "apiKey");
	if (fromLegacyConfig) {
		return fromLegacyConfig;
	}

	return undefined;
}

function getStringProperty(
	source: unknown,
	key: string,
): string | undefined {
	if (!source || typeof source !== "object") {
		return undefined;
	}
	const value = (source as Record<string, unknown>)[key];
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

/** Live reasoning picker value from the request options. */
function getConfiguredReasoningEffort(
	options: vscode.ProvideLanguageModelChatResponseOptions,
): unknown {
	const opts = options as {
		modelConfiguration?: Record<string, unknown>;
		configuration?: Record<string, unknown>;
	};
	return opts.modelConfiguration?.reasoningEffort ?? opts.configuration?.reasoningEffort;
}

/**
 * kimi-cli + opencode mapping: reasoningRequestFields gives
 * thinking {type} (+ reasoning_effort for levels); Kimi coding keeps
 * `keep: 'all'` on enabled thinking.
 */
function kimiReasoningFields(value: string | undefined): Record<string, unknown> {
	const fields = reasoningRequestFields(value, "enabled");
	const thinking = fields.thinking as { type?: string } | undefined;
	if (thinking?.type === "enabled") {
		return { ...fields, thinking: { ...thinking, keep: "all" } };
	}
	return fields;
}

/** JSON length with image data (data URLs) removed. */
function strippedJsonLength(value: unknown): number {
	return JSON.stringify(value, (_key, v: unknown) =>
		typeof v === "string" && v.startsWith("data:") ? "" : v,
	).length;
}

function getPromptCacheKey(
	options: vscode.ProvideLanguageModelChatResponseOptions,
): string | undefined {
	const metadata = getObjectProperty(options, "metadata");
	const taskId = getObjectProperty(metadata, "taskId");
	if (typeof taskId !== "string") {
		return undefined;
	}

	const normalized = taskId.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function getToolCallBuilder(
	builders: Map<number, ToolCallBuilder>,
	index: number,
): ToolCallBuilder {
	const existing = builders.get(index);
	if (existing) {
		return existing;
	}

	const created: ToolCallBuilder = { id: "", name: "", arguments: "" };
	builders.set(index, created);
	return created;
}

function parseToolCallArguments(raw: string): Record<string, unknown> {
	const s = raw.trim() || "{}";
	try {
		const parsed: unknown = JSON.parse(s);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return { _nonObjectToolArguments: parsed };
	} catch {
		return {
			_invalidToolArgumentsJson: true,
			_rawArguments: raw,
		};
	}
}

function emitToolCalls(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	builders: Map<number, ToolCallBuilder>,
): void {
	for (const [, builder] of builders) {
		if (!builder.id || !builder.name) continue;

		const args = parseToolCallArguments(builder.arguments);
		progress.report(
			new vscode.LanguageModelToolCallPart(builder.id, builder.name, args),
		);
	}
	builders.clear();
}

function mapKimiApiError(error: KimiApiError): Error {
	const detail = error.response
		? ` Response: ${summarizeErrorResponse(error.response)}`
		: "";

	switch (error.statusCode) {
		case 0:
			return new Error(`${error.message}${detail}`);
		case 401:
			return new Error(
				`Authentication failed (401). Check your API key from kimi.com/code/console.${detail}`,
			);
		case 403:
			return new Error(
				`Forbidden (403). The API rejected the request.${detail}`,
			);
		case 429:
			return new Error("Rate limit exceeded. Please wait and try again.");
		default:
			return new Error(`Kimi API error ${error.statusCode}: ${error.message}${detail}`);
	}
}

export class KimiChatProvider implements vscode.LanguageModelChatProvider {
	private static readonly MODEL_CATALOG_CACHE_KEY = "kimi.modelCatalog.v2";
	private static readonly CHARS_PER_TOKEN_KEY = "kimi.charsPerToken";
	private static readonly CATALOG_REFRESH_COOLDOWN_MS = 30_000;
	private static readonly CATALOG_REFRESH_INTERVAL_MS = 30 * 60_000;

	private apiKey: string | undefined;
	private availableModels: CatalogModel[] = [];
	private servedInfos: vscode.LanguageModelChatInformation[] = [];
	private devCache: ModelsDevCache = { models: {} };
	private lastCatalogRefreshAttempt = 0;
	private catalogRefresh: Promise<void> | undefined;
	private lastKey: string | undefined;
	private lastBaseUrl: string | undefined;
	private charsPerToken = 4;
	private readonly modelsChangedEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.modelsChangedEmitter.event;

	constructor(private readonly globalState?: vscode.Memento) {
		this.hydrateCatalog();
		const timer = setInterval(() => {
			if (this.lastKey && this.lastBaseUrl) {
				this.lastCatalogRefreshAttempt = 0;
				this.maybeRefreshCatalog(this.lastKey, this.lastBaseUrl);
			}
		}, KimiChatProvider.CATALOG_REFRESH_INTERVAL_MS);
		if (typeof (timer as unknown as { unref?: unknown }).unref === "function") {
			(timer as unknown as { unref: () => void }).unref();
		}
	}

	/** Hydrate persisted { devCache, models } plus the token counter. */
	private hydrateCatalog(): void {
		try {
			const cpt = this.globalState?.get<unknown>(KimiChatProvider.CHARS_PER_TOKEN_KEY);
			if (typeof cpt === "number" && Number.isFinite(cpt) && cpt >= 1 && cpt <= 12) {
				this.charsPerToken = cpt;
			}
		} catch {
			// Best-effort; keep the default.
		}
		try {
			const cached = this.globalState?.get<{
				devCache?: unknown;
				models?: unknown;
			}>(KimiChatProvider.MODEL_CATALOG_CACHE_KEY);
			const devCache = cached?.devCache as ModelsDevCache | undefined;
			const models = cached?.models as CatalogModel[] | undefined;
			if (
				devCache !== null && typeof devCache === "object" &&
				devCache.models !== null && typeof devCache.models === "object" &&
				Array.isArray(models) &&
				models.every((m) => !!m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string")
			) {
				this.devCache = devCache;
				this.availableModels = [...models];
				this.servedInfos = models.map(toLanguageModelChatInformation);
				return;
			}
		} catch {
			// Corrupt cache — serve empty until the first refresh.
		}
		this.availableModels = [];
		this.servedInfos = [];
	}

	notifyModelsChanged(): void {
		this.modelsChangedEmitter.fire();
	}

	provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
		const key = getApiKey(options);
		if (!key) {
			// No API key configured yet — return empty so VS Code doesn't
			// duplicate model entries during the base vendor scan.
			// Once the user sets an API key via the model picker, VS Code
			// will call this method again with the configuration present.
			this.apiKey = undefined;
			return [];
		}

		this.apiKey = key;
		this.lastKey = key;
		this.lastBaseUrl = getApiBaseUrl();
		// Serve the cached catalog immediately and refresh lazily in the
		// background. With no catalog yet (first run), wait for the refresh
		// so the picker is not empty.
		const refresh = this.maybeRefreshCatalog(key, this.lastBaseUrl);
		if (refresh && this.servedInfos.length === 0) {
			return refresh.then(() => this.servedInfos);
		}
		return this.servedInfos;
	}

	/**
	 * Fire-and-forget catalog refresh with a 30s cooldown. The key only
	 * exists in request options (no secrets-stored key), so refreshes
	 * happen lazily here when a key is present.
	 */
	private maybeRefreshCatalog(key: string, baseUrl: string): Promise<void> | undefined {
		const now = Date.now();
		if (now - this.lastCatalogRefreshAttempt >= KimiChatProvider.CATALOG_REFRESH_COOLDOWN_MS) {
			this.lastCatalogRefreshAttempt = now;
			this.catalogRefresh = this.refreshModels(key, baseUrl).finally(() => {
				this.catalogRefresh = undefined;
			});
		}
		return this.catalogRefresh;
	}

	private async refreshModels(key: string, baseUrl: string): Promise<void> {
		let ids: string[];
		try {
			ids = await new KimiApiClient(key).listModels(baseUrl);
		} catch {
			// Network/auth failure — keep serving the cached catalog.
			return;
		}

		let nextCache: ModelsDevCache;
		try {
			nextCache = await resolveModelsDev(baseUrl, ids, this.devCache);
		} catch {
			// models.dev failure — keep the previous catalog, do not invent data.
			return;
		}

		const { models: merged } = buildCatalogModels(ids, nextCache);
		if (merged.length === 0) {
			return;
		}

		this.devCache = nextCache;
		if (JSON.stringify(merged) === JSON.stringify(this.availableModels)) {
			// Nothing changed for the picker; persist the revalidated cache only.
			await this.persistCatalog();
			return;
		}

		this.availableModels = merged;
		this.servedInfos = merged.map(toLanguageModelChatInformation);
		await this.persistCatalog();
		this.modelsChangedEmitter.fire();
	}

	private async persistCatalog(): Promise<void> {
		try {
			await this.globalState?.update(KimiChatProvider.MODEL_CATALOG_CACHE_KEY, {
				savedAt: Date.now(),
				devCache: this.devCache,
				models: this.availableModels,
			});
		} catch {
			// Persistence is best-effort; the in-memory catalog still applies.
		}
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		if (!this.apiKey) {
			throw new Error(
				"API key not configured. Configure it via the model picker.",
			);
		}

		const client = new KimiApiClient(this.apiKey);
		const entry = this.availableModels.find((m) => m.id === model.id);
		const reasoningValue = resolveReasoningChoice(entry?.choices, getConfiguredReasoningEffort(options));
		const reasoningFields = kimiReasoningFields(reasoningValue);
		const thinkingEnabled = reasoningValue !== undefined && reasoningValue !== "off";
		const kimiMessages = this.convertMessages(messages, thinkingEnabled);
		const kimiTools = this.convertTools(options.tools);
		const requestChars = strippedJsonLength({ messages: kimiMessages, tools: kimiTools });
		const maxTokens = options.modelOptions?.maxTokens as number | undefined;
		const promptCacheKey = getPromptCacheKey(options);
		const baseUrl = getApiBaseUrl();

		try {
			const stream = client.streamChat(
				model.id,
				kimiMessages,
				baseUrl,
				{
					maxTokens,
					tools: kimiTools,
					reasoningFields,
					promptCacheKey,
					toolMode: options.toolMode,
				},
				token,
			);

			const toolCallBuilders = new Map<number, ToolCallBuilder>();

			const reportThinkingPart = (text: string): void => {
				const thinkingPart = createThinkingPart(text);
				if (thinkingPart) {
					progress.report(thinkingPart);
				}
			};

			const reportUsage = (usage: KimiUsage): void => {
				const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
				const payload = JSON.stringify({
					prompt_tokens: usage.prompt_tokens,
					completion_tokens: usage.completion_tokens,
					total_tokens: usage.total_tokens,
					prompt_tokens_details: { cached_tokens: cached },
				});
				progress.report(
					new vscode.LanguageModelDataPart(
						new TextEncoder().encode(payload),
						"usage",
					) as unknown as vscode.LanguageModelResponsePart,
				);
				this.calibrateTokenCounter(requestChars, usage.prompt_tokens);
			};

			for await (const chunk of stream) {
				if (token.isCancellationRequested) break;

				const usage = chunk.usage ?? chunk.choices[0]?.usage;
				if (usage) {
					reportUsage(usage);
				}

				for (const choice of chunk.choices) {
					const delta = choice.delta;

					if (delta.reasoning_content) {
						reportThinkingPart(delta.reasoning_content);
					}

					if (delta.content) {
						progress.report(new vscode.LanguageModelTextPart(delta.content));
					}

					if (delta.tool_calls) {
						for (const toolCall of delta.tool_calls) {
							const builder = getToolCallBuilder(toolCallBuilders, toolCall.index);

							if (toolCall.id) builder.id = toolCall.id;
							if (toolCall.function?.name) builder.name = toolCall.function.name;
							if (toolCall.function?.arguments) builder.arguments += toolCall.function.arguments;
						}
					}

					if (choice.finish_reason === "tool_calls") {
						emitToolCalls(progress, toolCallBuilders);
					}
				}
			}

			emitToolCalls(progress, toolCallBuilders);
		} catch (error) {
			if (!(error instanceof KimiApiError)) throw error;
			throw mapKimiApiError(error);
		}
	}

	provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Thenable<number> {
		if (typeof text === "string") {
			return Promise.resolve(Math.max(1, Math.round(text.length / this.charsPerToken)));
		}

		const converted = this.convertMessages([text], false);
		const chars = strippedJsonLength(converted);
		return Promise.resolve(Math.max(1, Math.round(chars / this.charsPerToken)));
	}

	/** Recalibrate chars/token from live usage (Muse-proven EWMA). */
	private calibrateTokenCounter(requestChars: number, promptTokens: number): void {
		if (!Number.isFinite(promptTokens) || promptTokens <= 0) return;
		const ratio = Math.min(12, Math.max(1, requestChars / promptTokens));
		this.charsPerToken = 0.7 * this.charsPerToken + 0.3 * ratio;
		try {
			void this.globalState?.update(KimiChatProvider.CHARS_PER_TOKEN_KEY, this.charsPerToken);
		} catch {
			// Best-effort.
		}
	}

	private convertMessages(
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		thinkingEnabled: boolean,
	): KimiMessage[] {
		const result: KimiMessage[] = [];

		for (const msg of messages) {
			const role = this.convertRole(msg.role);
			const textParts: string[] = [];
			const imageParts: Array<{ type: "image_url"; image_url: { url: string } }> = [];
			let toolCalls: KimiMessage["tool_calls"] | undefined;
			const toolResults: Array<{ callId: string; content: string }> = [];
			let reasoningFromThinkingPart: string | undefined;

			for (const part of msg.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelDataPart) {
					const mime = part.mimeType.toLowerCase();
					if (mime.startsWith("image/")) {
						const b64 = Buffer.from(part.data).toString("base64");
						imageParts.push({
							type: "image_url",
							image_url: { url: `data:${part.mimeType};base64,${b64}` },
						});
					} else if (
						mime === "text/plain" ||
						mime === "application/json" ||
						mime.endsWith("+json")
					) {
						textParts.push(new TextDecoder("utf-8", { fatal: false }).decode(part.data));
					} else {
						textParts.push(
							`\n[Attachment omitted (not an image): ${part.mimeType}, ${part.data.length} bytes]\n`,
						);
					}
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					if (!toolCalls) toolCalls = [];
					toolCalls.push({
						id: part.callId,
						type: "function",
						function: {
							name: part.name,
							arguments: JSON.stringify(part.input),
						},
					});
				} else if (part instanceof vscode.LanguageModelToolResultPart) {
					toolResults.push({
						callId: part.callId,
						content:
							typeof part.content === "string"
								? part.content
								: JSON.stringify(part.content),
					});
				} else if (isThinkingPart(part)) {
					const thinkingValue = getValueFromThinkingPart(part);
					if (thinkingValue) {
						reasoningFromThinkingPart = reasoningFromThinkingPart
							? reasoningFromThinkingPart + thinkingValue
							: thinkingValue;
					}
				}
			}

			for (const toolResult of toolResults) {
				result.push({ role: "tool", content: toolResult.content, tool_call_id: toolResult.callId });
			}

			if (toolCalls && toolCalls.length > 0) {
				const mergedText = textParts.join("") || "";
				if (thinkingEnabled && reasoningFromThinkingPart) {
					result.push({
						role: "assistant",
						content: mergedText,
						tool_calls: toolCalls,
						reasoning_content: reasoningFromThinkingPart,
					});
				} else if (thinkingEnabled) {
					const { content, reasoning_content } =
						assistantToolCallThinkingPayload(mergedText);
					result.push({
						role: "assistant",
						content,
						tool_calls: toolCalls,
						reasoning_content,
					});
				} else {
					result.push({
						role: "assistant",
						content: mergedText,
						tool_calls: toolCalls,
					});
				}
			} else if (toolResults.length === 0) {
				const content: KimiMessage["content"] =
					imageParts.length > 0
						? [
							...(textParts.length > 0
								? textParts.map((t) => ({ type: "text" as const, text: t }))
								: []),
							...imageParts,
						]
						: textParts.join("");
				result.push({ role, content, name: msg.name });
			}
		}

		return result;
	}

	private convertRole(
		role: vscode.LanguageModelChatMessageRole,
	): "system" | "user" | "assistant" {
		switch (role) {
			case vscode.LanguageModelChatMessageRole.Assistant:
				return "assistant";
			case SYSTEM_ROLE:
				return "system";
			default:
				return "user";
		}
	}

	private convertTools(
		tools?: readonly vscode.LanguageModelChatTool[],
	): KimiTool[] | undefined {
		if (!tools || tools.length === 0) return undefined;

		return tools.map((tool) => ({
			type: "function" as const,
			function: {
				name: tool.name,
				description: tool.description,
				parameters: (tool.inputSchema ?? {}) as Record<string, unknown>,
			},
		}));
	}
}

function createThinkingPart(text: string): vscode.LanguageModelResponsePart | undefined {
	const vscodeWithThinking = vscode as typeof vscode & {
		LanguageModelThinkingPart?: new (value: string) => vscode.LanguageModelResponsePart;
	};

	if (typeof vscodeWithThinking.LanguageModelThinkingPart !== "function") {
		return undefined;
	}

	return new vscodeWithThinking.LanguageModelThinkingPart(text) as unknown as vscode.LanguageModelResponsePart;
}

function getValueFromThinkingPart(part: unknown): string | undefined {
	const candidate = part as { value?: unknown } | null;
	if (!candidate || !candidate.value) {
		return undefined;
	}

	if (typeof candidate.value === "string") {
		return candidate.value;
	}

	if (Array.isArray(candidate.value)) {
		return candidate.value.join("");
	}

	return undefined;
}

function isThinkingPart(part: unknown): part is vscode.LanguageModelResponsePart {
	const vscodeWithThinking = vscode as typeof vscode & {
		LanguageModelThinkingPart?: new (value: string) => vscode.LanguageModelResponsePart;
	};

	if (typeof vscodeWithThinking.LanguageModelThinkingPart !== "function") {
		return false;
	}

	return part instanceof (vscodeWithThinking.LanguageModelThinkingPart as any);
}
