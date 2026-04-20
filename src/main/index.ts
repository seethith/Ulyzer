import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import icon from '../../resources/icon.png?asset';
import { initDb, closeDb } from './services/db/sqlite';
import { registerAllHandlers } from './ipc';
import { migrateAllFolders } from './services/fs/content.service';
import { IPC } from '../../shared/ipc-channels';

function createWindow(): void {
  const mainWindow = new BrowserWindow({
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

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });

  ipcMain.handle(IPC.WINDOW_MINIMIZE, () => mainWindow.minimize());
  ipcMain.handle(IPC.WINDOW_MAXIMIZE, () => {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.handle(IPC.WINDOW_CLOSE, () => mainWindow.close());

  mainWindow.webContents.setWindowOpenHandler(() => {
    // URL opening is handled explicitly via IPC.SHELL_OPEN_URL — deny all
    // new-window requests to prevent unintended Electron windows from opening.
    return { action: 'deny' };
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
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
