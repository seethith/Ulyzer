import { IPC } from '@shared/ipc-channels';
import type {
  DagNode, GuidanceMode, TokenUsage,
} from '@shared/types';
import { LLMAdapter } from '../llm/adapter';
import { NodeRepository } from '../db/repositories/node.repo';
import { getDb } from '../db/sqlite';
import { ChecklistRepository } from '../db/repositories/checklist.repo';
import { compressHistory, collapseContext } from './agent-loop';
import type { ToolTurnMessage } from '../llm/adapter';
import { buildChatToolDefs, getChatTool } from './chat-tools/registry';
import { buildMemoryContext } from './student-memory';
import { isCommand, resolveCommand } from '../commands/registry';
import { languageLayer, localMsg } from '../prompt/prompt-builder';
import type { AgentRequest } from './orchestrator';

const nodeRepo = new NodeRepository();
const checklistRepo = new ChecklistRepository();

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeSend(sender: Electron.WebContents, channel: string, data: unknown): void {
  try {
    if (!sender.isDestroyed()) sender.send(channel, data);
  } catch {
    // window closed
  }
}

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
const DIFFICULTY_LABEL_EN: Record<string, string> = {
  beginner:     'Beginner',
  intermediate: 'Intermediate',
  advanced:     'Advanced',
};

// ── System prompts ────────────────────────────────────────────────────────────

/**
 * T6-3: Static system prompt — contains all invariant content.
 * This block is sent with cache_control so Anthropic caches it server-side,
 * cutting input-token cost by ~90% on cache-hit requests.
 */
