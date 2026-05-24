import type { ActiveNodeFileContext, Course, DagNode, GenerateFolder, GuidanceMode, NodeHandoff, SearchMode } from '@shared/types';
import type { ImageAttachment, PdfAttachment } from '../llm/adapter';
import type { AgentChannel, AgentProfile } from '../agent-core/run-state';
import { getSearchModeInstruction } from '../agent-policy';
import { buildMemoryContext } from '../agent-memory/student-memory';
import { localMsg } from '../prompt/prompt-builder';
import type { BuiltContext, ContextPack, ContextPackId } from './context-pack';
import { joinContextPacks } from './context-pack';

const DIFFICULTY_LABEL_ZH: Record<string, string> = {
  beginner: '入门',
  intermediate: '进阶',
  advanced: '高级',
};
const DIFFICULTY_LABEL_EN: Record<string, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
};
const MODE_LABEL_ZH: Record<GuidanceMode, string> = {
  strict: '严格模式（苏格拉底引导）',
  balanced: '均衡模式（引导为主）',
  loose: '宽松模式（直接解答）',
};
const MODE_LABEL_EN: Record<GuidanceMode, string> = {
  strict: 'Strict (Socratic guidance)',
  balanced: 'Balanced (guided)',
  loose: 'Loose (direct answers)',
};

export interface ContextPackResolverInput {
  courseId: string;
  course?: Course | null;
  nodes?: DagNode[];
  node?: DagNode | null;
  mode?: GuidanceMode;
  language?: string;
  handoff?: NodeHandoff | null;
  studentMemory?: string;
  searchMode?: SearchMode;
  agentChannel?: AgentChannel;
  contextFiles?: string[];
  imageAttachments?: ImageAttachment[];
  pdfAttachments?: PdfAttachment[];
  prereqNames?: string;
  targetFolder?: GenerateFolder;
  outlineText?: string;
  indexText?: string;
  nodeMaterialsSummary?: string;
  activeFile?: ActiveNodeFileContext;
  ragSnippets?: string;
  userRequest?: string;
  motorSkillPracticeNote?: string;
  authoritativeSources?: string;
  practiceSourceBrief?: string;
  videoReferences?: string;
}

export class ContextPackResolver {
  resolveForProfile(
    profile: AgentProfile,
    input: ContextPackResolverInput,
    separator = '\n\n',
  ): BuiltContext {
    return this.resolve(profile.contextPacks, {
      ...input,
      agentChannel: input.agentChannel ?? profile.agentChannel,
    }, separator);
  }

  resolve(
    packIds: ContextPackId[],
    input: ContextPackResolverInput,
    separator = '\n\n',
  ): BuiltContext {
    const packs = packIds
      .map((id) => this.buildPack(id, input))
      .filter((pack): pack is ContextPack => Boolean(pack?.content));
    return joinContextPacks(packs, separator);
  }

