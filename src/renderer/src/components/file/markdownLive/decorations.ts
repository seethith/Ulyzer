import { StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { forceParsing, syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import { IPC } from '@shared/ipc-channels';
import {
  collectCodeBlocks,
  collectExcludedRanges,
  collectImages,
  collectLinkAtPosition,
  collectMathRanges,
  collectTables,
  collectTaskMarkers,
  directChildren,
  docText,
  intersectsRange,
  isLineActive,
  isRangeContainedInRanges,
  isRangeActive,
} from './parse';
import type { MarkdownRange } from './types';
import {
  BlockMathWidget,
  CodeBlockWidget,
  HorizontalRuleWidget,
  ImageWidget,
  InlineMathWidget,
  MermaidWidget,
  TableWidget,
  TaskMarkerWidget,
} from './widgets';
import { revealMarkdownSourceEffect } from './interactions';

interface MarkdownLivePreviewOptions {
  enabled: boolean;
  filePath: string;
}

interface PendingDecoration {
  from: number;
  to: number;
  decoration: Decoration;
}

interface MarkdownLiveDecorationState {
  decorations: DecorationSet;
  atomicRanges: DecorationSet;
}

interface ReplacementOptions {
  revealWhenActive?: boolean;
}

const refreshMarkdownDecorationsEffect = StateEffect.define<void>();

const revealedMarkdownSourceField = StateField.define<MarkdownRange | null>({
  create: () => null,
  update: (value, transaction) => {
    let next = value;
    let receivedEffect = false;

    for (const effect of transaction.effects) {
      if (effect.is(revealMarkdownSourceEffect)) {
        next = effect.value;
        receivedEffect = true;
      }
    }

    if (next && transaction.docChanged) {
      next = {
        from: transaction.changes.mapPos(next.from, -1),
        to: transaction.changes.mapPos(next.to, 1),
      };
      if (next.from >= next.to) next = null;
    }

    if (next && transaction.selection && !receivedEffect && !isSelectionInsideRange(transaction.state, next)) {
      next = null;
    }

    return next;
  },
});

export function markdownLivePreview(options: MarkdownLivePreviewOptions): Extension {
  if (!options.enabled) return [];

  const decorationField = StateField.define<MarkdownLiveDecorationState>({
    create: (state) => buildMarkdownDecorations(state, options),
    update: (value, transaction) => {
      if (
        transaction.docChanged
        || transaction.selection
        || transaction.effects.some((effect) => effect.is(refreshMarkdownDecorationsEffect))
      ) {
        return buildMarkdownDecorations(transaction.state, options);
      }
      return {
        decorations: value.decorations.map(transaction.changes),
        atomicRanges: value.atomicRanges.map(transaction.changes),
      };
    },
    provide: (field) => [
      EditorView.decorations.from(field, (value) => value.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(field).atomicRanges),
    ],
  });

  return [
    revealedMarkdownSourceField,
    decorationField,
    markdownLiveViewportRefresh(),
    markdownLinkClickHandler(),
  ];
}

function markdownLiveViewportRefresh(): Extension {
  return ViewPlugin.fromClass(class {
    private pendingFrame = 0;
    private destroyed = false;

    constructor(private readonly view: EditorView) {
      this.scheduleRefresh();
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.scheduleRefresh();
      }
    }

    destroy(): void {
      this.destroyed = true;
      if (this.pendingFrame) {
        window.cancelAnimationFrame(this.pendingFrame);
        this.pendingFrame = 0;
      }
    }

    private scheduleRefresh(): void {
      if (this.pendingFrame) return;
      this.pendingFrame = window.requestAnimationFrame(() => {
        this.pendingFrame = 0;
        if (this.destroyed || !this.view.dom.isConnected) return;

        const parseTarget = Math.min(this.view.state.doc.length, this.view.viewport.to + 50000);
        if (!syntaxTreeAvailable(this.view.state, parseTarget)) {
          forceParsing(this.view, parseTarget, 80);
        }

        this.view.dispatch({
          effects: refreshMarkdownDecorationsEffect.of(undefined),
        });
      });
    }
  });
}

function markdownLinkClickHandler(): Extension {
  return EditorView.domEventHandlers({
    mousedown: openLinkFromMouseEvent,
  });
}

function openLinkFromMouseEvent(event: MouseEvent, view: EditorView): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (position == null) return false;

  const link = collectLinkAtPosition(view.state, position);
  if (!link || !/^https?:\/\//i.test(link.url)) return false;

  event.preventDefault();
  event.stopPropagation();
  window.api.invoke(IPC.SHELL_OPEN_URL, link.url).catch(() => {});
  return true;
}

function buildMarkdownDecorations(state: EditorState, options: MarkdownLivePreviewOptions): MarkdownLiveDecorationState {
  const decorations: PendingDecoration[] = [];
  const atomicDecorations: PendingDecoration[] = [];
  const replacedRanges: MarkdownRange[] = [];
  const excludedRanges = collectExcludedRanges(state);
  const revealedSource = state.field(revealedMarkdownSourceField, false);

  const add = (from: number, to: number, decoration: Decoration): void => {
    if (from < 0 || to < from || to > state.doc.length) return;
    decorations.push({ from, to, decoration });
  };

  const addReplacement = (
    from: number,
    to: number,
    decoration: Decoration,
    replacementOptions: ReplacementOptions = {},
  ): void => {
    const revealWhenActive = replacementOptions.revealWhenActive ?? true;
    const explicitlyRevealed = revealedSource && intersectsRange(from, to, [revealedSource]);
    if (explicitlyRevealed || (revealWhenActive && isRangeActive(state, from, to)) || intersectsRange(from, to, replacedRanges)) return;
    replacedRanges.push({ from, to });
    add(from, to, decoration);
    atomicDecorations.push({ from, to, decoration });
  };

  for (const block of collectCodeBlocks(state)) {
    const info = block.info.toLowerCase();
    const isMermaid = info.split(/\s+/).includes('mermaid');
    addReplacement(
      block.from,
      block.to,
      Decoration.replace({
        block: true,
        widget: isMermaid
          ? new MermaidWidget(block.code, block.from, block.to, block.codeFrom, block.codeTo)
          : new CodeBlockWidget(block.code, block.info, block.from, block.to, block.codeFrom, block.codeTo),
      }),
      { revealWhenActive: false },
    );
  }

  for (const table of collectTables(state)) {
    addReplacement(
      table.from,
      table.to,
      Decoration.replace({
        block: true,
        widget: new TableWidget(table.source, table.from, table.to),
      }),
      { revealWhenActive: false },
    );
  }

  for (const math of collectMathRanges(state, excludedRanges)) {
    if (math.displayMode) {
      addReplacement(
        math.from,
        math.to,
        Decoration.replace({
          block: true,
          widget: new BlockMathWidget(math.formula, math.from, math.to, math.bodyFrom, math.bodyTo),
        }),
        { revealWhenActive: false },
      );
    } else {
      addReplacement(
        math.from,
        math.to,
        Decoration.replace({
          widget: new InlineMathWidget(math.formula, math.from, math.to, math.bodyFrom, math.bodyTo),
        }),
      );
    }
  }

  for (const image of collectImages(state)) {
    addReplacement(
      image.from,
      image.to,
      Decoration.replace({
        widget: new ImageWidget(image.src, image.alt, options.filePath, image.from, image.to),
      }),
      { revealWhenActive: false },
    );
  }

  for (const task of collectTaskMarkers(state)) {
    addReplacement(
      task.from,
      task.to,
      Decoration.replace({
        widget: new TaskMarkerWidget(task.checked, task.from, task.to),
      }),
      { revealWhenActive: false },
    );
  }

  syntaxTree(state).iterate({
    enter: (node) => {
      if (isRangeContainedInRanges(node.from, node.to, replacedRanges)) return false;

      decorateBlockNode(state, node, add, replacedRanges);
      decorateInlineNode(state, node, add, replacedRanges);
      return undefined;
    },
  });

  return {
    decorations: Decoration.set(
      decorations.map((item): Range<Decoration> => item.decoration.range(item.from, item.to)),
      true,
    ),
    atomicRanges: Decoration.set(
      atomicDecorations.map((item): Range<Decoration> => item.decoration.range(item.from, item.to)),
      true,
    ),
  };
}

function isSelectionInsideRange(state: EditorState, range: MarkdownRange): boolean {
  return state.selection.ranges.some((selection) => {
    if (selection.empty) return selection.head >= range.from && selection.head <= range.to;
    return selection.from <= range.to && selection.to >= range.from;
  });
}

function decorateBlockNode(
  state: EditorState,
  node: SyntaxNodeRef,
  add: (from: number, to: number, decoration: Decoration) => void,
  replacedRanges: readonly MarkdownRange[],
): void {
  if (/^ATXHeading[1-6]$/.test(node.name)) {
    const level = Number(node.name.replace('ATXHeading', ''));
    const line = state.doc.lineAt(node.from);
    add(line.from, line.from, Decoration.line({ class: `md-cm-line md-cm-heading md-cm-h${level}` }));

    const syntaxNode = node.node;
    const headerMark = syntaxNode.getChild('HeaderMark');
    if (headerMark) {
      if (isLineActive(state, node.from, node.to)) {
        dimRange(headerMark.from, headerMark.to, add, replacedRanges);
      } else {
        hideRange(headerMark.from, Math.min(headerMark.to + 1, node.to), add, replacedRanges);
      }
    }
    return;
  }

  if (node.name === 'Blockquote') {
    const line = state.doc.lineAt(node.from);
    add(line.from, line.from, Decoration.line({ class: 'md-cm-line md-cm-blockquote-line' }));
    const quoteMarks = node.node.getChildren('QuoteMark');
    for (const mark of quoteMarks) {
      if (isLineActive(state, node.from, node.to)) {
        dimRange(mark.from, mark.to, add, replacedRanges);
      } else {
        hideRange(mark.from, Math.min(mark.to + 1, node.to), add, replacedRanges);
      }
    }
    return;
  }

  if (node.name === 'ListItem') {
    const listMark = node.node.getChild('ListMark');
    if (listMark && isLineActive(state, node.from, node.to)) {
      dimRange(listMark.from, listMark.to, add, replacedRanges);
    }
    return;
  }

  if (node.name === 'HorizontalRule') {
    hideAsWidgetIfInactive(
      state,
      node.from,
      node.to,
      Decoration.replace({
        block: true,
        widget: new HorizontalRuleWidget(node.from, node.to),
      }),
      add,
      replacedRanges,
    );
  }
}

function decorateInlineNode(
  state: EditorState,
  node: SyntaxNodeRef,
  add: (from: number, to: number, decoration: Decoration) => void,
  replacedRanges: readonly MarkdownRange[],
): void {
  const active = isRangeActive(state, node.from, node.to);

  if (node.name === 'StrongEmphasis') {
    decorateDelimitedInline(node.node, 'EmphasisMark', 'md-cm-strong', add, replacedRanges, active);
    return;
  }

  if (node.name === 'Emphasis') {
    decorateDelimitedInline(node.node, 'EmphasisMark', 'md-cm-emphasis', add, replacedRanges, active);
    return;
  }

  if (node.name === 'Strikethrough') {
    decorateDelimitedInline(node.node, 'StrikethroughMark', 'md-cm-strikethrough', add, replacedRanges, active);
    return;
  }

  if (node.name === 'InlineCode') {
    decorateDelimitedInline(node.node, 'CodeMark', 'md-cm-inline-code', add, replacedRanges, active);
    return;
  }

  if (node.name === 'Link') {
    decorateLink(state, node.node, add, replacedRanges, active);
    return;
  }

  if (node.name === 'Autolink') {
    decorateAutolink(state, node.node, add, replacedRanges, active);
    return;
  }

  if (node.name === 'URL') {
    decorateBareUrl(state, node, add);
  }
}

function decorateDelimitedInline(
  node: SyntaxNode,
  markName: string,
  className: string,
  add: (from: number, to: number, decoration: Decoration) => void,
  replacedRanges: readonly MarkdownRange[],
  active: boolean,
): void {
  const marks = node.getChildren(markName);
  if (marks.length < 2) return;
  for (const mark of marks) {
    if (active) {
      dimRange(mark.from, mark.to, add, replacedRanges);
    } else {
      hideRange(mark.from, mark.to, add, replacedRanges);
    }
  }
  const contentFrom = marks[0].to;
  const contentTo = marks[marks.length - 1].from;
  if (contentFrom < contentTo) {
    add(contentFrom, contentTo, Decoration.mark({ class: className }));
  }
}

function decorateLink(
  state: EditorState,
  node: SyntaxNode,
  add: (from: number, to: number, decoration: Decoration) => void,
  replacedRanges: readonly MarkdownRange[],
  active: boolean,
): void {
  const children = directChildren(node);
  const url = node.getChild('URL');
  const firstMark = children.find((child) => child.name === 'LinkMark');
  const closingLabel = children.find((child) => child.name === 'LinkMark' && docText(state, child.from, child.to) === ']');

  if (!firstMark || !closingLabel) return;
  const textFrom = firstMark.to;
  const textTo = closingLabel.from;
  if (textFrom < textTo) {
    add(textFrom, textTo, Decoration.mark({ class: 'md-cm-link' }));
  }

  if (active) {
    dimRange(firstMark.from, firstMark.to, add, replacedRanges);
  } else {
    hideRange(firstMark.from, firstMark.to, add, replacedRanges);
  }
  for (const child of children) {
    if (child === firstMark) continue;
    if (child.name === 'LinkMark' || child.name === 'URL') {
      if (active) {
        dimRange(child.from, child.to, add, replacedRanges);
      } else {
        hideRange(child.from, child.to, add, replacedRanges);
      }
    }
  }
  if (url) {
    if (active) {
      dimRange(url.from, url.to, add, replacedRanges);
    } else {
      hideRange(url.from, url.to, add, replacedRanges);
    }
  }
}

function decorateAutolink(
  state: EditorState,
  node: SyntaxNode,
  add: (from: number, to: number, decoration: Decoration) => void,
  replacedRanges: readonly MarkdownRange[],
  active: boolean,
): void {
  const url = node.getChild('URL');
  if (!url) return;
  const href = docText(state, url.from, url.to);
  if (!/^https?:\/\//i.test(href)) return;

  add(url.from, url.to, Decoration.mark({ class: 'md-cm-link' }));
  for (const child of directChildren(node)) {
    if (child.name !== 'LinkMark') continue;
    if (active) {
      dimRange(child.from, child.to, add, replacedRanges);
    } else {
      hideRange(child.from, child.to, add, replacedRanges);
    }
  }
}

function decorateBareUrl(
  state: EditorState,
  node: SyntaxNodeRef,
  add: (from: number, to: number, decoration: Decoration) => void,
): void {
  const href = docText(state, node.from, node.to);
  if (!/^https?:\/\//i.test(href)) return;
  add(node.from, node.to, Decoration.mark({ class: 'md-cm-link' }));
}

function hideAsWidgetIfInactive(
  state: EditorState,
  from: number,
  to: number,
  decoration: Decoration,
  add: (from: number, to: number, decoration: Decoration) => void,
  replacedRanges: readonly MarkdownRange[],
): void {
  if (isRangeActive(state, from, to) || intersectsRange(from, to, replacedRanges)) return;
  add(from, to, decoration);
}

function hideRange(
  from: number,
  to: number,
  add: (from: number, to: number, decoration: Decoration) => void,
  replacedRanges: readonly MarkdownRange[],
): void {
  if (from >= to || intersectsRange(from, to, replacedRanges)) return;
  add(from, to, Decoration.replace({}));
}

function dimRange(
  from: number,
  to: number,
  add: (from: number, to: number, decoration: Decoration) => void,
  replacedRanges: readonly MarkdownRange[],
): void {
  if (from >= to || intersectsRange(from, to, replacedRanges)) return;
  add(from, to, Decoration.mark({ class: 'md-cm-source-marker' }));
}
