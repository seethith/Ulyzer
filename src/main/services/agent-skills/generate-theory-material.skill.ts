import type { AgentSkill } from './skill';

const workflowPromptZh =
  '生成原理资料，主依据 [学习蓝图 / 纲要] 中的 v1 学习蓝图：学习目标、核心知识结构、核心关系、表征/例反例、常见误解和掌握证据；轻量参考 v2 实践与出题蓝图中的掌握证据、题型方向和实践桥，让讲解能自然过渡到后续练习。（[已有资料覆盖情况] 已有内容不重复。）\n' +
  '使用系统已放入上下文的参考来源；除非系统明确开放并说明补搜原因，否则不要调用 web_search；不要读取 outline，学习蓝图已在上下文中。若参考来源中包含 AI 已生成资料（generated、思维导图、复盘清单、旧原理/实践资料），只用于避免重复和了解已有覆盖，不要把它当作事实权威来源。内容要聚焦，少堆长文，多做分段、信号标记、图文靠近和关键概念先铺垫。\n' +
  '数学公式必须使用标准 Markdown + LaTeX：行内公式写 `$a+b$`；块级公式写成 `$$` 单独一行、公式正文、`$$` 单独一行；不要用裸 `[ ... ]` 包公式；矩阵、cases、array 的换行必须写双反斜杠 `\\\\`，不要只写单个 `\\`。\n' +
  '资料结构不再固定为六节。请根据节点类型自由组织标题，但必须完成以下学习功能槽位：\n' +
  '1. **真实问题入口**：开头用一个本节点能解决的具体问题/任务切入，说明为什么值得学，不要直接百科式堆定义。\n' +
  '2. **激活旧知**：用很短的清单唤起 3-5 个前置概念或技能；只点亮，不展开成新教程。\n' +
  '3. **关键概念先铺垫**：核心概念用短块呈现，每块包含一句话定义、解决什么问题、对应的公式/图像/例子、最容易混淆点。\n' +
  '4. **核心模型与图文靠近**：可用 Mermaid 或表格展示核心关系，图后紧接解释每个节点/箭头。Mermaid 必须使用安全子集：第一行只写 `flowchart TD` 或 `flowchart LR`，节点 ID 只用 ASCII（A、B1、concept_1），节点文本必须双引号（A["概念说明"]），标签内部不要再写双引号或 `["..."]`（维度写成 `A(m×n)`，不要写 `A["m×n"]`），连线只用 `A --> B` 或 `A -->|"关系"| B`，子图只用 `subgraph sg1["标题"] ... end`；禁止中文节点 ID、未加引号节点文本、圆形/胶囊/嵌套括号形状、mindmap/sequence/class 等其他图类型。\n' +
  '5. **最小 worked example**：给一个完整但不过长的示范例子，说明每一步为什么这么做、算到什么、如何验证；数学/编程/语言/动作节点都要选适合本节点的最小演示。\n' +
  '6. **少量操作骨架**：提供必要的步骤框架或判断流程，作为 supportive information + 少量 procedural information；不要把原理资料写成大量练习题，变式训练留给实践资料。\n' +
  '7. **误区与边界**：列出本节点最容易破坏理解的误区、为什么会错、正确理解和一个小反例/校正例。\n' +
  '8. **应用与整合**：回到开头真实问题，说明现在能解决什么、还能连接到哪些应用或后续节点。\n' +
  '9. **进入实践资料的桥**：结尾给出下一步练习建议，按“如果你卡在 X，就练 Y；能做到 Z 就算可以进入实践资料”的形式写；建议必须具体，禁止时间估算。\n' +
  '10. **参考资料**：保留参考资料章节。每条资源给出完整链接（优先使用上方权威参考来源中的 URL）+ 搜索建议词（链接失效或想找更多时使用）。格式：`- [资源名称](完整URL) — 搜索："关键词"`。视频资源同样格式，URL 来自参考来源时直接用，无 URL 时只给搜索建议词。';

