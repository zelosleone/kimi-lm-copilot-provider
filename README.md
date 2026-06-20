# Kimi LM Copilot Provider

VS Code language model provider that connects Copilot Chat to Moonshot Kimi. Just enter your API key from `kimi.com/code/console` and start chatting with the model in VS Code Copilot Chat/Agent. 

## If you want to compile yourself

1. Install dependencies: `npm install`
2. Compile: `npm run compile`
3. Run npx `vsce package` to create the `.vsix` file.
4. Load the extension in VS Code.
5. Configure `apiKey` from `kimi.com/code/console` in the model provider settings.

## API

- Base URL: `https://api.kimi.com/coding/v1`
- Chat endpoint: `/chat/completions`
- Full endpoint used by the client: `https://api.kimi.com/coding/v1/chat/completions`

## Request Fields

The client sends:

- `model`
- `messages`
- `stream`
- `thinking` (as `{ type: "enabled", keep: "all" }` or `{ type: "disabled" }`)
- `top_p` (optional)
- `max_completion_tokens` (optional)
- `tools` (optional)
- `tool_choice` (optional, `auto` or `required`)
- `stop` (optional)
- `prompt_cache_key` (optional, from `metadata.taskId`)

Notes:

- `temperature` is not sent by this extension. I am letting API handle it by itself. Chinese providers are better at handling these stuff by themselves, and I don't want to mess with it.
- `safety_identifier` is not sent.
- Image and data attachments are supported via `LanguageModelDataPart`; images are base64-encoded into `image_url` objects.

## Default Headers

Currently, Kimi wouldn't accept ANY clients so we need to send extra headers to larp as an accepted client.

Each request includes:

- `Content-Type: application/json`
- `Authorization: Bearer <apiKey>`
- `User-Agent: KimiCLI/<version>`
- `X-Msh-Platform: kimi_cli`
- `X-Msh-Version: <version>`
- `X-Msh-Device-Name: <hostname>`
- `X-Msh-Device-Model: <OS model>`
- `X-Msh-Device-Id: <generated device id>`
- `X-Msh-Os-Version: <OS version>`

## Streaming and Tools

- Streaming responses are consumed as SSE (`data:` lines).
- Reasoning content (`reasoning_content`) is streamed and rendered in collapsible `<details><summary>Thinking</summary>` blocks.
- Tool calls are collected from streamed deltas and emitted when the model finishes with `tool_calls`.
- If the model returns tool calls after reasoning, the reasoning block is automatically closed before the tool calls are emitted.
