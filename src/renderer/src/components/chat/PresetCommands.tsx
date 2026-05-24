import React, { useRef, useState, useEffect } from 'react';
import { Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface PresetCommand {
  label: string;
  value: string;
  warn?: boolean;
  description?: string;
  group?: string;
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
  const hasGroups = commands.some((cmd) => cmd.group);
  const groups = commands.reduce<Array<{ label: string; items: PresetCommand[] }>>((acc, cmd) => {
    const label = cmd.group ?? '';
    const current = acc.find((group) => group.label === label);
    if (current) current.items.push(cmd);
    else acc.push({ label, items: [cmd] });
    return acc;
  }, []);

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-block', marginBottom: 6 }}>
      <button
        className="ui-pressable"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '3px 10px',
          fontSize: 12,
          color: open ? 'var(--text)' : 'var(--text2)',
          backgroundColor: open ? 'var(--app-workspace-muted-bg, var(--surface3, var(--surface2)))' : 'var(--app-workspace-muted-bg, var(--surface2))',
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
        <div className="ui-menu-pop" style={{
          position: 'absolute',
          bottom: 'calc(100% + 6px)',
          left: 0,
          background: 'linear-gradient(var(--app-workspace-card-bg-strong, var(--surface)), var(--app-workspace-card-bg-strong, var(--surface))), var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '6px',
          boxShadow: '0 -4px 16px rgba(0,0,0,0.18)',
          zIndex: 100,
          width: 320,
          maxWidth: 'min(86vw, 360px)',
          maxHeight: 'min(62vh, 520px)',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          transformOrigin: 'bottom left',
        }}>
          {groups.map((group, groupIndex) => (
            <div key={group.label || `group-${groupIndex}`} style={{
              paddingTop: groupIndex === 0 ? 0 : 6,
              marginTop: groupIndex === 0 ? 0 : 4,
              borderTop: groupIndex === 0 ? 'none' : '1px solid var(--border)',
            }}>
              {hasGroups && group.label && (
                <div style={{
                  padding: '4px 8px 5px',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 0,
                  color: 'var(--text3)',
                }}>
                  {group.label}
                </div>
              )}
              {group.items.map((cmd) => (
                <button
                  className="ui-pressable"
                  key={cmd.value}
                  onClick={() => { if (!disabled) { onSelect(cmd.value); setOpen(false); } }}
                  style={{
                    width: '100%',
                    padding: '8px 9px',
                    fontSize: 12,
                    textAlign: 'left',
                    color: cmd.warn ? '#b45309' : 'var(--text2)',
                    backgroundColor: 'transparent',
                    border: 'none',
                    borderRadius: 7,
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    fontFamily: 'var(--sans)',
                  }}
                  onMouseEnter={(e) => {
                    if (!disabled) {
                      (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--app-workspace-muted-bg, var(--surface2))';
                      (e.currentTarget as HTMLButtonElement).style.color = cmd.warn ? 'var(--amber, #f59e0b)' : 'var(--text)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
                    (e.currentTarget as HTMLButtonElement).style.color = cmd.warn ? '#b45309' : 'var(--text2)';
                  }}
                >
                  <span style={{ display: 'block', fontWeight: 650, color: 'inherit' }}>{cmd.label}</span>
                  {cmd.description && (
                    <span style={{
                      display: 'block',
                      marginTop: 2,
                      fontSize: 11,
                      lineHeight: 1.45,
                      color: 'var(--text3)',
                      whiteSpace: 'normal',
                    }}>
                      {cmd.description}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
