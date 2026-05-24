import type { AgentType, ChatMessage, LLMMessage, LLMProvider, ThinkingMode, TokenUsage } from '@shared/types';
import type { ImageAttachment, PdfAttachment, ToolDef, ToolTurnMessage } from '../llm/adapter';
import { LLMAdapter } from '../llm/adapter';
import { message as i18nMessage } from '../agent-i18n/messages';
import { ChatThreadContextRepository, type ThreadMessageRow } from '../db/repositories/chat-thread-context.repo';
import {
  ChatContextCollapseRepository,
  type ChatContextCollapseKind,
  type ChatContextCollapseRecord,
} from '../db/repositories/chat-context-collapse.repo';
import { AgentContextEntryRepository, type AgentContextEntryRecord } from '../db/repositories/agent-context-entry.repo';
import { countTokens } from '../llm/token-counter';
import { resolveContextWindowBudget, type ContextTaskKind, type ContextWindowBudget } from './context-window-budget';
import { snipMessage } from './history';
import { appendMissingMustKeeps, validateContextSummary, type ContextSummaryValidation } from './context-summary-validator';
import { tokenMeter, type ContextSnapshot } from './token-meter';

interface PreparedContextMessages {
  messages: ToolTurnMessage[];
  estimatedTokens: number;
  budget: ContextWindowBudget;
  compacted: boolean;
  snapshot: ContextSnapshot;
}

export interface CompactThreadInput {
  modelProvider: LLMProvider;
  model: string;
  courseId: string;
  nodeId?: string;
  threadId: string;
  agent: AgentType;
  language?: string;
  signal?: AbortSignal;
  currentUserMessage?: string;
  keepRecent?: number;
  instruction?: string;
  kind?: ChatContextCollapseKind;
  forceSnip?: boolean;
  onProgress?: (message: string) => void;
  onUsage?: (usage: TokenUsage) => void;
}

export interface CompactThreadResult {
  compacted: boolean;
  summarizedMessages: number;
  retainedMessages: number;
  rawMessageCount: number;
  summaryTokenCount: number;
  coveredMessageId: string | null;
  kind: ChatContextCollapseKind | 'none';
  validation?: ContextSummaryValidation;
}

interface PrepareMessagesInput {
  modelProvider: LLMProvider;
  model: string;
  courseId: string;
  nodeId?: string;
  threadId?: string;
  agent: AgentType;
  language?: string;
  thinkingMode?: ThinkingMode;
  taskKind?: ContextTaskKind;
  systemPrompt: string;
  initialMessages: ToolTurnMessage[];
  tools?: ToolDef[];
  fallbackMessages?: LLMMessage[];
  visibleMessages?: ChatMessage[];
  currentUserMessage: string;
  imageAttachments?: ImageAttachment[];
  pdfAttachments?: PdfAttachment[];
  sessionId?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onUsage?: (usage: TokenUsage) => void;
}

interface ProjectionBuildResult {
  messages: ToolTurnMessage[];
  projectedRows: ThreadMessageRow[];
  microCompactedCount: number;
  summaryText: string;
}

const DEFAULT_RECENT_KEEP = 16;
const COLLAPSE_RECENT_KEEP = 8;
const HARD_RECENT_KEEP = 4;
const RAW_KEEP_FOR_MICRO = 8;
const LONG_MESSAGE_TOKENS = 1_200;
const LONG_MESSAGE_CHARS = 4_000;
const SUMMARY_MAX_HISTORY_CHARS = 90_000;

function rowToToolTurn(row: ThreadMessageRow): ToolTurnMessage {
  return row.role === 'user'
    ? { role: 'user', content: row.content }
    : { role: 'assistant', text: row.content, toolCalls: [] };
}

function sameUserMessage(row: ThreadMessageRow | undefined, content: string): boolean {
  return Boolean(row && row.role === 'user' && row.content.trim() === content.trim());
}

function isContextControlMessage(row: ThreadMessageRow): boolean {
  return row.role === 'user' && /^\/(?:compact|usage|context|force-snip|snip)\b/i.test(row.content.trim());
}

