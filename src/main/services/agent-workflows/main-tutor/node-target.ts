import type { NodeTarget } from './types';

/**
 * Derive a target node range from the persisted course profile.
 *
 * The route workflow no longer has a separate ability-spec preprocessing pass.
 * User goals and constraints enter through the chat loop/profile tools, then this
 * helper converts the saved profile into a conservative roadmap size target.
 */
export function computeNodeTarget(
  timeBudget: string | null | undefined,
  knownTopicsText: string | null | undefined,
): NodeTarget {
  let base = 25;

  if (timeBudget) {
    const tb = timeBudget.toLowerCase();
    if (/[1-9]\s*天|[1-2]\s*周|\b[1-2]\s*(day|week)/.test(tb)) {
      base = Math.min(base, 10);
    } else if (/[3-9]\s*个?月|半年|一年|[1-9]\s*年|\b[3-9]\s*month/.test(tb)) {
      base = Math.max(base, 25);
    }
  }

  const knownCount = knownTopicsText
    ? knownTopicsText.split(/[,，\n]/).filter((s) => s.trim()).length
    : 0;
  const discount = Math.min(0.30, knownCount * 0.05);
  base = Math.round(base * (1 - discount));

  const total    = Math.max(5, Math.min(60, base));
  const chapters = Math.max(2, Math.min(12, Math.ceil(total / 5)));

  const label =
    total <= 10 ? `速览型（${total} 节点）` :
    total <= 25 ? `掌握型（${total} 节点）` :
                  `系统型（${total} 节点）`;

  return {
    min:      Math.max(5, total - 10),
    max:      total + 10,
    chapters: `${chapters}-${Math.min(12, chapters + 2)}`,
    label,
  };
}
