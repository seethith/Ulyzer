import type { DagNode, DagEdge } from '@shared/types'
import { normalizeDagEdges } from '@shared/dag-graph'

export const NODE_W = 180
export const NODE_H = 90

const CANVAS_X = 96
const CANVAS_Y = 88
const MAIN_STEP_X = 245
const ROW_STEP_Y = 122
const LANE_PAD_X = 34
const LANE_PAD_TOP = 44
const LANE_PAD_BOTTOM = 26
const CHAPTER_COLUMN_GAP = 150
const CHAPTER_ROW_GAP = 90

const PRIORITY_RANK: Record<string, number> = {
  must: 0,
  should: 1,
  nice_to_have: 2
}

function chapterKey(node: DagNode): string {
  return node.chapter || '其他'
}

function priorityRank(node: DagNode): number {
  if (node.node_type === 'boss') return 4
  return PRIORITY_RANK[node.priority ?? 'must'] ?? 0
}

function stableNodeRank(node: DagNode): string {
  return `${priorityRank(node)}:${node.chapter_order}:${node.name}:${node.id}`
}

function sortChapterNodes(chapterNodes: DagNode[], edges: DagEdge[]): DagNode[] {
  const ids = new Set(chapterNodes.map((node) => node.id))
  const byId = new Map(chapterNodes.map((node) => [node.id, node]))
  const outgoing = new Map<string, string[]>()
  const incomingCount = new Map<string, number>()

  for (const node of chapterNodes) {
    outgoing.set(node.id, [])
    incomingCount.set(node.id, 0)
  }

  for (const edge of edges) {
    if (!ids.has(edge.source_node_id) || !ids.has(edge.target_node_id)) continue
    outgoing.get(edge.source_node_id)?.push(edge.target_node_id)
    incomingCount.set(edge.target_node_id, (incomingCount.get(edge.target_node_id) ?? 0) + 1)
  }

  const queue = chapterNodes
    .filter((node) => (incomingCount.get(node.id) ?? 0) === 0)
    .sort((a, b) => stableNodeRank(a).localeCompare(stableNodeRank(b)))
  const ordered: DagNode[] = []

  while (queue.length > 0) {
    const node = queue.shift()!
    ordered.push(node)
    for (const targetId of outgoing.get(node.id) ?? []) {
      const nextCount = (incomingCount.get(targetId) ?? 0) - 1
      incomingCount.set(targetId, nextCount)
      if (nextCount === 0) {
        const target = byId.get(targetId)
        if (target) {
          queue.push(target)
          queue.sort((a, b) => stableNodeRank(a).localeCompare(stableNodeRank(b)))
        }
      }
    }
  }

  if (ordered.length === chapterNodes.length) return ordered
  const orderedIds = new Set(ordered.map((node) => node.id))
  return [
    ...ordered,
    ...chapterNodes
      .filter((node) => !orderedIds.has(node.id))
      .sort((a, b) => stableNodeRank(a).localeCompare(stableNodeRank(b)))
  ]
}

function computeChapterLayers(chapterNodes: DagNode[], edges: DagEdge[]): Map<string, number> {
  const ids = new Set(chapterNodes.map((node) => node.id))
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  for (const node of chapterNodes) {
    incoming.set(node.id, [])
    outgoing.set(node.id, [])
  }

  for (const edge of edges) {
    if (!ids.has(edge.source_node_id) || !ids.has(edge.target_node_id)) continue
    incoming.get(edge.target_node_id)?.push(edge.source_node_id)
    outgoing.get(edge.source_node_id)?.push(edge.target_node_id)
  }

  const ordered = sortChapterNodes(chapterNodes, edges)
  const hasAnyIntraEdge = ordered.some((node) => (incoming.get(node.id)?.length ?? 0) > 0)
  const layerById = new Map<string, number>()
  for (const node of ordered) {
    const parents = incoming.get(node.id) ?? []
    if (parents.length === 0) {
      const isolated = (outgoing.get(node.id)?.length ?? 0) === 0
      layerById.set(node.id, hasAnyIntraEdge || !isolated ? 0 : layerById.size)
      continue
    }
    const layer = Math.max(...parents.map((id) => (layerById.get(id) ?? 0) + 1))
    layerById.set(node.id, layer)
  }

  const nonBossMaxLayer = Math.max(
    -1,
    ...ordered
      .filter((node) => node.node_type !== 'boss')
      .map((node) => layerById.get(node.id) ?? 0)
  )
  ordered
    .filter((node) => node.node_type === 'boss')
    .forEach((node, index) => {
      const current = layerById.get(node.id) ?? 0
      if (current <= nonBossMaxLayer) layerById.set(node.id, nonBossMaxLayer + 1 + index)
    })

  return layerById
}

interface ChapterLayout {
  key: string
  order: number
  nodes: DagNode[]
  width: number
  height: number
  localPositions: Map<string, { x: number; y: number }>
}

