import { app, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, NativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { IPC } from '@shared/ipc-channels';
import { attachmentMimeType } from '@shared/attachment-formats';
import type { IpcResponse, FsEntry, LocalFilePickRequest, PickedLocalFile } from '@shared/types';
import {
  ensureCourseDir, ensureNodeDir, listNodeTree,
  readFileContent, writeFileContent, deleteFileFsResult,
  createFile, createFolder, renameItem, copyFile, copyPathsToDirectory, importPaths, moveItem,
  getNodeDir, getContentRoot,
} from '../services/fs/content.service';
import { recordCleanupFailure } from '../services/storage/storage-cleanup';

function assertInsideContentRoot(targetPath: string): string {
  const root = path.resolve(getContentRoot());
  const resolved = path.resolve(targetPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Path is outside the Ulyzer content workspace');
  }
  return resolved;
}

function readableRoots(): string[] {
  return [getContentRoot(), appBackgroundDir()].map((root) => path.resolve(root));
}

function assertReadableBinaryPath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  if (!readableRoots().some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
    throw new Error('Path is outside readable Ulyzer folders');
  }
  return resolved;
}

function resolveOpenablePath(targetPath: string): string {
  // showItemInFolder only highlights the file in the OS file manager (no read, no
  // execute) and is intentionally used to reveal a source's *original* file, which
  // may live outside the content root — so any path is allowed here. Paths that can
  // be read (assertReadableBinaryPath) or opened/executed (openPath below) stay
  // strictly confined to the content root.
  return path.resolve(targetPath);
}

function assertSimpleName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
    throw new Error('Invalid file or folder name');
  }
  return trimmed;
}

function emitFsChanged(event: IpcMainInvokeEvent, paths: string[]): void {
  event.sender.send(IPC.FS_CHANGED, { paths });
}