function compactBoundaryTurn(summary: string, collapse: ChatContextCollapseRecord | null, language?: string): ToolTurnMessage[] {
  const isEn = language === 'en';
  const boundary = collapse
    ? `[compact_boundary id=${collapse.id} kind=${collapse.kind} covered_to=${collapse.to_message_id ?? 'unknown'}]`
    : '[compact_boundary legacy=true]';
  return [
    {
      role: 'user',
      content: [
        isEn ? '[Compressed conversation state]' : '[压缩后的连续对话状态]',
        summary.trim(),
        '',
        boundary,
        isEn
          ? 'The original transcript remains stored outside the active context. Continue from this projection and the recent full messages below.'
          : '原始 transcript 仍完整保存在活跃上下文之外。请基于这份投影视图和下面最近完整消息继续。',
      ].join('\n'),
    },
    {
      role: 'assistant',
      text: isEn
        ? 'Understood. I will continue from the compressed state and the recent full-fidelity transcript.'
        : '好的，我会基于压缩状态和最近完整原文继续。',
      toolCalls: [],
    },
  ];
}

function formatRows(rows: ThreadMessageRow[], maxChars = SUMMARY_MAX_HISTORY_CHARS): string {
  let out = '';
  for (const row of rows) {
    const label = row.role === 'user' ? 'User' : 'Assistant';
    const progress = row.progress ? `\n[progress]\n${snipMessage(row.progress)}` : '';
    const chunk = `\n\n<message id="${row.id}" at="${row.created_at}" role="${row.role}">\n${label}: ${snipMessage(row.content)}${progress}\n</message>`;
    if (out.length + chunk.length > maxChars) {
      out += `\n\n[History truncated before summarization: ${rows.length} messages total]`;
      break;
    }
    out += chunk;
  }
  return out.trim();
}

function fallbackContinuitySummary(previous: string | null, rows: ThreadMessageRow[], language?: string): string {
  const userTopics = rows
    .filter((row) => row.role === 'user')
    .map((row) => row.content.slice(0, 160).replace(/\s+/g, ' '))
    .filter(Boolean)
    .slice(-14);
  return [
    previous?.trim(),
    language === 'en'
      ? `Recent user requests before compaction: ${userTopics.join('; ')}`
      : `压缩前近期用户请求：${userTopics.join('；')}`,
  ].filter(Boolean).join('\n\n');
}

function continuitySummaryPrompt(language?: string): string {
  if (language === 'en') {
    return `You are the context compactor for an agentic learning app. Produce a continuity summary, not a user profile and not a fixed memory schema.
The original transcript is kept elsewhere; your job is to make the next context window continue the same task.
Preserve general discussion context, user corrections, constraints, file names/paths, generated materials, open loops, decisions and why they were made.
Output plain text only. Use compact headings if helpful.`;
  }
  return `你是一个 AI 学习软件的上下文压缩器。请生成“连续任务摘要”，不要写成用户画像，也不要硬套固定 memory schema。
原始 transcript 会完整保存在别处；你的任务是让新的 context window 能自然继续同一个任务。
必须保留一般讨论背景、用户纠错、约束、文件名/路径、已生成资料、未完成事项、关键决策及原因。
只输出纯文本摘要。必要时可用简短小标题。`;
}

function rowTokenCount(row: ThreadMessageRow): number {
  return row.token_count > 0 ? row.token_count : countTokens(row.content);
}

function microCompactRows(rows: ThreadMessageRow[], language?: string): { rows: ThreadMessageRow[]; count: number } {
  let count = 0;
  const cutoff = Math.max(0, rows.length - RAW_KEEP_FOR_MICRO);
  const projected = rows.map((row, index) => {
    if (index >= cutoff) return row;
    const shouldCompact = row.content.length > LONG_MESSAGE_CHARS || rowTokenCount(row) > LONG_MESSAGE_TOKENS;
    if (!shouldCompact) return row;
    count += 1;
    const head = row.content.slice(0, 900).trim();
    const tail = row.content.slice(-600).trim();
    const omitted = Math.max(0, row.content.length - head.length - tail.length);
    const content = language === 'en'
      ? [
          `[Message-level collapse: original transcript is preserved in storage]`,
          `message_id=${row.id}; role=${row.role}; created_at=${row.created_at}; omitted_chars=${omitted}`,
          '',
          head,
          omitted > 0 ? `\n...[${omitted} chars omitted from active projection]...\n` : '',
          tail,
        ].join('\n')
      : [
          `[消息级折叠：原始 transcript 已保留在存储中]`,
          `message_id=${row.id}; role=${row.role}; created_at=${row.created_at}; omitted_chars=${omitted}`,
          '',
          head,
          omitted > 0 ? `\n...[活跃投影中省略 ${omitted} 字符]...\n` : '',
          tail,
        ].join('\n');
    return {
      ...row,
      content,
      token_count: countTokens(content),
    };
  });
  return { rows: projected, count };
}

