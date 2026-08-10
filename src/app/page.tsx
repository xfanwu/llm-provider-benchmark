'use client';

import { useEffect, useRef, useState } from 'react';
import { PROVIDERS, ProviderConfig } from '@/lib/providers';
import { ChatMessage, RunState } from '@/lib/types';

const LS_KEY = (id: string) => `lpb:key:${id}`;
const LS_MODEL = (id: string) => `lpb:model:${id}`;
const LS_BASEURL = (id: string) => `lpb:baseurl:${id}`;
const LS_GCP_PROJECT = (id: string) => `lpb:gcp:project:${id}`;
const LS_GCP_LOCATION = (id: string) => `lpb:gcp:location:${id}`;
const LS_GCP_SA = (id: string) => `lpb:gcp:sa:${id}`;
const LS_AWS_REGION = (id: string) => `lpb:aws:region:${id}`;
const LS_AWS_AK = (id: string) => `lpb:aws:ak:${id}`;
const LS_AWS_SK = (id: string) => `lpb:aws:sk:${id}`;
const LS_AWS_TOKEN = (id: string) => `lpb:aws:token:${id}`;
const LS_CUSTOM = 'lpb:custom-providers';

interface ProviderForm {
  enabled: boolean;
  apiKey: string;
  model: string;
  baseUrl: string;
  gcpProject: string;
  gcpLocation: string;
  gcpSa: string;
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken: string;
}

// A user-defined OpenAI-compatible provider. The whole list is persisted to
// localStorage as one JSON array (LS_CUSTOM), unlike builtin providers which
// use per-field keys.
interface CustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
}

// Pastel design system (shared classes).
const INP =
  'rounded-xl border border-violet-100 bg-white/80 px-2.5 py-1.5 font-mono text-sm text-foreground placeholder:text-gray-400 transition focus:border-violet-300 focus:outline-none focus:ring-2 focus:ring-violet-200';
const INP_TEXT =
  'rounded-xl border border-violet-100 bg-white/80 px-2.5 py-1.5 text-sm text-foreground placeholder:text-gray-400 transition focus:border-violet-300 focus:outline-none focus:ring-2 focus:ring-violet-200';
const CARD =
  'flex flex-wrap items-center gap-3 rounded-2xl border border-violet-100 bg-white/80 px-4 py-3 shadow-sm shadow-violet-100/60 transition-all hover:-translate-y-0.5 hover:shadow-md hover:shadow-violet-200/60';

// Adapters so custom entries flow through the exact same run/render logic as
// builtin ProviderConfig entries.
function customToConfig(c: CustomProvider): ProviderConfig {
  return {
    id: c.id,
    name: c.name,
    protocol: 'openai-compatible',
    auth: 'api-key',
    baseUrl: c.baseUrl,
    models: [{ logical: c.model, remote: c.model, capabilities: ['text'] }],
  };
}

function customToForm(c: CustomProvider): ProviderForm {
  return {
    enabled: c.enabled,
    apiKey: c.apiKey,
    model: c.model,
    baseUrl: c.baseUrl,
    gcpProject: '',
    gcpLocation: '',
    gcpSa: '',
    awsRegion: '',
    awsAccessKeyId: '',
    awsSecretAccessKey: '',
    awsSessionToken: '',
  };
}

// A gcp-oauth provider is only runnable when all three fields are filled.
function gcpReady(form: ProviderForm): boolean {
  return Boolean(form.gcpProject.trim() && form.gcpLocation.trim() && form.gcpSa.trim());
}

// An aws-sigv4 provider is runnable when the region is set and either the
// key pair is filled in or the server has AWS_* env credentials to fall back
// on; the session token is optional (long-term IAM keys need none).
function awsReady(form: ProviderForm, awsConfigured = false): boolean {
  return (
    Boolean(form.awsRegion.trim()) &&
    (awsConfigured || Boolean(form.awsAccessKeyId.trim() && form.awsSecretAccessKey.trim()))
  );
}

