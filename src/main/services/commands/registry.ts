/**
 * Command registry for Ulyzer chat.
 *
 * Two command types (mirroring Claude Code's pattern):
 *   prompt  — expands to a system prompt injection; goes to the LLM
 *   local   — executes locally and returns a string; does NOT go to the LLM
 *
 * Commands are loaded in layers: builtin < user (same-name user commands win).
 *
 * Usage (renderer side):
 *   const cmd = resolveCommand('/explain', courseId);
 *   if (cmd?.type === 'prompt') userMessage = cmd.handler('/explain', ctx) + '\n' + userMessage;
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { NodeRepository } from '../db/repositories/node.repo';
import { getDb } from '../db/sqlite';

const nodeRepo = new NodeRepository();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CommandContext {
  courseId: string;
  nodeId?:  string;
  threadId?: string;
}

export type CommandType = 'prompt' | 'local';

export interface Command {
  /** Command name without the leading /  */
  name:        string;
  description: string;
  type:        CommandType;
  source:      'builtin' | 'user';
  /** Returns a prompt injection or local result */
  handler: (args: string, ctx: CommandContext) => string;
}

// ── Built-in commands ─────────────────────────────────────────────────────────

const builtinCommands: Command[] = [
  {
    name:        'explain',
    description: '深度解释当前概念，多角度多类比',
    type:        'prompt',
    source:      'builtin',
    handler: (args) =>
      `请深度解释以下内容，使用多个日常类比，从不同角度讲清楚：${args || '当前节点的核心概念'}`,
  },
  {
    name:        'quiz',
    description: '为当前节点生成练习题',
    type:        'prompt',
    source:      'builtin',
    handler: (args) =>
      `请为当前节点生成实践练习题，并调用 generate_practice 保存到实践资料。${args ? `要求：${args}` : ''}`,
  },
  {
    name:        'summary',
    description: '用3-5句话总结当前节点的核心要点',
    type:        'prompt',
    source:      'builtin',
    handler: (args) =>
      `请用 3-5 句话总结以下内容的核心要点，每句话对应一个关键知识点：${args || '我们刚才讨论的内容'}`,
  },
  {
    name:        'progress',
    description: '查看当前课程的学习进度统计',
    type:        'local',
    source:      'builtin',
    handler: (_args, ctx) => {
      const nodes = nodeRepo.findByCourse(ctx.courseId);
      if (nodes.length === 0) return '当前课程尚无路线图。';
      const done      = nodes.filter((n) => n.status === 'done').length;
      const active    = nodes.filter((n) => n.status === 'active').length;
      const available = nodes.filter((n) => n.status === 'available').length;
      const locked    = nodes.filter((n) => n.status === 'locked').length;
      const pct       = Math.round((done / nodes.length) * 100);
      return [
        `## 学习进度`,
        `总进度：${done}/${nodes.length} 节点（${pct}%）`,
        `- ✅ 已完成：${done}`,
        `- 🔵 进行中：${active}`,
        `- ⬜ 可学习：${available}`,
        `- 🔒 未解锁：${locked}`,
      ].join('\n');
    },
  },
  {
    name:        'usage',
    description: '查看当前课程和对话的 token / 费用统计',
    type:        'local',
    source:      'builtin',
    handler: (_args, ctx) => {
      try {
        interface UsageTotalRow {
          calls: number;
          input_tokens: number;
          output_tokens: number;
          input_cache_hit_tokens: number;
          input_cache_miss_tokens: number;
          estimated_calls: number;
          cost_cny: number;
        }
        interface UsageModelRow extends UsageTotalRow {
          provider: string | null;
          model: string | null;
        }
        interface ContextSnapshotRow {
          context_window: number;
          estimated_total_tokens: number;
          estimated_input_tokens: number;
          projected_tokens: number;
          risk_level: string;
        }
        const db = getDb();
        const total = db.prepare<[string], UsageTotalRow>(
          `SELECT COUNT(*) AS calls,
                  COALESCE(SUM(input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(input_cache_hit_tokens), 0) AS input_cache_hit_tokens,
                  COALESCE(SUM(input_cache_miss_tokens), 0) AS input_cache_miss_tokens,
                  COALESCE(SUM(CASE WHEN usage_estimated = 1 THEN 1 ELSE 0 END), 0) AS estimated_calls,
                  COALESCE(SUM(cost_cny), 0) AS cost_cny
             FROM token_logs
            WHERE course_id = ?`,
        ).get(ctx.courseId) ?? {
          calls: 0,
          input_tokens: 0,
          output_tokens: 0,
          input_cache_hit_tokens: 0,
          input_cache_miss_tokens: 0,
          estimated_calls: 0,
          cost_cny: 0,
        };
        const models = db.prepare<[string], UsageModelRow>(
          `SELECT provider, model, COUNT(*) AS calls,
                  COALESCE(SUM(input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(input_cache_hit_tokens), 0) AS input_cache_hit_tokens,
                  COALESCE(SUM(input_cache_miss_tokens), 0) AS input_cache_miss_tokens,
                  COALESCE(SUM(CASE WHEN usage_estimated = 1 THEN 1 ELSE 0 END), 0) AS estimated_calls,
                  COALESCE(SUM(cost_cny), 0) AS cost_cny
             FROM token_logs
            WHERE course_id = ?
            GROUP BY provider, model
            ORDER BY (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0)) DESC
            LIMIT 5`,
        ).all(ctx.courseId);
        const thread = ctx.threadId
          ? db.prepare<[string], { messages: number; tokens: number }>(
              `SELECT COUNT(*) AS messages, COALESCE(SUM(token_count), 0) AS tokens
                 FROM messages
                WHERE thread_id = ?`,
            ).get(ctx.threadId)
          : null;
        const compressed = ctx.threadId
          ? db.prepare<[string], { checkpoints: number; token_before: number; token_after: number }>(
              `SELECT COUNT(*) AS checkpoints,
                      COALESCE(SUM(token_before), 0) AS token_before,
                      COALESCE(SUM(token_after), 0) AS token_after
                FROM chat_context_collapses
               WHERE thread_id = ?`,
            ).get(ctx.threadId)
          : null;
        const snapshot = ctx.threadId
          ? db.prepare<[string], ContextSnapshotRow>(
              `SELECT context_window, estimated_total_tokens, estimated_input_tokens,
                      projected_tokens, risk_level
                 FROM chat_context_snapshots
                WHERE thread_id = ?
                ORDER BY created_at DESC
                LIMIT 1`,
            ).get(ctx.threadId)
          : null;
        const totalTokens = total.input_tokens + total.output_tokens;
        const cacheLine = total.input_cache_hit_tokens > 0 || total.input_cache_miss_tokens > 0
          ? `输入缓存：命中 ${total.input_cache_hit_tokens.toLocaleString()} / 未命中 ${total.input_cache_miss_tokens.toLocaleString()} tokens。`
          : null;
        const lines = [
          '## Token 用量',
          `API 用量账本：${totalTokens.toLocaleString()} tokens（输入 ${total.input_tokens.toLocaleString()} / 输出 ${total.output_tokens.toLocaleString()}），约 ¥${total.cost_cny.toFixed(4)}，${total.calls} 次模型调用。`,
        ];
        if (cacheLine) lines.push(cacheLine);
        if (total.estimated_calls > 0) {
          lines.push(`其中 ${total.estimated_calls} 次为本地估算：供应商流式响应没有返回 usage 时，会用本轮实际上下文和输出文本补账。`);
        }
        if (thread) {
          lines.push(`当前对话：${thread.messages} 条消息，历史正文约 ${thread.tokens.toLocaleString()} tokens。`);
        }
        if (snapshot && snapshot.context_window > 0) {
          const pct = Math.round((snapshot.estimated_total_tokens / snapshot.context_window) * 1000) / 10;
          lines.push(`最近 context window 投影：${pct}%（约 ${snapshot.estimated_total_tokens.toLocaleString()} / ${snapshot.context_window.toLocaleString()} tokens）。`);
        }
        if (compressed) {
          lines.push(`上下文折叠：${compressed.checkpoints} 个 collapse/checkpoint，折叠前约 ${compressed.token_before.toLocaleString()} tokens，折叠后约 ${compressed.token_after.toLocaleString()} tokens。`);
        }
        lines.push('说明：输入框圆圈显示的是下一次请求的 context window 占用投影；这里的 API 用量账本是课程内已经完成的模型调用累计，所以两者不会相等。');
        if (models.length > 0) {
          lines.push('', '### 模型分布');
          for (const row of models) {
            const tokens = row.input_tokens + row.output_tokens;
            const estimated = row.estimated_calls > 0 ? `，估算 ${row.estimated_calls} 次` : '';
            lines.push(`- ${row.provider || 'unknown'} / ${row.model || 'unknown'}：${tokens.toLocaleString()} tokens，¥${row.cost_cny.toFixed(4)}，${row.calls} 次${estimated}`);
          }
        }
        return lines.join('\n');
      } catch {
        return '暂时无法读取 token 用量统计。';
      }
    },
  },
  {
    name:        'compact',
    description: '手动压缩当前对话上下文',
    type:        'local',
    source:      'builtin',
    handler: () => '请在当前对话中发送 /compact，可追加压缩指令，例如：/compact 保留我对学习目标的纠正。',
  },
  {
    name:        'context',
    description: '查看当前对话投影视图和 token 风险',
    type:        'local',
    source:      'builtin',
    handler: () => '请在当前对话中发送 /context，系统会显示当前 context projection 状态。',
  },
  {
    name:        'force-snip',
    description: '不调用模型，强制折叠旧上下文',
    type:        'local',
    source:      'builtin',
    handler: () => '请在当前对话中发送 /force-snip，系统会用非 LLM 方式强制折叠旧上下文。',
  },
  {
    name:        'hint',
    description: '给出当前练习题的提示（不直接给出答案）',
    type:        'prompt',
    source:      'builtin',
    handler: (args) =>
      `请给出以下问题的思考提示，不要直接给出答案，引导我独立思考：${args || '当前练习题'}`,
  },
];

