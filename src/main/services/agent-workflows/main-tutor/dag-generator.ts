import { IPC } from '@shared/ipc-channels';
import type { Course, SearchMode, TokenUsage } from '@shared/types';
import type { LLMUsageContext } from '../../llm/adapter';
import { streamStructuredCompletion } from '../../llm/structured-stream';
import type { AgentRequest } from '../../agent-core/orchestrator';
import type { AgentRunContext } from '../../agent-core/run-context';
import { AgentContextEntryRepository } from '../../db/repositories/agent-context-entry.repo';
import { abortError, normalizeAgentError } from '../../agent-core/agent-errors';
import type { WorkflowLifecycle, WorkflowPhase } from '../workflow-lifecycle';
import { buildDagGenerationContext } from '../../agent-context/context-builder';
import { localMsg } from '../../agent-i18n/messages';
import { resolveModelCapability } from '../../llm/model-capabilities';
import { ChapterScopeGenerator } from './chapter-scope';
import { DagPersistence } from './dag-persistence';
import { parseDagJson } from './dag-json';
import { computeNodeTarget } from './node-target';
import { DagPromptBuilder } from './prompts';
import { collectRouteEvidence } from './route-evidence';
import { resolveRoadmapSearchMode } from './roadmap-intent';
import { safeSend } from './events';
import type { DagGenerationResult, DagRepairReport } from './types';

const ROADMAP_TARGET_OUTPUT_TOKENS = 100_000;
const ROADMAP_MIN_OUTPUT_TOKENS = 16_000;
const contextEntryRepo = new AgentContextEntryRepository();

export interface CourseProfileRepositoryPort {
  findById(id: string): Course | null;
  updateProfile(id: string, data: {
    goal_text?: string | null;
    known_topics?: string | null;
    time_budget?: string | null;
    depth_preference?: string | null;
  }): void;
}

export interface DagGeneratorDeps {
  courseRepo: CourseProfileRepositoryPort;
  persistence: DagPersistence;
  promptBuilder?: DagPromptBuilder;
  chapterScopeGenerator?: ChapterScopeGenerator;
}

export class DagGenerator {
  private readonly promptBuilder: DagPromptBuilder;
  private readonly chapterScopeGenerator: ChapterScopeGenerator;

  constructor(private readonly deps: DagGeneratorDeps) {
    this.promptBuilder = deps.promptBuilder ?? new DagPromptBuilder();
    this.chapterScopeGenerator = deps.chapterScopeGenerator ?? new ChapterScopeGenerator();
  }

  /** Sends progress + DAG_GENERATED to sender. Returns result on success, throws on error. Does not send STREAM_END. */
  async generate(
    req: AgentRequest,
    sender: Electron.WebContents,
    topicOverride?: string,
    context?: AgentRunContext,
    lifecycle?: WorkflowLifecycle,
  ): Promise<DagGenerationResult> {
    const accUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, costCny: 0 };
    const topic = topicOverride ?? req.userMessage;

    const progress = (chunk: string) => {
      if (lifecycle) {
        lifecycle.progress(chunk);
        return;
      }
      if (context) {
        context.progress(chunk);
        return;
      }
      safeSend(sender, IPC.LLM_STREAM_CHUNK, { sessionId: req.sessionId, chunk, isProgress: true });
    };
    const thinking = (chunk: string) => {
      if (context) {
        context.thinking(chunk);
        return;
      }
      safeSend(sender, IPC.LLM_STREAM_CHUNK, { sessionId: req.sessionId, chunk, isThinking: true });
    };
    // Clean user-facing phase hint (separate from the dev diagnostics trace).
    const userPhase = (label: string) => context?.phase(label);
    const startPhase = (phase: WorkflowPhase) => lifecycle?.start(phase);
    const completePhase = (phase: WorkflowPhase, artifactIds: string[] = []) => lifecycle?.complete(phase, artifactIds);
    const failPhase = (error: unknown) => lifecycle?.fail(error);
    const usageContext = (source: string): LLMUsageContext => ({
      sessionId: req.sessionId,
      courseId: req.courseId,
      threadId: req.threadId,
      source,
      recordUsage: false,
    });
    const recordUsage = (usage: TokenUsage, source: string) => {
      accUsage.inputTokens += usage.inputTokens;
      accUsage.outputTokens += usage.outputTokens;
      accUsage.costCny += usage.costCny;
      if (lifecycle) lifecycle.addUsage(usage, source);
      else context?.addUsage(usage, source);
    };

    startPhase('prepare_context');
    userPhase(localMsg(req.language, '正在规划学习路线…', 'Planning the learning route…'));

    const course = this.deps.courseRepo.findById(req.courseId);
    const profileText = [
      course?.goal_text    ? `学习目标：${course.goal_text}`    : '',
      course?.known_topics ? `已掌握：${course.known_topics}` : '',
      course?.time_budget  ? `时间预算：${course.time_budget}`  : '',
    ].filter(Boolean).join('\n') || '';

    const nodeTarget = computeNodeTarget(course?.time_budget, course?.known_topics);

    const generationContext = buildDagGenerationContext({
      messages: req.messages,
      topic,
    });
    completePhase('prepare_context');

    const requestedSearchMode = req.searchMode ?? 'auto';
    const effectiveSearchMode = resolveRoadmapSearchMode({
      baseMode: requestedSearchMode,
      userMessage: req.userMessage,
      messages: req.messages,
      topic,
    });
    if (effectiveSearchMode !== requestedSearchMode) {
      progress(localMsg(
        req.language,
        `\n\n🔒 已根据本轮文字要求将路线图检索模式调整为「${searchModeLabel(effectiveSearchMode, req.language)}」。\n`,
        `\n\n🔒 Roadmap retrieval mode was adjusted to "${searchModeLabel(effectiveSearchMode, req.language)}" based on this request.\n`,
      ));
    }
    const genSystemPrompt = this.promptBuilder.buildGenerationPrompt(nodeTarget, {
      searchMode: effectiveSearchMode,
    });

    startPhase('retrieve_sources');
    userPhase(localMsg(req.language, '正在检索参考资料…', 'Retrieving reference sources…'));
    const evidence = await collectRouteEvidence({
      topic,
      profileText,
      courseId: req.courseId,
      provider: req.provider,
      model: req.model,
      searchMode: effectiveSearchMode,
      language: req.language,
      signal: req.signal,
      onProgress: progress,
      usageContext: usageContext('route_evidence'),
      onUsage: (usage) => recordUsage(usage, 'route_evidence'),
    });
    completePhase('retrieve_sources');