  private buildPack(id: ContextPackId, input: ContextPackResolverInput): ContextPack | undefined {
    switch (id) {
      case 'courseProfile':
        return buildCourseProfilePack(input.course);
      case 'courseDagSummary':
        return buildCourseDagSummaryPack(input.nodes ?? []);
      case 'courseProgress':
        return buildCourseProgressPack(input.nodes ?? []);
      case 'currentNode':
        return buildCurrentNodePack(input);
      case 'nodeHandoff':
        return buildNodeHandoffPack(input.handoff, input.language);
      case 'nodeOutline':
        return textPack('nodeOutline', input.language === 'en' ? 'Learning Blueprint / Outline' : '学习蓝图 / 纲要', input.outlineText, input.language === 'en' ? '[Learning Blueprint / Knowledge Outline]' : '[学习蓝图 / 知识纲要]');
      case 'coverageIndex':
        return textPack('coverageIndex', input.language === 'en' ? 'Coverage Index' : '已有资料覆盖情况', input.indexText, input.language === 'en' ? '[Coverage Index]' : '[已有资料覆盖情况]');
      case 'nodeMaterialsSummary':
        return textPack('nodeMaterialsSummary', input.language === 'en' ? 'Node material summary' : '节点资料摘要', input.nodeMaterialsSummary);
      case 'activeFile':
        return buildActiveFilePack(input.activeFile, input.language);
      case 'ragSnippets':
        return textPack('ragSnippets', input.language === 'en' ? 'Retrieved snippets' : '检索片段', input.ragSnippets);
      case 'studentMemory':
        return buildStudentMemoryPack(input.courseId, input.studentMemory);
      case 'attachments':
        return buildAttachmentsPack(input);
      case 'searchMode':
        return buildSearchModePack(input);
      case 'localeInstruction':
        return buildLocalePack(input.language);
      case 'userRequest':
        return textPack('userRequest', input.language === 'en' ? 'User request' : '用户要求', `${input.userRequest ?? ''}${input.motorSkillPracticeNote ?? ''}`);
      case 'authoritativeSources':
        return buildAuthoritativeSourcesPack(input);
      case 'practiceSourceBrief':
        return textPack('practiceSourceBrief', input.language === 'en' ? 'Practice Source Brief' : '实践题源简报', input.practiceSourceBrief);
      case 'videoReferences':
        return buildVideoReferencesPack(input);
      default:
        return undefined;
    }
  }
}

function diffLabel(difficulty: string, language?: string): string {
  const map = language === 'en' ? DIFFICULTY_LABEL_EN : DIFFICULTY_LABEL_ZH;
  return map[difficulty] ?? difficulty;
}

function buildCourseProfilePack(course: Course | null | undefined): ContextPack {
  const profileLines: string[] = [];
  if (course?.goal_text) profileLines.push(`学习目标：${course.goal_text}`);
  if (course?.known_topics) profileLines.push(`已掌握主题：${course.known_topics}`);
  if (course?.time_budget) profileLines.push(`时间预算：${course.time_budget}`);

  return {
    id: 'courseProfile',
    title: '用户学习档案',
    content: profileLines.length > 0
      ? `[用户学习档案]\n${profileLines.join('\n')}`
      : '[用户学习档案]\n（尚未填写，请在对话末尾引导用户补充目标和水平信息）',
  };
}

function buildCourseDagSummaryPack(nodes: DagNode[]): ContextPack {
  if (nodes.length === 0) {
    return {
      id: 'courseDagSummary',
      title: '当前课程路线图',
      content: '[当前课程尚无路线图，可以告知用户先生成路线]',
    };
  }

  const chapters = new Map<string, DagNode[]>();
  for (const node of nodes) {
    if (!chapters.has(node.chapter)) chapters.set(node.chapter, []);
    chapters.get(node.chapter)!.push(node);
  }

  const lines = [
    '[当前课程路线图]',
    '（节点格式：状态 节点名（难度，ID）— 调用 add_node 时 prerequisites 必须使用此处的 ID）',
  ];
  for (const [chapter, chapterNodes] of chapters) {
    chapterNodes.sort((a, b) => (a.chapter_order ?? 0) - (b.chapter_order ?? 0));
    lines.push(`\n## ${chapter}`);
    for (const node of chapterNodes) {
      const icon = node.status === 'done' ? '✅' : node.status === 'active' ? '🔵' : '⬜';
      const prereqNames = (node.prerequisites ?? [])
        .map((pid) => nodes.find((candidate) => candidate.id === pid)?.name ?? pid)
        .join(', ');
      const prereqStr = prereqNames ? ` ← [${prereqNames}]` : '';
      lines.push(`${icon} ${node.name}（${node.difficulty}，ID: ${node.id}）${prereqStr}`);
    }
  }

  return { id: 'courseDagSummary', title: '当前课程路线图', content: lines.join('\n') };
}

function buildCourseProgressPack(nodes: DagNode[]): ContextPack | undefined {
  if (nodes.length === 0) return undefined;
  const done = nodes.filter((node) => node.status === 'done').length;
  return {
    id: 'courseProgress',
    title: '课程进度',
    content: `已完成 ${done}/${nodes.length} 个节点。\n规划建议：新节点应根据知识依赖关系设置 prerequisites，使路线图形成有向无环图（DAG）。`,
  };
}

