import * as fs from 'fs';
import * as nodePath from 'path';
import { z } from 'zod';
import { getArtifactDisplayName, getArtifactIndexEntry, getArtifactIndexHeader, sanitizeFilenamePart } from '../../agent-i18n/artifact-names';
import { message, normalizeLanguage } from '../../agent-i18n/messages';
import { toolDescription, toolPropertyDescription } from '../../agent-i18n/tool-descriptions';
import { buildOutlineContextForArtifact } from '../../agent-workflows/outline-context';
import { formatGenerationStepTrace } from '../../agent-workflows/material/material-progress-trace';
import { resolveOutputTokenBudget } from '../../agent-context/output-token-budget';
import { NodeRepository } from '../../db/repositories/node.repo';
import { getFolderPath, writeFileContent } from '../../fs/content.service';
import { LLMAdapter } from '../../llm/adapter';
import { usageLedger } from '../../llm/usage-ledger';
import { languageLayer, localMsg } from '../../prompt/prompt-builder';
import { importTextSource } from '../../source/source-library';
import { collectEvidencePack, formatEvidencePack, summarizeEvidencePack } from '../../web/research-pipeline';
import { assessSourceRisk, classifySourceTier, classifyTrustLevel, normalizeUrl } from '../../web/source-authority';
import type { EvidencePack, SearchMode, SourceRecord, TokenUsage } from '@shared/types';
import type { ToolContext, TutorTool } from '../tutor-tools/index';
import { buildTool } from '../tutor-tools/index';

const nodeRepo = new NodeRepository();

interface ReferenceIndexResult {
  success: boolean;
  fileName?: string;
  summary: string;
}

function syncGeneratedSourceIndex(
  ctx: Pick<ToolContext, 'courseId' | 'nodeId'>,
  fileName: string,
  filePath: string,
  content: string,
): boolean {
  try {
    importTextSource({
      courseId: ctx.courseId,
      nodeId: ctx.nodeId,
      title: fileName,
      content,
      filePath,
      kind: 'generated',
      origin: 'ai_generated',
    });
    return true;
  } catch {
    return false;
  }
}

