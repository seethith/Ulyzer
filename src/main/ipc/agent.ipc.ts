import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as nodePath from 'path';
import { IPC } from '@shared/ipc-channels';
import type { LLMProvider, AgentPlanRequest, AgentChatRequest, AgentClarifyRequest, ClarifyResult, IpcResponse, FileAttachment, OutlineStatusRequest, OutlineGenerateNextRequest, KcCoverageStatus, TopicGenerateRequest } from '@shared/types';
import type { ImageAttachment, PdfAttachment } from '../services/llm/adapter';
import { AgentOrchestrator } from '../services/agent/orchestrator';
import { analyzeIntent } from '../services/agent/intent-clarifier';
import { registerAbort, unregisterAbort, abortSession } from '../services/abort-registry';
import { NodeRepository } from '../services/db/repositories/node.repo';
import { checkKcCoverage, generateNextOutlineVersion, getOutlineVersionNumber, MAX_OUTLINE_VERSION } from '../services/agent/outline-version';
import { generateOutlineV1 } from '../services/agent/sub-tutor-loop';
import { generateTopicOutline } from '../services/agent/topic-generator';
import { indexFile } from '../services/rag/indexer';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

// Formats that are silently skipped (not image, not text, not PDF-for-Claude)
const SKIP_EXTS = new Set([
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2',
  '.exe', '.dmg', '.pkg', '.deb', '.apk',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac', '.ogg',
  '.ttf', '.otf', '.woff', '.woff2',
  '.ico', '.bmp', '.tiff', '.psd', '.ai',
  '.xmind', '.mm', '.mmap', '.mindnode', '.opml',
]);

// Max base64 size for a single image (~4MB of base64 ≈ 3MB raw ≈ a reasonably large image)
const MAX_IMAGE_BASE64_BYTES = 4 * 1024 * 1024;

/** Models that support vision (image input). */
function supportsVision(provider: LLMProvider, model: string): boolean {
  if (provider === 'anthropic') return true;
  if (provider === 'openai') return model.startsWith('gpt-4o');
  if (provider === 'gemini') return true;
  if (provider === 'grok') return model === 'grok-3' || model.startsWith('grok');
  if (provider === 'minimax') return true;
  if (provider === 'openrouter') return true; // varies by routed model; allow and let API reject
  return false; // deepseek, qwen, ollama: no vision by default
}

function processAttachments(
  attachments: FileAttachment[],
  baseMessage: string,
  provider: LLMProvider,
  model: string,
  nodeId?: string,
  courseId?: string,
): { userMessage: string; imageAttachments: ImageAttachment[]; pdfAttachments: PdfAttachment[] } {
  let userMessage = baseMessage;
  const imageAttachments: ImageAttachment[] = [];
  const pdfAttachments: PdfAttachment[] = [];
  const visionOk = supportsVision(provider, model);
  const skippedImages: string[] = [];

  for (const att of attachments) {
    const ext = nodePath.extname(att.name).toLowerCase();

    if (IMAGE_EXTS.has(ext)) {
      if (!visionOk) {
        skippedImages.push(att.name);
        continue;
      }
      // Prefer pre-read base64, fall back to reading from path
      let b64 = att.base64 ?? null;
      if (!b64 && att.path) {
        try { b64 = fs.readFileSync(att.path).toString('base64'); } catch { /* skip */ }
      }
      if (!b64) continue;
      // Skip oversized images to prevent huge requests
      if (b64.length > MAX_IMAGE_BASE64_BYTES) {
        userMessage += `\n\n[图片 ${att.name} 体积过大已跳过，请压缩后重新上传]`;
        continue;
      }
      const mediaType = att.mimeType || `image/${ext.slice(1) === 'jpg' ? 'jpeg' : ext.slice(1)}`;
      imageAttachments.push({ mediaType, base64: b64, name: att.name });

    } else if (ext === '.pdf') {
      if (provider === 'anthropic') {
        // Claude supports PDF as document block
        let b64 = att.base64 ?? null;
        if (!b64 && att.path) {
          try { b64 = fs.readFileSync(att.path).toString('base64'); } catch { /* skip */ }
        }
        if (b64) pdfAttachments.push({ name: att.name, base64: b64 });
      } else {
        userMessage += `\n\n[PDF 附件 ${att.name} 在当前模型中不支持，请切换到 Claude 使用 PDF 功能]`;
      }

    } else if (!SKIP_EXTS.has(ext)) {
      // Text/code: prefer pre-read content, fall back to path
      const textContent = att.content ?? (att.path ? (() => { try { return fs.readFileSync(att.path!, 'utf-8'); } catch { return null; } })() : null);
      if (textContent) {
        const snippet = textContent.slice(0, 20000);
        userMessage += `\n\n[附件: ${att.name}]\n\`\`\`\n${snippet}\n\`\`\``;
        if (nodeId && courseId) {
          try { indexFile(randomUUID(), nodeId, courseId, textContent); } catch { /* non-fatal */ }
        }
      }
    }
    // SKIP_EXTS and unknown binary: skip silently
  }

  if (skippedImages.length > 0) {
    userMessage += `\n\n[注意：已附加图片 ${skippedImages.join('、')}，但当前模型不支持图片识别，图片已忽略]`;
  }

  return { userMessage, imageAttachments, pdfAttachments };
}

