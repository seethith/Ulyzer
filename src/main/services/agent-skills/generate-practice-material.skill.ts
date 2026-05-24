import type { AgentSkill } from './skill';

const practicePromptZh =
  '生成练习册式实践资料，主依据 [学习蓝图 / 纲要] 中的 v2 实践与出题蓝图：KC×题型矩阵、题型模板库、变量变化维度、错误触发补练规则、交错练习策略、下一轮练习规则；辅以 v1 的 KC 与边界、v3 的题后反思接口。参考 [实践题源简报] 的题型范式和「结构化题目资产」。\n\n' +
  '**工作流：** 调用 generate_quiz 获取 Exercise Blueprint → 按蓝图生成 A/B/C/D 组题目 → 确保每题标注 KC、认知动作、题型、来源策略 → **在同一次响应中调用两次 save_file**（先保存题目文件，再保存参考答案文件）。\n\n' +
  '**持续出题 / 下一套练习：** 生成前必须阅读 [学习蓝图 / 纲要] 和 [已有资料覆盖情况]；如果其中有「出题历史」，要避开已用过的 KC×题型×场景组合。用户说“下一套 / 再来一套 / 继续练 / 不要重复”时，本次应生成新的续练题：优先补历史中薄弱或未覆盖的 KC/题型，换场景、变量、表征方式或错误类型。必要时可调用 read_node_materials 读取已有 practice/theory 的短预览来确认不要重复。\n\n' +
  '**双层结构：认知动作 × 练习册题型**\n' +
  '- 认知动作仍需形成合理梯度：理解、应用、分析、评估、创造；应用/分析题通常应是主体，但以学习蓝图的任务证据为准。\n' +
  '- 题目呈现必须按练习册结构组织：\n' +
  '  - **A组：核心原型题** — 建立最标准的解题/操作模型，题干短、条件清晰、结果可判定。\n' +
  '  - **B组：变式训练** — 改变边界条件、限制、数据或场景，检查是否真的理解。\n' +
  '  - **C组：错误诊断** — 给错误代码/错误推理/错误步骤/错误方案，要求定位、解释并修正。\n' +
  '  - **D组：迁移/综合** — 放入新场景，要求判断适用性、组合多个 KC 或完成小型任务。\n' +
  '- 每个关键 KC 至少被 1 道应用/分析/创造题覆盖；至少包含 1 道变式题和 1 道错误诊断题。\n\n' +
  '**每道题必须有元信息：**\n' +
  '- `KC：KC编号 + 名称`\n' +
  '- `认知动作：理解 | 应用 | 分析 | 评估 | 创造`\n' +
  '- `题型：概念辨析 | 原型题 | 变式题 | 错误诊断 | 迁移/综合`\n' +
  '- `来源策略：来源改编 | 题型参考 | AI原创`\n\n' +
  '**题目质量要求：**\n' +
  '- 不要照搬 [实践题源简报] 中的原题或结构化题目资产；只能模仿题型结构、约束方式、答案/评分方式，并改写情境、数据、变量或问法。\n' +
  '- 避免泛题：不要只问“解释 X”“谈谈 X 的作用”；概念题也必须带边界、反例或易错场景。\n' +
  '- 编程/计算题必须给可验证的输入/输出、测试用例或判定条件。\n' +
  '- 操作/制作/动作技能题必须给材料/环境、步骤要求和自检标准。\n' +
  '- 开放题/创造题必须给评分维度，不得只有“自由发挥”。\n\n' +
  '**选择题选项必须用列表格式（每个选项单独一行）：**\n  - A. 选项内容\n  - B. 选项内容\n\n' +
  '**⚠️ 每道题末尾必须标注来源（不得省略）：** 从权威资料/题库改编的写 `来源：{平台或书名} {URL或页码}`；AI 自行创作的写 `[AI原创]`。\n\n' +
  '**保存前自检：** 调用 save_file 前，逐题检查是否都有 `来源：...` 或 `[AI原创]`；缺一题就先补，不要把修复工作留给工具校验。\n\n' +
  '**⚠️ 关键要求——题目与答案必须分两个文件保存：**\n' +
  '1. **题目文件**（folderName: "practice"）：只含题目，不得在题后写答案；每题末尾标注题号（如 Q1、Q2）；文件末尾加一行 `> 参考答案见「参考答案」文件夹。`\n' +
  '2. **参考答案文件**（folderName: "answer"，与题目文件同一次响应中保存）：文件名与题目文件相同（如 题目文件名是 xxx-练习题.md，答案文件名即 xxx-参考答案.md）；' +
  '文件顶部必须加声明：`> ⚠️ 以下为 AI 生成的参考答案，仅供对照，建议核实后使用。`；' +
  '每道题按 Q1/Q2… 编号列出：解题思路 → 完整答案/评分维度 → 常见错误提示；' +
  '编程题额外提供可运行的测试用例（输入/预期输出）；创造层题目给出评分维度说明而非标准答案。';

