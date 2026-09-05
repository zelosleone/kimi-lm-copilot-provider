import type * as vscode from "vscode";

export interface KimiModelInfo {
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

const NEW_MODEL_DEFAULTS: Omit<KimiModelInfo, "id" | "name"> = {
	family: "kimi",
	version: "custom",
	tooltip: "Moonshot AI",
	maxInputTokens: 262144,
	maxOutputTokens: 32768,
	thinking: true,
	requireSseDoneMarker: false,
	capabilities: { imageInput: true, toolCalling: true },
};

/**
 * Merge user-configured model entries with the built-in defaults by `id`:
 * same id overrides fields, new id appends a model with fields defaulted.
 * Entries without a non-empty string `id` are skipped. Inputs are not mutated.
 */
export function mergeModels(
	defaults: readonly KimiModelInfo[],
	overrides: readonly unknown[],
): KimiModelInfo[] {
	const merged = defaults.map((m) => ({ ...m, capabilities: { ...m.capabilities } }));

	for (const entry of overrides) {
		if (!entry || typeof entry !== "object") continue;
		const raw = entry as Record<string, unknown>;
		const id = raw.id;
		if (typeof id !== "string" || id.trim().length === 0) continue;

		const clean: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(raw)) {
			if (value !== undefined) clean[key] = value;
		}

		const existing = merged.find((m) => m.id === id);
		if (existing) {
			Object.assign(existing, clean);
			continue;
		}

		merged.push({
			...NEW_MODEL_DEFAULTS,
			capabilities: { ...NEW_MODEL_DEFAULTS.capabilities },
			...(clean as Partial<KimiModelInfo>),
			id,
			name: typeof raw.name === "string" && raw.name.trim() ? raw.name : id,
		} as KimiModelInfo);
	}

	return merged;
}

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
