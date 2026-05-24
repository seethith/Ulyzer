import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronRight, ChevronDown, FileText, Folder, FolderOpen,
  FilePlus, FolderPlus, RefreshCw, ExternalLink,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FsEntry } from '@shared/types';
import { IPC } from '@shared/ipc-channels';
import type { IpcChannel } from '@shared/ipc-channels';
import type { IpcResponse } from '@shared/types';
import { useEditorStore } from '../../stores/editor.store';
import { showToast } from '../ui/ToastViewport';

function getParentPath(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx > 0 ? p.slice(0, idx) : p;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function isSameOrDescendant(parentPath: string, candidatePath: string): boolean {
  const parent = normalizePath(parentPath);
  const candidate = normalizePath(candidatePath);
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' && error ? error : fallback;
}

function nameFromPath(p: string): string {
  const normalized = normalizePath(p);
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function hasInternalFsDrag(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes('application/ulyzer-fs-entry');
}

function hasExternalFileDrag(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes('Files');
}

function hasWorkspaceDrop(dataTransfer: DataTransfer): boolean {
  return hasInternalFsDrag(dataTransfer) || hasExternalFileDrag(dataTransfer);
}

function externalPathsFromFiles(files: FileList): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const file of Array.from(files)) {
    const filePath = window.api.getPathForFile?.(file);
    if (filePath && !seen.has(filePath)) {
      seen.add(filePath);
      paths.push(filePath);
    }
  }
  return paths;
}

function startSystemFileDrag(e: React.DragEvent, filePath: string): boolean {
  if (!window.api.startFileDrag) return false;
  e.preventDefault();
  window.api.startFileDrag([filePath]);
  return true;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
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
      className="ui-tree-row ui-scale-in"
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
        className="ui-focus-ring"
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={type === 'file' ? t('file_explorer.file_placeholder') : t('file_explorer.folder_placeholder')}
        style={{
          flex: 1, fontSize: 12, padding: '1px 5px',
          border: '1px solid var(--accent-b)', borderRadius: 3,
          backgroundColor: 'var(--app-workspace-card-bg-strong, var(--surface))', color: 'var(--text)', outline: 'none',
        }}
      />
    </div>
  );
};

// ── Context menu ──────────────────────────────────────────────────────────────

interface ContextMenuState {
  x: number;
  y: number;
  entry: FsEntry | null;
  targetFolderPath: string | null;
  isProtected: boolean;
}

const CONTEXT_MENU_VIEWPORT_MARGIN = 8;

const MenuItem: React.FC<{ label: string; onClick: () => void; danger?: boolean }> = ({
  label, onClick, danger,
}) => (
  <div
    className="ui-pressable"
    onClick={onClick}
    style={{
      margin: '1px 3px',
      padding: '6px 10px',
      cursor: 'pointer',
      fontSize: 12,
      lineHeight: 1.35,
      borderRadius: 5,
      color: danger ? '#b45309' : 'var(--text)',
      userSelect: 'none',
      whiteSpace: 'nowrap',
      transition: 'background-color 100ms ease, color 100ms ease',
    }}
    onMouseEnter={(e) => {
      (e.currentTarget as HTMLDivElement).style.backgroundColor = danger
        ? 'rgba(180, 83, 9, 0.12)'
        : 'var(--app-workspace-muted-bg, var(--surface2))';
    }}
    onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent'; }}
  >
    {label}
  </div>
);

const MenuDivider: React.FC = () => (
  <div style={{ height: 1, margin: '4px 7px', backgroundColor: 'var(--border)' }} />
);

// ── FolderNode ────────────────────────────────────────────────────────────────

