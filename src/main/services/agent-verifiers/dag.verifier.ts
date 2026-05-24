import type { DagEdge, DagNode } from '@shared/types';
import { fail, pass, type VerificationResult } from './types';

export interface DagVerifierNode {
  id: string;
  name?: string;
}

export interface DagVerifierEdge {
  source?: string;
  target?: string;
  source_node_id?: string;
  target_node_id?: string;
}

function edgeSource(edge: DagVerifierEdge): string {
  return edge.source_node_id ?? edge.source ?? '';
}

function edgeTarget(edge: DagVerifierEdge): string {
  return edge.target_node_id ?? edge.target ?? '';
}

export function verifyDagAcyclic(
  nodes: DagVerifierNode[],
  edges: DagVerifierEdge[],
): VerificationResult {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  for (const edge of edges) {
    const source = edgeSource(edge);
    const target = edgeTarget(edge);
    if (!nodeIds.has(source) || !nodeIds.has(target)) {
      return fail('dagAcyclic', [{
        code: 'dag.edge_unknown_node',
        severity: 'error',
        message: `Edge references an unknown node: ${source} -> ${target}`,
        details: { source, target },
      }]);
    }
    adjacency.get(source)?.push(target);
    inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited++;
    for (const neighbor of adjacency.get(current) ?? []) {
      const nextDegree = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, nextDegree);
      if (nextDegree === 0) queue.push(neighbor);
    }
  }

  if (visited !== nodes.length) {
    const cyclicNodeIds = [...inDegree.entries()]
      .filter(([, degree]) => degree > 0)
      .map(([id]) => id);
    return fail('dagAcyclic', [{
      code: 'dag.cycle_detected',
      severity: 'error',
      message: 'DAG contains a cycle.',
      details: { cyclicNodeIds },
    }]);
  }

  return pass('dagAcyclic');
}

export function assertDagAcyclic(
  nodes: DagVerifierNode[],
  edges: DagVerifierEdge[],
  message = 'DAG 存在循环依赖（图中有环），请重新生成',
): void {
  const result = verifyDagAcyclic(nodes, edges);
  if (!result.passed) throw new Error(message);
}

function tokenizeGoal(text: string): string[] {
  const ascii = text.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]{2,}/g) ?? [];
  const cjk = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  return [...new Set([...ascii, ...cjk])].filter((token) =>
    !['学习', '掌握', '理解', '课程', '基础', '系统', '能力', '知识'].includes(token),
  );
}

export function verifyDagGoalCoverage(
  nodes: Pick<DagNode, 'name' | 'description'>[],
  goalText: string | undefined,
): VerificationResult {
  const goalTokens = tokenizeGoal(goalText ?? '');
  if (goalTokens.length === 0) {
    return pass('dagGoalCoverage', [{
      code: 'dag.goal_missing',
      severity: 'warning',
      message: 'No explicit goal text was available for deterministic coverage checking.',
    }]);
  }

  const routeText = nodes
    .map((node) => `${node.name} ${node.description ?? ''}`)
    .join('\n')
    .toLowerCase();
  const covered = goalTokens.filter((token) => routeText.includes(token.toLowerCase()));
  const ratio = covered.length / goalTokens.length;

  if (ratio < 0.3) {
    return fail('dagGoalCoverage', [{
      code: 'dag.goal_coverage_low',
      severity: 'error',
      message: 'Route nodes appear weakly aligned with the stated goal.',
      details: { covered, goalTokens, ratio },
    }]);
  }

  return pass('dagGoalCoverage', ratio < 0.6
    ? [{
        code: 'dag.goal_coverage_partial',
        severity: 'warning',
        message: 'Route goal coverage is partial; review node naming and descriptions.',
        details: { covered, goalTokens, ratio },
      }]
    : []);
}

export type { DagEdge, DagNode };
