import type { IpcMainInvokeEvent } from 'electron';
import type { ActiveNodeFileContext, LLMProvider, LLMMessage, ThinkingMode } from '@shared/types';
import type { SupportedLocale } from '@shared/i18n';
import type { ImageAttachment, PdfAttachment } from '../llm/adapter';
import type { ChatRunRecorder } from '../agent-chat/chat-run-recorder';
import { MainTutor } from '../agent-workflows/main-tutor';
import { SubTutor } from '../agent-workflows/sub-tutor';

export type AgentType = 'main_tutor' | 'sub_tutor';
/**
 * Coarse action label. There is no intent classifier anymore — chat turns are
 * dispatched as 'chat' and the model routes via tools.
 */
export type AgentAction =
  | 'chat'
  | 'roadmap_generate'
  | 'roadmap_edit'
  | 'course_strategy'
  | 'node_dispatch'
  | 'material_generate'
  | 'custom_artifact'
  | 'file_edit'
  | 'review'
  | 'diagnostic';

export interface AgentRequest {
  type: AgentType;
  action: AgentAction;
  courseId: string;
  nodeId?: string;
  threadId?: string;
  sessionId: string;
  provider: LLMProvider;
  model: string;
  userMessage: string;
  messages?: LLMMessage[];
  contextFiles?: string[];
  senderEvent: IpcMainInvokeEvent;
  signal?: AbortSignal;
  imageAttachments?: ImageAttachment[];
  pdfAttachments?: PdfAttachment[];
  searchMode?: 'auto' | 'web' | 'library' | 'off';
  thinkingMode?: ThinkingMode;
  /** Normalized UI/agent locale used to instruct AI and name generated artifacts. */
  language?: SupportedLocale;
  activeFile?: ActiveNodeFileContext;
  recorder?: ChatRunRecorder;
}

export class AgentOrchestrator {
  async dispatch(req: AgentRequest): Promise<void> {
    switch (req.type) {
      case 'main_tutor':
        await new MainTutor().handle(req);
        break;
      case 'sub_tutor':
        await new SubTutor().handle(req);
        break;
      default:
        throw new Error(`Agent type not yet supported: ${req.type}`);
    }
  }
}
