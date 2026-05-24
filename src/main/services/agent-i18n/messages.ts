import type { GuidanceMode } from '@shared/types';
import {
  baseLanguage,
  legacyAgentLanguage,
  normalizeLocale,
  type AgentLocaleContext,
  type BaseLanguage,
  type SupportedLocale,
} from '@shared/i18n';

export { baseLanguage, legacyAgentLanguage, normalizeLocale };
export type { AgentLocaleContext, BaseLanguage, SupportedLocale };

export type AgentLanguage = SupportedLocale;
export type LegacyAgentLanguage = 'zh' | 'en';

export interface LocalizedText {
  zh: string;
  en: string;
}

export interface LocalizedList {
  zh: string[];
  en: string[];
}

export function normalizeLanguage(language?: string | null): LegacyAgentLanguage {
  return legacyAgentLanguage(language);
}

function formatTemplate(text: string, params: Record<string, string | number> = {}): string {
  return text.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
  );
}

export function localize(
  text: LocalizedText,
  language?: string,
  params?: Record<string, string | number>,
): string {
  return formatTemplate(text[normalizeLanguage(language)], params);
}

/** Returns the en string only for English locales; all other locales use zh until fully localized. */
export function localMsg(language: string | undefined | null, zh: string, en: string): string {
  return normalizeLanguage(language) === 'en' ? en : zh;
}

