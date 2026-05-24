import { describe, expect, it } from 'vitest'
import {
  syncDagProgressWithChapterDependencies,
  type DagProgressEdge,
  type DagProgressNode
} from '@shared/dag-progress'

function node(
  id: string,
  chapter: string,
  status: DagProgressNode['status'] = 'locked',
  priority?: string
): DagProgressNode {
  return { id, chapter, status, priority }
}

function edge(source: string, target: string): DagProgressEdge {
  return { source_node_id: source, target_node_id: target }
}

describe('syncDagProgressWithChapterDependencies', () => {
  it('locks root nodes in later chapters until prerequisite chapters are complete', () => {
    const synced = syncDagProgressWithChapterDependencies(
      [
        node('a1', 'A', 'done'),
        node('a2', 'A', 'available'),
        node('b1', 'B'),
        node('b2', 'B')
      ],
      [edge('a2', 'b2')]
    )

    expect(synced.find((item) => item.id === 'b1')?.status).toBe('locked')
    expect(synced.find((item) => item.id === 'b2')?.status).toBe('locked')
  })

  it('unlocks a dependent chapter when its prerequisite chapter is complete', () => {
    const synced = syncDagProgressWithChapterDependencies(
      [
        node('a1', 'A', 'done'),
        node('a2', 'A', 'done'),
        node('b1', 'B'),
        node('b2', 'B')
      ],
      [edge('a2', 'b2')]
    )

    expect(synced.find((item) => item.id === 'b1')?.status).toBe('available')
    expect(synced.find((item) => item.id === 'b2')?.status).toBe('available')
  })

  it('supports parallel and serial chapter dependencies', () => {
    const synced = syncDagProgressWithChapterDependencies(
      [
        node('a1', 'A', 'done'),
        node('b1', 'B'),
        node('b2', 'B'),
        node('c1', 'C'),
        node('c2', 'C'),
        node('d1', 'D'),
        node('d2', 'D')
      ],
      [edge('a1', 'b2'), edge('b2', 'c2'), edge('a1', 'd2')]
    )

    expect(synced.find((item) => item.id === 'b1')?.status).toBe('available')
    expect(synced.find((item) => item.id === 'd1')?.status).toBe('available')
    expect(synced.find((item) => item.id === 'c1')?.status).toBe('locked')
  })

  it('does not let nice-to-have nodes block the next chapter', () => {
    const synced = syncDagProgressWithChapterDependencies(
      [
        node('a1', 'A', 'done'),
        node('a2', 'A', 'locked', 'nice_to_have'),
        node('b1', 'B')
      ],
      [edge('a1', 'b1')]
    )

    expect(synced.find((item) => item.id === 'b1')?.status).toBe('available')
  })
})
