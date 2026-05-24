import { app } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

function sanitizeName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'asset';
}

function extensionFor(input: { fileName: string; mimeType?: string }): string {
  const lowerName = input.fileName.toLowerCase();
  const extIndex = lowerName.lastIndexOf('.');
  if (extIndex >= 0) return lowerName.slice(extIndex);
  const mime = (input.mimeType ?? '').toLowerCase();
  if (mime.includes('wordprocessingml')) return '.docx';
  if (mime.includes('presentationml')) return '.pptx';
  if (mime.includes('spreadsheetml')) return '.xlsx';
  if (mime.includes('rtf')) return '.rtf';
  if (mime.includes('epub')) return '.epub';
  if (mime.includes('opendocument.text')) return '.odt';
  if (mime.includes('opendocument.spreadsheet')) return '.ods';
  if (mime.includes('opendocument.presentation')) return '.odp';
  if (mime.includes('opml')) return '.opml';
  if (mime.includes('freemind')) return '.mm';
  if (mime.includes('xmind')) return '.xmind';
  if (mime.includes('png')) return '.png';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('mp3')) return '.mp3';
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('mpeg')) return '.mp3';
  if (mime.includes('m4a')) return '.m4a';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('mp4')) return '.mp4';
  if (mime.includes('quicktime')) return '.mov';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('video/')) return '.mp4';
  if (mime.includes('pdf')) return '.pdf';
  return '';
}

export function getLibraryRoot(): string {
  return join(app.getPath('userData'), 'ulyzer-library');
}

export function getCourseLibraryDir(courseId: string): string {
  return join(getLibraryRoot(), courseId);
}

export function ensureCourseLibraryDir(courseId: string): string {
  const dir = getCourseLibraryDir(courseId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeSourceAsset(input: {
  courseId: string;
  sourceId: string;
  fileName: string;
  mimeType?: string;
  buffer: Buffer;
}): string {
  const dir = ensureCourseLibraryDir(input.courseId);
  const ext = extensionFor({ fileName: input.fileName, mimeType: input.mimeType });
  const baseName = sanitizeName(input.fileName.replace(/\.[^.]+$/, ''));
  const assetPath = join(dir, `${input.sourceId}-${baseName}${ext}`);
  writeFileSync(assetPath, input.buffer);
  return assetPath;
}

export function copySourceAsset(input: {
  courseId: string;
  sourceId: string;
  fileName?: string;
  mimeType?: string;
  sourcePath: string;
}): string {
  const dir = ensureCourseLibraryDir(input.courseId);
  const fileName = input.fileName || basename(input.sourcePath);
  const ext = extensionFor({ fileName, mimeType: input.mimeType });
  const baseName = sanitizeName(fileName.replace(/\.[^.]+$/, ''));
  const assetPath = join(dir, `${input.sourceId}-${baseName}${ext}`);
  if (assetPath !== input.sourcePath) copyFileSync(input.sourcePath, assetPath);
  return assetPath;
}

export function ensureSourcePageAssetDir(courseId: string, sourceId: string): string {
  const dir = join(ensureCourseLibraryDir(courseId), `${sourceId}-pages`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function deleteSourceAsset(filePath?: string | null): void {
  if (!filePath) return;
  if (!existsSync(filePath)) return;
  rmSync(filePath, { force: true });
}

export function deleteCourseLibraryAssetsBySourceId(courseId: string, sourceId: string): void {
  const dir = getCourseLibraryDir(courseId);
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith(`${sourceId}-`)) continue;
    rmSync(join(dir, entry), { force: true, recursive: true });
  }
}

export function deleteCourseLibraryAssets(courseId: string): void {
  const dir = getCourseLibraryDir(courseId);
  if (!existsSync(dir)) return;
  rmSync(dir, { force: true, recursive: true });
}
