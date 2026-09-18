"""
mock-cloud-gateway.py — 验证用「OpenAI 兼容云网关」

模拟一家"云端供应商"的三个接口，供 speech-to-speech 的 openai STT /
chat-completions LLM / openai TTS handler 以真实云端参数访问：

  POST /v1/audio/transcriptions   STT：返回脚本化转写文本（无可用云 STT Key，
                                  用固定文本验证链路；首条 warmup 静音返回空）
  POST /v1/chat/completions       LLM：流式回显用户最新语音转写（证明 STT→LLM 接线）
  POST /v1/audio/speech           TTS：**真实微软云端合成**（edge-tts，免 Key 国内直连），
                                  mp3 → ffmpeg → PCM16 24kHz 流式返回

所有收到的请求（含完整 payload 摘要）写入 verify/cloud-requests.log，
作为「s2s 发出的请求与真实云端形状一致」的证据。
"""
from __future__ import annotations

import asyncio
import json
import shutil
import time
from pathlib import Path

import edge_tts
from fastapi import FastAPI, Request, UploadFile
from fastapi.responses import JSONResponse, Response, StreamingResponse

APP_PORT = 8091
EDGE_VOICE = "zh-CN-XiaoxiaoNeural"
MOCK_STT_TEXT = "喂，你终于上线了，我等你好久了，今天想我了没有呀？"
LOG = Path(__file__).parent.parent / "verify" / "cloud-requests.log"

stt_calls = 0
app = FastAPI(title="mock-cloud-gateway")


def log_request(kind: str, summary: str) -> None:
    LOG.parent.mkdir(exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(f"[{time.strftime('%H:%M:%S')}] {kind}: {summary}\n")
    print(f"[gateway] {kind}: {summary}", flush=True)


@app.get("/v1/models")
async def models() -> JSONResponse:
    return JSONResponse({"data": [{"id": "mock-asr"}, {"id": "mock-chat"}, {"id": "mock-tts"}]})


# ------------------------------------------------------------------ STT ----

@app.post("/v1/audio/transcriptions")
async def transcriptions(request: Request, file: UploadFile) -> JSONResponse:
    global stt_calls
    stt_calls += 1
    form = await request.form()
    meta = {k: str(form.get(k)) for k in form if k != "file"}
    wav_bytes = await file.read()
    # 首条是 1 秒合成静音的 warmup；真实音频返回脚本化转写
    text = "" if stt_calls == 1 else MOCK_STT_TEXT
    log_request("STT", f"warmup={stt_calls == 1} file={len(wav_bytes)}B fields={meta} -> text={text!r}")
    return JSONResponse({"text": text})


# ------------------------------------------------------------------ LLM ----

def _sse(text: str, model: str) -> str:
    """OpenAI chat.completions 流式响应（分词发送）。"""
    events = []
    for piece in [text[i:i + 4] for i in range(0, len(text), 4)]:
        chunk = {
            "id": "chatcmpl-mock", "object": "chat.completion.chunk",
            "created": int(time.time()), "model": model,
            "choices": [{"index": 0, "delta": {"content": piece}, "finish_reason": None}],
        }
        events.append("data: " + json.dumps(chunk, ensure_ascii=False))
    final = {
        "id": "chatcmpl-mock", "object": "chat.completion.chunk",
        "created": int(time.time()), "model": model,
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
    }
    events.append("data: " + json.dumps(final, ensure_ascii=False))
    return "\n\n".join(events) + "\n\ndata: [DONE]\n\n"


@app.post("/v1/chat/completions")
async def chat_completions(request: Request) -> Response:
    body = await request.json()
    messages = body.get("messages", [])
    user_text = next(
        (m.get("content") or "" for m in reversed(messages) if m.get("role") == "user"), ""
    )
    if isinstance(user_text, list):  # content 数组形态，取 text 段
        user_text = " ".join(p.get("text", "") for p in user_text if isinstance(p, dict))
    reply = f"嗯，我在呢。我刚才听你说的是：{user_text} 今天也想去见你呀。"
    log_request("LLM", f"stream={body.get('stream')} model={body.get('model')} "
                       f"n_msgs={len(messages)} last_user={user_text[:60]!r} -> reply={reply[:50]!r}")
    if body.get("stream"):
        return Response(content=_sse(reply, body.get("model", "mock")),
                        media_type="text/event-stream")
    return JSONResponse({
        "id": "chatcmpl-mock", "object": "chat.completion", "created": int(time.time()),
        "model": body.get("model", "mock"),
        "choices": [{"index": 0, "message": {"role": "assistant", "content": reply},
                     "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    })


# ------------------------------------------------------------------ TTS ----

async def _edge_to_pcm_stream(text: str, voice: str):
    """edge-tts(微软云) mp3 → ffmpeg → PCM16 24k mono，逐块产出。"""
    ff = shutil.which("ffmpeg")
    if not ff:
        raise RuntimeError("ffmpeg not found")
    comm = edge_tts.Communicate(text, voice)
    proc = await asyncio.create_subprocess_exec(
        ff, "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
        "-f", "s16le", "-ar", "24000", "-ac", "1", "pipe:1",
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
    )

    async def feed() -> None:
        try:
            async for chunk in comm.stream():
                if chunk["type"] == "audio":
                    proc.stdin.write(chunk["data"])
                    await proc.stdin.drain()
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass

    feeder = asyncio.create_task(feed())
    total = 0
    try:
        while True:
            out = await proc.stdout.read(4096)
            if not out:
                break
            total += len(out)
            yield out
        await feeder
        await proc.wait()
    finally:
        feeder.cancel()
    log_request("TTS", f"edge_voice={voice} chars={len(text)} -> {total}B pcm24k")


@app.post("/v1/audio/speech")
async def speech(request: Request) -> StreamingResponse:
    body = await request.json()
    text = body.get("input", "")
    voice = body.get("voice") or EDGE_VOICE
    if isinstance(voice, dict):
        voice = voice.get("id", EDGE_VOICE)
    edge_voice = voice.split("edge:", 1)[1] if voice.startswith("edge:") else EDGE_VOICE
    log_request("TTS", f"model={body.get('model')} voice={voice} fmt={body.get('response_format')} "
                       f"input={text[:50]!r}")
    if body.get("response_format") == "wav":
        # 简化：网关统一给 pcm（handler 默认 pcm；wav 分支仅显式请求时用，此处不支持）
        return JSONResponse({"error": "gateway supports pcm only"}, status_code=400)
    return StreamingResponse(
        _edge_to_pcm_stream(text, edge_voice),
        media_type="audio/pcm",
        headers={"x-sample-rate": "24000"},
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=APP_PORT, log_level="warning")
