import { create } from 'zustand';
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
  updateFileContent: (id: string, content: string) => void;
  saveFile: (id: string) => Promise<void>;
  deleteFile: (filePath: string) => Promise<void>;
  clearAll: () => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tree: null,
  openedFiles: [],
  activeFileId: null,

  loadTree: async (courseId, nodeId) => {
    const res = await window.api.invoke(IPC.FS_LIST_NODE, courseId, nodeId) as IpcResponse<FsEntry>;
    if (res.success && res.data) set({ tree: res.data });
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
      const file: OpenedFile = { id: filePath, name, path: filePath, content: '' };
      set((s) => ({ openedFiles: [...s.openedFiles, file], activeFileId: filePath }));
      return;
    }
    const res = await window.api.invoke(IPC.FS_READ_FILE, filePath) as IpcResponse<string>;
    if (res.success && res.data !== undefined) {
      const file: OpenedFile = { id: filePath, name, path: filePath, content: res.data };
      set((s) => ({ openedFiles: [...s.openedFiles, file], activeFileId: filePath }));
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

  updateFileContent: (id, content) => {
    set((s) => ({
      openedFiles: s.openedFiles.map((f) => f.id === id ? { ...f, content } : f),
    }));
  },

  saveFile: async (id) => {
    const file = get().openedFiles.find((f) => f.id === id);
    if (!file) return;
    await window.api.invoke(IPC.FS_WRITE_FILE, file.path, file.content);
  },

  deleteFile: async (filePath) => {
    await window.api.invoke(IPC.FS_DELETE_FILE, filePath);
    set((s) => {
      const openedFiles = s.openedFiles.filter((f) => f.path !== filePath);
      const activeFileId = s.activeFileId === filePath
        ? (openedFiles.length > 0 ? openedFiles[openedFiles.length - 1].id : null)
        : s.activeFileId;
      return { openedFiles, activeFileId };
    });
  },

  clearAll: () => set({ tree: null, openedFiles: [], activeFileId: null }),
}));
