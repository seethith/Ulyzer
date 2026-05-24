import React, { useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { useTranslation } from 'react-i18next';
import { IPC } from '@shared/ipc-channels';
import { repairMermaidFlowchartSafeSubset } from '@shared/mermaid-sanitize';
import { renderMarkdownToHtml } from '../../utils/markdown-render';
import { splitMarkdownForMermaid } from '../../utils/markdown-parts';
import { hasMermaidRenderError } from '../../utils/mermaid-render';
import { isMindmapSource, MERMAID_RENDER_CONFIG } from '../../utils/mermaid-config';

mermaid.initialize(MERMAID_RENDER_CONFIG);

interface MarkdownPreviewProps {
  content: string;
  className?: string;
}

type MermaidState =
  | { status: 'rendering' }
  | { status: 'rendered'; svg: string; repaired: boolean }
  | { status: 'failed'; messageKey: 'syntax' | 'render' | 'render_detail'; error?: string; repairedSource?: string };

function normalizeMermaidError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || 'Mermaid render failed');
}

const MermaidDiagram: React.FC<{ source: string }> = ({ source }) => {
  const { t } = useTranslation();
  const reactId = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const renderIdRef = useRef(`md-mmd-${reactId}-${Math.random().toString(36).slice(2, 8)}`);
  const [state, setState] = useState<MermaidState>({ status: 'rendering' });
  const isMindmap = isMindmapSource(source);

  useEffect(() => {
    let cancelled = false;
    const repaired = repairMermaidFlowchartSafeSubset(source);
    const renderSource = repaired.code;
    setState({ status: 'rendering' });

    (async () => {
      try {
        const parsed = await mermaid.parse(renderSource, { suppressErrors: true });
        if (cancelled) return;
        if (!parsed) {
          setState({
            status: 'failed',
            messageKey: 'syntax',
            repairedSource: repaired.changed ? renderSource : undefined,
          });
          return;
        }

        const { svg } = await mermaid.render(renderIdRef.current, renderSource);
        if (cancelled) return;
        if (hasMermaidRenderError(svg)) {
          setState({
            status: 'failed',
            messageKey: 'render',
            repairedSource: repaired.changed ? renderSource : undefined,
          });
          return;
        }

        setState({ status: 'rendered', svg, repaired: repaired.changed });
      } catch (error) {
        if (cancelled) return;
        setState({
          status: 'failed',
          messageKey: 'render_detail',
          error: normalizeMermaidError(error),
          repairedSource: repaired.changed ? renderSource : undefined,
        });
      }
    })();

    return () => { cancelled = true; };
  }, [source]);

  if (state.status === 'rendered') {
    return (
      <div
        className={`mermaid-block markdown-mermaid-block mermaid-diagram${isMindmap ? ' mermaid-mindmap-diagram' : ''}`}
        data-repaired={state.repaired ? 'true' : undefined}
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    );
  }

  if (state.status === 'rendering') {
    return (
      <div className={`mermaid-block markdown-mermaid-block mermaid-rendering${isMindmap ? ' mermaid-mindmap-diagram' : ''}`}>
        {t('markdown.mermaid_rendering')}
      </div>
    );
  }

  const failedMessage = state.messageKey === 'render_detail'
    ? t('markdown.mermaid_render_failed_detail', { error: state.error })
    : state.messageKey === 'syntax'
      ? t('markdown.mermaid_syntax_error')
      : t('markdown.mermaid_render_failed');

  return (
    <div className={`mermaid-block markdown-mermaid-block mermaid-fallback${isMindmap ? ' mermaid-mindmap-diagram' : ''}`}>
      <div className="mermaid-fallback-label">{failedMessage} {t('markdown.mermaid_fallback_suffix')}</div>
      <pre><code className="language-mermaid">{source}</code></pre>
      {state.repairedSource && state.repairedSource !== source && (
        <details className="mermaid-repaired-source">
          <summary>{t('markdown.mermaid_view_repaired')}</summary>
          <pre><code className="language-mermaid">{state.repairedSource}</code></pre>
        </details>
      )}
    </div>
  );
};

const MarkdownHtmlChunk: React.FC<{ content: string }> = ({ content }) => {
  const html = useMemo(() => renderMarkdownToHtml(content), [content]);
  return <div className="markdown-html-chunk" dangerouslySetInnerHTML={{ __html: html }} />;
};

export const MarkdownPreview = React.forwardRef<HTMLDivElement, MarkdownPreviewProps>(({ content, className }, forwardedRef) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const parts = useMemo(() => splitMarkdownForMermaid(content), [content]);

  useImperativeHandle(forwardedRef, () => containerRef.current as HTMLDivElement);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target instanceof HTMLElement
        ? event.target
        : event.target instanceof Node
          ? event.target.parentElement
          : null;

      // Code-block copy button (rendered by the markdown code renderer).
      const copyBtn = target?.closest('.md-code-copy');
      if (copyBtn instanceof HTMLElement) {
        event.preventDefault();
        const code = copyBtn.closest('.hljs-pre')?.querySelector('code');
        const text = code?.textContent ?? '';
        if (text) {
          navigator.clipboard.writeText(text).then(() => {
            copyBtn.classList.add('md-code-copied');
            window.setTimeout(() => copyBtn.classList.remove('md-code-copied'), 1500);
          }).catch(() => {/* ignore */});
        }
        return;
      }

      const anchor = target?.closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (href?.startsWith('http://') || href?.startsWith('https://')) {
        event.preventDefault();
        window.api.invoke(IPC.SHELL_OPEN_URL, href);
      }
    };
    container.addEventListener('click', handleClick);
    return () => container.removeEventListener('click', handleClick);
  }, []);

  return (
    <div ref={containerRef} className={className}>
      {parts.map((part, index) => (
        part.kind === 'mermaid'
          ? <MermaidDiagram key={`mermaid-${index}`} source={part.content} />
          : <MarkdownHtmlChunk key={`markdown-${index}`} content={part.content} />
      ))}
    </div>
  );
});

MarkdownPreview.displayName = 'MarkdownPreview';
