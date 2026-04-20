import React, { useState } from 'react';
import { Trash2, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Course, CourseStatus } from '@shared/types';

interface CourseCardProps {
  course: Course;
  onClick: () => void;
  onDelete: () => void;
  onEdit: () => void;
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

export const CourseCard: React.FC<CourseCardProps> = ({ course, onClick, onDelete, onEdit }) => {
  const { t } = useTranslation();
  const [hovered, setHovered]       = useState(false);
  const [confirming, setConfirming] = useState(false);

  const progress = course.total_nodes > 0
    ? course.done_nodes / course.total_nodes
    : 0;

  return (
    <div
      onClick={confirming ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setConfirming(false); }}
      style={{
        width: 158,
        backgroundColor: confirming ? 'var(--red-s, #fef2f2)' : 'var(--surface)',
        border: `1px solid ${confirming ? 'var(--red, #ef4444)' : hovered ? 'var(--border2)' : 'var(--border)'}`,
        borderRadius: 'var(--r2)',
        padding: '14px 14px 12px',
        cursor: confirming ? 'default' : 'pointer',
        userSelect: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        boxShadow: hovered && !confirming ? '0 4px 12px rgba(0,0,0,0.08)' : 'var(--shadow)',
        transform: hovered && !confirming ? 'translateY(-1px)' : 'none',
        transition: 'box-shadow 0.15s, transform 0.15s, border-color 0.15s, background-color 0.15s',
        position: 'relative',
      }}
    >
      {/* Top-right: status dot / action buttons */}
      {confirming ? null : hovered ? (
        <div style={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 2 }}>
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            title={t('course_card.edit')}
            style={iconBtnStyle}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface2)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text2)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text3)'; }}
          >
            <Pencil size={11} />
          </button>
          <button
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
          position: 'absolute', top: 12, right: 12,
          width: 7, height: 7, borderRadius: '50%',
          backgroundColor: STATUS_DOT[course.status], flexShrink: 0,
        }} />
      )}

      {/* Course name */}
      <div style={{
        fontSize: 13, fontWeight: 600, color: 'var(--text)', lineHeight: 1.4,
        paddingRight: 14, display: '-webkit-box', WebkitLineClamp: 3,
        WebkitBoxOrient: 'vertical', overflow: 'hidden', minHeight: 54,
      }}>
        {course.name}
      </div>

      {/* Progress bar */}
      <div style={{
        height: 3,
        backgroundColor: 'var(--border)',
        borderRadius: 2,
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          width: `${Math.round(progress * 100)}%`,
          backgroundColor: 'var(--green)',
          borderRadius: 2,
          transition: 'width 0.3s',
        }} />
      </div>

      {/* Footer */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 2,
      }}>
        <span style={{
          fontSize: 11,
          color: course.status === 'active' ? 'var(--accent)' : 'var(--text3)',
          fontWeight: course.status === 'active' ? 500 : 400,
        }}>
          {course.status !== 'new' ? t(`course_card.status_${course.status}`) : ''}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
          {course.done_nodes}/{course.total_nodes}
        </span>
      </div>

      {/* Updated at */}
      <div style={{ fontSize: 11, color: 'var(--text3)' }}>
        {formatDate(course.updated_at, t)}
      </div>

      {/* Confirmation overlay */}
      {confirming && (
        <div
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
            padding: 12,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--red, #ef4444)', textAlign: 'center' }}>
            {t('course_card.confirm_delete')}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text3)', textAlign: 'center', lineHeight: 1.4 }}>
            {t('course_card.delete_warning')}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={(e) => { e.stopPropagation(); setConfirming(false); }}
              style={{
                padding: '4px 10px',
                fontSize: 12,
                border: '1px solid var(--border2)',
                borderRadius: 'var(--r)',
                backgroundColor: 'var(--surface)',
                color: 'var(--text2)',
                cursor: 'pointer',
              }}
            >
              {t('common.cancel')}
            </button>
            <button
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
