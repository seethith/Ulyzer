import type { SupportedLocale } from './i18n';

// ── Course ────────────────────────────────────────────────────────────────────

export type CourseStatus = 'new' | 'planning' | 'active' | 'done';
export type DepthPreference = 'quick' | 'standard' | 'deep';

export interface Course {
  id: string;
  name: string;
  description: string | null;
  status: CourseStatus;
  total_nodes: number;
  done_nodes: number;
  hours_spent: number;
  total_token_used: number;
  total_cost_cny: number;
  goal_text: string | null;
  known_topics: string | null;
  time_budget: string | null;
  depth_preference: DepthPreference | null;
  profile_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateCourseDto {
  name: string;
  description?: string;
}

// ── DAG ───────────────────────────────────────────────────────────────────────

export type NodeType = 'main' | 'boss';
export type NodeStatus = 'locked' | 'available' | 'active' | 'done';
export type Difficulty = 'beginner' | 'intermediate' | 'advanced';
export type BloomTarget = 'remember_understand' | 'analyze_evaluate' | 'apply' | 'create';
export type LearningType = 'verbal_info' | 'intellectual_skill' | 'cognitive_strategy' | 'motor_skill' | 'attitude';
export type NodePriority = 'must' | 'should' | 'nice_to_have';

export interface RequiredCost {
  money?: number;
  equipment?: string;
  location?: string;
}

export interface DagNode {
  id: string;
  course_id: string;
  chapter: string;
  chapter_order: number;
  name: string;
  description: string | null;
  node_type: NodeType;
  status: NodeStatus;
  difficulty: Difficulty;
  prerequisites: string[];
  required_tools: string[];
  required_cost: RequiredCost;
  position_x: number;
  position_y: number;
  bloom_target: BloomTarget | null;
  learning_type: LearningType | null;
  priority: NodePriority | null;
  source_ids: string[];
  rationale: string | null;
  created_at: string;
  updated_at: string;
}

export interface DagEdge {
  id: string;
  course_id: string;
  source_node_id: string;
  target_node_id: string;
  created_at: string;
}

export interface DagGraph {
  nodes: DagNode[];
  edges: DagEdge[];
}

export interface CreateNodeDto {
  id?: string;
  course_id: string;
  chapter: string;
  chapter_order?: number;
  name: string;
  description?: string;
  node_type?: NodeType;
  status?: NodeStatus;
  difficulty?: Difficulty;
  prerequisites?: string[];
  required_tools?: string[];
  required_cost?: RequiredCost;
  position_x?: number;
  position_y?: number;
  bloom_target?: BloomTarget;
  learning_type?: LearningType;
  priority?: NodePriority;
  source_ids?: string[];
  rationale?: string;
}

// ── Session ───────────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  course_id: string;
  node_id: string;
  phase: 2 | 3;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
  token_used: number;
  cost_cny: number;
  mastery_score: number | null;
}

export interface StartSessionDto {
  id?: string;
  course_id: string;
  node_id: string;
  phase: 2 | 3;
}

export interface EndSessionDto {
  duration_seconds: number;
  token_used: number;
  cost_cny: number;
  mastery_score?: number;
}

// ── File ──────────────────────────────────────────────────────────────────────

export type FileType = 'theory' | 'practice' | 'answer' | 'reference' | 'user_upload';

