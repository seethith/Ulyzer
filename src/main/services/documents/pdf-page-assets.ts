import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSourcePageAssetDir } from '../source/source-assets';
import { createDocumentJob, listDocumentJobs, updateDocumentJob } from './document-jobs';
import { listDocumentPageAssets, upsertDocumentPageAsset } from './document-store';
import type { DocumentAsset } from './document-types';
import { resolveSwiftBinary } from './swift-runtime';

const MAX_PAGE_ASSET_PAGES = 800;
const PAGE_ASSET_PROGRESS_STEP = 20;

const PDF_PAGE_ASSET_SWIFT_SCRIPT = String.raw`
import Foundation
import PDFKit
import AppKit

struct MetaResult: Encodable {
  let type: String
  let pageCount: Int
  let requestedCount: Int
}

struct PageAssetResult: Encodable {
  let type: String
  let page: Int
  let filePath: String?
  let width: Int?
  let height: Int?
  let error: String?
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

guard CommandLine.arguments.count >= 4 else {
  stderr("Usage: pdf-page-assets.swift <pdf-path> <out-dir> <pages> [max-dim]\n")
  exit(2)
}

let pdfPath = CommandLine.arguments[1]
let outDir = CommandLine.arguments[2]
let requestedPagesArg = CommandLine.arguments[3]
let maxDimension = CGFloat(Double(CommandLine.arguments.count > 4 ? CommandLine.arguments[4] : "960") ?? 960)

guard let document = PDFDocument(url: URL(fileURLWithPath: pdfPath)) else {
  stderr("pdf-load-failed")
  exit(3)
}

try FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
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
  let scale = min(CGFloat(2.0), max(CGFloat(0.5), maxDimension / max(bounds.width, bounds.height)))
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

emit(MetaResult(type: "meta", pageCount: pageCount, requestedCount: requestedPages.count))

for pageNumber in requestedPages {
  autoreleasepool {
    guard let page = document.page(at: pageNumber - 1) else {
      emit(PageAssetResult(type: "page", page: pageNumber, filePath: nil, width: nil, height: nil, error: "page-not-found"))
      return
    }
    guard let image = renderPage(page) else {
      emit(PageAssetResult(type: "page", page: pageNumber, filePath: nil, width: nil, height: nil, error: "page-render-failed"))
      return
    }
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.72]) else {
      emit(PageAssetResult(type: "page", page: pageNumber, filePath: nil, width: nil, height: nil, error: "jpeg-encode-failed"))
      return
    }
    let filePath = (outDir as NSString).appendingPathComponent(String(format: "page-%05d.jpg", pageNumber))
    do {
      try data.write(to: URL(fileURLWithPath: filePath), options: .atomic)
      emit(PageAssetResult(type: "page", page: pageNumber, filePath: filePath, width: image.width, height: image.height, error: nil))
    } catch {
      emit(PageAssetResult(type: "page", page: pageNumber, filePath: nil, width: nil, height: nil, error: String(describing: error)))
    }
  }
}
`;

interface RenderedPageAsset {
  page: number;
  filePath: string;
  width: number | null;
  height: number | null;
}

function hasActiveThumbnailJob(sourceId: string): boolean {
  return [...listDocumentJobs({ sourceId, state: 'pending', limit: 20 }), ...listDocumentJobs({ sourceId, state: 'running', limit: 20 })]
    .some((job) => job.jobType === 'thumbnail');
}

function pdfPageNumbers(asset: DocumentAsset): number[] {
  return asset.units
    .filter((unit) => unit.kind === 'page' && unit.pageNumber)
    .map((unit) => unit.pageNumber as number)
    .slice(0, MAX_PAGE_ASSET_PAGES);
}

