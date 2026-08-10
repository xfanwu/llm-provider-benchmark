# LLM Provider Benchmark — Product Requirements Document (PRD)

## 1. Background and goals

There are many LLM API providers (OpenRouter, Replicate, Vercel AI Gateway, Cloudflare AI Gateway, and so on), and the actual performance of the same model differs across providers. There is no simple tool for a direct side-by-side comparison.

**Goal**: build a web tool that sends the **same prompt group** to the **same model** across different providers concurrently, and compares **TTFT (time to first token)**, **throughput (tokens/s)** and other metrics in real time to support provider selection.

## 2. Users and core scenarios

- **Users**: developers / engineers doing provider selection.
- **Core scenario**:
  1. Pick a model (e.g. `llama-3.3-70b`);
  2. Tick 2~N providers;
  3. Select or edit several prompt groups;
  4. Run — all providers get the same prompts concurrently;
  5. Watch each provider's TTFT, throughput, total latency and cost estimate update in real time;
  6. Repeat multiple rounds and take averages/medians.

## 3. Functional requirements

### 3.1 P0 — Provider management

- Built-in preset providers in two categories:
  - **API key auth (OpenAI-compatible protocol)**: OpenRouter, Vercel AI Gateway, Cloudflare AI Gateway, Together, Fireworks, Groq, DeepInfra, etc.;
  - **GCP auth (OpenAI-compatible protocol)**: Vertex AI — endpoint is `https://aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi`; the protocol is OpenAI-compatible, but auth is Google Cloud OAuth (service account JSON → access token; the token expires after 1 hour and must be refreshed).
