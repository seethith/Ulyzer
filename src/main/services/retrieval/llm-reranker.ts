import { createHash, randomUUID } from 'crypto';
import type { ResearchTaskType, SourceRecord, TokenUsage } from '@shared/types';
import { LLMAdapter } from '../llm/adapter';
import { getDb } from '../db/sqlite';
import type { RetrievalCandidate } from './types';

interface RerankInput {
  query: string;
  taskType: ResearchTaskType;
  candidates: RetrievalCandidate[];
  sources: Map<string, SourceRecord>;
  limit: number;
  provider: string;
  model: string;
  signal?: AbortSignal;
  onUsage?: (usage: TokenUsage) => void;
}

interface CacheRow {
  chunk_id: string;
  relevance: number;
  reason: string | null;
}

function queryHash(query: string): string {
  return createHash('sha256').update(query.trim().toLowerCase()).digest('hex');
}

function readCache(input: RerankInput, hash: string): Map<string, CacheRow> {
  if (input.candidates.length === 0) return new Map();
  const ids = input.candidates.map((candidate) => candidate.chunkId);
  const placeholders = ids.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT chunk_id, relevance, reason
       FROM source_rerank_cache
       WHERE query_hash = ?
         AND task_type = ?
         AND provider = ?
         AND model = ?
         AND chunk_id IN (${placeholders})`,
    )
    .all(hash, input.taskType, input.provider, input.model, ...ids) as CacheRow[];
  return new Map(rows.map((row) => [row.chunk_id, row]));
}

function writeCache(input: RerankInput, hash: string, rows: Array<{ chunkId: string; relevance: number; reason?: string }>): void {
  if (rows.length === 0) return;
  const sourceByChunk = new Map(input.candidates.map((candidate) => [candidate.chunkId, candidate.sourceId]));
  const stmt = getDb().prepare(
    `INSERT INTO source_rerank_cache (
       id, query_hash, chunk_id, source_id, task_type, provider, model, relevance, reason
     ) VALUES (
       @id, @query_hash, @chunk_id, @source_id, @task_type, @provider, @model, @relevance, @reason
     )
     ON CONFLICT(query_hash, chunk_id, task_type, provider, model) DO UPDATE SET
       relevance = excluded.relevance,
       reason = excluded.reason,
       created_at = datetime('now')`,
  );
  getDb().transaction(() => {
    for (const row of rows) {
      const sourceId = sourceByChunk.get(row.chunkId);
      if (!sourceId) continue;
      stmt.run({
        id: randomUUID(),
        query_hash: hash,
        chunk_id: row.chunkId,
        source_id: sourceId,
        task_type: input.taskType,
        provider: input.provider,
        model: input.model,
        relevance: Math.max(0, Math.min(4, row.relevance)),
        reason: row.reason?.slice(0, 180) ?? null,
      });
    }
  })();
}

function formatCandidates(input: RerankInput, candidates: RetrievalCandidate[]): string {
  return candidates.map((candidate, index) => {
    const source = input.sources.get(candidate.sourceId);
    return [
      `[${index + 1}] chunk_id=${candidate.chunkId}`,
      `资料：${source?.title ?? candidate.sourceId}`,
      `来源层级：${source?.origin ?? 'unknown'}；可信度：${source?.trustScore ?? 0.5}`,
      `定位：${candidate.locator ?? ''}${candidate.page ? ` p.${candidate.page}` : ''}`,
      `片段：${candidate.text.slice(0, 520)}`,
    ].join('\n');
  }).join('\n\n');
}

function parseScores(raw: string): Array<{ chunkId: string; relevance: number; reason?: string }> {
  const first = raw.indexOf('[');
  const last = raw.lastIndexOf(']');
  const json = first >= 0 && last > first ? raw.slice(first, last + 1) : raw;
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => {
    const obj = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {};
    return {
      chunkId: typeof obj.chunk_id === 'string' ? obj.chunk_id : '',
      relevance: typeof obj.relevance === 'number' ? obj.relevance : 0,
      reason: typeof obj.reason === 'string' ? obj.reason : undefined,
    };
  }).filter((item) => item.chunkId);
}

async function scoreWithLlm(input: RerankInput, candidates: RetrievalCandidate[]): Promise<Array<{ chunkId: string; relevance: number; reason?: string }>> {
  let raw = '';
  await LLMAdapter.stream({
    provider: input.provider,
    model: input.model,
    systemPrompt: '你是参考资料检索 reranker。只输出合法 JSON 数组，不输出 Markdown。',
    messages: [{
      role: 'user',
      content:
        `用户问题：${input.query}\n任务类型：${input.taskType}\n\n` +
        `请判断每个片段是否能直接帮助回答问题。relevance 取 0-4：0无关，1弱相关，2可参考，3相关，4强相关。\n` +
        `只输出数组，每项为 {"chunk_id":"...","relevance":0-4,"reason":"不超过20字"}。\n\n` +
        formatCandidates(input, candidates),
    }],
    maxTokens: Math.min(1600, Math.max(500, candidates.length * 70)),
    temperature: 0,
    jsonMode: true,
    signal: input.signal,
    onChunk: (chunk) => { raw += chunk; },
    onComplete: (usage) => { input.onUsage?.(usage); },
    onError: () => {},
  });
  return parseScores(raw);
}

export async function rerankWithLlm(input: RerankInput): Promise<RetrievalCandidate[]> {
  if (!input.provider || !input.model || input.candidates.length <= input.limit) {
    return input.candidates.slice(0, input.limit);
  }
  const hash = queryHash(input.query);
  const cache = readCache(input, hash);
  const missing = input.candidates.filter((candidate) => !cache.has(candidate.chunkId)).slice(0, 32);

  if (missing.length > 0) {
    try {
      const scores = await scoreWithLlm(input, missing);
      writeCache(input, hash, scores);
      for (const score of scores) {
        cache.set(score.chunkId, {
          chunk_id: score.chunkId,
          relevance: score.relevance,
          reason: score.reason ?? null,
        });
      }
    } catch {
      return input.candidates.slice(0, input.limit);
    }
  }

  return input.candidates
    .map((candidate) => {
      const cached = cache.get(candidate.chunkId);
      if (!cached) return candidate;
      const llmBonus = cached.relevance / 4;
      return {
        ...candidate,
        rerankScore: (candidate.rerankScore ?? 0) + llmBonus,
        finalScore: candidate.finalScore * 0.55 + llmBonus * 0.45,
      };
    })
    .filter((candidate) => {
      const cached = cache.get(candidate.chunkId);
      return !cached || cached.relevance >= 1.5;
    })
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, input.limit);
}
