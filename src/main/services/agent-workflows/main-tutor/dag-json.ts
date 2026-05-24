import { assertDagAcyclic } from '../../agent-verifiers/dag.verifier';
import { normalizeDagEdges } from '@shared/dag-graph';
import type { DagRepairReport, LlmEdge, LlmNode, ParsedDagOutput } from './types';

const NODE_TYPES = new Set(['main', 'boss']);
const DIFFICULTIES = new Set(['beginner', 'intermediate', 'advanced']);
const BLOOM_TARGETS = new Set(['remember_understand', 'apply', 'analyze_evaluate', 'create']);
const LEARNING_TYPES = new Set(['verbal_info', 'intellectual_skill', 'cognitive_strategy', 'motor_skill', 'attitude']);
const PRIORITIES = new Set(['must', 'should', 'nice_to_have']);

export function parseDagJson(raw: string): ParsedDagOutput {
  let text = raw.trim();

  const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    text = jsonBlockMatch[1].trim();
  }

  const firstBrace = text.indexOf('{');
  const lastBrace  = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  } else if (firstBrace > 0) {
    text = text.slice(firstBrace);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('LLM 返回的内容不是有效 JSON，请重新生成');
  }

  if (typeof data !== 'object' || data === null) {
    throw new Error('DAG 数据格式错误');
  }

  const obj = data as Record<string, unknown>;

  if (!Array.isArray(obj.nodes) || obj.nodes.length === 0) {
    throw new Error('DAG 缺少 nodes 数组');
  }

  if (!Array.isArray(obj.edges)) {
    throw new Error('DAG 缺少 edges 数组');
  }

  const repaired = repairDagStructure(obj.nodes as LlmNode[], obj.edges as LlmEdge[]);
  const nodes = repaired.nodes;
  const edges = repaired.edges;

  for (const node of nodes) {
    if (!node.id) throw new Error(`节点缺少 id 字段`);
    if (!node.name) throw new Error(`节点 ${node.id} 缺少 name 字段`);
    if (!node.chapter) throw new Error(`节点 ${node.id} 缺少 chapter 字段`);
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      throw new Error(`边引用了不存在的节点: ${edge.source}`);
    }
    if (!nodeIds.has(edge.target)) {
      throw new Error(`边引用了不存在的节点: ${edge.target}`);
    }
  }

  validateNoCycles(nodes, edges);

  return repaired;
}

export function repairDagStructure(nodes: LlmNode[], edges: LlmEdge[]): ParsedDagOutput {
  const repairReport = createRepairReport();
  const seen = new Set<string>();
  const repairedNodes: LlmNode[] = [];
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || node.id.trim().length === 0) continue;
    if (seen.has(node.id)) {
      repairReport.droppedDuplicateNodes += 1;
      continue;
    }
    seen.add(node.id);
    repairedNodes.push(normalizeNode(node, repairReport));
  }

  const originalEdgeKeys = new Set<string>();
  const candidates: Array<LlmEdge & { origin: 'edge' | 'prerequisite' }> = [];
  for (const edge of edges) {
    candidates.push({ ...edge, origin: 'edge' });
    if (edge && typeof edge.source === 'string' && typeof edge.target === 'string') {
      originalEdgeKeys.add(`${edge.source}->${edge.target}`);
    }
  }
  for (const node of repairedNodes) {
    for (const prerequisite of node.prerequisites ?? []) {
      candidates.push({ source: prerequisite, target: node.id, origin: 'prerequisite' });
    }
  }

  const structurallyValidCandidates = candidates.filter(
    (edge): edge is LlmEdge & { origin: 'edge' | 'prerequisite' } =>
      !!edge && typeof edge.source === 'string' && typeof edge.target === 'string',
  );
  const normalized = normalizeDagEdges(repairedNodes, structurallyValidCandidates, {
    getSource: (edge) => edge.source,
    getTarget: (edge) => edge.target,
  });
  repairReport.droppedUnknownEdges += normalized.report.droppedUnknownEdges;
  repairReport.droppedSelfLoops += normalized.report.droppedSelfLoops;
  repairReport.droppedDuplicateEdges += normalized.report.droppedDuplicateEdges;
  repairReport.droppedCycleEdges += normalized.report.droppedCycleEdges;
  repairReport.droppedTransitiveEdges += normalized.report.droppedTransitiveEdges;
  repairReport.addedPrerequisiteEdges += normalized.edges.filter((edge) => {
    const key = `${edge.source}->${edge.target}`;
    return edge.origin === 'prerequisite' && !originalEdgeKeys.has(key);
  }).length;

  const repairedEdges: LlmEdge[] = normalized.edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
  }));

  const prerequisitesByNode = new Map<string, string[]>();
  for (const node of repairedNodes) prerequisitesByNode.set(node.id, []);
  for (const edge of repairedEdges) prerequisitesByNode.get(edge.target)?.push(edge.source);

  return {
    nodes: repairedNodes.map((node) => ({
      ...node,
      prerequisites: prerequisitesByNode.get(node.id) ?? [],
    })),
    edges: repairedEdges,
    repairReport,
  };
}

