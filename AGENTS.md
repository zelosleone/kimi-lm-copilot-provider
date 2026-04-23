# AGENTS Guide

This file helps AI coding agents become productive quickly in this repository.

## Scope

- This is a VS Code extension that registers Moonshot Kimi as a Copilot Chat language model provider.
- Primary source files are under `src/`.
- Product and API overview lives in [README.md](README.md).

## Fast Start

1. Install deps: `npm install`
2. Compile once: `npm run compile`
3. Dev watch mode: `npm run watch`
4. Package extension: `npx vsce package`

Notes:
- There is currently no test script in [package.json](package.json).
- Compiled output goes to `out/`.

## Architecture Boundaries

- [src/extension.ts](src/extension.ts): extension activation, provider registration, `kimi.testConnection` command.
- [src/provider.ts](src/provider.ts): VS Code `LanguageModelChatProvider` implementation, message/tool conversion, streaming response emission.
- [src/api.ts](src/api.ts): Kimi HTTP client, request headers/body, SSE parsing, typed API errors.
- [src/models.ts](src/models.ts): model registry and model metadata exposed to VS Code.

Rule of thumb:
- Keep HTTP protocol logic in `api.ts`.
- Keep VS Code adaptation logic in `provider.ts`.
- Keep model definitions centralized in `models.ts`.

## Conventions

- TypeScript strict mode is enabled (see [tsconfig.json](tsconfig.json)).
- Prefer small, typed helpers for unknown input parsing and normalization.
- Preserve ESM-style local imports with `.js` extension in TypeScript source where already used.
- Avoid broad refactors unless requested; keep changes minimal and localized.

## Known Pitfalls

- Streaming parser in [src/api.ts](src/api.ts) assumes SSE `data:` lines; malformed chunks are skipped silently.
- Thinking rendering in [src/provider.ts](src/provider.ts) depends on exact `<think>` and `</think>` tags.
- Token counting in [src/provider.ts](src/provider.ts) is heuristic (`chars / 4`), not tokenizer-accurate.
- Do not log full API keys or sensitive config values.

## Change Checklist For Agents

Before finishing code changes:
1. Run `npm run compile` and fix TypeScript errors.
2. Keep provider API behavior backward compatible unless the task requires breaking changes.
3. If adding a model, update [src/models.ts](src/models.ts) and verify provider lookup behavior in [src/provider.ts](src/provider.ts).
4. If changing request payload/headers, verify alignment with API notes in [README.md](README.md).

## Where To Look First

- Extension manifest and commands: [package.json](package.json)
- API usage and request contract notes: [README.md](README.md)
- Provider runtime path: [src/provider.ts](src/provider.ts)
