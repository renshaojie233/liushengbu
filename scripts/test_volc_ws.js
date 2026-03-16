const { transcribeAudioFile } = require("../lib/volcStreaming");

async function main() {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error("用法: node scripts/test_volc_ws.js <audio-file>");
    process.exit(1);
  }

  const config = {
    appId: process.env.VOLC_APP_ID || "",
    cluster: process.env.VOLC_CLUSTER || "Doubao_Seed_ASR_Streaming_2.02000000660265493762",
    resourceId: process.env.VOLC_RESOURCE_ID || "volc.seedasr.sauc.duration",
    accessToken: process.env.VOLC_TOKEN || "",
    secretKey: process.env.VOLC_SECRET || "",
    authStyle: process.env.VOLC_AUTH_STYLE || "x-api",
    authMode: process.env.VOLC_AUTH_MODE || "bearer",
    bodyTokenMode: process.env.VOLC_BODY_TOKEN_MODE || "raw",
    wsUrl: process.env.VOLC_WS_URL || "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream",
  };

  const result = await transcribeAudioFile(config, inputFile);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
