import { describe, expect, it } from 'vitest';
import { isRoadmapCreationRequest, resolveRoadmapSearchMode } from './roadmap-intent';

describe('roadmap intent helpers', () => {
  it('detects explicit roadmap creation requests', () => {
    expect(isRoadmapCreationRequest('只依据参考库生成一份操作系统学习路线图')).toBe(true);
    expect(isRoadmapCreationRequest('帮我规划 Python 学习路径')).toBe(true);
    expect(isRoadmapCreationRequest('参考库里第 2 章讲了什么')).toBe(false);
  });

  it('narrows roadmap search mode to library when the user says to only use the source library', () => {
    expect(resolveRoadmapSearchMode({
      baseMode: 'auto',
      userMessage: '请只依据该参考库规划生成一份路线图，不要联网。',
      topic: '操作系统',
    })).toBe('library');
  });

  it('can narrow explicit no-search roadmap requests to off', () => {
    expect(resolveRoadmapSearchMode({
      baseMode: 'auto',
      userMessage: '生成路线图，不要联网，也不要读取参考库。',
      topic: '操作系统',
    })).toBe('off');
  });
});
