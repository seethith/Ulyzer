/**
 * node-sizing — KC granularity heuristics and quiz question count computation.
 *
 * Callers:
 *   - material/material-generation-loop.ts (v1 outline KC range in prompt)
 *   - outline-version.ts (v2/v3 advisory granularity)
 *   - generate-quiz.tool.ts (default quiz question count)
 */
import * as fs from 'fs';
import type { DagNode } from '@shared/types';
import { getLatestOutlinePath } from '../fs/content.service';

// ── KC count range for outline generation ────────────────────────────────────

/**
 * Compute a soft KC count range for v1 outline generation.
 *
 * This is deliberately not a hard validation rule. The model may choose fewer
 * or more KCs when the node task warrants it, but should explain the granularity
 * when it goes outside the guidance band.
 */
export function computeKcRange(
  node: Pick<DagNode, 'node_type' | 'bloom_target' | 'learning_type'>,
): { min: number; max: number } {
  // Base guidance from the node's cognitive endpoint.
  let [min, max]: [number, number] =
    node.bloom_target === 'remember_understand' ? [4, 7] :
    node.bloom_target === 'analyze_evaluate'    ? [5, 9] :
    node.bloom_target === 'create'              ? [3, 6] :
                                                  [5, 8]; // apply / default

  // node_type: boss nodes require comprehensive KC coverage
  if (node.node_type === 'boss') { min += 2; max += 3; }

  // learning_type: verbal_info (concepts/facts) tends to have more enumerable KCs;
  // motor_skill has fewer discrete KCs (the complexity is inside each procedure)
  if (node.learning_type === 'verbal_info') { max += 1; }
  if (node.learning_type === 'motor_skill') { min -= 1; max -= 1; }

  return { min: Math.max(3, min), max: Math.max(min + 2, Math.min(18, max)) };
}

export function formatKcCountGuidance(
  _range: { min: number; max: number },
  language?: string,
): string {
  return language === 'en'
    ? 'Choose the KC count needed to complete the node goal. Do not pad to a quota; split only when a concept needs separate evidence or practice, and merge items that would create repetitive materials.'
    : '按完成节点目标所需自行决定 KC 数量。不要为了配额凑数；只有当概念需要独立证据或独立练习时才拆分，容易造成资料重复的项目要合并。';
}

// ── KC count parsing from saved outline ──────────────────────────────────────

/** Parse the number of KC entries from the latest saved outline file. Returns 0 if unavailable. */
export function readKcCountFromOutline(courseId: string, nodeId: string): number {
  const outlinePath = getLatestOutlinePath(courseId, nodeId);
  if (!outlinePath) return 0;
  try {
    const text = fs.readFileSync(outlinePath, 'utf-8');
    const matches = text.match(/^### KC\d+:/mg);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

// ── Quiz question count ───────────────────────────────────────────────────────

/**
 * Compute the recommended practice question count for a node.
 *
 * Base: one question per KC (ensures every KC is exercised).
 * Fallback when outline not yet saved: use a fixed minimum.
 * Multipliers adjust for how much practice each node type/cognitive endpoint warrants.
 */
export function computeQuizCount(
  kcCount: number,
  node: Pick<DagNode, 'bloom_target' | 'node_type' | 'priority'>,
): number {
  const base = Math.max(4, kcCount > 0 ? kcCount : 5);

  // apply contexts need more repetition; create contexts need fewer but deeper questions
  const bloomMult: Record<string, number> = {
    remember_understand: 0.9,
    analyze_evaluate:    1.0,
    apply:               1.3,
    create:              0.8,
  };

  // boss nodes warrant more questions; main nodes get standard coverage
  const typeMult: Record<string, number> = {
    boss: 1.3,
    main: 1.0,
  };

  // must-learn nodes get full coverage; nice-to-have nodes get lighter treatment
  const priorityMult: Record<string, number> = {
    must:         1.0,
    should:       0.85,
    nice_to_have: 0.70,
  };

  const bloom    = bloomMult[node.bloom_target ?? 'apply']     ?? 1.0;
  const type     = typeMult[node.node_type ?? 'main']          ?? 1.0;
  const priority = priorityMult[node.priority ?? 'must']       ?? 1.0;

  return Math.max(4, Math.min(16, Math.round(base * bloom * type * priority)));
}
