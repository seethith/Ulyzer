import { createHash } from 'crypto';
import { randomUUID } from 'crypto';
import type {
  AgentType,
  Difficulty,
  SourceExercise,
  SourceExerciseExtractionResult,
  SourceExerciseListRequest,
  SourceExerciseLicenseStatus,
  SourceExerciseStatus,
  SourceKind,
  SourceScope,
} from '@shared/types';
import { getDb } from '../db/sqlite';

interface SourceExerciseRow {
  id: string;
  source_id: string;
  course_id: string;
  node_id: string | null;
  source_title?: string | null;
  source_url?: string | null;
  source_kind?: string | null;
  item_type: string;
  difficulty: string;
  cognitive_action: string;
  stem_md: string;
  choices_json: string;
  answer_md: string | null;
  solution_md: string | null;
  hints_json: string;
  kc_tags_json: string;
  source_locator: string | null;
  source_page: number | null;
  license_status: string;
  quality_score: number;
  extraction_confidence: number;
  duplicate_hash: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface SourceContextRow {
  id: string;
  course_id: string;
  node_id: string | null;
  title: string;
  kind: string;
  origin: string | null;
  url: string | null;
  file_path: string | null;
  host: string | null;
}

interface SourceTextBlock {
  text: string;
  locator: string | null;
  page: number | null;
}

export interface ExtractedExerciseCandidate {
  stemMd: string;
  choices: string[];
  answerMd: string | null;
  solutionMd: string | null;
  hints: string[];
  kcTags: string[];
  sourceLocator: string | null;
  sourcePage: number | null;
  itemType: string;
  difficulty: Difficulty | 'unknown';
  cognitiveAction: string;
  qualityScore: number;
  extractionConfidence: number;
}

const EXERCISE_START_RE =
  /^\s*(?:#{1,6}\s*)?(?:(?:Q|Question|Problem|Exercise|Example)\s*\d+[A-Za-z]?\s*(?:[:：.)、-]|$)|(?:练习|习题|题目|例题|案例题|思考题)\s*[一二三四五六七八九十百\d]*(?:[-—][一二三四五六七八九十百\d]+)?\s*(?:[:：.)、-]|$)|问题\s*[一二三四五六七八九十百\d]*(?:[-—][一二三四五六七八九十百\d]+)?\s*(?:[:：?？]|$)|作业\s*(?:[一二三四五六七八九十百\d]+|题|任务|练习)\s*(?:[:：.)、-]|$)|(?:\d{1,2}|[一二三四五六七八九十])[.)、)]\s*(?:计算|证明|判断|求|分析|解释|设计|写出|比较|讨论|完成|实现|选择|设|已知|给定|请|试|根据|Consider|Compute|Prove|Show|Find|Explain|Design|Let))/i;

const ANSWER_MARK_RE = /^\s*(?:#{1,6}\s*)?(?:参考答案|答案|解析|解答|提示|Answer|Solution|Hint)\s*[:：]?\s*/im;
const CHOICE_RE = /^\s*(?:[-*]\s*)?([A-D])[.)、)]\s+(.+)$/i;
const KC_RE = /\bKC\s*\d+[^，。；;\n)]*/gi;
const RISKY_HOST_RE = /(?:doc88|docin|wenku|scribd|coursehero|chegg|studocu|testbank|答案|题库答案)/i;
const TASK_ACTION_RE =
  /(?:请|试|根据|给定|设|已知|判断|选择|计算|求|证明|解释|分析|比较|设计|写出|完成|实现|讨论|指出|描述|评价|推导|列出|说明|回答|解答|求解|改写|诊断|纠正|复盘|Consider|Compute|Prove|Show|Find|Explain|Design|Let|Solve|Calculate|Evaluate|Analyze|Compare|Discuss|Describe|Implement|Write)/i;
const QUESTION_CUE_RE = /(?:[?？]|如何|为什么|什么是|是否|哪[个些]|How|Why|What|Which|Whether)/i;
const NON_EXERCISE_STRONG_RE =
  /(?:评分标准|评价标准|评分细则|评分规则|评分表|作业评分|成绩评定|成绩构成|课程考核|考核内容|考核方式|教学大纲|教学计划|课程目标|教学目标|支撑课程目标|毕业要求|达成度|考核分值)/i;
