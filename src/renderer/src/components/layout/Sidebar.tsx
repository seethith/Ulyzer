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
      backgroundColor: 'var(--app-chrome-sidebar-bg, var(--sidebar))',
      backdropFilter: 'var(--app-chrome-backdrop-filter, none)',
      WebkitBackdropFilter: 'var(--app-chrome-backdrop-filter, none)',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      flexShrink: 0,
      height: '100%',
    }}>
      {/* Nav icons */}
      <div style={{ ...noDragStyle, paddingTop: 10 }}>
        <button
          className="ui-pressable"
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
          className="ui-pressable"
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
  const topbarLeftAction = useAppStore((s) => s.topbarLeftAction);
  const topbarRightAction = useAppStore((s) => s.topbarRightAction);
  const isStreaming  = useChatStore((s) => s.isStreaming);

  const safeNavigate = (path: string) => {
    if (isStreaming && !window.confirm(t('sidebar.leave_confirm'))) return;
    navigate(path);
  };

  const breadcrumbWidth = 420;
  const bar: ElectronCSS = {
    height: 40,
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    position: 'relative',
    backgroundColor: 'var(--app-chrome-topbar-bg, var(--topbar))',
    backdropFilter: 'var(--app-chrome-backdrop-filter, none)',
    WebkitBackdropFilter: 'var(--app-chrome-backdrop-filter, none)',
    borderBottom: '1px solid var(--border)',
    WebkitAppRegion: 'drag',
  };
  const noDrag: ElectronCSS = { WebkitAppRegion: 'no-drag', display: 'flex', alignItems: 'center', gap: 4 };
  const actionButton = (action: NonNullable<typeof headerAction>, compact = false) => (
    <button
      className={`ui-pressable topbar-action-button ${compact ? 'topbar-action-button-compact' : 'topbar-action-button-full'}`}
      onClick={action.onClick}
      title={action.title ?? action.label}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: compact ? 0 : 5,
        minWidth: compact ? 32 : 0,
        height: compact ? 28 : 'auto',
        padding: compact ? '0 8px' : '4px 12px',
        borderRadius: 6,
        border: '1px solid var(--topbar-action-border, var(--border2))',
        background: 'var(--topbar-action-bg, var(--app-workspace-muted-bg, var(--surface2)))',
        color: 'var(--topbar-action-color, var(--text2))',
        boxShadow: 'var(--topbar-action-shadow, none)',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'var(--sans)',
        whiteSpace: 'nowrap',
        WebkitAppRegion: 'no-drag',
      } as ElectronCSS}
    >
      <span key={action.label} className="topbar-action-icon">{action.icon}</span>
      {!compact && action.label}
    </button>
  );

  return (
    <div style={bar}>
      {topbarLeftAction && (
        <div style={{ ...noDrag, position: 'absolute', left: 90, top: 0, height: '100%' }}>
          {actionButton(topbarLeftAction, true)}
        </div>
      )}

      <div
        className="topbar-breadcrumb-shell"
        style={{
          ...noDrag,
          position: 'absolute',
          left: '50%',
          top: 7,
          height: 26,
          width: breadcrumbWidth,
          transform: 'translateX(-50%)',
          justifyContent: 'center',
          overflow: 'hidden',
          boxSizing: 'border-box',
        }}
      >
        {breadcrumbs.map((crumb, i) => {
          const isLast = i === breadcrumbs.length - 1;
          return (
            <React.Fragment key={crumb.path}>
              {i > 0 && <span className="topbar-breadcrumb-separator">›</span>}
              <span
                className="topbar-breadcrumb-slot"
                style={{
                  flex: breadcrumbs.length > 1 ? '1 1 0' : '0 1 auto',
                  WebkitAppRegion: 'no-drag',
                } as ElectronCSS}
              >
                <button
                  className={`topbar-breadcrumb-button ui-pressable ${isLast ? 'topbar-breadcrumb-button-current' : ''}`}
                  onClick={() => safeNavigate(crumb.path)}
                  title={crumb.label}
                  aria-current={isLast ? 'page' : undefined}
                  style={{ WebkitAppRegion: 'no-drag' } as ElectronCSS}
                >
                  <span className="topbar-breadcrumb-label">{crumb.label}</span>
                </button>
              </span>
            </React.Fragment>
          );
        })}
      </div>

      {headerAction && (
        <div
          style={{
            ...noDrag,
            position: 'absolute',
            left: `calc(50% + ${breadcrumbWidth / 2 + 12}px)`,
            top: 0,
            height: '100%',
          }}
        >
          {actionButton(headerAction)}
        </div>
      )}

      {topbarRightAction && (
        <div style={{ ...noDrag, position: 'absolute', right: 16, top: 0, height: '100%' }}>
          {actionButton(topbarRightAction, true)}
        </div>
      )}
    </div>
  );
};