    startPhase('generate_content');
    let draftText = '';
    const dagMaxTokens = resolveRoadmapOutputBudget(req.provider, req.model);
    const messages: Array<{ role: 'user'; content: string }> = [{
      role: 'user',
      content: [
        generationContext.content,
        '---',
        evidence.digest,
        '---',
        localMsg(
          req.language,
          '现在请只输出最终路线图 JSON 对象，必须包含 nodes 和 edges 两个数组。不要调用工具，不要添加解释、Markdown 或代码块。',
          'Now output only the final roadmap JSON object with nodes and edges arrays. Do not call tools, and do not add explanation, Markdown, or code fences.',
        ),
      ].join('\n\n'),
    }];

    if (req.signal?.aborted) {
      const aborted = abortError();
      failPhase(aborted);
      throw aborted;
    }

    let announcedThinking = false;
    userPhase(localMsg(req.language, '正在生成路线图结构…', 'Generating the roadmap structure…'));
    progress(localMsg(req.language, '\n🧩 正在基于证据包生成路线图草案 JSON…\n\n', '\n🧩 Generating a draft roadmap JSON from the evidence digest…\n\n'));
    draftText = (await streamStructuredCompletion({
      provider: req.provider,
      model: req.model,
      systemPrompt: genSystemPrompt,
      messages,
      maxTokens: dagMaxTokens,
      jsonMode: true,
      kind: 'json',
      language: req.language,
      usageContext: usageContext('route_generate_draft'),
      signal: req.signal,
      onProgress: progress,
      onThinkingChunk: (chunk) => {
        if (!announcedThinking) {
          announcedThinking = true;
          progress(localMsg(req.language, '🧠 正在组织章节、节点和依赖关系…\n\n', '🧠 Organizing chapters, nodes, and dependencies…\n\n'));
        }
        thinking(chunk);
      },
      onUsage: (usage) => recordUsage(usage, 'route_generate_draft'),
    })).text;

    if (!draftText) {
      const error = new Error('未能获取路线图内容，请重试');
      failPhase(error);
      throw error;
    }

    progress(localMsg(
      req.language,
      effectiveSearchMode === 'library'
        ? '\n\n🔎 草案已生成，正在按参考库证据做严格对齐审查…\n'
        : '\n\n🔎 草案已生成，正在按用户目标和专业课程结构做一轮自评补全…\n',
      effectiveSearchMode === 'library'
        ? '\n\n🔎 Draft generated. Running a strict source-library alignment review…\n'
        : '\n\n🔎 Draft generated. Running one expert self-review pass to enrich the roadmap against the user goal and curriculum structure…\n',
    ));
    let finalText = draftText;
    try {
      const review = await this.reviewAndReviseDag({
        req,
        draftText,
        generationContextText: generationContext.content,
        profileText,
        searchMode: effectiveSearchMode,
        evidenceDigest: evidence.digest,
        maxTokens: dagMaxTokens,
        accUsage,
        context,
        lifecycle,
        progress,
        thinking,
        usageContext: usageContext('route_review'),
        recordUsage,
      });
      finalText = review.roadmapText;
      progress(review.progressText);
    } catch (err) {
      progress(localMsg(
        req.language,
        `\n\n⚠️ 路线图自评修订失败，已回退使用草案继续 JSON 校验：${normalizeAgentError(err).message}\n`,
        `\n\n⚠️ Roadmap self-review failed. Falling back to the draft for JSON validation: ${normalizeAgentError(err).message}\n`,
      ));
    }
    completePhase('generate_content');

    startPhase('verify');
    let dagData: ReturnType<typeof parseDagJson>;
    try {
      dagData = parseDagJson(finalText);
      if (effectiveSearchMode === 'library') {
        dagData = await this.alignStrictLibraryDagIfNeeded({
          req,
          dagData,
          evidenceDigest: evidence.digest,
          sourceIds: evidence.pack?.sources.map((source) => source.id) ?? [],
          maxTokens: dagMaxTokens,
          accUsage,
          context,
          lifecycle,
          progress,
          usageContext: usageContext('route_library_alignment'),
          recordUsage,
        });
      }
      progress(formatRepairReport(dagData.repairReport, req.language));
      completePhase('verify');
    } catch {
      try {
        progress(localMsg(
          req.language,
          '\n\n🧰 路线图 JSON 解析失败，正在执行一次轻量 JSON 修复…\n',
          '\n\n🧰 Roadmap JSON parse failed. Running one lightweight JSON repair pass…\n',
        ));
        const repairedText = await this.repairJson(req, finalText, dagMaxTokens, accUsage, context, lifecycle, usageContext('route_json_repair'), recordUsage);
        dagData = parseDagJson(repairedText);
        if (effectiveSearchMode === 'library') {
          dagData = await this.alignStrictLibraryDagIfNeeded({
            req,
            dagData,
            evidenceDigest: evidence.digest,
            sourceIds: evidence.pack?.sources.map((source) => source.id) ?? [],
            maxTokens: dagMaxTokens,
            accUsage,
            context,
            lifecycle,
            progress,
            usageContext: usageContext('route_library_alignment'),
            recordUsage,
          });
        }
        progress(formatRepairReport(dagData.repairReport, req.language));
        progress(localMsg(
          req.language,
          '\n\n✅ JSON 修复完成，继续验证路线图结构…\n',
          '\n\n✅ JSON repair completed. Continuing route validation…\n',
        ));
        completePhase('verify');
      } catch (repairErr) {
        failPhase(repairErr);
        throw repairErr;
      }
    }
    userPhase(localMsg(req.language, '正在保存路线图…', 'Saving the roadmap…'));
    progress(localMsg(req.language, '\n\n✅ 路线结构验证通过，正在保存到数据库…\n', '\n\n✅ Route structure validated, saving to database…\n'));
    startPhase('persist_artifacts');
    let graph: ReturnType<DagPersistence['save']>;
    try {
      graph = this.deps.persistence.save(req.courseId, dagData);
      this.recordRoadmapContextEntry(req, graph.nodes, graph.edges);
    } catch (err) {
      failPhase(err);
      throw err;
    }
    completePhase('persist_artifacts', graph.nodes.map((node) => node.id));

