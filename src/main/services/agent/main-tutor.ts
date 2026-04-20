import { randomUUID } from 'crypto';
import * as path from 'path';
import { IPC } from '@shared/ipc-channels';
import type { DagGraph, DagNode, NodeType, Difficulty, BloomTarget, LearningType, NodePriority, RequiredCost, CreateNodeDto, TokenUsage } from '@shared/types';
import { LLMAdapter } from '../llm/adapter';
import type { ToolTurnMessage } from '../llm/adapter';
import { getCourseDir, writeFileContent } from '../fs/content.service';
import { NodeRepository, EdgeRepository } from '../db/repositories/node.repo';
import { CourseRepository } from '../db/repositories/course.repo';
import { getDb } from '../db/sqlite';
import { compressHistory } from './agent-loop';
import { createLogger } from '../../utils/logger';

const log = createLogger('MainTutor');
import type { AgentRequest } from './orchestrator';
import { buildSystemPrompt, roleLayer, languageLayer, localMsg } from '../prompt/prompt-builder';
import { isCommand, resolveCommand } from '../commands/registry';
import { buildDagToolDefs, executeDagTool } from './dag-tools/index';
import type { DagToolContext } from './dag-tools/index';

const nodeRepo = new NodeRepository();
const edgeRepo = new EdgeRepository();
const courseRepo = new CourseRepository();

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeSend(sender: Electron.WebContents, channel: string, data: unknown): void {
  try {
    if (!sender.isDestroyed()) sender.send(channel, data);
  } catch {
    // window may have closed
  }
}

// ── Ability spec types ────────────────────────────────────────────────────────

interface KsaoSpec {
  knowledge: string[];
  skills: string[];
  abilities: string[];
  others: string[];
}
interface GagneCoverage {
  言语信息: string[];
  智识技能: string[];
  认知策略: string[];
  动作技能: string[];
  态度: string[];
  missing: string[];
}
interface AbilitySpec {
  terminal_performance: string;
  verification_evidence: string;
  scope?: 'micro' | 'standard' | 'comprehensive';
  goal_type?: 'job_interview' | 'hobby_project' | 'academic' | 'certification' | 'general';
  ksao: KsaoSpec;
  gagne_coverage: GagneCoverage;
  time_priority_split: { must: string[]; should: string[]; nice_to_have: string[] };
  search_queries: string[];
}

// ── DAG generation system prompt ──────────────────────────────────────────────

const DAG_GEN_SYSTEM_PROMPT = `你是一名专业学习路线规划师。你的任务是根据用户的学习目标和能力规格，生成一个结构化的知识图谱（DAG）。

工作流程：
1. 先调用 web_search 搜索 [能力规格] 中列出的 search_queries，参考权威课程结构
2. 综合搜索结果与能力规格进行路线规划
3. 最后直接输出合法 JSON，不要加任何 markdown 代码块或额外说明文字

节点字段规则：

bloom_target（必填）— 该节点要求学员达到的布鲁姆认知层级：
- "remember_understand"：以记忆/理解为主，靠近学习路径起点的基础概念节点
- "analyze_evaluate"：需要比较、分析、评估的节点
- "apply"：需要动手操作、实践、解题的节点（大多数节点应为此类）
- "create"：开放性综合任务、设计、创作，通常是 boss 节点

learning_type（必填）— Gagné 五类学习成果之一：
- "verbal_info"：以"知道是什么"为主（定义、原理、术语）
- "intellectual_skill"：以"知道怎么做"为主（推导、解题、分析）
- "cognitive_strategy"：学会如何学习和自我调试（元认知、研究方法）
- "motor_skill"：需要身体协调与操作（乐器演奏、实验操作、体育动作）
- "attitude"：审美判断、价值取向、习惯养成

priority（必填）— 来自能力规格的优先级分级：
- "must"：核心必学，路线完成度的底线
- "should"：重要但可推后，时间充裕时应完成
- "nice_to_have"：有余力再学，可折叠

完整性约束（输出前必须自检）：
1. KSAO 对齐：能力规格 ksao 中每项能力必须有至少一个节点覆盖
2. Gagné 覆盖：能力规格 gagne_coverage.missing 中列出的类型必须在路线中补充节点
3. 目标对齐：每个节点必须可追溯到 terminal_performance，无关节点不得出现
4. 图结构：有向无环图，每章末尾有 boss 节点，难度从 beginner 到 advanced 递进

输出必须是合法 JSON，不要加任何 markdown 代码块包裹。严格遵循以下示例结构：

{
  "chapters": [
    { "name": "基础入门", "order": 0 },
    { "name": "实践应用", "order": 1 }
  ],
  "nodes": [
    {
      "id": "node_basic_1",
      "chapter": "基础入门",
      "chapter_order": 0,
      "name": "核心概念理解",
      "description": "掌握该领域最基础的定义、原理与术语",
      "node_type": "main",
      "hours_est": 2.0,
      "difficulty": "beginner",
      "prerequisites": [],
      "required_tools": [],
      "required_cost": { "money": 0, "equipment": "无", "location": "家" },
      "bloom_target": "remember_understand",
      "learning_type": "verbal_info",
      "priority": "must"
    },
    {
      "id": "node_basic_2",
      "chapter": "基础入门",
      "chapter_order": 1,
      "name": "环境搭建与工具",
      "description": "安装必要工具，跑通第一个最小示例",
      "node_type": "main",
      "hours_est": 1.5,
      "difficulty": "beginner",
      "prerequisites": ["node_basic_1"],
      "required_tools": ["电脑"],
      "required_cost": { "money": 0, "equipment": "电脑", "location": "家" },
      "bloom_target": "apply",
      "learning_type": "intellectual_skill",
      "priority": "must"
    },
    {
      "id": "node_basic_boss",
      "chapter": "基础入门",
      "chapter_order": 2,
      "name": "基础综合考核",
      "description": "综合运用本章知识完成一个完整的小任务",
      "node_type": "boss",
      "hours_est": 3.0,
      "difficulty": "intermediate",
      "prerequisites": ["node_basic_1", "node_basic_2"],
      "required_tools": ["电脑"],
      "required_cost": { "money": 0, "equipment": "电脑", "location": "家" },
      "bloom_target": "create",
      "learning_type": "intellectual_skill",
      "priority": "must"
    },
    {
      "id": "node_practice_1",
      "chapter": "实践应用",
      "chapter_order": 0,
      "name": "真实项目实践",
      "description": "在真实场景中应用所学，解决实际问题",
      "node_type": "main",
      "hours_est": 4.0,
      "difficulty": "intermediate",
      "prerequisites": ["node_basic_boss"],
      "required_tools": ["电脑"],
      "required_cost": { "money": 0, "equipment": "电脑", "location": "家" },
      "bloom_target": "apply",
      "learning_type": "intellectual_skill",
      "priority": "should"
    },
    {
      "id": "node_practice_boss",
      "chapter": "实践应用",
      "chapter_order": 1,
      "name": "项目综合考核",
      "description": "独立完成一个完整项目，展示综合掌握程度",
      "node_type": "boss",
      "hours_est": 5.0,
      "difficulty": "advanced",
      "prerequisites": ["node_practice_1"],
      "required_tools": ["电脑"],
      "required_cost": { "money": 0, "equipment": "电脑", "location": "家" },
      "bloom_target": "create",
      "learning_type": "cognitive_strategy",
      "priority": "should"
    }
  ],
  "edges": [
    { "source": "node_basic_1",    "target": "node_basic_2" },
    { "source": "node_basic_2",    "target": "node_basic_boss" },
    { "source": "node_basic_boss", "target": "node_practice_1" },
    { "source": "node_practice_1", "target": "node_practice_boss" }
  ]
}

注意：
- 所有 id 必须唯一；edges 中的 source/target 必须都存在于 nodes 中；prerequisites 中引用的 id 也必须存在
- bloom_target / learning_type / priority 三个字段每个节点都必须填写`;

