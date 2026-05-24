import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCourseStore } from '../../stores/course.store';
import { useAppStore } from '../../stores/app.store';
import type { Course } from '@shared/types';

interface CourseInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** If provided, edit mode. If null/undefined, create mode. */
  course?: Course | null;
}

interface ProfileState {
  goal_text: string;
  known_topics: string;
  time_budget: string;
}

export const CourseInfoModal: React.FC<CourseInfoModalProps> = ({ isOpen, onClose, course }) => {
  const { t } = useTranslation();
  const navigate      = useNavigate();
  const createCourse  = useCourseStore((s) => s.createCourse);
  const updateCourse  = useCourseStore((s) => s.updateCourse);
  const setCurrentCourse = useAppStore((s) => s.setCurrentCourse);

  const isEdit = !!course;

  const [name,    setName]    = useState('');
  const [profile, setProfile] = useState<ProfileState>({
    goal_text: '', known_topics: '', time_budget: '',
  });
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setName(course?.name ?? '');
      setProfile({
        goal_text:    course?.goal_text    ?? '',
        known_topics: course?.known_topics ?? '',
        time_budget:  course?.time_budget  ?? '',
      });
      setError('');
      setLoading(false);
      setTimeout(() => nameRef.current?.focus(), 50);
    }
  }, [isOpen]);  

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError(t('course_info_modal.error_empty')); return; }

    setLoading(true);
    setError('');
    try {
      const profileData = {
        goal_text:    profile.goal_text.trim()    || null,
        known_topics: profile.known_topics.trim() || null,
        time_budget:  profile.time_budget.trim()  || null,
      };

      if (isEdit) {
        await updateCourse(course.id, { name: trimmed, ...profileData } as Parameters<typeof updateCourse>[1]);
        onClose();
      } else {
        const newCourse = await createCourse(trimmed);
        if (Object.values(profileData).some(Boolean)) {
          await updateCourse(newCourse.id, profileData as Parameters<typeof updateCourse>[1]);
        }
        setCurrentCourse(newCourse.id);
        onClose();
        navigate('/dag');
      }
    } catch {
      setError(isEdit ? t('course_info_modal.error_save_failed') : t('course_info_modal.error_create_failed'));
      setLoading(false);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  if (!isOpen) return null;

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '6px 10px', fontSize: 12,
    color: 'var(--text)', backgroundColor: 'var(--surface)',
    border: '1px solid var(--border)', borderRadius: 'var(--r)',
    outline: 'none', fontFamily: 'var(--sans)', boxSizing: 'border-box',
    transition: 'border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease',
  };

  return (
    <div
      className="ui-animated-backdrop"
      onClick={handleBackdropClick}
      style={{
        position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.3)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
    >
      <div className="ui-animated-modal" style={{
        backgroundColor: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--r2)', padding: 28, width: 400,
        boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
        maxHeight: '90vh', overflowY: 'auto',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>{t('course_info_modal.title')}</h2>
          <button
            className="ui-pressable"
            onClick={onClose}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text3)', padding: 4, borderRadius: 'var(--r)',
              display: 'flex', alignItems: 'center',
            }}
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          {/* Course name */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text2)', marginBottom: 5 }}>
              {t('course_info_modal.course_name')} <span style={{ color: 'var(--accent)' }}>*</span>
            </label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              placeholder={t('new_course.placeholder')}
              maxLength={80}
              style={{
                ...inputStyle, padding: '7px 10px', fontSize: 13,
                border: `1px solid ${error ? '#e57373' : 'var(--border)'}`,
              }}
              onFocus={(e) => { if (!error) e.target.style.borderColor = 'var(--accent-b)'; }}
              onBlur={(e)  => { if (!error) e.target.style.borderColor = 'var(--border)'; }}
            />
            {error && <p style={{ fontSize: 12, color: '#e57373', marginTop: 4 }}>{error}</p>}
          </div>

          {/* Profile fields */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>
              {t('course_info_modal.profile_hint')}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

              {/* goal_text */}
              <div>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>{t('course_info_modal.goal_label')}</label>
                <input
                  type="text"
                  value={profile.goal_text}
                  onChange={(e) => setProfile((p) => ({ ...p, goal_text: e.target.value }))}
                  placeholder={t('course_info_modal.goal_placeholder')}
                  style={inputStyle}
                  onFocus={(e) => { e.target.style.borderColor = 'var(--accent-b)'; }}
                  onBlur={(e)  => { e.target.style.borderColor = 'var(--border)'; }}
                />
              </div>

              {/* known_topics */}
              <div>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>{t('course_info_modal.known_label')}</label>
                <input
                  type="text"
                  value={profile.known_topics}
                  onChange={(e) => setProfile((p) => ({ ...p, known_topics: e.target.value }))}
                  placeholder={t('course_info_modal.known_placeholder')}
                  style={inputStyle}
                  onFocus={(e) => { e.target.style.borderColor = 'var(--accent-b)'; }}
                  onBlur={(e)  => { e.target.style.borderColor = 'var(--border)'; }}
                />
              </div>

              {/* time_budget */}
              <div>
                <label style={{ display: 'block', fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>{t('course_info_modal.time_label')}</label>
                <input
                  type="text"
                  value={profile.time_budget}
                  onChange={(e) => setProfile((p) => ({ ...p, time_budget: e.target.value }))}
                  placeholder={t('course_info_modal.time_placeholder')}
                  style={inputStyle}
                  onFocus={(e) => { e.target.style.borderColor = 'var(--accent-b)'; }}
                  onBlur={(e)  => { e.target.style.borderColor = 'var(--border)'; }}
                />
              </div>

            </div>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              className="ui-pressable"
              type="button"
              onClick={onClose}
              disabled={loading}
              style={{
                padding: '7px 16px', fontSize: 13, color: 'var(--text2)',
                backgroundColor: 'transparent', border: '1px solid var(--border)',
                borderRadius: 'var(--r)', cursor: 'pointer', fontFamily: 'var(--sans)',
              }}
            >
              {t('common.cancel')}
            </button>
            <button
              className="ui-pressable"
              type="submit"
              disabled={loading || !name.trim()}
              style={{
                padding: '7px 20px', fontSize: 13, fontWeight: 500, color: '#fff',
                backgroundColor: loading || !name.trim() ? 'var(--border2)' : 'var(--accent)',
                border: 'none', borderRadius: 'var(--r)',
                cursor: loading || !name.trim() ? 'not-allowed' : 'pointer',
                transition: 'background-color 0.15s', fontFamily: 'var(--sans)',
              }}
            >
              {loading ? t('common.saving') : isEdit ? t('course_info_modal.btn_save') : t('course_info_modal.btn_create')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
