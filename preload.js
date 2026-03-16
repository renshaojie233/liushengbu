const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, listener) {
  const wrapped = (_, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("appApi", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  ensureMicrophoneAccess: () => ipcRenderer.invoke("media:ensure-microphone"),
  getMicrophoneStatus: () => ipcRenderer.invoke("media:get-microphone-status"),
  openMicrophoneSettings: () => ipcRenderer.invoke("media:open-microphone-settings"),
  pickFile: () => ipcRenderer.invoke("file:pick"),
  transcribeFile: (filePath) => ipcRenderer.invoke("transcribe:file", filePath),
  startLiveTranscription: () => ipcRenderer.invoke("transcribe:live-start"),
  pushLiveChunk: (payload) => ipcRenderer.invoke("transcribe:live-chunk", payload),
  stopLiveTranscription: () => ipcRenderer.invoke("transcribe:live-stop"),
  transcribeRecording: (payload) => ipcRenderer.invoke("transcribe:recording", payload),
  saveRecordingBuffer: (payload) => ipcRenderer.invoke("recording:save-buffer", payload),
  transcribeSegment: (payload) => ipcRenderer.invoke("transcribe:segment", payload),
  onLiveUpdate: (listener) => subscribe("transcribe:live-update", listener),
  onLiveError: (listener) => subscribe("transcribe:live-error", listener),
  onLiveClosed: (listener) => subscribe("transcribe:live-closed", listener),
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  saveSession: (session) => ipcRenderer.invoke("sessions:save", session),
  deleteSession: (sessionId) => ipcRenderer.invoke("sessions:delete", sessionId),
  exportSessionBundle: (payload) => ipcRenderer.invoke("sessions:export-bundle", payload),
});