    const dagPayload = {
      nodes: graph.nodes, edges: graph.edges,
      summary: '', usage: context?.usage ?? { inputTokens: 0, outputTokens: 0, costCny: 0 },
    };
    startPhase('emit_result');
    if (lifecycle) lifecycle.dagGenerated(dagPayload);
    else if (context) context.dagGenerated(dagPayload);
    else safeSend(sender, IPC.DAG_GENERATED, { ...dagPayload, sessionId: req.sessionId });
    completePhase('emit_result');

    await this.chapterScopeGenerator.generate(
      req.courseId,
      graph.nodes,
      req.provider,
      req.model,
      req.signal,
      {
        onStart: (chapterCount) => progress(localMsg(
          req.language,
          `\n🧩 正在为 ${chapterCount} 个章节分配知识点范围…\n`,
          `\n🧩 Assigning knowledge scopes for ${chapterCount} chapters…\n`,
        )),
        onChapterStart: (chapter, index, total) => progress(localMsg(
          req.language,
          `\n[Scope] ${index}/${total} 开始处理「${chapter}」…\n`,
          `\n[Scope] ${index}/${total} Processing "${chapter}"…\n`,
        )),
        onChapterComplete: (chapter, index, total) => progress(localMsg(
          req.language,
          `[Scope] ${index}/${total} 已完成「${chapter}」知识点范围\n`,
          `[Scope] ${index}/${total} Completed knowledge scope for "${chapter}"\n`,
        )),
        onChapterFailed: (chapter, err) => progress(localMsg(
          req.language,
          `[Scope] 「${chapter}」知识点范围生成失败（不影响路线图）：${normalizeAgentError(err).message}\n`,
          `[Scope] Knowledge scope failed for "${chapter}" without blocking the roadmap: ${normalizeAgentError(err).message}\n`,
        )),
        onComplete: (completed, total) => progress(localMsg(
          req.language,
          `\n✅ 章节知识点范围处理完成：${completed}/${total} 个章节成功。\n`,
          `\n✅ Chapter knowledge scope pass completed: ${completed}/${total} chapters succeeded.\n`,
        )),
        onUsage: (usage) => recordUsage(usage, 'chapter_scope'),
        usageContext,
        onFailed: (err) => progress(localMsg(
          req.language,
          `\n⚠️ 章节知识点范围处理失败（不影响路线图）：${normalizeAgentError(err).message}\n`,
          `\n⚠️ Chapter knowledge scope pass failed without blocking the roadmap: ${normalizeAgentError(err).message}\n`,
        )),
      },
    );