function buildChapterLayout(key: string, chapterNodes: DagNode[], edges: DagEdge[]): ChapterLayout {
  const order = Math.min(...chapterNodes.map((node) => node.chapter_order ?? 999))
  const ordered = sortChapterNodes(chapterNodes, edges)
  const layerById = computeChapterLayers(chapterNodes, edges)
  const nodesByLayer = new Map<number, DagNode[]>()

  for (const node of ordered) {
    const layer = layerById.get(node.id) ?? 0
    const current = nodesByLayer.get(layer) ?? []
    current.push(node)
    nodesByLayer.set(layer, current)
  }

  const localPositions = new Map<string, { x: number; y: number }>()
  let maxRows = 1
  let maxLayer = 0

  for (const [layer, layerNodes] of nodesByLayer) {
    maxLayer = Math.max(maxLayer, layer)
    const sortedLayerNodes = [...layerNodes].sort((a, b) =>
      stableNodeRank(a).localeCompare(stableNodeRank(b))
    )
    maxRows = Math.max(maxRows, sortedLayerNodes.length)
    sortedLayerNodes.forEach((node, rowIndex) => {
      localPositions.set(node.id, {
        x: LANE_PAD_X + layer * MAIN_STEP_X,
        y: LANE_PAD_TOP + rowIndex * ROW_STEP_Y
      })
    })
  }

  return {
    key,
    order,
    nodes: chapterNodes,
    width: Math.max(maxLayer * MAIN_STEP_X + NODE_W + LANE_PAD_X * 2, MIN_LANE_W),
    height:
      LANE_PAD_TOP +
      maxRows * NODE_H +
      Math.max(0, maxRows - 1) * (ROW_STEP_Y - NODE_H) +
      LANE_PAD_BOTTOM,
    localPositions
  }
}

function buildChapterEdges(nodes: DagNode[], edges: DagEdge[]): Array<{ source: string; target: string }> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const chapterIds = [...new Set(nodes.map(chapterKey))]
  const seen = new Set<string>()
  const chapterEdges: Array<{ source: string; target: string }> = []

  for (const edge of edges) {
    const source = nodeById.get(edge.source_node_id)
    const target = nodeById.get(edge.target_node_id)
    if (!source || !target) continue

    const sourceChapter = chapterKey(source)
    const targetChapter = chapterKey(target)
    if (sourceChapter === targetChapter) continue

    const key = `${sourceChapter}\u0000${targetChapter}`
    if (seen.has(key)) continue
    seen.add(key)
    chapterEdges.push({ source: sourceChapter, target: targetChapter })
  }

  return normalizeDagEdges(
    chapterIds.map((id) => ({ id })),
    chapterEdges,
    {
      getSource: (edge) => edge.source,
      getTarget: (edge) => edge.target
    }
  ).edges
}

function computeChapterRanks(
  chapters: ChapterLayout[],
  chapterEdges: Array<{ source: string; target: string }>
): Map<string, number> {
  const rankByChapter = new Map<string, number>()
  if (chapterEdges.length === 0) {
    chapters.forEach((chapter, index) => rankByChapter.set(chapter.key, index))
    return rankByChapter
  }

  const outgoing = new Map<string, string[]>()
  const incomingCount = new Map<string, number>()
  for (const chapter of chapters) {
    outgoing.set(chapter.key, [])
    incomingCount.set(chapter.key, 0)
    rankByChapter.set(chapter.key, 0)
  }

  for (const edge of chapterEdges) {
    outgoing.get(edge.source)?.push(edge.target)
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1)
  }

  const chapterByKey = new Map(chapters.map((chapter) => [chapter.key, chapter]))
  const queue = chapters
    .filter((chapter) => (incomingCount.get(chapter.key) ?? 0) === 0)
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))

  while (queue.length > 0) {
    const chapter = queue.shift()!
    const sourceRank = rankByChapter.get(chapter.key) ?? 0
    for (const target of outgoing.get(chapter.key) ?? []) {
      rankByChapter.set(target, Math.max(rankByChapter.get(target) ?? 0, sourceRank + 1))
      const nextIncoming = (incomingCount.get(target) ?? 0) - 1
      incomingCount.set(target, nextIncoming)
      if (nextIncoming === 0) {
        const targetChapter = chapterByKey.get(target)
        if (targetChapter) {
          queue.push(targetChapter)
          queue.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
        }
      }
    }
  }

  return rankByChapter
}

// ── Learning-path layout ─────────────────────────────────────────────────────
//
// Chapters form the outer DAG from left to right. Chapters with the same rank
// can be learned in parallel and are stacked within the same column. Inside each
// chapter, nodes still flow left-to-right so both reading directions match.