function buildCurrentNodePack(input: ContextPackResolverInput): ContextPack | undefined {
  if (!input.node) return undefined;
  const isEn = input.language === 'en';
  if (input.targetFolder) {
    return {
      id: 'currentNode',
      title: isEn ? 'Current node' : '当前节点',
      content: isEn
        ? `Node: ${input.node.name} (${input.node.chapter}, ${diffLabel(input.node.difficulty, input.language)})\n` +
          `Prerequisites completed: ${input.prereqNames || 'none'}\n` +
          `Request type: ${input.targetFolder}`
        : `节点：${input.node.name}（${input.node.chapter}，${diffLabel(input.node.difficulty, input.language)}难度）\n` +
          `前置已学：${input.prereqNames || '无'}\n` +
          `请求类型：${input.targetFolder}`,
    };
  }
  const mode = input.mode ?? 'balanced';
  const modeMap = isEn ? MODE_LABEL_EN : MODE_LABEL_ZH;
  return {
    id: 'currentNode',
    title: isEn ? 'Current learning context' : '当前学习上下文',
    content: isEn
      ? `[Learning Context]\nNode: "${input.node.name}" (${input.node.chapter}, ${diffLabel(input.node.difficulty, input.language)})\nGuidance Mode: ${modeMap[mode]}`
      : `[当前学习上下文]\n节点：「${input.node.name}」（${input.node.chapter}，${diffLabel(input.node.difficulty, input.language)}难度）\n引导模式：${modeMap[mode]}`,
  };
}

function buildNodeHandoffPack(handoff: NodeHandoff | null | undefined, language?: string): ContextPack | undefined {
  if (!handoff) return undefined;
  const isEn = language === 'en';
  const lines: string[] = [];
  if (handoff.taskDefinition) lines.push(isEn ? `Task definition: ${handoff.taskDefinition}` : `节点任务：${handoff.taskDefinition}`);
  if (handoff.scopeBoundary) lines.push(isEn ? `Boundary: ${handoff.scopeBoundary}` : `范围边界：${handoff.scopeBoundary}`);
  if (handoff.rationale) lines.push(isEn ? `Rationale: ${handoff.rationale}` : `规划依据：${handoff.rationale}`);
  if (handoff.recommendedSourceIds.length > 0) lines.push(isEn ? `Recommended source IDs: ${handoff.recommendedSourceIds.join(', ')}` : `推荐资料指针：${handoff.recommendedSourceIds.join('、')}`);
  if (handoff.suggestedQueries.length > 0) lines.push(isEn ? `Suggested queries: ${handoff.suggestedQueries.join(' | ')}` : `建议补充检索：${handoff.suggestedQueries.join(' ｜ ')}`);
  if (handoff.generationConstraints.length > 0) lines.push(isEn ? `Generation constraints: ${handoff.generationConstraints.join(' ; ')}` : `生成约束：${handoff.generationConstraints.join('；')}`);
  if (handoff.coverageRequirements.length > 0) lines.push(isEn ? `Coverage requirements: ${handoff.coverageRequirements.join(' ; ')}` : `覆盖要求：${handoff.coverageRequirements.join('；')}`);
  return { id: 'nodeHandoff', title: isEn ? 'Node handoff' : '主导师交接', content: lines.join('\n') };
}

function buildStudentMemoryPack(courseId: string, studentMemory?: string): ContextPack | undefined {
  const memory = studentMemory ?? buildMemoryContext(courseId);
  return memory ? { id: 'studentMemory', title: '学生记忆', content: memory } : undefined;
}

function buildAttachmentsPack(input: ContextPackResolverInput): ContextPack | undefined {
  const files = input.contextFiles ?? [];
  const images = input.imageAttachments ?? [];
  const pdfs = input.pdfAttachments ?? [];
  if (files.length + images.length + pdfs.length === 0) return undefined;
  const content = [
    files.length ? `Context files: ${files.join(', ')}` : '',
    images.length ? `Images attached: ${images.length}` : '',
    pdfs.length ? `PDFs attached: ${pdfs.length}` : '',
  ].filter(Boolean).join('\n');
  return { id: 'attachments', title: 'Attachments', content };
}

