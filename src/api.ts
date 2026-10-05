import * as vscode from "vscode";
import { hostname, type, release, machine, version } from "node:os";
import { randomUUID } from "node:crypto";
import { EXCLUDED_MODEL_PATTERN } from "./models.js";

const CHAT_ENDPOINT = "/chat/completions";
const MODELS_ENDPOINT = "/models";
const VERSION = "1.47.0";
const DEVICE_ID = randomUUID().replace(/-/g, "");

function asciiHeaderValue(value: string, fallback = "unknown"): string {
	const sanitized = value.replace(/[^\x20-\x7e]/g, "").trim();
	return sanitized || fallback;
}

function kimiDeviceModel(): string {
	const system = type();
	const rel = release();
	const mach = machine?.() ?? "";

	if (system === "Darwin") {
		return `macOS ${rel} ${mach}`.trim();
	}

	if (system === "Windows_NT") {
		const parts = rel.split(".");
		const build = Number(parts[2] ?? "");
		const label =
			parts[0] === "10"
				? Number.isFinite(build) && build >= 22000
					? "11"
					: "10"
				: rel;
		return `Windows ${label} ${mach}`.trim();
	}

	if (system) {
		return `${system} ${rel} ${mach}`.trim();
	}

	return "Unknown";
}

export function getDefaultHeaders(apiKey: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
		"User-Agent": `KimiCLI/${VERSION}`,
		"X-Msh-Platform": "kimi_cli",
		"X-Msh-Version": VERSION,
		"X-Msh-Device-Name": asciiHeaderValue(hostname() || "unknown"),
		"X-Msh-Device-Model": asciiHeaderValue(kimiDeviceModel()),
		"X-Msh-Device-Id": DEVICE_ID,
		"X-Msh-Os-Version": asciiHeaderValue(
			version?.() || `${type()} ${release()}`,
		),
	};
}

export type KimiContent =
	| string
	| Array<
			| { type: "text"; text: string }
			| { type: "image_url"; image_url: { url: string } }
	>;

export interface KimiMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: KimiContent;
	name?: string;
	tool_calls?: KimiToolCall[];
	tool_call_id?: string;
	reasoning_content?: string;
}

export interface KimiToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

export interface KimiTool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

interface ChatOptions {
	topP?: number;
	maxTokens?: number;
	tools?: KimiTool[];
	stop?: string[];
	/** Live reasoning fields from reasoningRequestFields (thinking + reasoning_effort). Spread into the body. */
	reasoningFields?: Record<string, unknown>;
	promptCacheKey?: string;
	toolMode?: vscode.LanguageModelChatToolMode;
}

export interface KimiUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_tokens_details?: { cached_tokens?: number };
}

interface KimiStreamChunk {
	id: string;
	created: number;
	model: string;
	/** Moonshot-style streams put usage at the top level or inside choices[0]. */
	usage?: KimiUsage;
	choices: Array<{
		index: number;
		delta: {
			role?: string;
			content?: string;
			reasoning_content?: string;
			tool_calls?: Array<{
				index: number;
				id?: string;
				type?: string;
				function?: {
					name?: string;
					arguments?: string;
				};
			}>;
		};
		finish_reason: string | null;
		usage?: KimiUsage;
	}>;
}

interface KimiResponse {
	id: string;
	created: number;
	model: string;
	choices: Array<{
		index: number;
		message: {
			role: string;
			content: string;
			tool_calls?: KimiToolCall[];
		};
		finish_reason: string;
	}>;
	usage: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

export class KimiApiError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number,
		public readonly response?: unknown,
	) {
		super(message);
		this.name = "KimiApiError";
	}
}

export function summarizeErrorResponse(response: unknown, maxChars = 400): string {
	try {
		const text =
			typeof response === "string" ? response : JSON.stringify(response);
		if (text.length <= maxChars) {
			return text;
		}
		return `${text.slice(0, maxChars)}...`;
	} catch {
		return "";
	}
}

export class KimiApiClient {
	private readonly headers: Record<string, string>;

	constructor(apiKey: string) {
		this.headers = getDefaultHeaders(apiKey);
	}