    const chapters = new Set(dagData.nodes.map((n) => n.chapter));
    return { nodeCount: graph.nodes.length, chapterNames: [...chapters], profileText, accUsage: { ...accUsage } };
  }

  private recordRoadmapContextEntry(
    req: AgentRequest,
    nodes: ReturnType<DagPersistence['save']>['nodes'],
    edges: ReturnType<DagPersistence['save']>['edges'],
  ): void {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const chapters = new Map<string, typeof nodes>();
    for (const node of nodes) {
      if (!chapters.has(node.chapter)) chapters.set(node.chapter, []);
      chapters.get(node.chapter)!.push(node);
    }

    const lines = [
      '[路线图产物摘要]',
      `本课程最近一次生成了 ${nodes.length} 个节点、${edges.length} 条直接依赖边。完整结构保存在课程 DAG 数据库中；需要精确 ID/边时调用 read_roadmap。`,
      '',
      '章节与节点：',
    ];
    for (const [chapter, chapterNodes] of chapters) {
      lines.push(`\n## ${chapter}`);
      for (const node of [...chapterNodes].sort((a, b) => (a.chapter_order ?? 0) - (b.chapter_order ?? 0))) {
        const prereq = (node.prerequisites ?? [])
          .map((id) => nodeById.get(id)?.name ?? id)
          .filter(Boolean)
          .join('、');
        lines.push(`- ${node.name}（${node.difficulty}，${node.node_type}，ID: ${node.id}）${prereq ? `；前置：${prereq}` : ''}`);
      }
    }

    contextEntryRepo.deactivateKind({
      courseId: req.courseId,
      agent: 'main_tutor',
      kind: 'course_dag_artifact',
    });
    contextEntryRepo.create({
      courseId: req.courseId,
      threadId: req.threadId ?? null,
      agent: 'main_tutor',
      kind: 'course_dag_artifact',
      title: '最近生成的课程路线图',
      content: lines.join('\n'),
    });
  }

  private async repairJson(
    req: AgentRequest,
    raw: string,
    maxTokens: number,
    accUsage: TokenUsage,
    context?: AgentRunContext,
    lifecycle?: WorkflowLifecycle,
    usageContext?: LLMUsageContext,
    recordUsage?: (usage: TokenUsage, source: string) => void,
  ): Promise<string> {
    const repaired = (await streamStructuredCompletion({
      provider: req.provider,
      model: req.model,
      systemPrompt: localMsg(
        req.language,
        '你是 JSON 修复器。只修复用户提供的路线图 JSON 文本，使其成为合法 JSON 对象。不要重新规划路线图，不要新增解释，不要输出 Markdown。输出对象必须只包含 nodes 和 edges。',
        'You are a JSON repair tool. Only repair the provided roadmap JSON text into a valid JSON object. Do not redesign the roadmap, do not add explanations, and do not output Markdown. The output object must contain only nodes and edges.',
      ),
      messages: [{ role: 'user', content: raw }],
      maxTokens,
      jsonMode: true,
      kind: 'json',
      language: req.language,
      usageContext,
      signal: req.signal,
      onUsage: (usage) => {
        if (recordUsage) {
          recordUsage(usage, usageContext?.source ?? 'route_json_repair');
          return;
        }
        accUsage.inputTokens += usage.inputTokens;
        accUsage.outputTokens += usage.outputTokens;
        accUsage.costCny += usage.costCny;
        if (lifecycle) lifecycle.addUsage(usage, usageContext?.source);
        else context?.addUsage(usage, usageContext?.source);
      },
    })).text;
    return repaired;
  }

  private async alignStrictLibraryDagIfNeeded(input: {
    req: AgentRequest;
    dagData: ReturnType<typeof parseDagJson>;
    evidenceDigest: string;
    sourceIds: string[];
    maxTokens: number;
    accUsage: TokenUsage;
    context?: AgentRunContext;
    lifecycle?: WorkflowLifecycle;
    progress: (chunk: string) => void;
    usageContext?: LLMUsageContext;
    recordUsage?: (usage: TokenUsage, source: string) => void;
  }): Promise<ReturnType<typeof parseDagJson>> {
    const issues = evaluateStrictLibraryGrounding(input.dagData, input.sourceIds, input.req.language);
    if (!issues.needsRepair) {
      if (issues.warning) input.progress(issues.warning);
      return input.dagData;
    }

    input.progress(localMsg(
      input.req.language,
      `\n\n🔒 参考库严格模式发现路线图来源约束偏弱，正在执行一次参考库对齐修复：${issues.summary}\n`,
      `\n\n🔒 Strict library mode found weak source grounding. Running one source-library alignment repair: ${issues.summary}\n`,
    ));

    const aligned = (await streamStructuredCompletion({
      provider: input.req.provider,
      model: input.req.model,
      systemPrompt: localMsg(
        input.req.language,
        '你是严格参考库路线图对齐器。只根据提供的参考库证据修订路线图 JSON。删除或改写无参考库支撑的章节/节点，保留有资料依据的内容，补齐合理 source_ids。不要联网，不要用外部知识补内容。只输出合法 JSON 对象，且只包含 nodes 和 edges。',
        'You are a strict source-library roadmap aligner. Revise the roadmap JSON only against the provided source-library evidence. Remove or rewrite unsupported chapters/nodes, keep source-backed content, and fill sensible source_ids. Do not use web or outside knowledge. Output valid JSON only with nodes and edges.',
      ),
      messages: [{
        role: 'user',
        content: [
          localMsg(input.req.language, '【可用 source_id】', '[Allowed source_ids]'),
          input.sourceIds.join(', ') || localMsg(input.req.language, '（无）', '(none)'),
          localMsg(input.req.language, '【严格参考库证据摘要】', '[Strict source-library evidence digest]'),
          compactForPrompt(input.evidenceDigest, 90000),
          localMsg(input.req.language, '【待对齐路线图 JSON】', '[Roadmap JSON to align]'),
          JSON.stringify({ nodes: input.dagData.nodes, edges: input.dagData.edges }),
          localMsg(
            input.req.language,
            '请输出对齐后的完整 JSON。要求：1）不要新增参考库证据没有覆盖的主题；2）无来源支撑的 main 节点应删除、合并或改写到有来源的章节；3）boss 节点可综合有来源支撑的同章内容；4）edges 必须只引用保留节点且无环；5）edges 只表示直接前置依赖，不要输出 A→B→C 同时又 A→C 的传递冗余边。',
            'Output the complete aligned JSON. Requirements: 1) do not add topics not covered by source-library evidence; 2) unsupported main nodes should be removed, merged, or rewritten into source-backed chapters; 3) boss nodes may integrate source-backed content in the same chapter; 4) edges must only reference retained nodes and be acyclic; 5) edges must represent direct prerequisites only, not transitive redundant A→C when A→B→C exists.',
          ),
        ].join('\n\n'),
      }],
      maxTokens: input.maxTokens,
      jsonMode: true,
      kind: 'json',
      language: input.req.language,
      temperature: 0,
      usageContext: input.usageContext,
      signal: input.req.signal,
      onProgress: input.progress,
      onUsage: (usage) => {
        if (input.recordUsage) {
          input.recordUsage(usage, input.usageContext?.source ?? 'route_library_alignment');
          return;
        }
        input.accUsage.inputTokens += usage.inputTokens;
        input.accUsage.outputTokens += usage.outputTokens;
        input.accUsage.costCny += usage.costCny;
        if (input.lifecycle) input.lifecycle.addUsage(usage, input.usageContext?.source);
        else input.context?.addUsage(usage, input.usageContext?.source);
      },
    })).text;

    try {
      const parsed = parseDagJson(aligned);
      input.progress(localMsg(
        input.req.language,
        '\n\n🔒 参考库对齐修复完成，已继续验证路线结构。\n',
        '\n\n🔒 Source-library alignment repair completed; continuing route validation.\n',
      ));
      return parsed;
    } catch (err) {
      input.progress(localMsg(
        input.req.language,
        `\n\n⚠️ 参考库对齐修复失败，保留原路线图继续：${normalizeAgentError(err).message}\n`,
        `\n\n⚠️ Source-library alignment repair failed; keeping the original roadmap: ${normalizeAgentError(err).message}\n`,
      ));
      return input.dagData;
    }
  }

  private async reviewAndReviseDag(input: {
    req: AgentRequest;
    draftText: string;
    generationContextText: string;
    profileText: string;
    searchMode: SearchMode;
    evidenceDigest: string;
    maxTokens: number;
    accUsage: TokenUsage;
    context?: AgentRunContext;
    lifecycle?: WorkflowLifecycle;
    progress: (chunk: string) => void;
    thinking: (chunk: string) => void;
    usageContext?: LLMUsageContext;
    recordUsage?: (usage: TokenUsage, source: string) => void;
  }): Promise<{ roadmapText: string; progressText: string }> {
    const {
      req,
      draftText,
      generationContextText,
      profileText,
      searchMode,
      evidenceDigest,
      maxTokens,
      accUsage,
      context,
      lifecycle,
      progress,
      thinking,
      usageContext,
      recordUsage,
    } = input;
    let announcedThinking = false;

    const reviewed = (await streamStructuredCompletion({
      provider: req.provider,
      model: req.model,
      systemPrompt: buildRoadmapReviewSystemPrompt(searchMode, req.language),
      messages: [{
        role: 'user',
        content: buildRoadmapReviewUserPrompt({
          language: req.language,
          generationContextText,
          profileText,
          searchMode,
          evidenceDigest,
          draftText,
        }),
      }],
      maxTokens,
      jsonMode: true,
      kind: 'json',
      language: req.language,
      temperature: 0.2,
      usageContext,
      signal: req.signal,
      onProgress: progress,
      onThinkingChunk: (chunk) => {
        if (!announcedThinking) {
          announcedThinking = true;
          progress(localMsg(
            req.language,
            searchMode === 'library'
              ? '\n🧠 正在检查路线图是否严格贴合参考库目录、章节和证据来源…\n'
              : '\n🧠 正在检查路线图是否跑题、漏核心内容、难度跳跃或依赖不合理…\n',
            searchMode === 'library'
              ? '\n🧠 Checking whether the roadmap strictly matches source-library outlines, chapters, and citations…\n'
              : '\n🧠 Checking for scope drift, missing core coverage, difficulty jumps, and dependency issues…\n',
          ));
        }
        thinking(chunk);
      },
      onUsage: (usage) => {
        if (recordUsage) {
          recordUsage(usage, usageContext?.source ?? 'route_review');
          return;
        }
        accUsage.inputTokens += usage.inputTokens;
        accUsage.outputTokens += usage.outputTokens;
        accUsage.costCny += usage.costCny;
        if (lifecycle) lifecycle.addUsage(usage, usageContext?.source);
        else context?.addUsage(usage, usageContext?.source);
      },
    })).text;

    if (!reviewed) {
      throw new Error('自评修订没有返回内容');
    }

    return parseRoadmapReviewResult(reviewed, req.language);
  }
}

