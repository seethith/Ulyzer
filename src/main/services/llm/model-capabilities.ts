/**
 * Model capability registry.
 *
 * Single source of truth for what each model supports: vision, PDF, audio,
 * video, tool calling, strict JSON, native search, thinking style, prompt
 * cache mode, context window, max output tokens.
 *
 * Used by:
 *   - agent.ipc.ts to gate attachment processing
 *   - token-budget.ts to size context per model
 *   - providers/{claude,openai}.ts to translate `thinkingBudget` → native API
 *   - response-format / strict JSON code paths
 */
import { readCachedModelCapability } from './model-capability-cache';
import type { ModelCapabilityInfo, ThinkingMode } from '@shared/types';

export type ThinkingStyle =
  | 'none'              // No thinking mode
  | 'anthropic'         // Claude: top-level thinking parameter
  | 'reasoner-model'    // DeepSeek R1: model is reasoning-only, output in reasoning_content
  | 'extra-qwen'        // Qwen3: extra_body { enable_thinking, thinking_budget }
  | 'extra-gemini'      // Gemini 2.5: extra_body { thinking: { budget_tokens } }
  | 'extra-grok'        // Grok mini: extra_body { reasoning_effort }
  | 'openai-effort';    // OpenAI o1/o3: { reasoning_effort }

export type PromptCacheMode =
  | 'none'                 // No caching
  | 'auto'                 // Server-side automatic (OpenAI, DeepSeek, Qwen, Grok)
  | 'explicit-anthropic';  // Requires cache_control markers (Claude)

export type ThinkingControl = ModelCapabilityInfo['thinkingControl'];

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

export interface ModelCapability {
  /** Maximum input + output tokens combined */
  contextWindow: number;
  /** Maximum tokens the model can emit in one response */
  maxOutputTokens: number;
  inputModalities?: ModelModalities;
  outputModalities?: ModelModalities;
  attachmentStrategies?: AttachmentStrategies;
  supportsVision: boolean;
  supportsPdf: boolean;
  supportsAudio: boolean;
  supportsVideo: boolean;
  supportsTools: boolean;
  /** Native strict JSON schema mode (response_format: json_schema with strict=true) */
  supportsStrictJson: boolean;
  /** Provider-native web search / grounding (not external Tavily/Exa) */
  supportsNativeSearch: boolean;
  /** Whether the model/API exposes thinking or reasoning content/controls. */
  supportsReasoning?: boolean;
  thinkingStyle: ThinkingStyle;
  promptCache: PromptCacheMode;
}

export const DEFAULT_CAPABILITY: ModelCapability = {
  contextWindow:        128_000,
  maxOutputTokens:      16_384,
  inputModalities:      { text: true, image: false, pdf: false, audio: false, video: false },
  outputModalities:     { text: true, image: false, pdf: false, audio: false, video: false },
  attachmentStrategies: {
    image: 'ocr_fallback',
    pdf:   'extract_text',
    docx:  'extract_text',
    pptx:  'extract_text',
    xlsx:  'extract_text',
    rtf:   'extract_text',
    epub:  'extract_text',
    odt:   'extract_text',
    ods:   'extract_text',
    odp:   'extract_text',
    opml:  'extract_text',
    mm:    'extract_text',
    xmind: 'extract_text',
    audio: 'transcribe',
    video: 'transcribe',
  },
  supportsVision:       false,
  supportsPdf:          false,
  supportsAudio:        false,
  supportsVideo:        false,
  supportsTools:        true,
  supportsReasoning:    false,
  supportsStrictJson:   false,
  supportsNativeSearch: false,
  thinkingStyle:        'none',
  promptCache:          'auto',
};

// ── Capability tables, keyed by model name ─────────────────────────────────

const CLAUDE_4_BASE: ModelCapability = {
  contextWindow:        200_000,
  maxOutputTokens:      64_000,
  supportsVision:       true,
  supportsPdf:          true,
  supportsAudio:        false,
  supportsVideo:        false,
  supportsTools:        true,
  supportsStrictJson:   false,  // uses tool calling for structured output
  supportsNativeSearch: false,
  thinkingStyle:        'anthropic',
  promptCache:          'explicit-anthropic',
};

const CLAUDE_HAIKU_BASE: ModelCapability = {
  ...CLAUDE_4_BASE,
  maxOutputTokens:      8192,
  thinkingStyle:        'none',  // haiku does not currently support extended thinking
};

