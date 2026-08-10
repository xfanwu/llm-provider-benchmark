# LLM Provider Benchmark

Fire the **same model and prompt** at multiple LLM providers concurrently and compare **TTFT (time to first token)**, **throughput (tokens/s)** and more, in real time — to help you pick the right provider.

## Features

- Built-in providers: OpenRouter, Vercel AI Gateway, Cloudflare Unified, Together, Fireworks, Groq, DeepInfra, 302.AI, Vertex AI, AWS Bedrock
- Three auth strategies (handled by the server-side proxy; credentials are never logged or persisted):
  - **API key**: header passthrough (OpenAI-compatible protocol)
  - **GCP OAuth**: service account JSON → access token (in-memory cache, auto-refresh)
  - **AWS SigV4**: IAM credential signing (temporary credentials with Session Token supported)
- AWS Bedrock via the **bedrock-mantle** endpoint, with the API surface chosen per model:
  - `/openai/v1/responses` → GPT-5.6 Luna / Sol (e.g. `openai.gpt-5.6-luna`)
  - `/v1/chat/completions` → GPT-OSS, Gemma and others
  - `/anthropic/v1/messages` → Claude 5 family
  - Responses / Messages SSE events are translated server-side into OpenAI-compatible chunks, so the frontend parser and metrics are fully reused
- Metrics: TTFB / TTFT / total time / output tokens (with estimation marker) / throughput / decode rate
- Concurrent streaming requests, abort at any time, per-provider error isolation, expandable raw output
- Custom OpenAI-compatible providers supported
- All credentials live in browser localStorage only; the server is a pure relay

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:3000.

### Configure providers

1. Copy the env template and fill it in:

```bash
cp .env.example .env
```

2. Env vars ending in `_API_KEY` appear in the "From .env" dropdown in the UI (local development only, see the security notes below).
3. Tick a provider, fill in its key (or pick from the dropdown), confirm the model name, and run.

### AWS Bedrock prerequisites

- Enable **model access** in the Bedrock console (Model access)
- The IAM user needs `bedrock-mantle:CreateInference` / `bedrock-mantle:Get*` / `bedrock-mantle:List*` permissions
- Option A (recommended): set `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in `.env` (add `AWS_SESSION_TOKEN` for temporary credentials) and leave the UI fields blank
- Option B: fill Region / Access Key ID / Secret Access Key directly in the UI (stored in the browser only)

## Security notes

**This tool is designed for local use.** If you deploy it publicly, note:

- `/api/run` is an unauthenticated streaming proxy — anyone who can reach your deployment can use your configured keys / server credentials to call upstream APIs.
- Server-side keys only take effect when `LPB_ENABLE_SERVER_KEYS=1` is set (`/api/env-keys` returns `*_API_KEY` values; `/api/run` falls back to server-side AWS credentials). **Do not set this variable on a public deployment.**
- `.env` is gitignored; never commit real credentials. `.env.example` contains placeholders only and is safe to commit.

## Tech stack

Next.js (App Router) + TypeScript + Tailwind CSS v4, no extra runtime dependencies (SigV4 signing and GCP OAuth are implemented with `node:crypto`).

## License

[WTFPL](LICENSE)
