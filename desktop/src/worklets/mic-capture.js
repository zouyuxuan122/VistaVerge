// mic-capture.js — AudioWorklet：累积 40ms 帧、计算 RMS、以 Float32Array 发给主线程。
// 主线程负责噪声门 / VAD 断句（手感参数与原 start-voice.sh 一致）。
const CHUNK_SAMPLES = 640; // 40ms @ 16kHz

class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(CHUNK_SAMPLES);
    this._fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._fill++] = ch[i];
      if (this._fill === CHUNK_SAMPLES) {
        let sum = 0;
        for (let j = 0; j < CHUNK_SAMPLES; j++) {
          const s = this._buf[j];
          sum += s * s;
        }
        const rms = Math.sqrt(sum / CHUNK_SAMPLES);
        const out = this._buf.slice(0);
        this.port.postMessage({ pcm: out, rms }, [out.buffer]);
        this._buf = new Float32Array(CHUNK_SAMPLES);
        this._fill = 0;
      }
    }
    return true;
  }
}

registerProcessor("mic-capture", MicCapture);
