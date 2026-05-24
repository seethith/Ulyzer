import React from 'react'
import { Handle, Position } from 'reactflow'
import type { NodeProps } from 'reactflow'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { DagNode } from '@shared/types'
import type { ChapterBox } from './dagLayout'

export type DAGNodeData = DagNode

const STATUS_COLORS: Record<string, { border: string; bg: string; dot: string; opacity: number }> =
  {
    done: {
      border: 'var(--green)',
      bg: 'color-mix(in srgb, var(--green-s) 66%, transparent)',
      dot: 'var(--green)',
      opacity: 1
    },
    active: {
      border: 'var(--accent)',
      bg: 'color-mix(in srgb, var(--accent-s) 68%, transparent)',
      dot: 'var(--accent)',
      opacity: 1
    },
    available: {
      border: 'var(--border2)',
      bg: 'color-mix(in srgb, var(--app-workspace-card-bg-strong, var(--surface)) 74%, transparent)',
      dot: 'var(--accent)',
      opacity: 1
    },
    locked: {
      border: 'color-mix(in srgb, var(--border) 70%, transparent)',
      bg: 'color-mix(in srgb, var(--app-workspace-muted-bg, var(--surface2)) 54%, transparent)',
      dot: 'color-mix(in srgb, var(--border2) 58%, transparent)',
      opacity: 0.38
    }
  }

const TYPE_ACCENT: Record<string, string> = {
  boss: 'var(--amber)',
  main: ''
}

const DIFFICULTY_KEYS: Record<string, string> = {
  beginner: 'dag_node.difficulty_beginner',
  intermediate: 'dag_node.difficulty_intermediate',
  advanced: 'dag_node.difficulty_advanced'
}

function nodeHandleStyle(color: string): React.CSSProperties {
  return {
    background: color,
    width: 13,
    height: 13,
    border: '2px solid color-mix(in srgb, var(--app-workspace-card-bg-strong, var(--surface)) 84%, transparent)',
    boxShadow: '0 0 0 1px var(--border), var(--shadow)',
    zIndex: 5
  }
}

function chapterHandleStyle(color: string): React.CSSProperties {
  return {
    background: color,
    width: 18,
    height: 18,
    border: '3px solid color-mix(in srgb, var(--app-workspace-card-bg-strong, var(--surface)) 84%, transparent)',
    boxShadow: '0 0 0 1px var(--border), var(--shadow)',
    opacity: 0.9,
    pointerEvents: 'auto',
    zIndex: 6
  }
}

