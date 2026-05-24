import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { resolveSwiftBinary } from './swift-runtime';

const execFileAsync = promisify(execFile);

export interface PdfTextLayerPage {
  page: number;
  text: string;
}

export interface PdfTextLayerResult {
  pageCount: number;
  pages: PdfTextLayerPage[];
  encrypted: boolean;
}

const SWIFT_PDF_TEXT_SCRIPT = String.raw`
import Foundation
import PDFKit

struct PageOut: Codable {
  let page: Int
  let text: String
}

struct Output: Codable {
  let pageCount: Int
  let encrypted: Bool
  let pages: [PageOut]
}

let args = CommandLine.arguments
guard args.count >= 3 else {
  fputs("Usage: pdf-text-layer.swift <pdf-path> <out-json>\n", stderr)
  exit(2)
}

let pdfURL = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])

guard let document = PDFDocument(url: pdfURL) else {
  fputs("Unable to open PDF\n", stderr)
  exit(3)
}

let count = document.pageCount
var pages: [PageOut] = []
pages.reserveCapacity(count)

for index in 0..<count {
  autoreleasepool {
    let page = document.page(at: index)
    let text = page?.string ?? ""
    pages.append(PageOut(page: index + 1, text: text))
  }
}

let output = Output(pageCount: count, encrypted: document.isEncrypted, pages: pages)
let data = try JSONEncoder().encode(output)
try data.write(to: outURL)
`;

export async function extractPdfTextLayer(pdfPath: string): Promise<PdfTextLayerResult> {
  const dir = await mkdtemp(join(tmpdir(), 'ulyzer-pdf-text-'));
  const outputPath = join(dir, 'pages.json');
  try {
    // Prefer the precompiled binary (no Xcode toolchain needed); fall back to
    // interpreting the inline source when running from source before build:swift.
    const binary = resolveSwiftBinary('pdf-text-layer');
    const command = binary ?? '/usr/bin/swift';
    let prefixArgs: string[] = [];
    if (!binary) {
      const scriptPath = join(dir, 'extract-pdf-text.swift');
      await writeFile(scriptPath, SWIFT_PDF_TEXT_SCRIPT, 'utf8');
      prefixArgs = [scriptPath];
    }
    await execFileAsync(command, [...prefixArgs, pdfPath, outputPath], {
      timeout: 90_000,
      maxBuffer: 1024 * 1024 * 4,
    });
    const parsed = JSON.parse(await readFile(outputPath, 'utf8')) as PdfTextLayerResult;
    return {
      pageCount: parsed.pageCount,
      encrypted: Boolean(parsed.encrypted),
      pages: Array.isArray(parsed.pages)
        ? parsed.pages.map((page) => ({
          page: Number(page.page),
          text: typeof page.text === 'string' ? page.text : '',
        })).filter((page) => Number.isFinite(page.page) && page.page > 0)
        : [],
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
