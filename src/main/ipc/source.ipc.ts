import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import {
  attachmentMimeType,
} from '@shared/attachment-formats';
import { IPC } from '@shared/ipc-channels';
import type {
  IpcResponse,
  SourceProcessingState,
  SourceExercise,
  SourceExerciseExtractionResult,
  SourceExerciseListRequest,
  SourceExerciseReextractRequest,
  SourceExerciseUpdateRequest,
  SourceListRequest,
  SourceReindexRequest,
  SourceSearchRequest,
  SourceSearchResult,
  SourceStatsRequest,
  SourceLibraryStats,
  SourceImportTextRequest,
  SourceImportFileRequest,
  SourceImportUrlRequest,
  SourceRecord,
  SourceLinkAddRequest,
  SourceLinkCandidatesRequest,
  SourceLinkRemoveRequest,
  SourceLinkUpdateRequest,
  YtDlpInstallResult,
  YtDlpStatus,
  FfmpegStatus,
  WhisperStatus,
  WhisperInstallResult,
} from '@shared/types';
import { hybridRetrieve } from '../services/retrieval/hybrid-retriever';
import {
  deleteSource,
  getSourceById,
  getSourceLibraryStats,
  importTextSource,
  linkMainSourcesToNode,
  listLinkableMainSources,
  listSources,
  unlinkMainSourceFromNode,
  updateMainSourceLinkForNode,
  replaceSourceContent,
  updateSource,
} from '../services/source/source-library';
import {
  getYtDlpStatus,
  installYtDlp,
} from '../services/source/video-ingestion';
import {
  getFfmpegStatus,
  getWhisperStatus,
  installWhisper,
} from '../services/source/local-transcription';
import { ingestUrlSource } from '../services/source/url-ingestion';
import { rebuildSourceSemanticProfile, scheduleSourceSemanticProfile } from '../services/source/source-semantic-profile';
import { reindexSource, setSourceProcessingError, setSourceProcessingState } from '../services/source/source-indexer';
import { extractExercisesForSource, listSourceExercises, updateSourceExerciseStatus } from '../services/source/source-exercises';
import { reprocessDocumentSource } from '../services/documents/document-processing';
import { ingestUploadSource } from '../services/documents/document-ingest';

function ok<T>(data: T): IpcResponse<T> {
  return { success: true, data };
}

function fail<T = unknown>(err: unknown): IpcResponse<T> {
  return { success: false, error: err instanceof Error ? err.message : String(err) };
}

function normalizeMimeType(input: SourceImportFileRequest): string {
  return attachmentMimeType(input.title, input.mimeType);
}

function sourceIdForImport(): string {
  return randomUUID();
}

function decodeBase64(base64: string): Buffer {
  return Buffer.from(base64, 'base64');
}

function applyResolvedSourceContent(input: {
  sourceId: string;
  title?: string;
  content: string;
  mimeType?: string | null;
  processingError?: string | null;
  processingState?: SourceProcessingState;
}): SourceRecord {
  const record = replaceSourceContent({
    sourceId: input.sourceId,
    title: input.title,
    content: input.content,
    mimeType: input.mimeType,
  });
  setSourceProcessingError(input.sourceId, input.processingError ?? null);
  setSourceProcessingState(
    input.sourceId,
    input.processingState ?? (input.processingError ? 'failed' : 'ready'),
  );
  return record;
}

function shouldBuildSemanticProfile(source: SourceRecord): boolean {
  return source.origin === 'user_import' || source.origin === 'web_collected';
}

function scheduleSemanticProfileForRecord(source: SourceRecord, options?: { force?: boolean; delayMs?: number }): void {
  if (!shouldBuildSemanticProfile(source)) return;
  scheduleSourceSemanticProfile(source.id, options);
}

