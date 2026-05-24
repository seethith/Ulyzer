import React from 'react';
import { FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MessageArtifact } from '@shared/types';

interface ArtifactCardsProps {
  artifacts: MessageArtifact[];
  /** Opens the file in the workspace; when omitted the card is non-interactive. */
  onOpen?: (artifact: MessageArtifact) => void;
}

function basename(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? filePath;
}

/** Clickable cards for files a turn generated — "已生成 xxx.md" becomes openable. */
export const ArtifactCards: React.FC<ArtifactCardsProps> = ({ artifacts, onOpen }) => {
  const { t } = useTranslation();
  if (artifacts.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, marginBottom: 4 }}>
      {artifacts.map((artifact) => {
        const folderLabel = t(`chat_messages.artifact_folder_${artifact.folderName}`, { defaultValue: '' });
        const interactive = Boolean(onOpen);
        return (
          <button
            key={artifact.filePath}
            className="ui-pressable"
            onClick={() => onOpen?.(artifact)}
            disabled={!interactive}
            title={interactive ? t('chat_messages.artifact_open') : undefined}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px', maxWidth: '100%',
              border: '1px solid var(--border)', borderRadius: 'var(--r)',
              background: 'var(--app-workspace-card-bg-strong, var(--surface))',
              color: 'var(--text2)', cursor: interactive ? 'pointer' : 'default',
              fontFamily: 'var(--sans)', textAlign: 'left',
            }}
            onMouseEnter={(e) => {
              if (!interactive) return;
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent-b)';
              (e.currentTarget as HTMLButtonElement).style.background = 'var(--app-workspace-muted-bg, var(--surface2))';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)';
              (e.currentTarget as HTMLButtonElement).style.background = 'var(--app-workspace-card-bg-strong, var(--surface))';
            }}
          >
            <FileText size={15} style={{ flexShrink: 0, color: 'var(--accent)' }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5, color: 'var(--text)' }}>
              {basename(artifact.filePath)}
            </span>
            {folderLabel && (
              <span style={{
                flexShrink: 0, fontSize: 10, padding: '1px 6px', borderRadius: 999,
                background: 'var(--app-workspace-muted-bg, var(--surface2))', color: 'var(--text3)',
              }}>
                {folderLabel}
              </span>
            )}
            {interactive && (
              <span style={{ flexShrink: 0, marginLeft: 'auto', fontSize: 11, color: 'var(--accent)' }}>
                {t('chat_messages.artifact_open')}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
