let currentTab = "record";
let selectedFile = null;
let currentSession = null;
let mediaRecorder = null;
let liveStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let silentNode = null;
let chunks = [];
let startedAt = null;
let liveChunkQueue = Promise.resolve();
let isRecordingLive = false;
let isRecordingPaused = false;
let isFinalizingRecording = false;
let currentRecordingToken = 0;
let livePcmChunks = [];
let livePcmBytes = 0;
let correctedUntilMs = 0;
let correctedTranscript = "";
let latestLivePayload = null;
let pendingCorrectionEndMs = 0;
let segmentCorrectionRunning = false;
let currentAudioSrc = "";
let currentConfig = {};
let currentTranscriptionMode = "hybrid";
let currentEditingSessionId = null;
let currentSearchQuery = "";
let isEnhancingSession = false;
let recentlyUpdatedSessionId = null;
let recentlyUpdatedTimer = null;

const PCM_SAMPLE_RATE = 16000;
const PCM_BYTES_PER_MS = (PCM_SAMPLE_RATE * 2) / 1000;
const MIN_CORRECTION_WINDOW_MS = 5000;
const MODE_HINTS = {
  realtime: "边录边出字，适合低延迟记录。",
  precise: "停止后生成整段精准稿，适合最终归档。",
  hybrid: "实时出字，并按停顿自动修正前文。",
};

const els = {
  main: document.querySelector(".main"),
  libraryPanel: document.querySelector(".library-panel"),
  recordDock: document.querySelector(".record-dock"),
  tabs: [...document.querySelectorAll(".tab")],
  contents: [...document.querySelectorAll(".tab-content")],
  openSettings: document.getElementById("openSettings"),
  workspace: document.getElementById("workspace"),
  modeRealtime: document.getElementById("modeRealtime"),
  modePrecise: document.getElementById("modePrecise"),
  modeHybrid: document.getElementById("modeHybrid"),
  modeHint: document.getElementById("modeHint"),
  settingsDialog: document.getElementById("settingsDialog"),
  permissionDialog: document.getElementById("permissionDialog"),
  permissionOpenSettings: document.getElementById("permissionOpenSettings"),
  permissionRetry: document.getElementById("permissionRetry"),
  saveSettings: document.getElementById("saveSettings"),
  pickFile: document.getElementById("pickFile"),
  pauseRecord: document.getElementById("pauseRecord"),
  stopRecord: document.getElementById("stopRecord"),
  openSettingsMirror: document.getElementById("openSettingsMirror"),
  recordStatus: document.getElementById("recordStatus"),
  transcriptText: document.getElementById("transcriptText"),
  liveListeningRow: document.getElementById("liveListeningRow"),
  liveListeningText: document.getElementById("liveListeningText"),
  playbackBar: document.getElementById("playbackBar"),
  sessionTitle: document.getElementById("sessionTitle"),
  transcriptMeta: document.getElementById("transcriptMeta"),
  enhanceSession: document.getElementById("enhanceSession"),
  exportSession: document.getElementById("exportSession"),
  sessionList: document.getElementById("sessionList"),
  sessionSearch: document.getElementById("sessionSearch"),
  toast: document.getElementById("toast"),
  cfgAppId: document.getElementById("cfgAppId"),
  cfgCluster: document.getElementById("cfgCluster"),
  cfgResourceId: document.getElementById("cfgResourceId"),
  cfgAccessToken: document.getElementById("cfgAccessToken"),
  cfgSecretKey: document.getElementById("cfgSecretKey"),
  cfgAuthStyle: document.getElementById("cfgAuthStyle"),
  cfgAuthMode: document.getElementById("cfgAuthMode"),
  cfgBodyTokenMode: document.getElementById("cfgBodyTokenMode"),
  playbackAudio: document.getElementById("playbackAudio"),
};

function showToast(text) {
  els.toast.textContent = text;
  els.toast.classList.remove("hidden");
  setTimeout(() => els.toast.classList.add("hidden"), 2600);
}

function isMicStatusGranted(status) {
  return status === "granted";
}

async function requestMicrophonePermissionDirectly() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch {
    return false;
  }
}

async function ensureMicrophonePermission() {
  const initialStatus = await window.appApi.getMicrophoneStatus();
  if (isMicStatusGranted(initialStatus)) return true;

  if (initialStatus === "not-determined" || initialStatus === "unknown" || !initialStatus) {
    const mainGranted = await window.appApi.ensureMicrophoneAccess();
    if (mainGranted) {
      const currentStatus = await window.appApi.getMicrophoneStatus();
      if (isMicStatusGranted(currentStatus)) return true;
    }
  }

  const rendererGranted = await requestMicrophonePermissionDirectly();
  if (rendererGranted) return true;

  const finalStatus = await window.appApi.getMicrophoneStatus();
  return isMicStatusGranted(finalStatus);
}