export interface FileRecord {
  id: string;
  node_id: string | null;
  course_id: string | null;
  file_type: FileType;
  name: string;
  content: string | null;
  file_path: string | null;
  is_locked: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateFileDto {
  id?: string;
  node_id?: string;
  course_id?: string;
  file_type: FileType;
  name: string;
  content?: string;
  file_path?: string;
  is_locked?: boolean;
}

// ── Settings ──────────────────────────────────────────────────────────────────

export type GuidanceMode = 'strict' | 'balanced' | 'loose';

export type AppTheme = 'warm' | 'white' | 'dark';

export type AppBackgroundFit = 'cover' | 'contain' | 'center';

/** Reasoning intensity. Mapped per model: effort models → reasoning_effort low/medium/high;
 *  budget models → scaled budget_tokens; reasoner models → on/off only. */
export type ThinkingMode = 'off' | 'low' | 'medium' | 'high';

export type LearningSearchDepth = 'economy' | 'standard' | 'deep';

export type YouTubeCookiesMode = 'none' | 'safari' | 'chrome' | 'firefox' | 'edge' | 'brave' | 'cookies_file';

export interface Settings {
  id: number;
  default_provider: string;
  default_model: string;
  guidance_mode: GuidanceMode;
  font_size: number;
  remember_layout: boolean;
  theme: AppTheme;
  background_image_enabled: boolean;
  background_image_path: string | null;
  background_image_opacity: number;
  background_overlay_opacity: number;
  background_image_fit: AppBackgroundFit;
  ocr_worker_count: number;
  learning_search_depth: LearningSearchDepth;
  learning_search_max_queries: number;
  learning_search_max_pages: number;
  learning_search_auto_ingest: boolean;
  learning_search_allow_community: boolean;
  learning_search_use_exa: boolean;
  learning_search_tavily_advanced: boolean;
  youtube_proxy_url?: string | null;
  youtube_cookies_mode?: YouTubeCookiesMode;
  youtube_cookies_path?: string | null;
  youtube_cookies_profile?: string | null;
  created_at: string;
  updated_at: string;
}


// ── LLM ───────────────────────────────────────────────────────────────────────

/** Provider ID string — built-in values: anthropic | openai | gemini | grok | openrouter | deepseek | qwen | minimax | ollama */
export type LLMProvider = string;

// ── Provider / Model registry ─────────────────────────────────────────────────

export interface ProviderConfig {
  id: string;
  name: string;
  type: 'anthropic' | 'openai_compat' | 'ollama';
  baseUrl: string | null;
  apiKeyName: string | null;
  isBuiltin: boolean;
  enabled: boolean;
}

export interface ProviderModel {
  id: string;
  providerId: string;
  modelId: string;
  label: string;
  tag: string;
  isBuiltin: boolean;
  source: 'builtin' | 'fetched' | 'user';
  /** @deprecated Historical registry metadata only. Runtime capability checks use ModelCapabilityInfo from models.dev/local curated rules. */
  contextWindow: number | null;
  /** @deprecated Historical registry metadata only. Runtime capability checks use ModelCapabilityInfo from models.dev/local curated rules. */
  maxOutputTokens: number | null;
  /** @deprecated Historical registry metadata only. Runtime pricing should come from the capability cache where available. */
  inputPrice: number | null;
  /** @deprecated Historical registry metadata only. Runtime pricing should come from the capability cache where available. */
  outputPrice: number | null;
  /** @deprecated Historical registry metadata only. Runtime capability checks use ModelCapabilityInfo. */
  supportsVision: boolean | null;
  /** @deprecated Historical registry metadata only. Runtime capability checks use ModelCapabilityInfo. */
  supportsPdf: boolean | null;
  /** @deprecated Historical registry metadata only. Runtime capability checks use ModelCapabilityInfo. */
  supportsTools: boolean | null;
  /** @deprecated Historical registry metadata only. Runtime capability checks use ModelCapabilityInfo. */
  supportsReasoning: boolean | null;
  rawMetadataJson: string | null;
  /** @deprecated Manual capability overrides are no longer a primary capability source. */
  capabilityOverridesJson: string | null;
  lastSeenAt: string | null;
}

export interface CreateProviderDto {
  name: string;
  type: 'openai_compat' | 'ollama';
  baseUrl: string;
  apiKeyName?: string;
}

export interface UpdateModelDto {
  label?: string;
  tag?: string;
}

export interface ModelModalities {
  text: boolean;
  image: boolean;
  pdf: boolean;
  audio: boolean;
  video: boolean;
}

export interface AttachmentStrategies {
  image: 'native' | 'ocr_fallback' | 'unsupported';
  pdf: 'native' | 'extract_text' | 'unsupported';
  docx: 'extract_text' | 'unsupported';
  pptx: 'extract_text' | 'unsupported';
  xlsx: 'extract_text' | 'unsupported';
  rtf: 'extract_text' | 'unsupported';
  epub: 'extract_text' | 'unsupported';
  odt: 'extract_text' | 'unsupported';
  ods: 'extract_text' | 'unsupported';
  odp: 'extract_text' | 'unsupported';
  opml: 'extract_text' | 'unsupported';
  mm: 'extract_text' | 'unsupported';
  xmind: 'extract_text' | 'unsupported';
  audio: 'native' | 'transcribe' | 'unsupported';
  video: 'native' | 'transcribe' | 'unsupported';
}

export interface ModelCapabilityInfo {
  contextWindow: number;
  maxOutputTokens: number;
  inputModalities: ModelModalities;
  outputModalities: ModelModalities;
  attachmentStrategies: AttachmentStrategies;
  supportsVision: boolean;
  supportsPdf: boolean;
  supportsAudio: boolean;
  supportsVideo: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
  thinkingControl: 'none' | 'model' | 'budget' | 'effort';
  supportsStrictJson: boolean;
  supportsNativeSearch: boolean;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  costCny: number;
  /** Provider-reported cached prompt/input tokens when available. */
  inputCacheHitTokens?: number;
  /** Provider-reported non-cached prompt/input tokens when available. */
  inputCacheMissTokens?: number;
  /** True when provider did not return usage and Ulyzer fell back to a local estimate. */
  estimated?: boolean;
}

export interface StreamChunkPayload {
  sessionId: string;
  chunk: string;
  /** When true, this is a tool-execution progress message — rendered with lighter
   *  italic styling and NOT saved to the message history. */
  isProgress?: boolean;
  /** Provider reasoning/thinking stream. Rendered with progress/debug output. */
  isThinking?: boolean;
}

export interface StreamEndPayload {
  sessionId: string;
  usage: TokenUsage;
}

export interface StreamErrorPayload {
  sessionId: string;
  error: string;
  code?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

/** A tool the agent is about to run, streamed to the UI so it can show a tool card. */
export interface AgentToolCallPayload {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  /** Truncated, JSON-ish preview of the tool input. */
  inputPreview: string;
}

/** The outcome of a tool call, streamed to the UI to complete the tool card. */
export interface AgentToolResultPayload {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  status: 'completed' | 'failed';
  isError: boolean;
  durationMs?: number;
  /** Truncated preview of the tool result/error for display. */
  contentPreview: string;
}

// ── File attachment (chat) ────────────────────────────────────────────────────

export type ChatAttachmentStatus =
  | 'queued'
  | 'uploading'
  | 'processing'
  | 'ocr'
  | 'partial'
  | 'ready'
  | 'failed';

export interface FileAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path?: string;
  content?: string;   // pre-read text content (for text/code files)
  base64?: string;    // pre-read base64 (for image files)
  sourceId?: string;  // prepared source library record for this chat attachment
  status?: ChatAttachmentStatus;
  progressCurrent?: number;
  progressTotal?: number;
  message?: string;
  processingError?: string | null;
}

export interface ChatAttachmentPrepareRequest {
  attachmentId: string;
  courseId: string;
  nodeId?: string;
  threadId?: string;
  sessionId?: string;
  agentType: AgentType;
  name: string;
  mimeType?: string;
  size: number;
  filePath?: string;
  originalPath?: string;
  content?: string;
  base64?: string;
}

export interface ChatAttachmentStatusRequest {
  attachmentId: string;
  sourceId: string;
}

// ── Chat message ──────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  attachments?: FileAttachment[];
  /** Legacy free-form tool/generation trace — fallback "查看思路" for messages without structured diagnostics. */
  progress?: string;
  /** Provider reasoning/thinking stream — rendered as a dedicated collapsible thinking block. */
  thinking?: string;
  /** Structured developer-diagnostic records — the unified "查看思路" view. */
  diagnostics?: DiagnosticRecord[];
  /** Files this turn generated, rendered as clickable artifact cards. */
  artifacts?: MessageArtifact[];
}

