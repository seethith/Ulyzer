import { describe, expect, it } from 'vitest';
import {
  detectFolderLanguageFromNames,
  getFolderDisplayName,
  getFolderName,
  getFolderNameMap,
  getNodeSubfolderNames,
  resolveFolderKey,
  resolveFolderNameForLanguage,
} from './folder-policy';

describe('folder policy catalog', () => {
  it('exposes stable folder names for Chinese and English workspaces', () => {
    expect(getFolderName('outline', 'zh')).toBe('纲要');
    expect(getFolderName('theory', 'zh')).toBe('原理资料');
    expect(getFolderName('outline', 'en')).toBe('Outline');
    expect(getFolderName('feynman', 'en')).toBe('Feynman Review');

    expect(getNodeSubfolderNames('zh')).toEqual([
      '纲要',
      '原理资料',
      '实践资料',
      '参考答案',
      '个人笔记',
      '费曼复盘',
    ]);
    expect(getNodeSubfolderNames('en')).toEqual([
      'Outline',
      'Theory',
      'Practice',
      'Answer',
      'Notes',
      'Feynman Review',
    ]);
  });

  it('detects existing workspace language from folder names for backwards compatibility', () => {
    expect(detectFolderLanguageFromNames(['纲要', '原理资料'])).toBe('zh');
    expect(detectFolderLanguageFromNames(['Outline', 'Theory'])).toBe('en');
    expect(detectFolderLanguageFromNames([])).toBe('zh');
  });

  it('resolves canonical keys and localized folder names through one policy', () => {
    expect(resolveFolderKey('theory')).toBe('theory');
    expect(resolveFolderKey('原理资料')).toBe('theory');
    expect(resolveFolderKey('Theory')).toBe('theory');
    expect(resolveFolderNameForLanguage('原理资料', 'en')).toBe('Theory');
    expect(resolveFolderNameForLanguage('Theory', 'zh')).toBe('原理资料');
    expect(resolveFolderNameForLanguage('custom', 'en')).toBe('custom');
    expect(getFolderDisplayName('practice')).toBe('实践资料 / Practice');
    expect(getFolderNameMap('zh').answer).toBe('参考答案');
  });
});