const NON_EXERCISE_TERM_RE =
  /(?:提交时间|按时提交|延时半天|延时一天|规范性|整洁|美观|正确率|权重|出勤率|课堂表现|期末考试|平时成绩|考查方式|考试方式|考核项目|教学内容|授课内容|学时|先修课程|课程性质|教材|参考书目|课程简介)/gi;
const SCORE_BAND_RE =
  /(?:\d{1,3}\s*[-~－—]\s*\d{1,3}\s*分|[ABCD][+-]?\s*[-—]\s*\d{1,3}|[<>≥≤]\s*\d{1,3}\s*%|\d{1,3}\s*%|权重\s*0?\.\d|\d+\s*学时)/i;

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function toExercise(row: SourceExerciseRow): SourceExercise {
  return {
    id: row.id,
    sourceId: row.source_id,
    courseId: row.course_id,
    nodeId: row.node_id,
    sourceTitle: row.source_title ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    sourceKind: row.source_kind as SourceKind | undefined,
    itemType: row.item_type,
    difficulty: row.difficulty as Difficulty | 'unknown',
    cognitiveAction: row.cognitive_action,
    stemMd: row.stem_md,
    choices: parseJsonArray(row.choices_json),
    answerMd: row.answer_md,
    solutionMd: row.solution_md,
    hints: parseJsonArray(row.hints_json),
    kcTags: parseJsonArray(row.kc_tags_json),
    sourceLocator: row.source_locator,
    sourcePage: row.source_page,
    licenseStatus: row.license_status as SourceExerciseLicenseStatus,
    qualityScore: row.quality_score,
    extractionConfidence: row.extraction_confidence,
    duplicateHash: row.duplicate_hash,
    status: row.status as SourceExerciseStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function compactText(value: string): string {
  return value.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

function countMatches(value: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  const matches = value.match(pattern);
  return matches?.length ?? 0;
}

function isLikelyRubricOrSyllabus(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const rubricTermCount = countMatches(normalized, NON_EXERCISE_TERM_RE);
  const hasStrongMarker = NON_EXERCISE_STRONG_RE.test(normalized);
  const hasScoreBand = SCORE_BAND_RE.test(normalized);
  const hasTaskAction = TASK_ACTION_RE.test(normalized) || QUESTION_CUE_RE.test(normalized);
  const shortLabelLines = text
    .split('\n')
    .filter((line) => /^(?:\s*)(?:提交时间|规范性|正确率|权重|成绩|考核|课堂表现|出勤率|作业|期末|课程目标|教学目标)/.test(line))
    .length;

  if (hasStrongMarker && (hasScoreBand || rubricTermCount >= 2 || shortLabelLines >= 2)) return true;
  if (rubricTermCount >= 4 && (hasScoreBand || !hasTaskAction)) return true;
  if (shortLabelLines >= 3 && hasScoreBand) return true;
  return false;
}

function hasExerciseTaskShape(stem: string, choices: string[]): boolean {
  const head = stem.split('\n').slice(0, 8).join(' ');
  if (TASK_ACTION_RE.test(head) || QUESTION_CUE_RE.test(head)) return true;
  if (choices.length >= 2 && (TASK_ACTION_RE.test(stem) || QUESTION_CUE_RE.test(stem))) return true;
  return false;
}

function stableHash(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex').slice(0, 32);
}

function classifyItemType(text: string, choices: string[]): string {
  if (choices.length >= 2) return 'multiple_choice';
  if (/证明|prove|show that/i.test(text)) return 'proof';
  if (/代码|程序|实现|debug|Python|JavaScript|SQL|函数|test case/i.test(text)) return 'coding';
  if (/实验|lab|操作|拍摄|练习动作|drill|训练/i.test(text)) return 'lab';
  if (/案例|情境|场景|case|scenario/i.test(text)) return 'case_analysis';
  if (/判断|true or false|是否|对错/i.test(text)) return 'judgement';
  if (/计算|求|compute|calculate|evaluate/i.test(text)) return 'calculation';
  return 'short_answer';
}

function classifyDifficulty(text: string): Difficulty | 'unknown' {
  if (/证明|综合|迁移|项目|设计|创造|反例|开放|derive|prove|project|synthesis/i.test(text)) return 'advanced';
  if (/分析|解释|比较|诊断|应用|实现|calculate|compute|analyze|debug/i.test(text)) return 'intermediate';
  if (/判断|选择|定义|写出|识别|概念|choose|identify|define/i.test(text)) return 'beginner';
  return 'unknown';
}

function classifyCognitiveAction(text: string): string {
  if (/设计|创建|提出|project|create|design/i.test(text)) return 'create';
  if (/评估|判断优劣|选择策略|validate|evaluate/i.test(text)) return 'evaluate';
  if (/分析|诊断|比较|为什么|反例|analyze|debug|compare/i.test(text)) return 'analyze';
  if (/计算|求|应用|实现|apply|compute|calculate|solve/i.test(text)) return 'apply';
  return 'understand';
}

function extractChoices(stem: string): string[] {
  return stem
    .split('\n')
    .map((line) => line.match(CHOICE_RE))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => `${match[1].toUpperCase()}. ${match[2].trim()}`);
}

function splitAnswer(segment: string): { stem: string; answer: string | null; solution: string | null; hints: string[] } {
  const match = segment.match(ANSWER_MARK_RE);
  if (!match || match.index === undefined) return { stem: segment, answer: null, solution: null, hints: [] };
  const stem = segment.slice(0, match.index);
  const tail = segment.slice(match.index + match[0].length).trim();
  const paragraphs = tail.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const answer = paragraphs[0] ?? tail.slice(0, 600);
  const solution = paragraphs.length > 1 ? paragraphs.join('\n\n') : tail.length > answer.length + 40 ? tail : null;
  const hints = /提示|Hint/i.test(match[0]) && answer ? [answer] : [];
  return { stem, answer, solution, hints };
}

function qualityFor(input: {
  stem: string;
  answer: string | null;
  solution: string | null;
  choices: string[];
  licenseStatus: SourceExerciseLicenseStatus;
  sourceLocator?: string | null;
}): { score: number; confidence: number; status: SourceExerciseStatus } {
  const stemLength = input.stem.length;
  let score = 0.35;
  if (stemLength >= 40) score += 0.12;
  if (stemLength >= 120) score += 0.08;
  if (stemLength <= 1800) score += 0.06;
  if (input.choices.length >= 2) score += 0.08;
  if (input.answer) score += 0.18;
  if (input.solution) score += 0.12;
  if (input.sourceLocator) score += 0.06;
  if (input.licenseStatus === 'open' || input.licenseStatus === 'user_import') score += 0.05;
  if (input.licenseStatus === 'risky') score -= 0.35;
  if (stemLength < 30 || stemLength > 3500) score -= 0.2;
  score = Math.max(0, Math.min(1, Number(score.toFixed(2))));
  const confidence = Math.max(0.2, Math.min(0.95, Number((score - (input.answer ? 0 : 0.05)).toFixed(2))));
  const status: SourceExerciseStatus = input.licenseStatus === 'risky' || score < 0.42
    ? 'needs_review'
    : 'usable';
  return { score, confidence, status };
}

function licenseStatusFor(source: SourceContextRow): SourceExerciseLicenseStatus {
  const text = `${source.host ?? ''} ${source.url ?? ''} ${source.file_path ?? ''} ${source.title}`;
  if (RISKY_HOST_RE.test(text)) return 'risky';
  if (source.origin === 'user_import' || source.origin === 'chat_attachment') return 'user_import';
  if (/\b(?:openstax|ocw\.mit\.edu|khanacademy|libretexts|github|readthedocs|docs\.python|developer\.mozilla|wikipedia|wikibooks)\b/i.test(text)) return 'open';
  return 'unknown';
}

function candidateSegments(block: SourceTextBlock): string[] {
  const lines = block.text.split('\n');
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (EXERCISE_START_RE.test(line)) starts.push(index);
  });
  if (starts.length === 0) return [];
  const segments: string[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const next = starts[i + 1] ?? Math.min(lines.length, start + 90);
    const segment = compactText(lines.slice(start, next).join('\n'));
    if (segment.length >= 30) segments.push(segment.slice(0, 4200));
  }
  return segments;
}