const GPT_4O_BASE: ModelCapability = {
  contextWindow:        128_000,
  maxOutputTokens:      16_384,
  supportsVision:       true,
  supportsPdf:          true,    // via Files API (not yet implemented; cap reflects model ability)
  supportsAudio:        false,   // gpt-4o-audio is a separate model id
  supportsVideo:        false,
  supportsTools:        true,
  supportsStrictJson:   true,
  supportsNativeSearch: false,   // requires Responses API, not Chat Completions
  thinkingStyle:        'none',
  promptCache:          'auto',
};

const O_SERIES_BASE: ModelCapability = {
  contextWindow:        200_000,
  maxOutputTokens:      100_000,
  supportsVision:       true,
  supportsPdf:          true,
  supportsAudio:        false,
  supportsVideo:        false,
  supportsTools:        true,
  supportsStrictJson:   true,
  supportsNativeSearch: false,
  thinkingStyle:        'openai-effort',
  promptCache:          'auto',
};

const DEEPSEEK_CHAT: ModelCapability = {
  contextWindow:        64_000,
  maxOutputTokens:      8192,
  supportsVision:       false,
  supportsPdf:          false,
  supportsAudio:        false,
  supportsVideo:        false,
  supportsTools:        true,
  supportsStrictJson:   false,  // supports JSON mode but not strict schema
  supportsNativeSearch: false,
  thinkingStyle:        'none',
  promptCache:          'auto',
};

const DEEPSEEK_REASONER: ModelCapability = {
  ...DEEPSEEK_CHAT,
  supportsTools:        false,  // R1 does not currently support tool calling
  thinkingStyle:        'reasoner-model',
};

const DEEPSEEK_V4_BASE: ModelCapability = {
  ...DEEPSEEK_CHAT,
  contextWindow:        1_000_000,
  maxOutputTokens:      384_000,
  supportsReasoning:    true,
  thinkingStyle:        'reasoner-model',
};

const QWEN3_BASE: ModelCapability = {
  contextWindow:        131_072,
  maxOutputTokens:      8192,
  supportsVision:       false,
  supportsPdf:          false,
  supportsAudio:        false,
  supportsVideo:        false,
  supportsTools:        true,
  supportsStrictJson:   false,
  supportsNativeSearch: false,
  thinkingStyle:        'extra-qwen',
  promptCache:          'auto',
};

const QWEN_2_5_BASE: ModelCapability = {
  ...QWEN3_BASE,
  thinkingStyle:        'none',
};

const GEMINI_2_5_BASE: ModelCapability = {
  contextWindow:        1_048_576,
  maxOutputTokens:      65_536,
  supportsVision:       true,
  supportsPdf:          true,
  supportsAudio:        true,
  supportsVideo:        true,
  supportsTools:        true,
  supportsStrictJson:   true,
  supportsNativeSearch: true,    // Google search grounding
  thinkingStyle:        'extra-gemini',
  promptCache:          'auto',  // limited via OpenAI-compat endpoint
};

const GEMINI_2_0_BASE: ModelCapability = {
  ...GEMINI_2_5_BASE,
  maxOutputTokens:      8192,
  thinkingStyle:        'none',
};

const GEMINI_1_5_BASE: ModelCapability = {
  contextWindow:        2_000_000,
  maxOutputTokens:      8192,
  supportsVision:       true,
  supportsPdf:          true,
  supportsAudio:        true,
  supportsVideo:        true,
  supportsTools:        true,
  supportsStrictJson:   true,
  supportsNativeSearch: true,
  thinkingStyle:        'none',
  promptCache:          'auto',
};

const GROK_3: ModelCapability = {
  contextWindow:        131_072,
  maxOutputTokens:      8192,
  supportsVision:       true,
  supportsPdf:          false,
  supportsAudio:        false,
  supportsVideo:        false,
  supportsTools:        true,
  supportsStrictJson:   true,
  supportsNativeSearch: false,
  thinkingStyle:        'none',
  promptCache:          'auto',
};

const GROK_3_MINI: ModelCapability = {
  ...GROK_3,
  thinkingStyle:        'extra-grok',
};

const PERPLEXITY_BASE: ModelCapability = {
  contextWindow:        128_000,
  maxOutputTokens:      4096,
  supportsVision:       false,
  supportsPdf:          false,
  supportsAudio:        false,
  supportsVideo:        false,
  supportsTools:        false,
  supportsStrictJson:   false,
  supportsNativeSearch: true,    // built-in
  thinkingStyle:        'none',
  promptCache:          'auto',
};

