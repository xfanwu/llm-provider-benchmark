// Provider registry: all M1 providers are OpenAI-compatible with API key auth,
// so a new provider is pure configuration here — no adapter code required.

export interface ModelMapping {
  logical: string;
  remote: string;
  capabilities: ('text' | 'vision')[];
  /** API surface on the upstream provider. Defaults to 'chat-completions'. */
  api?: 'chat-completions' | 'responses' | 'messages';
}

export interface ProviderConfig {
  id: string;
  name: string;
  protocol: 'openai-compatible';
  auth: 'api-key' | 'gcp-oauth' | 'aws-sigv4';
  baseUrl: string;
  models: ModelMapping[];
  pricing?: { inputPer1M: number; outputPer1M: number };
  defaultHeaders?: Record<string, string>;
  /** When true, the UI shows an editable baseUrl field (placeholder URLs). */
  baseUrlEditable?: boolean;
}

export const PROVIDERS: ProviderConfig[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai-compatible',
    auth: 'api-key',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      { logical: 'llama-3.3-70b', remote: 'meta-llama/llama-3.3-70b-instruct', capabilities: ['text'] },
      { logical: 'qwen-2.5-72b', remote: 'qwen/qwen-2.5-72b-instruct', capabilities: ['text'] },
    ],
  },
  {
    id: 'vercel-gateway',
    name: 'Vercel AI Gateway',
    protocol: 'openai-compatible',
    auth: 'api-key',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    models: [
      { logical: 'llama-3.3-70b', remote: 'meta/llama-3.3-70b', capabilities: ['text'] },
      { logical: 'gpt-4o-mini', remote: 'openai/gpt-4o-mini', capabilities: ['text', 'vision'] },
    ],
  },
  {
    // Cloudflare unified AI endpoint: model ids come from the catalog at
    // developers.cloudflare.com/ai/models (e.g. google/gemini-3.6-flash).
    // Auth is a Cloudflare API token, not the upstream provider key.
    id: 'cloudflare-unified',
    name: 'Cloudflare 统一端点',
    protocol: 'openai-compatible',
    auth: 'api-key',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
    baseUrlEditable: true,
    models: [
      { logical: 'gemini-3.6-flash', remote: 'google/gemini-3.6-flash', capabilities: ['text', 'vision'] },
      { logical: 'gpt-4.1-mini', remote: 'openai/gpt-4.1-mini', capabilities: ['text', 'vision'] },
    ],
  },
  {
    id: 'together',
    name: 'Together',
    protocol: 'openai-compatible',
    auth: 'api-key',
    baseUrl: 'https://api.together.xyz/v1',
    models: [
      { logical: 'llama-3.3-70b', remote: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', capabilities: ['text'] },
      { logical: 'qwen-2.5-72b', remote: 'Qwen/Qwen2.5-72B-Instruct-Turbo', capabilities: ['text'] },
    ],
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    protocol: 'openai-compatible',
    auth: 'api-key',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    models: [
      { logical: 'llama-3.3-70b', remote: 'accounts/fireworks/models/llama-v3p3-70b-instruct', capabilities: ['text'] },
      { logical: 'qwen-2.5-72b', remote: 'accounts/fireworks/models/qwen2p5-72b-instruct', capabilities: ['text'] },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    protocol: 'openai-compatible',
    auth: 'api-key',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: [
      { logical: 'llama-3.3-70b', remote: 'llama-3.3-70b-versatile', capabilities: ['text'] },
      { logical: 'llama-3.1-8b', remote: 'llama-3.1-8b-instant', capabilities: ['text'] },
    ],
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    protocol: 'openai-compatible',
    auth: 'api-key',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    models: [
      { logical: 'llama-3.3-70b', remote: 'meta-llama/Llama-3.3-70B-Instruct', capabilities: ['text'] },
      { logical: 'qwen-2.5-72b', remote: 'Qwen/Qwen2.5-72B-Instruct', capabilities: ['text'] },
    ],
  },
  {
    id: 'ai302',
    name: '302.AI',
    protocol: 'openai-compatible',
    auth: 'api-key',
    baseUrl: 'https://api.302.ai',
    models: [
      { logical: 'gpt-4o-mini', remote: 'gpt-4o-mini', capabilities: ['text', 'vision'] },
      { logical: 'gemini-flash', remote: 'gemini-2.5-flash', capabilities: ['text', 'vision'] },
    ],
  },
  {
    id: 'vertex',
    name: 'Vertex AI',
    protocol: 'openai-compatible',
    auth: 'gcp-oauth',
    baseUrl:
      'https://aiplatform.googleapis.com/v1/projects/{project_id}/locations/{location}/endpoints/openapi',
    models: [
      { logical: 'gemini-3.5-flash', remote: 'google/gemini-3.5-flash', capabilities: ['text', 'vision'] },
      { logical: 'gemini-3.1-pro', remote: 'google/gemini-3.1-pro', capabilities: ['text', 'vision'] },
    ],
  },
  {
    // AWS Bedrock via the bedrock-mantle endpoint (recommended by AWS for
    // OpenAI/Anthropic-compatible APIs, and the only endpoint hosting GPT-5.6).
    // One endpoint, three API surfaces — selected per model via `api`:
    //   - /openai/v1/responses      → OpenAI new-gen models (GPT-5.6 Luna/Terra/Sol)
    //   - /v1/chat/completions      → OpenAI-compatible models (GPT-OSS, Gemma, ...)
    //   - /anthropic/v1/messages    → Claude models (Claude 5 family)
    // The proxy signs with SigV4 (service "bedrock-mantle") and translates the
    // Responses/Messages SSE events into OpenAI chat-completions-shaped chunks
    // so the frontend parser and metrics work unchanged.
    id: 'bedrock',
    name: 'AWS Bedrock',
    protocol: 'openai-compatible',
    auth: 'aws-sigv4',
    baseUrl: 'https://bedrock-mantle.{region}.api.aws',
    models: [
      { logical: 'gpt-5.6-luna', remote: 'openai.gpt-5.6-luna', capabilities: ['text', 'vision'], api: 'responses' },
      { logical: 'gpt-5.6-sol', remote: 'openai.gpt-5.6-sol', capabilities: ['text', 'vision'], api: 'responses' },
      { logical: 'gpt-oss-120b', remote: 'openai.gpt-oss-120b', capabilities: ['text'], api: 'chat-completions' },
      { logical: 'claude-sonnet-5', remote: 'anthropic.claude-sonnet-5', capabilities: ['text', 'vision'], api: 'messages' },
    ],
  },
];
