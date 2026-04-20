import React, { useState, useRef } from 'react';
import { SquarePen, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage, ChatThread, FileAttachment } from '@shared/types';
import { PresetCommands } from './PresetCommands';
import { ChatMessages } from './ChatMessages';
import { ChatInputBox } from './ChatInputBox';
import { ChatHistoryPanel } from './ChatHistoryPanel';
import { useSettingsStore } from '../../stores/settings.store';

export interface ChatPanelPreset {
  label: string;
  /** Text inserted into the input box when preset is clicked, e.g. "/创建路线 " */
  prefix: string;
  /**
   * If present, when the user sends a message starting with this prefix,
   * onCommand(command, userText) is called instead of onSend.
   */
  command?: string;
  warn?: boolean;
  /**
   * If true, clicking this preset immediately fires onCommand(command, '')
   * without inserting text into the input box. Requires `command`.
   */
  autoSend?: boolean;
}

interface ChatPanelProps {
  title: string;
  subtitle?: string;
  presets?: ChatPanelPreset[];
  messages: ChatMessage[];
  streamingContent: string;
  progressContent?: string;
  isStreaming: boolean;
  streamError?: string | null;
  /** Regular chat message */
  onSend: (message: string, attachments: FileAttachment[], webSearchEnabled: boolean) => void;
  /**
   * Called when the user sends a message that matches a preset command.
   * `userText` is the text after the prefix; `fullText` is the full original input.
   */
  onCommand?: (command: string, userText: string, fullText: string) => void;
  /** Stop the current stream */
  onAbort?: () => void;
  onEditAndResendMessage?: (id: string, content: string) => void;
  emptyText?: React.ReactNode;
  // ── Thread props ──────────────────────────────────────────────────────────────
  threads?: ChatThread[];
  activeThreadId?: string | null;
  onNewThread?: () => void;
  onSwitchThread?: (threadId: string) => void;
  onDeleteThread?: (threadId: string) => void;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  title,
  subtitle,
  presets = [],
  messages,
  streamingContent,
  progressContent,
  isStreaming,
  streamError,
  onSend,
  onCommand,
  onAbort,
  onEditAndResendMessage,
  emptyText,
  threads = [],
  activeThreadId,
  onNewThread,
  onSwitchThread,
  onDeleteThread,
}) => {
  const { t } = useTranslation();
  const [inputText, setInputText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [webSearchError, setWebSearchError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const getApiKey = useSettingsStore((s) => s.getApiKey);
  const webSearchErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleWebSearchToggle = async () => {
    if (webSearchEnabled) {
      setWebSearchEnabled(false);
      setWebSearchError(null);
      return;
    }
    const key = await getApiKey('tavily');
    if (!key) {
      setWebSearchError(t('chat_panel.web_search_no_key'));
      if (webSearchErrorTimerRef.current) clearTimeout(webSearchErrorTimerRef.current);
      webSearchErrorTimerRef.current = setTimeout(() => setWebSearchError(null), 6000);
      return;
    }
    setWebSearchEnabled(true);
    setWebSearchError(null);
  };

  // Insert prefix into input and focus — or auto-fire command if autoSend
  const handlePresetClick = (prefix: string) => {
    const preset = presets.find((p) => p.prefix === prefix);
    if (preset?.autoSend && preset.command) {
      onCommand?.(preset.command, '', preset.prefix.trim());
      return;
    }
    setInputText(prefix);
    setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }, 0);
  };

  // On send: check if message starts with a command prefix
  const handleSend = (text: string, attachments: FileAttachment[], wsEnabled: boolean) => {
    for (const preset of presets) {
      if (preset.command) {
        const trimmedPrefix = preset.prefix.trimEnd();
        if (text === trimmedPrefix || text.startsWith(preset.prefix)) {
          const userText = text.startsWith(preset.prefix)
            ? text.slice(preset.prefix.length).trim()
            : '';
          onCommand?.(preset.command, userText, text.trim());
          return;
        }
      }
    }
    onSend(text, attachments, wsEnabled);
    // Reset web search toggle after each send — one-shot per message
    setWebSearchEnabled(false);
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      backgroundColor: 'var(--bg)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 10px', backgroundColor: 'var(--panel)', flexShrink: 0,
        position: 'relative',
      }}>
        {/* Left: new chat button */}
        <HeaderIconButton onClick={onNewThread} title="新建对话" disabled={!onNewThread}>
          <SquarePen size={14} />
        </HeaderIconButton>

        {/* Center: title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, justifyContent: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{title}</span>
          {subtitle && <span style={{ fontSize: 11, color: 'var(--text3)' }}>· {subtitle}</span>}
        </div>

        {/* Right: history button */}
        <HeaderIconButton
          onClick={() => setHistoryOpen((v) => !v)}
          title="对话记录"
          active={historyOpen}
          disabled={!onSwitchThread}
        >
          <Clock size={14} />
        </HeaderIconButton>

        {/* History dropdown */}
        {historyOpen && onSwitchThread && (
          <ChatHistoryPanel
            threads={threads}
            activeThreadId={activeThreadId ?? null}
            onSelect={(id) => { onSwitchThread(id); }}
            onDelete={(id) => { onDeleteThread?.(id); }}
            onClose={() => setHistoryOpen(false)}
          />
        )}
      </div>

      {/* Messages */}
      <ChatMessages
        messages={messages}
        streamingContent={streamingContent}
        progressContent={progressContent}
        isStreaming={isStreaming}
        streamError={streamError ?? null}
        onEditAndResendMessage={onEditAndResendMessage}
        emptyText={emptyText}
      />

      {/* Input area */}
      <div style={{ padding: '8px 12px 12px', flexShrink: 0 }}>
        <ChatInputBox
          value={inputText}
          onChange={setInputText}
          onSend={handleSend}
          onAbort={onAbort}
          placeholder={t('chat_input.placeholder')}
          disabled={isStreaming}
          textareaRef={textareaRef}
          webSearchEnabled={webSearchEnabled}
          onWebSearchToggle={handleWebSearchToggle}
          webSearchError={webSearchError}
          headerSlot={
            presets.length > 0 ? (
              <PresetCommands
                commands={presets.map((p) => ({ label: p.label, value: p.prefix, warn: p.warn }))}
                onSelect={handlePresetClick}
                disabled={isStreaming}
              />
            ) : undefined
          }
        />
      </div>
    </div>
  );
};