export const COMMON_MESSAGES = {
  languageInstruction: {
    zh: '',
    en: 'IMPORTANT: You must always respond in English, regardless of the language used in the conversation or context.',
  },
  toolStart: {
    zh: '\n🔧 执行工具：**{name}**\n',
    en: '\n🔧 Running tool: **{name}**\n',
  },
  unknownTool: {
    zh: '错误：未知工具 {name}，可用工具：{available}。',
    en: 'Error: unknown tool {name}. Available tools: {available}.',
  },
  toolFailure: {
    zh: '工具执行失败：{error}。请检查参数后重试。',
    en: 'Tool failed: {error}. Check the parameters and retry.',
  },
  toolFailureProgress: {
    zh: '⚠️ 工具执行失败：{error}\n',
    en: '⚠️ Tool execution failed: {error}\n',
  },
  toolResultTruncated: {
    zh: '\n\n[...内容过长，已截断中间部分...]\n\n',
    en: '\n\n[...content too long; middle section truncated...]\n\n',
  },
  fileSavedProgress: {
    zh: '📁 已保存：{filename}',
    en: '📁 Saved: {filename}',
  },
  fileSavedToPath: {
    zh: '文件已保存至：{filePath}',
    en: 'File saved to: {filePath}',
  },
  noNodeSelected: {
    zh: '未关联节点，无法执行此操作',
    en: 'No node selected; cannot perform this action',
  },
  noNodeSelectedGenerateMaterial: {
    zh: '未关联节点，无法生成资料',
    en: 'No node selected; cannot generate material',
  },
  noNodeSelectedGenerateReview: {
    zh: '未关联节点，无法生成复盘清单',
    en: 'No node selected; cannot generate a review checklist',
  },
  noNodeSelectedGenerateMindmap: {
    zh: '未关联节点，无法生成思维导图',
    en: 'No node selected; cannot generate a mind map',
  },
  noNodeSelectedSearchKnowledge: {
    zh: '未关联节点，无法检索',
    en: 'No node selected; cannot search',
  },
  nodeNotFound: {
    zh: '节点不存在：{nodeId}',
    en: 'Node not found: {nodeId}',
  },
  outlineGenerating: {
    zh: '📝 正在生成学习蓝图（知识纲要）…\n',
    en: '📝 Generating learning blueprint…\n',
  },
  outlineGenerationFailed: {
    zh: '学习蓝图生成失败：{error}',
    en: 'Learning blueprint generation failed: {error}',
  },
  outlineMissingGenerateFirst: {
    zh: '当前节点还没有学习蓝图/知识纲要，请先发送"帮我生成大纲"生成纲要后再来生成资料。',
    en: 'No learning blueprint found. Please generate an outline first by saying "generate outline".',
  },
  outlineReadyStartingMaterial: {
    zh: '✅ 学习蓝图已生成，开始生成资料…\n',
    en: '✅ Learning blueprint ready, starting material generation…\n',
  },
  authoritativeSourcesRetrieving: {
    zh: '📚 正在检索权威参考来源…\n',
    en: '📚 Retrieving authoritative reference sources…\n',
  },
  outputContinuation: {
    zh: '⏩ 输出已截断，正在续写（第 {attempt}/{max} 次）…\n',
    en: '⏩ Output truncated, continuing (attempt {attempt}/{max})…\n',
  },
  outputContinuationLimit: {
    zh: '⚠️ 已达最大续写次数，以当前内容结束。\n',
    en: '⚠️ Maximum continuation attempts reached, ending with current content.\n',
  },
  answerGenerating: {
    zh: '📝 正在生成参考答案…\n',
    en: '📝 Generating answer key…\n',
  },
  contextTooLongCompressing: {
    zh: '\n⚠️ 上下文过长，正在压缩历史…\n',
    en: '\n⚠️ Context too long, compressing history…\n',
  },
  contextNearLimitSummarizing: {
    zh: '\n⚠️ 上下文接近极限，正在生成摘要…\n',
    en: '\n⚠️ Context near limit, generating summary…\n',
  },
  contextNearLimitCompressing: {
    zh: '\n⚠️ 上下文接近上限，正在压缩历史…\n',
    en: '\n⚠️ Context approaching limit, compressing history…\n',
  },
  summaryGenerationFailedMicrocompact: {
    zh: '⚠️ 摘要生成失败，降级为微压缩\n',
    en: '⚠️ Summary generation failed; falling back to micro-compaction\n',
  },
  rateLimitRetrying: {
    zh: '⏳ 请求频率超限，稍后重试…\n',
    en: '⏳ Rate limit reached, retrying shortly…\n',
  },
  maxTurnsExceeded: {
    zh: '处理轮次已达上限，已停止继续尝试。请换一种更明确的请求，或让我基于已完成的结果继续。',
    en: 'The processing turn limit was reached, so I stopped retrying. Please make the request more specific, or ask me to continue from the completed result.',
  },
  practiceVerifierRepairTriggered: {
    zh: '⚠️ 练习资料校验未通过，正在要求模型修复后重新保存…\n',
    en: '⚠️ Practice material verification failed; requesting a repaired save…\n',
  },
  practiceAnswerMissingRepairTriggered: {
    zh: '⚠️ 练习题已保存但缺少参考答案，正在补生成答案文件…\n',
    en: '⚠️ Practice file was saved without an answer key; generating the answer file…\n',
  },
  generationFailedProgress: {
    zh: '⚠️ 生成出错：{error}\n',
    en: '⚠️ Generation failed: {error}\n',
  },
  generationFailedRetry: {
    zh: '生成失败，请稍后重试',
    en: 'Generation failed, please retry',
  },
  generationIncompleteRetry: {
    zh: '生成未完成，请稍后重试',
    en: 'Generation incomplete, please retry',
  },
  generatedSavedToFolder: {
    zh: '已生成并保存至「{folder}」：{filename}',
    en: 'Generated and saved to {folder}: {filename}',
  },
  fileSavedOverview: {
    zh: '✅ 文件已保存至「{folder}」：**{filename}**\n',
    en: '✅ File saved to [{folder}]: **{filename}**\n',
  },
  fileSavedOverviewCovers: {
    zh: '涵盖：{headings}',
    en: 'Covers: {headings}',
  },
  feynmanReviewGenerated: {
    zh: '已生成深度复盘清单：{filename}，保存至「{folder}」文件夹。',
    en: 'Feynman review checklist generated: {filename}, saved to {folder} folder.',
  },
  mindmapGenerated: {
    zh: '已生成思维导图：{filename}，保存至「{folder}」文件夹，可在文件列表中打开查看。',
    en: 'Mind map generated: {filename}, saved to {folder} folder.',
  },
  topicOutlineGenerated: {
    zh: '专题纲要「{topic}」已生成并保存到「{folder}」文件夹。你可以基于该专题纲要继续请求生成原理资料或实践题。',
    en: 'Topic outline for "{topic}" generated and saved to the {folder} folder. You can now request theory materials or practice exercises based on this topic.',
  },
  topicGenerationFailed: {
    zh: '专题生成失败：{error}',
    en: 'Topic generation failed: {error}',
  },
  topicOutlineSavedProgress: {
    zh: '✅ 专题纲要「{topic}」已保存至{folder}文件夹。\n',
    en: '✅ Topic outline for "{topic}" saved to the {folder} folder.\n',
  },
  topicOutlineGenerationFailed: {
    zh: '专题纲要生成失败：{error}',
    en: 'Topic outline generation failed: {error}',
  },
  outlineMaxVersionReached: {
    zh: '当前学习蓝图已是最高版本 v{version}，无法继续升级。如需深入某个知识组件，可以请我生成专题。',
    en: 'The learning blueprint is already at the maximum version v{version}. To go deeper into a specific KC, ask me to generate a topic.',
  },
  outlineBundleAlreadyReady: {
    zh: '当前节点的三层基础蓝图已经齐全：v1 学习蓝图、v2 实践与出题蓝图、v3 复盘与深化蓝图。如需深入某个知识组件，可以请我生成专题。',
    en: 'The node already has the three foundation blueprints: v1 Learning Blueprint, v2 Practice & Exercise Blueprint, and v3 Review & Deepening Blueprint. To go deeper into a specific KC, ask me to generate a topic.',
  },
  outlineBundleSaved: {
    zh: '三层基础蓝图已生成并保存到「{folder}」文件夹：{versions}。',
    en: 'Three foundation blueprints generated and saved to the {folder} folder: {versions}.',
  },
  outlineVersionSaved: {
    zh: 'v{version} 学习蓝图已生成并保存到「{folder}」文件夹。',
    en: 'Learning blueprint v{version} generated and saved to the {folder} folder.',
  },
  outlineVersionGeneratedProgress: {
    zh: '✅ 学习蓝图 v{version} 已生成。\n',
    en: '✅ Learning blueprint v{version} generated.\n',
  },
  outlineVersionGenerationFailed: {
    zh: '学习蓝图 v{version} 生成失败：{error}',
    en: 'Learning blueprint v{version} generation failed: {error}',
  },
  videoNoResults: {
    zh: '未找到相关视频，或未配置 YouTube API Key（可在设置页面添加）。',
    en: 'No related videos found, or the YouTube API key is not configured. You can add it in Settings.',
  },
  videoSearchFailed: {
    zh: '视频搜索出错：{error}',
    en: 'Video search failed: {error}',
  },
  routeGenerationFailed: {
    zh: '路线图生成失败：{error}',
    en: 'Roadmap generation failed: {error}',
  },
  skeletonGenerationFailedRetry: {
    zh: '章节骨架生成失败，请重试',
    en: 'Chapter skeleton generation failed. Please retry.',
  },
  skeletonJsonParseFailedRetry: {
    zh: '章节骨架 JSON 解析失败，请重试',
    en: 'Chapter skeleton JSON parse failed. Please retry.',
  },
  skeletonEmptyRetry: {
    zh: '章节骨架为空，请重试',
    en: 'Chapter skeleton is empty. Please retry.',
  },
  verificationPassed: {
    zh: '校验通过',
    en: 'Verification passed',
  },
  verificationFailedHeader: {
    zh: '校验未通过：',
    en: 'Verification failed:',
  },
  readFolderEmpty: {
    zh: '[{folder}] 暂无文件',
    en: '[{folder}] no files',
  },
  mistakeRecorded: {
    zh: '错题已记录到「{path}」',
    en: 'Mistake recorded to {path}',
  },
  noteSaved: {
    zh: '笔记已保存：{filename}',
    en: 'Note saved: {filename}',
  },
  readFailed: {
    zh: '读取失败：{error}',
    en: 'Read failed: {error}',
  },
  fileMissing: {
    zh: '文件不存在：{filename}',
    en: 'File not found: {filename}',
  },
  contentTruncated: {
    zh: '\n…（内容已截断）',
    en: '\n...(content truncated)',
  },
  searchNoMaterialsYet: {
    zh: '当前节点暂无相关资料，可生成后再检索',
    en: 'No relevant material found for this node yet. Generate material first, then search again.',
  },
  searchSnippetLabel: {
    zh: '片段 {index}',
    en: 'Snippet {index}',
  },
} as const satisfies Record<string, LocalizedText>;

