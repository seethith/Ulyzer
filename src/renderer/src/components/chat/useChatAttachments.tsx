import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import {
  attachmentExt,
  attachmentMimeType,
  ATTACHMENT_SUPPORTED_EXTS,
  CHAT_ATTACHMENT_ACCEPT,
  isAttachmentAudioExt,
  isAttachmentDocxExt,
  isAttachmentEpubExt,
  isAttachmentImageExt,
  isAttachmentMmExt,
  isAttachmentOdpExt,
  isAttachmentOdsExt,
  isAttachmentOdtExt,
  isAttachmentOpmlExt,
  isAttachmentPdfExt,
  isAttachmentPptxExt,
  isAttachmentRtfExt,
  isAttachmentTextExt,
  isAttachmentVideoExt,
  isAttachmentXmindExt,
  isAttachmentXlsxExt,
  isBinaryAttachmentExt,
  isNativeImageAttachmentExt,
} from '@shared/attachment-formats';
import type {
  AgentType,
  ChatAttachmentPrepareRequest,
  ChatAttachmentStatus,
  FileAttachment,
  IpcResponse,
  ModelCapabilityInfo,
  PickedLocalFile,
} from '@shared/types';
import { IPC } from '@shared/ipc-channels';

interface UseChatAttachmentsInput {
  agentType: AgentType;
  courseId: string;
  nodeId?: string;
  threadId?: string | null;
  attachmentCapability?: ModelCapabilityInfo | null;
  initialAttachments?: FileAttachment[];
  deleteSourceOnRemove?: boolean;
}

const attachmentSpinStyle = '@keyframes ulyzerAttachmentSpin { to { transform: rotate(360deg); } }';

async function compressImage(file: File): Promise<{ base64: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const maxDim = 1568;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('canvas unavailable'));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        const keepPng = file.name.toLowerCase().endsWith('.png') || file.name.toLowerCase().endsWith('.gif');
        const mimeType = keepPng ? 'image/png' : 'image/jpeg';
        const dataUrl = canvas.toDataURL(mimeType, 0.85);
        resolve({ base64: base64FromDataUrl(dataUrl), mimeType });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image load failed'));
    };
    img.src = url;
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.readAsText(file, 'utf-8');
  });
}

export function isExtSupported(ext: string, capability?: ModelCapabilityInfo | null): boolean {
  if (isAttachmentTextExt(ext)) return true;
  if (!capability) return (ATTACHMENT_SUPPORTED_EXTS as readonly string[]).includes(ext);
  const strategies = capability.attachmentStrategies;
  if (isAttachmentImageExt(ext)) return strategies.image !== 'unsupported';
  if (isAttachmentPdfExt(ext)) return strategies.pdf !== 'unsupported';
  if (isAttachmentDocxExt(ext)) return strategies.docx !== 'unsupported';
  if (isAttachmentPptxExt(ext)) return strategies.pptx !== 'unsupported';
  if (isAttachmentXlsxExt(ext)) return strategies.xlsx !== 'unsupported';
  if (isAttachmentRtfExt(ext)) return strategies.rtf !== 'unsupported';
  if (isAttachmentEpubExt(ext)) return strategies.epub !== 'unsupported';
  if (isAttachmentOdtExt(ext)) return strategies.odt !== 'unsupported';
  if (isAttachmentOdsExt(ext)) return strategies.ods !== 'unsupported';
  if (isAttachmentOdpExt(ext)) return strategies.odp !== 'unsupported';
  if (isAttachmentOpmlExt(ext)) return strategies.opml !== 'unsupported';
  if (isAttachmentMmExt(ext)) return strategies.mm !== 'unsupported';
  if (isAttachmentXmindExt(ext)) return strategies.xmind !== 'unsupported';
  if (isAttachmentAudioExt(ext)) return strategies.audio !== 'unsupported';
  if (isAttachmentVideoExt(ext)) return strategies.video !== 'unsupported';
  return false;
}

