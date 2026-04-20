import React, { useRef, useState, useEffect } from 'react';
import { Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface PresetCommand {
  label: string;
  value: string;
  warn?: boolean;
}

interface PresetCommandsProps {
  commands: PresetCommand[];
  onSelect: (value: string) => void;
  disabled?: boolean;
}

export const PresetCommands: React.FC<PresetCommandsProps> = ({
  commands,
  onSelect,
  disabled,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  if (commands.length === 0) return null;

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-block', marginBottom: 6 }}>
      <button
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '3px 10px',
          fontSize: 12,
          color: open ? 'var(--text)' : 'var(--text2)',
          backgroundColor: open ? 'var(--surface3, var(--surface2))' : 'var(--surface2)',
          border: `1px solid ${open ? 'var(--border2)' : 'var(--border)'}`,
          borderRadius: 20,
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontFamily: 'var(--sans)',
          opacity: disabled ? 0.5 : 1,
          transition: 'all 0.1s',
        }}
      >
        <Zap size={12} />
        <span>{t('preset_commands.label')}</span>
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          bottom: 'calc(100% + 6px)',
          left: 0,
          backgroundColor: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '4px 0',
          boxShadow: '0 -4px 16px rgba(0,0,0,0.18)',
          zIndex: 100,
          minWidth: 140,
          display: 'flex',
          flexDirection: 'column',
        }}>
          {commands.map((cmd) => (
            <button
              key={cmd.value}
              onClick={() => { if (!disabled) { onSelect(cmd.value); setOpen(false); } }}
              style={{
                padding: '6px 14px',
                fontSize: 12,
                textAlign: 'left',
                color: cmd.warn ? '#b45309' : 'var(--text2)',
                backgroundColor: 'transparent',
                border: 'none',
                cursor: disabled ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap',
                fontFamily: 'var(--sans)',
              }}
              onMouseEnter={(e) => {
                if (!disabled) {
                  (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface2)';
                  (e.currentTarget as HTMLButtonElement).style.color = cmd.warn ? 'var(--amber, #f59e0b)' : 'var(--text)';
                }
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
                (e.currentTarget as HTMLButtonElement).style.color = cmd.warn ? '#b45309' : 'var(--text2)';
              }}
            >
              {cmd.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
