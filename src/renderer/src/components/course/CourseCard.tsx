import React, { useState } from 'react';
import { ArrowRight, Trash2, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Course, CourseStatus } from '@shared/types';

interface CourseCardProps {
  course: Course;
  onClick: () => void;
  onDelete: () => void;
  onEdit: () => void;
  staggerIndex?: number;
}

const STATUS_DOT: Record<CourseStatus, string> = {
  active:   'var(--accent)',
  done:     'var(--green)',
  planning: 'var(--amber)',
  new:      'var(--border2)',
};

function formatDate(iso: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return t('course_card.today');
  if (days === 1) return t('course_card.yesterday');
  if (days < 7) return t('course_card.days_ago', { count: days });
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

type CardStyle = React.CSSProperties & { '--ui-stagger-delay'?: string };

export const CourseCard: React.FC<CourseCardProps> = ({ course, onClick, onDelete, onEdit, staggerIndex = 0 }) => {
  const { t } = useTranslation();
  const [hovered, setHovered]       = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pressed, setPressed]       = useState(false);

  const progress = course.total_nodes > 0
    ? course.done_nodes / course.total_nodes
    : 0;
  const progressPercent = Math.round(progress * 100);
  const statusLabel = course.status !== 'new'
    ? t(`course_card.status_${course.status}`)
    : t('course_card.status_new');
  const supportingText = course.goal_text?.trim() || course.description?.trim() || t('course_card.no_goal');

  return (
    <div
      className="ui-course-card ui-stagger-item"
      onClick={confirming ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseDown={() => { if (!confirming) setPressed(true); }}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => { setHovered(false); setConfirming(false); setPressed(false); }}
      style={{
        width: 260,
        height: 180,
        backgroundColor: confirming ? 'var(--red-s, #fef2f2)' : 'var(--app-workspace-card-bg-strong, var(--surface))',
        border: `1px solid ${confirming ? 'var(--red, #ef4444)' : hovered ? 'var(--border2)' : 'var(--border)'}`,
        borderRadius: 'var(--r2)',
        padding: '16px',
        cursor: confirming ? 'default' : 'pointer',
        userSelect: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        boxShadow: hovered && !confirming ? '0 7px 18px rgba(0,0,0,0.09)' : 'var(--shadow)',
        transform: pressed && !confirming
          ? 'translateY(1px) scale(0.995)'
          : hovered && !confirming
            ? 'translateY(-1px)'
            : 'none',
        transition: 'box-shadow 0.15s, transform 0.15s, border-color 0.15s, background-color 0.15s',
        position: 'relative',
        '--ui-stagger-delay': `${Math.min(staggerIndex, 8) * 42}ms`,
      } as CardStyle}
    >
      {/* Top-right: status dot / action buttons */}
      {confirming ? null : hovered ? (
        <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', gap: 2 }}>
          <button
            className="ui-pressable"
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            title={t('course_card.edit')}
            style={iconBtnStyle}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--app-workspace-muted-bg, var(--surface2))'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text2)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text3)'; }}
          >
            <Pencil size={11} />
          </button>
          <button
            className="ui-pressable"
            onClick={(e) => { e.stopPropagation(); setConfirming(true); }}
            title={t('course_card.delete')}
            style={iconBtnStyle}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--red, #ef4444)'; (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text3)'; }}
          >
            <Trash2 size={11} />
          </button>
        </div>
      ) : (
        <div style={{
          position: 'absolute', top: 16, right: 16,
          width: 8, height: 8, borderRadius: '50%',
          backgroundColor: STATUS_DOT[course.status], flexShrink: 0,
        }} />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 76 }}>
        <div style={{
          fontSize: 15,
          fontWeight: 700,
          color: 'var(--text)',
          lineHeight: 1.35,
          paddingRight: 28,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {course.name}
        </div>

        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minWidth: 0,
        }}>
          <span style={{
            fontSize: 11,
            lineHeight: '20px',
            height: 20,
            padding: '0 8px',
            borderRadius: 999,
            backgroundColor: course.status === 'active' ? 'var(--accent-s)' : 'var(--app-workspace-muted-bg, var(--surface2))',
            border: '1px solid var(--border)',
            color: course.status === 'active' ? 'var(--accent)' : 'var(--text2)',
            fontWeight: course.status === 'active' ? 600 : 500,
            flexShrink: 0,
          }}>
            {statusLabel}
          </span>
          <span style={{
            fontSize: 12,
            color: 'var(--text3)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {supportingText}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>{t('course_card.progress')}</span>
          <span style={{ fontSize: 12, color: 'var(--text2)', fontFamily: 'var(--mono)', fontWeight: 600 }}>
            {course.done_nodes}/{course.total_nodes} · {progressPercent}%
          </span>
        </div>
        <div style={{
          height: 5,
          backgroundColor: 'var(--border)',
          borderRadius: 999,
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%',
            width: `${progressPercent}%`,
            backgroundColor: course.status === 'done' ? 'var(--green)' : 'var(--accent)',
            borderRadius: 999,
            transition: 'width 0.3s',
          }} className="ui-progress-fill" />
        </div>
      </div>

      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 'auto',
      }}>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>
          {formatDate(course.updated_at, t)}
        </span>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 12,
          fontWeight: 600,
          color: hovered ? 'var(--accent)' : 'var(--text2)',
          transition: 'color 0.15s',
        }}>
          {t('course_card.continue_learning')}
          <ArrowRight className="ui-course-arrow" size={12} />
        </span>
      </div>

      {/* Confirmation overlay */}
      {confirming && (
        <div
          className="ui-scale-in"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 'var(--r2)',
            backgroundColor: 'var(--red-s, #fef2f2)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            padding: 20,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--red, #ef4444)', textAlign: 'center' }}>
            {t('course_card.confirm_delete')}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text3)', textAlign: 'center', lineHeight: 1.4 }}>
            {t('course_card.delete_warning')}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="ui-pressable"
              onClick={(e) => { e.stopPropagation(); setConfirming(false); }}
              style={{
                padding: '4px 10px',
                fontSize: 12,
                border: '1px solid var(--border2)',
                borderRadius: 'var(--r)',
                backgroundColor: 'var(--app-workspace-card-bg-strong, var(--surface))',
                color: 'var(--text2)',
                cursor: 'pointer',
              }}
            >
              {t('common.cancel')}
            </button>
            <button
              className="ui-pressable"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              style={{
                padding: '4px 10px',
                fontSize: 12,
                border: 'none',
                borderRadius: 'var(--r)',
                backgroundColor: 'var(--red, #ef4444)',
                color: '#fff',
                cursor: 'pointer',
                fontWeight: 500,
              }}
            >
              {t('common.delete')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const iconBtnStyle: React.CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: 'var(--r)',
  border: 'none',
  backgroundColor: 'transparent',
  color: 'var(--text3)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  transition: 'background-color 0.1s, color 0.1s',
};
