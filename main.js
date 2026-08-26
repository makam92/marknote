const { app, BrowserWindow, shell } = require('electron');
const { start, PORT } = require('./server');

app.setName('Marknote');

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
      nodeIntegration: false
    }
  });

  win.loadURL(`http://localhost:${PORT}`);

  // External links open in the default browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
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
