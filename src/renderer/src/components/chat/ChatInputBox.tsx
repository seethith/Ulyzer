import React, { useRef, useCallback, useEffect } from 'react';
import { Paperclip, Globe, ArrowUp, X, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FileAttachment } from '@shared/types';
import { IPC } from '@shared/ipc-channels';
import { ModelSelector } from './ModelSelector';

interface ChatInputBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (message: string, attachments: FileAttachment[], webSearchEnabled: boolean) => void;
  onAbort?: () => void;
  placeholder?: string;
  disabled?: boolean;
  /** Extra content to render above the textarea (e.g. preset commands) */
  headerSlot?: React.ReactNode;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Whether web search is currently enabled for the next message */
  webSearchEnabled?: boolean;
  /** Called when user clicks the Globe button */
  onWebSearchToggle?: () => void;
  /** Error message to show when web search key is not configured */
  webSearchError?: string | null;
}

const MIN_HEIGHT = 72;
const MAX_HEIGHT = 160;

// ── Supported file types ───────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const PDF_EXTS   = new Set(['.pdf']);

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown',
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx',
  '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.cs',
  '.go', '.rs', '.swift', '.kt', '.rb', '.php',
  '.html', '.htm', '.css', '.scss', '.sass',
  '.json', '.yaml', '.yml', '.toml', '.xml',
  '.csv', '.tsv', '.sql', '.log',
  '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.vue', '.svelte',
]);

const SUPPORTED_EXTS = new Set([...IMAGE_EXTS, ...PDF_EXTS, ...TEXT_EXTS]);

// ── Image compression ──────────────────────────────────────────────────────────

/** Resize + JPEG-compress an image to reduce base64 size before sending to AI. */
async function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const MAX_DIM = 1568; // Claude's recommended max dimension
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > MAX_DIM || height > MAX_DIM) {
        const ratio = Math.min(MAX_DIM / width, MAX_DIM / height);
        width  = Math.round(width  * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('canvas unavailable')); return; }
      ctx.drawImage(img, 0, 0, width, height);
      // Use PNG for PNG/GIF to preserve transparency; JPEG for everything else
      const isPng = file.name.toLowerCase().endsWith('.png') || file.name.toLowerCase().endsWith('.gif');
      const dataUrl = canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.85);
      resolve(dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
    img.src = url;
  });
}

