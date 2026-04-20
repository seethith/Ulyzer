import { z } from 'zod';
import { buildTool } from './index';
import { LLMAdapter } from '../../llm/adapter';

interface BloomCoverageResult {
  /** Bloom layers present in the generated content */
  layersFound:     string[];
  /** Layers that are missing or have too few tasks */
  missingLayers:   string[];
  /** Whether the Apply layer (第三层) has the highest count */
  applyIsDominant: boolean;
  issues:   string[];
  /** True when all 4 layers have at least one task AND Apply is dominant */
  passed:   boolean;
  suggestion: string;
}

/**
 * check_difficulty — validates that the generated practice material covers all
 * four Bloom cognitive layers with the correct proportion:
 *   Layer 1 (记忆/理解) ~20%  |  Layer 2 (分析/评估) ~15%
 *   Layer 3 (应用)      ~50%  |  Layer 4 (创造)      ~15%
 *
 * If passed=false the outer model should add tasks for the missing layers.
 */
export const checkDifficultyTool = buildTool<
  { content: string; nodeName: string },
  BloomCoverageResult
>({
  name: 'check_difficulty',
  description:
    '校验生成的实践资料是否覆盖四个布鲁姆认知层级，且应用层（第三层）占比最高。' +
    '生成实践题目后**必须调用**；若 passed=false，按 suggestion 补充缺失层级后重新调用 save_file。',
  inputSchema: z.object({
    content:  z.string().describe('生成的完整实践资料内容（Markdown）'),
    nodeName: z.string().describe('节点名称'),
  }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      content:  { type: 'string', description: '生成的实践资料内容（完整 Markdown）' },
      nodeName: { type: 'string', description: '节点名称' },
    },
    required: ['content', 'nodeName'],
  },
  maxResultChars: 800,
  execute: async ({ content, nodeName }, { provider, model, signal }) => {
    const FALLBACK: BloomCoverageResult = {
      layersFound:     [],
      missingLayers:   ['校验失败，无法确定'],
      applyIsDominant: false,
      issues:          ['质量校验响应解析失败'],
      suggestion:      '校验器未能解析响应，建议人工核查四个布鲁姆层级是否均有题目，且应用层占比最高。',
      passed:          false,
    };

    let raw = '';
    await LLMAdapter.stream({
      provider,
      model,
      systemPrompt:
        '你是布鲁姆认知层级覆盖校验助手。分析实践资料中四个布鲁姆层级的覆盖情况。\n\n' +
        '四层定义：\n' +
        '- 第一层（记忆/理解）：问答、判断、填空、名词解释类题目\n' +
        '- 第二层（分析/评估）：比较分析、优劣评价、场景判断、需说明理由的题目\n' +
        '- 第三层（应用）：代码题、操作任务、情景模拟、有约束条件的实操任务\n' +
        '- 第四层（创造）：开放性综合任务、设计题、无标准答案的创作任务\n\n' +
        '输出 JSON（不加代码块）：\n' +
        '{"layersFound":["第一层","第三层"],"missingLayers":["第二层","第四层"],' +
        '"applyIsDominant":true,"issues":[],"suggestion":""}',
      messages: [
        { role: 'user', content: `节点：${nodeName}\n\n资料内容：\n${content.slice(0, 3000)}` },
      ],
      maxTokens:   400,
      temperature: 0.1,
      signal,
      onChunk:    (c) => { raw += c; },
      onComplete: () => {},
      onError:    () => {},
    });

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return FALLBACK;
      const parsed = JSON.parse(match[0]) as Omit<BloomCoverageResult, 'passed'>;
      const allFourCovered = (parsed.missingLayers ?? []).length === 0;
      return {
        ...parsed,
        passed: allFourCovered && (parsed.applyIsDominant ?? false),
      };
    } catch {
      return FALLBACK;
    }
  },
  formatResult: ({ layersFound, missingLayers, applyIsDominant, issues, suggestion, passed }) =>
    `${passed ? '✓ 布鲁姆层级覆盖校验通过' : '✗ 需要补充'}\n` +
    `已覆盖层级：${layersFound.join('、') || '无'}\n` +
    `缺失层级：${missingLayers.join('、') || '无'}\n` +
    `应用层占比最高：${applyIsDominant ? '是' : '否'}\n` +
    `${issues.length > 0 ? '问题：' + issues.join('；') + '\n' : ''}` +
    `${suggestion || ''}`,
});
