import type { ToolTurnMessage } from '../llm/adapter';
import { NodeRepository, EdgeRepository } from '../db/repositories/node.repo';
import { CourseRepository } from '../db/repositories/course.repo';
import { NodeHandoffRepository } from '../db/repositories/node-handoff.repo';
import type { AgentRequest } from '../agent-core/orchestrator';
import type { ChatAgentRunSpec } from '../agent-core/chat-agent-runner';
import {
  runAgentDefinition,
  resolvePolicyLayerCtx,
  resolveSearchMode,
  type AgentDefinition,
} from '../agent-core/agent-definition';
import { AgentProfileResolver } from '../agent-core/profile-resolver';
import type { AgentRunContext } from '../agent-core/run-context';
import type { CommandContext } from '../commands/registry';
import { composeSystemPrompt } from '../agent-policy/policy-layer-registry';
import { localMsg } from '../prompt/prompt-builder';
import { buildDagToolRegistry } from '../agent-tools/dag-tools/index';
import type { DagToolContext } from '../agent-tools/dag-tools/index';
import { filterRegistryBySearchMode } from '../agent-tools/search-mode-guard';
import { AgentContextBuilder } from '../agent-context/context-builder';
import { mainTutorProfile } from '../agent-profiles/main-tutor.profile';
import { DagGenerator, type CourseProfileRepositoryPort } from './main-tutor/dag-generator';
import { DagPersistence } from './main-tutor/dag-persistence';
import { DagPromptBuilder } from './main-tutor/prompts';
import { workflowRunner } from './workflow-runner';

interface MainTutorContextBuilder {
  buildProfileContext(
    profile: typeof mainTutorProfile,
    input: {
      courseId: string;
      searchMode?: AgentRequest['searchMode'];
      agentChannel?: AgentRequest['type'];
      language?: AgentRequest['language'];
      contextFiles?: string[];
      imageAttachments?: AgentRequest['imageAttachments'];
      pdfAttachments?: AgentRequest['pdfAttachments'];
      contextTokenBudget?: number;
    },
  ): { content: string };
}

export interface MainTutorDeps {
  courseRepo: CourseProfileRepositoryPort;
  contextBuilder: MainTutorContextBuilder;
  dagGenerator: Pick<DagGenerator, 'generate'>;
}

export function createMainTutorDeps(): MainTutorDeps {
  const nodeRepo = new NodeRepository();
  const edgeRepo = new EdgeRepository();
  const courseRepo = new CourseRepository();
  const handoffRepo = new NodeHandoffRepository();
  const promptBuilder = new DagPromptBuilder();

  return {
    courseRepo,
    contextBuilder: new AgentContextBuilder(),
    dagGenerator: new DagGenerator({
      courseRepo,
      persistence: new DagPersistence(nodeRepo, edgeRepo, handoffRepo, courseRepo),
      promptBuilder,
    }),
  };
}

const profileResolver = new AgentProfileResolver([mainTutorProfile]);

function toolResultSucceeded(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { success?: unknown };
    return parsed.success === true;
  } catch {
    return /"success"\s*:\s*true/.test(content);
  }
}

function buildRouteSummary(content: string, language?: string): string {
  try {
    const parsed = JSON.parse(content) as {
      success?: unknown;
      nodeCount?: unknown;
      chapterNames?: unknown;
    };
    if (parsed.success !== true) return '';
    const nodeCount = typeof parsed.nodeCount === 'number' ? parsed.nodeCount : 0;
    const chapters = Array.isArray(parsed.chapterNames)
      ? parsed.chapterNames.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
      : [];
    const chapterText = chapters.length > 0
      ? chapters.join('、')
      : localMsg(language, '若干章节', 'several chapters');
    return localMsg(
      language,
      `路线图已生成，共 ${nodeCount} 个节点，分为 ${chapters.length || '若干'} 个章节：${chapterText}。\n\n你可以从第一个可用节点开始学习，也可以继续让我细化某一章或调整路线难度。`,
      `The roadmap has been generated with ${nodeCount} nodes across ${chapters.length || 'several'} chapters: ${chapterText}.\n\nYou can start from the first available node, or ask me to refine a chapter or adjust the roadmap difficulty.`,
    );
  } catch {
    return '';
  }
}

