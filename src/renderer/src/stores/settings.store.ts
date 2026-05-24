import { create } from 'zustand';
import { IPC } from '@shared/ipc-channels';
import type { Settings, GuidanceMode, IpcResponse, ProviderConfig, ProviderModel, CreateProviderDto, UpdateModelDto, AppTheme, AppBackgroundFit, YouTubeCookiesMode, LearningSearchDepth } from '@shared/types';

async function dbInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await window.api.invoke(channel as Parameters<typeof window.api.invoke>[0], ...args)) as IpcResponse<T>;
  if (!res.success) throw new Error(res.error ?? 'IPC error');
  return res.data as T;
}

function resolveAvailableSelection(
  provider: string,
  model: string,
  providers: ProviderConfig[],
  models: ProviderModel[],
): { provider: string; model: string } {
  const providerConfig = providers.find((p) => p.id === provider);
  if (
    provider &&
    model &&
    providerConfig?.enabled === true &&
    models.some((m) => m.providerId === provider && m.modelId === model && m.source !== 'builtin')
  ) {
    return { provider, model };
  }
  return { provider: '', model: '' };
}

function normalizeOcrWorkerCount(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 2;
  return Math.min(4, Math.max(1, Math.trunc(n)));
}

function normalizeLearningSearchMax(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(8, Math.max(1, Math.trunc(n)));
}

interface SettingsState {
  provider: string;
  model: string;
  guidanceMode: GuidanceMode;
  fontSize: number;
  rememberLayout: boolean;
  ocrWorkerCount: number;
  learningSearchDepth: LearningSearchDepth;
  learningSearchMaxQueries: number;
  learningSearchMaxPages: number;
  learningSearchAutoIngest: boolean;
  learningSearchAllowCommunity: boolean;
  learningSearchUseExa: boolean;
  learningSearchTavilyAdvanced: boolean;
  youtubeProxyUrl: string;
  youtubeCookiesMode: YouTubeCookiesMode;
  youtubeCookiesPath: string;
  youtubeCookiesProfile: string;
  backgroundImageEnabled: boolean;
  backgroundImagePath: string;
  backgroundImageOpacity: number;
  backgroundOverlayOpacity: number;
  backgroundImageFit: AppBackgroundFit;
  loaded: boolean;

  providers: ProviderConfig[];
  models: ProviderModel[];
  theme: AppTheme;

  load: () => Promise<void>;
  save: () => Promise<void>;
  setModel: (provider: string, model: string) => void;
  setPatch: (patch: Partial<Omit<SettingsState,
    'load' | 'save' | 'setModel' | 'setPatch' | 'setTheme' |
    'getApiKey' | 'saveApiKey' | 'deleteApiKey' |
    'loadProviders' | 'createProvider' | 'updateProvider' | 'deleteProvider' |
    'updateModel' | 'clearProviderModels'
  >>) => void;
  setTheme: (theme: AppTheme) => void;
  getApiKey: (provider: string) => Promise<string | null>;
  saveApiKey: (provider: string, key: string) => Promise<void>;
  deleteApiKey: (provider: string) => Promise<void>;