const STATIC_CHAT_SYSTEM_PROMPT = `你是一名 AI 学习导师，支持三种引导模式。请根据对话开头的上下文消息中指定的模式和节点信息进行辅导。

## 引导模式说明

### 严格模式（strict）
- 不直接给出答案，采用苏格拉底式引导
- 优先用提问让学员思考，如"你认为原因是什么？""你尝试了哪些方法？"
- 只有当学员展示了自己的思考过程后，才提供进一步提示
- 鼓励先动手尝试，遇到具体错误再来求助
- 每次回复结尾附一个引导性问题

### 均衡模式（balanced，默认）
- 先引导学员思考，询问他们已有的理解
- 对初学者的基础问题可以直接解答
- 对练习题相关的问题，给提示而不是直接答案
- 回答要简洁，配合具体例子

### 宽松模式（loose）
- 直接、详细地回答问题，给出完整代码和解释
- 鼓励学员提出更多问题，建立学习信心

## 通用原则
- 回复语言与用户保持一致
- 若有参考资料片段，优先引导学员思考而非直接摘抄
- 紧扣当前节点知识范围，适当拓展但不偏离核心主题

## 工具使用原则
你有内容生成、资料读取和笔记管理工具，应主动判断并调用，无需等用户明确要求：
- 用户说"帮我生成大纲"/"生成纲要"/"升级纲要"/"纲要太简单了"/"先生成大纲" → 调用 generate_outline（自动检测当前版本，v0→v1→v2→v3，每次只升一级）
- 用户对某概念不清楚 → 调用 generate_theory 生成讲解（保存到「原理资料」）
- 用户想练习或检验掌握 → 调用 generate_practice 出题（保存到「实践资料」）
- 用户表示学完了或想复盘 → 调用 generate_feynman_checklist（保存到「费曼复盘」）
- 用户说"帮我画思维导图"/"知识结构" → 调用 generate_mindmap（保存到「原理资料」）
- 用户做错题或有理解偏差 → 调用 record_mistake 记录（保存到「实践资料/mistakes.md」）
- 用户说"帮我记下来"/"存到笔记"/"整理关键点" → 调用 append_to_notes（保存到「个人笔记」）
- 用户问某概念原理/不理解某内容/报错时 → 先调用 search_knowledge 查询已有资料，再决定是否生成新内容或直接回答
- 用户说"帮我找视频"/"推荐教学视频"/"有没有视频讲这个"/"视频资源" 等 → 调用 search_videos
- 回答前不确定是否有重复内容 → 先调用 read_materials 查看
- **调用 generate_theory / generate_practice / generate_feynman_checklist 前，禁止手动读取知识纲要**（不要调 read_materials、read_file、search_knowledge 去找纲要文件）——这些生成工具内部会自动读取纲要，直接调用即可，无需预读。
- 用户要求在节点文件夹内自由创建文件或子文件夹 → 调用 create_file
- 用户明确确认要对某 KC 开启专题深钻（说"是""确认"等）→ 调用 generate_topic(kcId, kcName)
- 普通问答、引导式对话无需调用任何工具，直接回复即可
- **绝不主动调用 generate_outline**，只有用户明确说要生成/升级大纲时才调用；若 generate_theory/generate_practice 返回失败，直接将工具返回的失败信息转告用户，不做任何自动补救。

## 文件夹对应关系（严格遵守，不得混淆）
- 「原理资料」= theory：概念讲解、原理分析、思维导图
- 「实践资料」= practice：练习题、实操任务、参考答案、错题本
- 「个人笔记」= notes：学习笔记、关键点摘要、心得
- 「费曼复盘」= answer（在 generate 系列工具中）：复盘清单、费曼笔记

## Skill 编排策略（AI 自主引导的多步工作流）

### Skill 1：费曼复盘（触发词：复盘/检验/我学完了/费曼）
Step 1: read_materials('费曼复盘') → 检查是否有清单
  → 无清单：generate_feynman_checklist() → 提示用户"填写后再发给我"
  → 有清单但用户没提交笔记：引导用户"请用自己的语言填写清单后发给我"
  → 用户提交了笔记：评估笔记质量，指出盲区，给出具体改进建议
Step 2 (score < 75): read_materials('原理资料') → "你在X上有偏差，我帮你重新讲"
Step 2 (score >= 75): 祝贺 → 询问是否生成章节总结

### Skill 2：思维导图（触发词：思维导图/知识图/可视化/知识结构）
Step 1: read_materials('原理资料') → 若有资料，告知"基于已有资料生成"
Step 2: generate_mindmap() → 生成 Mermaid 思维导图
Step 3: 引导用户"在左侧文件列表中打开查看可视化效果"

### Skill 3：错题本回顾（触发词：错题/帮我回顾/我之前错的）
Step 1: read_file('mistakes.md', '实践资料') → 获取错题列表
  → 无错题：提示"目前没有错题记录，可以先做练习"
  → 有错题：按知识点分类展示
Step 2 (可选): generate_practice(专项强化) → 针对错误知识点出新题

### Skill 4：章节总结（触发词：这章学完了/整合本章/章节总结）
Step 1: get_node_progress() → 确认章节内节点学习情况
Step 2: generate_chapter_summary() → 生成跨节点综合总结
Step 3: 建议下一步复习重点

### Skill 5：薄弱项分析（触发词：哪里没掌握/薄弱点/该复习什么）
Step 1: get_node_progress() → 找出 locked/available 节点和有错题的节点
Step 2: read_file('mistakes.md', '实践资料') → 统计高频错误
Step 3: 综合输出 Top 3 薄弱节点 + 具体薄弱点 + 推荐复习顺序
Step 4 (可选): generate_practice(最弱节点专项) → 出针对性练习题

### Skill 6：学前摸底（触发词：我想开始学/这个我了解多少/先测测我）
Step 1: AI 直接 chat 生成 3-5 道摸底题（不调 Tool，快速）
Step 2: 用户回答 → AI 评估基础水平
  → 基础薄弱：建议回顾前置节点 → generate_theory(基础重点)
  → 基础扎实："直接进入进阶内容" → generate_theory(进阶聚焦)

### Skill 7：专题深钻（触发词：深入了解/再挖深一点/详细讲/底层原理/边界情况/这个我想彻底搞清楚）
Step 1: AI 识别用户想深入的具体知识点，结合知识纲要中的 KC 列表判断最匹配的 KC
Step 2: AI 提议：「是否为「[KC名称]」开启专题？开启后我将生成该知识组件的专题纲要，覆盖其深层机制、边界条件和专家级误区。（回复「是」或「确认」即可）」
Step 3: 用户确认后 → 调用 generate_topic(kcId, kcName)
注意：用户只是提问时直接回答，不主动提议专题；不得未经确认直接调用 generate_topic。`;