const orchestrator  = new AgentOrchestrator();
const nodeRepo      = new NodeRepository();

function safeSend(sender: Electron.WebContents, channel: string, data: unknown): void {
  try {
    if (!sender.isDestroyed()) sender.send(channel, data);
  } catch {
    // window closed
  }
}

export function registerAgentHandlers(): void {
  // ── DAG generation (main tutor: generate_dag) ────────────────────────────────

  ipcMain.handle(
    IPC.AGENT_PLAN,
    (event, req: AgentPlanRequest): IpcResponse<void> => {
      const controller = new AbortController();
      registerAbort(req.sessionId, controller);

      orchestrator
        .dispatch({
          type: 'main_tutor',
          action: 'chat',
          courseId: req.courseId,
          sessionId: req.sessionId,
          provider: req.provider,
          model: req.model,
          userMessage: req.userMessage,
          messages: req.messages,
          senderEvent: event,
          signal: controller.signal,
        })
        .catch((err: unknown) => {
          safeSend(event.sender, IPC.LLM_STREAM_ERROR, {
            sessionId: req.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          unregisterAbort(req.sessionId);
        });

      return { success: true };
    }
  );

  // ── General agent chat ────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.AGENT_CHAT,
    (event, req: AgentChatRequest): IpcResponse<void> => {
      const controller = new AbortController();
      registerAbort(req.sessionId, controller);

      const { userMessage, imageAttachments, pdfAttachments } = req.attachments?.length
        ? processAttachments(req.attachments, req.userMessage, req.provider, req.model, req.nodeId, req.courseId)
        : { userMessage: req.userMessage, imageAttachments: [], pdfAttachments: [] };

      orchestrator
        .dispatch({
          type: req.agentType,
          action: 'chat',
          courseId: req.courseId,
          nodeId: req.nodeId,
          sessionId: req.sessionId,
          provider: req.provider,
          model: req.model,
          userMessage,
          messages: req.messages,
          imageAttachments: imageAttachments.length > 0 ? imageAttachments : undefined,
          pdfAttachments: pdfAttachments.length > 0 ? pdfAttachments : undefined,
          webSearchEnabled: req.webSearchEnabled,
          language: req.language,
          senderEvent: event,
          signal: controller.signal,
        })
        .catch((err: unknown) => {
          safeSend(event.sender, IPC.LLM_STREAM_ERROR, {
            sessionId: req.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          unregisterAbort(req.sessionId);
        });

      return { success: true };
    }
  );


  // ── Intent clarification (fast invoke, never blocks the user) ────────────────

  ipcMain.handle(
    IPC.AGENT_CLARIFY,
    async (_event, req: AgentClarifyRequest): Promise<IpcResponse<ClarifyResult>> => {
      try {
        const result = await analyzeIntent(
          req.userMessage,
          req.messages ?? [],
          req.provider,
          req.model
        );
        return { success: true, data: result };
      } catch {
        // Always succeed — clarification failures must never block the user
        return { success: true, data: { needsClarification: false, questions: [] } };
      }
    }
  );

  // ── Outline: get KC coverage status ──────────────────────────────────────────

  ipcMain.handle(
    IPC.OUTLINE_GET_STATUS,
    async (_event, req: OutlineStatusRequest): Promise<IpcResponse<KcCoverageStatus>> => {
      try {
        const status = checkKcCoverage(req.courseId, req.nodeId);
        return { success: true, data: status };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // ── Outline: generate next version (v1→v2, v2→v3) ────────────────────────────

  ipcMain.handle(
    IPC.OUTLINE_GENERATE_NEXT,
    (event, req: OutlineGenerateNextRequest): IpcResponse<void> => {
      const controller = new AbortController();
      registerAbort(req.sessionId, controller);

      (async () => {
        const node = nodeRepo.findById(req.nodeId);
        if (!node) {
          safeSend(event.sender, IPC.LLM_STREAM_ERROR, {
            sessionId: req.sessionId,
            error: `节点不存在: ${req.nodeId}`,
          });
          return;
        }

        const currentVersion = getOutlineVersionNumber(req.courseId, req.nodeId);

        // Already at max — friendly stop, no generation needed
        if (currentVersion >= MAX_OUTLINE_VERSION) {
          safeSend(event.sender, IPC.LLM_STREAM_START, { sessionId: req.sessionId });
          safeSend(event.sender, IPC.LLM_STREAM_CHUNK, {
            sessionId: req.sessionId,
            chunk: `纲要已是最高版本 v${MAX_OUTLINE_VERSION}，无需继续升级。如需深入某个知识组件，可使用「生成专题」功能。`,
            isProgress: true,
          });
          safeSend(event.sender, IPC.LLM_STREAM_END, { sessionId: req.sessionId, usage: { inputTokens: 0, outputTokens: 0, costCny: 0 } });
          return;
        }

        safeSend(event.sender, IPC.LLM_STREAM_START, { sessionId: req.sessionId });

        const opts = {
          courseId: req.courseId,
          nodeId:   req.nodeId,
          provider: req.provider,
          model:    req.model,
          signal:   controller.signal,
          onProgressChunk: (msg: string) =>
            safeSend(event.sender, IPC.LLM_STREAM_CHUNK, { sessionId: req.sessionId, chunk: msg }),
          onComplete: (usage: { inputTokens: number; outputTokens: number; costCny: number }) => { outlineUsage = usage; },
        };
        let outlineUsage = { inputTokens: 0, outputTokens: 0, costCny: 0 };

        try {
          if (currentVersion === 0) {
            await generateOutlineV1(opts, node);
          } else {
            await generateNextOutlineVersion(opts, node);
          }
          safeSend(event.sender, IPC.LLM_STREAM_END, { sessionId: req.sessionId, usage: outlineUsage });
        } catch (err) {
          safeSend(event.sender, IPC.LLM_STREAM_ERROR, {
            sessionId: req.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })().finally(() => unregisterAbort(req.sessionId));

      return { success: true };
    }
  );

  // ── Topic: generate topic outline for a single KC ────────────────────────────

  ipcMain.handle(
    IPC.TOPIC_GENERATE,
    (event, req: TopicGenerateRequest): IpcResponse<void> => {
      const controller = new AbortController();
      registerAbort(req.sessionId, controller);

      (async () => {
        const node = nodeRepo.findById(req.nodeId);
        if (!node) {
          safeSend(event.sender, IPC.LLM_STREAM_ERROR, {
            sessionId: req.sessionId,
            error: `节点不存在: ${req.nodeId}`,
          });
          return;
        }

        safeSend(event.sender, IPC.LLM_STREAM_START, { sessionId: req.sessionId });

        try {
          let topicUsage = { inputTokens: 0, outputTokens: 0, costCny: 0 };
          await generateTopicOutline(
            {
              courseId: req.courseId,
              nodeId:   req.nodeId,
              kcId:     req.kcId,
              kcName:   req.kcName,
              provider: req.provider,
              model:    req.model,
              signal:   controller.signal,
              onProgressChunk: (msg) =>
                safeSend(event.sender, IPC.LLM_STREAM_CHUNK, { sessionId: req.sessionId, chunk: msg }),
              onComplete: (usage) => { topicUsage = usage; },
            },
            node,
          );
          safeSend(event.sender, IPC.LLM_STREAM_END, { sessionId: req.sessionId, usage: topicUsage });
        } catch (err) {
          safeSend(event.sender, IPC.LLM_STREAM_ERROR, {
            sessionId: req.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })().finally(() => unregisterAbort(req.sessionId));

      return { success: true };
    }
  );

  // ── Abort any stream (agent or direct LLM) ────────────────────────────────────

  ipcMain.handle(
    IPC.LLM_ABORT,
    (_event, sessionId: string): IpcResponse<void> => {
      abortSession(sessionId);
      return { success: true };
    }
  );
}
