import React, { useCallback, useMemo, useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import ReactFlow, {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  MarkerType,
  MiniMap,
  type Connection,
  type Node,
  type Edge,
  type EdgeMouseHandler,
  type OnNodesChange,
  type OnEdgesChange,
  type NodeMouseHandler,
  type NodeDragHandler,
  type OnMoveEnd,
  type Viewport
} from 'reactflow'
import 'reactflow/dist/style.css'
import { Save, Workflow } from 'lucide-react'
import type { DagNode, DagEdge } from '@shared/types'
import { normalizeDagEdges } from '@shared/dag-graph'
import { useDAGStore } from '../../stores/dag.store'
import { DAGNodeComponent, ChapterGroupNode } from './DAGNode'
import { DAGEdgeComponent, type DAGEdgeData } from './DAGEdge'
import { NodeBubble } from './NodeBubble'
import { applyElkLayout, computeChapterBoxes } from './dagLayout'
import type { ChapterBox } from './dagLayout'
import { showToast } from '../ui/ToastViewport'

const nodeTypes = {
  dagNode: DAGNodeComponent,
  chapterGroup: ChapterGroupNode
}

const edgeTypes = {
  dagEdge: DAGEdgeComponent
}

const CHAPTER_GROUP_ID_PREFIX = '__chapter_'
const CHAPTER_EDGE_ID_PREFIX = '__chapter_edge_'
const DAG_GLASS_SURFACE = 'color-mix(in srgb, var(--app-workspace-card-bg-strong, var(--surface)) 68%, transparent)'
const DAG_GLASS_SURFACE_HOVER = 'color-mix(in srgb, var(--app-workspace-muted-bg, var(--surface2)) 62%, transparent)'
const DAG_GLASS_BORDER = 'color-mix(in srgb, var(--border2) 62%, transparent)'
const DAG_GLASS_SHADOW = '0 6px 18px rgba(0,0,0,0.07), inset 0 1px 0 rgba(255,255,255,0.16)'
const DAG_GLASS_FILTER = 'blur(7px) saturate(108%)'

interface DAGCanvasProps {
  courseId: string
  onSave: () => Promise<void> | void
}

const DAG_VIEWPORT_STORAGE_PREFIX = 'ulyzer:dag-viewport:v1:'
const NODE_BUBBLE_EXIT_MS = 170

function dagViewportStorageKey(courseId: string): string {
  return `${DAG_VIEWPORT_STORAGE_PREFIX}${encodeURIComponent(courseId)}`
}

function isValidViewport(value: unknown): value is Viewport {
  if (!value || typeof value !== 'object') return false
  const viewport = value as Partial<Viewport>
  return (
    Number.isFinite(viewport.x) &&
    Number.isFinite(viewport.y) &&
    Number.isFinite(viewport.zoom) &&
    typeof viewport.zoom === 'number' &&
    viewport.zoom > 0
  )
}

function readSavedViewport(courseId: string): Viewport | undefined {
  if (!courseId || typeof window === 'undefined') return undefined
  try {
    const raw = window.localStorage.getItem(dagViewportStorageKey(courseId))
    if (!raw) return undefined
    const parsed = JSON.parse(raw)
    return isValidViewport(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function saveViewport(courseId: string, viewport: Viewport): void {
  if (!courseId || typeof window === 'undefined' || !isValidViewport(viewport)) return
  try {
    window.localStorage.setItem(dagViewportStorageKey(courseId), JSON.stringify(viewport))
  } catch {
    // localStorage can fail in private or quota-limited environments; viewport persistence is optional.
  }
}

// ── Converters ────────────────────────────────────────────────────────────────

function toRFNode(n: DagNode, selected: boolean): Node<DagNode> {
  return {
    id: n.id,
    type: 'dagNode',
    position: { x: n.position_x, y: n.position_y },
    data: n,
    selected,
    zIndex: 2
  }
}

function toGroupNode(
  box: ChapterBox,
  collapsed: boolean,
  onToggle: (chapter: string) => void,
  draggable: boolean
): Node<ChapterBox> {
  return {
    id: chapterGroupId(box.chapter),
    type: 'chapterGroup',
    position: { x: box.x, y: box.y },
    data: { ...box, collapsed, onToggle, draggable },
    selectable: false,
    focusable: false,
    connectable: true,
    draggable,
    dragHandle: '.chapter-group-drag-handle',
    style: { pointerEvents: 'none' },
    zIndex: 1
  }
}

function toRFEdge(
  e: DagEdge,
  highlighted: boolean,
  dimmed: boolean,
  selected: boolean,
  onDelete: (edgeId: string) => void,
  deleteLabel: string,
  interactionWidth = 24
): Edge<DAGEdgeData> {
  return {
    id: e.id,
    source: e.source_node_id,
    target: e.target_node_id,
    type: 'dagEdge',
    selected,
    focusable: true,
    reconnectable: true,
    interactionWidth,
    data: {
      onDelete,
      label: deleteLabel,
      edgeKind: 'node',
      emphasis: selected ? 'selected' : highlighted ? 'highlighted' : dimmed ? 'dimmed' : 'normal'
    },
    style: {
      stroke: selected || highlighted ? 'var(--accent)' : dimmed ? 'var(--border)' : 'var(--text3)',
      strokeWidth: selected ? 3 : highlighted ? 2.5 : 1.5,
      opacity: dimmed ? 0.25 : 1,
      transition: 'stroke 0.15s, opacity 0.15s, stroke-width 0.15s'
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: selected || highlighted ? 'var(--accent)' : dimmed ? 'var(--border)' : 'var(--text3)',
      width: 14,
      height: 14
    },
    animated: false
  }
}

interface ChapterVisualEdge {
  id: string
  source: string
  target: string
  underlyingEdgeIds: string[]
}

function chapterGroupId(chapter: string): string {
  return `${CHAPTER_GROUP_ID_PREFIX}${encodeURIComponent(chapter)}`
}

function isChapterGroupNodeId(id: string): boolean {
  return id.startsWith(CHAPTER_GROUP_ID_PREFIX)
}

function chapterFromGroupNodeId(id: string | null | undefined): string | null {
  if (!id || !isChapterGroupNodeId(id)) return null
  try {
    return decodeURIComponent(id.slice(CHAPTER_GROUP_ID_PREFIX.length))
  } catch {
    return null
  }
}

function isChapterVisualEdgeId(id: string): boolean {
  return id.startsWith(CHAPTER_EDGE_ID_PREFIX)
}

function createChapterVisualEdges(
  nodes: DagNode[],
  edges: DagEdge[],
  chapterBoxes: ChapterBox[],
  selectedEdgeId: string | null,
  onDelete: (underlyingEdgeIds: string[]) => void,
  deleteLabel: string
): Edge<DAGEdgeData>[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const knownChapters = new Set(chapterBoxes.map((box) => box.chapter))
  const chapterNodes = chapterBoxes.map((box) => ({ id: box.chapter }))
  const grouped = new Map<string, ChapterVisualEdge>()

  for (const edge of edges) {
    const source = nodeById.get(edge.source_node_id)
    const target = nodeById.get(edge.target_node_id)
    if (!source || !target) continue

    const sourceChapter = nodeChapter(source)
    const targetChapter = nodeChapter(target)
    if (sourceChapter === targetChapter) continue
    if (!knownChapters.has(sourceChapter) || !knownChapters.has(targetChapter)) continue

    const key = `${sourceChapter}\u0000${targetChapter}`
    const current =
      grouped.get(key) ??
      ({
        id: key,
        source: sourceChapter,
        target: targetChapter,
        underlyingEdgeIds: []
      } satisfies ChapterVisualEdge)
    current.underlyingEdgeIds.push(edge.id)
    grouped.set(key, current)
  }

  const normalized = normalizeDagEdges(chapterNodes, [...grouped.values()], {
    getSource: (edge) => edge.source,
    getTarget: (edge) => edge.target
  }).edges

  return normalized.map((edge, index) => {
    const id = `${CHAPTER_EDGE_ID_PREFIX}${index}_${encodeURIComponent(edge.source)}_${encodeURIComponent(edge.target)}`
    const selected = selectedEdgeId === id
    return {
      id,
      source: chapterGroupId(edge.source),
      target: chapterGroupId(edge.target),
      type: 'dagEdge',
      selected,
      selectable: true,
      focusable: true,
      reconnectable: false,
      interactionWidth: 22,
      data: {
        underlyingEdgeIds: edge.underlyingEdgeIds,
        edgeKind: 'chapter',
        emphasis: selected ? 'selected' : 'chapter',
        onDelete: () => {
          onDelete(edge.underlyingEdgeIds)
        },
        label: deleteLabel
      },
      style: {
        stroke: 'var(--accent)',
        strokeWidth: selected ? 3 : 2,
        strokeDasharray: '7 8',
        opacity: selected ? 0.72 : 0.58,
        transition: 'opacity 0.15s, stroke-width 0.15s'
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: 'var(--accent)',
        width: 16,
        height: 16
      },
      animated: false
    }
  })
}

function createEdge(courseId: string, sourceNodeId: string, targetNodeId: string): DagEdge {
  return {
    id: crypto.randomUUID(),
    course_id: courseId,
    source_node_id: sourceNodeId,
    target_node_id: targetNodeId,
    created_at: new Date().toISOString()
  }
}

function isAcyclic(nodes: DagNode[], edges: DagEdge[]): boolean {
  const nodeIds = new Set(nodes.map((n) => n.id))
  const inDegree = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const id of nodeIds) {
    inDegree.set(id, 0)
    outgoing.set(id, [])
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.source_node_id) || !nodeIds.has(edge.target_node_id)) continue
    outgoing.get(edge.source_node_id)?.push(edge.target_node_id)
    inDegree.set(edge.target_node_id, (inDegree.get(edge.target_node_id) ?? 0) + 1)
  }

  const queue = [...inDegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id)
  let visited = 0

  while (queue.length > 0) {
    const id = queue.shift()!
    visited += 1
    for (const target of outgoing.get(id) ?? []) {
      const nextDegree = (inDegree.get(target) ?? 0) - 1
      inDegree.set(target, nextDegree)
      if (nextDegree === 0) queue.push(target)
    }
  }

  return visited === nodeIds.size
}

function hasReachablePath(
  sourceId: string,
  targetId: string,
  edges: DagEdge[],
  ignoreEdgeId?: string
): boolean {
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.id === ignoreEdgeId) continue
    const current = outgoing.get(edge.source_node_id) ?? []
    current.push(edge.target_node_id)
    outgoing.set(edge.source_node_id, current)
  }

  const visited = new Set<string>()
  const stack = [...(outgoing.get(sourceId) ?? [])]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === targetId) return true
    if (visited.has(id)) continue
    visited.add(id)
    stack.push(...(outgoing.get(id) ?? []))
  }
  return false
}

