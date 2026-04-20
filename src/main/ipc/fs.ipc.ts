import { ipcMain, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { IPC } from '@shared/ipc-channels';
import type { IpcResponse, FsEntry } from '@shared/types';
import {
  ensureCourseDir, ensureNodeDir, listNodeTree,
  readFileContent, writeFileContent, deleteFileFs,
  createFile, createFolder, renameItem, copyFile,
  getNodeDir, getContentRoot,
} from '../services/fs/content.service';

function assertInsideContentRoot(targetPath: string): string {
  const root = path.resolve(getContentRoot());
  const resolved = path.resolve(targetPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Path is outside the Ulyzer content workspace');
  }
  return resolved;
}

function assertSimpleName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
    throw new Error('Invalid file or folder name');
  }
  return trimmed;
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

  ipcMain.handle(IPC.FS_DELETE_FILE, (_e, filePath: string): IpcResponse<void> => {
    try { deleteFileFs(assertInsideContentRoot(filePath)); return { success: true }; }
    catch (err) { return { success: false, error: String(err) }; }
  });

  // parentPath is the absolute directory in which to create
  ipcMain.handle(
    IPC.FS_CREATE_FILE,
    (_e, parentPath: string, name: string): IpcResponse<string> => {
      try {
        const parent = assertInsideContentRoot(parentPath);
        const cleanName = assertSimpleName(name);
        const fileName = cleanName.includes('.') ? cleanName : `${cleanName}.md`;
        const filePath = assertInsideContentRoot(path.join(parent, fileName));
        createFile(filePath);
        return { success: true, data: filePath };
      } catch (err) { return { success: false, error: String(err) }; }
    }
  );

  ipcMain.handle(
    IPC.FS_CREATE_FOLDER,
    (_e, parentPath: string, name: string): IpcResponse<string> => {
      try {
        const parent = assertInsideContentRoot(parentPath);
        const folderPath = assertInsideContentRoot(path.join(parent, assertSimpleName(name)));
        createFolder(folderPath);
        return { success: true, data: folderPath };
      } catch (err) { return { success: false, error: String(err) }; }
    }
  );

  ipcMain.handle(
    IPC.FS_RENAME,
    (_e, oldPath: string, newName: string): IpcResponse<string> => {
      try {
        const renamed = renameItem(assertInsideContentRoot(oldPath), assertSimpleName(newName));
        return { success: true, data: assertInsideContentRoot(renamed) };
      }
      catch (err) { return { success: false, error: String(err) }; }
    }
  );

  ipcMain.handle(
    IPC.FS_COPY_FILE,
    (_e, srcPath: string, destDir: string): IpcResponse<string> => {
      try {
        const copied = copyFile(assertInsideContentRoot(srcPath), assertInsideContentRoot(destDir));
        return { success: true, data: assertInsideContentRoot(copied) };
      }
      catch (err) { return { success: false, error: String(err) }; }
    }
  );

  ipcMain.handle(
    IPC.FS_OPEN_PATH,
    (_e, arg1: string, arg2?: string): IpcResponse<void> => {
      try {
        if (arg2 !== undefined) {
          // Called as (courseId, nodeId) from FileExplorer — open the node directory
          shell.openPath(getNodeDir(arg1, arg2));
        } else {
          // Called as (filePath) from EditorArea — reveal the specific file in Finder
          shell.showItemInFolder(assertInsideContentRoot(arg1));
        }
        return { success: true };
      } catch (err) { return { success: false, error: String(err) }; }
    }
  );

  ipcMain.handle(
    IPC.FS_READ_FILE_BINARY,
    (_e, filePath: string): IpcResponse<string> => {
      try {
        const data = fs.readFileSync(assertInsideContentRoot(filePath));
        return { success: true, data: data.toString('base64') };
      } catch (err) { return { success: false, error: String(err) }; }
    }
  );

  ipcMain.handle(
    IPC.SHELL_OPEN_URL,
    (_e, url: string): IpcResponse<void> => {
      try {
        if (url.startsWith('http://') || url.startsWith('https://')) {
          shell.openExternal(url);
        }
        return { success: true };
      } catch (err) { return { success: false, error: String(err) }; }
    }
  );
}