// ── Preprocessing system prompt ───────────────────────────────────────────────

const PREPROCESS_SYSTEM_PROMPT = `你是学习目标分解专家。基于用户的学习目标和档案，用逆向设计（UbD）+ KSAO 胜任力框架 + Gagné 五类学习成果，输出结构化能力规格 JSON。

分析步骤（思考过程不输出）：
1. 提炼终点表现（terminal_performance）：用户学完后能做什么具体的、可观察的事情？
2. 定义验收标准（verification_evidence）：什么表现能证明真正达到目标？
3. KSAO 四维展开：将终点能力拆解为知识/技能/能力/其他。
   若档案中有「已掌握主题」，直接从 KSAO 清单中排除对应的基础能力，节点数相应减少，不重复学已会的内容。
4. Gagné 五类检查：以上能力覆盖了哪几类？哪几类缺失（填入 missing）？
   - 言语信息（知道"是什么"）、智识技能（知道"怎么做"）、认知策略（如何学习和自我调试）
   - 动作技能（身体操作与协调）、态度（审美判断、价值取向）
5. 时间优先级分级：must（核心必学）、should（重要但可推后）、nice_to_have（有余力再学）
6. 课程规模判断（scope）——综合目标深度、KSAO 广度、用户时间预算三项（已排除已掌握内容后重新评估广度）：
   - "micro"：目标词含"了解/速成/快速/简单了解"，或时间预算 ≤ 2 周，或 must 能力 ≤ 5 项 → 路线节点目标 5-10 个
   - "standard"：目标词含"掌握/学会/学好"，或时间预算 1-2 个月，或 must 能力 6-15 项 → 路线节点目标 12-25 个
   - "comprehensive"：目标词含"精通/系统/深入/全面/专业"，或时间预算 3 个月以上，或 must 能力 > 15 项 → 路线节点目标 25-50 个
7. 推断目标类型（goal_type）：从用户目标判断学习动机 —— job_interview（面试/求职）/ hobby_project（兴趣/项目）/ academic（学术/课程作业）/ certification（考证/备考）/ general（通用）
8. 搜索词：3-5 个针对能力缺口的搜索关键词，用于搜索权威课程结构

只输出 JSON，不加任何说明文字：
{
  "terminal_performance": "能做什么（具体可观察）",
  "verification_evidence": "什么表现证明达到目标",
  "scope": "standard",
  "goal_type": "general",
  "ksao": {
    "knowledge": ["知识点1", "知识点2"],
    "skills": ["技能1", "技能2"],
    "abilities": ["底层能力1"],
    "others": ["态度/情境因素1"]
  },
  "gagne_coverage": {
    "言语信息": ["概念1"],
    "智识技能": ["方法1"],
    "认知策略": ["策略1"],
    "动作技能": [],
    "态度": [],
    "missing": []
  },
  "time_priority_split": {
    "must": ["核心能力1", "核心能力2"],
    "should": ["进阶能力1"],
    "nice_to_have": ["扩展能力1"]
  },
  "search_queries": ["query1 syllabus", "query2 course outline", "query3 curriculum"]
}`;

// ── Dynamic context layer ─────────────────────────────────────────────────────
// Dynamic layer — injects current course DAG node status as the first user message.
// Rebuilt on every chat turn so progress info stays fresh without breaking the cached system prompt.
function buildPlannerContext(courseId: string): string {
  const course = courseRepo.findById(courseId);
  const nodes  = nodeRepo.findByCourse(courseId);

  const profileLines: string[] = [];
  if (course?.goal_text)     profileLines.push(`学习目标：${course.goal_text}`);
  if (course?.known_topics)  profileLines.push(`已掌握主题：${course.known_topics}`);
  if (course?.time_budget)   profileLines.push(`时间预算：${course.time_budget}`);
  const profileSection = profileLines.length > 0
    ? `[用户学习档案]\n${profileLines.join('\n')}\n\n`
    : '[用户学习档案]\n（尚未填写，请在对话末尾引导用户补充目标和水平信息）\n\n';

  if (nodes.length === 0) return `${profileSection}[当前课程尚无路线图，可以告知用户先生成路线]`;

  const chapters = new Map<string, DagNode[]>();
  for (const n of nodes) {
    if (!chapters.has(n.chapter)) chapters.set(n.chapter, []);
    chapters.get(n.chapter)!.push(n);
  }

  const lines = [`${profileSection}[当前课程路线图]`, '（节点格式：状态 节点名（难度，学时，ID）— 调用 add_node 时 prerequisites 必须使用此处的 ID）'];
  for (const [chapter, chNodes] of chapters) {
    chNodes.sort((a, b) => (a.chapter_order ?? 0) - (b.chapter_order ?? 0));
    lines.push(`\n## ${chapter}`);
    for (const n of chNodes) {
      const icon = n.status === 'done' ? '✅' : n.status === 'active' ? '🔵' : '⬜';
      const prereqNames = (n.prerequisites ?? [])
        .map((pid) => nodes.find((x) => x.id === pid)?.name ?? pid)
        .join(', ');
      const prereqStr = prereqNames ? ` ← [${prereqNames}]` : '';
      lines.push(`${icon} ${n.name}（${n.difficulty}，${n.hours_est}h，ID: ${n.id}）${prereqStr}`);
    }
  }
  const done = nodes.filter((n) => n.status === 'done').length;
  lines.push(`\n已完成 ${done}/${nodes.length} 个节点。`);
  lines.push('规划建议：新节点应根据知识依赖关系设置 prerequisites，使路线图形成有向无环图（DAG）。');
  return lines.join('\n');
}

// ── DAG JSON types (from LLM output) ─────────────────────────────────────────

interface LlmNode {
  id: string;
  chapter: string;
  chapter_order?: number;
  name: string;
  description?: string;
  node_type?: string;
  hours_est?: number;
  difficulty?: string;
  prerequisites?: string[];
  required_tools?: string[];
  required_cost?: RequiredCost;
  bloom_target?: string;
  learning_type?: string;
  priority?: string;
}

