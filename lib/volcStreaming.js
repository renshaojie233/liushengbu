const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const WebSocket = require("ws");
const { resolveFfmpeg } = require("./ffmpeg");

const V2_WS_URL = "wss://openspeech.bytedance.com/api/v2/asr";
const V3_ASYNC_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
const V3_NOSTREAM_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream";

function buildHeader(messageType, messageFlags, serialization = 1, compression = 1) {
  const protocolVersion = 1;
  const headerSize = 1;
  return Buffer.from([
    (protocolVersion << 4) | headerSize,
    (messageType << 4) | messageFlags,
    (serialization << 4) | compression,
    0,
  ]);
}

function withPayloadSize(header, payload) {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, size, payload]);
}

function isV3SaucConfig(config) {
  return Boolean(config.resourceId && config.resourceId.includes(".sauc."));
}

function getWsUrl(config) {
  if (config.wsUrl) return config.wsUrl;
  return isV3SaucConfig(config) ? V3_NOSTREAM_URL : V2_WS_URL;
}

function getPreviewWsUrl(config) {
  if (config.previewWsUrl) return config.previewWsUrl;
  return isV3SaucConfig(config) ? V3_ASYNC_URL : getWsUrl(config);
}

function buildAuthHeader(config) {
  if (config.authMode === "hmac" && config.secretKey) {
    const canonical = "GET /api/v2/asr HTTP/1.1\nopenspeech.bytedance.com\n";
    const mac = crypto.createHmac("sha256", config.secretKey).update(canonical).digest("base64url");
    return `HMAC256; access_token="${config.accessToken}"; mac="${mac}"`;
  }
  return `Bearer; ${config.accessToken}`;
}

function buildHeaders(config, wsUrl) {
  if ((config.authStyle || "x-api") === "x-api") {
    const headers = {
      "X-Api-App-Key": config.appId,
      "X-Api-Access-Key": config.accessToken,
    };
    if (config.resourceId) headers["X-Api-Resource-Id"] = config.resourceId;
    if (wsUrl.includes("/api/v3/")) headers["X-Api-Connect-Id"] = crypto.randomUUID();
    return headers;
  }

  return {
    Authorization: buildAuthHeader(config),
    ...(config.resourceId ? { "X-Api-Resource-Id": config.resourceId } : {}),
  };
}