async function checkMicrophonePermissionOnStartup() {
  const granted = await ensureMicrophonePermission();
  if (granted) return true;

  if (!els.permissionDialog?.open) {
    els.permissionDialog?.showModal();
  }
  return false;
}

function normalizeSearchText(value) {
  return String(value || "").trim().toLowerCase();
}

function sessionMatchesSearch(session, query) {
  if (!query) return true;
  const haystack = [
    session.title,
    session.transcript,
    session.updatedAt ? new Date(session.updatedAt).toLocaleString() : "",
    ...(Array.isArray(session.utterances) ? session.utterances.map((item) => item?.text || "") : []),
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(query);
}

function filterSessions(sessions) {
  const query = normalizeSearchText(currentSearchQuery);
  if (!query) return sessions;
  return sessions.filter((session) => sessionMatchesSearch(session, query));
}

function switchTab(tab) {
  currentTab = tab;
  els.tabs.forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  els.contents.forEach((panel) => panel.classList.toggle("active", panel.dataset.content === tab));
  els.main?.classList.toggle("record-mode", tab === "record");
  els.main?.classList.toggle("playback-mode", tab === "playback");
  els.libraryPanel?.classList.toggle("hidden", tab === "record");
  els.recordDock?.classList.toggle("hidden", tab === "playback");
  if (tab === "record") {
    els.playbackBar?.classList.add("hidden");
  } else if (currentSession?.audioPath) {
    els.playbackBar?.classList.remove("hidden");
  }
}

function fillConfig(config) {
  currentConfig = { ...config };
  els.cfgAppId.value = config.appId || "";
  els.cfgCluster.value = config.cluster || "";
  els.cfgResourceId.value = config.resourceId || "";
  els.cfgAccessToken.value = config.accessToken || "";
  els.cfgSecretKey.value = config.secretKey || "";
  els.cfgAuthStyle.value = config.authStyle || "x-api";
  els.cfgAuthMode.value = config.authMode || "bearer";
  els.cfgBodyTokenMode.value = config.bodyTokenMode || "raw";
  applyTranscriptionMode(config.transcriptionMode || "hybrid");
}

function readConfigForm() {
  return {
    appId: els.cfgAppId.value.trim(),
    cluster: els.cfgCluster.value.trim(),
    resourceId: els.cfgResourceId.value.trim(),
    accessToken: els.cfgAccessToken.value.trim(),
    secretKey: els.cfgSecretKey.value.trim(),
    authStyle: els.cfgAuthStyle.value,
    authMode: els.cfgAuthMode.value,
    bodyTokenMode: els.cfgBodyTokenMode.value,
    transcriptionMode: currentTranscriptionMode,
  };
}

function applyTranscriptionMode(mode) {
  currentTranscriptionMode = mode;
  els.modeRealtime?.classList.toggle("active", mode === "realtime");
  els.modePrecise?.classList.toggle("active", mode === "precise");
  els.modeHybrid?.classList.toggle("active", mode === "hybrid");
  if (els.modeHint) {
    els.modeHint.textContent = MODE_HINTS[mode] || MODE_HINTS.hybrid;
  }
}

async function persistTranscriptionMode(mode) {
  applyTranscriptionMode(mode);
  currentConfig = { ...currentConfig, ...readConfigForm(), transcriptionMode: mode };
  await window.appApi.saveConfig(currentConfig);
}

function updateCurrentSession(session) {
  currentSession = session;
  els.sessionTitle.textContent = session.title;
  renderTranscript(session);
  syncPlaybackBar(session);
  els.transcriptMeta.textContent = session.utterances?.length ? `${session.utterances.length} 段` : "";
  refreshEnhanceUi();
  els.exportSession.disabled = !session.transcript;
}

function refreshEnhanceUi() {
  if (!els.enhanceSession) return;
  els.enhanceSession.disabled = isEnhancingSession || !currentSession?.audioPath;
  els.enhanceSession.classList.toggle("is-busy", isEnhancingSession);
  els.enhanceSession.textContent = isEnhancingSession ? "优化中…" : "优化转写";
}

function updateRecordControls() {
  if (els.pauseRecord) {
    els.pauseRecord.dataset.tooltip = mediaRecorder?.state === "paused" ? "继续录音" : "暂停录音";
  }
  if (els.stopRecord) {
    const active = mediaRecorder?.state === "recording" || mediaRecorder?.state === "paused";
    els.stopRecord.dataset.tooltip = active ? "停止录音" : "开始录音";
  }
}

function makeEmptySession() {
  return { title: "未开始", transcript: "", utterances: [] };
}

function syncPlaybackBar(session) {
  if (currentTab !== "playback") {
    els.playbackBar?.classList.add("hidden");
    return;
  }
  const hasAudio = Boolean(session?.audioPath);
  els.playbackBar?.classList.toggle("hidden", !hasAudio);
  if (!hasAudio) {
    currentAudioSrc = "";
    els.playbackAudio.removeAttribute("src");
    els.playbackAudio.load();
    return;
  }
  const nextSrc = normalizeFileUrl(session.audioPath);
  if (nextSrc && currentAudioSrc !== nextSrc) {
    currentAudioSrc = nextSrc;
    els.playbackAudio.src = nextSrc;
  }
}

function formatTime(ms = 0) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function normalizeFileUrl(filePath) {
  if (!filePath) return "";
  return `file://${encodeURI(filePath)}`;
}

async function jumpToUtterance(utterance) {
  if (!currentSession?.audioPath || !utterance) return;
  const nextSrc = normalizeFileUrl(currentSession.audioPath);
  if (!nextSrc) return;
  if (currentAudioSrc !== nextSrc) {
    els.playbackAudio.src = nextSrc;
    currentAudioSrc = nextSrc;
    await new Promise((resolve) => {
      if (els.playbackAudio.readyState >= 1) {
        resolve();
        return;
      }
      els.playbackAudio.onloadedmetadata = () => resolve();
      els.playbackAudio.onerror = () => resolve();
    });
  }
  const seekTo = Math.max(0, Number(utterance.start_time || 0) / 1000);
  els.playbackAudio.currentTime = seekTo;
  els.playbackBar?.classList.remove("hidden");
  els.playbackAudio.play().catch(() => {
    showToast("无法播放该段录音");
  });
}

function renderTranscript(session) {
  const utterances = Array.isArray(session?.utterances) ? session.utterances.filter((item) => item?.text) : [];
  if (!utterances.length) {
    els.transcriptText.textContent = session?.transcript || "这里会显示课堂转写结果。";
    els.transcriptText.classList.toggle("empty", !session?.transcript);
    return;
  }

  els.transcriptText.innerHTML = "";
  utterances.forEach((utterance) => {
    const block = document.createElement("article");
    block.className = "utterance-block";
    const status = utterance.definite ? "稳定" : "实时";
    block.innerHTML = `
      <button type="button" class="utterance-time-button" data-tooltip="跳到这一段录音">[${formatTime(utterance.start_time)}]</button>
      <span class="utterance-text">${utterance.text}</span>
      <span class="utterance-tag">${status}</span>
    `;
    block.querySelector(".utterance-time-button")?.addEventListener("click", (event) => {
      event.stopPropagation();
      jumpToUtterance(utterance).catch(() => {});
    });
    els.transcriptText.appendChild(block);
  });
  els.transcriptText.classList.remove("empty");
}

function updateListeningRow(payload) {
  if (!isRecordingLive || isRecordingPaused || currentTranscriptionMode === "precise") {
    els.liveListeningRow?.classList.add("hidden");
    return;
  }
  const latestUtterance = [...(payload?.utterances || [])].reverse().find((item) => !item.definite && item.text);
  const text = latestUtterance?.text || payload?.text || "正在收听...";
  els.liveListeningText.textContent = currentTranscriptionMode === "realtime" ? text : `正在收听：${text}`;
  els.liveListeningRow?.classList.remove("hidden");
}

function resetRecordingUi() {
  els.recordStatus.textContent = "准备录音";
  isRecordingPaused = false;
  if (els.pauseRecord) {
    els.pauseRecord.disabled = true;
    els.pauseRecord.textContent = "Ⅱ";
    els.pauseRecord.classList.remove("is-paused");
  }
  els.stopRecord.disabled = false;
  els.stopRecord.textContent = "●";
  els.stopRecord.classList.remove("is-recording");
  els.liveListeningRow?.classList.add("hidden");
  updateRecordControls();
}

function downsampleBuffer(input, inputSampleRate, outputSampleRate) {
  if (outputSampleRate === inputSampleRate) return input;
  const ratio = inputSampleRate / outputSampleRate;
  const length = Math.round(input.length / ratio);
  const result = new Float32Array(length);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i += 1) {
      accum += input[i];
      count += 1;
    }
    result[offsetResult] = count ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function floatTo16BitPcm(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function queueLiveChunk(bytes) {
  const copied = new Uint8Array(bytes);
  livePcmChunks.push({ startByte: livePcmBytes, bytes: copied });
  livePcmBytes += copied.length;
  liveChunkQueue = liveChunkQueue
    .then(() => window.appApi.pushLiveChunk({ buffer: Array.from(copied) }))
    .catch((error) => showToast(error.message || "实时转写发送失败"));
}

function resetLiveCorrectionState() {
  livePcmChunks = [];
  livePcmBytes = 0;
  correctedUntilMs = 0;
  correctedTranscript = "";
  latestLivePayload = null;
  pendingCorrectionEndMs = 0;
  segmentCorrectionRunning = false;
}

function joinTranscriptParts(parts) {
  return parts.filter(Boolean).join("").trim();
}

function slicePcmRange(startMs, endMs) {
  const startByte = Math.max(0, Math.floor(startMs * PCM_BYTES_PER_MS));
  const endByte = Math.max(startByte, Math.floor(endMs * PCM_BYTES_PER_MS));
  const totalLength = Math.max(0, endByte - startByte);
  const output = new Uint8Array(totalLength);
  let writeOffset = 0;

  for (const chunk of livePcmChunks) {
    const chunkStart = chunk.startByte;
    const chunkEnd = chunk.startByte + chunk.bytes.length;
    if (chunkEnd <= startByte || chunkStart >= endByte) continue;
    const from = Math.max(0, startByte - chunkStart);
    const to = Math.min(chunk.bytes.length, endByte - chunkStart);
    const slice = chunk.bytes.subarray(from, to);
    output.set(slice, writeOffset);
    writeOffset += slice.length;
  }

  return output.subarray(0, writeOffset);
}

function buildTailText(payload) {
  const utterances = Array.isArray(payload?.utterances) ? payload.utterances : [];
  const pendingUtterances = utterances.filter((item) => {
    const endTime = Number(item?.end_time);
    if (!Number.isFinite(endTime)) return true;
    return endTime > correctedUntilMs;
  });
  if (pendingUtterances.length) {
    return pendingUtterances.map((item) => item.text || "").join("");
  }
  if (!correctedTranscript) return payload?.text || "";
  if (typeof payload?.text === "string" && payload.text.startsWith(correctedTranscript)) {
    return payload.text.slice(correctedTranscript.length);
  }
  return "";
}

function renderCombinedTranscript(payload) {
  const transcript = joinTranscriptParts([correctedTranscript, buildTailText(payload)]);
  updateCurrentSession({
    ...(currentSession || { id: `session-${Date.now()}`, title: makeTitle("现场录音") }),
    transcript,
    utterances: payload?.utterances || [],
  });
}

function refreshRecordStatus() {
  if (isFinalizingRecording) {
    els.recordStatus.textContent = currentTranscriptionMode === "precise" ? "正在生成精准稿" : "正在保存录音";
    return;
  }
  if (!isRecordingLive) {
    els.recordStatus.textContent = "准备录音";
    return;
  }
  if (isRecordingPaused) {
    els.recordStatus.textContent = "录音已暂停";
    return;
  }
  if (segmentCorrectionRunning) {
    els.recordStatus.textContent = "录音中，前文高质量校正中…";
    return;
  }
  if (currentTranscriptionMode === "precise") {
    els.recordStatus.textContent = "精准模式录音中，停止后自动生成精准稿";
    return;
  }
  if (latestLivePayload?.isDefinite) {
    els.recordStatus.textContent = currentTranscriptionMode === "hybrid" ? "录音中，实时+精准联合处理中" : "录音中，实时转写中";
    return;
  }
  els.recordStatus.textContent = currentTranscriptionMode === "hybrid" ? "录音中，实时出字并自动优化前文" : "录音中，实时蹦字…";
}

async function drainSegmentCorrections(token) {
  if (segmentCorrectionRunning || !isRecordingLive || token !== currentRecordingToken) return;
  segmentCorrectionRunning = true;
  refreshRecordStatus();

  while (isRecordingLive && token === currentRecordingToken) {
    const targetEndMs = pendingCorrectionEndMs;
    if (targetEndMs - correctedUntilMs < MIN_CORRECTION_WINDOW_MS) break;
    const pcm = slicePcmRange(0, targetEndMs);
    if (!pcm.length) break;

    try {
      const result = await window.appApi.transcribeSegment({
        buffer: Array.from(pcm),
        sampleRate: PCM_SAMPLE_RATE,
      });
      if (!isRecordingLive || token !== currentRecordingToken) break;
      correctedTranscript = result.text || correctedTranscript;
      correctedUntilMs = targetEndMs;
      if (latestLivePayload) renderCombinedTranscript(latestLivePayload);
    } catch (error) {
      if (isRecordingLive && token === currentRecordingToken) {
        showToast(error.message || "分段校正失败");
      }
      break;
    }
  }

  segmentCorrectionRunning = false;
  refreshRecordStatus();
}

function scheduleSegmentCorrection(payload, token) {
  if (currentTranscriptionMode !== "hybrid") return;
  const utterances = Array.isArray(payload?.utterances) ? payload.utterances : [];
  const definiteEnds = utterances
    .filter((item) => item?.definite && Number.isFinite(Number(item?.end_time)))
    .map((item) => Number(item.end_time))
    .filter((endTime) => endTime > correctedUntilMs);
  if (!definiteEnds.length) return;
  pendingCorrectionEndMs = Math.max(pendingCorrectionEndMs, ...definiteEnds);
  drainSegmentCorrections(token).catch((error) => {
    segmentCorrectionRunning = false;
    if (isRecordingLive && token === currentRecordingToken) {
      showToast(error.message || "分段校正失败");
      refreshRecordStatus();
    }
  });
}

function teardownLiveAudio() {
  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (silentNode) {
    silentNode.disconnect();
    silentNode = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  if (liveStream) {
    liveStream.getTracks().forEach((track) => track.stop());
    liveStream = null;
  }
}

async function setupLivePreview(stream) {
  audioContext = new AudioContext();
  sourceNode = audioContext.createMediaStreamSource(stream);
  processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  silentNode = audioContext.createGain();
  silentNode.gain.value = 0;
  sourceNode.connect(processorNode);
  processorNode.connect(silentNode);
  silentNode.connect(audioContext.destination);

  processorNode.onaudioprocess = (event) => {
    if (!isRecordingLive || isRecordingPaused) return;
    const input = event.inputBuffer.getChannelData(0);
    const downsampled = downsampleBuffer(input, audioContext.sampleRate, 16000);
    const pcm = floatTo16BitPcm(downsampled);
    queueLiveChunk(new Uint8Array(pcm.buffer));
  };
}

async function togglePauseRecording() {
  if (!mediaRecorder || isFinalizingRecording || mediaRecorder.state === "inactive") return;
  if (mediaRecorder.state === "paused") {
    mediaRecorder.resume();
    isRecordingPaused = false;
    if (audioContext?.state === "suspended") {
      await audioContext.resume().catch(() => {});
    }
    if (els.pauseRecord) {
      els.pauseRecord.textContent = "Ⅱ";
      els.pauseRecord.classList.remove("is-paused");
    }
    updateRecordControls();
    refreshRecordStatus();
    return;
  }

  if (mediaRecorder.state === "recording") {
    mediaRecorder.pause();
    isRecordingPaused = true;
    if (audioContext?.state === "running") {
      await audioContext.suspend().catch(() => {});
    }
    if (els.pauseRecord) {
      els.pauseRecord.textContent = "▶";
      els.pauseRecord.classList.add("is-paused");
    }
    els.liveListeningRow?.classList.add("hidden");
    updateRecordControls();
    refreshRecordStatus();
  }
}

function renderSessions(sessions) {
  const visibleSessions = filterSessions(sessions);
  els.sessionList.innerHTML = "";
  if (!visibleSessions.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "session-list-empty";
    emptyState.textContent = currentSearchQuery ? "没有匹配的录音记录" : "还没有录音记录";
    els.sessionList.appendChild(emptyState);
    return;
  }

  visibleSessions.forEach((session) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "session-item";
    item.classList.toggle("active", session.id === currentSession?.id);

    const titleRow = document.createElement("div");
    titleRow.className = "session-title-row";

    if (currentEditingSessionId === session.id) {
      const input = document.createElement("input");
      input.className = "session-title-input";
      input.value = session.title || "";
      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          commitSessionRename(session.id, input.value);
        } else if (event.key === "Escape") {
          currentEditingSessionId = null;
          renderSessions(sessions);
        }
      });
      input.addEventListener("blur", () => {
        commitSessionRename(session.id, input.value);
      });
      titleRow.appendChild(input);
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
    } else {
      const title = document.createElement("strong");
      title.textContent = session.title;
      titleRow.appendChild(title);

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "session-edit-button";
      editButton.setAttribute("aria-label", "重命名录音");
      editButton.setAttribute("data-tooltip", "改名");
      editButton.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 16.25V20h3.75L18.81 8.94l-3.75-3.75L4 16.25Zm13.71-9.04a1.003 1.003 0 0 0 0-1.42l-1.5-1.5a1.003 1.003 0 0 0-1.42 0l-1.17 1.17 3.75 3.75 1.34-1.5Z"/>
        </svg>
      `;
      editButton.addEventListener("click", (event) => {
        event.stopPropagation();
        currentEditingSessionId = session.id;
        renderSessions(sessions);
      });
      titleRow.appendChild(editButton);

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "session-edit-button session-delete-button";
      deleteButton.setAttribute("aria-label", "删除录音");
      deleteButton.setAttribute("data-tooltip", "删除");
      deleteButton.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h2v8H7V9Zm4 0h2v8h-2V9Zm4 0h2v8h-2V9ZM6 21a2 2 0 0 1-2-2V7h16v12a2 2 0 0 1-2 2H6Z"/>
        </svg>
      `;
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteSession(session.id).catch((error) => showToast(error.message || "删除失败"));
      });
      titleRow.appendChild(deleteButton);
    }

    const time = document.createElement("span");
    time.textContent = new Date(session.updatedAt).toLocaleString();

    item.appendChild(titleRow);
    item.appendChild(time);
    item.classList.toggle("recently-updated", session.id === recentlyUpdatedSessionId);
    item.addEventListener("click", () => {
      switchTab("playback");
      updateCurrentSession(session);
      renderSessions(sessions);
    });
    els.sessionList.appendChild(item);
  });
}