function searchModeLabel(mode: 'auto' | 'web' | 'library' | 'off', language?: string): string {
  const en = language === 'en';
  if (mode === 'library') return en ? 'Strict library' : '严格参考库';
  if (mode === 'web') return en ? 'Web only' : '联网';
  if (mode === 'off') return en ? 'Search off' : '关闭';
  return en ? 'Auto' : '自动';
}

function resolveRoadmapOutputBudget(provider: string, model: string): number {
  const capability = resolveModelCapability(provider, model);
  if (capability.maxOutputTokens < ROADMAP_MIN_OUTPUT_TOKENS) {
    return Math.max(1024, capability.maxOutputTokens);
  }
  return Math.min(ROADMAP_TARGET_OUTPUT_TOKENS, capability.maxOutputTokens);
}

function evaluateStrictLibraryGrounding(
  dagData: ReturnType<typeof parseDagJson>,
  sourceIds: string[],
  language?: string,
): { needsRepair: boolean; summary: string; warning?: string } {
  const allowed = new Set(sourceIds);
  if (allowed.size === 0) {
    return {
      needsRepair: false,
      summary: 'no source ids available',
      warning: localMsg(
        language,
        '\n\n⚠️ 严格参考库模式未获得可用 source_id；若参考库为空或资料未启用，路线图可能无法做到资料对齐。\n',
        '\n\n⚠️ Strict library mode received no usable source_id; if the library is empty or sources are disabled, the roadmap may not be source-aligned.\n',
      ),
    };
  }

  const mainNodes = dagData.nodes.filter((node) => node.node_type !== 'boss');
  const unknownSourceRefs = dagData.nodes.reduce((count, node) =>
    count + (node.source_ids ?? []).filter((id) => !allowed.has(id)).length, 0);
  const unsupportedMainNodes = mainNodes.filter((node) =>
    !Array.isArray(node.source_ids) || node.source_ids.filter((id) => allowed.has(id)).length === 0,
  );
  const unsupportedRatio = mainNodes.length > 0 ? unsupportedMainNodes.length / mainNodes.length : 0;
  const needsRepair = unknownSourceRefs > 0 || (mainNodes.length >= 4 && unsupportedRatio > 0.35);
  const summary = `main 节点无参考库来源 ${unsupportedMainNodes.length}/${mainNodes.length}，未知 source_id 引用 ${unknownSourceRefs} 个`;

  if (!needsRepair && unsupportedMainNodes.length > 0) {
    return {
      needsRepair,
      summary,
      warning: localMsg(
        language,
        `\n\n🔒 参考库严格模式来源检查：${summary}。比例未超过修复阈值，继续保存；建议后续观察这些节点是否确有资料依据。\n`,
        `\n\n🔒 Strict library grounding check: ${summary}. The ratio is below the repair threshold, so saving continues; please watch whether these nodes truly have source support.\n`,
      ),
    };
  }

  return { needsRepair, summary };
}

function formatRepairReport(report: DagRepairReport, language?: string): string {
  const zhItems = [
    report.droppedDuplicateNodes > 0 ? `移除重复节点 ${report.droppedDuplicateNodes} 个` : '',
    report.normalizedFields > 0 ? `规范化字段 ${report.normalizedFields} 处` : '',
    report.droppedInvalidPrerequisites > 0 ? `移除无效前置引用 ${report.droppedInvalidPrerequisites} 个` : '',
    report.truncatedSourceIds > 0 ? `裁剪过长来源列表 ${report.truncatedSourceIds} 个节点` : '',
    report.addedPrerequisiteEdges > 0 ? `补齐前置边 ${report.addedPrerequisiteEdges} 条` : '',
    report.droppedDuplicateEdges > 0 ? `移除重复边 ${report.droppedDuplicateEdges} 条` : '',
    report.droppedUnknownEdges > 0 ? `移除未知节点边 ${report.droppedUnknownEdges} 条` : '',
    report.droppedSelfLoops > 0 ? `移除自环边 ${report.droppedSelfLoops} 条` : '',
    report.droppedCycleEdges > 0 ? `移除成环边 ${report.droppedCycleEdges} 条` : '',
    report.droppedTransitiveEdges > 0 ? `移除传递冗余边 ${report.droppedTransitiveEdges} 条` : '',
  ].filter(Boolean);

  const enItems = [
    report.droppedDuplicateNodes > 0 ? `removed ${report.droppedDuplicateNodes} duplicate nodes` : '',
    report.normalizedFields > 0 ? `normalized ${report.normalizedFields} fields` : '',
    report.droppedInvalidPrerequisites > 0 ? `removed ${report.droppedInvalidPrerequisites} invalid prerequisite refs` : '',
    report.truncatedSourceIds > 0 ? `trimmed long source lists on ${report.truncatedSourceIds} nodes` : '',
    report.addedPrerequisiteEdges > 0 ? `added ${report.addedPrerequisiteEdges} prerequisite edges` : '',
    report.droppedDuplicateEdges > 0 ? `removed ${report.droppedDuplicateEdges} duplicate edges` : '',
    report.droppedUnknownEdges > 0 ? `removed ${report.droppedUnknownEdges} unknown-node edges` : '',
    report.droppedSelfLoops > 0 ? `removed ${report.droppedSelfLoops} self-loop edges` : '',
    report.droppedCycleEdges > 0 ? `removed ${report.droppedCycleEdges} cycle-forming edges` : '',
    report.droppedTransitiveEdges > 0 ? `removed ${report.droppedTransitiveEdges} transitive redundant edges` : '',
  ].filter(Boolean);

  if (zhItems.length === 0) {
    return localMsg(language, '\n\n🛠 路线结构无需自动修复。\n', '\n\n🛠 No automatic route structure repairs were needed.\n');
  }

  return localMsg(
    language,
    `\n\n🛠 已自动修复路线结构：${zhItems.join('，')}。\n`,
    `\n\n🛠 Automatic route structure repairs: ${enItems.join(', ')}.\n`,
  );
}

