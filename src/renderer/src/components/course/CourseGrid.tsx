import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCourseStore } from '../../stores/course.store';
import { useAppStore } from '../../stores/app.store';
import { CourseCard } from './CourseCard';
import { CourseInfoModal } from './CourseInfoModal';
import { showToast } from '../ui/ToastViewport';
import type { Course } from '@shared/types';

export const CourseGrid: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const courses = useCourseStore((s) => s.courses);
  const deleteCourse = useCourseStore((s) => s.deleteCourse);
  const setCurrentCourse = useAppStore((s) => s.setCurrentCourse);

  const handleDelete = (id: string) => {
    // Optimistic removal happens in the store; surface a toast (and restore) on failure.
    void deleteCourse(id).catch(() => {
      showToast({ kind: 'error', text: t('course_card.delete_failed') });
    });
  };

  const [newModalOpen, setNewModalOpen]       = useState(false);
  const [editingCourse, setEditingCourse]     = useState<Course | null>(null);

  const handleCourseClick = (id: string) => {
    setCurrentCourse(id);
    navigate('/dag');
  };

  return (
    <>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, 260px)',
        gap: 16,
        marginTop: 26,
      }}>
        <NewCourseCardButton onClick={() => setNewModalOpen(true)} staggerIndex={0} />

        {courses.map((course, index) => (
          <CourseCard
            key={course.id}
            course={course}
            staggerIndex={index + 1}
            onClick={() => handleCourseClick(course.id)}
            onDelete={() => handleDelete(course.id)}
            onEdit={() => setEditingCourse(course)}
          />
        ))}
      </div>

      {/* New course modal */}
      <CourseInfoModal
        isOpen={newModalOpen}
        onClose={() => setNewModalOpen(false)}
      />

      {/* Edit course info modal */}
      <CourseInfoModal
        isOpen={editingCourse !== null}
        onClose={() => setEditingCourse(null)}
        course={editingCourse}
      />
    </>
  );
};

// ── Inline new-course button card ─────────────────────────────────────────────

type StaggerStyle = React.CSSProperties & { '--ui-stagger-delay'?: string };

const NewCourseCardButton: React.FC<{ onClick: () => void; staggerIndex?: number }> = ({ onClick, staggerIndex = 0 }) => {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  return (
    <button
      className="ui-stagger-item ui-pressable"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => { setHovered(false); setPressed(false); }}
      style={{
        width: 260, height: 180,
        backgroundColor: hovered ? 'var(--accent-s)' : 'var(--app-workspace-card-bg-strong, var(--surface))',
        border: `1.5px dashed ${hovered ? 'var(--accent)' : 'var(--border2)'}`,
        borderRadius: 'var(--r2)', cursor: 'pointer',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 10,
        color: hovered ? 'var(--accent)' : 'var(--text3)',
        transition: 'border-color 0.15s, background-color 0.15s, color 0.15s, transform 0.15s, box-shadow 0.15s',
        transform: pressed ? 'translateY(1px) scale(0.995)' : hovered ? 'translateY(-1px)' : 'none',
        boxShadow: hovered ? '0 4px 12px rgba(0,0,0,0.06)' : 'none',
        flexShrink: 0,
        '--ui-stagger-delay': `${Math.min(staggerIndex, 8) * 42}ms`,
      } as StaggerStyle}
    >
      <div style={{
        width: 36, height: 36, borderRadius: '50%',
        backgroundColor: hovered ? 'var(--accent-b)' : 'var(--app-workspace-muted-bg, var(--surface2))',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background-color 0.15s, transform 0.18s ease',
        transform: hovered ? 'rotate(90deg)' : 'rotate(0deg)',
      }}>
        <Plus size={18} strokeWidth={2.5} />
      </div>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{t('new_course.button')}</span>
    </button>
  );
};
