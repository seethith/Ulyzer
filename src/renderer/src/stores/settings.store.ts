import { create } from 'zustand';
import { IPC } from '@shared/ipc-channels';
import type { Settings, GuidanceMode, IpcResponse, ProviderConfig, ProviderModel, CreateProviderDto, CreateModelDto, AppTheme } from '@shared/types';

async function dbInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await window.api.invoke(channel as Parameters<typeof window.api.invoke>[0], ...args)) as IpcResponse<T>;
  if (!res.success) throw new Error(res.error ?? 'IPC error');
  return res.data as T;
}

interface SettingsState {
  provider: string;
  model: string;
  guidanceMode: GuidanceMode;
  fontSize: number;
  rememberLayout: boolean;
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
    'createModel' | 'deleteModel'
  >>) => void;
  setTheme: (theme: AppTheme) => void;
  getApiKey: (provider: string) => Promise<string | null>;
  saveApiKey: (provider: string, key: string) => Promise<void>;
  deleteApiKey: (provider: string) => Promise<void>;

  loadProviders: () => Promise<void>;
  createProvider: (dto: CreateProviderDto) => Promise<ProviderConfig>;
  updateProvider: (id: string, data: Partial<Pick<ProviderConfig, 'name' | 'baseUrl' | 'apiKeyName' | 'enabled'>>) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  createModel: (dto: CreateModelDto) => Promise<ProviderModel>;
  deleteModel: (id: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  guidanceMode: 'strict',
  fontSize: 13,
  rememberLayout: true,
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
    // Apply theme to DOM immediately on load
    document.documentElement.setAttribute('data-theme', theme);
    set({
      provider: s.default_provider,
      model: s.default_model,
      guidanceMode: s.guidance_mode,
      fontSize: s.font_size,
      rememberLayout: s.remember_layout,
      loaded: true,
      providers,
      models,
      theme,
    });
  },

  save: async () => {
    const s = get();
    await dbInvoke<Settings>(IPC.SETTINGS_SAVE, {
      default_provider: s.provider,
      default_model: s.model,
      guidance_mode: s.guidanceMode,
      font_size: s.fontSize,
      remember_layout: s.rememberLayout,
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
    set({ providers, models });
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
    }));
  },

  createModel: async (dto: CreateModelDto) => {
    const model = await dbInvoke<ProviderModel>(IPC.DB_MODEL_CREATE, dto);
    set((s) => ({ models: [...s.models, model] }));
    return model;
  },

  deleteModel: async (id: string) => {
    await dbInvoke<void>(IPC.DB_MODEL_DELETE, id);
    set((s) => ({ models: s.models.filter((m) => m.id !== id) }));
  },
}));
