import React, { useEffect, useState } from 'react';
import { X, CheckCircle2, XCircle, Loader2, Trash2, ChevronDown, Plus, RefreshCw, HardDrive, Image as ImageIcon, Upload, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/app.store';
import { useSettingsStore } from '../../stores/settings.store';
import { useUpdateStore } from '../../stores/update.store';
import i18n from '../../i18n';
import type {
  IpcResponse,
  AppBackgroundFit,
  LearningSearchDepth,
  PickedLocalFile,
  ProviderConfig,
  ProviderModel,
  StorageCleanupResult,
  StorageStats,
  YouTubeCookiesMode,
  YtDlpInstallResult,
  YtDlpStatus,
  FfmpegStatus,
  WhisperStatus,
  WhisperInstallResult,
} from '@shared/types';
import { IPC } from '@shared/ipc-channels';
import { UI_LANGUAGES } from '@shared/i18n';
import { providerKeychainKey } from '../../utils/provider-key';
import { useLocalImageDataUrl } from '../../utils/local-image-data-url';
const GUIDANCE_VALUES = ['strict', 'balanced', 'loose'] as const;

type Section = 'appearance' | 'model' | 'learning' | 'search' | 'advanced' | 'about';

export const SettingsModal: React.FC = () => {
  const { t } = useTranslation();
  const isOpen = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const settings = useSettingsStore();
  const [activeSection, setActiveSection] = useState<Section>('appearance');
  useEffect(() => {
    if (isOpen && !settings.loaded) {
      settings.load().catch(console.error);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) setOpen(false);
  };

  return (
    <div
      className="ui-animated-backdrop"
      onClick={handleBackdrop}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.3)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div className="ui-animated-modal" style={{
        backgroundColor: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r2)',
        width: 720,
        height: 560,
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 20px',
          backgroundColor: 'var(--topbar)',
          flexShrink: 0,
        }}>
          <h2 style={{ fontSize: 15, fontWeight: 600 }}>{t('settings.title')}</h2>
          <button
            className="ui-pressable"
            onClick={() => setOpen(false)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text3)', padding: 4, borderRadius: 'var(--r)',
              display: 'flex', alignItems: 'center',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Sidebar nav */}
          <nav style={{
            width: 130,
            backgroundColor: 'var(--panel)',
            padding: '12px 8px',
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}>
            {([
              ['appearance', t('settings.nav_appearance')],
              ['model',      t('settings.nav_model')],
              ['learning',   t('settings.nav_learning')],
              ['search',     t('settings.nav_search')],
              ['advanced',   t('settings.nav_advanced')],
              ['about',      t('settings.nav_about')],
            ] as [Section, string][]).map(([key, label]) => (
              <button
                className="ui-pressable"
                key={key}
                onClick={() => setActiveSection(key)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 10px',
                  fontSize: 13,
                  borderRadius: 'var(--r)',
                  border: 'none',
                  cursor: 'pointer',
                  backgroundColor: activeSection === key ? 'var(--accent-s)' : 'transparent',
                  color: activeSection === key ? 'var(--accent)' : 'var(--text2)',
                  fontWeight: activeSection === key ? 500 : 400,
                  transition: 'all 0.1s',
                  fontFamily: 'var(--sans)',
                }}
              >
                {label}
              </button>
            ))}
          </nav>

          {/* Content */}
          <div style={{ flex: 1, padding: '20px 24px', overflowY: 'auto' }}>
            {activeSection === 'appearance' && (
              <AppearanceSection settings={settings} />
            )}
            {activeSection === 'model' && (
              <ModelSection settings={settings} />
            )}
            {activeSection === 'learning' && (
              <LearningSection settings={settings} />
            )}
            {activeSection === 'search' && (
              <SearchSection settings={settings} />
            )}
            {activeSection === 'advanced' && (
              <AdvancedSection settings={settings} />
            )}
            {activeSection === 'about' && (
              <AboutSection />
            )}
          </div>
        </div>

      </div>
    </div>
  );
};

// ── Section components ────────────────────────────────────────────────────────

const FieldLabel: React.FC<{ children: React.ReactNode; desc?: string }> = ({ children, desc }) => (
  <div style={{ marginBottom: 6 }}>
    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{children}</div>
    {desc && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{desc}</div>}
  </div>
);

const FieldRow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ marginBottom: 20 }}>{children}</div>
);

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  fontSize: 13,
  color: 'var(--text)',
  backgroundColor: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r)',
  outline: 'none',
  fontFamily: 'var(--mono)',
  transition: 'border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease',
};

// null = loading, true = configured, false = missing
type KeyStatusMap = Record<string, boolean | null>;

const KEY_HINT: Record<string, string> = {
  anthropic:  'console.anthropic.com',
  openai:     'platform.openai.com',
  gemini:     'aistudio.google.com',
  grok:       'console.x.ai',
  openrouter: 'openrouter.ai/keys',
  deepseek:   'platform.deepseek.com',
  qwen:       'dashscope.console.aliyun.com',
  minimax:    'platform.minimaxi.com',
  mistral:    'console.mistral.ai',
  groq:       'console.groq.com',
  together:   'api.together.xyz/settings/api-keys',
  moonshot:   'platform.moonshot.cn',
  zhipu:      'open.bigmodel.cn',
  doubao:     'console.volcengine.com/ark',
  perplexity: 'www.perplexity.ai/settings/api',
  cohere:     'dashboard.cohere.com/api-keys',
};

// ── ProviderRow — one row per provider with expandable key management ──────────

interface ProviderRowProps {
  provider: ProviderConfig;
  models: ProviderModel[];
  keyStatus: boolean | null;
  settings: ReturnType<typeof useSettingsStore.getState>;
  onDelete?: () => void;
  onKeyChange: () => void;
}

