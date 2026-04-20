import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { useCourseStore } from '../../stores/course.store';
import { useAppStore } from '../../stores/app.store';

interface NewCourseModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const NewCourseModal: React.FC<NewCourseModalProps> = ({ isOpen, onClose }) => {
  const navigate = useNavigate();
  const createCourse = useCourseStore((s) => s.createCourse);
  const setCurrentCourse = useAppStore((s) => s.setCurrentCourse);

  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setName('');
      setError('');
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('请输入课程名称');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const course = await createCourse(trimmed);
      setCurrentCourse(course.id);
      onClose();
      navigate('/dag');
    } catch {
      setError('创建失败，请重试');
      setLoading(false);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  if (!isOpen) return null;

  return (
    <div
      onClick={handleBackdropClick}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.3)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div style={{
        backgroundColor: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r2)',
        padding: 28,
        width: 380,
        boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>新建课程</h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text3)',
              padding: 4,
              borderRadius: 'var(--r)',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 20 }}>
            <label style={{
              display: 'block',
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--text2)',
              marginBottom: 6,
            }}>
              课程名称
            </label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              placeholder="例：Python 机器学习入门"
              maxLength={80}
              style={{
                width: '100%',
                padding: '8px 12px',
                fontSize: 14,
                color: 'var(--text)',
                backgroundColor: 'var(--surface)',
                border: `1px solid ${error ? '#e57373' : 'var(--border)'}`,
                borderRadius: 'var(--r)',
                outline: 'none',
                fontFamily: 'var(--sans)',
              }}
              onFocus={(e) => {
                if (!error) e.target.style.borderColor = 'var(--accent-b)';
              }}
              onBlur={(e) => {
                if (!error) e.target.style.borderColor = 'var(--border)';
              }}
            />
            {error && (
              <p style={{ fontSize: 12, color: '#e57373', marginTop: 4 }}>{error}</p>
            )}
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              style={{
                padding: '7px 16px',
                fontSize: 13,
                color: 'var(--text2)',
                backgroundColor: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r)',
                cursor: 'pointer',
                fontFamily: 'var(--sans)',
              }}
            >
              取消
            </button>
            <button
              type="submit"
              disabled={loading || !name.trim()}
              style={{
                padding: '7px 20px',
                fontSize: 13,
                fontWeight: 500,
                color: '#fff',
                backgroundColor: loading || !name.trim() ? 'var(--border2)' : 'var(--accent)',
                border: 'none',
                borderRadius: 'var(--r)',
                cursor: loading || !name.trim() ? 'not-allowed' : 'pointer',
                transition: 'background-color 0.15s',
                fontFamily: 'var(--sans)',
              }}
            >
              {loading ? '创建中…' : '新建课程'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