function buildActiveFilePack(activeFile: ActiveNodeFileContext | undefined, language?: string): ContextPack | undefined {
  if (!activeFile) return undefined;
  const isEn = language === 'en';
  const relPath = activeFile.relativePath || activeFile.name || activeFile.path;
  const type = activeFile.isMarkdown
    ? (isEn ? 'Markdown' : 'Markdown')
    : (isEn ? 'text or binary file' : '文本或二进制文件');
  const preview = activeFile.contentPreview?.trim();
  const lines = isEn
    ? [
        '[Active Open File]',
        `Path for node tools: ${relPath}`,
        `Name: ${activeFile.name}`,
        `Type: ${type}`,
        'If the user says "this file", "current file", "the open material", or "here", treat it as this file unless the user specifies another target.',
        'Before modifying it, still call read_file/list_node_files or edit_markdown_file/update_file so the change is grounded in the saved node file.',
      ]
    : [
        '[当前打开文件]',
        `节点工具可用路径：${relPath}`,
        `文件名：${activeFile.name}`,
        `类型：${type}`,
        '当用户说“这个文件”“当前文件”“这份资料”“左边打开的资料”“这里”时，优先理解为这个文件，除非用户另行指定目标。',
        '真正修改前仍要调用 read_file/list_node_files 或 edit_markdown_file/update_file，以保存到当前节点文件中。',
      ];
  if (preview) {
    lines.push(isEn ? 'Opened editor preview, possibly including unsaved edits:' : '当前编辑器预览（可能包含尚未保存的编辑）：');
    lines.push('```markdown');
    lines.push(preview);
    lines.push('```');
  }
  return { id: 'activeFile', title: isEn ? 'Active open file' : '当前打开文件', content: lines.join('\n') };
}

function buildSearchModePack(input: ContextPackResolverInput): ContextPack | undefined {
  if (!input.searchMode) return undefined;
  return {
    id: 'searchMode',
    title: 'Search mode',
    content: getSearchModeInstruction(input.searchMode, input.agentChannel ?? 'sub_tutor', input.language),
  };
}

function buildLocalePack(language?: string): ContextPack {
  return {
    id: 'localeInstruction',
    title: 'Language',
    content: localMsg(language, '[语言] 请使用中文回答。', '[Language] Please answer in English.'),
  };
}

function buildAuthoritativeSourcesPack(input: ContextPackResolverInput): ContextPack {
  const isEn = input.language === 'en';
  return {
    id: 'authoritativeSources',
    title: isEn ? 'Authoritative Reference Sources' : '权威参考来源',
    content: (isEn ? '# Authoritative Reference Sources (Tier 1 first — facts must be grounded in these)\n\n' : '# 权威参考来源（Tier 1 优先，事实部分以此为准）\n\n') +
      (input.authoritativeSources || (isEn ? '(No authoritative sources found — generate from reliable knowledge and mark all content [AI Generated])' : '（未找到权威来源，请基于可靠知识生成，并全文标注 [AI 生成]）')),
  };
}

function buildVideoReferencesPack(input: ContextPackResolverInput): ContextPack | undefined {
  if (!input.videoReferences) return undefined;
  const isEn = input.language === 'en';
  return {
    id: 'videoReferences',
    title: isEn ? 'Tutorial Video References' : '教学视频参考',
    content: isEn
      ? `# Tutorial Video References (from YouTube — link directly when writing reference sections)\n\n${input.videoReferences}`
      : `# 教学视频参考（来自 YouTube，写入参考资料时可直接引用链接）\n\n${input.videoReferences}`,
  };
}

function textPack(
  id: ContextPackId,
  title: string,
  content: string | undefined,
  prefix?: string,
): ContextPack | undefined {
  if (!content) return undefined;
  return { id, title, content: prefix ? `${prefix}\n${content}` : content };
}