// ── User custom commands (file-based) ─────────────────────────────────────────

function userCommandsPath(): string {
  return path.join(app.getPath('userData'), 'ulyzer-commands.json');
}

interface UserCommandDef {
  name:        string;
  description: string;
  type:        'prompt' | 'local';
  template:    string;
}

function loadUserCommands(): Command[] {
  try {
    const raw  = fs.readFileSync(userCommandsPath(), 'utf8');
    const defs = JSON.parse(raw) as UserCommandDef[];
    return defs.map((d) => ({
      name:        d.name,
      description: d.description,
      type:        d.type,
      source:      'user' as const,
      handler: (args: string) =>
        d.template.replace(/\$\{args\}/g, args).replace(/\$\{input\}/g, args),
    }));
  } catch {
    return [];
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────

function dedup(commands: Command[]): Command[] {
  const map = new Map<string, Command>();
  for (const c of commands) map.set(c.name, c);
  return [...map.values()];
}

/** Returns all available commands (builtin + user, user overrides builtin). */
export function getAllCommands(): Command[] {
  return dedup([...builtinCommands, ...loadUserCommands()]);
}

/**
 * Resolve a slash command string (e.g. "/explain React hooks") to a Command.
 * Returns null if the command is not found.
 *
 * @param input  Raw user input, e.g. "/explain React hooks"
 */
export function resolveCommand(input: string): { command: Command; args: string } | null {
  if (!input.startsWith('/')) return null;
  const [rawName, ...rest] = input.slice(1).split(' ');
  const name = rawName.toLowerCase();
  const args = rest.join(' ');
  const command = getAllCommands().find((c) => c.name === name);
  if (!command) return null;
  return { command, args };
}

/** Returns true if the input string looks like a slash command. */
export function isCommand(input: string): boolean {
  return /^\/\w/.test(input.trimStart());
}
