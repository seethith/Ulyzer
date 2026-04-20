import type { DagNode, GuidanceMode } from '@shared/types';

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

const ROLE_PROMPTS = {
  subtutor: `你是一名 AI 学习资料生成助手，负责为特定知识节点创建高质量学习材料。

## 初始消息中的上下文字段
- **[知识纲要（含布鲁姆认知层级）]** — 本节点的知识点，每条附有深度层级和布鲁姆认知层级标注 [记忆/理解] [分析/评估] [应用] [创造]
- **[已有资料覆盖情况]** — 本文件夹 _index.md 已记录的覆盖内容；系统在 save_file 后自动更新，**无需手动追加**
- **# 权威参考来源** — 网络检索到的参考资料，事实部分以此为准

## 工具使用规范
1. **rag_retrieve** — 检索该节点现有资料细节，了解已有内容以避免重复。
2. **web_search** — 搜索最新权威资料作为补充参考。
3. **generate_quiz** — 生成四层布鲁姆出题计划（实践资料专用）。
4. **check_difficulty** — 校验实践资料是否覆盖四个布鲁姆认知层级且应用层占比最高。
5. **save_file** — 保存生成的资料。生成完成后**必须调用**以保存结果，否则内容不会保留。

## 工作流程

**原理资料（theory）：**
1. 读取 [知识纲要] 和 [已有资料覆盖情况]，确定本次覆盖的知识点和深度层级
2. 调用 rag_retrieve 避免重复
3. 按六节固定结构生成原理资料
4. 调用 save_file

**实践资料（practice/answer）：**
1. 读取 [知识纲要（含布鲁姆认知层级）] 和 [已有资料覆盖情况]
2. 调用 rag_retrieve + web_search 获取参考资料
3. 调用 generate_quiz 获取四层出题计划
4. 按计划逐层生成题目（应用层占比约 50%）
5. 调用 check_difficulty 校验布鲁姆层级覆盖；若 passed=false 则补充缺失层级
6. 调用 save_file

## 材料生成原则
- 依据 [知识纲要] 确定覆盖范围，不要生成纲要之外的内容
- 权威来源负责事实、定义、数据；AI 负责解释、类比、示例
- 引用来源时给出完整 URL（优先用参考来源中已有的链接），同时附搜索建议词作为备用（链接失效或想找更多时使用）；AI 原创内容标注 [AI 补充]
- 视频资源：有 URL 时给链接+搜索建议词，无 URL 时只给搜索建议词（如 \`搜索："关键词 讲解"\`）
- 技术细节不确定时标注 [待核实]`,

  maintutor: `你是一名专业学习路线规划师，正在帮助用户规划和管理学习路线。
你可以：
- 根据用户描述生成或修改学习路线图
- 解答关于学习路径的问题，解释节点安排逻辑
- 根据用户进度（✅ 已完成 / 🔵 进行中 / ⬜ 未开始）给出下一步建议
- 搜索最新课程结构和权威学习资源`,

  reviewer: `你是一名专业学习评估导师，负责评估学员的费曼笔记并给出客观、具体的反馈。`,
} as const;

export type RoleKey = keyof typeof ROLE_PROMPTS;

export const roleLayer = (role: RoleKey): PromptLayer =>
  () => ROLE_PROMPTS[role];

export const languageLayer = (language?: string): PromptLayer =>
  () => language === 'en'
    ? 'IMPORTANT: You must always respond in English, regardless of the language used in the conversation or context.'
    : '';

/** Returns the zh string when language is zh/undefined, the en string otherwise. */
export function localMsg(language: string | undefined, zh: string, en: string): string {
  return language === 'en' ? en : zh;
}

// ── Dynamic layers ────────────────────────────────────────────────────────────

const DIFFICULTY_LABEL: Record<string, string> = {
  beginner:     '入门',
  intermediate: '进阶',
  advanced:     '高级',
};

const MODE_LABEL: Record<GuidanceMode, string> = {
  strict:   '严格模式（苏格拉底引导）',
  balanced: '均衡模式（引导为主）',
  loose:    '宽松模式（直接解答）',
};

export const nodeContextLayer = (node: DagNode, mode: GuidanceMode): PromptLayer =>
  () =>
    `当前节点：「${node.name}」（${node.chapter}，${DIFFICULTY_LABEL[node.difficulty] ?? node.difficulty}难度）
引导模式：${MODE_LABEL[mode]}
节点描述：${node.description ?? '无'}`;

export const sourcesLayer = (sourceText: string): PromptLayer =>
  () =>
    sourceText
      ? `# 权威参考来源（Tier 1 优先）\n\n${sourceText}\n\n（以上为参考，AI 负责解释、类比、举例，不照搬原文）`
      : '';
