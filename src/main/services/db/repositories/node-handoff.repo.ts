import type { Course, DagNode, NodeHandoff } from '@shared/types';
import { getDb } from '../sqlite';

interface NodeHandoffRow {
  node_id: string;
  course_id: string;
  task_definition: string | null;
  scope_boundary: string | null;
  rationale: string | null;
  recommended_source_ids: string | null;
  suggested_queries: string | null;
  generation_constraints: string | null;
  coverage_requirements: string | null;
  created_at: string;
  updated_at: string;
}

function toNodeHandoff(row: NodeHandoffRow): NodeHandoff {
  return {
    nodeId: row.node_id,
    courseId: row.course_id,
    taskDefinition: row.task_definition ?? null,
    scopeBoundary: row.scope_boundary ?? null,
    rationale: row.rationale ?? null,
    recommendedSourceIds: JSON.parse(row.recommended_source_ids ?? '[]') as string[],
    suggestedQueries: JSON.parse(row.suggested_queries ?? '[]') as string[],
    generationConstraints: JSON.parse(row.generation_constraints ?? '[]') as string[],
    coverageRequirements: JSON.parse(row.coverage_requirements ?? '[]') as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || out.includes(normalized)) continue;
    out.push(normalized);
  }
  return out;
}

function buildSuggestedQueries(node: DagNode): string[] {
  const base = node.name.trim();
  const chapter = node.chapter.trim();
  return uniqueStrings([
    `${base} official documentation concepts`,
    `${base} exercises examples`,
    `${chapter} ${base} syllabus objectives`,
  ]);
}

function buildGenerationConstraints(node: DagNode, course?: Course | null): string[] {
  const constraints: Array<string | null> = [
    `难度：${node.difficulty}`,
    node.bloom_target ? `认知层级：${node.bloom_target}` : null,
    course?.time_budget ? `时间预算：${course.time_budget}` : null,
    course?.depth_preference ? `学习深度：${course.depth_preference}` : null,
  ];
  return uniqueStrings(constraints);
}

function buildCoverageRequirements(node: DagNode): string[] {
  const requirements: Array<string | null> = [];
  switch (node.bloom_target) {
    case 'remember_understand':
      requirements.push('覆盖核心定义与基本原理', '至少给出一个基础示例');
      break;
    case 'analyze_evaluate':
      requirements.push('覆盖关键比较点与判断依据', '明确常见误区或边界情况');
      break;
    case 'apply':
      requirements.push('覆盖操作步骤与练习路径', '至少给出一个可执行例子');
      break;
    case 'create':
      requirements.push('覆盖综合任务目标与交付要求', '明确评价标准或 rubric');
      break;
    default:
      requirements.push('覆盖本节点的核心概念与实践要求');
      break;
  }
  if (node.node_type === 'boss') {
    requirements.push('突出综合考核与跨知识点整合');
  }
  return uniqueStrings(requirements);
}

function buildScopeBoundary(node: DagNode): string {
  if (node.node_type === 'boss') {
    return '聚焦本章综合应用与验收，不展开后续章节的新知识。';
  }
  return '聚焦当前节点目标与前置衔接，不提前展开后续节点的延伸主题。';
}

export function buildNodeHandoffPayload(node: DagNode, course?: Course | null): Omit<NodeHandoff, 'createdAt' | 'updatedAt'> {
  return {
    nodeId: node.id,
    courseId: node.course_id,
    taskDefinition: node.description?.trim() || `${node.name}：完成当前节点的核心学习任务并衔接后续节点。`,
    scopeBoundary: buildScopeBoundary(node),
    rationale: node.rationale ?? null,
    recommendedSourceIds: [...(node.source_ids ?? [])],
    suggestedQueries: buildSuggestedQueries(node),
    generationConstraints: buildGenerationConstraints(node, course),
    coverageRequirements: buildCoverageRequirements(node),
  };
}

export class NodeHandoffRepository {
  findByNodeId(nodeId: string): NodeHandoff | null {
    const row = getDb()
      .prepare<[string], NodeHandoffRow>('SELECT * FROM node_handoffs WHERE node_id = ?')
      .get(nodeId);
    return row ? toNodeHandoff(row) : null;
  }

  upsert(input: Omit<NodeHandoff, 'createdAt' | 'updatedAt'>): NodeHandoff {
    getDb()
      .prepare(
        `INSERT INTO node_handoffs (
           node_id, course_id, task_definition, scope_boundary, rationale,
           recommended_source_ids, suggested_queries, generation_constraints, coverage_requirements
         ) VALUES (
           @node_id, @course_id, @task_definition, @scope_boundary, @rationale,
           @recommended_source_ids, @suggested_queries, @generation_constraints, @coverage_requirements
         )
         ON CONFLICT(node_id) DO UPDATE SET
           course_id = excluded.course_id,
           task_definition = excluded.task_definition,
           scope_boundary = excluded.scope_boundary,
           rationale = excluded.rationale,
           recommended_source_ids = excluded.recommended_source_ids,
           suggested_queries = excluded.suggested_queries,
           generation_constraints = excluded.generation_constraints,
           coverage_requirements = excluded.coverage_requirements,
           updated_at = datetime('now')`,
      )
      .run({
        node_id: input.nodeId,
        course_id: input.courseId,
        task_definition: input.taskDefinition,
        scope_boundary: input.scopeBoundary,
        rationale: input.rationale,
        recommended_source_ids: JSON.stringify(input.recommendedSourceIds ?? []),
        suggested_queries: JSON.stringify(input.suggestedQueries ?? []),
        generation_constraints: JSON.stringify(input.generationConstraints ?? []),
        coverage_requirements: JSON.stringify(input.coverageRequirements ?? []),
      });
    return this.findByNodeId(input.nodeId)!;
  }

  delete(nodeId: string): void {
    getDb().prepare('DELETE FROM node_handoffs WHERE node_id = ?').run(nodeId);
  }

  syncFromNode(node: DagNode, course?: Course | null): NodeHandoff {
    return this.upsert(buildNodeHandoffPayload(node, course));
  }
}
