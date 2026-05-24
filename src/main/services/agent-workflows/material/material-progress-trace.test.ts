import { describe, expect, it } from 'vitest';
import type { DagNode, EvidencePack } from '@shared/types';
import type { ToolCallBlock, ToolResultBlock } from '../../llm/adapter';
import {
  analyzeOutlineContentForTrace,
  formatFeynmanContextTrace,
  formatFeynmanSaveTrace,
  formatMaterialContextTrace,
  formatMaterialSourceTrace,
  formatMaterialToolResultTrace,
  formatMaterialToolStartTrace,
  formatMaterialTurnTrace,
  formatOutlineContextTrace,
  formatOutlineSourceTrace,
  formatOutlineStepTrace,
  formatOutlineVerificationTrace,
} from './material-progress-trace';

function node(overrides: Partial<DagNode> = {}): DagNode {
  return {
    id: 'node-1',
    courseId: 'course-1',
    chapter: '基础',
    name: '闭包',
    description: '理解 lexical environment',
    difficulty: 'beginner',
    prerequisites: [],
    position: { x: 0, y: 0 },
    ...overrides,
  } as DagNode;
}

describe('material progress trace', () => {
  it('summarizes material context without dumping hidden reasoning', () => {
    const trace = formatMaterialContextTrace({
      node: node(),
      targetFolder: 'theory',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      searchMode: 'auto',
      userMessage: '请生成原理资料',
      outlineVersion: 'v2',
      kcNames: ['KC1 作用域', 'KC2 闭包'],
      indexEntryCount: 3,
      prerequisiteNames: '函数基础',
      language: 'zh',
    });

    expect(trace).toContain('资料生成过程');
    expect(trace).toContain('deepseek/deepseek-v4-flash');
    expect(trace).toContain('KC1 作用域');
    expect(trace).not.toContain('内化');
  });

  it('renders source budgets, selected sources and coverage gaps', () => {
    const pack: EvidencePack = {
      query: 'closure',
      taskType: 'theory',
      sources: [{
        id: 's1',
        courseId: 'course-1',
        nodeId: 'node-1',
        scope: 'node_private',
        usage: 'node_local',
        kind: 'web',
        origin: 'web_collected',
        title: 'MDN Closures',
        url: 'https://developer.mozilla.org/docs/Web/JavaScript/Guide/Closures',
        filePath: null,
        host: 'developer.mozilla.org',
        trustScore: 0.95,
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
      chunks: [{ sourceId: 's1', text: 'A closure is...', score: 0.9, sourceKind: 'web' }],
      coverage: { required: ['definition'], covered: [], missing: ['常见误区'] },
      budgetUsed: { queries: 2, pagesFetched: 1, reflectionSearches: 1, llmReranks: 1 },
      warnings: ['web search fallback used'],
    };

    const trace = formatMaterialSourceTrace({
      query: '闭包 JavaScript',
      searchMode: 'auto',
      isPractice: false,
      evidencePack: pack,
      language: 'zh',
    });

    expect(trace).toContain('检索预算');
    expect(trace).toContain('MDN Closures');
    expect(trace).toContain('常见误区');
  });

  it('summarizes save_file inputs instead of dumping full generated content', () => {
    const call: ToolCallBlock = {
      id: 'tool-1',
      name: 'save_file',
      input: {
        folderName: 'theory',
        filename: 'closure.md',
        content: '# 闭包\n\n## 概念\n\n' + '正文'.repeat(200),
      },
    };
    const result: ToolResultBlock = {
      toolCallId: 'tool-1',
      content: '文件已保存至：/tmp/closure.md',
    };

    const start = formatMaterialToolStartTrace(call, 'zh');
    const done = formatMaterialToolResultTrace({ call, result, durationMs: 1200, language: 'zh' });

    expect(start).toContain('filename=closure.md');
    expect(start).toContain('正文约');
    expect(start).not.toContain('正文正文正文正文正文正文正文正文正文正文');
    expect(done).toContain('成功');
    expect(done).toContain('1.2秒');
  });

  it('includes turn stop reason, tool names and token usage', () => {
    const trace = formatMaterialTurnTrace({
      turn: 1,
      stopReason: 'tool_use',
      toolNames: ['rag_retrieve', 'save_file'],
      usage: { inputTokens: 1000, outputTokens: 200, costCny: 0.01 },
      messageCount: 5,
      budgetUsed: 1200,
      budgetLimit: 10000,
      language: 'zh',
    });

    expect(trace).toContain('第 2 轮');
    expect(trace).toContain('tool_use');
    expect(trace).toContain('rag_retrieve');
    expect(trace).toContain('1,000');
    expect(trace).toContain('12%');
  });

  it('summarizes outline generation inputs and references', () => {
    const contextTrace = formatOutlineContextTrace({
      node: node({ learning_type: 'intellectual_skill', bloom_target: 'apply' }),
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      searchMode: 'library',
      currentVersion: 0,
      targetVersion: 1,
      kcTargetRange: '3-6',
      nodeScopeCount: 4,
      adjacentOutlineCount: 2,
      prerequisiteNames: '函数基础',
      language: 'zh',
    });
    const sourceTrace = formatOutlineSourceTrace({
      strictLibraryMode: true,
      language: 'zh',
      references: [
        { title: 'Closure syllabus', url: 'https://example.com/syllabus', kind: 'curriculum' },
        { title: 'Closure mistakes', url: 'https://example.com/mistakes', kind: 'misconception' },
      ],
    });

    expect(contextTrace).toContain('纲要生成过程');
    expect(contextTrace).not.toContain('KC 数量参考');
    expect(contextTrace).toContain('函数基础');
    expect(sourceTrace).toContain('课程结构 1，误解/边界 1');
    expect(sourceTrace).toContain('Closure syllabus');
  });

  it('renders outline stage timing without hidden reasoning', () => {
    const trace = formatOutlineStepTrace({
      step: '检索纲要参考',
      status: 'done',
      durationMs: 12_345,
      detail: '采用参考 4 条；课程结构 2，误解/边界 2。',
      language: 'zh',
    });

    expect(trace).toContain('纲要阶段：检索纲要参考 完成');
    expect(trace).toContain('12.3秒');
    expect(trace).toContain('采用参考 4 条');
    expect(trace).not.toContain('思考');
  });

  it('checks outline structure for trace display', () => {
    const content = `# 知识纲要 — 闭包（v1）

## 知识单元（KCs）

### KC1: 作用域
- 类型：陈述性
- 布鲁姆层级：[记忆/理解]
- 前置KC：无
- 掌握指标：解释作用域

### KC2: 闭包
- 类型：程序性
- 布鲁姆层级：[应用]
- 前置KC：KC1
- 掌握指标：识别闭包

## 常见误解（Misconceptions）
1. 误解：闭包等于函数 实际：闭包包含环境

## 边界条件
- 循环变量捕获`;

    const stats = analyzeOutlineContentForTrace(content);
    const trace = formatOutlineVerificationTrace({
      targetVersion: 1,
      content,
      kcTargetRange: '2-3',
      filename: '_outline_v1.md',
      language: 'zh',
    });

    expect(stats.kcCount).toBe(2);
    expect(stats.prerequisiteIssueCount).toBe(0);
    expect(trace).toContain('纲要校验');
    expect(trace).toContain('KC 2 个');
    expect(trace).toContain('_outline_v1.md');
  });

  it('summarizes Feynman review context and save status', () => {
    const outline = `# 知识纲要
## 知识单元（KCs）
### KC1: 作用域
- 布鲁姆层级：[记忆/理解]
## 常见误解（Misconceptions）
1. 误解：x
## 边界条件
- y`;
    const contextTrace = formatFeynmanContextTrace({
      node: node({ learning_type: 'intellectual_skill', bloom_target: 'analyze_evaluate' }),
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      outlineVersion: 'v1',
      outlineText: outline,
      prerequisiteNames: '函数基础',
      language: 'zh',
    });
    const saveTrace = formatFeynmanSaveTrace({
      filename: 'feynman.md',
      content: '# 复盘\n\n## 清单\n- 解释概念\n- 举例说明',
      indexed: true,
      indexUpdated: true,
      language: 'zh',
    });

    expect(contextTrace).toContain('费曼复盘生成过程');
    expect(contextTrace).toContain('KC 1 个');
    expect(saveTrace).toContain('费曼复盘保存');
    expect(saveTrace).toContain('清单项约 2 条');
    expect(saveTrace).toContain('RAG 索引成功');
  });
});
