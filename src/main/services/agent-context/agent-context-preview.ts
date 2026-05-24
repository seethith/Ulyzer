import type { AgentContextStatusRequest, GuidanceMode, SearchMode } from '@shared/types';
import type { ToolDef, ToolTurnMessage } from '../llm/adapter';
import { getDb } from '../db/sqlite';
import { CourseRepository } from '../db/repositories/course.repo';
import { NodeRepository } from '../db/repositories/node.repo';
import { NodeHandoffRepository } from '../db/repositories/node-handoff.repo';
import { AgentProfileResolver } from '../agent-core/profile-resolver';
import { AgentContextBuilder } from './context-builder';
import { mainTutorProfile } from '../agent-profiles/main-tutor.profile';
import { nodeTutorProfile } from '../agent-profiles/node-tutor.profile';
import { buildDagToolRegistry } from '../agent-tools/dag-tools';
import { buildChatToolRegistry } from '../agent-tools/chat-tools/registry';
import { isRoadmapCreationRequest } from '../agent-workflows/main-tutor/roadmap-intent';
import { buildSystemPrompt, languageLayer, localMsg, modelIdentityLayer, roleLayer } from '../prompt/prompt-builder';
import {
  folderPolicyLayer,
  generalLearningAssistantRolePolicyLayer,
  nodeTutorChatRolePolicyLayer,
  nodeTutorToolRoutingPolicyLayer,
  nodeTutorWorkflowRoutingPolicyLayer,
  searchPolicyLayer,
  tutorGuidancePolicyLayer,
} from '../agent-policy';
import type { ContextTaskKind } from './context-window-budget';

export interface AgentContextProjectionPreview {
  systemPrompt: string;
  initialMessages: ToolTurnMessage[];
  tools: ToolDef[];
  taskKind: ContextTaskKind;
}

const courseRepo = new CourseRepository();
const nodeRepo = new NodeRepository();
const handoffRepo = new NodeHandoffRepository();
const contextBuilder = new AgentContextBuilder(courseRepo, nodeRepo);
const mainResolver = new AgentProfileResolver([mainTutorProfile]);
const nodeResolver = new AgentProfileResolver([nodeTutorProfile]);

function getGuidanceMode(): GuidanceMode {
  try {
    const row = getDb()
      .prepare<[], { guidance_mode: string }>('SELECT guidance_mode FROM settings WHERE id = 1')
      .get();
    return (row?.guidance_mode as GuidanceMode) ?? 'balanced';
  } catch {
    return 'balanced';
  }
}

function resolveSearchMode(req: AgentContextStatusRequest): SearchMode {
  return req.searchMode ?? 'auto';
}

export async function buildAgentContextProjectionPreview(
  req: AgentContextStatusRequest,
): Promise<AgentContextProjectionPreview> {
  return req.agentType === 'main_tutor'
    ? buildMainTutorPreview(req)
    : buildNodeTutorPreview(req);
}

async function buildMainTutorPreview(req: AgentContextStatusRequest): Promise<AgentContextProjectionPreview> {
  const searchMode = resolveSearchMode(req);
  const course = courseRepo.findById(req.courseId);
  const profileIncomplete = !course?.goal_text || !course?.known_topics;
  const profileGuidance = profileIncomplete
    ? '\n\n[档案引导] 若本次用户消息未涉及学习目标或已掌握主题，请在回复末尾用一句话自然引导用户补充，例如："顺便问一下，您希望学到什么程度，目前有哪些基础？填写后我可以给出更准确的规划建议。"若用户提到了相关信息，请调用 update_profile 工具保存。'
    : '';
  const systemPrompt = await buildSystemPrompt(
    roleLayer('maintutor', req.language),
    modelIdentityLayer(req.provider, req.model, req.language),
    languageLayer(req.language),
  ) + profileGuidance;

  const plannerContext = contextBuilder.buildProfileContext(mainTutorProfile, {
    courseId: req.courseId,
    searchMode,
    agentChannel: 'main_tutor',
    language: req.language,
  });
  const toolRegistry = mainResolver.filterToolRegistry(buildDagToolRegistry(req.language), mainTutorProfile);
  return {
    systemPrompt,
    initialMessages: [
      { role: 'user', content: plannerContext.content },
      { role: 'assistant', text: '好的，我已了解当前课程状态，可以开始讨论。', toolCalls: [] },
    ],
    tools: toolRegistry.buildToolDefs(req.language),
    taskKind: isRoadmapCreationRequest(req.currentUserMessage) ? 'roadmap' : 'chat',
  };
}

async function buildNodeTutorPreview(req: AgentContextStatusRequest): Promise<AgentContextProjectionPreview> {
  const searchMode = resolveSearchMode(req);
  const mode = getGuidanceMode();
  const node = req.nodeId ? nodeRepo.findById(req.nodeId) : null;
  const initialMessages: ToolTurnMessage[] = [];

  if (node) {
    const dynamicCtx = contextBuilder.buildProfileContext(nodeTutorProfile, {
      courseId: req.courseId,
      node,
      mode,
      language: req.language,
      searchMode,
      agentChannel: 'sub_tutor',
      handoff: handoffRepo.findByNodeId(node.id),
      activeFile: req.activeFile,
    });
    initialMessages.push({ role: 'user', content: dynamicCtx.content });
    initialMessages.push({
      role: 'assistant',
      text: localMsg(req.language, '好的，我已了解当前节点信息和引导模式，开始辅助学习。', 'Understood. I have the node context and guidance mode. Ready to help.'),
      toolCalls: [],
    });
  }

  const systemPrompt = node
    ? await buildSystemPrompt(
        nodeTutorChatRolePolicyLayer(req.language),
        tutorGuidancePolicyLayer(req.language),
        nodeTutorToolRoutingPolicyLayer(req.language),
        folderPolicyLayer(req.language),
        nodeTutorWorkflowRoutingPolicyLayer(req.language),
        searchPolicyLayer(searchMode, 'sub_tutor', req.language),
        modelIdentityLayer(req.provider, req.model, req.language),
        languageLayer(req.language),
      )
    : await buildSystemPrompt(
        generalLearningAssistantRolePolicyLayer(req.language),
        searchPolicyLayer(searchMode, 'sub_tutor', req.language),
        modelIdentityLayer(req.provider, req.model, req.language),
        languageLayer(req.language),
      );

  const toolRegistry = nodeResolver.filterToolRegistry(buildChatToolRegistry(), nodeTutorProfile);
  return {
    systemPrompt,
    initialMessages,
    tools: toolRegistry.buildToolDefs(req.language),
    taskKind: 'chat',
  };
}
