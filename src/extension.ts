import * as vscode from "vscode";
import { KimiApiClient, KimiApiError } from "./api";
import { KimiChatProvider } from "./provider";

const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
const DEFAULT_MODEL_ID = "kimi-for-coding";

function formatConnectionError(err: unknown): string {
	const detail = err instanceof KimiApiError && err.response
		? ` ${JSON.stringify(err.response)}`
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
	try {
		await client.chat(
			DEFAULT_MODEL_ID,
			[{ role: "user", content: "Ping" }],
			DEFAULT_BASE_URL,
			{ maxTokens: 1 },
		);
		vscode.window.showInformationMessage("Kimi connection test succeeded.");
	} catch (err) {
		vscode.window.showErrorMessage(formatConnectionError(err));
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const provider = new KimiChatProvider();

	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider("moonshot", provider),
	);

	context.subscriptions.push(provider);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("languageModelChatProviders")) {
				provider.refreshLanguageModelChatInformation();
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("kimi.testConnection", runConnectionTest),
	);
}

export function deactivate(): void {}
