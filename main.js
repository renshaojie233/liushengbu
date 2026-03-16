const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell, systemPreferences } = require("electron");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createLiveTranscriber, transcribeAudioFile } = require("./lib/volcStreaming");
const { ensureDir, readJson, writeJson } = require("./lib/store");
const { resolveFfmpeg } = require("./lib/ffmpeg");

let mainWindow;
let liveTranscriber = null;
let isQuitting = false;
const dockIconPath = path.join(__dirname, "assets", "app-icon.png");

function userDataPath(...parts) {
  return path.join(app.getPath("userData"), ...parts);
}

function normalizeConfig(config) {
  const next = { ...config };
  const cluster = String(next.cluster || "").toLowerCase();
  const resourceId = String(next.resourceId || "");
  const match = resourceId.match(/^volc\.(bigasr|seedasr)\.sauc\.(duration|concurrent)$/);
  if (match) {
    const expectedFamily = cluster.includes("seed") ? "seedasr" : cluster.includes("bigasr") ? "bigasr" : null;
    if (expectedFamily && match[1] !== expectedFamily) {
      next.resourceId = `volc.${expectedFamily}.sauc.${match[2]}`;
    }
  }
  if (next.resourceId && next.resourceId.includes(".sauc.")) {
    next.authStyle = "x-api";
  }
  return next;
}

function defaultConfig() {
  return {
    appId: "",
    cluster: "Doubao_Seed_ASR_Streaming_2.02000000660265493762",
    resourceId: "volc.seedasr.sauc.duration",
    accessToken: "",
    secretKey: "",
    authStyle: "x-api",
    authMode: "bearer",
    bodyTokenMode: "raw",
    transcriptionMode: "hybrid",
  };
}

function loadConfig() {
  const filePath = userDataPath("config.json");
  const fromDisk = readJson(filePath, {});
  const merged = normalizeConfig({ ...defaultConfig(), ...fromDisk });
  if (JSON.stringify(merged) !== JSON.stringify({ ...defaultConfig(), ...fromDisk })) {
    writeJson(filePath, merged);
  }
  return merged;
}

function saveConfig(config) {
  const normalized = normalizeConfig(config);
  writeJson(userDataPath("config.json"), normalized);
  return normalized;
}