const workflowPromptEn =
  'Generate theory materials primarily from the v1 Learning Blueprint in [Learning Blueprint / Outline]: learning goals, core knowledge structure, core relations, representations/examples/counterexamples, misconceptions, and mastery evidence. Use the v2 Practice & Exercise Blueprint lightly for mastery evidence, exercise directions, and the bridge into later practice. Do not repeat already-covered content listed in [Coverage Index].\n' +
  'Use the reference sources already placed in context; do not call web_search unless the system explicitly enables it with a stated gap. Do not read outline because the blueprint is already in context. If the reference package includes AI-generated materials (generated sources, mindmaps, review checklists, or previous theory/practice files), use them only to avoid repetition and understand existing coverage, not as authoritative factual sources. Keep the artifact focused: less long exposition, more short segments, clear signaling, nearby text/visual explanations, and early pretraining of key concepts.\n' +
  'Math must use standard Markdown + LaTeX: inline math as `$a+b$`; display math as `$$` on its own line, formula body, then `$$` on its own line; do not wrap formulas in bare `[ ... ]`; matrix/cases/array row breaks must use double backslashes `\\\\`, not a single `\\`.\n' +
  'The material is no longer locked to a six-section outline. Choose headings freely for the node type, but complete these learning-function slots:\n' +
  '1. **Real problem entry**: open with a concrete problem/task this node helps solve and why it matters; avoid starting as a mini encyclopedia.\n' +
  '2. **Activate prior knowledge**: briefly list 3-5 prerequisite concepts or skills; activate them without turning them into a full tutorial.\n' +
  '3. **Pretrain key concepts**: present each core concept as a short block: one-sentence definition, what problem it solves, where it appears in formula/visual/example, and its easiest confusion.\n' +
  '4. **Core model with nearby explanation**: use a Mermaid diagram or table when helpful, and explain every node/edge immediately after it. Mermaid must use this safe subset: first line only `flowchart TD` or `flowchart LR`; node ids ASCII only (A, B1, concept_1); node labels always double-quoted (A["Concept"]); do not put extra double quotes or `["..."]` inside a label (write `A(m×n)`, not `A["m×n"]`); edges only `A --> B` or `A -->|"relation"| B`; subgraphs only `subgraph sg1["Title"] ... end`; do not use non-ASCII node ids, unquoted labels, round/circle/nested-bracket node shapes, or other diagram types such as mindmap/sequence/class.\n' +
  '5. **Minimal worked example**: include one complete but compact demonstration; explain why each step is taken, what it computes, and how to verify it. Use the most suitable example type for math/programming/language/motor-skill nodes.\n' +
  '6. **Small procedural skeleton**: provide only the necessary steps or decision flow as supportive information plus a little procedural information; do not turn theory material into a large exercise set.\n' +
  '7. **Misconceptions and boundaries**: for the most damaging misconceptions, show the wrong idea, why it is tempting, the correct view, and a small counterexample or correction.\n' +
  '8. **Application and integration**: return to the opening problem and state what the learner can now solve, plus key applications or follow-up nodes.\n' +
  '9. **Bridge into practice**: end with concrete next-practice guidance in the form “if you are stuck at X, practice Y; if you can do Z, move to practice material.” No time estimates.\n' +
  '10. **References**: keep a references section. For each resource: full link (prefer URLs from the authoritative sources above) + search suggestion. Format: `- [Resource Name](full URL) — Search: "keywords"`. Video resources use the same format; if no URL is available, provide search keywords only.';

export const generateTheoryMaterialSkill: AgentSkill = {
  id: 'generate_theory_material',
  title: {
    zh: '生成原理资料',
    en: 'Generate Theory Material',
  },
  description: {
    zh: '为当前节点生成结构化原理讲解，优先依据学习蓝图补齐核心关系、表征、例子/反例和误解。',
    en: 'Generate structured theory material for the current node, using the learning blueprint to cover core relations, representations, examples/counterexamples, and misconceptions.',
  },
  workflowPrompt: {
    zh: workflowPromptZh,
    en: workflowPromptEn,
  },
  materialFolders: ['theory'],
  materialWorkflowPrompts: {
    theory: {
      zh: workflowPromptZh,
      en: workflowPromptEn,
    },
  },
  defaultRequestPrefixes: {
    zh: [
      '帮我生成原理资料',
      '请按照当前节点的知识纲要，为我生成一份原理资料',
    ],
    en: [
      'Following the current node outline, please generate theory material',
    ],
  },
};