function buildRouteFailureSummary(content: string | undefined, language?: string): string {
  const detail = (content ?? '').trim();
  return localMsg(
    language,
    `路线图生成失败，已停止自动重试。\n\n失败原因：${detail || '未知错误'}\n\n你可以调整需求范围、补充学习目标/时间预算后再重新生成。`,
    `Roadmap generation failed, and automatic retry has been stopped.\n\nReason: ${detail || 'Unknown error'}\n\nYou can narrow the scope, add learning goals or time budget, then generate again.`,
  );
}

export class MainTutor implements AgentDefinition<DagToolContext> {
  readonly profile = mainTutorProfile;
  readonly usageSource = 'main_tutor_chat';

  constructor(private readonly deps: MainTutorDeps = createMainTutorDeps()) {}

  async handle(req: AgentRequest): Promise<void> {
    switch (req.action) {
      case 'chat':
      case 'roadmap_generate':
      case 'roadmap_edit':
      case 'course_strategy':
      case 'node_dispatch':
        await runAgentDefinition(this, req);
        break;
      default:
        throw new Error(`MainTutor: unsupported action ${req.action}`);
    }
  }

  buildCommandContext(req: AgentRequest): CommandContext {
    return { courseId: req.courseId, threadId: req.threadId };
  }

  async buildRunSpec(
    req: AgentRequest,
    runContext: AgentRunContext,
  ): Promise<ChatAgentRunSpec<DagToolContext>> {
    const sender = req.senderEvent.sender;
    const searchMode = resolveSearchMode(req);
    const course = this.deps.courseRepo.findById(req.courseId);
    const profileIncomplete = !course?.goal_text || !course?.known_topics;
    const profileGuidance = profileIncomplete
      ? '\n\n[档案引导] 若本次用户消息未涉及学习目标或已掌握主题，请在回复末尾用一句话自然引导用户补充，例如："顺便问一下，您希望学到什么程度，目前有哪些基础？填写后我可以给出更准确的规划建议。"若用户提到了相关信息，请调用 update_profile 工具保存。'
      : '';
    const systemPrompt = (await composeSystemPrompt(
      this.profile,
      resolvePolicyLayerCtx(this.profile, req, false),
    )) + profileGuidance;

    const dagCtx: DagToolContext = {
      courseId: req.courseId,
      sessionId: req.sessionId,
      sender,
      provider: req.provider,
      model: req.model,
      searchMode,
      language: req.language,
      taskList: runContext.taskList,
      runContext,
      runDagGeneration: async (topic: string) => {
        profileResolver.assertWorkflowAllowed(this.profile, 'route.generate');
        const result = await workflowRunner.run('route.generate', {
          req,
          sender,
          topic,
          generate: (generateReq, runSender, topicOverride, context, lifecycle) =>
            this.deps.dagGenerator.generate(generateReq, runSender, topicOverride, context, lifecycle),
        }, { context: runContext });
        return { nodeCount: result.nodeCount, chapterNames: result.chapterNames };
      },
    };

    // Full course context — no intent-driven pack narrowing.
    const plannerContext = this.deps.contextBuilder.buildProfileContext(this.profile, {
      courseId: req.courseId,
      searchMode,
      agentChannel: 'main_tutor',
      language: req.language,
      contextFiles: req.contextFiles,
      imageAttachments: req.imageAttachments,
      pdfAttachments: req.pdfAttachments,
    });

    return {
      systemPrompt,
      initialMessages: [
        { role: 'user', content: plannerContext.content },
        { role: 'assistant', text: '好的，我已了解当前课程状态，可以开始讨论。', toolCalls: [] },
      ] satisfies ToolTurnMessage[],
      // Profile-filtered DAG tool set, then trimmed by the active search mode.
      toolRegistry: filterRegistryBySearchMode(
        profileResolver.filterToolRegistry(buildDagToolRegistry(req.language), this.profile),
        searchMode,
      ),
      toolContext: dagCtx,
      loopConfig: profileResolver.getLoopConfig(this.profile),
      afterToolResults: (_turn, response, toolResults) => {
        const generatedRoute = response.toolCalls.some((call) => call.name === 'generate_dag');
        if (!generatedRoute) return;
        const routeResult = toolResults.find((result) =>
          response.toolCalls.some((call) => call.name === 'generate_dag' && call.id === result.toolCallId),
        );
        if (!routeResult || routeResult.isError || !toolResultSucceeded(routeResult.content)) {
          runContext.chunk(buildRouteFailureSummary(routeResult?.content, req.language));
          return 'complete';
        }
        const summary = buildRouteSummary(routeResult.content, req.language);
        if (summary) runContext.chunk(summary);
        return 'complete';
      },
    };
  }
}
