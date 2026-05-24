import { create } from 'zustand';
import i18n from '../i18n';
import { IPC } from '@shared/ipc-channels';
import type { FsEntry, OpenedFile, IpcResponse } from '@shared/types';

interface EditorState {
  tree: FsEntry | null;
  openedFiles: OpenedFile[];
  activeFileId: string | null;

  loadTree: (courseId: string, nodeId: string) => Promise<void>;
  openFile: (filePath: string, name: string) => Promise<void>;
  closeFile: (id: string) => void;
  setActiveFile: (id: string) => void;
  setFileFocused: (id: string, focused: boolean) => void;
  updateFileContent: (id: string, content: string) => void;
  saveFile: (id: string) => Promise<void>;
  refreshFileFromDisk: (filePath: string, name?: string) => Promise<void>;
  reloadFileFromDisk: (id: string) => Promise<void>;
  deleteFile: (filePath: string) => Promise<void>;
  syncRenamedPath: (oldPath: string, newPath: string) => void;
  clearAll: () => void;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '');
}

function basename(filePath: string): string {
  const normalized = normalizePath(filePath);
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function isSameOrDescendant(parentPath: string, candidatePath: string): boolean {
  const parent = normalizePath(parentPath);
  const candidate = normalizePath(candidatePath);
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function replacePathPrefix(filePath: string, oldPath: string, newPath: string): string | null {
  if (!isSameOrDescendant(oldPath, filePath)) return null;
  const normalizedFile = normalizePath(filePath);
  const normalizedOld = normalizePath(oldPath);
  const suffix = normalizedFile.slice(normalizedOld.length);
  return `${normalizePath(newPath)}${suffix}`;
}

function pickFallbackActiveFile(openedFiles: OpenedFile[]): string | null {
  return openedFiles.length > 0 ? openedFiles[openedFiles.length - 1].id : null;
}

function createOpenedFile(filePath: string, name: string, content: string): OpenedFile {
  return {
    id: filePath,
    name,
    path: filePath,
    content,
    lastSavedContent: content,
    isDirty: false,
    isFocused: false,
    externalUpdatePending: false,
  };
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tree: null,
  openedFiles: [],
  activeFileId: null,

  loadTree: async (courseId, nodeId) => {
    const res = await window.api.invoke(IPC.FS_LIST_NODE, courseId, nodeId) as IpcResponse<FsEntry>;
    if (!res.success || !res.data) throw new Error(res.error ?? i18n.t('errors.load_tree_failed'));
    set({ tree: res.data });
  },

  openFile: async (filePath, name) => {
    const { openedFiles } = get();
    const existing = openedFiles.find((f) => f.path === filePath);
    if (existing) {
      set({ activeFileId: existing.id });
      return;
    }
    // Binary/image files: don't load as text — EditorPane handles display separately
    const BINARY_OPEN_EXTS = new Set([
      '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.ico',
      '.pdf', '.xmind', '.mm', '.mmap', '.mindnode', '.opml',
      '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      '.zip', '.rar', '.7z',
    ]);
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    if (BINARY_OPEN_EXTS.has(ext)) {
      const file = createOpenedFile(filePath, name, '');
      set((s) => ({ openedFiles: [...s.openedFiles, file], activeFileId: filePath }));
      return;
    }
    const res = await window.api.invoke(IPC.FS_READ_FILE, filePath) as IpcResponse<string>;
    if (res.success && res.data !== undefined) {
      const file = createOpenedFile(filePath, name, res.data);
      set((s) => ({ openedFiles: [...s.openedFiles, file], activeFileId: filePath }));
    } else {
      throw new Error(res.error ?? i18n.t('errors.read_file_failed'));
    }
  },

  closeFile: (id) => {
    set((s) => {
      const files = s.openedFiles.filter((f) => f.id !== id);
      const activeFileId = s.activeFileId === id
        ? (files.length > 0 ? files[files.length - 1].id : null)
        : s.activeFileId;
      return { openedFiles: files, activeFileId };
    });
  },

  setActiveFile: (id) => set({ activeFileId: id }),

  setFileFocused: (id, focused) => {
    set((s) => ({
      openedFiles: s.openedFiles.map((f) => f.id === id ? { ...f, isFocused: focused } : f),
    }));
  },

  updateFileContent: (id, content) => {
    set((s) => ({
      openedFiles: s.openedFiles.map((f) => {
        if (f.id !== id) return f;
        return {
          ...f,
          content,
          isDirty: content !== (f.lastSavedContent ?? ''),
        };
      }),
    }));
  },

  saveFile: async (id) => {
    const file = get().openedFiles.find((f) => f.id === id);
    if (!file) return;
    const savedContent = file.content;
    const res = await window.api.invoke(IPC.FS_WRITE_FILE, file.path, savedContent) as IpcResponse<void>;
    if (!res.success) throw new Error(res.error ?? i18n.t('errors.save_file_failed'));
    set((s) => ({
      openedFiles: s.openedFiles.map((f) => {
        if (f.id !== id) return f;
        return {
          ...f,
          lastSavedContent: savedContent,
          isDirty: f.content !== savedContent,
          externalUpdatePending: false,
        };
      }),
    }));
  },

  refreshFileFromDisk: async (filePath, name) => {
    const existing = get().openedFiles.find((f) => f.path === filePath);
    if (!existing) {
      await get().openFile(filePath, name ?? basename(filePath));
      return;
    }

    const res = await window.api.invoke(IPC.FS_READ_FILE, filePath) as IpcResponse<string>;
    if (!res.success || res.data === undefined) throw new Error(res.error ?? i18n.t('errors.read_file_failed'));
    const diskContent = res.data;

    set((s) => ({
      openedFiles: s.openedFiles.map((f) => {
        if (f.path !== filePath) return f;
        if (f.isDirty || f.isFocused) return { ...f, externalUpdatePending: true };
        return {
          ...f,
          content: diskContent,
          lastSavedContent: diskContent,
          isDirty: false,
          externalUpdatePending: false,
        };
      }),
      activeFileId: existing.id,
    }));
  },

  reloadFileFromDisk: async (id) => {
    const file = get().openedFiles.find((f) => f.id === id);
    if (!file) return;
    const res = await window.api.invoke(IPC.FS_READ_FILE, file.path) as IpcResponse<string>;
    if (!res.success || res.data === undefined) throw new Error(res.error ?? i18n.t('errors.read_file_failed'));
    const diskContent = res.data;
    set((s) => ({
      openedFiles: s.openedFiles.map((f) => f.id === id
        ? {
            ...f,
            content: diskContent,
            lastSavedContent: diskContent,
            isDirty: false,
            externalUpdatePending: false,
          }
        : f),
    }));
  },

  deleteFile: async (filePath) => {
    const res = await window.api.invoke(IPC.FS_DELETE_FILE, filePath) as IpcResponse<void>;
    if (!res.success) throw new Error(res.error ?? i18n.t('errors.delete_failed'));
    set((s) => {
      const openedFiles = s.openedFiles.filter((f) => !isSameOrDescendant(filePath, f.path));
      const activeFileId = s.activeFileId && isSameOrDescendant(filePath, s.activeFileId)
        ? pickFallbackActiveFile(openedFiles)
        : s.activeFileId;
      return { openedFiles, activeFileId };
    });
  },

  syncRenamedPath: (oldPath, newPath) => {
    set((s) => {
      let activeFileId = s.activeFileId;
      const openedFiles = s.openedFiles.map((file) => {
        const nextPath = replacePathPrefix(file.path, oldPath, newPath);
        if (!nextPath) return file;
        if (activeFileId === file.id) activeFileId = nextPath;
        return {
          ...file,
          id: nextPath,
          path: nextPath,
          name: basename(nextPath),
        };
      });
      return { openedFiles, activeFileId };
    });
  },

  clearAll: () => set({ tree: null, openedFiles: [], activeFileId: null }),
}));