function latestBoundaryIndex(rows: ThreadMessageRow[], toMessageId: string | null | undefined): number {
  if (!toMessageId) return -1;
  return rows.findIndex((row) => row.id === toMessageId);
}

function shouldIncludeCurrentUserTurn(input: Pick<PrepareMessagesInput, 'currentUserMessage' | 'imageAttachments' | 'pdfAttachments'>): boolean {
  return input.currentUserMessage.trim().length > 0
    || (input.imageAttachments?.length ?? 0) > 0
    || (input.pdfAttachments?.length ?? 0) > 0;
}

function visibleMessageToRow(message: ChatMessage, index: number): ThreadMessageRow {
  const createdAt = Number.isFinite(message.timestamp) && message.timestamp > 0
    ? new Date(message.timestamp).toISOString()
    : new Date(index).toISOString();
  return {
    id: message.id || `visible-${index}`,
    role: message.role,
    content: message.content,
    progress: message.progress ?? null,
    created_at: createdAt,
    token_count: countTokens(message.content),
  };
}

function mergeVisibleRows(storedRows: ThreadMessageRow[], visibleRows: ThreadMessageRow[]): ThreadMessageRow[] {
  if (visibleRows.length === 0) return storedRows;
  const byId = new Map<string, ThreadMessageRow>();
  for (const row of storedRows) byId.set(row.id, row);
  for (const row of visibleRows) {
    const existing = byId.get(row.id);
    byId.set(row.id, existing ? {
      ...existing,
      role: row.role,
      content: row.content,
      progress: row.progress,
      token_count: row.token_count,
    } : row);
  }
  return [...byId.values()].sort((a, b) => {
    const at = Date.parse(a.created_at);
    const bt = Date.parse(b.created_at);
    return (Number.isFinite(at) ? at : 0) - (Number.isFinite(bt) ? bt : 0);
  });
}

function formatContextEntry(entry: AgentContextEntryRecord): string {
  return [
    `## ${entry.title || entry.kind}`,
    `kind=${entry.kind}; entry_id=${entry.id}; created_at=${entry.created_at}`,
    entry.content,
  ].join('\n');
}

export class ContextWindowManager {
  constructor(
    private readonly threadRepo = new ChatThreadContextRepository(),
    private readonly collapseRepo = new ChatContextCollapseRepository(),
    private readonly contextEntryRepo = new AgentContextEntryRepository(),
  ) {}

  async compactThread(input: CompactThreadInput): Promise<CompactThreadResult> {
    let rows = this.loadThreadRows(input.threadId);
    if (input.currentUserMessage && sameUserMessage(rows.at(-1), input.currentUserMessage)) {
      rows = rows.slice(0, -1);
    }
    const latest = this.safeLatestCheckpoint(input.threadId);
    const previousSummary = latest?.replacement_text ?? null;
    const coveredIndex = latestBoundaryIndex(rows, latest?.to_message_id);
    const uncoveredRows = coveredIndex >= 0 ? rows.slice(coveredIndex + 1) : rows;
    const keepRecent = Math.max(0, input.keepRecent ?? COLLAPSE_RECENT_KEEP);
    const split = Math.max(0, uncoveredRows.length - keepRecent);
    const rowsToSummarize = uncoveredRows.slice(0, split);

    if (rowsToSummarize.length === 0) {
      return {
        compacted: false,
        summarizedMessages: 0,
        retainedMessages: uncoveredRows.length,
        rawMessageCount: rows.length,
        summaryTokenCount: previousSummary ? countTokens(previousSummary) : 0,
        coveredMessageId: latest?.to_message_id ?? null,
        kind: 'none',
      };
    }

    input.onProgress?.(i18nMessage('contextNearLimitSummarizing', input.language));
    const kind = input.kind ?? (input.forceSnip ? 'emergency' : 'manual');
    const summary = input.forceSnip
      ? fallbackContinuitySummary(previousSummary, rowsToSummarize, input.language)
      : await this.summarizeRows({
          ...input,
          systemPrompt: '',
          initialMessages: [],
          currentUserMessage: '',
          previousSummary,
          rows: rowsToSummarize,
          instruction: input.instruction,
        });
    const validation = validateContextSummary(summary, rowsToSummarize);
    const finalSummary = appendMissingMustKeeps(summary, validation, input.language);
    const created = this.safeCreateCollapse({
      threadId: input.threadId,
      courseId: input.courseId,
      nodeId: input.nodeId ?? null,
      agent: input.agent,
      kind,
      fromMessageId: rowsToSummarize[0]?.id ?? null,
      toMessageId: rowsToSummarize.at(-1)?.id ?? null,
      replacementText: finalSummary,
      sourceEntryIds: rowsToSummarize.map((row) => row.id),
      instruction: input.instruction ?? null,
      tokenBefore: rowsToSummarize.reduce((sum, row) => sum + rowTokenCount(row), 0),
      tokenAfter: countTokens(finalSummary),
      validationJson: JSON.stringify(validation),
    });

    return {
      compacted: true,
      summarizedMessages: rowsToSummarize.length,
      retainedMessages: uncoveredRows.length - rowsToSummarize.length,
      rawMessageCount: rows.length,
      summaryTokenCount: countTokens(finalSummary),
      coveredMessageId: rowsToSummarize.at(-1)?.id ?? created?.to_message_id ?? null,
      kind,
      validation,
    };
  }

