import React, { useEffect, useState } from 'react';
import { X, CheckCircle2, XCircle, Loader2, Trash2, ChevronDown, Plus, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/app.store';
import { useSettingsStore } from '../../stores/settings.store';
import type { ProviderConfig } from '@shared/types';
import { IPC } from '@shared/ipc-channels';
const GUIDANCE_VALUES = ['strict', 'balanced', 'loose'] as const;

type Section = 'appearance' | 'model' | 'learning' | 'search' | 'about';

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
      <div style={{
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
              ['about',      t('settings.nav_about')],
            ] as [Section, string][]).map(([key, label]) => (
              <button
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
  keyStatus: boolean | null;
  settings: ReturnType<typeof useSettingsStore.getState>;
  onDelete?: () => void;
  onKeyChange: () => void;
}

const ProviderRow: React.FC<ProviderRowProps> = ({ provider, keyStatus, settings, onDelete, onKeyChange }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [urlInput, setUrlInput] = useState(provider.baseUrl ?? '');
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchMsg, setFetchMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const isOllama = provider.type === 'ollama';
  const noKey = !provider.apiKeyName;

  const handleSaveKey = async () => {
    if (!keyInput) return;
    await settings.saveApiKey(provider.id, keyInput);
    setKeyInput('');
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    onKeyChange();
  };

  const handleDeleteKey = async () => {
    setDeleting(true);
    try { await settings.deleteApiKey(provider.id); onKeyChange(); }
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
      const result = await window.api.invoke(IPC.PROVIDER_FETCH_MODELS, { providerId: provider.id }) as { added: number; models: string[] };
      setFetchMsg({ text: result.added > 0 ? t('settings.model.models_added', { count: result.added }) : t('settings.model.models_updated'), ok: true });
      onKeyChange(); // trigger reload
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
        .filter((p) => p.apiKeyName)
        .map(async (p) => {
          const k = await settings.getApiKey(p.id);
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
        await settings.saveApiKey(provider.id, addForm.apiKey);
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
const THEME_PREVIEWS = {
  warm:  { sidebar: '#d4cfc5', topbar: '#e2ddd3', panel: '#eae6dc', bg: '#f2efe6', surface: '#faf7f0', text: '#1a1915', accent: '#c96442' },
  white: { sidebar: '#e6e6e6', topbar: '#efefef', panel: '#f5f5f5', bg: '#ffffff', surface: '#fafafa', text: '#1a1a1a', accent: '#c96442' },
  dark:  { sidebar: '#272727', topbar: '#2f2f2f', panel: '#363636', bg: '#2c2c2c', surface: '#3c3c3c', text: '#e2ddd6', accent: '#e07455' },
} as const;

const AppearanceSection: React.FC<{ settings: ReturnType<typeof useSettingsStore.getState> }> = ({ settings }) => {
  const { t, i18n: i18nInstance } = useTranslation();

  const handleLanguageChange = (lang: string) => {
    i18nInstance.changeLanguage(lang);
    localStorage.setItem('ulyzer_lang', lang);
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

    {/* Language */}
    <FieldRow>
      <FieldLabel>{t('settings.appearance.language_label')}</FieldLabel>
      <div style={{ display: 'flex', gap: 8 }}>
        {(['zh', 'en'] as const).map((lang) => {
          const isActive = i18nInstance.language === lang;
          return (
            <button
              key={lang}
              onClick={() => handleLanguageChange(lang)}
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
              {t(`settings.appearance.language_${lang}` as Parameters<typeof t>[0])}
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

const SEARCH_KEY_PROVIDERS = [
  {
    id: 'tavily',
    label: 'Tavily Search API Key',
    desc: '通用网络搜索，擅长时效性内容（免费版每月 1000 次）。申请地址：app.tavily.com',
    placeholder: 'tvly-...',
  },
  {
    id: 'exa',
    label: 'Exa Search API Key',
    desc: '语义神经搜索，擅长找权威文档、学术论文、高质量教程，与 Tavily 互补（免费版每月 1000 次）。申请地址：exa.ai',
    placeholder: 'exa_...',
  },
  {
    id: 'youtube',
    label: 'YouTube Data API Key',
    desc: '用于体育/音乐/艺术等课题自动搜索教学视频（免费配额每日 10000 单位）。在 Google Cloud Console 申请。',
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
  return (
  <div style={{ color: 'var(--text2)' }}>
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
        Uly<span style={{ color: 'var(--accent)' }}>zer</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>v0.1.0-dev</div>
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
