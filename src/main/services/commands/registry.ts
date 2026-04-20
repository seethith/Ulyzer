/**
 * Command registry for Ulyzer chat.
 *
 * Three command types (mirroring Claude Code's pattern):
 *   prompt  — expands to a system prompt injection; goes to the LLM
 *   local   — executes locally and returns a string; does NOT go to the LLM
 *   action  — triggers a named action (e.g. generate_material) in the orchestrator
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

const nodeRepo = new NodeRepository();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CommandContext {
  courseId: string;
  nodeId?:  string;
}

export type CommandType = 'prompt' | 'local' | 'action';

export interface Command {
  /** Command name without the leading /  */
  name:        string;
  description: string;
  type:        CommandType;
  source:      'builtin' | 'user';
  /** Returns a string (prompt injection or local result) or an action descriptor */
  handler: (args: string, ctx: CommandContext) => string | ActionDescriptor;
}

export interface ActionDescriptor {
  action:       string;
  [key: string]: unknown;
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
    type:        'action',
    source:      'builtin',
    handler: (_args, ctx) => ({
      action:       'generate_material',
      targetFolder: 'practice',
      nodeId:       ctx.nodeId,
    }),
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