  async prepareMessages(input: PrepareMessagesInput): Promise<PreparedContextMessages> {
    const budget = resolveContextWindowBudget({
      provider: input.modelProvider,
      model: input.model,
      taskKind: input.taskKind ?? 'chat',
      thinkingMode: input.thinkingMode,
    });

    const rows = this.loadRows(input);
    const latest = input.threadId ? this.safeLatestCheckpoint(input.threadId) : null;
    let summaryText = latest?.replacement_text ?? '';
    const boundaryIndex = latestBoundaryIndex(rows, latest?.to_message_id);
    let liveRows = boundaryIndex >= 0 ? rows.slice(boundaryIndex + 1) : rows;
    let checkpointCount = latest ? 1 : summaryText ? 1 : 0;
    let compacted = false;

    let projection = this.buildProjection(input, summaryText, latest, liveRows);
    let snapshot = this.createSnapshot(input, budget, rows, projection, checkpointCount);

    if (snapshot.estimatedInputTokens > budget.compressAt && input.threadId) {
      const split = Math.max(0, liveRows.length - DEFAULT_RECENT_KEEP);
      const rowsToSummarize = liveRows.slice(0, split);
      if (rowsToSummarize.length > 0) {
        input.onProgress?.(i18nMessage('contextNearLimitSummarizing', input.language));
        const nextSummary = await this.summarizeRows({
          ...input,
          previousSummary: summaryText || null,
          rows: rowsToSummarize,
        });
        const validation = validateContextSummary(nextSummary, rowsToSummarize);
        summaryText = appendMissingMustKeeps(nextSummary, validation, input.language);
        const created = this.safeCreateCollapse({
          threadId: input.threadId,
          courseId: input.courseId,
          nodeId: input.nodeId ?? null,
          agent: input.agent,
          kind: 'auto',
          fromMessageId: rowsToSummarize[0]?.id ?? null,
          toMessageId: rowsToSummarize.at(-1)?.id ?? null,
          replacementText: summaryText,
          sourceEntryIds: rowsToSummarize.map((row) => row.id),
          tokenBefore: rowsToSummarize.reduce((sum, row) => sum + rowTokenCount(row), 0),
          tokenAfter: countTokens(summaryText),
          validationJson: JSON.stringify(validation),
        });
        liveRows = liveRows.slice(split);
        checkpointCount += 1;
        compacted = true;
        projection = this.buildProjection(input, summaryText, created ?? latest, liveRows);
        snapshot = this.createSnapshot(input, budget, rows, projection, checkpointCount);
      }
    }

    if (snapshot.estimatedInputTokens > budget.collapseAt) {
      input.onProgress?.(i18nMessage('contextNearLimitCompressing', input.language));
      for (const keep of [COLLAPSE_RECENT_KEEP, HARD_RECENT_KEEP, 2, 0]) {
        projection = this.buildProjection(input, summaryText, latest, liveRows.slice(-keep), true);
        snapshot = this.createSnapshot(input, budget, rows, projection, checkpointCount);
        compacted = true;
        if (snapshot.estimatedInputTokens <= budget.inputBudget) break;
      }
    }

    if (snapshot.estimatedInputTokens > budget.inputBudget && input.threadId && liveRows.length > 2) {
      const emergencyRows = liveRows.slice(0, -2);
      const emergencySummary = appendMissingMustKeeps(
        fallbackContinuitySummary(summaryText || null, emergencyRows, input.language),
        validateContextSummary(summaryText, emergencyRows),
        input.language,
      );
      const created = this.safeCreateCollapse({
        threadId: input.threadId,
        courseId: input.courseId,
        nodeId: input.nodeId ?? null,
        agent: input.agent,
        kind: 'emergency',
        fromMessageId: emergencyRows[0]?.id ?? null,
        toMessageId: emergencyRows.at(-1)?.id ?? null,
        replacementText: emergencySummary,
        sourceEntryIds: emergencyRows.map((row) => row.id),
        tokenBefore: emergencyRows.reduce((sum, row) => sum + rowTokenCount(row), 0),
        tokenAfter: countTokens(emergencySummary),
      });
      summaryText = emergencySummary;
      liveRows = liveRows.slice(-2);
      checkpointCount += 1;
      compacted = true;
      projection = this.buildProjection(input, summaryText, created ?? latest, liveRows, true);
      snapshot = this.createSnapshot(input, budget, rows, projection, checkpointCount);
    }

    if (snapshot.estimatedInputTokens > budget.inputBudget) {
      projection = {
        ...projection,
        messages: projection.messages.map((item) => {
          if (item.role === 'user') return { ...item, content: snipMessage(item.content) };
          if (item.role === 'assistant') return { ...item, text: snipMessage(item.text) };
          return {
            role: 'tool_results',
            results: item.results.map((result) => ({ ...result, content: snipMessage(result.content) })),
          };
        }),
      };
      snapshot = this.createSnapshot(input, budget, rows, projection, checkpointCount);
      compacted = true;
    }

    this.recordSnapshot(input, snapshot);
    tokenMeter.recordEstimate({
      sessionId: input.sessionId,
      courseId: input.courseId,
      threadId: input.threadId,
      provider: input.modelProvider,
      model: input.model,
      estimatedInputTokens: snapshot.estimatedInputTokens,
      estimatedOutputTokens: budget.reservedOutputTokens,
      source: 'context_projection',
    });

    return {
      messages: projection.messages,
      estimatedTokens: snapshot.estimatedInputTokens,
      budget,
      compacted,
      snapshot,
    };
  }