export function acceptedExts(capability?: ModelCapabilityInfo | null): string {
  if (!capability) return CHAT_ATTACHMENT_ACCEPT;
  return ATTACHMENT_SUPPORTED_EXTS.filter((ext) => isExtSupported(ext, capability)).join(',');
}

function mimeTypeForBinary(file: File, ext: string): string {
  void ext;
  return attachmentMimeType(file.name, file.type);
}

function base64FromDataUrl(value: string): string {
  return value.includes(',') ? value.split(',')[1] : value;
}

async function imageFileToAttachment(file: File, ext: string, id = crypto.randomUUID()): Promise<FileAttachment> {
  try {
    const compressed = await compressImage(file);
    return {
      id,
      name: file.name,
      mimeType: compressed.mimeType,
      size: file.size,
      base64: compressed.base64,
    };
  } catch {
    const dataUrl = await readFileAsDataUrl(file);
    return {
      id,
      name: file.name,
      mimeType: mimeTypeForBinary(file, ext),
      size: file.size,
      base64: base64FromDataUrl(dataUrl),
    };
  }
}

async function fileToAttachment(file: File, ext: string, id = crypto.randomUUID()): Promise<FileAttachment> {
  if (isAttachmentImageExt(ext)) return imageFileToAttachment(file, ext, id);
  if (isBinaryAttachmentExt(ext)) {
    const dataUrl = await readFileAsDataUrl(file);
    return {
      id,
      name: file.name,
      mimeType: mimeTypeForBinary(file, ext),
      size: file.size,
      base64: base64FromDataUrl(dataUrl),
    };
  }
  const content = await readFileAsText(file);
  return {
    id,
    name: file.name,
    mimeType: file.type || attachmentMimeType(file.name),
    size: file.size,
    content,
  };
}

export function isAttachmentBusy(status?: ChatAttachmentStatus): boolean {
  return status === 'queued'
    || status === 'uploading'
    || status === 'processing'
    || status === 'ocr'
    || status === 'partial';
}

export function statusColor(status: ChatAttachmentStatus): string {
  if (status === 'ready') return '#15803d';
  if (status === 'failed') return '#b91c1c';
  return 'var(--accent)';
}

function progressLabel(att: FileAttachment, label: string): string {
  if (att.progressTotal && att.progressTotal > 0) {
    return `${label} ${att.progressCurrent ?? 0}/${att.progressTotal}`;
  }
  return label;
}

export function attachmentStatusText(att: FileAttachment): string {
  if (att.message) return att.message;
  switch (att.status ?? 'ready') {
    case 'queued': return i18n.t('attachments.queued');
    case 'uploading': return i18n.t('attachments.uploading');
    case 'processing': return i18n.t('attachments.parsing');
    case 'ocr': return progressLabel(att, i18n.t('attachments.ocr'));
    case 'partial': return progressLabel(att, i18n.t('attachments.parsing'));
    case 'failed': return i18n.t('attachments.failed');
    case 'ready': return i18n.t('attachments.ready');
  }
}

export function AttachmentStatusIcon({ status }: { status: ChatAttachmentStatus }) {
  if (status === 'ready') return <CheckCircle2 size={12} color="#15803d" />;
  if (status === 'failed') return <AlertTriangle size={12} color="#b91c1c" />;
  return (
    <span style={{
      width: 12,
      height: 12,
      border: '2px solid var(--accent-b)',
      borderTopColor: 'var(--accent)',
      borderRadius: '50%',
      animation: 'ulyzerAttachmentSpin 0.8s linear infinite',
      flexShrink: 0,
    }} />
  );
}

export function AttachmentSpinStyle() {
  return <style>{attachmentSpinStyle}</style>;
}

