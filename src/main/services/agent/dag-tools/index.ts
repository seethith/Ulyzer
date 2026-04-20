/**
 * DAG edit tools — used by MainTutor chat to add/remove/update nodes.
 *
 * Unlike the sub-tutor tools (in tutor-tools/), these are NOT registered in the
 * global TOOL_REGISTRY. Instead, buildDagToolDefs() returns the LLM-facing
 * schemas, and executeDagTool() dispatches calls with a per-request context that
 * carries the Electron sender for emitting IPC.DAG_GENERATED.
 */
import { randomUUID } from 'crypto';
import { IPC } from '@shared/ipc-channels';
import type { DagEdge, Difficulty, NodeType } from '@shared/types';
import type { ToolDef, ToolCallBlock } from '../../llm/adapter';
import { NodeRepository, EdgeRepository } from '../../db/repositories/node.repo';
import { getDb } from '../../db/sqlite';
import { buildDagSearchResults } from '../../web/source-strategy';
import { CourseRepository } from '../../db/repositories/course.repo';

export interface DagToolContext {
  courseId: string;
  sessionId: string;
  sender: Electron.WebContents;
  provider?: string;
  model?: string;
  /** Callback to trigger full DAG generation (injected by handleChat) */
  runDagGeneration?: (topic: string) => Promise<{ nodeCount: number; chapterNames: string[] }>;
}

const nodeRepo = new NodeRepository();
const edgeRepo = new EdgeRepository();
const courseRepo = new CourseRepository();

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeSend(sender: Electron.WebContents, channel: string, data: unknown): void {
  try {
    if (!sender.isDestroyed()) sender.send(channel, data);
  } catch { /* window closed */ }
}

/** After any DAG mutation, sync total_nodes/done_nodes and push updated graph. */
function pushDagUpdate(courseId: string, ctx: DagToolContext): void {
  const db = getDb();
  db.prepare(
    `UPDATE courses SET
       total_nodes = (SELECT COUNT(*) FROM dag_nodes WHERE course_id = ?),
       done_nodes  = (SELECT COUNT(*) FROM dag_nodes WHERE course_id = ? AND status = 'done'),
       updated_at  = datetime('now')
     WHERE id = ?`
  ).run(courseId, courseId, courseId);

  const nodes = nodeRepo.findByCourse(courseId);
  const edges = edgeRepo.findByCourse(courseId);
  safeSend(ctx.sender, IPC.DAG_GENERATED, {
    nodes,
    edges,
    summary: '',
    usage: { inputTokens: 0, outputTokens: 0, costCny: 0 },
    sessionId: ctx.sessionId,
  });
}

/** Place the new node at the bottom of its chapter column. */
function computeNewNodePosition(courseId: string, chapter: string): { x: number; y: number } {
  const CHAPTER_GAP_X = 260;
  const NODE_GAP_Y    = 130;
  const MARGIN_X      = 80;
  const MARGIN_Y      = 80;

  const allNodes = nodeRepo.findByCourse(courseId);
  // Unique chapters in insertion order
  const chapters = [...new Set(allNodes.map((n) => n.chapter))];
  const chapterIndex = chapters.indexOf(chapter);
  const ci = chapterIndex === -1 ? chapters.length : chapterIndex;

  const inChapter = allNodes.filter((n) => n.chapter === chapter);
  const maxChapterOrder = inChapter.length > 0
    ? Math.max(...inChapter.map((n) => n.chapter_order ?? 0))
    : -1;

  return {
    x: ci * CHAPTER_GAP_X + MARGIN_X,
    y: (maxChapterOrder + 1) * NODE_GAP_Y + MARGIN_Y,
  };
}

// ── Tool schemas ──────────────────────────────────────────────────────────────

