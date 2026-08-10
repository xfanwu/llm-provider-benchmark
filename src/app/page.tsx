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
  idle: '空闲',
  pending: '等待',
  connecting: '连接中',
  streaming: '流式中',
  done: '完成',
  error: '错误',
  aborted: '已中止',
};

const STATUS_COLOR: Record<string, string> = {
  idle: 'bg-gray-200 text-gray-600',
  pending: 'bg-gray-200 text-gray-600',
  connecting: 'bg-yellow-100 text-yellow-800',
  streaming: 'bg-blue-100 text-blue-800',
  done: 'bg-green-100 text-green-800',
  error: 'bg-red-100 text-red-800',
  aborted: 'bg-orange-100 text-orange-800',
};

export default function Home() {
  const [forms, setForms] = useState<Record<string, ProviderForm>>({});
  const [customs, setCustoms] = useState<CustomProvider[]>([]);
  const [envKeys, setEnvKeys] = useState<{ name: string; value: string }[]>([]);
  const [awsConfigured, setAwsConfigured] = useState(false);
  const [newCustom, setNewCustom] = useState({ name: '', baseUrl: '', apiKey: '', model: '' });
  const [systemPrompt, setSystemPrompt] = useState('');
  const [userPrompt, setUserPrompt] = useState('用三句话介绍大语言模型的流式输出。');
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
        name = '自定义供应商';
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
        className="rounded border border-gray-300 px-1 py-1 text-xs text-gray-600"
        value=""
        onChange={(e) => {
          if (e.target.value) onPick(e.target.value);
        }}
      >
        <option value="">从 .env 选择</option>
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
              ? '请先填写 Project ID、Location 和 Service Account JSON'
              : null
            : config.auth === 'aws-sigv4'
              ? !awsReady(form, awsConfigured)
                ? awsConfigured
                  ? '请先填写 Region'
                  : '请先填写 Region、Access Key ID 和 Secret Access Key（或配置服务端 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY）'
                : null
              : !(form.baseUrl.trim() && form.apiKey.trim() && form.model.trim())
                ? '请先填写 baseUrl、API Key 和模型名'
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
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-8">
        <h1 className="text-2xl font-bold">LLM 供应商基准测试</h1>
        <p className="mt-1 text-sm text-gray-600">
          对同一模型、同一 prompt，并发调用多个供应商的 API，实时对比 TTFT / 吞吐等指标。
        </p>
      </header>

      {/* Provider configuration */}
      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold">供应商</h2>
        <div className="space-y-2">
          {PROVIDERS.map((p) => {
            const form = forms[p.id];
            if (!form) return null;
            return (
              <div
                key={p.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-gray-200 bg-white px-3 py-2"
              >
                <label className="flex w-44 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => updateForm(p.id, { enabled: e.target.checked })}
                  />
                  <span className="font-medium">{p.name}</span>
                </label>
                {p.auth === 'gcp-oauth' ? (
                  <>
                    <input
                      type="text"
                      placeholder="Project ID"
                      className="w-44 rounded border border-gray-300 px-2 py-1 font-mono text-sm"
                      value={form.gcpProject}
                      onChange={(e) => {
                        updateForm(p.id, { gcpProject: e.target.value });
                        localStorage.setItem(LS_GCP_PROJECT(p.id), e.target.value);
                      }}
                    />
                    <input
                      type="text"
                      placeholder="Location"
                      className="w-28 rounded border border-gray-300 px-2 py-1 font-mono text-sm"
                      value={form.gcpLocation}
                      onChange={(e) => {
                        updateForm(p.id, { gcpLocation: e.target.value });
                        localStorage.setItem(LS_GCP_LOCATION(p.id), e.target.value);
                      }}
                    />
                    <input
                      type="text"
                      placeholder="model"
                      className="w-72 rounded border border-gray-300 px-2 py-1 font-mono text-sm"
                      value={form.model}
                      onChange={(e) => {
                        updateForm(p.id, { model: e.target.value });
                        localStorage.setItem(LS_MODEL(p.id), e.target.value);
                      }}
                    />
                    <textarea
                      placeholder="粘贴 Service Account JSON 或其 base64 编码（如 GCP_CREDENTIALS_BASE64）"
                      rows={2}
                      className="w-full rounded border border-gray-300 px-2 py-1 font-mono text-xs"
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
                      placeholder="Region（如 us-east-1）"
                      className="w-32 rounded border border-gray-300 px-2 py-1 font-mono text-sm"
                      value={form.awsRegion}
                      onChange={(e) => {
                        updateForm(p.id, { awsRegion: e.target.value });
                        localStorage.setItem(LS_AWS_REGION(p.id), e.target.value);
                      }}
                    />
                    <input
                      type="password"
                      placeholder="Access Key ID"
                      className="w-52 rounded border border-gray-300 px-2 py-1 font-mono text-sm"
                      value={form.awsAccessKeyId}
                      onChange={(e) => {
                        updateForm(p.id, { awsAccessKeyId: e.target.value });
                        localStorage.setItem(LS_AWS_AK(p.id), e.target.value);
                      }}
                    />
                    <input
                      type="password"
                      placeholder="Secret Access Key"
                      className="w-52 rounded border border-gray-300 px-2 py-1 font-mono text-sm"
                      value={form.awsSecretAccessKey}
                      onChange={(e) => {
                        updateForm(p.id, { awsSecretAccessKey: e.target.value });
                        localStorage.setItem(LS_AWS_SK(p.id), e.target.value);
                      }}
                    />
                    {awsConfigured && (
                      <span className="rounded bg-green-50 px-2 py-1 text-xs text-green-700">
                        已配置 .env 凭证，可留空
                      </span>
                    )}
                    <input
                      type="password"
                      placeholder="Session Token（可选，临时凭证）"
                      className="w-44 rounded border border-gray-300 px-2 py-1 font-mono text-sm"
                      value={form.awsSessionToken}
                      onChange={(e) => {
                        updateForm(p.id, { awsSessionToken: e.target.value });
                        localStorage.setItem(LS_AWS_TOKEN(p.id), e.target.value);
                      }}
                    />
                    <input
                      type="text"
                      placeholder="model"
                      className="w-72 rounded border border-gray-300 px-2 py-1 font-mono text-sm"
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
                      className="w-56 rounded border border-gray-300 px-2 py-1 text-sm"
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
                      className="w-72 rounded border border-gray-300 px-2 py-1 font-mono text-sm"
                      value={form.model}
                      onChange={(e) => {
                        updateForm(p.id, { model: e.target.value });
                        localStorage.setItem(LS_MODEL(p.id), e.target.value);
                      }}
                    />
                    {p.baseUrlEditable && (
                      <input
                        type="text"
                        placeholder="baseUrl（替换 {account_id}/{gateway_id}）"
                        className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 font-mono text-sm"
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
            <div
              key={c.id}
              className="flex flex-wrap items-center gap-3 rounded-md border border-gray-200 bg-white px-3 py-2"
            >
              <label className="flex w-44 items-center gap-2">
                <input
                  type="checkbox"
                  checked={c.enabled}
                  onChange={(e) => updateCustom(c.id, { enabled: e.target.checked })}
                />
                <span className="font-medium">{c.name}</span>
              </label>
              <input
                type="password"
                placeholder="API Key"
                className="w-56 rounded border border-gray-300 px-2 py-1 text-sm"
                value={c.apiKey}
                onChange={(e) => updateCustom(c.id, { apiKey: e.target.value })}
              />
              {renderEnvKeySelect((v) => updateCustom(c.id, { apiKey: v }))}
              <input
                type="text"
                placeholder="model"
                className="w-72 rounded border border-gray-300 px-2 py-1 font-mono text-sm"
                value={c.model}
                onChange={(e) => updateCustom(c.id, { model: e.target.value })}
              />
              <input
                type="text"
                placeholder="baseUrl"
                className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 font-mono text-sm"
                value={c.baseUrl}
                onChange={(e) => updateCustom(c.id, { baseUrl: e.target.value })}
              />
              <button
                onClick={() => removeCustom(c.id)}
                className="rounded px-2 py-1 text-sm text-red-600 hover:bg-red-50"
                title="删除该供应商"
              >
                删除
              </button>
            </div>
          ))}

          {/* Add-custom-provider form */}
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed border-gray-300 px-3 py-2">
            <span className="w-44 text-sm text-gray-500">自定义供应商</span>
            <input
              type="text"
              placeholder="名称（可空，取 baseUrl 主机名）"
              className="w-44 rounded border border-gray-300 px-2 py-1 text-sm"
              value={newCustom.name}
              onChange={(e) => setNewCustom({ ...newCustom, name: e.target.value })}
            />
            <input
              type="text"
              placeholder="baseUrl，如 https://api.example.com/v1"
              className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 font-mono text-sm"
              value={newCustom.baseUrl}
              onChange={(e) => setNewCustom({ ...newCustom, baseUrl: e.target.value })}
            />
            <input
              type="password"
              placeholder="API Key"
              className="w-48 rounded border border-gray-300 px-2 py-1 text-sm"
              value={newCustom.apiKey}
              onChange={(e) => setNewCustom({ ...newCustom, apiKey: e.target.value })}
            />
            <input
              type="text"
              placeholder="模型名"
              className="w-56 rounded border border-gray-300 px-2 py-1 font-mono text-sm"
              value={newCustom.model}
              onChange={(e) => setNewCustom({ ...newCustom, model: e.target.value })}
            />
            <button
              onClick={addCustom}
              disabled={!newCustom.baseUrl.trim() || !newCustom.model.trim()}
              className="rounded bg-gray-700 px-3 py-1 text-sm text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              + 添加
            </button>
          </div>
        </div>
      </section>

      {/* Prompt configuration */}
      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold">Prompt</h2>
        <div className="space-y-3">
          <textarea
            placeholder="System prompt（可选）"
            rows={2}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
          <textarea
            placeholder="User prompt"
            rows={4}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
            value={userPrompt}
            onChange={(e) => setUserPrompt(e.target.value)}
          />
          <div className="flex gap-6 text-sm">
            <label className="flex items-center gap-2">
              max_tokens
              <input
                type="number"
                className="w-24 rounded border border-gray-300 px-2 py-1"
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value))}
              />
            </label>
            <label className="flex items-center gap-2">
              temperature
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                className="w-24 rounded border border-gray-300 px-2 py-1"
                value={temperature}
                onChange={(e) => setTemperature(Number(e.target.value))}
              />
            </label>
          </div>
        </div>
      </section>

      {/* Run controls */}
      <section className="mb-8 flex items-center gap-3">
        {!running ? (
          <button
            onClick={handleRun}
            disabled={enabledCount === 0}
            className="rounded bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            运行（{enabledCount} 家供应商）
          </button>
        ) : (
          <button
            onClick={handleAbort}
            className="rounded bg-red-600 px-5 py-2 text-sm font-medium text-white hover:bg-red-700"
          >
            中止
          </button>
        )}
      </section>

      {/* Metrics cards */}
      {Object.keys(runs).length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">结果</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {/* Unified card source: builtin providers + custom entries that have a run. */}
            {[
              ...PROVIDERS.map((p) => ({ id: p.id, name: p.name, model: forms[p.id]?.model ?? '' })),
              ...customs.map((c) => ({ id: c.id, name: c.name, model: c.model })),
            ]
              .filter((p) => runs[p.id])
              .map((p) => {
              const run = runs[p.id];
              const m = run.metrics;
              return (
                <div key={p.id} className="rounded-md border border-gray-200 bg-white p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <span className="font-semibold">{p.name}</span>
                      <span className="ml-2 font-mono text-xs text-gray-500">{p.model}</span>
                    </div>
                    <span className={`rounded px-2 py-0.5 text-xs ${STATUS_COLOR[run.status]}`}>
                      {STATUS_LABEL[run.status]}
                    </span>
                  </div>
                  {run.status === 'error' ? (
                    <p className="break-all text-sm text-red-700">{m.error}</p>
                  ) : (
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                      <dt className="text-gray-500">TTFB</dt>
                      <dd>{fmtMs(m.ttfbMs)}</dd>
                      <dt className="text-gray-500">TTFT</dt>
                      <dd>{fmtMs(m.ttftMs)}</dd>
                      <dt className="text-gray-500">总耗时</dt>
                      <dd>{fmtMs(m.totalMs)}</dd>
                      <dt className="text-gray-500">输出 tokens</dt>
                      <dd>
                        {m.outputTokens}
                        {m.tokensEstimated && m.outputTokens > 0 && (
                          <span className="ml-1 text-xs text-gray-400">（估算）</span>
                        )}
                      </dd>
                      <dt className="text-gray-500">吞吐</dt>
                      <dd>{fmtRate(m.tokensPerSec)}</dd>
                      <dt className="text-gray-500">decode 速率</dt>
                      <dd>{fmtRate(m.decodeTokensPerSec)}</dd>
                    </dl>
                  )}
                  {run.output && (
                    <details className="mt-3">
                      <summary className="cursor-pointer text-sm text-gray-500">输出原文</summary>
                      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs">
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