export function maybeStartPdfPageAssetBackfill(input: {
  sourceId: string;
  asset: DocumentAsset;
  filePath?: string | null;
}): boolean {
  if (input.asset.kind !== 'pdf' || !input.filePath || process.platform !== 'darwin') return false;
  if (hasActiveThumbnailJob(input.sourceId)) return true;
  const existing = new Set(listDocumentPageAssets(input.sourceId, { assetType: 'thumbnail', limit: MAX_PAGE_ASSET_PAGES })
    .map((asset) => asset.pageNumber));
  const pages = pdfPageNumbers(input.asset).filter((page) => !existing.has(page));
  if (pages.length === 0) return false;

  const outDir = ensureSourcePageAssetDir(input.asset.courseId, input.sourceId);
  mkdirSync(outDir, { recursive: true });
  const job = createDocumentJob({
    sourceId: input.sourceId,
    courseId: input.asset.courseId,
    nodeId: input.asset.nodeId ?? null,
    jobType: 'thumbnail',
    progressTotal: pages.length,
    metadata: { pages, filePath: input.filePath, outDir },
  });

  void (async () => {
    let done = 0;
    try {
      updateDocumentJob(job.id, { state: 'running', progressCurrent: 0, progressTotal: pages.length });
      await renderPdfPageThumbnails({
        pdfPath: input.filePath!,
        outDir,
        pages,
        onPage: (page) => {
          done += 1;
          upsertDocumentPageAsset({
            sourceId: input.sourceId,
            asset: input.asset,
            pageNumber: page.page,
            assetType: 'thumbnail',
            filePath: page.filePath,
            mimeType: 'image/jpeg',
            width: page.width,
            height: page.height,
          });
          if (done % PAGE_ASSET_PROGRESS_STEP === 0 || done === pages.length) {
            updateDocumentJob(job.id, {
              state: 'running',
              progressCurrent: done,
              progressTotal: pages.length,
              metadata: { pages, filePath: input.filePath, outDir },
            });
          }
        },
      });
      updateDocumentJob(job.id, {
        state: 'ready',
        progressCurrent: pages.length,
        progressTotal: pages.length,
        error: null,
        metadata: { pages, filePath: input.filePath, outDir },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateDocumentJob(job.id, {
        state: 'failed',
        error: message,
        metadata: { pages, filePath: input.filePath, outDir },
      });
    }
  })();

  return true;
}

async function renderPdfPageThumbnails(input: {
  pdfPath: string;
  outDir: string;
  pages: number[];
  onPage?: (page: RenderedPageAsset) => void;
}): Promise<RenderedPageAsset[]> {
  // Prefer the precompiled binary (no Xcode toolchain needed); fall back to
  // interpreting the inline source via /usr/bin/swift when running from source.
  const binary = resolveSwiftBinary('pdf-page-assets');
  const dir = binary ? null : await mkdtemp(join(tmpdir(), 'ulyzer-pdf-pages-'));
  const swiftCommand = binary ?? '/usr/bin/swift';
  let swiftPrefixArgs: string[] = [];
  try {
    if (!binary && dir) {
      const scriptPath = join(dir, 'pdf-page-assets.swift');
      await writeFile(scriptPath, PDF_PAGE_ASSET_SWIFT_SCRIPT, 'utf8');
      swiftPrefixArgs = [scriptPath];
    }
    return await runPageAssetWorker({
      swiftCommand,
      swiftPrefixArgs,
      pdfPath: input.pdfPath,
      outDir: input.outDir,
      pageArg: input.pages.join(','),
      onPage: input.onPage,
    });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

function runPageAssetWorker(input: {
  swiftCommand: string;
  swiftPrefixArgs: string[];
  pdfPath: string;
  outDir: string;
  pageArg: string;
  onPage?: (page: RenderedPageAsset) => void;
}): Promise<RenderedPageAsset[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.swiftCommand, [...input.swiftPrefixArgs, input.pdfPath, input.outDir, input.pageArg, '960'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pages: RenderedPageAsset[] = [];
    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
      child.kill();
    };
    const consumeLine = (line: string) => {
      if (!line.trim()) return;
      const parsed = JSON.parse(line) as {
        type?: string;
        page?: number;
        filePath?: string;
        width?: number;
        height?: number;
        error?: string | null;
      };
      if (parsed.type !== 'page' || parsed.error || !parsed.filePath) return;
      const page = {
        page: Number(parsed.page),
        filePath: parsed.filePath,
        width: typeof parsed.width === 'number' ? parsed.width : null,
        height: typeof parsed.height === 'number' ? parsed.height : null,
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
        fail(new Error(stderr.trim() || `PDF page asset worker exited with code ${code}`));
        return;
      }
      settled = true;
      resolve(pages);
    });
  });
}