function convertAudio(inputFile, targetFormat) {
  const extension = targetFormat === "wav" ? "wav" : "pcm";
  const outFile = path.join(os.tmpdir(), `doubao-class-notes-${Date.now()}.${extension}`);
  const args = ["-y", "-i", inputFile, "-ac", "1", "-ar", "16000"];
  if (targetFormat === "wav") {
    args.push("-c:a", "pcm_s16le", outFile);
  } else {
    args.push("-f", "s16le", outFile);
  }

  const result = spawnSync(resolveFfmpeg(), args, { stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(result.stderr.toString("utf8") || "ffmpeg 转码失败");
  }
  return outFile;
}

function makeV2FullRequest(config, reqid) {
  const bodyToken = config.bodyTokenMode === "prefixed"
    ? `Bearer; ${config.accessToken}`
    : config.accessToken;
  const payload = Buffer.from(
    JSON.stringify({
      app: {
        appid: config.appId,
        cluster: config.cluster,
        token: bodyToken,
        resource_id: config.resourceId || undefined,
      },
      user: {
        uid: "renshaojie",
      },
      request: {
        reqid,
        workflow: "audio_in,resample,partition,vad,fe,decode,itn,nlu_punctuate",
        show_language: true,
        show_utterances: true,
        result_type: "single",
        sequence: 1,
      },
      audio: {
        format: "raw",
        codec: "raw",
        rate: 16000,
        bits: 16,
        channel: 1,
      },
    }),
    "utf8"
  );

  return withPayloadSize(buildHeader(1, 0, 1, 1), zlib.gzipSync(payload));
}

function makeV3FullRequest(wsUrl, audioFormat = "wav") {
  const audio = {
    format: audioFormat,
    codec: "raw",
    rate: 16000,
    bits: 16,
    channel: 1,
  };

  if (wsUrl.endsWith("bigmodel_nostream")) {
    audio.language = "zh-CN";
  }

  const payload = Buffer.from(
    JSON.stringify({
      user: {
        uid: "renshaojie",
        platform: process.platform,
        sdk_version: "doubao-class-notes",
      },
      audio,
      request: {
        model_name: "bigmodel",
        enable_itn: true,
        enable_ddc: false,
        enable_punc: true,
        show_utterances: true,
        result_type: "full",
      },
    }),
    "utf8"
  );

  return withPayloadSize(buildHeader(1, 0, 1, 1), zlib.gzipSync(payload));
}

function makeAudioPacket(chunk, isLast) {
  const flags = isLast ? 2 : 0;
  return withPayloadSize(buildHeader(2, flags, 0, 1), zlib.gzipSync(chunk));
}

function makeStreamingWavHeader(sampleRate = 16000, channels = 1, bits = 16, dataSize = 0x7ffff000) {
  const blockAlign = channels * (bits / 8);
  const byteRate = sampleRate * blockAlign;
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(Math.min(36 + dataSize, 0xffffffff), 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(Math.min(dataSize, 0xffffffff), 40);
  return buffer;
}

function parseMessage(buffer) {
  const headerSize = (buffer[0] & 0x0f) * 4;
  const messageType = (buffer[1] & 0xf0) >> 4;
  const messageFlags = buffer[1] & 0x0f;
  const serialization = (buffer[2] & 0xf0) >> 4;
  const compression = buffer[2] & 0x0f;

  let payloadOffset = headerSize;
  let payloadSize = 0;
  let backendCode = null;
  let sequence = null;

  if ((messageFlags === 1 || messageFlags === 3) && buffer.length >= payloadOffset + 4) {
    sequence = buffer.readInt32BE(payloadOffset);
    payloadOffset += 4;
  }

  if (messageType === 15) {
    backendCode = buffer.readUInt32BE(payloadOffset);
    payloadOffset += 4;
    payloadSize = buffer.readUInt32BE(payloadOffset);
    payloadOffset += 4;
  } else if (buffer.length >= payloadOffset + 4) {
    payloadSize = buffer.readUInt32BE(payloadOffset);
    payloadOffset += 4;
  }

  const payload = buffer.subarray(payloadOffset, payloadOffset + payloadSize);
  let decoded = payload;
  if (compression === 1 && payload.length > 0) {
    decoded = zlib.gunzipSync(payload);
  }
  if (serialization === 1 && decoded.length > 0) {
    const text = decoded.toString("utf8");
    try {
      decoded = JSON.parse(text);
    } catch {
      decoded = text;
    }
  } else {
    decoded = decoded.toString("utf8");
  }

  return { messageType, messageFlags, sequence, backendCode, decoded };
}

function normalizeError(backendCode, detail) {
  if (backendCode === 45000010) {
    return "豆包鉴权失败：当前 Access Token / Secret Key / 鉴权方式 不匹配。";
  }
  if (backendCode === 45000030 || detail.includes("requested resource not granted")) {
    return `豆包资源未授权：${detail}`;
  }
  return `豆包语音返回错误 ${backendCode}: ${detail}`;
}

function shouldResolve(protocol, transcript, utterances, message) {
  if (!transcript) return false;
  return protocol === "v2" && message.messageType === 9;
}

async function transcribeAudioFile(config, inputFile) {
  const protocol = isV3SaucConfig(config) ? "v3" : "v2";
  const wsUrl = getWsUrl(config);
  const idleTimeoutMs = protocol === "v3" ? Number(config.fileIdleTimeoutMs || 30000) : 0;
  if (!config.appId || !config.accessToken) {
    throw new Error("请先在设置中填写 App ID 和 Access Token。");
  }
  if (protocol === "v2" && !config.cluster) {
    throw new Error("当前接口需要 Cluster，请先在设置中填写。");
  }
  if (protocol === "v3" && !config.resourceId) {
    throw new Error("当前接口需要 Resource ID，请先在设置中填写。");
  }

  const convertedFile = convertAudio(inputFile, protocol === "v3" ? "wav" : "raw");
  const audio = fs.readFileSync(convertedFile);
  const reqid = `req-${Date.now()}`;
  const chunkSize = protocol === "v3" ? 6400 : 32000;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: buildHeaders(config, wsUrl) });
    let transcript = "";
    let utterances = [];
    let settled = false;
    let idleTimer = null;

    const cleanup = () => fs.rmSync(convertedFile, { force: true });
    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearIdleTimer();
      cleanup();
      resolve(result);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearIdleTimer();
      cleanup();
      reject(error);
    };
    const armIdleTimer = () => {
      if (protocol !== "v3" || !transcript) return;
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        ws.close();
        finish({ text: transcript, utterances });
      }, idleTimeoutMs);
    };

    ws.on("open", () => {
      const fullRequest = protocol === "v3"
        ? makeV3FullRequest(wsUrl)
        : makeV2FullRequest(config, reqid);
      ws.send(fullRequest);

      let offset = 0;
      while (offset < audio.length) {
        const end = Math.min(offset + chunkSize, audio.length);
        const chunk = audio.subarray(offset, end);
        ws.send(makeAudioPacket(chunk, end >= audio.length));
        offset = end;
      }
    });

    ws.on("message", (data) => {
      try {
        const message = parseMessage(Buffer.from(data));
        if (message.messageType === 15) {
          const detail = message.decoded?.message || "未知错误";
          throw new Error(normalizeError(message.backendCode, detail));
        }

        const result = message.decoded?.result || message.decoded;
        if (result?.text) transcript = result.text;
        if (Array.isArray(result?.utterances)) utterances = result.utterances;

        if (shouldResolve(protocol, transcript, utterances, message)) {
          ws.close();
          finish({ text: transcript, utterances });
          return;
        }
        armIdleTimer();
      } catch (error) {
        ws.close();
        fail(error);
      }
    });

    ws.on("close", () => {
      if (settled) return;
      if (transcript) {
        finish({ text: transcript, utterances });
        return;
      }
      fail(new Error("豆包语音连接已关闭，未返回有效结果。"));
    });

    ws.on("error", (error) => {
      fail(error);
    });
  });
}

