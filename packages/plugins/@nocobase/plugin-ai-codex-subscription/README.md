# AI LLM: Codex/ChatGPT subscription

This plugin registers a NocoBase AI LLM provider named `codex-subscription` and connects it to a real ChatGPT subscription through OpenAI OAuth.

## What changed

This provider no longer uses:

- bridge URLs
- pasted session secrets
- compatibility API keys as real credentials

Instead it:

1. opens the OpenAI OAuth login flow,
2. receives the callback in NocoBase,
3. stores the access/refresh tokens encrypted in NocoBase,
4. refreshes tokens when needed,
5. calls the ChatGPT Codex backend directly.

The `apiKey` option remains only as a non-secret sentinel because the current generic NocoBase test-flight UI still expects it.

## Setup

1. Enable `@nocobase/plugin-ai`.
2. Enable `@nocobase/plugin-ai-codex-subscription`.
3. Create or edit an LLM service whose provider is `codex-subscription`.
4. Save the service.
5. Click `Connect ChatGPT` in the provider settings.
6. Complete the browser OAuth flow.
7. Run test flight.

## Stored data

The plugin stores only encrypted OAuth tokens plus connection metadata:

- LLM service name
- ChatGPT account id
- encrypted access token
- encrypted refresh token
- expiry / verification timestamps

Ecobase collections, reports, prompts, and evidence rows must never store raw OAuth tokens.

## Mock mode

`mockMode` and `mockResponse` still exist for local tests.

## Runtime behavior

- `listModels()` returns a curated model list for configuration.
- `testFlight()` and live prompts require a completed OAuth connection.
- expired access tokens are refreshed automatically with the stored refresh token.
- live requests go to `https://chatgpt.com/backend-api/codex/responses` unless `options.baseURL` overrides the backend root.

## Limitations

This plugin only provides an LLM connection for NocoBase AI employees and provider-backed generation paths. It does not change deterministic Ecobase logic.