interface LlmEdge {
  source: string;
  target: string;
}

interface ChapterScopeEntry {
  nodes: string[];
  scope_distribution: Record<string, string[]>;
  boundary_notes?: string;
}

interface LlmDagOutput {
  nodes: LlmNode[];
  edges: LlmEdge[];
}

// ── JSON parsing & validation ─────────────────────────────────────────────────

function parseDagJson(raw: string): LlmDagOutput {
  let text = raw.trim();

  // Extract from markdown code block if wrapped
  const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    text = jsonBlockMatch[1].trim();
  }

  // Extract the JSON object — trim preamble before '{' and trailing text after last '}'
  const firstBrace = text.indexOf('{');
  const lastBrace  = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  } else if (firstBrace > 0) {
    text = text.slice(firstBrace);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('LLM 返回的内容不是有效 JSON，请重新生成');
  }

  if (typeof data !== 'object' || data === null) {
    throw new Error('DAG 数据格式错误');
  }

  const obj = data as Record<string, unknown>;

  if (!Array.isArray(obj.nodes) || obj.nodes.length === 0) {
    throw new Error('DAG 缺少 nodes 数组');
  }

  if (!Array.isArray(obj.edges)) {
    throw new Error('DAG 缺少 edges 数组');
  }

  const nodes = obj.nodes as LlmNode[];
  const edges = obj.edges as LlmEdge[];

  // Validate each node has required fields
  for (const node of nodes) {
    if (!node.id) throw new Error(`节点缺少 id 字段`);
    if (!node.name) throw new Error(`节点 ${node.id} 缺少 name 字段`);
    if (!node.chapter) throw new Error(`节点 ${node.id} 缺少 chapter 字段`);
  }

  // Validate edge references
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      throw new Error(`边引用了不存在的节点: ${edge.source}`);
    }
    if (!nodeIds.has(edge.target)) {
      throw new Error(`边引用了不存在的节点: ${edge.target}`);
    }
  }

  // Topological sort to detect cycles (Kahn's algorithm)
  validateNoCycles(nodes, edges);

  return { nodes, edges };
}

function validateNoCycles(nodes: LlmNode[], edges: LlmEdge[]): void {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited++;
    for (const neighbor of adjacency.get(current) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (visited !== nodes.length) {
    throw new Error('DAG 存在循环依赖（图中有环），请重新生成');
  }
}

// ── Position computation ──────────────────────────────────────────────────────

function computePositions(nodes: LlmNode[]): Map<string, { x: number; y: number }> {
  // Group nodes by chapter, preserving chapter order
  const chapterOrder = new Map<string, number>();
  const chapterNodes = new Map<string, LlmNode[]>();

  for (const node of nodes) {
    if (!chapterNodes.has(node.chapter)) {
      chapterNodes.set(node.chapter, []);
      chapterOrder.set(node.chapter, chapterOrder.size);
    }
    chapterNodes.get(node.chapter)!.push(node);
  }

  const positions = new Map<string, { x: number; y: number }>();
  const CHAPTER_GAP_X = 260;
  const NODE_GAP_Y = 130;
  const MARGIN_X = 80;
  const MARGIN_Y = 80;

  for (const [chapter, chNodes] of chapterNodes) {
    chNodes.sort((a, b) => (a.chapter_order ?? 0) - (b.chapter_order ?? 0));
    const ci = chapterOrder.get(chapter) ?? 0;
    for (let i = 0; i < chNodes.length; i++) {
      positions.set(chNodes[i].id, {
        x: ci * CHAPTER_GAP_X + MARGIN_X,
        y: i * NODE_GAP_Y + MARGIN_Y,
      });
    }
  }

  return positions;
}

// ── DB persistence ────────────────────────────────────────────────────────────

function saveDagToDb(courseId: string, data: LlmDagOutput): DagGraph {
  const positions = computePositions(data.nodes);

  // Deduplicate AI nodes by their AI-assigned ID
  const seenAiIds = new Set<string>();
  const uniqueNodes = data.nodes.filter((n) => {
    if (seenAiIds.has(n.id)) return false;
    seenAiIds.add(n.id);
    return true;
  });

  // Map AI-generated IDs (e.g. "node_1") → fresh UUIDs to avoid cross-course collisions
  const idMap = new Map<string, string>();
  for (const n of uniqueNodes) {
    idMap.set(n.id, randomUUID());
  }

  const db = getDb();

  // Delete all existing nodes for this course in one statement
  db.prepare('DELETE FROM dag_nodes WHERE course_id = ?').run(courseId);

  // Insert new nodes using remapped UUIDs
  const savedNodes: DagNode[] = [];
  for (const lNode of uniqueNodes) {
    const realId = idMap.get(lNode.id)!;
    const pos = positions.get(lNode.id) ?? { x: 0, y: 0 };
    const dto: CreateNodeDto = {
      id: realId,
      course_id: courseId,
      chapter: lNode.chapter,
      chapter_order: lNode.chapter_order ?? 0,
      name: lNode.name,
      description: lNode.description,
      node_type: (lNode.node_type as NodeType) ?? 'main',
      status: 'locked',
      hours_est: lNode.hours_est ?? 1.0,
      difficulty: (lNode.difficulty as Difficulty) ?? 'beginner',
      // Filter out any prerequisite IDs that don't exist in the current node set
      // (LLM sometimes hallucinates IDs that were never defined).
      prerequisites: (lNode.prerequisites ?? []).filter((pid) => idMap.has(pid)),
      required_tools: lNode.required_tools ?? [],
      required_cost: lNode.required_cost ?? {},
      position_x: pos.x,
      position_y: pos.y,
      bloom_target:  (lNode.bloom_target  as BloomTarget  | undefined) ?? undefined,
      learning_type: (lNode.learning_type as LearningType | undefined) ?? undefined,
      priority:      (lNode.priority      as NodePriority | undefined) ?? undefined,
    };
    savedNodes.push(nodeRepo.create(dto));
  }

  // Set root nodes (no incoming edges) to 'available'
  const hasIncoming = new Set(data.edges.map((e) => e.target));
  for (const lNode of uniqueNodes) {
    if (!hasIncoming.has(lNode.id)) {
      const realId = idMap.get(lNode.id)!;
      nodeRepo.updateStatus(realId, 'available');
    }
  }

  // Save edges, remapping source/target to real UUIDs; skip edges referencing unknown nodes
  const edgeDtos = data.edges
    .filter((e) => idMap.has(e.source) && idMap.has(e.target))
    .map((e) => ({
      id: randomUUID(),
      course_id: courseId,
      source_node_id: idMap.get(e.source)!,
      target_node_id: idMap.get(e.target)!,
      created_at: new Date().toISOString(),
    }));
  edgeRepo.saveAll(courseId, edgeDtos);

  // Keep total_nodes / done_nodes in sync (same logic as DB_DAG_SAVE IPC handler)
  db.prepare(
    `UPDATE courses SET
       total_nodes = (SELECT COUNT(*) FROM dag_nodes WHERE course_id = ?),
       done_nodes  = (SELECT COUNT(*) FROM dag_nodes WHERE course_id = ? AND status = 'done'),
       updated_at  = datetime('now')
     WHERE id = ?`
  ).run(courseId, courseId, courseId);

  return {
    nodes: nodeRepo.findByCourse(courseId),
    edges: edgeRepo.findByCourse(courseId),
  };
}

// ── Chapter scope generation (separate non-fatal call) ───────────────────────

const CHAPTER_SCOPE_SYSTEM_PROMPT = `你是学习路线知识点分配专家。根据给定的课程节点列表，为每个非 boss 节点分配互不重叠的知识点清单，以 JSON 输出。

要求：
1. scope_distribution 中同章各主节点的知识点不得重叠
2. boss 节点不分配独立知识点（其综合考核已涵盖本章全部知识点）
3. 每个节点 3-6 个具体知识点，以动宾短语描述（如"理解XXX原理"、"掌握YYY步骤"）

只输出合法 JSON，不加 markdown 代码块，格式：
{
  "章节名": {
    "nodes": ["节点名1", "节点名2"],
    "scope_distribution": {
      "节点名1": ["知识点A", "知识点B"],
      "节点名2": ["知识点C", "知识点D"]
    },
    "boundary_notes": "说明 boss 节点的定位"
  }
}`;

async function generateChapterScope(
  courseId: string,
  nodes: DagNode[],
  provider: string,
  model: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    // Group nodes by chapter
    const chapterMap = new Map<string, DagNode[]>();
    for (const n of nodes) {
      if (!chapterMap.has(n.chapter)) chapterMap.set(n.chapter, []);
      chapterMap.get(n.chapter)!.push(n);
    }

    const nodeList = [...chapterMap.entries()]
      .map(([chapter, cNodes]) => {
        const mainNodes = cNodes.filter((n) => n.node_type !== 'boss').map((n) => n.name);
        const bossNodes = cNodes.filter((n) => n.node_type === 'boss').map((n) => n.name);
        return `章节：${chapter}\n  主节点：${mainNodes.join('、') || '无'}\n  Boss节点：${bossNodes.join('、') || '无'}`;
      })
      .join('\n\n');

    const userMsg = `请为以下课程节点分配知识点清单：\n\n${nodeList}`;

    let raw = '';
    await LLMAdapter.stream({
      provider, model,
      messages: [{ role: 'user', content: userMsg }],
      systemPrompt: CHAPTER_SCOPE_SYSTEM_PROMPT,
      maxTokens: 2000,
      signal,
      onChunk: (c) => { raw += c; },
      onComplete: () => {},
      onError: () => {},
    });

    const jsonMatch = raw.match(/\{[\s\S]+\}/);
    if (!jsonMatch) {
      log.warn('generateChapterScope: LLM 未返回有效 JSON，章节知识点分配跳过');
      return;
    }

    const scope = JSON.parse(jsonMatch[0]) as Record<string, ChapterScopeEntry>;
    const scopePath = path.join(getCourseDir(courseId), '_chapter_scope.json');
    writeFileContent(scopePath, JSON.stringify(scope, null, 2));
  } catch (err) {
    log.warn('generateChapterScope 失败（非致命）', { error: String(err) });
  }
}

