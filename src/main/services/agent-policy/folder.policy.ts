import { localMsg } from '../prompt/prompt-builder';
import type { PromptPolicyLayer } from './types';

export function folderPolicyLayer(language?: string): PromptPolicyLayer {
  return () => localMsg(
    language,
    `## 文件夹对应关系（严格遵守，不得混淆）
- 「原理资料」= theory：概念讲解、原理分析、思维导图
- 「实践资料」= practice：练习题、实操任务、参考答案、错题本
- 「个人笔记」= notes：学习笔记、关键点摘要、心得
- 「费曼复盘」= answer（在 generate 系列工具中）：复盘清单、费曼笔记`,
    `## Folder Mapping (strict)
- Theory = theory: concept explanations, principle analysis, mind maps
- Practice = practice: exercises, practical tasks, answer references, mistake log
- Notes = notes: study notes, key-point summaries, reflections
- Feynman Review = answer in generate-series tools: review checklists and Feynman notes`,
  );
}
