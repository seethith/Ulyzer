/**
 * DAG edit tools used by MainTutor chat.
 *
 * These definitions are adapted into the shared tool catalog/registry pipeline,
 * then filtered by the main tutor profile and centralized tool permissions.
 */
import { randomUUID } from 'crypto';
import { IPC } from '@shared/ipc-channels';
import { normalizeDagEdges } from '@shared/dag-graph';
import type { DagEdge, DagNode, Difficulty, NodeStatus, NodeType, SearchMode } from '@shared/types';
import type { ToolDef, ToolCallBlock } from '../../llm/adapter';
import { localizeToolDefinition } from '../../agent-i18n/tool-descriptions';
import { createToolCatalogFromDefs } from '../tool-catalog';
import { NodeRepository, EdgeRepository } from '../../db/repositories/node.repo';
import { NodeHandoffRepository } from '../../db/repositories/node-handoff.repo';
import { getDb } from '../../db/sqlite';
import { collectEvidencePack, formatEvidencePack } from '../../web/research-pipeline';
import { fetchUrlForAgent } from '../../web/web-fetch';
import { CourseRepository } from '../../db/repositories/course.repo';
import { verifyDagAcyclic } from '../../agent-verifiers/dag.verifier';
import { readSourceForAgent, searchLibraryForAgent } from '../library-tools.shared';
import { deletePrivateSourcesForNode } from '../../source/source-library';
import { blockLibraryMessage, blockWebMessage } from '../search-mode-guard';
import { recomputeCourseDagProgress } from '../../dag/dag-progress';
import type { AgentRunContext } from '../../agent-core/run-context';
import { applyWriteTodos, type TaskList } from '../../agent-core/task-list';

export interface DagToolContext {
  courseId: string;
  sessionId: string;
  sender: Electron.WebContents;
  provider?: string;
  model?: string;
  searchMode?: SearchMode;
  language?: string;
  runContext?: AgentRunContext;
  /** Per-run task checklist maintained via write_todos; drives the loop's completion gate. */
  taskList?: TaskList;
  /** Callback to trigger full DAG generation (injected by handleChat) */
  runDagGeneration?: (topic: string) => Promise<{ nodeCount: number; chapterNames: string[] }>;
}

const nodeRepo = new NodeRepository();
const edgeRepo = new EdgeRepository();
const courseRepo = new CourseRepository();
const handoffRepo = new NodeHandoffRepository();
type PersistableDagEdge = Omit<DagEdge, 'created_at'> & Partial<Pick<DagEdge, 'created_at'>>;

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

function normalizeCourseEdges(nodes: Array<{ id: string }>, edges: PersistableDagEdge[]): PersistableDagEdge[] {
  return normalizeDagEdges(nodes, edges, {
    getSource: (edge) => edge.source_node_id,
    getTarget: (edge) => edge.target_node_id,
  }).edges;
}

function syncPrerequisitesFromEdges(nodes: Array<{ id: string }>, edges: PersistableDagEdge[]): void {
  const prerequisitesByNode = new Map<string, string[]>();
  for (const node of nodes) prerequisitesByNode.set(node.id, []);
  for (const edge of edges) {
    const current = prerequisitesByNode.get(edge.target_node_id);
    if (current && !current.includes(edge.source_node_id)) current.push(edge.source_node_id);
  }

  const db = getDb();
  const update = db.prepare(
    `UPDATE dag_nodes SET prerequisites = ?, updated_at = datetime('now') WHERE id = ?`,
  );
  for (const node of nodes) {
    update.run(JSON.stringify(prerequisitesByNode.get(node.id) ?? []), node.id);
  }
}