// ── Adaptive node-count target ────────────────────────────────────────────────

/**
 * Derive a target node range and chapter count from PREPROCESS scope +
 * the user's time budget (time_budget overrides scope when it's explicit).
 */
function computeNodeTarget(
  scope: string | undefined,
  timeBudget: string | null | undefined,
  depthPreference: string | null | undefined,
): { min: number; max: number; chapters: string; label: string } {
  // User-set depth_preference takes highest priority
  if (depthPreference === 'quick')    return { min: 5,  max: 10, chapters: '2-3',  label: '速览型（5-10 节点）' };
  if (depthPreference === 'deep')     return { min: 25, max: 50, chapters: '6-12', label: '系统型（25-50 节点）' };
  if (depthPreference === 'standard') return { min: 12, max: 25, chapters: '4-7',  label: '掌握型（12-25 节点）' };

  let s = scope ?? 'standard';

  // Explicit time budget can override the LLM-judged scope
  if (timeBudget) {
    const tb = timeBudget.toLowerCase();
    if (/[1-9]\s*天|[1-2]\s*周|\b[1-2]\s*(day|week)/.test(tb))        s = 'micro';
    else if (/[3-9]\s*个?月|半年|一年|[1-9]\s*年|\b[3-9]\s*month/.test(tb)) s = 'comprehensive';
  }

  switch (s) {
    case 'micro':         return { min: 5,  max: 10, chapters: '2-3',  label: '速览型（5-10 节点）' };
    case 'comprehensive': return { min: 25, max: 50, chapters: '6-12', label: '系统型（25-50 节点）' };
    default:              return { min: 12, max: 25, chapters: '4-7',  label: '掌握型（12-25 节点）' };
  }
}

// ── Multi-pass DAG generation (comprehensive courses) ────────────────────────

const SKELETON_SYSTEM_PROMPT =
  `你是课程路线规划师。根据能力规格，将学习内容分配到若干章节，每章给出 boss 考核节点和技能点清单。\n\n` +
  `只输出合法 JSON，不加任何说明或 markdown：\n` +
  `{\n  "chapters": [\n    {\n      "name": "章节名称",\n      "order": 0,\n      "nodes_target": 4,\n` +
  `      "boss": {\n        "id": "boss_0",\n        "name": "综合考核名称",\n        "description": "考核内容（1-2句）",\n` +
  `        "hours_est": 3.0,\n        "difficulty": "intermediate",\n        "bloom_target": "create",\n` +
  `        "learning_type": "intellectual_skill",\n        "priority": "must"\n      },\n` +
  `      "skill_points": ["技能点1", "技能点2", "技能点3"]\n    }\n  ]\n}\n\n` +
  `规则：nodes_target 为该章主节点数（3-6）；boss id 格式 boss_0/boss_1…；` +
  `各章 skill_points 不得重叠且必须覆盖全部 KSAO 能力点；难度从第一章 beginner 向最后一章 advanced 递进。`;

const CHAPTER_FILL_SYSTEM_PROMPT =
  `你是课程节点设计师。根据本章技能点清单生成主学习节点列表。\n\n` +
  `只输出合法 JSON：\n` +
  `{\n  "nodes": [\n    {\n      "id": "node_0",\n      "chapter_order": 0,\n      "name": "节点名称",\n` +
  `      "description": "节点内容（1-2句）",\n      "node_type": "main",\n      "hours_est": 2.0,\n` +
  `      "difficulty": "beginner",\n      "prerequisites": [],\n      "required_tools": [],\n` +
  `      "required_cost": { "money": 0, "equipment": "无", "location": "家" },\n` +
  `      "bloom_target": "remember_understand",\n      "learning_type": "verbal_info",\n      "priority": "must"\n    }\n  ]\n}\n\n` +
  `规则：只生成 node_type "main" 节点；第一章第一个节点 prerequisites 为 []；` +
  `其他章第一个节点 prerequisites 必须为 ["entry_point"]；` +
  `章内后续节点只能引用本章前面节点 id（node_0/node_1…）；节点数等于 nodes_target；` +
  `bloom_target: remember_understand/analyze_evaluate/apply/create；` +
  `learning_type: verbal_info/intellectual_skill/cognitive_strategy/motor_skill/attitude；` +
  `priority: must/should/nice_to_have。`;