async function commitSessionRename(sessionId, rawTitle) {
  const nextTitle = String(rawTitle || "").trim();
  currentEditingSessionId = null;
  if (!nextTitle) {
    showToast("录音名称不能为空");
    await refreshSessions();
    return;
  }
  const sessions = await window.appApi.listSessions();
  const target = sessions.find((session) => session.id === sessionId);
  if (!target) {
    await refreshSessions();
    return;
  }
  const renamed = { ...target, title: nextTitle };
  const nextSessions = await window.appApi.saveSession(renamed);
  if (currentSession?.id === sessionId) {
    updateCurrentSession(renamed);
  }
  renderSessions(nextSessions);
  showToast("名称已更新");
}

async function refreshSessions() {
  const sessions = await window.appApi.listSessions();
  renderSessions(sessions);
  if (isRecordingLive || isFinalizingRecording) return sessions;
  const matched = sessions.find((session) => session.id === currentSession?.id);
  if (matched) {
    updateCurrentSession(matched);
    renderSessions(sessions);
  }
  return sessions;
}

async function deleteSession(sessionId) {
  const nextSessions = await window.appApi.deleteSession(sessionId);
  if (currentSession?.id === sessionId) {
    const replacement = filterSessions(nextSessions).find(Boolean) || makeEmptySession();
    updateCurrentSession(replacement);
    if (!replacement.id) {
      els.transcriptMeta.textContent = "";
      els.playbackBar?.classList.add("hidden");
    }
  }
  renderSessions(nextSessions);
  showToast("录音已删除");
}

