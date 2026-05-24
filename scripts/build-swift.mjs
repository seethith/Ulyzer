#!/usr/bin/env node
/**
 * Precompile the bundled Swift OCR / PDF tools to native binaries so the shipped
 * app needs NO Swift toolchain / Xcode Command Line Tools on the user's machine.
 *
 * Each tool's source is the `String.raw` constant already embedded in the TS
 * services (single source of truth, also used as the /usr/bin/swift fallback when
 * running from source). We extract it, compile with `swiftc -O`, and emit to
 * `resources/swift/bin/ulyzer-<tool>`, which electron-builder ships via
 * `extraResources`. macOS-only; on other platforms this is a no-op.
 */
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const TARGETS = [
  { file: 'src/main/services/documents/pdf-ocr.ts',          name: 'PDF_OCR_SWIFT_SCRIPT',        out: 'pdf-ocr' },
  { file: 'src/main/services/documents/pdf-text-layer.ts',   name: 'SWIFT_PDF_TEXT_SCRIPT',       out: 'pdf-text-layer' },
  { file: 'src/main/services/documents/pdf-page-assets.ts',  name: 'PDF_PAGE_ASSET_SWIFT_SCRIPT', out: 'pdf-page-assets' },
  { file: 'src/main/services/source/local-ocr.ts',           name: 'SWIFT_OCR_SCRIPT',            out: 'image-ocr' },
];

if (process.platform !== 'darwin') {
  console.log('[build-swift] not macOS — skipping (Swift OCR binaries are macOS-only).');
  process.exit(0);
}

const binDir = join('resources', 'swift', 'bin');
mkdirSync(binDir, { recursive: true });

for (const target of TARGETS) {
  const src = readFileSync(target.file, 'utf8');
  const match = src.match(new RegExp('const ' + target.name + ' = String\\.raw`([\\s\\S]*?)`'));
  if (!match) {
    console.error(`[build-swift] could not find ${target.name} in ${target.file}`);
    process.exit(1);
  }
  const code = match[1].replace(/^\n/, '');
  const swiftFile = join(tmpdir(), `ulyzer-build-${target.out}.swift`);
  writeFileSync(swiftFile, code, 'utf8');
  const outBin = join(binDir, `ulyzer-${target.out}`);
  try {
    execFileSync('swiftc', ['-O', '-o', outBin, swiftFile], { stdio: 'inherit' });
    console.log(`[build-swift] compiled ${target.out}`);
  } finally {
    rmSync(swiftFile, { force: true });
  }
}

console.log(`[build-swift] done → ${binDir}`);