export function extractExerciseCandidatesFromText(
  text: string,
  options: {
    sourceLocator?: string | null;
    sourcePage?: number | null;
    licenseStatus?: SourceExerciseLicenseStatus;
  } = {},
): ExtractedExerciseCandidate[] {
  const sourceBlock: SourceTextBlock = {
    text: compactText(text),
    locator: options.sourceLocator ?? null,
    page: options.sourcePage ?? null,
  };
  const licenseStatus = options.licenseStatus ?? 'unknown';
  const out: ExtractedExerciseCandidate[] = [];
  const seen = new Set<string>();
  for (const segment of candidateSegments(sourceBlock)) {
    const split = splitAnswer(segment);
    const stem = compactText(split.stem);
    if (stem.length < 30) continue;
    const choices = extractChoices(stem);
    if (isLikelyRubricOrSyllabus(stem)) continue;
    if (!hasExerciseTaskShape(stem, choices)) continue;
    const quality = qualityFor({
      stem,
      answer: split.answer,
      solution: split.solution,
      choices,
      licenseStatus,
      sourceLocator: sourceBlock.locator,
    });
    const hash = stableHash(stem.replace(/\s+/g, ' '));
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push({
      stemMd: stem,
      choices,
      answerMd: split.answer,
      solutionMd: split.solution,
      hints: split.hints,
      kcTags: [...new Set(stem.match(KC_RE)?.map((tag) => tag.replace(/\s+/g, '').trim()) ?? [])],
      sourceLocator: sourceBlock.locator,
      sourcePage: sourceBlock.page,
      itemType: classifyItemType(stem, choices),
      difficulty: classifyDifficulty(stem),
      cognitiveAction: classifyCognitiveAction(stem),
      qualityScore: quality.score,
      extractionConfidence: quality.confidence,
    });
  }
  return out.slice(0, 80);
}