export function buildDagToolDefs(): ToolDef[] {
  return [
    {
      name: 'add_node',
      description:
        '【做什么】在课程路线图中新增一个知识节点，自动连接前置依赖边，路线图实时刷新。' +
        '【何时调用】用户说"加个节点"/"加一下X"/"补充X这个知识点"/"路线里加上X"/"我还想学X"/"添加X到路线"，或 AI 规划路线时需要补充内容时。' +
        '【关键】prerequisites 必须填写上下文中列出的节点 UUID（格式 "ID: xxx-xxx-xxx"），不填则新节点不与任何节点相连；需要根据知识依赖关系决定前置节点。' +
        '【限制】只能操作当前课程；不能批量添加（需分次调用）。',
      inputSchema: {
        type: 'object',
        properties: {
          name:           { type: 'string', description: '节点名称，简洁清晰（≤20字）' },
          chapter:        { type: 'string', description: '所属章节名称（必须与现有章节一致，或新章节名）' },
          description:    { type: 'string', description: '节点内容描述（1-2句话）' },
          difficulty:     { type: 'string', enum: ['beginner', 'intermediate', 'advanced'], description: '难度级别' },
          hours_est:      { type: 'number', description: '预估学习时间（小时），如 1.5' },
          node_type:      { type: 'string', enum: ['main', 'boss'], description: '节点类型，普通节点用 main，综合考核用 boss' },
          prerequisites:  { type: 'array', items: { type: 'string' }, description: '前置节点的 UUID 列表，从当前路线图上下文获取' },
        },
        required: ['name', 'chapter'],
      },
    },
    {
      name: 'remove_node',
      description:
        '【做什么】从课程路线图中删除一个节点，自动清理所有关联边和后续节点的前置依赖，路线图实时刷新。' +
        '【何时调用】用户说"删掉X节点"/"把X去掉"/"移除X"/"不需要学X了"/"删除这个节点"，并明确指出了要删除的节点名称或位置时。' +
        '【限制】删除不可撤销；需要节点 UUID（从路线图上下文获取）；只能操作当前课程的节点。',
      inputSchema: {
        type: 'object',
        properties: {
          node_id: { type: 'string', description: '要删除的节点 UUID（从当前路线图上下文获取）' },
        },
        required: ['node_id'],
      },
    },
    {
      name: 'connect_nodes',
      description:
        '【做什么】在两个已有节点之间新增一条有向依赖边（source → target），路线图实时刷新。' +
        '【何时调用】用户说"把A和B连起来"/"A应该是B的前置"/"让A指向B"/"A连B"/"A→B"，或 AI 发现路线图中存在应当相连但未相连的节点时。' +
        '【限制】不能创建已存在的重复边；不能创建环（会导致循环依赖）；需要从上下文获取节点 UUID。',
      inputSchema: {
        type: 'object',
        properties: {
          source_node_id: { type: 'string', description: '源节点 UUID（前置节点，必须先完成）' },
          target_node_id: { type: 'string', description: '目标节点 UUID（后续节点，依赖前置）' },
        },
        required: ['source_node_id', 'target_node_id'],
      },
    },
    {
      name: 'generate_dag',
      description:
        '【做什么】根据学习主题生成完整的课程路线图（DAG），包含章节划分、知识节点和依赖关系，结果实时显示在路线图画布上。' +
        '【何时调用】用户要求生成/规划/创建学习路线、课程规划，或提供了学习主题/目标时。' +
        '【重要】如果用户在同一条消息中提到了学习目标、已掌握主题或时间预算，请先调用 update_profile 保存这些信息，再调用 generate_dag。' +
        '【限制】每次只能生成一个路线图；生成过程较长（30秒-2分钟），用户会看到进度提示。',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '学习主题或课程名称，如"Python机器学习"、"有机化学基础"' },
        },
        required: ['topic'],
      },
    },
    {
      name: 'update_profile',
      description:
        '当用户在对话中表达学习目标、已掌握主题或时间预算时，调用此工具将提取的信息保存到课程学习档案。只保存用户明确提到的字段，其余字段不传。',
      inputSchema: {
        type: 'object',
        properties: {
          goal_text:    { type: 'string', description: '学习目标（想达到什么水平、为什么学）' },
          known_topics: { type: 'string', description: '已掌握的主题/技能（如：Python基础、SQL查询）' },
          time_budget:  { type: 'string', description: '时间预算（如：每天2小时，共3个月）' },
        },
      },
    },
    {
      name: 'analyze_dag',
      description:
        '分析当前课程路线图的结构质量：节点分布、难度曲线、孤立节点、章节平衡、总学时等。用于了解路线现状或回答用户关于路线结构的问题。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'web_search',
      description:
        '搜索网络获取权威参考资料。规划路线时用于查找真实课程大纲、教学结构、权威教材；普通对话中用于获取最新官方文档或知识背景。',
      inputSchema: {
        type: 'object',
        properties: {
          query:      { type: 'string', description: '搜索关键词（中英文均可）' },
          maxResults: { type: 'number', description: '返回结果数量，1-5，默认 3' },
        },
        required: ['query'],
      },
    },
    {
      name: 'update_node',
      description:
        '【做什么】修改路线图中已有节点的属性（名称、描述、难度、预估时间、章节等），只更新传入的字段，路线图实时刷新。' +
        '【何时调用】用户说"把X改成Y"/"修改X节点的难度"/"X的时间估算不对"/"X的描述需要改一下"/"重命名X"，或用户对某个节点的属性提出修改意见时。' +
        '【限制】只能修改属性，不能改变节点的前置依赖关系（依赖变更需删除再重建）；只能操作当前课程的节点。',
      inputSchema: {
        type: 'object',
        properties: {
          node_id:        { type: 'string', description: '要修改的节点 UUID' },
          name:           { type: 'string', description: '新名称' },
          description:    { type: 'string', description: '新描述' },
          difficulty:     { type: 'string', enum: ['beginner', 'intermediate', 'advanced'] },
          hours_est:      { type: 'number', description: '新的预估学习时间（小时）' },
          chapter:        { type: 'string', description: '修改所属章节' },
          node_type:      { type: 'string', enum: ['main', 'boss'] },
        },
        required: ['node_id'],
      },
    },
  ];
}

