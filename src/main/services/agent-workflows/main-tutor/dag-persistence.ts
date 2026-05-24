import { randomUUID } from 'crypto';
import type {
  Course,
  BloomTarget,
  CreateNodeDto,
  DagEdge,
  DagGraph,
  DagNode,
  Difficulty,
  LearningType,
  NodePriority,
  NodeType,
} from '@shared/types';
import { getDb } from '../../db/sqlite';
import type { LlmDagOutput, LlmNode } from './types';
import { NodeHandoffRepository } from '../../db/repositories/node-handoff.repo';
import { recomputeCourseDagProgress } from '../../dag/dag-progress';

export interface DagNodeRepositoryPort {
  create(data: CreateNodeDto): DagNode;
  findByCourse(courseId: string): DagNode[];
  updateStatus(id: string, status: 'available'): void;
}

export interface DagEdgeRepositoryPort {
  findByCourse(courseId: string): DagEdge[];
  saveAll(courseId: string, edges: Array<Omit<DagEdge, 'created_at'>>): void;
}

export class DagPersistence {
  constructor(
    private readonly nodeRepo: DagNodeRepositoryPort,
    private readonly edgeRepo: DagEdgeRepositoryPort,
    private readonly handoffRepo?: NodeHandoffRepository,
    private readonly courseRepo?: { findById(id: string): Course | null },
  ) {}

  save(courseId: string, data: LlmDagOutput): DagGraph {
    const positions = computePositions(data.nodes);

    const seenAiIds = new Set<string>();
    const uniqueNodes = data.nodes.filter((n) => {
      if (seenAiIds.has(n.id)) return false;
      seenAiIds.add(n.id);
      return true;
    });

    const idMap = new Map<string, string>();
    for (const n of uniqueNodes) {
      idMap.set(n.id, randomUUID());
    }

    const db = getDb();
    db.prepare('DELETE FROM dag_nodes WHERE course_id = ?').run(courseId);

    const savedNodes: DagNode[] = [];
    const course = this.courseRepo?.findById(courseId) ?? null;
    for (const lNode of uniqueNodes) {
      const realId = idMap.get(lNode.id)!;
      const pos = positions.get(lNode.id) ?? { x: 0, y: 0 };
      const dto: CreateNodeDto = {
        id: realId,
        course_id: courseId,
        chapter: lNode.chapter,
        chapter_order: lNode.chapter_order ?? 0,
        name: lNode.name,
        description: lNode.description,
        node_type: (lNode.node_type as NodeType) ?? 'main',
        status: 'locked',
        difficulty: (lNode.difficulty as Difficulty) ?? 'beginner',
        prerequisites: (lNode.prerequisites ?? []).filter((pid) => idMap.has(pid)),
        required_tools: lNode.required_tools ?? [],
        required_cost: {},
        position_x: pos.x,
        position_y: pos.y,
        bloom_target:  (lNode.bloom_target  as BloomTarget  | undefined) ?? undefined,
        learning_type: (lNode.learning_type as LearningType | undefined) ?? undefined,
        priority:      (lNode.priority      as NodePriority | undefined) ?? undefined,
        source_ids:    normalizeSourceIds(lNode),
        rationale:     lNode.rationale,
      };
      const savedNode = this.nodeRepo.create(dto);
      savedNodes.push(savedNode);
      this.handoffRepo?.syncFromNode(savedNode, course);
    }

    const edgeDtos = data.edges
      .filter((e) => idMap.has(e.source) && idMap.has(e.target))
      .map((e) => ({
        id: randomUUID(),
        course_id: courseId,
        source_node_id: idMap.get(e.source)!,
        target_node_id: idMap.get(e.target)!,
        created_at: new Date().toISOString(),
      }));
    this.edgeRepo.saveAll(courseId, edgeDtos);
    recomputeCourseDagProgress(courseId);

    db.prepare(
      `UPDATE courses SET
         total_nodes = (SELECT COUNT(*) FROM dag_nodes WHERE course_id = ?),
         done_nodes  = (SELECT COUNT(*) FROM dag_nodes WHERE course_id = ? AND status = 'done'),
         updated_at  = datetime('now')
       WHERE id = ?`
    ).run(courseId, courseId, courseId);

    return {
      nodes: this.nodeRepo.findByCourse(courseId),
      edges: this.edgeRepo.findByCourse(courseId),
    };
  }

