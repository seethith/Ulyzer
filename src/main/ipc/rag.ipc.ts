import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { IpcResponse } from '../../../shared/types';
import { indexFile } from '../services/rag/indexer';
import { retrieveChunks } from '../services/rag/retriever';

export function registerRagHandlers(): void {
  // Index a file's content into FTS5
  ipcMain.handle(
    IPC.RAG_INDEX,
    (_e, fileId: string, nodeId: string, courseId: string, content: string): IpcResponse => {
      try {
        indexFile(fileId, nodeId, courseId, content);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
  );

  // Retrieve top-k chunks for a node + query
  ipcMain.handle(
    IPC.RAG_RETRIEVE,
    (_e, nodeId: string, query: string, k?: number): IpcResponse => {
      try {
        const chunks = retrieveChunks(nodeId, query, k);
        return { success: true, data: chunks };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
  );
}
