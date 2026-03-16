const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function getBundledFfmpegPath() {
  const executable = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return path.join(process.resourcesPath || "", "ffmpeg-bin", executable);
}

const CANDIDATE_PATHS = [
  getBundledFfmpegPath(),
  process.env.FFMPEG_PATH,
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
  "/opt/local/bin/ffmpeg",
].filter(Boolean);

function canRun(binary) {
  try {
    const result = spawnSync(binary, ["-version"], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

function resolveFfmpeg() {
  for (const candidate of CANDIDATE_PATHS) {
    if (fs.existsSync(candidate) && canRun(candidate)) {
      return candidate;
    }
  }

  const fromPath = spawnSync("which", ["ffmpeg"], { encoding: "utf8" });
  const binary = fromPath.status === 0 ? fromPath.stdout.trim().split("\n")[0] : "";
  if (binary && fs.existsSync(binary) && canRun(binary)) {
    return binary;
  }

  throw new Error("未找到 ffmpeg。请重新安装留声簿，或手动安装 ffmpeg。");
}

module.exports = {
  resolveFfmpeg,
};