// ── Tool execution ────────────────────────────────────────────────────────────

export async function executeDagTool(
  call: ToolCallBlock,
  ctx: DagToolContext,
): Promise<string> {
  const { name, input } = call;

  try {
    if (name === 'generate_dag') {
      const { topic } = input as { topic: string };
      if (!ctx.runDagGeneration) return JSON.stringify({ success: false, message: 'generate_dag 不可用' });
      const result = await ctx.runDagGeneration(topic);
      return JSON.stringify({ success: true, nodeCount: result.nodeCount, chapterNames: result.chapterNames });
    }
    if (name === 'update_profile') {
      return updateProfile(input as UpdateProfileInput, ctx);
    }
    if (name === 'analyze_dag') {
      return analyzeDag(ctx);
    }
    if (name === 'web_search') {
      return webSearch(input as { query: string; maxResults?: number }, ctx);
    }
    if (name === 'add_node') {
      return addNode(input as unknown as AddNodeInput, ctx);
    }
    if (name === 'remove_node') {
      return removeNode(input as unknown as RemoveNodeInput, ctx);
    }
    if (name === 'connect_nodes') {
      return connectNodes(input as unknown as ConnectNodesInput, ctx);
    }
    if (name === 'update_node') {
      return updateNode(input as unknown as UpdateNodeInput, ctx);
    }
    return `未知工具: ${name}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `操作失败: ${msg}`;
  }
}

// ── update_profile ────────────────────────────────────────────────────────────

interface UpdateProfileInput {
  goal_text?: string;
  known_topics?: string;
  time_budget?: string;
}

function updateProfile(input: UpdateProfileInput, ctx: DagToolContext): string {
  const data: UpdateProfileInput = {};
  if (input.goal_text    !== undefined) data.goal_text    = input.goal_text;
  if (input.known_topics !== undefined) data.known_topics = input.known_topics;
  if (input.time_budget  !== undefined) data.time_budget  = input.time_budget;
  if (Object.keys(data).length === 0) return JSON.stringify({ success: false, message: '没有提供任何字段' });
  courseRepo.updateProfile(ctx.courseId, data);
  const LABEL: Record<string, string> = { goal_text: '学习目标', known_topics: '已掌握主题', time_budget: '时间预算' };
  const updated = Object.keys(data).map((k) => LABEL[k] ?? k).join('、');
  return JSON.stringify({ success: true, message: `已更新学习档案：${updated}` });
}

// ── analyze_dag ───────────────────────────────────────────────────────────────

function analyzeDag(ctx: DagToolContext): string {
  const nodes = nodeRepo.findByCourse(ctx.courseId);
  if (nodes.length === 0) return JSON.stringify({ message: '当前课程暂无路线图节点' });

  const edges = edgeRepo.findByCourse(ctx.courseId);
  const hasIncoming  = new Set(edges.map((e) => e.target_node_id));
  const hasOutgoing  = new Set(edges.map((e) => e.source_node_id));
  const orphans      = nodes.filter((n) => !hasIncoming.has(n.id) && !hasOutgoing.has(n.id)).map((n) => n.name);

  const chapters = new Map<string, typeof nodes>();
  for (const n of nodes) {
    if (!chapters.has(n.chapter)) chapters.set(n.chapter, []);
    chapters.get(n.chapter)!.push(n);
  }

  const chapterStats = [...chapters.entries()].map(([name, ns]) => ({
    name,
    count: ns.length,
    hasBoss: ns.some((n) => n.node_type === 'boss'),
    difficultySpread: [...new Set(ns.map((n) => n.difficulty))],
    totalHours: ns.reduce((s, n) => s + (n.hours_est ?? 0), 0),
  }));

  const diffDist: Record<string, number> = { beginner: 0, intermediate: 0, advanced: 0 };
  for (const n of nodes) { if (n.difficulty in diffDist) diffDist[n.difficulty]++; }

  const totalHours = nodes.reduce((s, n) => s + (n.hours_est ?? 0), 0);
  const doneCount  = nodes.filter((n) => n.status === 'done').length;
  const chaptersNoBoss = chapterStats.filter((c) => !c.hasBoss).map((c) => c.name);

  return JSON.stringify({
    total_nodes: nodes.length,
    total_hours: totalHours.toFixed(1),
    done_nodes: doneCount,
    chapters: chapterStats,
    difficulty_distribution: diffDist,
    orphan_nodes: orphans,
    chapters_missing_boss: chaptersNoBoss,
    issues: [
      ...(orphans.length > 0 ? [`孤立节点（无连接）：${orphans.join('、')}`] : []),
      ...(chaptersNoBoss.length > 0 ? [`缺少 Boss 关的章节：${chaptersNoBoss.join('、')}`] : []),
      ...(diffDist.beginner === nodes.length ? ['所有节点难度均为 beginner，可能缺少进阶内容'] : []),
    ],
  }, null, 2);
}

// ── web_search ────────────────────────────────────────────────────────────────

async function webSearch(
  input: { query: string; maxResults?: number },
  ctx: DagToolContext,
): Promise<string> {
  const maxResults = Math.min(input.maxResults ?? 3, 5);
  const { answer, results } = await buildDagSearchResults(input.query, {
    provider: ctx.provider,
    model: ctx.model,
    maxResults,
  });
  const parts: string[] = [];
  if (answer) parts.push(`[搜索摘要] ${answer}`);
  parts.push(
    ...results.map((r, i) =>
      `[网络资料 ${i + 1}] ${r.title}\n来源：${r.url}\n${r.content.slice(0, 600)}`,
    ),
  );
  return parts.join('\n\n---\n\n') || '未找到相关结果';
}

// ── add_node ──────────────────────────────────────────────────────────────────

interface AddNodeInput {
  name: string;
  chapter: string;
  description?: string;
  difficulty?: string;
  hours_est?: number;
  node_type?: string;
  prerequisites?: string[];
}

function addNode(input: AddNodeInput, ctx: DagToolContext): string {
  const pos = computeNewNodePosition(ctx.courseId, input.chapter);
  const allNodes = nodeRepo.findByCourse(ctx.courseId);
  const inChapter = allNodes.filter((n) => n.chapter === input.chapter);
  const chapterOrder = inChapter.length > 0
    ? Math.max(...inChapter.map((n) => n.chapter_order ?? 0)) + 1
    : 0;

  // Validate prerequisites exist in this course; collect invalid ones for feedback
  const invalidPrereqs = (input.prerequisites ?? []).filter((pid) =>
    !allNodes.some((n) => n.id === pid),
  );
  const validPrereqs = (input.prerequisites ?? []).filter((pid) =>
    allNodes.some((n) => n.id === pid),
  );

  const newNode = nodeRepo.create({
    course_id:     ctx.courseId,
    chapter:       input.chapter,
    chapter_order: chapterOrder,
    name:          input.name,
    description:   input.description,
    node_type:     (input.node_type as NodeType) ?? 'main',
    status:        validPrereqs.length > 0 ? 'locked' : 'available',
    hours_est:     input.hours_est ?? 2.0,
    difficulty:    (input.difficulty as Difficulty) ?? 'intermediate',
    prerequisites: validPrereqs,
    required_tools: [],
    required_cost:  {},
    position_x:    pos.x,
    position_y:    pos.y,
  });

  // Add edges from each prerequisite to this new node
  if (validPrereqs.length > 0) {
    const existingEdges = edgeRepo.findByCourse(ctx.courseId);
    const newEdges: Array<Omit<DagEdge, 'created_at'>> = [
      ...existingEdges,
      ...validPrereqs.map((pid) => ({
        id:             randomUUID(),
        course_id:      ctx.courseId,
        source_node_id: pid,
        target_node_id: newNode.id,
      })),
    ];
    edgeRepo.saveAll(ctx.courseId, newEdges);
  }

  pushDagUpdate(ctx.courseId, ctx);
  return JSON.stringify({
    success: true,
    node_id: newNode.id,
    message: `已添加节点「${newNode.name}」到章节「${input.chapter}」，` +
      (validPrereqs.length > 0
        ? `已连接前置节点 ${validPrereqs.length} 个。`
        : '未连接任何前置节点（孤立节点）。') +
      (invalidPrereqs.length > 0
        ? ` 警告：以下 prerequisites ID 不存在，已跳过：${invalidPrereqs.join(', ')}。请使用上下文中的正确 ID 重新连接。`
        : ''),
  });
}

// ── remove_node ───────────────────────────────────────────────────────────────

interface RemoveNodeInput {
  node_id: string;
}

function removeNode(input: RemoveNodeInput, ctx: DagToolContext): string {
  const node = nodeRepo.findById(input.node_id);
  if (!node) return JSON.stringify({ success: false, message: `节点不存在: ${input.node_id}` });
  if (node.course_id !== ctx.courseId) {
    return JSON.stringify({ success: false, message: '无法操作其他课程的节点' });
  }

  // Collect the deleted node's parents and children BEFORE removing anything
  const allEdges = edgeRepo.findByCourse(ctx.courseId);
  const parentIds = allEdges
    .filter((e) => e.target_node_id === input.node_id)
    .map((e) => e.source_node_id);
  const childIds = allEdges
    .filter((e) => e.source_node_id === input.node_id)
    .map((e) => e.target_node_id);

  // Remove the node (edges are handled via cleanup below)
  nodeRepo.delete(input.node_id);

  // Rebuild edges: drop any edge referencing the deleted node, then bridge parent→child
  const cleanEdges = allEdges.filter(
    (e) => e.source_node_id !== input.node_id && e.target_node_id !== input.node_id,
  );
  // Add bridging edges (A→B→C: delete B → add A→C) if not already present
  const bridgeEdges: typeof cleanEdges = [];
  for (const parentId of parentIds) {
    for (const childId of childIds) {
      const alreadyExists = cleanEdges.some(
        (e) => e.source_node_id === parentId && e.target_node_id === childId,
      );
      if (!alreadyExists) {
        bridgeEdges.push({
          id:             randomUUID(),
          course_id:      ctx.courseId,
          source_node_id: parentId,
          target_node_id: childId,
          created_at:     new Date().toISOString(),
        });
      }
    }
  }
  edgeRepo.saveAll(ctx.courseId, [...cleanEdges, ...bridgeEdges]);

  // Remove the deleted node from other nodes' prerequisites and bridge via parents
  const db = getDb();
  const remaining = nodeRepo.findByCourse(ctx.courseId);
  for (const n of remaining) {
    if (n.prerequisites.includes(input.node_id)) {
      // Replace the deleted node in prerequisites with its parents (bridge)
      const withoutDeleted = n.prerequisites.filter((p) => p !== input.node_id);
      const bridged = [...new Set([...withoutDeleted, ...parentIds])];
      db.prepare(
        `UPDATE dag_nodes SET prerequisites = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(JSON.stringify(bridged), n.id);
    }
  }

  // Recalculate root nodes (no incoming edges) → set to 'available'
  const edges = edgeRepo.findByCourse(ctx.courseId);
  const hasIncoming = new Set(edges.map((e) => e.target_node_id));
  for (const n of nodeRepo.findByCourse(ctx.courseId)) {
    if (!hasIncoming.has(n.id) && n.status === 'locked') {
      nodeRepo.updateStatus(n.id, 'available');
    }
  }

  pushDagUpdate(ctx.courseId, ctx);
  return JSON.stringify({
    success: true,
    message: `已删除节点「${node.name}」` +
      (bridgeEdges.length > 0
        ? `，已自动连接 ${bridgeEdges.length} 条桥接边（继承原有依赖关系）。`
        : '。'),
  });
}

