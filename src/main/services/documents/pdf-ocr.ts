import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { resolveSwiftBinary } from './swift-runtime';

const DEFAULT_OCR_WORKER_COUNT = 2;
const MIN_OCR_WORKER_COUNT = 1;
const MAX_OCR_WORKER_COUNT = 4;

const PDF_OCR_SWIFT_SCRIPT = String.raw`
import Foundation
import PDFKit
import Vision
import AppKit

struct PageResult: Encodable {
  let type: String
  let page: Int
  let text: String
  let error: String?
}

struct MetaResult: Encodable {
  let type: String
  let pageCount: Int
  let requestedCount: Int
}

func stderr(_ message: String) {
  FileHandle.standardError.write(Data(message.utf8))
}

func emit<T: Encodable>(_ value: T) {
  do {
    let data = try JSONEncoder().encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
  } catch {
    stderr("json-encode-failed: \(String(describing: error))\n")
  }
}

guard CommandLine.arguments.count > 1 else {
  stderr("missing-pdf-path")
  exit(2)
}

let pdfPath = CommandLine.arguments[1]
let requestedPagesArg = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""
let url = URL(fileURLWithPath: pdfPath)

guard let document = PDFDocument(url: url) else {
  stderr("pdf-load-failed")
  exit(3)
}

let pageCount = document.pageCount
let requestedPages: [Int]
if requestedPagesArg.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
  requestedPages = Array(1...pageCount)
} else {
  requestedPages = requestedPagesArg
    .split(separator: ",")
    .compactMap { Int($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    .filter { $0 >= 1 && $0 <= pageCount }
}

func renderPage(_ page: PDFPage) -> CGImage? {
  let bounds = page.bounds(for: .mediaBox)
  let maxDimension: CGFloat = 2200
  let scale = min(CGFloat(3.0), max(CGFloat(1.0), maxDimension / max(bounds.width, bounds.height)))
  let size = NSSize(width: max(1, bounds.width * scale), height: max(1, bounds.height * scale))
  let image = NSImage(size: size)
  image.lockFocus()
  NSColor.white.setFill()
  NSRect(origin: .zero, size: size).fill()
  guard let context = NSGraphicsContext.current?.cgContext else {
    image.unlockFocus()
    return nil
  }
  context.saveGState()
  context.scaleBy(x: scale, y: scale)
  page.draw(with: .mediaBox, to: context)
  context.restoreGState()
  image.unlockFocus()
  var rect = NSRect(origin: .zero, size: size)
  return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
}

func recognizeText(_ image: CGImage) throws -> String {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
  let handler = VNImageRequestHandler(cgImage: image, options: [:])
  try handler.perform([request])
  let observations = request.results ?? []
  return observations
    .compactMap { $0.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
    .joined(separator: "\n")
}

emit(MetaResult(type: "meta", pageCount: pageCount, requestedCount: requestedPages.count))

for pageNumber in requestedPages {
  autoreleasepool {
    guard let page = document.page(at: pageNumber - 1) else {
      emit(PageResult(type: "page", page: pageNumber, text: "", error: "page-not-found"))
      return
    }
    guard let image = renderPage(page) else {
      emit(PageResult(type: "page", page: pageNumber, text: "", error: "page-render-failed"))
      return
    }
    do {
      let text = try recognizeText(image)
      emit(PageResult(type: "page", page: pageNumber, text: text, error: nil))
    } catch {
      emit(PageResult(type: "page", page: pageNumber, text: "", error: String(describing: error)))
    }
  }
}
`;

export interface PdfOcrPageResult {
  page: number;
  text: string;
  error?: string | null;
}

export interface PdfOcrResult {
  pageCount: number;
  pages: PdfOcrPageResult[];
}

export function normalizePdfOcrWorkerCount(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_OCR_WORKER_COUNT;
  return Math.min(MAX_OCR_WORKER_COUNT, Math.max(MIN_OCR_WORKER_COUNT, Math.trunc(n)));
}

