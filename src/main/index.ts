import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import icon from '../../resources/icon.png?asset';
import { initDb, closeDb } from './services/db/sqlite';
import { registerAllHandlers } from './ipc';
import { migrateAllFolders } from './services/fs/content.service';
import { refreshStaleModelsDevCapabilityCache } from './services/llm/model-capability-cache';
import { runStartupMaintenance } from './services/maintenance/startup-maintenance';
import { IPC } from '../../shared/ipc-channels';

// Set the app name before anything reads it, so the macOS menu bar shows
// "Ulyzer" (not "Electron") and app.getName()-derived paths are consistent
// with the packaged build (productName: Ulyzer in electron-builder.yml).
app.setName('Ulyzer');

let mainWindow: BrowserWindow | null = null;
let windowControlHandlersRegistered = false;

function getWindowForControl(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? mainWindow;
}

function registerWindowControlHandlers(): void {
  if (windowControlHandlersRegistered) return;
  windowControlHandlersRegistered = true;

  ipcMain.handle(IPC.WINDOW_MINIMIZE, () => {
    getWindowForControl()?.minimize();
  });
  ipcMain.handle(IPC.WINDOW_MAXIMIZE, () => {
    const window = getWindowForControl();
    if (!window) return;
    window.isMaximized() ? window.unmaximize() : window.maximize();
  });
  ipcMain.handle(IPC.WINDOW_CLOSE, () => {
    getWindowForControl()?.close();
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 6, y: 11 },
    } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow = window;

  window.on('ready-to-show', () => {
    window.show();
  });

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  window.webContents.setWindowOpenHandler(() => {
    // URL opening is handled explicitly via IPC.SHELL_OPEN_URL — deny all
    // new-window requests to prevent unintended Electron windows from opening.
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    const currentUrl = window.webContents.getURL();
    // Same-origin navigation (the app's own page) is allowed; everything else is
    // blocked. http(s) targets are handed to the OS browser; any other protocol
    // (file:, data:, javascript:, …) is silently denied.
    let sameOrigin = false;
    try {
      sameOrigin = !!currentUrl && new URL(url).origin === new URL(currentUrl).origin;
    } catch {
      sameOrigin = false;
    }
    if (sameOrigin) return;
    event.preventDefault();
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.ulyzer.app');

  // Set dock icon on macOS (BrowserWindow icon option only works on Linux)
  if (process.platform === 'darwin') {
    app.dock?.setIcon(icon);
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // Initialize database (runs migrations)
  initDb();

  // Rename any UUID-named course/node folders to human-readable names
  migrateAllFolders();

  // Register all IPC handlers
  registerAllHandlers();
  registerWindowControlHandlers();

  // Local housekeeping: fix interrupted agent runs + prune stale resume state.
  runStartupMaintenance();
  void refreshStaleModelsDevCapabilityCache().catch(() => {
    // Network/cache refresh is best-effort; app startup should not depend on it.
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('quit', () => {
  closeDb();
});
