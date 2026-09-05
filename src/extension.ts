import * as vscode from "vscode";
import { KimiApiClient, KimiApiError, summarizeErrorResponse } from "./api";
import {
	API_BASE_URL_KEY,
	CONFIG_SECTION,
	MODELS_KEY,
	getApiBaseUrl,
	PRESET_URLS,
	setApiBaseUrl,
} from "./config";
import { KimiChatProvider } from "./provider";

const DEFAULT_MODEL_ID = "kimi-for-coding";

function formatConnectionError(err: unknown): string {
	const detail = err instanceof KimiApiError && err.response
		? ` ${summarizeErrorResponse(err.response)}`
		: "";
	return `Kimi test failed: ${err instanceof Error ? err.message : String(err)}${detail}`;
}

async function runConnectionTest(): Promise<void> {
	const key = await vscode.window.showInputBox({
		prompt: "Enter your Kimi API key to test",
		password: true,
		placeHolder: "sk-...",
	});
	if (!key) return;

	const client = new KimiApiClient(key.trim());
	const baseUrl = getApiBaseUrl();
	try {
		await client.chat(
			DEFAULT_MODEL_ID,
			[{ role: "user", content: "Ping" }],
			baseUrl,
			{ maxTokens: 1 },
		);
		vscode.window.showInformationMessage(`Kimi connection test succeeded using ${baseUrl}.`);
	} catch (err) {
		vscode.window.showErrorMessage(formatConnectionError(err));
	}
}

async function setBaseUrlAndNotify(
	provider: KimiChatProvider,
	url: string,
	label: string,
): Promise<void> {
	await setApiBaseUrl(url);
	provider.notifyModelsChanged();
	vscode.window.showInformationMessage(`Kimi: Switched to ${label} (${url})`);
}

async function setCustomBaseUrl(provider: KimiChatProvider): Promise<void> {
	const input = await vscode.window.showInputBox({
		prompt: "Enter custom Kimi API base URL",
		placeHolder: "https://api.kimi.com/coding/v1",
		value: getApiBaseUrl(),
		validateInput: (value) => {
			if (!value || value.trim().length === 0) {
				return "URL cannot be empty";
			}
			try {
				new URL(value.trim());
				return undefined;
			} catch {
				return "Invalid URL";
			}
		},
	});
	if (!input) return;
	await setBaseUrlAndNotify(provider, input.trim(), "custom endpoint");
}

export function activate(context: vscode.ExtensionContext): void {
	const provider = new KimiChatProvider();

	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider("moonshot", provider),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (
				event.affectsConfiguration("moonshot") ||
				event.affectsConfiguration(`${CONFIG_SECTION}.${API_BASE_URL_KEY}`) ||
				event.affectsConfiguration(`${CONFIG_SECTION}.${MODELS_KEY}`)
			) {
				provider.notifyModelsChanged();
			}
		}),
		vscode.commands.registerCommand("kimi.testConnection", runConnectionTest),
		vscode.commands.registerCommand("kimi.setBaseUrl.global", () =>
			setBaseUrlAndNotify(provider, PRESET_URLS.global, "Global API (kimi.com)"),
		),
		vscode.commands.registerCommand("kimi.setBaseUrl.china", () =>
			setBaseUrlAndNotify(provider, PRESET_URLS.china, "China API (kimi.cn)"),
		),
		vscode.commands.registerCommand("kimi.setBaseUrl.ai", () =>
			setBaseUrlAndNotify(provider, PRESET_URLS.ai, "Alternative API (kimi.ai)"),
		),
		vscode.commands.registerCommand("kimi.setBaseUrl.custom", () =>
			setCustomBaseUrl(provider),
		),
	);
}

export function deactivate(): void { }
