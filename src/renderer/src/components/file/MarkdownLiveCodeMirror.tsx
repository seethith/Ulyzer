import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import i18n from '../../i18n';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { searchKeymap } from '@codemirror/search';
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { MessageSquareQuote } from 'lucide-react';
import { useChatStore } from '../../stores/chat.store';
import { useEditorStore } from '../../stores/editor.store';
import { markdownLivePreview } from './markdownLive/decorations';
import { markdownLiveTheme } from './markdownLive/theme';

interface MarkdownLiveCodeMirrorProps {
  fileId: string;
  filePath: string;
  content: string;
  livePreview: boolean;
  onChange: (value: string) => void;
  onFocusChange: (focused: boolean) => void;
}

interface SelectionQuoteAction {
  text: string;
  top: number;
  left: number;
  lineFrom: number;
  lineTo: number;
}

const MAX_DRAFT_QUOTE_CHARS = 4000;

export const MarkdownLiveCodeMirror: React.FC<MarkdownLiveCodeMirrorProps> = ({
  fileId,
  filePath,
  content,
  livePreview,
  onChange,
  onFocusChange,
}) => {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onFocusChangeRef = useRef(onFocusChange);
  const filePathRef = useRef(filePath);
  const [quoteAction, setQuoteAction] = useState<SelectionQuoteAction | null>(null);
  const setQuoteActionRef = useRef(setQuoteAction);
  const previewCompartmentRef = useRef(new Compartment());
  const gutterCompartmentRef = useRef(new Compartment());

  useEffect(() => {
    filePathRef.current = filePath;
  }, [filePath]);

  useEffect(() => {
    setQuoteActionRef.current = setQuoteAction;
  }, []);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onFocusChangeRef.current = onFocusChange;
  }, [onFocusChange]);

  const baseExtensions = useMemo<Extension[]>(() => [
    markdownLiveTheme,
    markdown({ base: markdownLanguage, extensions: [GFM] }),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    history(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(true),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
      if (update.focusChanged) {
        onFocusChangeRef.current(update.view.hasFocus);
      }
      if (update.selectionSet || update.viewportChanged || update.docChanged || update.focusChanged) {
        updateSelectionQuoteAction(update.view, frameRef.current, setQuoteActionRef.current);
      }
    }),
    keymap.of([
      indentWithTab,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...searchKeymap,
      ...completionKeymap,
      ...markdownKeymap,
    ]),
  ], []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const previewCompartment = previewCompartmentRef.current;
    const gutterCompartment = gutterCompartmentRef.current;
    const state = EditorState.create({
      doc: content,
      extensions: [
        ...baseExtensions,
        previewCompartment.of(markdownLivePreview({ enabled: livePreview, filePath })),
        gutterCompartment.of(sourceModeGutters(livePreview)),
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;

    return () => {
      onFocusChangeRef.current(false);
      view.destroy();
      viewRef.current = null;
    };
  }, [baseExtensions, fileId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === content) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: content },
    });
  }, [content]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        previewCompartmentRef.current.reconfigure(markdownLivePreview({ enabled: livePreview, filePath })),
        gutterCompartmentRef.current.reconfigure(sourceModeGutters(livePreview)),
      ],
    });
  }, [livePreview, filePath]);

  const handleQuoteSelection = useCallback(() => {
    const action = quoteAction;
    if (!action) return;
    const sourcePath = filePathRef.current;
    useChatStore.getState().setDraftQuote('sub_tutor', {
      id: crypto.randomUUID(),
      text: action.text,
      sourceName: basename(sourcePath),
      sourcePath,
      relativePath: relativePathForOpenedFile(sourcePath),
      lineFrom: action.lineFrom,
      lineTo: action.lineTo,
      createdAt: Date.now(),
    });
    setQuoteAction(null);
  }, [quoteAction]);

  return (
    <div ref={frameRef} className="markdown-cm-editor-frame">
      <div
        ref={hostRef}
        className="markdown-cm-editor"
        data-file-id={fileId}
        data-live-preview={livePreview ? 'true' : 'false'}
      />
      {quoteAction && (
        <button
          type="button"
          className="markdown-selection-quote-button ui-pressable"
          style={{ top: quoteAction.top, left: quoteAction.left }}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            handleQuoteSelection();
          }}
          title={i18n.t('editor_area.quote_to_chat_title')}
          aria-label={i18n.t('editor_area.quote_to_chat_title')}
        >
          <MessageSquareQuote size={14} />
          <span>{i18n.t('editor_area.quote_to_chat')}</span>
        </button>
      )}
    </div>
  );
};

function updateSelectionQuoteAction(
  view: EditorView,
  frame: HTMLElement | null,
  setQuoteAction: React.Dispatch<React.SetStateAction<SelectionQuoteAction | null>>,
): void {
  if (!frame || !view.hasFocus) {
    setQuoteAction(null);
    return;
  }

  const ranges = view.state.selection.ranges.filter((range) => !range.empty);
  if (ranges.length === 0) {
    setQuoteAction(null);
    return;
  }

  const text = normalizeSelectedQuoteText(
    ranges.map((range) => view.state.sliceDoc(range.from, range.to)).join('\n\n'),
  );
  if (!text) {
    setQuoteAction(null);
    return;
  }

  const primary = view.state.selection.main;
  const coords = view.coordsAtPos(primary.to, -1) ?? view.coordsAtPos(primary.from, 1);
  if (!coords) {
    setQuoteAction(null);
    return;
  }

  const frameRect = frame.getBoundingClientRect();
  const lineFrom = view.state.doc.lineAt(Math.min(...ranges.map((range) => range.from))).number;
  const lineTo = view.state.doc.lineAt(Math.max(...ranges.map((range) => Math.max(range.from, range.to - 1)))).number;
  const left = clamp(coords.left - frameRect.left, 12, Math.max(12, frameRect.width - 132));
  const top = clamp(coords.bottom - frameRect.top + 8, 12, Math.max(12, frameRect.height - 38));

  setQuoteAction({ text, top, left, lineFrom, lineTo });
}

function normalizeSelectedQuoteText(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (normalized.length <= MAX_DRAFT_QUOTE_CHARS) return normalized;
  return `${normalized.slice(0, MAX_DRAFT_QUOTE_CHARS).trimEnd()}\n...`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
}

function relativePathForOpenedFile(filePath: string): string | undefined {
  const editor = useEditorStore.getState();
  const rootPath = editor.tree?.path?.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!rootPath) return undefined;
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized !== rootPath && !normalized.startsWith(`${rootPath}/`)) return undefined;
  return normalized.slice(rootPath.length).replace(/^\/+/, '') || undefined;
}

function sourceModeGutters(livePreview: boolean): Extension {
  if (livePreview) return [];
  return [
    lineNumbers(),
    foldGutter(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
  ];
}
