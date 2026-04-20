import React from 'react';
import { Handle, Position } from 'reactflow';
import type { NodeProps } from 'reactflow';
import { useTranslation } from 'react-i18next';
import type { DagNode } from '@shared/types';
import type { ChapterBox } from './dagLayout';

export type DAGNodeData = DagNode;

const STATUS_COLORS: Record<string, { border: string; bg: string; dot: string; opacity: number }> = {
  done:      { border: 'var(--green)',  bg: 'var(--green-s)',  dot: 'var(--green)',  opacity: 1 },
  active:    { border: 'var(--accent)', bg: 'var(--accent-s)', dot: 'var(--accent)', opacity: 1 },
  available: { border: 'var(--border2)',bg: 'var(--surface)',  dot: 'var(--accent)', opacity: 1 },
  locked:    { border: 'var(--border)', bg: 'var(--surface2)', dot: 'var(--border2)',opacity: 0.55 },
};

const TYPE_ACCENT: Record<string, string> = {
  boss:  'var(--amber)',
  drill: 'var(--green)',
  main:  '',
};

const DIFFICULTY_KEYS: Record<string, string> = {
  beginner:     'dag_node.difficulty_beginner',
  intermediate: 'dag_node.difficulty_intermediate',
  advanced:     'dag_node.difficulty_advanced',
};

const PRIORITY_BADGE: Record<string, string> = {
  must:         '⭐',
  should:       '⚡',
  nice_to_have: '💡',
};

export const DAGNodeComponent: React.FC<NodeProps<DAGNodeData>> = ({ data, selected }) => {
  const { t } = useTranslation();
  const colors = STATUS_COLORS[data.status] ?? STATUS_COLORS.locked;
  const typeAccent = TYPE_ACCENT[data.node_type] ?? '';

  const borderColor = selected
    ? 'var(--accent)'
    : typeAccent || colors.border;

  const bgColor = selected ? 'var(--accent-s)' : colors.bg;

  return (
    <div
      style={{
        width: 180,
        padding: '10px 12px',
        backgroundColor: bgColor,
        border: `1.5px solid ${borderColor}`,
        borderRadius: 'var(--r2)',
        boxShadow: selected
          ? '0 0 0 3px var(--accent-s), var(--shadow)'
          : 'var(--shadow)',
        opacity: colors.opacity,
        cursor: 'pointer',
        fontFamily: 'var(--sans)',
        position: 'relative',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        userSelect: 'none',
      }}
    >
      {/* Target handle (top) */}
      <Handle
        type="target"
        position={Position.Top}
        style={{
          background: borderColor,
          width: 8,
          height: 8,
          border: `2px solid var(--surface)`,
        }}
      />

      {/* Chapter label */}
      <div style={{
        fontSize: 10,
        color: typeAccent || 'var(--text3)',
        fontWeight: 600,
        letterSpacing: '0.03em',
        marginBottom: 4,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {data.node_type === 'boss' ? t('dag_node.boss_label') : data.chapter}
      </div>

      {/* Node name */}
      <div style={{
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--text)',
        lineHeight: 1.4,
        marginBottom: 6,
        overflow: 'hidden',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
      }}>
        {data.name}
      </div>

      {/* Meta row */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 10,
        color: 'var(--text3)',
      }}>
        <span>{data.hours_est}h</span>
        <span>·</span>
        <span>{DIFFICULTY_KEYS[data.difficulty] ? t(DIFFICULTY_KEYS[data.difficulty] as Parameters<typeof t>[0]) : data.difficulty}</span>
        {data.priority && PRIORITY_BADGE[data.priority] && (
          <>
            <span>·</span>
            <span title={data.priority}>{PRIORITY_BADGE[data.priority]}</span>
          </>
        )}
      </div>

      {/* Status dot (top-right) */}
      <div style={{
        position: 'absolute',
        top: 8,
        right: 8,
        width: 7,
        height: 7,
        borderRadius: '50%',
        backgroundColor: colors.dot,
        boxShadow: `0 0 0 2px var(--surface)`,
      }} />

      {/* Source handle (bottom) */}
      <Handle
        type="source"
        position={Position.Bottom}
        style={{
          background: borderColor,
          width: 8,
          height: 8,
          border: `2px solid var(--surface)`,
        }}
      />
    </div>
  );
};

// ── Chapter group background node ─────────────────────────────────────────────

export const ChapterGroupNode: React.FC<NodeProps<ChapterBox>> = ({ data }) => (
  <div
    style={{
      width: data.width,
      height: data.height,
      borderRadius: 'var(--r2)',
      border: '1.5px dashed var(--border2)',
      backgroundColor: 'rgba(0,0,0,0.025)',
      pointerEvents: 'none',
    }}
  >
    <div style={{
      position: 'absolute',
      top: 6,
      left: 10,
      fontSize: 10,
      fontWeight: 600,
      color: 'var(--text3)',
      letterSpacing: '0.04em',
      fontFamily: 'var(--sans)',
    }}>
      {data.chapter}
    </div>
  </div>
);
