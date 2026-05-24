import { normalizeDagEdges } from './dag-graph'

export interface DagProgressNode {
  id: string
  chapter: string
  status: 'locked' | 'available' | 'active' | 'done'
  priority?: string | null
}

export interface DagProgressEdge {
  source_node_id: string
  target_node_id: string
}

function nodeChapter(node: DagProgressNode): string {
  return node.chapter || '其他'
}

function isBlockingChapterNode(node: DagProgressNode): boolean {
  return node.priority !== 'nice_to_have'
}

function isChapterComplete(chapterNodes: DagProgressNode[]): boolean {
  const blockingNodes = chapterNodes.filter(isBlockingChapterNode)
  const requiredNodes = blockingNodes.length > 0 ? blockingNodes : chapterNodes
  return requiredNodes.length > 0 && requiredNodes.every((node) => node.status === 'done')
}

function buildChapterPrerequisites(
  nodes: DagProgressNode[],
  edges: DagProgressEdge[]
): Map<string, string[]> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const chapterIds = [...new Set(nodes.map(nodeChapter))]
  const chapterEdges: Array<{ source: string; target: string }> = []
  const seen = new Set<string>()

  for (const edge of edges) {
    const source = nodeById.get(edge.source_node_id)
    const target = nodeById.get(edge.target_node_id)
    if (!source || !target) continue
    const sourceChapter = nodeChapter(source)
    const targetChapter = nodeChapter(target)
    if (sourceChapter === targetChapter) continue
    const key = `${sourceChapter}\u0000${targetChapter}`
    if (seen.has(key)) continue
    seen.add(key)
    chapterEdges.push({ source: sourceChapter, target: targetChapter })
  }

  const normalized = normalizeDagEdges(
    chapterIds.map((id) => ({ id })),
    chapterEdges,
    {
      getSource: (edge) => edge.source,
      getTarget: (edge) => edge.target
    }
  ).edges

  const prerequisites = new Map<string, string[]>()
  for (const chapter of chapterIds) prerequisites.set(chapter, [])
  for (const edge of normalized) {
    const current = prerequisites.get(edge.target) ?? []
    current.push(edge.source)
    prerequisites.set(edge.target, current)
  }
  return prerequisites
}

export function syncDagProgressWithChapterDependencies<
  N extends DagProgressNode,
  E extends DagProgressEdge
>(nodes: N[], edges: E[]): N[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const prerequisitesByTarget = new Map<string, string[]>()
  const chapterNodes = new Map<string, N[]>()

  for (const node of nodes) {
    const chapter = nodeChapter(node)
    const current = chapterNodes.get(chapter) ?? []
    current.push(node)
    chapterNodes.set(chapter, current)
  }

  for (const edge of edges) {
    if (!nodeById.has(edge.source_node_id) || !nodeById.has(edge.target_node_id)) continue
    const current = prerequisitesByTarget.get(edge.target_node_id) ?? []
    if (!current.includes(edge.source_node_id)) current.push(edge.source_node_id)
    prerequisitesByTarget.set(edge.target_node_id, current)
  }

  const chapterPrerequisites = buildChapterPrerequisites(nodes, edges)
  const chapterComplete = new Map<string, boolean>()
  for (const [chapter, chapterNodeList] of chapterNodes) {
    chapterComplete.set(chapter, isChapterComplete(chapterNodeList))
  }

  return nodes.map((node) => {
    const prerequisites = prerequisitesByTarget.get(node.id) ?? []
    if (node.status === 'done' || node.status === 'active') {
      return { ...node, prerequisites }
    }

    const nodePrerequisitesDone =
      prerequisites.length === 0 ||
      prerequisites.every((id) => nodeById.get(id)?.status === 'done')
    const prerequisiteChaptersDone = (chapterPrerequisites.get(nodeChapter(node)) ?? []).every(
      (chapter) => chapterComplete.get(chapter) === true
    )

    return {
      ...node,
      prerequisites,
      status: nodePrerequisitesDone && prerequisiteChaptersDone ? 'available' : 'locked'
    }
  })
}
