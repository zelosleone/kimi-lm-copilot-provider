import * as vscode from "vscode";
import { hostname, type, release, machine, version } from "node:os";
import { randomUUID } from "node:crypto";

const CHAT_ENDPOINT = "/chat/completions";
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

function getDefaultHeaders(apiKey: string): Record<string, string> {
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
	thinking?: boolean;
	promptCacheKey?: string;
	toolMode?: vscode.LanguageModelChatToolMode;
	/**
	 * When true (default), the stream must end with `data: [DONE]` or an error is thrown (Moonshot streaming docs).
	 * Kimi Coding (`api.kimi.com/coding`) may close the connection without sending `[DONE]`; set false for that endpoint.
	 */
	requireSseDoneMarker?: boolean;
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
		let sawDataEvent = false;
		let sawDoneMarker = false;
		const strictSseDone =
			options?.requireSseDoneMarker !== false;

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
					if (data === "[DONE]") {
						sawDoneMarker = true;
						return;
					}

					sawDataEvent = true;
					try {
						yield JSON.parse(data) as KimiStreamChunk;
					} catch {
						console.warn("Malformed SSE chunk skipped:", data);
					}
				}
			}

			if (
				strictSseDone &&
				!cancellationToken?.isCancellationRequested &&
				sawDataEvent &&
				!sawDoneMarker
			) {
				throw new KimiApiError(
					"Stream ended without a data: [DONE] chunk; the response may be incomplete (see Kimi streaming API documentation).",
					0,
				);
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
			thinking: thinking
				? { type: "enabled", keep: "all" }
				: { type: "disabled" },
		};

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