const MODE_LABEL_ZH: Record<GuidanceMode, string> = {
  strict:   '严格模式（苏格拉底引导）',
  balanced: '均衡模式（引导为主）',
  loose:    '宽松模式（直接解答）',
};
const MODE_LABEL_EN: Record<GuidanceMode, string> = {
  strict:   'Strict (Socratic guidance)',
  balanced: 'Balanced (guided)',
  loose:    'Loose (direct answers)',
};

/**
 * T6-4: Build the dynamic context that is injected as the FIRST user message,
 * followed by a neutral assistant acknowledgement, before the chat history.
 * Keeps the cached static system prompt truly static across every request.
 */
function buildDynamicContext(node: DagNode, mode: GuidanceMode, language?: string): string {
  const isEn = language === 'en';
  const diffMap = isEn ? DIFFICULTY_LABEL_EN : DIFFICULTY_LABEL_ZH;
  const modeMap = isEn ? MODE_LABEL_EN : MODE_LABEL_ZH;
  const diff = diffMap[node.difficulty] ?? node.difficulty;
  if (isEn) {
    return `[Learning Context]\nNode: "${node.name}" (${node.chapter}, ${diff})\nGuidance Mode: ${modeMap[mode]}`;
  }
  return `[当前学习上下文]\n节点：「${node.name}」（${node.chapter}，${diff}难度）\n引导模式：${modeMap[mode]}`;
}

// ── Web search helpers (T3) ───────────────────────────────────────────────────

// ── Mastery checklist generation ──────────────────────────────────────────────
//
// Designed as a top-level independent function so it can later be wrapped as a
// tool call inside SubTutorLoop without refactoring the internals.
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
      onChunk: (chunk) => { rawJson += chunk; },
      onComplete: () => { /* noop */ },
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

export class SubTutor {
  async handle(req: AgentRequest): Promise<void> {
    switch (req.action) {
      case 'chat':
        await this.handleChat(req);
        break;
      default:
        throw new Error(`SubTutor: unsupported action ${req.action}`);
    }
  }

  private async handleChat(req: AgentRequest): Promise<void> {
    const sender = req.senderEvent.sender;
    const nodeId = req.nodeId;

    // ── Slash command shortcuts (kept for quick access; AI handles natural language) ──
    if (isCommand(req.userMessage)) {
      const resolved = resolveCommand(req.userMessage);
      if (resolved) {
        const { command, args } = resolved;
        const ctx = { courseId: req.courseId, nodeId };

        if (command.type === 'local') {
          const result = command.handler(args, ctx) as string;
          safeSend(sender, IPC.LLM_STREAM_CHUNK, { sessionId: req.sessionId, chunk: result });
          safeSend(sender, IPC.LLM_STREAM_END,   { sessionId: req.sessionId, usage: { inputTokens: 0, outputTokens: 0, costCny: 0 } });
          return;
        }

        if (command.type === 'prompt') {
          const prefix = command.handler(args, ctx) as string;
          req = { ...req, userMessage: prefix + (args ? '\n\n' + args : '') };
        }

        if (command.type === 'action') {
          // action-type commands are no longer used; fall through to handleChat
        }
      }
    }

    // ── Build conversation context ─────────────────────────────────────────────
    const mode = getGuidanceMode();
    const node = nodeId ? nodeRepo.findById(nodeId) : null;

    // Convert plain history to ToolTurnMessage format for streamWithTools
    const history = compressHistory(req.messages ?? []);
    let toolMessages: ToolTurnMessage[] = [];

    if (node) {
      const memCtx = buildMemoryContext(req.courseId);
      const dynamicCtx = (memCtx ? memCtx + '\n' : '') + buildDynamicContext(node, mode, req.language);
      toolMessages.push({ role: 'user',      content: dynamicCtx });
      toolMessages.push({ role: 'assistant', text: localMsg(req.language, '好的，我已了解当前节点信息和引导模式，开始辅助学习。', 'Understood. I have the node context and guidance mode. Ready to help.'), toolCalls: [] });
    }

    for (const m of history) {
      toolMessages.push(
        m.role === 'user'
          ? { role: 'user', content: m.content }
          : { role: 'assistant', text: m.content, toolCalls: [] },
      );
    }

    // Append current user message so it's available on every turn (including tool turns)
    toolMessages.push({ role: 'user', content: req.userMessage });

    // ── ToolContext wired to sender ─────────────────────────────────────────────
    const toolCtx = {
      sessionId: req.sessionId,
      courseId:  req.courseId,
      nodeId:    nodeId ?? '',
      provider:  req.provider,
      model:     req.model,
      signal:    req.signal,
      language:  req.language,
      onChunk:   (chunk: string) =>
        safeSend(sender, IPC.LLM_STREAM_CHUNK, { sessionId: req.sessionId, chunk }),
      onProgress: (msg: string) =>
        safeSend(sender, IPC.LLM_STREAM_CHUNK, { sessionId: req.sessionId, chunk: msg, isProgress: true }),
      onFileGenerated: (payload: import('@shared/types').FileGeneratedPayload) => {
        if (nodeId && !checklistRepo.hasChecklist(nodeId)) {
          void generateMasteryChecklist(nodeId, req.provider, req.model);
        }
        safeSend(sender, IPC.FILE_GENERATED, payload);
      },
    };

    // ── streamWithTools loop ───────────────────────────────────────────────────
    // AI decides when to call tools; no rigid intent matching needed.
    const baseSystemPrompt = node ? STATIC_CHAT_SYSTEM_PROMPT : localMsg(req.language, '你是一名 AI 学习助手，请帮助用户解答学习问题。', 'You are an AI learning assistant. Help the user with their learning questions.');
    const langInstruction = languageLayer(req.language)();
    const systemPrompt = langInstruction ? `${baseSystemPrompt}\n\n${langInstruction}` : baseSystemPrompt;
    const chatTools    = buildChatToolDefs();
    const accUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, costCny: 0 };
    const MAX_TOOL_TURNS        = 10;
    const CHAT_COMPRESS_THRESHOLD = 20; // compress tool-turn history after this many messages

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      if (req.signal?.aborted) return;

