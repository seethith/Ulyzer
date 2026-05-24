import type { SourceKind } from '@shared/types';

const WEB_MAX_CHUNKS = 40;
const GENERATED_MAX_CHUNKS = 80;
const DEFAULT_UPLOAD_MAX_CHUNKS = 160;
const MAX_DOCUMENT_MAX_CHUNKS = 3000;
const CHUNKS_PER_PAGE_BUDGET = 3;

export function resolveSourceMaxChunks(input: {
  sourceKind: SourceKind;
  explicit?: number;
  pageCount?: number;
}): number {
  if (input.explicit && input.explicit > 0) return input.explicit;
  if (input.sourceKind === 'web') return WEB_MAX_CHUNKS;
  if (input.sourceKind === 'generated') return GENERATED_MAX_CHUNKS;

  const pageCount = input.pageCount ?? 0;
  if (pageCount > 0) {
    return Math.min(
      Math.max(DEFAULT_UPLOAD_MAX_CHUNKS, pageCount * CHUNKS_PER_PAGE_BUDGET),
      MAX_DOCUMENT_MAX_CHUNKS,
    );
  }

  return DEFAULT_UPLOAD_MAX_CHUNKS;
}