/** A file produced during a chat turn, surfaced as a clickable card under the answer. */
export interface MessageArtifact {
  filePath: string;
  folderName: FolderKey;
  nodeId: string;
}

// ── App updates ────────────────────────────────────────────────────────────────

export interface UpdateCheckOptions {
  /** Include pre-release (alpha/beta) GitHub releases when picking the latest. */
  includePrerelease?: boolean;
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseNotes?: string;
  publishedAt?: string;
  prerelease?: boolean;
  /** Set when the check could not complete; the UI stays silent except on manual checks. */
  error?: 'offline' | 'rate_limited' | 'unknown' | null;
}

export interface ChatMessageEditPayload {
  content: string;
  attachments: FileAttachment[];
}

// ── Storage management ───────────────────────────────────────────────────────

export type StorageAreaKey = 'library' | 'content' | 'ocr_cache' | 'runtime_cache';

export interface StorageAreaStat {
  key: StorageAreaKey;
  label: string;
  path: string;
  bytes: number;
  exists: boolean;
}

export interface StorageStats {
  areas: StorageAreaStat[];
  totalBytes: number;
  orphanAssetCount: number;
  pendingCleanupCount: number;
  failedCleanupCount: number;
}

export interface StorageCleanupResult {
  removedCount: number;
  freedBytes: number;
  retriedCount: number;
  resolvedCount: number;
  failedCount: number;
  errors: string[];
}

