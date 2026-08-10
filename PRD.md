# LLM Provider Benchmark — 产品需求文档（PRD）

## 1. 背景与目标

市面上 LLM API 供应商众多（OpenRouter、Replicate、Vercel AI Gateway、Cloudflare AI Gateway 等），同一模型在不同供应商下的实际性能差异缺乏直观的横向对比工具。

**目标**：做一个 Web 工具，对**同一模型**在不同供应商间，用**相同的 prompt 组**并发发起请求，实时对比 TTFT（首 token 延迟）、吞吐（tokens/s）等指标，辅助技术选型。

## 2. 用户与核心场景

- **用户**：开发者 / 技术选型人员。
- **核心场景**：
  1. 选定一个模型（如 `llama-3.3-70b`）；
  2. 勾选 2~N 个供应商；
  3. 选择或编辑若干组 prompt；
  4. 点击运行，各供应商并发跑同样的 prompt；
  5. 实时看到每个供应商的 TTFT、吞吐、总耗时、成本估算；
  6. 可重复多轮取平均/中位数。

## 3. 功能需求

### 3.1 P0 — 供应商管理

- 内置预设供应商分两类：
  - **API Key 认证（OpenAI 兼容协议）**：OpenRouter、Vercel AI Gateway、Cloudflare AI Gateway、Together、Fireworks、Groq、DeepInfra 等；
  - **GCP 认证（OpenAI 兼容协议）**：Vertex AI——endpoint 为 `https://aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi`，协议本身是 OpenAI 兼容，但认证是 Google Cloud OAuth（service account JSON → access token，token 默认 1 小时过期需刷新）。
- 每个供应商配置项：
  - 认证信息：API Key，或 Vertex 的 project / location / service account JSON（仅存浏览器 localStorage，不入库、不上传）；
  - 模型 ID 映射（同一逻辑模型在各家的实际 model 名不同，如 Vertex 用 `google/gemini-3.5-flash`）及能力标签（text / vision）；
  - 供应商特定参数透传（如 Vertex 的 `extra_body.google.thinking_config`、OpenRouter 的自定义 headers）。
- 支持用户自定义添加 OpenAI 兼容供应商。

### 3.2 P0 — 模型与任务分类

- 模型按任务类型分类，MVP 支持两类：
  - **文本推理（text）**：纯文本输入输出，含 reasoning 推理模型；
  - **多模态视觉（vision）**：图片 + 文本输入，文本输出。
- 分类贯穿整个流程：选模型（带类型）→ 过滤出支持该模型的供应商 → 只显示匹配类型的 prompt 组。
- 供应商的模型映射需标注能力标签（text / vision），运行前校验供应商是否支持所选模型及输入类型。
- 结构上预留扩展：后续可增加 embedding、图像生成、TTS 等类型。

### 3.3 P0 — Prompt 组管理

- Prompt 组按类型区分：**文本组** / **图文组**。
- 文本组：名称、system prompt（可选）、user prompt、`max_tokens`、`temperature`。
- 图文组：在文本组基础上增加**图片输入**——本地上传（转 base64 data URL）或图片 URL；统一管理图片素材库，可复用。
- 图片统一用 OpenAI 兼容的 `image_url` content 格式发送；记录图片分辨率与文件大小（影响 prefill 和计费）。
- 内置示例组：短问答 / 长文生成 / 代码生成 / 图片理解（看图描述、图表问答）。

### 3.4 P0 — 基准测试运行

- 对选中供应商**并发**发起流式请求（图文组即同一张图 + 同一 prompt 并发发给各家 vision 模型），逐供应商独立计时。
- 每组 prompt 可设置重复次数（默认 3 次），结果取平均/中位数/p50/p95。
- 支持运行中止（AbortController）。

### 3.5 P0 — 指标采集

- TTFT（首 token 到达时间，ms）
- TTFB（HTTP 首字节时间，ms）：与 TTFT 的差值用于区分网络/排队慢还是模型生成慢，对网关类供应商（Cloudflare / Vercel）尤其有参考价值
- 总时延（ms）
- 输出 token 数
- 吞吐（tokens/s，全程）
- decode 速率（TTFT 之后的 tokens/s）
- ITL / TPOT（逐 token 间隔）：记录每个 chunk 间隔，输出 p50/p95，衡量输出抖动（jitter）
- prefill 速率估算：输入 token 数 ÷ (TTFT − 网络开销)，长 prompt 场景下区分度大
- 多轮统计：TTFT / 吞吐报 p50/p95，避免单次均值被异常值带偏
- 错误 / 超时标记（区分 429 限流、5xx、超时）
- 成本估算（若配置了供应商单价，USD；图文组需包含图片 token 化的费用）

### 3.6 P0 — 结果展示

- 实时表格 + 柱状图对比（TTFT / throughput 两个维度）。
- 逐轮原始结果可展开查看（含每轮输出原文，便于核对输出长度差异）。
- 导出 JSON / CSV。

### 3.7 P1 — 后续迭代