export const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  // ── Claude ──────────────────────────────────────────────────────────────
  'claude-sonnet-4-6':          CLAUDE_4_BASE,
  'claude-opus-4-6':            CLAUDE_4_BASE,
  'claude-sonnet-4-5-20251001': CLAUDE_4_BASE,
  'claude-opus-4-5-20251001':   CLAUDE_4_BASE,
  'claude-haiku-4-5-20251001':  CLAUDE_HAIKU_BASE,

  // ── OpenAI ──────────────────────────────────────────────────────────────
  'gpt-4o':              GPT_4O_BASE,
  'gpt-4o-mini':         GPT_4O_BASE,
  'o1':                  O_SERIES_BASE,
  'o3-mini':             { ...O_SERIES_BASE, supportsVision: false, supportsPdf: false },

  // ── DeepSeek ────────────────────────────────────────────────────────────
  'deepseek-chat':       DEEPSEEK_CHAT,
  'deepseek-reasoner':   DEEPSEEK_REASONER,
  'deepseek-v4':         DEEPSEEK_V4_BASE,

  // ── Grok ────────────────────────────────────────────────────────────────
  'grok-3':              GROK_3,
  'grok-3-mini':         GROK_3_MINI,

  // ── Gemini 2.5 / 2.0 / 1.5 ─────────────────────────────────────────────
  'gemini-2.5-pro':                    GEMINI_2_5_BASE,
  'gemini-2.5-flash':                  GEMINI_2_5_BASE,
  'gemini-2.5-flash-preview-04-17':    GEMINI_2_5_BASE,
  'gemini-2.0-flash':                  GEMINI_2_0_BASE,
  'gemini-2.0-flash-lite':             GEMINI_2_0_BASE,
  'gemini-2.0-flash-thinking-exp':     { ...GEMINI_2_0_BASE, thinkingStyle: 'extra-gemini' },
  'gemini-1.5-pro-002':                GEMINI_1_5_BASE,
  'gemini-1.5-flash-002':              GEMINI_1_5_BASE,
  'gemini-1.5-flash-8b':               GEMINI_1_5_BASE,

  // ── Qwen 2.5 ────────────────────────────────────────────────────────────
  'qwen-turbo':          QWEN_2_5_BASE,
  'qwen-plus':           QWEN_2_5_BASE,
  'qwen-max':            QWEN_2_5_BASE,

  // ── Qwen 3 ──────────────────────────────────────────────────────────────
  'qwen3-235b-a22b':     QWEN3_BASE,
  'qwen3-32b':           QWEN3_BASE,
  'qwen3-14b':           QWEN3_BASE,
  'qwen3-8b':            QWEN3_BASE,

  // ── MiniMax ─────────────────────────────────────────────────────────────
  'MiniMax-Text-01':     { ...DEFAULT_CAPABILITY, contextWindow: 1_000_000, maxOutputTokens: 8192 },
  'MiniMax-M1':          { ...DEFAULT_CAPABILITY, contextWindow: 1_000_000, maxOutputTokens: 8192 },

  // ── Perplexity ──────────────────────────────────────────────────────────
  'sonar':               PERPLEXITY_BASE,
  'sonar-pro':           PERPLEXITY_BASE,
};

/**
 * Look up capability for a (provider, model) pair.
 *
 * Resolution order:
 *   1. Curated static fallback by exact/prefix model name
 *   2. models.dev cache patch for the selected provider/model, when present
 *   3. DEFAULT_CAPABILITY if neither source knows the model
 */
export function getCapability(_provider: string, model: string): ModelCapability {
  const provider = _provider;
  const base = inferStaticCapability(model);
  const cached = readCachedModelCapability(provider, model);
  return cached ? mergeCapability(base, capabilityPatchFromModelsDev(cached)) : base;
}

export function resolveModelCapability(provider: string, model: string): ModelCapability {
  return getCapability(provider, model);
}

function inferStaticCapability(model: string): ModelCapability {
  const modelKeys = [model];
  const routedName = model.includes('/') ? model.split('/').pop() : null;
  if (routedName && routedName !== model) modelKeys.push(routedName);
  if (modelKeys.some((key) => /deepseek[-_]?v4/i.test(key))) return DEEPSEEK_V4_BASE;
  for (const key of modelKeys) {
    if (MODEL_CAPABILITIES[key]) return MODEL_CAPABILITIES[key];
  }
  const candidates = Object.keys(MODEL_CAPABILITIES)
    .filter((m) => modelKeys.some((key) => key.startsWith(m)))
    .sort((a, b) => b.length - a.length);
  if (candidates.length > 0) return MODEL_CAPABILITIES[candidates[0]];
  return DEFAULT_CAPABILITY;
}