function saveNormalizedCourseEdges(courseId: string, nodes: Array<{ id: string }>, edges: PersistableDagEdge[]): PersistableDagEdge[] {
  const normalizedEdges = normalizeCourseEdges(nodes, edges);
  edgeRepo.saveAll(courseId, normalizedEdges);
  syncPrerequisitesFromEdges(nodes, normalizedEdges);
  recomputeCourseDagProgress(courseId);
  return normalizedEdges;
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

const DIFFICULTIES: Difficulty[] = ['beginner', 'intermediate', 'advanced'];
const NODE_TYPES: NodeType[] = ['main', 'boss'];
const BATCH_ADD_LIMIT = 12;

function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === 'string' && (DIFFICULTIES as string[]).includes(value);
}

function isNodeType(value: unknown): value is NodeType {
  return typeof value === 'string' && (NODE_TYPES as string[]).includes(value);
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
    : [];
}

function truncateText(value: string | null | undefined, max = 160): string | null {
  const text = value?.trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function chapterIndexMap(nodes: DagNode[]): Map<string, number> {
  const chapters = new Map<string, number>();
  for (const node of nodes) {
    if (!chapters.has(node.chapter)) chapters.set(node.chapter, chapters.size);
  }
  return chapters;
}

function nodePosition(chapterIndex: number, chapterOrder: number): { x: number; y: number } {
  const CHAPTER_GAP_X = 260;
  const NODE_GAP_Y = 130;
  const MARGIN_X = 80;
  const MARGIN_Y = 80;
  return {
    x: chapterIndex * CHAPTER_GAP_X + MARGIN_X,
    y: chapterOrder * NODE_GAP_Y + MARGIN_Y,
  };
}

// ── Tool schemas ──────────────────────────────────────────────────────────────

export function buildDagToolDefs(language?: string): ToolDef[] {
  const toolDefs: ToolDef[] = [
    {
      name: 'read_roadmap',
      description:
        '【做什么】读取当前课程路线图的最新事实快照，返回章节、节点 ID、状态、难度和前置依赖。' +
        '【何时调用】需要确认最新节点列表、节点 ID、章节结构或依赖关系时调用；如果上下文可能过旧或缺少 ID，优先调用本工具。' +
        '【限制】只返回事实数据，不分析路线质量；结构质量分析请调用 analyze_dag。',
      inputSchema: {
        type: 'object',
        properties: {
          chapter:       { type: 'string', description: '可选，只读取指定章节；不填则读取全路线图' },
          include_edges: { type: 'boolean', description: '是否返回依赖边列表，默认 true' },
        },
      },
    },
    {
      name: 'add_node',
      description:
        '【做什么】在课程路线图中新增一个知识节点，自动连接前置依赖边，路线图实时刷新。' +
        '【何时调用】用户说"加个节点"/"加一下X"/"补充X这个知识点"/"路线里加上X"/"我还想学X"/"添加X到路线"，或 AI 规划路线时需要补充内容时。' +
        '【关键】prerequisites 必须填写上下文中列出的节点 UUID（格式 "ID: xxx-xxx-xxx"），且只填写直接前置依赖；如果已有 A→B→C，不要再填 A→C 这类传递冗余依赖。' +
        '【限制】只能操作当前课程；单个节点用本工具，一次新增多个节点时优先用 batch_add_nodes。',
      inputSchema: {
        type: 'object',
        properties: {
          name:           { type: 'string', description: '节点名称，简洁清晰（≤20字）' },
          chapter:        { type: 'string', description: '所属章节名称（必须与现有章节一致，或新章节名）' },
          description:    { type: 'string', description: '节点内容描述（1-2句话）' },
          difficulty:     { type: 'string', enum: ['beginner', 'intermediate', 'advanced'], description: '难度级别' },
          node_type:      { type: 'string', enum: ['main', 'boss'], description: '节点类型，普通节点用 main，综合考核用 boss' },
          prerequisites:  { type: 'array', items: { type: 'string' }, description: '直接前置节点 UUID 列表，从当前路线图上下文获取；不要填写传递冗余上游节点' },
          source_ids:     { type: 'array', items: { type: 'string' }, description: '规划依据来源 ID 列表，从 web_search 返回的 source_id 复制；无来源时为空数组' },
          rationale:      { type: 'string', description: '为什么加入该节点及其依赖位置；只说明学习价值或编排理由' },
        },
        required: ['name', 'chapter'],
      },
    },
    {
      name: 'batch_add_nodes',
      description:
        '【做什么】一次性批量新增多个路线图节点，并统一建立依赖边，路线图实时刷新。' +
        '【何时调用】用户要求扩展某章、补充多个知识点、新增一整章或一次添加 2 个以上节点时优先调用。' +
        '【关键】每个新节点必须有唯一 temp_id；prerequisites 可引用已有节点 UUID，也可引用本批次 temp_id，但只填写直接前置依赖，避免传递冗余边。' +
        '【限制】每次 1-12 个节点；整批事务写入，任一节点或依赖非法则整体失败。',
      inputSchema: {
        type: 'object',
        properties: {
          nodes: {
            type: 'array',
            minItems: 1,
            maxItems: BATCH_ADD_LIMIT,
            description: '要新增的节点数组，按学习顺序排列',
            items: {
              type: 'object',
              properties: {
                temp_id:       { type: 'string', description: '本批次内唯一临时 ID，如 n1、n2；供同批次 prerequisites 引用' },
                name:          { type: 'string', description: '节点名称，简洁清晰（≤20字）' },
                chapter:       { type: 'string', description: '所属章节名称（必须与现有章节一致，或新章节名）' },
                description:   { type: 'string', description: '节点内容描述（1-2句话）' },
                difficulty:    { type: 'string', enum: ['beginner', 'intermediate', 'advanced'], description: '难度级别' },
                node_type:     { type: 'string', enum: ['main', 'boss'], description: '节点类型，普通节点用 main，综合考核用 boss' },
                prerequisites: { type: 'array', items: { type: 'string' }, description: '直接前置依赖，可填已有节点 UUID 或同批次 temp_id；不要填写传递冗余上游节点' },
                source_ids:    { type: 'array', items: { type: 'string' }, description: '规划依据来源 ID 列表；无来源时为空数组' },
                rationale:     { type: 'string', description: '为什么加入该节点及其依赖位置；只说明学习价值或编排理由' },
              },
              required: ['temp_id', 'name', 'chapter'],
            },
          },
        },
        required: ['nodes'],
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
        '【限制】只能创建直接前置依赖；不能创建已存在的重复边、传递冗余边或环（会导致循环依赖）；需要从上下文获取节点 UUID。',
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
        '【重要】生成全新路线图时不要先调用 web_search、search_library 或 read_source；本工具内部会按当前搜索模式统一规划并检索证据。' +
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
      name: 'web_fetch',
      description:
        '抓取用户提供的网页链接，返回清洗后的正文内容（不需要搜索 API）。用户在对话中粘贴了某个网址（博客、官方文档、Stack Overflow、GitHub README 等）希望你阅读/讲解时，或 web_search 返回结果后需要深入读取某条来源正文时调用。只支持 http/https，禁止本地/内网地址；一次只抓一个链接，不要用它做关键词搜索（用 web_search）。',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的网页完整链接（必须以 http:// 或 https:// 开头）' },
        },
        required: ['url'],
      },
    },
    {
      name: 'search_library',
      description:
        '检索当前课程参考库，返回资料来源、AI 概览（资料语义预处理）和相关片段。先依据 AI 概览判断资料是否相关，需要具体页/段落时再调用 read_source。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '参考库检索关键词或问题' },
          limit: { type: 'number', description: '返回参考资料条数，1-8，默认 5' },
        },
        required: ['query'],
      },
    },
    {
      name: 'read_source',
      description:
        '展开阅读某条资料的更完整片段。通常先用 search_library 查看 AI 概览并找到 source_id；确认需要正文细节后，再对 PDF/文档指定 page、page_start/page_end 或 unit_index 精读具体范围。',
      inputSchema: {
        type: 'object',
        properties: {
          source_id: { type: 'string', description: 'search_library 返回的 source_id' },
          max_chunks: { type: 'number', description: '展开片段数，1-8，默认 5' },
          page: { type: 'number', description: '读取单页页码，适用于 PDF 等分页文档' },
          page_start: { type: 'number', description: '读取页码范围起点，适用于 PDF 等分页文档' },
          page_end: { type: 'number', description: '读取页码范围终点，适用于 PDF 等分页文档' },
          unit_index: { type: 'number', description: '读取结构化文档单元索引，0 开始；适用于非分页文档' },
          max_blocks: { type: 'number', description: '最多返回内容块数量，1-120，默认 36' },
        },
        required: ['source_id'],
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
          chapter:        { type: 'string', description: '修改所属章节' },
          node_type:      { type: 'string', enum: ['main', 'boss'] },
          source_ids:     { type: 'array', items: { type: 'string' }, description: '更新规划依据来源 ID 列表' },
          rationale:      { type: 'string', description: '更新规划依据说明' },
        },
        required: ['node_id'],
      },
    },
    {
      name: 'write_todos',
      description:
        '维护一份贯穿整个任务的待办清单，让多步骤规划工作进度清晰可见。每次调用都用完整列表覆盖旧列表；只要清单里还有 pending/in_progress 项，系统就会让你继续工作而不会提前结束。',
      inputSchema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '完整的待办项数组',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
              },
              required: ['content'],
            },
          },
        },
        required: ['todos'],
      },
    },
  ];

  return toolDefs.map((tool) => {
    const localized = localizeToolDefinition(tool.name, tool.description, tool.inputSchema, language);
    return { ...tool, ...localized };
  });
}