  loadProviders: () => Promise<void>;
  createProvider: (dto: CreateProviderDto) => Promise<ProviderConfig>;
  updateProvider: (id: string, data: Partial<Pick<ProviderConfig, 'name' | 'baseUrl' | 'apiKeyName' | 'enabled'>>) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  updateModel: (id: string, data: UpdateModelDto) => Promise<ProviderModel>;
  clearProviderModels: (providerId: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  provider: '',
  model: '',
  guidanceMode: 'strict',
  fontSize: 13,
  rememberLayout: true,
  ocrWorkerCount: 2,
  learningSearchDepth: 'standard',
  learningSearchMaxQueries: 4,
  learningSearchMaxPages: 4,
  learningSearchAutoIngest: true,
  learningSearchAllowCommunity: false,
  learningSearchUseExa: true,
  learningSearchTavilyAdvanced: false,
  youtubeProxyUrl: '',
  youtubeCookiesMode: 'none',
  youtubeCookiesPath: '',
  youtubeCookiesProfile: '',
  backgroundImageEnabled: false,
  backgroundImagePath: '',
  backgroundImageOpacity: 0.72,
  backgroundOverlayOpacity: 0.38,
  backgroundImageFit: 'cover',
  loaded: false,
  providers: [],
  models: [],
  theme: 'warm',

  load: async () => {
    const [s, providers, models] = await Promise.all([
      dbInvoke<Settings>(IPC.SETTINGS_GET),
      dbInvoke<ProviderConfig[]>(IPC.DB_PROVIDER_LIST),
      dbInvoke<ProviderModel[]>(IPC.DB_MODEL_LIST),
    ]);
    const theme = (s.theme ?? 'warm') as AppTheme;
    const selection = resolveAvailableSelection(s.default_provider, s.default_model, providers, models);
    // Apply theme to DOM immediately on load
    document.documentElement.setAttribute('data-theme', theme);
    set({
      provider: selection.provider,
      model: selection.model,
      guidanceMode: s.guidance_mode,
      fontSize: s.font_size,
      rememberLayout: s.remember_layout,
      ocrWorkerCount: normalizeOcrWorkerCount(s.ocr_worker_count),
      learningSearchDepth: s.learning_search_depth ?? 'standard',
      learningSearchMaxQueries: normalizeLearningSearchMax(s.learning_search_max_queries, 4),
      learningSearchMaxPages: normalizeLearningSearchMax(s.learning_search_max_pages, 4),
      learningSearchAutoIngest: s.learning_search_auto_ingest ?? true,
      learningSearchAllowCommunity: s.learning_search_allow_community ?? false,
      learningSearchUseExa: s.learning_search_use_exa ?? true,
      learningSearchTavilyAdvanced: s.learning_search_tavily_advanced ?? false,
      youtubeProxyUrl: s.youtube_proxy_url ?? '',
      youtubeCookiesMode: s.youtube_cookies_mode ?? 'none',
      youtubeCookiesPath: s.youtube_cookies_path ?? '',
      youtubeCookiesProfile: s.youtube_cookies_profile ?? '',
      backgroundImageEnabled: s.background_image_enabled ?? false,
      backgroundImagePath: s.background_image_path ?? '',
      backgroundImageOpacity: s.background_image_opacity ?? 0.72,
      backgroundOverlayOpacity: s.background_overlay_opacity ?? 0.38,
      backgroundImageFit: s.background_image_fit ?? 'cover',
      loaded: true,
      providers,
      models,
      theme,
    });
    if (selection.provider !== s.default_provider || selection.model !== s.default_model) {
      await dbInvoke<Settings>(IPC.SETTINGS_SAVE, {
        default_provider: selection.provider,
        default_model: selection.model,
      });
    }
  },

  save: async () => {
    const s = get();
    await dbInvoke<Settings>(IPC.SETTINGS_SAVE, {
      default_provider: s.provider,
      default_model: s.model,
      guidance_mode: s.guidanceMode,
      font_size: s.fontSize,
      remember_layout: s.rememberLayout,
      ocr_worker_count: normalizeOcrWorkerCount(s.ocrWorkerCount),
      learning_search_depth: s.learningSearchDepth,
      learning_search_max_queries: normalizeLearningSearchMax(s.learningSearchMaxQueries, 4),
      learning_search_max_pages: normalizeLearningSearchMax(s.learningSearchMaxPages, 4),
      learning_search_auto_ingest: s.learningSearchAutoIngest,
      learning_search_allow_community: s.learningSearchAllowCommunity,
      learning_search_use_exa: s.learningSearchUseExa,
      learning_search_tavily_advanced: s.learningSearchTavilyAdvanced,
      youtube_proxy_url: s.youtubeProxyUrl.trim(),
      youtube_cookies_mode: s.youtubeCookiesMode,
      youtube_cookies_path: s.youtubeCookiesPath.trim(),
      youtube_cookies_profile: s.youtubeCookiesProfile.trim(),
      background_image_enabled: s.backgroundImageEnabled,
      background_image_path: s.backgroundImagePath.trim(),
      background_image_opacity: s.backgroundImageOpacity,
      background_overlay_opacity: s.backgroundOverlayOpacity,
      background_image_fit: s.backgroundImageFit,
      theme: s.theme,
    });
  },

  setModel: (provider, model) => {
    set({ provider, model });
    // Persist immediately so the choice survives app restarts
    get().save().catch(() => {/* non-fatal */});
  },

  setPatch: (patch) => set(patch),

  setTheme: (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    set({ theme });
  },

  getApiKey: async (provider: string) => {
    const res = await window.api.invoke(IPC.SETTINGS_GET_KEY, provider) as IpcResponse<string | null>;
    return res.success ? (res.data ?? null) : null;
  },

  saveApiKey: async (provider: string, key: string) => {
    await dbInvoke<void>(IPC.SETTINGS_SAVE_KEY, provider, key);
  },

  deleteApiKey: async (provider: string) => {
    await window.api.invoke(IPC.SETTINGS_DELETE_KEY, provider);
  },

  loadProviders: async () => {
    const [providers, models] = await Promise.all([
      dbInvoke<ProviderConfig[]>(IPC.DB_PROVIDER_LIST),
      dbInvoke<ProviderModel[]>(IPC.DB_MODEL_LIST),
    ]);
    const current = get();
    const selection = resolveAvailableSelection(current.provider, current.model, providers, models);
    set({ providers, models, ...selection });
    if (selection.provider !== current.provider || selection.model !== current.model) {
      get().save().catch(() => {/* non-fatal */});
    }
  },

  createProvider: async (dto: CreateProviderDto) => {
    const provider = await dbInvoke<ProviderConfig>(IPC.DB_PROVIDER_CREATE, dto);
    set((s) => ({ providers: [...s.providers, provider] }));
    return provider;
  },

  updateProvider: async (id: string, data) => {
    await dbInvoke<void>(IPC.DB_PROVIDER_UPDATE, id, data);
    set((s) => ({
      providers: s.providers.map((p) => p.id === id ? { ...p, ...data } : p),
    }));
  },

  deleteProvider: async (id: string) => {
    await dbInvoke<void>(IPC.DB_PROVIDER_DELETE, id);
    set((s) => ({
      providers: s.providers.filter((p) => p.id !== id),
      models: s.models.filter((m) => m.providerId !== id),
      ...(s.provider === id ? { provider: '', model: '' } : {}),
    }));
  },

  updateModel: async (id: string, data: UpdateModelDto) => {
    const model = await dbInvoke<ProviderModel>(IPC.DB_MODEL_UPDATE, id, data);
    set((s) => ({ models: s.models.map((m) => m.id === id ? model : m) }));
    return model;
  },

  clearProviderModels: async (providerId: string) => {
    await dbInvoke<void>(IPC.DB_MODEL_CLEAR_PROVIDER, providerId);
    set((s) => ({
      models: s.models.filter((m) => m.providerId !== providerId),
      ...(s.provider === providerId ? { provider: '', model: '' } : {}),
    }));
  },
}));
