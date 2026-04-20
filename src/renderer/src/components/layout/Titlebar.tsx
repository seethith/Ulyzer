import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/app.store';
import { useChatStore } from '../../stores/chat.store';

// Extend CSSProperties to include Electron-specific drag region property
interface ElectronCSSProperties extends React.CSSProperties {
  WebkitAppRegion?: 'drag' | 'no-drag';
}

export const Titlebar: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { breadcrumbs } = useAppStore();
  const isStreaming = useChatStore((s) => s.isStreaming);

  const safeNavigate = (path: string) => {
    if (isStreaming && !window.confirm(t('sidebar.leave_confirm'))) return;
    navigate(path);
  };

  const titlebarStyle: ElectronCSSProperties = {
    height: 40,
    backgroundColor: 'var(--topbar)',
    display: 'flex',
    alignItems: 'center',
    padding: '0 16px',
    gap: 12,
    flexShrink: 0,
    WebkitAppRegion: 'drag',
  };

  const noDragStyle: ElectronCSSProperties = {
    display: 'flex',
    gap: 6,
    WebkitAppRegion: 'no-drag',
  };

  const breadcrumbContainerStyle: ElectronCSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 13,
    color: 'var(--text2)',
    flex: 1,
    WebkitAppRegion: 'no-drag',
  };

  return (
    <div style={titlebarStyle}>
      {/* macOS traffic lights */}
      <div style={noDragStyle}>
        <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: '#ff5f57' }} />
        <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: '#febc2e' }} />
        <div style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: '#28c840' }} />
      </div>

      {/* Logo */}
      <div style={{ fontWeight: 600, fontSize: 14, marginRight: 8 }}>
        Uly<span style={{ color: 'var(--accent)' }}>zer</span>
      </div>

      {/* Breadcrumbs */}
      <div style={breadcrumbContainerStyle}>
        {breadcrumbs.map((crumb, i) => (
          <React.Fragment key={crumb.path}>
            {i > 0 && <span style={{ color: 'var(--text3)' }}>›</span>}
            {i < breadcrumbs.length - 1 ? (
              <button
                onClick={() => safeNavigate(crumb.path)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--text2)',
                  fontSize: 13,
                  padding: 0,
                }}
              >
                {crumb.label}
              </button>
            ) : (
              <span style={{ color: 'var(--text)' }}>{crumb.label}</span>
            )}
          </React.Fragment>
        ))}
      </div>

    </div>
  );
};
