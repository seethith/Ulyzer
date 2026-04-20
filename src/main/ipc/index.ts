import { registerDbHandlers } from './db.ipc';
import { registerLlmHandlers } from './llm.ipc';
import { registerAgentHandlers } from './agent.ipc';
import { registerRagHandlers } from './rag.ipc';
import { registerFsHandlers } from './fs.ipc';
import { registerWebHandlers } from './web.ipc';

export function registerAllHandlers(): void {
  registerDbHandlers();
  registerLlmHandlers();
  registerAgentHandlers();
  registerRagHandlers();
  registerFsHandlers();
  registerWebHandlers();
}