  /**
   * Append new chapters/nodes to an existing route without deleting anything.
   * Used for open-ended route extension (vertical deepening or horizontal expansion).
   * New nodes' `entry_point` prerequisites resolve to `entryPointOverride` when provided
   * (used for vertical deepening into a specific chapter), otherwise to the global tail boss.
   */
  append(courseId: string, data: LlmDagOutput, entryPointOverride?: string): DagGraph {
    const existingNodes = this.nodeRepo.findByCourse(courseId);
    const existingEdges = this.edgeRepo.findByCourse(courseId);

    const outgoing = new Set(existingEdges.map((e) => e.source_node_id));
    // Use the explicitly provided entry point (vertical deepening) or fall back to global tail boss.
    const tailNode = entryPointOverride
      ? existingNodes.find((n) => n.id === entryPointOverride)
      : ([...existingNodes].reverse().find((n) => !outgoing.has(n.id) && n.node_type === 'boss') ??
         [...existingNodes].reverse().find((n) => !outgoing.has(n.id)));

    const seenAiIds = new Set<string>();
    const uniqueNewNodes = data.nodes.filter((n) => {
      if (seenAiIds.has(n.id)) return false;
      seenAiIds.add(n.id);
      return true;
    });

    const idMap = new Map<string, string>();
    for (const n of uniqueNewNodes) idMap.set(n.id, randomUUID());

    const existingChapters = [...new Set(existingNodes.map((n) => n.chapter))];
    const positions = computeAppendPositions(uniqueNewNodes, existingChapters);

    const course = this.courseRepo?.findById(courseId) ?? null;
    for (const lNode of uniqueNewNodes) {
      const realId = idMap.get(lNode.id)!;
      const pos = positions.get(lNode.id) ?? { x: 0, y: 0 };
      const resolvedPrereqs = (lNode.prerequisites ?? []).flatMap((pid) => {
        if (pid === 'entry_point') return tailNode ? [tailNode.id] : [];
        return idMap.has(pid) ? [idMap.get(pid)!] : [];
      });
      const dto: CreateNodeDto = {
        id: realId,
        course_id: courseId,
        chapter: lNode.chapter,
        chapter_order: lNode.chapter_order ?? 0,
        name: lNode.name,
        description: lNode.description,
        node_type: (lNode.node_type as NodeType) ?? 'main',
        status: 'locked',
        difficulty: (lNode.difficulty as Difficulty) ?? 'beginner',
        prerequisites: resolvedPrereqs,
        required_tools: lNode.required_tools ?? [],
        required_cost: {},
        position_x: pos.x,
        position_y: pos.y,
        bloom_target:  (lNode.bloom_target  as BloomTarget  | undefined) ?? undefined,
        learning_type: (lNode.learning_type as LearningType | undefined) ?? undefined,
        priority:      (lNode.priority      as NodePriority | undefined) ?? undefined,
        source_ids:    normalizeSourceIds(lNode),
        rationale:     lNode.rationale,
      };
      const savedNode = this.nodeRepo.create(dto);
      this.handoffRepo?.syncFromNode(savedNode, course);
    }

    // New entry edges: for any node referencing entry_point, add an explicit edge from tailNode.
    const entryEdgeDtos: Array<Omit<DagEdge, 'created_at'>> = [];
    if (tailNode) {
      for (const lNode of uniqueNewNodes) {
        if ((lNode.prerequisites ?? []).includes('entry_point')) {
          entryEdgeDtos.push({
            id: randomUUID(),
            course_id: courseId,
            source_node_id: tailNode.id,
            target_node_id: idMap.get(lNode.id)!,
          });
        }
      }
    }

    // Internal new edges between new nodes.
    const internalEdgeDtos: Array<Omit<DagEdge, 'created_at'>> = data.edges
      .filter((e) => idMap.has(e.source) && idMap.has(e.target))
      .map((e) => ({
        id: randomUUID(),
        course_id: courseId,
        source_node_id: idMap.get(e.source)!,
        target_node_id: idMap.get(e.target)!,
      }));

    // saveAll replaces all edges — pass existing + new combined.
    this.edgeRepo.saveAll(courseId, [...existingEdges, ...entryEdgeDtos, ...internalEdgeDtos]);
    recomputeCourseDagProgress(courseId);

    const db = getDb();
    db.prepare(
      `UPDATE courses SET
         total_nodes = (SELECT COUNT(*) FROM dag_nodes WHERE course_id = ?),
         done_nodes  = (SELECT COUNT(*) FROM dag_nodes WHERE course_id = ? AND status = 'done'),
         updated_at  = datetime('now')
       WHERE id = ?`
    ).run(courseId, courseId, courseId);

    return {
      nodes: this.nodeRepo.findByCourse(courseId),
      edges: this.edgeRepo.findByCourse(courseId),
    };
  }
}