const practicePromptEn =
  'Generate workbook-style practice exercises primarily from the v2 Practice & Exercise Blueprint in [Learning Blueprint / Outline]: KC×exercise matrix, template library, variation dimensions, error-trigger remediation rules, interleaving strategy, and next-round practice generation rules. Use v1 for KC boundaries and v3 for post-question reflection prompts. Use [Practice Source Brief] and its structured exercise assets as exercise-pattern evidence.\n\n' +
  '**Workflow:** Call generate_quiz for the Exercise Blueprint → generate A/B/C/D exercise groups from the blueprint → label every question with KC, cognitive action, exercise type, and source strategy → **call save_file twice in the same response** (first save the exercise file, then the answer key).\n\n' +
  '**Continuous practice / next set:** Before generation, read both [Learning Blueprint / Outline] and [Coverage Index]. If Practice History exists, avoid repeated KC × exercise type × scenario combinations. When the user asks for a next/additional/non-repeating set, generate a new continuation set: prioritize weak or uncovered KC/type areas from history and change scenarios, variables, representations, or error types. If needed, call read_node_materials for existing practice/theory previews to avoid repetition.\n\n' +
  '**Two-axis structure: cognitive action × workbook exercise type:**\n' +
  '- Cognitive actions should form a reasonable progression: Understand, Apply, Analyze, Evaluate, Create. Apply/Analyze tasks are usually the body, but follow the blueprint evidence model.\n' +
  '- Present exercises as workbook groups:\n' +
  '  - **Group A: Core Prototype Exercises** — standard, compact, well-constrained tasks with checkable outcomes.\n' +
  '  - **Group B: Variations** — change boundaries, constraints, data, or scenarios to test real understanding.\n' +
  '  - **Group C: Error Diagnosis** — provide wrong code/reasoning/steps/plans; ask the learner to locate, explain, and fix the error.\n' +
  '  - **Group D: Transfer/Synthesis** — new scenarios requiring applicability judgment, KC combination, or a small authentic task.\n' +
  '- Every key KC must be covered by at least one Apply/Analyse/Create exercise; include at least one variation and one diagnosis exercise.\n\n' +
  '**Every question must include metadata:**\n' +
  '- `KC: KC id + name`\n' +
  '- `Cognitive Action: Understand | Apply | Analyze | Evaluate | Create`\n' +
  '- `Type: Concept Check | Prototype | Variation | Error Diagnosis | Transfer/Synthesis`\n' +
  '- `Source Strategy: Adapted | Pattern Reference | AI Original`\n\n' +
  '**Quality requirements:**\n' +
  '- Do not copy source questions from [Practice Source Brief] or structured exercise assets; imitate structure, constraints, answer format, and rubric style only, and rewrite scenario/data/variables/question wording.\n' +
  '- Avoid generic prompts like "Explain X" or "Discuss the role of X"; even concept checks need boundaries, counterexamples, or misconception scenarios.\n' +
  '- Coding/calculation tasks must include verifiable input/output, tests, or acceptance criteria.\n' +
  '- Operational/motor/creative tasks must include materials/context, required steps, and self-check criteria.\n' +
  '- Open-ended/Create tasks must include rubrics, not just "be creative".\n\n' +
  '**Multiple-choice options must use list format (one option per line):**\n  - A. option text\n  - B. option text\n\n' +
  '**⚠️ Each question must end with a source citation (mandatory):** Adapted from authoritative material: `Source: {platform or book} {URL or page}`; AI-original: `[AI Original]`\n\n' +
  '**Pre-save self-check:** Before calling save_file, check every question for either `Source: ...` or `[AI Original]`; if any question is missing it, fix the draft before saving.\n\n' +
  '**⚠️ Critical — exercises and answers must be saved in two separate files:**\n' +
  '1. **Exercise file** (folderName: "practice"): questions only, no inline answers; label each question Q1, Q2…; add at the end: `> Answer key is in the "Answer" folder.`\n' +
  '2. **Answer key file** (folderName: "answer", saved in the same response): filename should match the exercise file; must start with: `> ⚠️ AI-generated answer key — for reference only, please verify before use.`; each answer labelled Q1/Q2…: reasoning → full answer → common mistakes; coding questions include runnable test cases (input / expected output); Tier 4 creative questions provide evaluation rubrics instead of standard answers.';

const answerPromptZh =
  '生成参考答案文件，对应「实践资料」中已有的题目。\n\n' +
  '**格式要求：**\n' +
  '- 文件顶部必须加声明：`> ⚠️ 以下为 AI 生成的参考答案，仅供对照，建议核实后使用。`\n' +
  '- 按题号（Q1/Q2…）逐题列出，每题包含：解题思路 → 完整答案 → 常见错误提示\n' +
  '- 编程题额外提供可运行的测试用例（输入/预期输出）\n' +
  '- 创造层开放题给出评分维度说明而非标准答案\n' +
  '- folderName 必须填 "answer"，文件名与对应题目文件相同（将题目文件名中的"练习题"替换为"参考答案"）';

const answerPromptEn =
  'Generate an answer key file corresponding to an existing exercise file in the Practice folder.\n\n' +
  '**Format requirements:**\n' +
  '- File must begin with: `> ⚠️ AI-generated answer key — for reference only, please verify before use.`\n' +
  '- List each answer by question number (Q1/Q2…): reasoning → full answer → common mistakes\n' +
  '- Coding questions must include runnable test cases (input / expected output)\n' +
  '- Tier 4 creative questions provide evaluation rubrics instead of standard answers\n' +
  '- folderName must be "answer"; the filename should match the corresponding exercise file';

export const generatePracticeMaterialSkill: AgentSkill = {
  id: 'generate_practice_material',
  title: {
    zh: '生成实践资料',
    en: 'Generate Practice Material',
  },
  description: {
    zh: '为当前节点生成分层练习，并在同一工作流中拆分保存题目与参考答案。',
    en: 'Generate tiered practice exercises and split exercises from the answer key in the same workflow.',
  },
  workflowPrompt: {
    zh: practicePromptZh,
    en: practicePromptEn,
  },
  materialFolders: ['practice', 'answer'],
  materialWorkflowPrompts: {
    practice: {
      zh: practicePromptZh,
      en: practicePromptEn,
    },
    answer: {
      zh: answerPromptZh,
      en: answerPromptEn,
    },
  },
  defaultRequestPrefixes: {
    zh: [
      '帮我生成实践资料',
      '请按照当前节点的知识纲要，为我生成一套练习题',
    ],
    en: [
      'Following the current node outline, please generate practice exercises',
    ],
  },
};