const ProviderRow: React.FC<ProviderRowProps> = ({ provider, models, keyStatus, settings, onDelete, onKeyChange }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [urlInput, setUrlInput] = useState(provider.baseUrl ?? '');
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchMsg, setFetchMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const isOllama = provider.type === 'ollama';
  const keychainKey = providerKeychainKey(provider);
  const noKey = keychainKey === null;

  const handleSaveKey = async () => {
    if (!keyInput) return;
    if (!keychainKey) return;
    await settings.saveApiKey(keychainKey, keyInput);
    setKeyInput('');
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    onKeyChange();
  };

  const handleDeleteKey = async () => {
    if (!keychainKey) return;
    setDeleting(true);
    try {
      await settings.deleteApiKey(keychainKey);
      await settings.clearProviderModels(provider.id);
      onKeyChange();
    }
    finally { setDeleting(false); }
  };

  const handleSaveUrl = async () => {
    await settings.updateProvider(provider.id, { baseUrl: urlInput });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleFetchModels = async () => {
    setFetchLoading(true);
    setFetchMsg(null);
    try {
      const res = await window.api.invoke(IPC.PROVIDER_FETCH_MODELS, provider.id) as IpcResponse<{ added: number; removed: number; models: string[] }>;
      if (!res.success) throw new Error(res.error ?? 'Fetch models failed');
      const result = res.data ?? { added: 0, removed: 0, models: [] };
      let fetchText = t('settings.model.models_updated');
      if (result.models.length === 0) {
        fetchText = result.removed > 0
          ? t('settings.model.models_empty_removed', { count: result.removed })
          : t('settings.model.models_empty');
      } else if (result.added > 0 && result.removed > 0) {
        fetchText = t('settings.model.models_added_removed', { added: result.added, removed: result.removed });
      } else if (result.added > 0) {
        fetchText = t('settings.model.models_added', { count: result.added });
      } else if (result.removed > 0) {
        fetchText = t('settings.model.models_removed', { count: result.removed });
      }
      setFetchMsg({
        text: fetchText,
        ok: result.models.length > 0,
      });
      await settings.loadProviders();
      const fresh = useSettingsStore.getState();
      if (!fresh.provider || !fresh.model) {
        const firstModel = fresh.models.find((m) => m.providerId === provider.id && m.source !== 'builtin');
        if (firstModel) fresh.setModel(firstModel.providerId, firstModel.modelId);
      }
      onKeyChange();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setFetchMsg({ text: msg.length > 50 ? msg.slice(0, 50) + '…' : msg, ok: false });
    } finally {
      setFetchLoading(false);
      setTimeout(() => setFetchMsg(null), 4000);
    }
  };

  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 'var(--r)',
      marginBottom: 6,
      overflow: 'hidden',
    }}>
      {/* Row header */}
      <div style={{
        display: 'flex', alignItems: 'center', padding: '7px 10px',
        gap: 8, cursor: 'pointer', backgroundColor: 'var(--surface)',
      }}
        onClick={() => setExpanded((v) => !v)}
      >
        <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{provider.name}</span>

        {/* Key status */}
        <span style={{ flexShrink: 0 }}>
          {noKey ? (
            <span style={{ fontSize: 11, color: 'var(--text3)' }}>{t('common.no_key')}</span>
          ) : keyStatus === null ? (
            <Loader2 size={12} style={{ color: 'var(--text3)', animation: 'spin 1s linear infinite' }} />
          ) : keyStatus ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--green)' }}>
              <CheckCircle2 size={12} /> {t('common.configured')}
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: '#ef4444' }}>
              <XCircle size={12} /> {t('common.not_configured')}
            </div>
          )}
        </span>

        {/* Custom provider delete */}
        {onDelete && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title={t('settings.model.delete_provider_title')}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text3)', padding: 2,
              display: 'flex', alignItems: 'center', flexShrink: 0,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#ef4444'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text3)'; }}
          >
            <Trash2 size={13} />
          </button>
        )}

        <ChevronDown size={13} style={{
          color: 'var(--text3)', flexShrink: 0,
          transition: 'transform 0.15s',
          transform: expanded ? 'rotate(180deg)' : 'none',
        }} />
      </div>

      {/* Expanded: key input or URL input */}
      {expanded && (
        <div style={{
          padding: '10px 10px 12px',
          borderTop: '1px solid var(--border)',
          backgroundColor: 'var(--bg)',
        }}>
          {isOllama ? (
            <>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 6 }}>{t('settings.model.service_url')}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="http://localhost:11434"
                  style={{ ...inputStyle, flex: 1, fontFamily: 'var(--mono)', fontSize: 12 }}
                />
                <button
                  onClick={handleSaveUrl}
                  disabled={!urlInput}
                  style={saveKeyBtnStyle(saved, !urlInput)}
                >
                  {saved ? t('common.saved') : t('common.save')}
                </button>
              </div>
            </>
          ) : !noKey ? (
            <>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 6 }}>
                API Key
                {KEY_HINT[provider.id] && (
                  <span style={{ color: 'var(--text3)', marginLeft: 6, fontSize: 11 }}>
                    · {t('common.apply_for', { hint: KEY_HINT[provider.id] })}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder={keyStatus ? t('settings.model.paste_new_key') : t('settings.model.paste_key')}
                  style={{ ...inputStyle, flex: 1 }}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSaveKey(); }}
                />
                <button
                  onClick={handleSaveKey}
                  disabled={!keyInput}
                  style={saveKeyBtnStyle(saved, !keyInput)}
                >
                  {saved ? t('common.saved') : t('common.save')}
                </button>
                {keyStatus === true && (
                  <button
                    onClick={handleDeleteKey}
                    disabled={deleting}
                    title={t('settings.model.delete_key_title')}
                    style={{
                      padding: '7px 10px', fontSize: 12,
                      color: deleting ? 'var(--text3)' : '#ef4444',
                      backgroundColor: 'transparent',
                      border: '1px solid #fecaca', borderRadius: 'var(--r)',
                      cursor: deleting ? 'not-allowed' : 'pointer',
                      display: 'flex', alignItems: 'center', gap: 4,
                      whiteSpace: 'nowrap', fontFamily: 'var(--sans)', flexShrink: 0,
                    }}
                  >
                    <Trash2 size={12} /> {t('common.delete')}
                  </button>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                {t('settings.model.key_stored_in_keychain')}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>{t('settings.model.no_key_needed')}</div>
          )}

          {/* Fetch models row */}
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={handleFetchModels}
              disabled={fetchLoading}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '5px 10px', fontSize: 12,
                color: 'var(--text2)', backgroundColor: 'var(--surface)',
                border: '1px solid var(--border)', borderRadius: 'var(--r)',
                cursor: fetchLoading ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--sans)', flexShrink: 0,
              }}
            >
              <RefreshCw size={11} style={{ animation: fetchLoading ? 'spin 1s linear infinite' : 'none' }} />
              {t('settings.model.fetch_models')}
            </button>
            {fetchMsg && (
              <span style={{ fontSize: 11, color: fetchMsg.ok ? 'var(--green)' : '#ef4444' }}>
                {fetchMsg.text}
              </span>
            )}
          </div>

          {models.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 2 }}>
                {t('settings.model.fetched_models', { count: models.length })}
              </div>
              <div style={{ maxHeight: 180, overflowY: 'auto', borderTop: '1px solid var(--border)' }}>
                {models.map((m) => (
                  <div key={m.id} style={{ borderBottom: '1px solid var(--border)', padding: '7px 0' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 12, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {m.label}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {m.modelId} · {m.source}
                        </div>
                      </div>
                      {m.tag && (
                        <span style={{ fontSize: 10, color: 'var(--accent)', backgroundColor: 'var(--accent-s)', padding: '1px 5px', borderRadius: 3, flexShrink: 0 }}>
                          {m.tag}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function saveKeyBtnStyle(saved: boolean, disabled: boolean): React.CSSProperties {
  return {
    padding: '7px 12px', fontSize: 12, fontWeight: 500, color: '#fff',
    backgroundColor: saved ? 'var(--green)' : disabled ? 'var(--border2)' : 'var(--accent)',
    border: 'none', borderRadius: 'var(--r)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    whiteSpace: 'nowrap', fontFamily: 'var(--sans)',
    transition: 'background-color 0.2s', flexShrink: 0,
  };
}

// ── ModelSection ──────────────────────────────────────────────────────────────

const ModelSection: React.FC<{ settings: ReturnType<typeof useSettingsStore.getState> }> = ({ settings }) => {
  const { t } = useTranslation();
  const [keyStatus, setKeyStatus] = useState<KeyStatusMap>({});
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', type: 'openai_compat' as 'openai_compat' | 'ollama', baseUrl: '', apiKeyName: '', apiKey: '' });
  const [addSaving, setAddSaving] = useState(false);

  const loadKeyStatus = React.useCallback(async () => {
    const entries = await Promise.all(
      settings.providers
        .filter((p) => providerKeychainKey(p))
        .map(async (p) => {
          const keychainKey = providerKeychainKey(p)!;
          const k = await settings.getApiKey(keychainKey);
          return [p.id, !!k] as [string, boolean];
        })
    );
    setKeyStatus(Object.fromEntries(entries));
  }, [settings.providers, settings.getApiKey]);  

  useEffect(() => {
    if (settings.providers.length > 0) loadKeyStatus();
  }, [settings.providers.length]);  

  const handleAddProvider = async () => {
    if (!addForm.name || !addForm.baseUrl) return;
    setAddSaving(true);
    try {
      const provider = await settings.createProvider({
        name: addForm.name,
        type: addForm.type,
        baseUrl: addForm.baseUrl,
        apiKeyName: addForm.type === 'openai_compat' && addForm.apiKeyName ? addForm.apiKeyName : undefined,
      });
      if (addForm.type === 'openai_compat' && addForm.apiKey) {
        await settings.saveApiKey(providerKeychainKey(provider) ?? provider.id, addForm.apiKey);
      }
      setAddForm({ name: '', type: 'openai_compat', baseUrl: '', apiKeyName: '', apiKey: '' });
      setShowAddProvider(false);
      loadKeyStatus();
    } finally {
      setAddSaving(false);
    }
  };

  const handleDeleteProvider = async (id: string) => {
    await settings.deleteProvider(id);
  };

  return (
    <div>
      <FieldRow>
        <FieldLabel desc={t('settings.model.api_key_desc')}>{t('settings.model.api_key_label')}</FieldLabel>
        <div>
          {settings.providers.map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              models={settings.models.filter((m) => m.providerId === p.id)}
              keyStatus={keyStatus[p.id] ?? null}
              settings={settings}
              onDelete={p.isBuiltin ? undefined : () => handleDeleteProvider(p.id)}
              onKeyChange={loadKeyStatus}
            />
          ))}
        </div>
      </FieldRow>

      {/* Add custom provider */}
      <FieldRow>
        <button
          onClick={() => setShowAddProvider((v) => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 12px', fontSize: 12, fontWeight: 500,
            color: 'var(--accent)', backgroundColor: 'var(--accent-s)',
            border: '1px solid var(--accent-b)', borderRadius: 'var(--r)',
            cursor: 'pointer', fontFamily: 'var(--sans)',
          }}
        >
          <Plus size={13} />
          {t('settings.model.add_provider_btn')}
        </button>

        {showAddProvider && (
          <div style={{
            marginTop: 10, padding: '12px 14px',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r2)',
            backgroundColor: 'var(--bg)',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>{t('settings.model.add_provider_name')}</div>
                <input
                  type="text"
                  value={addForm.name}
                  onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder={t('settings.model.add_provider_name_placeholder')}
                  style={{ ...inputStyle, fontSize: 12 }}
                />
              </div>
              <div style={{ width: 110 }}>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>{t('settings.model.add_provider_type')}</div>
                <select
                  value={addForm.type}
                  onChange={(e) => setAddForm((f) => ({ ...f, type: e.target.value as 'openai_compat' | 'ollama' }))}
                  style={{ ...inputStyle, fontSize: 12, padding: '7px 6px' }}
                >
                  <option value="openai_compat">{t('settings.model.add_provider_type_openai')}</option>
                  <option value="ollama">{t('settings.model.add_provider_type_ollama')}</option>
                </select>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>{t('settings.model.add_provider_url_label')}</div>
              <input
                type="text"
                value={addForm.baseUrl}
                onChange={(e) => setAddForm((f) => ({ ...f, baseUrl: e.target.value }))}
                placeholder={t('settings.model.add_provider_url_placeholder')}
                style={{ ...inputStyle, fontSize: 12, fontFamily: 'var(--mono)' }}
              />
            </div>
            {addForm.type === 'openai_compat' && (
              <>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>{t('settings.model.add_provider_key_name')}</div>
                    <input
                      type="text"
                      value={addForm.apiKeyName}
                      onChange={(e) => setAddForm((f) => ({ ...f, apiKeyName: e.target.value }))}
                      placeholder={t('settings.model.add_provider_key_name_placeholder')}
                      style={{ ...inputStyle, fontSize: 12 }}
                    />
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>{t('settings.model.add_provider_key')}</div>
                  <input
                    type="password"
                    value={addForm.apiKey}
                    onChange={(e) => setAddForm((f) => ({ ...f, apiKey: e.target.value }))}
                    placeholder={t('settings.model.add_provider_key_placeholder')}
                    style={{ ...inputStyle, fontSize: 12 }}
                  />
                </div>
              </>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowAddProvider(false)}
                style={{
                  padding: '6px 14px', fontSize: 12,
                  color: 'var(--text2)', backgroundColor: 'transparent',
                  border: '1px solid var(--border)', borderRadius: 'var(--r)',
                  cursor: 'pointer', fontFamily: 'var(--sans)',
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleAddProvider}
                disabled={addSaving || !addForm.name || !addForm.baseUrl}
                style={{
                  padding: '6px 16px', fontSize: 12, fontWeight: 500,
                  color: '#fff',
                  backgroundColor: addSaving || !addForm.name || !addForm.baseUrl ? 'var(--border2)' : 'var(--accent)',
                  border: 'none', borderRadius: 'var(--r)',
                  cursor: addSaving || !addForm.name || !addForm.baseUrl ? 'not-allowed' : 'pointer',
                  fontFamily: 'var(--sans)',
                }}
              >
                {addSaving ? t('settings.model.adding') : t('settings.model.btn_add')}
              </button>
            </div>
          </div>
        )}
      </FieldRow>
    </div>
  );
};

// ── AppearanceSection ─────────────────────────────────────────────────────────

const THEME_IDS = ['warm', 'white', 'dark'] as const;
const BACKGROUND_FITS: AppBackgroundFit[] = ['cover', 'contain', 'center'];
const THEME_PREVIEWS = {
  warm:  { sidebar: '#d4cfc5', topbar: '#e2ddd3', panel: '#eae6dc', bg: '#f2efe6', surface: '#faf7f0', text: '#1a1915', accent: '#c96442' },
  white: { sidebar: '#e6e6e6', topbar: '#efefef', panel: '#f5f5f5', bg: '#ffffff', surface: '#fafafa', text: '#1a1a1a', accent: '#c96442' },
  dark:  { sidebar: '#272727', topbar: '#2f2f2f', panel: '#363636', bg: '#2c2c2c', surface: '#3c3c3c', text: '#e2ddd6', accent: '#e07455' },
} as const;

function backgroundPreviewScrim(opacity: number): string {
  const pct = Math.round(Math.min(0.85, Math.max(0, opacity)) * 100);
  return `color-mix(in srgb, var(--bg) ${pct}%, transparent)`;
}

function backgroundPreviewFilter(opacity: number): string {
  const clamped = Math.min(0.85, Math.max(0, opacity));
  if (clamped <= 0.01) return 'none';
  return `blur(${Math.round(4 + clamped * 14)}px) saturate(${Math.round(104 + clamped * 18)}%)`;
}

const AppearanceSection: React.FC<{ settings: ReturnType<typeof useSettingsStore.getState> }> = ({ settings }) => {
  const { t, i18n: i18nInstance } = useTranslation();
  const [backgroundBusy, setBackgroundBusy] = useState(false);
  const [backgroundMessage, setBackgroundMessage] = useState<string | null>(null);
  const backgroundPreviewUrl = useLocalImageDataUrl(settings.backgroundImagePath);
  const backgroundActive = settings.backgroundImageEnabled && Boolean(settings.backgroundImagePath);

  const handleLanguageChange = (lang: string) => {
    i18nInstance.changeLanguage(lang);
    localStorage.setItem('ulyzer_lang', lang);
  };

  const chooseBackgroundImage = async () => {
    setBackgroundMessage(null);
    setBackgroundBusy(true);
    try {
      const pickRes = await window.api.invoke(IPC.FS_PICK_FILES, {
        accept: '.jpg,.jpeg,.png,.webp',
        importAs: 'background-image',
        multiple: false,
        title: t('settings.appearance.background_pick_title'),
      }) as IpcResponse<PickedLocalFile[]>;
      if (!pickRes.success) {
        setBackgroundMessage(pickRes.error ?? t('settings.appearance.background_import_failed'));
        return;
      }
      const file = pickRes.data?.[0];
      if (!file) return;
      const isFirstBackground = !settings.backgroundImagePath;

      settings.setPatch({
        backgroundImageEnabled: true,
        backgroundImagePath: file.path,
        ...(isFirstBackground ? {
          backgroundImageOpacity: Math.max(settings.backgroundImageOpacity, 0.72),
          backgroundOverlayOpacity: 0.38,
        } : {}),
      });
      await settings.save();
    } catch (error) {
      setBackgroundMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBackgroundBusy(false);
    }
  };

  const clearBackgroundImage = () => {
    settings.setPatch({
      backgroundImageEnabled: false,
      backgroundImagePath: '',
    });
    settings.save().catch(console.error);
  };

  const setBackgroundEnabled = (enabled: boolean) => {
    settings.setPatch({ backgroundImageEnabled: enabled && Boolean(settings.backgroundImagePath) });
    settings.save().catch(console.error);
  };

  const setBackgroundOpacity = (value: number) => {
    settings.setPatch({ backgroundImageOpacity: value });
  };

  const setBackgroundOverlayOpacity = (value: number) => {
    settings.setPatch({ backgroundOverlayOpacity: value });
  };

  const saveBackgroundOpacity = () => {
    settings.save().catch(console.error);
  };

  const setBackgroundFit = (fit: AppBackgroundFit) => {
    settings.setPatch({ backgroundImageFit: fit });
    settings.save().catch(console.error);
  };

  return (
  <div>
    <FieldRow>
      <FieldLabel desc={t('settings.appearance.theme_desc')}>{t('settings.appearance.theme_label')}</FieldLabel>
      <div style={{ display: 'flex', gap: 12 }}>
        {THEME_IDS.map((id) => {
          const isSelected = settings.theme === id;
          const p = THEME_PREVIEWS[id];
          return (
            <button
              key={id}
              onClick={() => { settings.setTheme(id); settings.save().catch(console.error); }}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                gap: 8, padding: '10px 10px 12px',
                border: `2px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 'var(--r2)',
                backgroundColor: isSelected ? 'var(--accent-s)' : 'transparent',
                cursor: 'pointer', transition: 'border-color 0.15s, background-color 0.15s',
                flex: 1,
              }}
            >
              {/* Mini UI preview */}
              <div style={{
                width: 100, height: 66,
                borderRadius: 5, overflow: 'hidden',
                border: '1px solid rgba(0,0,0,0.1)',
                display: 'flex', flexShrink: 0,
                boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
              }}>
                {/* Sidebar strip */}
                <div style={{ width: 14, backgroundColor: p.sidebar, flexShrink: 0 }} />
                {/* Main area */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                  {/* Topbar */}
                  <div style={{ height: 10, backgroundColor: p.topbar }} />
                  {/* Panel + content */}
                  <div style={{ flex: 1, display: 'flex' }}>
                    <div style={{ width: 28, backgroundColor: p.panel }} />
                    <div style={{ flex: 1, backgroundColor: p.bg, padding: '4px 5px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {/* Simulated text lines */}
                      <div style={{ height: 4, borderRadius: 2, backgroundColor: p.text, opacity: 0.7, width: '80%' }} />
                      <div style={{ height: 3, borderRadius: 2, backgroundColor: p.text, opacity: 0.35, width: '60%' }} />
                      <div style={{ height: 3, borderRadius: 2, backgroundColor: p.text, opacity: 0.35, width: '70%' }} />
                      {/* Accent button */}
                      <div style={{ height: 6, borderRadius: 2, backgroundColor: p.accent, width: '40%', marginTop: 2 }} />
                    </div>
                  </div>
                </div>
              </div>
              {/* Theme name */}
              <div style={{
                fontSize: 13, fontWeight: isSelected ? 600 : 500,
                color: isSelected ? 'var(--accent)' : 'var(--text)',
              }}>
                {t(`settings.appearance.theme_${id}` as Parameters<typeof t>[0])}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text3)', textAlign: 'center', lineHeight: 1.4 }}>
                {t(`settings.appearance.theme_${id}_desc` as Parameters<typeof t>[0])}
              </div>
            </button>
          );
        })}
      </div>
    </FieldRow>

    <FieldRow>
      <FieldLabel desc={t('settings.appearance.background_desc')}>{t('settings.appearance.background_label')}</FieldLabel>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '180px 1fr',
        gap: 14,
        alignItems: 'stretch',
      }}>
        <div style={{
          minHeight: 132,
          borderRadius: 'var(--r2)',
          border: '1px solid var(--border)',
          overflow: 'hidden',
          position: 'relative',
          backgroundColor: 'var(--panel)',
          boxShadow: 'var(--shadow)',
        }}>
          {backgroundPreviewUrl ? (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                backgroundImage: `url("${backgroundPreviewUrl}")`,
                backgroundSize: settings.backgroundImageFit === 'center' ? 'auto' : settings.backgroundImageFit,
                backgroundPosition: 'center',
                backgroundRepeat: 'no-repeat',
                opacity: settings.backgroundImageOpacity,
              }}
            />
          ) : (
            <div style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text3)',
            }}>
              <ImageIcon size={28} />
            </div>
          )}
          {backgroundPreviewUrl && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                backgroundColor: backgroundPreviewScrim(settings.backgroundOverlayOpacity),
                backdropFilter: backgroundPreviewFilter(settings.backgroundOverlayOpacity),
                WebkitBackdropFilter: backgroundPreviewFilter(settings.backgroundOverlayOpacity),
              }}
            />
          )}
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            gridTemplateRows: '22px 1fr',
            background: 'linear-gradient(180deg, rgba(0,0,0,0.10), rgba(0,0,0,0.02))',
          }}>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center', padding: '0 8px', backgroundColor: 'rgba(255,255,255,0.42)' }}>
              <span style={{ width: 32, height: 6, borderRadius: 3, backgroundColor: 'rgba(0,0,0,0.22)' }} />
              <span style={{ width: 54, height: 6, borderRadius: 3, backgroundColor: 'rgba(0,0,0,0.14)' }} />
            </div>
            <div style={{ display: 'flex' }}>
              <div style={{ width: 38, backgroundColor: 'rgba(255,255,255,0.30)' }} />
              <div style={{ flex: 1, padding: 12 }}>
                <div style={{ height: 8, width: '70%', borderRadius: 4, backgroundColor: 'rgba(0,0,0,0.18)', marginBottom: 8 }} />
                <div style={{ height: 6, width: '52%', borderRadius: 3, backgroundColor: 'rgba(0,0,0,0.12)', marginBottom: 8 }} />
                <div style={{ height: 22, width: 54, borderRadius: 5, backgroundColor: 'rgba(201,100,66,0.60)' }} />
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              onClick={() => chooseBackgroundImage().catch(console.error)}
              disabled={backgroundBusy}
              style={smallButtonStyle(backgroundBusy)}
            >
              {backgroundBusy ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Upload size={12} />}
              {settings.backgroundImagePath ? t('settings.appearance.background_replace') : t('settings.appearance.background_choose')}
            </button>
            <button
              onClick={clearBackgroundImage}
              disabled={!settings.backgroundImagePath}
              style={smallButtonStyle(!settings.backgroundImagePath, true)}
            >
              <EyeOff size={12} />
              {t('settings.appearance.background_clear')}
            </button>
            <label style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: settings.backgroundImagePath ? 'var(--text2)' : 'var(--text3)',
              cursor: settings.backgroundImagePath ? 'pointer' : 'not-allowed',
            }}>
              <input
                type="checkbox"
                checked={backgroundActive}
                disabled={!settings.backgroundImagePath}
                onChange={(event) => setBackgroundEnabled(event.target.checked)}
                style={{ accentColor: 'var(--accent)' }}
              />
              {t('settings.appearance.background_enabled')}
            </label>
          </div>

          <div style={{ fontSize: 11, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {settings.backgroundImagePath
              ? settings.backgroundImagePath.split(/[\\/]/).pop()
              : t('settings.appearance.background_empty')}
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>
              <span>{t('settings.appearance.background_opacity')}</span>
              <span>{Math.round(settings.backgroundImageOpacity * 100)}%</span>
            </div>
            <input
              type="range"
              min={10}
              max={100}
              step={1}
              value={Math.round(settings.backgroundImageOpacity * 100)}
              disabled={!settings.backgroundImagePath}
              onChange={(event) => setBackgroundOpacity(Number(event.target.value) / 100)}
              onMouseUp={saveBackgroundOpacity}
              onTouchEnd={saveBackgroundOpacity}
              onBlur={saveBackgroundOpacity}
              style={{ width: '100%', accentColor: 'var(--accent)' }}
            />
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>
              <span>{t('settings.appearance.background_overlay_opacity')}</span>
              <span>{Math.round(settings.backgroundOverlayOpacity * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={85}
              step={1}
              value={Math.round(settings.backgroundOverlayOpacity * 100)}
              disabled={!settings.backgroundImagePath}
              onChange={(event) => setBackgroundOverlayOpacity(Number(event.target.value) / 100)}
              onMouseUp={saveBackgroundOpacity}
              onTouchEnd={saveBackgroundOpacity}
              onBlur={saveBackgroundOpacity}
              style={{ width: '100%', accentColor: 'var(--accent)' }}
            />
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 6 }}>{t('settings.appearance.background_fit_label')}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {BACKGROUND_FITS.map((fit) => {
                const selected = settings.backgroundImageFit === fit;
                return (
                  <button
                    key={fit}
                    onClick={() => setBackgroundFit(fit)}
                    disabled={!settings.backgroundImagePath}
                    style={{
                      flex: 1,
                      padding: '6px 8px',
                      fontSize: 12,
                      borderRadius: 'var(--r)',
                      border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                      backgroundColor: selected ? 'var(--accent-s)' : 'var(--surface)',
                      color: !settings.backgroundImagePath ? 'var(--text3)' : selected ? 'var(--accent)' : 'var(--text2)',
                      cursor: settings.backgroundImagePath ? 'pointer' : 'not-allowed',
                      fontFamily: 'var(--sans)',
                    }}
                  >
                    {t(`settings.appearance.background_fit_${fit}` as Parameters<typeof t>[0])}
                  </button>
                );
              })}
            </div>
          </div>

          {backgroundMessage && (
            <div style={{ fontSize: 11, color: 'var(--accent)' }}>
              {backgroundMessage}
            </div>
          )}
        </div>
      </div>
    </FieldRow>

    {/* Language */}
    <FieldRow>
      <FieldLabel>{t('settings.appearance.language_label')}</FieldLabel>
      <div style={{ display: 'flex', gap: 8 }}>
        {UI_LANGUAGES.map((lang) => {
          const isActive = i18nInstance.language === lang.code;
          return (
            <button
              key={lang.code}
              onClick={() => handleLanguageChange(lang.code)}
              style={{
                padding: '6px 16px', fontSize: 13,
                border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 'var(--r)',
                backgroundColor: isActive ? 'var(--accent-s)' : 'transparent',
                color: isActive ? 'var(--accent)' : 'var(--text2)',
                fontWeight: isActive ? 600 : 400,
                cursor: 'pointer', fontFamily: 'var(--sans)',
                transition: 'all 0.1s',
              }}
            >
              {lang.label}
            </button>
          );
        })}
      </div>
    </FieldRow>
  </div>
  );
};

const LearningSection: React.FC<{ settings: ReturnType<typeof useSettingsStore.getState> }> = ({ settings }) => {
  const { t } = useTranslation();
  return (
  <div>
    <FieldRow>
      <FieldLabel desc={t('settings.learning.guidance_desc')}>{t('settings.learning.guidance_label')}</FieldLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {GUIDANCE_VALUES.map((value) => (
          <label
            key={value}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: '8px 10px',
              borderRadius: 'var(--r)',
              border: `1px solid ${settings.guidanceMode === value ? 'var(--accent-b)' : 'var(--border)'}`,
              backgroundColor: settings.guidanceMode === value ? 'var(--accent-s)' : 'transparent',
              cursor: 'pointer',
              transition: 'all 0.1s',
            }}
          >
            <input
              type="radio"
              name="guidanceMode"
              value={value}
              checked={settings.guidanceMode === value}
              onChange={() => { settings.setPatch({ guidanceMode: value }); settings.save().catch(console.error); }}
              style={{ marginTop: 2, accentColor: 'var(--accent)', flexShrink: 0 }}
            />
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{t(`settings.learning.guidance_${value}` as Parameters<typeof t>[0])}</div>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 1 }}>{t(`settings.learning.guidance_${value}_desc` as Parameters<typeof t>[0])}</div>
            </div>
          </label>
        ))}
      </div>
    </FieldRow>

  </div>
  );
};

const AdvancedSection: React.FC<{ settings: ReturnType<typeof useSettingsStore.getState> }> = ({ settings }) => {
  const { t } = useTranslation();
  const values = [1, 2, 3, 4] as const;
  const searchDepthValues: LearningSearchDepth[] = ['economy', 'standard', 'deep'];
  const searchNumberValues = [1, 2, 3, 4, 5, 6, 7, 8] as const;
  const cookieModes: YouTubeCookiesMode[] = ['none', 'safari', 'chrome', 'firefox', 'edge', 'brave', 'cookies_file'];
  const current = Math.min(4, Math.max(1, Math.trunc(Number(settings.ocrWorkerCount) || 2)));
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageAction, setStorageAction] = useState<string | null>(null);
  const [storageMessage, setStorageMessage] = useState<string | null>(null);
  const [youtubeProxyInput, setYoutubeProxyInput] = useState(settings.youtubeProxyUrl ?? '');
  const [ytDlpStatus, setYtDlpStatus] = useState<YtDlpStatus | null>(null);
  const [ytDlpBusy, setYtDlpBusy] = useState(false);
  const [ytDlpMessage, setYtDlpMessage] = useState<string | null>(null);
  const [whisperStatus, setWhisperStatus] = useState<WhisperStatus | null>(null);
  const [whisperBusy, setWhisperBusy] = useState(false);
  const [whisperMessage, setWhisperMessage] = useState<string | null>(null);
  const [ffmpegStatus, setFfmpegStatus] = useState<FfmpegStatus | null>(null);
  const [youtubeCookiesPathInput, setYoutubeCookiesPathInput] = useState(settings.youtubeCookiesPath ?? '');
  const [youtubeCookiesProfileInput, setYoutubeCookiesProfileInput] = useState(settings.youtubeCookiesProfile ?? '');
  const isBrowserCookieMode = ['safari', 'chrome', 'firefox', 'edge', 'brave'].includes(settings.youtubeCookiesMode);

  useEffect(() => {
    setYoutubeProxyInput(settings.youtubeProxyUrl ?? '');
  }, [settings.youtubeProxyUrl]);

  useEffect(() => {
    setYoutubeCookiesPathInput(settings.youtubeCookiesPath ?? '');
  }, [settings.youtubeCookiesPath]);

  useEffect(() => {
    setYoutubeCookiesProfileInput(settings.youtubeCookiesProfile ?? '');
  }, [settings.youtubeCookiesProfile]);

  const setWorkerCount = (value: number) => {
    settings.setPatch({ ocrWorkerCount: value });
    settings.save().catch(console.error);
  };

  const saveSearchPatch = (patch: Parameters<typeof settings.setPatch>[0]) => {
    settings.setPatch(patch);
    settings.save().catch(console.error);
  };

  const saveYoutubeProxy = () => {
    settings.setPatch({ youtubeProxyUrl: youtubeProxyInput.trim() });
    settings.save().catch(console.error);
  };

  const saveYouTubeCookies = (
    mode = settings.youtubeCookiesMode,
    path = youtubeCookiesPathInput,
    profile = youtubeCookiesProfileInput,
  ) => {
    settings.setPatch({
      youtubeCookiesMode: mode,
      youtubeCookiesPath: path.trim(),
      youtubeCookiesProfile: profile.trim(),
    });
    settings.save().catch(console.error);
  };

  const chooseCookiesFile = async () => {
    const res = await window.api.invoke(IPC.FS_PICK_FILES, {
      accept: '.txt',
      multiple: false,
      title: t('settings.advanced.youtube_cookies_pick_title'),
    }) as IpcResponse<PickedLocalFile[]>;
    const file = res.success ? res.data?.[0] : null;
    if (!file) return;
    setYoutubeCookiesPathInput(file.path);
    settings.setPatch({ youtubeCookiesMode: 'cookies_file', youtubeCookiesPath: file.path });
    settings.save().catch(console.error);
  };

  const loadYtDlpStatus = async () => {
    const res = await window.api.invoke(IPC.YTDLP_STATUS) as IpcResponse<YtDlpStatus>;
    if (res.success && res.data) setYtDlpStatus(res.data);
  };

  const installYtDlp = async () => {
    setYtDlpBusy(true);
    setYtDlpMessage(null);
    try {
      const res = await window.api.invoke(IPC.YTDLP_INSTALL) as IpcResponse<YtDlpInstallResult>;
      if (!res.success || !res.data) {
        setYtDlpMessage(res.error ?? t('settings.advanced.ytdlp_install_failed'));
        await loadYtDlpStatus().catch(() => {});
        return;
      }
      setYtDlpStatus(res.data);
      setYtDlpMessage(t('settings.advanced.ytdlp_installed', { version: res.data.version ?? '' }));
    } finally {
      setYtDlpBusy(false);
    }
  };

  const loadWhisperStatus = async () => {
    const res = await window.api.invoke(IPC.WHISPER_STATUS) as IpcResponse<WhisperStatus>;
    if (res.success && res.data) setWhisperStatus(res.data);
  };

  const loadFfmpegStatus = async () => {
    const res = await window.api.invoke(IPC.FFMPEG_STATUS) as IpcResponse<FfmpegStatus>;
    if (res.success && res.data) setFfmpegStatus(res.data);
  };

  const installWhisper = async () => {
    setWhisperBusy(true);
    setWhisperMessage(null);
    try {
      const res = await window.api.invoke(IPC.WHISPER_INSTALL) as IpcResponse<WhisperInstallResult>;
      if (!res.success || !res.data) {
        setWhisperMessage(res.error ?? t('settings.advanced.whisper_install_failed'));
        await loadWhisperStatus().catch(() => {});
        return;
      }
      setWhisperStatus(res.data);
      setWhisperMessage(res.data.installed ? t('settings.advanced.whisper_installed') : (res.data.error ?? t('settings.advanced.whisper_install_failed')));
    } finally {
      setWhisperBusy(false);
    }
  };

  const loadStorageStats = async () => {
    setStorageLoading(true);
    try {
      const res = await window.api.invoke(IPC.STORAGE_STATS) as IpcResponse<StorageStats>;
      if (res.success && res.data) setStorageStats(res.data);
    } finally {
      setStorageLoading(false);
    }
  };

  useEffect(() => {
    loadStorageStats().catch(() => {});
    loadYtDlpStatus().catch(() => {});
    loadWhisperStatus().catch(() => {});
    loadFfmpegStatus().catch(() => {});
  }, []);

  const runStorageAction = async (
    actionId: string,
    channel: typeof IPC.STORAGE_CLEANUP_ORPHANS | typeof IPC.STORAGE_CLEAR_OCR_CACHE | typeof IPC.STORAGE_CLEAR_RUNTIME_CACHE,
  ) => {
    setStorageAction(actionId);
    setStorageMessage(null);
    try {
      const res = await window.api.invoke(channel) as IpcResponse<StorageCleanupResult>;
      if (!res.success || !res.data) {
        setStorageMessage(res.error ?? t('settings.advanced.storage_action_failed'));
        return;
      }
      setStorageMessage(t('settings.advanced.storage_cleaned', {
        count: res.data.removedCount + res.data.resolvedCount,
        size: formatBytes(res.data.freedBytes),
      }));
      await loadStorageStats();
    } finally {
      setStorageAction(null);
    }
  };

  const confirmRuntimeClean = () => {
    if (window.confirm(t('settings.advanced.storage_runtime_confirm'))) {
      runStorageAction('runtime', IPC.STORAGE_CLEAR_RUNTIME_CACHE).catch(() => {});
    }
  };

  return (
    <div>
      <FieldRow>
        <FieldLabel desc={t('settings.advanced.ocr_worker_desc')}>
          {t('settings.advanced.ocr_worker_label')}
        </FieldLabel>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          {values.map((value) => {
            const selected = current === value;
            return (
              <button
                key={value}
                onClick={() => setWorkerCount(value)}
                style={{
                  width: 44,
                  height: 32,
                  borderRadius: 'var(--r)',
                  border: `1px solid ${selected ? 'var(--accent-b)' : 'var(--border)'}`,
                  backgroundColor: selected ? 'var(--accent-s)' : 'transparent',
                  color: selected ? 'var(--accent)' : 'var(--text2)',
                  fontSize: 13,
                  fontWeight: selected ? 600 : 500,
                  cursor: 'pointer',
                  fontFamily: 'var(--sans)',
                }}
              >
                {value}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
          {t('settings.advanced.ocr_worker_help')}
        </div>
      </FieldRow>

      <FieldRow>
        <FieldLabel desc={t('settings.advanced.search_budget_desc')}>
          {t('settings.advanced.search_budget_label')}
        </FieldLabel>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          {searchDepthValues.map((depth) => {
            const selected = settings.learningSearchDepth === depth;
            return (
              <button
                key={depth}
                type="button"
                onClick={() => saveSearchPatch({ learningSearchDepth: depth })}
                style={{
                  flex: 1,
                  height: 32,
                  borderRadius: 'var(--r)',
                  border: `1px solid ${selected ? 'var(--accent-b)' : 'var(--border)'}`,
                  backgroundColor: selected ? 'var(--accent-s)' : 'transparent',
                  color: selected ? 'var(--accent)' : 'var(--text2)',
                  fontSize: 12,
                  fontWeight: selected ? 600 : 500,
                  cursor: 'pointer',
                  fontFamily: 'var(--sans)',
                }}
              >
                {t(`settings.advanced.search_depth_${depth}` as Parameters<typeof t>[0])}
              </button>
            );
          })}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>
              {t('settings.advanced.search_max_queries')}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {searchNumberValues.map((value) => {
                const selected = settings.learningSearchMaxQueries === value;
                return (
                  <button
                    key={`query-${value}`}
                    type="button"
                    onClick={() => saveSearchPatch({ learningSearchMaxQueries: value })}
                    style={{
                      width: 30,
                      height: 28,
                      borderRadius: 'var(--r)',
                      border: `1px solid ${selected ? 'var(--accent-b)' : 'var(--border)'}`,
                      backgroundColor: selected ? 'var(--accent-s)' : 'transparent',
                      color: selected ? 'var(--accent)' : 'var(--text2)',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    {value}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>
              {t('settings.advanced.search_max_pages')}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {searchNumberValues.map((value) => {
                const selected = settings.learningSearchMaxPages === value;
                return (
                  <button
                    key={`page-${value}`}
                    type="button"
                    onClick={() => saveSearchPatch({ learningSearchMaxPages: value })}
                    style={{
                      width: 30,
                      height: 28,
                      borderRadius: 'var(--r)',
                      border: `1px solid ${selected ? 'var(--accent-b)' : 'var(--border)'}`,
                      backgroundColor: selected ? 'var(--accent-s)' : 'transparent',
                      color: selected ? 'var(--accent)' : 'var(--text2)',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    {value}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
          {([
            ['learningSearchAutoIngest', 'search_auto_ingest'] as const,
            ['learningSearchAllowCommunity', 'search_allow_community'] as const,
            ['learningSearchUseExa', 'search_use_exa'] as const,
            ['learningSearchTavilyAdvanced', 'search_tavily_advanced'] as const,
          ]).map(([key, label]) => (
            <label
              key={key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                fontSize: 12,
                color: 'var(--text2)',
                cursor: 'pointer',
                minWidth: 0,
              }}
            >
              <input
                type="checkbox"
                checked={Boolean(settings[key])}
                onChange={(event) => saveSearchPatch({ [key]: event.target.checked })}
              />
              <span>{t(`settings.advanced.${label}` as Parameters<typeof t>[0])}</span>
            </label>
          ))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
          {t('settings.advanced.search_budget_help')}
        </div>
      </FieldRow>

      <FieldRow>
        <FieldLabel desc={t('settings.advanced.youtube_proxy_desc')}>
          {t('settings.advanced.youtube_proxy_label')}
        </FieldLabel>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={youtubeProxyInput}
            onChange={(event) => setYoutubeProxyInput(event.target.value)}
            onBlur={saveYoutubeProxy}
            placeholder={t('settings.advanced.youtube_proxy_placeholder')}
            style={{ ...inputStyle, flex: 1, fontSize: 12 }}
          />
          <button
            type="button"
            onClick={saveYoutubeProxy}
            style={smallButtonStyle(false)}
          >
            {t('common.save')}
          </button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.6, marginTop: 6 }}>
          {t('settings.advanced.youtube_proxy_help')}
        </div>
      </FieldRow>

      <FieldRow>
        <FieldLabel desc={t('settings.advanced.youtube_cookies_desc')}>
          {t('settings.advanced.youtube_cookies_label')}
        </FieldLabel>
        <select
          value={settings.youtubeCookiesMode}
          onChange={(event) => saveYouTubeCookies(event.target.value as YouTubeCookiesMode)}
          style={{ ...inputStyle, fontSize: 12, marginBottom: 8 }}
        >
          {cookieModes.map((mode) => (
            <option key={mode} value={mode}>
              {t(`settings.advanced.youtube_cookies_mode_${mode}` as Parameters<typeof t>[0])}
            </option>
          ))}
        </select>
        {settings.youtubeCookiesMode === 'cookies_file' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input
              value={youtubeCookiesPathInput}
              onChange={(event) => setYoutubeCookiesPathInput(event.target.value)}
              onBlur={() => saveYouTubeCookies('cookies_file')}
              placeholder={t('settings.advanced.youtube_cookies_path_placeholder')}
              style={{ ...inputStyle, flex: 1, fontSize: 12 }}
            />
            <button
              type="button"
              onClick={() => chooseCookiesFile().catch((error) => setYtDlpMessage(error instanceof Error ? error.message : String(error)))}
              style={smallButtonStyle(false)}
            >
              {t('settings.advanced.youtube_cookies_choose')}
            </button>
          </div>
        )}
        {isBrowserCookieMode && (
          <input
            value={youtubeCookiesProfileInput}
            onChange={(event) => setYoutubeCookiesProfileInput(event.target.value)}
            onBlur={() => saveYouTubeCookies(settings.youtubeCookiesMode, youtubeCookiesPathInput)}
            placeholder={t('settings.advanced.youtube_cookies_profile_placeholder')}
            style={{ ...inputStyle, fontSize: 12, marginBottom: 8 }}
          />
        )}
        <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
          {t('settings.advanced.youtube_cookies_help')}
        </div>
      </FieldRow>

      <FieldRow>
        <FieldLabel desc={t('settings.advanced.ytdlp_desc')}>
          {t('settings.advanced.ytdlp_label')}
        </FieldLabel>
        <div style={{
          border: '1px solid var(--border)',
          borderRadius: 'var(--r2)',
          background: 'var(--surface2)',
          padding: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                {ytDlpStatus?.available
                  ? <CheckCircle2 size={14} color="rgb(22, 101, 52)" />
                  : <XCircle size={14} color="var(--warning, #b7791f)" />}
                {ytDlpStatus === null
                  ? t('common.loading')
                  : ytDlpStatus.available
                    ? t('settings.advanced.ytdlp_ready', { version: ytDlpStatus.version ?? '' })
                    : t('settings.advanced.ytdlp_missing')}
              </div>
              <div style={{ marginTop: 5, fontSize: 11, color: 'var(--text3)', lineHeight: 1.5, wordBreak: 'break-all' }}>
                {ytDlpStatus?.available
                  ? ytDlpStatus.path
                  : ytDlpStatus?.error ?? t('settings.advanced.ytdlp_missing_help')}
              </div>
            </div>
            <button
              type="button"
              onClick={() => installYtDlp().catch((error) => {
                setYtDlpMessage(error instanceof Error ? error.message : String(error));
                setYtDlpBusy(false);
              })}
              disabled={ytDlpBusy}
              style={smallButtonStyle(ytDlpBusy)}
            >
              {ytDlpBusy ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={12} />}
              {ytDlpStatus?.available ? t('settings.advanced.ytdlp_update') : t('settings.advanced.ytdlp_install')}
            </button>
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text3)', lineHeight: 1.5, wordBreak: 'break-all' }}>
            {t('settings.advanced.ytdlp_install_path', { path: ytDlpStatus?.installPath ?? '' })}
          </div>
          {ytDlpMessage && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text3)', lineHeight: 1.5 }}>
              {ytDlpMessage}
            </div>
          )}
        </div>
      </FieldRow>

      <FieldRow>
        <FieldLabel desc={t('settings.advanced.whisper_desc')}>
          {t('settings.advanced.whisper_label')}
        </FieldLabel>
        <div style={{
          border: '1px solid var(--border)',
          borderRadius: 'var(--r2)',
          background: 'var(--surface2)',
          padding: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                {whisperStatus?.available
                  ? <CheckCircle2 size={14} color="rgb(22, 101, 52)" />
                  : <XCircle size={14} color="var(--warning, #b7791f)" />}
                {whisperStatus === null
                  ? t('common.loading')
                  : whisperStatus.available
                    ? t('settings.advanced.whisper_ready')
                    : t('settings.advanced.whisper_missing')}
              </div>
              <div style={{ marginTop: 5, fontSize: 11, color: 'var(--text3)', lineHeight: 1.5, wordBreak: 'break-all' }}>
                {whisperStatus?.available
                  ? t('settings.advanced.whisper_ready_help')
                  : whisperStatus?.error ?? t('settings.advanced.whisper_missing_help')}
              </div>
            </div>
            {whisperStatus?.platformSupported !== false && (
              <button
                type="button"
                onClick={() => installWhisper().catch((error) => {
                  setWhisperMessage(error instanceof Error ? error.message : String(error));
                  setWhisperBusy(false);
                })}
                disabled={whisperBusy}
                style={smallButtonStyle(whisperBusy)}
              >
                {whisperBusy ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={12} />}
                {whisperStatus?.available ? t('settings.advanced.whisper_update') : t('settings.advanced.whisper_install')}
              </button>
            )}
          </div>
          {whisperMessage && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text3)', lineHeight: 1.5 }}>
              {whisperMessage}
            </div>
          )}
        </div>
      </FieldRow>

      <FieldRow>
        <FieldLabel desc={t('settings.advanced.ffmpeg_desc')}>
          {t('settings.advanced.ffmpeg_label')}
        </FieldLabel>
        <div style={{
          border: '1px solid var(--border)',
          borderRadius: 'var(--r2)',
          background: 'var(--surface2)',
          padding: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
            {ffmpegStatus?.available
              ? <CheckCircle2 size={14} color="rgb(22, 101, 52)" />
              : <XCircle size={14} color="var(--warning, #b7791f)" />}
            {ffmpegStatus === null
              ? t('common.loading')
              : ffmpegStatus.available
                ? t('settings.advanced.ffmpeg_ready')
                : t('settings.advanced.ffmpeg_missing')}
          </div>
          <div style={{ marginTop: 5, fontSize: 11, color: 'var(--text3)', lineHeight: 1.5, wordBreak: 'break-all' }}>
            {ffmpegStatus?.available
              ? ffmpegStatus.path
              : t('settings.advanced.ffmpeg_install_help')}
          </div>
        </div>
      </FieldRow>

      <FieldRow>
        <FieldLabel desc={t('settings.advanced.storage_desc')}>
          {t('settings.advanced.storage_label')}
        </FieldLabel>
        <div style={{
          border: '1px solid var(--border)',
          borderRadius: 'var(--r2)',
          background: 'var(--surface2)',
          padding: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <HardDrive size={15} color="var(--text3)" />
              <span style={{ fontSize: 12, color: 'var(--text2)', fontWeight: 600 }}>
                {storageStats ? formatBytes(storageStats.totalBytes) : t('common.loading')}
              </span>
              {storageStats && (
                <span style={{ fontSize: 11, color: 'var(--text3)' }}>
                  {t('settings.advanced.storage_pending', {
                    orphan: storageStats.orphanAssetCount,
                    pending: storageStats.pendingCleanupCount + storageStats.failedCleanupCount,
                  })}
                </span>
              )}
            </div>
            <button
              onClick={() => loadStorageStats().catch(() => {})}
              disabled={storageLoading}
              style={smallButtonStyle(storageLoading)}
            >
              {storageLoading ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={12} />}
              {t('settings.advanced.storage_refresh')}
            </button>
          </div>

          {storageStats && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
              {storageStats.areas.map((area) => (
                <div key={area.key} style={{
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r)',
                  background: 'var(--surface)',
                  padding: '8px 10px',
                  minWidth: 0,
                }}>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>{localizedStorageArea(area.key, t)}</div>
                  <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600 }}>{formatBytes(area.bytes)}</div>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button
              onClick={() => runStorageAction('orphans', IPC.STORAGE_CLEANUP_ORPHANS).catch(() => {})}
              disabled={Boolean(storageAction)}
              style={smallButtonStyle(Boolean(storageAction))}
            >
              {storageAction === 'orphans' ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Trash2 size={12} />}
              {t('settings.advanced.storage_cleanup_orphans')}
            </button>
            <button
              onClick={() => runStorageAction('ocr', IPC.STORAGE_CLEAR_OCR_CACHE).catch(() => {})}
              disabled={Boolean(storageAction)}
              style={smallButtonStyle(Boolean(storageAction))}
            >
              {storageAction === 'ocr' ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Trash2 size={12} />}
              {t('settings.advanced.storage_clear_ocr')}
            </button>
            <button
              onClick={confirmRuntimeClean}
              disabled={Boolean(storageAction)}
              style={smallButtonStyle(Boolean(storageAction), true)}
            >
              {storageAction === 'runtime' ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Trash2 size={12} />}
              {t('settings.advanced.storage_clear_runtime')}
            </button>
          </div>
          {storageMessage && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text3)', lineHeight: 1.5 }}>
              {storageMessage}
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text3)', lineHeight: 1.5 }}>
            {t('settings.advanced.storage_help')}
          </div>
        </div>
      </FieldRow>
    </div>
  );
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function smallButtonStyle(disabled: boolean, danger = false): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '6px 10px',
    fontSize: 12,
    borderRadius: 'var(--r)',
    border: '1px solid var(--border)',
    background: danger ? '#fef2f2' : 'var(--surface)',
    color: disabled ? 'var(--border2)' : danger ? '#b91c1c' : 'var(--text2)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'var(--sans)',
  };
}

function localizedStorageArea(key: StorageStats['areas'][number]['key'], t: ReturnType<typeof useTranslation>['t']): string {
  return t(`settings.advanced.storage_area_${key}` as Parameters<typeof t>[0]);
}

const SEARCH_KEY_PROVIDERS = [
  {
    id: 'tavily',
    label: 'Tavily Search API Key',
    desc: i18n.t('settings.search.tavily_desc'),
    placeholder: 'tvly-...',
  },
  {
    id: 'exa',
    label: 'Exa Search API Key',
    desc: i18n.t('settings.search.exa_desc'),
    placeholder: 'exa_...',
  },
  {
    id: 'youtube',
    label: 'YouTube Data API Key',
    desc: i18n.t('settings.search.youtube_desc'),
    placeholder: 'AIza...',
  },
] as const;

const SearchSection: React.FC<{ settings: ReturnType<typeof useSettingsStore.getState> }> = ({ settings }) => {
  const { t } = useTranslation();
  const [keyInputs, setKeyInputs] = React.useState<Record<string, string>>({});
  const [savedMap, setSavedMap] = React.useState<Record<string, boolean>>({});
  const [deletingMap, setDeletingMap] = React.useState<Record<string, boolean>>({});
  const [keyStatus, setKeyStatus] = React.useState<Record<string, boolean | null>>(() =>
    Object.fromEntries(SEARCH_KEY_PROVIDERS.map((p) => [p.id, null]))
  );

  const loadStatus = React.useCallback(async () => {
    const entries = await Promise.all(
      SEARCH_KEY_PROVIDERS.map(async (p) => {
        const k = await settings.getApiKey(p.id);
        return [p.id, !!k] as [string, boolean];
      })
    );
    setKeyStatus(Object.fromEntries(entries));
  }, [settings]);

  React.useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleSave = async (id: string) => {
    const val = keyInputs[id] ?? '';
    if (!val) return;
    await settings.saveApiKey(id, val);
    setKeyInputs((prev) => ({ ...prev, [id]: '' }));
    setSavedMap((prev) => ({ ...prev, [id]: true }));
    setTimeout(() => setSavedMap((prev) => ({ ...prev, [id]: false })), 2000);
    loadStatus();
  };

  const handleDelete = async (id: string) => {
    setDeletingMap((prev) => ({ ...prev, [id]: true }));
    try {
      await settings.deleteApiKey(id);
      loadStatus();
    } finally {
      setDeletingMap((prev) => ({ ...prev, [id]: false }));
    }
  };

  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 16, lineHeight: 1.6 }}>
        {t('settings.search.intro')}
      </div>

      {SEARCH_KEY_PROVIDERS.map((p) => {
        const status = keyStatus[p.id];
        const isSaved = savedMap[p.id];
        const isDeleting = deletingMap[p.id];
        const val = keyInputs[p.id] ?? '';
        return (
          <FieldRow key={p.id}>
            <FieldLabel desc={t(`settings.search.${p.id}_desc` as Parameters<typeof t>[0])}>
              {t(`settings.search.${p.id}_label` as Parameters<typeof t>[0])}
              <span style={{ marginLeft: 8 }}>
                {status === null ? (
                  <Loader2 size={11} style={{ color: 'var(--text3)', display: 'inline', verticalAlign: 'middle' }} />
                ) : status ? (
                  <CheckCircle2 size={11} style={{ color: 'var(--green)', display: 'inline', verticalAlign: 'middle' }} />
                ) : (
                  <XCircle size={11} style={{ color: '#ef4444', display: 'inline', verticalAlign: 'middle' }} />
                )}
              </span>
            </FieldLabel>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="password"
                value={val}
                onChange={(e) => setKeyInputs((prev) => ({ ...prev, [p.id]: e.target.value }))}
                placeholder={status ? t('settings.search.paste_new_key') : p.placeholder}
                style={{ ...inputStyle, flex: 1 }}
              />
              <button
                onClick={() => handleSave(p.id)}
                disabled={!val}
                style={{
                  padding: '7px 12px', fontSize: 12, fontWeight: 500, color: '#fff',
                  backgroundColor: isSaved ? 'var(--green)' : 'var(--accent)',
                  border: 'none', borderRadius: 'var(--r)',
                  cursor: !val ? 'not-allowed' : 'pointer',
                  opacity: !val ? 0.5 : 1,
                  whiteSpace: 'nowrap', fontFamily: 'var(--sans)',
                  transition: 'background-color 0.2s',
                }}
              >
                {isSaved ? t('common.saved') : t('common.save')}
              </button>
              {status === true && (
                <button
                  onClick={() => handleDelete(p.id)}
                  disabled={isDeleting}
                  title={t('settings.search.delete_key_title')}
                  style={{
                    padding: '7px 10px', fontSize: 12,
                    color: isDeleting ? 'var(--text3)' : '#ef4444',
                    backgroundColor: 'transparent',
                    border: '1px solid #fecaca', borderRadius: 'var(--r)',
                    cursor: isDeleting ? 'not-allowed' : 'pointer',
                    display: 'flex', alignItems: 'center', gap: 4,
                    whiteSpace: 'nowrap', fontFamily: 'var(--sans)',
                    flexShrink: 0,
                  }}
                >
                  <Trash2 size={13} />
                  {t('common.delete')}
                </button>
              )}
            </div>
          </FieldRow>
        );
      })}
    </div>
  );
};

const AboutSection: React.FC = () => {
  const { t } = useTranslation();
  const status = useUpdateStore((s) => s.status);
  const result = useUpdateStore((s) => s.result);
  const prefs = useUpdateStore((s) => s.prefs);
  const check = useUpdateStore((s) => s.check);
  const openDownload = useUpdateStore((s) => s.openDownload);
  const setAutoCheck = useUpdateStore((s) => s.setAutoCheck);
  const setPrerelease = useUpdateStore((s) => s.setPrerelease);

  // Populate the current version (and surface any update) when About opens.
  useEffect(() => {
    if (status === 'idle') void check(false);
  }, [status, check]);

  const displayVersion = result?.currentVersion ?? '…';

  return (
  <div style={{ color: 'var(--text2)' }}>
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
        Uly<span style={{ color: 'var(--accent)' }}>zer</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>v{displayVersion}</div>
    </div>

    {/* Update controls */}
    <div style={{
      border: '1px solid var(--border)', borderRadius: 'var(--r2)',
      padding: '12px 14px', marginBottom: 16,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          onClick={() => void check(true)}
          disabled={status === 'checking'}
          style={smallButtonStyle(status === 'checking')}
        >
          <RefreshCw size={12} style={{ animation: status === 'checking' ? 'spin 1s linear infinite' : 'none' }} />
          {t('update.check_now')}
        </button>
        <span style={{ fontSize: 12, color: 'var(--text3)', minWidth: 0 }}>
          {status === 'checking' && t('update.checking')}
          {status === 'latest' && t('update.latest')}
          {status === 'error' && t('update.error')}
          {status === 'available' && result?.latestVersion && (
            <span>
              {t('update.new_version', { version: result.latestVersion, current: displayVersion })}{' '}
              <button
                onClick={openDownload}
                style={{
                  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                  color: 'var(--accent)', fontSize: 'inherit', fontFamily: 'inherit', textDecoration: 'underline',
                }}
              >
                {t('update.download')}
              </button>
            </span>
          )}
        </span>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text2)', cursor: 'pointer' }}>
        <input type="checkbox" checked={prefs.autoCheck} onChange={(e) => setAutoCheck(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
        {t('update.auto_check')}
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text2)', cursor: 'pointer' }}>
        <input type="checkbox" checked={prefs.prerelease} onChange={(e) => setPrerelease(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
        {t('update.receive_prerelease')}
      </label>
    </div>

    <p style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 12 }}>
      {t('settings.about.description')}
    </p>
    <div style={{ fontSize: 12, color: 'var(--text3)', lineHeight: 1.8, marginBottom: 16 }}>
      <div>{t('settings.about.tech_stack')}</div>
      <div>{t('settings.about.database')}</div>
      <div>{t('settings.about.ai_models')}</div>
    </div>
    <div style={{
      borderTop: '1px solid var(--border)',
      paddingTop: 14,
      fontSize: 12,
      color: 'var(--text3)',
      lineHeight: 1.8,
    }}>
      <div style={{ marginBottom: 4, color: 'var(--text2)', fontWeight: 500 }}>{t('settings.about.thanks_title')}</div>
      <div>
        {t('settings.about.thanks_reactflow').replace('React Flow', '')}{' '}
        <button
          onClick={() => window.api.invoke('shell:open-url', 'https://reactflow.dev')}
          style={{
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--accent)', fontSize: 'inherit', fontFamily: 'inherit',
          }}
        >
          React Flow
        </button>
      </div>
    </div>
  </div>
  );
};