function sourceBlocks(sourceId: string): SourceTextBlock[] {
  const blocks = getDb()
    .prepare<[string], { text: string; locator: string | null; page_number: number | null }>(
      `SELECT text, locator, page_number
       FROM source_document_blocks
       WHERE source_id = ?
       ORDER BY COALESCE(page_number, 0), block_index ASC`,
    )
    .all(sourceId);
  if (blocks.length > 0) {
    return blocks.map((row) => ({
      text: row.text,
      locator: row.locator,
      page: row.page_number,
    }));
  }
  return getDb()
    .prepare<[string], { content: string; locator: string | null; page: number | null }>(
      `SELECT content, locator, page
       FROM source_chunks
       WHERE source_id = ?
       ORDER BY chunk_index ASC`,
    )
    .all(sourceId)
    .map((row) => ({ text: row.content, locator: row.locator, page: row.page }));
}

function sourceContext(sourceId: string): SourceContextRow | null {
  return getDb()
    .prepare<[string], SourceContextRow>(
      `SELECT id, course_id, node_id, title, kind, origin, url, file_path, host
       FROM source_records
       WHERE id = ?`,
    )
    .get(sourceId) ?? null;
}

export function extractExercisesForSource(input: {
  sourceId: string;
  force?: boolean;
}): SourceExerciseExtractionResult {
  const source = sourceContext(input.sourceId);
  if (!source) throw new Error(`Source not found: ${input.sourceId}`);
  const licenseStatus = licenseStatusFor(source);
  const blocks = sourceBlocks(input.sourceId);
  const candidates = blocks.flatMap((block) =>
    extractExerciseCandidatesFromText(block.text, {
      sourceLocator: block.locator,
      sourcePage: block.page,
      licenseStatus,
    }),
  );
  const db = getDb();
  const deleteIds = db
    .prepare<[string], { id: string }>('SELECT id FROM source_exercises WHERE source_id = ?')
    .all(input.sourceId)
    .map((row) => row.id);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO source_exercises (
       id, source_id, course_id, node_id, item_type, difficulty, cognitive_action,
       stem_md, choices_json, answer_md, solution_md, hints_json, kc_tags_json,
       source_locator, source_page, license_status, quality_score, extraction_confidence,
       duplicate_hash, status, updated_at
     ) VALUES (
       @id, @source_id, @course_id, @node_id, @item_type, @difficulty, @cognitive_action,
       @stem_md, @choices_json, @answer_md, @solution_md, @hints_json, @kc_tags_json,
       @source_locator, @source_page, @license_status, @quality_score, @extraction_confidence,
       @duplicate_hash, @status, datetime('now')
     )`,
  );
  const insertFts = db.prepare(
    `INSERT INTO source_exercises_fts (stem, answer, solution, exercise_id, source_id, course_id, node_id)
     VALUES (@stem, @answer, @solution, @exercise_id, @source_id, @course_id, @node_id)`,
  );
  db.transaction(() => {
    if (deleteIds.length > 0) {
      const placeholders = deleteIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM source_exercises_fts WHERE exercise_id IN (${placeholders})`).run(...deleteIds);
      db.prepare(`DELETE FROM source_exercises WHERE id IN (${placeholders})`).run(...deleteIds);
    }
    for (const candidate of candidates) {
      const status = qualityFor({
        stem: candidate.stemMd,
        answer: candidate.answerMd,
        solution: candidate.solutionMd,
        choices: candidate.choices,
        licenseStatus,
        sourceLocator: candidate.sourceLocator,
      }).status;
      const id = randomUUID();
      const duplicateHash = stableHash(candidate.stemMd.replace(/\s+/g, ' '));
      insert.run({
        id,
        source_id: source.id,
        course_id: source.course_id,
        node_id: source.node_id,
        item_type: candidate.itemType,
        difficulty: candidate.difficulty,
        cognitive_action: candidate.cognitiveAction,
        stem_md: candidate.stemMd,
        choices_json: JSON.stringify(candidate.choices),
        answer_md: candidate.answerMd,
        solution_md: candidate.solutionMd,
        hints_json: JSON.stringify(candidate.hints),
        kc_tags_json: JSON.stringify(candidate.kcTags),
        source_locator: candidate.sourceLocator,
        source_page: candidate.sourcePage,
        license_status: licenseStatus,
        quality_score: candidate.qualityScore,
        extraction_confidence: candidate.extractionConfidence,
        duplicate_hash: duplicateHash,
        status,
      });
      insertFts.run({
        stem: candidate.stemMd,
        answer: candidate.answerMd ?? '',
        solution: candidate.solutionMd ?? '',
        exercise_id: id,
        source_id: source.id,
        course_id: source.course_id,
        node_id: source.node_id,
      });
    }
  })();
  const rows = getDb()
    .prepare<[string], { count: number; usable: number; with_answer: number; with_solution: number }>(
      `SELECT
         COUNT(*) AS count,
         SUM(CASE WHEN status = 'usable' THEN 1 ELSE 0 END) AS usable,
         SUM(CASE WHEN answer_md IS NOT NULL AND length(answer_md) > 0 THEN 1 ELSE 0 END) AS with_answer,
         SUM(CASE WHEN solution_md IS NOT NULL AND length(solution_md) > 0 THEN 1 ELSE 0 END) AS with_solution
       FROM source_exercises
       WHERE source_id = ?`,
    )
    .get(input.sourceId);
  return {
    sourceId: input.sourceId,
    extracted: rows?.count ?? 0,
    usable: rows?.usable ?? 0,
    withAnswer: rows?.with_answer ?? 0,
    withSolution: rows?.with_solution ?? 0,
  };
}

