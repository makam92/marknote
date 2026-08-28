// Minimal native bridge for presenter mode: the renderer can list displays
// and ask the main process to open/close the display window on a chosen
// screen. Main-process window creation is what reliably lands fullscreen on
// the right display (same recipe as the serializer app).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('marknoteNative', {
  displays: () => ipcRenderer.invoke('present:displays'),
  openDisplay: (id, file) => ipcRenderer.invoke('present:open', id, file),
  closeDisplay: () => ipcRenderer.invoke('present:close'),
  exportPdf: (file, isDeck, title) => ipcRenderer.invoke('export:pdf', file, isDeck, title)
});
