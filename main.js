const { app, BrowserWindow, shell, screen, ipcMain, dialog, session, desktopCapturer, globalShortcut } = require('electron');

// System-audio loopback for the meeting recorder: Chromium supports it on
// macOS 13+ via ScreenCaptureKit / Core Audio taps, but only behind these
// feature flags (harmless on other platforms; Windows has native loopback).
app.commandLine.appendSwitch(
  'enable-features',
  'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride'
);
const path = require('path');
const fs = require('fs');
const { start, PORT, DATA_ROOT } = require('./server');

// Presenter-mode debug trail — read .presenter-debug.log when placement misbehaves.
function dbg(msg) {
  try { fs.appendFileSync(path.join(DATA_ROOT, '.presenter-debug.log'), new Date().toISOString() + ' ' + msg + '\n'); } catch (e) { /* best-effort */ }
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

// Save arbitrary text (transcripts etc.) via the OS save dialog.
ipcMain.handle('save:text', async (_e, defaultName, content) => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: path.join(app.getPath('downloads'), String(defaultName || 'export.txt').replace(/[/\\:]/g, '-')),
      filters: [{ name: 'Text', extensions: ['txt'] }]
    });
    if (canceled || !filePath) return { canceled: true };
    fs.writeFileSync(filePath, String(content));
    shell.showItemInFolder(filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    return { error: String(err.message).slice(0, 200) };
  }
});

// ——— backup export ———
ipcMain.handle('backup:save', async () => {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: path.join(app.getPath('downloads'), `Marknote backup ${stamp}.zip`),
      filters: [{ name: 'Zip', extensions: ['zip'] }]
    });
    if (canceled || !filePath) return { canceled: true };
    const resp = await fetch(`http://localhost:${PORT}/api/backup`);
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(filePath, buf);
    shell.showItemInFolder(filePath);
    return { ok: true, path: filePath, size: buf.length };
  } catch (err) {
    return { error: String(err.message).slice(0, 200) };
  }
});

let captureWin = null;
ipcMain.on('capture:hide', () => {
  if (captureWin && !captureWin.isDestroyed()) captureWin.hide();
});
app.on('will-quit', () => globalShortcut.unregisterAll());

app.whenReady().then(async () => {
  try {
    await start();
  } catch (err) {
    // Port already taken — assume another instance's server is running and reuse it.
    if (err.code !== 'EADDRINUSE') throw err;
  }

  // System-audio capture for the meeting recorder ("Include computer audio"):
  // the handler picks the primary screen itself (no picker dialog) and asks
  // for the loopback audio device — real system audio on Windows natively
  // and on macOS 13+ via the feature flags enabled at the top of this file.
  // The renderer only uses the audio; the video track is never recorded.
  try {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback({ video: sources[0], audio: 'loopback' });
      }).catch(() => callback({}));
    });
  } catch (err) {
    dbg('display media handler failed: ' + err.message);
  }

  // Quick capture: a small always-on-top window on a global shortcut.
  // Blur hides it; the shortcut toggles it back with the field cleared.
  const toggleCapture = () => {
    if (captureWin && !captureWin.isDestroyed()) {
      if (captureWin.isVisible()) { captureWin.hide(); return; }
      captureWin.show();
      captureWin.focus();
      captureWin.webContents.send('capture:reset');
      return;
    }
    // type 'panel' (macOS NSPanel) takes keyboard focus WITHOUT activating
    // the app — so the main window stays put and whatever app the user was
    // in keeps its state, Spotlight-style.
    captureWin = new BrowserWindow({
      width: 620,
      height: 150,
      frame: false,
      resizable: false,
      show: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      webPreferences: { preload: path.join(__dirname, 'preload.js') }
    });
    captureWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    captureWin.loadURL(`http://127.0.0.1:${PORT}/#capture`);
    captureWin.once('ready-to-show', () => {
      captureWin.center();
      const [x] = captureWin.getPosition();
      captureWin.setPosition(x, 180);
      captureWin.show();
      captureWin.focus();
      // make sure the caret lands in the field on the very first open too
      captureWin.webContents.send('capture:reset');
    });
    captureWin.on('blur', () => { if (captureWin && !captureWin.isDestroyed()) captureWin.hide(); });
  };
  if (!globalShortcut.register('Alt+Space', toggleCapture)) {
    // taken by another app (Alfred/Raycast style launchers) — try a fallback
    if (globalShortcut.register('CommandOrControl+Shift+Space', toggleCapture)) {
      dbg('capture shortcut: Alt+Space taken, using Cmd+Shift+Space');
    } else {
      dbg('capture shortcut: could not register');
    }
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
