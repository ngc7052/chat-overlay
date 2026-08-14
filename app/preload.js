'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  setLocked: (locked) => ipcRenderer.invoke('window:setLocked', locked),
  resizeBy: (dx, dy) => ipcRenderer.invoke('window:resizeBy', dx, dy),
  moveBy: (dx, dy) => ipcRenderer.invoke('window:moveBy', dx, dy),
  quit: () => ipcRenderer.invoke('app:quit'),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),

  httpJson: (url) => ipcRenderer.invoke('http:json', url),

  onLocked: (cb) => ipcRenderer.on('state:locked', (_e, locked) => cb(locked)),
  onHotkeys: (cb) => ipcRenderer.on('state:hotkeys', (_e, s) => cb(s)),
  onReconnect: (cb) => ipcRenderer.on('action:reconnect', () => cb()),
});
