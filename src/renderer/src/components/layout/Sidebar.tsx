import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { LayoutGrid, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/app.store';
import { useChatStore } from '../../stores/chat.store';

interface ElectronCSS extends React.CSSProperties {
  WebkitAppRegion?: 'drag' | 'no-drag';
}


export const Sidebar: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const isStreaming = useChatStore((s) => s.isStreaming);

  const safeNavigate = (path: string) => {
    if (isStreaming && !window.confirm(t('sidebar.leave_confirm'))) return;
    navigate(path);
  };
  const isCoursesActive = location.pathname === '/';

  const noDragStyle: ElectronCSS = { WebkitAppRegion: 'no-drag', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, width: '100%' };

  return (
    <div style={{
      width: 48,
      backgroundColor: 'var(--sidebar)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      flexShrink: 0,
      height: '100%',
    }}>
      {/* Nav icons */}
      <div style={{ ...noDragStyle, paddingTop: 10 }}>
        <button
          onClick={() => safeNavigate('/')}
          title={t('sidebar.my_courses')}
          style={{
            width: 36, height: 36, borderRadius: 'var(--r)', border: 'none',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            backgroundColor: isCoursesActive ? 'rgba(201,100,66,0.18)' : 'transparent',
            color: isCoursesActive ? 'var(--accent)' : 'var(--text2)',
            position: 'relative',
          }}
        >
          <LayoutGrid size={18} />
          {isCoursesActive && (
            <div style={{
              position: 'absolute', right: -8, top: '50%', transform: 'translateY(-50%)',
              width: 2, height: 20, backgroundColor: 'var(--accent)', borderRadius: 1,
            }} />
          )}
        </button>
      </div>

      {/* Bottom: settings */}
      <div style={{ marginTop: 'auto', paddingBottom: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, WebkitAppRegion: 'no-drag' } as ElectronCSS}>
        <button
          onClick={() => setSettingsOpen(true)}
          title={t('sidebar.settings')}
          style={{
            width: 36, height: 36, borderRadius: 'var(--r)', border: 'none',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            backgroundColor: 'transparent', color: 'var(--text2)',
          }}
        >
          <Settings size={18} />
        </button>
      </div>
    </div>
  );
};

export const Breadcrumbbar: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const breadcrumbs  = useAppStore((s) => s.breadcrumbs);
  const headerAction = useAppStore((s) => s.headerAction);
  const isStreaming  = useChatStore((s) => s.isStreaming);

  const safeNavigate = (path: string) => {
    if (isStreaming && !window.confirm(t('sidebar.leave_confirm'))) return;
    navigate(path);
  };

  const bar: ElectronCSS = {
    height: 40, display: 'flex', alignItems: 'center',
    paddingLeft: 90, paddingRight: 16, gap: 4, flexShrink: 0,
    backgroundColor: 'var(--topbar)',
    WebkitAppRegion: 'drag',
  };
  const noDrag: ElectronCSS = { WebkitAppRegion: 'no-drag', display: 'flex', alignItems: 'center', gap: 4 };

  return (
    <div style={bar}>
      <div style={noDrag}>
        {breadcrumbs.map((crumb, i) => (
          <React.Fragment key={crumb.path}>
            {i > 0 && <span style={{ color: 'var(--text3)', fontSize: 13, padding: '0 2px' }}>›</span>}
            {i < breadcrumbs.length - 1 ? (
              <button
                onClick={() => safeNavigate(crumb.path)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--text2)', fontSize: 13, padding: 0,
                }}
              >
                {crumb.label}
              </button>
            ) : (
              <span style={{ color: 'var(--text)', fontSize: 13, fontWeight: 500 }}>{crumb.label}</span>
            )}
          </React.Fragment>
        ))}
      </div>

      {headerAction && (
        <div style={{ ...noDrag, marginLeft: 'auto' }}>
          <button
            onClick={headerAction.onClick}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '4px 12px', borderRadius: 6,
              border: '1px solid var(--border2)',
              background: 'var(--surface2)',
              color: 'var(--text2)', fontSize: 12, fontWeight: 600,
              cursor: 'pointer', fontFamily: 'var(--sans)',
            } as ElectronCSS}
          >
            {headerAction.icon}
            {headerAction.label}
          </button>
        </div>
      )}
    </div>
  );
};