export async function applyElkLayout(nodes: DagNode[], edges: DagEdge[]): Promise<DagNode[]> {
  if (nodes.length === 0) return nodes

  const chapterMap = new Map<string, DagNode[]>()
  for (const node of nodes) {
    const key = chapterKey(node)
    const current = chapterMap.get(key) ?? []
    current.push(node)
    chapterMap.set(key, current)
  }

  const chapters = [...chapterMap.entries()]
    .map(([key, chapterNodes]) => buildChapterLayout(key, chapterNodes, edges))
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
  const chapterEdges = buildChapterEdges(nodes, edges)
  const rankByChapter = computeChapterRanks(chapters, chapterEdges)
  const chaptersByRank = new Map<number, ChapterLayout[]>()

  for (const chapter of chapters) {
    const rank = rankByChapter.get(chapter.key) ?? 0
    const current = chaptersByRank.get(rank) ?? []
    current.push(chapter)
    chaptersByRank.set(rank, current)
  }

  const sortedRanks = [...chaptersByRank.keys()].sort((a, b) => a - b)
  const rankX = new Map<number, number>()
  let cursorX = CANVAS_X
  for (const rank of sortedRanks) {
    rankX.set(rank, cursorX)
    const maxWidth = Math.max(...(chaptersByRank.get(rank) ?? []).map((chapter) => chapter.width))
    cursorX += maxWidth + CHAPTER_COLUMN_GAP
  }

  const posMap = new Map<string, { x: number; y: number }>()
  for (const rank of sortedRanks) {
    const columnChapters = [...(chaptersByRank.get(rank) ?? [])].sort(
      (a, b) => a.order - b.order || a.key.localeCompare(b.key)
    )
    let cursorY = CANVAS_Y
    for (const chapter of columnChapters) {
      const baseX = rankX.get(rank) ?? CANVAS_X
      for (const node of chapter.nodes) {
        const local = chapter.localPositions.get(node.id)
        if (!local) continue
        posMap.set(node.id, {
          x: baseX + local.x,
          y: cursorY + local.y
        })
      }
      cursorY += chapter.height + CHAPTER_ROW_GAP
    }
  }

  return nodes.map((node) => {
    const pos = posMap.get(node.id)
    if (!pos) return node
    return { ...node, position_x: pos.x, position_y: pos.y }
  })
}

// ── Chapter swimlane boxes ───────────────────────────────────────────────────

export interface ChapterBox {
  chapter: string
  order: number
  x: number
  y: number
  width: number
  height: number
  nodeCount: number
  doneCount: number
  bossCount: number
  optionalCount: number
  collapsed?: boolean
  onToggle?: (chapter: string) => void
  draggable?: boolean
}

const MIN_LANE_W = 520
const COLLAPSED_H = 54

export function computeChapterBoxes(
  nodes: DagNode[],
  collapsedChapters: Set<string> = new Set()
): ChapterBox[] {
  const map = new Map<
    string,
    {
      order: number
      minX: number
      minY: number
      maxX: number
      maxY: number
      nodeCount: number
      doneCount: number
      bossCount: number
      optionalCount: number
    }
  >()

  for (const node of nodes) {
    const key = chapterKey(node)
    const existing = map.get(key) ?? {
      order: node.chapter_order ?? 999,
      minX: node.position_x,
      minY: node.position_y,
      maxX: node.position_x + NODE_W,
      maxY: node.position_y + NODE_H,
      nodeCount: 0,
      doneCount: 0,
      bossCount: 0,
      optionalCount: 0
    }

    existing.order = Math.min(existing.order, node.chapter_order ?? 999)
    existing.minX = Math.min(existing.minX, node.position_x)
    existing.minY = Math.min(existing.minY, node.position_y)
    existing.maxX = Math.max(existing.maxX, node.position_x + NODE_W)
    existing.maxY = Math.max(existing.maxY, node.position_y + NODE_H)
    existing.nodeCount += 1
    if (node.status === 'done') existing.doneCount += 1
    if (node.node_type === 'boss') existing.bossCount += 1
    if (node.priority === 'should' || node.priority === 'nice_to_have') existing.optionalCount += 1
    map.set(key, existing)
  }

  return [...map.entries()]
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([chapter, bounds]) => {
      const collapsed = collapsedChapters.has(chapter)
      const x = bounds.minX - LANE_PAD_X
      const y = bounds.minY - LANE_PAD_TOP
      return {
        chapter,
        order: bounds.order,
        x,
        y,
        width: Math.max(bounds.maxX - bounds.minX + LANE_PAD_X * 2, MIN_LANE_W),
        height: collapsed
          ? COLLAPSED_H
          : bounds.maxY - bounds.minY + LANE_PAD_TOP + LANE_PAD_BOTTOM,
        nodeCount: bounds.nodeCount,
        doneCount: bounds.doneCount,
        bossCount: bounds.bossCount,
        optionalCount: bounds.optionalCount,
        collapsed
      }
    })
}