- 多模型同时对比；
- 历史记录持久化（IndexedDB）；
- 结果分享链接；
- 网关类供应商（Cloudflare / Vercel）自带遥测数据的对照展示；
- 更多云厂商适配器：AWS Bedrock（SigV4 签名认证）、Azure OpenAI（api-key + deployment 维度 URL）；协议均非标准 OpenAI 兼容或认证复杂，走适配器扩展。

## 4. 非功能需求

- **隐私**：API Key / service account JSON 等凭据只存浏览器本地；服务端仅做请求中转（代理），不记录、不持久化凭据。Vertex 的 OAuth token 交换在代理侧按请求完成，access token 仅内存缓存、随过期丢弃。
- **CORS**：通过代理层解决浏览器直连各供应商 API 的跨域问题（GCP / AWS 的签名与 OAuth 流程也必须在代理侧完成，浏览器直连不可行）。
- **保护上限**：单次运行 供应商数 × prompt 组数 × 重复次数 ≤ 可配置上限（默认 100 请求）。
- 单请求默认超时 60s。

## 5. 技术方案

**Next.js (App Router) + TypeScript 单仓全栈**：

- 前端：Next.js + Tailwind + shadcn/ui，图表用 Recharts。
- 后端：Next.js Route Handler 做 SSE/流式代理，转发到各供应商端点；计时在前端基于流式 chunk 完成（TTFT = 收到第一个非空内容 chunk 的时间）。
- **Provider 注册表 + 适配器模式**（核心设计，保证新增供应商低成本）：
  - 所有供应商在一份注册表（`providers.ts`）中声明：id、名称、协议类型、认证方式、模型映射、单价；
  - **协议适配**：`openai-compatible` 覆盖绝大多数供应商，零代码纯配置；专有协议（Replicate，后续 Bedrock / Azure）实现统一 `ProviderAdapter` 接口；
  - **认证策略**与协议解耦：`api-key`（header 透传）、`gcp-oauth`（service account → access token，代理侧刷新）、`aws-sigv4`（P1）、`azure-key`（P1）；
  - 计时、指标采集、展示完全基于适配器输出的统一 chunk 流，新增供应商不触碰这些代码。
- Replicate：独立的 provider 适配模块（REST / streaming API）。
- 状态：React state + localStorage；无需数据库。
- 部署：Vercel 一键部署。

## 6. 数据与接口要点

- 统一内部接口：`runBenchmark({ provider, model, prompt, params }) -> AsyncIterable<chunk>`，各供应商实现适配；`prompt` 支持文本与图文（`image_url` content）两种形态。
- Provider 注册表条目：

```ts
interface ProviderConfig {
  id: string;
  name: string;
  protocol: 'openai-compatible' | 'replicate';  // P1: 'bedrock' | 'azure'
  auth: 'api-key' | 'gcp-oauth';                // P1: 'aws-sigv4' | 'azure-key'
  baseUrl: string;                              // 可含 {project}/{location} 占位（Vertex）
  models: { logical: string; remote: string; capabilities: ('text'|'vision')[] }[];
  pricing?: { inputPer1M: number; outputPer1M: number };
  defaultHeaders?: Record<string, string>;      // 如 OpenRouter 的 HTTP-Referer
  extraBody?: Record<string, unknown>;          // 如 Vertex 的 google.thinking_config
}
```

- 认证在代理侧按 `auth` 策略处理：`api-key` 直接透传 header；`gcp-oauth` 用 service account JSON 换 access token（内存缓存至过期，供 1 小时有效期内复用）。
- 指标结构：

```ts
interface RunMetrics {
  ttfbMs: number | null;     // HTTP 首字节（区分网络/排队 vs 模型生成）
  ttftMs: number | null;
  totalMs: number;
  outputTokens: number;      // 精确值或本地估算（需标注）
  tokensPerSec: number;
  decodeTokensPerSec: number;
  itlMsP50?: number;         // 逐 token 间隔 p50/p95（抖动）
  itlMsP95?: number;
  costUsd?: number;          // 图文组含图片 token 费用
  error?: string;
}
```

- 流式解析：OpenAI 兼容 SSE（`data: {...}\n\n`，以 `data: [DONE]` 结束）；Replicate 使用其 streaming API。

## 7. 边界情况

- 供应商报错 / 限流 / 超时：该行标记错误并展示原因，不影响其他供应商继续。
- 某供应商不支持所选模型或输入类型（如纯文本模型发图文请求）：配置阶段提示，运行前校验并阻止。
- 图片超限：base64 图片超过供应商大小/分辨率限制时，运行前提示压缩或换图；各家限制不同，按最严格者预先校验。
- 响应缺少 `usage` 字段：token 数用本地估算（按 chunk 增量近似）并在 UI 标注「估算」。

## 8. 里程碑

- **M1**：Next.js 脚手架 + provider 注册表/适配器抽象 + 供应商配置 + OpenAI 兼容流式代理 + 单 prompt 组跑通 TTFT/吞吐展示。
- **M2**：Vertex AI 适配（GCP OAuth 认证 + `extra_body` 参数透传）；prompt 组管理（含图文组）、重复次数、图表对比、导出 JSON/CSV。
- **M3**：Replicate 适配、自定义供应商、成本估算。
- **M4（P1）**：Bedrock（SigV4）、Azure OpenAI 适配器。
