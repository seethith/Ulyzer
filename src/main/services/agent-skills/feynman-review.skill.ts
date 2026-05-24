import type { AgentSkill } from './skill';
import { normalizeLanguage } from '../agent-i18n/messages';

interface FeynmanReviewPromptInput {
  nodeName: string;
  chapter: string;
  difficultyLabel: string;
  outlineText?: string;
  learningType?: string | null;
  bloomTarget?: string | null;
  prerequisiteNames?: string;
  language?: string;
}

const learningTypeDeepeningZh: Record<string, string> = {
  motor_skill:
    '**动作技能型节点（motor_skill）** — 每个知识点的深化问题必须围绕：\n' +
    '- 步骤顺序：第 N 步和第 N+1 步的先后原因是什么？\n' +
    '- 自检标准：正确完成这一步的判断依据是什么？\n' +
    '- 错误识别：做错了会有什么可观察的症状？\n' +
    '禁止使用选择题或判断题格式。',
  intellectual_skill:
    '**智识技能型节点（intellectual_skill）** — 每个知识点的深化问题必须围绕：\n' +
    '- 推导过程：为什么是这样，而不是更直觉的做法？\n' +
    '- 边界条件：这个方法/公式在什么情况下不成立？\n' +
    '- 反例构造：能不能举一个这个知识点不适用的例子？',
  cognitive_strategy:
    '**认知策略型节点（cognitive_strategy）** — 每个知识点的深化问题必须围绕：\n' +
    '- 元认知过程：你怎么知道自己用对了这个策略？\n' +
    '- 调试思路：卡住时你会怎么诊断？从哪里开始排查？\n' +
    '- 策略选择依据：为什么选这个策略而不是另一个？',
  verbal_info:
    '**言语信息型节点（verbal_info）** — 每个知识点的深化问题必须围绕：\n' +
    '- 精确边界：定义里最关键的限定词是哪个，去掉它会怎样？\n' +
    '- 概念区分：与相近概念的精确区别在哪条边界上？\n' +
    '- 自发类比：用你自己的话，打一个能解释这个概念的比方。',
  attitude:
    '**态度/审美型节点（attitude）** — 每个知识点的深化问题必须围绕：\n' +
    '- 判断依据：你的判断标准是什么，怎么量化或描述？\n' +
    '- 反转条件：在什么情况下你的判断会反转？\n' +
    '- 价值冲突：如果两个你认可的标准相互冲突，如何取舍？',
};

const learningTypeDeepeningEn: Record<string, string> = {
  motor_skill:
    '**Motor-skill node (motor_skill)** — for each KC, deepen around:\n' +
    '- Step order: why does step N need to precede step N+1?\n' +
    '- Self-check standard: what should the learner observe when the step is correct?\n' +
    '- Error recognition: what visible symptom appears when this goes wrong?\n' +
    'Do not use multiple-choice or true/false formats.',
  intellectual_skill:
    '**Intellectual-skill node (intellectual_skill)** — for each KC, deepen around:\n' +
    '- Reasoning path: why does this work instead of the more intuitive approach?\n' +
    '- Boundary conditions: when does this method/formula break down?\n' +
    '- Counterexample construction: can you give a case where this KC does not apply?',
  cognitive_strategy:
    '**Cognitive-strategy node (cognitive_strategy)** — for each KC, deepen around:\n' +
    '- Metacognition: how do you know you used the strategy correctly?\n' +
    '- Debugging: when stuck, how do you diagnose the problem and where do you start?\n' +
    '- Strategy choice: why this strategy instead of another?',
  verbal_info:
    '**Verbal-information node (verbal_info)** — for each KC, deepen around:\n' +
    '- Precise boundary: which qualifier in the definition matters most, and what changes if it is removed?\n' +
    '- Concept distinction: what exact boundary separates it from similar concepts?\n' +
    '- Original analogy: explain the concept with an analogy in your own words.',
  attitude:
    '**Attitude/aesthetic node (attitude)** — for each KC, deepen around:\n' +
    '- Judgment basis: what is your standard and how can you describe or quantify it?\n' +
    '- Reversal condition: when would your judgment change?\n' +
    '- Value conflict: how do you choose when two accepted standards conflict?',
};

