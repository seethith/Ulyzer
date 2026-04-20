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
  total_hours_est: number;
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

export type NodeType = 'main' | 'boss' | 'drill';
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
  hours_est: number;
  difficulty: Difficulty;
  prerequisites: string[];
  required_tools: string[];
  required_cost: RequiredCost;
  position_x: number;
  position_y: number;
  bloom_target: BloomTarget | null;
  learning_type: LearningType | null;
  priority: NodePriority | null;
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
  hours_est?: number;
  difficulty?: Difficulty;
  prerequisites?: string[];
  required_tools?: string[];
  required_cost?: RequiredCost;
  position_x?: number;
  position_y?: number;
  bloom_target?: BloomTarget;
  learning_type?: LearningType;
  priority?: NodePriority;
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

// ── Notebook ──────────────────────────────────────────────────────────────────

export interface Notebook {
  id: string;
  node_id: string;
  course_id: string;
  title: string;
  content: string;
  review_content: string;
  review_submitted: boolean;
  created_at: string;
  updated_at: string;
}

export interface SaveNotebookDto {
  title?: string;
  content?: string;
  review_content?: string;
  review_submitted?: boolean;
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

export interface Settings {
  id: number;
  default_provider: string;
  default_model: string;
  guidance_mode: GuidanceMode;
  font_size: number;
  remember_layout: boolean;
  theme: AppTheme;
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
}

export interface CreateProviderDto {
  name: string;
  type: 'openai_compat' | 'ollama';
  baseUrl: string;
  apiKeyName?: string;
}

export interface CreateModelDto {
  providerId: string;
  modelId: string;
  label: string;
  tag?: string;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMStreamRequest {
  sessionId: string;
  provider: LLMProvider;
  model: string;
  messages: LLMMessage[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  costCny: number;
}

export interface StreamChunkPayload {
  sessionId: string;
  chunk: string;
  /** When true, this is a tool-execution progress message — rendered with lighter
   *  italic styling and NOT saved to the message history. */
  isProgress?: boolean;
}

export interface StreamEndPayload {
  sessionId: string;
  usage: TokenUsage;
}

export interface StreamErrorPayload {
  sessionId: string;
  error: string;
}

// ── File attachment (chat) ────────────────────────────────────────────────────

export interface FileAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path?: string;
  content?: string;   // pre-read text content (for text/code files)
  base64?: string;    // pre-read base64 (for image files)
}

// ── Chat message ──────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  attachments?: FileAttachment[];
  /** Collapsible generation progress/reasoning — shown as "查看思路" toggle */
  progress?: string;
}

// ── Agent requests ────────────────────────────────────────────────────────────

export type AgentType = 'main_tutor' | 'sub_tutor';

export interface AgentPlanRequest {
  courseId: string;
  sessionId: string;
  provider: LLMProvider;
  model: string;
  userMessage: string;
  /** Recent conversation history — used as additional context for DAG generation */
  messages?: LLMMessage[];
}

export interface AgentChatRequest {
  agentType: AgentType;
  courseId: string;
  nodeId?: string;
  sessionId: string;
  provider: LLMProvider;
  model: string;
  userMessage: string;
  messages: LLMMessage[];
  attachments?: FileAttachment[];
  /** User explicitly toggled web search on for this message */
  webSearchEnabled?: boolean;
  /** UI language — used to instruct AI to respond in the correct language */
  language?: string;
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

export type GenerateFolder = 'theory' | 'practice' | 'answer' | 'notes';

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
}

// ── File-generated event payload ──────────────────────────────────────────────

export interface FileGeneratedPayload {
  sessionId: string;
  filePath: string;
  folderName: string;
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

export interface OutlineGenerateNextRequest {
  courseId: string;
  nodeId: string;
  sessionId: string;
  provider: LLMProvider;
  model: string;
}

export interface TopicGenerateRequest {
  courseId: string;
  nodeId: string;
  kcId: string;
  kcName: string;
  sessionId: string;
  provider: LLMProvider;
  model: string;
}

// ── IPC response wrapper ──────────────────────────────────────────────────────

export interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