function buildRoadmapReviewSystemPrompt(searchMode: SearchMode, language?: string): string {
  if (searchMode === 'library') {
    return localMsg(
      language,
      `你是严格参考库路线图审稿人。你会收到用户请求、学习档案、严格参考库证据摘要和一份草案 JSON。

任务：
1. 只依据参考库证据审查草案是否贴合资料目录、章节、小节、页级摘录和来源 ID。
2. 修正跑出参考库范围的章节或节点；优先删除、合并或改写为参考库已覆盖内容。
3. 如果草案漏掉参考库目录中的重要章节/小节，可以补上，但必须能从证据摘要中找到支撑。
4. boss 节点按原路线图风格保留为阶段综合任务，但只能综合同章参考库已覆盖内容。

严格约束：
- 不要使用通用课程体系、模型专业知识或外部经验补出参考库未覆盖的主题。
- 不要因为“通常应该学”就新增节点；只有参考库证据出现或明显属于资料目录结构时才新增。
- 无参考库支撑的 main 节点应删除、合并或改写；source_ids 应尽量填写证据中的 source_id。
- 如果参考库覆盖有限，宁可输出更窄、更少但忠实的路线图，不要为了完整而编外部内容。
- review.verdict 只能是 "pass" 或 "revise"。
- edges/prerequisites 只表示直接前置依赖；如果已有 A→B→C，不要再输出 A→C 这类传递冗余边。
- 每章优先保持清晰主线，可有少量分叉/汇合；跨章边只连接真实直接依赖，不要机械连接章节首尾。
- roadmap 必须只包含 nodes 和 edges；节点字段、枚举、source_ids 限制继续遵守。
- 输出合法 JSON，不要 Markdown、代码块或额外解释。

输出格式：
{
  "review": {
    "verdict": "revise",
    "summary": "一句话说明如何对齐参考库",
    "coverage_map": {
      "standard_basis": "严格参考库证据",
      "modules": [
        {
          "module": "参考库章节/资料模块",
          "status": "covered",
          "action": "保留/删除/改写/补上了哪些节点"
        }
      ]
    },
    "issues": [
      {
        "type": "unsupported_by_library",
        "severity": "high",
        "message": "发现的问题",
        "fix": "采取的参考库对齐修订"
      }
    ]
  },
  "roadmap": {
    "nodes": [],
    "edges": []
  }
}`,
      `You are a strict source-library roadmap reviewer. You will receive the user request, learner profile, a strict source-library evidence digest, and a draft JSON roadmap.

Tasks:
1. Review only against the source-library evidence: outlines, chapters, units, page excerpts, and source IDs.
2. Fix chapters or nodes that drift outside the library. Prefer deleting, merging, or rewriting them into source-backed content.
3. If the draft misses important chapters/sections present in the library evidence, add them, but only when supported by the evidence digest.
4. Keep boss nodes as stage integration tasks, but they may only integrate source-backed content from the same chapter.

Hard constraints:
- Do not use generic curricula, expert prior knowledge, or outside experience to add topics not covered by the library.
- Do not add nodes merely because they are normally important; add only when the source-library evidence contains them or clearly implies them through the document outline.
- Unsupported main nodes should be removed, merged, or rewritten; source_ids should be filled from the provided evidence wherever possible.
- If library coverage is limited, output a narrower but faithful roadmap instead of inventing completeness.
- review.verdict must be exactly "pass" or "revise".
- edges/prerequisites must represent direct prerequisites only; if A→B→C already exists, do not also output transitive redundant A→C.
- Prefer a clear main line within each chapter with a few natural branches/joins; cross-chapter edges should represent real direct dependencies, not mechanical chapter tail-to-head links.
- roadmap must contain only nodes and edges; preserve node fields, enum values, and source_ids limits.
- Output valid JSON only, with no Markdown, code fences, or extra prose.

Output format:
{
  "review": {
    "verdict": "revise",
    "summary": "one-sentence summary of source-library alignment",
    "coverage_map": {
      "standard_basis": "strict source-library evidence",
      "modules": [
        {
          "module": "library chapter/source module",
          "status": "covered",
          "action": "which nodes were kept/deleted/rewritten/added"
        }
      ]
    },
    "issues": [
      {
        "type": "unsupported_by_library",
        "severity": "high",
        "message": "the issue found",
        "fix": "the source-library alignment change"
      }
    ]
  },
  "roadmap": {
    "nodes": [],
    "edges": []
  }
}`,
    );
  }

  return localMsg(
    language,
    `你是路线图自评与补全编辑。你会收到用户请求、学习档案、检索模式和一份草案 JSON。

任务：
1. 以用户目标和你的专业知识为主，判断草案有没有遗漏重要知识点、技能环节或学习阶段。
2. 只修补明显缺漏和较大的结构错误，让最终路线图比草案更丰富、更完整、更适合学习。
3. 优先新增、细化、改写或调整依赖；除非明显重复、跑题或错误，不要删减节点。
4. boss 节点按原路线图风格保留为阶段综合任务；如果 boss 太空泛，优先改写具体任务，不要做单独 boss 审查，也不要把 boss 集中删到只剩最后一个。

严格约束：
- 自评阶段不要被证据包限制；证据已经用于生成草案，这一步重点使用模型专业知识补全课程结构。
- 用户指定“只依据参考库/PDF/某资料”时，仍应尊重该限制；否则允许基于典型课程体系、成熟实践路径和专业经验补充缺漏。
- 用户主题宽泛时，不要把它缩窄成单一子领域；例如“数学入门”不能只生成微积分。
- 最终路线图通常不应比草案节点更少、覆盖更粗；若确实删除，必须只删除明显重复/跑题节点，并在 review.summary 说明。
- 新增节点要接入 DAG：除开篇基础节点外，应有合理前置依赖，并通向后续节点、阶段 boss 或最终项目。
- 缺少直接来源不应阻止你补充必要节点；这类节点使用 source_ids: [] 即可，rationale 只说明学习价值或编排理由，不要写来源说明。
- review.verdict 只能是 "pass" 或 "revise"。
- edges/prerequisites 只表示直接前置依赖；如果已有 A→B→C，不要再输出 A→C 这类传递冗余边。
- 每章优先保持清晰主线，可有少量分叉/汇合；跨章边只连接真实直接依赖，不要机械连接章节首尾。
- 软件会根据跨章边推导章节前置依赖。若 B 章必须等 A 章学完后开启，请至少保留一条真实直接的 A章节点→B章节点 边；并行章节可以共享同一前置章，串行章节用 A章→B章→C章 表达。除真正独立的开篇模块外，不要让后续章节完全游离。
- 保留原有 schema：roadmap 必须只包含 nodes 和 edges；节点字段、枚举、source_ids 限制继续遵守。
- 输出必须是合法 JSON，不要 Markdown、代码块或额外解释。

输出格式：
{
  "review": {
    "verdict": "revise",
    "summary": "一句话说明补全或修正了什么",
    "coverage_map": {
      "standard_basis": "模型专业知识与典型学习路径",
      "modules": [
        {
          "module": "缺漏或薄弱模块",
          "status": "missing",
          "action": "新增/细化/改写了哪些节点"
        }
      ]
    },
    "issues": [
      {
        "type": "missing_core",
        "severity": "high",
        "message": "发现的问题",
        "fix": "在 roadmap 中采取的修订"
      }
    ]
  },
  "roadmap": {
    "nodes": [],
    "edges": []
  }
}`,
    `You are a roadmap self-review and enrichment editor. You will receive the user request, learner profile, retrieval mode, and a draft JSON roadmap.

Tasks:
1. Use the user goal and your own expert knowledge to judge whether the draft misses important knowledge, skills, or learning stages.
2. Only patch meaningful omissions and major structural errors so the final roadmap is richer, more complete, and more learnable than the draft.
3. Prefer adding, detailing, rewriting, or fixing dependencies. Do not remove nodes unless they are clearly duplicate, off-topic, or wrong.
4. Keep boss nodes in the original roadmap style as stage integration tasks. If a boss is vague, rewrite it into a concrete task. Do not run a separate boss audit, and do not collapse all boss nodes into only one final boss.

Hard constraints:
- Do not constrain the review around the evidence pack; evidence was already used for the draft. This pass should mainly use expert curriculum judgment to enrich the route.
- If the user requested using only a library/PDF/source, still respect that restriction. Otherwise, you may use typical curricula, mature practice paths, and expert knowledge to fill gaps.
- If the topic is broad, do not collapse it into a single subfield; for example, "intro to mathematics" must not become only calculus.
- The final roadmap should usually not have fewer nodes or coarser coverage than the draft. If you delete anything, only delete obvious duplicates/off-topic nodes and explain it in review.summary.
- New nodes should be integrated into the DAG: except for opening foundations, they need sensible prerequisites and should lead to later nodes, a stage boss, or a final project.
- Missing direct sources must not stop you from adding necessary nodes. Use source_ids: [] for those nodes, and make rationale explain learning value or sequencing, not provenance.
- review.verdict must be exactly "pass" or "revise".
- edges/prerequisites must represent direct prerequisites only; if A→B→C already exists, do not also output transitive redundant A→C.
- Prefer a clear main line within each chapter with a few natural branches/joins; cross-chapter edges should represent real direct dependencies, not mechanical chapter tail-to-head links.
- The app derives chapter prerequisites from cross-chapter edges. If chapter B should unlock only after chapter A, include at least one real direct A-chapter node → B-chapter node edge. Parallel chapters may share the same previous chapter; serial chapters should form A chapter → B chapter → C chapter. Do not leave later chapters completely disconnected unless they are true independent entry modules.
- Preserve the original schema: roadmap must contain only nodes and edges; node fields, enum values, and source_ids limits still apply.
- Output valid JSON only, with no Markdown, code fences, or extra prose.

Output format:
{
  "review": {
    "verdict": "revise",
    "summary": "one-sentence summary of what was enriched or corrected",
    "coverage_map": {
      "standard_basis": "model expert knowledge and typical learning path",
      "modules": [
        {
          "module": "missing or weak module",
          "status": "missing",
          "action": "which nodes were added, detailed, or rewritten"
        }
      ]
    },
    "issues": [
      {
        "type": "missing_core",
        "severity": "high",
        "message": "the issue found",
        "fix": "the change made in roadmap"
      }
    ]
  },
  "roadmap": {
    "nodes": [],
    "edges": []
  }
}`,
  );
}

