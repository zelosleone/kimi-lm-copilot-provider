import type * as vscode from "vscode";

interface KimiModelInfo {
	id: string;
	name: string;
	family: string;
	version: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	tooltip: string;
	thinking: boolean;
	/**
	 * When true, streaming must include a terminal `data: [DONE]` SSE event (strict Moonshot behavior).
	 * Kimi Coding API may omit it; set false for those models.
	 */
	requireSseDoneMarker: boolean;
	capabilities: {
		imageInput: boolean;
		toolCalling: boolean;
	};
}

export const KIMI_MODELS: KimiModelInfo[] = [
	{
		id: "kimi-for-coding",
		name: "Kimi for Coding",
		family: "kimi",
		version: "for-coding",
		tooltip: "Moonshot AI",
		maxInputTokens: 229376,
		maxOutputTokens: 32768,
		thinking: true,
		requireSseDoneMarker: false,
		capabilities: { imageInput: true, toolCalling: true },
	},
];

export function toLanguageModelChatInformation(
	model: KimiModelInfo,
): vscode.LanguageModelChatInformation {
	const {
		id,
		name,
		family,
		version,
		tooltip,
		maxInputTokens,
		maxOutputTokens,
		capabilities,
	} = model;

	return {
		id,
		name,
		family,
		version,
		tooltip,
		detail: tooltip,
		maxInputTokens,
		maxOutputTokens,
		isUserSelectable: true,
		capabilities,
	} as vscode.LanguageModelChatInformation;
}