function dateStamp(): string {
  const now = new Date();
  return `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
}

function uniqueFilename(dir: string, baseName: string): string {
  const fileName = `${baseName}.md`;
  if (!fs.existsSync(nodePath.join(dir, fileName))) return fileName;
  let i = 2;
  while (fs.existsSync(nodePath.join(dir, `${baseName}-${i}.md`))) i += 1;
  return `${baseName}-${i}.md`;
}

function listTheoryFiles(theoryDir: string): string {
  try {
    return fs.readdirSync(theoryDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .slice(0, 30)
      .join('\n');
  } catch {
    return '';
  }
}

function readTheoryIndex(theoryDir: string): string {
  try {
    const indexPath = nodePath.join(theoryDir, '_index.md');
    if (!fs.existsSync(indexPath)) return '';
    return fs.readFileSync(indexPath, 'utf-8').slice(0, 4000);
  } catch {
    return '';
  }
}

function plannedReferenceQueries(base: string, language?: string) {
  const topic = base.replace(/\s+/g, ' ').trim();
  if (normalizeLanguage(language) === 'en') {
    return [
      { query: `${topic} textbook PDF lecture notes open course`, purpose: 'textbook_course' },
      { query: `${topic} official documentation tutorial guide`, purpose: 'official_docs' },
      { query: `${topic} research paper survey review`, purpose: 'papers' },
      { query: `${topic} interactive visualization simulation dataset notebook case study`, purpose: 'practice_resources' },
    ];
  }
  return [
    { query: `${topic} 教材 PDF 讲义 公开课`, purpose: 'textbook_course' },
    { query: `${topic} 官方文档 权威教程 指南`, purpose: 'official_docs' },
    { query: `${topic} 论文 综述 研究`, purpose: 'papers' },
    { query: `${topic} 仿真 可视化 数据集 notebook 案例`, purpose: 'practice_resources' },
  ];
}

async function collectReferenceEvidence(input: {
  ctx: ToolContext;
  query: string;
  mode: SearchMode;
  kind: string;
}): Promise<EvidencePack | null> {
  const { ctx, query, mode, kind } = input;
  const startedAt = Date.now();
  ctx.onProgress(formatGenerationStepTrace({
    kind,
    step: localMsg(ctx.language, mode === 'library' ? '检索本地参考库' : '检索外部参考',
      mode === 'library' ? 'search local library' : 'search external references'),
    status: 'start',
    detail: localMsg(ctx.language, `搜索模式 ${mode}。`, `Search mode ${mode}.`),
    language: ctx.language,
  }));
  const pack = await collectEvidencePack({
    query,
    courseId: ctx.courseId,
    nodeId: ctx.nodeId,
    mode,
    taskType: 'theory',
    maxWebResults: 8,
    plannedQueries: plannedReferenceQueries(query, ctx.language),
    language: ctx.language,
    provider: ctx.provider,
    model: ctx.model,
    signal: ctx.signal,
    onProgress: (msg) => ctx.onProgress(msg),
    onUsage: (usage: TokenUsage) => {
      ctx.runContext?.addUsage(usage);
      if (!ctx.runContext) {
        usageLedger.record({
          sessionId: ctx.sessionId,
          courseId: ctx.courseId,
          provider: ctx.provider,
          model: ctx.model,
          usage,
          source: `chat_tool_generate_external_reference_index_${mode}`,
        });
      }
    },
  });
  ctx.onProgress(formatGenerationStepTrace({
    kind,
    step: localMsg(ctx.language, mode === 'library' ? '检索本地参考库' : '检索外部参考',
      mode === 'library' ? 'search local library' : 'search external references'),
    status: 'done',
    durationMs: Date.now() - startedAt,
    detail: summarizeEvidencePack(pack, ctx.language).trim(),
    language: ctx.language,
  }));
  return pack;
}

function evidenceSection(packs: Array<{ label: string; pack: EvidencePack }>, language?: string): string {
  if (packs.length === 0) {
    return localMsg(
      language,
      '（本轮搜索模式关闭，未检索外部来源。请生成可执行的搜索方法，不要编造链接。）',
      '(Search is off for this turn. Produce executable search strategies and do not invent links.)',
    );
  }
  return packs.map(({ label, pack }) => `## ${label}\n${summarizeEvidencePack(pack, language)}\n${formatEvidencePack(pack, language)}`).join('\n\n');
}

