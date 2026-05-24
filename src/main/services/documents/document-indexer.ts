import type { SourceKind } from '@shared/types';
import { indexDocumentUnits, indexSourceContent } from '../source/source-indexer';
import type { DocumentAsset, DocumentUnit } from './document-types';
import { documentAssetPages, documentAssetToText } from './document-parser';

export function indexDocumentAsset(input: {
  sourceId: string;
  asset: DocumentAsset;
  sourceKind?: SourceKind;
  force?: boolean;
  maxChunks?: number;
}): void {
  indexSourceContent({
    sourceId: input.sourceId,
    courseId: input.asset.courseId,
    nodeId: input.asset.nodeId ?? null,
    sourceKind: input.sourceKind ?? input.asset.sourceKind ?? 'upload',
    fileName: input.asset.fileName ?? input.asset.title,
    mimeType: input.asset.mimeType ?? undefined,
    pages: documentAssetPages(input.asset),
    content: documentAssetToText(input.asset),
    maxChunks: input.maxChunks,
    force: input.force,
  });
}

export function indexDocumentAssetUnits(input: {
  sourceId: string;
  asset: DocumentAsset;
  units: DocumentUnit[];
  sourceKind?: SourceKind;
  maxChunks?: number;
}): void {
  indexDocumentUnits({
    sourceId: input.sourceId,
    asset: input.asset,
    units: input.units,
    sourceKind: input.sourceKind,
    maxChunks: input.maxChunks,
  });
}
