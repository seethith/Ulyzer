import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { IPC } from '@shared/ipc-channels'
import { normalizeDagEdges } from '@shared/dag-graph'
import {
  ensureCourseDir,
  ensureNodeDir,
  getCourseDir,
  getNodeDir,
  deleteFileFsResult
} from '../services/fs/content.service'
import { assertDagAcyclic } from '../services/agent-verifiers/dag.verifier'
import type {
  IpcResponse,
  Course,
  CreateCourseDto,
  DagGraph,
  DagNode,
  DagEdge,
  StartSessionDto,
  EndSessionDto,
  Settings,
  GuidanceMode,
  FileRecord,
  CreateFileDto,
  FileType,
  FileAttachment,
  ChatMessage,
  DiagnosticRecord,
  MessageArtifact,
  ChatThread,
  AgentType,
  ProviderConfig,
  ProviderModel,
  CreateProviderDto,
  UpdateModelDto,
  YouTubeCookiesMode
} from '@shared/types'
import { CourseRepository } from '../services/db/repositories/course.repo'
import { NodeRepository, EdgeRepository } from '../services/db/repositories/node.repo'
import { NodeHandoffRepository } from '../services/db/repositories/node-handoff.repo'
import { SessionRepository } from '../services/db/repositories/session.repo'
import { getDb } from '../services/db/sqlite'
import {
  cleanupOrphanSourceAssets,
  deletePrivateSourcesForThread,
  deleteSourceLinksForNode,
  deleteSourcesByIds,
  deleteSourcesForCourse,
  importTextSource,
  listPrivateSourceIdsForNode,
  replaceSourceContent
} from '../services/source/source-library'
import { refreshModelsDevCapabilityCache } from '../services/llm/model-capability-cache'
import { getModelCapabilityInfo } from '../services/llm/model-capabilities'
import { countTokens } from '../services/llm/token-counter'
import { recordCleanupFailure } from '../services/storage/storage-cleanup'
import { recomputeCourseDagProgress } from '../services/dag/dag-progress'

const courseRepo = new CourseRepository()
const nodeRepo = new NodeRepository()
const edgeRepo = new EdgeRepository()
const handoffRepo = new NodeHandoffRepository()
const sessionRepo = new SessionRepository()

function ok<T>(data: T): IpcResponse<T> {
  return { success: true, data }
}

function fail(err: unknown): IpcResponse<never> {
  const message = err instanceof Error ? err.message : String(err)
  return { success: false, error: message }
}

function sanitizeMessageAttachments(attachments?: FileAttachment[] | null): FileAttachment[] {
  if (!attachments || !Array.isArray(attachments)) return []
  return attachments
    .filter((att) => att && typeof att.id === 'string' && typeof att.name === 'string')
    .map((att) => ({
      id: att.id,
      name: att.name,
      mimeType: att.mimeType || 'application/octet-stream',
      size: Number.isFinite(att.size) ? att.size : 0,
      sourceId: att.sourceId,
      status: att.status,
      progressCurrent: att.progressCurrent,
      progressTotal: att.progressTotal,
      message: att.message,
      processingError: att.processingError ?? null
    }))
}

function messageAttachmentsJson(attachments?: FileAttachment[] | null): string | null {
  const clean = sanitizeMessageAttachments(attachments)
  return clean.length > 0 ? JSON.stringify(clean) : null
}

function parseMessageAttachments(value?: string | null): FileAttachment[] | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    const clean = sanitizeMessageAttachments(
      Array.isArray(parsed) ? (parsed as FileAttachment[]) : []
    )
    return clean.length > 0 ? clean : undefined
  } catch {
    return undefined
  }
}

function parseDiagnostics(value?: string | null): DiagnosticRecord[] | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as DiagnosticRecord[]) : undefined
  } catch {
    return undefined
  }
}

function parseArtifacts(value?: string | null): MessageArtifact[] | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as MessageArtifact[]) : undefined
  } catch {
    return undefined
  }
}