function hasChapterPath(
  sourceChapter: string,
  targetChapter: string,
  nodes: DagNode[],
  edges: DagEdge[],
  ignoreEdgeIds: Set<string> = new Set()
): boolean {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    if (ignoreEdgeIds.has(edge.id)) continue
    const source = nodeById.get(edge.source_node_id)
    const target = nodeById.get(edge.target_node_id)
    if (!source || !target) continue
    const from = nodeChapter(source)
    const to = nodeChapter(target)
    if (from === to) continue
    const current = outgoing.get(from) ?? []
    if (!current.includes(to)) current.push(to)
    outgoing.set(from, current)
  }

  const visited = new Set<string>()
  const stack = [...(outgoing.get(sourceChapter) ?? [])]
  while (stack.length > 0) {
    const chapter = stack.pop()!
    if (chapter === targetChapter) return true
    if (visited.has(chapter)) continue
    visited.add(chapter)
    stack.push(...(outgoing.get(chapter) ?? []))
  }
  return false
}

function normalizePrerequisites(
  nodeId: string,
  allNodes: DagNode[],
  prerequisites: string[]
): string[] {
  const nodeIds = new Set(allNodes.map((n) => n.id))
  return [...new Set(prerequisites)].filter((id) => id !== nodeId && nodeIds.has(id))
}