// ── Agent requests ────────────────────────────────────────────────────────────

export type AgentType = 'main_tutor' | 'sub_tutor';

export interface AgentChatRequest {
  agentType: AgentType;
  courseId: string;
  nodeId?: string;
  threadId?: string;
  sessionId: string;
  provider: LLMProvider;
  model: string;
  userMessage: string;
  /** Legacy renderer-provided history. Prefer threadId so the main process can build full context. */
  messages?: LLMMessage[];
  attachments?: FileAttachment[];
  /** User-selected source/search policy for this message. */
  searchMode?: SearchMode;
  /** User-selected thinking/reasoning policy for this message. */
  thinkingMode?: ThinkingMode;
  /** Normalized UI/agent locale used to instruct AI and name generated artifacts. */
  language?: SupportedLocale;
  /** Current file focused in the node workspace editor, if any. */
  activeFile?: ActiveNodeFileContext;
  /** When enabled, the main process owns user/assistant message persistence for this run. */
  persistence?: {
    mode: 'backend';
    userMessageId?: string;
    assistantMessageId?: string;
    persistUserMessage?: boolean;
    persistAssistantMessage?: boolean;
  };
}

/**
 * One structured developer-diagnostic record. Numeric/enum fields are
 * language-agnostic (the client localizes labels at view time); `text` carries
 * pre-localized narration (workflow detail). Persisted as JSON on the message and
 * streamed live via the `diagnostic` run event.
 */
export type DiagnosticKind =
  | 'run.start'
  | 'run.done'
  | 'turn'
  | 'tool'
  | 'decision'
  | 'compaction'
  | 'workflow.phase'
  | 'note'
  | 'error';

export interface DiagnosticRecord {
  /** Monotonic elapsed ms since run start. */
  t: number;
  kind: DiagnosticKind;
  source?: 'loop' | 'workflow' | 'agent';
  turn?: number;
  stopReason?: string;
  model?: string;
  provider?: string;
  toolName?: string;
  status?: 'running' | 'completed' | 'failed';
  durationMs?: number;
  usageIn?: number;
  usageOut?: number;
  costCny?: number;
  cacheHitTokens?: number;
  ctxUsed?: number;
  ctxLimit?: number;
  messageCount?: number;
  workflowId?: string;
  phase?: string;
  decision?: string;
  beforeMessages?: number;
  afterMessages?: number;
  maxTurns?: number;
  hardMaxTurns?: number;
  turns?: number;
  runStatus?: string;
  /** Pre-localized narration / detail (workflow traces, notes). */
  text?: string;
  inputSummary?: string;
  resultSummary?: string;
  isError?: boolean;
}

export type ChatRunEventType =
  | 'run.started'
  | 'message.user.persisted'
  | 'message.delta'
  | 'progress.delta'
  | 'thinking.delta'
  | 'diagnostic'
  | 'phase'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'artifact.created'
  | 'message.assistant.persisted'
  | 'run.completed'
  | 'run.failed'
  | 'run.aborted'
  | 'run.interrupted';

export interface ChatRunEvent {
  type: ChatRunEventType;
  runId: string;
  sessionId: string;
  agentType?: AgentType;
  courseId?: string;
  nodeId?: string;
  threadId?: string;
  messageId?: string;
  role?: 'user' | 'assistant';
  chunk?: string;
  toolName?: string;
  toolCallId?: string;
  status?: 'started' | 'completed' | 'failed' | 'aborted' | 'interrupted';
  durationMs?: number;
  artifactType?: 'file' | 'dag';
  artifactId?: string;
  filePath?: string;
  folderName?: string;
  usage?: TokenUsage;
  error?: string;
  metadata?: Record<string, unknown>;
  /** Structured developer-diagnostic record (for `diagnostic` events). */
  diagnostic?: DiagnosticRecord;
  /** Localized current-phase hint for the user-facing status line (for `phase` events). */
  phase?: string;
}

