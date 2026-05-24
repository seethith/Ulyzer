import { syncDagProgressWithChapterDependencies } from '@shared/dag-progress'
import type { DagGraph } from '@shared/types'
import { NodeRepository, EdgeRepository } from '../db/repositories/node.repo'
import { getDb } from '../db/sqlite'

const nodeRepo = new NodeRepository()
const edgeRepo = new EdgeRepository()

export function recomputeCourseDagProgress(courseId: string): DagGraph {
  const nodes = nodeRepo.findByCourse(courseId)
  const edges = edgeRepo.findByCourse(courseId)
  const syncedNodes = syncDagProgressWithChapterDependencies(nodes, edges)
  const db = getDb()
  const update = db.prepare(
    `UPDATE dag_nodes
        SET status = @status,
            prerequisites = @prerequisites,
            updated_at = CASE
              WHEN status != @status OR prerequisites != @prerequisites THEN datetime('now')
              ELSE updated_at
            END
      WHERE id = @id`
  )

  db.transaction(() => {
    for (const node of syncedNodes) {
      update.run({
        id: node.id,
        status: node.status,
        prerequisites: JSON.stringify(node.prerequisites)
      })
    }
    db.prepare(
      `UPDATE courses SET
         total_nodes = (SELECT COUNT(*) FROM dag_nodes WHERE course_id = ?),
         done_nodes  = (SELECT COUNT(*) FROM dag_nodes WHERE course_id = ? AND status = 'done'),
         updated_at  = datetime('now')
       WHERE id = ?`
    ).run(courseId, courseId, courseId)
  })()

  return {
    nodes: nodeRepo.findByCourse(courseId),
    edges
  }
}
