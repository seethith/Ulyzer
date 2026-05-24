import { describe, expect, it } from 'vitest';
import {
  folderPolicyLayer,
  getSearchModeInstruction,
  nodeTutorChatRolePolicyLayer,
  nodeTutorToolRoutingPolicyLayer,
  nodeTutorWorkflowRoutingPolicyLayer,
  searchPolicyLayer,
  tutorGuidancePolicyLayer,
} from './index';

describe('agent policy prompt layers', () => {
  it('exposes node tutor chat policy as composable layers', () => {
    expect(nodeTutorChatRolePolicyLayer('zh')()).toContain('AI 学习导师');
    expect(tutorGuidancePolicyLayer('zh')()).toContain('严格模式');
    expect(nodeTutorToolRoutingPolicyLayer('zh')()).toContain('generate_theory');
    expect(folderPolicyLayer('zh')()).toContain('原理资料');
    expect(nodeTutorWorkflowRoutingPolicyLayer('zh')()).toContain('专题深钻');
  });

  it('localizes policy layers for English prompts', () => {
    expect(nodeTutorChatRolePolicyLayer('en-US')()).toContain('AI learning tutor');
    expect(tutorGuidancePolicyLayer('en-US')()).toContain('Guidance Modes');
    expect(nodeTutorToolRoutingPolicyLayer('en-US')()).toContain('generate_practice');
    expect(folderPolicyLayer('en-US')()).toContain('Folder Mapping');
  });

  it('keeps main and sub tutor search instructions distinct', () => {
    expect(getSearchModeInstruction('web', 'main_tutor', 'zh')).toContain('直接调用 generate_dag，不要先调用 web_search');
    expect(getSearchModeInstruction('web', 'sub_tutor', 'zh')).toContain('生成学习资料');
    expect(getSearchModeInstruction('library', 'main_tutor', 'en-US')).toContain('call generate_dag directly');
    expect(getSearchModeInstruction('off', 'sub_tutor', 'en-US')).toContain('Do not call web_search');
    expect(searchPolicyLayer('auto', 'sub_tutor', 'zh')()).toBe('');
  });
});