export function buildDagToolRegistry(language?: string) {
  return createToolCatalogFromDefs<DagToolContext>('dag', buildDagToolDefs(language), executeDagTool).toRegistry();
}

// ── Tool execution ────────────────────────────────────────────────────────────

export async function executeDagTool(
  call: ToolCallBlock,
  ctx: DagToolContext,
): Promise<string> {
  const { name, input } = call;

  try {
    if (name === 'read_roadmap') {
      return readRoadmap(input as unknown as ReadRoadmapInput, ctx);
    }
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
    if (name === 'web_fetch') {
      return webFetch(input as { url: string }, ctx);
    }
    if (name === 'search_library') {
      return searchLibrary(input as { query: string; limit?: number }, ctx);
    }
    if (name === 'read_source') {
      return readSource(input as {
        source_id: string;
        max_chunks?: number;
        page?: number;
        page_start?: number;
        page_end?: number;
        unit_index?: number;
        max_blocks?: number;
      }, ctx);
    }
    if (name === 'add_node') {
      return addNode(input as unknown as AddNodeInput, ctx);
    }
    if (name === 'batch_add_nodes') {
      return batchAddNodes(input as unknown as BatchAddNodesInput, ctx);
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
    if (name === 'write_todos') {
      return applyWriteTodos(ctx.taskList, input as { todos?: Array<{ content?: unknown; status?: unknown }> }, ctx.language);
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

// ── read_roadmap ──────────────────────────────────────────────────────────────

interface ReadRoadmapInput {
  chapter?: string;
  include_edges?: boolean;
}

function readRoadmap(input: ReadRoadmapInput, ctx: DagToolContext): string {
  const allNodes = nodeRepo.findByCourse(ctx.courseId);
  const allEdges = edgeRepo.findByCourse(ctx.courseId);
  const chapterFilter = cleanString(input?.chapter);
  const nodes = chapterFilter
    ? allNodes.filter((node) => node.chapter === chapterFilter)
    : allNodes;
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  const includedIds = new Set(nodes.map((node) => node.id));
  const chapters = new Map<string, DagNode[]>();

  for (const node of nodes) {
    if (!chapters.has(node.chapter)) chapters.set(node.chapter, []);
    chapters.get(node.chapter)!.push(node);
  }

  const includeEdges = input?.include_edges !== false;
  const edges = includeEdges
    ? allEdges
        .filter((edge) => !chapterFilter || (includedIds.has(edge.source_node_id) && includedIds.has(edge.target_node_id)))
        .map((edge) => ({
          id: edge.id,
          source: edge.source_node_id,
          source_name: nodeById.get(edge.source_node_id)?.name ?? null,
          target: edge.target_node_id,
          target_name: nodeById.get(edge.target_node_id)?.name ?? null,
        }))
    : undefined;

  return JSON.stringify({
    success: true,
    course_id: ctx.courseId,
    total_nodes: allNodes.length,
    returned_nodes: nodes.length,
    chapter_filter: chapterFilter || null,
    chapters: [...chapters.entries()].map(([name, chapterNodes]) => ({
      name,
      nodes: [...chapterNodes]
        .sort((a, b) => (a.chapter_order ?? 0) - (b.chapter_order ?? 0))
        .map((node) => ({
          id: node.id,
          name: node.name,
          chapter: node.chapter,
          chapter_order: node.chapter_order,
          node_type: node.node_type,
          status: node.status,
          difficulty: node.difficulty,
          description: truncateText(node.description),
          prerequisites: node.prerequisites.map((id) => ({
            id,
            name: nodeById.get(id)?.name ?? null,
          })),
          source_ids: node.source_ids ?? [],
          rationale: truncateText(node.rationale),
        })),
    })),
    ...(includeEdges ? { edges } : {}),
  }, null, 2);
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
  }));

  const diffDist: Record<string, number> = { beginner: 0, intermediate: 0, advanced: 0 };
  for (const n of nodes) { if (n.difficulty in diffDist) diffDist[n.difficulty]++; }

  const doneCount = nodes.filter((n) => n.status === 'done').length;
  const chaptersNoBoss = chapterStats.filter((c) => !c.hasBoss).map((c) => c.name);

  return JSON.stringify({
    total_nodes: nodes.length,
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
  const blocked = blockWebMessage(ctx.searchMode);
  if (blocked) return blocked;
  const maxResults = Math.min(input.maxResults ?? 3, 5);
  const pack = await collectEvidencePack({
    query: input.query,
    courseId: ctx.courseId,
    mode: 'web',
    taskType: 'roadmap',
    maxWebResults: maxResults,
    provider: ctx.provider,
    model: ctx.model,
    language: 'zh',
    onUsage: (usage) => ctx.runContext?.addUsage(usage),
  });
  return formatEvidencePack(pack, 'zh') || '未找到相关结果';
}

async function webFetch(
  input: { url: string },
  ctx: DagToolContext,
): Promise<string> {
  const blocked = blockWebMessage(ctx.searchMode, ctx.language);
  if (blocked) return blocked;
  const res = await fetchUrlForAgent({ url: input.url, language: ctx.language });
  return res.summary;
}

async function searchLibrary(
  input: { query: string; limit?: number },
  ctx: DagToolContext,
): Promise<string> {
  const blocked = blockLibraryMessage(ctx.searchMode);
  if (blocked) return blocked;
  return searchLibraryForAgent({
    courseId: ctx.courseId,
    agentType: 'main_tutor',
    query: input.query,
    limit: input.limit,
    provider: ctx.provider,
    model: ctx.model,
    llmRerank: true,
    onUsage: (usage) => ctx.runContext?.addUsage(usage),
  });
}

async function readSource(
  input: {
    source_id: string;
    max_chunks?: number;
    page?: number;
    page_start?: number;
    page_end?: number;
    unit_index?: number;
    max_blocks?: number;
  },
  ctx: DagToolContext,
): Promise<string> {
  const blocked = blockLibraryMessage(ctx.searchMode);
  if (blocked) return blocked;
  return readSourceForAgent({
    courseId: ctx.courseId,
    agentType: 'main_tutor',
    sourceId: input.source_id,
    maxChunks: input.max_chunks,
    page: input.page,
    pageStart: input.page_start,
    pageEnd: input.page_end,
    unitIndex: input.unit_index,
    maxBlocks: input.max_blocks,
  });
}

// ── add_node ──────────────────────────────────────────────────────────────────

interface AddNodeInput {
  name: string;
  chapter: string;
  description?: string;
  difficulty?: string;
  node_type?: string;
  prerequisites?: string[];
  source_ids?: string[];
  rationale?: string;
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
    difficulty:    (input.difficulty as Difficulty) ?? 'intermediate',
    prerequisites: validPrereqs,
    required_tools: [],
    required_cost:  {},
    position_x:    pos.x,
    position_y:    pos.y,
    source_ids:    input.source_ids ?? [],
    rationale:     input.rationale,
  });
  handoffRepo.syncFromNode(newNode, courseRepo.findById(ctx.courseId));

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
    saveNormalizedCourseEdges(ctx.courseId, [...allNodes, newNode], newEdges);
  }
  recomputeCourseDagProgress(ctx.courseId);

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

// ── batch_add_nodes ───────────────────────────────────────────────────────────

interface BatchAddNodeInput {
  temp_id: string;
  name: string;
  chapter: string;
  description?: string;
  difficulty?: string;
  node_type?: string;
  prerequisites?: string[];
  source_ids?: string[];
  rationale?: string;
}

interface BatchAddNodesInput {
  nodes?: BatchAddNodeInput[];
}

interface NormalizedBatchNode {
  tempId: string;
  realId: string;
  name: string;
  chapter: string;
  description?: string;
  difficulty: Difficulty;
  nodeType: NodeType;
  prerequisites: string[];
  sourceIds: string[];
  rationale?: string;
  chapterOrder: number;
  position: { x: number; y: number };
}

function failBatchAdd(errors: string[]): string {
  return JSON.stringify({
    success: false,
    errors,
    message: `批量新增节点失败：${errors.join('；')}`,
  }, null, 2);
}

function normalizeBatchNodes(
  input: BatchAddNodesInput,
  existingNodes: DagNode[],
): { nodes: NormalizedBatchNode[]; errors: string[] } {
  const rawNodes = Array.isArray(input?.nodes) ? input.nodes : [];
  const errors: string[] = [];
  if (rawNodes.length === 0) errors.push('nodes 不能为空');
  if (rawNodes.length > BATCH_ADD_LIMIT) errors.push(`一次最多新增 ${BATCH_ADD_LIMIT} 个节点`);

  const existingIds = new Set(existingNodes.map((node) => node.id));
  const tempIds = new Set<string>();
  const normalizedBase: Array<Omit<NormalizedBatchNode, 'realId' | 'chapterOrder' | 'position'>> = [];

  rawNodes.slice(0, BATCH_ADD_LIMIT).forEach((raw, index) => {
    const tempId = cleanString(raw?.temp_id);
    const name = cleanString(raw?.name);
    const chapter = cleanString(raw?.chapter);
    const label = tempId || `第 ${index + 1} 个节点`;

    if (!tempId) errors.push(`${label}: temp_id 必填`);
    if (tempId && tempIds.has(tempId)) errors.push(`${label}: temp_id 重复`);
    if (tempId) tempIds.add(tempId);
    if (!name) errors.push(`${label}: name 必填`);
    if (!chapter) errors.push(`${label}: chapter 必填`);

    const rawDifficulty = raw?.difficulty;
    const difficulty = rawDifficulty === undefined || rawDifficulty === ''
      ? 'intermediate'
      : rawDifficulty;
    if (!isDifficulty(difficulty)) {
      errors.push(`${label}: difficulty 必须是 ${DIFFICULTIES.join('/')}`);
    }

    const rawNodeType = raw?.node_type;
    const nodeType = rawNodeType === undefined || rawNodeType === ''
      ? 'main'
      : rawNodeType;
    if (!isNodeType(nodeType)) {
      errors.push(`${label}: node_type 必须是 ${NODE_TYPES.join('/')}`);
    }

    normalizedBase.push({
      tempId,
      name,
      chapter,
      description: cleanString(raw?.description) || undefined,
      difficulty: isDifficulty(difficulty) ? difficulty : 'intermediate',
      nodeType: isNodeType(nodeType) ? nodeType : 'main',
      prerequisites: cleanStringArray(raw?.prerequisites),
      sourceIds: cleanStringArray(raw?.source_ids),
      rationale: cleanString(raw?.rationale) || undefined,
    });
  });

  for (const node of normalizedBase) {
    for (const prereq of node.prerequisites) {
      if (prereq === node.tempId) {
        errors.push(`${node.tempId}: 不能依赖自身`);
      } else if (!existingIds.has(prereq) && !tempIds.has(prereq)) {
        errors.push(`${node.tempId}: prerequisite 不存在：${prereq}`);
      }
    }
  }

  const chapters = chapterIndexMap(existingNodes);
  const chapterOrders = new Map<string, number>();
  for (const existing of existingNodes) {
    chapterOrders.set(existing.chapter, Math.max(chapterOrders.get(existing.chapter) ?? -1, existing.chapter_order ?? 0));
  }

  const nodes = normalizedBase.map((node): NormalizedBatchNode => {
    if (!chapters.has(node.chapter)) chapters.set(node.chapter, chapters.size);
    const chapterOrder = (chapterOrders.get(node.chapter) ?? -1) + 1;
    chapterOrders.set(node.chapter, chapterOrder);
    return {
      ...node,
      realId: randomUUID(),
      chapterOrder,
      position: nodePosition(chapters.get(node.chapter) ?? 0, chapterOrder),
    };
  });

  return { nodes, errors };
}

function batchAddNodes(input: BatchAddNodesInput, ctx: DagToolContext): string {
  const existingNodes = nodeRepo.findByCourse(ctx.courseId);
  const existingEdges = edgeRepo.findByCourse(ctx.courseId);
  const { nodes, errors } = normalizeBatchNodes(input, existingNodes);
  if (errors.length > 0) return failBatchAdd(errors);

  const idMap = new Map(nodes.map((node) => [node.tempId, node.realId]));
  const idMapObject = Object.fromEntries(idMap.entries());
  const realPrereqIdsByNode = new Map<string, string[]>();
  const newEdges: Array<Omit<DagEdge, 'created_at'>> = [];

  for (const node of nodes) {
    const realPrereqs = node.prerequisites.map((id) => idMap.get(id) ?? id);
    realPrereqIdsByNode.set(node.tempId, realPrereqs);
    for (const prereqId of realPrereqs) {
      newEdges.push({
        id: randomUUID(),
        course_id: ctx.courseId,
        source_node_id: prereqId,
        target_node_id: node.realId,
      });
    }
  }

  const candidateNodes = [
    ...existingNodes,
    ...nodes.map((node) => ({
      id: node.realId,
      name: node.name,
    })),
  ];
  const candidateEdges: Array<Omit<DagEdge, 'created_at'>> = [
    ...existingEdges,
    ...newEdges,
  ];
  const acyclic = verifyDagAcyclic(candidateNodes, candidateEdges);
  if (!acyclic.passed) {
    return JSON.stringify({
      success: false,
      verifier: acyclic.verifier,
      issues: acyclic.issues,
      message: '批量新增节点失败：新增依赖会形成循环或引用未知节点。',
    }, null, 2);
  }

  const createdNodes: DagNode[] = [];
  const db = getDb();
  const course = courseRepo.findById(ctx.courseId);
  const insertEdge = db.prepare(
    `INSERT INTO dag_edges (id, course_id, source_node_id, target_node_id)
     VALUES (@id, @course_id, @source_node_id, @target_node_id)`,
  );
  const normalizedCandidateEdges = normalizeCourseEdges(candidateNodes, candidateEdges);

  db.transaction(() => {
    for (const node of nodes) {
      const realPrereqs = realPrereqIdsByNode.get(node.tempId) ?? [];
      const status: NodeStatus = realPrereqs.length > 0 ? 'locked' : 'available';
      const created = nodeRepo.create({
        id: node.realId,
        course_id: ctx.courseId,
        chapter: node.chapter,
        chapter_order: node.chapterOrder,
        name: node.name,
        description: node.description,
        node_type: node.nodeType,
        status,
        difficulty: node.difficulty,
        prerequisites: realPrereqs,
        required_tools: [],
        required_cost: {},
        position_x: node.position.x,
        position_y: node.position.y,
        source_ids: node.sourceIds,
        rationale: node.rationale,
      });
      createdNodes.push(created);
      handoffRepo.syncFromNode(created, course);
    }

    db.prepare('DELETE FROM dag_edges WHERE course_id = ?').run(ctx.courseId);
    for (const edge of normalizedCandidateEdges) {
      insertEdge.run(edge);
    }
  })();
  syncPrerequisitesFromEdges([...existingNodes, ...createdNodes], normalizedCandidateEdges);

  pushDagUpdate(ctx.courseId, ctx);
  return JSON.stringify({
    success: true,
    created_count: createdNodes.length,
    edge_count: normalizedCandidateEdges.length - existingEdges.length,
    id_map: idMapObject,
    created_nodes: createdNodes.map((node) => ({
      id: node.id,
      temp_id: nodes.find((candidate) => candidate.realId === node.id)?.tempId,
      name: node.name,
      chapter: node.chapter,
      chapter_order: node.chapter_order,
      node_type: node.node_type,
      difficulty: node.difficulty,
      prerequisites: node.prerequisites,
    })),
    message: `已批量添加 ${createdNodes.length} 个节点，并连接 ${Math.max(normalizedCandidateEdges.length - existingEdges.length, 0)} 条直接依赖边。`,
  }, null, 2);
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
  deletePrivateSourcesForNode(input.node_id);
  nodeRepo.delete(input.node_id);
  handoffRepo.delete(input.node_id);

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
  saveNormalizedCourseEdges(ctx.courseId, nodeRepo.findByCourse(ctx.courseId), [...cleanEdges, ...bridgeEdges]);

  recomputeCourseDagProgress(ctx.courseId);

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
  const candidateEdges = [...existingEdges, newEdge];
  const acyclic = verifyDagAcyclic(nodeRepo.findByCourse(ctx.courseId), candidateEdges);
  if (!acyclic.passed) {
    return JSON.stringify({
      success: false,
      verifier: acyclic.verifier,
      message: `不能连接「${source.name}」→「${target.name}」：会形成循环依赖。`,
      issues: acyclic.issues,
    });
  }

  const normalizedEdges = saveNormalizedCourseEdges(ctx.courseId, nodeRepo.findByCourse(ctx.courseId), candidateEdges);
  const directEdgeKept = normalizedEdges.some(
    (edge) => edge.source_node_id === input.source_node_id && edge.target_node_id === input.target_node_id,
  );
  pushDagUpdate(ctx.courseId, ctx);
  return JSON.stringify({
    success: true,
    message: directEdgeKept
      ? `已连接「${source.name}」→「${target.name}」。`
      : `「${source.name}」已可通过现有路径到达「${target.name}」，未新增冗余直连。`,
  });
}

// ── update_node ───────────────────────────────────────────────────────────────

interface UpdateNodeInput {
  node_id: string;
  name?: string;
  description?: string;
  difficulty?: string;
  chapter?: string;
  node_type?: string;
  source_ids?: string[];
  rationale?: string;
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
    ...(input.chapter     !== undefined && { chapter:     input.chapter }),
    ...(input.node_type   !== undefined && { node_type:   input.node_type as NodeType }),
    ...(input.source_ids  !== undefined && { source_ids:  input.source_ids }),
    ...(input.rationale   !== undefined && { rationale:   input.rationale }),
  });
  handoffRepo.syncFromNode(updated, courseRepo.findById(ctx.courseId));

  pushDagUpdate(ctx.courseId, ctx);
  return JSON.stringify({
    success: true,
    message: `已更新节点「${updated.name}」`,
  });
}