interface FolderNodeProps {
  entry: FsEntry;
  depth: number;
  selectedPath: string | null;
  onSelect: (entry: FsEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FsEntry, isProtected: boolean) => void;
  onMoveEntry: (srcPath: string, destDir: string) => void;
  onImportExternalFiles: (files: FileList, destDir: string) => void;
  onOperationError: (error: unknown, fallback: string) => void;
  renamingPath: string | null;
  renamingName: string;
  onRenameChange: (name: string) => void;
  onRenameConfirm: () => void;
  onRenameCancel: () => void;
  collapsedFolderPaths: Set<string>;
  onToggleFolder: (folderPath: string) => void;
  onSetFolderExpanded: (folderPath: string, expanded: boolean) => void;
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
  onMoveEntry, onImportExternalFiles, onOperationError,
  renamingPath, renamingName, onRenameChange, onRenameConfirm, onRenameCancel,
  collapsedFolderPaths, onToggleFolder, onSetFolderExpanded,
  creatingIn, creatingType, creatingName, onCreatingChange, onCreatingConfirm, onCreatingCancel, createInputRef,
}) => {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [dropTarget, setDropTarget] = useState(false);
  const openFile = useEditorStore((s) => s.openFile);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameHandledRef = useRef(false);

  const isSelected = selectedPath === entry.path;
  const isRenaming = renamingPath === entry.path;
  const isProtected = false;
  const expanded = !collapsedFolderPaths.has(entry.path);

  // Auto-expand when a new item is being created inside this folder
  useEffect(() => {
    if (creatingIn === entry.path) onSetFolderExpanded(entry.path, true);
  }, [creatingIn, entry.path, onSetFolderExpanded]);

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  const baseRowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', height: 26, cursor: 'pointer',
    fontSize: 12, userSelect: 'none', position: 'relative',
    backgroundColor: isSelected
      ? 'var(--accent-s)'
      : hovered
        ? 'var(--app-workspace-muted-bg, var(--surface2, rgba(255,255,255,0.07)))'
        : 'transparent',
    boxShadow: isSelected
      ? 'inset 3px 0 0 var(--accent), inset 0 0 0 1px var(--accent-b)'
      : hovered
        ? 'inset 2px 0 0 var(--border2)'
        : 'none',
    transition: 'background-color 120ms ease, box-shadow 120ms ease, color 120ms ease, transform 120ms ease',
  };

  const childProps = {
    selectedPath, onSelect, onContextMenu, onMoveEntry, onImportExternalFiles, onOperationError,
    renamingPath, renamingName, onRenameChange, onRenameConfirm, onRenameCancel,
    collapsedFolderPaths, onToggleFolder, onSetFolderExpanded,
    creatingIn, creatingType, creatingName, onCreatingChange, onCreatingConfirm, onCreatingCancel, createInputRef,
  };

  // Rename mode, VS Code-style: Enter/blur confirms, Escape/empty cancels.
  if (isRenaming) {
    const handleRenameKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        renameHandledRef.current = true;
        if (renamingName.trim()) onRenameConfirm(); else onRenameCancel();
      } else if (e.key === 'Escape') {
        renameHandledRef.current = true;
        onRenameCancel();
      }
    };

    const handleRenameBlur = () => {
      if (renameHandledRef.current) { renameHandledRef.current = false; return; }
      if (renamingName.trim()) onRenameConfirm(); else onRenameCancel();
    };

    return (
      <div className="ui-tree-row ui-scale-in" style={{
        ...baseRowStyle,
        paddingLeft: depth * 12 + 8,
        paddingRight: 6, gap: 5,
        backgroundColor: 'var(--app-workspace-muted-bg, var(--surface2))',
      }}>
        {entry.type === 'folder'
          ? <Folder size={13} style={{ flexShrink: 0, color: 'var(--amber, #d97706)' }} />
          : <FileText size={12} style={{ flexShrink: 0, color: 'var(--text3)' }} />}
        <input
          className="ui-focus-ring"
          ref={renameInputRef}
          value={renamingName}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={handleRenameKeyDown}
          onBlur={handleRenameBlur}
          onClick={(e) => e.stopPropagation()}
          style={{
            flex: 1, fontSize: 12, padding: '1px 5px',
            border: '1px solid var(--accent-b)', borderRadius: 3,
            backgroundColor: 'var(--app-workspace-card-bg-strong, var(--surface))', color: 'var(--text)', outline: 'none',
          }}
        />
      </div>
    );
  }

  // File row
  if (entry.type === 'file') {
    return (
      <div
        className="ui-tree-row"
        role="treeitem"
        aria-selected={isSelected}
        draggable
        onDragStart={(e) => {
          if (startSystemFileDrag(e, entry.path)) return;
          e.dataTransfer.setData(
            'application/ulyzer-file',
            JSON.stringify({ path: entry.path, name: entry.name }),
          );
          e.dataTransfer.setData(
            'application/ulyzer-fs-entry',
            JSON.stringify({ path: entry.path, name: entry.name, type: entry.type }),
          );
          e.dataTransfer.effectAllowed = 'copyMove';
        }}
        style={{ ...baseRowStyle, paddingLeft: depth * 12 + 8, gap: 5, color: isSelected ? 'var(--text)' : 'var(--text2)' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(entry);
          openFile(entry.path, entry.name).catch((error) => onOperationError(error, t('file_explorer.open_file_failed')));
        }}
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
        className="ui-tree-row"
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={expanded}
        draggable={!isProtected}
        onDragStart={(e) => {
          if (isProtected) return;
          if (startSystemFileDrag(e, entry.path)) return;
          e.dataTransfer.setData(
            'application/ulyzer-fs-entry',
            JSON.stringify({ path: entry.path, name: entry.name, type: entry.type }),
          );
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (hasWorkspaceDrop(e.dataTransfer)) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = hasInternalFsDrag(e.dataTransfer) ? 'move' : 'copy';
            setDropTarget(true);
          }
        }}
        onDragEnter={(e) => {
          if (hasWorkspaceDrop(e.dataTransfer)) {
            e.preventDefault();
            e.stopPropagation();
            setDropTarget(true);
          }
        }}
        onDragLeave={(e) => {
          const nextTarget = e.relatedTarget as Node | null;
          if (nextTarget && e.currentTarget.contains(nextTarget)) return;
          setDropTarget(false);
        }}
        onDragEnd={() => setDropTarget(false)}
        onDrop={(e) => {
          const raw = e.dataTransfer.getData('application/ulyzer-fs-entry');
          if (raw) {
            e.preventDefault();
            e.stopPropagation();
            setDropTarget(false);
            try {
              const payload = JSON.parse(raw) as { path?: string };
              if (payload.path) onMoveEntry(payload.path, entry.path);
            } catch (error) {
              onOperationError(error, t('file_explorer.move_failed'));
            }
            return;
          }
          if (e.dataTransfer.files.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            setDropTarget(false);
            onImportExternalFiles(e.dataTransfer.files, entry.path);
          }
        }}
        style={{
          ...baseRowStyle,
          paddingLeft: depth * 12 + 4, gap: 4,
          backgroundColor: dropTarget ? 'var(--accent-s)' : baseRowStyle.backgroundColor,
          boxShadow: dropTarget
            ? 'inset 4px 0 0 var(--accent), inset 0 0 0 1px var(--accent)'
            : baseRowStyle.boxShadow,
          color: isSelected ? 'var(--text)' : 'var(--text)', fontWeight: depth === 0 || isSelected ? 600 : 400,
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={(e) => { e.stopPropagation(); onSelect(entry); onToggleFolder(entry.path); }}
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
        <div className="ui-tree-children">
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
        </div>
      )}
    </>
  );
};