function deletePrivateMessageAttachmentSources(messageId: string): void {
  const db = getDb()
  const row = db
    .prepare<
      [string],
      { attachments_json: string | null }
    >('SELECT attachments_json FROM messages WHERE id = ?')
    .get(messageId)
  const sourceIds = [
    ...new Set(
      (parseMessageAttachments(row?.attachments_json) ?? [])
        .map((att) => att.sourceId)
        .filter((id): id is string => Boolean(id))
    )
  ]
  if (sourceIds.length === 0) return
  const placeholders = sourceIds.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT id FROM source_records WHERE id IN (${placeholders})`)
    .all(...sourceIds) as Array<{ id: string }>
  deleteSourcesByIds(rows.map((item) => item.id))
}

function attachmentSourceIds(attachments?: FileAttachment[] | null): string[] {
  return [
    ...new Set(
      (attachments ?? []).map((att) => att.sourceId).filter((id): id is string => Boolean(id))
    )
  ]
}

function attachmentSourceIdsFromJson(value?: string | null): string[] {
  return attachmentSourceIds(parseMessageAttachments(value))
}

function deleteUnreferencedMessageAttachmentSources(sourceIds: string[]): void {
  const candidates = [...new Set(sourceIds.filter(Boolean))]
  if (candidates.length === 0) return
  const referenced = new Set<string>()
  const rows = getDb()
    .prepare<
      [],
      { attachments_json: string | null }
    >('SELECT attachments_json FROM messages WHERE attachments_json IS NOT NULL')
    .all()
  for (const row of rows) {
    for (const sourceId of attachmentSourceIdsFromJson(row.attachments_json)) {
      referenced.add(sourceId)
    }
  }
  deleteSourcesByIds(candidates.filter((sourceId) => !referenced.has(sourceId)))
}

// ── Settings helpers ──────────────────────────────────────────────────────────

interface SettingsRow {
  id: number
  default_provider: string
  default_model: string
  guidance_mode: string
  font_size: number
  remember_layout: number
  theme: string
  background_image_enabled?: number | null
  background_image_path?: string | null
  background_image_opacity?: number | null
  background_overlay_opacity?: number | null
  background_image_fit?: string | null
  ocr_worker_count?: number | null
  learning_search_depth?: string | null
  learning_search_max_queries?: number | null
  learning_search_max_pages?: number | null
  learning_search_auto_ingest?: number | null
  learning_search_allow_community?: number | null
  learning_search_use_exa?: number | null
  learning_search_tavily_advanced?: number | null
  youtube_proxy_url?: string | null
  youtube_cookies_mode?: string | null
  youtube_cookies_path?: string | null
  youtube_cookies_profile?: string | null
  created_at: string
  updated_at: string
}

function getOrCreateSettings(): Settings {
  const db = getDb()
  const row = db.prepare<[], SettingsRow>('SELECT * FROM settings WHERE id = 1').get()
  if (row) {
    return rowToSettings(row)
  }
  db.prepare('INSERT INTO settings (id) VALUES (1)').run()
  return rowToSettings(db.prepare<[], SettingsRow>('SELECT * FROM settings WHERE id = 1').get()!)
}

function rowToSettings(row: SettingsRow): Settings {
  return {
    ...row,
    guidance_mode: row.guidance_mode as GuidanceMode,
    remember_layout: row.remember_layout === 1,
    theme: (row.theme ?? 'warm') as Settings['theme'],
    background_image_enabled: row.background_image_enabled === 1,
    background_image_path: row.background_image_path ?? '',
    background_image_opacity: normalizeBackgroundImageOpacity(row.background_image_opacity),
    background_overlay_opacity: normalizeBackgroundOverlayOpacity(row.background_overlay_opacity),
    background_image_fit: normalizeBackgroundImageFit(row.background_image_fit),
    ocr_worker_count: normalizeOcrWorkerCount(row.ocr_worker_count),
    learning_search_depth: normalizeLearningSearchDepth(row.learning_search_depth),
    learning_search_max_queries: normalizeLearningSearchMax(row.learning_search_max_queries, 4),
    learning_search_max_pages: normalizeLearningSearchMax(row.learning_search_max_pages, 4),
    learning_search_auto_ingest: row.learning_search_auto_ingest !== 0,
    learning_search_allow_community: row.learning_search_allow_community === 1,
    learning_search_use_exa: row.learning_search_use_exa !== 0,
    learning_search_tavily_advanced: row.learning_search_tavily_advanced === 1,
    youtube_proxy_url: row.youtube_proxy_url ?? '',
    youtube_cookies_mode: normalizeYouTubeCookiesMode(row.youtube_cookies_mode),
    youtube_cookies_path: row.youtube_cookies_path ?? '',
    youtube_cookies_profile: row.youtube_cookies_profile ?? ''
  }
}

function normalizeOcrWorkerCount(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 2
  return Math.min(4, Math.max(1, Math.trunc(n)))
}

function normalizeBackgroundImageOpacity(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0.72
  return Math.min(1, Math.max(0.1, n))
}

function normalizeBackgroundOverlayOpacity(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0.38
  return Math.min(0.85, Math.max(0, n))
}

function normalizeBackgroundImageFit(value: unknown): Settings['background_image_fit'] {
  return value === 'contain' || value === 'center' ? value : 'cover'
}

function normalizeLearningSearchDepth(value: unknown): Settings['learning_search_depth'] {
  return value === 'economy' || value === 'deep' ? value : 'standard'
}

function normalizeLearningSearchMax(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(8, Math.max(1, Math.trunc(n)))
}

function normalizeYouTubeCookiesMode(value: unknown): YouTubeCookiesMode {
  const allowed: YouTubeCookiesMode[] = [
    'none',
    'safari',
    'chrome',
    'firefox',
    'edge',
    'brave',
    'cookies_file'
  ]
  return allowed.includes(value as YouTubeCookiesMode) ? (value as YouTubeCookiesMode) : 'none'
}

interface ModelRow {
  id: string
  provider_id: string
  model_id: string
  label: string
  tag: string
  is_builtin: number
  source?: string | null
  context_window?: number | null
  max_output_tokens?: number | null
  input_price?: number | null
  output_price?: number | null
  supports_vision?: number | null
  supports_pdf?: number | null
  supports_tools?: number | null
  supports_reasoning?: number | null
  raw_metadata_json?: string | null
  capability_overrides_json?: string | null
  last_seen_at?: string | null
}

function nullableBool(value: number | null | undefined): boolean | null {
  if (value === null || value === undefined) return null
  return value === 1
}

function rowToProviderModel(row: ModelRow): ProviderModel {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelId: row.model_id,
    label: row.label,
    tag: row.tag,
    isBuiltin: row.is_builtin === 1,
    source: (row.source ?? (row.is_builtin === 1 ? 'builtin' : 'user')) as ProviderModel['source'],
    contextWindow: row.context_window ?? null,
    maxOutputTokens: row.max_output_tokens ?? null,
    inputPrice: row.input_price ?? null,
    outputPrice: row.output_price ?? null,
    supportsVision: nullableBool(row.supports_vision),
    supportsPdf: nullableBool(row.supports_pdf),
    supportsTools: nullableBool(row.supports_tools),
    supportsReasoning: nullableBool(row.supports_reasoning),
    rawMetadataJson: row.raw_metadata_json ?? null,
    capabilityOverridesJson: row.capability_overrides_json ?? null,
    lastSeenAt: row.last_seen_at ?? null
  }
}

interface ModelEntry {
  id: string
  label: string
  tag: string
  contextWindow?: number | null
  maxOutputTokens?: number | null
  inputPrice?: number | null
  outputPrice?: number | null
  supportsVision?: boolean | null
  supportsPdf?: boolean | null
  supportsTools?: boolean | null
  supportsReasoning?: boolean | null
  rawMetadata?: unknown
}

const MODEL_FETCH_TIMEOUT_MS = 15_000
const MAX_RAW_METADATA_JSON_BYTES = 128 * 1024
const MAX_MODEL_NUMERIC_VALUE = 1_000_000_000

function boolToDb(value: boolean | null | undefined): number | null {
  if (value === undefined || value === null) return null
  return value ? 1 : 0
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('Base URL 无效，请使用 http:// 或 https:// 开头的地址')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Base URL 仅支持 http:// 或 https://')
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new Error('Base URL 不能包含用户名、密码或空主机名')
  }
  return parsed.toString().replace(/\/+$/, '')
}

async function fetchJsonWithTimeout<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MODEL_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('获取模型超时，请检查网络或服务地址')
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

function rawMetadataToJson(rawMetadata: unknown): string | null {
  if (!rawMetadata) return null
  try {
    const json = JSON.stringify(rawMetadata)
    return Buffer.byteLength(json, 'utf8') <= MAX_RAW_METADATA_JSON_BYTES ? json : null
  } catch {
    return null
  }
}

function sanitizePositiveNumber(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isFinite(value) || value <= 0 || value > MAX_MODEL_NUMERIC_VALUE) return null
  return value
}

function sanitizePrice(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isFinite(value) || value < 0 || value > MAX_MODEL_NUMERIC_VALUE) return null
  return value
}

function nonBuiltinModelWhereClause(): string {
  return "COALESCE(source, CASE WHEN is_builtin = 1 THEN 'builtin' ELSE 'user' END) <> 'builtin'"
}

function dedupeModels(models: ModelEntry[]): ModelEntry[] {
  const seen = new Set<string>()
  const unique: ModelEntry[] = []
  for (const model of models) {
    if (!model.id || seen.has(model.id)) continue
    seen.add(model.id)
    unique.push(model)
  }
  return unique
}

async function resolveProviderApiKey(
  providerId: string,
  apiKeyName: string | null
): Promise<string> {
  const { getApiKey } = await import('../utils/keychain')
  return (await getApiKey(apiKeyName ?? providerId)) ?? ''
}

async function fetchOllamaModels(baseUrl: string): Promise<ModelEntry[]> {
  const json = await fetchJsonWithTimeout<{ models?: Array<{ name: string; details?: unknown }> }>(
    `${normalizeBaseUrl(baseUrl)}/api/tags`
  )
  return (json.models ?? []).map((m) => ({
    id: m.name,
    label: m.name,
    tag: '',
    inputPrice: 0,
    outputPrice: 0,
    rawMetadata: m
  }))
}

async function fetchAnthropicModels(apiKey: string): Promise<ModelEntry[]> {
  if (!apiKey) {
    return []
  }
  const json = await fetchJsonWithTimeout<{ data?: Array<{ id: string; display_name?: string }> }>(
    'https://api.anthropic.com/v1/models',
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    }
  )
  return (json.data ?? []).map((m) => ({
    id: m.id,
    label: m.display_name ?? m.id,
    tag: '',
    rawMetadata: m
  }))
}

async function fetchOpenRouterModels(baseUrl: string, apiKey: string): Promise<ModelEntry[]> {
  type ORModel = {
    id: string
    name?: string
    pricing?: { prompt?: string; completion?: string }
    context_length?: number
    architecture?: { modality?: string; instruct_type?: string | null }
  }
  const json = await fetchJsonWithTimeout<{ data?: ORModel[] }>(
    `${normalizeBaseUrl(baseUrl)}/models`,
    {
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'HTTP-Referer': 'https://ulyzer.app'
      }
    }
  )
  const skipModality = /^text->image|^audio->|^image->|^video->/i
  const skipId =
    /\bembed\b|embedding|text-embed|\btts\b|-tts$|tts-1|whisper|moderat|rerank|speech-to/i

  return (json.data ?? [])
    .filter((m) => {
      if (!m.id) return false
      if (skipId.test(m.id)) return false
      const modality = m.architecture?.modality ?? ''
      if (modality && skipModality.test(modality)) return false
      return true
    })
    .map((m) => {
      const promptPrice = Number.parseFloat(m.pricing?.prompt ?? '')
      const completionPrice = Number.parseFloat(m.pricing?.completion ?? '')
      const ctxLen = m.context_length ?? null
      let tag = ''
      if (promptPrice === 0) tag = '免费'
      else if ((ctxLen ?? 0) >= 128000) tag = '长文'
      else if (Number.isFinite(promptPrice) && promptPrice < 0.0000015) tag = '经济'
      return {
        id: m.id,
        label: m.name ?? m.id,
        tag,
        contextWindow: ctxLen,
        inputPrice: Number.isFinite(promptPrice) ? promptPrice * 1000 * 7.2 : null,
        outputPrice: Number.isFinite(completionPrice) ? completionPrice * 1000 * 7.2 : null,
        rawMetadata: m
      }
    })
}

async function fetchOpenAICompatModels(baseUrl: string, apiKey: string): Promise<ModelEntry[]> {
  const json = await fetchJsonWithTimeout<{ data?: Array<{ id: string }> }>(
    `${normalizeBaseUrl(baseUrl)}/models`,
    {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
    }
  )
  const skip =
    /\bembed\b|embedding|text-embed|\btts\b|-tts$|tts-1|whisper|dall-e|moderat|rerank|speech-to/i
  return (json.data ?? [])
    .filter((m) => m.id && !skip.test(m.id))
    .map((m) => ({ id: m.id, label: m.id, tag: '', rawMetadata: m }))
}

// ── File helpers ──────────────────────────────────────────────────────────────

interface FileRow {
  id: string
  node_id: string | null
  course_id: string | null
  file_type: string
  name: string
  content: string | null
  file_path: string | null
  is_locked: number
  created_at: string
  updated_at: string
}

function rowToFile(row: FileRow): FileRecord {
  return {
    ...row,
    file_type: row.file_type as FileType,
    is_locked: row.is_locked === 1
  }
}

function syncFileRecordSource(row: FileRow): void {
  if (!row.content || !row.node_id || !row.course_id) return
  const isImported = row.file_type === 'reference' || row.file_type === 'user_upload'
  const sourceId = `file-record-source:${row.id}`
  try {
    const exists = Boolean(getDb().prepare<[string], { id: string }>('SELECT id FROM source_records WHERE id = ?').get(sourceId))
    if (exists) {
      replaceSourceContent({
        sourceId,
        title: row.name,
        content: row.content,
        mimeType: 'text/markdown'
      })
      getDb()
        .prepare(
          `UPDATE source_records
           SET enabled = 1, title = ?, file_path = ?, kind = ?, origin = ?
           WHERE id = ?`
        )
        .run(row.name, row.file_path ?? null, isImported ? 'upload' : 'generated', isImported ? 'user_import' : 'ai_generated', sourceId)
      return
    }
    importTextSource({
      id: sourceId,
      courseId: row.course_id,
      nodeId: row.node_id,
      title: row.name,
      content: row.content,
      filePath: row.file_path ?? undefined,
      kind: isImported ? 'upload' : 'generated',
      origin: isImported ? 'user_import' : 'ai_generated',
      mimeType: 'text/markdown'
    })
  } catch {
    /* non-fatal */
  }
}

// ── Register all DB IPC handlers ──────────────────────────────────────────────

export function registerDbHandlers(): void {
  // ── Course ──────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.DB_COURSE_LIST, (): IpcResponse<Course[]> => {
    try {
      return ok(courseRepo.findAll())
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.DB_COURSE_CREATE, (_event, data: CreateCourseDto): IpcResponse<Course> => {
    try {
      const course = courseRepo.create(data)
      try {
        ensureCourseDir(course.id)
      } catch {
        /* non-fatal */
      }
      return ok(course)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.DB_COURSE_UPDATE,
    (_event, id: string, data: Partial<Omit<Course, 'id' | 'created_at'>>): IpcResponse<Course> => {
      try {
        return ok(courseRepo.update(id, data))
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.DB_COURSE_DELETE, (_event, id: string): IpcResponse<void> => {
    try {
      const courseDir = getCourseDir(id)
      deleteSourcesForCourse(id)
      // token_logs.course_id and agent_run_states.course_id have no ON DELETE
      // CASCADE, so with foreign_keys=ON a course that has usage logs would fail
      // to delete. Clear those dependents first.
      const db = getDb()
      db.prepare('DELETE FROM token_logs WHERE course_id = ?').run(id)
      try { db.prepare('DELETE FROM agent_run_states WHERE course_id = ?').run(id) } catch { /* table may not exist on old DBs */ }
      courseRepo.delete(id)
      const deleted = deleteFileFsResult(courseDir)
      if (!deleted.success) {
        recordCleanupFailure({
          path: courseDir,
          kind: 'course-content',
          ownerType: 'course',
          ownerId: id,
          reason: '课程工作区目录删除失败',
          error: deleted.error
        })
      }
      try {
        cleanupOrphanSourceAssets(id)
      } catch {
        /* non-fatal */
      }
      return ok(undefined)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.DB_NODE_GET, (_event, nodeId: string): IpcResponse<DagNode | null> => {
    try {
      return ok(nodeRepo.findById(nodeId))
    } catch (err) {
      return fail(err)
    }
  })

  // ── DAG ─────────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.DB_DAG_GET, (_event, courseId: string): IpcResponse<DagGraph> => {
    try {
      return ok(recomputeCourseDagProgress(courseId))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.DB_DAG_SAVE,
    (
      _event,
      payload: { courseId: string; nodes: DagNode[]; edges: DagEdge[] }
    ): IpcResponse<DagGraph> => {
      try {
        const normalizedEdges = normalizeDagEdges(payload.nodes, payload.edges, {
          getSource: (edge) => edge.source_node_id,
          getTarget: (edge) => edge.target_node_id
        }).edges
        const prerequisitesByNode = new Map<string, string[]>()
        for (const node of payload.nodes) prerequisitesByNode.set(node.id, [])
        for (const edge of normalizedEdges) {
          const current = prerequisitesByNode.get(edge.target_node_id)
          if (current && !current.includes(edge.source_node_id)) current.push(edge.source_node_id)
        }
        const normalizedNodes = payload.nodes.map((node) => ({
          ...node,
          prerequisites: prerequisitesByNode.get(node.id) ?? []
        }))
        assertDagAcyclic(normalizedNodes, normalizedEdges, 'DAG 存在循环依赖（图中有环），保存已取消')
        const db = getDb()
        const upsertNode = db.prepare(
          `INSERT INTO dag_nodes (
             id, course_id, chapter, chapter_order, name, description,
             node_type, status, difficulty,
             prerequisites, required_tools, required_cost,
             position_x, position_y,
             bloom_target, learning_type, priority,
             source_ids, rationale
           ) VALUES (
             @id, @course_id, @chapter, @chapter_order, @name, @description,
             @node_type, @status, @difficulty,
             @prerequisites, @required_tools, @required_cost,
             @position_x, @position_y,
             @bloom_target, @learning_type, @priority,
             @source_ids, @rationale
           )
           ON CONFLICT(id) DO UPDATE SET
             chapter = excluded.chapter,
             chapter_order = excluded.chapter_order,
             name = excluded.name,
             description = excluded.description,
             node_type = excluded.node_type,
             status = excluded.status,
             difficulty = excluded.difficulty,
             prerequisites = excluded.prerequisites,
             required_tools = excluded.required_tools,
             required_cost = excluded.required_cost,
             position_x = excluded.position_x,
             position_y = excluded.position_y,
             bloom_target = excluded.bloom_target,
             learning_type = excluded.learning_type,
             priority = excluded.priority,
             source_ids = excluded.source_ids,
             rationale = excluded.rationale,
             updated_at = datetime('now')`
        )

        // Collect IDs of nodes that will be removed before the transaction
        const incomingIds = new Set(normalizedNodes.map((n) => n.id))
        const existingNodes = nodeRepo.findByCourse(payload.courseId)
        const removedNodes = existingNodes.filter((n) => !incomingIds.has(n.id))
        const removedNodePrivateSourceIds = removedNodes.flatMap((node) =>
          listPrivateSourceIdsForNode(node.id)
        )

        db.transaction(() => {
          for (const node of normalizedNodes) {
            upsertNode.run({
              ...node,
              prerequisites: JSON.stringify(node.prerequisites),
              required_tools: JSON.stringify(node.required_tools),
              required_cost: JSON.stringify(node.required_cost),
              source_ids: JSON.stringify(node.source_ids ?? []),
              rationale: node.rationale ?? null
            })
          }
          // Delete nodes that are no longer in the DAG
          for (const node of removedNodes) {
            nodeRepo.delete(node.id)
          }
          edgeRepo.saveAll(payload.courseId, normalizedEdges)
          // Keep total_nodes in sync
          db.prepare(
            `UPDATE courses SET
               total_nodes = (SELECT COUNT(*) FROM dag_nodes WHERE course_id = ?),
               done_nodes  = (SELECT COUNT(*) FROM dag_nodes WHERE course_id = ? AND status = 'done'),
               updated_at  = datetime('now')
             WHERE id = ?`
          ).run(payload.courseId, payload.courseId, payload.courseId)
        })()

        // Ensure FS dirs for all nodes (non-fatal)
        for (const node of normalizedNodes) {
          try {
            ensureNodeDir(payload.courseId, node.id)
          } catch {
            /* non-fatal */
          }
        }
        // Delete FS dirs for removed nodes (non-fatal)
        for (const node of removedNodes) {
          const nodeDir = getNodeDir(payload.courseId, node.id)
          const deleted = deleteFileFsResult(nodeDir)
          if (!deleted.success) {
            recordCleanupFailure({
              path: nodeDir,
              kind: 'node-content',
              ownerType: 'node',
              ownerId: node.id,
              reason: '节点工作区目录删除失败',
              error: deleted.error
            })
          }
          handoffRepo.delete(node.id)
          deleteSourceLinksForNode(node.id)
        }
        deleteSourcesByIds(removedNodePrivateSourceIds)

        const graph = recomputeCourseDagProgress(payload.courseId)
        const course = courseRepo.findById(payload.courseId)
        for (const node of graph.nodes) {
          handoffRepo.syncFromNode(node, course)
        }

        return ok(graph)
      } catch (err) {
        return fail(err)
      }
    }
  )

  // ── Session ──────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.DB_SESSION_START, (_event, data: StartSessionDto): IpcResponse => {
    try {
      return ok(sessionRepo.start(data))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.DB_SESSION_END, (_event, id: string, data: EndSessionDto): IpcResponse => {
    try {
      return ok(sessionRepo.end(id, data))
    } catch (err) {
      return fail(err)
    }
  })

  // ── Files ────────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.DB_FILES_GET, (_event, nodeId: string): IpcResponse<FileRecord[]> => {
    try {
      const rows = getDb()
        .prepare<[string], FileRow>('SELECT * FROM files WHERE node_id = ? ORDER BY created_at ASC')
        .all(nodeId)
      return ok(rows.map(rowToFile))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.DB_FILE_CREATE, (_event, data: CreateFileDto): IpcResponse<FileRecord> => {
    try {
      const id = data.id ?? randomUUID()
      getDb()
        .prepare(
          `INSERT INTO files (id, node_id, course_id, file_type, name, content, file_path, is_locked)
             VALUES (@id, @node_id, @course_id, @file_type, @name, @content, @file_path, @is_locked)`
        )
        .run({
          id,
          node_id: data.node_id ?? null,
          course_id: data.course_id ?? null,
          file_type: data.file_type,
          name: data.name,
          content: data.content ?? null,
          file_path: data.file_path ?? null,
          is_locked: data.is_locked ? 1 : 0
        })
      const row = getDb().prepare<[string], FileRow>('SELECT * FROM files WHERE id = ?').get(id)!
      // Auto-index into the unified source library if content is provided.
      syncFileRecordSource(row)
      return ok(rowToFile(row))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.DB_FILE_UPDATE,
    (
      _event,
      id: string,
      data: Partial<Pick<FileRecord, 'name' | 'content' | 'file_path' | 'is_locked'>>
    ): IpcResponse<FileRecord> => {
      try {
        const existing = getDb()
          .prepare<[string], FileRow>('SELECT * FROM files WHERE id = ?')
          .get(id)
        if (!existing) throw new Error(`File not found: ${id}`)

        getDb()
          .prepare(
            `UPDATE files SET
               name = @name,
               content = @content,
               file_path = @file_path,
               is_locked = @is_locked,
               updated_at = datetime('now')
             WHERE id = @id`
          )
          .run({
            id,
            name: data.name ?? existing.name,
            content: data.content ?? existing.content,
            file_path: data.file_path ?? existing.file_path,
            is_locked: (data.is_locked ?? existing.is_locked === 1) ? 1 : 0
          })
        const row = getDb().prepare<[string], FileRow>('SELECT * FROM files WHERE id = ?').get(id)!
        syncFileRecordSource(row)
        return ok(rowToFile(row))
      } catch (err) {
        return fail(err)
      }
    }
  )

  // ── Settings ─────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.SETTINGS_GET, (): IpcResponse<Settings> => {
    try {
      return ok(getOrCreateSettings())
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.SETTINGS_SAVE,
    (_event, data: Partial<Omit<Settings, 'id' | 'created_at'>>): IpcResponse<Settings> => {
      try {
        const current = getOrCreateSettings()
        getDb()
          .prepare(
            `UPDATE settings SET
               default_provider = @default_provider,
               default_model = @default_model,
               guidance_mode = @guidance_mode,
               font_size = @font_size,
		               remember_layout = @remember_layout,
		               theme = @theme,
		               background_image_enabled = @background_image_enabled,
		               background_image_path = @background_image_path,
		               background_image_opacity = @background_image_opacity,
		               background_overlay_opacity = @background_overlay_opacity,
		               background_image_fit = @background_image_fit,
		               ocr_worker_count = @ocr_worker_count,
		               learning_search_depth = @learning_search_depth,
		               learning_search_max_queries = @learning_search_max_queries,
		               learning_search_max_pages = @learning_search_max_pages,
		               learning_search_auto_ingest = @learning_search_auto_ingest,
		               learning_search_allow_community = @learning_search_allow_community,
		               learning_search_use_exa = @learning_search_use_exa,
		               learning_search_tavily_advanced = @learning_search_tavily_advanced,
			               youtube_proxy_url = @youtube_proxy_url,
			               youtube_cookies_mode = @youtube_cookies_mode,
			               youtube_cookies_path = @youtube_cookies_path,
			               youtube_cookies_profile = @youtube_cookies_profile,
			               updated_at = datetime('now')
             WHERE id = 1`
          )
          .run({
            default_provider: data.default_provider ?? current.default_provider,
            default_model: data.default_model ?? current.default_model,
            guidance_mode: data.guidance_mode ?? current.guidance_mode,
            font_size: data.font_size ?? current.font_size,
            remember_layout: (data.remember_layout ?? current.remember_layout) ? 1 : 0,
            theme: data.theme ?? current.theme,
            background_image_enabled:
              (data.background_image_enabled ?? current.background_image_enabled) ? 1 : 0,
            background_image_path:
              data.background_image_path === undefined
                ? (current.background_image_path ?? '')
                : (data.background_image_path ?? '').trim(),
            background_image_opacity: normalizeBackgroundImageOpacity(
              data.background_image_opacity ?? current.background_image_opacity
            ),
            background_overlay_opacity: normalizeBackgroundOverlayOpacity(
              data.background_overlay_opacity ?? current.background_overlay_opacity
            ),
            background_image_fit: normalizeBackgroundImageFit(
              data.background_image_fit ?? current.background_image_fit
            ),
            ocr_worker_count: normalizeOcrWorkerCount(
              data.ocr_worker_count ?? current.ocr_worker_count
            ),
            learning_search_depth: normalizeLearningSearchDepth(
              data.learning_search_depth ?? current.learning_search_depth
            ),
            learning_search_max_queries: normalizeLearningSearchMax(
              data.learning_search_max_queries ?? current.learning_search_max_queries,
              4
            ),
            learning_search_max_pages: normalizeLearningSearchMax(
              data.learning_search_max_pages ?? current.learning_search_max_pages,
              4
            ),
            learning_search_auto_ingest:
              (data.learning_search_auto_ingest ?? current.learning_search_auto_ingest) ? 1 : 0,
            learning_search_allow_community:
              (data.learning_search_allow_community ?? current.learning_search_allow_community)
                ? 1
                : 0,
            learning_search_use_exa:
              (data.learning_search_use_exa ?? current.learning_search_use_exa) ? 1 : 0,
            learning_search_tavily_advanced:
              (data.learning_search_tavily_advanced ?? current.learning_search_tavily_advanced)
                ? 1
                : 0,
            youtube_proxy_url:
              data.youtube_proxy_url === undefined
                ? (current.youtube_proxy_url ?? '')
                : (data.youtube_proxy_url ?? '').trim(),
            youtube_cookies_mode: normalizeYouTubeCookiesMode(
              data.youtube_cookies_mode ?? current.youtube_cookies_mode
            ),
            youtube_cookies_path:
              data.youtube_cookies_path === undefined
                ? (current.youtube_cookies_path ?? '')
                : (data.youtube_cookies_path ?? '').trim(),
            youtube_cookies_profile:
              data.youtube_cookies_profile === undefined
                ? (current.youtube_cookies_profile ?? '')
                : (data.youtube_cookies_profile ?? '').trim()
          })
        return ok(getOrCreateSettings())
      } catch (err) {
        return fail(err)
      }
    }
  )

  // ── Messages ──────────────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.DB_MESSAGES_GET,
    (
      _event,
      courseId: string,
      agent: string,
      nodeId?: string,
      threadId?: string
    ): IpcResponse<ChatMessage[]> => {
      try {
        interface MsgRow {
          id: string
          role: string
          content: string
          progress: string | null
          thinking: string | null
          diagnostics: string | null
          artifacts: string | null
          attachments_json: string | null
          created_at: string
        }
        let rows: MsgRow[]
        if (threadId) {
          rows = getDb()
            .prepare<[string], MsgRow>(
              `SELECT id, role, content, progress, thinking, diagnostics, artifacts, attachments_json, created_at
               FROM messages
               WHERE thread_id = ?
               ORDER BY created_at ASC`
            )
            .all(threadId)
        } else if (nodeId) {
          rows = getDb()
            .prepare<[string, string, string], MsgRow>(
              `SELECT id, role, content, progress, thinking, diagnostics, artifacts, attachments_json, created_at
               FROM messages
               WHERE course_id = ? AND agent = ? AND node_id = ?
               ORDER BY created_at ASC`
            )
            .all(courseId, agent, nodeId)
        } else {
          rows = getDb()
            .prepare<[string, string], MsgRow>(
              `SELECT id, role, content, progress, thinking, diagnostics, artifacts, attachments_json, created_at
               FROM messages
               WHERE course_id = ? AND agent = ? AND node_id IS NULL
               ORDER BY created_at ASC`
            )
            .all(courseId, agent)
        }
        const messages: ChatMessage[] = rows.map((r) => ({
          id: r.id,
          role: r.role as 'user' | 'assistant',
          content: r.content,
          timestamp: new Date(r.created_at).getTime(),
          progress: r.progress || undefined,
          thinking: r.thinking || undefined,
          diagnostics: parseDiagnostics(r.diagnostics),
          artifacts: parseArtifacts(r.artifacts),
          attachments: parseMessageAttachments(r.attachments_json)
        }))
        return ok(messages)
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.DB_MESSAGE_CREATE,
    (
      _event,
      data: {
        id: string
        courseId: string
        role: string
        content: string
        progress?: string
        thinking?: string
        diagnostics?: string
        artifacts?: string
        attachments?: FileAttachment[]
        agent: string
        nodeId?: string
        threadId?: string
      }
    ): IpcResponse<void> => {
      try {
        const db = getDb()
        db.prepare(
          `INSERT OR IGNORE INTO messages (id, course_id, node_id, role, content, progress, thinking, diagnostics, artifacts, attachments_json, agent, thread_id, token_count)
           VALUES (@id, @course_id, @node_id, @role, @content, @progress, @thinking, @diagnostics, @artifacts, @attachments_json, @agent, @thread_id, @token_count)`
        ).run({
          id: data.id,
          course_id: data.courseId,
          node_id: data.nodeId ?? null,
          role: data.role,
          content: data.content,
          progress: data.progress ?? null,
          thinking: data.thinking ?? null,
          diagnostics: data.diagnostics ?? null,
          artifacts: data.artifacts ?? null,
          attachments_json: messageAttachmentsJson(data.attachments),
          agent: data.agent,
          thread_id: data.threadId ?? null,
          token_count: countTokens(data.content)
        })
        // Keep thread updated_at in sync
        if (data.threadId) {
          db.prepare(`UPDATE chat_threads SET updated_at = datetime('now') WHERE id = ?`).run(
            data.threadId
          )
        }
        return ok(undefined)
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.DB_MESSAGE_UPDATE,
    (
      _event,
      id: string,
      patchOrContent: string | { content: string; attachments?: FileAttachment[] | null }
    ): IpcResponse<void> => {
      try {
        if (typeof patchOrContent === 'string') {
          getDb().prepare('UPDATE messages SET content = ?, token_count = ? WHERE id = ?').run(patchOrContent, countTokens(patchOrContent), id)
        } else {
          getDb()
            .prepare('UPDATE messages SET content = ?, attachments_json = ?, token_count = ? WHERE id = ?')
            .run(patchOrContent.content, messageAttachmentsJson(patchOrContent.attachments), countTokens(patchOrContent.content), id)
        }
        return ok(undefined)
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.DB_MESSAGE_EDIT_AND_TRUNCATE,
    (
      _event,
      data: {
        id: string
        content: string
        attachments?: FileAttachment[] | null
        truncateMessageIds?: string[]
      }
    ): IpcResponse<void> => {
      try {
        const db = getDb()
        const cleanupSourceIds = db.transaction(() => {
          interface MessageRow {
            id: string
            role: string
            course_id: string
            node_id: string | null
            agent: string | null
            thread_id: string | null
            attachments_json: string | null
          }
          const current = db
            .prepare<[string], MessageRow>(
              `SELECT id, role, course_id, node_id, agent, thread_id, attachments_json
             FROM messages
             WHERE id = ?`
            )
            .get(data.id)
          if (!current) throw new Error(`Message not found: ${data.id}`)
          if (current.role !== 'user')
            throw new Error('Only user messages can be edited and resent')

          const nextAttachments = sanitizeMessageAttachments(data.attachments)
          const keptSourceIds = new Set(attachmentSourceIds(nextAttachments))
          const sourceIdsToCleanup = new Set<string>()
          for (const sourceId of attachmentSourceIdsFromJson(current.attachments_json)) {
            if (!keptSourceIds.has(sourceId)) sourceIdsToCleanup.add(sourceId)
          }

          const rawDeleteIds = Array.isArray(data.truncateMessageIds) ? data.truncateMessageIds : []
          const deleteIds = [...new Set(rawDeleteIds.filter((id) => id && id !== data.id))]
          let rowsToDelete: Array<Pick<MessageRow, 'id' | 'attachments_json'>> = []
          if (deleteIds.length > 0) {
            const placeholders = deleteIds.map(() => '?').join(',')
            rowsToDelete = db
              .prepare<unknown[], Pick<MessageRow, 'id' | 'attachments_json'>>(
                `SELECT id, attachments_json
               FROM messages
               WHERE id IN (${placeholders})
                 AND course_id = ?
                 AND COALESCE(agent, '') = COALESCE(?, '')
                 AND COALESCE(node_id, '') = COALESCE(?, '')
                 AND ${current.thread_id ? 'thread_id = ?' : 'thread_id IS NULL'}`
              )
              .all(
                ...deleteIds,
                current.course_id,
                current.agent,
                current.node_id,
                ...(current.thread_id ? [current.thread_id] : [])
              )
            for (const row of rowsToDelete) {
              for (const sourceId of attachmentSourceIdsFromJson(row.attachments_json)) {
                if (!keptSourceIds.has(sourceId)) sourceIdsToCleanup.add(sourceId)
              }
            }
          }

          db.prepare('UPDATE messages SET content = ?, attachments_json = ?, token_count = ? WHERE id = ?').run(
            data.content,
            messageAttachmentsJson(nextAttachments),
            countTokens(data.content),
            data.id
          )

          if (rowsToDelete.length > 0) {
            const placeholders = rowsToDelete.map(() => '?').join(',')
            db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(
              ...rowsToDelete.map((row) => row.id)
            )
          }

          if (current.thread_id) {
            db.prepare("UPDATE chat_threads SET updated_at = datetime('now') WHERE id = ?").run(
              current.thread_id
            )
          }
          return [...sourceIdsToCleanup]
        })()

        deleteUnreferencedMessageAttachmentSources(cleanupSourceIds)
        return ok(undefined)
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.DB_MESSAGE_DELETE, (_event, id: string): IpcResponse<void> => {
    try {
      deletePrivateMessageAttachmentSources(id)
      getDb().prepare('DELETE FROM messages WHERE id = ?').run(id)
      return ok(undefined)
    } catch (err) {
      return fail(err)
    }
  })

  // ── Chat threads ──────────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.DB_THREAD_LIST,
    (_event, courseId: string, agent: string, nodeId?: string): IpcResponse<ChatThread[]> => {
      try {
        interface ThreadRow {
          id: string
          course_id: string
          node_id: string | null
          agent: string
          title: string
          created_at: string
          updated_at: string
          deleted: number
        }
        let rows: ThreadRow[]
        if (nodeId) {
          rows = getDb()
            .prepare<[string, string, string], ThreadRow>(
              `SELECT * FROM chat_threads
               WHERE course_id = ? AND agent = ? AND node_id = ? AND deleted = 0
               ORDER BY updated_at DESC`
            )
            .all(courseId, agent, nodeId)
        } else {
          rows = getDb()
            .prepare<[string, string], ThreadRow>(
              `SELECT * FROM chat_threads
               WHERE course_id = ? AND agent = ? AND node_id IS NULL AND deleted = 0
               ORDER BY updated_at DESC`
            )
            .all(courseId, agent)
        }
        const threads: ChatThread[] = rows.map((r) => ({
          id: r.id,
          courseId: r.course_id,
          nodeId: r.node_id,
          agent: r.agent as AgentType,
          title: r.title,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          deleted: r.deleted === 1
        }))
        return ok(threads)
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.DB_THREAD_CREATE,
    (
      _event,
      data: { courseId: string; agent: string; nodeId?: string; title?: string }
    ): IpcResponse<ChatThread> => {
      try {
        const id = randomUUID()
        const db = getDb()
        db.prepare(
          `INSERT INTO chat_threads (id, course_id, node_id, agent, title)
           VALUES (@id, @course_id, @node_id, @agent, @title)`
        ).run({
          id,
          course_id: data.courseId,
          node_id: data.nodeId ?? null,
          agent: data.agent,
          title: data.title ?? 'New Chat'
        })
        interface ThreadRow {
          id: string
          course_id: string
          node_id: string | null
          agent: string
          title: string
          created_at: string
          updated_at: string
          deleted: number
        }
        const row = db
          .prepare<[string], ThreadRow>('SELECT * FROM chat_threads WHERE id = ?')
          .get(id)!
        return ok({
          id: row.id,
          courseId: row.course_id,
          nodeId: row.node_id,
          agent: row.agent as AgentType,
          title: row.title,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          deleted: false
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.DB_THREAD_UPDATE,
    (_event, id: string, data: { title?: string }): IpcResponse<void> => {
      try {
        getDb()
          .prepare(
            `UPDATE chat_threads SET title = @title, updated_at = datetime('now') WHERE id = @id`
          )
          .run({ id, title: data.title ?? 'New Chat' })
        return ok(undefined)
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.DB_THREAD_DELETE, (_event, id: string): IpcResponse<void> => {
    try {
      deletePrivateSourcesForThread(id)
      getDb()
        .prepare(`UPDATE chat_threads SET deleted = 1, updated_at = datetime('now') WHERE id = ?`)
        .run(id)
      return ok(undefined)
    } catch (err) {
      return fail(err)
    }
  })

  // ── Providers ─────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.DB_PROVIDER_LIST, (): IpcResponse<ProviderConfig[]> => {
    try {
      interface ProviderRow {
        id: string
        name: string
        type: string
        base_url: string | null
        api_key_name: string | null
        is_builtin: number
        enabled: number
      }
      const rows = getDb()
        .prepare<
          [],
          ProviderRow
        >('SELECT * FROM providers ORDER BY is_builtin DESC, created_at ASC')
        .all()
      return ok(
        rows.map(
          (r): ProviderConfig => ({
            id: r.id,
            name: r.name,
            type: r.type as ProviderConfig['type'],
            baseUrl: r.base_url,
            apiKeyName: r.api_key_name,
            isBuiltin: r.is_builtin === 1,
            enabled: r.enabled === 1
          })
        )
      )
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.DB_PROVIDER_CREATE,
    (_event, data: CreateProviderDto): IpcResponse<ProviderConfig> => {
      try {
        const id = randomUUID()
        const db = getDb()
        db.prepare(
          `INSERT INTO providers (id, name, type, base_url, api_key_name, is_builtin)
           VALUES (@id, @name, @type, @base_url, @api_key_name, 0)`
        ).run({
          id,
          name: data.name,
          type: data.type,
          base_url: data.baseUrl,
          api_key_name: data.apiKeyName ?? null
        })
        interface ProviderRow {
          id: string
          name: string
          type: string
          base_url: string | null
          api_key_name: string | null
          is_builtin: number
          enabled: number
        }
        const row = db
          .prepare<[string], ProviderRow>('SELECT * FROM providers WHERE id = ?')
          .get(id)!
        return ok({
          id: row.id,
          name: row.name,
          type: row.type as ProviderConfig['type'],
          baseUrl: row.base_url,
          apiKeyName: row.api_key_name,
          isBuiltin: false,
          enabled: true
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.DB_PROVIDER_UPDATE,
    (
      _event,
      id: string,
      data: Partial<Pick<ProviderConfig, 'name' | 'baseUrl' | 'apiKeyName' | 'enabled'>>
    ): IpcResponse<void> => {
      try {
        const db = getDb()
        interface ProviderRow {
          name: string
          base_url: string | null
          api_key_name: string | null
          enabled: number
        }
        const existing = db
          .prepare<
            [string],
            ProviderRow
          >('SELECT name, base_url, api_key_name, enabled FROM providers WHERE id = ?')
          .get(id)
        if (!existing) throw new Error(`Provider not found: ${id}`)
        db.prepare(
          `UPDATE providers SET name = @name, base_url = @base_url, api_key_name = @api_key_name, enabled = @enabled WHERE id = @id`
        ).run({
          id,
          name: data.name ?? existing.name,
          base_url: data.baseUrl !== undefined ? data.baseUrl : existing.base_url,
          api_key_name: data.apiKeyName !== undefined ? data.apiKeyName : existing.api_key_name,
          enabled: (data.enabled !== undefined ? data.enabled : existing.enabled === 1) ? 1 : 0
        })
        return ok(undefined)
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.DB_PROVIDER_DELETE, (_event, id: string): IpcResponse<void> => {
    try {
      getDb().prepare('DELETE FROM providers WHERE id = ? AND is_builtin = 0').run(id)
      return ok(undefined)
    } catch (err) {
      return fail(err)
    }
  })

  // ── Provider models ───────────────────────────────────────────────────────────

  ipcMain.handle(IPC.DB_MODEL_LIST, (_event, providerId?: string): IpcResponse<ProviderModel[]> => {
    try {
      let rows: ModelRow[]
      if (providerId) {
        rows = getDb()
          .prepare<
            [string],
            ModelRow
          >("SELECT * FROM provider_models WHERE provider_id = ? AND COALESCE(source, CASE WHEN is_builtin = 1 THEN 'builtin' ELSE 'user' END) <> 'builtin' ORDER BY created_at ASC")
          .all(providerId)
      } else {
        rows = getDb()
          .prepare<
            [],
            ModelRow
          >("SELECT * FROM provider_models WHERE COALESCE(source, CASE WHEN is_builtin = 1 THEN 'builtin' ELSE 'user' END) <> 'builtin' ORDER BY provider_id ASC, created_at ASC")
          .all()
      }
      return ok(rows.map(rowToProviderModel))
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.DB_MODEL_UPDATE,
    (_event, id: string, data: UpdateModelDto): IpcResponse<ProviderModel> => {
      try {
        const db = getDb()
        const existing = db
          .prepare<[string], ModelRow>('SELECT * FROM provider_models WHERE id = ?')
          .get(id)
        if (!existing) throw new Error(`Model not found: ${id}`)
        db.prepare(
          `UPDATE provider_models SET
             label = @label,
             tag = @tag
           WHERE id = @id`
        ).run({
          id,
          label: data.label ?? existing.label,
          tag: data.tag ?? existing.tag
        })
        return ok(
          rowToProviderModel(
            db.prepare<[string], ModelRow>('SELECT * FROM provider_models WHERE id = ?').get(id)!
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.DB_MODEL_CLEAR_PROVIDER, (_event, providerId: string): IpcResponse<void> => {
    try {
      const db = getDb()
      db.transaction(() => {
        db.prepare(
          `DELETE FROM provider_models WHERE provider_id = ? AND ${nonBuiltinModelWhereClause()}`
        ).run(providerId)
        db.prepare(
          `UPDATE settings
             SET default_provider = '', default_model = '', updated_at = datetime('now')
             WHERE default_provider = ?`
        ).run(providerId)
      })()
      return ok(undefined)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.MODEL_CAPABILITY_GET,
    (
      _event,
      providerId: string,
      modelId: string
    ): IpcResponse<ReturnType<typeof getModelCapabilityInfo>> => {
      try {
        return ok(getModelCapabilityInfo(providerId, modelId))
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.PROVIDER_FETCH_MODELS,
    async (
      _event,
      providerArg: string | { providerId?: string }
    ): Promise<IpcResponse<{ added: number; removed: number; models: string[] }>> => {
      try {
        const providerId = typeof providerArg === 'string' ? providerArg : providerArg.providerId
        if (!providerId) return fail(new Error('Provider id is required'))
        const db = getDb()
        const provider = db
          .prepare<
            [string],
            {
              id: string
              type: string
              base_url: string | null
              api_key_name: string | null
              enabled: number
            }
          >('SELECT id, type, base_url, api_key_name, enabled FROM providers WHERE id = ?')
          .get(providerId)
        if (!provider) return fail(new Error('Provider not found'))
        if (provider.enabled !== 1) return fail(new Error('Provider 已停用，请先启用后再获取模型'))

        let models: ModelEntry[] = []

        if (provider.type === 'ollama') {
          models = await fetchOllamaModels(provider.base_url ?? 'http://localhost:11434')
        } else if (providerId === 'anthropic') {
          const apiKey = await resolveProviderApiKey(provider.id, provider.api_key_name)
          if (!apiKey) return fail(new Error('API Key 未配置，请先保存 Key'))
          models = await fetchAnthropicModels(apiKey)
        } else if (providerId === 'openrouter') {
          const apiKey = await resolveProviderApiKey(provider.id, provider.api_key_name)
          if (!apiKey) return fail(new Error('API Key 未配置，请先保存 Key'))
          models = await fetchOpenRouterModels(
            provider.base_url ?? 'https://openrouter.ai/api/v1',
            apiKey
          )
        } else {
          const baseUrl =
            provider.base_url ?? (providerId === 'openai' ? 'https://api.openai.com/v1' : null)
          if (!baseUrl) return fail(new Error('No base URL configured'))
          const apiKey = await resolveProviderApiKey(provider.id, provider.api_key_name)
          if (!apiKey) return fail(new Error('API Key 未配置，请先保存 Key'))
          models = await fetchOpenAICompatModels(baseUrl, apiKey)
        }

        const fetchedModels = dedupeModels(models)
        const fetchedIds = new Set(fetchedModels.map((m) => m.id))
        const existingRows = db
          .prepare<
            [string],
            { model_id: string }
          >(`SELECT model_id FROM provider_models WHERE provider_id = ? AND ${nonBuiltinModelWhereClause()}`)
          .all(providerId)
        const existing = new Set(existingRows.map((r) => r.model_id))
        const insert = db.prepare(
          `INSERT OR IGNORE INTO provider_models (
             id, provider_id, model_id, label, tag, is_builtin, source,
             context_window, max_output_tokens, input_price, output_price,
             supports_vision, supports_pdf, supports_tools, supports_reasoning,
             raw_metadata_json, last_seen_at
           ) VALUES (?,?,?,?,?,0,'fetched',?,?,?,?,?,?,?,?,?,datetime('now'))`
        )
        const touch = db.prepare(
          `UPDATE provider_models SET
             raw_metadata_json = COALESCE(@raw_metadata_json, raw_metadata_json),
             context_window = COALESCE(@context_window, context_window),
             max_output_tokens = COALESCE(@max_output_tokens, max_output_tokens),
             input_price = COALESCE(@input_price, input_price),
             output_price = COALESCE(@output_price, output_price),
             supports_vision = COALESCE(@supports_vision, supports_vision),
             supports_pdf = COALESCE(@supports_pdf, supports_pdf),
             supports_tools = COALESCE(@supports_tools, supports_tools),
             supports_reasoning = COALESCE(@supports_reasoning, supports_reasoning),
             last_seen_at = datetime('now')
           WHERE provider_id = @provider_id AND model_id = @model_id`
        )
        const added: string[] = []
        const removed = existingRows
          .map((r) => r.model_id)
          .filter((modelId) => !fetchedIds.has(modelId))
        const deleteModel = db.prepare<[string, string]>(
          `DELETE FROM provider_models WHERE provider_id = ? AND model_id = ? AND ${nonBuiltinModelWhereClause()}`
        )
        db.transaction(() => {
          for (const modelId of removed) {
            deleteModel.run(providerId, modelId)
            db.prepare(
              `UPDATE settings
               SET default_provider = '', default_model = '', updated_at = datetime('now')
               WHERE default_provider = ? AND default_model = ?`
            ).run(providerId, modelId)
          }
          for (const m of fetchedModels) {
            const metadataJson = rawMetadataToJson(m.rawMetadata)
            if (existing.has(m.id)) {
              touch.run({
                provider_id: providerId,
                model_id: m.id,
                raw_metadata_json: metadataJson,
                context_window: sanitizePositiveNumber(m.contextWindow),
                max_output_tokens: sanitizePositiveNumber(m.maxOutputTokens),
                input_price: sanitizePrice(m.inputPrice),
                output_price: sanitizePrice(m.outputPrice),
                supports_vision: boolToDb(m.supportsVision),
                supports_pdf: boolToDb(m.supportsPdf),
                supports_tools: boolToDb(m.supportsTools),
                supports_reasoning: boolToDb(m.supportsReasoning)
              })
              continue
            }
            insert.run(
              `fetched:${providerId}:${m.id}`,
              providerId,
              m.id,
              m.label,
              m.tag,
              sanitizePositiveNumber(m.contextWindow),
              sanitizePositiveNumber(m.maxOutputTokens),
              sanitizePrice(m.inputPrice),
              sanitizePrice(m.outputPrice),
              boolToDb(m.supportsVision),
              boolToDb(m.supportsPdf),
              boolToDb(m.supportsTools),
              boolToDb(m.supportsReasoning),
              metadataJson
            )
            added.push(m.id)
          }
        })()

        await refreshModelsDevCapabilityCache({ providerIds: [providerId] }).catch(() => undefined)

        return ok({
          added: added.length,
          removed: removed.length,
          models: fetchedModels.map((m) => m.id)
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  // ── Node complete ─────────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC.DB_NODE_COMPLETE,
    (_event, nodeId: string): IpcResponse<{ updatedNodes: DagNode[] }> => {
      try {
        const db = getDb()
        interface NodeRow {
          course_id: string
        }
        const nodeRow = db
          .prepare<[string], NodeRow>('SELECT course_id FROM dag_nodes WHERE id = ?')
          .get(nodeId)

        // Mark node as done
        db.prepare(
          `UPDATE dag_nodes SET status = 'done', updated_at = datetime('now') WHERE id = ?`
        ).run(nodeId)

        const updatedNodes = nodeRow ? recomputeCourseDagProgress(nodeRow.course_id).nodes : []

        return ok({ updatedNodes })
      } catch (err) {
        return fail(err)
      }
    }
  )
}