export function registerSourceHandlers(): void {
  ipcMain.handle(
    IPC.SOURCE_LIST,
    (_e, input: SourceListRequest): IpcResponse<SourceRecord[]> => {
      try {
        return ok(listSources(input));
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.YTDLP_STATUS,
    async (): Promise<IpcResponse<YtDlpStatus>> => {
      try {
        return ok(await getYtDlpStatus());
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.YTDLP_INSTALL,
    async (): Promise<IpcResponse<YtDlpInstallResult>> => {
      try {
        return ok(await installYtDlp());
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.FFMPEG_STATUS,
    async (): Promise<IpcResponse<FfmpegStatus>> => {
      try {
        return ok(await getFfmpegStatus());
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.WHISPER_STATUS,
    async (): Promise<IpcResponse<WhisperStatus>> => {
      try {
        return ok(await getWhisperStatus());
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.WHISPER_INSTALL,
    async (): Promise<IpcResponse<WhisperInstallResult>> => {
      try {
        return ok(await installWhisper());
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.SOURCE_LINK_CANDIDATES,
    (_e, input: SourceLinkCandidatesRequest): IpcResponse<SourceRecord[]> => {
      try {
        return ok(listLinkableMainSources(input));
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.SOURCE_LINK_ADD,
    (_e, input: SourceLinkAddRequest): IpcResponse<SourceRecord[]> => {
      try {
        return ok(linkMainSourcesToNode(input));
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.SOURCE_LINK_UPDATE,
    (_e, input: SourceLinkUpdateRequest): IpcResponse<SourceRecord | null> => {
      try {
        return ok(updateMainSourceLinkForNode(input));
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.SOURCE_LINK_REMOVE,
    (_e, input: SourceLinkRemoveRequest): IpcResponse<void> => {
      try {
        unlinkMainSourceFromNode(input);
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.SOURCE_IMPORT_URL,
    async (_e, input: SourceImportUrlRequest): Promise<IpcResponse<SourceRecord>> => {
      try {
        const outcome = await ingestUrlSource({ ...input, renderFallback: true });
        scheduleSemanticProfileForRecord(outcome.record, { delayMs: 300 });
        return ok(outcome.record);
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.SOURCE_IMPORT_TEXT,
    (_e, input: SourceImportTextRequest): IpcResponse<SourceRecord> => {
      try {
        const record = importTextSource(input);
        setSourceProcessingError(record.id, input.processingError ?? null);
        setSourceProcessingState(record.id, input.processingState ?? (input.processingError ? 'failed' : 'ready'));
        scheduleSemanticProfileForRecord(record, { delayMs: 300 });
        return ok(record);
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.SOURCE_RESOLVE,
    (_e, input: {
      sourceId: string;
      title?: string;
      content: string;
      mimeType?: string | null;
      processingError?: string | null;
      processingState?: SourceProcessingState;
    }): IpcResponse<SourceRecord> => {
      try {
        const record = applyResolvedSourceContent(input);
        scheduleSemanticProfileForRecord(record, { force: true, delayMs: 300 });
        return ok(record);
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.SOURCE_IMPORT_FILE,
    async (_e, input: SourceImportFileRequest): Promise<IpcResponse<SourceRecord>> => {
      try {
        const mimeType = normalizeMimeType(input);
        const buffer = input.base64 ? decodeBase64(input.base64) : undefined;
        if (!input.filePath && !buffer) throw new Error('文件内容为空，无法导入。');
        const sourceId = sourceIdForImport();

        const record = await ingestUploadSource({
          id: sourceId,
          courseId: input.courseId,
          nodeId: input.nodeId,
          threadId: input.threadId,
          sessionId: input.sessionId,
          scope: input.scope,
          usage: input.usage,
          origin: input.origin,
          title: input.title,
          remark: input.remark,
          originalPath: input.originalPath,
          filePath: input.filePath,
          buffer,
          mimeType,
        });
        scheduleSemanticProfileForRecord(record, { delayMs: 500 });
        return ok(record);
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.SOURCE_UPDATE,
    (_e, id: string, data: {
      enabled?: boolean;
      title?: string;
      remark?: string | null;
      scope?: SourceRecord['scope'];
      usage?: SourceRecord['usage'];
    }): IpcResponse<SourceRecord> => {
      try {
        const record = updateSource(id, data);
        if (data.title !== undefined || data.remark !== undefined) {
          scheduleSemanticProfileForRecord(record, { force: true, delayMs: 200 });
        }
        return ok(record);
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.SOURCE_DELETE,
    (_e, id: string): IpcResponse<void> => {
      try {
        deleteSource(id);
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.SOURCE_SEARCH,
    async (_e, input: SourceSearchRequest): Promise<IpcResponse<SourceSearchResult[]>> => {
      try {
        const result = await hybridRetrieve({
          courseId: input.courseId,
          nodeId: input.nodeId,
          query: input.query,
          limit: input.limit ?? 8,
          agentType: input.agentType,
          scope: input.scope,
        });
        const sourceMap = new Map(result.sources.map((source) => [source.id, source]));
        const grouped = new Map<string, SourceSearchResult>();
        for (const chunk of result.candidates) {
          const source = sourceMap.get(chunk.sourceId);
          if (!source) continue;
          if (!grouped.has(source.id)) grouped.set(source.id, { source, chunks: [] });
          grouped.get(source.id)!.chunks.push(chunk);
        }
        return ok([...grouped.values()]);
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.SOURCE_STATS,
    (_e, input: SourceStatsRequest): IpcResponse<SourceLibraryStats> => {
      try {
        return ok(getSourceLibraryStats(input));
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.SOURCE_EXERCISES,
    (_e, input: SourceExerciseListRequest): IpcResponse<SourceExercise[]> => {
      try {
        return ok(listSourceExercises(input));
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.SOURCE_EXERCISE_REEXTRACT,
    (_e, input: SourceExerciseReextractRequest): IpcResponse<SourceExerciseExtractionResult> => {
      try {
        return ok(extractExercisesForSource({ sourceId: input.sourceId, force: input.force }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.SOURCE_EXERCISE_UPDATE,
    (_e, input: SourceExerciseUpdateRequest): IpcResponse<SourceExercise | null> => {
      try {
        if (!input.status) return ok(null);
        return ok(updateSourceExerciseStatus({ exerciseId: input.exerciseId, status: input.status }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.SOURCE_REINDEX,
    async (_e, input: SourceReindexRequest): Promise<IpcResponse<void>> => {
      try {
        const handledByDocumentPipeline = await reprocessDocumentSource(input.sourceId, input.force);
        if (!handledByDocumentPipeline) await reindexSource(input.sourceId, input.force);
        const source = getSourceById(input.sourceId);
        if (source) scheduleSemanticProfileForRecord(source, { force: true, delayMs: 500 });
        return ok(undefined);
      } catch (err) {
        return fail(err);
      }
    },
  );

  ipcMain.handle(
    IPC.SOURCE_SEMANTIC_PROFILE_REBUILD,
    async (_e, input: { sourceId: string; force?: boolean }): Promise<IpcResponse<SourceRecord | null>> => {
      try {
        await rebuildSourceSemanticProfile(input.sourceId, { force: input.force ?? true });
        return ok(getSourceById(input.sourceId));
      } catch (err) {
        return fail(err);
      }
    },
  );

}