export function sanitizeAttachmentsForMessage(attachments: FileAttachment[]): FileAttachment[] {
  return attachments.map((att) => ({
    id: att.id,
    name: att.name,
    mimeType: att.mimeType || 'application/octet-stream',
    size: Number.isFinite(att.size) ? att.size : 0,
    sourceId: att.sourceId,
    status: att.status,
    progressCurrent: att.progressCurrent,
    progressTotal: att.progressTotal,
    message: att.message,
    processingError: att.processingError ?? null,
  }));
}

export function useChatAttachments(input: UseChatAttachmentsInput) {
  const { t } = useTranslation();
  const [attachments, setAttachments] = useState<FileAttachment[]>(input.initialAttachments ?? []);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialSignatureRef = useRef('');
  const removedAttachmentIdsRef = useRef(new Set<string>());

  const fileAccept = useMemo(() => acceptedExts(input.attachmentCapability), [input.attachmentCapability]);

  const showError = useCallback((msg: string) => {
    setUploadError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setUploadError(null), 5000);
  }, []);

  useEffect(() => {
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const nextSignature = (input.initialAttachments ?? [])
      .map((att) => `${att.id}:${att.sourceId ?? ''}:${att.status ?? ''}`)
      .join('|');
    if (nextSignature === initialSignatureRef.current) return;
    initialSignatureRef.current = nextSignature;
    setAttachments(input.initialAttachments ?? []);
  }, [input.initialAttachments]);

  const updateAttachment = useCallback((id: string, patch: Partial<FileAttachment>) => {
    setAttachments((prev) => prev.map((att) => (att.id === id ? { ...att, ...patch } : att)));
  }, []);

  const prepareAttachment = useCallback(async (raw: FileAttachment) => {
    if (!input.courseId) {
      updateAttachment(raw.id, {
        status: 'failed',
        message: i18n.t('attachments.select_course_first'),
        processingError: i18n.t('attachments.select_course_first'),
      });
      return;
    }
    updateAttachment(raw.id, { ...raw, status: 'processing', message: i18n.t('attachments.parsing_attachment') });
    const request: ChatAttachmentPrepareRequest = {
      attachmentId: raw.id,
      courseId: input.courseId,
      nodeId: input.nodeId,
      threadId: input.threadId ?? undefined,
      agentType: input.agentType,
      name: raw.name,
      mimeType: raw.mimeType,
      size: raw.size,
      filePath: raw.path,
      originalPath: raw.path,
      content: raw.content,
      base64: raw.base64,
    };
    try {
      const res = await window.api.invoke(IPC.CHAT_ATTACHMENT_PREPARE, request) as IpcResponse<FileAttachment>;
      if (!res.success || !res.data) {
        if (removedAttachmentIdsRef.current.has(raw.id)) {
          removedAttachmentIdsRef.current.delete(raw.id);
          return;
        }
        updateAttachment(raw.id, {
          status: 'failed',
          message: res.error ?? i18n.t('attachments.parse_failed'),
          processingError: res.error ?? i18n.t('attachments.parse_failed'),
        });
        return;
      }
      if (removedAttachmentIdsRef.current.has(raw.id)) {
        removedAttachmentIdsRef.current.delete(raw.id);
        if (res.data.sourceId) {
          window.api.invoke(IPC.CHAT_ATTACHMENT_REMOVE, { attachmentId: res.data.id, sourceId: res.data.sourceId }).catch(() => {});
        }
        return;
      }
      updateAttachment(raw.id, {
        ...res.data,
        content: undefined,
        base64: undefined,
        path: undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateAttachment(raw.id, { status: 'failed', message, processingError: message });
    }
  }, [input.agentType, input.courseId, input.nodeId, input.threadId, updateAttachment]);

  useEffect(() => {
    const pending = attachments.filter((att) =>
      att.sourceId && att.status && att.status !== 'ready' && att.status !== 'failed');
    if (pending.length === 0) return;
    const timer = window.setInterval(() => {
      for (const att of pending) {
        if (!att.sourceId) continue;
        window.api
          .invoke(IPC.CHAT_ATTACHMENT_STATUS, { attachmentId: att.id, sourceId: att.sourceId })
          .then((res) => {
            const response = res as IpcResponse<FileAttachment>;
            if (response.success && response.data) updateAttachment(att.id, response.data);
          })
          .catch(() => {});
      }
    }, 1600);
    return () => window.clearInterval(timer);
  }, [attachments, updateAttachment]);

  const processFiles = useCallback(async (files: File[]) => {
    const invalid: string[] = [];
    const failed: string[] = [];

    for (const file of files) {
      const ext = attachmentExt(file.name);
      if (!isExtSupported(ext, input.attachmentCapability)) {
        invalid.push(file.name);
        continue;
      }
      const id = crypto.randomUUID();
      const localPath = window.api.getPathForFile?.(file) || (file as File & { path?: string }).path;
      setAttachments((prev) => [...prev, {
        id,
        name: file.name,
        mimeType: attachmentMimeType(file.name, file.type),
        size: file.size,
        status: 'uploading',
        message: localPath ? i18n.t('attachments.importing_file') : i18n.t('attachments.reading_file'),
      }]);
      if (localPath) {
        void prepareAttachment({
          id,
          name: file.name,
          mimeType: attachmentMimeType(file.name, file.type),
          size: file.size,
          path: localPath,
        });
      } else {
        fileToAttachment(file, ext, id)
          .then((raw) => prepareAttachment(raw))
          .catch(() => {
            failed.push(file.name);
            updateAttachment(id, {
              status: 'failed',
              message: i18n.t('attachments.read_failed'),
              processingError: i18n.t('attachments.read_failed'),
            });
          });
      }
    }

    if (invalid.length > 0) {
      showError(t('chat_input.unsupported_format', { name: invalid.join('、') }));
    }
    if (failed.length > 0) {
      showError(t('chat_input.upload_failed', { name: failed.join('、') }));
    }
  }, [input.attachmentCapability, prepareAttachment, showError, t, updateAttachment]);

  const processPickedFiles = useCallback((files: PickedLocalFile[]) => {
    const invalid: string[] = [];
    for (const file of files) {
      const ext = attachmentExt(file.name);
      if (!isExtSupported(ext, input.attachmentCapability)) {
        invalid.push(file.name);
        continue;
      }
      const id = crypto.randomUUID();
      setAttachments((prev) => [...prev, {
        id,
        name: file.name,
        mimeType: attachmentMimeType(file.name, file.mimeType),
        size: file.size,
        path: file.path,
        status: 'uploading',
        message: i18n.t('attachments.importing_file'),
      }]);
      void prepareAttachment({
        id,
        name: file.name,
        mimeType: attachmentMimeType(file.name, file.mimeType),
        size: file.size,
        path: file.path,
      });
    }
    if (invalid.length > 0) {
      showError(t('chat_input.unsupported_format', { name: invalid.join('、') }));
    }
  }, [input.attachmentCapability, prepareAttachment, showError, t]);

  const pickLocalFiles = useCallback(async (disabled?: boolean) => {
    if (disabled) return;
    const res = await window.api.invoke(IPC.FS_PICK_FILES, {
      accept: fileAccept,
      multiple: true,
      title: i18n.t('attachments.pick_title'),
    }) as IpcResponse<PickedLocalFile[]>;
    if (!res.success) {
      showError(res.error ?? i18n.t('attachments.pick_failed'));
      return;
    }
    processPickedFiles(res.data ?? []);
  }, [fileAccept, processPickedFiles, showError]);

  const processInternalDrop = useCallback(async (raw: string) => {
    let info: { path: string; name: string };
    try {
      info = JSON.parse(raw) as { path: string; name: string };
    } catch {
      return;
    }

    const ext = attachmentExt(info.name);
    if (!isExtSupported(ext, input.attachmentCapability)) {
      showError(t('chat_input.unsupported_format', { name: info.name }));
      return;
    }
    const id = crypto.randomUUID();
    setAttachments((prev) => [...prev, {
      id,
      name: info.name,
      mimeType: attachmentMimeType(info.name),
      size: 0,
      status: 'uploading',
      message: i18n.t('attachments.importing_file'),
    }]);
    await prepareAttachment({
      id,
      name: info.name,
      mimeType: attachmentMimeType(info.name),
      size: 0,
      path: info.path,
    });
  }, [input.attachmentCapability, prepareAttachment, showError, t]);

  const removeAttachment = useCallback((id: string, deleteSource = input.deleteSourceOnRemove ?? true) => {
    const current = attachments.find((att) => att.id === id);
    setAttachments((prev) => prev.filter((att) => att.id !== id));
    if (deleteSource && current?.sourceId) {
      window.api.invoke(IPC.CHAT_ATTACHMENT_REMOVE, { attachmentId: current.id, sourceId: current.sourceId }).catch(() => {});
    } else if (deleteSource) {
      removedAttachmentIdsRef.current.add(id);
    }
  }, [attachments, input.deleteSourceOnRemove]);

  const clearAttachments = useCallback((deleteSources = false) => {
    if (deleteSources) {
      for (const att of attachments) {
        if (att.sourceId) {
          window.api.invoke(IPC.CHAT_ATTACHMENT_REMOVE, { attachmentId: att.id, sourceId: att.sourceId }).catch(() => {});
        } else {
          removedAttachmentIdsRef.current.add(att.id);
        }
      }
    }
    setAttachments([]);
  }, [attachments]);

  const attachmentsReady = attachments.every((att) => (att.status ?? 'ready') === 'ready');

  const attachmentInfo = useMemo(() => {
    if (attachments.length === 0) return null;
    if (attachments.some((att) => isAttachmentBusy(att.status))) return i18n.t('attachments.busy_wait');
    if (attachments.some((att) => att.status === 'failed')) return i18n.t('attachments.has_failed');
    const imageExts = attachments.map((att) => attachmentExt(att.name)).filter((ext) => isAttachmentImageExt(ext));
    const hasImage = imageExts.length > 0;
    const hasOnlyNativeImages = hasImage && imageExts.every((ext) => isNativeImageAttachmentExt(ext));
    const hasDoc = attachments.some((att) => {
      const ext = attachmentExt(att.name);
      return isAttachmentPdfExt(ext)
        || isAttachmentDocxExt(ext)
        || isAttachmentPptxExt(ext)
        || isAttachmentXlsxExt(ext)
        || isAttachmentRtfExt(ext)
        || isAttachmentEpubExt(ext)
        || isAttachmentOdtExt(ext)
        || isAttachmentOdsExt(ext)
        || isAttachmentOdpExt(ext)
        || isAttachmentOpmlExt(ext)
        || isAttachmentMmExt(ext)
        || isAttachmentXmindExt(ext);
    });
    const hasMedia = attachments.some((att) => isAttachmentAudioExt(attachmentExt(att.name)) || isAttachmentVideoExt(attachmentExt(att.name)));
    if (hasOnlyNativeImages && input.attachmentCapability?.attachmentStrategies.image === 'native') {
      return t('chat_input.attachment_hint_image_native');
    }
    if (hasImage) return t('chat_input.attachment_hint_image_ocr');
    if (hasMedia) return t('chat_input.attachment_hint_media');
    if (hasDoc) return t('chat_input.attachment_hint_document');
    return t('chat_input.attachment_hint_text');
  }, [attachments, input.attachmentCapability, t]);

  return {
    attachments,
    setAttachments,
    attachmentsReady,
    attachmentInfo,
    uploadError,
    processFiles,
    pickLocalFiles,
    processInternalDrop,
    removeAttachment,
    clearAttachments,
  };
}
