import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../stores/app.store';
import { useCourseStore } from '../stores/course.store';
import { CourseGrid } from '../components/course/CourseGrid';

const CoursePage: React.FC = () => {
  const { t } = useTranslation();
  const setBreadcrumbs = useAppStore((s) => s.setBreadcrumbs);
  const { loadCourses, loading } = useCourseStore();

  useEffect(() => {
    setBreadcrumbs([{ label: t('sidebar.my_courses'), path: '/' }]);
    loadCourses();
  }, []);

  return (
    <div style={{ padding: '40px 40px 60px', animation: 'pageFadeIn 150ms ease' }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
        {t('course_page.title')}
      </h1>
      <p style={{ fontSize: 13, color: 'var(--text2)' }}>
        {t('course_page.subtitle')}
      </p>

      {loading ? (
        <div style={{ marginTop: 40, color: 'var(--text3)', fontSize: 13 }}>{t('common.loading')}</div>
      ) : (
        <CourseGrid />
      )}
    </div>
  );
};

export default CoursePage;