// ── connect_nodes ─────────────────────────────────────────────────────────────

interface ConnectNodesInput {
  source_node_id: string;
  target_node_id: string;
}

function connectNodes(input: ConnectNodesInput, ctx: DagToolContext): string {
  const source = nodeRepo.findById(input.source_node_id);
  const target = nodeRepo.findById(input.target_node_id);
  if (!source) return JSON.stringify({ success: false, message: `源节点不存在: ${input.source_node_id}` });
  if (!target) return JSON.stringify({ success: false, message: `目标节点不存在: ${input.target_node_id}` });
  if (source.course_id !== ctx.courseId || target.course_id !== ctx.courseId) {
    return JSON.stringify({ success: false, message: '节点不属于当前课程' });
  }
  if (input.source_node_id === input.target_node_id) {
    return JSON.stringify({ success: false, message: '不能将节点连接到自身' });
  }

  const existingEdges = edgeRepo.findByCourse(ctx.courseId);
  const alreadyExists = existingEdges.some(
    (e) => e.source_node_id === input.source_node_id && e.target_node_id === input.target_node_id,
  );
  if (alreadyExists) {
    return JSON.stringify({ success: false, message: `边「${source.name}」→「${target.name}」已存在` });
  }

  const newEdge = {
    id:             randomUUID(),
    course_id:      ctx.courseId,
    source_node_id: input.source_node_id,
    target_node_id: input.target_node_id,
  };
  edgeRepo.saveAll(ctx.courseId, [...existingEdges, newEdge]);

  // Update target node's prerequisites
  const db = getDb();
  const updatedPrereqs = [...new Set([...target.prerequisites, input.source_node_id])];
  db.prepare(
    `UPDATE dag_nodes SET prerequisites = ?, status = 'locked', updated_at = datetime('now') WHERE id = ?`
  ).run(JSON.stringify(updatedPrereqs), target.id);

  pushDagUpdate(ctx.courseId, ctx);
  return JSON.stringify({
    success: true,
    message: `已连接「${source.name}」→「${target.name}」。`,
  });
}

// ── update_node ───────────────────────────────────────────────────────────────

interface UpdateNodeInput {
  node_id: string;
  name?: string;
  description?: string;
  difficulty?: string;
  hours_est?: number;
  chapter?: string;
  node_type?: string;
}

function updateNode(input: UpdateNodeInput, ctx: DagToolContext): string {
  const node = nodeRepo.findById(input.node_id);
  if (!node) return JSON.stringify({ success: false, message: `节点不存在: ${input.node_id}` });
  if (node.course_id !== ctx.courseId) {
    return JSON.stringify({ success: false, message: '无法操作其他课程的节点' });
  }

  const updated = nodeRepo.update(input.node_id, {
    ...(input.name        !== undefined && { name:        input.name }),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.difficulty  !== undefined && { difficulty:  input.difficulty as Difficulty }),
    ...(input.hours_est   !== undefined && { hours_est:   input.hours_est }),
    ...(input.chapter     !== undefined && { chapter:     input.chapter }),
    ...(input.node_type   !== undefined && { node_type:   input.node_type as NodeType }),
  });

  pushDagUpdate(ctx.courseId, ctx);
  return JSON.stringify({
    success: true,
    message: `已更新节点「${updated.name}」`,
  });
}