export interface AgentContextStatusRequest {
  agentType: AgentType;
  courseId: string;
  nodeId?: string;
  threadId?: string | null;
  messages?: ChatMessage[];
  provider: LLMProvider;
  model: string;
  currentUserMessage?: string;
  searchMode?: SearchMode;
  thinkingMode?: ThinkingMode;
  language?: string;
  activeFile?: ActiveNodeFileContext;
}

export interface AgentContextStatus {
  /** Input fullness: inputTokens / inputBudget, as a 0–100 percent. */
  percent: number;
  /** Estimated input tokens consumed by the prompt (system + tools + history + draft). */
  inputTokens: number;
  /** Usable input budget = context window minus reserved output/thinking/safety. */
  inputBudget: number;
  /** Full model context window, for tooltip context. */
  contextWindow: number;
}

export type MaterialType = 'theory' | 'practice' | 'answer';

export interface RagChunk {
  id: string;
  fileId: string;
  nodeId: string;
  chunkIndex: number;
  content: string;
  sourceName: string;
}

// ── Search / Source library ──────────────────────────────────────────────────

export type SearchMode = 'auto' | 'web' | 'library' | 'off';

export type SourceKind = 'web' | 'upload' | 'generated';
export type SourceScope = 'main_private' | 'node_private';
export type SourceUsage = 'planning_only' | 'handoff_candidate' | 'handoff_selected' | 'node_local';
export type SourceOrigin = 'user_import' | 'chat_attachment' | 'web_collected' | 'ai_generated';

export type ResearchTaskType = 'roadmap' | 'theory' | 'practice' | 'answer' | 'chat' | 'freshness';

export type TrustLevel = 'official' | 'academic' | 'educational' | 'community' | 'library' | 'unknown';

export type LearningShape =
  | 'knowledge_understanding'
  | 'skill_operation'
  | 'creative_project'
  | 'tool_software'
  | 'game_system'
  | 'social_behavior'
  | 'physical_training'
  | 'exam_course'
  | 'interest_exploration'
  | 'mixed';

export type LearningSourceType =
  | 'official_doc'
  | 'course_syllabus'
  | 'textbook_or_notes'
  | 'tutorial'
  | 'worked_example'
  | 'exercise_or_assignment'
  | 'project_or_case'
  | 'rubric_or_assessment'
  | 'common_mistake'
  | 'tool_material'
  | 'safety_or_constraint'
  | 'community_experience'
  | 'video_or_transcript'
  | 'reference_index'
  | 'unknown';

export interface LearningSourceSlot {
  id: string;
  name: string;
  purpose: string;
  mustHave: boolean;
  priority: 'high' | 'medium' | 'low';
  queryIntents: string[];
  qualityCriteria: string[];
  acceptableSourceTypes: LearningSourceType[];
}

export interface LearningSourcePlan {
  id: string;
  courseId: string;
  nodeId?: string | null;
  taskType: ResearchTaskType;
  userGoal: string;
  learningShape: LearningShape;
  planningRationale: string;
  slots: LearningSourceSlot[];
  createdAt: string;
}

export interface LearningSearchCandidate {
  slotId: string;
  query: string;
  title: string;
  url: string;
  excerpt: string;
  provider: 'tavily' | 'exa' | 'openalex' | 'semantic_scholar' | 'oer' | 'manual';
  rawScore: number;
  publishedDate?: string;
}

export interface LearningSourceEvaluation {
  sourceId?: string;
  url: string;
  slotId: string;
  sourceType: LearningSourceType;
  trustLevel: TrustLevel;
  qualityScore: number;
  whyUseful: string;
  limitations: string;
  shouldIngest: boolean;
  enabledByDefault: boolean;
  mainEvidence: boolean;
}

export interface SourceLearningMetadata {
  sourceId: string;
  courseId: string;
  slotId: string;
  slotName?: string | null;
  sourceType: LearningSourceType;
  qualityScore: number;
  whyUseful?: string | null;
  limitations?: string | null;
  mainEvidence: boolean;
  ingestPolicy?: string | null;
  planId?: string | null;
  query?: string | null;
  updatedAt?: string | null;
}

