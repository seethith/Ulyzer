export const ATTACHMENT_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'] as const;
export const ATTACHMENT_NATIVE_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'] as const;
export const ATTACHMENT_PDF_EXTS = ['.pdf'] as const;
export const ATTACHMENT_DOCX_EXTS = ['.docx'] as const;
export const ATTACHMENT_PPTX_EXTS = ['.pptx'] as const;
export const ATTACHMENT_XLSX_EXTS = ['.xlsx'] as const;
export const ATTACHMENT_RTF_EXTS = ['.rtf'] as const;
export const ATTACHMENT_EPUB_EXTS = ['.epub'] as const;
export const ATTACHMENT_ODT_EXTS = ['.odt'] as const;
export const ATTACHMENT_ODS_EXTS = ['.ods'] as const;
export const ATTACHMENT_ODP_EXTS = ['.odp'] as const;
export const ATTACHMENT_OPML_EXTS = ['.opml'] as const;
export const ATTACHMENT_MM_EXTS = ['.mm'] as const;
export const ATTACHMENT_XMIND_EXTS = ['.xmind'] as const;
export const ATTACHMENT_AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.ogg', '.aac', '.flac'] as const;
export const ATTACHMENT_VIDEO_EXTS = ['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv'] as const;
export const ATTACHMENT_TEXT_EXTS = [
  '.txt', '.md', '.markdown',
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx',
  '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.cs',
  '.go', '.rs', '.swift', '.kt', '.rb', '.php',
  '.html', '.htm', '.css', '.scss', '.sass',
  '.json', '.yaml', '.yml', '.toml', '.xml',
  '.svg',
  '.csv', '.tsv', '.sql', '.log',
  '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.vue', '.svelte',
] as const;

export const ATTACHMENT_UNSUPPORTED_BINARY_EXTS = [
  '.doc',
  '.xls', '.ppt',
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2',
  '.exe', '.dmg', '.pkg', '.deb', '.apk',
  '.ttf', '.otf', '.woff', '.woff2',
  '.ico', '.tiff', '.psd', '.ai',
  '.mmap', '.mindnode',
] as const;

export const ATTACHMENT_SUPPORTED_EXTS = [
  ...ATTACHMENT_IMAGE_EXTS,
  ...ATTACHMENT_PDF_EXTS,
  ...ATTACHMENT_DOCX_EXTS,
  ...ATTACHMENT_PPTX_EXTS,
  ...ATTACHMENT_XLSX_EXTS,
  ...ATTACHMENT_RTF_EXTS,
  ...ATTACHMENT_EPUB_EXTS,
  ...ATTACHMENT_ODT_EXTS,
  ...ATTACHMENT_ODS_EXTS,
  ...ATTACHMENT_ODP_EXTS,
  ...ATTACHMENT_OPML_EXTS,
  ...ATTACHMENT_MM_EXTS,
  ...ATTACHMENT_XMIND_EXTS,
  ...ATTACHMENT_AUDIO_EXTS,
  ...ATTACHMENT_VIDEO_EXTS,
  ...ATTACHMENT_TEXT_EXTS,
] as const;

export const CHAT_ATTACHMENT_ACCEPT = ATTACHMENT_SUPPORTED_EXTS.join(',');
export const SOURCE_LIBRARY_FILE_ACCEPT = ATTACHMENT_SUPPORTED_EXTS.join(',');

const imageExtSet = new Set<string>(ATTACHMENT_IMAGE_EXTS);
const nativeImageExtSet = new Set<string>(ATTACHMENT_NATIVE_IMAGE_EXTS);
const pdfExtSet = new Set<string>(ATTACHMENT_PDF_EXTS);
const docxExtSet = new Set<string>(ATTACHMENT_DOCX_EXTS);
const pptxExtSet = new Set<string>(ATTACHMENT_PPTX_EXTS);
const xlsxExtSet = new Set<string>(ATTACHMENT_XLSX_EXTS);
const rtfExtSet = new Set<string>(ATTACHMENT_RTF_EXTS);
const epubExtSet = new Set<string>(ATTACHMENT_EPUB_EXTS);
const odtExtSet = new Set<string>(ATTACHMENT_ODT_EXTS);
const odsExtSet = new Set<string>(ATTACHMENT_ODS_EXTS);
const odpExtSet = new Set<string>(ATTACHMENT_ODP_EXTS);
const opmlExtSet = new Set<string>(ATTACHMENT_OPML_EXTS);
const mmExtSet = new Set<string>(ATTACHMENT_MM_EXTS);
const xmindExtSet = new Set<string>(ATTACHMENT_XMIND_EXTS);
const audioExtSet = new Set<string>(ATTACHMENT_AUDIO_EXTS);
const videoExtSet = new Set<string>(ATTACHMENT_VIDEO_EXTS);
const textExtSet = new Set<string>(ATTACHMENT_TEXT_EXTS);
const unsupportedBinaryExtSet = new Set<string>(ATTACHMENT_UNSUPPORTED_BINARY_EXTS);

