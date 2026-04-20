import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  ChevronRight, ChevronDown, FileText, Folder, FolderOpen,
  FilePlus, FolderPlus, RefreshCw, ExternalLink, Check, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FsEntry } from '@shared/types';
import { IPC } from '@shared/ipc-channels';
import { useEditorStore } from '../../stores/editor.store';

// The fixed node subfolders — cannot be renamed or deleted (both zh and en names)
const PROTECTED_FOLDERS = new Set([
  '原理资料', '实践资料', '个人笔记', '费曼复盘',
  'Theory',  'Practice',  'Notes',   'Feynman Review',
]);

function getParentPath(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx > 0 ? p.slice(0, idx) : p;
}

// ── Inline create input (VSCode-style: Enter/blur confirms, Escape/empty cancels) ──

interface InlineCreateInputProps {
  depth: number;
  type: 'file' | 'folder';
  value: string;
  onChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

const InlineCreateInput: React.FC<InlineCreateInputProps> = ({
  depth, type, value, onChange, onConfirm, onCancel, inputRef,
}) => {
  const { t } = useTranslation();
  // Tracks whether a keyboard shortcut already handled the commit so blur doesn't double-fire
  const handledRef = useRef(false);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handledRef.current = true;
      if (value.trim()) onConfirm(); else onCancel();
    } else if (e.key === 'Escape') {
      handledRef.current = true;
      onCancel();
    }
  };

  const handleBlur = () => {
    if (handledRef.current) { handledRef.current = false; return; }
    if (value.trim()) onConfirm(); else onCancel();
  };

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', height: 26,
        paddingLeft: depth * 12 + 8, paddingRight: 6, gap: 5, flexShrink: 0,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {type === 'file'
        ? <FileText size={12} style={{ flexShrink: 0, color: 'var(--text3)' }} />
        : <Folder size={13} style={{ flexShrink: 0, color: 'var(--amber, #d97706)' }} />}
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={type === 'file' ? t('file_explorer.file_placeholder') : t('file_explorer.folder_placeholder')}
        style={{
          flex: 1, fontSize: 12, padding: '1px 5px',
          border: '1px solid var(--accent-b)', borderRadius: 3,
          backgroundColor: 'var(--surface)', color: 'var(--text)', outline: 'none',
        }}
      />
    </div>
  );
};

// ── Context menu ──────────────────────────────────────────────────────────────

interface ContextMenuState {
  x: number;
  y: number;
  entry: FsEntry;
  isProtected: boolean;
}

const MenuItem: React.FC<{ label: string; onClick: () => void; danger?: boolean }> = ({
  label, onClick, danger,
}) => (
  <div
    onClick={onClick}
    style={{
      padding: '5px 14px', cursor: 'pointer', fontSize: 12,
      color: danger ? '#ef4444' : 'var(--text)', userSelect: 'none',
    }}
    onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--surface2)'; }}
    onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent'; }}
  >
    {label}
  </div>
);

// ── FolderNode ────────────────────────────────────────────────────────────────

interface FolderNodeProps {
  entry: FsEntry;
  depth: number;
  selectedPath: string | null;
  onSelect: (entry: FsEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FsEntry, isProtected: boolean) => void;
  renamingPath: string | null;
  renamingName: string;
  onRenameChange: (name: string) => void;
  onRenameConfirm: () => void;
  onRenameCancel: () => void;
  creatingIn: string | null;
  creatingType: 'file' | 'folder' | null;
  creatingName: string;
  onCreatingChange: (name: string) => void;
  onCreatingConfirm: () => void;
  onCreatingCancel: () => void;
  createInputRef: React.RefObject<HTMLInputElement | null>;
}

