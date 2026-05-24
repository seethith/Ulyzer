import { localMsg } from '../agent-i18n/messages';
import type { AgentTool } from './types';

/**
 * Minimal, conservative validation of model-generated tool input against the
 * tool's declared JSON schema. Tools are wrapped without Zod enforcement
 * (see fromToolModule), so before this the model could send a call missing a
 * required argument and the tool would fail deep inside with an opaque error.
 *
 * We only flag the two highest-value, lowest-false-positive problems:
 *  - a declared `required` property is absent
 *  - a present property violates a declared `enum` (compared leniently so a
 *    number-vs-string representation never trips it)
 *
 * Extra/unknown properties and looser type mismatches are intentionally allowed
 * through — tools may coerce them, and rejecting them risks breaking flows that
 * previously worked. On failure we return a structured error the model can fix.
 */

interface JsonSchemaShape {
  required?: unknown;
  properties?: Record<string, { enum?: unknown } | undefined>;
}

export interface ToolInputValidation {
  ok: boolean;
  message?: string;
}

export function validateToolInput(
  tool: AgentTool<unknown>,
  input: Record<string, unknown>,
  language?: string,
): ToolInputValidation {
  const schema = tool.inputSchema as JsonSchemaShape;
  const problems: string[] = [];

  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
  for (const key of required) {
    if (input[key] === undefined || input[key] === null) {
      problems.push(localMsg(language, `缺少必填参数 "${key}"`, `missing required parameter "${key}"`));
    }
  }

  const properties = schema.properties ?? {};
  for (const [key, spec] of Object.entries(properties)) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    const allowed = spec?.enum;
    if (Array.isArray(allowed) && allowed.length > 0) {
      const matches = allowed.some((option) => option === value || String(option) === String(value));
      if (!matches) {
        problems.push(localMsg(
          language,
          `参数 "${key}" 取值无效，应为 ${JSON.stringify(allowed)} 之一`,
          `invalid value for "${key}"; expected one of ${JSON.stringify(allowed)}`,
        ));
      }
    }
  }

  if (problems.length === 0) return { ok: true };
  return {
    ok: false,
    message: localMsg(
      language,
      `工具 ${tool.name} 输入参数校验失败：${problems.join('；')}。请修正参数后重新调用。`,
      `Input validation failed for tool ${tool.name}: ${problems.join('; ')}. Fix the arguments and call again.`,
    ),
  };
}