function markSessionUpdated(sessionId) {
  recentlyUpdatedSessionId = sessionId;
  clearTimeout(recentlyUpdatedTimer);
  recentlyUpdatedTimer = setTimeout(() => {
    recentlyUpdatedSessionId = null;
    window.appApi.listSessions().then(renderSessions).catch(() => {});
  }, 2200);
}

function makeTitle(prefix = "课堂记录") {
  return `${prefix} ${new Date().toLocaleString()}`;
}

async function transcribeSelectedFile() {
  if (!selectedFile) return;
  els.sessionTitle.textContent = "正在转写…";
  els.transcriptText.textContent = "正在把文件送去豆包语音，请稍候。";
  els.transcriptText.classList.remove("empty");
  try {
    const result = await window.appApi.transcribeFile(selectedFile);
    const session = {
      id: `session-${Date.now()}`,
      title: makeTitle("上传文件"),
      transcript: result.text,
      utterances: result.utterances || [],
      audioPath: result.audioPath || selectedFile,
      sourceAudioPath: result.sourceAudioPath || selectedFile,
    };
    updateCurrentSession(session);
    renderSessions(await window.appApi.saveSession(session));
    showToast("转写完成");
  } catch (error) {
    showToast(error.message || "转写失败");
    els.transcriptText.textContent = error.message || "转写失败";
  } finally {
    selectedFile = null;
  }
}