function normalizeNode(node: LlmNode, repairReport: DagRepairReport): LlmNode {
  const sourceIds = Array.isArray(node.source_ids)
    ? node.source_ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  if (sourceIds.length > 2) repairReport.truncatedSourceIds += 1;

  const prerequisites = Array.isArray(node.prerequisites)
    ? node.prerequisites.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  if (Array.isArray(node.prerequisites) && prerequisites.length !== node.prerequisites.length) {
    repairReport.droppedInvalidPrerequisites += node.prerequisites.length - prerequisites.length;
  }

  const normalizedNodeType = NODE_TYPES.has(node.node_type ?? '') ? node.node_type : 'main';
  const normalizedDifficulty = DIFFICULTIES.has(node.difficulty ?? '') ? node.difficulty : 'beginner';
  const normalizedBloomTarget = BLOOM_TARGETS.has(node.bloom_target ?? '') ? node.bloom_target : undefined;
  const normalizedLearningType = LEARNING_TYPES.has(node.learning_type ?? '') ? node.learning_type : undefined;
  const normalizedPriority = PRIORITIES.has(node.priority ?? '') ? node.priority : undefined;

  if (node.node_type !== undefined && node.node_type !== normalizedNodeType) repairReport.normalizedFields += 1;
  if (node.difficulty !== undefined && node.difficulty !== normalizedDifficulty) repairReport.normalizedFields += 1;
  if (node.bloom_target !== undefined && node.bloom_target !== normalizedBloomTarget) repairReport.normalizedFields += 1;
  if (node.learning_type !== undefined && node.learning_type !== normalizedLearningType) repairReport.normalizedFields += 1;
  if (node.priority !== undefined && node.priority !== normalizedPriority) repairReport.normalizedFields += 1;

  const next: LlmNode = {
    ...node,
    node_type: normalizedNodeType,
    difficulty: normalizedDifficulty,
    bloom_target: normalizedBloomTarget,
    learning_type: normalizedLearningType,
    priority: normalizedPriority,
    prerequisites,
    required_tools: Array.isArray(node.required_tools)
      ? node.required_tools.filter((tool): tool is string => typeof tool === 'string' && tool.length > 0)
      : [],
    source_ids: sourceIds.slice(0, 2),
  };
  delete next.sourceIds;
  return next;
}

function createRepairReport(): DagRepairReport {
  return {
    droppedDuplicateNodes: 0,
    normalizedFields: 0,
    droppedInvalidPrerequisites: 0,
    truncatedSourceIds: 0,
    addedPrerequisiteEdges: 0,
    droppedDuplicateEdges: 0,
    droppedUnknownEdges: 0,
    droppedSelfLoops: 0,
    droppedCycleEdges: 0,
    droppedTransitiveEdges: 0,
  };
}

export function validateNoCycles(nodes: LlmNode[], edges: LlmEdge[]): void {
  assertDagAcyclic(nodes, edges, 'DAG 存在循环依赖（图中有环），请重新生成');
}
