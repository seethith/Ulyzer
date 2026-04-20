import React, { useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { createLowlight, common } from 'lowlight';
import { marked } from 'marked';

const lowlight = createLowlight(common);

// Detect if content is already HTML; otherwise treat as Markdown
function toHtml(content: string): string {
  if (/^\s*<[a-z]/i.test(content.trim())) return content;
  return marked.parse(content) as string;
}

interface RichEditorProps {
  content: string;
  onChange?: (html: string) => void;
}

export const RichEditor: React.FC<RichEditorProps> = ({ content, onChange }) => {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      CodeBlockLowlight.configure({ lowlight }),
    ],
    content: toHtml(content),
    onUpdate: ({ editor: e }) => {
      onChange?.(e.getHTML());
    },
  });

  // Sync when content changes from outside (e.g. AI re-generation)
  useEffect(() => {
    if (!editor || editor.isFocused) return;
    const next = toHtml(content);
    if (editor.getHTML() !== next) {
      editor.commands.setContent(next, { emitUpdate: false });
    }
  }, [content]);  

  return (
    <div className="rich-editor-wrap">
      <EditorContent editor={editor} />
    </div>
  );
};
