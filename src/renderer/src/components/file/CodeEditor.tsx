import React from 'react';
import MonacoEditor from '@monaco-editor/react';
import type { editor as MonacoEditorNamespace } from 'monaco-editor';
import { useSettingsStore } from '../../stores/settings.store';
import type { AppTheme } from '@shared/types';

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

interface CodeEditorProps {
  content: string;
  language: string;
  onChange?: (value: string) => void;
  onMount?: (editor: MonacoEditorNamespace.IStandaloneCodeEditor) => void;
}

type MonacoApi = typeof import('monaco-editor');

const MONACO_THEME_BY_APP_THEME: Record<AppTheme, string> = {
  warm: 'ulyzer-warm-code',
  white: 'ulyzer-white-code',
  dark: 'ulyzer-dark-code',
};

let monacoThemesDefined = false;

function defineUlyzerMonacoThemes(monaco: MonacoApi): void {
  if (monacoThemesDefined) return;
  monacoThemesDefined = true;

  monaco.editor.defineTheme('ulyzer-warm-code', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '5b8a4f', fontStyle: 'italic' },
      { token: 'keyword', foreground: '365f9f' },
      { token: 'number', foreground: '8d6432' },
      { token: 'string', foreground: 'b24c3e' },
      { token: 'type', foreground: '6b5a8f' },
      { token: 'class', foreground: '6b5a8f' },
      { token: 'function', foreground: '8a5f1f' },
      { token: 'delimiter', foreground: '6b6860' },
      { token: 'operator', foreground: '7a5544' },
      { token: 'tag', foreground: '8a5f1f' },
      { token: 'attribute.name', foreground: '7a6341' },
    ],
    colors: {
      'editor.background': '#00000000',
      'editor.foreground': '#1a1915',
      'editorGutter.background': '#00000000',
      'editorLineNumber.foreground': '#8f8a80',
      'editorLineNumber.activeForeground': '#c96442',
      'editorCursor.foreground': '#c96442',
      'editor.lineHighlightBackground': '#c9644212',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#c9644230',
      'editor.inactiveSelectionBackground': '#c964421c',
      'editor.wordHighlightBackground': '#c9644216',
      'editor.wordHighlightStrongBackground': '#c9644224',
      'editorIndentGuide.background1': '#1a19151c',
      'editorIndentGuide.activeBackground1': '#c9644266',
      'editorWhitespace.foreground': '#6b686040',
      'editorBracketMatch.background': '#c964421f',
      'editorBracketMatch.border': '#c964426a',
      'scrollbarSlider.background': '#a8a49c66',
      'scrollbarSlider.hoverBackground': '#c9644266',
      'scrollbarSlider.activeBackground': '#c964428c',
    },
  });

  monaco.editor.defineTheme('ulyzer-white-code', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '4f8050', fontStyle: 'italic' },
      { token: 'keyword', foreground: '315f9f' },
      { token: 'number', foreground: '805f31' },
      { token: 'string', foreground: 'b64d3f' },
      { token: 'type', foreground: '675b90' },
      { token: 'class', foreground: '675b90' },
      { token: 'function', foreground: '836021' },
      { token: 'delimiter', foreground: '555555' },
      { token: 'operator', foreground: '74523f' },
      { token: 'tag', foreground: '836021' },
      { token: 'attribute.name', foreground: '75613f' },
    ],
    colors: {
      'editor.background': '#00000000',
      'editor.foreground': '#1a1a1a',
      'editorGutter.background': '#00000000',
      'editorLineNumber.foreground': '#969696',
      'editorLineNumber.activeForeground': '#c96442',
      'editorCursor.foreground': '#c96442',
      'editor.lineHighlightBackground': '#c9644210',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#c964422f',
      'editor.inactiveSelectionBackground': '#c964421c',
      'editor.wordHighlightBackground': '#c9644214',
      'editor.wordHighlightStrongBackground': '#c9644222',
      'editorIndentGuide.background1': '#0000001c',
      'editorIndentGuide.activeBackground1': '#c9644266',
      'editorWhitespace.foreground': '#5555553f',
      'editorBracketMatch.background': '#c964421f',
      'editorBracketMatch.border': '#c964426a',
      'scrollbarSlider.background': '#99999966',
      'scrollbarSlider.hoverBackground': '#c9644266',
      'scrollbarSlider.activeBackground': '#c964428c',
    },
  });

  monaco.editor.defineTheme('ulyzer-dark-code', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '82a970', fontStyle: 'italic' },
      { token: 'keyword', foreground: '91b8ff' },
      { token: 'number', foreground: 'd4ad72' },
      { token: 'string', foreground: 'e29b8b' },
      { token: 'type', foreground: 'c7a8e5' },
      { token: 'class', foreground: 'c7a8e5' },
      { token: 'function', foreground: 'ead18c' },
      { token: 'delimiter', foreground: 'b8b8b8' },
      { token: 'operator', foreground: 'e3b09b' },
      { token: 'tag', foreground: 'ead18c' },
      { token: 'attribute.name', foreground: 'd6c08d' },
    ],
    colors: {
      'editor.background': '#00000000',
      'editor.foreground': '#f0f0f0',
      'editorGutter.background': '#00000000',
      'editorLineNumber.foreground': '#787878',
      'editorLineNumber.activeForeground': '#e07455',
      'editorCursor.foreground': '#e07455',
      'editor.lineHighlightBackground': '#e0745518',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#e0745542',
      'editor.inactiveSelectionBackground': '#e0745524',
      'editor.wordHighlightBackground': '#e0745520',
      'editor.wordHighlightStrongBackground': '#e0745532',
      'editorIndentGuide.background1': '#ffffff22',
      'editorIndentGuide.activeBackground1': '#e0745568',
      'editorWhitespace.foreground': '#b8b8b83f',
      'editorBracketMatch.background': '#e0745526',
      'editorBracketMatch.border': '#e074556e',
      'scrollbarSlider.background': '#78787870',
      'scrollbarSlider.hoverBackground': '#e0745566',
      'scrollbarSlider.activeBackground': '#e074558c',
    },
  });
}

