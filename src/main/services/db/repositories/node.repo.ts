import { randomUUID } from 'crypto';
import { getDb } from '../sqlite';
import type {
  DagNode,
  DagEdge,
  NodeType,
  NodeStatus,
  Difficulty,
  BloomTarget,
  LearningType,
  NodePriority,
  RequiredCost,
  CreateNodeDto,
} from '@shared/types';

// ── Row types (SQLite returns strings for JSON columns) ───────────────────────

interface DagNodeRow {
  id: string;
  course_id: string;
  chapter: string;
  chapter_order: number;
  name: string;
  description: string | null;
  node_type: string;
  status: string;
  hours_est: number;
  difficulty: string;
  prerequisites: string;
  required_tools: string;
  required_cost: string;
  position_x: number;
  position_y: number;
  bloom_target: string | null;
  learning_type: string | null;
  priority: string | null;
  created_at: string;
  updated_at: string;
}

interface DagEdgeRow {
  id: string;
  course_id: string;
  source_node_id: string;
  target_node_id: string;
  created_at: string;
}

function rowToNode(row: DagNodeRow): DagNode {
  return {
    ...row,
    node_type:    row.node_type    as NodeType,
    status:       row.status       as NodeStatus,
    difficulty:   row.difficulty   as Difficulty,
    bloom_target: (row.bloom_target  ?? null) as BloomTarget | null,
    learning_type:(row.learning_type ?? null) as LearningType | null,
    priority:     (row.priority      ?? null) as NodePriority | null,
    prerequisites: JSON.parse(row.prerequisites) as string[],
    required_tools: JSON.parse(row.required_tools) as string[],
    required_cost: JSON.parse(row.required_cost) as RequiredCost,
  };
}

// ── NodeRepository ────────────────────────────────────────────────────────────

export class NodeRepository {
  findByCourse(courseId: string): DagNode[] {
    const rows = getDb()
      .prepare<[string], DagNodeRow>(
        'SELECT * FROM dag_nodes WHERE course_id = ? ORDER BY chapter_order ASC'
      )
      .all(courseId);
    return rows.map(rowToNode);
  }

  findById(id: string): DagNode | null {
    const row = getDb()
      .prepare<[string], DagNodeRow>('SELECT * FROM dag_nodes WHERE id = ?')
      .get(id);
    return row ? rowToNode(row) : null;
  }

  create(data: CreateNodeDto): DagNode {
    const id = data.id ?? randomUUID();
    getDb()
      .prepare(
        `INSERT INTO dag_nodes (
           id, course_id, chapter, chapter_order, name, description,
           node_type, status, hours_est, difficulty,
           prerequisites, required_tools, required_cost,
           position_x, position_y,
           bloom_target, learning_type, priority
         ) VALUES (
           @id, @course_id, @chapter, @chapter_order, @name, @description,
           @node_type, @status, @hours_est, @difficulty,
           @prerequisites, @required_tools, @required_cost,
           @position_x, @position_y,
           @bloom_target, @learning_type, @priority
         )`
      )
      .run({
        id,
        course_id:      data.course_id,
        chapter:        data.chapter,
        chapter_order:  data.chapter_order ?? 0,
        name:           data.name,
        description:    data.description ?? null,
        node_type:      data.node_type ?? 'main',
        status:         data.status ?? 'locked',
        hours_est:      data.hours_est ?? 1.0,
        difficulty:     data.difficulty ?? 'beginner',
        prerequisites:  JSON.stringify(data.prerequisites ?? []),
        required_tools: JSON.stringify(data.required_tools ?? []),
        required_cost:  JSON.stringify(data.required_cost ?? {}),
        position_x:     data.position_x ?? 0,
        position_y:     data.position_y ?? 0,
        bloom_target:   data.bloom_target  ?? null,
        learning_type:  data.learning_type ?? null,
        priority:       data.priority      ?? null,
      });
    return this.findById(id)!;
  }

  update(id: string, data: Partial<Omit<DagNode, 'id' | 'created_at'>>): DagNode {
    const existing = this.findById(id);
    if (!existing) throw new Error(`DagNode not found: ${id}`);

    const merged = { ...existing, ...data };
    getDb()
      .prepare(
        `UPDATE dag_nodes SET
           chapter = @chapter,
           chapter_order = @chapter_order,
           name = @name,
           description = @description,
           node_type = @node_type,
           status = @status,
           hours_est = @hours_est,
           difficulty = @difficulty,
           prerequisites = @prerequisites,
           required_tools = @required_tools,
           required_cost = @required_cost,
           position_x = @position_x,
           position_y = @position_y,
           bloom_target = @bloom_target,
           learning_type = @learning_type,
           priority = @priority,
           updated_at = datetime('now')
         WHERE id = @id`
      )
      .run({
        id,
        chapter:        merged.chapter,
        chapter_order:  merged.chapter_order,
        name:           merged.name,
        description:    merged.description,
        node_type:      merged.node_type,
        status:         merged.status,
        hours_est:      merged.hours_est,
        difficulty:     merged.difficulty,
        prerequisites:  JSON.stringify(merged.prerequisites),
        required_tools: JSON.stringify(merged.required_tools),
        required_cost:  JSON.stringify(merged.required_cost),
        position_x:     merged.position_x,
        position_y:     merged.position_y,
        bloom_target:   merged.bloom_target  ?? null,
        learning_type:  merged.learning_type ?? null,
        priority:       merged.priority      ?? null,
      });
    return this.findById(id)!;
  }

  updateStatus(id: string, status: NodeStatus): void {
    getDb()
      .prepare(
        `UPDATE dag_nodes SET status = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(status, id);
  }

  delete(id: string): void {
    getDb().prepare('DELETE FROM dag_nodes WHERE id = ?').run(id);
  }
}

// ── EdgeRepository ────────────────────────────────────────────────────────────

export class EdgeRepository {
  findByCourse(courseId: string): DagEdge[] {
    return getDb()
      .prepare<[string], DagEdgeRow>(
        'SELECT * FROM dag_edges WHERE course_id = ?'
      )
      .all(courseId);
  }

  /** Replace all edges for a course in one transaction */
  saveAll(courseId: string, edges: Array<Omit<DagEdge, 'created_at'>>): void {
    const db = getDb();
    const deleteStmt = db.prepare('DELETE FROM dag_edges WHERE course_id = ?');
    const insertStmt = db.prepare(
      `INSERT INTO dag_edges (id, course_id, source_node_id, target_node_id)
       VALUES (@id, @course_id, @source_node_id, @target_node_id)`
    );

    db.transaction(() => {
      deleteStmt.run(courseId);
      for (const edge of edges) {
        insertStmt.run({
          id: edge.id ?? randomUUID(),
          course_id: courseId,
          source_node_id: edge.source_node_id,
          target_node_id: edge.target_node_id,
        });
      }
    })();
  }

  delete(id: string): void {
    getDb().prepare('DELETE FROM dag_edges WHERE id = ?').run(id);
  }
}