interface CapabilityPatch {
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  inputModalities?: ModelModalities | null;
  outputModalities?: ModelModalities | null;
  attachmentStrategies?: AttachmentStrategies | null;
  supportsVision?: boolean | null;
  supportsPdf?: boolean | null;
  supportsAudio?: boolean | null;
  supportsVideo?: boolean | null;
  supportsTools?: boolean | null;
  supportsReasoning?: boolean | null;
  supportsStrictJson?: boolean | null;
}

function modalitiesFromList(values: string[] | undefined): ModelModalities {
  const set = new Set((values ?? []).map((value) => value.toLowerCase()));
  return {
    text:  set.has('text') || set.size === 0,
    image: set.has('image'),
    pdf:   set.has('pdf'),
    audio: set.has('audio'),
    video: set.has('video'),
  };
}

function deriveAttachmentStrategies(input: ModelModalities): AttachmentStrategies {
  return {
    image: input.image ? 'native' : 'ocr_fallback',
    pdf:   input.pdf ? 'native' : 'extract_text',
    docx:  'extract_text',
    pptx:  'extract_text',
    xlsx:  'extract_text',
    rtf:   'extract_text',
    epub:  'extract_text',
    odt:   'extract_text',
    ods:   'extract_text',
    odp:   'extract_text',
    opml:  'extract_text',
    mm:    'extract_text',
    xmind: 'extract_text',
    audio: input.audio ? 'native' : 'transcribe',
    video: input.video ? 'native' : 'transcribe',
  };
}

