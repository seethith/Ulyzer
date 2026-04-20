import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCourseStore } from '../../stores/course.store';
import { useAppStore } from '../../stores/app.store';
import { CourseCard } from './CourseCard';
import { CourseInfoModal } from './CourseInfoModal';
import type { Course } from '@shared/types';

export const CourseGrid: React.FC = () => {
  const navigate = useNavigate();
  const courses = useCourseStore((s) => s.courses);
  const deleteCourse = useCourseStore((s) => s.deleteCourse);
  const setCurrentCourse = useAppStore((s) => s.setCurrentCourse);

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
        gridTemplateColumns: 'repeat(auto-fill, 158px)',
        gap: 14,
        marginTop: 24,
      }}>
        <NewCourseCardButton onClick={() => setNewModalOpen(true)} />

        {courses.map((course) => (
          <CourseCard
            key={course.id}
            course={course}
            onClick={() => handleCourseClick(course.id)}
            onDelete={() => deleteCourse(course.id)}
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

const NewCourseCardButton: React.FC<{ onClick: () => void }> = ({ onClick }) => {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 158, height: 158,
        backgroundColor: hovered ? 'var(--accent-s)' : 'var(--surface)',
        border: `1.5px dashed ${hovered ? 'var(--accent)' : 'var(--border2)'}`,
        borderRadius: 'var(--r2)', cursor: 'pointer',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 8,
        color: hovered ? 'var(--accent)' : 'var(--text3)',
        transition: 'all 0.15s', flexShrink: 0,
      }}
    >
      <div style={{
        width: 32, height: 32, borderRadius: '50%',
        backgroundColor: hovered ? 'var(--accent-b)' : 'var(--surface2)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background-color 0.15s',
      }}>
        <Plus size={16} strokeWidth={2.5} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 500 }}>{t('new_course.button')}</span>
    </button>
  );
};