const bloomReviewSuggestionZh: Record<string, string> = {
  remember_understand:
    '建议明天快速过一遍本节知识点的定义，3 天后尝试不看资料用自己的话各讲一遍，1 周后再做一次本清单的第一节。',
  analyze_evaluate:
    '建议 2 天后找一个新的对比场景，重新分析各知识点的优劣取舍；1 周后做一道需要综合判断的分析题。',
  apply:
    '建议 3 天后在一个新场景中尝试应用本节技能，做不出来时只看原理资料对应知识点，不要直接搜答案。',
  create:
    '建议 1 周后独立完成一个综合任务，看能否把本节所有知识点融入其中；评估维度：完整性 + 灵活运用 + 质量。',
};

const bloomReviewSuggestionEn: Record<string, string> = {
  remember_understand:
    'Tomorrow, quickly revisit the definitions in this node. In 3 days, explain each one from memory in your own words. In 1 week, redo section 1 of this checklist.',
  analyze_evaluate:
    'In 2 days, choose a new comparison scenario and reassess the tradeoffs. In 1 week, complete an analysis task that requires integrated judgment.',
  apply:
    'In 3 days, apply this skill in a new scenario. If you get stuck, consult the corresponding theory material first instead of jumping straight to search.',
  create:
    'In 1 week, complete an integrated task independently and check whether you can weave all KCs from this node into it. Evaluate completeness, flexible use, and quality.',
};

function learningTypeNote(learningType: string | null | undefined, language?: string): string {
  if (!learningType) return '';
  const notes = normalizeLanguage(language) === 'en' ? learningTypeDeepeningEn : learningTypeDeepeningZh;
  return notes[learningType] ?? '';
}

function bloomReviewSuggestion(bloomTarget: string | null | undefined, language?: string): string {
  const suggestions = normalizeLanguage(language) === 'en' ? bloomReviewSuggestionEn : bloomReviewSuggestionZh;
  if (bloomTarget && suggestions[bloomTarget]) return suggestions[bloomTarget];
  return suggestions.apply;
}