  describeThread(input: Omit<PrepareMessagesInput, 'initialMessages' | 'systemPrompt'> & {
    systemPrompt?: string;
    initialMessages?: ToolTurnMessage[];
  }): string {
    const snapshot = this.getSnapshot({
      ...input,
      systemPrompt: input.systemPrompt ?? '',
      initialMessages: input.initialMessages ?? [],
    });
    const pct = Math.round(snapshot.estimatedUsageRatio * 100);
    return [
      '## Context Projection',
      `模型：${snapshot.provider}/${snapshot.model}`,
      `Context window：${snapshot.contextWindow.toLocaleString()} tokens`,
      `投影输入：${snapshot.estimatedInputTokens.toLocaleString()} / ${snapshot.inputBudget.toLocaleString()} input tokens`,
      `总预算占比：${pct}%（风险：${snapshot.riskLevel}）`,
      `原始 transcript：约 ${snapshot.rawTranscriptTokens.toLocaleString()} tokens`,
      `投影后：约 ${snapshot.projectedTokens.toLocaleString()} tokens，节省 ${snapshot.collapseSavings.toLocaleString()} tokens`,
      `checkpoint：${snapshot.checkpointCount} 个；最近完整消息：${snapshot.liveMessageCount} 条；消息级折叠：${snapshot.microCompactedCount} 条`,
    ].join('\n');
  }