      // Semantic context compression — only after the first tool turn to avoid compressing
      // the initial context setup; falls back to microcompact if LLM call fails.
      if (turn > 0 && toolMessages.length > CHAT_COMPRESS_THRESHOLD) {
        toolMessages = await collapseContext(toolMessages, {
          provider:   req.provider,
          model:      req.model,
          signal:     req.signal,
          onProgress: (msg) => safeSend(sender, IPC.LLM_STREAM_CHUNK, { sessionId: req.sessionId, chunk: msg, isProgress: true }),
        });
      }

      const response = await LLMAdapter.streamWithTools({
        provider:    req.provider,
        model:       req.model,
        systemPrompt,
        messages:    toolMessages,
        tools:       chatTools,
        maxTokens:   2048,
        signal:      req.signal,
        onChunk:     (chunk) => safeSend(sender, IPC.LLM_STREAM_CHUNK, { sessionId: req.sessionId, chunk }),
      }).catch((err: Error) => {
        safeSend(sender, IPC.LLM_STREAM_ERROR, { sessionId: req.sessionId, error: err.message });
        return null;
      });

      if (!response) return;

      accUsage.inputTokens  += response.usage.inputTokens;
      accUsage.outputTokens += response.usage.outputTokens;
      accUsage.costCny      += response.usage.costCny;

      toolMessages.push(response.assistantTurn);

      if (response.stopReason !== 'tool_use' || response.toolCalls.length === 0) break;

      const toolResults = await Promise.all(
        response.toolCalls.map(async (tc) => {
          const tool = getChatTool(tc.name);
          if (!tool) return { toolCallId: tc.id, content: localMsg(req.language, `未知工具: ${tc.name}`, `Unknown tool: ${tc.name}`) };
          try {
            const result = await tool.execute(tc.input, toolCtx);
            return { toolCallId: tc.id, content: tool.formatResult(result) };
          } catch (err) {
            return { toolCallId: tc.id, content: localMsg(req.language, `工具执行出错: ${String(err)}`, `Tool error: ${String(err)}`), isError: true };
          }
        }),
      );
      toolMessages.push({ role: 'tool_results', results: toolResults });
    }

    safeSend(sender, IPC.LLM_STREAM_END, { sessionId: req.sessionId, usage: accUsage });
  }


}