export type SourceEmbeddingStatus = 'pending' | 'ready' | 'failed' | 'skipped' | 'lexical_only';
export type SourceProcessingState = 'pending' | 'partial' | 'ready' | 'failed' | 'limited';
export type SourceSemanticProfileStatus = 'pending' | 'ready' | 'failed' | 'skipped';

export interface SourceSemanticProfile {
  sourceId: string;
  status: SourceSemanticProfileStatus;
  summary?: string | null;
  concepts: string[];
  suitableFor: string[];
  difficulty?: string | null;
  contentTypes: string[];
  qualityNotes?: string | null;
  nodeHints: string[];
  model?: string | null;
  updatedAt?: string | null;
  error?: string | null;
}

export interface EvidenceCoverage {
  required: string[];
  covered: string[];
  missing: string[];
}

export interface ResearchBudgetUsed {
  queries: number;
  pagesFetched: number;
  reflectionSearches: number;
  llmReranks: number;
}

export interface SourceRecord {
  id: string;
  courseId: string;
  nodeId: string | null;
  threadId?: string | null;
  sessionId?: string | null;
  scope: SourceScope;
  displayScope?: SourceScope;
  usage: SourceUsage;
  kind: SourceKind;
  origin: SourceOrigin;
  title: string;
  remark?: string | null;
  url: string | null;
  originalPath?: string | null;
  filePath: string | null;
  mediaType?: string | null;
  host: string | null;
  trustScore: number;
  enabled: boolean;
  linkedToNode?: boolean;
  hitCount?: number;
  lastHitAt?: string | null;
  embeddingStatus?: SourceEmbeddingStatus;
  processingState?: SourceProcessingState;
  processingError?: string | null;
  chunkCount?: number;
  documentUnitCount?: number;
  documentBlockCount?: number;
  documentTextUnitCount?: number;
  documentOcrPendingCount?: number;
  documentOcrFailedCount?: number;
  documentPageAssetCount?: number;
  exerciseCount?: number;
  usableExerciseCount?: number;
  exerciseWithAnswerCount?: number;
  exerciseWithSolutionCount?: number;
  semanticProfile?: SourceSemanticProfile | null;
  learningMetadata?: SourceLearningMetadata[];
  lastIndexedAt?: string | null;
  createdAt: string;
}

export interface NodeSourceLink {
  id: string;
  courseId: string;
  nodeId: string;
  sourceId: string;
  enabled: boolean;
  reason?: string | null;
  createdAt: string;
}

export interface SourceLinkCandidatesRequest {
  courseId: string;
  nodeId: string;
  query?: string;
  limit?: number;
}

export interface SourceLinkAddRequest {
  courseId: string;
  nodeId: string;
  sourceIds: string[];
  reason?: string;
}

export interface SourceLinkRemoveRequest {
  courseId: string;
  nodeId: string;
  sourceId: string;
}

export interface SourceLinkUpdateRequest {
  courseId: string;
  nodeId: string;
  sourceId: string;
  enabled: boolean;
}

export interface EvidenceChunk {
  chunkId?: string;
  sourceId: string;
  text: string;
  locator?: string;
  score: number;
  sourceKind: SourceKind;
  slot?: string;
  trustLevel?: TrustLevel;
  headingPath?: string[];
  page?: number;
  retrievalMethod?: 'lexical' | 'vector' | 'hybrid' | 'web';
  supportType?: 'fact' | 'example' | 'exercise_pattern' | 'rationale' | 'background';
}

export interface EvidencePack {
  query: string;
  taskType: ResearchTaskType;
  sources: SourceRecord[];
  chunks: EvidenceChunk[];
  coverage: EvidenceCoverage;
  budgetUsed: ResearchBudgetUsed;
  warnings: string[];
}

export interface SourceImportUrlRequest {
  courseId: string;
  nodeId?: string;
  threadId?: string;
  sessionId?: string;
  scope?: SourceScope;
  usage?: SourceUsage;
  origin?: SourceOrigin;
  url: string;
  title?: string;
  remark?: string;
  searchExcerpt?: string;
  trustScore?: number;
  query?: string;
}