  getSnapshot(input: Omit<PrepareMessagesInput, 'initialMessages' | 'systemPrompt'> & {
    systemPrompt?: string;
    initialMessages?: ToolTurnMessage[];
  }): ContextSnapshot {
    const preparedInput: PrepareMessagesInput = {
      ...input,
      systemPrompt: input.systemPrompt ?? '',
      initialMessages: input.initialMessages ?? [],
    };
    const budget = resolveContextWindowBudget({
      provider: input.modelProvider,
      model: input.model,
      taskKind: input.taskKind ?? 'chat',
      thinkingMode: input.thinkingMode,
    });
    const rows = this.loadRows(preparedInput);
    const latest = input.threadId ? this.safeLatestCheckpoint(input.threadId) : null;
    const summaryText = latest?.replacement_text ?? '';
    const boundaryIndex = latestBoundaryIndex(rows, latest?.to_message_id);
    const liveRows = boundaryIndex >= 0 ? rows.slice(boundaryIndex + 1) : rows;
    const projection = this.buildProjection(preparedInput, summaryText, latest, liveRows);
    return this.createSnapshot(preparedInput, budget, rows, projection, latest ? 1 : summaryText ? 1 : 0);
  }

  private loadRows(input: PrepareMessagesInput): ThreadMessageRow[] {
    const visibleRows = (input.visibleMessages ?? []).map(visibleMessageToRow);
    let sourceRows = input.threadId
      ? mergeVisibleRows(this.loadThreadRows(input.threadId), visibleRows)
      : visibleRows.length > 0
        ? visibleRows
        : (input.fallbackMessages ?? []).map((message, index): ThreadMessageRow | null => {
          if (message.role === 'system') return null;
          return {
            id: `fallback-${index}`,
            role: message.role,
            content: message.content,
            progress: null,
            created_at: new Date(index).toISOString(),
            token_count: countTokens(message.content),
          };
        }).filter((row): row is ThreadMessageRow => Boolean(row));
    if (input.currentUserMessage && sameUserMessage(sourceRows.at(-1), input.currentUserMessage)) {
      sourceRows = sourceRows.slice(0, -1);
    }
    return sourceRows.filter((row) => !isContextControlMessage(row));
  }

  private loadThreadRows(threadId: string): ThreadMessageRow[] {
    try {
      return this.threadRepo.listMessages(threadId).filter((row) => !isContextControlMessage(row));
    } catch {
      return [];
    }
  }

  private buildProjection(
    input: PrepareMessagesInput,
    summaryText: string,
    collapse: ChatContextCollapseRecord | null,
    rows: ThreadMessageRow[],
    forceMicro = false,
  ): ProjectionBuildResult {
    const micro = forceMicro
      ? {
          rows: rows.map((row, index) => index < rows.length - 2
            ? { ...row, content: snipMessage(row.content), token_count: countTokens(snipMessage(row.content)) }
            : row),
          count: Math.max(0, rows.length - 2),
        }
      : microCompactRows(rows, input.language);
    return {
      messages: [
        ...input.initialMessages,
        ...this.loadContextEntryTurns(input),
        ...(summaryText.trim() ? compactBoundaryTurn(summaryText, collapse, input.language) : []),
        ...micro.rows.map(rowToToolTurn),
        ...(shouldIncludeCurrentUserTurn(input) ? [{ role: 'user' as const, content: input.currentUserMessage }] : []),
      ],
      projectedRows: micro.rows,
      microCompactedCount: micro.count,
      summaryText,
    };
  }

  private loadContextEntryTurns(input: PrepareMessagesInput): ToolTurnMessage[] {
    const entries = this.safeListContextEntries(input);
    if (entries.length === 0) return [];
    return [{
      role: 'user',
      content: [
        input.language === 'en'
          ? '[Persistent artifact and hidden context entries]'
          : '[持久产物与隐藏上下文条目]',
        ...entries.map(formatContextEntry),
      ].join('\n\n'),
    }];
  }

  private safeListContextEntries(input: PrepareMessagesInput): AgentContextEntryRecord[] {
    try {
      return this.contextEntryRepo.listActive({
        courseId: input.courseId,
        nodeId: input.nodeId ?? null,
        threadId: input.threadId ?? null,
        agent: input.agent,
      });
    } catch {
      return [];
    }
  }