function reconcilePrerequisiteEdges(
  courseId: string,
  targetNodeId: string,
  prerequisiteIds: string[],
  currentEdges: DagEdge[]
): DagEdge[] {
  const existingIncoming = new Map(
    currentEdges
      .filter((edge) => edge.target_node_id === targetNodeId)
      .map((edge) => [edge.source_node_id, edge])
  )
  return [
    ...currentEdges.filter((edge) => edge.target_node_id !== targetNodeId),
    ...prerequisiteIds.map(
      (sourceId) => existingIncoming.get(sourceId) ?? createEdge(courseId, sourceId, targetNodeId)
    )
  ]
}

function stableCanvasNodeRank(node: DagNode): string {
  const typeRank = node.node_type === 'boss' ? 2 : 0
  const priorityRank = node.priority === 'nice_to_have' ? 2 : node.priority === 'should' ? 1 : 0
  return `${typeRank}:${priorityRank}:${node.position_x}:${node.position_y}:${node.name}:${node.id}`
}

function chapterAnchorNodes(
  sourceChapter: string,
  targetChapter: string,
  nodes: DagNode[],
  edges: DagEdge[]
): { source: DagNode; target: DagNode } | null {
  const sourceNodes = nodes.filter((node) => nodeChapter(node) === sourceChapter)
  const targetNodes = nodes.filter((node) => nodeChapter(node) === targetChapter)
  if (sourceNodes.length === 0 || targetNodes.length === 0) return null

  const sourceIds = new Set(sourceNodes.map((node) => node.id))
  const targetIds = new Set(targetNodes.map((node) => node.id))
  const sourceOutgoingInChapter = new Set<string>()
  const targetIncomingInChapter = new Set<string>()

  for (const edge of edges) {
    if (sourceIds.has(edge.source_node_id) && sourceIds.has(edge.target_node_id)) {
      sourceOutgoingInChapter.add(edge.source_node_id)
    }
    if (targetIds.has(edge.source_node_id) && targetIds.has(edge.target_node_id)) {
      targetIncomingInChapter.add(edge.target_node_id)
    }
  }

  const source =
    [...sourceNodes]
      .sort((a, b) => {
        if (a.node_type === 'boss' && b.node_type !== 'boss') return -1
        if (a.node_type !== 'boss' && b.node_type === 'boss') return 1
        const aTerminal = !sourceOutgoingInChapter.has(a.id)
        const bTerminal = !sourceOutgoingInChapter.has(b.id)
        if (aTerminal !== bTerminal) return aTerminal ? -1 : 1
        return b.position_x - a.position_x || a.position_y - b.position_y || stableCanvasNodeRank(a).localeCompare(stableCanvasNodeRank(b))
      })[0] ?? null

  const target =
    [...targetNodes]
      .sort((a, b) => {
        if (a.node_type === 'boss' && b.node_type !== 'boss') return 1
        if (a.node_type !== 'boss' && b.node_type === 'boss') return -1
        const aEntry = !targetIncomingInChapter.has(a.id)
        const bEntry = !targetIncomingInChapter.has(b.id)
        if (aEntry !== bEntry) return aEntry ? -1 : 1
        return a.position_x - b.position_x || a.position_y - b.position_y || stableCanvasNodeRank(a).localeCompare(stableCanvasNodeRank(b))
      })[0] ?? null

  return source && target ? { source, target } : null
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable
}

function hasValidSavedLayout(nodes: DagNode[]): boolean {
  if (nodes.length === 0) return true
  const everyPositionIsFinite = nodes.every(
    (node) => Number.isFinite(node.position_x) && Number.isFinite(node.position_y)
  )
  if (!everyPositionIsFinite) return false
  return nodes.some((node) => Math.abs(node.position_x) > 0.5 || Math.abs(node.position_y) > 0.5)
}

function nodeChapter(node: DagNode): string {
  return node.chapter || '其他'
}

interface ChapterDragState {
  chapter: string
  startX: number
  startY: number
  nodePositions: Array<{ id: string; x: number; y: number }>
}

// ── DAGCanvas ─────────────────────────────────────────────────────────────────