export interface SourceImportTextRequest {
  courseId: string;
  nodeId?: string;
  threadId?: string;
  sessionId?: string;
  scope?: SourceScope;
  usage?: SourceUsage;
  origin?: SourceOrigin;
  title: string;
  remark?: string;
  content: string;
  url?: string;
  originalPath?: string;
  filePath?: string;
  mimeType?: string;
  processingState?: SourceProcessingState;
  processingError?: string | null;
}

export interface SourceImportFileRequest {
  courseId: string;
  nodeId?: string;
  threadId?: string;
  sessionId?: string;
  scope?: SourceScope;
  usage?: SourceUsage;
  origin?: SourceOrigin;
  title: string;
  remark?: string;
  originalPath?: string;
  filePath?: string;
  base64?: string;
  mimeType: string;
}

export interface LocalFilePickRequest {
  accept?: string;
  multiple?: boolean;
  title?: string;
  importAs?: 'background-image';
}

export interface PickedLocalFile {
  path: string;
  name: string;
  size: number;
  mimeType: string;
}

export interface YtDlpStatus {
  available: boolean;
  version?: string;
  path?: string;
  installPath: string;
  error?: string;
}

export interface YtDlpInstallResult extends YtDlpStatus {
  downloaded: boolean;
}

export interface FfmpegStatus {
  available: boolean;
  path?: string;
  error?: string;
}

export interface WhisperStatus {
  available: boolean;
  version?: string;
  /** mlx-whisper only runs on Apple Silicon macOS; false elsewhere. */
  platformSupported: boolean;
  error?: string;
}

export interface WhisperInstallResult extends WhisperStatus {
  installed: boolean;
}

export interface SourceListRequest {
  courseId: string;
  nodeId?: string;
  agentType: AgentType;
  scope?: SourceScope;
}

export interface SourceSearchRequest {
  courseId: string;
  nodeId?: string;
  agentType: AgentType;
  scope?: SourceScope;
  query: string;
  limit?: number;
}

export interface SourceSearchResult {
  source: SourceRecord;
  chunks: EvidenceChunk[];
}

export type SourceExerciseStatus = 'usable' | 'needs_review' | 'blocked';
export type SourceExerciseLicenseStatus = 'open' | 'user_import' | 'unknown' | 'risky';

export interface SourceExercise {
  id: string;
  sourceId: string;
  courseId: string;
  nodeId: string | null;
  sourceTitle?: string;
  sourceUrl?: string | null;
  sourceKind?: SourceKind;
  itemType: string;
  difficulty: Difficulty | 'unknown';
  cognitiveAction: string;
  stemMd: string;
  choices: string[];
  answerMd?: string | null;
  solutionMd?: string | null;
  hints: string[];
  kcTags: string[];
  sourceLocator?: string | null;
  sourcePage?: number | null;
  licenseStatus: SourceExerciseLicenseStatus;
  qualityScore: number;
  extractionConfidence: number;
  duplicateHash: string;
  status: SourceExerciseStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SourceExerciseListRequest {
  courseId: string;
  nodeId?: string;
  agentType: AgentType;
  scope?: SourceScope;
  sourceId?: string;
  query?: string;
  onlyUsable?: boolean;
  requireAnswer?: boolean;
  itemType?: string;
  difficulty?: Difficulty | 'unknown';
  status?: SourceExerciseStatus;
  limit?: number;
}

export interface SourceExerciseReextractRequest {
  sourceId: string;
  force?: boolean;
}

export interface SourceExerciseUpdateRequest {
  exerciseId: string;
  status?: SourceExerciseStatus;
}

export interface SourceExerciseExtractionResult {
  sourceId: string;
  extracted: number;
  usable: number;
  withAnswer: number;
  withSolution: number;
}

export interface SourceLibraryStats {
  totalSources: number;
  enabledSources: number;
  chunkCount: number;
  exerciseCount: number;
  usableExerciseCount: number;
  exerciseWithAnswerCount: number;
  exerciseWithSolutionCount: number;
  semanticReady: number;
  lexicalOnly: number;
  pendingIndex: number;
  failedIndex: number;
  duplicateHostSources: number;
  duplicateHostCount: number;
  duplicateTitleCount: number;
  lowQualitySources: number;
  neverHitSources: number;
  archiveCandidateCount: number;
  archiveCandidateTitles: string[];
  warnings: string[];
}

export interface SourceStatsRequest {
  courseId: string;
  nodeId?: string;
  agentType: AgentType;
  scope?: SourceScope;
}

export interface SourceReindexRequest {
  sourceId: string;
  force?: boolean;
}

export interface NodeHandoff {
  nodeId: string;
  courseId: string;
  taskDefinition: string | null;
  scopeBoundary: string | null;
  rationale: string | null;
  recommendedSourceIds: string[];
  suggestedQueries: string[];
  generationConstraints: string[];
  coverageRequirements: string[];
  createdAt: string;
  updatedAt: string;
}

export const FOLDER_KEYS = [
  'outline',
  'theory',
  'practice',
  'answer',
  'notes',
  'feynman',
] as const;

export type FolderKey = typeof FOLDER_KEYS[number];

export type GenerateFolder = Extract<FolderKey, 'theory' | 'practice' | 'answer' | 'notes'>;

export const OUTLINE_VERSION_KEYS = ['latest', 'v1', 'v2', 'v3'] as const;

export type OutlineVersionSelection = typeof OUTLINE_VERSION_KEYS[number];

export const GENERATE_FOLDER_KEYS = [
  'theory',
  'practice',
  'answer',
  'notes',
] as const satisfies readonly GenerateFolder[];

export interface AgentGenerateRequest {
  nodeId: string;
  courseId: string;
  sessionId: string;
  provider: LLMProvider;
  model: string;
  targetFolder: GenerateFolder;
  userMessage: string;
}

export interface FeynmanChecklistRequest {
  nodeId: string;
  courseId: string;
  sessionId: string;
  provider: LLMProvider;
  model: string;
  userMessage: string;
}

// ── Agent Loop / Intent Clarification ────────────────────────────────────────

export interface ClarifyResult {
  needsClarification: boolean;
  questions: string[];
}

export interface AgentClarifyRequest {
  agentType: 'planner' | 'tutor';
  userMessage: string;
  messages?: LLMMessage[];
  provider: LLMProvider;
  model: string;
  sessionId?: string;
  courseId?: string;
  threadId?: string | null;
}

// ── Web search ────────────────────────────────────────────────────────────────

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
  trustScore: number;
  publishedDate?: string;
}