interface SkeletonChapter {
  name: string;
  order: number;
  nodes_target: number;
  boss: {
    id: string;
    name: string;
    description: string;
    hours_est: number;
    difficulty: string;
    bloom_target: string;
    learning_type: string;
    priority: string;
  };
  skill_points: string[];
}

function mergeChapters(skeleton: SkeletonChapter[], chapterNodes: LlmNode[][]): LlmDagOutput {
  const allNodes: LlmNode[] = [];
  const allEdges: LlmEdge[] = [];
  const edgeSet = new Set<string>();

  const addEdge = (source: string, target: string) => {
    const key = `${source}→${target}`;
    if (!edgeSet.has(key)) { edgeSet.add(key); allEdges.push({ source, target }); }
  };

  for (let ci = 0; ci < skeleton.length; ci++) {
    const chapter = skeleton[ci];
    const rawNodes = chapterNodes[ci];
    const prefix = `ch${ci}_`;

    for (const node of rawNodes) {
      const newId = prefix + node.id;
      const newPrereqs = (node.prerequisites ?? []).flatMap((pid) => {
        if (pid === 'entry_point') return ci > 0 ? [skeleton[ci - 1].boss.id] : [];
        return [prefix + pid];
      });
      allNodes.push({ ...node, id: newId, chapter: chapter.name, prerequisites: newPrereqs });
      for (const prereq of newPrereqs) addEdge(prereq, newId);
    }

    // Boss node — depends on every main node in the chapter
    const mainIds = rawNodes.map((n) => prefix + n.id);
    allNodes.push({
      id:             chapter.boss.id,
      chapter:        chapter.name,
      chapter_order:  rawNodes.length,
      name:           chapter.boss.name,
      description:    chapter.boss.description,
      node_type:      'boss',
      hours_est:      chapter.boss.hours_est,
      difficulty:     chapter.boss.difficulty,
      prerequisites:  mainIds,
      required_tools: [],
      required_cost:  { money: 0, equipment: '无', location: '家' },
      bloom_target:   chapter.boss.bloom_target,
      learning_type:  chapter.boss.learning_type,
      priority:       chapter.boss.priority,
    });
    for (const mid of mainIds) addEdge(mid, chapter.boss.id);
  }

  return { nodes: allNodes, edges: allEdges };
}

async function fillChapter(
  req: AgentRequest,
  chapter: SkeletonChapter,
  chapterIndex: number,
  totalChapters: number,
  courseTopic: string,
  accUsage: TokenUsage,
): Promise<LlmNode[]> {
  const diffHint =
    chapterIndex === 0              ? 'beginner' :
    chapterIndex === totalChapters - 1 ? 'advanced' : 'intermediate';

  const input =
    `课程：${courseTopic}\n` +
    `章节：${chapter.name}（第 ${chapterIndex + 1}/${totalChapters} 章，难度：${diffHint}）\n\n` +
    `本章技能点：\n${chapter.skill_points.map((sp, i) => `${i + 1}. ${sp}`).join('\n')}\n\n` +
    `生成 ${chapter.nodes_target} 个主节点。\n` +
    (chapterIndex === 0
      ? '这是第一章，第一个节点 prerequisites 为 []。'
      : '第一个节点 prerequisites 必须为 ["entry_point"]。');

  let raw = '';
  await LLMAdapter.stream({
    provider: req.provider, model: req.model,
    messages: [{ role: 'user', content: input }],
    systemPrompt: CHAPTER_FILL_SYSTEM_PROMPT + (req.language === 'en'
      ? '\n\nIMPORTANT: All node `name`, `chapter`, `description`, and `skill_points` values MUST be in English.'
      : ''),
    maxTokens: 3000,
    temperature: 0,
    signal: req.signal,
    onChunk:    (c) => { raw += c; },
    onComplete: (u) => { accUsage.inputTokens += u.inputTokens; accUsage.outputTokens += u.outputTokens; accUsage.costCny += u.costCny; },
    onError:    () => {},
  });

  const match = raw.match(/\{[\s\S]+\}/);
  if (!match) return [];
  try { return (JSON.parse(match[0]) as { nodes: LlmNode[] }).nodes ?? []; }
  catch { return []; }
}

async function generateDagMultiPass(
  req: AgentRequest,
  spec: AbilitySpec,
  nodeTarget: { min: number; max: number; chapters: string; label: string },
  courseTopic: string,
  progress: (chunk: string) => void,
  accUsage: TokenUsage,
): Promise<LlmDagOutput> {
  // ── Step A: Skeleton ───────────────────────────────────────────────────────
  progress(localMsg(req.language, '📐 正在规划章节骨架…\n', '📐 Planning chapter skeleton…\n'));

  const skeletonInput =
    `课程主题：${courseTopic}\n终点目标：${spec.terminal_performance}\n\n` +
    `KSAO 胜任力清单：\n` +
    `- 知识：${spec.ksao?.knowledge?.join('、') || '—'}\n` +
    `- 技能：${spec.ksao?.skills?.join('、') || '—'}\n` +
    `- 能力：${spec.ksao?.abilities?.join('、') || '—'}\n\n` +
    `优先级：must（${spec.time_priority_split?.must?.join('、') || '—'}）` +
    `  should（${spec.time_priority_split?.should?.join('、') || '—'}）\n\n` +
    `目标章节数：${nodeTarget.chapters} 个，总主节点数：${nodeTarget.min}-${nodeTarget.max} 个`;

  let skeletonRaw = '';
  await LLMAdapter.stream({
    provider: req.provider, model: req.model,
    messages: [{ role: 'user', content: skeletonInput }],
    systemPrompt: SKELETON_SYSTEM_PROMPT + (req.language === 'en'
      ? '\n\nIMPORTANT: All chapter `name` and `skill_points` values MUST be in English.'
      : ''),
    maxTokens: 2000,
    temperature: 0,
    signal: req.signal,
    onChunk:    (c) => { skeletonRaw += c; },
    onComplete: (u) => { accUsage.inputTokens += u.inputTokens; accUsage.outputTokens += u.outputTokens; accUsage.costCny += u.costCny; },
    onError:    () => {},
  });

  const skeletonMatch = skeletonRaw.match(/\{[\s\S]+\}/);
  if (!skeletonMatch) throw new Error('章节骨架生成失败，请重试');

  let skeleton: SkeletonChapter[];
  try {
    skeleton = (JSON.parse(skeletonMatch[0]) as { chapters: SkeletonChapter[] }).chapters;
  } catch {
    throw new Error('章节骨架 JSON 解析失败，请重试');
  }
  if (!skeleton?.length) throw new Error('章节骨架为空，请重试');

  progress(localMsg(req.language, `✅ 章节：${skeleton.map((c) => c.name).join(' → ')}\n\n`, `✅ Chapters: ${skeleton.map((c) => c.name).join(' → ')}\n\n`));
  progress(localMsg(req.language, '📝 正在并发填充各章节节点…\n', '📝 Filling chapter nodes concurrently…\n'));

  // ── Step B: Fill chapters in parallel ──────────────────────────────────────
  const chapterResults = await Promise.allSettled(
    skeleton.map((ch, ci) => fillChapter(req, ch, ci, skeleton.length, courseTopic, accUsage)),
  );

  const chapterNodes: LlmNode[][] = skeleton.map((ch, ci) => {
    const result = chapterResults[ci];
    if (result.status === 'fulfilled' && result.value.length > 0) {
      progress(`  ✓ ${ch.name}（${result.value.length} 节点）\n`);
      return result.value;
    }
    progress(`  ⚠ ${ch.name} 填充失败，使用占位节点\n`);
    return [{
      id: 'node_0', chapter: ch.name, chapter_order: 0,
      name: ch.skill_points[0] ?? '核心知识',
      description: `${ch.name}的核心学习内容`,
      node_type: 'main', hours_est: 2.0, difficulty: 'intermediate',
      prerequisites: ci === 0 ? [] : ['entry_point'],
      required_tools: [], required_cost: {},
      bloom_target: 'apply', learning_type: 'intellectual_skill', priority: 'must',
    }];
  });

  // ── Step C: Merge & validate ───────────────────────────────────────────────
  progress(localMsg(req.language, '\n🔗 正在合并章节并验证结构…\n', '\n🔗 Merging chapters and validating structure…\n'));
  return mergeChapters(skeleton, chapterNodes);
}

