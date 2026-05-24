import React from 'react';
import i18n from '../i18n';
import { create } from 'zustand';

interface BreadcrumbItem {
  label: string;
  path: string;
}

interface HeaderAction {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  title?: string;
}

interface AppState {
  currentCourseId: string | null;
  currentNodeId: string | null;
  breadcrumbs: BreadcrumbItem[];
  headerAction: HeaderAction | null;
  topbarLeftAction: HeaderAction | null;
  topbarRightAction: HeaderAction | null;
  settingsOpen: boolean;

  setCurrentCourse: (id: string | null) => void;
  setCurrentNode: (id: string | null) => void;
  setBreadcrumbs: (items: BreadcrumbItem[]) => void;
  setHeaderAction: (action: HeaderAction | null) => void;
  setTopbarLeftAction: (action: HeaderAction | null) => void;
  setTopbarRightAction: (action: HeaderAction | null) => void;
  setSettingsOpen: (open: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  currentCourseId: null,
  currentNodeId: null,
  breadcrumbs: [{ label: i18n.t('sidebar.my_courses'), path: '/' }],
  headerAction: null,
  topbarLeftAction: null,
  topbarRightAction: null,
  settingsOpen: false,

  setCurrentCourse: (id) => set({ currentCourseId: id }),
  setCurrentNode: (id) => set({ currentNodeId: id }),
  setBreadcrumbs: (items) => set({ breadcrumbs: items }),
  setHeaderAction: (action) => set({ headerAction: action }),
  setTopbarLeftAction: (action) => set({ topbarLeftAction: action }),
  setTopbarRightAction: (action) => set({ topbarRightAction: action }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
}));