	async *streamChat(
		model: string,
		messages: KimiMessage[],
		baseUrl: string,
		options?: ChatOptions,
		cancellationToken?: vscode.CancellationToken,
	): AsyncGenerator<KimiStreamChunk> {
		const response = await this.sendRequest(model, messages, baseUrl, true, options, cancellationToken);

		if (!response.body) {
			throw new KimiApiError("No response body", 0);
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				if (cancellationToken?.isCancellationRequested) {
					await reader.cancel();
					break;
				}

				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || !trimmed.startsWith("data:")) continue;

					const data = trimmed.slice(5).trim();
					// [DONE] is optional for all models (lenient SSE).
					if (data === "[DONE]") {
						return;
					}

					try {
						yield JSON.parse(data) as KimiStreamChunk;
					} catch {
						console.warn("Malformed SSE chunk skipped:", data);
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	async chat(
		model: string,
		messages: KimiMessage[],
		baseUrl: string,
		options?: ChatOptions,
		cancellationToken?: vscode.CancellationToken,
	): Promise<KimiResponse> {
		const response = await this.sendRequest(model, messages, baseUrl, false, options, cancellationToken);
		return response.json() as Promise<KimiResponse>;
	}

	/**
	 * List available model ids via `GET {baseUrl}/models` using the same
	 * headers as chat (KimiCLI UA + X-Msh-* + Bearer key). Parses the
	 * OpenAI shape `{ data: [{ id }] }` and drops non-chat ids
	 * (embeddings, rerankers, moderation, TTS, whisper).
	 */
	async listModels(baseUrl: string): Promise<string[]> {
		const response = await fetch(`${baseUrl}${MODELS_ENDPOINT}`, {
			method: "GET",
			headers: this.headers,
		});

		if (!response.ok) {
			const errorBody = await this.parseErrorBody(response);
			throw new KimiApiError(
				`Kimi API error: ${response.status} ${response.statusText}`,
				response.status,
				errorBody,
			);
		}

		const body: unknown = await response.json();
		const data =
			body !== null && typeof body === "object" &&
				Array.isArray((body as { data?: unknown }).data)
				? (body as { data: unknown[] }).data
				: [];

		const ids: string[] = [];
		for (const entry of data) {
			const id =
				entry !== null && typeof entry === "object"
					? (entry as { id?: unknown }).id
					: undefined;
			if (typeof id !== "string" || id.length === 0) continue;
			if (EXCLUDED_MODEL_PATTERN.test(id)) continue;
			ids.push(id);
		}
		return ids;
	}

	private buildRequestBody(
		model: string,
		messages: KimiMessage[],
		stream: boolean,
		options?: ChatOptions,
	): string {
		const body: Record<string, unknown> = {
			model,
			messages,
			stream,
			...(options?.reasoningFields ?? {}),
		};

		if (stream) {
			body.stream_options = { include_usage: true };
		}
		if (options?.topP !== undefined) {
			body.top_p = options.topP;
		}
		if (options?.maxTokens !== undefined) {
			body.max_completion_tokens = options.maxTokens;
		}
		if (options?.tools !== undefined) {
			body.tools = options.tools;
		}
		if (options?.stop !== undefined) {
			body.stop = options.stop;
		}
		if (options?.promptCacheKey) {
			body.prompt_cache_key = options.promptCacheKey;
		}
		if (options?.toolMode === vscode.LanguageModelChatToolMode.Auto) {
			body.tool_choice = "auto";
		} else if (options?.toolMode === vscode.LanguageModelChatToolMode.Required) {
			body.tool_choice = "required";
		}

		return JSON.stringify(body);
	}

	private async sendRequest(
		model: string,
		messages: KimiMessage[],
		baseUrl: string,
		stream: boolean,
		options?: ChatOptions,
		cancellationToken?: vscode.CancellationToken,
	): Promise<Response> {
		const abortController = new AbortController();
		const abortListener = cancellationToken?.onCancellationRequested(() => {
			abortController.abort();
		});

		try {
			const response = await fetch(`${baseUrl}${CHAT_ENDPOINT}`, {
				method: "POST",
				headers: this.headers,
				body: this.buildRequestBody(model, messages, stream, options),
				signal: abortController.signal,
			});

			if (response.ok) {
				return response;
			}

			const errorBody = await this.parseErrorBody(response);
			throw new KimiApiError(
				`Kimi API error: ${response.status} ${response.statusText}`,
				response.status,
				errorBody,
			);
		} finally {
			abortListener?.dispose();
		}
	}

	private async parseErrorBody(response: Response): Promise<unknown> {
		const errorText = await response.text();
		try {
			return JSON.parse(errorText);
		} catch {
			return errorText;
		}
	}
}
