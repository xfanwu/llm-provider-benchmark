// Types for a single benchmark run against one provider.

export type RunStatus = 'idle' | 'pending' | 'connecting' | 'streaming' | 'done' | 'error' | 'aborted';

export interface RunMetrics {
  /** HTTP headers received (fetch resolved), ms since start. */
  ttfbMs: number | null;
  /** First SSE chunk carrying non-empty content, ms since start. */
  ttftMs: number | null;
  /** Total wall time from request start to [DONE] / error / abort, ms. */
  totalMs: number | null;
  /** Output token count (from usage if present, otherwise estimated). */
  outputTokens: number;
  /** True when outputTokens is estimated from content length. */
  tokensEstimated: boolean;
  /** Overall throughput: outputTokens / totalMs. */
  tokensPerSec: number | null;
  /** Decode rate: tokens after TTFT / (totalMs - ttftMs). */
  decodeTokensPerSec: number | null;
  /** Upstream error message, when status is 'error'. */
  error?: string;
}

export interface RunState {
  providerId: string;
  status: RunStatus;
  metrics: RunMetrics;
  /** Accumulated raw output text (collapsible in UI). */
  output: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