// ── MainTutor ─────────────────────────────────────────────────────────────────

export class MainTutor {
  async handle(req: AgentRequest): Promise<void> {
    switch (req.action) {
      case 'generate_dag':
        await this.handleGenerateDag(req);
        break;
      case 'chat':
        await this.handleChat(req);
        break;
      default:
        throw new Error(`MainTutor: unsupported action ${req.action}`);
    }
  }

  /** Core DAG generation logic. Sends progress + DAG_GENERATED to sender. Returns result on success, throws on error. Does NOT send STREAM_END. */
  private async _generateDagCore(
    req: AgentRequest,
    sender: Electron.WebContents,
    topicOverride?: string,
  ): Promise<{ nodeCount: number; chapterNames: string[]; totalHours: number; spec: AbilitySpec | null; profileText: string; accUsage: TokenUsage }> {
    const MAX_TOOL_TURNS = 8;
    const accUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, costCny: 0 };
    const topic = topicOverride ?? req.userMessage;

    const progress = (chunk: string) =>
      safeSend(sender, IPC.LLM_STREAM_CHUNK, { sessionId: req.sessionId, chunk, isProgress: true });

    progress(localMsg(req.language, '🤔 正在分析学习目标和约束条件…\n\n', '🤔 Analysing learning objectives and constraints…\n\n'));

    // ── Step 1: Preprocessing — goal decomposition via UbD + KSAO + Gagné ────
    const course = courseRepo.findById(req.courseId);
    const profileText = [
      course?.goal_text    ? `学习目标：${course.goal_text}`    : '',
      course?.known_topics ? `已掌握主题：${course.known_topics}` : '',
      course?.time_budget  ? `时间预算：${course.time_budget}`  : '',
    ].filter(Boolean).join('\n') || '（学习档案未填写）';

    const preprocessInput = `课程主题：${topic}\n\n用户学习档案：\n${profileText}`;

    let spec: AbilitySpec | null = null;
    let preprocessRaw = '';

    progress(localMsg(req.language, '📋 正在分解学习目标和能力清单…\n', '📋 Decomposing learning goals and ability checklist…\n'));
    await LLMAdapter.stream({
      provider: req.provider, model: req.model,
      messages: [{ role: 'user', content: preprocessInput }],
      systemPrompt: PREPROCESS_SYSTEM_PROMPT,
      maxTokens: 1200,
      temperature: 0,
      signal: req.signal,
      onChunk: (c) => { preprocessRaw += c; },
      onComplete: (u) => { accUsage.inputTokens += u.inputTokens; accUsage.outputTokens += u.outputTokens; accUsage.costCny += u.costCny; },
      onError: () => { /* non-fatal, proceed without spec */ },
    });
    try {
      const jsonMatch = preprocessRaw.match(/\{[\s\S]+\}/);
      if (jsonMatch) spec = JSON.parse(jsonMatch[0]) as AbilitySpec;
    } catch { /* proceed without spec */ }

    const nodeTarget = computeNodeTarget(spec?.scope, course?.time_budget, course?.depth_preference);

    if (spec) {
      const mustCount    = spec.time_priority_split?.must?.length ?? 0;
      const missingGagne = spec.gagne_coverage?.missing?.join('、') || '无';
      progress(`✅ 终点目标：${spec.terminal_performance}\n   必学能力 ${mustCount} 项  |  Gagné 缺失：${missingGagne}  |  规模：${nodeTarget.label}\n\n`);

      // Auto-save terminal_performance as goal_text if profile has no goal yet
      if (!course?.goal_text && spec.terminal_performance) {
        try { courseRepo.updateProfile(req.courseId, { goal_text: spec.terminal_performance }); } catch { /* non-fatal */ }
      }
    }

    // ── Comprehensive path: multi-pass generation ─────────────────────────────
    if (spec && nodeTarget.min >= 12) {
      const dagData = await generateDagMultiPass(req, spec, nodeTarget, topic, progress, accUsage);
      validateNoCycles(dagData.nodes, dagData.edges);
      progress(localMsg(req.language, '\n\n✅ 路线结构验证通过，正在保存到数据库…\n', '\n\n✅ Route structure validated, saving to database…\n'));
      const graph = saveDagToDb(req.courseId, dagData);
      safeSend(sender, IPC.DAG_GENERATED, {
        nodes: graph.nodes, edges: graph.edges,
        summary: '', usage: { inputTokens: 0, outputTokens: 0, costCny: 0 },
        sessionId: req.sessionId,
      });
      generateChapterScope(req.courseId, graph.nodes, req.provider, req.model, req.signal);
      const chapters   = new Set(dagData.nodes.map((n) => n.chapter));
      const totalHours = graph.nodes.reduce((s, n) => s + (n.hours_est ?? 0), 0);
      return { nodeCount: graph.nodes.length, chapterNames: [...chapters], totalHours, spec, profileText, accUsage: { ...accUsage } };
    }

