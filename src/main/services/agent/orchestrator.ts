import type { IpcMainInvokeEvent } from 'electron';
import type { LLMProvider, LLMMessage } from '@shared/types';
import type { ImageAttachment, PdfAttachment } from '../llm/adapter';
import { MainTutor } from './main-tutor';
import { SubTutor } from './sub-tutor';

export type AgentType = 'main_tutor' | 'sub_tutor';
export type AgentAction = 'chat' | 'generate_dag';

export interface AgentRequest {
  type: AgentType;
  action: AgentAction;
  courseId: string;
  nodeId?: string;
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
  webSearchEnabled?: boolean;
  /** UI language — used to instruct AI to respond in the correct language */
  language?: string;
}

export class AgentOrchestrator {
  async dispatch(req: AgentRequest): Promise<void> {
    switch (req.type) {
      case 'main_tutor': {
        const tutor = new MainTutor();
        await tutor.handle(req);
        break;
      }
      case 'sub_tutor': {
        const tutor = new SubTutor();
        await tutor.handle(req);
        break;
      }
      default: {
        throw new Error(`Agent type not yet supported: ${req.type}`);
      }
    }
  }
}
