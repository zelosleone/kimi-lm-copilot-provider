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

/**
 * Model ids that are never chat models. Applied to `/models` results
 * (OpenAI shape `{ data: [{ id }] }`).
 */
export const EXCLUDED_MODEL_PATTERN = /embed|rerank|moderation|tts|whisper/i;

/** Turn a raw model id (e.g. "kimi-k2-2.5") into a display name ("Kimi K2 2.5"). */
export function humanizeKimiModelId(id: string): string {
	const words = id.split(/[-_\s]+/).filter((w) => w.length > 0);
	if (words.length === 0) return id;
	return words
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

/**
 * Resolve a model id to full info: a known entry when the id matches,
 * otherwise lenient inferred defaults (unknown models may omit [DONE],
 * so requireSseDoneMarker is false).
 */
export function resolveKimiModel(id: string): KimiModelInfo {
	const known = KIMI_MODELS.find((m) => m.id === id);
	if (known) return known;
	return {
		id,
		name: humanizeKimiModelId(id),
		family: "kimi",
		version: id,
		tooltip: "Moonshot AI",
		maxInputTokens: 229376,
		maxOutputTokens: 32768,
		thinking: true,
		requireSseDoneMarker: false,
		capabilities: { imageInput: true, toolCalling: true },
	};
}

/**
 * Merge fetched `/models` ids with the known list: server order first
 * (resolved via resolveKimiModel), then any known entries the server
 * omitted (e.g. kimi-for-coding), deduplicated by id.
 */
export function mergeKimiModels(fetchedIds: string[]): KimiModelInfo[] {
	const seen = new Set<string>();
	const merged: KimiModelInfo[] = [];
	for (const id of fetchedIds) {
		if (!id || seen.has(id)) continue;
		seen.add(id);
		merged.push(resolveKimiModel(id));
	}
	for (const known of KIMI_MODELS) {
		if (seen.has(known.id)) continue;
		seen.add(known.id);
		merged.push(known);
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