export const CodeEditor: React.FC<CodeEditorProps> = ({ content, language, onChange, onMount }) => {
  const theme = useSettingsStore((s) => s.theme);
  const isPlainText = language === 'plaintext';

  return (
    <div className={`code-file-shell ${isPlainText ? 'code-file-shell-plain' : 'code-file-shell-code'}`}>
      <MonacoEditor
        className="ulyzer-monaco-editor"
        height="100%"
        value={content}
        language={language}
        theme={MONACO_THEME_BY_APP_THEME[theme]}
        beforeMount={defineUlyzerMonacoThemes}
        onChange={(v) => onChange?.(v ?? '')}
        onMount={(editor) => onMount?.(editor)}
        options={{
          automaticLayout: true,
          bracketPairColorization: { enabled: !isPlainText },
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          folding: !isPlainText,
          fontFamily: isPlainText
            ? "'Noto Sans SC', system-ui, sans-serif"
            : "'JetBrains Mono', 'Menlo', 'SFMono-Regular', monospace",
          fontLigatures: !isPlainText,
          fontSize: isPlainText ? 13.5 : 13,
          glyphMargin: false,
          guides: {
            bracketPairs: !isPlainText,
            indentation: !isPlainText,
          },
          hideCursorInOverviewRuler: true,
          lineDecorationsWidth: isPlainText ? 34 : 12,
          lineHeight: isPlainText ? 26 : 22,
          lineNumbers: isPlainText ? 'off' : 'on',
          lineNumbersMinChars: isPlainText ? 0 : 3,
          minimap: { enabled: false },
          occurrencesHighlight: 'off',
          overviewRulerBorder: false,
          overviewRulerLanes: 0,
          padding: { top: isPlainText ? 24 : 20, bottom: 36 },
          renderLineHighlight: isPlainText ? 'none' : 'line',
          scrollBeyondLastLine: false,
          selectionHighlight: false,
          smoothScrolling: true,
          stickyScroll: { enabled: false },
          wordWrap: 'on',
          wrappingIndent: isPlainText ? 'same' : 'indent',
          scrollbar: {
            alwaysConsumeMouseWheel: false,
            horizontalScrollbarSize: 10,
            useShadows: false,
            verticalScrollbarSize: 10,
          },
        }}
      />
    </div>
  );
};
