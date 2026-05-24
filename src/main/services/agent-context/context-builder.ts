import type { DagNode, GenerateFolder, LLMMessage } from '@shared/types';
import { CourseRepository } from '../db/repositories/course.repo';
import { NodeRepository } from '../db/repositories/node.repo';
import type { AgentProfile } from '../agent-core/run-state';
import type { ContextPack } from './context-pack';
import { joinContextPacks, type BuiltContext } from './context-pack';
import { ContextPackResolver, type ContextPackResolverInput } from './context-pack-resolver';

export function buildDagGenerationContext(input: {
  messages?: LLMMessage[];
  topic: string;
  searchQueries?: string[];
}): BuiltContext {
  const packs: ContextPack[] = [];
  const historyContext = (input.messages ?? [])
    .slice(-8)
    .map((message) => `[${message.role === 'user' ? '用户' : 'AI'}]: ${message.content}`)
    .join('\n');

  if (historyContext) {
    packs.push({
      id:      'courseDagSummary',
      title:   '对话背景',
      content: `[对话背景]\n${historyContext}`,
    });
  }

  const searchHint = input.searchQueries?.length
    ? `\n\n建议搜索关键词（请依次调用 web_search）：${input.searchQueries.map((query) => `「${query}」`).join('、')}`
    : '';

  packs.push({
    id:      'userRequest',
    title:   '用户请求',
    content: `${input.topic}${searchHint}`,
  });

  return joinContextPacks(packs, '\n\n---\n\n');
}

export function buildMaterialGenerationContext(input: {
  node: DagNode;
  prereqNames: string;
  targetFolder: GenerateFolder;
  outlineText: string;
  indexText: string;
  guideSection: string;
  motorSkillPracticeNote: string;
  sourceText: string;
  practiceSourceBrief?: string;
  videoText: string;
  language?: string;
}): BuiltContext {
  return new ContextPackResolver().resolve([
    'currentNode',
    'nodeOutline',
    'coverageIndex',
    'userRequest',
    'authoritativeSources',
    'practiceSourceBrief',
    'videoReferences',
  ], {
    courseId: 'material-context',
    node: input.node,
    prereqNames: input.prereqNames,
    targetFolder: input.targetFolder,
    outlineText: input.outlineText,
    indexText: input.indexText,
    userRequest: input.guideSection,
    motorSkillPracticeNote: input.motorSkillPracticeNote,
    authoritativeSources: input.sourceText,
    practiceSourceBrief: input.practiceSourceBrief,
    videoReferences: input.videoText,
    language: input.language,
  }, '\n\n---\n\n');
}

export class AgentContextBuilder {
  constructor(
    private readonly courseRepo = new CourseRepository(),
    private readonly nodeRepo = new NodeRepository(),
    private readonly packResolver = new ContextPackResolver(),
  ) {}

  buildProfileContext(
    profile: AgentProfile,
    input: Omit<ContextPackResolverInput, 'course' | 'nodes'>,
  ): BuiltContext {
    // Full context from the profile — no intent-driven per-pack budgeting.
    // Overall context-window budgeting is handled by ContextWindowManager.
    return this.packResolver.resolveForProfile(profile, {
      ...input,
      course: this.courseRepo.findById(input.courseId),
      nodes: this.nodeRepo.findByCourse(input.courseId),
    });
  }
}