async function startRecording() {
  try {
    const recordingToken = Date.now();
    els.recordStatus.textContent = "请求麦克风权限";
    const hasMicAccess = await ensureMicrophonePermission();
    if (!hasMicAccess) {
      if (!els.permissionDialog?.open) {
        els.permissionDialog?.showModal();
      }
      throw new Error("没有麦克风权限，请到系统设置里允许“留声簿”访问麦克风。");
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    currentRecordingToken = recordingToken;
    isRecordingLive = true;
    isRecordingPaused = false;
    isFinalizingRecording = false;
    liveStream = stream;
    chunks = [];
    startedAt = Date.now();
    liveChunkQueue = Promise.resolve();
    resetLiveCorrectionState();
    updateCurrentSession({
      id: `session-${Date.now()}`,
      title: makeTitle("现场录音"),
      transcript: "",
      utterances: [],
    });
    els.transcriptText.textContent =
      currentTranscriptionMode === "precise"
        ? "精准模式录音中。停止后会自动生成整段精准转写。"
        : "正在实时转写…";
    els.transcriptText.classList.remove("empty");
    els.recordStatus.textContent = "连接实时转写";

    if (currentTranscriptionMode !== "precise") {
      await window.appApi.startLiveTranscription();
      await setupLivePreview(stream);
    }

    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    mediaRecorder.onstop = async () => {
      isFinalizingRecording = true;
      await liveChunkQueue;
      if (currentTranscriptionMode === "hybrid" && latestLivePayload) {
        scheduleSegmentCorrection(latestLivePayload, currentRecordingToken);
        await drainSegmentCorrections(currentRecordingToken);
      }
      isRecordingLive = false;
      isRecordingPaused = false;
      await window.appApi.stopLiveTranscription();
      const blob = new Blob(chunks, { type: "audio/webm" });
      const buffer = await blob.arrayBuffer();
      refreshRecordStatus();
      try {
        let nextSession;
        if (currentTranscriptionMode === "precise") {
          const result = await window.appApi.transcribeRecording({
            buffer: Array.from(new Uint8Array(buffer)),
            extension: "webm",
          });
          nextSession = {
            id: `session-${Date.now()}`,
            title: makeTitle("现场录音"),
            transcript: result.text || "",
            utterances: result.utterances || [],
            audioPath: result.audioPath || "",
            sourceAudioPath: result.sourceAudioPath || result.audioPath || "",
          };
        } else {
          const saved = await window.appApi.saveRecordingBuffer({
            buffer: Array.from(new Uint8Array(buffer)),
            extension: "webm",
          });
          nextSession = {
            id: `session-${Date.now()}`,
            title: makeTitle("现场录音"),
            transcript: currentSession?.transcript || latestLivePayload?.text || "",
            utterances: currentSession?.utterances || latestLivePayload?.utterances || [],
            audioPath: saved.audioPath || "",
            sourceAudioPath: saved.sourceAudioPath || saved.audioPath || "",
          };
        }
        updateCurrentSession(nextSession);
        if (currentSession) renderSessions(await window.appApi.saveSession(currentSession));
        if (currentTab === "record") {
          updateCurrentSession(makeEmptySession());
        }
        showToast(currentTranscriptionMode === "precise" ? "精准转写完成" : "录音已保存");
      } catch (error) {
        showToast(error.message || "录音转写失败");
        els.transcriptText.textContent = error.message || "录音转写失败";
      } finally {
        isFinalizingRecording = false;
        teardownLiveAudio();
        resetLiveCorrectionState();
        resetRecordingUi();
      }
    };
    mediaRecorder.start(250);
    refreshRecordStatus();
    if (els.pauseRecord) {
      els.pauseRecord.disabled = false;
      els.pauseRecord.textContent = "Ⅱ";
      els.pauseRecord.classList.remove("is-paused");
    }
    els.stopRecord.textContent = "■";
    els.stopRecord.classList.add("is-recording");
    updateRecordControls();
  } catch (error) {
    isRecordingLive = false;
    isFinalizingRecording = false;
    teardownLiveAudio();
    resetLiveCorrectionState();
    resetRecordingUi();
    showToast(error.message || "启动录音失败");
  }
}

async function enhanceSession() {
  if (!currentSession?.audioPath) return;
  isEnhancingSession = true;
  refreshEnhanceUi();
  els.transcriptMeta.textContent = "正在优化整段录音…";
  els.transcriptText.textContent = "正在使用精准模型优化整段录音…";
  els.transcriptText.classList.remove("empty");
  try {
    const result = await window.appApi.transcribeFile(currentSession.sourceAudioPath || currentSession.audioPath);
    const nextSession = {
      ...currentSession,
      transcript: result.text || "",
      utterances: result.utterances || [],
      audioPath: currentSession.audioPath,
    };
    updateCurrentSession(nextSession);
    renderSessions(await window.appApi.saveSession(nextSession));
    markSessionUpdated(nextSession.id);
    showToast("优化完成");
  } catch (error) {
    showToast(error.message || "优化失败");
    renderTranscript(currentSession);
  } finally {
    isEnhancingSession = false;
    els.transcriptMeta.textContent = currentSession?.utterances?.length ? `${currentSession.utterances.length} 段` : "";
    refreshEnhanceUi();
  }
}

async function exportSession() {
  if (!currentSession) return;
  const content = `# ${currentSession.title}\n\n## 转写稿\n\n${currentSession.transcript || ""}\n`;
  const saved = await window.appApi.exportSessionBundle({
    title: currentSession.title,
    content,
    audioPath: currentSession.audioPath || "",
    sourceAudioPath: currentSession.sourceAudioPath || currentSession.audioPath || "",
  });
  if (saved?.exportDir) showToast(`已导出到 ${saved.exportDir}`);
}

async function init() {
  fillConfig(await window.appApi.getConfig());
  await refreshSessions();
  if (!currentSession) {
    updateCurrentSession(makeEmptySession());
  }
  resetRecordingUi();
  switchTab("record");
  updateRecordControls();
  checkMicrophonePermissionOnStartup().catch(() => {});

  els.tabs.forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));
  els.modeRealtime?.addEventListener("click", () => persistTranscriptionMode("realtime").catch(() => {}));
  els.modePrecise?.addEventListener("click", () => persistTranscriptionMode("precise").catch(() => {}));
  els.modeHybrid?.addEventListener("click", () => persistTranscriptionMode("hybrid").catch(() => {}));
  els.openSettings.addEventListener("click", () => els.settingsDialog.showModal());
  els.openSettingsMirror?.addEventListener("click", () => els.settingsDialog.showModal());
  els.saveSettings.addEventListener("click", async (event) => {
    event.preventDefault();
    currentConfig = { ...currentConfig, ...readConfigForm() };
    await window.appApi.saveConfig(currentConfig);
    els.settingsDialog.close();
    showToast("设置已保存");
  });
  els.permissionOpenSettings?.addEventListener("click", async () => {
    const opened = await window.appApi.openMicrophoneSettings();
    if (!opened) {
      showToast("无法直接打开系统设置，请手动前往“隐私与安全性 -> 麦克风”");
    }
  });
  els.permissionRetry?.addEventListener("click", async () => {
    const ok = await checkMicrophonePermissionOnStartup();
    if (ok) {
      els.permissionDialog?.close();
      showToast("麦克风权限已开启");
    }
  });
  els.pickFile.addEventListener("click", async () => {
    switchTab("playback");
    const filePath = await window.appApi.pickFile();
    if (!filePath) return;
    selectedFile = filePath;
    await transcribeSelectedFile();
  });
  els.sessionSearch?.addEventListener("input", async (event) => {
    currentSearchQuery = event.target.value || "";
    renderSessions(await window.appApi.listSessions());
  });
  els.enhanceSession.addEventListener("click", () => {
    enhanceSession().catch((error) => showToast(error.message || "优化失败"));
  });
  els.pauseRecord?.addEventListener("click", () => {
    togglePauseRecording().catch((error) => showToast(error.message || "暂停失败"));
  });
  els.stopRecord.addEventListener("click", () => {
    if (isFinalizingRecording) return;
    if (mediaRecorder?.state === "recording") {
      mediaRecorder.stop();
      els.stopRecord.disabled = true;
      updateRecordControls();
      return;
    }
    if (mediaRecorder?.state === "paused") {
      mediaRecorder.stop();
      els.stopRecord.disabled = true;
      updateRecordControls();
      return;
    }
    startRecording().catch((error) => showToast(error.message || "启动录音失败"));
  });
  window.appApi.onLiveUpdate((payload) => {
    if (!isRecordingLive) return;
    latestLivePayload = payload;
    renderCombinedTranscript(payload);
    scheduleSegmentCorrection(payload, currentRecordingToken);
    updateListeningRow(payload);
    refreshRecordStatus();
  });
  window.appApi.onLiveError((payload) => {
    if (!isRecordingLive && !isFinalizingRecording) return;
    showToast(payload.message || "实时转写失败");
    els.recordStatus.textContent = payload.message || "实时转写失败";
  });
  els.exportSession.addEventListener("click", exportSession);
}

init().catch((error) => showToast(error.message || "初始化失败"));
