// ws-client.mjs — 真实 Realtime WebSocket 验证客户端（Node 24 内置 WebSocket）
//
// 模拟浏览器：连 ws://127.0.0.1:8765/v1/realtime，把 ref.wav（16kHz PCM16 mono）
// 按 50ms 块推成 input_audio_buffer.append，服务端 VAD 断句 → STT → LLM → TTS，
// 收集 transcript / text / output_audio 事件，把返回音频写成 out.wav。
//
// 用法: node ws-client.mjs [wav路径] [超时秒]

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WS_URL = process.env.S2S_WS_URL || "ws://127.0.0.1:8765/v1/realtime";
const wavPath = process.argv[2] || "../deploy-package/ref.wav";
const TIMEOUT_S = Number(process.argv[3] || 150);

// ── 读 WAV，剥头取 PCM16 ─────────────────────────────────────────────────────
const wav = readFileSync(wavPath);
const dataIdx = wav.indexOf("data", 12); // RIFF 头之后找 data 块
const pcm = wav.subarray(dataIdx + 8);
console.log(`[client] 输入: ${basename(wavPath)} ${pcm.length}B PCM16 (~${(pcm.length / 32000).toFixed(1)}s @16kHz)`);

// ── 连接 ─────────────────────────────────────────────────────────────────────
const ws = new WebSocket(WS_URL);
ws.binaryType = "arraybuffer";

/** @type {string[]} 事件时间线 */
const timeline = [];
let sttText = "";
let replyText = "";
const audioChunks = [];
let responseDone = false;
let turnCommitted = false;

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;

let sessionObj = null;
function sendSessionUpdate() {
  if (!sessionObj) return;
  const s = structuredClone(sessionObj);
  s.instructions = "你叫小雅，是他的女朋友。口语、两三句、带语气词。不用 Markdown。";
  if ("voice" in s) s.voice = "user:my-clone-voice-id";
  ws.send(JSON.stringify({ type: "session.update", session: s }));
  console.log(`[client] ${at()} session.update 已发送（回显 created 会话 + 人设/音色）`);
}

ws.addEventListener("open", () => {
  console.log(`[client] ${at()} 已连接 ${WS_URL}`);
  streamAudio(); // session.update 等 session.created 到达后再发
});

ws.addEventListener("message", (evt) => {
  if (typeof evt.data !== "string") return;
  let m; try { m = JSON.parse(evt.data); } catch { return; }
  const t = m.type || "";
  if (t !== "response.output_audio.delta") timeline.push(`${at()} ${t}`);
  if (t === "session.created") {
    sessionObj = m.session;
    sendSessionUpdate();
  } else if (t === "input_audio_buffer.speech_started") {
    console.log(`[client] ${at()} VAD: 检测到说话`);
  } else if (t === "input_audio_buffer.speech_stopped") {
    console.log(`[client] ${at()} VAD: 说话结束，等断句`);
  } else if (t === "conversation.item.input_audio_transcription.completed") {
    sttText = m.transcript || "";
    console.log(`[client] ${at()} STT 转写: "${sttText}"`);
  } else if (t === "response.output_audio_transcript.delta" || t === "response.output_text.delta") {
    replyText += m.delta || "";
  } else if (t === "response.output_audio.delta") {
    const bin = Buffer.from(m.delta, "base64");
    audioChunks.push(bin);
  } else if (t === "response.done") {
    responseDone = true;
    console.log(`[client] ${at()} 回合完成。音频块数=${audioChunks.length}`);
  } else if (t === "error") {
    console.error(`[client] ${at()} 服务端错误: ${JSON.stringify(m).slice(0, 300)}`);
  }
});

ws.addEventListener("close", () => console.log(`[client] ${at()} 连接关闭`));
ws.addEventListener("error", (e) => console.error("[client] ws error:", e.message || e));

// ── 音频推流 ─────────────────────────────────────────────────────────────────
async function streamAudio() {
  const CHUNK = 1600; // 50ms @16kHz mono s16le
  const silent = Buffer.alloc(CHUNK);
  for (let off = 0; off < pcm.length; off += CHUNK) {
    const slice = pcm.subarray(off, Math.min(off + CHUNK, pcm.length));
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: slice.toString("base64") }));
    await new Promise((r) => setTimeout(r, 50));
  }
  // 真实麦克风是持续推流的：语音结束后继续喂 4s 静音，让 VAD 看到停顿、
  // 触发断句（min_silence_ms）与 smart-turn 判定
  for (let i = 0; i < 80; i++) {
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: silent.toString("base64") }));
    await new Promise((r) => setTimeout(r, 50));
  }
  turnCommitted = true;
  console.log(`[client] ${at()} 语音+静音尾段推送完毕，等待 STT→LLM→TTS…`);
}

// ── 收尾与判定 ───────────────────────────────────────────────────────────────
setTimeout(() => {
  const audioBytes = audioChunks.reduce((n, c) => n + c.length, 0);
  // 写 WAV（16kHz mono 16bit）
  if (audioBytes) {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); header.writeUInt32LE(36 + audioBytes, 4); header.write("WAVE", 8);
    header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write("data", 36); header.writeUInt32LE(audioBytes, 40);
    writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "out.wav"), Buffer.concat([header, ...audioChunks]));
  }
  const result = {
    connected: true,
    responseDone,
    sttText,
    replyText: replyText.slice(0, 200),
    audioChunks: audioChunks.length,
    audioBytes,
    audioSeconds: +(audioBytes / 32000).toFixed(2),
    verdict: sttText && replyText && audioBytes > 16000 ? "PASS ✅" : "FAIL ❌",
  };
  console.log("\n===== 验证结果 =====");
  console.log(JSON.stringify(result, null, 2));
  console.log("===== 事件时间线（尾部 30 条）=====");
  console.log(timeline.slice(-30).join("\n"));
  try { ws.close(); } catch {}
  process.exit(result.verdict.startsWith("PASS") ? 0 : 1);
}, TIMEOUT_S * 1000);
