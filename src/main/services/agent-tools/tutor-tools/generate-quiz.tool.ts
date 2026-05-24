import { z } from 'zod';
import { NodeRepository } from '../../db/repositories/node.repo';
import { buildTool } from './index';
import { toolDescription, toolPropertyDescription } from '../../agent-i18n/tool-descriptions';
import { computeQuizCount, readKcCountFromOutline } from '../../agent-workflows/node-sizing';

const nodeRepo = new NodeRepository();

/**
 * generate_quiz — produces an exercise blueprint for practice generation.
 *
 * Reads the learning blueprint / knowledge outline from the initial message and
 * returns a two-axis plan: cognitive action × exercise function.
 *
 * totalCount defaults to a value computed from node metadata + actual KC count
 * so simpler nodes get fewer questions and complex/boss nodes get more.
 */
export const generateQuizTool = buildTool<
  { nodeName: string; totalCount?: number },
  { plan: string }
>({
  name: 'generate_quiz',
  description: toolDescription('generate_quiz'),
  inputSchema: z.object({
    nodeName:   z.string().describe(toolPropertyDescription('generate_quiz', 'nodeName')),
    totalCount: z.number().int().min(4).max(20).optional().describe(toolPropertyDescription('generate_quiz', 'totalCount')),
  }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      nodeName:   { type: 'string',  description: toolPropertyDescription('generate_quiz', 'nodeName') },
      totalCount: { type: 'number',  description: toolPropertyDescription('generate_quiz', 'totalCount') },
    },
    required: ['nodeName'],
  },
  maxResultChars: 2600,
  execute: async ({ nodeName, totalCount }, ctx) => {
    // Compute recommended count from node metadata + actual KC count in saved outline.
    // Falls back to 8 if node not found (e.g. context-less invocation).
    let recommended = 8;
    if (ctx?.nodeId && ctx?.courseId) {
      const node = nodeRepo.findById(ctx.nodeId);
      if (node) {
        const kcCount = readKcCountFromOutline(ctx.courseId, ctx.nodeId);
        recommended = computeQuizCount(kcCount, node);
      }
    }
    const total = totalCount ?? recommended;

    const l1 = Math.max(1, Math.round(total * 0.20));   // 理解       ~20%
    const l2 = Math.max(1, Math.round(total * 0.25));   // 分析/评估  ~25%
    const l3 = Math.max(1, Math.round(total * 0.40));   // 应用       ~40%
    const l4 = Math.max(1, total - l1 - l2 - l3);      // 创造/迁移  ~15%

    const plan =
      `# Exercise Blueprint — 节点「${nodeName}」（共 ${total} 题）\n\n` +
      `请优先从初始消息的 v2 实践与出题蓝图提取 KC×题型矩阵、题型模板、错误触发补练和下一轮练习规则；辅以 v1 的 KC/掌握证据与 v3 的复盘线索。参考 [实践题源简报] 的题型范式，特别是其中的结构化题目资产。\n` +
      `不要照搬题源原题或题目资产；只模仿题干结构、约束方式、答案结构和评分方式，并改写情境、变量或数据。\n\n` +
      `## 1. 认知动作建议配额（可按蓝图证据微调）\n` +
      `- 理解：${l1} 题，用于确认定义、边界、基本辨析，不得成为主体。\n` +
      `- 分析/评估：${l2} 题，用于比较、诊断、取舍、判断适用条件，必须要求说明理由。\n` +
      `- 应用：${l3} 题，作为主体，覆盖所有关键 KC；每个关键 KC 至少 1 个可操作任务。\n` +
      `- 创造/迁移：${l4} 题，用于综合设计、开放任务或真实场景迁移，必须有评分维度。\n\n` +
      `## 2. 练习册式题型结构\n` +
      `请按以下 A/B/C/D 组组织题目，而不是只按四层罗列：\n` +
      `- A组：核心原型题。建立最标准的解题/操作模型，题干短、条件清晰、结果可判定。\n` +
      `- B组：变式训练。改变边界条件、限制、数据或场景，检查是否真的理解。\n` +
      `- C组：错误诊断。给出错误代码/错误推理/错误步骤/错误方案，要求定位、解释并修正。\n` +
      `- D组：迁移/综合。放入新场景，要求判断适用性、组合多个 KC 或完成小型任务。\n\n` +
      `## 3. 每题必须包含的元信息\n` +
      `每道题题干前或题干后必须标注：\n` +
      `- KC：KC编号 + 名称\n` +
      `- 认知动作：理解 | 应用 | 分析 | 评估 | 创造\n` +
      `- 题型：概念辨析 | 原型题 | 变式题 | 错误诊断 | 迁移/综合\n` +
      `- 来源策略：来源改编 | 题型参考 | AI原创\n\n` +
      `## 4. 出题质量约束\n` +
      `- 至少包含 1 道变式题和 1 道错误诊断题；应用题数量必须最多。\n` +
      `- 编程/计算题必须给可验证的输入/输出、测试用例或判定条件。\n` +
      `- 操作/制作/动作技能题必须给材料/环境、步骤要求和自检标准。\n` +
      `- 开放题/创造题必须给评分维度，不得只有"自由发挥"。\n` +
      `- 避免泛题：不要只问"解释 X""谈谈 X 的作用"；如果出现概念题，也必须用边界、反例或易错场景约束。\n` +
      `- 题目文件只保存题目；参考答案文件逐题给出解题思路、完整答案、常见错误提示。\n\n` +
      `生成完成后按 A/B/C/D 组保存 practice 文件，并在同一工作流保存 answer 文件。`;

    return { plan };
  },
  formatResult: ({ plan }) => plan,
});
