import type { GuidanceMode } from '@shared/types';
import { LLMAdapter } from '../llm/adapter';
import { NodeRepository } from '../db/repositories/node.repo';
import { getDb } from '../db/sqlite';
import { ChecklistRepository } from '../db/repositories/checklist.repo';
import { NodeHandoffRepository } from '../db/repositories/node-handoff.repo';
import type { ToolTurnMessage } from '../llm/adapter';
import { buildChatToolRegistry } from '../agent-tools/chat-tools/registry';
import { filterRegistryBySearchMode } from '../agent-tools/search-mode-guard';
import type { ToolContext } from '../agent-tools/tutor-tools/index';
import { localMsg } from '../prompt/prompt-builder';
import type { AgentRequest } from '../agent-core/orchestrator';
import type { ChatAgentRunSpec } from '../agent-core/chat-agent-runner';
import {
  runAgentDefinition,
  resolvePolicyLayerCtx,
  resolveSearchMode,
  type AgentDefinition,
} from '../agent-core/agent-definition';
import { composeSystemPrompt } from '../agent-policy/policy-layer-registry';
import { AgentProfileResolver } from '../agent-core/profile-resolver';
import type { AgentRunContext } from '../agent-core/run-context';
import type { CommandContext } from '../commands/registry';
import { AgentContextBuilder } from '../agent-context/context-builder';
import { nodeTutorProfile } from '../agent-profiles/node-tutor.profile';

const nodeRepo = new NodeRepository();
const checklistRepo = new ChecklistRepository();
const handoffRepo = new NodeHandoffRepository();
const profileResolver = new AgentProfileResolver([nodeTutorProfile]);
const contextBuilder = new AgentContextBuilder();

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

// ── Labels ────────────────────────────────────────────────────────────────────

const DIFFICULTY_LABEL_ZH: Record<string, string> = {
  beginner:     '入门',
  intermediate: '进阶',
  advanced:     '高级',
};

// ── Mastery checklist generation ──────────────────────────────────────────────
//
// Designed as a top-level independent function so it can later be wrapped as a
// chat/material tool without refactoring the internals.
// Call it fire-and-forget after material is saved — never await at the call site.

export async function generateMasteryChecklist(
  nodeId: string,
  provider: string,
  model: string,
): Promise<void> {
  const node = nodeRepo.findById(nodeId);
  if (!node) return;

  const systemPrompt = `你是一名学习目标评估专家。根据节点信息，生成一份掌握度检核清单。

输出严格 JSON 数组，每项包含：
- "concept": 知识点名称（简短）
- "verificationQuestion": 用该知识点能否真正理解的验证问题（不能通过背书回答）
- "required": true 表示核心必掌握，false 表示扩展了解

输出 5-8 个条目，按重要性排序。不要加代码块或任何多余文字，直接输出 JSON 数组。`;

  const difficultyLabel = DIFFICULTY_LABEL_ZH[node.difficulty] ?? node.difficulty;

  const userMessage = `节点名称：${node.name}
章节：${node.chapter}
难度：${difficultyLabel}
描述：${node.description ?? '无'}

生成该节点的掌握度检核清单。`;

  let rawJson = '';
  try {
    await LLMAdapter.stream({
      provider: provider as Parameters<typeof LLMAdapter.stream>[0]['provider'],
      model,
      messages: [{ role: 'user', content: userMessage }],
      systemPrompt,
      maxTokens: 1024,
      temperature: 0.3,
      usageContext: {
        courseId: node.course_id,
        source: 'mastery_checklist',
      },
      onChunk: (chunk) => { rawJson += chunk; },
      onComplete: () => {},
      onError: (err) => { console.error('[generateMasteryChecklist] LLM error:', err.message); },
    });

    const arr = JSON.parse(rawJson.trim()) as Array<{
      concept: string;
      verificationQuestion: string;
      required: boolean;
    }>;

    if (Array.isArray(arr) && arr.length > 0) {
      checklistRepo.upsertAll(nodeId, arr);
    }
  } catch (err) {
    // Non-fatal — checklist is a background enhancement
    console.error('[generateMasteryChecklist] Failed:', err);
  }
}

// ── SubTutor ──────────────────────────────────────────────────────────────────

export class SubTutor implements AgentDefinition<ToolContext> {
  readonly profile = nodeTutorProfile;
  readonly usageSource = 'sub_tutor_chat';

  async handle(req: AgentRequest): Promise<void> {
    switch (req.action) {
      case 'chat':
      case 'material_generate':
      case 'custom_artifact':
      case 'file_edit':
      case 'review':
      case 'diagnostic':
        await runAgentDefinition(this, req);
        break;
      default:
        throw new Error(`SubTutor: unsupported action ${req.action}`);
    }
  }

  buildCommandContext(req: AgentRequest): CommandContext {
    return { courseId: req.courseId, nodeId: req.nodeId, threadId: req.threadId };
  }

  async buildRunSpec(
    req: AgentRequest,
    runContext: AgentRunContext,
  ): Promise<ChatAgentRunSpec<ToolContext>> {
    const nodeId = req.nodeId;
    const mode = getGuidanceMode();
    const node = nodeId ? nodeRepo.findById(nodeId) : null;
    const searchMode = resolveSearchMode(req);
    const initialMessages: ToolTurnMessage[] = [];

    if (node) {
      // Full node context — no intent-driven pack narrowing. The model decides
      // which tools to call from the system prompt's tool-routing guidance.
      const dynamicCtx = contextBuilder.buildProfileContext(this.profile, {
        courseId: req.courseId,
        node,
        mode,
        language: req.language,
        searchMode,
        agentChannel: 'sub_tutor',
        handoff: handoffRepo.findByNodeId(node.id),
        activeFile: req.activeFile,
        contextFiles: req.contextFiles,
        imageAttachments: req.imageAttachments,
        pdfAttachments: req.pdfAttachments,
      });
      initialMessages.push({ role: 'user', content: dynamicCtx.content });
      initialMessages.push({ role: 'assistant', text: localMsg(req.language, '好的，我已了解当前节点信息和引导模式，开始辅助学习。', 'Understood. I have the node context and guidance mode. Ready to help.'), toolCalls: [] });
    }

    const systemPrompt = await composeSystemPrompt(
      this.profile,
      resolvePolicyLayerCtx(this.profile, req, Boolean(node)),
    );

    const toolCtx: ToolContext = {
      sessionId: req.sessionId,
      courseId:  req.courseId,
      nodeId:    nodeId ?? '',
      provider:  req.provider,
      model:     req.model,
      signal:    req.signal,
      language:  req.language,
      searchMode,
      taskList:  runContext.taskList,
      depth:     0,
      onChunk:   (chunk: string) => runContext.chunk(chunk),
      onProgress: (msg: string) => runContext.progress(msg),
      onFileGenerated: (payload) => {
        if (nodeId && !checklistRepo.hasChecklist(nodeId)) {
          void generateMasteryChecklist(nodeId, req.provider, req.model);
        }
        runContext.fileGenerated(payload);
      },
      runContext,
    };

    // Compaction is handled centrally by the proactive token-budget ladder in
    // runChatAgent — no per-turn message-count trigger here.
    return {
      systemPrompt,
      initialMessages,
      // Profile-filtered tool set, then trimmed by the active search mode so the
      // model never sees retrieval tools the mode forbids (off/web/library).
      toolRegistry: filterRegistryBySearchMode(
        profileResolver.filterToolRegistry(buildChatToolRegistry(), this.profile),
        searchMode,
      ),
      toolContext: toolCtx,
      loopConfig: profileResolver.getLoopConfig(this.profile),
    };
  }
}
