#!/usr/bin/env bash
# =============================================================================
#  start-cloud-server.sh — 全云端模式编排服务启动（CPU 即可，无需显卡/WSL）
#
#  读取同目录 cloud.env（可由前端「☁ 云服务 → 下载 cloud.env」生成），映射成
#  speech-to-speech serve 的参数。三件套全部走云端 OpenAI 兼容接口。
#
#  用法:
#    pip install "speech-to-speech"            # 首次
#    ./start-cloud-server.sh [cloud.env 路径]
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${1:-$HERE/cloud.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "✗ 找不到 $ENV_FILE" >&2
  echo "  在前端设置 → ☁ 云服务 填好三件套后点「下载 cloud.env」，" >&2
  echo "  或手动复制 cloud.env.example 改名填写。" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${S2S_STT_BASE_URL:?cloud.env 缺 S2S_STT_BASE_URL}"
: "${S2S_STT_MODEL:?cloud.env 缺 S2S_STT_MODEL}"
: "${S2S_LLM_BASE_URL:?cloud.env 缺 S2S_LLM_BASE_URL}"
: "${S2S_LLM_MODEL:?cloud.env 缺 S2S_LLM_MODEL}"
: "${S2S_TTS_BASE_URL:?cloud.env 缺 S2S_TTS_BASE_URL}"
: "${S2S_TTS_MODEL:?cloud.env 缺 S2S_TTS_MODEL}"

exec speech-to-speech serve \
  --stt openai \
  --openai_stt_base_url "$S2S_STT_BASE_URL" \
  --openai_stt_model "$S2S_STT_MODEL" \
  --openai_stt_api_key "${S2S_STT_API_KEY:-}" \
  --openai_stt_language "${S2S_LANGUAGE:-zh}" \
  --llm_backend chat-completions \
  --responses_api_base_url "$S2S_LLM_BASE_URL" \
  --model_name "$S2S_LLM_MODEL" \
  --responses_api_api_key "${S2S_LLM_API_KEY:-}" \
  --responses_api_stream \
  --tts openai \
  --openai_tts_base_url "$S2S_TTS_BASE_URL" \
  --openai_tts_model "$S2S_TTS_MODEL" \
  --openai_tts_api_key "${S2S_TTS_API_KEY:-}" \
  --openai_tts_voice "${S2S_TTS_VOICE:-}" \
  --thresh "${S2S_VAD_THRESH:-0.6}" \
  --min_speech_ms "${S2S_MIN_SPEECH_MS:-500}" \
  --min_silence_ms "${S2S_MIN_SILENCE_MS:-1200}" \
  --speech_pad_ms "${S2S_SPEECH_PAD_MS:-300}"
