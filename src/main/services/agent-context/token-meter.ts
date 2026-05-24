import { randomUUID } from 'crypto';
import type { TokenUsage } from '@shared/types';
import type { ToolDef, ToolTurnMessage } from '../llm/adapter';
import { getDb } from '../db/sqlite';
import { countTokens } from '../llm/token-counter';
import type { ContextWindowBudget } from './context-window-budget';

export interface TokenBreakdown {
  textTokens: number;
  toolTokens: number;
  toolSchemaTokens: number;
  attachmentTokens: number;
  summaryTokens: number;
  systemTokens: number;
  reservedOutputTokens: number;
  reservedThinkingTokens: number;
  safetyTokens: number;
  estimatedInputTokens: number;
  estimatedTotalTokens: number;
}

export interface ContextSnapshot {
  provider: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputBudget: number;
  estimatedInputTokens: number;
  estimatedTotalTokens: number;
  estimatedUsageRatio: number;
  compressAt: number;
  collapseAt: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  liveMessageCount: number;
  checkpointCount: number;
  summaryTokens: number;
  microCompactedCount: number;
  rawTranscriptTokens: number;
  projectedTokens: number;
  tokenBeforeProjection: number;
  tokenAfterProjection: number;
  collapseSavings: number;
  breakdown: TokenBreakdown;
}

export interface UsageEstimateInput {
  sessionId?: string | null;
  courseId?: string | null;
  threadId?: string | null;
  provider: string;
  model: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  source?: string;
}

function toolTurnTokenParts(message: ToolTurnMessage): { text: number; tool: number } {
  if (message.role === 'user') return { text: countTokens(message.content), tool: 0 };
  if (message.role === 'assistant') {
    const toolCalls = message.toolCalls.length > 0 ? JSON.stringify(message.toolCalls) : '';
    return {
      text: countTokens(message.text),
      tool: toolCalls ? countTokens(toolCalls) : 0,
    };
  }
  return {
    text: 0,
    tool: countTokens(message.results.map((result) => result.content).join('\n')),
  };
}

function readCorrectionFactor(provider: string, model: string): number {
  try {
    const row = getDb()
      .prepare<[string, string], { ratio: number | null }>(
        `SELECT AVG(estimate_ratio) AS ratio
           FROM (
             SELECT estimate_ratio
               FROM llm_usage_estimates
              WHERE provider = ?
                AND model = ?
                AND estimate_ratio IS NOT NULL
              ORDER BY completed_at DESC
              LIMIT 30
           )`,
      )
      .get(provider, model);
    const ratio = row?.ratio;
    return typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0
      ? Math.max(0.5, Math.min(1.75, ratio))
      : 1;
  } catch {
    return 1;
  }
}

export class TokenMeter {
  measureToolMessages(input: {
    provider: string;
    model: string;
    messages: ToolTurnMessage[];
    tools?: ToolDef[];
    systemPrompt?: string;
    budget: ContextWindowBudget;
    summaryText?: string;
    imageCount?: number;
    pdfPageCount?: number;
    applyCorrection?: boolean;
  }): TokenBreakdown {
    let textTokens = 0;
    let toolTokens = 0;
    for (const message of input.messages) {
      const parts = toolTurnTokenParts(message);
      textTokens += parts.text;
      toolTokens += parts.tool;
    }
    const toolSchemaTokens = input.tools?.length ? countTokens(JSON.stringify(input.tools)) : 0;
    const systemTokens = countTokens(input.systemPrompt ?? '');
    const summaryTokens = countTokens(input.summaryText ?? '');
    const attachmentTokens = (input.imageCount ?? 0) * 1_600 + (input.pdfPageCount ?? 0) * 1_200;
    const overhead = input.messages.length * 4 + 16;
    const rawInput = textTokens + toolTokens + toolSchemaTokens + systemTokens + attachmentTokens + overhead;
    const factor = input.applyCorrection === false
      ? 1
      : readCorrectionFactor(input.provider, input.model);
    const estimatedInputTokens = Math.max(0, Math.round(rawInput * factor));
    const estimatedTotalTokens = estimatedInputTokens
      + input.budget.reservedOutputTokens
      + input.budget.reservedThinkingTokens
      + input.budget.safetyTokens;

    return {
      textTokens,
      toolTokens,
      toolSchemaTokens,
      attachmentTokens,
      summaryTokens,
      systemTokens,
      reservedOutputTokens: input.budget.reservedOutputTokens,
      reservedThinkingTokens: input.budget.reservedThinkingTokens,
      safetyTokens: input.budget.safetyTokens,
      estimatedInputTokens,
      estimatedTotalTokens,
    };
  }