function buildRoadmapReviewUserPrompt(input: {
  language?: string;
  generationContextText: string;
  profileText: string;
  searchMode: SearchMode;
  evidenceDigest: string;
  draftText: string;
}): string {
  return [
    localMsg(input.language, '【用户请求、对话背景与生成约束】', '[User request, conversation context, and generation constraints]'),
    compactForPrompt(input.generationContextText, 24000),
    localMsg(input.language, '【学习档案】', '[Learner profile]'),
    input.profileText || localMsg(input.language, '（无）', '(none)'),
    localMsg(input.language, '【本轮检索模式】', '[Retrieval mode]'),
    searchModeLabel(input.searchMode, input.language),
    input.searchMode === 'library'
      ? localMsg(input.language, '【严格参考库证据摘要】', '[Strict source-library evidence digest]')
      : localMsg(input.language, '【证据摘要】', '[Evidence digest]'),
    compactForPrompt(input.evidenceDigest, input.searchMode === 'library' ? 90000 : 22000),
    localMsg(input.language, '【草案路线图 JSON】', '[Draft roadmap JSON]'),
    compactForPrompt(input.draftText, 360000),
    input.searchMode === 'library'
      ? localMsg(
          input.language,
          '请输出严格按参考库对齐后的完整 JSON。review 简短说明删掉/改写/保留了哪些内容，roadmap 必须只覆盖参考库证据支持的节点。不要为了完整而补外部知识。edges 只保留直接前置依赖，不要输出传递冗余边。',
          'Output the complete JSON aligned strictly to the source library. Keep review brief about what was removed/rewritten/kept, and roadmap must only cover source-library-backed nodes. Do not add outside knowledge for completeness. Keep only direct prerequisite edges, not transitive redundant edges.',
        )
      : localMsg(
          input.language,
          '请输出自评后的完整 JSON。review 简短说明补了什么，roadmap 必须是补全修正后的完整路线图对象。不要为了精简而减少草案的核心知识覆盖。edges 只保留直接前置依赖，不要输出传递冗余边。',
          'Output the complete reviewed JSON. Keep review brief about what was enriched, and roadmap must be the complete enriched/corrected roadmap object. Do not reduce core coverage just to simplify. Keep only direct prerequisite edges, not transitive redundant edges.',
        ),
  ].join('\n\n');
}

