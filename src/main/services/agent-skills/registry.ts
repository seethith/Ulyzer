import type { GenerateFolder } from '@shared/types';
import { feynmanReviewSkill } from './feynman-review.skill';
import { generatePracticeMaterialSkill } from './generate-practice-material.skill';
import { generateTheoryMaterialSkill } from './generate-theory-material.skill';
import type { AgentSkill, AgentSkillId, LocalizedList } from './skill';
import { pickLocalizedList, pickLocalizedText } from './skill';

const skills: AgentSkill[] = [
  generateTheoryMaterialSkill,
  generatePracticeMaterialSkill,
  feynmanReviewSkill,
];

const skillsById = new Map<AgentSkillId, AgentSkill>(
  skills.map((skill) => [skill.id, skill]),
);

const materialSkillByFolder: Partial<Record<GenerateFolder, AgentSkillId>> = {
  theory:   'generate_theory_material',
  practice: 'generate_practice_material',
  answer:   'generate_practice_material',
};

const legacyGenerationDefaultPrefixes: LocalizedList = {
  zh: [
    '请帮我生成相关学习资料',
  ],
  en: [
    'Please generate relevant learning material',
  ],
};

export function listSkills(): AgentSkill[] {
  return [...skills];
}

function getSkill(id: AgentSkillId): AgentSkill {
  const skill = skillsById.get(id);
  if (!skill) throw new Error(`Unknown agent skill: ${id}`);
  return skill;
}

export function getMaterialGenerationSkill(folderName: GenerateFolder): AgentSkill | undefined {
  const skillId = materialSkillByFolder[folderName];
  return skillId ? getSkill(skillId) : undefined;
}

export function getMaterialWorkflowPrompt(folderName: GenerateFolder, language?: string): string {
  const skill = getMaterialGenerationSkill(folderName);
  if (!skill) return '';
  const prompt = skill.materialWorkflowPrompts?.[folderName] ?? skill.workflowPrompt;
  return pickLocalizedText(prompt, language);
}

export function getGenerationDefaultPrefixes(): string[] {
  const zh = [
    ...pickLocalizedList(legacyGenerationDefaultPrefixes, 'zh'),
    ...skills.flatMap((skill) => pickLocalizedList(skill.defaultRequestPrefixes, 'zh')),
  ];
  const en = [
    ...pickLocalizedList(legacyGenerationDefaultPrefixes, 'en'),
    ...skills.flatMap((skill) => pickLocalizedList(skill.defaultRequestPrefixes, 'en')),
  ];
  return [...new Set([...zh, ...en])];
}
