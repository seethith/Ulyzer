/**
 * TokenBudget — tracks cumulative token usage within a single agent loop run.
 *
 * When usage exceeds 85% of the limit, the loop should call compressHistory()
 * to fold old messages, preventing context-window overflow on long sessions.
 *
 * Default limit (180 000) comfortably fits within claude-sonnet's 200k window
 * while leaving room for the final assistant response.
 */

export interface TokenBudget {
  used:  number;
  limit: number;
  /** Ratio of used / limit, 0–1 */
  percentUsed(): number;
  /** True when usage has crossed the Microcompact trigger threshold (85%) */
  shouldCompress(): boolean;
  /** True when usage has crossed the Context Collapse threshold (90%) */
  shouldCollapse(): boolean;
  /** Add input + output tokens from one LLM call */
  add(inputTokens: number, outputTokens: number): void;
  /** Reset usage counter after a context collapse so compression doesn't trigger immediately again */
  reset(): void;
}

export function createBudget(limit = 180_000): TokenBudget {
  return {
    used:  0,
    limit,
    percentUsed()      { return this.used / this.limit; },
    shouldCompress()   { return this.percentUsed() > 0.85; },
    shouldCollapse()   { return this.percentUsed() > 0.90; },
    add(input, output) { this.used += input + output; },
    reset()            { this.used = 0; },
  };
}
