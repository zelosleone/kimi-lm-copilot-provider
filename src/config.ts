import * as vscode from "vscode";
import { KIMI_MODELS, mergeModels, type KimiModelInfo } from "./models.js";

export const CONFIG_SECTION = "kimi";
export const API_BASE_URL_KEY = "apiBaseUrl";
export const MODELS_KEY = "models";

export const PRESET_URLS = {
    global: "https://api.kimi.com/coding/v1",
    china: "https://api.kimi.cn/coding/v1",
    ai: "https://api.kimi.ai/coding/v1",
} as const;

export function getApiBaseUrl(): string {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const url = config.get<string>(API_BASE_URL_KEY);
    if (typeof url === "string" && url.trim().length > 0) {
        return url.trim();
    }
    return PRESET_URLS.global;
}

export function getModels(): KimiModelInfo[] {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const overrides = config.get<unknown[]>(MODELS_KEY);
    if (!Array.isArray(overrides) || overrides.length === 0) {
        return KIMI_MODELS;
    }
    return mergeModels(KIMI_MODELS, overrides);
}

export async function setApiBaseUrl(
    url: string,
    global = true,
): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const target = global
        ? vscode.ConfigurationTarget.Global
        : vscode.ConfigurationTarget.Workspace;
    await config.update(API_BASE_URL_KEY, url, target);
}