function dragIconPath(): string {
  const candidates = [
    path.join(process.cwd(), 'resources', 'icon.png'),
    path.join(process.cwd(), 'build', 'icon.png'),
    path.join(app.getAppPath(), 'resources', 'icon.png'),
    path.join(app.getAppPath(), 'build', 'icon.png'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function createDragIcon(): NativeImage {
  const iconPath = dragIconPath();
  if (fs.existsSync(iconPath)) {
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) return image.resize({ width: 32, height: 32 });
  }
  return nativeImage.createEmpty();
}

let fileClipboardPaths: string[] = [];

const BACKGROUND_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_BACKGROUND_IMAGE_BYTES = 50 * 1024 * 1024;

function appBackgroundDir(): string {
  return path.join(app.getPath('userData'), 'backgrounds');
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'background';
}

function importBackgroundImage(sourcePath: string): string {
  const source = path.resolve(sourcePath);
  const stat = fs.statSync(source);
  if (!stat.isFile()) throw new Error('请选择图片文件');
  if (stat.size > MAX_BACKGROUND_IMAGE_BYTES) throw new Error('背景图片不能超过 50 MB');

  const ext = path.extname(source).toLowerCase();
  if (!BACKGROUND_IMAGE_EXTENSIONS.has(ext)) {
    throw new Error('仅支持 JPG、PNG、WebP 背景图片');
  }

  if (ext !== '.webp') {
    const image = nativeImage.createFromPath(source);
    if (image.isEmpty()) throw new Error('无法读取这张图片，请换一张试试');
  }

  const targetDir = appBackgroundDir();
  fs.mkdirSync(targetDir, { recursive: true });
  const safeName = sanitizeFileName(path.basename(source, ext));
  const target = path.join(targetDir, `${Date.now()}-${safeName}${ext}`);
  fs.copyFileSync(source, target);
  return target;
}

function existingPaths(paths: string[]): string[] {
  return paths.map((p) => path.resolve(p)).filter((p) => fs.existsSync(p));
}

function readMacosFilePathsFromPasteboard(): string[] {
  if (process.platform !== 'darwin') return [];

  const script = `
ObjC.import('AppKit');
ObjC.import('Foundation');
const pasteboard = $.NSPasteboard.generalPasteboard;
const classes = $.NSArray.arrayWithObject($.NSURL);
const options = $.NSDictionary.dictionaryWithObjectForKey(
  $.NSNumber.numberWithBool(true),
  $.NSPasteboardURLReadingFileURLsOnlyKey
);
const urls = pasteboard.readObjectsForClassesOptions(classes, options);
const out = [];
if (urls) {
  for (let i = 0; i < urls.count; i += 1) {
    const url = urls.objectAtIndex(i);
    if (url.isFileURL) out.push(ObjC.unwrap(url.path));
  }
}
out.join('\\n');
`;

  try {
    return execFileSync('osascript', ['-l', 'JavaScript', '-e', script], {
      timeout: 1500,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeFilePathsToSystemClipboard(paths: string[]): void {
  const cleanPaths = existingPaths(paths);
  if (process.platform !== 'darwin' || cleanPaths.length === 0) {
    clipboard.writeText(cleanPaths.join('\n'));
    return;
  }

  try {
    const script = `
ObjC.import('AppKit');
ObjC.import('Foundation');
const paths = ${JSON.stringify(cleanPaths)};
const pasteboard = $.NSPasteboard.generalPasteboard;
const urls = $.NSMutableArray.array;
for (let i = 0; i < paths.length; i += 1) {
  urls.addObject($.NSURL.fileURLWithPath(paths[i]));
}
pasteboard.clearContents;
pasteboard.writeObjects(urls);
pasteboard.setStringForType(paths.join('\\n'), $.NSPasteboardTypeString);
`;
    execFileSync('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 1500, stdio: 'ignore' });
  } catch {
    clipboard.writeText(cleanPaths.join('\n'));
  }
}

function fileUrlToPath(value: string): string | null {
  const trimmed = value.replace(/\0/g, '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(trimmed).pathname);
    } catch {
      return null;
    }
  }
  return path.isAbsolute(trimmed) ? trimmed : null;
}

function readFilePathsFromSystemClipboard(): string[] {
  const candidates: string[] = [];
  candidates.push(...readMacosFilePathsFromPasteboard());

  const bookmark = clipboard.readBookmark();
  const bookmarkPath = fileUrlToPath(bookmark.url);
  if (bookmarkPath) candidates.push(bookmarkPath);

  for (const format of ['public.file-url', 'public.url', 'text/uri-list', 'NSFilenamesPboardType']) {
    try {
      const raw = clipboard.readBuffer(format).toString('utf-8');
      for (const line of raw.split(/\0|\r?\n/)) {
        const p = fileUrlToPath(line);
        if (p) candidates.push(p);
      }
    } catch {
      // Some native clipboard formats are not readable through Electron on every platform.
    }
  }

  for (const line of clipboard.readText().split(/\r?\n/)) {
    const p = fileUrlToPath(line);
    if (p) candidates.push(p);
  }

  return existingPaths(Array.from(new Set(candidates)));
}

function readClipboardFilePaths(): string[] {
  const system = readFilePathsFromSystemClipboard();
  if (system.length > 0) return system;
  return existingPaths(fileClipboardPaths);
}

function extensionsFromAccept(accept?: string): string[] {
  if (!accept) return [];
  return accept
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('.'))
    .map((part) => part.slice(1).toLowerCase())
    .filter(Boolean);
}

export function registerFsHandlers(): void {
  ipcMain.handle(IPC.FS_ENSURE_COURSE, (_e, courseId: string): IpcResponse<void> => {
    try { ensureCourseDir(courseId); return { success: true }; }
    catch (err) { return { success: false, error: String(err) }; }
  });

  ipcMain.handle(IPC.FS_ENSURE_NODE, (_e, courseId: string, nodeId: string, language?: string): IpcResponse<void> => {
    try { ensureNodeDir(courseId, nodeId, language); return { success: true }; }
    catch (err) { return { success: false, error: String(err) }; }
  });

  ipcMain.handle(IPC.FS_LIST_NODE, (_e, courseId: string, nodeId: string): IpcResponse<FsEntry> => {
    try { return { success: true, data: listNodeTree(courseId, nodeId) }; }
    catch (err) { return { success: false, error: String(err) }; }
  });

  ipcMain.handle(IPC.FS_READ_FILE, (_e, filePath: string): IpcResponse<string> => {
    try { return { success: true, data: readFileContent(assertInsideContentRoot(filePath)) }; }
    catch (err) { return { success: false, error: String(err) }; }
  });

  ipcMain.handle(IPC.FS_WRITE_FILE, (_e, filePath: string, content: string): IpcResponse<void> => {
    try { writeFileContent(assertInsideContentRoot(filePath), content); return { success: true }; }
    catch (err) { return { success: false, error: String(err) }; }
  });

  ipcMain.handle(IPC.FS_DELETE_FILE, (event, filePath: string): IpcResponse<void> => {
    try {
      const resolved = assertInsideContentRoot(filePath);
      const deleted = deleteFileFsResult(resolved);
      if (!deleted.success) {
        recordCleanupFailure({
          path: resolved,
          kind: 'workspace-file',
          reason: '工作区文件删除失败',
          error: deleted.error,
        });
        return { success: false, error: deleted.error };
      }
      emitFsChanged(event, [resolved]);
      return { success: true };
    }
    catch (err) { return { success: false, error: String(err) }; }
  });

  // parentPath is the absolute directory in which to create
  ipcMain.handle(
    IPC.FS_CREATE_FILE,
    (event, parentPath: string, name: string): IpcResponse<string> => {
      try {
        const parent = assertInsideContentRoot(parentPath);
        const cleanName = assertSimpleName(name);
        const fileName = cleanName.includes('.') ? cleanName : `${cleanName}.md`;
        const filePath = assertInsideContentRoot(path.join(parent, fileName));
        createFile(filePath);
        emitFsChanged(event, [filePath]);
        return { success: true, data: filePath };
      } catch (err) { return { success: false, error: String(err) }; }
    }
  );

  ipcMain.handle(
    IPC.FS_CREATE_FOLDER,
    (event, parentPath: string, name: string): IpcResponse<string> => {
      try {
        const parent = assertInsideContentRoot(parentPath);
        const folderPath = assertInsideContentRoot(path.join(parent, assertSimpleName(name)));
        createFolder(folderPath);
        emitFsChanged(event, [folderPath]);
        return { success: true, data: folderPath };
      } catch (err) { return { success: false, error: String(err) }; }
    }
  );

  ipcMain.handle(
    IPC.FS_RENAME,
    (event, oldPath: string, newName: string): IpcResponse<string> => {
      try {
        const oldResolved = assertInsideContentRoot(oldPath);
        const renamed = assertInsideContentRoot(renameItem(oldResolved, assertSimpleName(newName)));
        emitFsChanged(event, [oldResolved, renamed]);
        return { success: true, data: renamed };
      }
      catch (err) { return { success: false, error: String(err) }; }
    }
  );

  ipcMain.handle(
    IPC.FS_COPY_FILE,
    (event, srcPath: string, destDir: string): IpcResponse<string> => {
      try {
        const copied = assertInsideContentRoot(copyFile(assertInsideContentRoot(srcPath), assertInsideContentRoot(destDir)));
        emitFsChanged(event, [copied]);
        return { success: true, data: copied };
      }
      catch (err) { return { success: false, error: String(err) }; }
    }
  );

  ipcMain.handle(
    IPC.FS_COPY_TO_CLIPBOARD,
    (_event, srcPath: string): IpcResponse<void> => {
      try {
        const src = assertInsideContentRoot(srcPath);
        fileClipboardPaths = [src];
        writeFilePathsToSystemClipboard(fileClipboardPaths);
        return { success: true };
      }
      catch (err) { return { success: false, error: String(err) }; }
    }
  );

  ipcMain.handle(
    IPC.FS_PASTE_CLIPBOARD,
    (event, destDir: string): IpcResponse<string[]> => {
      try {
        const dest = assertInsideContentRoot(destDir);
        const paths = readClipboardFilePaths();
        if (paths.length === 0) throw new Error('剪贴板里没有可粘贴的文件或文件夹');
        const copied = copyPathsToDirectory(paths, dest).map((p) => assertInsideContentRoot(p));
        emitFsChanged(event, copied);
        return { success: true, data: copied };
      }
      catch (err) { return { success: false, error: String(err) }; }
    }
  );

  ipcMain.handle(
    IPC.FS_MOVE,
    (event, srcPath: string, destDir: string): IpcResponse<string> => {
      try {
        const src = assertInsideContentRoot(srcPath);
        const moved = assertInsideContentRoot(moveItem(src, assertInsideContentRoot(destDir)));
        emitFsChanged(event, [src, moved]);
        return { success: true, data: moved };
      }
      catch (err) { return { success: false, error: String(err) }; }
    }
  );

  ipcMain.handle(
    IPC.FS_IMPORT_PATHS,
    (event, srcPaths: string[], destDir: string): IpcResponse<string[]> => {
      try {
        const sources = Array.isArray(srcPaths)
          ? srcPaths.map((src) => path.resolve(src)).filter(Boolean)
          : [];
        if (sources.length === 0) throw new Error('没有可导入的文件');
        const imported = importPaths(sources, assertInsideContentRoot(destDir)).map((p) => assertInsideContentRoot(p));
        emitFsChanged(event, imported);
        return { success: true, data: imported };
      }
      catch (err) { return { success: false, error: String(err) }; }
    }
  );

  ipcMain.on(
    IPC.FS_START_DRAG_OUT,
    (event: IpcMainEvent, filePaths: string[]) => {
      try {
        const files = Array.isArray(filePaths)
          ? filePaths.map((filePath) => assertInsideContentRoot(filePath))
          : [];
        if (files.length === 0) throw new Error('没有可拖出的文件');
        event.sender.startDrag({ file: files[0], files, icon: createDragIcon() });
      }
      catch (err) {
        console.warn('[FS_START_DRAG_OUT] failed:', err);
      }
    }
  );

  ipcMain.handle(
    IPC.FS_OPEN_PATH,
    (_e, arg1: string, arg2?: string): IpcResponse<void> => {
      try {
        if (arg2 !== undefined) {
          // Called as (courseId, nodeId) from FileExplorer — open the node directory.
          // courseId/nodeId are DB ids; reject anything with path separators before
          // building the path, then re-check the result stays inside the content root.
          assertSimpleName(arg1);
          assertSimpleName(arg2);
          shell.openPath(assertInsideContentRoot(getNodeDir(arg1, arg2)));
        } else {
          // Called as (filePath) from editors/library — reveal the original file in Finder
          shell.showItemInFolder(resolveOpenablePath(arg1));
        }
        return { success: true };
      } catch (err) { return { success: false, error: String(err) }; }
    }
  );

  ipcMain.handle(
    IPC.FS_PICK_FILES,
    async (_e, input?: LocalFilePickRequest): Promise<IpcResponse<PickedLocalFile[]>> => {
      try {
        const extensions = extensionsFromAccept(input?.accept);
        const result = await dialog.showOpenDialog({
          title: input?.title || '选择文件',
          properties: input?.multiple === false ? ['openFile'] : ['openFile', 'multiSelections'],
          filters: extensions.length > 0
            ? [{ name: 'Supported files', extensions }]
            : undefined,
        });
        if (result.canceled) return { success: true, data: [] };
        const selectedPaths = input?.importAs === 'background-image'
          ? result.filePaths.slice(0, 1).map(importBackgroundImage)
          : result.filePaths;
        const files = selectedPaths.map((filePath) => {
          const stat = fs.statSync(filePath);
          const name = path.basename(filePath);
          return {
            path: filePath,
            name,
            size: stat.size,
            mimeType: attachmentMimeType(name),
          };
        });
        return { success: true, data: files };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  );
  ipcMain.handle(
    IPC.FS_READ_FILE_BINARY,
    (_e, filePath: string): IpcResponse<string> => {
      try {
        const data = fs.readFileSync(assertReadableBinaryPath(filePath));
        return { success: true, data: data.toString('base64') };
      } catch (err) { return { success: false, error: String(err) }; }
    }
  );

  ipcMain.handle(
    IPC.SHELL_OPEN_URL,
    (_e, url: string): IpcResponse<void> => {
      try {
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          return { success: false, error: 'Only http(s) URLs can be opened externally' };
        }
        shell.openExternal(url);
        return { success: true };
      } catch (err) { return { success: false, error: String(err) }; }
    }
  );
}
