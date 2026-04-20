import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { X, Clock, Wrench, ArrowRight } from 'lucide-react';
import type { DagNode } from '@shared/types';
import { useAppStore } from '../../stores/app.store';

const STATUS_KEYS: Record<string, string> = {
  locked:    'dag_node.status_locked',
  available: 'dag_node.status_available',
  active:    'dag_node.status_active',
  done:      'dag_node.status_done',
};

const DIFFICULTY_KEYS: Record<string, string> = {
  beginner:     'dag_node.difficulty_beginner',
  intermediate: 'dag_node.difficulty_intermediate',
  advanced:     'dag_node.difficulty_advanced',
};

const STATUS_COLOR: Record<string, string> = {
  locked:    'var(--text3)',
  available: 'var(--accent)',
  active:    'var(--accent)',
  done:      'var(--green)',
};

interface NodeBubbleProps {
  node: DagNode;
  allNodes: DagNode[];
  onClose: () => void;
}

export const NodeBubble: React.FC<NodeBubbleProps> = ({ node, allNodes, onClose }) => {
  const navigate      = useNavigate();
  const { t }         = useTranslation();
  const setCurrentNode = useAppStore((s) => s.setCurrentNode);

  const prereqNodes = allNodes.filter((n) => node.prerequisites.includes(n.id));

  const handleEnter = () => {
    if (node.status === 'locked') return;
    setCurrentNode(node.id);
    navigate('/node');
  };

  return (
    <div
      style={{
        width: 256,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: 'var(--surface)',
        borderLeft: '1px solid var(--border)',
        animation: 'sidebarSlideIn 180ms ease',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{
        padding: '12px 14px 10px',
        backgroundColor: 'var(--topbar)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 8,
        flexShrink: 0,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 4 }}>
            {node.chapter}
          </div>
          <div style={{
            fontSize: 14, fontWeight: 600, color: 'var(--text)', lineHeight: 1.3,
            wordBreak: 'break-word',
          }}>
            {node.name}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text3)', padding: 2, flexShrink: 0,
            display: 'flex', alignItems: 'center', borderRadius: 4,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text3)'; }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
        {/* Status & difficulty */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
          <Tag color={STATUS_COLOR[node.status]}>{STATUS_KEYS[node.status] ? t(STATUS_KEYS[node.status] as Parameters<typeof t>[0]) : node.status}</Tag>
          <Tag color="var(--text3)">{DIFFICULTY_KEYS[node.difficulty] ? t(DIFFICULTY_KEYS[node.difficulty] as Parameters<typeof t>[0]) : node.difficulty}</Tag>
        </div>

        {/* Description — full text, no clamp */}
        {node.description && (
          <p style={{
            fontSize: 12, color: 'var(--text2)', lineHeight: 1.6,
            margin: '0 0 12px', wordBreak: 'break-word',
          }}>
            {node.description}
          </p>
        )}

        <div style={{
          height: 1, backgroundColor: 'var(--border)', margin: '0 0 10px',
        }} />

        {/* Hours */}
        <InfoRow icon={<Clock size={11} />} label={t('dag_node.hours_est', { count: node.hours_est })} />

        {/* Required tools */}
        {node.required_tools.length > 0 && (
          <InfoRow
            icon={<Wrench size={11} />}
            label={node.required_tools.join('、')}
          />
        )}

        {/* Prerequisites */}
        {prereqNodes.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 6 }}>
              {t('dag_node.prerequisites')}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {prereqNodes.map((p) => (
                <span
                  key={p.id}
                  style={{
                    fontSize: 10,
                    padding: '2px 7px',
                    backgroundColor: 'var(--surface2)',
                    border: '1px solid var(--border)',
                    borderRadius: 3,
                    color: 'var(--text2)',
                  }}
                >
                  {p.name}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer — always visible */}
      <div style={{
        padding: '10px 14px 14px',
        borderTop: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <button
          onClick={handleEnter}
          disabled={node.status === 'locked'}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            padding: '8px 0',
            backgroundColor: node.status === 'locked' ? 'var(--surface2)' : 'var(--accent)',
            color: node.status === 'locked' ? 'var(--text3)' : '#fff',
            border: 'none',
            borderRadius: 'var(--r)',
            fontSize: 12,
            fontWeight: 600,
            cursor: node.status === 'locked' ? 'not-allowed' : 'pointer',
            fontFamily: 'var(--sans)',
            transition: 'opacity 0.15s',
          }}
          onMouseEnter={(e) => {
            if (node.status !== 'locked')
              (e.currentTarget as HTMLButtonElement).style.opacity = '0.85';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.opacity = '1';
          }}
        >
          {node.status === 'locked' ? t('dag_node.node_locked') : t('dag_node.enter_node')}
          {node.status !== 'locked' && <ArrowRight size={12} />}
        </button>
      </div>
    </div>
  );
};

// ── Sub-components ────────────────────────────────────────────────────────────

const Tag: React.FC<{ color: string; children: React.ReactNode }> = ({ color, children }) => (
  <span style={{
    fontSize: 10, fontWeight: 500,
    padding: '2px 7px',
    backgroundColor: 'var(--surface2)',
    border: '1px solid var(--border)',
    borderRadius: 20,
    color,
  }}>
    {children}
  </span>
);

const InfoRow: React.FC<{ icon: React.ReactNode; label: string }> = ({ icon, label }) => (
  <div style={{
    display: 'flex', alignItems: 'flex-start', gap: 6,
    fontSize: 11, color: 'var(--text2)', marginBottom: 6,
  }}>
    <span style={{ color: 'var(--text3)', display: 'flex', marginTop: 1, flexShrink: 0 }}>
      {icon}
    </span>
    <span style={{ wordBreak: 'break-word', lineHeight: 1.5 }}>{label}</span>
  </div>
);
