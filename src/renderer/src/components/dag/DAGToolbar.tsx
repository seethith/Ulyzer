import React from 'react';
import { Save, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface DAGToolbarProps {
  isGenerating: boolean;
  onSave: () => void;
}

export const DAGToolbar: React.FC<DAGToolbarProps> = ({
  isGenerating,
  onSave,
}) => {
  const { t } = useTranslation();
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      padding: '6px 10px',
      backgroundColor: 'var(--panel)',
      flexShrink: 0,
    }}>
      {/* Generating indicator */}
      {isGenerating && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--accent)' }}>
          <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
          <span>{t('dag_toolbar.generating')}</span>
        </div>
      )}

      <div style={{ flex: 1 }} />

      {/* Save */}
      <ToolbarBtn
        onClick={onSave}
        disabled={isGenerating}
        title={t('dag_toolbar.save_title')}
        icon={<Save size={13} />}
        label={t('dag_toolbar.save')}
      />
    </div>
  );
};

// ── Sub-components ────────────────────────────────────────────────────────────

const ToolbarBtn: React.FC<{
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  icon: React.ReactNode;
  label: string;
  accent?: boolean;
  danger?: boolean;
}> = ({ onClick, disabled, title, icon, label, accent, danger }) => {
  const baseColor = danger ? '#b45309' : accent ? 'var(--accent)' : 'var(--text2)';

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 8px',
        fontSize: 12,
        color: disabled ? 'var(--text3)' : baseColor,
        backgroundColor: 'transparent',
        border: '1px solid transparent',
        borderRadius: 'var(--r)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'var(--sans)',
        opacity: disabled ? 0.6 : 1,
        transition: 'background-color 0.1s, border-color 0.1s',
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={(e) => {
        if (!disabled) {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = danger
            ? 'var(--amber-s)'
            : accent
            ? 'var(--accent-s)'
            : 'var(--surface2)';
          (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)';
        }
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
        (e.currentTarget as HTMLButtonElement).style.borderColor = 'transparent';
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
};

