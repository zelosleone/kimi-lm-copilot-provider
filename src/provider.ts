import * as vscode from "vscode";
import {
	KimiApiClient,
	KimiApiError,
	type KimiMessage,
	type KimiTool,
} from "./api.js";
import { KIMI_MODELS, toLanguageModelChatInformation } from "./models.js";

interface ThinkingState {
	buffer: string;
	insideThinking: boolean;
}

interface ToolCallBuilder {
	id: string;
	name: string;
	arguments: string;
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const THINK_OPEN_REPLACEMENT = '<details><summary>Thinking</summary>\n\n';
const THINK_CLOSE_REPLACEMENT = '\n\n</details>\n\n';

function findTrailingPartialMatch(buffer: string, tag: string): number {
	for (let i = Math.min(tag.length - 1, buffer.length); i >= 1; i--) {
		if (buffer.slice(-i) === tag.slice(0, i)) {
			return i;
		}
	}
	return 0;
}

function processThinkingContent(
	content: string,
	state: ThinkingState,
	preserveThinking: boolean = false,
): { output: string; state: ThinkingState } {
	let output = "";
	let buffer = state.buffer + content;
	let insideThinking = state.insideThinking;

	while (buffer.length > 0) {
		const tag = insideThinking ? THINK_CLOSE : THINK_OPEN;
		const replacement = preserveThinking
			? tag
			: insideThinking
				? THINK_CLOSE_REPLACEMENT
				: THINK_OPEN_REPLACEMENT;
		const tagIdx = buffer.indexOf(tag);

		if (tagIdx !== -1) {
			output += buffer.slice(0, tagIdx) + replacement;
			buffer = buffer.slice(tagIdx + tag.length);
			insideThinking = !insideThinking;
			continue;
		}

		const partialMatch = findTrailingPartialMatch(buffer, tag);
		if (partialMatch > 0) {
			output += buffer.slice(0, -partialMatch);
			buffer = buffer.slice(-partialMatch);
		} else {
			output += buffer;
			buffer = "";
		}
		break;
	}

	return { output, state: { buffer, insideThinking } };
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
	const configuration = getObjectProperty(options, "configuration");
	const apiKey = getObjectProperty(configuration, "apiKey");
	if (typeof apiKey !== "string") {
		return undefined;
	}

	const normalized = apiKey.trim();
	return normalized.length > 0 ? normalized : undefined;
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

function emitToolCalls(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	builders: Map<number, ToolCallBuilder>,
): void {
	for (const [, builder] of builders) {
		if (!builder.id || !builder.name) continue;

		let args: Record<string, unknown> = {};
		try {
			args = JSON.parse(builder.arguments || "{}");
		} catch {}
		progress.report(
			new vscode.LanguageModelToolCallPart(builder.id, builder.name, args),
		);
	}
	builders.clear();
}

function mapKimiApiError(error: KimiApiError): Error {
	const detail = error.response
		? ` Response: ${JSON.stringify(error.response)}`
		: "";

	switch (error.statusCode) {
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
	private apiKey: string | undefined;
	private readonly onDidChangeLanguageModelChatInformationEmitter = new vscode.EventEmitter<void>();

	readonly onDidChangeLanguageModelChatInformation =
		this.onDidChangeLanguageModelChatInformationEmitter.event;

	dispose(): void {
		this.onDidChangeLanguageModelChatInformationEmitter.dispose();
	}

	refreshLanguageModelChatInformation(): void {
		this.onDidChangeLanguageModelChatInformationEmitter.fire();
	}

	provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
		const key = getApiKey(options);
		if (!key) {
			return [];
		}

		this.apiKey = key;
		return KIMI_MODELS.map(toLanguageModelChatInformation);
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
		const kimiMessages = this.convertMessages(messages);
		const kimiTools = this.convertTools(options.tools);
		const maxTokens = options.modelOptions?.maxTokens as number | undefined;
		const promptCacheKey = getPromptCacheKey(options);

		const modelDef = KIMI_MODELS.find((m) => m.id === model.id);
		const thinking = modelDef?.thinking ?? false;
		const baseUrl = modelDef?.baseUrl ?? "https://api.kimi.com/coding/v1";

		try {
			const stream = client.streamChat(
				model.id,
				kimiMessages,
				baseUrl,
				{ maxTokens, tools: kimiTools, thinking, promptCacheKey },
				token,
			);

			const toolCallBuilders = new Map<number, ToolCallBuilder>();

			let thinkingState: ThinkingState = { buffer: "", insideThinking: false };

			for await (const chunk of stream) {
				if (token.isCancellationRequested) break;

				for (const choice of chunk.choices) {
					const delta = choice.delta;

					if (delta.content) {
						const result = processThinkingContent(delta.content, thinkingState, thinking);
						thinkingState = result.state;
						if (result.output) {
							progress.report(new vscode.LanguageModelTextPart(result.output));
						}
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
			return Promise.resolve(Math.ceil(text.length / 4));
		}

		let totalChars = 0;
		let imageCount = 0;
		for (const part of text.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				totalChars += part.value.length;
			} else if (part instanceof vscode.LanguageModelDataPart) {
				if (part.mimeType?.startsWith("image/")) {
					imageCount++;
				}
			}
		}
		// Rough estimate: text tokens + image tokens (each image ~256 tokens)
		const textTokens = Math.ceil(totalChars / 4);
		const imageTokens = imageCount * 256;
		return Promise.resolve(textTokens + imageTokens);
	}

	private convertMessages(
		messages: readonly vscode.LanguageModelChatRequestMessage[],
	): KimiMessage[] {
		const result: KimiMessage[] = [];

		for (const msg of messages) {
			const role = this.convertRole(msg.role);
			let contentParts: Array<{ type: "text" | "image_url"; text?: string; image_url?: { url: string } }> = [];
			let toolCalls: KimiMessage["tool_calls"] | undefined;
			let toolCallId: string | undefined;
			let hasNonTextContent = false;

			for (const part of msg.content) {
				if (part instanceof vscode.LanguageModelTextPart) {
					contentParts.push({ type: "text", text: part.value });
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
					toolCallId = part.callId;
					const content =
						typeof part.content === "string"
							? part.content
							: JSON.stringify(part.content);
					contentParts.push({ type: "text", text: content });
				} else if (part instanceof vscode.LanguageModelDataPart) {
					hasNonTextContent = true;
					// Handle image data
					if (part.mimeType?.startsWith("image/")) {
						const base64Data = Buffer.from(part.data).toString("base64");
						const dataUrl = `data:${part.mimeType};base64,${base64Data}`;
						contentParts.push({
							type: "image_url",
							image_url: { url: dataUrl },
						});
					}
				}
			}

			// If we only have text content, use string format for backward compatibility
			const content = hasNonTextContent
				? contentParts
				: contentParts.map(p => p.text || "").join("");

			if (toolCallId) {
				result.push({ role: "tool", content, tool_call_id: toolCallId });
			} else if (toolCalls && toolCalls.length > 0) {
				result.push({ role: "assistant", content: content || "", tool_calls: toolCalls });
			} else {
				result.push({ role, content, name: msg.name });
			}
		}

		return result;
	}

	private convertRole(
		role: vscode.LanguageModelChatMessageRole,
	): "system" | "user" | "assistant" {
		switch (role) {
			case vscode.LanguageModelChatMessageRole.User:
				return "user";
			case vscode.LanguageModelChatMessageRole.Assistant:
				return "assistant";
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