class LiveTranscriber {
  constructor(config, handlers = {}) {
    this.config = { ...config, wsUrl: getPreviewWsUrl(config) };
    this.handlers = handlers;
    this.ws = null;
    this.closed = false;
    this.started = false;
    this.sentAudio = false;
    this.latestText = "";
    this.latestUtterances = [];
  }

  async start() {
    if (!this.config.appId || !this.config.accessToken) {
      throw new Error("请先在设置中填写 App ID 和 Access Token。");
    }
    if (isV3SaucConfig(this.config) && !this.config.resourceId) {
      throw new Error("实时转写需要 Resource ID。");
    }

    const wsUrl = this.config.wsUrl;
    this.ws = new WebSocket(wsUrl, { headers: buildHeaders(this.config, wsUrl) });

    await new Promise((resolve, reject) => {
      const onOpen = () => {
        const fullRequest = isV3SaucConfig(this.config)
          ? makeV3FullRequest(wsUrl, "wav")
          : makeV2FullRequest(this.config, `req-${Date.now()}`);
        this.ws.send(fullRequest);
        this.started = true;
        resolve();
      };
      const onError = (error) => reject(error);
      this.ws.once("open", onOpen);
      this.ws.once("error", onError);
    });

    this.ws.on("message", (data) => {
      try {
        const message = parseMessage(Buffer.from(data));
        if (message.messageType === 15) {
          const detail = message.decoded?.message || "未知错误";
          throw new Error(normalizeError(message.backendCode, detail));
        }
        const result = message.decoded?.result || message.decoded;
        const text = result?.text || "";
        const utterances = Array.isArray(result?.utterances) ? result.utterances : [];
        if (!text || text === this.latestText) return;
        this.latestText = text;
        this.latestUtterances = utterances;
        this.handlers.onPartial?.({
          text,
          utterances,
          isDefinite: utterances.some((item) => item.definite),
        });
      } catch (error) {
        this.handlers.onError?.(error);
      }
    });

    this.ws.on("error", (error) => {
      if (!this.closed) this.handlers.onError?.(error);
    });

    this.ws.on("close", () => {
      this.closed = true;
      this.handlers.onClose?.({
        text: this.latestText,
        utterances: this.latestUtterances,
      });
    });
  }

  sendAudioChunk(chunk) {
    if (!this.started || this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    let payload = chunk;
    if (isV3SaucConfig(this.config) && !this.sentAudio) {
      payload = Buffer.concat([makeStreamingWavHeader(), chunk]);
    }
    this.sentAudio = true;
    this.ws.send(makeAudioPacket(payload, false));
  }

  async stop() {
    if (!this.ws || this.closed) return;
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(makeAudioPacket(Buffer.alloc(0), true));
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.ws.terminate();
        resolve();
      }, 1500);
      this.ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

module.exports = {
  createLiveTranscriber: (config, handlers) => new LiveTranscriber(config, handlers),
  transcribeAudioFile,
};