function scopeClause(input: { agentType: AgentType; nodeId?: string; scope?: SourceScope }): { where: string; params: unknown[] } {
  if (input.agentType === 'main_tutor' || !input.nodeId) {
    return { where: `sr.scope = 'main_private'`, params: [] };
  }
  if (input.scope === 'main_private') return { where: `sr.scope = 'main_private'`, params: [] };
  return {
    where: `(
      (sr.scope = 'node_private' AND sr.node_id = ?)
      OR (
        sr.scope = 'main_private'
        AND EXISTS (
          SELECT 1 FROM node_source_links nsl
          WHERE nsl.source_id = sr.id
            AND nsl.course_id = sr.course_id
            AND nsl.node_id = ?
            AND nsl.enabled = 1
        )
      )
    )`,
    params: [input.nodeId, input.nodeId],
  };
}

function queryClause(query?: string): { where: string; params: unknown[] } {
  const trimmed = query?.trim();
  if (!trimmed) return { where: '', params: [] };
  const tokens = trimmed.split(/\s+/).filter(Boolean).slice(0, 6);
  if (tokens.length === 0) return { where: '', params: [] };
  const clauses = tokens.map(() => `(LOWER(se.stem_md) LIKE ? OR LOWER(COALESCE(se.solution_md, '')) LIKE ? OR LOWER(sr.title) LIKE ?)`);
  const params = tokens.flatMap((token) => {
    const like = `%${token.toLowerCase()}%`;
    return [like, like, like];
  });
  return { where: `AND ${clauses.join(' AND ')}`, params };
}

