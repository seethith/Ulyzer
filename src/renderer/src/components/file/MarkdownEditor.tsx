import React, { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, NodeViewWrapper, NodeViewContent, ReactNodeViewRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { TableKit } from '@tiptap/extension-table';
import Link from '@tiptap/extension-link';
import { Markdown } from 'tiptap-markdown';
import { createLowlight, common } from 'lowlight';
import mermaid from 'mermaid';
import { IPC } from '@shared/ipc-channels';

const lowlight = createLowlight(common);

mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' });

// ── Mermaid NodeView ──────────────────────────────────────────────────────────

interface MermaidNodeProps {
  node: { attrs: { language?: string }; textContent: string };
}

const MermaidBlock: React.FC<MermaidNodeProps> = ({ node }) => {
  const [svg, setSvg]           = useState('');
  const [editMode, setEditMode] = useState(false);
  const lang = node.attrs.language ?? '';
  const code = node.textContent;

  useEffect(() => {
    if (lang !== 'mermaid' || !code.trim()) { setSvg(''); return; }
    const id = `mmd-${Math.random().toString(36).slice(2, 9)}`;
    mermaid.render(id, code)
      .then(({ svg: s }) => {
        // Mermaid v11 resolves with an error-containing SVG instead of rejecting.
        // Detect the error text and fall back to code view.
        if (s.includes('Syntax error')) {
          setSvg(''); setEditMode(true);
        } else {
          setSvg(s); setEditMode(false);
        }
      })
      .catch(() => { setSvg(''); setEditMode(true); });
  }, [code, lang]);

  // Non-mermaid: standard code block rendering
  if (lang !== 'mermaid') {
    return (
      <NodeViewWrapper as="pre">
        <NodeViewContent as={"code" as unknown as "div"} className={lang ? `language-${lang}` : undefined} />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper className="mermaid-block">
      {/* NodeViewContent must always stay in the DOM so TipTap manages the content */}
      <div style={{ display: editMode || !svg ? 'block' : 'none' }}>
        <pre style={{ margin: 0 }}>
          <NodeViewContent as={"code" as unknown as "div"} className="language-mermaid" />
        </pre>
        {svg && (
          <button
            contentEditable={false}
            onMouseDown={(e) => { e.preventDefault(); setEditMode(false); }}
            style={{
              fontSize: 11, marginTop: 6, padding: '2px 8px', cursor: 'pointer',
              border: '1px solid var(--border)', background: 'var(--surface2)',
              color: 'var(--text2)', borderRadius: 4,
            }}
          >
            ↩ 显示图表
          </button>
        )}
      </div>

      {/* Rendered diagram — click to switch to code edit mode */}
      {svg && !editMode && (
        <div
          className="mermaid-diagram"
          dangerouslySetInnerHTML={{ __html: svg }}
          onClick={() => setEditMode(true)}
          title="点击查看 / 编辑代码"
          style={{ cursor: 'pointer', overflowX: 'auto' }}
        />
      )}
    </NodeViewWrapper>
  );
};

// ── MarkdownEditor ────────────────────────────────────────────────────────────

interface MarkdownEditorProps {
  content: string;
  onChange?: (markdown: string) => void;
}

export const MarkdownEditor: React.FC<MarkdownEditorProps> = ({ content, onChange }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      CodeBlockLowlight.configure({ lowlight }).extend({
        addNodeView() {
          return ReactNodeViewRenderer(MermaidBlock as React.FC);
        },
      }),
      TableKit,
      Link.configure({ openOnClick: false, HTMLAttributes: { rel: 'noopener noreferrer' } }),
      Markdown.configure({ html: true, transformPastedText: true }),
    ],
    content,
    onUpdate: ({ editor: e }) => {
      const mdStorage = e.storage as unknown as Record<string, { getMarkdown: () => string }>;
      onChange?.(mdStorage.markdown.getMarkdown());
    },
  });

  // Sync when content changes from outside (e.g. file reloaded)
  useEffect(() => {
    if (!editor || editor.isFocused) return;
    const mdStorage = editor.storage as unknown as Record<string, { getMarkdown: () => string }>;
    const current = mdStorage.markdown.getMarkdown();
    if (current !== content) {
      editor.commands.setContent(content, { emitUpdate: false });
    }
  }, [content]);  

  // Open links externally via Electron shell
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (href?.startsWith('http://') || href?.startsWith('https://')) {
        e.preventDefault();
        window.api.invoke(IPC.SHELL_OPEN_URL, href);
      }
    };
    container.addEventListener('click', handleClick);
    return () => container.removeEventListener('click', handleClick);
  }, []);

  return (
    <div ref={containerRef} className="rich-editor-wrap">
      <EditorContent editor={editor} />
    </div>
  );
};