function normalizeSourceIds(node: LlmNode): string[] {
  const ids = node.source_ids ?? node.sourceIds ?? [];
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
}

/** Compute positions for new nodes appended after existing chapters. */
function computeAppendPositions(
  newNodes: LlmNode[],
  existingChapters: string[],
): Map<string, { x: number; y: number }> {
  const CHAPTER_GAP_X = 260;
  const NODE_GAP_Y    = 130;
  const MARGIN_X      = 80;
  const MARGIN_Y      = 80;

  const newChapterOrder = new Map<string, number>();
  const newChapterNodes = new Map<string, LlmNode[]>();

  for (const node of newNodes) {
    if (!newChapterNodes.has(node.chapter)) {
      newChapterNodes.set(node.chapter, []);
      newChapterOrder.set(node.chapter, existingChapters.length + newChapterOrder.size);
    }
    newChapterNodes.get(node.chapter)!.push(node);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [chapter, chNodes] of newChapterNodes) {
    chNodes.sort((a, b) => (a.chapter_order ?? 0) - (b.chapter_order ?? 0));
    const ci = newChapterOrder.get(chapter) ?? 0;
    for (let i = 0; i < chNodes.length; i++) {
      positions.set(chNodes[i].id, {
        x: ci * CHAPTER_GAP_X + MARGIN_X,
        y: i * NODE_GAP_Y + MARGIN_Y,
      });
    }
  }
  return positions;
}

function computePositions(nodes: LlmNode[]): Map<string, { x: number; y: number }> {
  const chapterOrder = new Map<string, number>();
  const chapterNodes = new Map<string, LlmNode[]>();

  for (const node of nodes) {
    if (!chapterNodes.has(node.chapter)) {
      chapterNodes.set(node.chapter, []);
      chapterOrder.set(node.chapter, chapterOrder.size);
    }
    chapterNodes.get(node.chapter)!.push(node);
  }

  const positions = new Map<string, { x: number; y: number }>();
  const CHAPTER_GAP_X = 260;
  const NODE_GAP_Y = 130;
  const MARGIN_X = 80;
  const MARGIN_Y = 80;

  for (const [chapter, chNodes] of chapterNodes) {
    chNodes.sort((a, b) => (a.chapter_order ?? 0) - (b.chapter_order ?? 0));
    const ci = chapterOrder.get(chapter) ?? 0;
    for (let i = 0; i < chNodes.length; i++) {
      positions.set(chNodes[i].id, {
        x: ci * CHAPTER_GAP_X + MARGIN_X,
        y: i * NODE_GAP_Y + MARGIN_Y,
      });
    }
  }

  return positions;
}
