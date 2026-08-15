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

  // One-way "the renderer is up" signal; boot.js stops counting launches on it.
  ready: () => ipcRenderer.send('renderer:ready'),

  updateVersion: () => ipcRenderer.invoke('update:version'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateApply: () => ipcRenderer.invoke('update:apply'),
  updateRestart: () => ipcRenderer.invoke('update:restart'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, info) => cb(info)),
  onUpdateNone: (cb) => ipcRenderer.on('update:none', (_e, info) => cb(info)),
  onUpdateError: (cb) => ipcRenderer.on('update:error', (_e, msg) => cb(msg)),

  onLocked: (cb) => ipcRenderer.on('state:locked', (_e, locked) => cb(locked)),
  onHotkeys: (cb) => ipcRenderer.on('state:hotkeys', (_e, s) => cb(s)),
  onReconnect: (cb) => ipcRenderer.on('action:reconnect', () => cb()),
});