    // ── Step 2: Build dynamic system prompt with ability spec ─────────────────
    const GOAL_TYPE_HINT: Record<string, string> = {
      job_interview: '目标类型：面试/求职 → must 节点集中在高频考点和实战练习，降低纯理论节点比例，实践节点优先。',
      hobby_project: '目标类型：兴趣/项目 → 实践节点和应用节点优先，理论节点适度精简，以能完成项目为导向。',
      academic:      '目标类型：学术/课程 → 理论深度优先，覆盖完整知识体系，保留 nice_to_have 延伸内容。',
      certification: '目标类型：考证/备考 → 严格按照证书考纲顺序排节点，重点标注考试高频考点，去除考纲外内容。',
    };
    const goalTypeHint = spec?.goal_type && GOAL_TYPE_HINT[spec.goal_type]
      ? `\n${GOAL_TYPE_HINT[spec.goal_type]}\n` : '';

    const paramsSection = spec ? `
[能力规格（逆向设计产出）]
终点表现：${spec.terminal_performance}
验收标准：${spec.verification_evidence}
${goalTypeHint}
KSAO 胜任力清单：
- 知识：${spec.ksao?.knowledge?.join('、') || '—'}
- 技能：${spec.ksao?.skills?.join('、')   || '—'}
- 能力：${spec.ksao?.abilities?.join('、')|| '—'}
- 其他：${spec.ksao?.others?.join('、')   || '—'}

Gagné 五类覆盖要求（路线中每类必须至少有一个节点，missing 中列出的类型必须补充）：
缺失类型：${spec.gagne_coverage?.missing?.join('、') || '无（五类均已覆盖）'}

优先级分级（节点 priority 字段必须按此分配）：
- must：${spec.time_priority_split?.must?.join('、')          || '—'}
- should：${spec.time_priority_split?.should?.join('、')      || '—'}
- nice_to_have：${spec.time_priority_split?.nice_to_have?.join('、') || '—'}

课程规模目标（必须严格遵守）：
- 节点总数：${nodeTarget.min}-${nodeTarget.max} 个（${nodeTarget.label}）
- 章节数：${nodeTarget.chapters} 个
- 节点粒度：每个节点 = 一个人专注状态下 2-3 小时内能完成的最小可测量学习单元
- 如果 KSAO 技能点多于节点上限，合并相近技能点为一个节点；如果少于节点下限，适当拆分复杂技能点

输出 JSON 前先完成两项自检（不输出检查过程）：
1. 完整性检查：KSAO 清单中每项能力是否都有节点覆盖，Gagné missing 中的类型是否已补充节点
2. 目标对齐检查：每个节点能否追溯到 terminal_performance，有无不相关节点；节点数是否在 ${nodeTarget.min}-${nodeTarget.max} 范围内
发现问题直接修正后再输出 JSON。` : `
节点粒度标准：一个节点 = 一个人在专注状态下能在 2-3 小时内完成的最小可测量学习单元。
输出 JSON 前完成完整性检查（节点是否覆盖达成目标所需的全部能力）和目标对齐检查，发现问题直接修正。`;

    const genSystemPrompt = DAG_GEN_SYSTEM_PROMPT + paramsSection;

    // ── Step 3: streamWithTools loop — web_search + JSON output ──────────────
    const genTools = buildDagToolDefs().filter((t) => t.name === 'web_search');
    const genCtx: DagToolContext = { courseId: req.courseId, sessionId: req.sessionId, sender, provider: req.provider, model: req.model };

    const historyContext = (req.messages ?? [])
      .slice(-8)
      .map((m) => `[${m.role === 'user' ? '用户' : 'AI'}]: ${m.content}`)
      .join('\n');
    const contextPrefix = historyContext ? `[对话背景]\n${historyContext}\n\n---\n\n` : '';

    const searchHint = spec?.search_queries?.length
      ? `\n\n建议搜索关键词（请依次调用 web_search）：${spec.search_queries.map((q) => `「${q}」`).join('、')}`
      : '';

    const messages: ToolTurnMessage[] = [
      { role: 'user', content: contextPrefix + topic + searchHint },
    ];

    progress(localMsg(req.language, '🧠 AI 正在搜索参考资料并规划课程节点…\n\n', '🧠 AI is searching references and planning course nodes…\n\n'));

    let finalText = '';

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      if (req.signal?.aborted) throw new Error('已取消');

      let turnText = '';
      const dagMaxTokens = Math.min(nodeTarget.max * 220 + 1500, 8000);
      const response = await LLMAdapter.streamWithTools({
        provider: req.provider, model: req.model,
        systemPrompt: genSystemPrompt,
        messages, tools: genTools,
        maxTokens: dagMaxTokens,
        signal: req.signal,
        onChunk: (chunk) => { turnText += chunk; progress(chunk); },
      });

      accUsage.inputTokens  += response.usage.inputTokens;
      accUsage.outputTokens += response.usage.outputTokens;
      accUsage.costCny      += response.usage.costCny;
      messages.push(response.assistantTurn);

      if (response.stopReason === 'tool_use') {
        const toolResults = await Promise.all(
          response.toolCalls.map(async (tc) => {
            progress(`\n🔍 搜索：${(tc.input as { query?: string }).query ?? tc.name}…\n`);
            return { toolCallId: tc.id, content: await executeDagTool(tc, genCtx) };
          }),
        );
        messages.push({ role: 'tool_results', results: toolResults });
        continue;
      }

