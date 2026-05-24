import type { LearningSearchDepth } from '@shared/types';
import { getDb } from '../db/sqlite';

export interface LearningSearchRuntimeSettings {
  depth: LearningSearchDepth;
  maxQueries: number;
  maxPages: number;
  autoIngest: boolean;
  allowCommunityAutoImport: boolean;
  useExa: boolean;
  tavilyAdvanced: boolean;
}

interface SettingsRow {
  learning_search_depth?: string | null;
  learning_search_max_queries?: number | null;
  learning_search_max_pages?: number | null;
  learning_search_auto_ingest?: number | null;
  learning_search_allow_community?: number | null;
  learning_search_use_exa?: number | null;
  learning_search_tavily_advanced?: number | null;
}

function normalizeDepth(value: unknown): LearningSearchDepth {
  return value === 'economy' || value === 'deep' ? value : 'standard';
}

function normalizeMax(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(8, Math.max(1, Math.trunc(n)));
}

export function readLearningSearchSettings(): LearningSearchRuntimeSettings {
  try {
    const row = getDb()
      .prepare<[], SettingsRow>(
        `SELECT learning_search_depth,
                learning_search_max_queries,
                learning_search_max_pages,
                learning_search_auto_ingest,
                learning_search_allow_community,
                learning_search_use_exa,
                learning_search_tavily_advanced
         FROM settings
         WHERE id = 1`,
      )
      .get();
    return {
      depth: normalizeDepth(row?.learning_search_depth),
      maxQueries: normalizeMax(row?.learning_search_max_queries, 4),
      maxPages: normalizeMax(row?.learning_search_max_pages, 4),
      autoIngest: row?.learning_search_auto_ingest !== 0,
      allowCommunityAutoImport: row?.learning_search_allow_community === 1,
      useExa: row?.learning_search_use_exa !== 0,
      tavilyAdvanced: row?.learning_search_tavily_advanced === 1,
    };
  } catch {
    return {
      depth: 'standard',
      maxQueries: 4,
      maxPages: 4,
      autoIngest: true,
      allowCommunityAutoImport: false,
      useExa: true,
      tavilyAdvanced: false,
    };
  }
}
