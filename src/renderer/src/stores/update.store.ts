import { create } from 'zustand';
import { IPC } from '@shared/ipc-channels';
import type { IpcResponse, UpdateCheckResult } from '@shared/types';

export type UpdateStatus = 'idle' | 'checking' | 'latest' | 'available' | 'error';

interface UpdatePrefs {
  autoCheck: boolean;
  prerelease: boolean;
  skippedVersion: string | null;
  lastCheckAt: number;
}

const PREFS_KEY = 'ulyzer.update.prefs';
const THROTTLE_MS = 12 * 60 * 60 * 1000; // auto-check at most twice a day
// Default: auto-check on, prerelease channel on (the app is in alpha).
const DEFAULT_PREFS: UpdatePrefs = { autoCheck: true, prerelease: true, skippedVersion: null, lastCheckAt: 0 };

function loadPrefs(): UpdatePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<UpdatePrefs>) };
  } catch { /* ignore */ }
  return { ...DEFAULT_PREFS };
}

function savePrefs(prefs: UpdatePrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}

interface UpdateState {
  status: UpdateStatus;
  result: UpdateCheckResult | null;
  /** Banner hidden for this session via "稍后". */
  bannerDismissed: boolean;
  prefs: UpdatePrefs;
  /** Run a check. `manual` re-shows the banner even if dismissed earlier. */
  check: (manual?: boolean) => Promise<void>;
  /** Startup auto-check, respecting the toggle and the throttle window. */
  autoCheckOnStartup: () => void;
  dismissBanner: () => void;
  skipVersion: () => void;
  openDownload: () => void;
  setAutoCheck: (value: boolean) => void;
  setPrerelease: (value: boolean) => void;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: 'idle',
  result: null,
  bannerDismissed: false,
  prefs: loadPrefs(),

  check: async (manual = false) => {
    if (get().status === 'checking') return;
    set({ status: 'checking' });
    let result: UpdateCheckResult | null = null;
    try {
      const res = (await window.api.invoke(IPC.UPDATE_CHECK, {
        includePrerelease: get().prefs.prerelease,
      })) as IpcResponse<UpdateCheckResult>;
      result = res.success ? res.data ?? null : null;
    } catch { result = null; }

    const prefs = { ...get().prefs, lastCheckAt: Date.now() };
    savePrefs(prefs);

    if (!result) { set({ status: 'error', prefs }); return; }
    const status: UpdateStatus = result.error ? 'error' : result.hasUpdate ? 'available' : 'latest';
    set({ result, status, prefs, bannerDismissed: manual ? false : get().bannerDismissed });
  },

  autoCheckOnStartup: () => {
    const { prefs } = get();
    if (!prefs.autoCheck) return;
    if (Date.now() - prefs.lastCheckAt < THROTTLE_MS) return;
    void get().check(false);
  },

  dismissBanner: () => set({ bannerDismissed: true }),

  skipVersion: () => {
    const version = get().result?.latestVersion;
    if (!version) return;
    const prefs = { ...get().prefs, skippedVersion: version };
    savePrefs(prefs);
    set({ prefs, bannerDismissed: true });
  },

  openDownload: () => {
    const url = get().result?.releaseUrl;
    if (url) window.api.invoke(IPC.SHELL_OPEN_URL, url).catch(() => { /* ignore */ });
  },

  setAutoCheck: (value) => {
    const prefs = { ...get().prefs, autoCheck: value };
    savePrefs(prefs);
    set({ prefs });
  },

  setPrerelease: (value) => {
    const prefs = { ...get().prefs, prerelease: value };
    savePrefs(prefs);
    set({ prefs });
  },
}));

/** Banner shows only for an available, non-skipped update that wasn't dismissed this session. */
export function selectUpdateBannerVisible(s: UpdateState): boolean {
  return s.status === 'available'
    && !s.bannerDismissed
    && !!s.result?.latestVersion
    && s.result.latestVersion !== s.prefs.skippedVersion;
}
