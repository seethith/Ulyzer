import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { ChevronDown, AlertTriangle, CheckCircle2, X, Search } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settings.store';
import type { ProviderConfig, ProviderModel } from '@shared/types';
import { providerKeychainKey } from '../../utils/provider-key';

// ── ModelPickerModal — rendered via portal to avoid clipping ──────────────────

interface ModalProps {
  providers: ProviderConfig[];
  models: ProviderModel[];
  keyStatus: Record<string, boolean | null>;
  currentProvider: string;
  currentModel: string;
  onSelect: (provider: string, model: string) => void;
  onClose: () => void;
}

const ModelPickerModal: React.FC<ModalProps> = ({
  providers, keyStatus, currentProvider, currentModel,
  models, onSelect, onClose,
}) => {
  const { t } = useTranslation();
  const [leftProvider, setLeftProvider] = useState<string>(currentProvider || providers[0]?.id || '');
  const [search, setSearch] = useState('');
  const [modelSearch, setModelSearch] = useState('');

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    if (leftProvider && providers.some((p) => p.id === leftProvider)) return;
    setLeftProvider(providers[0]?.id ?? '');
  }, [leftProvider, providers]);

  useEffect(() => {
    setModelSearch('');
  }, [leftProvider]);

  const rightModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    const providerModels = models.filter((m) => m.providerId === leftProvider);
    if (!q) return providerModels;
    return providerModels.filter((m) => (
      m.label.toLowerCase().includes(q) ||
      m.modelId.toLowerCase().includes(q) ||
      m.tag.toLowerCase().includes(q)
    ));
  }, [models, leftProvider, modelSearch]);

  // Alphabetically sorted providers, filtered by search query
  const visibleProviders = useMemo(() => {
    const q = search.trim().toLowerCase();
    const sorted = [...providers].sort((a, b) => a.name.localeCompare(b.name));
    if (!q) return sorted;
    return sorted.filter((p) => {
      if (p.name.toLowerCase().includes(q)) return true;
      // Also include if any model label matches
      return models.some((m) => m.providerId === p.id && m.label.toLowerCase().includes(q));
    });
  }, [providers, models, search]);

  return createPortal(
    <div
      className="ui-animated-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0,
        backgroundColor: 'rgba(0,0,0,0.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1200,
      }}
    >
      <div className="ui-animated-modal" style={{
        backgroundColor: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r2)',
        width: 520,
        height: 420,
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 8px 32px rgba(0,0,0,0.16)',
        overflow: 'hidden',
      }}>
        {/* Modal header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 16px',
          backgroundColor: 'var(--topbar)',
          flexShrink: 0,
          borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{t('model_selector.select_model')}</span>
          <button
            className="ui-pressable"
            onClick={onClose}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text3)', padding: 2, borderRadius: 'var(--r)',
              display: 'flex', alignItems: 'center',
            }}
          >
            <X size={15} />
          </button>
        </div>

        {/* Two-panel body */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Left: provider list */}
          <div style={{
            width: 180,
            borderRight: '1px solid var(--border)',
            overflowY: 'auto',
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: 'var(--panel)',
          }}>
            {/* Search box */}
            <div style={{
              padding: '6px 8px',
              borderBottom: '1px solid var(--border)',
              flexShrink: 0,
              display: 'flex', alignItems: 'center', gap: 5,
              backgroundColor: 'var(--panel)',
            }}>
              <Search size={12} style={{ color: 'var(--text3)', flexShrink: 0 }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('model_selector.search_placeholder')}
                autoFocus
                style={{
                  flex: 1, border: 'none', outline: 'none', fontSize: 12,
                  backgroundColor: 'transparent', color: 'var(--text)',
                  fontFamily: 'var(--sans)',
                }}
              />
            </div>
            {/* Provider list (alphabetical, flat) */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
              {visibleProviders.map((p) => {
                const isActive = p.id === leftProvider;
                const isCurrent = p.id === currentProvider;
                const ks = keyStatus[p.id];
                const noKeyNeeded = providerKeychainKey(p) === null;
                const keyMissing = ks === false;
                const hasKey = ks === true;

                return (
                  <button
                    className="ui-pressable"
                    key={p.id}
                    onClick={() => setLeftProvider(p.id)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '7px 12px',
                      fontSize: 13,
                      textAlign: 'left',
                      color: isActive ? 'var(--accent)' : 'var(--text)',
                      backgroundColor: isActive ? 'var(--accent-s)' : 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      fontFamily: 'var(--sans)',
                      gap: 6,
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface2)';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.backgroundColor = isActive ? 'var(--accent-s)' : 'transparent';
                    }}
                  >
                    <span style={{
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontWeight: isCurrent ? 600 : 400,
                      flex: 1,
                    }}>
                      {p.name}
                    </span>
                    <span style={{ flexShrink: 0, lineHeight: 1, display: 'flex', alignItems: 'center' }}>
                      {noKeyNeeded ? (
                        <span style={{ fontSize: 9, color: 'var(--text3)' }}>{t('model_selector.local')}</span>
                      ) : hasKey ? (
                        <CheckCircle2 size={12} style={{ color: 'var(--green)' }} />
                      ) : keyMissing ? (
                        <AlertTriangle size={12} style={{ color: '#f97316' }} />
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right: model list */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{
              padding: '6px 10px',
              borderBottom: '1px solid var(--border)',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              backgroundColor: 'var(--surface)',
            }}>
              <Search size={12} style={{ color: 'var(--text3)', flexShrink: 0 }} />
              <input
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                placeholder={t('model_selector.search_model_placeholder')}
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: 'none',
                  outline: 'none',
                  fontSize: 12,
                  backgroundColor: 'transparent',
                  color: 'var(--text)',
                  fontFamily: 'var(--sans)',
                }}
              />
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0', minWidth: 0 }}>
              {rightModels.length === 0 ? (
                <div style={{
                  padding: '40px 20px',
                  fontSize: 12,
                  color: 'var(--text3)',
                  textAlign: 'center',
                  lineHeight: 1.8,
                }}>
                  {t('model_selector.no_models')}<br />
                  <span style={{ fontSize: 11 }}>{t('model_selector.fetch_models_hint')}</span>
                </div>
              ) : (
                rightModels.map((opt) => {
                  const isSelected = opt.providerId === currentProvider && opt.modelId === currentModel;
                  const keyMissing = keyStatus[opt.providerId] === false;

                  return (
                    <button
                      className="ui-pressable"
                      key={opt.id}
                      onClick={() => { onSelect(opt.providerId, opt.modelId); onClose(); }}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '8px 16px',
                        fontSize: 13,
                        textAlign: 'left',
                        color: isSelected ? 'var(--accent)' : keyMissing ? 'var(--text3)' : 'var(--text)',
                        backgroundColor: isSelected ? 'var(--accent-s)' : 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        fontFamily: 'var(--sans)',
                        gap: 10,
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface2)';
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLButtonElement).style.backgroundColor = isSelected ? 'var(--accent-s)' : 'transparent';
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
                        {keyMissing && <AlertTriangle size={11} style={{ color: '#f97316', flexShrink: 0 }} />}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {opt.label}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                        {keyMissing && (
                          <span style={{
                            fontSize: 10, color: '#f97316',
                            backgroundColor: '#fff7ed', border: '1px solid #fed7aa',
                            padding: '1px 5px', borderRadius: 3, fontWeight: 500,
                          }}>
                            {t('common.not_configured')}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

// ── ModelSelector — trigger button ────────────────────────────────────────────

export const ModelSelector: React.FC = () => {
  const { t } = useTranslation();
  const { provider, model, setModel, getApiKey, providers, models } = useSettingsStore();
  const [open, setOpen] = useState(false);
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean | null>>({});

  // Check API key status for all providers
  useEffect(() => {
    if (!providers.length) return;
    for (const p of providers) {
      const keychainKey = providerKeychainKey(p);
      if (!keychainKey) {
        setKeyStatus((prev) => ({ ...prev, [p.id]: true }));
        continue;
      }
      getApiKey(keychainKey).then((key) => {
        setKeyStatus((prev) => ({ ...prev, [p.id]: !!key }));
      });
    }
  }, [providers, getApiKey]);

  const selectableProviders = useMemo(() => {
    return providers.filter((p) => {
      if (!p.enabled) return false;
      const hasModels = models.some((m) => m.providerId === p.id && m.source !== 'builtin');
      if (!hasModels) return false;
      const keychainKey = providerKeychainKey(p);
      if (!keychainKey) return true;
      return keyStatus[p.id] === true;
    });
  }, [providers, models, keyStatus]);

  const selectableModels = useMemo(() => {
    const providerIds = new Set(selectableProviders.map((p) => p.id));
    return models.filter((m) => m.source !== 'builtin' && providerIds.has(m.providerId));
  }, [models, selectableProviders]);

  const currentModel: ProviderModel | undefined = selectableModels.find(
    (m) => m.providerId === provider && m.modelId === model
  );
  const currentLabel = currentModel?.label ?? t('model_selector.select_model');
  const currentKeyOk = keyStatus[provider] !== false;
  const currentKeyLoading = keyStatus[provider] === undefined || keyStatus[provider] === null;
  const keyMissing = Boolean(provider && model && !currentKeyLoading && !currentKeyOk);
  const noSelectableModels = selectableModels.length === 0;

  const handleSelect = useCallback((p: string, m: string) => {
    setModel(p, m);
  }, [setModel]);

  return (
    <>
      <button
        className="ui-pressable"
        onClick={() => setOpen(true)}
        title={noSelectableModels ? t('model_selector.fetch_models_hint') : keyMissing ? `${currentLabel}: ${t('model_selector.no_key_warning')}` : t('model_selector.select_model')}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '3px 7px',
          minHeight: 26,
          fontSize: 12,
          color: 'var(--text2)',
          backgroundColor: open ? 'var(--surface2)' : 'transparent',
          border: `1px solid ${keyMissing || !currentModel ? '#fca5a5' : 'var(--border)'}`,
          borderRadius: 'var(--r)', cursor: 'pointer',
          whiteSpace: 'nowrap', fontFamily: 'var(--sans)',
          // Hug the content (basis: auto) so a short model name doesn't leave
          // trailing whitespace; still shrink/ellipsize and cap very long names.
          flex: '0 1 auto',
          minWidth: 0,
          maxWidth: 'min(180px, 42%)',
          overflow: 'hidden',
          transition: 'background-color 0.1s, border-color 0.1s',
        }}
      >
        {(keyMissing || !currentModel) && <AlertTriangle size={11} style={{ color: '#ef4444', flexShrink: 0 }} />}
        <span style={{
          color: keyMissing || !currentModel ? '#ef4444' : 'var(--text)',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {currentLabel}
        </span>
        <ChevronDown size={12} style={{ flexShrink: 0 }} />
      </button>

      {open && (
        <ModelPickerModal
          providers={selectableProviders}
          models={selectableModels}
          keyStatus={keyStatus}
          currentProvider={provider}
          currentModel={model}
          onSelect={handleSelect}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
};
