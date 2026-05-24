import React from 'react';
import { useChatStore } from '../../stores/chat.store';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolGroupBlock } from './ToolGroupBlock';
import type { UiTool } from './toolActivity';

/**
 * Live composer for the active run: streams the thinking block (open by default so
 * the user watches the analysis) and the tool group, in canonical order.
 */
export const LiveActivity: React.FC = () => {
  const thinkingContent = useChatStore((s) => s.thinkingContent);
  const liveToolEvents = useChatStore((s) => s.liveToolEvents);

  const tools: UiTool[] = liveToolEvents.map((e) => ({
    name: e.toolName,
    status: e.status,
    durationMs: e.durationMs,
  }));

  const hasThinking = Boolean(thinkingContent.trim());
  if (!hasThinking && tools.length === 0) return null;

  return (
    <div>
      {hasThinking && <ThinkingBlock content={thinkingContent} sealed={false} defaultOpen />}
      {tools.length > 0 && <ToolGroupBlock tools={tools} defaultCollapsed={false} />}
    </div>
  );
};
