const { app, BrowserWindow, shell, screen, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { start, PORT } = require('./server');

// Presenter-mode debug trail — read .presenter-debug.log when placement misbehaves.
function dbg(msg) {
  try { fs.appendFileSync(path.join(__dirname, '.presenter-debug.log'), new Date().toISOString() + ' ' + msg + '\n'); } catch (e) { /* best-effort */ }
}

app.setName('Marknote');

// Presentations can autoplay background music without a per-video gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 720,
    minHeight: 480,
    title: 'Marknote',
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.loadURL(`http://localhost:${PORT}`);

  // External links open in the default browser, not inside the app.
  // Exception: the presenter mode's display window — created covering the
  // full bounds of the external screen (TV/projector) with fullscreen set at
  // creation. Bounds + fullscreen together at creation is what reliably lands
  // on the right display (same recipe as the serializer app's cast window).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://localhost:${PORT}`) && url.includes('#display/')) {
      const primary = screen.getPrimaryDisplay();
      const target = screen.getAllDisplays().find((d) => d.id !== primary.id);
      const opts = target
        ? { x: target.bounds.x, y: target.bounds.y, width: target.bounds.width, height: target.bounds.height, fullscreen: true, frame: false, backgroundColor: '#000000' }
        : { width: 1024, height: 640, backgroundColor: '#000000' };
      return { action: 'allow', overrideBrowserWindowOptions: opts };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://localhost:${PORT}`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
}

// ——— presenter mode: display window on a chosen screen ———
// Created by the MAIN process with the target display's full bounds +
// fullscreen at creation (serializer's proven recipe) — window.open placement
// from the renderer is unreliable across screens.
let displayWindow = null;

function openDisplayWindow(displayId, file) {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  // displayId -1: plain window on the primary screen — for sharing in
  // Teams/Zoom while an external display is connected.
  const windowed = displayId === -1;
  const target = windowed
    ? primary
    : (displays.find((d) => d.id === displayId)
      || displays.find((d) => d.id !== primary.id)
      || primary);
  dbg(`present:open requested=${displayId} chose=${target.id} primary=${primary.id} bounds=${JSON.stringify(target.bounds)} all=${JSON.stringify(displays.map((d) => ({ id: d.id, label: d.label, bounds: d.bounds })))}`);
  if (displayWindow && !displayWindow.isDestroyed()) {
    const old = displayWindow;
    displayWindow = null;
    old.removeAllListeners('closed');
    old.destroy();
  }
  const external = !windowed && target.id !== primary.id;
  const b = target.bounds;
  displayWindow = new BrowserWindow({
    x: external ? b.x : b.x + 80,
    y: external ? b.y : b.y + 80,
    width: external ? b.width : 1024,
    height: external ? b.height : 640,
    fullscreen: external,
    frame: !external,
    backgroundColor: '#000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  displayWindow.loadURL(`http://localhost:${PORT}/#display/${encodeURIComponent(file)}`);
  displayWindow.on('closed', () => {
    displayWindow = null;
    // authoritative "the display is gone" signal — covers Esc, ×, the traffic
    // light and crashes alike (renderer-side messages die with the process)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('present:display-closed');
    }
  });
}

ipcMain.handle('present:displays', () => {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    label: d.label || `Display ${d.id}`,
    primary: d.id === primaryId,
    width: d.size.width,
    height: d.size.height
  }));
});
ipcMain.handle('present:open', (_e, id, file) => openDisplayWindow(id, file));
ipcMain.handle('present:close', () => {
  if (displayWindow && !displayWindow.isDestroyed()) displayWindow.destroy();
  displayWindow = null;
});

// ——— PDF export ———
// A hidden window loads the print view (#print/ = A4 document,
// #printdeck/ = landscape slide pages); the page sets window.__printReady
// once markdown, mermaid, images and fonts are done, then printToPDF runs.
ipcMain.handle('export:pdf', async (_e, file, isDeck, title) => {
  const w = new BrowserWindow({
    show: false,
    width: isDeck ? 1400 : 900,
    height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  try {
    const route = isDeck ? '#printdeck/' : '#print/';
    await w.loadURL(`http://localhost:${PORT}/${route}${encodeURIComponent(file)}`);
    const t0 = Date.now();
    let ready = false;
    while (Date.now() - t0 < 25000) {
      ready = await w.webContents.executeJavaScript('window.__printReady === true').catch(() => false);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!ready) return { error: 'render timed out' };
    const pdf = await w.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    const safe = String(title || 'note').replace(/[/\\:]/g, '-');
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: path.join(app.getPath('downloads'), safe + '.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (canceled || !filePath) return { canceled: true };
    fs.writeFileSync(filePath, pdf);
    shell.showItemInFolder(filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    dbg('export:pdf failed: ' + err.message);
    return { error: String(err.message).slice(0, 200) };
  } finally {
    if (!w.isDestroyed()) w.destroy();
  }
});

app.whenReady().then(async () => {
  try {
    await start();
  } catch (err) {
    // Port already taken — assume another instance's server is running and reuse it.
    if (err.code !== 'EADDRINUSE') throw err;
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// macOS convention: closing the window keeps the app in the Dock;
// clicking the Dock icon reopens it (see the 'activate' handler above).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
