import { create } from 'zustand';
import { IPC } from '@shared/ipc-channels';
import type { Course, IpcResponse } from '@shared/types';

async function dbInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await window.api.invoke(channel as Parameters<typeof window.api.invoke>[0], ...args)) as IpcResponse<T>;
  if (!res.success) throw new Error(res.error ?? 'IPC error');
  return res.data as T;
}

interface CourseState {
  courses: Course[];
  loading: boolean;
  error: string | null;

  loadCourses: () => Promise<void>;
  createCourse: (name: string) => Promise<Course>;
  updateCourse: (id: string, data: Partial<Course>) => Promise<void>;
  deleteCourse: (id: string) => Promise<void>;
}

export const useCourseStore = create<CourseState>((set) => ({
  courses: [],
  loading: false,
  error: null,

  loadCourses: async () => {
    set({ loading: true, error: null });
    try {
      const courses = await dbInvoke<Course[]>(IPC.DB_COURSE_LIST);
      set({ courses, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  createCourse: async (name: string) => {
    const course = await dbInvoke<Course>(IPC.DB_COURSE_CREATE, { name });
    set((s) => ({ courses: [course, ...s.courses] }));
    return course;
  },

  updateCourse: async (id: string, data: Partial<Course>) => {
    const updated = await dbInvoke<Course>(IPC.DB_COURSE_UPDATE, id, data);
    set((s) => ({
      courses: s.courses.map((c) => (c.id === id ? updated : c)),
    }));
  },

  deleteCourse: async (id: string) => {
    await dbInvoke<void>(IPC.DB_COURSE_DELETE, id);
    set((s) => ({ courses: s.courses.filter((c) => c.id !== id) }));
  },
}));
