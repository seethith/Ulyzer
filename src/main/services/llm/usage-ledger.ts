import type { TokenUsage } from '@shared/types';
import { getDb } from '../db/sqlite';
import { tokenMeter } from '../agent-context/token-meter';

export interface UsageLedgerRecordInput {
  sessionId?: string | null;
  courseId?: string | null;
  provider: string;
  model: string;
  usage?: Partial<TokenUsage> | null;
  source?: string | null;
  estimateSource?: string | null;
}

function normalizeUsage(usage?: Partial<TokenUsage> | null): TokenUsage {
  const inputCacheHitTokens = Math.max(0, Math.round(usage?.inputCacheHitTokens ?? 0));
  const inputCacheMissTokens = Math.max(0, Math.round(usage?.inputCacheMissTokens ?? 0));
  const inputTokens = Math.max(
    0,
    Math.round(usage?.inputTokens ?? inputCacheHitTokens + inputCacheMissTokens),
  ) || inputCacheHitTokens + inputCacheMissTokens;
  return {
    inputTokens,
    outputTokens: Math.max(0, Math.round(usage?.outputTokens ?? 0)),
    costCny: usage?.costCny ?? 0,
    ...(inputCacheHitTokens > 0 ? { inputCacheHitTokens } : {}),
    ...(inputCacheMissTokens > 0 ? { inputCacheMissTokens } : {}),
    ...(usage?.estimated ? { estimated: true } : {}),
  };
}

export class UsageLedger {
  record(input: UsageLedgerRecordInput): TokenUsage {
    const usage = normalizeUsage(input.usage);
    if (
      usage.inputTokens <= 0
      && usage.outputTokens <= 0
      && (usage.inputCacheHitTokens ?? 0) <= 0
      && (usage.inputCacheMissTokens ?? 0) <= 0
      && usage.costCny <= 0
    ) {
      return usage;
    }

    try {
      const db = getDb();
      db.prepare(
        `INSERT INTO token_logs (
           session_id, course_id, provider, model, source,
           input_tokens, output_tokens, input_cache_hit_tokens, input_cache_miss_tokens,
           usage_estimated, cost_cny
         ) VALUES (
           @session_id, @course_id, @provider, @model, @source,
           @input_tokens, @output_tokens, @input_cache_hit_tokens, @input_cache_miss_tokens,
           @usage_estimated, @cost_cny
         )`,
      ).run({
        session_id: input.sessionId ?? null,
        course_id: input.courseId ?? null,
        provider: input.provider,
        model: input.model,
        source: input.source ?? 'unknown',
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        input_cache_hit_tokens: usage.inputCacheHitTokens ?? 0,
        input_cache_miss_tokens: usage.inputCacheMissTokens ?? 0,
        usage_estimated: usage.estimated ? 1 : 0,
        cost_cny: usage.costCny,
      });

      if (input.courseId) {
        db.prepare(
          `UPDATE courses
              SET total_token_used = COALESCE(total_token_used, 0) + @tokens,
                  total_cost_cny = COALESCE(total_cost_cny, 0) + @cost,
                  updated_at = datetime('now')
            WHERE id = @course_id`,
        ).run({
          course_id: input.courseId,
          tokens: usage.inputTokens + usage.outputTokens,
          cost: usage.costCny,
        });
      }

      tokenMeter.completeLatestEstimate({
        sessionId: input.sessionId,
        provider: input.provider,
        model: input.model,
        source: input.estimateSource,
        usage,
      });
    } catch {
      // Usage accounting must never break a model response.
    }

    return usage;
  }
}

export const usageLedger = new UsageLedger();
