import { LLMAdapter } from '../llm/adapter';
import type { LLMProvider, LLMMessage } from '@shared/types';

export interface ClarifyResult {
  needsClarification: boolean;
  questions: string[];
}

const CLARIFY_SYSTEM_PROMPT = `你是一个学习助手的意图分析层。判断用户输入是否足够明确，以便制定具体的学习计划或回答问题。

只返回 JSON（不加代码块包裹）：
- 需要澄清：{"needsClarification": true, "questions": ["具体问题1", "具体问题2"]}
- 足够清晰：{"needsClarification": false, "questions": []}

判断标准（宁可假设合理默认值，不要过度澄清）：

需要澄清的情况：
- 主题极其模糊，完全看不出方向（如只说"学点东西""提升自己"）
- 目标词汇过于宽泛无法拆解（如仅说"编程"而无任何限定）

不需要澄清的情况：
- 有具体技术/科目名称（如"React"、"游泳"、"英语口语"）
- 有具体的疑惑或错误信息
- 是对话中的追问、补充或短句
- 已有时间/背景约束，哪怕目标不完整
- 单纯问候或寒暄

澄清问题要精准有用，最多 2 个，每个不超过 25 字。`;

/**
 * Analyze whether the user's input is ambiguous enough to warrant clarification.
 *
 * This is a lightweight LLM call (max 150 tokens, temperature 0.1).
 * All failures default to "no clarification needed" — it must never block the user.
 */
export async function analyzeIntent(
  userMessage: string,
  history: LLMMessage[],
  provider: LLMProvider,
  model: string,
  signal?: AbortSignal
): Promise<ClarifyResult> {
  const noClarity: ClarifyResult = { needsClarification: false, questions: [] };

  // Fast-path skip: too short to be ambiguous, or has enough history context
  if (userMessage.trim().length < 5 || history.length >= 3) return noClarity;

  let fullResponse = '';
  let errored = false;

  try {
    await LLMAdapter.stream({
      provider,
      model,
      systemPrompt: CLARIFY_SYSTEM_PROMPT,
      messages: [
        ...history.slice(-4),
        { role: 'user', content: userMessage },
      ],
      maxTokens: 150,
      temperature: 0.1,
      signal,
      onChunk: (c) => { fullResponse += c; },
      onComplete: () => {},
      onError: () => { errored = true; },
    });
  } catch {
    errored = true;
  }

  if (errored || !fullResponse) return noClarity;

  try {
    const match = fullResponse.match(/\{[\s\S]*\}/);
    if (!match) return noClarity;
    const parsed = JSON.parse(match[0]) as ClarifyResult;
    return {
      needsClarification: !!parsed.needsClarification,
      questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, 2) : [],
    };
  } catch {
    return noClarity;
  }
}
