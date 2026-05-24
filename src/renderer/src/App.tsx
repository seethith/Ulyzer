import React, { useEffect, useState } from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Sidebar, Breadcrumbbar } from './components/layout/Sidebar';
import { SettingsModal } from './components/settings/SettingsModal';
import { UpdateBanner } from './components/update/UpdateBanner';
import { useSettingsStore } from './stores/settings.store';
import { useCourseStore } from './stores/course.store';
import { useUpdateStore } from './stores/update.store';
import CoursePage from './pages/CoursePage';
import DAGPage from './pages/DAGPage';
import NodePage from './pages/NodePage';
import { useLocalImageDataUrl } from './utils/local-image-data-url';
import './styles/globals.css';
import './styles/tailwind.css';

interface AppBackgroundProps {
  imageSrc: string;
  opacity: number;
  fit: string;
}

const STARTUP_MIN_DURATION_MS = 520;
const STARTUP_BACKGROUND_WAIT_MS = 1200;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function backgroundSizeForFit(fit: string): React.CSSProperties {
  if (fit === 'contain') {
    return { backgroundSize: 'contain', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' };
  }
  if (fit === 'center') {
    return { backgroundSize: 'auto', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' };
  }
  return { backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function translucentSurface(cssVar: string, opacity: number): string {
  return `color-mix(in srgb, ${cssVar} ${Math.round(clamp(opacity, 0, 1) * 100)}%, transparent)`;
}

const AppBackground: React.FC<AppBackgroundProps> = ({ imageSrc, opacity, fit }) => (
  <div
    aria-hidden="true"
    style={{
      position: 'fixed',
      inset: 0,
      pointerEvents: 'none',
      zIndex: 0,
      opacity,
      backgroundImage: `url("${imageSrc}")`,
      ...backgroundSizeForFit(fit),
    }}
  />
);

const StartupLoading: React.FC<{ error: string | null; onRetry: () => void }> = ({ error, onRetry }) => {
  const { t } = useTranslation();
  return (
    <div className="startup-screen">
      <div className="startup-panel">
        <div className="startup-mark" aria-hidden="true">
          <div className="startup-spinner" />
        </div>
        <div className="startup-copy">
          <div className="startup-title">Ulyzer</div>
          <div className="startup-subtitle">
            {error ? t('startup.failed') : t('startup.preparing')}
          </div>
          {error && (
            <>
              <div className="startup-error">{error}</div>
              <button className="startup-retry ui-pressable" onClick={onRetry}>
                {t('startup.retry')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const App: React.FC = () => {
  const loadSettings = useSettingsStore((s) => s.load);
  const loadCourses = useCourseStore((s) => s.loadCourses);
  const backgroundEnabled = useSettingsStore((s) => s.backgroundImageEnabled);
  const backgroundImagePath = useSettingsStore((s) => s.backgroundImagePath);
  const backgroundOpacity = useSettingsStore((s) => s.backgroundImageOpacity);
  const backgroundOverlayOpacity = useSettingsStore((s) => s.backgroundOverlayOpacity);
  const backgroundFit = useSettingsStore((s) => s.backgroundImageFit);
  const [startupReady, setStartupReady] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [backgroundWaitExpired, setBackgroundWaitExpired] = useState(false);
  const backgroundImageSrc = useLocalImageDataUrl(backgroundImagePath);
  const backgroundRendered = backgroundEnabled && Boolean(backgroundImagePath.trim()) && Boolean(backgroundImageSrc);
  const waitingForBackground = startupReady
    && backgroundEnabled
    && Boolean(backgroundImagePath.trim())
    && !backgroundImageSrc
    && !backgroundWaitExpired;
  const appReady = startupReady && !startupError && !waitingForBackground;
  const overlayOpacity = clamp(backgroundOverlayOpacity, 0, 0.85);
  const workspaceBackground = backgroundRendered ? translucentSurface('var(--bg)', overlayOpacity) : 'var(--bg)';
  const workspaceContentBackground = backgroundRendered ? 'transparent' : 'var(--bg)';
  const panelOpacity = clamp(overlayOpacity + 0.22, 0.28, 0.92);
  const cardOpacity = clamp(overlayOpacity + 0.20, 0.28, 0.94);
  const cardStrongOpacity = clamp(overlayOpacity + 0.32, 0.36, 0.96);
  const mutedOpacity = clamp(overlayOpacity + 0.12, 0.24, 0.88);
  const accentOpacity = clamp(overlayOpacity + 0.18, 0.30, 0.90);
  const topbarOpacity = clamp(overlayOpacity + 0.24, 0.34, 0.94);
  const sidebarOpacity = clamp(overlayOpacity + 0.30, 0.42, 0.96);
  const nodeDetailOpacity = clamp(overlayOpacity - 0.14, 0.18, 0.72);
  const nodeDetailHeaderOpacity = clamp(overlayOpacity - 0.04, 0.22, 0.78);
  const workspaceBackdropFilter = backgroundRendered && overlayOpacity > 0.01
    ? `blur(${Math.round(4 + overlayOpacity * 14)}px) saturate(${Math.round(104 + overlayOpacity * 18)}%)`
    : undefined;
  const workspacePanelBackground = backgroundRendered
    ? translucentSurface('var(--panel)', panelOpacity)
    : 'var(--panel)';
  const workspaceCardBackground = backgroundRendered
    ? translucentSurface('var(--surface)', cardOpacity)
    : 'var(--surface)';
  const workspaceCardStrongBackground = backgroundRendered
    ? translucentSurface('var(--surface)', cardStrongOpacity)
    : 'var(--surface)';
  const workspaceMutedBackground = backgroundRendered
    ? translucentSurface('var(--surface2)', mutedOpacity)
    : 'var(--surface2)';
  const workspaceAccentBackground = backgroundRendered
    ? translucentSurface('var(--accent-s)', accentOpacity)
    : 'var(--accent-s)';
  const workspaceTopbarBackground = backgroundRendered
    ? translucentSurface('var(--topbar)', panelOpacity)
    : 'var(--topbar)';
  const chromeTopbarBackground = backgroundRendered
    ? translucentSurface('var(--topbar)', topbarOpacity)
    : 'var(--topbar)';
  const chromeSidebarBackground = backgroundRendered
    ? translucentSurface('var(--sidebar)', sidebarOpacity)
    : 'var(--sidebar)';
  const workspaceNodeDetailBackground = backgroundRendered
    ? translucentSurface('var(--surface)', nodeDetailOpacity)
    : 'var(--surface)';
  const workspaceNodeDetailHeaderBackground = backgroundRendered
    ? translucentSurface('var(--topbar)', nodeDetailHeaderOpacity)
    : 'var(--topbar)';
  const shellStyle: React.CSSProperties & {
    '--app-workspace-bg': string;
    '--app-workspace-panel-bg': string;
    '--app-workspace-card-bg': string;
    '--app-workspace-card-bg-strong': string;
    '--app-workspace-muted-bg': string;
    '--app-workspace-accent-bg': string;
    '--app-workspace-topbar-bg': string;
    '--app-workspace-node-detail-bg': string;
    '--app-workspace-node-detail-header-bg': string;
    '--app-chrome-sidebar-bg': string;
    '--app-chrome-topbar-bg': string;
    '--app-chrome-backdrop-filter': string;
  } = {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    overflow: 'hidden',
    '--app-workspace-bg': workspaceContentBackground,
    '--app-workspace-panel-bg': workspacePanelBackground,
    '--app-workspace-card-bg': workspaceCardBackground,
    '--app-workspace-card-bg-strong': workspaceCardStrongBackground,
    '--app-workspace-muted-bg': workspaceMutedBackground,
    '--app-workspace-accent-bg': workspaceAccentBackground,
    '--app-workspace-topbar-bg': workspaceTopbarBackground,
    '--app-workspace-node-detail-bg': workspaceNodeDetailBackground,
    '--app-workspace-node-detail-header-bg': workspaceNodeDetailHeaderBackground,
    '--app-chrome-sidebar-bg': chromeSidebarBackground,
    '--app-chrome-topbar-bg': chromeTopbarBackground,
    '--app-chrome-backdrop-filter': workspaceBackdropFilter ?? 'none',
  };
  const mainStyle: React.CSSProperties = {
    flex: 1,
    overflow: 'auto',
    backgroundColor: workspaceBackground,
    backdropFilter: workspaceBackdropFilter,
    WebkitBackdropFilter: workspaceBackdropFilter,
  };

  useEffect(() => {
    let cancelled = false;
    setStartupReady(false);
    setStartupError(null);
    setBackgroundWaitExpired(false);

    Promise.all([
      loadSettings(),
      loadCourses(),
      delay(STARTUP_MIN_DURATION_MS),
    ])
      .then(() => {
        if (!cancelled) setStartupReady(true);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setStartupError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [loadCourses, loadSettings, startupAttempt]);

  useEffect(() => {
    setBackgroundWaitExpired(false);
    if (!startupReady || !backgroundEnabled || !backgroundImagePath.trim() || backgroundImageSrc) return;
    const timer = window.setTimeout(() => setBackgroundWaitExpired(true), STARTUP_BACKGROUND_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [backgroundEnabled, backgroundImagePath, backgroundImageSrc, startupReady]);

  // Once the app is usable, run a throttled background update check (respects the toggle).
  useEffect(() => {
    if (!appReady) return;
    const timer = window.setTimeout(() => useUpdateStore.getState().autoCheckOnStartup(), 4000);
    return () => window.clearTimeout(timer);
  }, [appReady]);

  return (
    <HashRouter>
      <div style={{ position: 'relative', isolation: 'isolate', height: '100vh', overflow: 'hidden' }}>
        {backgroundRendered && (
          <AppBackground imageSrc={backgroundImageSrc} opacity={backgroundOpacity} fit={backgroundFit} />
        )}
        {!appReady ? (
          <StartupLoading error={startupError} onRetry={() => setStartupAttempt((value) => value + 1)} />
        ) : (
          <div style={shellStyle}>
            {/* Breadcrumb bar spans full window width — traffic lights float over its left side */}
            <Breadcrumbbar />

            {/* New-version banner sits under the top chrome (avoids the macOS traffic lights) */}
            <UpdateBanner />

            {/* Bottom row: sidebar + page content */}
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
              <Sidebar />
              <main style={mainStyle}>
                <Routes>
                  <Route path="/" element={<CoursePage />} />
                  <Route path="/dag" element={<DAGPage />} />
                  <Route path="/node" element={<NodePage />} />
                </Routes>
              </main>
            </div>
          </div>
        )}
      </div>
      {appReady && (
        <>
          <SettingsModal />
        </>
      )}
    </HashRouter>
  );
};

export default App;
