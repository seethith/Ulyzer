import type { SourceKind, SourceProcessingState } from '@shared/types';

export type DocumentKind =
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'rtf'
  | 'epub'
  | 'odt'
  | 'ods'
  | 'odp'
  | 'opml'
  | 'mm'
  | 'xmind'
  | 'csv'
  | 'tsv'
  | 'image'
  | 'html'
  | 'markdown'
  | 'text'
  | 'unknown';

export type DocumentUnitKind =
  | 'page'
  | 'slide'
  | 'sheet'
  | 'section'
  | 'image'
  | 'webpage'
  | 'text';

export type DocumentBlockType =
  | 'title'
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'table'
  | 'image'
  | 'ocr_text'
  | 'code'
  | 'metadata';

export type DocumentJobType = 'parse' | 'ocr' | 'index' | 'thumbnail';
export type DocumentJobState = 'pending' | 'running' | 'ready' | 'failed' | 'cancelled';
export type DocumentOcrState = 'not_required' | 'pending' | 'ready' | 'failed';

export interface DocumentBlock {
  id?: string;
  unitId?: string;
  sourceId?: string;
  courseId?: string;
  nodeId?: string | null;
  blockIndex: number;
  type: DocumentBlockType;
  locator: string;
  text: string;
  headingPath?: string[];
  pageNumber?: number | null;
  charStart?: number | null;
  charEnd?: number | null;
  metadata?: Record<string, unknown>;
}

export interface DocumentUnit {
  id?: string;
  sourceId?: string;
  courseId?: string;
  nodeId?: string | null;
  unitIndex: number;
  kind: DocumentUnitKind;
  locator: string;
  title?: string | null;
  pageNumber?: number | null;
  text: string;
  charCount: number;
  ocrState?: DocumentOcrState;
  metadata?: Record<string, unknown>;
  blocks: DocumentBlock[];
}

export interface DocumentAsset {
  sourceId?: string;
  courseId: string;
  nodeId?: string | null;
  kind: DocumentKind;
  sourceKind?: SourceKind;
  title: string;
  mimeType?: string | null;
  fileName?: string | null;
  filePath?: string | null;
  originalPath?: string | null;
  url?: string | null;
  parserVersion: string;
  processingState: SourceProcessingState;
  processingError?: string | null;
  metadata?: Record<string, unknown>;
  units: DocumentUnit[];
}

export interface ParseDocumentInput {
  sourceId?: string;
  courseId: string;
  nodeId?: string | null;
  title: string;
  fileName?: string | null;
  mimeType?: string | null;
  filePath?: string | null;
  originalPath?: string | null;
  url?: string | null;
  sourceKind?: SourceKind;
  buffer?: Buffer;
  text?: string;
}

export interface StoredDocumentUnit extends Omit<DocumentUnit, 'blocks'> {
  id: string;
  sourceId: string;
  courseId: string;
  nodeId: string | null;
  createdAt: string;
}

export interface StoredDocumentBlock extends DocumentBlock {
  id: string;
  unitId: string;
  sourceId: string;
  courseId: string;
  nodeId: string | null;
  createdAt: string;
}

export interface StoredDocumentPageAsset {
  id: string;
  sourceId: string;
  unitId: string | null;
  courseId: string;
  nodeId: string | null;
  pageNumber: number;
  assetType: 'thumbnail' | 'page_image';
  filePath: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentProcessingJob {
  id: string;
  sourceId: string | null;
  courseId: string;
  nodeId: string | null;
  jobType: DocumentJobType;
  state: DocumentJobState;
  progressCurrent: number;
  progressTotal: number;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