export type CommonMessageKey = keyof typeof COMMON_MESSAGES;

export function message(
  key: CommonMessageKey,
  language?: string,
  params?: Record<string, string | number>,
): string {
  return localize(COMMON_MESSAGES[key], language, params);
}

const DIFFICULTY_LABELS: Record<string, LocalizedText> = {
  beginner:     { zh: '入门', en: 'Beginner' },
  intermediate: { zh: '进阶', en: 'Intermediate' },
  advanced:     { zh: '高级', en: 'Advanced' },
};

export function getDifficultyLabel(difficulty: string, language?: string): string {
  const label = DIFFICULTY_LABELS[difficulty];
  return label ? localize(label, language) : difficulty;
}

const GUIDANCE_MODE_LABELS: Record<GuidanceMode, LocalizedText> = {
  strict: {
    zh: '严格模式（苏格拉底引导）',
    en: 'Strict mode (Socratic guidance)',
  },
  balanced: {
    zh: '均衡模式（引导为主）',
    en: 'Balanced mode (guided first)',
  },
  loose: {
    zh: '宽松模式（直接解答）',
    en: 'Loose mode (direct answers)',
  },
};

export function getGuidanceModeLabel(mode: GuidanceMode, language?: string): string {
  return localize(GUIDANCE_MODE_LABELS[mode], language);
}