// ── Sub-components ────────────────────────────────────────────────────────────

const HeaderIconButton: React.FC<{
  onClick?: () => void; title?: string; disabled?: boolean; active?: boolean; children: React.ReactNode;
}> = ({ onClick, title, disabled, active, children }) => (
  <button
    onClick={onClick}
    title={title}
    disabled={disabled}
    style={{
      width: 28, height: 28, borderRadius: 'var(--r)',
      border: active ? '1px solid var(--accent-b)' : 'none',
      cursor: disabled ? 'default' : 'pointer',
      backgroundColor: active ? 'var(--accent-s)' : 'transparent',
      color: disabled ? 'var(--border2)' : active ? 'var(--accent)' : 'var(--text3)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, transition: 'background-color 0.1s, color 0.1s',
    }}
    onMouseEnter={(e) => {
      if (!disabled) {
        (e.currentTarget as HTMLButtonElement).style.backgroundColor = active ? 'var(--accent-b)' : 'var(--surface2)';
        (e.currentTarget as HTMLButtonElement).style.color = active ? 'var(--accent)' : 'var(--text2)';
      }
    }}
    onMouseLeave={(e) => {
      (e.currentTarget as HTMLButtonElement).style.backgroundColor = active ? 'var(--accent-s)' : 'transparent';
      (e.currentTarget as HTMLButtonElement).style.color = disabled ? 'var(--border2)' : active ? 'var(--accent)' : 'var(--text3)';
    }}
  >
    {children}
  </button>
);
