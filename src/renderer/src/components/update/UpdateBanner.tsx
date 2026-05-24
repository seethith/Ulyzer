import React from 'react';
import { Download, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUpdateStore, selectUpdateBannerVisible } from '../../stores/update.store';

/** Slim full-width banner shown under the top chrome when a newer release exists. */
export const UpdateBanner: React.FC = () => {
  const { t } = useTranslation();
  const visible = useUpdateStore(selectUpdateBannerVisible);
  const result = useUpdateStore((s) => s.result);
  const openDownload = useUpdateStore((s) => s.openDownload);
  const dismissBanner = useUpdateStore((s) => s.dismissBanner);
  const skipVersion = useUpdateStore((s) => s.skipVersion);

  if (!visible || !result?.latestVersion) return null;

  return (
    <div
      role="status"
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '6px 12px', flexShrink: 0,
        borderBottom: '1px solid var(--accent-b)',
        background: 'var(--accent-s)', color: 'var(--text)', fontSize: 12.5,
      }}
    >
      <Download size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {t('update.new_version', { version: result.latestVersion, current: result.currentVersion })}
        {result.prerelease ? ` · ${t('update.prerelease_tag')}` : ''}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto', flexShrink: 0 }}>
        <button
          className="ui-pressable"
          onClick={openDownload}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '3px 12px', borderRadius: 6, cursor: 'pointer',
            border: '1px solid var(--accent-b)', background: 'var(--accent)', color: '#fff', fontSize: 12,
          }}
        >
          {t('update.download')}
        </button>
        <button
          className="ui-pressable"
          onClick={skipVersion}
          style={{
            padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
            border: 'none', background: 'transparent', color: 'var(--text3)', fontSize: 12,
          }}
        >
          {t('update.skip')}
        </button>
        <button
          className="ui-pressable"
          onClick={dismissBanner}
          title={t('update.later')}
          aria-label={t('update.later')}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, borderRadius: 6, cursor: 'pointer',
            border: 'none', background: 'transparent', color: 'var(--text3)',
          }}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};