function getExt(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

// ── Component ──────────────────────────────────────────────────────────────────

export const ChatInputBox: React.FC<ChatInputBoxProps> = ({
  value,
  onChange,
  onSend,
  onAbort,
  placeholder,
  disabled = false,
  headerSlot,
  textareaRef: externalRef,
  webSearchEnabled = false,
  onWebSearchToggle,
  webSearchError,
}) => {
  const { t } = useTranslation();
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalRef ?? internalRef;

  const [attachments, setAttachments] = React.useState<FileAttachment[]>([]);
  const [focused, setFocused] = React.useState(false);
  const [isDragging, setIsDragging] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = `${MIN_HEIGHT}px`;
    const scrollH = el.scrollHeight;
    el.style.height = `${Math.min(Math.max(scrollH, MIN_HEIGHT), MAX_HEIGHT)}px`;
  }, [textareaRef]);

  useEffect(() => { resizeTextarea(); }, [value, resizeTextarea]);

  useEffect(() => {
    return () => { if (errorTimerRef.current) clearTimeout(errorTimerRef.current); };
  }, []);

  const showError = (msg: string) => {
    setUploadError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setUploadError(null), 5000);
  };

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !disabled;

  const handleSend = () => {
    if (!canSend) return;
    onSend(value.trim(), attachments, webSearchEnabled);
    onChange('');
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = `${MIN_HEIGHT}px`;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // nativeEvent.isComposing is true while an IME (e.g. pinyin) is composing;
    // don't send on Enter during composition — only send when IME confirms.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const processFiles = useCallback(async (files: File[]) => {
    const invalid: string[] = [];
    const pending: Promise<FileAttachment | null>[] = [];

    for (const f of files) {
      const ext = getExt(f.name);
      if (!SUPPORTED_EXTS.has(ext)) {
        invalid.push(f.name);
        continue;
      }
      const isImage = IMAGE_EXTS.has(ext);
      const isPdf   = PDF_EXTS.has(ext);
      pending.push(
        isImage
          ? compressImage(f)
              .then((base64): FileAttachment => ({
                id: crypto.randomUUID(),
                name: f.name,
                mimeType: f.name.toLowerCase().endsWith('.png') ? 'image/png'
                        : f.name.toLowerCase().endsWith('.gif') ? 'image/gif'
                        : 'image/jpeg',
                size: f.size,
                base64,
              }))
              .catch(() => null)
          : new Promise<FileAttachment | null>((resolve) => {
              const reader = new FileReader();
              reader.onload = () => {
                if (isPdf) {
                  // PDF: store as base64 for Claude
                  const dataUrl = reader.result as string;
                  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
                  resolve({
                    id: crypto.randomUUID(),
                    name: f.name,
                    mimeType: 'application/pdf',
                    size: f.size,
                    base64,
                  });
                } else {
                  resolve({
                    id: crypto.randomUUID(),
                    name: f.name,
                    mimeType: f.type || 'text/plain',
                    size: f.size,
                    content: reader.result as string,
                  });
                }
              };
              reader.onerror = () => resolve(null);
              if (isPdf) {
                reader.readAsDataURL(f);
              } else {
                reader.readAsText(f, 'utf-8');
              }
            })
      );
    }

    const results = await Promise.all(pending);
    const valid = results.filter((a): a is FileAttachment => a !== null);
    if (valid.length > 0) setAttachments((prev) => [...prev, ...valid]);
    if (invalid.length > 0) {
      showError(t('chat_input.unsupported_format', { name: invalid.join('、') }));
    }
  }, []);

  // Handle internal FileExplorer drag (path-only, read via IPC)
  const processInternalDrop = useCallback(async (raw: string) => {
    let info: { path: string; name: string };
    try { info = JSON.parse(raw) as { path: string; name: string }; }
    catch { return; }

    const ext = getExt(info.name);
    if (!SUPPORTED_EXTS.has(ext)) {
      showError(t('chat_input.unsupported_format', { name: info.name }));
      return;
    }
    const isImage = IMAGE_EXTS.has(ext);
    const isPdf   = PDF_EXTS.has(ext);
    try {
      if (isImage || isPdf) {
        const res = await window.api.invoke(IPC.FS_READ_FILE_BINARY, info.path) as { success: boolean; data?: string };
        if (!res.success || !res.data) return;
        setAttachments((prev) => [...prev, {
          id: crypto.randomUUID(),
          name: info.name,
          mimeType: isPdf ? 'application/pdf' : `image/${ext.slice(1) === 'jpg' ? 'jpeg' : ext.slice(1)}`,
          size: 0,
          base64: res.data,
        }]);
      } else {
        const res = await window.api.invoke(IPC.FS_READ_FILE, info.path) as { success: boolean; data?: string };
        if (!res.success || !res.data) return;
        const textData = res.data;
        setAttachments((prev) => [...prev, {
          id: crypto.randomUUID(),
          name: info.name,
          mimeType: 'text/plain',
          size: textData.length,
          content: textData,
        }]);
      }
    } catch {/* ignore */}
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    processFiles(Array.from(e.target.files ?? [])).catch(() => {});
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // Only trigger if leaving the container (not a child)
    if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    // Check for internal FileExplorer drag first
    const internal = e.dataTransfer.getData('application/ulyzer-file');
    if (internal) {
      processInternalDrop(internal).catch(() => {});
      return;
    }

    // OS-level file drop
    processFiles(Array.from(e.dataTransfer.files)).catch(() => {});
  };

  const borderColor = isDragging
    ? 'var(--accent)'
    : focused
      ? 'var(--accent-b)'
      : 'var(--border)';

  const boxShadow = isDragging || focused
    ? '0 0 0 3px var(--accent-s)'
    : 'var(--shadow)';

  return (
    <div
      style={{
        backgroundColor: 'var(--surface)',
        border: `1px solid ${borderColor}`,
        borderRadius: 'var(--r2)',
        boxShadow,
        transition: 'border-color 0.15s, box-shadow 0.15s',
        position: 'relative',
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {headerSlot && (
        <div style={{ padding: '8px 12px 0' }}>{headerSlot}</div>
      )}

      {/* Drag overlay hint */}
      {isDragging && (
        <div style={{
          padding: '6px 12px', fontSize: 12,
          color: 'var(--accent)', backgroundColor: 'var(--accent-s)',
          borderBottom: '1px solid var(--accent-b)',
          textAlign: 'center',
        }}>
          {t('chat_input.drop_to_add')}
        </div>
      )}

      {/* Upload error banner */}
      {uploadError && (
        <div style={{
          padding: '5px 12px', fontSize: 11,
          color: '#b91c1c', backgroundColor: '#fef2f2',
          borderBottom: '1px solid #fecaca',
        }}>
          {uploadError}
        </div>
      )}

      {/* Web search error banner */}
      {webSearchError && (
        <div style={{
          padding: '5px 12px', fontSize: 11,
          color: '#92400e', backgroundColor: '#fffbeb',
          borderBottom: '1px solid #fde68a',
        }}>
          {webSearchError}
        </div>
      )}

      {/* Attachment badges */}
      {attachments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 12px 0' }}>
          {attachments.map((att) => (
            <div key={att.id} style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '3px 8px', backgroundColor: 'var(--surface2)',
              border: '1px solid var(--border)', borderRadius: 20,
              fontSize: 12, color: 'var(--text2)', maxWidth: 200,
            }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {att.name}
              </span>
              <button onClick={() => removeAttachment(att.id)} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text3)', padding: 0, display: 'flex', alignItems: 'center', flexShrink: 0,
              }}>
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={isDragging ? '' : placeholder}
        disabled={disabled}
        rows={1}
        style={{
          display: 'block', width: '100%',
          minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT,
          padding: '12px 14px', fontSize: 13,
          color: 'var(--text)', backgroundColor: 'transparent',
          border: 'none', outline: 'none', resize: 'none',
          fontFamily: 'var(--sans)', lineHeight: 1.6, overflowY: 'auto',
        }}
      />

      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '6px 8px', borderTop: '1px solid rgba(0,0,0,0.05)', gap: 2,
      }}>
        <ToolButton onClick={() => fileInputRef.current?.click()} title={t('chat_input.upload_attachment')} disabled={disabled}>
          <Paperclip size={15} />
        </ToolButton>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={[...TEXT_EXTS, ...IMAGE_EXTS, ...PDF_EXTS].join(',')}
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />

        <ToolButton
          onClick={() => onWebSearchToggle?.()}
          title={webSearchEnabled ? t('chat_input.web_search_off') : t('chat_input.web_search_on')}
          active={webSearchEnabled}
          disabled={!onWebSearchToggle}
        >
          <Globe size={15} />
        </ToolButton>

        <div style={{ width: 1, height: 16, backgroundColor: 'var(--border)', margin: '0 4px' }} />
        <ModelSelector />

        <div style={{ flex: 1 }} />

        {disabled && onAbort ? (
          <button onClick={onAbort} title={t('chat_input.stop_generating')} style={{
            width: 30, height: 30, borderRadius: 'var(--r)',
            border: 'none', cursor: 'pointer',
            backgroundColor: 'var(--red, #ef4444)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background-color 0.15s', flexShrink: 0,
          }}>
            <Square size={12} fill="currentColor" />
          </button>
        ) : (
          <button onClick={handleSend} disabled={!canSend} title={canSend ? '发送 (Enter)' : ''} style={{
            width: 30, height: 30, borderRadius: 'var(--r)',
            border: 'none', cursor: canSend ? 'pointer' : 'not-allowed',
            backgroundColor: canSend ? 'var(--accent)' : 'var(--border)',
            color: canSend ? '#fff' : 'var(--text3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background-color 0.15s', flexShrink: 0,
          }}>
            <ArrowUp size={14} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
};

// ── Sub-components ────────────────────────────────────────────────────────────

const ToolButton: React.FC<{
  onClick: () => void; title?: string; disabled?: boolean; active?: boolean; children: React.ReactNode;
}> = ({ onClick, title, disabled, active, children }) => (
  <button onClick={onClick} title={title} disabled={disabled} style={{
    width: 28, height: 28, borderRadius: 'var(--r)',
    border: active ? '1px solid var(--accent-b)' : 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    backgroundColor: active ? 'var(--accent-s)' : 'transparent',
    color: disabled ? 'var(--border2)' : active ? 'var(--accent)' : 'var(--text3)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'background-color 0.1s, color 0.1s', flexShrink: 0,
  }}
    onMouseEnter={(e) => { if (!disabled) { (e.currentTarget as HTMLButtonElement).style.backgroundColor = active ? 'var(--accent-b)' : 'var(--surface2)'; (e.currentTarget as HTMLButtonElement).style.color = active ? 'var(--accent)' : 'var(--text2)'; } }}
    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = active ? 'var(--accent-s)' : 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = disabled ? 'var(--border2)' : active ? 'var(--accent)' : 'var(--text3)'; }}
  >
    {children}
  </button>
);

