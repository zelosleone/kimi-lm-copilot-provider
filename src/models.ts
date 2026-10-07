import type * as vscode from "vscode";
import {
	reasoningChoices,
	reasoningSchema,
	tokenLimits,
	type ModelsDevCache,
	type ReasoningChoices,
} from "./modelsDev.js";

/**
 * Model ids that are never chat models. Applied to `/models` results
 * (OpenAI shape `{ data: [{ id }] }`). This is a filter, not model data.
 */
export const EXCLUDED_MODEL_PATTERN = /embed|rerank|moderation|tts|whisper/i;

/** Live catalog entry: id from the provider, metadata from models.dev. */
export interface CatalogModel {
	id: string;
	name: string;
	context: number;
	output: number;
	imageInput: boolean;
	toolCalling: boolean;
	choices?: ReasoningChoices;
}

/**
 * Build live catalog entries from provider ids + models.dev cache.
 * Kimi's /models lists ids only, so all metadata comes from models.dev.
 * Ids with no context or output limit from either source use safe defaults.
 */
export function buildCatalogModels(
	ids: readonly string[],
	devCache: ModelsDevCache,
): { models: CatalogModel[]; skipped: string[] } {
	const models: CatalogModel[] = [];
	const skipped: string[] = [];
	for (const id of ids) {
		if (EXCLUDED_MODEL_PATTERN.test(id)) continue;
		const dev = devCache.models[id];
		const context = dev?.limit?.context;
		const output = dev?.limit?.output;
		if (typeof context !== "number" || typeof output !== "number") {
			// A model the vendor lists before models.dev catalogs it still shows up, with safe limits, corrected on the next refresh once models.dev knows it.
			const fallback = tokenLimits(131072, 32768);
			models.push({
				id,
				name: dev?.name ?? id,
				context: fallback.maxContextWindowTokens,
				output: fallback.maxOutputTokens,
				imageInput: false,
				toolCalling: true,
			});
			skipped.push(id);
			continue;
		}
		const choices = reasoningChoices(dev?.reasoning_options, undefined);
		models.push({
			id,
			name: dev?.name ?? id,
			context,
			output,
			imageInput: dev?.modalities?.input?.includes("image") ?? false,
			toolCalling: dev?.tool_call !== false,
			...(choices ? { choices } : {}),
		});
	}
	if (skipped.length > 0) {
		console.info(`Kimi: models using default limits: ${skipped.join(", ")}`);
	}
	return { models, skipped };
}

export function toLanguageModelChatInformation(
	model: CatalogModel,
): vscode.LanguageModelChatInformation {
	const limits = tokenLimits(model.context, model.output);

	return {
		id: model.id,
		name: model.name,
		family: "kimi",
		version: model.id,
		tooltip: "Moonshot AI",
		detail: "Moonshot AI",
		maxContextWindowTokens: limits.maxContextWindowTokens,
		maxInputTokens: limits.maxInputTokens,
		maxOutputTokens: limits.maxOutputTokens,
		isUserSelectable: true,
		isBYOK: true,
		capabilities: {
			imageInput: model.imageInput,
			toolCalling: model.toolCalling,
		},
		...(model.choices ? { configurationSchema: reasoningSchema(model.choices) } : {}),
	} as unknown as vscode.LanguageModelChatInformation;
}
