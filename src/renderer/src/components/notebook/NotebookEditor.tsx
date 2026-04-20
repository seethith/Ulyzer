import { useEffect, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useNotebookStore } from '../../stores/notebook.store';

interface Props {
  nodeId: string;
  courseId: string;
}

export default function NotebookEditor({ nodeId, courseId }: Props) {
  const { notebook, loading, loadNotebook, saveNotebook } = useNotebookStore();
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = useEditor({
    extensions: [StarterKit],
    content: '',
    onUpdate: ({ editor: e }) => {
      const html = e.getHTML();
      useNotebookStore.getState().setContent(html);

      // Debounced auto-save
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const nb = useNotebookStore.getState().notebook;
        if (nb) {
          saveNotebook(nodeId, courseId, { content: html });
        }
      }, 1500);
    },
  });

  useEffect(() => {
    loadNotebook(nodeId, courseId);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [nodeId, courseId]);

  // Sync initial content when notebook loads
  useEffect(() => {
    if (editor && notebook && !editor.isFocused) {
      const current = editor.getHTML();
      if (current !== notebook.content && notebook.content) {
        editor.commands.setContent(notebook.content, { emitUpdate: false });
      }
    }
  }, [notebook?.content, editor]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text3)' }}>
        加载笔记...
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', gap: 4, padding: '6px 10px',
        flexShrink: 0,
        background: 'var(--panel)',
      }}>
        {[
          { label: 'B', action: () => editor?.chain().focus().toggleBold().run(), active: editor?.isActive('bold') },
          { label: 'I', action: () => editor?.chain().focus().toggleItalic().run(), active: editor?.isActive('italic') },
          { label: 'H2', action: () => editor?.chain().focus().toggleHeading({ level: 2 }).run(), active: editor?.isActive('heading', { level: 2 }) },
          { label: 'H3', action: () => editor?.chain().focus().toggleHeading({ level: 3 }).run(), active: editor?.isActive('heading', { level: 3 }) },
          { label: '•', action: () => editor?.chain().focus().toggleBulletList().run(), active: editor?.isActive('bulletList') },
          { label: '1.', action: () => editor?.chain().focus().toggleOrderedList().run(), active: editor?.isActive('orderedList') },
          { label: '`', action: () => editor?.chain().focus().toggleCode().run(), active: editor?.isActive('code') },
        ].map((btn) => (
          <button
            key={btn.label}
            onClick={btn.action}
            style={{
              padding: '2px 8px', fontSize: 12, borderRadius: 4, border: '1px solid var(--border)',
              background: btn.active ? 'var(--accent-s)' : 'var(--surface2)',
              color: btn.active ? 'var(--accent)' : 'var(--text2)',
              cursor: 'pointer', fontWeight: btn.label === 'B' ? 700 : 400,
              fontStyle: btn.label === 'I' ? 'italic' : 'normal',
            }}
          >
            {btn.label}
          </button>
        ))}
      </div>

      {/* Editor area */}
      <div
        style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}
        className="notebook-editor-wrap"
      >
        <EditorContent
          editor={editor}
          style={{ minHeight: '100%', outline: 'none' }}
        />
        {!notebook?.content && (
          <div style={{
            position: 'absolute', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            color: 'var(--text3)', fontSize: 13, pointerEvents: 'none',
            textAlign: 'center',
          }}>
            用自己的话写下对本节内容的理解<br />
            <span style={{ fontSize: 11 }}>（费曼学习法：能讲清楚才是真懂了）</span>
          </div>
        )}
      </div>
    </div>
  );
}