  snapshot(input: {
    provider: string;
    model: string;
    budget: ContextWindowBudget;
    breakdown: TokenBreakdown;
    liveMessageCount: number;
    checkpointCount: number;
    rawTranscriptTokens: number;
    projectedTokens: number;
    tokenBeforeProjection: number;
    tokenAfterProjection: number;
    microCompactedCount: number;
  }): ContextSnapshot {
    const estimatedUsageRatio = input.budget.contextWindow > 0
      ? input.breakdown.estimatedTotalTokens / input.budget.contextWindow
      : 0;
    const riskLevel = input.breakdown.estimatedInputTokens >= input.budget.inputBudget
      ? 'critical'
      : input.breakdown.estimatedInputTokens >= input.budget.collapseAt
        ? 'high'
        : input.breakdown.estimatedInputTokens >= input.budget.compressAt
          ? 'medium'
          : 'low';
    return {
      provider: input.provider,
      model: input.model,
      contextWindow: input.budget.contextWindow,
      maxOutputTokens: input.budget.maxOutputTokens,
      inputBudget: input.budget.inputBudget,
      estimatedInputTokens: input.breakdown.estimatedInputTokens,
      estimatedTotalTokens: input.breakdown.estimatedTotalTokens,
      estimatedUsageRatio,
      compressAt: input.budget.compressAt,
      collapseAt: input.budget.collapseAt,
      riskLevel,
      liveMessageCount: input.liveMessageCount,
      checkpointCount: input.checkpointCount,
      summaryTokens: input.breakdown.summaryTokens,
      microCompactedCount: input.microCompactedCount,
      rawTranscriptTokens: input.rawTranscriptTokens,
      projectedTokens: input.projectedTokens,
      tokenBeforeProjection: input.tokenBeforeProjection,
      tokenAfterProjection: input.tokenAfterProjection,
      collapseSavings: Math.max(0, input.tokenBeforeProjection - input.tokenAfterProjection),
      breakdown: input.breakdown,
    };
  }

  recordEstimate(input: UsageEstimateInput): string | null {
    try {
      const id = randomUUID();
      getDb()
        .prepare(
          `INSERT INTO llm_usage_estimates (
             id, session_id, course_id, thread_id, provider, model,
             estimated_input_tokens, estimated_output_tokens, source
           ) VALUES (
             @id, @session_id, @course_id, @thread_id, @provider, @model,
             @estimated_input_tokens, @estimated_output_tokens, @source
           )`,
        )
        .run({
          id,
          session_id: input.sessionId ?? null,
          course_id: input.courseId ?? null,
          thread_id: input.threadId ?? null,
          provider: input.provider,
          model: input.model,
          estimated_input_tokens: input.estimatedInputTokens,
          estimated_output_tokens: input.estimatedOutputTokens,
          source: input.source ?? 'context_projection',
        });
      return id;
    } catch {
      return null;
    }
  }

  completeLatestEstimate(input: {
    sessionId?: string | null;
    provider: string;
    model: string;
    source?: string | null;
    usage: Partial<TokenUsage>;
  }): void {
    try {
      const row = getDb()
        .prepare(
          `SELECT id, estimated_input_tokens
             FROM llm_usage_estimates
            WHERE completed_at IS NULL
              AND ((@session_id IS NULL AND session_id IS NULL) OR session_id = @session_id)
              AND provider = @provider
              AND model = @model
              AND (@source IS NULL OR source = @source)
            ORDER BY created_at DESC
            LIMIT 1`,
        )
        .get({
          session_id: input.sessionId ?? null,
          provider: input.provider,
          model: input.model,
          source: input.source ?? null,
        }) as { id: string; estimated_input_tokens: number } | undefined;
      if (!row) return;
      const actualInput = input.usage.inputTokens ?? 0;
      const ratio = row.estimated_input_tokens > 0 && actualInput > 0
        ? actualInput / row.estimated_input_tokens
        : null;
      getDb()
        .prepare(
          `UPDATE llm_usage_estimates
              SET actual_input_tokens = @actual_input_tokens,
                  actual_output_tokens = @actual_output_tokens,
                  estimate_ratio = @estimate_ratio,
                  completed_at = datetime('now')
            WHERE id = @id`,
        )
        .run({
          id: row.id,
          actual_input_tokens: actualInput,
          actual_output_tokens: input.usage.outputTokens ?? 0,
          estimate_ratio: ratio,
        });
    } catch {
      // Estimate calibration must never break user-visible model responses.
    }
  }
}

export const tokenMeter = new TokenMeter();
