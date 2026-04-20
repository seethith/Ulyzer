import React from 'react';
import { create } from 'zustand';

interface BreadcrumbItem {
  label: string;
  path: string;
}

interface HeaderAction {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
}

interface AppState {
  currentCourseId: string | null;
  currentNodeId: string | null;
  breadcrumbs: BreadcrumbItem[];
  headerAction: HeaderAction | null;
  settingsOpen: boolean;

  setCurrentCourse: (id: string | null) => void;
  setCurrentNode: (id: string | null) => void;
  setBreadcrumbs: (items: BreadcrumbItem[]) => void;
  setHeaderAction: (action: HeaderAction | null) => void;
  setSettingsOpen: (open: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  currentCourseId: null,
  currentNodeId: null,
  breadcrumbs: [{ label: '我的课程', path: '/' }],
  headerAction: null,
  settingsOpen: false,

  setCurrentCourse: (id) => set({ currentCourseId: id }),
  setCurrentNode: (id) => set({ currentNodeId: id }),
  setBreadcrumbs: (items) => set({ breadcrumbs: items }),
  setHeaderAction: (action) => set({ headerAction: action }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
}));
