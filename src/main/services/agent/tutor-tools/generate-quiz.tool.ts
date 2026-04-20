import { z } from 'zod';
import { buildTool } from './index';

/**
 * generate_quiz — produces a Bloom-layer coverage plan for practice generation.
 *
 * Reads the knowledge points (with Bloom annotations) from the initial message's
 * [知识纲要] and returns an explicit per-layer plan: which knowledge points map to
 * which Bloom layer, with suggested task formats and count targets.
 *
 * This gives the model a concrete anchor before generating content, preventing
 * knowledge-point omissions and wrong task formats.
 */
export const generateQuizTool = buildTool<
  { nodeName: string; totalCount: number },
  { plan: string }
>({
  name: 'generate_quiz',
  description:
    '生成四层布鲁姆实践出题计划。调用后，按返回的计划逐层生成题目，确保每层都有题目且应用层（第三层）占比最高（约 50%）。' +
    '调用时机：开始生成实践资料前，用于规划每个知识点对应的布鲁姆层级和题型。',
  inputSchema: z.object({
    nodeName:   z.string().describe('节点名称'),
    totalCount: z.number().int().min(4).max(20).default(8).describe('总题目数量，默认 8'),
  }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      nodeName:   { type: 'string',  description: '节点名称' },
      totalCount: { type: 'number',  description: '总题目数量（4-20，默认 8）' },
    },
    required: ['nodeName'],
  },
  maxResultChars: 1200,
  execute: async ({ nodeName, totalCount }) => {
    const total = totalCount ?? 8;
    const l1 = Math.max(1, Math.round(total * 0.20));   // 记忆/理解  ~20%
    const l2 = Math.max(1, Math.round(total * 0.15));   // 分析/评估  ~15%
    const l3 = Math.max(1, Math.round(total * 0.50));   // 应用       ~50%
    const l4 = Math.max(1, total - l1 - l2 - l3);      // 创造       ~15%

    const plan =
      `节点「${nodeName}」实践出题计划（共 ${total} 题）\n\n` +
      `请从初始消息的 [知识纲要（含布鲁姆认知层级）] 中提取各知识点，按以下层级分配：\n\n` +
      `## 第一层：记忆/理解（${l1} 题）\n` +
      `对应知识纲要中标注 [记忆/理解] 的知识点。\n` +
      `题型选择：问答题、判断题、填空题、名词解释——选最能暴露"背了但没理解"的形式。\n\n` +
      `## 第二层：分析/评估（${l2} 题）\n` +
      `对应标注 [分析/评估] 的知识点。\n` +
      `题型选择：比较分析、优劣评价、场景判断——每题必须要求学生说明理由，无唯一答案。\n\n` +
      `## 第三层：应用（${l3} 题）⭐ 重点层\n` +
      `覆盖所有知识点（[应用] 标注的优先，其余知识点也需有应用任务）。\n` +
      `题型选择（根据知识点性质自主判断）：\n` +
      `  - 编程/数学 → 有标准解法的代码题或计算题\n` +
      `  - 操作/制作 → 具体步骤任务（列出材料、工具、步骤）\n` +
      `  - 情景/表演 → 给定场景的模拟任务（含评分维度）\n` +
      `  - 创意技能 → 有明确约束条件的实操任务（如"用X材料实现Y效果"）\n` +
      `  每个知识点至少 1 个应用任务。\n\n` +
      `## 第四层：创造（${l4} 题）\n` +
      `对应标注 [创造] 的知识点（无则从进阶知识点中选）。\n` +
      `开放性综合任务，明确评价维度（完整性/创意性/技术准确性等），学生自主选择完成方式。\n\n` +
      `生成完成后确保四层均有题目且应用层（第三层）题目数量最多，再调用 save_file 保存。`;

    return { plan };
  },
  formatResult: ({ plan }) => plan,
});
