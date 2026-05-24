import { z } from 'zod';
import * as nodePath from 'path';
import { GENERATE_FOLDER_KEYS, type GenerateFolder, type OutlineVersionSelection } from '@shared/types';
import { buildTool } from './index';
import { getFolderPath, writeFileContent, getLatestOutlinePath } from '../../fs/content.service';
import { message } from '../../agent-i18n/messages';
import { getArtifactFilenamePrefix, isNormalizedArtifactFilename } from '../../agent-i18n/artifact-names';
import { toolDescription, toolPropertyDescription } from '../../agent-i18n/tool-descriptions';
import { importTextSource } from '../../source/source-library';
import { createLogger } from '../../../utils/logger';
import { NodeRepository } from '../../db/repositories/node.repo';
import { detectDomain } from '../../web/source-strategy';
import { buildExtendedReading } from '../../agent-workflows/extended-reading';
import { formatVerificationIssues } from '../../agent-verifiers/types';
import { verifyPracticeContent } from '../../agent-verifiers/practice.verifier';
import { verifySourceCitation } from '../../agent-verifiers/citation.verifier';
import {
  formatTheoryMermaidIssues,
  sanitizeTheoryMarkdown,
  verifyTheoryMarkdownMermaid,
} from '../../agent-verifiers/theory-markdown.verifier';
import {
  formatMarkdownMathIssues,
  sanitizeMarkdownMath,
  verifyMarkdownMath,
} from '../../agent-verifiers/markdown-math.verifier';

const nodeRepo = new NodeRepository();

const log = createLogger('save_file');

// ── Filename normalisation ────────────────────────────────────────────────────

/**
 * Build a normalised filename: {type}-{outlineVersion}-{MMDD}-{descriptor}.md
 * Only applied to theory / practice / answer folders; notes keep AI-supplied name.
 * Descriptor is taken from the AI-supplied filename (extension stripped, ≤6 chars).
 */
function buildNormalizedFilename(
  aiFilename: string,
  folderName: GenerateFolder,
  courseId: string,
  nodeId: string,
  language?: string,
  outlineVersion?: OutlineVersionSelection,
): string {
  const typePrefix = getArtifactFilenamePrefix(folderName, language);
  if (!typePrefix) return aiFilename; // notes and unknown folders: pass through
  if (isNormalizedArtifactFilename(folderName, aiFilename, language)) return aiFilename;

  // Outline version (v1/v2/v3)
  const outlinePath = outlineVersion && outlineVersion !== 'latest'
    ? null
    : getLatestOutlinePath(courseId, nodeId);
  const vMatch = outlinePath ? nodePath.basename(outlinePath).match(/_outline_(v\d+)\.md/) : null;
  const version = outlineVersion && outlineVersion !== 'latest'
    ? outlineVersion
    : vMatch ? vMatch[1] : 'v1';

  // MMDD
  const now = new Date();
  const mmdd =
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');

  // Descriptor: strip extension + sanitize + limit to 6 characters
  const raw = aiFilename.replace(/\.md$/i, '').replace(/[/\\?%*:|"<>]/g, '').trim();
  const descriptor = raw.slice(0, 6) || typePrefix;

  return `${typePrefix}-${version}-${mmdd}-${descriptor}.md`;
}

/**
 * Normalize inline multiple-choice options to separate list lines.
 * If a line contains 2+ "A) / B) / C)" option markers inline, split each onto its own line.
 * e.g. "Question? A) opt1 B) opt2 C) opt3 D) opt4"
 *   → "Question?\n- A. opt1\n- B. opt2\n- C. opt3\n- D. opt4"
 */
function normalizeInlineOptions(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      // Only process lines that have 2+ option markers (avoids false positives)
      const count = (line.match(/\b[A-D][)）]\s/g) ?? []).length;
      if (count < 2) return line;
      // Insert a newline before each inline option marker (including the first one)
      return line.replace(/\s+([A-D])[)）]\s+/g, '\n- $1. ');
    })
    .join('\n');
}

function ensurePracticeSourceMarker(content: string, language?: string): string {
  if (verifySourceCitation(content).passed) return content;
  const note = language === 'en'
    ? '\n\n> Source note: this practice file did not include per-question source markers; unmarked questions are treated as [AI Original].\n'
    : '\n\n> 来源说明：本实践资料未逐题标注来源；未标注题目按 [AI原创] 处理。\n';
  return `${content.trimEnd()}${note}`;
}

export const saveFileTool = buildTool<
  { content: string; filename: string; folderName: GenerateFolder },
  { filePath: string; folderName: GenerateFolder; language?: string }
