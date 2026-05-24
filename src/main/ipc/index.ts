import { registerDbHandlers } from './db.ipc';
import { registerLlmHandlers } from './llm.ipc';
import { registerAgentHandlers } from './agent.ipc';
import { registerFsHandlers } from './fs.ipc';
import { registerWebHandlers } from './web.ipc';
import { registerSourceHandlers } from './source.ipc';
import { registerChatAttachmentHandlers } from './chat-attachment.ipc';
import { registerStorageHandlers } from './storage.ipc';
import { registerUpdateHandlers } from './update.ipc';

export function registerAllHandlers(): void {
  registerDbHandlers();
  registerLlmHandlers();
  registerAgentHandlers();
  registerFsHandlers();
  registerWebHandlers();
  registerSourceHandlers();
  registerChatAttachmentHandlers();
  registerStorageHandlers();
  registerUpdateHandlers();
}
