import { create } from 'zustand';
import { IPC } from '@shared/ipc-channels';
import type { Notebook, SaveNotebookDto } from '@shared/types';

interface NotebookState {
  notebook: Notebook | null;
  loading: boolean;
  saving: boolean;

  loadNotebook: (nodeId: string, courseId: string) => Promise<void>;
  saveNotebook: (nodeId: string, courseId: string, data: SaveNotebookDto) => Promise<void>;
  setContent: (content: string) => void;
  setReviewContent: (reviewContent: string) => void;
  clearNotebook: () => void;
}

export const useNotebookStore = create<NotebookState>((set, get) => ({
  notebook: null,
  loading: false,
  saving: false,

  loadNotebook: async (nodeId, courseId) => {
    set({ loading: true });
    try {
      const res = await window.api.invoke(IPC.DB_NOTEBOOK_GET, nodeId, courseId) as {
        success: boolean;
        data?: Notebook;
      };
      if (res.success && res.data) {
        set({ notebook: res.data });
      }
    } finally {
      set({ loading: false });
    }
  },

  saveNotebook: async (nodeId, courseId, data) => {
    set({ saving: true });
    try {
      const res = await window.api.invoke(IPC.DB_NOTEBOOK_SAVE, nodeId, courseId, data) as {
        success: boolean;
        data?: Notebook;
      };
      if (res.success && res.data) {
        set({ notebook: res.data });
      }
    } finally {
      set({ saving: false });
    }
  },

  setContent: (content) => {
    const nb = get().notebook;
    if (nb) set({ notebook: { ...nb, content } });
  },

  setReviewContent: (reviewContent) => {
    const nb = get().notebook;
    if (nb) set({ notebook: { ...nb, review_content: reviewContent } });
  },

  clearNotebook: () => set({ notebook: null, loading: false, saving: false }),
}));
