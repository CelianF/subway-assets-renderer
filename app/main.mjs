// Desktop app: runs the viewer server in-process and shows it in a window.
// Data lives in the OS data folder, under "Subway Assets Renderer":
//   macOS    ~/Library/Application Support/Subway Assets Renderer/workspace
//   Windows  %LOCALAPPDATA%\Subway Assets Renderer\workspace  (not Roaming: extractions use ~2 GB)
//   Linux    ~/.config/Subway Assets Renderer/workspace
import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';

const APP_NAME = 'Subway Assets Renderer';
const IS_WIN = process.platform === 'win32';

app.setName(APP_NAME);
app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));
const dataDir = IS_WIN && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, APP_NAME) : app.getPath('userData');

// Everything is served from this machine on a new port each launch, so cached copies of
// maps are never reused and only pile up (hundreds of MB): no HTTP cache
app.commandLine.appendSwitch('disable-http-cache');

// Read by server/api.js when it is first imported
process.env.SUBWAY_WORKSPACE ??= path.join(dataDir, 'workspace');
if (app.isPackaged) process.env.SUBWAY_RIPPER ??= path.join(process.resourcesPath, 'ripper', IS_WIN ? 'ripper.exe' : 'ripper');

let window = null;

function createWindow(port) {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: APP_NAME,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
  });
  const origin = `http://127.0.0.1:${port}`;
  // Links leaving the viewer open in the browser
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(origin)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  window.on('closed', () => (window = null));
  window.loadURL(origin);
}

// One instance at a time: two servers would share the same workspace
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(async () => {
    try {
      const { start } = await import('../server/index.js');
      const port = await start({ port: 0, host: '127.0.0.1' });
      createWindow(port);
    } catch (e) {
      dialog.showErrorBox(APP_NAME, `Could not start: ${e.message}`);
      app.quit();
    }
  });
}
