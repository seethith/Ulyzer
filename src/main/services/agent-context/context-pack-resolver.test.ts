import { describe, expect, it } from 'vitest';
import type { Course, DagNode } from '@shared/types';
import { mainTutorProfile } from '../agent-profiles/main-tutor.profile';
import { nodeTutorProfile } from '../agent-profiles/node-tutor.profile';
import { ContextPackResolver } from './context-pack-resolver';

const course: Course = {
  id: 'course-1',
  name: 'Course',
  description: null,
  status: 'active',
  total_nodes: 2,
  done_nodes: 1,
  hours_spent: 0,
  total_token_used: 0,
  total_cost_cny: 0,
  goal_text: '学会 TypeScript',
  known_topics: 'JavaScript',
  time_budget: '每天 1 小时',
  depth_preference: 'standard',
  profile_updated_at: null,
  created_at: '',
  updated_at: '',
};

const node: DagNode = {
  id: 'node-1',
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

describe('ContextPackResolver', () => {
  it('builds main tutor context in profile-declared order', () => {
    const result = new ContextPackResolver().resolveForProfile(mainTutorProfile, {
      courseId: 'course-1',
      course,
      nodes: [node],
      searchMode: 'library',
      agentChannel: 'main_tutor',
      language: 'zh',
    });

    expect(result.packs.map((pack) => pack.id)).toEqual(mainTutorProfile.contextPacks);
    expect(result.content).toContain('[用户学习档案]');
    expect(result.content).toContain('✅ 类型基础（beginner，ID: node-1）');
    expect(result.content).toContain('[搜索模式]');
    expect(result.content).toContain('[语言]');
  });

  it('builds node tutor context from node profile packs and skips missing optional packs', () => {
    const result = new ContextPackResolver().resolveForProfile(nodeTutorProfile, {
      courseId: 'course-1',
      course,
      nodes: [node],
      node,
      mode: 'balanced',
      studentMemory: '[Student Memory]\nPrefers examples',
      searchMode: 'off',
      agentChannel: 'sub_tutor',
      language: 'en',
    });

    expect(result.packs.map((pack) => pack.id)).toEqual([
      'currentNode',
      'studentMemory',
      'searchMode',
      'localeInstruction',
    ]);
    expect(result.content).toContain('Node: "类型基础" (基础, Beginner)');
    expect(result.content).toContain('[Student Memory]');
    expect(result.content).toContain('[Search mode]');
  });

  it('injects main-to-node handoff when a node handoff is available', () => {
    const result = new ContextPackResolver().resolveForProfile(nodeTutorProfile, {
      courseId: 'course-1',
      course,
      nodes: [node],
      node,
      mode: 'balanced',
      agentChannel: 'sub_tutor',
      language: 'zh',
      handoff: {
        nodeId: node.id,
        courseId: course.id,
        taskDefinition: '用类型系统约束真实业务数据',
        scopeBoundary: '不提前展开高级类型体操',
        rationale: '承接 JavaScript 到 TypeScript 的过渡',
        recommendedSourceIds: ['src-1'],
        suggestedQueries: ['TypeScript type system exercises'],
        generationConstraints: ['多用代码例子'],
        coverageRequirements: ['覆盖类型注解和联合类型'],
        createdAt: '',
        updatedAt: '',
      },
    });

    expect(result.packs.map((pack) => pack.id)).toContain('nodeHandoff');
    expect(result.content).toContain('节点任务：用类型系统约束真实业务数据');
    expect(result.content).toContain('覆盖要求：覆盖类型注解和联合类型');
  });

  it('builds material packs from the same resolver surface', () => {
    const result = new ContextPackResolver().resolve([
      'currentNode',
      'nodeOutline',
      'coverageIndex',
      'userRequest',
      'authoritativeSources',
      'videoReferences',
    ], {
      courseId: 'course-1',
      node,
      targetFolder: 'practice',
      outlineText: '# Outline',
      indexText: '- 已覆盖',
      userRequest: '用户要求：生成练习',
      authoritativeSources: '### Source',
      videoReferences: '- [Video](https://example.com)',
      language: 'zh',
    }, '\n\n---\n\n');

    expect(result.packs.map((pack) => pack.id)).toEqual([
      'currentNode',
      'nodeOutline',
      'coverageIndex',
      'userRequest',
      'authoritativeSources',
      'videoReferences',
    ]);
    expect(result.content).toContain('[学习蓝图 / 知识纲要]');
    expect(result.content).toContain('# 权威参考来源');
  });
});