export function attachmentExt(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

export function isAttachmentImageExt(ext: string): boolean {
  return imageExtSet.has(ext);
}

export function isNativeImageAttachmentExt(ext: string): boolean {
  return nativeImageExtSet.has(ext);
}

export function isAttachmentPdfExt(ext: string): boolean {
  return pdfExtSet.has(ext);
}

export function isAttachmentDocxExt(ext: string): boolean {
  return docxExtSet.has(ext);
}

export function isAttachmentPptxExt(ext: string): boolean {
  return pptxExtSet.has(ext);
}

export function isAttachmentXlsxExt(ext: string): boolean {
  return xlsxExtSet.has(ext);
}

export function isAttachmentRtfExt(ext: string): boolean {
  return rtfExtSet.has(ext);
}

export function isAttachmentEpubExt(ext: string): boolean {
  return epubExtSet.has(ext);
}

export function isAttachmentOdtExt(ext: string): boolean {
  return odtExtSet.has(ext);
}

export function isAttachmentOdsExt(ext: string): boolean {
  return odsExtSet.has(ext);
}

export function isAttachmentOdpExt(ext: string): boolean {
  return odpExtSet.has(ext);
}

export function isAttachmentOpmlExt(ext: string): boolean {
  return opmlExtSet.has(ext);
}

export function isAttachmentMmExt(ext: string): boolean {
  return mmExtSet.has(ext);
}

export function isAttachmentXmindExt(ext: string): boolean {
  return xmindExtSet.has(ext);
}

export function isAttachmentAudioExt(ext: string): boolean {
  return audioExtSet.has(ext);
}

export function isAttachmentVideoExt(ext: string): boolean {
  return videoExtSet.has(ext);
}

export function isAttachmentTextExt(ext: string): boolean {
  return textExtSet.has(ext);
}

export function isKnownUnsupportedAttachmentExt(ext: string): boolean {
  return unsupportedBinaryExtSet.has(ext);
}

export function isBinaryAttachmentExt(ext: string): boolean {
  return isAttachmentImageExt(ext) ||
    isAttachmentPdfExt(ext) ||
    isAttachmentDocxExt(ext) ||
    isAttachmentPptxExt(ext) ||
    isAttachmentXlsxExt(ext) ||
    isAttachmentRtfExt(ext) ||
    isAttachmentEpubExt(ext) ||
    isAttachmentOdtExt(ext) ||
    isAttachmentOdsExt(ext) ||
    isAttachmentOdpExt(ext) ||
    isAttachmentXmindExt(ext) ||
    isAttachmentAudioExt(ext) ||
    isAttachmentVideoExt(ext);
}

export function attachmentMimeType(name: string, fallback?: string | null): string {
  if (fallback) return fallback;
  const ext = attachmentExt(name);
  if (isAttachmentPdfExt(ext)) return 'application/pdf';
  if (isAttachmentDocxExt(ext)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (isAttachmentPptxExt(ext)) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (isAttachmentXlsxExt(ext)) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (isAttachmentRtfExt(ext)) return 'application/rtf';
  if (isAttachmentEpubExt(ext)) return 'application/epub+zip';
  if (isAttachmentOdtExt(ext)) return 'application/vnd.oasis.opendocument.text';
  if (isAttachmentOdsExt(ext)) return 'application/vnd.oasis.opendocument.spreadsheet';
  if (isAttachmentOdpExt(ext)) return 'application/vnd.oasis.opendocument.presentation';
  if (isAttachmentOpmlExt(ext)) return 'text/x-opml';
  if (isAttachmentMmExt(ext)) return 'application/x-freemind';
  if (isAttachmentXmindExt(ext)) return 'application/vnd.xmind.workbook';
  if (isAttachmentAudioExt(ext)) return `audio/${ext.slice(1) || '*'}`;
  if (isAttachmentVideoExt(ext)) return `video/${ext.slice(1) || '*'}`;
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (isAttachmentImageExt(ext)) return `image/${ext.slice(1) || '*'}`;
  if (ext === '.csv') return 'text/csv';
  if (ext === '.tsv') return 'text/tab-separated-values';
  if (isAttachmentTextExt(ext)) return 'text/plain';
  return 'application/octet-stream';
}
