# =============================================================================
#  start-cloud-server.ps1 — 全云端模式编排服务启动（Windows 本机，CPU 即可）
#
#  用法:
#    pip install "speech-to-speech"
#    powershell -ExecutionPolicy Bypass -File start-cloud-server.ps1 [-EnvFile cloud.env]
# =============================================================================
param([string]$EnvFile = Join-Path $PSScriptRoot "cloud.env")

if (-not (Test-Path $EnvFile)) {
  Write-Error "找不到 $EnvFile —— 在前端设置 → ☁ 云服务 生成 cloud.env 后放到本目录"
  exit 1
}

$map = @{}
Get-Content $EnvFile | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
    $map[$Matches[1]] = $Matches[2].Trim('"', "'")
  }
}

function Req($k) {
  if (-not $map[$k]) { Write-Error "cloud.env 缺 $k"; exit 1 }
  return $map[$k]
}

$sttBase = Req "S2S_STT_BASE_URL"; $sttModel = Req "S2S_STT_MODEL"
$llmBase = Req "S2S_LLM_BASE_URL"; $llmModel = Req "S2S_LLM_MODEL"
$ttsBase = Req "S2S_TTS_BASE_URL"; $ttsModel = Req "S2S_TTS_MODEL"

& speech-to-speech serve `
  --stt openai `
  --openai_stt_base_url $sttBase `
  --openai_stt_model $sttModel `
  --openai_stt_api_key $map["S2S_STT_API_KEY"] `
  --openai_stt_language zh `
  --llm_backend chat-completions `
  --responses_api_base_url $llmBase `
  --model_name $llmModel `
  --responses_api_api_key $map["S2S_LLM_API_KEY"] `
  --responses_api_stream `
  --tts openai `
  --openai_tts_base_url $ttsBase `
  --openai_tts_model $ttsModel `
  --openai_tts_api_key $map["S2S_TTS_API_KEY"] `
  --openai_tts_voice $map["S2S_TTS_VOICE"] `
  --thresh 0.6 --min_speech_ms 500 --min_silence_ms 1200 --speech_pad_ms 300
