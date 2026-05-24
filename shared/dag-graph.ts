export interface NormalizeDagEdgesReport {
  droppedDuplicateEdges: number
  droppedUnknownEdges: number
  droppedSelfLoops: number
  droppedCycleEdges: number
  droppedTransitiveEdges: number
}

export interface NormalizeDagEdgesOptions<N, E> {
  getNodeId?: (node: N) => string
  getSource: (edge: E) => string
  getTarget: (edge: E) => string
}

export interface NormalizeDagEdgesResult<E> {
  edges: E[]
  report: NormalizeDagEdgesReport
}

export function normalizeDagEdges<N extends { id: string }, E>(
  nodes: N[],
  edges: E[],
  options: NormalizeDagEdgesOptions<N, E>
): NormalizeDagEdgesResult<E> {
  const getNodeId = options.getNodeId ?? ((node: N) => node.id)
  const nodeIds = new Set(nodes.map(getNodeId))
  const seen = new Set<string>()
  const accepted: E[] = []
  const simpleEdges: Array<{ source: string; target: string }> = []
  const report: NormalizeDagEdgesReport = {
    droppedDuplicateEdges: 0,
    droppedUnknownEdges: 0,
    droppedSelfLoops: 0,
    droppedCycleEdges: 0,
    droppedTransitiveEdges: 0
  }

  for (const edge of edges) {
    const source = options.getSource(edge)
    const target = options.getTarget(edge)
    if (!nodeIds.has(source) || !nodeIds.has(target)) {
      report.droppedUnknownEdges += 1
      continue
    }
    if (source === target) {
      report.droppedSelfLoops += 1
      continue
    }
    const key = `${source}->${target}`
    if (seen.has(key)) {
      report.droppedDuplicateEdges += 1
      continue
    }
    const candidate = [...simpleEdges, { source, target }]
    if (!isAcyclic([...nodeIds], candidate)) {
      report.droppedCycleEdges += 1
      continue
    }
    seen.add(key)
    accepted.push(edge)
    simpleEdges.push({ source, target })
  }

  const keepIndexes = new Set<number>()
  simpleEdges.forEach((_edge, index) => keepIndexes.add(index))

  for (let index = 0; index < simpleEdges.length; index += 1) {
    const edge = simpleEdges[index]
    const otherEdges = simpleEdges.filter((_, otherIndex) => otherIndex !== index)
    if (isReachable(edge.source, edge.target, otherEdges)) {
      keepIndexes.delete(index)
      report.droppedTransitiveEdges += 1
    }
  }

  return {
    edges: accepted.filter((_, index) => keepIndexes.has(index)),
    report
  }
}

function isAcyclic(nodeIds: string[], edges: Array<{ source: string; target: string }>): boolean {
  const inDegree = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  for (const id of nodeIds) {
    inDegree.set(id, 0)
    outgoing.set(id, [])
  }

  for (const edge of edges) {
    outgoing.get(edge.source)?.push(edge.target)
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
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

  return visited === nodeIds.length
}

function isReachable(
  source: string,
  target: string,
  edges: Array<{ source: string; target: string }>
): boolean {
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    const current = outgoing.get(edge.source) ?? []
    current.push(edge.target)
    outgoing.set(edge.source, current)
  }

  const visited = new Set<string>()
  const stack = [...(outgoing.get(source) ?? [])]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === target) return true
    if (visited.has(id)) continue
    visited.add(id)
    stack.push(...(outgoing.get(id) ?? []))
  }
  return false
}