- Per-provider configuration:
  - Auth info: API key, or Vertex's project / location / service account JSON (stored in browser localStorage only — never in a database, never uploaded);
  - Model ID mapping (the actual model name per provider differs, e.g. Vertex uses `google/gemini-3.5-flash`) and capability tags (text / vision);
  - Provider-specific parameter passthrough (e.g. Vertex's `extra_body.google.thinking_config`, OpenRouter custom headers).
- Users can add custom OpenAI-compatible providers.

### 3.2 P0 — Model and task classification

- Models are classified by task type; the MVP supports two:
  - **Text reasoning (text)**: text in, text out, including reasoning models;
  - **Multimodal vision (vision)**: image + text input, text output.
- Classification runs through the whole flow: pick a model (with type) → filter providers that support it → only show matching prompt groups.
- Provider model mappings carry capability tags (text / vision); before running, validate that the provider supports the selected model and input type.
- The structure leaves room for more types later: embeddings, image generation, TTS, etc.

### 3.3 P0 — Prompt group management

- Prompt groups are typed: **text groups** / **image+text groups**.
- Text group: name, system prompt (optional), user prompt, `max_tokens`, `temperature`.
- Image+text group: everything in a text group plus **image input** — local upload (base64 data URL) or image URL; a unified image library for reuse.
- Images use the OpenAI-compatible `image_url` content format; record image resolution and file size (they affect prefill and billing).
- Built-in example groups: short Q&A / long-form generation / code generation / image understanding (describe the image, chart Q&A).

### 3.4 P0 — Benchmark run

- Send **concurrent streaming requests** to the selected providers (for image+text groups, the same image + prompt goes to every vision model concurrently), timing each provider independently.
- Each prompt group can be run with a configurable repeat count (default 3); results are aggregated as average/median/p50/p95.
- Run abort supported (AbortController).

### 3.5 P0 — Metric collection

- TTFT (time to first token, ms)
- TTFB (time to first HTTP byte, ms): the difference from TTFT separates network/queueing from model generation — especially useful for gateway providers (Cloudflare / Vercel)
- Total latency (ms)
- Output token count
- Throughput (tokens/s, end to end)
- Decode rate (tokens/s after TTFT)
- ITL / TPOT (inter-token interval): record every chunk gap, report p50/p95, to measure output jitter
- Prefill rate estimate: input tokens ÷ (TTFT − network overhead); meaningful for long prompts
- Multi-round statistics: TTFT / throughput reported as p50/p95 to avoid single-run outliers
- Error / timeout markers (distinguish 429 rate limit, 5xx, timeout)
- Cost estimate (if per-provider unit prices are configured, USD; image+text groups include image token cost)

### 3.6 P0 — Results display

- Real-time table + bar charts comparing TTFT / throughput.
- Per-round raw results expandable (including the raw output text, to verify output length differences).
- Export JSON / CSV.

### 3.7 P1 — Later iterations

- Multi-model comparison at once;
- History persistence (IndexedDB);
- Shareable result links;
- Side-by-side display of gateway-provider telemetry (Cloudflare / Vercel);
- More cloud adapters: AWS Bedrock (SigV4 signing), Azure OpenAI (api-key + deployment-scoped URL); both are non-standard OpenAI-compatible or complex auth, implemented as adapters.

## 4. Non-functional requirements

- **Privacy**: credentials (API keys / service account JSON) live in the browser only; the server is a relay (proxy) that never records or persists credentials. Vertex OAuth token exchange happens per request on the proxy; access tokens are cached in memory only and discarded on expiry.
- **CORS**: solved by the proxy layer (GCP / AWS signing and OAuth flows must run server-side; direct browser calls are not possible).
- **Guardrails**: per run, providers × prompt groups × repeats ≤ configurable limit (default 100 requests).
- Default per-request timeout: 60 s.

## 5. Technical approach

**Next.js (App Router) + TypeScript monorepo-style full stack**:

- Frontend: Next.js + Tailwind + shadcn/ui, charts with Recharts.
- Backend: Next.js Route Handlers as SSE/streaming proxies forwarding to each provider's endpoint; timing is done in the frontend based on streamed chunks (TTFT = arrival of the first non-empty content chunk).
- **Provider registry + adapter pattern** (core design, keeps adding providers cheap):
  - All providers are declared in one registry (`providers.ts`): id, name, protocol type, auth method, model mapping, unit prices;
  - **Protocol adapters**: `openai-compatible` covers most providers with zero code — pure config; proprietary protocols (Replicate, later Bedrock / Azure) implement a unified `ProviderAdapter` interface;
  - **Auth strategies** are decoupled from the protocol: `api-key` (header passthrough), `gcp-oauth` (service account → access token, refreshed server-side), `aws-sigv4` (P1), `azure-key` (P1);
  - Timing, metric collection and display are driven entirely by the adapter's unified chunk stream — new providers never touch this code.
- Replicate: a dedicated provider adapter module (REST / streaming API).
- State: React state + localStorage; no database.
- Deployment: one-click on Vercel.

## 6. Data and interface notes

- Unified internal interface: `runBenchmark({ provider, model, prompt, params }) -> AsyncIterable<chunk>`; every provider implements an adapter; `prompt` supports text and image+text (`image_url` content) forms.
- Provider registry entry:

```ts
interface ProviderConfig {
  id: string;
  name: string;
  protocol: 'openai-compatible' | 'replicate';  // P1: 'bedrock' | 'azure'
  auth: 'api-key' | 'gcp-oauth';                // P1: 'aws-sigv4' | 'azure-key'
  baseUrl: string;                              // may contain {project}/{location} placeholders (Vertex)
  models: { logical: string; remote: string; capabilities: ('text'|'vision')[] }[];
  pricing?: { inputPer1M: number; outputPer1M: number };
  defaultHeaders?: Record<string, string>;      // e.g. OpenRouter's HTTP-Referer
  extraBody?: Record<string, unknown>;          // e.g. Vertex's google.thinking_config
}
```

- Auth is handled on the proxy per `auth` strategy: `api-key` passes through the header; `gcp-oauth` exchanges the service account JSON for an access token (cached in memory until expiry, reused within the 1-hour validity).
- Metric structure:

```ts
interface RunMetrics {
  ttfbMs: number | null;     // first HTTP byte (separates network/queueing vs model generation)
  ttftMs: number | null;
  totalMs: number;
  outputTokens: number;      // exact value or local estimate (marked)
  tokensPerSec: number;
  decodeTokensPerSec: number;
  itlMsP50?: number;         // per-token interval p50/p95 (jitter)
  itlMsP95?: number;
  costUsd?: number;          // image+text groups include image token cost
  error?: string;
}
```

- Streaming parsing: OpenAI-compatible SSE (`data: {...}\n\n`, ending with `data: [DONE]`); Replicate uses its streaming API.

## 7. Edge cases

- Provider error / rate limit / timeout: mark that row as errored with the reason; other providers keep running.
- Provider does not support the selected model or input type (e.g. text-only model sent an image request): warn during configuration, validate and block before running.
- Oversized images: if the base64 image exceeds a provider's size/resolution limits, prompt to compress or swap before running; limits differ per provider — validate against the strictest.
- Response missing `usage`: estimate tokens locally (approximate by chunk deltas) and mark as "estimated" in the UI.

## 8. Milestones

- **M1**: Next.js scaffold + provider registry / adapter abstraction + provider config + OpenAI-compatible streaming proxy + single prompt group with TTFT/throughput working.
- **M2**: Vertex AI adapter (GCP OAuth auth + `extra_body` passthrough); prompt group management (incl. image+text groups), repeat counts, charts, JSON/CSV export.
- **M3**: Replicate adapter, custom providers, cost estimation.
- **M4 (P1)**: Bedrock (SigV4), Azure OpenAI adapters.
