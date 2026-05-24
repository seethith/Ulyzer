import type { DagNode, GuidanceMode } from '@shared/types';
import {
  getDifficultyLabel,
  getGuidanceModeLabel,
  localMsg,
  message,
  normalizeLanguage,
} from '../agent-i18n/messages';
import { getRolePrompt, type RoleKey } from '../agent-i18n/prompt-catalog';

export { localMsg } from '../agent-i18n/messages';

// ── Layer system ──────────────────────────────────────────────────────────────

type PromptLayer = () => string | Promise<string>;

/**
 * Compose multiple prompt layers into one system prompt string.
 * Put static layers (role, tools) first — they are most cache-friendly.
 * Dynamic layers (node context, RAG sources) go after.
 */
export async function buildSystemPrompt(...layers: PromptLayer[]): Promise<string> {
  const parts = await Promise.all(layers.map((l) => l()));
  return parts.filter(Boolean).join('\n\n---\n\n');
}

// ── Role prompts (static — most cache-friendly) ───────────────────────────────

export const roleLayer = (role: RoleKey, language?: string): PromptLayer =>
  () => getRolePrompt(role, language);

export const languageLayer = (language?: string): PromptLayer =>
  () => message('languageInstruction', language);

export const modelIdentityLayer = (provider: string, model: string, language?: string): PromptLayer =>
  () => localMsg(
    language,
    `# 模型身份说明
当前运行环境：Ulyzer 通过用户选择的 provider/model 调用你。
provider: ${provider || 'unknown'}
model: ${model || 'unknown'}

当用户询问"你是什么模型/你是谁开发的"时，请基于上述 provider/model 作答；不要臆称自己是 Claude、GPT、Gemini 或其他品牌，除非 provider/model 明确对应。`,
    `# Model Identity
Runtime: Ulyzer is calling you through the user-selected provider/model.
provider: ${provider || 'unknown'}
model: ${model || 'unknown'}

When the user asks what model you are or who developed you, answer from the provider/model above. Do not claim to be Claude, GPT, Gemini, or another brand unless the provider/model clearly matches it.`,
  );

// ── Dynamic layers ────────────────────────────────────────────────────────────

export const nodeContextLayer = (node: DagNode, mode: GuidanceMode, language?: string): PromptLayer =>
  () => {
    if (normalizeLanguage(language) === 'en') {
      return `Current node: "${node.name}" (${node.chapter}, ${getDifficultyLabel(node.difficulty, language)} difficulty)
Guidance mode: ${getGuidanceModeLabel(mode, language)}
Node description: ${node.description ?? 'None'}`;
    }
    return `当前节点：「${node.name}」（${node.chapter}，${getDifficultyLabel(node.difficulty, language)}难度）
引导模式：${getGuidanceModeLabel(mode)}
节点描述：${node.description ?? '无'}`;
  };

export const sourcesLayer = (sourceText: string, language?: string): PromptLayer =>
  () =>
    sourceText
      ? localMsg(
          language,
          `# 权威参考来源（Tier 1 优先）\n\n${sourceText}\n\n（以上为参考，AI 负责解释、类比、举例，不照搬原文）`,
          `# Authoritative Reference Sources (Tier 1 first)\n\n${sourceText}\n\n(Use the above as references. The AI should explain, compare, and give examples rather than copy source text.)`,
        )
      : '';
