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
 * Ids with no context or output limit from either source are skipped.
 */
export function buildCatalogModels(
	ids: readonly string[],
	devCache: ModelsDevCache,
): { models: CatalogModel[]; skipped: string[] } {
	const models: CatalogModel[] = [];
	const skipped: string[] = [];
	for (const id of ids) {
		const dev = devCache.models[id];
		const context = dev?.limit?.context;
		const output = dev?.limit?.output;
		if (typeof context !== "number" || typeof output !== "number") {
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
		console.warn(`Kimi: skipped models without live limits: ${skipped.join(", ")}`);
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