>({
  name: 'save_file',
  description: toolDescription('save_file'),
  inputSchema: z.object({
    content:    z.string().min(1).describe(toolPropertyDescription('save_file', 'content')),
    filename:   z.string().describe(toolPropertyDescription('save_file', 'filename')),
    folderName: z.enum(GENERATE_FOLDER_KEYS).describe(toolPropertyDescription('save_file', 'folderName')),
  }),
  inputJsonSchema: {
    type: 'object',
    properties: {
      content:    { type: 'string', description: toolPropertyDescription('save_file', 'content') },
      filename:   { type: 'string', description: toolPropertyDescription('save_file', 'filename') },
      folderName: {
        type: 'string',
        enum: [...GENERATE_FOLDER_KEYS],
        description: toolPropertyDescription('save_file', 'folderName'),
      },
    },
    required: ['content', 'filename', 'folderName'],
  },
  maxResultChars: 300,
  execute: async ({ content, filename, folderName }, { courseId, nodeId, sessionId, language, outlineVersion, onProgress, onFileGenerated }) => {
    const contentWithSourceMarker = folderName === 'practice'
      ? ensurePracticeSourceMarker(content, language)
      : content;
    if (folderName === 'practice') {
      const verification = verifyPracticeContent(contentWithSourceMarker);
      if (!verification.passed) {
        throw new Error(formatVerificationIssues(verification, language));
      }
    }

    const normalizedFilename = buildNormalizedFilename(filename, folderName, courseId, nodeId, language, outlineVersion);
    const dir = getFolderPath(courseId, nodeId, folderName);
    const filePath = nodePath.join(dir, normalizedFilename);

    // Append domain-aware "延伸阅读" section to theory and practice files
    const node = nodeRepo.findById(nodeId);
    const extendedReading = node
      ? buildExtendedReading(node.name, folderName, detectDomain(node.name, node.description))
      : '';
    const normalizedContent = normalizeInlineOptions(contentWithSourceMarker);
    const shouldCheckMath = folderName === 'theory' || folderName === 'practice' || folderName === 'answer';
    const mathSanitized = shouldCheckMath
      ? sanitizeMarkdownMath(normalizedContent)
      : { content: normalizedContent, repairedBlocks: 0, mathBlocks: 0 };
    if (shouldCheckMath && mathSanitized.repairedBlocks > 0) {
      log.warn('已清洗资料中的 LaTeX 公式定界符或矩阵换行，避免前端公式渲染失败', {
        filename,
        nodeId,
        folderName,
        repairedBlocks: mathSanitized.repairedBlocks,
      });
    }
    if (shouldCheckMath) {
      const mathVerification = verifyMarkdownMath(mathSanitized.content);
      if (!mathVerification.passed) {
        throw new Error(formatMarkdownMathIssues(mathVerification, language));
      }
    }

    const sanitized = folderName === 'theory'
      ? sanitizeTheoryMarkdown(mathSanitized.content)
      : { content: mathSanitized.content, repairedBlocks: 0 };
    if (sanitized.repairedBlocks > 0) {
      log.warn('已清洗原理资料中的 Mermaid 代码块，避免前端语法错误', {
        filename,
        nodeId,
        repairedBlocks: sanitized.repairedBlocks,
      });
    }
    if (folderName === 'theory') {
      const mermaidVerification = verifyTheoryMarkdownMermaid(sanitized.content);
      if (!mermaidVerification.passed) {
        throw new Error(formatTheoryMermaidIssues(mermaidVerification, language));
      }
    }
    const finalContent = sanitized.content + extendedReading;

    writeFileContent(filePath, finalContent);
    onProgress(message('fileSavedProgress', language, { filename: normalizedFilename }));

    // Sync into the unified source library index. This replaces the old file_chunks RAG index.
    try {
      importTextSource({
        courseId,
        nodeId,
        title: normalizedFilename,
        content: finalContent,
        filePath,
        kind: 'generated',
        origin: 'ai_generated',
      });
    } catch (err) {
      log.warn('参考库索引失败，文件已保存但检索可能不完整', { filename, nodeId, error: String(err) });
    }

    // Notify caller so it can emit FILE_GENERATED IPC event
    onFileGenerated({
      sessionId,
      filePath,
      folderName,
      nodeId,
      usage: { inputTokens: 0, outputTokens: 0, costCny: 0 }, // loop fills in real usage
    });

    return { filePath, folderName, language };
  },
  formatResult: ({ filePath, language }) => message('fileSavedToPath', language, { filePath }),
});
