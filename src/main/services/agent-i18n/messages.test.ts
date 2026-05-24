import { describe, expect, it } from 'vitest';
import type { DagNode } from '@shared/types';
import { getDifficultyLabel, getGuidanceModeLabel, localMsg, message, normalizeLanguage, normalizeLocale } from './messages';
import {
  getArtifactFilenamePrefix,
  getArtifactIndexEntry,
  getArtifactIndexHeader,
  getPairedAnswerFilename,
  getReviewBaseName,
  getReviewIndexHeader,
  getTimestampedArtifactFilename,
  isNormalizedArtifactFilename,
} from './artifact-names';
import { getPlanTemplate, getPlanToolTitle } from './plan-messages';
import { getRolePrompt } from './prompt-catalog';
import { toolDescription, toolPropertyDescription } from './tool-descriptions';
import { formatVerificationIssueMessage } from '../agent-verifiers/types';
import { nodeContextLayer, sourcesLayer } from '../prompt/prompt-builder';

describe('agent i18n catalogs', () => {
  it('localizes common messages and labels', () => {
    expect(message('fileSavedProgress', 'zh', { filename: 'a.md' })).toBe('📁 已保存：a.md');
    expect(message('fileSavedProgress', 'en', { filename: 'a.md' })).toBe('📁 Saved: a.md');
    expect(message('fileSavedProgress', 'en-US', { filename: 'a.md' })).toBe('📁 Saved: a.md');
    expect(getDifficultyLabel('intermediate', 'en')).toBe('Intermediate');
    expect(getGuidanceModeLabel('strict', 'zh')).toContain('苏格拉底');
  });

  it('normalizes legacy and BCP-47 locale inputs', () => {
    expect(normalizeLocale('zh')).toBe('zh-CN');
    expect(normalizeLocale('en')).toBe('en-US');
    expect(normalizeLocale('en-US')).toBe('en-US');
    expect(normalizeLanguage('en-US')).toBe('en');
    expect(normalizeLanguage('ja-JP')).toBe('zh');
    expect(localMsg('en-US', '中文', 'English')).toBe('English');
  });

  it('centralizes artifact names used by file generation', () => {
    expect(getArtifactFilenamePrefix('theory', 'zh')).toBe('原理');
    expect(getArtifactFilenamePrefix('practice', 'en')).toBe('practice');
    expect(getArtifactFilenamePrefix('practice', 'en-US')).toBe('practice');
    expect(getReviewBaseName('v2', '0421', 'zh')).toBe('复盘清单-v2-0421');
    expect(getReviewBaseName('v2', '0421', 'en-US')).toBe('review-v2-0421');
    expect(getReviewIndexHeader('en')).toBe('# Feynman Review Index\n');
    expect(getArtifactIndexHeader('theory', 'en')).toBe('# Theory Index\n');
    expect(getArtifactIndexEntry('practice', {
      fileName: 'practice-v1.md',
      date: '2026-04-22',
      coverage: 'KC1',
      outlineVersion: 'v1',
    }, 'en')).toContain('KCs covered: KC1');
    expect(getPairedAnswerFilename('practice-v1-0422-basics.md', 'en')).toBe('answer-v1-0422-basics.md');
    expect(getPairedAnswerFilename('练习-v1-0422-基础.md', 'zh')).toBe('答案-v1-0422-基础.md');
    expect(isNormalizedArtifactFilename('answer', 'answer-v1-0422-basics.md', 'en')).toBe(true);
    expect(isNormalizedArtifactFilename('answer', '答案-v1-0422-基础.md', 'zh')).toBe(true);
    expect(getTimestampedArtifactFilename('mindmap', { title: 'Chapter 1', timestamp: '2026-04-22T10-00' }, 'en')).toBe('2026-04-22T10-00-mindmap-Chapter-1.md');
  });

  it('centralizes verification and plan labels', () => {
    expect(formatVerificationIssueMessage({
      code: 'practice.missing_layer.apply',
      severity: 'error',
      message: 'Missing application layer.',
    }, 'zh')).toBe('缺少应用层。');
    expect(getPlanToolTitle('save_file', 'en')).toBe('Save file');
    expect(getPlanTemplate('materialGeneration', 'en').steps.map((step) => step[1])).toContain('Prepare node context');
  });

  it('localizes core prompt catalog and context layers', async () => {
    expect(getRolePrompt('maintutor', 'en-US')).toContain('learning roadmap planner');
    expect(getRolePrompt('maintutor', 'en-US')).not.toContain('学习路线规划师');

    const node: DagNode = {
      id: 'node-1',
      course_id: 'course-1',
      chapter: 'Chapter 1',
      chapter_order: 1,
      name: 'Vectors',
      description: null,
      node_type: 'main',
      status: 'active',
      difficulty: 'beginner',
      prerequisites: [],
      required_tools: [],
      required_cost: {},
      position_x: 0,
      position_y: 0,
      bloom_target: null,
      learning_type: null,
      priority: null,
      source_ids: [],
      rationale: null,
      created_at: '',
      updated_at: '',
    };
    const nodeContext = await nodeContextLayer(node, 'strict', 'en-US')();
    expect(nodeContext).toContain('Current node');
    expect(nodeContext).toContain('Guidance mode');
    expect(nodeContext).not.toContain('当前节点');

    const sources = await sourcesLayer('Reference text', 'en-US')();
    expect(sources).toContain('Authoritative Reference Sources');
    expect(sources).not.toContain('权威参考来源');
  });

  it('centralizes tool descriptions and schema property descriptions', () => {
    expect(toolDescription('save_file')).toContain('folderName');
    expect(toolDescription('generate_practice', 'en')).toContain('Generate practice exercises');
    expect(toolPropertyDescription('save_file', 'folderName', 'en')).toContain('theory=Theory');
    expect(toolPropertyDescription('rag_retrieve', 'query')).toContain('检索关键词');
  });
});
