import React, { useEffect } from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { Sidebar, Breadcrumbbar } from './components/layout/Sidebar';
import { SettingsModal } from './components/settings/SettingsModal';
import { useSettingsStore } from './stores/settings.store';
import CoursePage from './pages/CoursePage';
import DAGPage from './pages/DAGPage';
import NodePage from './pages/NodePage';
import './styles/globals.css';
import './styles/tailwind.css';

const App: React.FC = () => {
  const loadSettings = useSettingsStore((s) => s.load);

  useEffect(() => {
    loadSettings().catch(console.error);
  }, []);

  return (
    <HashRouter>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
        {/* Breadcrumb bar spans full window width — traffic lights float over its left side */}
        <Breadcrumbbar />

        {/* Bottom row: sidebar + page content */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          <Sidebar />
          <main style={{ flex: 1, overflow: 'auto', backgroundColor: 'var(--bg)' }}>
            <Routes>
              <Route path="/" element={<CoursePage />} />
              <Route path="/dag" element={<DAGPage />} />
              <Route path="/node" element={<NodePage />} />
            </Routes>
          </main>
        </div>
      </div>
      <SettingsModal />
    </HashRouter>
  );
};

export default App;
