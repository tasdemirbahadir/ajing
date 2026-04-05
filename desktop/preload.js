const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld("desktopDJ", {
  getSettings: () => ipcRenderer.invoke("dj:get-settings"),
  saveSettings: (options) => ipcRenderer.invoke("dj:save-settings", options || {}),
  resetSettings: () => ipcRenderer.invoke("dj:reset-settings"),
  prepare: (options) => ipcRenderer.invoke("dj:prepare", options || {}),
  getLatestSession: () => ipcRenderer.invoke("dj:get-latest-session"),
  stopPreparation: () => ipcRenderer.invoke("dj:stop-preparation"),
  playbackStart: (options) => ipcRenderer.invoke("dj:playback-start", options || {}),
  playbackTogglePause: () => ipcRenderer.invoke("dj:playback-toggle-pause"),
  playbackSeek: (options) => ipcRenderer.invoke("dj:playback-seek", options || {}),
  playbackStop: () => ipcRenderer.invoke("dj:playback-stop"),
  playbackGetState: () => ipcRenderer.invoke("dj:playback-get-state"),
  playbackSaveState: (options) => ipcRenderer.invoke("dj:playback-save-state", options || {}),
  exportMix: (options) => ipcRenderer.invoke("dj:export-mix", options || {}),
  onLog: (callback) => subscribe("dj:log", callback),
  onStatus: (callback) => subscribe("dj:status", callback),
  onPlaybackState: (callback) => subscribe("dj:playback", callback),
});