export interface VideoSearchResult {
  title: string;
  videoId: string;
  url: string;
  channelTitle: string;
  description: string;
}

// ── File system workspace ─────────────────────────────────────────────────────

export interface FsEntry {
  name: string;
  path: string;
  type: 'file' | 'folder';
  children?: FsEntry[];
}

export interface OpenedFile {
  id: string;
  name: string;
  path: string;
  content: string;
  lastSavedContent?: string;
  isDirty?: boolean;
  isFocused?: boolean;
  externalUpdatePending?: boolean;
}

export interface ActiveNodeFileContext {
  /** Absolute path as opened by the renderer; tools should prefer relativePath. */
  path: string;
  /** Node-workspace relative path, suitable for list_node_files/read_file/update_file/edit_markdown_file. */
  relativePath?: string;
  name: string;
  isMarkdown?: boolean;
  /** Small preview of the currently opened editor buffer. It may include unsaved edits. */
  contentPreview?: string;
}

// ── File-generated event payload ──────────────────────────────────────────────

export interface FileGeneratedPayload {
  sessionId: string;
  filePath: string;
  folderName: FolderKey;
  nodeId: string;
  usage: TokenUsage;
}

// ── Mastery Checklist ─────────────────────────────────────────────────────────

export interface ChecklistItem {
  id: string;
  node_id: string;
  concept: string;
  verification_question: string;
  required: boolean;
  created_at: string;
}

export interface ChecklistCoverage {
  covered: string[];    // concepts explicitly addressed in the review
  missing: string[];    // required concepts not covered
  coverageRate: number; // 0–1
}

// ── Chat thread ───────────────────────────────────────────────────────────────

export interface ChatThread {
  id: string;
  courseId: string;
  nodeId: string | null;
  agent: AgentType;
  title: string;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
}

// ── Outline version management ────────────────────────────────────────────────

export interface KcCoverageStatus {
  /** Current highest outline version (0 = no outline). */
  version: number;
  allKcIds: string[];
  coveredKcIds: string[];
  uncoveredKcIds: string[];
  isFullyCovered: boolean;
}

export interface OutlineStatusRequest {
  courseId: string;
  nodeId: string;
}

// ── IPC response wrapper ──────────────────────────────────────────────────────

export interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
