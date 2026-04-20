import React, { useEffect, useRef, useCallback } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IPC } from '@shared/ipc-channels';
import { useEditorStore } from '../../stores/editor.store';
import { CodeEditor, getLanguage } from '../file/CodeEditor';
import { MarkdownEditor } from '../file/MarkdownEditor';

// ── File type helpers ──────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.ico']);
const BINARY_EXTS = new Set([
  '.pdf', '.xmind', '.mm', '.mmap', '.mindnode', '.opml',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.rar', '.7z',
]);

function getFileExt(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

function extToMime(ext: string): string {
  if (ext === '.png')  return 'image/png';
  if (ext === '.gif')  return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.svg')  return 'image/svg+xml';
  if (ext === '.bmp')  return 'image/bmp';
  return 'image/jpeg';
}

// ── Image viewer ───────────────────────────────────────────────────────────────

const ImageViewer: React.FC<{ path: string; name: string }> = ({ path, name }) => {
  const { t } = useTranslation();
  const [src, setSrc] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  useEffect(() => {
    setLoading(true);
    setSrc(null);
    const ext = getFileExt(name);
    const mime = extToMime(ext);
    (window.api.invoke(IPC.FS_READ_FILE_BINARY, path) as Promise<{ success: boolean; data?: string }>)
      .then((res) => {
        if (res.success && res.data) setSrc(`data:${mime};base64,${res.data}`);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [path, name]);

  if (loading) return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', fontSize: 13 }}>
      {t('editor_area.loading')}
    </div>
  );
  if (!src) return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', fontSize: 13 }}>
      {t('editor_area.image_load_failed')}
    </div>
  );
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', backgroundColor: 'var(--bg)' }}>
      <img src={src} alt={name} style={{ maxWidth: '100%', height: 'auto', borderRadius: 4, boxShadow: '0 2px 8px rgba(0,0,0,0.12)' }} />
    </div>
  );
};

// ── EditorPane — single open file ─────────────────────────────────────────────

interface EditorPaneProps {
  fileId: string;
}

const EditorPane: React.FC<EditorPaneProps> = ({ fileId }) => {
  const { t } = useTranslation();
  const file = useEditorStore((s) => s.openedFiles.find((f) => f.id === fileId));
  const updateFileContent = useEditorStore((s) => s.updateFileContent);
  const saveFile = useEditorStore((s) => s.saveFile);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = useCallback((value: string) => {
    if (!fileId) return;
    updateFileContent(fileId, value);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveFile(fileId).catch(() => {});
    }, 1000);
  }, [fileId, updateFileContent, saveFile]);

  // Save on unmount / file switch
  useEffect(() => () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveFile(fileId).catch(() => {});
    }
  }, [fileId, saveFile]);

  if (!file) return null;

  const fileExt = getFileExt(file.name);

  // Image files → viewer
  if (IMAGE_EXTS.has(fileExt)) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '4px 10px', backgroundColor: 'var(--panel)', flexShrink: 0, fontSize: 11, color: 'var(--text3)' }}>
          {t('editor_area.image_preview')}
        </div>
        <ImageViewer path={file.path} name={file.name} />
      </div>
    );
  }

  // Known binary formats
  if (BINARY_EXTS.has(fileExt)) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text3)', backgroundColor: 'var(--bg)', fontSize: 13 }}>
        <span style={{ fontSize: 28 }}>📄</span>
        <span>{t('editor_area.unsupported_format', { ext: fileExt })}</span>
        <button
          onClick={() => (window.api.invoke(IPC.FS_OPEN_PATH, file.path) as Promise<void>).catch(() => {})}
          style={{ marginTop: 4, padding: '4px 12px', fontSize: 12, border: '1px solid var(--border2)', borderRadius: 'var(--r)', background: 'var(--surface)', color: 'var(--text2)', cursor: 'pointer' }}
        >
          {t('editor_area.show_in_finder')}
        </button>
      </div>
    );
  }

  // .md files → TipTap WYSIWYG (Typora-style, markdown in/out)
  if (fileExt === '.md') {
    return (
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <MarkdownEditor content={file.content} onChange={handleChange} />
      </div>
    );
  }

  // All other text files → Monaco editor
  // min-height:0 is required for Monaco height:"100%" to resolve inside a flex column
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <CodeEditor
        content={file.content}
        language={getLanguage(file.name)}
        onChange={handleChange}
      />
    </div>
  );
};

// ── EditorArea ─────────────────────────────────────────────────────────────────

export const EditorArea: React.FC = () => {
  const { t } = useTranslation();
  const openedFiles  = useEditorStore((s) => s.openedFiles);
  const activeFileId = useEditorStore((s) => s.activeFileId);
  const closeFile    = useEditorStore((s) => s.closeFile);
  const setActiveFile = useEditorStore((s) => s.setActiveFile);

  if (openedFiles.length === 0) {
    return (
      <div style={{
        height: '100%', display: 'flex', alignItems: 'center',
        justifyContent: 'center', flexDirection: 'column',
        gap: 8, color: 'var(--text3)', backgroundColor: 'var(--surface)',
      }}>
        <span style={{ fontSize: 24 }}>📄</span>
        <span style={{ fontSize: 13 }}>{t('editor_area.click_to_open')}</span>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--surface)' }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex', alignItems: 'center',
        backgroundColor: 'var(--panel)',
        flexShrink: 0, overflowX: 'auto',
      }}>
        {openedFiles.map((file) => {
          const isActive = file.id === activeFileId;
          return (
            <div
              key={file.id}
              onClick={() => setActiveFile(file.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 12px', cursor: 'pointer',
                borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                backgroundColor: isActive ? 'var(--bg)' : 'transparent',
                color: isActive ? 'var(--text)' : 'var(--text3)',
                fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0,
                userSelect: 'none',
              }}
            >
              <span>{file.name}</span>
              <button
                onClick={(e) => { e.stopPropagation(); closeFile(file.id); }}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--text3)', padding: 0,
                  display: 'flex', alignItems: 'center', lineHeight: 1,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text3)'; }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>

      {/* All editor panes mounted; only active one is visible (preserves scroll position) */}
      {openedFiles.map((file) => (
        <div
          key={file.id}
          style={{
            display: file.id === activeFileId ? 'flex' : 'none',
            flex: 1,
            minHeight: 0,
            flexDirection: 'column',
          }}
        >
          <EditorPane fileId={file.id} />
        </div>
      ))}
    </div>
  );
};
