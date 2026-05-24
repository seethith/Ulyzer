import type { LLMProvider, TokenUsage } from '@shared/types';
import type { ToolTurnMessage } from '../llm/adapter';
import { collapseContext, compressToolHistory } from './history';
import { message } from '../agent-i18n/messages';

/**
 * Single source of truth for in-memory tool-loop context compaction.
 *
 * Tiers, cheapest first (mirrors Claude Code / opencode graduated degradation):
 *  - `compress`  — microcompact: fold older tool turns into a short text summary (no LLM).
 *  - `collapse`  — semantic LLM summary of history.
 *  - `truncate`  — hard head/tail keep, last resort.
 *
 * Two entry points share these tiers:
 *  - `runGraduatedCompaction` — threshold-driven escalation (chat loop's proactive pre-turn check).
 *  - `compactByDecision`      — boolean-driven single tier (callers tracking a cumulative budget,
 *                               e.g. the material-generation loop).
 *
 * NOTE: thread/DB-level compaction lives in ContextWindowManager (compactThread) — a different
 * concern (persisted checkpoints), intentionally not merged here.
 */

export type CompactionTier = 'none' | 'compress' | 'collapse' | 'truncate';

export interface CompactionLlmOptions {
  provider: LLMProvider;
  model: string;
  signal?: AbortSignal;
  language?: string;
  onProgress: (msg: string) => void;
  onUsage?: (usage: TokenUsage) => void;
}

export interface CompactionResult {
  messages: ToolTurnMessage[];
  applied: CompactionTier;
}

/** Hard head/tail keep — drop the middle. Shared by the graduated ladder and reactive recovery. */
export function truncateHeadTail(
  messages: ToolTurnMessage[],
  opts: { head?: number; tail?: number } = {},
): ToolTurnMessage[] {
  const head = Math.max(0, opts.head ?? 2);
  const tail = Math.max(0, opts.tail ?? 4);
  if (messages.length <= head + tail) return messages;
  return [...messages.slice(0, head), ...messages.slice(-tail)];
}

async function applyTier(
  history: ToolTurnMessage[],
  tier: 'compress' | 'collapse',
  llm: CompactionLlmOptions,
): Promise<ToolTurnMessage[]> {
  if (tier === 'collapse') {
    llm.onProgress(message('contextNearLimitSummarizing', llm.language));
    return collapseContext(history, llm);
  }
  llm.onProgress(message('contextNearLimitCompressing', llm.language));
  return compressToolHistory(history, llm.language);
}

/**
 * Boolean-driven single-tier compaction (collapse takes priority over compress).
 * The caller decides which tier is warranted from its own budget; returns the tier
 * actually applied so the caller can e.g. reset a cumulative budget after a collapse.
 */
export async function compactByDecision(
  messages: ToolTurnMessage[],
  opts: CompactionLlmOptions & {
    compress: boolean;
    collapse: boolean;
    preserveFirstMessage?: boolean;
    minMessages?: number;
  },
): Promise<CompactionResult> {
  const minMessages = opts.minMessages ?? 4;
  if (messages.length <= minMessages) return { messages, applied: 'none' };

  const tier: 'compress' | 'collapse' | null = opts.collapse ? 'collapse' : opts.compress ? 'compress' : null;
  if (!tier) return { messages, applied: 'none' };

  const [first, ...rest] = messages;
  const history = opts.preserveFirstMessage ? rest : messages;
  const out = await applyTier(history, tier, opts);
  return {
    messages: opts.preserveFirstMessage ? [first, ...out] : out,
    applied: tier,
  };
}

/**
 * Threshold-driven graduated compaction: free microcompact first, escalate to an
 * LLM collapse only if still over the hard threshold, optional final truncation.
 */
export async function runGraduatedCompaction(
  messages: ToolTurnMessage[],
  opts: CompactionLlmOptions & {
    estimate: (msgs: ToolTurnMessage[]) => number;
    compressAt: number;
    collapseAt: number;
    allowTruncate?: boolean;
  },
): Promise<CompactionResult> {
  let current = messages;
  let tokens = opts.estimate(current);
  if (tokens < opts.compressAt) return { messages: current, applied: 'none' };

  let applied: CompactionTier = 'none';

  // Tier 1 (free): microcompact older tool turns.
  const compressed = compressToolHistory(current, opts.language);
  if (compressed !== current) {
    current = compressed;
    tokens = opts.estimate(current);
    applied = 'compress';
    opts.onProgress(message('contextNearLimitCompressing', opts.language));
  }

  // Tier 2 (LLM): semantic collapse only if still near the hard limit.
  if (tokens >= opts.collapseAt) {
    opts.onProgress(message('contextNearLimitSummarizing', opts.language));
    current = await collapseContext(current, opts);
    tokens = opts.estimate(current);
    applied = 'collapse';
  }

  // Tier 3 (optional): hard head/tail truncation as a last resort.
  if (opts.allowTruncate && tokens >= opts.collapseAt) {
    current = truncateHeadTail(current);
    applied = 'truncate';
  }

  return { messages: current, applied };
}
