import React from 'react'
import { useTranslation } from 'react-i18next'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from 'reactflow'
import { Trash2 } from 'lucide-react'

export interface DAGEdgeData {
  onDelete?: (edgeId: string) => void
  label?: string
  underlyingEdgeIds?: string[]
  edgeKind?: 'node' | 'chapter'
  emphasis?: 'normal' | 'dimmed' | 'highlighted' | 'selected' | 'chapter'
}

export const DAGEdgeComponent: React.FC<EdgeProps<DAGEdgeData>> = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  selected,
  data,
  interactionWidth
}) => {
  const { t } = useTranslation()
  const edgeKind = data?.edgeKind ?? 'node'
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: edgeKind === 'chapter' ? 0.38 : 0.22
  })
  const emphasis = data?.emphasis ?? (selected ? 'selected' : 'normal')
  const isFlowing = emphasis === 'selected' || emphasis === 'highlighted'

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        interactionWidth={interactionWidth ?? 18}
        style={{
          ...style,
          strokeWidth: selected ? 3 : style?.strokeWidth,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          strokeDasharray: isFlowing ? style?.strokeDasharray ?? '8 9' : style?.strokeDasharray,
          animation: isFlowing ? 'uiEdgeFlow 850ms linear infinite' : 'uiEdgeDraw 360ms ease both'
        }}
      />
      {selected && data?.onDelete && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
            }}
          >
            <div
              className="ui-edge-label-pop"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: 3,
                border: '1px solid var(--border)',
                borderRadius: 999,
                backgroundColor: 'var(--surface)',
                boxShadow: 'var(--shadow)'
              }}
            >
              <button
                className="ui-pressable"
                type="button"
                title={data?.label ?? t('dag_canvas.edge_delete')}
                onClick={(event) => {
                  event.stopPropagation()
                  data?.onDelete?.(id)
                }}
                style={{
                  width: 24,
                  height: 24,
                  border: 'none',
                  borderRadius: '50%',
                  backgroundColor: 'var(--amber-s)',
                  color: '#b45309',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  padding: 0
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
