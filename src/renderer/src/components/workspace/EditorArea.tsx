import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Eye, Pencil, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IPC } from '@shared/ipc-channels';
import { useEditorStore } from '../../stores/editor.store';
import { CodeEditor, getLanguage } from '../file/CodeEditor';
import { MarkdownLiveCodeMirror } from '../file/MarkdownLiveCodeMirror';

// ── File type helpers ──────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.ico']);
const BINARY_EXTS = new Set([
  '.pdf', '.xmind', '.mm', '.mmap', '.mindnode', '.opml',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.rar', '.7z',
]);
const TABLE_EXTS = new Set(['.csv', '.tsv']);
const HTML_EXTS = new Set(['.html', '.htm']);

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

function parseDelimitedRows(text: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && ch === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }
    if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && next === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }
  row.push(cell);
  if (row.some((value) => value.trim()) || rows.length === 0) rows.push(row);
  return rows;
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
    <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', backgroundColor: 'var(--app-workspace-bg, var(--bg))' }}>
      <img src={src} alt={name} style={{ maxWidth: '100%', height: 'auto', borderRadius: 4, boxShadow: '0 2px 8px rgba(0,0,0,0.12)' }} />
    </div>
  );
};

// ── EditorPane — single open file ─────────────────────────────────────────────

interface MarkdownLivePaneProps {
  fileId: string;
  filePath: string;
  content: string;
  onChange: (value: string) => void;
  onFocusChange: (focused: boolean) => void;
}

const MarkdownLivePane: React.FC<MarkdownLivePaneProps> = ({ fileId, filePath, content, onChange, onFocusChange }) => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'live' | 'source'>('live');

  useEffect(() => {
    setMode('live');
    onFocusChange(false);
  }, [fileId, onFocusChange]);

  useEffect(() => () => {
    onFocusChange(false);
  }, [onFocusChange]);

  const sourceMode = mode === 'source';

  return (
    <div className="markdown-file-shell">
      <button
        type="button"
        className="markdown-mode-toggle"
        title={sourceMode ? t('editor_area.toggle_to_wysiwyg') : t('editor_area.toggle_to_source')}
        aria-label={sourceMode ? t('editor_area.toggle_to_wysiwyg') : t('editor_area.toggle_to_source')}
        onClick={() => setMode(sourceMode ? 'live' : 'source')}
      >
        {sourceMode ? <Eye size={15} /> : <Pencil size={15} />}
      </button>

      <MarkdownLiveCodeMirror
        key={fileId}
        fileId={fileId}
        filePath={filePath}
        content={content}
        livePreview={!sourceMode}
        onChange={onChange}
        onFocusChange={onFocusChange}
      />
    </div>
  );
};

const ExternalUpdateNotice: React.FC<{ onReload: () => void }> = ({ onReload }) => {
  const { t } = useTranslation();
  return (
    <div className="file-external-update-notice">
      <span>{t('editor_area.ai_updated_notice')}</span>
      <button type="button" onClick={onReload}>{t('editor_area.reload')}</button>
    </div>
  );
};

interface PreviewSourcePaneProps {
  fileId: string;
  content: string;
  language: string;
  onChange: (value: string) => void;
  previewTitle: string;
  renderPreview: () => React.ReactNode;
}

const PreviewSourcePane: React.FC<PreviewSourcePaneProps> = ({
  fileId,
  content,
  language,
  onChange,
  previewTitle,
  renderPreview,
}) => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');

  useEffect(() => {
    setMode('preview');
  }, [fileId]);

  const editing = mode === 'edit';
  return (
    <div className="markdown-file-shell">
      <button
        type="button"
        className="markdown-mode-toggle"
        title={editing ? t('editor_area.toggle_to_preview', { preview: previewTitle }) : t('editor_area.toggle_to_source')}
        aria-label={editing ? t('editor_area.toggle_to_preview', { preview: previewTitle }) : t('editor_area.toggle_to_source')}
        onClick={() => setMode(editing ? 'preview' : 'edit')}
      >
        {editing ? <Eye size={15} /> : <Pencil size={15} />}
      </button>
      {editing ? (
        <div className="markdown-source-editor">
          <CodeEditor content={content} language={language} onChange={onChange} />
        </div>
      ) : renderPreview()}
    </div>
  );
};

const JsonPreview: React.FC<{ content: string }> = ({ content }) => {
  const { t } = useTranslation();
  let formatted = content.trim();
  let error: string | null = null;
  try {
    formatted = JSON.stringify(JSON.parse(content), null, 2);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '18px 22px', background: 'var(--app-workspace-bg, var(--bg))' }}>
      {error && (
        <div style={{
          marginBottom: 12,
          padding: '8px 10px',
          border: '1px solid rgba(239, 68, 68, 0.22)',
          borderRadius: 'var(--r)',
          color: 'rgb(185, 28, 28)',
          background: 'rgba(239, 68, 68, 0.08)',
          fontSize: 12,
        }}>
          {t('editor_area.json_parse_failed', { error })}
        </div>
      )}
      <pre style={{
        margin: 0,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontSize: 13,
        lineHeight: 1.6,
        fontFamily: "'JetBrains Mono', 'Menlo', monospace",
        color: 'var(--text)',
      }}>
        {formatted}
      </pre>
    </div>
  );
};