function parseRoadmapReviewResult(raw: string, language?: string): { roadmapText: string; progressText: string } {
  const parsed = extractJsonObject(raw);
  const root = asRecord(parsed);
  if (!root) {
    throw new Error('自评结果不是 JSON 对象');
  }

  if (Array.isArray(root.nodes) && Array.isArray(root.edges)) {
    return {
      roadmapText: JSON.stringify({ nodes: root.nodes, edges: root.edges }),
      progressText: localMsg(
        language,
        '\n\n🔎 路线图自评完成：模型直接返回了修订后的路线图，未附带结构化评测报告。\n',
        '\n\n🔎 Roadmap self-review completed: the model returned the revised roadmap directly without a structured review report.\n',
      ),
    };
  }

  const roadmap = asRecord(root.roadmap);
  if (!roadmap || !Array.isArray(roadmap.nodes) || !Array.isArray(roadmap.edges)) {
    throw new Error('自评结果缺少 roadmap.nodes 或 roadmap.edges');
  }

  return {
    roadmapText: JSON.stringify({ nodes: roadmap.nodes, edges: roadmap.edges }),
    progressText: formatRoadmapReviewProgress(root.review, language),
  };
}

function extractJsonObject(raw: string): unknown {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence?.[1]) {
    text = fence[1].trim();
  }
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error('自评结果不是有效 JSON');
  }
}

function formatRoadmapReviewProgress(review: unknown, language?: string): string {
  const data = asRecord(review);
  const verdict = readString(data?.verdict) || 'revise';
  const summary = readString(data?.summary);
  const issues = Array.isArray(data?.issues) ? data.issues.map(asRecord).filter(Boolean) : [];
  const coverageText = formatCoverageMapProgress(data?.coverage_map, language);

  if (issues.length === 0) {
    return localMsg(
      language,
      `\n\n🔎 路线图自评完成：${summary || (verdict === 'pass' ? '草案通过，未发现需要改写的高风险问题。' : '已完成必要修订。')}${coverageText}\n`,
      `\n\n🔎 Roadmap self-review completed: ${summary || (verdict === 'pass' ? 'the draft passed with no high-risk rewrite needed.' : 'necessary revisions were applied.')}${coverageText}\n`,
    );
  }

  const lines = issues.slice(0, 6).map((issue, index) => {
    const severity = readString(issue?.severity) || 'medium';
    const type = readString(issue?.type) || 'issue';
    const message = readString(issue?.message) || '';
    const fix = readString(issue?.fix) || '';
    const suffix = fix ? localMsg(language, `；修订：${fix}`, `; fix: ${fix}`) : '';
    return `${index + 1}. [${severity}/${type}] ${message}${suffix}`;
  });
  const more = issues.length > 6
    ? localMsg(language, `\n…另有 ${issues.length - 6} 条较小问题已纳入修订。`, `\n…${issues.length - 6} more minor issues were folded into the revision.`)
    : '';

  return localMsg(
    language,
    `\n\n🔎 路线图自评完成：${summary || '已根据评测结果修订草案。'}${coverageText}\n${lines.join('\n')}${more}\n`,
    `\n\n🔎 Roadmap self-review completed: ${summary || 'the draft was revised based on the review.'}${coverageText}\n${lines.join('\n')}${more}\n`,
  );
}

function formatCoverageMapProgress(coverageMap: unknown, language?: string): string {
  const data = asRecord(coverageMap);
  if (!data) return '';

  const basis = readString(data.standard_basis);
  const modules = Array.isArray(data.modules) ? data.modules.map(asRecord).filter(Boolean) : [];
  if (!basis && modules.length === 0) return '';

  const visibleModules = modules
    .filter((item) => {
      const status = readString(item?.status);
      return status === 'missing' || status === 'undercovered' || status === 'overexpanded' || status === 'misplaced';
    })
    .slice(0, 6);

  const fallbackModules = visibleModules.length > 0 ? visibleModules : modules.slice(0, 4);
  const lines = fallbackModules.map((item) => {
    const moduleName = readString(item?.module) || localMsg(language, '未命名模块', 'unnamed module');
    const status = readString(item?.status) || 'covered';
    const action = readString(item?.action);
    return `- ${moduleName}: ${status}${action ? ` -> ${action}` : ''}`;
  });

  const more = modules.length > fallbackModules.length
    ? localMsg(language, `\n…另有 ${modules.length - fallbackModules.length} 个覆盖模块已参与对照。`, `\n…${modules.length - fallbackModules.length} more coverage modules were compared.`)
    : '';

  return localMsg(
    language,
    `${basis ? `\n覆盖依据：${basis}` : ''}${lines.length ? `\n覆盖对照：\n${lines.join('\n')}${more}` : ''}`,
    `${basis ? `\nCoverage basis: ${basis}` : ''}${lines.length ? `\nCoverage comparison:\n${lines.join('\n')}${more}` : ''}`,
  );
}

function compactForPrompt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.62));
  const tail = text.slice(text.length - Math.floor(maxChars * 0.32));
  return `${head}\n\n...[content truncated for review prompt]...\n\n${tail}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
