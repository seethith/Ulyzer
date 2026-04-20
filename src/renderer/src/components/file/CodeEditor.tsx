import React from 'react';
import MonacoEditor from '@monaco-editor/react';
import { useSettingsStore } from '../../stores/settings.store';

const LANG_MAP: Record<string, string> = {
  py: 'python',   js: 'javascript', ts: 'typescript',
  jsx: 'javascript', tsx: 'typescript',
  css: 'css',     json: 'json',     yaml: 'yaml',  yml: 'yaml',
  sh: 'shell',    bash: 'shell',    java: 'java',
  c: 'c',         cpp: 'cpp',       go: 'go',      rs: 'rust',
  rb: 'ruby',     php: 'php',       html: 'html',  csv: 'plaintext',
  md: 'markdown', txt: 'plaintext',
};

export function getLanguage(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return LANG_MAP[ext] ?? 'plaintext';
}

export function isCodeFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ext in LANG_MAP && !['md', 'txt'].includes(ext);
}

interface CodeEditorProps {
  content: string;
  language: string;
  onChange?: (value: string) => void;
}

export const CodeEditor: React.FC<CodeEditorProps> = ({ content, language, onChange }) => {
  const theme = useSettingsStore((s) => s.theme);

  return (
    <MonacoEditor
      height="100%"
      value={content}
      language={language}
      theme={theme === 'dark' ? 'vs-dark' : 'vs'}
      onChange={(v) => onChange?.(v ?? '')}
      options={{
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        lineNumbers: 'on',
        padding: { top: 16, bottom: 16 },
        fontFamily: "'JetBrains Mono', 'Menlo', monospace",
      }}
    />
  );
};