const DelimitedTablePreview: React.FC<{ content: string; delimiter: ',' | '\t'; name: string }> = ({ content, delimiter, name }) => {
  const { t, i18n } = useTranslation();
  const rows = parseDelimitedRows(content, delimiter).filter((row) => row.some((cell) => cell.trim()));
  const header = rows[0] ?? [];
  const body = rows.slice(1, 501);
  const columnCount = Math.max(...rows.map((row) => row.length), 0);
  const numLocale = i18n.language.startsWith('en') ? 'en-US' : 'zh-CN';
  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 16, background: 'var(--app-workspace-bg, var(--bg))' }}>
      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>
        {t('editor_area.table_summary', { name, rows: rows.length.toLocaleString(numLocale), cols: columnCount.toLocaleString(numLocale) })}
        {rows.length > 501 ? t('editor_area.table_preview_truncated') : ''}
      </div>
      {rows.length === 0 ? (
        <div style={{ color: 'var(--text3)', fontSize: 13 }}>{t('editor_area.empty_table')}</div>
      ) : (
        <table style={{
          borderCollapse: 'separate',
          borderSpacing: 0,
          minWidth: '100%',
          fontSize: 12,
          color: 'var(--text)',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r)',
          overflow: 'hidden',
        }}>
          <thead>
            <tr>
              {Array.from({ length: columnCount }).map((_, index) => (
                <th
                  key={`h-${index}`}
                  style={{
                    position: 'sticky',
                    top: 0,
                    zIndex: 1,
                    textAlign: 'left',
                    padding: '7px 9px',
                    borderBottom: '1px solid var(--border)',
                    borderRight: index < columnCount - 1 ? '1px solid var(--border)' : undefined,
                    background: 'var(--app-workspace-panel-bg, var(--panel))',
                    fontWeight: 700,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {header[index] || t('editor_area.column_n', { n: index + 1 })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={`r-${rowIndex}`}>
                {Array.from({ length: columnCount }).map((_, cellIndex) => (
                  <td
                    key={`c-${rowIndex}-${cellIndex}`}
                    style={{
                      padding: '7px 9px',
                      borderBottom: rowIndex < body.length - 1 ? '1px solid var(--border)' : undefined,
                      borderRight: cellIndex < columnCount - 1 ? '1px solid var(--border)' : undefined,
                      verticalAlign: 'top',
                      maxWidth: 360,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {row[cellIndex] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

const HtmlPreview: React.FC<{ content: string }> = ({ content }) => (
  <div style={{ height: '100%', overflow: 'hidden', background: 'var(--app-workspace-bg, var(--bg))', padding: 16 }}>
    <iframe
      title="HTML preview"
      sandbox="allow-scripts allow-forms"
      srcDoc={content}
      style={{
        width: '100%',
        height: '100%',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r)',
        background: '#fff',
      }}
    />
  </div>
);

interface EditorPaneProps {
  fileId: string;
}

const EditorPane: React.FC<EditorPaneProps> = ({ fileId }) => {
  const { t } = useTranslation();
  const file = useEditorStore((s) => s.openedFiles.find((f) => f.id === fileId));
  const updateFileContent = useEditorStore((s) => s.updateFileContent);
  const setFileFocused = useEditorStore((s) => s.setFileFocused);
  const saveFile = useEditorStore((s) => s.saveFile);
  const reloadFileFromDisk = useEditorStore((s) => s.reloadFileFromDisk);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = useCallback((value: string) => {
    if (!fileId) return;
    updateFileContent(fileId, value);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveFile(fileId).catch(() => {});
    }, 1000);
  }, [fileId, updateFileContent, saveFile]);

  const handleFocusChange = useCallback((focused: boolean) => {
    setFileFocused(fileId, focused);
  }, [fileId, setFileFocused]);

  const handleReloadFromDisk = useCallback(() => {
    reloadFileFromDisk(fileId).catch(() => {});
  }, [fileId, reloadFileFromDisk]);

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
        <div style={{ padding: '4px 10px', backgroundColor: 'var(--app-workspace-panel-bg, var(--panel))', flexShrink: 0, fontSize: 11, color: 'var(--text3)' }}>
          {t('editor_area.image_preview')}
        </div>
        <ImageViewer path={file.path} name={file.name} />
      </div>
    );
  }

  // Known binary formats
  if (BINARY_EXTS.has(fileExt)) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text3)', backgroundColor: 'var(--app-workspace-bg, var(--bg))', fontSize: 13 }}>
        <span style={{ fontSize: 28 }}>📄</span>
        <span>{t('editor_area.unsupported_format', { ext: fileExt })}</span>
        <button
          onClick={() => (window.api.invoke(IPC.FS_OPEN_PATH, file.path) as Promise<void>).catch(() => {})}
          style={{ marginTop: 4, padding: '4px 12px', fontSize: 12, border: '1px solid var(--border2)', borderRadius: 'var(--r)', background: 'var(--app-workspace-card-bg-strong, var(--surface))', color: 'var(--text2)', cursor: 'pointer' }}
        >
          {t('editor_area.show_in_finder')}
        </button>
      </div>
    );
  }

  // Markdown files → live rich editing by default, source editor on demand.
  if (fileExt === '.md' || fileExt === '.markdown') {
    return (
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {file.externalUpdatePending && <ExternalUpdateNotice onReload={handleReloadFromDisk} />}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <MarkdownLivePane
            fileId={fileId}
            filePath={file.path}
            content={file.content}
            onChange={handleChange}
            onFocusChange={handleFocusChange}
          />
        </div>
      </div>
    );
  }

  if (TABLE_EXTS.has(fileExt)) {
    const delimiter = fileExt === '.tsv' ? '\t' : ',';
    return (
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <PreviewSourcePane
          fileId={fileId}
          content={file.content}
          language="plaintext"
          onChange={handleChange}
          previewTitle={t('editor_area.table_preview')}
          renderPreview={() => <DelimitedTablePreview content={file.content} delimiter={delimiter} name={file.name} />}
        />
      </div>
    );
  }

  if (fileExt === '.json') {
    return (
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <PreviewSourcePane
          fileId={fileId}
          content={file.content}
          language="json"
          onChange={handleChange}
          previewTitle={t('editor_area.format_preview')}
          renderPreview={() => <JsonPreview content={file.content} />}
        />
      </div>
    );
  }

  if (HTML_EXTS.has(fileExt)) {
    return (
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <PreviewSourcePane
          fileId={fileId}
          content={file.content}
          language="html"
          onChange={handleChange}
          previewTitle={t('editor_area.web_preview')}
          renderPreview={() => <HtmlPreview content={file.content} />}
        />
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

const FILE_TAB_WIDTH = 156;
type TabStyle = React.CSSProperties & { '--ui-stagger-delay'?: string };

export const EditorArea: React.FC = () => {
  const { t } = useTranslation();
  const openedFiles  = useEditorStore((s) => s.openedFiles);
  const activeFileId = useEditorStore((s) => s.activeFileId);
  const closeFile    = useEditorStore((s) => s.closeFile);
  const setActiveFile = useEditorStore((s) => s.setActiveFile);

  if (openedFiles.length === 0) {
    return (
      <div className="ui-empty-state" style={{
        height: '100%', display: 'flex', alignItems: 'center',
        justifyContent: 'center', flexDirection: 'column',
        gap: 8, color: 'var(--text3)', backgroundColor: 'var(--app-workspace-bg, var(--surface))',
      }}>
        <span style={{ fontSize: 24 }}>📄</span>
        <span style={{ fontSize: 13 }}>{t('editor_area.click_to_open')}</span>
      </div>
    );
  }

  return (
    <div className="ui-panel-content-in" style={{ height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--app-workspace-bg, var(--surface))' }}>
      {/* Tab bar */}
      <div className="file-tab-strip" style={{
        display: 'flex', alignItems: 'center',
        backgroundColor: 'var(--app-workspace-panel-bg, var(--panel))',
        flexShrink: 0, overflowX: 'auto', overflowY: 'hidden',
        scrollbarWidth: 'thin',
      }}>
        {openedFiles.map((file, index) => {
          const isActive = file.id === activeFileId;
          return (
            <div
              className="ui-tab-in ui-pressable"
              key={file.id}
              onClick={() => setActiveFile(file.id)}
              title={file.name}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                width: FILE_TAB_WIDTH,
                minWidth: FILE_TAB_WIDTH,
                maxWidth: FILE_TAB_WIDTH,
                boxSizing: 'border-box',
                padding: '8px 10px', cursor: 'pointer',
                borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                backgroundColor: isActive ? 'var(--app-workspace-bg, var(--bg))' : 'transparent',
                color: isActive ? 'var(--text)' : 'var(--text3)',
                fontSize: 12, whiteSpace: 'nowrap',
                flex: `0 0 ${FILE_TAB_WIDTH}px`,
                userSelect: 'none',
                transition: 'background-color 120ms ease, border-color 120ms ease, color 120ms ease, transform 120ms ease',
                '--ui-stagger-delay': `${Math.min(index, 6) * 28}ms`,
              } as TabStyle}
            >
              <span style={{
                minWidth: 0,
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {file.name}
              </span>
              <button
                className="ui-pressable"
                onClick={(e) => { e.stopPropagation(); closeFile(file.id); }}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--text3)', padding: 0, flexShrink: 0,
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
          className={file.id === activeFileId ? 'ui-panel-content-in' : undefined}
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