// ── Toolbar button ────────────────────────────────────────────────────────────

const ToolBtn: React.FC<{ onClick: () => void; title: string; children: React.ReactNode }> = ({
  onClick, title, children,
}) => (
  <button
    className="ui-pressable"
    onClick={onClick}
    title={title}
    style={{
      background: 'none', border: 'none', cursor: 'pointer',
      color: 'var(--text3)', padding: '2px 3px',
      display: 'flex', alignItems: 'center', borderRadius: 3, flexShrink: 0,
    }}
    onMouseEnter={(e) => {
      (e.currentTarget as HTMLButtonElement).style.color = 'var(--text)';
      (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--app-workspace-muted-bg, var(--surface2))';
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
  const openFile = useEditorStore((s) => s.openFile);
  const deleteFile = useEditorStore((s) => s.deleteFile);
  const syncRenamedPath = useEditorStore((s) => s.syncRenamedPath);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<FsEntry | null>(null);
  const explorerRef = useRef<HTMLDivElement>(null);
  const explorerActiveRef = useRef(false);
  const [collapsedFolderPaths, setCollapsedFolderPaths] = useState<Set<string>>(() => new Set());

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renamingName, setRenamingName] = useState('');

  // Inline creation state
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [creatingType, setCreatingType] = useState<'file' | 'folder' | null>(null);
  const [creatingName, setCreatingName] = useState('');
  const createInputRef = useRef<HTMLInputElement>(null);
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [rootDropTarget, setRootDropTarget] = useState(false);

  const showFeedback = useCallback((kind: 'error' | 'success', text: string) => {
    setFeedback({ kind, text });
    showToast({ kind, text });
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = setTimeout(() => setFeedback(null), kind === 'error' ? 4500 : 2200);
  }, []);

  const showError = useCallback((error: unknown, fallback: string) => {
    showFeedback('error', messageFromError(error, fallback));
  }, [showFeedback]);

  const invokeChecked = useCallback(async <T,>(channel: IpcChannel, ...args: unknown[]): Promise<T> => {
    const res = await window.api.invoke(channel, ...args) as IpcResponse<T>;
    if (!res.success) throw new Error(res.error ?? t('file_explorer.file_op_failed'));
    return res.data as T;
  }, []);

  const refreshTree = useCallback(async () => {
    try {
      await loadTree(courseId, nodeId);
    } catch (error) {
      showError(error, t('file_explorer.refresh_failed'));
    }
  }, [courseId, nodeId, loadTree, showError]);

  const setFolderExpanded = useCallback((folderPath: string, expanded: boolean) => {
    setCollapsedFolderPaths((current) => {
      const next = new Set(current);
      if (expanded) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  }, []);

  const toggleFolderExpanded = useCallback((folderPath: string) => {
    setCollapsedFolderPaths((current) => {
      const next = new Set(current);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  }, []);

  // Focus the creation input whenever it mounts
  useEffect(() => {
    if (creatingIn !== null) {
      requestAnimationFrame(() => createInputRef.current?.focus());
    }
  }, [creatingIn]);

  // Close context menu on any left click outside the menu, even if another panel stops propagation.
  useEffect(() => {
    if (!contextMenu) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target as Node | null;
      if (target && contextMenuRef.current?.contains(target)) return;
      setContextMenu(null);
    };
    window.addEventListener('pointerdown', closeOnOutsidePointerDown, true);
    return () => window.removeEventListener('pointerdown', closeOnOutsidePointerDown, true);
  }, [contextMenu]);

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const rect = contextMenuRef.current.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - CONTEXT_MENU_VIEWPORT_MARGIN;
    const maxY = window.innerHeight - rect.height - CONTEXT_MENU_VIEWPORT_MARGIN;
    const nextX = Math.round(Math.min(Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, contextMenu.x), Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, maxX)));
    const nextY = Math.round(Math.min(Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, contextMenu.y), Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, maxY)));
    if (nextX === contextMenu.x && nextY === contextMenu.y) return;
    setContextMenu((current) => current ? { ...current, x: nextX, y: nextY } : current);
  }, [contextMenu]);

  useEffect(() => () => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
  }, []);

  useEffect(() => {
    const onFsChanged = (data: unknown) => {
      const rootPath = useEditorStore.getState().tree?.path;
      if (!rootPath) return;
      const paths = (data as { paths?: unknown }).paths;
      if (!Array.isArray(paths)) return;
      if (paths.some((p) => typeof p === 'string' && (isSameOrDescendant(rootPath, p) || isSameOrDescendant(p, rootPath)))) {
        refreshTree().catch(() => {/* handled in refreshTree */});
      }
    };
    window.api.on(IPC.FS_CHANGED, onFsChanged);
    return () => window.api.off(IPC.FS_CHANGED, onFsChanged);
  }, [refreshTree]);

  useEffect(() => {
    const onFocus = () => refreshTree().catch(() => {/* handled in refreshTree */});
    const onVisibilityChange = () => {
      if (!document.hidden) onFocus();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refreshTree]);

  const handleSelect = useCallback((entry: FsEntry) => {
    setSelectedPath(entry.path);
    setSelectedEntry(entry);
  }, []);

  useEffect(() => {
    const updateExplorerActive = (event: PointerEvent) => {
      const target = event.target as Node | null;
      explorerActiveRef.current = Boolean(target && explorerRef.current?.contains(target));
    };
    window.addEventListener('pointerdown', updateExplorerActive, true);
    return () => window.removeEventListener('pointerdown', updateExplorerActive, true);
  }, []);

  const handleContextMenu = useCallback((
    e: React.MouseEvent, entry: FsEntry, isProtected: boolean,
  ) => {
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      entry,
      targetFolderPath: entry.type === 'folder' ? entry.path : null,
      isProtected,
    });
  }, []);

  const handleRootContextMenu = useCallback((e: React.MouseEvent) => {
    if (e.target !== e.currentTarget || !tree?.path) return;
    e.preventDefault();
    e.stopPropagation();
    setSelectedPath(null);
    setSelectedEntry(null);
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      entry: null,
      targetFolderPath: tree.path,
      isProtected: true,
    });
  }, [tree?.path]);

  // Determine the folder path where a new item should be created
  const getCreationParentPath = useCallback((): string => {
    if (selectedEntry) {
      return selectedEntry.type === 'folder'
        ? selectedEntry.path
        : getParentPath(selectedEntry.path);
    }
    // Nothing selected → use the node root (items appear at depth-0 level)
    return tree?.path ?? '';
  }, [selectedEntry, tree?.path]);

  const startCreating = useCallback((type: 'file' | 'folder', parentPath = getCreationParentPath()) => {
    if (!parentPath) return;
    setCreatingIn(parentPath);
    setCreatingType(type);
    setCreatingName('');
  }, [getCreationParentPath]);

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
        await invokeChecked<string>(IPC.FS_CREATE_FILE, creatingIn, name);
      } else {
        await invokeChecked<string>(IPC.FS_CREATE_FOLDER, creatingIn, name);
      }
      await refreshTree();
    } catch (error) {
      showError(error, creatingType === 'file' ? t('file_explorer.create_file_failed') : t('file_explorer.create_folder_failed'));
    }
    cancelCreating();
  }, [creatingName, creatingType, creatingIn, cancelCreating, invokeChecked, refreshTree, showError]);

  // Context menu actions
  const handleCreateFromContext = (type: 'file' | 'folder') => {
    if (!contextMenu?.targetFolderPath) return;
    const parentPath = contextMenu.targetFolderPath;
    setContextMenu(null);
    startCreating(type, parentPath);
  };

  const startRename = useCallback((entry: FsEntry) => {
    setRenamingPath(entry.path);
    setRenamingName(entry.name);
    setContextMenu(null);
  }, []);

  const handleRename = () => {
    if (!contextMenu?.entry) return;
    startRename(contextMenu.entry);
  };

  const copyEntry = useCallback(async (entry: FsEntry) => {
    setContextMenu(null);
    try {
      await invokeChecked<void>(IPC.FS_COPY_TO_CLIPBOARD, entry.path);
      showFeedback('success', t('file_explorer.copied_to_clipboard'));
    } catch (error) {
      showError(error, t('file_explorer.copy_failed'));
    }
  }, [invokeChecked, showError, showFeedback, t]);

  const pasteToDirectory = useCallback(async (destDir: string) => {
    setContextMenu(null);
    try {
      const pasted = await invokeChecked<string[]>(IPC.FS_PASTE_CLIPBOARD, destDir);
      await refreshTree();
      showFeedback('success', t('file_explorer.paste_success', { count: pasted.length }));
    } catch (error) {
      showError(error, t('file_explorer.paste_failed'));
    }
  }, [invokeChecked, refreshTree, showError, showFeedback, t]);

  const openOrToggleEntry = useCallback((entry: FsEntry) => {
    if (entry.type === 'folder') {
      toggleFolderExpanded(entry.path);
      return;
    }
    openFile(entry.path, entry.name).catch((error) => showError(error, t('file_explorer.open_file_failed')));
  }, [openFile, showError, toggleFolderExpanded]);

  const handleDelete = async () => {
    if (!contextMenu?.entry) return;
    const { entry } = contextMenu;
    setContextMenu(null);
    try {
      await deleteFile(entry.path);
      await refreshTree();
      if (selectedPath && isSameOrDescendant(entry.path, selectedPath)) { setSelectedPath(null); setSelectedEntry(null); }
    } catch (error) {
      showError(error, t('file_explorer.delete_failed'));
    }
  };

  const confirmRename = async () => {
    const newName = renamingName.trim();
    if (!newName || !renamingPath) { cancelRename(); return; }
    try {
      const newPath = await invokeChecked<string>(IPC.FS_RENAME, renamingPath, newName);
      syncRenamedPath(renamingPath, newPath);
      await refreshTree();
      if (selectedPath && isSameOrDescendant(renamingPath, selectedPath)) {
        const nextSelectedPath = selectedPath === renamingPath
          ? newPath
          : `${normalizePath(newPath)}${normalizePath(selectedPath).slice(normalizePath(renamingPath).length)}`;
        setSelectedPath(nextSelectedPath);
        setSelectedEntry((entry) => entry ? { ...entry, path: nextSelectedPath, name: nameFromPath(nextSelectedPath) } : null);
      }
    } catch (error) {
      showError(error, t('file_explorer.rename_failed'));
    }
    cancelRename();
  };

  const handleDuplicate = async () => {
    if (!contextMenu?.entry) return;
    await copyEntry(contextMenu.entry);
  };

  const handlePasteFromContext = async () => {
    if (!contextMenu?.targetFolderPath) return;
    await pasteToDirectory(contextMenu.targetFolderPath);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!explorerActiveRef.current || isTypingTarget(event.target)) return;
      if (renamingPath || creatingIn !== null) return;

      const primary = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (event.key === 'Escape' && contextMenu) {
        event.preventDefault();
        setContextMenu(null);
        return;
      }

      if (primary && key === 'n') {
        event.preventDefault();
        startCreating(event.shiftKey ? 'folder' : 'file');
        return;
      }

      if (primary && key === 'r') {
        event.preventDefault();
        refreshTree().catch(() => {});
        return;
      }

      if (primary && key === 'c' && selectedEntry) {
        event.preventDefault();
        void copyEntry(selectedEntry);
        return;
      }

      if (primary && key === 'v') {
        event.preventDefault();
        const destDir = getCreationParentPath();
        if (destDir) void pasteToDirectory(destDir);
        return;
      }

      if ((event.key === 'F2' || (primary && event.key === 'Enter')) && selectedEntry) {
        event.preventDefault();
        startRename(selectedEntry);
        return;
      }

      if (event.key === 'Enter' && !primary && selectedEntry) {
        event.preventDefault();
        openOrToggleEntry(selectedEntry);
        return;
      }

      if (event.key === 'ArrowRight' && selectedEntry?.type === 'folder') {
        event.preventDefault();
        setFolderExpanded(selectedEntry.path, true);
        return;
      }

      if (event.key === 'ArrowLeft' && selectedEntry?.type === 'folder') {
        event.preventDefault();
        setFolderExpanded(selectedEntry.path, false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    contextMenu,
    copyEntry,
    creatingIn,
    getCreationParentPath,
    openOrToggleEntry,
    pasteToDirectory,
    refreshTree,
    renamingPath,
    selectedEntry,
    setFolderExpanded,
    startCreating,
    startRename,
  ]);

  const handleMoveEntry = useCallback(async (srcPath: string, destDir: string) => {
    if (!srcPath || !destDir) return;
    try {
      const newPath = await invokeChecked<string>(IPC.FS_MOVE, srcPath, destDir);
      syncRenamedPath(srcPath, newPath);
      await refreshTree();
      if (selectedPath && isSameOrDescendant(srcPath, selectedPath)) {
        const nextSelectedPath = selectedPath === srcPath
          ? newPath
          : `${normalizePath(newPath)}${normalizePath(selectedPath).slice(normalizePath(srcPath).length)}`;
        setSelectedPath(nextSelectedPath);
        setSelectedEntry((entry) => entry ? { ...entry, path: nextSelectedPath, name: nameFromPath(nextSelectedPath) } : null);
      }
    } catch (error) {
      showError(error, t('file_explorer.move_failed'));
    }
  }, [invokeChecked, refreshTree, selectedPath, showError, syncRenamedPath]);

  const handleImportExternalFiles = useCallback(async (files: FileList, destDir: string) => {
    const paths = externalPathsFromFiles(files);
    if (paths.length === 0) {
      showError(t('file_explorer.drag_path_unreadable'), t('file_explorer.import_failed'));
      return;
    }
    try {
      const rootPath = tree?.path;
      const internalPaths = rootPath
        ? paths.filter((filePath) => isSameOrDescendant(rootPath, filePath))
        : [];
      const externalPaths = rootPath
        ? paths.filter((filePath) => !isSameOrDescendant(rootPath, filePath))
        : paths;

      let movedCount = 0;
      for (const srcPath of internalPaths) {
        const newPath = await invokeChecked<string>(IPC.FS_MOVE, srcPath, destDir);
        syncRenamedPath(srcPath, newPath);
        movedCount += 1;
        if (selectedPath && isSameOrDescendant(srcPath, selectedPath)) {
          const nextSelectedPath = selectedPath === srcPath
            ? newPath
            : `${normalizePath(newPath)}${normalizePath(selectedPath).slice(normalizePath(srcPath).length)}`;
          setSelectedPath(nextSelectedPath);
          setSelectedEntry((entry) => entry ? { ...entry, path: nextSelectedPath, name: nameFromPath(nextSelectedPath) } : null);
        }
      }

      const imported = externalPaths.length > 0
        ? await invokeChecked<string[]>(IPC.FS_IMPORT_PATHS, externalPaths, destDir)
        : [];
      await refreshTree();
      showFeedback('success', t('file_explorer.drop_success', { imported: imported.length, moved: movedCount }));
    } catch (error) {
      showError(error, t('file_explorer.import_failed'));
    }
  }, [invokeChecked, refreshTree, selectedPath, showError, showFeedback, syncRenamedPath, t, tree?.path]);

  const cancelRename = () => { setRenamingPath(null); setRenamingName(''); };

  const sharedNodeProps = {
    selectedPath, onSelect: handleSelect, onContextMenu: handleContextMenu,
    onMoveEntry: handleMoveEntry, onImportExternalFiles: handleImportExternalFiles, onOperationError: showError,
    renamingPath, renamingName, onRenameChange: setRenamingName,
    onRenameConfirm: confirmRename, onRenameCancel: cancelRename,
    collapsedFolderPaths, onToggleFolder: toggleFolderExpanded, onSetFolderExpanded: setFolderExpanded,
    creatingIn, creatingType, creatingName, onCreatingChange: setCreatingName,
    onCreatingConfirm: confirmCreating, onCreatingCancel: cancelCreating,
    createInputRef,
  };

  const contextMenuElement = contextMenu && typeof document !== 'undefined'
    ? createPortal(
      <div
        className="ui-menu-pop"
        ref={contextMenuRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          top: contextMenu.y,
          left: contextMenu.x,
          backgroundColor: 'var(--panel)',
          border: '1px solid var(--border2)',
          borderRadius: 9,
          padding: '5px 0',
          zIndex: 100000,
          minWidth: 148,
          boxShadow: '0 14px 34px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.12)',
          fontSize: 12,
          color: 'var(--text)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
        }}
      >
        {contextMenu.targetFolderPath && (
          <>
            <MenuItem label={t('file_explorer.new_file')} onClick={() => handleCreateFromContext('file')} />
            <MenuItem label={t('file_explorer.new_folder')} onClick={() => handleCreateFromContext('folder')} />
            <MenuItem label={t('file_explorer.paste')} onClick={handlePasteFromContext} />
            {contextMenu.entry && <MenuDivider />}
          </>
        )}
        {contextMenu.entry && !contextMenu.isProtected && (
          <MenuItem label={t('file_explorer.rename')} onClick={handleRename} />
        )}
        {contextMenu.entry && !contextMenu.isProtected && (
          <MenuItem label={t('file_explorer.copy_file')} onClick={handleDuplicate} />
        )}
        {contextMenu.entry && !contextMenu.isProtected && (
          <MenuItem label={t('file_explorer.delete')} onClick={handleDelete} danger />
        )}
      </div>,
      document.body,
    )
    : null;

  return (
    <div
      className="ui-panel-content-in"
      ref={explorerRef}
      tabIndex={0}
      style={{
        height: '100%', display: 'flex', flexDirection: 'column',
        backgroundColor: 'var(--app-workspace-panel-bg, var(--panel))',
        overflow: 'hidden', position: 'relative', outline: 'none',
      }}
      onFocusCapture={() => { explorerActiveRef.current = true; }}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget as Node | null;
        if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
          explorerActiveRef.current = false;
        }
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
          <ToolBtn onClick={() => refreshTree().catch(() => {})} title={t('file_explorer.refresh')}>
            <RefreshCw size={13} />
          </ToolBtn>
          <ToolBtn
            onClick={() => invokeChecked<void>(IPC.FS_OPEN_PATH, courseId, nodeId).catch((error) => showError(error, t('file_explorer.open_folder_failed')))}
            title={t('file_explorer.show_in_finder')}
          >
            <ExternalLink size={13} />
          </ToolBtn>
        </div>
      </div>

      {/* File tree — clicking empty area deselects */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '4px 0',
          backgroundColor: rootDropTarget ? 'var(--accent-s)' : 'transparent',
          boxShadow: rootDropTarget ? 'inset 0 0 0 1px var(--accent)' : 'none',
          transition: 'background-color 120ms ease, box-shadow 120ms ease',
        }}
        onClick={() => { setSelectedPath(null); setSelectedEntry(null); }}
        onContextMenu={handleRootContextMenu}
        onDragEnter={(e) => {
          if (e.target !== e.currentTarget) return;
          if (tree?.path && hasWorkspaceDrop(e.dataTransfer)) {
            e.preventDefault();
            setRootDropTarget(true);
          }
        }}
        onDragOver={(e) => {
          if (e.target !== e.currentTarget) return;
          if (tree?.path && hasWorkspaceDrop(e.dataTransfer)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = hasInternalFsDrag(e.dataTransfer) ? 'move' : 'copy';
            setRootDropTarget(true);
          }
        }}
        onDragLeave={() => setRootDropTarget(false)}
        onDragEnd={() => setRootDropTarget(false)}
        onDrop={(e) => {
          if (!tree?.path) return;
          if (e.target !== e.currentTarget) return;
          const raw = e.dataTransfer.getData('application/ulyzer-fs-entry');
          if (raw) {
            e.preventDefault();
            setRootDropTarget(false);
            try {
              const payload = JSON.parse(raw) as { path?: string };
              if (payload.path) handleMoveEntry(payload.path, tree.path);
            } catch (error) {
              showError(error, t('file_explorer.move_failed'));
            }
            return;
          }
          if (e.dataTransfer.files.length > 0) {
            e.preventDefault();
            setRootDropTarget(false);
            handleImportExternalFiles(e.dataTransfer.files, tree.path);
          }
        }}
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

      {feedback && (
        <div
          className="ui-feedback-pill"
          style={{
            position: 'absolute',
            left: 8,
            right: 8,
            bottom: 8,
            padding: '7px 9px',
            borderRadius: 6,
            fontSize: 12,
            lineHeight: 1.45,
            color: feedback.kind === 'error' ? '#7f1d1d' : 'var(--text2)',
            backgroundColor: feedback.kind === 'error' ? 'rgba(254, 226, 226, 0.94)' : 'var(--app-workspace-card-bg-strong, var(--surface))',
            border: `1px solid ${feedback.kind === 'error' ? '#fecaca' : 'var(--border)'}`,
            boxShadow: '0 6px 18px rgba(0,0,0,0.16)',
            zIndex: 20,
          }}
          title={feedback.text}
        >
          {feedback.text}
        </div>
      )}

      {contextMenuElement}
    </div>
  );
};