function capabilityPatchFromModelsDev(cache: {
  inputModalities: string[];
  outputModalities: string[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  supportsTools: boolean | null;
  supportsJson: boolean | null;
  supportsReasoning: boolean | null;
}): CapabilityPatch {
  const inputModalities = modalitiesFromList(cache.inputModalities);
  const outputModalities = modalitiesFromList(cache.outputModalities);
  return {
    contextWindow: cache.contextWindow,
    maxOutputTokens: cache.maxOutputTokens,
    inputModalities,
    outputModalities,
    attachmentStrategies: deriveAttachmentStrategies(inputModalities),
    supportsVision: inputModalities.image,
    supportsPdf: inputModalities.pdf,
    supportsAudio: inputModalities.audio,
    supportsVideo: inputModalities.video,
    supportsTools: cache.supportsTools,
    supportsStrictJson: cache.supportsJson,
    supportsReasoning: cache.supportsReasoning,
  };
}

function mergeCapability(base: ModelCapability, patch: CapabilityPatch): ModelCapability {
  const merged: ModelCapability = { ...base };
  if (patch.contextWindow !== undefined && patch.contextWindow !== null) merged.contextWindow = patch.contextWindow;
  if (patch.maxOutputTokens !== undefined && patch.maxOutputTokens !== null) merged.maxOutputTokens = patch.maxOutputTokens;
  if (patch.inputModalities !== undefined && patch.inputModalities !== null) merged.inputModalities = patch.inputModalities;
  if (patch.outputModalities !== undefined && patch.outputModalities !== null) merged.outputModalities = patch.outputModalities;
  if (patch.attachmentStrategies !== undefined && patch.attachmentStrategies !== null) merged.attachmentStrategies = patch.attachmentStrategies;
  if (patch.supportsVision !== undefined && patch.supportsVision !== null) merged.supportsVision = patch.supportsVision;
  if (patch.supportsPdf !== undefined && patch.supportsPdf !== null) merged.supportsPdf = patch.supportsPdf;
  if (patch.supportsAudio !== undefined && patch.supportsAudio !== null) merged.supportsAudio = patch.supportsAudio;
  if (patch.supportsVideo !== undefined && patch.supportsVideo !== null) merged.supportsVideo = patch.supportsVideo;
  if (patch.supportsTools !== undefined && patch.supportsTools !== null) merged.supportsTools = patch.supportsTools;
  if (patch.supportsStrictJson !== undefined && patch.supportsStrictJson !== null) merged.supportsStrictJson = patch.supportsStrictJson;
  if (patch.supportsReasoning !== undefined && patch.supportsReasoning !== null) {
    merged.supportsReasoning = patch.supportsReasoning;
    if (!patch.supportsReasoning) merged.thinkingStyle = 'none';
    if (patch.supportsReasoning && merged.thinkingStyle === 'none') merged.thinkingStyle = 'reasoner-model';
  }
  return merged;
}

function supportsThinking(capability: ModelCapability): boolean {
  return Boolean(capability.supportsReasoning) || capability.thinkingStyle !== 'none';
}

function thinkingControlForStyle(style: ThinkingStyle): ThinkingControl {
  if (style === 'none') return 'none';
  if (style === 'reasoner-model') return 'model';
  if (style === 'openai-effort' || style === 'extra-grok') return 'effort';
  return 'budget';
}

// effort models: the number is a bucket selector for budgetToEffort in the OpenAI
// provider (≤1024→low, (1024,4096]→medium, >4096→high) — it encodes reasoning_effort.
const EFFORT_LEVEL_BUDGET: Record<'low' | 'medium' | 'high', number> = { low: 1024, medium: 2048, high: 8192 };
// budget models (Anthropic/Gemini/Qwen): real budget_tokens tiers, clamped to model headroom.
const REASONING_LEVEL_BUDGET: Record<'low' | 'medium' | 'high', number> = { low: 2048, medium: 8192, high: 16384 };

/** Normalize a thinking mode to a non-off level, accepting legacy 'light'/'deep' aliases. */
function thinkingLevel(mode: ThinkingMode): 'low' | 'medium' | 'high' {
  const value = mode as string;
  if (value === 'deep' || value === 'high') return 'high';
  if (value === 'medium') return 'medium';
  if (value === 'light' || value === 'low') return 'low';
  return 'medium';
}

export function resolveThinkingBudget(provider: string, model: string, mode: ThinkingMode | undefined): number | undefined {
  if (!mode || (mode as string) === 'off') return 0;
  const capability = resolveModelCapability(provider, model);
  if (!supportsThinking(capability)) return 0;
  // Reasoner models always reason and can't be tuned — any "on" level just enables it.
  if (capability.thinkingStyle === 'reasoner-model') return 1;

  const level = thinkingLevel(mode);
  if (thinkingControlForStyle(capability.thinkingStyle) === 'effort') {
    return EFFORT_LEVEL_BUDGET[level];
  }
  const maxBudget = Math.max(1024, capability.maxOutputTokens - 1024);
  return Math.min(REASONING_LEVEL_BUDGET[level], maxBudget);
}

export function resolveAttachmentStrategies(provider: string, model: string): AttachmentStrategies {
  const capability = resolveModelCapability(provider, model);
  return capability.attachmentStrategies ?? deriveAttachmentStrategies(
    capability.inputModalities ?? {
      text: true,
      image: capability.supportsVision,
      pdf: capability.supportsPdf,
      audio: capability.supportsAudio,
      video: capability.supportsVideo,
    },
  );
}

function completeModalities(capability: ModelCapability, key: 'inputModalities' | 'outputModalities'): ModelModalities {
  return capability[key] ?? {
    text: true,
    image: key === 'inputModalities' ? capability.supportsVision : false,
    pdf: key === 'inputModalities' ? capability.supportsPdf : false,
    audio: key === 'inputModalities' ? capability.supportsAudio : false,
    video: key === 'inputModalities' ? capability.supportsVideo : false,
  };
}

export function getModelCapabilityInfo(provider: string, model: string): ModelCapabilityInfo {
  const capability = resolveModelCapability(provider, model);
  const supportsReasoning = supportsThinking(capability);
  return {
    contextWindow: capability.contextWindow,
    maxOutputTokens: capability.maxOutputTokens,
    inputModalities: completeModalities(capability, 'inputModalities'),
    outputModalities: completeModalities(capability, 'outputModalities'),
    attachmentStrategies: resolveAttachmentStrategies(provider, model),
    supportsVision: capability.supportsVision,
    supportsPdf: capability.supportsPdf,
    supportsAudio: capability.supportsAudio,
    supportsVideo: capability.supportsVideo,
    supportsTools: capability.supportsTools,
    supportsReasoning,
    thinkingControl: supportsReasoning ? thinkingControlForStyle(capability.thinkingStyle) : 'none',
    supportsStrictJson: capability.supportsStrictJson,
    supportsNativeSearch: capability.supportsNativeSearch,
  };
}
