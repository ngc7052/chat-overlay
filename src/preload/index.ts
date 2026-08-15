import { contextBridge, ipcRenderer } from 'electron';

/**
 * The entire surface the page is allowed to touch. Node integration is off and
 * context isolation on, so anything not listed here simply does not exist for
 * the renderer.
 */
const api = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch: unknown) => ipcRenderer.invoke('config:set', patch),

  setLocked: (locked: boolean) => ipcRenderer.invoke('window:setLocked', locked),
  resizeBy: (dx: number, dy: number) => ipcRenderer.invoke('window:resizeBy', dx, dy),
  moveBy: (dx: number, dy: number) => ipcRenderer.invoke('window:moveBy', dx, dy),
  quit: () => ipcRenderer.invoke('app:quit'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open', url),

  httpJson: (url: string) => ipcRenderer.invoke('http:json', url),
  endpoints: () => ipcRenderer.invoke('env:endpoints'),

  updateVersion: () => ipcRenderer.invoke('update:version'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateApply: () => ipcRenderer.invoke('update:apply'),
  updateRestart: () => ipcRenderer.invoke('update:restart'),

  rendererReady: () => ipcRenderer.send('renderer:ready'),

  onUpdateAvailable: (cb: (info: unknown) => void) =>
    ipcRenderer.on('update:available', (_e, info) => cb(info)),
  onUpdateNone: (cb: (info: unknown) => void) =>
    ipcRenderer.on('update:none', (_e, info) => cb(info)),
  onUpdateError: (cb: (msg: string) => void) =>
    ipcRenderer.on('update:error', (_e, msg) => cb(msg)),
  onLocked: (cb: (locked: boolean) => void) =>
    ipcRenderer.on('state:locked', (_e, locked) => cb(locked)),
  onHotkeys: (cb: (s: { lock: boolean; hide: boolean }) => void) =>
    ipcRenderer.on('state:hotkeys', (_e, s) => cb(s)),
  onReconnect: (cb: () => void) => ipcRenderer.on('action:reconnect', () => cb()),
  onPointerOver: (cb: (over: boolean) => void) =>
    ipcRenderer.on('state:pointerOver', (_e, over) => cb(over)),
};

export type OverlayApi = typeof api;

contextBridge.exposeInMainWorld('overlay', api);