function extractHeadings(content: string): string {
  const headings = [...content.matchAll(/^#{1,3}\s+(.+)$/gm)]
    .map((match) => match[1].trim())
    .filter(Boolean)
    .slice(0, 8);
  return headings.join('、');
}

function escapeMarkdownCell(value: string | null | undefined): string {
  return (value || '')
    .replace(/\|/g, '\\|')
    .replace(/\n+/g, ' ')
    .trim();
}

function escapeMarkdownLinkLabel(value: string | null | undefined): string {
  return escapeMarkdownCell(value || '未命名资源')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function sourceUrl(source: SourceRecord): string | null {
  if (!source.url) return null;
  if (!/^https?:\/\//i.test(source.url)) return null;
  return source.url;
}

function clickableSourcesFromPacks(packs: Array<{ label: string; pack: EvidencePack }>): Array<{
  source: SourceRecord;
  label: string;
  url: string;
}> {
  const seen = new Set<string>();
  const out: Array<{ source: SourceRecord; label: string; url: string }> = [];
  for (const item of packs) {
    for (const source of item.pack.sources) {
      const url = sourceUrl(source);
      if (!url) continue;
      const normalized = normalizeUrl(url);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      const risk = assessSourceRisk({
        title: source.title,
        url: source.url,
        kind: source.kind,
        origin: source.origin,
        host: source.host,
        filePath: source.filePath,
        originalPath: source.originalPath,
        trustScore: source.trustScore,
      });
      if (risk.level === 'blocked' || risk.level === 'high') continue;
      out.push({ source, label: item.label, url: normalized });
    }
  }
  return out.slice(0, 24);
}

function buildSearchUrl(engine: 'google' | 'scholar' | 'youtube' | 'bilibili', query: string): string {
  const encoded = encodeURIComponent(query);
  if (engine === 'scholar') return `https://scholar.google.com/scholar?q=${encoded}`;
  if (engine === 'youtube') return `https://www.youtube.com/results?search_query=${encoded}`;
  if (engine === 'bilibili') return `https://search.bilibili.com/all?keyword=${encoded}`;
  return `https://www.google.com/search?q=${encoded}`;
}

function formatClickableSourceAppendix(input: {
  packs: Array<{ label: string; pack: EvidencePack }>;
  query: string;
  language?: string;
}): string {
  const sources = clickableSourcesFromPacks(input.packs);
  const title = localMsg(input.language, '## 可点击来源索引', '## Clickable Source Index');
  if (sources.length === 0) {
    const q = input.query.trim();
    return [
      title,
      localMsg(
        input.language,
        '本轮没有检索到足够可靠的具体 URL。以下是可点击搜索入口，不等同于已验证资源，打开后仍需按质量标准筛选。',
        'No reliable exact URLs were found in this run. The following are clickable search entry points, not verified resources; filter them with the quality criteria after opening.',
      ),
      '',
      `- [Google：${escapeMarkdownLinkLabel(q)}](${buildSearchUrl('google', q)})`,
      `- [Google Scholar：${escapeMarkdownLinkLabel(q)}](${buildSearchUrl('scholar', q)})`,
      `- [YouTube：${escapeMarkdownLinkLabel(q)}](${buildSearchUrl('youtube', q)})`,
      `- [Bilibili：${escapeMarkdownLinkLabel(q)}](${buildSearchUrl('bilibili', q)})`,
      '',
    ].join('\n');
  }

  const header = localMsg(
    input.language,
    '| # | 资源 | 来源类型 | 可信层级 | 风险 | 来自 |\n|---:|---|---|---|---|---|',
    '| # | Resource | Type | Trust tier | Risk | From |\n|---:|---|---|---|---|---|',
  );
  const rows = sources.map(({ source, label, url }, index) => {
    const risk = assessSourceRisk({
      title: source.title,
      url,
      kind: source.kind,
      origin: source.origin,
      host: source.host,
      filePath: source.filePath,
      originalPath: source.originalPath,
      trustScore: source.trustScore,
    });
    const tier = classifySourceTier(source);
    const trust = classifyTrustLevel({
      kind: source.kind,
      host: source.host,
      url,
      trustScore: source.trustScore,
    });
    return `| ${index + 1} | [${escapeMarkdownLinkLabel(source.title)}](${url}) | ${escapeMarkdownCell(source.kind)} | ${escapeMarkdownCell(`${tier}/${trust}`)} | ${escapeMarkdownCell(risk.level)} | ${escapeMarkdownCell(label)} |`;
  });
  return [
    title,
    localMsg(
      input.language,
      '以下链接由工具从本轮检索结果中直接抽取并过滤高风险来源生成，供优先打开查看。',
      'The links below were extracted directly from this run’s search results and high-risk sources were filtered out. Open these first.',
    ),
    '',
    header,
    ...rows,
    '',
  ].join('\n');
}

function appendClickableSourceIndex(content: string, appendix: string): string {
  const trimmed = content.trim();
  if (/^##\s+(可点击来源索引|Clickable Source Index)\b/im.test(trimmed)) return `${trimmed}\n`;
  return `${trimmed}\n\n---\n\n${appendix.trim()}\n`;
}

export const generateExternalReferenceIndexTool: TutorTool<{
  topic?: string;
  custom_instructions?: string;
}, ReferenceIndexResult> = buildTool({
  name: 'generate_external_reference_index',
  description: toolDescription('generate_external_reference_index'),
  inputSchema: z.object({
    topic: z.string().optional(),
    custom_instructions: z.string().optional(),
  }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: toolPropertyDescription('generate_external_reference_index', 'topic') },
      custom_instructions: { type: 'string', description: toolPropertyDescription('generate_external_reference_index', 'custom_instructions') },
    },
  },
  maxResultChars: 500,
  isReadOnly: false,
  execute: async (input, ctx): Promise<ReferenceIndexResult> => {
    if (!ctx.nodeId) return { success: false, summary: message('noNodeSelectedGenerateMaterial', ctx.language) };

    const node = nodeRepo.findById(ctx.nodeId);
    if (!node) return { success: false, summary: message('nodeNotFound', ctx.language, { nodeId: ctx.nodeId }) };

    const kind = localMsg(ctx.language, '外部参考索引', 'External reference index');
    const targetTopic = input.topic?.trim() || node.name;
    const searchQuery = [node.name, input.topic, node.description].filter(Boolean).join(' ');
    const theoryDir = getFolderPath(ctx.courseId, ctx.nodeId, 'theory');
    fs.mkdirSync(theoryDir, { recursive: true });

    ctx.onProgress('\n' + localMsg(ctx.language, '### 外部参考索引生成过程\n', '### External reference index trace\n'));

    const outlineStartedAt = Date.now();
    ctx.onProgress(formatGenerationStepTrace({
      kind,
      step: localMsg(ctx.language, '读取蓝图与已有资料', 'read blueprint and existing materials'),
      status: 'start',
      detail: localMsg(ctx.language, '读取三层基础蓝图、原理资料索引和已有原理资料文件名。', 'Reading foundation blueprints, theory index, and existing theory filenames.'),
      language: ctx.language,
    }));
    const outlineContext = buildOutlineContextForArtifact({
      courseId: ctx.courseId,
      nodeId: ctx.nodeId,
      artifactKind: 'generic',
      language: ctx.language,
      kcName: input.topic,
    });
    const theoryIndex = readTheoryIndex(theoryDir);
    const theoryFiles = listTheoryFiles(theoryDir);
    ctx.onProgress(formatGenerationStepTrace({
      kind,
      step: localMsg(ctx.language, '读取蓝图与已有资料', 'read blueprint and existing materials'),
      status: 'done',
      durationMs: Date.now() - outlineStartedAt,
      detail: localMsg(
        ctx.language,
        `蓝图约 ${outlineContext.text.length.toLocaleString('en-US')} 字符；已有原理资料 ${theoryFiles ? theoryFiles.split('\n').length : 0} 个。`,
        `Blueprint about ${outlineContext.text.length.toLocaleString('en-US')} chars; existing theory files ${theoryFiles ? theoryFiles.split('\n').length : 0}.`,
      ),
      language: ctx.language,
    }));

    const packs: Array<{ label: string; pack: EvidencePack }> = [];
    const mode = ctx.searchMode ?? 'auto';
    if (mode === 'off') {
      ctx.onProgress(formatGenerationStepTrace({
        kind,
        step: localMsg(ctx.language, '检索参考来源', 'retrieve references'),
        status: 'skip',
        detail: localMsg(ctx.language, '搜索模式关闭，只生成搜索方法和甄别标准，不编造具体链接。', 'Search is off; generating search methods and evaluation criteria without invented links.'),
        language: ctx.language,
      }));
    } else {
      if (mode === 'auto' || mode === 'library') {
        const pack = await collectReferenceEvidence({ ctx, query: searchQuery, mode: 'library', kind });
        if (pack) packs.push({ label: localMsg(ctx.language, '本地参考库', 'Local source library'), pack });
      }
      if (mode === 'auto' || mode === 'web') {
        const pack = await collectReferenceEvidence({ ctx, query: searchQuery, mode: 'web', kind });
        if (pack) packs.push({ label: localMsg(ctx.language, '外部网页/开放资源', 'External web/open resources'), pack });
      }
    }

    const evidenceText = evidenceSection(packs, ctx.language);
    const promptStartedAt = Date.now();
    const systemPrompt = languageLayer(ctx.language)() + localMsg(
      ctx.language,
      `你是学习资源策展与资料导航专家。请为当前节点生成一份「外部参考索引.md」，默认保存到原理资料文件夹。

节点：${node.name}
章节：${node.chapter}
难度：${node.difficulty}
聚焦方向：${targetTopic}

三层基础蓝图与节点范围：
${outlineContext.text || '（暂无蓝图上下文）'}

已有原理资料文件：
${theoryFiles || '（暂无）'}

已有原理资料索引：
${theoryIndex || '（暂无）'}

检索证据与候选来源：
${evidenceText}

用户额外要求：
${input.custom_instructions || '（无）'}

输出要求：
- 只输出完整 Markdown 正文，不要解释工具流程。
- 这不是原理讲解正文，不要写成长篇教材；它是给学习者和后续 AI 使用的资源导航索引。
- 必须默认围绕当前节点和蓝图范围组织，不要泛化到整门课程。
- 按资源类型分组：教材/PDF/讲义、官方文档/权威教程、开放课程/视频、论文/综述、开源 notebook/代码示例、仿真/可视化、数据集/真实案例、搜索策略与甄别标准。
- 每条资源尽量包含：资源名、类型、链接或可复制搜索词、适合用途、对应 KC/学习环节、质量/风险备注、是否建议导入本地。
- 检索证据里凡是有 http/https URL 的资源，必须优先写成 Markdown 可点击链接：[资源名](URL)，不要只写资源名或搜索词。
- 只能使用检索证据中出现的具体链接；没有可靠链接时写「搜索词：...」，不要编造 URL。
- 明确规避：盗版资源、下载站、毕业论文聚合页、低质 SEO 搬运、无来源视频合集。
- 最后保留「参考来源与延伸阅读」小节，列出本索引实际依据的来源编号或搜索词。`,
      `You are a learning-resource curator. Generate an "External Reference Index.md" for the current node, saved by default to the Theory folder.

Node: ${node.name}
Chapter: ${node.chapter}
Difficulty: ${node.difficulty}
Focus: ${targetTopic}

Foundation blueprints and node scope:
${outlineContext.text || '(No blueprint context)'}

Existing theory files:
${theoryFiles || '(none)'}

Existing theory index:
${theoryIndex || '(none)'}

Evidence and candidate sources:
${evidenceText}

Extra user requirements:
${input.custom_instructions || '(none)'}

Output requirements:
- Output only complete Markdown content.
- This is not a long theory lesson; it is a resource navigation index for learners and future AI use.
- Stay within the current node and blueprint scope.
- Group by resource type: textbooks/PDF/lecture notes, official docs/tutorials, open courses/videos, papers/surveys, open notebooks/code examples, simulations/visualizations, datasets/real cases, search strategy and quality criteria.
- Each item should include name, type, link or copyable search query, use case, related KC/learning phase, quality/risk note, and local-import suggestion.
- Whenever an evidence source contains an http/https URL, prioritize a Markdown clickable link: [Resource name](URL). Do not downgrade real URLs into plain names or search queries.
- Use exact links only when present in the evidence; otherwise write "Search query: ...". Do not invent URLs.
- Explicitly avoid piracy, download farms, thesis aggregators, low-quality SEO copies, and unsourced video compilations.
- Keep a final "References and further reading" section listing the actual source IDs or search queries used.`,
    );
    ctx.onProgress(formatGenerationStepTrace({
      kind,
      step: localMsg(ctx.language, '构建生成提示词', 'build generation prompt'),
      status: 'done',
      durationMs: Date.now() - promptStartedAt,
      detail: localMsg(
        ctx.language,
        `system prompt 约 ${systemPrompt.length.toLocaleString('en-US')} 字符；候选来源 ${packs.reduce((sum, item) => sum + item.pack.sources.length, 0)} 个。`,
        `system prompt about ${systemPrompt.length.toLocaleString('en-US')} chars; candidate sources ${packs.reduce((sum, item) => sum + item.pack.sources.length, 0)}.`,
      ),
      language: ctx.language,
    }));

    let fullContent = '';
    let streamError = '';
    const generationStartedAt = Date.now();
    ctx.onProgress(formatGenerationStepTrace({
      kind,
      step: localMsg(ctx.language, '模型生成索引正文', 'model drafts index'),
      status: 'start',
      detail: localMsg(ctx.language, '调用模型生成外部参考索引 Markdown。', 'Calling the model to draft the external reference index Markdown.'),
      language: ctx.language,
    }));
    await LLMAdapter.stream({
      provider: ctx.provider,
      model: ctx.model,
      messages: [{
        role: 'user',
        content: localMsg(
          ctx.language,
          `请为节点「${node.name}」生成外部参考索引，聚焦「${targetTopic}」。`,
          `Generate an external reference index for node "${node.name}", focused on "${targetTopic}".`,
        ),
      }],
      systemPrompt,
      maxTokens: resolveOutputTokenBudget({ provider: ctx.provider, model: ctx.model, task: 'utility', requestedMaxTokens: 16_000 }),
      temperature: 0.25,
      signal: ctx.signal,
      onChunk: (chunk) => { fullContent += chunk; },
      onComplete: (usage) => {
        ctx.runContext?.addUsage(usage);
        if (!ctx.runContext) {
          usageLedger.record({
            sessionId: ctx.sessionId,
            courseId: ctx.courseId,
            provider: ctx.provider,
            model: ctx.model,
            usage,
            source: 'chat_tool_generate_external_reference_index',
          });
        }
      },
      onError: (err) => { streamError = err.message; },
    });
    ctx.onProgress(formatGenerationStepTrace({
      kind,
      step: localMsg(ctx.language, '模型生成索引正文', 'model drafts index'),
      status: streamError || !fullContent ? 'fail' : 'done',
      durationMs: Date.now() - generationStartedAt,
      detail: streamError || localMsg(ctx.language, `输出约 ${fullContent.length.toLocaleString('en-US')} 字符。`, `Output about ${fullContent.length.toLocaleString('en-US')} chars.`),
      language: ctx.language,
    }));
    if (streamError || !fullContent.trim()) {
      return { success: false, summary: streamError || message('generationFailedRetry', ctx.language) };
    }

    const clickableAppendix = formatClickableSourceAppendix({
      packs,
      query: searchQuery,
      language: ctx.language,
    });
    const finalContent = appendClickableSourceIndex(fullContent, clickableAppendix);

    const stem = sanitizeFilenamePart(
      localMsg(ctx.language, `外部参考索引-${dateStamp()}-${targetTopic}`, `external-reference-index-${dateStamp()}-${targetTopic}`),
      localMsg(ctx.language, `外部参考索引-${dateStamp()}`, `external-reference-index-${dateStamp()}`),
      46,
    );
    const fileName = uniqueFilename(theoryDir, stem);
    const filePath = nodePath.join(theoryDir, fileName);
    const persistStartedAt = Date.now();
    writeFileContent(filePath, finalContent);

    let indexUpdated = false;
    try {
      const indexPath = nodePath.join(theoryDir, '_index.md');
      const existing = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : getArtifactIndexHeader('theory', ctx.language);
      const entry = getArtifactIndexEntry('theory', {
        fileName,
        date: new Date().toISOString().slice(0, 10),
        headings: extractHeadings(finalContent) || localMsg(ctx.language, '外部参考索引', 'External reference index'),
      }, ctx.language);
      writeFileContent(indexPath, existing + entry);
      indexUpdated = true;
    } catch { /* non-fatal */ }
    const indexed = syncGeneratedSourceIndex(ctx, fileName, filePath, finalContent);
    ctx.onProgress(formatGenerationStepTrace({
      kind,
      step: localMsg(ctx.language, '写入索引文件', 'write index file'),
      status: 'done',
      durationMs: Date.now() - persistStartedAt,
      detail: localMsg(
        ctx.language,
        `保存到 ${getArtifactDisplayName('theory', ctx.language)}/${fileName}；参考库索引${indexed ? '成功' : '未完成'}；目录索引${indexUpdated ? '已更新' : '未更新'}。`,
        `Saved to ${getArtifactDisplayName('theory', ctx.language)}/${fileName}; source index ${indexed ? 'ok' : 'not completed'}; folder index ${indexUpdated ? 'updated' : 'not updated'}.`,
      ),
      language: ctx.language,
    }));
    ctx.onFileGenerated({ sessionId: ctx.sessionId, filePath, folderName: 'theory', nodeId: ctx.nodeId, usage: { inputTokens: 0, outputTokens: 0, costCny: 0 } });

    return {
      success: true,
      fileName,
      summary: message('generatedSavedToFolder', ctx.language, {
        folder: getArtifactDisplayName('theory', ctx.language),
        filename: fileName,
      }),
    };
  },
  formatResult: (r) => r.summary,
});