function emptyMetrics() {
  return {
    ttfbMs: null,
    ttftMs: null,
    totalMs: null,
    outputTokens: 0,
    tokensEstimated: false,
    tokensPerSec: null,
    decodeTokensPerSec: null,
  };
}

const STATUS_LABEL: Record<string, string> = {
  idle: 'Idle',
  pending: 'Pending',
  connecting: 'Connecting',
  streaming: 'Streaming',
  done: 'Done',
  error: 'Error',
  aborted: 'Aborted',
};

const STATUS_COLOR: Record<string, string> = {
  idle: 'bg-gray-100 text-gray-500',
  pending: 'bg-gray-100 text-gray-500',
  connecting: 'bg-amber-100 text-amber-700',
  streaming: 'bg-sky-100 text-sky-700',
  done: 'bg-emerald-100 text-emerald-700',
  error: 'bg-rose-100 text-rose-700',
  aborted: 'bg-orange-100 text-orange-700',
};

export default function Home() {
  const [forms, setForms] = useState<Record<string, ProviderForm>>({});
  const [customs, setCustoms] = useState<CustomProvider[]>([]);
  const [envKeys, setEnvKeys] = useState<{ name: string; value: string }[]>([]);
  const [awsConfigured, setAwsConfigured] = useState(false);
  const [newCustom, setNewCustom] = useState({ name: '', baseUrl: '', apiKey: '', model: '' });
  const [systemPrompt, setSystemPrompt] = useState('');
  const [userPrompt, setUserPrompt] = useState('Explain streaming output in large language models in three sentences.');
  const [maxTokens, setMaxTokens] = useState(512);
  const [temperature, setTemperature] = useState(0.7);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Initialize forms from localStorage (client only).
  useEffect(() => {
    const initial: Record<string, ProviderForm> = {};
    for (const p of PROVIDERS) {
      initial[p.id] = {
        enabled: false,
        apiKey: localStorage.getItem(LS_KEY(p.id)) ?? '',
        model: localStorage.getItem(LS_MODEL(p.id)) ?? p.models[0]?.remote ?? '',
        baseUrl: localStorage.getItem(LS_BASEURL(p.id)) ?? p.baseUrl,
        gcpProject: localStorage.getItem(LS_GCP_PROJECT(p.id)) ?? '',
        gcpLocation: localStorage.getItem(LS_GCP_LOCATION(p.id)) ?? 'global',
        gcpSa: localStorage.getItem(LS_GCP_SA(p.id)) ?? '',
        awsRegion: localStorage.getItem(LS_AWS_REGION(p.id)) ?? 'us-east-1',
        awsAccessKeyId: localStorage.getItem(LS_AWS_AK(p.id)) ?? '',
        awsSecretAccessKey: localStorage.getItem(LS_AWS_SK(p.id)) ?? '',
        awsSessionToken: localStorage.getItem(LS_AWS_TOKEN(p.id)) ?? '',
      };
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is client-only; a lazy initializer would desync SSR HTML
    setForms(initial);
    try {
      setCustoms(JSON.parse(localStorage.getItem(LS_CUSTOM) ?? '[]') as CustomProvider[]);
    } catch {
      setCustoms([]);
    }
    // Load server-side *_API_KEY env vars for the key picker dropdown, plus
    // the AWS_* env credential flag (true when the proxy can sign server-side).
    fetch('/api/env-keys')
      .then((r) => r.json())
      .then((j) => {
        setEnvKeys(j.keys ?? []);
        setAwsConfigured(j.awsConfigured === true);
      })
      .catch(() => setEnvKeys([]));
  }, []);

  // Persist the whole custom-provider list on every change.
  const saveCustoms = (next: CustomProvider[]) => {
    setCustoms(next);
    localStorage.setItem(LS_CUSTOM, JSON.stringify(next));
  };

  const updateCustom = (id: string, patch: Partial<CustomProvider>) => {
    saveCustoms(customs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const addCustom = () => {
    const baseUrl = newCustom.baseUrl.trim();
    const model = newCustom.model.trim();
    if (!baseUrl || !model) return;
    let name = newCustom.name.trim();
    if (!name) {
      try {
        name = new URL(baseUrl).hostname;
      } catch {
        name = 'Custom provider';
      }
    }
    saveCustoms([
      ...customs,
      { id: `custom-${Date.now()}`, name, baseUrl, apiKey: newCustom.apiKey, model, enabled: true },
    ]);
    setNewCustom({ name: '', baseUrl: '', apiKey: '', model: '' });
  };

  const removeCustom = (id: string) => {
    saveCustoms(customs.filter((c) => c.id !== id));
  };

  // Dropdown offering .env API keys; always snaps back to the placeholder
  // after a pick. Rendered as a plain element (not a component) to avoid
  // remounting inputs. Hidden when no env keys are available.
  const renderEnvKeySelect = (onPick: (value: string) => void) => {
    if (envKeys.length === 0) return null;
    return (
      <select
        className="rounded-full border border-violet-100 bg-white/80 px-2 py-1 text-xs text-violet-600"
        value=""
        onChange={(e) => {
          if (e.target.value) onPick(e.target.value);
        }}
      >
        <option value="">From .env</option>
        {envKeys.map((k) => (
          <option key={k.name} value={k.value}>
            {k.name}
          </option>
        ))}
      </select>
    );
  };

  const updateForm = (id: string, patch: Partial<ProviderForm>) => {
    setForms((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  const updateRun = (id: string, patch: Partial<RunState>) => {
    setRuns((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  const updateMetrics = (id: string, patch: Partial<RunState['metrics']>) => {
    setRuns((prev) =>
      prev[id] ? { ...prev, [id]: { ...prev[id], metrics: { ...prev[id].metrics, ...patch } } } : prev
    );
  };

  async function runOne(provider: ProviderConfig, form: ProviderForm, signal: AbortSignal) {
    const id = provider.id;
    const start = performance.now();
    const messages: ChatMessage[] = [];
    if (systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userPrompt });

    updateRun(id, { status: 'connecting', output: '', metrics: emptyMetrics() });

    let res: Response;
    try {
      const gcp =
        provider.auth === 'gcp-oauth'
          ? {
              serviceAccount: form.gcpSa,
              projectId: form.gcpProject.trim(),
              location: form.gcpLocation.trim(),
            }
          : undefined;
      const aws =
        provider.auth === 'aws-sigv4'
          ? {
              region: form.awsRegion.trim(),
              accessKeyId: form.awsAccessKeyId.trim(),
              secretAccessKey: form.awsSecretAccessKey.trim(),
              sessionToken: form.awsSessionToken.trim() || undefined,
            }
          : undefined;
      // Upstream API surface for the selected model (Bedrock mantle serves
      // Responses / Messages / Chat Completions per model). Falls back to the
      // default when the model field was typed in manually. Sent for Bedrock
      // only — the route uses it to pick the endpoint path.
      const api =
        provider.models.find((m) => m.remote === form.model)?.api ?? 'chat-completions';
      res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: form.baseUrl,
          apiKey: form.apiKey,
          model: form.model,
          messages,
          maxTokens,
          temperature,
          headers: provider.defaultHeaders,
          ...(gcp ? { gcp } : {}),
          ...(aws ? { aws } : {}),
          ...(provider.auth === 'aws-sigv4' ? { api } : {}),
        }),
        signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      updateRun(id, {
        status: aborted ? 'aborted' : 'error',
        metrics: {
          ...emptyMetrics(),
          totalMs: performance.now() - start,
          error: aborted ? undefined : String(err),
        },
      });
      return;
    }

    const ttfbMs = performance.now() - start;
    updateMetrics(id, { ttfbMs });

    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        msg = j.detail ? `${j.error}: ${String(j.detail).slice(0, 300)}` : j.error ?? msg;
      } catch {
        /* keep default message */
      }
      updateRun(id, {
        status: 'error',
        metrics: { ...emptyMetrics(), ttfbMs, totalMs: performance.now() - start, error: msg },
      });
      return;
    }

    updateRun(id, { status: 'streaming' });

    // Parse the SSE stream: lines of `data: {json}`, terminated by `data: [DONE]`.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let output = '';
    let ttftMs: number | null = null;
    let usageTokens: number | null = null;
    let doneSeen = false;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') {
            doneSeen = true;
            break;
          }
          try {
            const chunk = JSON.parse(payload);
            const delta: string = chunk.choices?.[0]?.delta?.content ?? '';
            if (delta) {
              if (ttftMs === null) {
                ttftMs = performance.now() - start;
                updateMetrics(id, { ttftMs });
              }
              output += delta;
              updateRun(id, { output });
            }
            const usage = chunk.usage;
            if (usage && typeof usage.completion_tokens === 'number') {
              usageTokens = usage.completion_tokens;
            }
          } catch {
            /* ignore malformed SSE payloads */
          }
        }
        if (doneSeen) break;
      }
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      const totalMs = performance.now() - start;
      updateRun(id, {
        status: aborted ? 'aborted' : 'error',
        output,
        metrics: {
          ttfbMs,
          ttftMs,
          totalMs,
          outputTokens: usageTokens ?? Math.round(output.length / 4),
          tokensEstimated: usageTokens === null,
          tokensPerSec: null,
          decodeTokensPerSec: null,
          error: aborted ? undefined : String(err),
        },
      });
      return;
    }

    const totalMs = performance.now() - start;
    const estimated = usageTokens === null;
    const outputTokens = usageTokens ?? Math.round(output.length / 4);
    const tokensPerSec = totalMs > 0 ? outputTokens / (totalMs / 1000) : null;
    const decodeMs = ttftMs !== null ? totalMs - ttftMs : null;
    const decodeTokensPerSec = decodeMs && decodeMs > 0 ? outputTokens / (decodeMs / 1000) : null;
    updateRun(id, {
      status: 'done',
      output,
      metrics: { ttfbMs, ttftMs, totalMs, outputTokens, tokensEstimated: estimated, tokensPerSec, decodeTokensPerSec },
    });
  }

  async function handleRun() {
    // Unified run targets: enabled builtin providers + enabled custom entries,
    // both reduced to the same { config, form } shape.
    const targets: { config: ProviderConfig; form: ProviderForm }[] = [
      ...PROVIDERS.filter((p) => forms[p.id]?.enabled).map((p) => ({ config: p, form: forms[p.id] })),
      ...customs.filter((c) => c.enabled).map((c) => ({ config: customToConfig(c), form: customToForm(c) })),
    ];
    if (targets.length === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);

    const initial: Record<string, RunState> = {};
    for (const t of targets) {
      initial[t.config.id] = { providerId: t.config.id, status: 'pending', metrics: emptyMetrics(), output: '' };
    }
    setRuns(initial);

    // Fire all providers concurrently; failures are isolated per provider.
    // Providers missing required fields are short-circuited locally.
    await Promise.allSettled(
      targets.map(({ config, form }) => {
        const missing =
          config.auth === 'gcp-oauth'
            ? !gcpReady(form)
              ? 'Fill in Project ID, Location and Service Account JSON first'
              : null
            : config.auth === 'aws-sigv4'
              ? !awsReady(form, awsConfigured)
                ? awsConfigured
                  ? 'Region is required'
                  : 'Fill in Region, Access Key ID and Secret Access Key (or set server-side AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)'
                : null
              : !(form.baseUrl.trim() && form.apiKey.trim() && form.model.trim())
                ? 'Fill in baseUrl, API Key and model first'
                : null;
        if (missing) {
          updateRun(config.id, {
            status: 'error',
            metrics: { ...emptyMetrics(), error: missing },
          });
          return Promise.resolve();
        }
        return runOne(config, form, controller.signal);
      })
    );
    setRunning(false);
    abortRef.current = null;
  }

  function handleAbort() {
    abortRef.current?.abort();
  }

  const enabledCount =
    PROVIDERS.filter((p) => forms[p.id]?.enabled).length + customs.filter((c) => c.enabled).length;

  return (
    <main className="relative mx-auto max-w-6xl px-4 py-10">
      {/* Decorative pastel blobs */}
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-pink-200/50 blur-3xl" />
        <div className="absolute -right-32 top-1/3 h-96 w-96 rounded-full bg-sky-200/50 blur-3xl" />
        <div className="absolute -bottom-32 left-1/3 h-96 w-96 rounded-full bg-violet-200/50 blur-3xl" />
      </div>

      <header className="mb-10">
        <h1 className="bg-gradient-to-r from-pink-500 via-violet-500 to-sky-500 bg-clip-text text-4xl font-extrabold tracking-tight text-transparent">
          LLM Provider Benchmark
        </h1>
        <p className="mt-2 text-sm text-gray-500">
          Fire the same model and prompt at multiple LLM providers concurrently; compare TTFT / throughput in real time.
        </p>
      </header>

      {/* Provider configuration */}
      <section className="mb-10">
        <h2 className="mb-4 text-lg font-extrabold tracking-tight">Providers</h2>
        <div className="space-y-3">
          {PROVIDERS.map((p) => {
            const form = forms[p.id];
            if (!form) return null;
            return (
              <div key={p.id} className={CARD}>
                <label className="flex w-44 cursor-pointer items-center gap-2.5">
                  <input
                    type="checkbox"
                    className="peer sr-only"
                    checked={form.enabled}
                    onChange={(e) => updateForm(p.id, { enabled: e.target.checked })}
                  />
                  <span className="relative h-6 w-11 shrink-0 rounded-full bg-gray-200 transition-colors peer-checked:bg-gradient-to-r peer-checked:from-pink-400 peer-checked:to-violet-400 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5" />
                  <span className="font-bold">{p.name}</span>
                </label>
                {p.auth === 'gcp-oauth' ? (
                  <>
                    <input
                      type="text"
                      placeholder="Project ID"
                      className={`${INP} w-44`}
                      value={form.gcpProject}
                      onChange={(e) => {
                        updateForm(p.id, { gcpProject: e.target.value });
                        localStorage.setItem(LS_GCP_PROJECT(p.id), e.target.value);
                      }}
                    />
                    <input
                      type="text"
                      placeholder="Location"
                      className={`${INP} w-28`}
                      value={form.gcpLocation}
                      onChange={(e) => {
                        updateForm(p.id, { gcpLocation: e.target.value });
                        localStorage.setItem(LS_GCP_LOCATION(p.id), e.target.value);
                      }}
                    />
                    <input
                      type="text"
                      placeholder="model"
                      className={`${INP} w-72`}
                      value={form.model}
                      onChange={(e) => {
                        updateForm(p.id, { model: e.target.value });
                        localStorage.setItem(LS_MODEL(p.id), e.target.value);
                      }}
                    />
                    <textarea
                      placeholder="Paste Service Account JSON or its base64 encoding (e.g. GCP_CREDENTIALS_BASE64)"
                      rows={2}
                      className="w-full rounded-xl border border-violet-100 bg-white/80 px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-gray-400 transition focus:border-violet-300 focus:outline-none focus:ring-2 focus:ring-violet-200"
                      value={form.gcpSa}
                      onChange={(e) => {
                        updateForm(p.id, { gcpSa: e.target.value });
                        localStorage.setItem(LS_GCP_SA(p.id), e.target.value);
                      }}
                    />
                  </>
                ) : p.auth === 'aws-sigv4' ? (
                  <>
                    <input
                      type="text"
                      placeholder="Region (e.g. us-east-1)"
                      className={`${INP} w-32`}
                      value={form.awsRegion}
                      onChange={(e) => {
                        updateForm(p.id, { awsRegion: e.target.value });
                        localStorage.setItem(LS_AWS_REGION(p.id), e.target.value);
                      }}
                    />
                    <input
                      type="password"
                      placeholder="Access Key ID"
                      className={`${INP} w-52`}
                      value={form.awsAccessKeyId}
                      onChange={(e) => {
                        updateForm(p.id, { awsAccessKeyId: e.target.value });
                        localStorage.setItem(LS_AWS_AK(p.id), e.target.value);
                      }}
                    />
                    <input
                      type="password"
                      placeholder="Secret Access Key"
                      className={`${INP} w-52`}
                      value={form.awsSecretAccessKey}
                      onChange={(e) => {
                        updateForm(p.id, { awsSecretAccessKey: e.target.value });
                        localStorage.setItem(LS_AWS_SK(p.id), e.target.value);
                      }}
                    />
                    {awsConfigured && (
                      <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                        .env credentials configured; leave blank
                      </span>
                    )}
                    <input
                      type="password"
                      placeholder="Session Token (optional, temp credentials)"
                      className={`${INP} w-44`}
                      value={form.awsSessionToken}
                      onChange={(e) => {
                        updateForm(p.id, { awsSessionToken: e.target.value });
                        localStorage.setItem(LS_AWS_TOKEN(p.id), e.target.value);
                      }}
                    />
                    <input
                      type="text"
                      placeholder="model"
                      className={`${INP} w-72`}
                      value={form.model}
                      onChange={(e) => {
                        updateForm(p.id, { model: e.target.value });
                        localStorage.setItem(LS_MODEL(p.id), e.target.value);
                      }}
                    />
                  </>
                ) : (
                  <>
                    <input
                      type="password"
                      placeholder="API Key"
                      className={`${INP_TEXT} w-56`}
                      value={form.apiKey}
                      onChange={(e) => {
                        updateForm(p.id, { apiKey: e.target.value });
                        localStorage.setItem(LS_KEY(p.id), e.target.value);
                      }}
                    />
                    {renderEnvKeySelect((v) => {
                      updateForm(p.id, { apiKey: v });
                      localStorage.setItem(LS_KEY(p.id), v);
                    })}
                    <input
                      type="text"
                      placeholder="model"
                      className={`${INP} w-72`}
                      value={form.model}
                      onChange={(e) => {
                        updateForm(p.id, { model: e.target.value });
                        localStorage.setItem(LS_MODEL(p.id), e.target.value);
                      }}
                    />
                    {p.baseUrlEditable && (
                      <input
                        type="text"
                        placeholder="baseUrl (replace {account_id}/{gateway_id})"
                        className={`${INP} min-w-0 flex-1`}
                        value={form.baseUrl}
                        onChange={(e) => {
                          updateForm(p.id, { baseUrl: e.target.value });
                          localStorage.setItem(LS_BASEURL(p.id), e.target.value);
                        }}
                      />
                    )}
                  </>
                )}
              </div>
            );
          })}

          {/* Custom providers: same row layout, always api-key auth, baseUrl editable, plus delete. */}
          {customs.map((c) => (
            <div key={c.id} className={CARD}>
              <label className="flex w-44 cursor-pointer items-center gap-2.5">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={c.enabled}
                  onChange={(e) => updateCustom(c.id, { enabled: e.target.checked })}
                />
                <span className="relative h-6 w-11 shrink-0 rounded-full bg-gray-200 transition-colors peer-checked:bg-gradient-to-r peer-checked:from-pink-400 peer-checked:to-violet-400 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5" />
                <span className="font-bold">{c.name}</span>
              </label>
              <input
                type="password"
                placeholder="API Key"
                className={`${INP_TEXT} w-56`}
                value={c.apiKey}
                onChange={(e) => updateCustom(c.id, { apiKey: e.target.value })}
              />
              {renderEnvKeySelect((v) => updateCustom(c.id, { apiKey: v }))}
              <input
                type="text"
                placeholder="model"
                className={`${INP} w-72`}
                value={c.model}
                onChange={(e) => updateCustom(c.id, { model: e.target.value })}
              />
              <input
                type="text"
                placeholder="baseUrl"
                className={`${INP} min-w-0 flex-1`}
                value={c.baseUrl}
                onChange={(e) => updateCustom(c.id, { baseUrl: e.target.value })}
              />
              <button
                onClick={() => removeCustom(c.id)}
                className="rounded-full px-3 py-1 text-sm font-medium text-rose-500 transition hover:bg-rose-50"
                title="Delete this provider"
              >
                Delete
              </button>
            </div>
          ))}

          {/* Add-custom-provider form */}
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border-2 border-dashed border-violet-200 bg-white/40 px-4 py-3">
            <span className="w-44 text-sm font-medium text-gray-400">Custom provider</span>
            <input
              type="text"
              placeholder="Name (optional; defaults to baseUrl host)"
              className={`${INP_TEXT} w-44`}
              value={newCustom.name}
              onChange={(e) => setNewCustom({ ...newCustom, name: e.target.value })}
            />
            <input
              type="text"
              placeholder="baseUrl, e.g. https://api.example.com/v1"
              className={`${INP} min-w-0 flex-1`}
              value={newCustom.baseUrl}
              onChange={(e) => setNewCustom({ ...newCustom, baseUrl: e.target.value })}
            />
            <input
              type="password"
              placeholder="API Key"
              className={`${INP_TEXT} w-48`}
              value={newCustom.apiKey}
              onChange={(e) => setNewCustom({ ...newCustom, apiKey: e.target.value })}
            />
            <input
              type="text"
              placeholder="Model name"
              className={`${INP} w-56`}
              value={newCustom.model}
              onChange={(e) => setNewCustom({ ...newCustom, model: e.target.value })}
            />
            <button
              onClick={addCustom}
              disabled={!newCustom.baseUrl.trim() || !newCustom.model.trim()}
              className="rounded-full bg-violet-600 px-4 py-1.5 text-sm font-bold text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              + Add
            </button>
          </div>
        </div>
      </section>

      {/* Prompt configuration */}
      <section className="mb-10">
        <h2 className="mb-4 text-lg font-extrabold tracking-tight">Prompt</h2>
        <div className="space-y-4 rounded-3xl border border-violet-100 bg-white/80 p-5 shadow-sm shadow-violet-100/60">
          <textarea
            placeholder="System prompt (optional)"
            rows={2}
            className="w-full rounded-2xl border border-violet-100 bg-white/80 px-4 py-3 text-sm text-foreground placeholder:text-gray-400 transition focus:border-violet-300 focus:outline-none focus:ring-2 focus:ring-violet-200"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
          <textarea
            placeholder="User prompt"
            rows={4}
            className="w-full rounded-2xl border border-violet-100 bg-white/80 px-4 py-3 text-sm text-foreground placeholder:text-gray-400 transition focus:border-violet-300 focus:outline-none focus:ring-2 focus:ring-violet-200"
            value={userPrompt}
            onChange={(e) => setUserPrompt(e.target.value)}
          />
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2 rounded-full bg-violet-50 px-4 py-2 font-medium text-violet-700">
              max_tokens
              <input
                type="number"
                className="w-24 rounded-full border border-violet-100 bg-white/80 px-2 py-1 text-center font-mono transition focus:border-violet-300 focus:outline-none focus:ring-2 focus:ring-violet-200"
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value))}
              />
            </label>
            <label className="flex items-center gap-2 rounded-full bg-pink-50 px-4 py-2 font-medium text-pink-700">
              temperature
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                className="w-24 rounded-full border border-violet-100 bg-white/80 px-2 py-1 text-center font-mono transition focus:border-violet-300 focus:outline-none focus:ring-2 focus:ring-violet-200"
                value={temperature}
                onChange={(e) => setTemperature(Number(e.target.value))}
              />
            </label>
          </div>
        </div>
      </section>

      {/* Run controls */}
      <section className="mb-10 flex items-center gap-3">
        {!running ? (
          <button
            onClick={handleRun}
            disabled={enabledCount === 0}
            className="animate-gradient-pan rounded-full bg-gradient-to-r from-pink-400 via-violet-400 to-sky-400 px-8 py-3 text-sm font-bold text-white shadow-lg shadow-violet-300/50 transition-transform hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
          >
            Run ({enabledCount} providers)
          </button>
        ) : (
          <button
            onClick={handleAbort}
            className="rounded-full bg-rose-100 px-8 py-3 text-sm font-bold text-rose-600 transition hover:bg-rose-200 active:scale-95"
          >
            Abort
          </button>
        )}
      </section>

      {/* Metrics cards */}
      {Object.keys(runs).length > 0 && (
        <section>
          <h2 className="mb-4 text-lg font-extrabold tracking-tight">Results</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {/* Unified card source: builtin providers + custom entries that have a run. */}
            {[
              ...PROVIDERS.map((p) => ({ id: p.id, name: p.name, model: forms[p.id]?.model ?? '' })),
              ...customs.map((c) => ({ id: c.id, name: c.name, model: c.model })),
            ]
              .filter((p) => runs[p.id])
              .map((p, i) => {
                const run = runs[p.id];
                const m = run.metrics;
                return (
                  <div
                    key={p.id}
                    className="animate-fade-up rounded-3xl border border-violet-100 bg-white/85 p-5 shadow-sm shadow-violet-100/60"
                    style={{ animationDelay: `${i * 70}ms` }}
                  >
                    <div className="mb-4 flex items-center justify-between">
                      <div className="min-w-0">
                        <span className="font-bold">{p.name}</span>
                        <span className="ml-2 font-mono text-xs text-gray-400">{p.model}</span>
                      </div>
                      <span
                        className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_COLOR[run.status]}`}
                      >
                        {run.status === 'streaming' && (
                          <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-current" />
                        )}
                        {STATUS_LABEL[run.status]}
                      </span>
                    </div>
                    {run.status === 'error' ? (
                      <p className="break-all text-sm font-medium text-rose-600">{m.error}</p>
                    ) : (
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                        <dt className="text-xs text-gray-400">TTFB</dt>
                        <dd className="font-mono text-sm font-semibold">{fmtMs(m.ttfbMs)}</dd>
                        <dt className="text-xs text-gray-400">TTFT</dt>
                        <dd className="font-mono text-sm font-semibold">{fmtMs(m.ttftMs)}</dd>
                        <dt className="text-xs text-gray-400">Total time</dt>
                        <dd className="font-mono text-sm font-semibold">{fmtMs(m.totalMs)}</dd>
                        <dt className="text-xs text-gray-400">Output tokens</dt>
                        <dd className="font-mono text-sm font-semibold">
                          {m.outputTokens}
                          {m.tokensEstimated && m.outputTokens > 0 && (
                            <span className="ml-1 text-xs font-normal text-amber-500">(estimated)</span>
                          )}
                        </dd>
                        <dt className="text-xs text-gray-400">Throughput</dt>
                        <dd className="font-mono text-sm font-semibold">{fmtRate(m.tokensPerSec)}</dd>
                        <dt className="text-xs text-gray-400">Decode rate</dt>
                        <dd className="font-mono text-sm font-semibold">{fmtRate(m.decodeTokensPerSec)}</dd>
                      </dl>
                    )}
                    {run.output && (
                      <details className="mt-4">
                        <summary className="cursor-pointer text-sm font-medium text-violet-500 transition hover:text-violet-600">
                          Raw output
                        </summary>
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-2xl bg-violet-50/70 p-3 text-xs leading-relaxed">
                          {run.output}
                        </pre>
                      </details>
                    )}
                  </div>
                );
              })}
          </div>
        </section>
      )}
    </main>
  );
}

function fmtMs(v: number | null) {
  return v === null ? '—' : `${Math.round(v)} ms`;
}

function fmtRate(v: number | null) {
  return v === null ? '—' : `${v.toFixed(1)} tok/s`;
}