function makeWavBufferFromPcm(pcmBuffer, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

function loadSessions() {
  return readJson(userDataPath("sessions.json"), []);
}

function saveSessions(sessions) {
  writeJson(userDataPath("sessions.json"), sessions);
}

function upgradeSessionAudio(session) {
  if (!session?.audioPath) return session;
  const ext = path.extname(session.audioPath).toLowerCase();
  if (ext !== ".webm") return session;

  const playbackPath = createPlaybackAudio(session.audioPath);
  if (!playbackPath || playbackPath === session.audioPath) {
    return session;
  }

  return {
    ...session,
    audioPath: playbackPath,
    sourceAudioPath: session.sourceAudioPath || session.audioPath,
  };
}

function recordingsDir() {
  const dir = userDataPath("recordings");
  ensureDir(dir);
  return dir;
}

function safeName(input, fallback = "课堂记录") {
  const value = String(input || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return value || fallback;
}

function persistRecording(buffer, extension = "webm") {
  const safeExt = String(extension || "webm").replace(/[^a-z0-9]/gi, "").toLowerCase() || "webm";
  const filePath = path.join(recordingsDir(), `${Date.now()}.${safeExt}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function createPlaybackAudio(sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return sourcePath;
  }

  const targetPath = sourcePath.replace(/\.[^.]+$/, ".mp3");
  if (fs.existsSync(targetPath)) {
    return targetPath;
  }

  const ffmpegPath = resolveFfmpeg();
  const result = spawnSync(
    ffmpegPath,
    ["-y", "-i", sourcePath, "-vn", "-acodec", "libmp3lame", "-q:a", "2", targetPath],
    { encoding: "utf8" }
  );

  if (result.status === 0 && fs.existsSync(targetPath)) {
    return targetPath;
  }

  return sourcePath;
}

function exportAudioFile(sourcePath, exportDir, title) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return { audioPath: "", audioFormat: "", sourceAudioPath: "", sourceAudioFormat: "" };
  }

  const baseName = safeName(title, "课堂录音");
  const ext = path.extname(sourcePath) || ".webm";
  const sourceAudioPath = path.join(exportDir, `${baseName}-source${ext}`);
  fs.copyFileSync(sourcePath, sourceAudioPath);
  const mp3Path = path.join(exportDir, `${baseName}.mp3`);
  const ffmpegPath = resolveFfmpeg();
  const ffmpegResult = spawnSync(
    ffmpegPath,
    ["-y", "-i", sourcePath, "-vn", "-acodec", "libmp3lame", "-q:a", "2", mp3Path],
    { encoding: "utf8" }
  );

  if (ffmpegResult.status === 0 && fs.existsSync(mp3Path)) {
    return {
      audioPath: mp3Path,
      audioFormat: "mp3",
      sourceAudioPath,
      sourceAudioFormat: ext.replace(/^\./, "") || "audio",
    };
  }

  return {
    audioPath: "",
    audioFormat: "",
    sourceAudioPath,
    sourceAudioFormat: ext.replace(/^\./, "") || "audio",
  };
}

function createWindow() {
  if (process.platform === "darwin" && fs.existsSync(dockIconPath)) {
    app.dock.setIcon(nativeImage.createFromPath(dockIconPath));
  }
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 680,
    title: "留声簿",
    icon: dockIconPath,
    backgroundColor: "#f4efe6",
    center: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile("index.html");
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    isQuitting = true;
    mainWindow.hide();
    setImmediate(() => app.quit());
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("config:get", () => loadConfig());
ipcMain.handle("config:save", (_, config) => saveConfig(config));

ipcMain.handle("file:pick", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "音频/视频", extensions: ["mp3", "wav", "m4a", "aac", "ogg", "opus", "mp4", "mov", "mkv", "webm"] },
      { name: "全部文件", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle("media:ensure-microphone", async () => {
  if (process.platform !== "darwin") return true;
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return true;
  if (status === "denied" || status === "restricted") return false;
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
});

ipcMain.handle("media:get-microphone-status", () => {
  if (process.platform !== "darwin") return "granted";
  return systemPreferences.getMediaAccessStatus("microphone");
});

ipcMain.handle("media:open-microphone-settings", async () => {
  if (process.platform !== "darwin") return false;
  const deepLink = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
  const opened = await shell.openExternal(deepLink);
  if (!opened) return true;
  const fallback = shell.openPath("/System/Applications/System Settings.app");
  return fallback.then((result) => !result).catch(() => false);
});

ipcMain.handle("transcribe:file", async (_, filePath) => {
  const config = loadConfig();
  const result = await transcribeAudioFile(config, filePath);
  return { ...result, audioPath: filePath };
});

ipcMain.handle("transcribe:live-start", async () => {
  if (liveTranscriber) {
    await liveTranscriber.stop();
    liveTranscriber = null;
  }

  const config = loadConfig();
  liveTranscriber = createLiveTranscriber(
    {
      ...config,
      previewWsUrl: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
    },
    {
      onPartial(payload) {
        mainWindow?.webContents.send("transcribe:live-update", payload);
      },
      onError(error) {
        mainWindow?.webContents.send("transcribe:live-error", {
          message: error.message || "实时转写失败",
        });
      },
      onClose(payload) {
        mainWindow?.webContents.send("transcribe:live-closed", payload);
      },
    }
  );

  try {
    await liveTranscriber.start();
    return true;
  } catch (error) {
    liveTranscriber = null;
    throw error;
  }
});

ipcMain.handle("transcribe:live-chunk", async (_, payload) => {
  if (!liveTranscriber) return false;
  liveTranscriber.sendAudioChunk(Buffer.from(payload.buffer));
  return true;
});

ipcMain.handle("transcribe:live-stop", async () => {
  if (!liveTranscriber) return false;
  const current = liveTranscriber;
  liveTranscriber = null;
  await current.stop();
  return true;
});

ipcMain.handle("transcribe:recording", async (_, payload) => {
  const ext = payload?.extension || "webm";
  const audioBuffer = Buffer.from(payload.buffer);
  const savedFile = persistRecording(audioBuffer, ext);
  try {
    const result = await transcribeAudioFile(loadConfig(), savedFile);
    return {
      ...result,
      audioPath: createPlaybackAudio(savedFile),
      sourceAudioPath: savedFile,
    };
  } catch (error) {
    fs.rmSync(savedFile, { force: true });
    throw error;
  }
});

ipcMain.handle("recording:save-buffer", async (_, payload) => {
  const ext = payload?.extension || "webm";
  const audioBuffer = Buffer.from(payload.buffer);
  const savedFile = persistRecording(audioBuffer, ext);
  return {
    audioPath: createPlaybackAudio(savedFile),
    sourceAudioPath: savedFile,
  };
});

ipcMain.handle("transcribe:segment", async (_, payload) => {
  const tempDir = path.join(os.tmpdir(), "doubao-class-notes");
  ensureDir(tempDir);
  const tempFile = path.join(tempDir, `${Date.now()}-segment.wav`);
  const pcmBuffer = Buffer.from(payload.buffer);
  fs.writeFileSync(tempFile, makeWavBufferFromPcm(pcmBuffer, payload.sampleRate || 16000));
  try {
    return await transcribeAudioFile(loadConfig(), tempFile);
  } finally {
    fs.rmSync(tempFile, { force: true });
  }
});

ipcMain.handle("sessions:list", () => {
  const sessions = loadSessions();
  const next = sessions.map(upgradeSessionAudio);
  if (JSON.stringify(next) !== JSON.stringify(sessions)) {
    saveSessions(next);
  }
  return next;
});
ipcMain.handle("sessions:save", (_, session) => {
  const sessions = loadSessions();
  const prepared = upgradeSessionAudio({ ...session, updatedAt: new Date().toISOString() });
  const next = [prepared, ...sessions.filter((item) => item.id !== session.id)];
  saveSessions(next);
  return next;
});
ipcMain.handle("sessions:delete", async (_, sessionId) => {
  const sessions = loadSessions();
  const target = sessions.find((item) => item.id === sessionId);
  const next = sessions.filter((item) => item.id !== sessionId);
  saveSessions(next);
  if (target?.audioPath && fs.existsSync(target.audioPath)) {
    fs.rmSync(target.audioPath, { force: true });
  }
  if (target?.sourceAudioPath && target.sourceAudioPath !== target.audioPath && fs.existsSync(target.sourceAudioPath)) {
    fs.rmSync(target.sourceAudioPath, { force: true });
  }
  return next;
});

ipcMain.handle("sessions:export-bundle", async (_, payload) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const bundleName = `${safeName(payload.title, "课堂记录")}-export`;
  const exportDir = path.join(result.filePaths[0], bundleName);
  ensureDir(exportDir);
  const markdownPath = path.join(exportDir, `${safeName(payload.title, "课堂记录")}.md`);
  fs.writeFileSync(markdownPath, payload.content || "", "utf8");
  const { audioPath, audioFormat, sourceAudioPath, sourceAudioFormat } = exportAudioFile(
    payload.sourceAudioPath || payload.audioPath,
    exportDir,
    payload.title
  );
  await shell.openPath(exportDir);
  return { exportDir, markdownPath, audioPath, audioFormat, sourceAudioPath, sourceAudioFormat };
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  app.quit();
});
