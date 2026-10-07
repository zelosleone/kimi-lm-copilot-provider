# Kimi Language Model Provider for Copilot

Use your Kimi Code plan (Moonshot AI) in GitHub Copilot Chat.

1. In the Copilot Chat model picker, open **Manage Models**, pick **Moonshot** and paste your API key from [kimi.com/code/console](https://kimi.com/code/console).
2. Pick a Kimi model in the model picker.
3. Set reasoning effort right in the picker.

The model list comes live from the Kimi Code API, and context windows, image support and effort levels come from [models.dev](https://models.dev), so new Kimi models show up without an update. Brand-new models appear right away with safe default limits until models.dev lists them. Copilot's context window indicator works as usual.

Reasoning Effort is live per model: Auto, Off and levels such as Low, High and Max where the model supports them. Auto sends nothing and lets Kimi decide. Temperature isn't sent; Kimi picks its own. Thinking blocks need VS Code Insiders (proposed API).

## Endpoints

The default is `https://api.kimi.com/coding/v1` (setting `kimi.apiBaseUrl`, must end with `/coding/v1`). Switch with **Kimi: Set API Endpoint to Global (kimi.com)**, **China (kimi.cn)**, **Alternative (kimi.ai)** or **Set Custom API Endpoint**, and check your key with **Kimi: Test Connection**.

Kimi's coding API only accepts known clients, so requests identify as Kimi CLI (`KimiCLI` user agent and `X-Msh-*` headers).

## Build

```sh
npm install
npm run compile
npx -y @vscode/vsce package
```

MIT license.
