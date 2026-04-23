import type * as vscode from "vscode";

interface KimiModelInfo {
	id: string;
	name: string;
	family: string;
	version: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	tooltip: string;
	baseUrl: string;
	thinking: boolean;
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
		maxInputTokens: 262144,
		maxOutputTokens: 32768,
		baseUrl: "https://api.kimi.com/coding/v1",
		thinking: false,
		capabilities: { imageInput: true, toolCalling: true },
	},
	{
		id: "kimi-for-coding-thinking",
		name: "Kimi for Coding (Thinking)",
		family: "kimi",
		version: "for-coding-thinking",
		tooltip: "Moonshot AI",
		maxInputTokens: 262144,
		maxOutputTokens: 32768,
		baseUrl: "https://api.kimi.com/coding/v1",
		thinking: true,
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
		capabilities,
	};
}
