import { WidgetType, type EditorView } from '@codemirror/view';
import i18n from '../../../i18n';
import mermaid from 'mermaid';
import { IPC } from '@shared/ipc-channels';
import type { IpcResponse } from '@shared/types';
import { repairMermaidFlowchartSafeSubset } from '@shared/mermaid-sanitize';
import { renderMarkdownInlineToHtml, renderMarkdownMath } from '../../../utils/markdown-render';
import { hasMermaidRenderError } from '../../../utils/mermaid-render';
import { isMindmapSource, MERMAID_RENDER_CONFIG } from '../../../utils/mermaid-config';
import { resolveMarkdownAssetPath } from './parse';
import { revealMarkdownSourceEffect } from './interactions';

mermaid.initialize(MERMAID_RENDER_CONFIG);

let mermaidWidgetCounter = 0;

function revealSourceRange(view: EditorView, from: number, to: number, event?: Event): void {
  event?.preventDefault();
  event?.stopPropagation();
  view.dispatch({
    effects: revealMarkdownSourceEffect.of({ from, to }),
    selection: { anchor: from },
    scrollIntoView: true,
  });
  view.focus();
}

function localImageMime(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'bmp') return 'image/bmp';
  return 'image/png';
}

function normalizeMermaidError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || 'Mermaid render failed');
}

function openHttpLinkFromEvent(event: MouseEvent): void {
  const target = event.target instanceof HTMLElement
    ? event.target
    : event.target instanceof Node
      ? event.target.parentElement
      : null;
  const anchor = target?.closest('a');
  const href = anchor?.getAttribute('href');
  if (!href || !/^https?:\/\//i.test(href)) return;

  event.preventDefault();
  event.stopPropagation();
  window.api.invoke(IPC.SHELL_OPEN_URL, href).catch(() => {});
}

function stopWidgetEvent(event: Event): void {
  event.stopPropagation();
}

function dispatchSourceEdit(view: EditorView, from: number, to: number, insert: string, selectionAnchor = from + insert.length): void {
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: selectionAnchor },
  });
}

function mappedOuterEnd(outerTo: number, from: number, to: number, insert: string): number {
  return outerTo + insert.length - (to - from);
}

