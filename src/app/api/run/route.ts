import { createHash, createHmac, createSign } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const GCP_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GCP_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/** Refresh cached access tokens 5 minutes before their stated expiry. */
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

interface GcpServiceAccount {
  client_email: string;
  private_key: string;
}

type UpstreamApi = 'chat-completions' | 'responses' | 'messages';

interface RunRequestBody {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: { role: string; content: string }[];
  maxTokens: number;
  temperature: number;
  headers?: Record<string, string>;
  gcp?: { serviceAccount: unknown; projectId: string; location: string };
  aws?: { region: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /** Upstream API surface; defaults to 'chat-completions' (Bedrock mantle models). */
  api?: UpstreamApi;
}

// In-memory access token cache, keyed by service account client_email.
// Tokens live only in process memory — never logged, never persisted.

// Accepts a service account as an object, a raw JSON string, or a
// base64-encoded JSON string (e.g. GCP_CREDENTIALS_BASE64 from CI).
function parseServiceAccount(input: unknown): Partial<GcpServiceAccount> {
  if (typeof input !== 'string') return input as Partial<GcpServiceAccount>;
  const compact = input.replace(/\s+/g, '');
  const json = compact.startsWith('{')
    ? compact
    : Buffer.from(compact, 'base64').toString('utf8');
  try {
    return JSON.parse(json) as Partial<GcpServiceAccount>;
  } catch {
    throw new Error('Service account must be the SA JSON content or its base64 encoding');
  }
}
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

// Exchange a service account key for an OAuth2 access token via the JWT
// bearer flow (RFC 7523): build a self-signed RS256 JWT and POST it as a
// grant to Google's token endpoint. No external dependencies.
async function getGcpAccessToken(sa: GcpServiceAccount): Promise<string> {
  const cached = tokenCache.get(sa.client_email);
  if (cached && Date.now() < cached.expiresAt - TOKEN_REFRESH_SKEW_MS) {
    return cached.token;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: GCP_SCOPE,
      aud: GCP_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(sa.private_key, 'base64url');
  const jwt = `${header}.${claims}.${signature}`;

  const res = await fetch(GCP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Token exchange failed (${res.status}): ${detail.slice(0, 1000)}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in?: number };
  tokenCache.set(sa.client_email, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  });
  return data.access_token;
}

// Join baseUrl with the chat/completions path, tolerating a baseUrl that
// already ends with it (e.g. pasted from provider docs).
function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

// Resolve the endpoint path for the selected upstream API surface. Bedrock
// mantle serves three surfaces off one bare-host baseUrl (selected via `api`,
// which only Bedrock providers send); every other provider includes the
// version prefix in its baseUrl and only ever uses chat completions.
// Idempotent: safe to call twice.
function upstreamUrl(baseUrl: string, api?: UpstreamApi): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (api === 'responses') {
    return trimmed.endsWith('/openai/v1/responses') ? trimmed : `${trimmed}/openai/v1/responses`;
  }
  if (api === 'messages') {
    return trimmed.endsWith('/anthropic/v1/messages') ? trimmed : `${trimmed}/anthropic/v1/messages`;
  }
  if (api === 'chat-completions') {
    return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/v1/chat/completions`;
  }
  return chatCompletionsUrl(baseUrl);
}

// Bedrock signs with different SigV4 service names per endpoint: mantle is
// "bedrock-mantle", the legacy runtime endpoint is "bedrock".
function sigv4Service(host: string): string {
  return host.includes('bedrock-mantle') ? 'bedrock-mantle' : 'bedrock';
}

// Translate a Responses API (OpenAI) or Messages API (Anthropic) SSE stream
// into OpenAI chat-completions-shaped SSE chunks (`choices[0].delta.content`
// for text, a final `usage` chunk, then `data: [DONE]`), so the frontend
// parser and metrics work identically across all upstream APIs.
function translateToChatCompletionsSSE(
  upstream: ReadableStream<Uint8Array>,
  api: Exclude<UpstreamApi, 'chat-completions'>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  return upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            continue;
          }
          const enqueue = (json: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(json)}\n\n`));
          const emitDone = () => controller.enqueue(encoder.encode('data: [DONE]\n\n'));

          if (api === 'responses') {
            if (event.type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta) {
              enqueue({ choices: [{ delta: { content: event.delta } }] });
            } else if (event.type === 'response.completed') {
              const usage = (event.response as { usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } } | undefined)?.usage;
              if (usage) {
                enqueue({
                  choices: [],
                  usage: {
                    prompt_tokens: usage.input_tokens ?? 0,
                    completion_tokens: usage.output_tokens ?? 0,
                    total_tokens: usage.total_tokens ?? 0,
                  },
                });
              }
              emitDone();
            }
          } else {
            // messages (Anthropic)
            if (event.type === 'message_start') {
              const usage = (event.message as { usage?: { input_tokens?: number } } | undefined)?.usage;
              inputTokens = usage?.input_tokens ?? null;
            } else if (event.type === 'content_block_delta') {
              const delta = (event.delta as { type?: string; text?: string } | undefined)?.text;
              if (delta) enqueue({ choices: [{ delta: { content: delta } }] });
            } else if (event.type === 'message_delta') {
              const usage = (event.usage as { output_tokens?: number } | undefined);
              outputTokens = usage?.output_tokens ?? null;
            } else if (event.type === 'message_stop') {
              if (inputTokens !== null || outputTokens !== null) {
                enqueue({
                  choices: [],
                  usage: {
                    prompt_tokens: inputTokens ?? 0,
                    completion_tokens: outputTokens ?? 0,
                    total_tokens: (inputTokens ?? 0) + (outputTokens ?? 0),
                  },
                });
              }
              emitDone();
            }
          }
        }
      },
    })
  );
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