export function listSourceExercises(input: SourceExerciseListRequest): SourceExercise[] {
  const limit = Math.max(1, Math.min(input.limit ?? 80, 300));
  const scope = scopeClause(input);
  const query = queryClause(input.query);
  const params: unknown[] = [input.courseId, ...scope.params];
  let filters = '';
  if (input.sourceId) {
    filters += ' AND se.source_id = ?';
    params.push(input.sourceId);
  }
  if (input.onlyUsable) filters += ` AND se.status = 'usable'`;
  if (input.requireAnswer) filters += ` AND se.answer_md IS NOT NULL AND length(se.answer_md) > 0`;
  if (input.itemType) {
    filters += ' AND se.item_type = ?';
    params.push(input.itemType);
  }
  if (input.difficulty) {
    filters += ' AND se.difficulty = ?';
    params.push(input.difficulty);
  }
  if (input.status) {
    filters += ' AND se.status = ?';
    params.push(input.status);
  }
  params.push(...query.params, limit);
  const rows = getDb()
    .prepare(
      `SELECT se.*, sr.title AS source_title, sr.url AS source_url, sr.kind AS source_kind
       FROM source_exercises se
       JOIN source_records sr ON sr.id = se.source_id
       WHERE se.course_id = ?
         AND sr.enabled = 1
         AND ${scope.where}
         ${filters}
         ${query.where}
       ORDER BY
         CASE se.status WHEN 'usable' THEN 0 WHEN 'needs_review' THEN 1 ELSE 2 END,
         se.quality_score DESC,
         se.updated_at DESC
       LIMIT ?`,
    )
    .all(...params) as SourceExerciseRow[];
  return rows.map(toExercise);
}

export function updateSourceExerciseStatus(input: { exerciseId: string; status: SourceExerciseStatus }): SourceExercise | null {
  getDb()
    .prepare<[SourceExerciseStatus, string]>(
      `UPDATE source_exercises
       SET status = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(input.status, input.exerciseId);
  const row = getDb()
    .prepare<[string], SourceExerciseRow>(
      `SELECT se.*, sr.title AS source_title, sr.url AS source_url, sr.kind AS source_kind
       FROM source_exercises se
       JOIN source_records sr ON sr.id = se.source_id
       WHERE se.id = ?`,
    )
    .get(input.exerciseId);
  return row ? toExercise(row) : null;
}

export function retrieveSourceExercises(input: {
  courseId: string;
  nodeId?: string;
  agentType?: AgentType;
  scope?: SourceScope;
  query: string;
  limit?: number;
  requireAnswer?: boolean;
}): SourceExercise[] {
  return listSourceExercises({
    courseId: input.courseId,
    nodeId: input.nodeId,
    agentType: input.agentType ?? 'sub_tutor',
    scope: input.scope,
    query: input.query,
    onlyUsable: true,
    requireAnswer: input.requireAnswer,
    limit: input.limit ?? 8,
  });
}

export function formatSourceExerciseEvidenceBrief(exercises: SourceExercise[], language?: string): string {
  const isEn = language === 'en';
  if (exercises.length === 0) {
    return isEn ? 'No structured exercise assets found.' : '未检索到结构化题目资产。';
  }
  return exercises.slice(0, 5).map((exercise, index) => {
    const label = `E${index + 1}`;
    const source = exercise.sourceTitle ?? exercise.sourceUrl ?? exercise.sourceId;
    const locator = exercise.sourceLocator ? ` @ ${exercise.sourceLocator}` : exercise.sourcePage ? ` @ p.${exercise.sourcePage}` : '';
    const answerState = exercise.answerMd ? (isEn ? 'answer yes' : '有答案') : (isEn ? 'answer no' : '无答案');
    const solutionState = exercise.solutionMd ? (isEn ? 'solution yes' : '有解析') : (isEn ? 'solution no' : '无解析');
    const stem = exercise.stemMd.replace(/\n{2,}/g, '\n').slice(0, 420);
    return `${label}. [${exercise.itemType}/${exercise.difficulty}/${exercise.licenseStatus}] ${source}${locator}\n` +
      `${isEn ? 'Status' : '状态'}: ${answerState}, ${solutionState}, quality ${exercise.qualityScore.toFixed(2)}\n` +
      `${isEn ? 'Stem' : '题干'}:\n${stem}`;
  }).join('\n\n');
}