export function buildFeynmanReviewWorkflowPrompt(input: FeynmanReviewPromptInput): string {
  const note = learningTypeNote(input.learningType, input.language);
  const reviewSuggestion = bloomReviewSuggestion(input.bloomTarget, input.language);

  if (normalizeLanguage(input.language) === 'en') {
    const prereqQuestion = input.prerequisiteNames
      ? `How is this node related to "${input.prerequisiteNames}"? After finishing it, did your understanding of those prerequisites change?`
      : 'Where does this node sit in the whole course system? What problem does it solve that the prerequisite knowledge could not solve?';

    return (
      `You are the deep-review coach for node "${input.nodeName}" (${input.chapter}, ${input.difficultyLabel} difficulty).\n` +
      (input.outlineText ? `\n[Three-Layer Blueprint Context]\n${input.outlineText}\n\n` : '') +
      'Generate a **five-part deep Feynman review checklist** that helps the learner reflect and consolidate after finishing this node.\n\n' +
      '**Core principles:**\n' +
      '- This checklist is for internal reflection, not a test paper. Do not use multiple-choice or true/false questions.\n' +
      '- Every question must be impossible to answer by rote memorisation alone; it should require real understanding.\n' +
      '- After every question, leave a line `→ My thinking: ____` for the learner to fill in.\n' +
      (note ? `\n${note}\n` : '') +
      '\nOutput exactly the following five-part structure. Do not omit any section:\n\n' +
      '---\n\n' +
      '## 0. Active Recall (do this first, about 3 minutes)\n\n' +
      `> Before reading anything below, close your eyes or look at a blank area and replay what you remember about "${input.nodeName}".\n` +
      '> Do not check materials or notes. Summarise what you can explain in one sentence, and mark what still feels unclear.\n\n' +
      '---\n\n' +
      '## 1. KC Deepening Questions\n\n' +
      'Use v3 Review & Deepening Blueprint as the primary basis, and use v1 KCs/mastery evidence plus v2 mistake/remediation cues as support. Generate 1-2 deepening questions per KC; if no blueprint is available, infer KCs from the node description.\n' +
      'Questions should match the blueprint evidence: definitions/boundaries, new-scenario use, tradeoff judgment, independent design, or error diagnosis.\n' +
      'Format:\n\n' +
      '**[KC name]** ([learning role] · [cognitive action])\n' +
      '→ [Deepening question 1]\n\n' +
      '   → My thinking: ____\n\n' +
      '→ [Deepening question 2 (optional)]\n\n' +
      '   → My thinking: ____\n\n' +
      '---\n\n' +
      '## 2. Integration & Distillation\n\n' +
      '(Output these three fixed questions. Do not omit them.)\n\n' +
      '**Q1. What is the single most important rule in this node?**\n' +
      '(Not a definition, but the idea/method you should remember after learning this node.)\n\n' +
      '→ My answer: ____\n\n' +
      '**Q2. Relationship to prerequisites**\n' +
      `${prereqQuestion}\n\n` +
      '→ My answer: ____\n\n' +
      '**Q3. Make an analogy**\n' +
      'What everyday object or situation can explain the core mechanism of this node?\n\n' +
      '→ My answer: ____\n\n' +
      '---\n\n' +
      '## 3. Learning Process Review\n\n' +
      '**1. Which part felt smoothest?**\n\n' +
      '→ ____\n\n' +
      '**2. Which part felt hardest or most confusing?**\n\n' +
      '→ ____\n\n' +
      'What was the root cause? Choose the closest one:\n' +
      '- [ ] Missing prerequisite knowledge\n' +
      '- [ ] The concept itself was hard to visualise\n' +
      '- [ ] The material was not clear enough\n' +
      '- [ ] My attention/state was poor at the time\n' +
      '- [ ] Other: ____\n\n' +
      '**3. If you learned this node again, what would you change?**\n\n' +
      '→ ____\n\n' +
      '---\n\n' +
      '## 4. Next Actions\n\n' +
      '**Open gaps** (list unclear KCs from section 1 here):\n' +
      '- [ ] ____\n' +
      '- [ ] ____\n\n' +
      '**Spaced review suggestion:**\n' +
      `${reviewSuggestion}\n\n` +
      '---'
    );
  }

  const prereqQuestion = input.prerequisiteNames
    ? `这个节点和「${input.prerequisiteNames}」是什么关系？学完之后，你对它的理解有没有发生变化？`
    : '本节知识在整个课程体系中"坐在什么位置"？它解决了什么前置知识解决不了的问题？';

  return (
    `你是节点「${input.nodeName}」（${input.chapter}，${input.difficultyLabel}难度）的深度复盘助手。\n` +
      (input.outlineText ? `\n[三层蓝图上下文]\n${input.outlineText}\n\n` : '') +
    '生成一份**五段式深度复盘清单**，帮助学员在学完本节后进行内心反思与深度巩固。\n\n' +
    '**核心原则**：\n' +
    '- 这是供学员自己对照内心反思的清单，不是测试卷，不要出选择题或判断题\n' +
    '- 每个问题都必须是"用背书无法回答"的，必须真正理解才能思考\n' +
    '- 每道问题后留一行"→ 我的思考：____"供学员填写\n' +
    (note ? `\n${note}\n` : '') +
    '\n严格按以下五段结构输出，不要省略任何段落：\n\n' +
    '---\n\n' +
    '## 〇、激活回忆（先做这件事，约 3 分钟）\n\n' +
    `> 在看下面任何内容之前，先做这件事：\n>\n> 闭上眼睛，或盯着空白处，把你记得的关于「${input.nodeName}」的东西在脑子里过一遍。\n` +
    '> 不查资料，不翻笔记。能说清楚的用一句话概括；说不清楚的记下来。\n>\n> （约 3 分钟，不要跳过——先主动回忆再对照，效果会完全不同）\n\n' +
    '---\n\n' +
    '## 一、知识点深化问题\n\n' +
    '优先依据上方 v3 复盘与深化蓝图，并辅以 v1 的 KC/掌握证据、v2 的错误与补练线索，逐条生成 1-2 个深化问题；若无蓝图则按节点描述推断知识点。\n' +
    '问题必须针对蓝图中的掌握证据：定义边界、新场景应用、取舍判断、独立设计或错误诊断。\n' +
    '格式：\n\n' +
    '**[知识点名称]**（[学习作用]·[认知动作]）\n' +
    '→ [深化问题1]\n\n' +
    '   → 我的思考：____\n\n' +
    '→ [深化问题2（可选）]\n\n' +
    '   → 我的思考：____\n\n' +
    '---\n\n' +
    '## 二、整合与提炼\n\n' +
    '（以下三个问题固定输出，不要省略）\n\n' +
    '**Q1. 本节最核心的一条规律是什么？**\n' +
    '（不是定义——而是：学完这节，最该记住的那一条思维/方法是什么？）\n\n' +
    '→ 我的回答：____\n\n' +
    '**Q2. 与前置知识的关系**\n' +
    `${prereqQuestion}\n\n` +
    '→ 我的回答：____\n\n' +
    '**Q3. 打一个类比**\n' +
    '如果用一个日常生活中的事物来比喻本节的核心机制，你会怎么比？（没有标准答案，能想到任何类比都算）\n\n' +
    '→ 我的回答：____\n\n' +
    '---\n\n' +
    '## 三、学习过程复盘\n\n' +
    '（回顾你学习这个节点的过程——不是内容本身，而是"你学的那个过程"）\n\n' +
    '**1. 哪个环节学得最顺？**（说明你的已有基础起了作用）\n\n' +
    '→ ____\n\n' +
    '**2. 哪个环节最费劲或最困惑？**\n\n' +
    '→ ____\n\n' +
    '费劲的根本原因是什么？（勾选最符合的）\n' +
    '- [ ] 缺少前置知识\n' +
    '- [ ] 概念本身难以直觉化\n' +
    '- [ ] 资料讲解不够清晰\n' +
    '- [ ] 自己当时注意力/状态不好\n' +
    '- [ ] 其他：____\n\n' +
    '**3. 如果重新学一次，你会改变什么？**\n\n' +
    '→ ____\n\n' +
    '---\n\n' +
    '## 四、下一步行动\n\n' +
    '**待解决的漏洞**（把第一节里没想清楚的知识点列在这里）：\n' +
    '- [ ] ____\n' +
    '- [ ] ____\n\n' +
    '**间隔复习建议：**\n' +
    `${reviewSuggestion}\n\n` +
    '---'
  );
}

export const feynmanReviewSkill: AgentSkill = {
  id: 'feynman_review',
  title: {
    zh: '费曼复盘',
    en: 'Feynman Review',
  },
  description: {
    zh: '生成节点学完后的深度复盘清单，聚焦主动回忆、知识点深化、整合提炼和下一步行动。',
    en: 'Generate a post-learning deep review checklist focused on active recall, KC deepening, synthesis, and next actions.',
  },
  workflowPrompt: {
    zh: '生成五段式深度复盘清单：激活回忆、知识点深化问题、整合与提炼、学习过程复盘、下一步行动。问题必须用背书无法回答，并为学员保留填写空间。',
    en: 'Generate a five-part deep review checklist: active recall, KC deepening questions, integration and distillation, learning process review, and next actions. Questions must require understanding rather than memorisation and leave space for learner reflection.',
  },
  defaultRequestPrefixes: {
    zh: [
      '帮我生成费曼复盘清单',
      '帮我总结复盘',
      '我已学完本节点，请为我生成一份费曼复盘清单',
    ],
    en: [
      "I've finished this node. Please generate a Feynman review checklist",
    ],
  },
};