// AWS Signature Version 4 request signing (AWS4-HMAC-SHA256), implemented
// with node:crypto only — no SDK dependency, mirroring the GCP JWT flow.
// Reference: https://docs.aws.amazon.com/general/latest/gr/sigv4-signed-request-examples.html
function signV4(opts: {
  method: string;
  url: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  body: string;
}): Record<string, string> {
  const { method, url, region, service, accessKeyId, secretAccessKey, sessionToken, body } = opts;
  const parsed = new URL(url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  // SigV4 canonical headers: lowercase names, sorted, value trimmed of
  // leading/trailing whitespace with consecutive spaces collapsed.
  const headerMap: Record<string, string> = {
    host: parsed.host,
    'content-type': 'application/json',
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
  if (sessionToken) headerMap['x-amz-security-token'] = sessionToken;

  const entries = Object.entries(headerMap)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalHeaders = entries.map(([name, value]) => `${name}:${value}\n`).join('');
  const signedHeaders = entries.map(([name]) => name).join(';');

  const canonicalRequest = [
    method,
    parsed.pathname || '/',
    parsed.search.replace(/^\?/, ''),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    'Content-Type': 'application/json',
    'X-Amz-Date': amzDate,
    'X-Amz-Content-Sha256': payloadHash,
    ...(sessionToken ? { 'X-Amz-Security-Token': sessionToken } : {}),
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// POST /api/run — streaming proxy.
// Forwards an OpenAI-compatible chat/completions request upstream and pipes the
// SSE body back untouched. Credentials (apiKey / service account) are only used
// for this forward; they are never logged or persisted.
export async function POST(req: NextRequest) {
  let body: RunRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { baseUrl, apiKey, model, messages, maxTokens, temperature, headers, gcp, aws, api } = body;
  if (!baseUrl || !model || !Array.isArray(messages)) {
    return NextResponse.json(
      { error: 'Missing required fields: baseUrl, model, messages' },
      { status: 400 }
    );
  }

  // Build the upstream body per API surface. Anthropic's Messages API takes
  // the system prompt in a top-level `system` field, not as a role.
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  const chatMessages = messages.filter((m) => m.role !== 'system');
  const payload =
    api === 'responses'
      ? // GPT-5.6 models reject a `temperature` parameter outright.
        JSON.stringify({ model, input: messages, max_output_tokens: maxTokens, stream: true })
      : api === 'messages'
        ? JSON.stringify({
            model,
            ...(system ? { system } : {}),
            messages: chatMessages,
            max_tokens: maxTokens,
            temperature,
            stream: true,
          })
        : JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: true });
  let url = baseUrl;
  let upstreamHeaders: Record<string, string>;

  if (gcp) {
    // GCP OAuth path: fill baseUrl placeholders and exchange the service
    // account key for an access token.
    if (!gcp.projectId || !gcp.location || !gcp.serviceAccount) {
      return NextResponse.json(
        { error: 'gcp requires serviceAccount, projectId and location' },
        { status: 400 }
      );
    }
    let sa: Partial<GcpServiceAccount>;
    try {
      sa = parseServiceAccount(gcp.serviceAccount);
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 400 });
    }
    if (typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string') {
      return NextResponse.json(
        { error: 'Service account JSON must contain client_email and private_key' },
        { status: 400 }
      );
    }
    url = url.replace('{project_id}', gcp.projectId).replace('{location}', gcp.location);
    try {
      const accessToken = await getGcpAccessToken({ client_email: sa.client_email, private_key: sa.private_key });
      upstreamHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...(headers ?? {}),
      };
    } catch (err) {
      return NextResponse.json({ error: 'GCP token exchange failed', detail: String(err) }, { status: 502 });
    }
  } else if (aws) {
    // AWS SigV4 path: fill the {region} placeholder and sign the request
    // with the user's IAM credentials. Fields left blank in the UI fall back
    // to AWS_* server-side env vars, so keys never have to touch the browser.
    const accessKeyId = aws.accessKeyId.trim() || process.env.AWS_ACCESS_KEY_ID || '';
    const secretAccessKey = aws.secretAccessKey.trim() || process.env.AWS_SECRET_ACCESS_KEY || '';
    const sessionToken = aws.sessionToken?.trim() || process.env.AWS_SESSION_TOKEN || undefined;
    if (!aws.region || !accessKeyId || !secretAccessKey) {
      return NextResponse.json(
        { error: 'aws requires region, accessKeyId and secretAccessKey (or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars)' },
        { status: 400 }
      );
    }
    url = upstreamUrl(url.replace('{region}', aws.region), api);
    try {
      upstreamHeaders = {
        ...(headers ?? {}),
        // Anthropic Messages API requires this version header (not signed).
        ...(api === 'messages' ? { 'anthropic-version': '2023-06-01' } : {}),
        ...signV4({
          method: 'POST',
          url,
          region: aws.region,
          service: sigv4Service(new URL(url).host),
          accessKeyId,
          secretAccessKey,
          sessionToken,
          body: payload,
        }),
      };
    } catch (err) {
      return NextResponse.json({ error: 'AWS SigV4 signing failed', detail: String(err) }, { status: 502 });
    }
  } else {
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing required field: apiKey' }, { status: 400 });
    }
    upstreamHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(headers ?? {}),
    };
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl(url, api), {
      method: 'POST',
      headers: upstreamHeaders,
      body: payload,
      signal: req.signal, // propagate client abort to the upstream request
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return NextResponse.json(
      { error: aborted ? 'Aborted' : `Upstream request failed: ${String(err)}` },
      { status: aborted ? 499 : 502 }
    );
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return NextResponse.json(
      { error: `Upstream ${upstream.status}`, detail: text.slice(0, 2000) },
      { status: upstream.status }
    );
  }

  if (!upstream.body) {
    return NextResponse.json({ error: 'Upstream returned no body' }, { status: 502 });
  }

  // Responses/Messages APIs emit their own SSE event shapes; translate them
  // to OpenAI chat-completions chunks so the client parser is unchanged.
  // Chat completions is piped through untouched.
  const streamBody =
    api && api !== 'chat-completions' ? translateToChatCompletionsSSE(upstream.body, api) : upstream.body;

  return new Response(streamBody, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