function normalizeTextareaValue(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function codeValueForTextarea(code: string): string {
  return normalizeTextareaValue(code);
}

function codeValueForMarkdown(value: string): string {
  return normalizeTextareaValue(value);
}

function autoSizeTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.max(textarea.scrollHeight + 2, 36)}px`;
}

interface SvgMetrics {
  width: number;
  height: number;
}

function estimateMermaidHeight(source: string): number {
  const meaningfulLines = source
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0).length;
  return Math.max(260, Math.min(720, 220 + meaningfulLines * 24));
}

function parseSvgLength(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/[\d.]+/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function extractSvgMetrics(svg: string): SvgMetrics | null {
  const template = document.createElement('template');
  template.innerHTML = svg.trim();

  const svgElement = template.content.querySelector('svg');
  if (!svgElement) return null;

  const viewBox = svgElement.getAttribute('viewBox');
  if (viewBox) {
    const values = viewBox.split(/[\s,]+/).map(Number);
    const width = values[2];
    const height = values[3];
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }

  const width = parseSvgLength(svgElement.getAttribute('width'));
  const height = parseSvgLength(svgElement.getAttribute('height'));
  if (width && height) return { width, height };

  return null;
}

function applyMermaidStageSize(stage: HTMLElement, metrics: SvgMetrics | null): void {
  const availableWidth = Math.max(320, stage.clientWidth - 36 || 760);
  const visualWidth = Math.round(Math.min(availableWidth * 0.94, 860));
  const ratio = metrics && metrics.width > 0 ? metrics.height / metrics.width : 0.58;
  const visualHeight = Math.max(180, Math.ceil(visualWidth * ratio) + 28);

  stage.style.setProperty('--md-cm-mermaid-width', `${visualWidth}px`);
  stage.style.setProperty('--md-cm-mermaid-height', `${visualHeight}px`);
}

export class InlineMathWidget extends WidgetType {
  constructor(
    private readonly formula: string,
    private readonly from: number,
    private readonly to: number,
    private readonly bodyFrom: number,
    private readonly bodyTo: number,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof InlineMathWidget
      && other.formula === this.formula
      && other.from === this.from
      && other.to === this.to
      && other.bodyFrom === this.bodyFrom
      && other.bodyTo === this.bodyTo;
  }

  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement('span');
    span.className = 'md-cm-math md-cm-inline-math';
    span.innerHTML = renderMarkdownMath(this.formula, false);
    span.title = i18n.t('markdown.edit_formula');
    span.addEventListener('mousedown', stopWidgetEvent);
    span.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.showInlineEditor(view, span);
    });
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }

  private showInlineEditor(view: EditorView, span: HTMLElement): void {
    const input = document.createElement('input');
    input.className = 'md-cm-inline-math-editor';
    input.value = this.formula;
    input.spellcheck = false;
    span.textContent = '';
    span.appendChild(input);

    let committed = false;
    const commit = (): void => {
      if (committed) return;
      committed = true;
      if (input.value === this.formula) {
        span.innerHTML = renderMarkdownMath(this.formula, false);
        view.focus();
        return;
      }
      dispatchSourceEdit(
        view,
        this.bodyFrom,
        this.bodyTo,
        input.value,
        mappedOuterEnd(this.to, this.bodyFrom, this.bodyTo, input.value),
      );
      view.focus();
    };
    const cancel = (): void => {
      if (committed) return;
      committed = true;
      span.innerHTML = renderMarkdownMath(this.formula, false);
      view.focus();
    };

    input.addEventListener('mousedown', stopWidgetEvent);
    input.addEventListener('click', stopWidgetEvent);
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      }
    });
    input.addEventListener('blur', commit);
    window.requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }
}

export class BlockMathWidget extends WidgetType {
  constructor(
    private readonly formula: string,
    private readonly from: number,
    private readonly to: number,
    private readonly bodyFrom: number,
    private readonly bodyTo: number,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof BlockMathWidget
      && other.formula === this.formula
      && other.from === this.from
      && other.to === this.to
      && other.bodyFrom === this.bodyFrom
      && other.bodyTo === this.bodyTo;
  }

  toDOM(view: EditorView): HTMLElement {
    const block = document.createElement('div');
    block.className = 'md-cm-block-widget md-cm-math md-cm-block-math';
    block.innerHTML = renderMarkdownMath(this.formula, true);
    block.title = i18n.t('markdown.edit_formula');
    block.addEventListener('mousedown', stopWidgetEvent);
    block.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.showBlockEditor(view, block);
    });
    return block;
  }

  ignoreEvent(): boolean {
    return true;
  }

  private showBlockEditor(view: EditorView, block: HTMLElement): void {
    const textarea = document.createElement('textarea');
    textarea.className = 'md-cm-block-math-editor';
    textarea.value = this.formula;
    textarea.spellcheck = false;
    block.textContent = '';
    block.appendChild(textarea);
    autoSizeTextarea(textarea);

    let committed = false;
    const commit = (): void => {
      if (committed) return;
      committed = true;
      const value = normalizeTextareaValue(textarea.value);
      if (value === this.formula) {
        block.innerHTML = renderMarkdownMath(this.formula, true);
        view.focus();
        return;
      }
      dispatchSourceEdit(
        view,
        this.bodyFrom,
        this.bodyTo,
        value,
        mappedOuterEnd(this.to, this.bodyFrom, this.bodyTo, value),
      );
      view.focus();
    };
    const cancel = (): void => {
      if (committed) return;
      committed = true;
      block.innerHTML = renderMarkdownMath(this.formula, true);
      view.focus();
    };

    textarea.addEventListener('mousedown', stopWidgetEvent);
    textarea.addEventListener('click', stopWidgetEvent);
    textarea.addEventListener('input', () => autoSizeTextarea(textarea));
    textarea.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      }
    });
    textarea.addEventListener('blur', commit);
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.select();
    });
  }
}

export class ImageWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly alt: string,
    private readonly markdownFilePath: string,
    private readonly from: number,
    private readonly to: number,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof ImageWidget
      && other.src === this.src
      && other.alt === this.alt
      && other.markdownFilePath === this.markdownFilePath
      && other.from === this.from
      && other.to === this.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = 'md-cm-image-widget';
    wrapper.title = i18n.t('markdown.edit_image_source');
    wrapper.addEventListener('dblclick', (event) => revealSourceRange(view, this.from, this.to, event));

    const source = resolveMarkdownAssetPath(this.src, this.markdownFilePath);
    if (!source) {
      wrapper.textContent = this.alt || i18n.t('markdown.image_empty');
      return wrapper;
    }

    const image = document.createElement('img');
    image.alt = this.alt;
    image.loading = 'lazy';
    wrapper.appendChild(image);

    if (/^(?:https?:|data:|blob:)/i.test(source)) {
      image.src = source;
      return wrapper;
    }

    window.api.invoke(IPC.FS_READ_FILE_BINARY, source)
      .then((res) => {
        const result = res as IpcResponse<string>;
        if (!wrapper.isConnected) return;
        if (result.success && result.data) {
          image.src = `data:${localImageMime(source)};base64,${result.data}`;
          return;
        }
        wrapper.textContent = this.alt || this.src;
        wrapper.classList.add('is-missing');
      })
      .catch(() => {
        if (!wrapper.isConnected) return;
        wrapper.textContent = this.alt || this.src;
        wrapper.classList.add('is-missing');
      });

    return wrapper;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export class CodeBlockWidget extends WidgetType {
  constructor(
    private readonly code: string,
    private readonly info: string,
    private readonly from: number,
    private readonly to: number,
    private readonly codeFrom: number,
    private readonly codeTo: number,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof CodeBlockWidget
      && other.code === this.code
      && other.info === this.info
      && other.from === this.from
      && other.to === this.to
      && other.codeFrom === this.codeFrom
      && other.codeTo === this.codeTo;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'md-cm-block-widget md-cm-code-block';
    wrapper.title = i18n.t('markdown.edit_code');
    wrapper.addEventListener('mousedown', stopWidgetEvent);

    if (this.info) {
      const label = document.createElement('div');
      label.className = 'md-cm-code-label';
      label.textContent = this.info;
      wrapper.appendChild(label);
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'md-cm-code-editor';
    textarea.value = codeValueForTextarea(this.code);
    textarea.spellcheck = false;
    textarea.wrap = 'off';
    textarea.title = i18n.t('markdown.edit_code_blur');
    textarea.addEventListener('mousedown', stopWidgetEvent);
    textarea.addEventListener('click', stopWidgetEvent);
    textarea.addEventListener('input', () => {
      textarea.dataset.dirty = textarea.value === codeValueForTextarea(this.code) ? '' : 'true';
      autoSizeTextarea(textarea);
    });
    textarea.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Tab') {
        event.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const value = textarea.value;
        textarea.value = `${value.slice(0, start)}  ${value.slice(end)}`;
        textarea.selectionStart = textarea.selectionEnd = start + 2;
        textarea.dispatchEvent(new Event('input'));
      } else if (event.key === 'Escape') {
        event.preventDefault();
        textarea.value = codeValueForTextarea(this.code);
        textarea.dataset.dirty = '';
        textarea.blur();
        view.focus();
      }
    });
    textarea.addEventListener('blur', () => {
      const nextCode = codeValueForMarkdown(textarea.value);
      if (nextCode !== this.code) {
        dispatchSourceEdit(
          view,
          this.codeFrom,
          this.codeTo,
          nextCode,
          mappedOuterEnd(this.to, this.codeFrom, this.codeTo, nextCode),
        );
      }
    });
    wrapper.appendChild(textarea);
    window.requestAnimationFrame(() => autoSizeTextarea(textarea));
    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export class MermaidWidget extends WidgetType {
  constructor(
    private readonly code: string,
    private readonly from: number,
    private readonly to: number,
    private readonly codeFrom: number,
    private readonly codeTo: number,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof MermaidWidget
      && other.code === this.code
      && other.from === this.from
      && other.to === this.to
      && other.codeFrom === this.codeFrom
      && other.codeTo === this.codeTo;
  }

  get estimatedHeight(): number {
    return estimateMermaidHeight(this.code);
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div');
    const isMindmap = isMindmapSource(this.code);
    wrapper.className = `md-cm-block-widget md-cm-mermaid mermaid-block markdown-mermaid-block mermaid-rendering${isMindmap ? ' mermaid-mindmap-diagram' : ''}`;
    wrapper.title = i18n.t('markdown.edit_mermaid');
    wrapper.addEventListener('mousedown', stopWidgetEvent);

    const stage = document.createElement('div');
    stage.className = 'md-cm-mermaid-stage is-loading';
    stage.style.setProperty('--md-cm-mermaid-height', `${estimateMermaidHeight(this.code)}px`);
    stage.textContent = i18n.t('markdown.mermaid_rendering');
    const renderHost = document.createElement('div');
    renderHost.className = 'md-cm-mermaid-render-host';
    wrapper.append(stage, renderHost);

    const widgetId = `md-cm-mmd-${Date.now()}-${mermaidWidgetCounter++}`;
    const repaired = repairMermaidFlowchartSafeSubset(this.code);
    const renderSource = repaired.code;

    (async () => {
      try {
        const parsed = await mermaid.parse(renderSource, { suppressErrors: true });
        if (!wrapper.isConnected) return;
        if (!parsed) {
          renderMermaidFallback(wrapper, this.code, i18n.t('markdown.mermaid_syntax_error'), repaired.changed ? renderSource : undefined, isMindmap);
          appendMermaidSourceButton(wrapper, view, this.code, this.to, this.codeFrom, this.codeTo);
          requestWidgetMeasure(view);
          return;
        }

        const { svg } = await mermaid.render(widgetId, renderSource, renderHost);
        if (!wrapper.isConnected) return;
        if (hasMermaidRenderError(svg)) {
          renderMermaidFallback(wrapper, this.code, i18n.t('markdown.mermaid_render_failed'), repaired.changed ? renderSource : undefined, isMindmap);
          appendMermaidSourceButton(wrapper, view, this.code, this.to, this.codeFrom, this.codeTo);
          requestWidgetMeasure(view);
          return;
        }

        wrapper.className = `md-cm-block-widget md-cm-mermaid mermaid-block markdown-mermaid-block mermaid-diagram${isMindmap ? ' mermaid-mindmap-diagram' : ''}`;
        wrapper.dataset.repaired = repaired.changed ? 'true' : '';
        stage.className = 'md-cm-mermaid-stage';
        applyMermaidStageSize(stage, extractSvgMetrics(svg));
        stage.innerHTML = svg;
        wrapper.replaceChildren(stage);
        appendMermaidSourceButton(wrapper, view, this.code, this.to, this.codeFrom, this.codeTo);
        requestWidgetMeasure(view);
      } catch (error) {
        if (!wrapper.isConnected) return;
        renderMermaidFallback(
          wrapper,
          this.code,
          i18n.t('markdown.mermaid_render_failed_detail', { error: normalizeMermaidError(error) }),
          repaired.changed ? renderSource : undefined,
          isMindmap,
        );
        appendMermaidSourceButton(wrapper, view, this.code, this.to, this.codeFrom, this.codeTo);
        requestWidgetMeasure(view);
      }
    })();

    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function requestWidgetMeasure(view: EditorView): void {
  window.requestAnimationFrame(() => {
    if (!view.dom.isConnected) return;
    view.requestMeasure();
  });
}

function appendMermaidSourceButton(
  wrapper: HTMLElement,
  view: EditorView,
  source: string,
  outerTo: number,
  codeFrom: number,
  codeTo: number,
): void {
  const toolbar = document.createElement('div');
  toolbar.className = 'md-cm-widget-toolbar';
  toolbar.addEventListener('mousedown', stopWidgetEvent);
  toolbar.addEventListener('click', stopWidgetEvent);

  const button = document.createElement('button');
  button.className = 'md-cm-widget-button';
  button.type = 'button';
  button.textContent = i18n.t('markdown.mermaid_source_btn');
  button.title = i18n.t('markdown.mermaid_expand_source');
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showMermaidSourceEditor(wrapper, view, source, outerTo, codeFrom, codeTo);
  });

  toolbar.appendChild(button);
  wrapper.appendChild(toolbar);
}

function showMermaidSourceEditor(
  wrapper: HTMLElement,
  view: EditorView,
  source: string,
  outerTo: number,
  codeFrom: number,
  codeTo: number,
): void {
  const existing = wrapper.querySelector<HTMLTextAreaElement>('.md-cm-mermaid-source-editor');
  if (existing) {
    existing.focus();
    existing.select();
    return;
  }

  const panel = document.createElement('div');
  panel.className = 'md-cm-mermaid-editor';
  panel.addEventListener('mousedown', stopWidgetEvent);
  panel.addEventListener('click', stopWidgetEvent);

  const textarea = document.createElement('textarea');
  textarea.className = 'md-cm-mermaid-source-editor';
  textarea.value = codeValueForTextarea(source);
  textarea.spellcheck = false;
  textarea.wrap = 'off';
  textarea.addEventListener('input', () => autoSizeTextarea(textarea));
  textarea.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      const nextCode = codeValueForMarkdown(textarea.value);
      dispatchSourceEdit(view, codeFrom, codeTo, nextCode, mappedOuterEnd(outerTo, codeFrom, codeTo, nextCode));
      view.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      panel.remove();
      view.focus();
    }
  });

  const actions = document.createElement('div');
  actions.className = 'md-cm-widget-actions';

  const apply = document.createElement('button');
  apply.className = 'md-cm-widget-button';
  apply.type = 'button';
  apply.textContent = i18n.t('markdown.apply');
  apply.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const nextCode = codeValueForMarkdown(textarea.value);
    dispatchSourceEdit(view, codeFrom, codeTo, nextCode, mappedOuterEnd(outerTo, codeFrom, codeTo, nextCode));
    view.focus();
  });

  const cancel = document.createElement('button');
  cancel.className = 'md-cm-widget-button';
  cancel.type = 'button';
  cancel.textContent = i18n.t('common.cancel');
  cancel.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    panel.remove();
    view.focus();
  });

  actions.append(apply, cancel);
  panel.append(textarea, actions);
  wrapper.appendChild(panel);
  autoSizeTextarea(textarea);
  window.requestAnimationFrame(() => {
    textarea.focus();
    textarea.select();
  });
}

function renderMermaidFallback(
  wrapper: HTMLElement,
  source: string,
  message: string,
  repairedSource: string | undefined,
  isMindmap: boolean,
): void {
  wrapper.className = `md-cm-block-widget md-cm-mermaid mermaid-block markdown-mermaid-block mermaid-fallback${isMindmap ? ' mermaid-mindmap-diagram' : ''}`;
  wrapper.textContent = '';

  const label = document.createElement('div');
  label.className = 'mermaid-fallback-label';
  label.textContent = `${message} ${i18n.t('markdown.mermaid_fallback_suffix')}`;
  wrapper.appendChild(label);

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-mermaid';
  code.textContent = source;
  pre.appendChild(code);
  wrapper.appendChild(pre);

  if (repairedSource && repairedSource !== source) {
    const details = document.createElement('details');
    details.className = 'mermaid-repaired-source';
    const summary = document.createElement('summary');
    summary.textContent = i18n.t('markdown.mermaid_view_repaired');
    const repairedPre = document.createElement('pre');
    const repairedCode = document.createElement('code');
    repairedCode.className = 'language-mermaid';
    repairedCode.textContent = repairedSource;
    repairedPre.appendChild(repairedCode);
    details.append(summary, repairedPre);
    wrapper.appendChild(details);
  }
}

export class TableWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly from: number,
    private readonly to: number,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof TableWidget
      && other.source === this.source
      && other.from === this.from
      && other.to === this.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'md-cm-block-widget md-cm-table-widget';
    wrapper.title = i18n.t('markdown.edit_cell');
    wrapper.addEventListener('mousedown', stopWidgetEvent);
    wrapper.addEventListener('click', openHttpLinkFromEvent);

    const tableData = parseMarkdownTable(this.source);
    if (tableData.rows.length === 0) {
      wrapper.textContent = this.source;
      return wrapper;
    }

    const table = document.createElement('table');
    const header = tableData.rows[0] ?? [];
    const body = tableData.rows.slice(1);
    const columnCount = Math.max(...tableData.rows.map((row) => row.length), 0);

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (let index = 0; index < columnCount; index += 1) {
      const th = document.createElement('th');
      renderTableCell(th, header[index] ?? '', 0, index, tableData, view, this.from, this.to);
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let rowIndex = 0; rowIndex < body.length; rowIndex += 1) {
      const row = body[rowIndex];
      const tr = document.createElement('tr');
      for (let index = 0; index < columnCount; index += 1) {
        const td = document.createElement('td');
        renderTableCell(td, row[index] ?? '', rowIndex + 1, index, tableData, view, this.from, this.to);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrapper.appendChild(table);
    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

type TableAlignment = 'default' | 'left' | 'center' | 'right';

interface MarkdownTableData {
  rows: string[][];
  alignments: TableAlignment[];
}

function renderTableCell(
  cell: HTMLTableCellElement,
  value: string,
  rowIndex: number,
  columnIndex: number,
  tableData: MarkdownTableData,
  view: EditorView,
  from: number,
  to: number,
): void {
  cell.classList.add('md-cm-table-cell');
  renderTableCellContent(cell, value);

  cell.addEventListener('click', (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest('a')) return;
    event.preventDefault();
    event.stopPropagation();
    showTableCellEditor(cell, value, rowIndex, columnIndex, tableData, view, from, to);
  });
}

function renderTableCellContent(cell: HTMLTableCellElement, value: string): void {
  cell.textContent = '';
  if (value.trim()) {
    cell.innerHTML = renderMarkdownInlineToHtml(value);
  } else {
    const placeholder = document.createElement('span');
    placeholder.className = 'md-cm-table-empty-cell';
    placeholder.textContent = i18n.t('markdown.cell_empty');
    cell.appendChild(placeholder);
  }
}

function showTableCellEditor(
  cell: HTMLTableCellElement,
  value: string,
  rowIndex: number,
  columnIndex: number,
  tableData: MarkdownTableData,
  view: EditorView,
  from: number,
  to: number,
): void {
  if (cell.querySelector('textarea')) return;

  const textarea = document.createElement('textarea');
  textarea.className = 'md-cm-table-cell-editor';
  textarea.value = value;
  textarea.spellcheck = false;
  cell.textContent = '';
  cell.appendChild(textarea);
  autoSizeTextarea(textarea);

  let finished = false;
  const restore = (): void => {
    renderTableCellContent(cell, value);
  };
  const commit = (): void => {
    if (finished) return;
    finished = true;
    const nextValue = normalizeTextareaValue(textarea.value).replace(/\n/g, ' ').trim();
    if (nextValue === value) {
      restore();
      return;
    }
    const rows = tableData.rows.map((row) => row.slice());
    while (rows.length <= rowIndex) rows.push([]);
    while (rows[rowIndex].length <= columnIndex) rows[rowIndex].push('');
    rows[rowIndex][columnIndex] = nextValue;
    dispatchSourceEdit(view, from, to, serializeMarkdownTable({ rows, alignments: tableData.alignments }));
    view.focus();
  };
  const cancel = (): void => {
    if (finished) return;
    finished = true;
    restore();
    view.focus();
  };

  textarea.addEventListener('mousedown', stopWidgetEvent);
  textarea.addEventListener('click', stopWidgetEvent);
  textarea.addEventListener('input', () => autoSizeTextarea(textarea));
  textarea.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  });
  textarea.addEventListener('blur', commit);
  window.requestAnimationFrame(() => {
    textarea.focus();
    textarea.select();
  });
}

function parseMarkdownTable(source: string): MarkdownTableData {
  const lines = source.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return { rows: [], alignments: [] };
  const delimiterIndex = lines.findIndex(isDelimiterRow);
  if (delimiterIndex <= 0) return { rows: [], alignments: [] };
  const alignments = splitTableRow(lines[delimiterIndex]).map(parseTableAlignment);
  const rows = lines
    .filter((_, index) => index !== delimiterIndex)
    .map(splitTableRow)
    .filter((row) => row.some((cell) => cell.trim()));
  return { rows, alignments };
}

function isDelimiterRow(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cell = '';
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      cell += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function parseTableAlignment(cell: string): TableAlignment {
  const trimmed = cell.trim();
  const left = trimmed.startsWith(':');
  const right = trimmed.endsWith(':');
  if (left && right) return 'center';
  if (left) return 'left';
  if (right) return 'right';
  return 'default';
}

function serializeMarkdownTable(tableData: MarkdownTableData): string {
  const columnCount = Math.max(2, ...tableData.rows.map((row) => row.length), tableData.alignments.length);
  const rows = tableData.rows.length > 0 ? tableData.rows : [Array.from({ length: columnCount }, () => '')];
  const normalizedRows = rows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? ''));
  const delimiter = Array.from({ length: columnCount }, (_, index) => delimiterForAlignment(tableData.alignments[index] ?? 'default'));
  const lines = [
    serializeMarkdownTableRow(normalizedRows[0]),
    serializeMarkdownTableRow(delimiter),
    ...normalizedRows.slice(1).map(serializeMarkdownTableRow),
  ];
  return lines.join('\n');
}

function serializeMarkdownTableRow(row: readonly string[]): string {
  return `| ${row.map(escapeTableCell).join(' | ')} |`;
}

function escapeTableCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function delimiterForAlignment(alignment: TableAlignment): string {
  if (alignment === 'left') return ':---';
  if (alignment === 'center') return ':---:';
  if (alignment === 'right') return '---:';
  return '---';
}

export class HorizontalRuleWidget extends WidgetType {
  constructor(
    private readonly from: number,
    private readonly to: number,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof HorizontalRuleWidget
      && other.from === this.from
      && other.to === this.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'md-cm-block-widget md-cm-hr-widget';
    wrapper.title = i18n.t('markdown.edit_hr');
    wrapper.addEventListener('dblclick', (event) => revealSourceRange(view, this.from, this.to, event));
    wrapper.appendChild(document.createElement('hr'));
    return wrapper;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export class TaskMarkerWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly from: number,
    private readonly to: number,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof TaskMarkerWidget
      && other.checked === this.checked
      && other.from === this.from
      && other.to === this.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const checkbox = document.createElement('input');
    checkbox.className = 'md-cm-task-checkbox';
    checkbox.type = 'checkbox';
    checkbox.checked = this.checked;
    checkbox.title = i18n.t('markdown.toggle_task');
    checkbox.addEventListener('mousedown', (event) => event.stopPropagation());
    checkbox.addEventListener('change', (event) => {
      event.stopPropagation();
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: checkbox.checked ? '[x]' : '[ ]' },
        selection: { anchor: this.to },
      });
      view.focus();
    });
    return checkbox;
  }

  ignoreEvent(): boolean {
    return false;
  }
}
