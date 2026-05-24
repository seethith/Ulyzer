/**
 * Runtime resolver for the bundled Swift OCR / PDF tools.
 *
 * The .swift sources live in `src/main/services/**` as inline constants and are
 * precompiled to native binaries (`resources/swift/bin/ulyzer-<tool>`) at build
 * time by `scripts/build-swift.mjs`. Preferring the precompiled binary means the
 * user's machine needs NO Swift toolchain / Xcode Command Line Tools.
 *
 * When the binary is absent (e.g. running from source without `build:swift`),
 * callers fall back to interpreting the inline .swift source via `/usr/bin/swift`,
 * so the dev experience keeps working. macOS-only.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

export type SwiftTool = 'pdf-ocr' | 'pdf-text-layer' | 'pdf-page-assets' | 'image-ocr';

function swiftBinDir(): string {
  // Packaged: electron-builder `extraResources` copies resources/ into
  //   <App>/Contents/Resources/. Dev: resources/ sits at the project root.
  return app.isPackaged
    ? join(process.resourcesPath, 'swift', 'bin')
    : join(app.getAppPath(), 'resources', 'swift', 'bin');
}

/**
 * Absolute path to the precompiled binary for a tool, or null when it isn't
 * present (non-macOS, or running from source before `build:swift`). When null,
 * callers should fall back to interpreting the inline swift source.
 */
export function resolveSwiftBinary(tool: SwiftTool): string | null {
  if (process.platform !== 'darwin') return null;
  const binary = join(swiftBinDir(), `ulyzer-${tool}`);
  return existsSync(binary) ? binary : null;
}
