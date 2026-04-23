import type * as vscode from "vscode";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

const CHAT_ENDPOINT = "/chat/completions";
const VERSION = "0.1.0";
const DEVICE_ID = randomUUID().replace(/-/g, "");

function getDefaultHeaders(apiKey: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
		"User-Agent": `KimiCLI/${VERSION}`,
		"X-Msh-Platform": "kimi_cli",
		"X-Msh-Version": VERSION,
		"X-Msh-Device-Name": hostname() || "unknown",
		"X-Msh-Device-Id": DEVICE_ID,
	};
}

export interface KimiMessageContent {
	type: "text" | "image_url";
	text?: string;
	image_url?: {
		url: string;
	};
}

export interface KimiMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | KimiMessageContent[];
	name?: string;
	tool_calls?: KimiToolCall[];
	tool_call_id?: string;
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
	thinking?: boolean;
	promptCacheKey?: string;
}

interface KimiStreamChunk {
	id: string;
	created: number;
	model: string;
	choices: Array<{
		index: number;
		delta: {
			role?: string;
			content?: string;
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
		const response = await this.sendRequest(model, messages, baseUrl, true, options);

		if (!response.body) {
			throw new KimiApiError("No response body", 0);
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				if (cancellationToken?.isCancellationRequested) {
					reader.cancel();
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
					if (data === "[DONE]") return;

					try {
						yield JSON.parse(data) as KimiStreamChunk;
					} catch {
						// Malformed SSE chunks are non-fatal; skip and continue
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
	): Promise<KimiResponse> {
		const response = await this.sendRequest(model, messages, baseUrl, false, options);
		return response.json() as Promise<KimiResponse>;
	}

	private buildRequestBody(
		model: string,
		messages: KimiMessage[],
		stream: boolean,
		options?: ChatOptions,
	): string {
		const thinking = options?.thinking ?? false;
		const body: Record<string, unknown> = {
			model,
			messages,
			stream,
			thinking: { type: thinking ? "enabled" : "disabled" },
		};

		if (options?.topP !== undefined) {
			body.top_p = options.topP;
		}
		if (options?.maxTokens !== undefined) {
			body.max_tokens = options.maxTokens;
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

		return JSON.stringify(body);
	}

	private async sendRequest(
		model: string,
		messages: KimiMessage[],
		baseUrl: string,
		stream: boolean,
		options?: ChatOptions,
	): Promise<Response> {
		const response = await fetch(`${baseUrl}${CHAT_ENDPOINT}`, {
			method: "POST",
			headers: this.headers,
			body: this.buildRequestBody(model, messages, stream, options),
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