const FolderNode: React.FC<FolderNodeProps> = ({
  entry, depth,
  selectedPath, onSelect, onContextMenu,
  renamingPath, renamingName, onRenameChange, onRenameConfirm, onRenameCancel,
  creatingIn, creatingType, creatingName, onCreatingChange, onCreatingConfirm, onCreatingCancel, createInputRef,
}) => {
  const [expanded, setExpanded] = useState(true);
  const openFile = useEditorStore((s) => s.openFile);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const isSelected = selectedPath === entry.path;
  const isRenaming = renamingPath === entry.path;
  const isProtected = depth === 0 && entry.type === 'folder' && PROTECTED_FOLDERS.has(entry.name);

  // Auto-expand when a new item is being created inside this folder
  useEffect(() => {
    if (creatingIn === entry.path) setExpanded(true);
  }, [creatingIn, entry.path]);

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  const baseRowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', height: 26, cursor: 'pointer',
    fontSize: 12, userSelect: 'none', position: 'relative',
    backgroundColor: isSelected ? 'var(--surface2, rgba(255,255,255,0.07))' : 'transparent',
  };

  const childProps = {
    selectedPath, onSelect, onContextMenu,
    renamingPath, renamingName, onRenameChange, onRenameConfirm, onRenameCancel,
    creatingIn, creatingType, creatingName, onCreatingChange, onCreatingConfirm, onCreatingCancel, createInputRef,
  };

  // Rename mode (inline input with ✓ / ✗)
  if (isRenaming) {
    return (
      <div style={{
        ...baseRowStyle,
        paddingLeft: depth * 12 + (entry.type === 'folder' ? 4 : 8),
        paddingRight: 4, gap: 4,
        backgroundColor: 'var(--surface2)',
      }}>
        {entry.type === 'folder'
          ? <Folder size={13} style={{ flexShrink: 0, color: 'var(--amber, #d97706)' }} />
          : <FileText size={12} style={{ flexShrink: 0, color: 'var(--text3)' }} />}
        <input
          ref={renameInputRef}
          value={renamingName}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenameConfirm();
            if (e.key === 'Escape') onRenameCancel();
          }}
          onClick={(e) => e.stopPropagation()}
          style={{
            flex: 1, fontSize: 11, padding: '1px 4px',
            border: '1px solid var(--accent-b)', borderRadius: 3,
            backgroundColor: 'var(--surface)', color: 'var(--text)', outline: 'none',
          }}
        />
        <button
          onClick={(e) => { e.stopPropagation(); onRenameConfirm(); }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', display: 'flex', padding: 0 }}
        >
          <Check size={12} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onRenameCancel(); }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', display: 'flex', padding: 0 }}
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  // File row
  if (entry.type === 'file') {
    return (
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(
            'application/ulyzer-file',
            JSON.stringify({ path: entry.path, name: entry.name }),
          );
          e.dataTransfer.effectAllowed = 'copy';
        }}
        style={{ ...baseRowStyle, paddingLeft: depth * 12 + 8, gap: 5, color: 'var(--text2)' }}
        onClick={(e) => { e.stopPropagation(); onSelect(entry); openFile(entry.path, entry.name); }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onSelect(entry); onContextMenu(e, entry, false); }}
      >
        <FileText size={12} style={{ flexShrink: 0, color: 'var(--text3)' }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {entry.name}
        </span>
      </div>
    );
  }

  // Folder row + children
  return (
    <>
      <div
        style={{
          ...baseRowStyle,
          paddingLeft: depth * 12 + 4, gap: 4,
          color: 'var(--text)', fontWeight: depth === 0 ? 600 : 400,
        }}
        onClick={(e) => { e.stopPropagation(); onSelect(entry); setExpanded((v) => !v); }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onSelect(entry); onContextMenu(e, entry, isProtected); }}
      >
        {expanded
          ? <ChevronDown size={12} style={{ flexShrink: 0 }} />
          : <ChevronRight size={12} style={{ flexShrink: 0 }} />}
        {expanded
          ? <FolderOpen size={13} style={{ flexShrink: 0, color: 'var(--amber, #d97706)' }} />
          : <Folder size={13} style={{ flexShrink: 0, color: 'var(--amber, #d97706)' }} />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {entry.name}
        </span>
      </div>

      {expanded && (
        <>
          {/* Inline creation input inside this folder */}
          {creatingIn === entry.path && creatingType && (
            <InlineCreateInput
              depth={depth + 1}
              type={creatingType}
              value={creatingName}
              onChange={onCreatingChange}
              onConfirm={onCreatingConfirm}
              onCancel={onCreatingCancel}
              inputRef={createInputRef}
            />
          )}
          {entry.children?.map((child) => (
            <FolderNode key={child.path} entry={child} depth={depth + 1} {...childProps} />
          ))}
        </>
      )}
    </>
  );
};