export async function extractPdfPagesWithLocalOcr(input: {
  pdfPath: string;
  pages?: number[];
  workerCount?: number;
  onPage?: (page: PdfOcrPageResult) => void;
}): Promise<PdfOcrResult> {
  if (process.platform !== 'darwin') {
    throw new Error('本地 PDF OCR 当前仅支持 macOS。');
  }

  const requestedPages = (input.pages ?? [])
    .filter((page) => Number.isInteger(page) && page > 0)
    .filter((page, index, pages) => pages.indexOf(page) === index);
  const cache = readOcrCache(input.pdfPath, requestedPages);
  const cachedPages = requestedPages
    .map((page) => cache.pages.get(page))
    .filter((page): page is PdfOcrPageResult => Boolean(page));
  for (const page of cachedPages) input.onPage?.(page);

  const missingPages = requestedPages.length > 0
    ? requestedPages.filter((page) => !cache.pages.has(page))
    : [];
  if (requestedPages.length > 0 && missingPages.length === 0) {
    return {
      pageCount: cache.pageCount ?? Math.max(...requestedPages, 0),
      pages: cachedPages,
    };
  }

  const workerCount = requestedPages.length > 0
    ? Math.min(normalizePdfOcrWorkerCount(input.workerCount), Math.max(1, missingPages.length))
    : 1;
  // Prefer the precompiled binary (no Xcode toolchain needed); fall back to
  // interpreting the inline source via /usr/bin/swift when running from source.
  const binary = resolveSwiftBinary('pdf-ocr');
  const dir = binary ? null : await mkdtemp(join(tmpdir(), 'ulyzer-pdf-ocr-'));
  const swiftCommand = binary ?? '/usr/bin/swift';
  let swiftPrefixArgs: string[] = [];
  try {
    if (!binary && dir) {
      const scriptPath = join(dir, 'pdf-ocr.swift');
      await writeFile(scriptPath, PDF_OCR_SWIFT_SCRIPT, 'utf8');
      swiftPrefixArgs = [scriptPath];
    }
    const context = ocrCacheContext(input.pdfPath);
    const workerResult = await runOcrWorkerPool({
      swiftCommand,
      swiftPrefixArgs,
      pdfPath: input.pdfPath,
      pages: requestedPages.length > 0 ? missingPages : [],
      workerCount,
      onPage: (page) => {
        writeOcrPageCache(page, context);
        input.onPage?.(page);
      },
    });
    const pageCount = workerResult.pageCount || cache.pageCount || 0;
    writeOcrMetaCache(pageCount, context);
    const byPage = new Map<number, PdfOcrPageResult>();
    for (const page of cachedPages) byPage.set(page.page, page);
    for (const page of workerResult.pages) byPage.set(page.page, page);
    const pages = requestedPages.length > 0
      ? requestedPages.map((page) => byPage.get(page)).filter((page): page is PdfOcrPageResult => Boolean(page))
      : [...byPage.values()].sort((a, b) => a.page - b.page);
    return { pageCount, pages };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

function ocrCacheContext(pdfPath: string): { dir: string; metaPath: string } {
  const stat = statSync(pdfPath);
  const key = createHash('sha256')
    .update(`${pdfPath}\n${stat.size}\n${Math.round(stat.mtimeMs)}`)
    .digest('hex');
  const dir = join(app.getPath('userData'), 'ocr-cache', key);
  mkdirSync(dir, { recursive: true });
  return { dir, metaPath: join(dir, 'meta.json') };
}

function pageCachePath(dir: string, page: number): string {
  return join(dir, `${page}.json`);
}

function readOcrCache(pdfPath: string, pages: number[]): {
  pageCount?: number;
  pages: Map<number, PdfOcrPageResult>;
} {
  const context = ocrCacheContext(pdfPath);
  let pageCount: number | undefined;
  if (existsSync(context.metaPath)) {
    try {
      const parsed = JSON.parse(readFileSync(context.metaPath, 'utf8')) as { pageCount?: number };
      if (typeof parsed.pageCount === 'number') pageCount = parsed.pageCount;
    } catch {
      pageCount = undefined;
    }
  }
  const cached = new Map<number, PdfOcrPageResult>();
  for (const page of pages) {
    const path = pageCachePath(context.dir, page);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as PdfOcrPageResult;
      if (Number(parsed.page) === page) {
        cached.set(page, {
          page,
          text: String(parsed.text ?? '').trim(),
          error: parsed.error ? String(parsed.error) : null,
        });
      }
    } catch {
      // Ignore corrupt per-page cache and let the worker regenerate it.
    }
  }
  return { pageCount, pages: cached };
}

function writeOcrMetaCache(pageCount: number, context: { metaPath: string }): void {
  writeFileSync(context.metaPath, JSON.stringify({
    pageCount,
    updatedAt: new Date().toISOString(),
  }), 'utf8');
}

function writeOcrPageCache(page: PdfOcrPageResult, context: { dir: string }): void {
  writeFileSync(pageCachePath(context.dir, page.page), JSON.stringify({
    page: page.page,
    text: page.text,
    error: page.error ?? null,
    updatedAt: new Date().toISOString(),
  }), 'utf8');
}

function splitPagesForWorkers(pages: number[], workerCount: number): number[][] {
  if (pages.length === 0) return [[]];
  const count = Math.min(normalizePdfOcrWorkerCount(workerCount), pages.length);
  const groups = Array.from({ length: count }, () => [] as number[]);
  pages.forEach((page, index) => {
    groups[index % count].push(page);
  });
  return groups.filter((group) => group.length > 0);
}

async function runOcrWorkerPool(input: {
  swiftCommand: string;
  swiftPrefixArgs: string[];
  pdfPath: string;
  pages: number[];
  workerCount: number;
  onPage?: (page: PdfOcrPageResult) => void;
}): Promise<PdfOcrResult> {
  const groups = splitPagesForWorkers(input.pages, input.workerCount);
  const controller = new AbortController();
  const results = await Promise.all(
    groups.map((group) =>
      runOcrWorker({
        swiftCommand: input.swiftCommand,
        swiftPrefixArgs: input.swiftPrefixArgs,
        pdfPath: input.pdfPath,
        pageArg: group.join(','),
        signal: controller.signal,
        onPage: input.onPage,
      }).catch((error) => {
        controller.abort();
        throw error;
      })
    )
  );
  return {
    pageCount: Math.max(...results.map((result) => result.pageCount), 0),
    pages: results
      .flatMap((result) => result.pages)
      .sort((a, b) => a.page - b.page),
  };
}

function runOcrWorker(input: {
  swiftCommand: string;
  swiftPrefixArgs: string[];
  pdfPath: string;
  pageArg: string;
  signal?: AbortSignal;
  onPage?: (page: PdfOcrPageResult) => void;
}): Promise<PdfOcrResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.swiftCommand, [...input.swiftPrefixArgs, input.pdfPath, input.pageArg], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pages: PdfOcrPageResult[] = [];
    let pageCount = 0;
    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;
    let removeAbortListener = () => {};

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      reject(error);
      child.kill();
    };

    if (input.signal) {
      const onAbort = () => fail(new Error('PDF OCR 已取消。'));
      input.signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => input.signal?.removeEventListener('abort', onAbort);
      if (input.signal.aborted) {
        fail(new Error('PDF OCR 已取消。'));
        return;
      }
    }

    const consumeLine = (line: string) => {
      if (!line.trim()) return;
      const parsed = JSON.parse(line) as {
        type?: string;
        pageCount?: number;
        page?: number;
        text?: string;
        error?: string | null;
      };
      if (parsed.type === 'meta') {
        pageCount = Number(parsed.pageCount ?? 0);
        return;
      }
      if (parsed.type !== 'page') return;
      const page = {
        page: Number(parsed.page),
        text: String(parsed.text ?? '').trim(),
        error: parsed.error ? String(parsed.error) : null,
      };
      if (Number.isFinite(page.page) && page.page > 0) {
        pages.push(page);
        input.onPage?.(page);
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          consumeLine(line);
        } catch (error) {
          fail(error);
          return;
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      try {
        if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);
      } catch (error) {
        fail(error);
        return;
      }
      if (code !== 0) {
        fail(new Error(stderr.trim() || `PDF OCR worker exited with code ${code}`));
        return;
      }
      settled = true;
      removeAbortListener();
      resolve({ pageCount, pages });
    });
  });
}