export const DAGNodeComponent: React.FC<NodeProps<DAGNodeData>> = ({ data, selected }) => {
  const { t } = useTranslation()
  const [hovered, setHovered] = React.useState(false)
  const [selectedFlash, setSelectedFlash] = React.useState(false)
  const colors = STATUS_COLORS[data.status] ?? STATUS_COLORS.locked
  const isLocked = data.status === 'locked'
  const typeAccent = TYPE_ACCENT[data.node_type] ?? ''

  const hoverAccent = typeAccent || 'var(--accent)'
  const borderColor = selected ? 'var(--accent)' : hovered ? hoverAccent : typeAccent || colors.border

  const bgColor = selected
    ? 'color-mix(in srgb, var(--accent-s) 76%, transparent)'
    : hovered
      ? `color-mix(in srgb, ${colors.bg} 84%, var(--app-workspace-card-bg-strong, var(--surface)))`
      : colors.bg
  const boxShadow = selected
    ? '0 0 0 3px color-mix(in srgb, var(--accent-s) 58%, transparent), 0 8px 18px rgba(0,0,0,0.10), var(--shadow)'
    : hovered
      ? '0 8px 20px rgba(0,0,0,0.10), 0 0 0 3px color-mix(in srgb, var(--accent-s) 46%, transparent), var(--shadow)'
      : '0 4px 12px rgba(0,0,0,0.055), 0 0 0 1px rgba(255,255,255,0.10)'
  const opacity = isLocked ? (hovered ? 0.52 : colors.opacity) : hovered ? Math.max(colors.opacity, 0.78) : colors.opacity

  React.useEffect(() => {
    if (!selected) return
    setSelectedFlash(true)
    const timer = window.setTimeout(() => setSelectedFlash(false), 380)
    return () => window.clearTimeout(timer)
  }, [data.id, selected])

  return (
    <div
      className={`ui-dag-node-in${selectedFlash ? ' ui-dag-node-selected-flash' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 180,
        padding: '10px 12px',
        backgroundColor: bgColor,
        border: `1.5px solid ${borderColor}`,
        borderRadius: 'var(--r2)',
        boxShadow,
        opacity,
        backdropFilter: 'blur(5px) saturate(108%)',
        WebkitBackdropFilter: 'blur(5px) saturate(108%)',
        cursor: 'pointer',
        fontFamily: 'var(--sans)',
        position: 'relative',
        transform: hovered && !selected ? 'translateY(-1px)' : 'translateY(0)',
        transition: 'background-color 0.15s, border-color 0.15s, box-shadow 0.15s, opacity 0.15s, transform 0.15s',
        userSelect: 'none'
      }}
    >
      {/* Target handle (left) */}
      <Handle
        type="target"
        position={Position.Left}
        style={nodeHandleStyle(borderColor)}
      />

      {/* Chapter label */}
      <div
        className={data.status === 'active' ? 'ui-soft-pulse' : undefined}
        style={{
          fontSize: 10,
          color: typeAccent || 'var(--text3)',
          fontWeight: 600,
          letterSpacing: '0.03em',
          marginBottom: 4,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {data.node_type === 'boss' ? t('dag_node.boss_label') : data.chapter}
      </div>

      {/* Node name */}
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--text)',
          lineHeight: 1.4,
          marginBottom: 6,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical'
        }}
      >
        {data.name}
      </div>

      {/* Meta row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 10,
          color: 'var(--text3)'
        }}
      >
        <span>
          {DIFFICULTY_KEYS[data.difficulty]
            ? t(DIFFICULTY_KEYS[data.difficulty] as Parameters<typeof t>[0])
            : data.difficulty}
        </span>
      </div>

      {/* Status dot (top-right) */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          width: 7,
          height: 7,
          borderRadius: '50%',
          backgroundColor: colors.dot,
          boxShadow: '0 0 0 2px color-mix(in srgb, var(--app-workspace-card-bg-strong, var(--surface)) 86%, transparent)'
        }}
      />

      {/* Source handle (right) */}
      <Handle
        type="source"
        position={Position.Right}
        style={nodeHandleStyle(borderColor)}
      />
    </div>
  )
}

// ── Chapter group background node ─────────────────────────────────────────────

export const ChapterGroupNode: React.FC<NodeProps<ChapterBox>> = ({ data }) => (
  <ChapterGroupContent data={data} />
)

const ChapterGroupContent: React.FC<{ data: ChapterBox }> = ({ data }) => {
  const { t } = useTranslation()
  const progress = data.nodeCount > 0 ? Math.round((data.doneCount / data.nodeCount) * 100) : 0

  return (
    <div
      className="ui-chapter-group-in"
      style={{
        width: data.width,
        height: data.height,
        borderRadius: 'var(--r2)',
        border: '1px solid color-mix(in srgb, var(--border2) 62%, transparent)',
        backgroundColor: 'color-mix(in srgb, var(--app-workspace-card-bg, var(--surface)) 34%, transparent)',
        boxShadow: data.collapsed ? '0 6px 18px rgba(0,0,0,0.06)' : 'inset 0 0 0 1px rgba(255,255,255,0.08)',
        // No backdrop-filter here: this full-chapter panel sits in front of the
        // intra-chapter edges and edge delete buttons, so a blur would fuzz them
        // (inter-chapter edges in the gaps stayed sharp). The translucent panel
        // still groups the chapter visually; node cards keep their own frost.
        fontFamily: 'var(--sans)',
        overflow: 'hidden',
        pointerEvents: 'none',
        transition: 'width 180ms ease, height 180ms ease, box-shadow 160ms ease, border-color 160ms ease'
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        title={t('dag_canvas.chapter_target_handle')}
        style={chapterHandleStyle('var(--accent)')}
      />
      <Handle
        type="source"
        position={Position.Right}
        title={t('dag_canvas.chapter_source_handle')}
        style={chapterHandleStyle('var(--accent)')}
      />
      <div
        className="chapter-group-drag-handle"
        title={t('dag_canvas.drag_chapter')}
        style={{
          height: 34,
          padding: '0 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderBottom: data.collapsed ? 'none' : '1px solid color-mix(in srgb, var(--border) 72%, transparent)',
          backgroundColor: 'color-mix(in srgb, var(--app-workspace-card-bg-strong, var(--surface)) 68%, transparent)',
          cursor: data.draggable === false ? 'default' : 'grab',
          pointerEvents: 'auto'
        }}
      >
        <button
          className="nodrag nopan ui-pressable"
          onClick={(event) => {
            event.stopPropagation()
            data.onToggle?.(data.chapter)
          }}
          title={data.collapsed ? t('dag_canvas.expand_chapter') : t('dag_canvas.collapse_chapter')}
          style={{
            width: 22,
            height: 22,
            border: '1px solid var(--border)',
            borderRadius: 6,
            backgroundColor: 'color-mix(in srgb, var(--app-workspace-bg, var(--bg)) 62%, transparent)',
            color: 'var(--text2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            padding: 0,
            flexShrink: 0
          }}
        >
          {data.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        <div
          style={{
            minWidth: 0,
            flex: 1,
            display: 'flex',
            alignItems: 'baseline',
            gap: 8
          }}
        >
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {data.chapter}
          </span>
          <span style={{ fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap' }}>
            {t('dag_canvas.chapter_stats', {
              done: data.doneCount,
              total: data.nodeCount,
              optional: data.optionalCount,
              boss: data.bossCount
            })}
          </span>
        </div>
        <div
          style={{
            width: 62,
            height: 6,
            borderRadius: 99,
            backgroundColor: 'color-mix(in srgb, var(--app-workspace-muted-bg, var(--surface2)) 52%, transparent)',
            overflow: 'hidden',
            flexShrink: 0
          }}
        >
          <div
            style={{
              width: `${progress}%`,
              height: '100%',
              borderRadius: 99,
              backgroundColor: 'var(--accent)',
              transition: 'width 220ms ease'
            }}
          />
        </div>
      </div>
    </div>
  )
}