  private createSnapshot(
    input: PrepareMessagesInput,
    budget: ContextWindowBudget,
    rawRows: ThreadMessageRow[],
    projection: ProjectionBuildResult,
    checkpointCount: number,
  ): ContextSnapshot {
    const currentUserTokens = shouldIncludeCurrentUserTurn(input) ? countTokens(input.currentUserMessage) : 0;
    const rawTranscriptTokens = rawRows.reduce((sum, row) => sum + rowTokenCount(row), 0) + currentUserTokens;
    const tokenBeforeProjection = rawTranscriptTokens + countTokens(input.systemPrompt);
    const breakdown = tokenMeter.measureToolMessages({
      provider: input.modelProvider,
      model: input.model,
      messages: projection.messages,
      tools: input.tools,
      systemPrompt: input.systemPrompt,
      budget,
      summaryText: projection.summaryText,
      imageCount: input.imageAttachments?.length ?? 0,
      pdfPageCount: input.pdfAttachments?.length ?? 0,
    });
    return tokenMeter.snapshot({
      provider: input.modelProvider,
      model: input.model,
      budget,
      breakdown,
      liveMessageCount: projection.projectedRows.length,
      checkpointCount,
      rawTranscriptTokens,
      projectedTokens: breakdown.estimatedInputTokens,
      tokenBeforeProjection,
      tokenAfterProjection: breakdown.estimatedInputTokens,
      microCompactedCount: projection.microCompactedCount,
    });
  }

  private async summarizeRows(input: PrepareMessagesInput & {
    previousSummary?: string | null;
    rows: ThreadMessageRow[];
    instruction?: string;
  }): Promise<string> {
    const fallback = fallbackContinuitySummary(input.previousSummary ?? null, input.rows, input.language);
    let response = '';
    let failed = false;
    try {
      await LLMAdapter.stream({
        provider: input.modelProvider,
        model: input.model,
        systemPrompt: continuitySummaryPrompt(input.language),
        messages: [{
          role: 'user',
          content: [
            input.previousSummary ? `Previous compacted state:\n${input.previousSummary}` : '',
            input.instruction ? `User compaction instruction:\n${input.instruction}` : '',
            'Transcript range to fold into the compacted state:',
            formatRows(input.rows),
          ].filter(Boolean).join('\n\n---\n\n'),
        }],
        maxTokens: 1_500,
        temperature: 0.2,
        usageContext: {
          sessionId: input.sessionId,
          courseId: input.courseId,
          threadId: input.threadId,
          source: 'context_compaction',
          recordUsage: false,
        },
        signal: input.signal,
        onChunk: (chunk) => { response += chunk; },
        onComplete: (usage) => { input.onUsage?.(usage); },
        onError: () => { failed = true; },
      });
    } catch {
      failed = true;
    }
    return failed || !response.trim() ? fallback : response.trim();
  }

  private safeLatestCheckpoint(threadId: string): ChatContextCollapseRecord | null {
    try {
      return this.collapseRepo.latestCheckpoint(threadId);
    } catch {
      return null;
    }
  }

  private safeCreateCollapse(input: Parameters<ChatContextCollapseRepository['create']>[0]): ChatContextCollapseRecord | null {
    try {
      return this.collapseRepo.create(input);
    } catch {
      return null;
    }
  }

  private recordSnapshot(input: PrepareMessagesInput, snapshot: ContextSnapshot): void {
    this.collapseRepo.recordSnapshot({
      threadId: input.threadId ?? null,
      courseId: input.courseId,
      nodeId: input.nodeId ?? null,
      agent: input.agent,
      provider: input.modelProvider,
      model: input.model,
      taskKind: input.taskKind ?? 'chat',
      contextWindow: snapshot.contextWindow,
      maxOutputTokens: snapshot.maxOutputTokens,
      inputBudget: snapshot.inputBudget,
      estimatedInputTokens: snapshot.estimatedInputTokens,
      estimatedTotalTokens: snapshot.estimatedTotalTokens,
      rawTranscriptTokens: snapshot.rawTranscriptTokens,
      projectedTokens: snapshot.projectedTokens,
      tokenBeforeProjection: snapshot.tokenBeforeProjection,
      tokenAfterProjection: snapshot.tokenAfterProjection,
      collapseSavings: snapshot.collapseSavings,
      riskLevel: snapshot.riskLevel,
      liveMessageCount: snapshot.liveMessageCount,
      checkpointCount: snapshot.checkpointCount,
      summaryTokens: snapshot.summaryTokens,
      microCompactedCount: snapshot.microCompactedCount,
    });
  }
}
