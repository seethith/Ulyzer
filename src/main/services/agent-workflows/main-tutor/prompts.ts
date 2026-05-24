import type { SearchMode } from '@shared/types';
import type { NodeTarget } from './types';

export const SIMPLE_GEN_SYSTEM_PROMPT = `你是专业课程规划师。根据用户的学习主题，生成一份结构完整、内容扎实的学习路线图（DAG）。

工作流程：
1. 参考系统提供的用户请求、学习档案、对话背景和路线图证据摘要
2. 按该领域公认的知识体系规划章节，不要自行发明结构
3. 输出合法 JSON，不加任何 markdown 包裹或说明文字

路线规划要求：
- 章节结构优先遵循领域标准：计算机网络按 OSI 各层→安全→现代网络；数据结构按线性→树→图→算法分析；微积分按极限→导数→积分→级数→多元
- 每章覆盖一个独立的主题模块，章节之间有清晰的知识依赖关系
- 每章末尾有 1 个 boss 节点（综合考核或实战项目），boss 节点必须使用 "node_type": "boss"，不要只在名称里写 Boss
- boss 节点要具体覆盖本章主要内容，优先改写成清晰任务，不要用空泛的“综合练习”凑数
- 节点命名具体清晰：「TCP三次握手与拥塞控制」优于「传输层协议」
- 难度从 beginner 到 advanced 自然递进，章内和章间均有梯度
- 章节数根据主题广度自行决定，完整覆盖该学科的核心内容
- 节点数和章节数是建议规模，不是硬性上限；用户要求“从入门到精通”“内容要全”“节点不限”时，完整性优先
- 每个节点的 rationale 用一句短句说明学习价值或编排理由，不要写来源说明或长段
- 每个节点的 source_ids 最多 2 个；没有可靠来源时用空数组

依赖边要求（非常重要）：
- edges/prerequisites 只表示“直接前置依赖”，不要表示泛泛相关、同章相关或所有上游知识。
- 若已经存在 A→B 且 B→C，不要再输出 A→C；这种传递冗余边会让路线图变乱。
- 每章优先形成一条清晰主学习链，允许少量自然分叉/汇合，例如 A→B、A→C、B→D、C→D。
- 跨章边只连接真实的直接依赖；不要机械地把上一章末尾节点连接到下一章第一个节点。
- 系统会根据跨章边推导“章节依赖”：若 A 章有节点连到 B 章节点，则 B 章要等 A 章完成后才整体解锁。并行章节可共享同一前置章（A章→B章、A章→C章），串行章节用 A章→B章→C章 表达。
- 除真正的开篇基础章节外，后续章节如果不是并行入口，至少需要一条来自其前置章节的跨章直接依赖边；不要留下没有任何依赖关系的后续章节。
- 一个节点的直接前置通常控制在 1–3 个；除综合任务外，不要让单个节点依赖大量上游节点。

字段枚举（必须严格使用）：
- node_type: "main" | "boss"
- difficulty: "beginner" | "intermediate" | "advanced"
- bloom_target: "remember_understand" | "apply" | "analyze_evaluate" | "create"
- learning_type: "verbal_info" | "intellectual_skill" | "cognitive_strategy" | "motor_skill" | "attitude"
- priority: "must" | "should" | "nice_to_have"

完整性自检（输出前必须确认）：
1. 该领域的核心主题是否都有章节覆盖？有无明显遗漏的模块？
2. 每章节点是否具体独立、可单独学习？有无过于笼统的节点？
3. 每章 boss 是否能综合检验本章主要内容？
4. 依赖关系是否合理、无循环？
5. 依赖边是否都是直接依赖？是否存在可由中间节点抵达的传递冗余边？

输出必须是合法 JSON，不加任何 markdown 代码块。严格遵循以下结构：

{
  "nodes": [
    {
      "id": "node_1",
      "chapter": "章节名称",
      "chapter_order": 0,
      "name": "具体节点名称",
      "description": "该节点学习内容（1-2句话）",
      "node_type": "main",
      "difficulty": "beginner",
      "prerequisites": [],
      "required_tools": [],
      "bloom_target": "remember_understand",
      "learning_type": "verbal_info",
      "priority": "must",
      "source_ids": [],
      "rationale": "学习价值或编排理由"
    }
  ],
  "edges": [
    { "source": "node_1", "target": "node_2" }
  ]
}

注意：所有 id 必须唯一；edges 中的 source/target 必须都存在于 nodes 中；prerequisites 中引用的 id 也必须存在。`;

export const CHAPTER_SCOPE_SYSTEM_PROMPT = `你是学习路线知识点分配专家。根据给定的课程节点列表，为每个非 boss 节点分配互不重叠的知识点清单，以 JSON 输出。

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

export class DagPromptBuilder {
  buildGenerationPrompt(nodeTarget: NodeTarget, options: { searchMode?: SearchMode } = {}): string {
    const strictLibraryPrompt = options.searchMode === 'library'
      ? `\n\n【严格参考库模式】\n` +
        `- 本轮路线图只能依据系统提供的参考库证据摘要生成，不得联网，不得凭通用课程体系补出参考库中没有的章节、知识点或项目。\n` +
        `- 优先按参考库资料的目录、章节、小节、页级结构组织路线图；如果参考库只覆盖部分内容，就生成较小但忠实的路线图。\n` +
        `- 节点必须尽量填写参考库 source_ids；无法从参考库证据中找到支撑的节点不要生成。\n` +
        `- 如果资料缺少先修、练习或评估信息，不要自行补齐为新章节；只可在已有资料覆盖范围内设置必要的学习顺序和综合任务。\n` +
        `- rationale 只说明该节点为何由参考库结构推出，避免写“模型推断”或引入外部知识。`
      : '';
    return SIMPLE_GEN_SYSTEM_PROMPT +
      `\n\n课程建议规模：节点总数（含必要 boss 节点）约 ${nodeTarget.min}–${nodeTarget.max} 个，章节数约 ${nodeTarget.chapters} 章。这是初稿建议，不是硬性限制；若用户目标需要更完整覆盖，应优先保证知识结构完整、依赖清晰和综合检验合理。` +
      strictLibraryPrompt;
  }
}