// ── Toolbar button ────────────────────────────────────────────────────────────

const ToolBtn: React.FC<{ onClick: () => void; title: string; children: React.ReactNode }> = ({
  onClick, title, children,
}) => (
  <button
    onClick={onClick}
    title={title}
    style={{
      background: 'none', border: 'none', cursor: 'pointer',
      color: 'var(--text3)', padding: '2px 3px',
      display: 'flex', alignItems: 'center', borderRadius: 3, flexShrink: 0,
    }}
    onMouseEnter={(e) => {
      (e.currentTarget as HTMLButtonElement).style.color = 'var(--text)';
      (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface2)';
    }}
    onMouseLeave={(e) => {
      (e.currentTarget as HTMLButtonElement).style.color = 'var(--text3)';
      (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
    }}
  >
    {children}
  </button>
);

// ── FileExplorer ──────────────────────────────────────────────────────────────

interface FileExplorerProps {
  courseId: string;
  nodeId: string;
  nodeName: string;
}

export const FileExplorer: React.FC<FileExplorerProps> = ({ courseId, nodeId, nodeName }) => {
  const { t } = useTranslation();
  const tree = useEditorStore((s) => s.tree);
  const loadTree = useEditorStore((s) => s.loadTree);
  const deleteFile = useEditorStore((s) => s.deleteFile);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<FsEntry | null>(null);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renamingName, setRenamingName] = useState('');

  // Inline creation state
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [creatingType, setCreatingType] = useState<'file' | 'folder' | null>(null);
  const [creatingName, setCreatingName] = useState('');
  const createInputRef = useRef<HTMLInputElement>(null);

  // Focus the creation input whenever it mounts
  useEffect(() => {
    if (creatingIn !== null) {
      requestAnimationFrame(() => createInputRef.current?.focus());
    }
  }, [creatingIn]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  const handleSelect = useCallback((entry: FsEntry) => {
    setSelectedPath(entry.path);
    setSelectedEntry(entry);
  }, []);

  const handleContextMenu = useCallback((
    e: React.MouseEvent, entry: FsEntry, isProtected: boolean,
  ) => {
    setContextMenu({ x: e.clientX, y: e.clientY, entry, isProtected });
  }, []);

  // Determine the folder path where a new item should be created
  const getCreationParentPath = (): string => {
    if (selectedEntry) {
      return selectedEntry.type === 'folder'
        ? selectedEntry.path
        : getParentPath(selectedEntry.path);
    }
    // Nothing selected → use the node root (items appear at depth-0 level)
    return tree?.path ?? '';
  };

  const startCreating = (type: 'file' | 'folder') => {
    setCreatingIn(getCreationParentPath());
    setCreatingType(type);
    setCreatingName('');
  };

  const cancelCreating = useCallback(() => {
    setCreatingIn(null);
    setCreatingType(null);
    setCreatingName('');
  }, []);

  const confirmCreating = useCallback(async () => {
    const name = creatingName.trim();
    if (!name || !creatingType || !creatingIn) { cancelCreating(); return; }
    try {
      if (creatingType === 'file') {
        await window.api.invoke(IPC.FS_CREATE_FILE, creatingIn, name);
      } else {
        await window.api.invoke(IPC.FS_CREATE_FOLDER, creatingIn, name);
      }
      await loadTree(courseId, nodeId);
    } catch {/* ignore */}
    cancelCreating();
  }, [creatingName, creatingType, creatingIn, cancelCreating, loadTree, courseId, nodeId]);

  // Context menu actions
  const handleRename = () => {
    if (!contextMenu) return;
    setRenamingPath(contextMenu.entry.path);
    setRenamingName(contextMenu.entry.name);
    setContextMenu(null);
  };

  // Copy path to system clipboard
  const handleCopyPath = () => {
    if (!contextMenu) return;
    navigator.clipboard.writeText(contextMenu.entry.path).catch(() => {});
    setContextMenu(null);
  };

  const handleDelete = async () => {
    if (!contextMenu) return;
    const { entry } = contextMenu;
    setContextMenu(null);
    try {
      await deleteFile(entry.path);
      await loadTree(courseId, nodeId);
      if (selectedPath === entry.path) { setSelectedPath(null); setSelectedEntry(null); }
    } catch {/* ignore */}
  };

  const confirmRename = async () => {
    const newName = renamingName.trim();
    if (!newName || !renamingPath) { cancelRename(); return; }
    try {
      await window.api.invoke(IPC.FS_RENAME, renamingPath, newName);
      await loadTree(courseId, nodeId);
      if (selectedPath === renamingPath) { setSelectedPath(null); setSelectedEntry(null); }
    } catch {/* ignore */}
    cancelRename();
  };

  const cancelRename = () => { setRenamingPath(null); setRenamingName(''); };

  const sharedNodeProps = {
    selectedPath, onSelect: handleSelect, onContextMenu: handleContextMenu,
    renamingPath, renamingName, onRenameChange: setRenamingName,
    onRenameConfirm: confirmRename, onRenameCancel: cancelRename,
    creatingIn, creatingType, creatingName, onCreatingChange: setCreatingName,
    onCreatingConfirm: confirmCreating, onCreatingCancel: cancelCreating,
    createInputRef,
  };

  return (
    <div
      style={{
        height: '100%', display: 'flex', flexDirection: 'column',
        backgroundColor: 'var(--panel)',
        overflow: 'hidden', position: 'relative',
      }}
      onClick={() => setContextMenu(null)}
    >
      {/* Header */}
      <div style={{
        padding: '8px 12px', fontSize: 11, fontWeight: 700,
        color: 'var(--text3)', textTransform: 'uppercase',
        letterSpacing: '0.05em', flexShrink: 0,
      }}>
        {t('file_explorer.header')}
      </div>

      {/* Node name + toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', padding: '0 4px 0 12px',
        flexShrink: 0, minHeight: 28,
      }}>
        <span style={{
          fontSize: 11, fontWeight: 600, color: 'var(--text2)',
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {nodeName}
        </span>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <ToolBtn onClick={() => startCreating('file')} title={t('file_explorer.new_file')}>
            <FilePlus size={13} />
          </ToolBtn>
          <ToolBtn onClick={() => startCreating('folder')} title={t('file_explorer.new_folder')}>
            <FolderPlus size={13} />
          </ToolBtn>
          <ToolBtn onClick={() => loadTree(courseId, nodeId).catch(() => {})} title={t('file_explorer.refresh')}>
            <RefreshCw size={13} />
          </ToolBtn>
          <ToolBtn
            onClick={() => window.api.invoke(IPC.FS_OPEN_PATH, courseId, nodeId).catch(() => {})}
            title={t('file_explorer.show_in_finder')}
          >
            <ExternalLink size={13} />
          </ToolBtn>
        </div>
      </div>

      {/* File tree — clicking empty area deselects */}
      <div
        style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}
        onClick={() => { setSelectedPath(null); setSelectedEntry(null); }}
      >
        {/* Inline input at root level (nothing selected) */}
        {creatingIn === tree?.path && creatingType && (
          <InlineCreateInput
            depth={0}
            type={creatingType}
            value={creatingName}
            onChange={setCreatingName}
            onConfirm={confirmCreating}
            onCancel={cancelCreating}
            inputRef={createInputRef}
          />
        )}

        {tree?.children?.map((entry) => (
          <FolderNode
            key={entry.path}
            entry={entry}
            depth={0}
            {...sharedNodeProps}
          />
        ))}

        {!tree && (
          <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--text3)' }}>{t('file_explorer.loading')}</div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            backgroundColor: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '4px 0',
            zIndex: 9999,
            minWidth: 120,
            boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
            fontSize: 12,
          }}
        >
          {/* Rename: hidden for protected folders */}
          {!contextMenu.isProtected && (
            <MenuItem label={t('file_explorer.rename')} onClick={handleRename} />
          )}
          {/* Copy path to clipboard: available for all items */}
          <MenuItem label={t('file_explorer.copy_path')} onClick={handleCopyPath} />
          {/* Delete: hidden for protected folders */}
          {!contextMenu.isProtected && (
            <MenuItem label={t('file_explorer.delete')} onClick={handleDelete} danger />
          )}
        </div>
      )}
    </div>
  );
};
