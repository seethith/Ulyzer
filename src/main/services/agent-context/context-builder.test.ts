import { describe, expect, it } from 'vitest';
import type { DagNode } from '@shared/types';
import {
  buildDagGenerationContext,
  buildMaterialGenerationContext,
} from './context-builder';

const nodeA: DagNode = {
  id: 'node-a',
  course_id: 'course-1',
  chapter: '基础',
  chapter_order: 0,
  name: '类型基础',
  description: '类型系统入门',
  node_type: 'main',
  status: 'done',
  difficulty: 'beginner',
  prerequisites: [],
  required_tools: [],
  required_cost: {},
  position_x: 0,
  position_y: 0,
  bloom_target: 'remember_understand',
  learning_type: 'verbal_info',
  priority: 'must',
  source_ids: [],
  rationale: null,
  created_at: '',
  updated_at: '',
};

describe('agent context builder', () => {
  it('builds DAG generation context from recent conversation and search hints', () => {
    const result = buildDagGenerationContext({
      topic:         '机器学习',
      searchQueries: ['machine learning syllabus', 'ml roadmap'],
      messages:      [
        { role: 'user', content: '我想偏实践' },
        { role: 'assistant', content: '好的' },
      ],
    });

    expect(result.content).toContain('[对话背景]');
    expect(result.content).toContain('机器学习');
    expect(result.content).toContain('建议搜索关键词');
  });

  it('builds material generation context with outline, coverage, sources, and videos', () => {
    const result = buildMaterialGenerationContext({
      node:                   nodeA,
      prereqNames:            '前置 A',
      targetFolder:           'practice',
      outlineText:            '# Outline',
      indexText:              '- 已覆盖',
      guideSection:           '用户要求：生成练习',
      motorSkillPracticeNote: '',
      sourceText:             '### Source',
      videoText:              '- [Video](https://example.com)',
    });

    expect(result.packs.map((pack) => pack.id)).toEqual([
      'currentNode',
      'nodeOutline',
      'coverageIndex',
      'userRequest',
      'authoritativeSources',
      'videoReferences',
    ]);
    expect(result.content).toContain('[学习蓝图 / 知识纲要]');
    expect(result.content).toContain('[已有资料覆盖情况]');
    expect(result.content).toContain('# 权威参考来源');
    expect(result.content).toContain('# 教学视频参考');
  });
});