      finalText = turnText;
      break;
    }

    if (!finalText) throw new Error('未能获取路线图内容，请重试');

    const dagData = parseDagJson(finalText);
    progress(localMsg(req.language, '\n\n✅ 路线结构验证通过，正在保存到数据库…\n', '\n\n✅ Route structure validated, saving to database…\n'));
    const graph = saveDagToDb(req.courseId, dagData);

    safeSend(sender, IPC.DAG_GENERATED, {
      nodes: graph.nodes, edges: graph.edges,
      summary: '', usage: { inputTokens: 0, outputTokens: 0, costCny: 0 },
      sessionId: req.sessionId,
    });

    generateChapterScope(req.courseId, graph.nodes, req.provider, req.model, req.signal);

    const chapters   = new Set(dagData.nodes.map((n) => n.chapter));
    const totalHours = graph.nodes.reduce((s, n) => s + (n.hours_est ?? 0), 0);
    return { nodeCount: graph.nodes.length, chapterNames: [...chapters], totalHours, spec, profileText, accUsage: { ...accUsage } };
  }

  private async handleGenerateDag(req: AgentRequest): Promise<void> {
    const sender = req.senderEvent.sender;
    const accUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, costCny: 0 };

    try {
      const result = await this._generateDagCore(req, sender);
      accUsage.inputTokens  += result.accUsage.inputTokens;
      accUsage.outputTokens += result.accUsage.outputTokens;
      accUsage.costCny      += result.accUsage.costCny;

      const chapterList = result.chapterNames.map((ch) => `「${ch}」`).join('、');
      const isEn = req.language === 'en';
      const summaryPrompt = isEn
        ? `Roadmap generated and saved:\n` +
          `- ${result.nodeCount} nodes across ${result.chapterNames.length} chapters: ${result.chapterNames.join(', ')}\n` +
          `- Estimated total: ${result.totalHours.toFixed(1)} hours\n` +
          `- Learner profile: ${result.profileText}\n` +
          (result.spec ? `- Terminal performance: ${result.spec.terminal_performance}\n` : '') +
          `\nPlease:\n1. Briefly describe the roadmap structure (chapters and node distribution)\n` +
          `2. Explain the design rationale (why these chapters, key dependency logic, how it fits the learner's goal)\n` +
          `3. Ask if they're satisfied; hint they can say "adjust X" or "X part is wrong" to make changes\n` +
          `Keep it natural and friendly, no heading symbols, under 200 words.`
        : `路线图已生成并保存：\n` +
          `- 共 ${result.nodeCount} 个节点，分 ${result.chapterNames.length} 个章节：${chapterList}\n` +
          `- 总预估学时：${result.totalHours.toFixed(1)} 小时\n` +
          `- 用户学习档案：${result.profileText}\n` +
          (result.spec ? `- 终点表现：${result.spec.terminal_performance}\n` : '') +
          `\n请向用户：\n` +
          `1. 简述路线图整体结构（章节划分和节点分布）\n` +
          `2. 说明构建思路（为何这样划分章节、关键依赖关系的设计逻辑、如何结合用户目标）\n` +
          `3. 询问是否满意，提示可直接说"调整XX"或"XX部分不对"来修改\n` +
          `语气自然友好，不使用标题符号，直接说话，控制在200字以内。`;

      await LLMAdapter.stream({
        provider: req.provider, model: req.model,
        messages: [{ role: 'user', content: summaryPrompt }],
        systemPrompt: isEn
          ? 'You are a friendly learning roadmap planner introducing the roadmap you just generated to the user.'
          : '你是友好的学习路线规划师，正在向用户介绍刚刚生成的课程路线图。',
        maxTokens: 500,
        signal: req.signal,
        onChunk:    (chunk) => safeSend(sender, IPC.LLM_STREAM_CHUNK, { sessionId: req.sessionId, chunk }),
        onComplete: (u) => { accUsage.inputTokens += u.inputTokens; accUsage.outputTokens += u.outputTokens; accUsage.costCny += u.costCny; },
        onError:    () => {},
      });

      safeSend(sender, IPC.LLM_STREAM_END, { sessionId: req.sessionId, usage: accUsage });
    } catch (err) {
      safeSend(sender, IPC.LLM_STREAM_ERROR, {
        sessionId: req.sessionId,
        error: `路线图生成失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async handleChat(req: AgentRequest): Promise<void> {
    const sender = req.senderEvent.sender;

    // ── Slash command resolution ───────────────────────────────────────────────
    if (isCommand(req.userMessage)) {
      const resolved = resolveCommand(req.userMessage);
      if (resolved) {
        const { command, args } = resolved;
        const ctx = { courseId: req.courseId };

        if (command.type === 'local') {
          const result = command.handler(args, ctx) as string;
          safeSend(sender, IPC.LLM_STREAM_CHUNK, { sessionId: req.sessionId, chunk: result });
          safeSend(sender, IPC.LLM_STREAM_END,   { sessionId: req.sessionId, usage: { inputTokens: 0, outputTokens: 0, costCny: 0 } });
          return;
        }

        if (command.type === 'prompt') {
          const prefix = command.handler(args, ctx) as string;
          req = { ...req, userMessage: prefix + (args ? '\n\n' + args : '') };
        }
      }
    }

    // ── Tool-enabled chat loop ─────────────────────────────────────────────────
    const course = courseRepo.findById(req.courseId);
    const profileIncomplete = !course?.goal_text || !course?.known_topics;
    const profileGuidance = profileIncomplete
      ? '\n\n[档案引导] 若本次用户消息未涉及学习目标或已掌握主题，请在回复末尾用一句话自然引导用户补充，例如："顺便问一下，您希望学到什么程度，目前有哪些基础？填写后我可以给出更准确的规划建议。"若用户提到了相关信息，请调用 update_profile 工具保存。'
      : '';
    const systemPrompt = await buildSystemPrompt(roleLayer('maintutor'), languageLayer(req.language)) + profileGuidance;
    const dagCtx: DagToolContext = {
      courseId: req.courseId,
      sessionId: req.sessionId,
      sender,
      provider: req.provider,
      model: req.model,
      runDagGeneration: async (topic: string) => {
        const result = await this._generateDagCore({ ...req, userMessage: topic }, sender, topic);
        return { nodeCount: result.nodeCount, chapterNames: result.chapterNames };
      },
    };
    const dagTools = buildDagToolDefs();

    // Convert plain history to ToolTurnMessage format
    const history = compressHistory(req.messages ?? []);
    const toolMessages: ToolTurnMessage[] = [
      { role: 'user',      content: buildPlannerContext(req.courseId) },
      { role: 'assistant', text: '好的，我已了解当前课程状态，可以开始讨论。', toolCalls: [] },
      ...history.map((m): ToolTurnMessage =>
        m.role === 'user'
          ? { role: 'user', content: m.content }
          : { role: 'assistant', text: m.content, toolCalls: [] }
      ),
    ];

    // Append current user message so it persists across all tool turns
    toolMessages.push({ role: 'user', content: req.userMessage });

    const accUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, costCny: 0 };
    const MAX_TOOL_TURNS = 8; // Allow enough turns for multi-node additions

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      if (req.signal?.aborted) return;

      const response = await LLMAdapter.streamWithTools({
        provider:    req.provider,
        model:       req.model,
        systemPrompt,
        messages:    toolMessages,
        tools:       dagTools,
        maxTokens:   2048,
        signal:      req.signal,
        onChunk:     (chunk) => {
          safeSend(sender, IPC.LLM_STREAM_CHUNK, { sessionId: req.sessionId, chunk });
        },
      }).catch((err: Error) => {
        safeSend(sender, IPC.LLM_STREAM_ERROR, { sessionId: req.sessionId, error: err.message });
        return null;
      });

      if (!response) return;

      accUsage.inputTokens  += response.usage.inputTokens;
      accUsage.outputTokens += response.usage.outputTokens;
      accUsage.costCny      += response.usage.costCny;

      // Append assistant turn to message history
      toolMessages.push(response.assistantTurn);

      if (response.stopReason !== 'tool_use' || response.toolCalls.length === 0) break;

      // Execute all tool calls in this turn
      const toolResults = await Promise.all(
        response.toolCalls.map(async (tc) => ({
          toolCallId: tc.id,
          content:    await executeDagTool(tc, dagCtx),
        }))
      );
      toolMessages.push({ role: 'tool_results', results: toolResults });
    }

    safeSend(sender, IPC.LLM_STREAM_END, { sessionId: req.sessionId, usage: accUsage });
  }
}