export const DAGCanvas: React.FC<DAGCanvasProps> = ({ courseId, onSave }) => {
  const { t } = useTranslation()
  const {
    nodes,
    edges,
    selectedNodeId,
    isGenerating,
    updateNode,
    selectNode,
    setDAG,
    setEdges,
    setNodePositions,
    addEdge,
    deleteNode
  } = useDAGStore()

  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [collapsedChapters, setCollapsedChapters] = useState<Set<string>>(() => new Set())
  const [renderedBubbleNode, setRenderedBubbleNode] = useState<DagNode | null>(null)
  const [isNodeBubbleClosing, setIsNodeBubbleClosing] = useState(false)
  const [feedback, setFeedback] = useState<{
    kind: 'info' | 'success' | 'error'
    text: string
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const chapterDragRef = useRef<ChapterDragState | null>(null)
  const nodeBubbleCloseTimerRef = useRef<number | null>(null)
  const initialViewport = useMemo(() => readSavedViewport(courseId), [courseId])

  const handleMoveEnd = useCallback<OnMoveEnd>(
    (_event, viewport) => {
      if (nodes.length === 0) return
      saveViewport(courseId, viewport)
    },
    [courseId, nodes.length]
  )

  const toggleChapter = useCallback((chapter: string) => {
    setCollapsedChapters((current) => {
      const next = new Set(current)
      if (next.has(chapter)) next.delete(chapter)
      else next.add(chapter)
      return next
    })
  }, [])

  const visibleNodes = useMemo(
    () => nodes.filter((node) => !collapsedChapters.has(nodeChapter(node))),
    [collapsedChapters, nodes]
  )

  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes])

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])

  const visibleEdges = useMemo(
    () =>
      edges.filter((edge) => {
        const source = nodeById.get(edge.source_node_id)
        const target = nodeById.get(edge.target_node_id)
        return (
          !!source &&
          !!target &&
          visibleNodeIds.has(source.id) &&
          visibleNodeIds.has(target.id) &&
          nodeChapter(source) === nodeChapter(target)
        )
      }),
    [edges, nodeById, visibleNodeIds]
  )

  // ── Connected edges for hover highlight ──────────────────────────────────────
  const connectedEdgeIds = useMemo(() => {
    if (!hoveredNodeId) return new Set<string>()
    return new Set(
      visibleEdges
        .filter((e) => e.source_node_id === hoveredNodeId || e.target_node_id === hoveredNodeId)
        .map((e) => e.id)
    )
  }, [hoveredNodeId, visibleEdges])

  // ── Chapter group boxes ───────────────────────────────────────────────────────
  const chapterBoxes = useMemo(
    () => computeChapterBoxes(nodes, collapsedChapters),
    [collapsedChapters, nodes]
  )

  // ── ReactFlow nodes/edges ────────────────────────────────────────────────────
  const rfNodes = useMemo<Node[]>(
    () => [
      ...chapterBoxes.map((box) =>
        toGroupNode(
          box,
          collapsedChapters.has(box.chapter),
          toggleChapter,
          !isGenerating
        )
      ),
      ...visibleNodes.map((node) =>
        toRFNode(node, node.id === selectedNodeId)
      )
    ],
    [
      chapterBoxes,
      collapsedChapters,
      isGenerating,
      selectedNodeId,
      toggleChapter,
      visibleNodes
    ]
  )

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
  )

  useEffect(() => {
    if (nodeBubbleCloseTimerRef.current !== null) {
      window.clearTimeout(nodeBubbleCloseTimerRef.current)
      nodeBubbleCloseTimerRef.current = null
    }

    if (selectedNode) {
      setRenderedBubbleNode(selectedNode)
      setIsNodeBubbleClosing(false)
      return
    }

    if (renderedBubbleNode) {
      setIsNodeBubbleClosing(true)
      nodeBubbleCloseTimerRef.current = window.setTimeout(() => {
        setRenderedBubbleNode(null)
        setIsNodeBubbleClosing(false)
        nodeBubbleCloseTimerRef.current = null
      }, NODE_BUBBLE_EXIT_MS)
    }
  }, [renderedBubbleNode, selectedNode])

  useEffect(() => () => {
    if (nodeBubbleCloseTimerRef.current !== null) {
      window.clearTimeout(nodeBubbleCloseTimerRef.current)
    }
  }, [])

  const showFeedback = useCallback((kind: 'info' | 'success' | 'error', text: string) => {
    setFeedback({ kind, text })
    window.setTimeout(
      () => {
        setFeedback((current) => (current?.text === text ? null : current))
      },
      kind === 'error' ? 4200 : 2600
    )
  }, [])

  const persist = useCallback(async () => {
    setSaving(true)
    try {
      await onSave()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const text = t('dag_canvas.save_failed', { message })
      showFeedback('error', text)
      showToast({ kind: 'error', text })
      throw err
    } finally {
      setSaving(false)
    }
  }, [onSave, showFeedback, t])

  useEffect(() => {
    if (selectedNode && collapsedChapters.has(nodeChapter(selectedNode))) {
      selectNode(null)
    }
  }, [collapsedChapters, selectNode, selectedNode])

  useEffect(() => {
    if (selectedEdgeId && !isChapterVisualEdgeId(selectedEdgeId) && !edges.some((edge) => edge.id === selectedEdgeId)) {
      setSelectedEdgeId(null)
    }
  }, [edges, selectedEdgeId])

  useEffect(() => {
    if (selectedEdgeId && !isChapterVisualEdgeId(selectedEdgeId) && !visibleEdges.some((edge) => edge.id === selectedEdgeId)) {
      setSelectedEdgeId(null)
    }
  }, [selectedEdgeId, visibleEdges])

  // ── Auto-layout on first load ─────────────────────────────────────────────────
  const layoutAppliedRef = useRef(false)
  useEffect(() => {
    if (nodes.length === 0) {
      layoutAppliedRef.current = false
      return
    }
    if (hasValidSavedLayout(nodes)) {
      layoutAppliedRef.current = false
      return
    }
    if (layoutAppliedRef.current) return
    layoutAppliedRef.current = true
    let cancelled = false
    applyElkLayout(nodes, edges).then((laid) => {
      if (!cancelled) setDAG(laid, edges)
    })
    return () => {
      cancelled = true
    }
  }, [edges, nodes, setDAG])

  const handleRelayout = useCallback(async () => {
    const laid = await applyElkLayout(nodes, edges)
    setDAG(laid, edges)
    const text = t('dag_canvas.relayout_done')
    showFeedback('info', text)
    showToast({ kind: 'info', text })
  }, [edges, nodes, setDAG, showFeedback, t])

  const handleSave = useCallback(async () => {
    await persist()
    const text = t('dag_canvas.saved')
    showFeedback('success', text)
    showToast({ kind: 'success', text })
  }, [persist, showFeedback, t])

  const handleConnectNodes = useCallback(
    async (sourceId: string, targetId: string) => {
      const source = nodes.find((node) => node.id === sourceId)
      const target = nodes.find((node) => node.id === targetId)
      if (!source || !target) return
      if (sourceId === targetId) {
        showFeedback('error', t('dag_canvas.connect_self'))
        return
      }
      if (
        edges.some((edge) => edge.source_node_id === sourceId && edge.target_node_id === targetId)
      ) {
        showFeedback('error', t('dag_canvas.connect_duplicate'))
        return
      }
      if (hasReachablePath(sourceId, targetId, edges)) {
        showFeedback('error', t('dag_canvas.connect_transitive'))
        return
      }

      const nextEdge = createEdge(source.course_id, sourceId, targetId)
      const nextEdges = [...edges, nextEdge]
      if (!isAcyclic(nodes, nextEdges)) {
        showFeedback('error', t('dag_canvas.connect_cycle'))
        return
      }

      addEdge(nextEdge)
      setSelectedEdgeId(nextEdge.id)
      selectNode(null)
      await persist()
      showFeedback(
        'success',
        t('dag_canvas.connect_success', { source: source.name, target: target.name })
      )
    },
    [addEdge, edges, nodes, persist, selectNode, showFeedback, t]
  )

  const handleConnectChapters = useCallback(
    async (sourceChapter: string, targetChapter: string) => {
      if (sourceChapter === targetChapter) {
        showFeedback('error', t('dag_canvas.connect_self'))
        return
      }
      if (hasChapterPath(sourceChapter, targetChapter, nodes, edges)) {
        showFeedback('error', t('dag_canvas.connect_transitive'))
        return
      }

      const anchors = chapterAnchorNodes(sourceChapter, targetChapter, nodes, edges)
      if (!anchors) {
        showFeedback('error', t('dag_canvas.chapter_connect_no_anchor'))
        return
      }

      const nextEdge = createEdge(anchors.source.course_id, anchors.source.id, anchors.target.id)
      const nextEdges = [...edges, nextEdge]
      if (!isAcyclic(nodes, nextEdges)) {
        showFeedback('error', t('dag_canvas.connect_cycle'))
        return
      }

      addEdge(nextEdge)
      setSelectedEdgeId(null)
      selectNode(null)
      await persist()
      showFeedback(
        'success',
        t('dag_canvas.chapter_connect_success', { source: sourceChapter, target: targetChapter })
      )
    },
    [addEdge, edges, nodes, persist, selectNode, showFeedback, t]
  )

  const handleDeleteEdge = useCallback(
    async (edgeId: string) => {
      const edge = edges.find((item) => item.id === edgeId)
      if (!edge) return
      const source = nodes.find((node) => node.id === edge.source_node_id)
      const target = nodes.find((node) => node.id === edge.target_node_id)
      setEdges(edges.filter((item) => item.id !== edgeId))
      setSelectedEdgeId(null)
      await persist()
      showFeedback(
        'success',
        t('dag_canvas.edge_deleted', {
          source: source?.name ?? edge.source_node_id,
          target: target?.name ?? edge.target_node_id
        })
      )
    },
    [edges, nodes, persist, setEdges, showFeedback, t]
  )

  const handleDeleteChapterEdges = useCallback(
    async (edgeIds: string[]) => {
      const ids = new Set(edgeIds)
      const removed = edges.filter((edge) => ids.has(edge.id))
      if (removed.length === 0) return
      const first = removed[0]
      const source = nodes.find((node) => node.id === first.source_node_id)
      const target = nodes.find((node) => node.id === first.target_node_id)
      setEdges(edges.filter((edge) => !ids.has(edge.id)))
      setSelectedEdgeId(null)
      await persist()
      showFeedback(
        'success',
        t('dag_canvas.edge_deleted', {
          source: source ? nodeChapter(source) : first.source_node_id,
          target: target ? nodeChapter(target) : first.target_node_id
        })
      )
    },
    [edges, nodes, persist, setEdges, showFeedback, t]
  )

  const chapterVisualEdges = useMemo(
    () =>
      createChapterVisualEdges(
        nodes,
        edges,
        chapterBoxes,
        selectedEdgeId,
        (edgeIds) => {
          void handleDeleteChapterEdges(edgeIds)
        },
        t('dag_canvas.edge_delete')
      ),
    [chapterBoxes, edges, handleDeleteChapterEdges, nodes, selectedEdgeId, t]
  )

  useEffect(() => {
    if (
      selectedEdgeId &&
      isChapterVisualEdgeId(selectedEdgeId) &&
      !chapterVisualEdges.some((edge) => edge.id === selectedEdgeId)
    ) {
      setSelectedEdgeId(null)
    }
  }, [chapterVisualEdges, selectedEdgeId])

  const validateConnection = useCallback(
    (
      sourceId: string | null | undefined,
      targetId: string | null | undefined,
      ignoreEdgeId?: string
    ) => {
      if (!sourceId || !targetId) return false
      if (sourceId === targetId) return false

      const sourceChapter = chapterFromGroupNodeId(sourceId)
      const targetChapter = chapterFromGroupNodeId(targetId)
      if (sourceChapter || targetChapter) {
        if (!sourceChapter || !targetChapter || sourceChapter === targetChapter) return false
        if (hasChapterPath(sourceChapter, targetChapter, nodes, edges)) return false
        const anchors = chapterAnchorNodes(sourceChapter, targetChapter, nodes, edges)
        if (!anchors) return false
        return isAcyclic(nodes, [
          ...edges,
          createEdge(anchors.source.course_id, anchors.source.id, anchors.target.id)
        ])
      }

      if (
        !nodes.some((node) => node.id === sourceId) ||
        !nodes.some((node) => node.id === targetId)
      ) {
        return false
      }
      if (
        edges.some(
          (edge) =>
            edge.id !== ignoreEdgeId &&
            edge.source_node_id === sourceId &&
            edge.target_node_id === targetId
        )
      ) {
        return false
      }
      if (hasReachablePath(sourceId, targetId, edges, ignoreEdgeId)) return false
      const baseEdges = ignoreEdgeId ? edges.filter((edge) => edge.id !== ignoreEdgeId) : edges
      const courseId = nodes.find((node) => node.id === sourceId)?.course_id ?? ''
      return isAcyclic(nodes, [...baseEdges, createEdge(courseId, sourceId, targetId)])
    },
    [edges, nodes]
  )

  const handleReactFlowConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      const sourceChapter = chapterFromGroupNodeId(connection.source)
      const targetChapter = chapterFromGroupNodeId(connection.target)
      if (sourceChapter || targetChapter) {
        if (sourceChapter && targetChapter) {
          void handleConnectChapters(sourceChapter, targetChapter)
        } else {
          showFeedback('error', t('dag_canvas.chapter_connect_mixed'))
        }
        return
      }
      void handleConnectNodes(connection.source, connection.target)
    },
    [handleConnectChapters, handleConnectNodes, showFeedback, t]
  )

  const handleReconnect = useCallback(
    async (oldEdge: Edge, connection: Connection) => {
      const current = edges.find((edge) => edge.id === oldEdge.id)
      if (!current) return
      const sourceId = connection.source ?? oldEdge.source
      const targetId = connection.target ?? oldEdge.target
      if (!sourceId || !targetId || !validateConnection(sourceId, targetId, oldEdge.id)) {
        showFeedback('error', t('dag_canvas.edge_reconnect_invalid'))
        return
      }
      if (sourceId === current.source_node_id && targetId === current.target_node_id) return

      const nextEdges = edges.map((edge) =>
        edge.id === oldEdge.id
          ? {
              ...edge,
              source_node_id: sourceId,
              target_node_id: targetId
            }
          : edge
      )
      setEdges(nextEdges)
      setSelectedEdgeId(oldEdge.id)
      selectNode(null)
      await persist()
      const source = nodes.find((node) => node.id === sourceId)
      const target = nodes.find((node) => node.id === targetId)
      showFeedback(
        'success',
        t('dag_canvas.edge_reconnected', {
          source: source?.name ?? sourceId,
          target: target?.name ?? targetId
        })
      )
    },
    [edges, nodes, persist, selectNode, setEdges, showFeedback, t, validateConnection]
  )

  const rfEdges = useMemo<Edge<DAGEdgeData>[]>(() => {
    const anyHover = hoveredNodeId !== null
    return [
      ...chapterVisualEdges,
      ...visibleEdges.map((edge) =>
        toRFEdge(
          edge,
          anyHover && connectedEdgeIds.has(edge.id),
          anyHover && !connectedEdgeIds.has(edge.id),
          edge.id === selectedEdgeId,
          (edgeId) => {
            void handleDeleteEdge(edgeId)
          },
          t('dag_canvas.edge_delete')
        )
      )
    ]
  }, [
    chapterVisualEdges,
    connectedEdgeIds,
    handleDeleteEdge,
    hoveredNodeId,
    selectedEdgeId,
    t,
    visibleEdges
  ])

  const handleSaveNodeEdits = useCallback(
    async (nodeId: string, data: Partial<DagNode>, prerequisites: string[]) => {
      const node = nodes.find((item) => item.id === nodeId)
      if (!node) return
      const normalizedPrereqs = normalizePrerequisites(nodeId, nodes, prerequisites)
      const nextEdges = reconcilePrerequisiteEdges(node.course_id, nodeId, normalizedPrereqs, edges)
      if (!isAcyclic(nodes, nextEdges)) {
        showFeedback('error', t('dag_canvas.prerequisite_cycle'))
        throw new Error(t('dag_canvas.prerequisite_cycle'))
      }

      updateNode(nodeId, { ...data, prerequisites: normalizedPrereqs })
      setEdges(nextEdges)
      await persist()
      showFeedback('success', t('dag_canvas.node_saved'))
    },
    [edges, nodes, persist, setEdges, showFeedback, t, updateNode]
  )

  const handleDeleteNode = useCallback(
    async (node: DagNode) => {
      if (!window.confirm(t('dag_canvas.delete_confirm', { name: node.name }))) return
      deleteNode(node.id)
      setSelectedEdgeId(null)
      await persist()
      showFeedback('success', t('dag_canvas.node_deleted', { name: node.name }))
    },
    [deleteNode, persist, showFeedback, t]
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isGenerating || saving) return
      if (isEditableKeyboardTarget(event.target)) return
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      if (!selectedEdgeId && !selectedNode) return

      event.preventDefault()
      if (selectedEdgeId) {
        if (isChapterVisualEdgeId(selectedEdgeId)) {
          const visual = chapterVisualEdges.find((edge) => edge.id === selectedEdgeId)
          const underlying = visual?.data?.underlyingEdgeIds ?? []
          if (underlying.length > 0) void handleDeleteChapterEdges(underlying)
          return
        }
        void handleDeleteEdge(selectedEdgeId)
        return
      }
      if (selectedNode) {
        void handleDeleteNode(selectedNode)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    chapterVisualEdges,
    handleDeleteChapterEdges,
    handleDeleteEdge,
    handleDeleteNode,
    isGenerating,
    saving,
    selectedEdgeId,
    selectedNode
  ])

  // ── ReactFlow handlers ───────────────────────────────────────────────────────
  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          if (isChapterGroupNodeId(change.id)) continue
          updateNode(change.id, {
            position_x: change.position.x,
            position_y: change.position.y
          })
        }
      }
    },
    [updateNode]
  )

  const onNodeDragStart: NodeDragHandler = useCallback(
    (_event, node) => {
      if (node.type !== 'chapterGroup') return
      const data = node.data as ChapterBox
      chapterDragRef.current = {
        chapter: data.chapter,
        startX: node.position.x,
        startY: node.position.y,
        nodePositions: nodes
          .filter((item) => nodeChapter(item) === data.chapter)
          .map((item) => ({ id: item.id, x: item.position_x, y: item.position_y }))
      }
      setSelectedEdgeId(null)
      selectNode(null)
    },
    [nodes, selectNode]
  )

  const onNodeDrag: NodeDragHandler = useCallback(
    (_event, node) => {
      const drag = chapterDragRef.current
      if (!drag || node.type !== 'chapterGroup') return
      const dx = node.position.x - drag.startX
      const dy = node.position.y - drag.startY
      setNodePositions(
        drag.nodePositions.map((position) => ({
          id: position.id,
          x: position.x + dx,
          y: position.y + dy
        }))
      )
    },
    [setNodePositions]
  )

  const onNodeDragStop: NodeDragHandler = useCallback(
    (_event, node) => {
      const drag = chapterDragRef.current
      if (!drag || node.type !== 'chapterGroup') return
      chapterDragRef.current = null
      showFeedback('info', t('dag_canvas.chapter_moved', { chapter: drag.chapter }))
    },
    [showFeedback, t]
  )

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      for (const change of changes) {
        if (!('id' in change)) continue
        if (change.type === 'select') {
          setSelectedEdgeId(change.selected ? change.id : null)
        }
        if (change.type === 'remove') {
          if (isChapterVisualEdgeId(change.id)) {
            const visual = chapterVisualEdges.find((edge) => edge.id === change.id)
            const underlying = visual?.data?.underlyingEdgeIds ?? []
            if (underlying.length > 0) void handleDeleteChapterEdges(underlying)
            continue
          }
          void handleDeleteEdge(change.id)
        }
      }
    },
    [chapterVisualEdges, handleDeleteChapterEdges, handleDeleteEdge]
  )

  const onEdgeClick: EdgeMouseHandler = useCallback(
    (event, edge) => {
      event.stopPropagation()
      setSelectedEdgeId(edge.id)
      selectNode(null)
    },
    [selectNode]
  )

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      if (node.type === 'chapterGroup') return
      const dagNode = nodes.find((n) => n.id === node.id)
      if (!dagNode) return
      setSelectedEdgeId(null)
      selectNode(dagNode.id === selectedNodeId ? null : dagNode.id)
    },
    [nodes, selectedNodeId, selectNode]
  )

  const onNodeMouseEnter: NodeMouseHandler = useCallback((_event, node) => {
    if (node.type !== 'chapterGroup') setHoveredNodeId(node.id)
  }, [])

  const onNodeMouseLeave: NodeMouseHandler = useCallback(() => {
    setHoveredNodeId(null)
  }, [])

  const onPaneClick = useCallback(() => {
    setSelectedEdgeId(null)
    selectNode(null)
  }, [selectNode])

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="ui-panel-content-in" style={{ display: 'flex', height: '100%' }}>
      {/* ReactFlow canvas */}
      <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onEdgeClick={onEdgeClick}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={onNodeMouseLeave}
          onPaneClick={onPaneClick}
          onConnect={handleReactFlowConnect}
          onReconnect={handleReconnect}
          isValidConnection={(connection) =>
            validateConnection(connection.source, connection.target)
          }
          connectionLineType={ConnectionLineType.Bezier}
          connectionLineStyle={{
            stroke: 'var(--accent)',
            strokeWidth: 2,
            strokeLinecap: 'round'
          }}
          nodesDraggable={!isGenerating && !saving}
          nodesConnectable={!isGenerating && !saving}
          edgesUpdatable={!isGenerating && !saving}
          edgesFocusable
          deleteKeyCode={null}
          defaultViewport={initialViewport}
          fitView={!initialViewport}
          fitViewOptions={{ padding: 0.2 }}
          onMoveEnd={handleMoveEnd}
          minZoom={0.3}
          maxZoom={2}
          style={{ backgroundColor: 'var(--app-workspace-bg, var(--bg))' }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={28} size={1.5} color="var(--border)" />
          {visibleNodes.length > 0 && (
            <MiniMap
              position="bottom-left"
              pannable
              zoomable
              nodeColor={(node) => {
                const data = node.data as DagNode | undefined
                if (data?.node_type === 'boss') return '#f59e0b'
                if (data?.status === 'done') return '#16a34a'
                if (data?.status === 'active') return 'var(--accent)'
                return '#9ca3af'
              }}
              maskColor="color-mix(in srgb, var(--app-workspace-card-bg-strong, var(--surface)) 24%, transparent)"
              style={{
                width: 140,
                height: 96,
                margin: 12,
                border: `1px solid ${DAG_GLASS_BORDER}`,
                borderRadius: 'var(--r)',
                backgroundColor: DAG_GLASS_SURFACE,
                boxShadow: DAG_GLASS_SHADOW,
                backdropFilter: DAG_GLASS_FILTER,
                WebkitBackdropFilter: DAG_GLASS_FILTER
              }}
            />
          )}
        </ReactFlow>

        {/* Toolbar: save */}
        <div
          style={{
            position: 'absolute',
            top: 10,
            left: 10,
            display: 'flex',
            gap: 6,
            zIndex: 10
          }}
        >
          <button
            className="ui-pressable"
            onClick={() => {
              void handleRelayout()
            }}
            disabled={saving || isGenerating}
            title={t('dag_toolbar.relayout_title')}
            style={{
              width: 32,
              height: 32,
              borderRadius: 'var(--r)',
              border: `1px solid ${DAG_GLASS_BORDER}`,
              backgroundColor: DAG_GLASS_SURFACE,
              color: saving || isGenerating ? 'var(--text3)' : 'var(--text2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: saving || isGenerating ? 'not-allowed' : 'pointer',
              boxShadow: DAG_GLASS_SHADOW,
              backdropFilter: DAG_GLASS_FILTER,
              WebkitBackdropFilter: DAG_GLASS_FILTER
            }}
            onMouseEnter={(e) => {
              if (!saving && !isGenerating) {
                ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = DAG_GLASS_SURFACE_HOVER
              }
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = DAG_GLASS_SURFACE
            }}
          >
            <Workflow size={14} />
          </button>
          <button
            className="ui-pressable"
            onClick={() => {
              void handleSave()
            }}
            disabled={saving}
            title={t('dag_toolbar.save_title')}
            style={{
              width: 32,
              height: 32,
              borderRadius: 'var(--r)',
              border: `1px solid ${DAG_GLASS_BORDER}`,
              backgroundColor: DAG_GLASS_SURFACE,
              color: saving ? 'var(--text3)' : 'var(--text2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: saving ? 'not-allowed' : 'pointer',
              boxShadow: DAG_GLASS_SHADOW,
              backdropFilter: DAG_GLASS_FILTER,
              WebkitBackdropFilter: DAG_GLASS_FILTER
            }}
            onMouseEnter={(e) => {
              if (!saving) {
                ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = DAG_GLASS_SURFACE_HOVER
              }
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = DAG_GLASS_SURFACE
            }}
          >
            <Save size={14} />
          </button>
        </div>

        {feedback && (
          <div
            className="ui-feedback-pill"
            style={{
              position: 'absolute',
              top: 10,
              left: 84,
              maxWidth: 420,
              zIndex: 10,
              padding: '6px 10px',
              border: `1px solid ${feedback.kind === 'error' ? '#b45309' : feedback.kind === 'success' ? 'var(--green)' : 'var(--border)'}`,
              borderRadius: 'var(--r)',
              backgroundColor: 'var(--surface)',
              color: feedback.kind === 'error' ? '#b45309' : 'var(--text2)',
              fontSize: 12,
              boxShadow: 'var(--shadow)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {feedback.text}
          </div>
        )}

        {/* Empty state */}
        {nodes.length === 0 && !isGenerating && (
          <div
            className="ui-empty-state"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none'
            }}
          >
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>🗺️</div>
              <div
                style={{ fontSize: 14, fontWeight: 600, color: 'var(--text2)', marginBottom: 6 }}
              >
                {t('dag_canvas.empty_title')}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                {t('dag_canvas.empty_subtitle')}
              </div>
            </div>
          </div>
        )}

        {/* Generating indicator */}
        {isGenerating && (
          <div
            style={{
              position: 'absolute',
              bottom: 16,
              left: '50%',
              transform: 'translateX(-50%)',
              backgroundColor: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 20,
              padding: '6px 14px',
              fontSize: 12,
              color: 'var(--text2)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              boxShadow: 'var(--shadow)',
              pointerEvents: 'none'
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                backgroundColor: 'var(--accent)',
                animation: 'cursor-blink 0.9s steps(1) infinite',
                display: 'inline-block'
              }}
            />
            {t('dag_canvas.generating')}
          </div>
        )}
      </div>

      {/* Node sidebar */}
      {renderedBubbleNode && (
        <NodeBubble
          node={renderedBubbleNode}
          allNodes={nodes}
          onClose={() => selectNode(null)}
          onSaveEdits={handleSaveNodeEdits}
          onDeleteNode={handleDeleteNode}
          disabled={isGenerating || saving}
          isClosing={isNodeBubbleClosing}
        />
      )}
    </div>
  )
}
