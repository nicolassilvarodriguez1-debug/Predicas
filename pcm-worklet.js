// AudioWorklet: toma el audio del micrófono (cualquier frecuencia y número de
// canales), lo mezcla a mono, lo baja a 16 kHz y lo entrega en bloques PCM16
// de 250 ms para mandarlo a ElevenLabs Scribe Realtime. También reporta el
// nivel de volumen para el medidor.
class Pcm16kProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.sum = 0;
    this.cnt = 0;
    this.out = new Int16Array(4000);
    this.n = 0;
    this.sq = 0;
    this.sqCount = 0;
    this.blocks = 0;
  }

  process(inputs) {
    const chans = inputs[0];
    if (!chans || !chans.length || !chans[0]) return true;
    const len = chans[0].length;
    const nc = chans.length;

    for (let i = 0; i < len; i++) {
      let v = 0;
      for (let c = 0; c < nc; c++) v += chans[c][i];
      v /= nc;
      this.sq += v * v;
      this.sqCount++;

      this.sum += v;
      this.cnt++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        let s = this.sum / this.cnt;
        this.sum = 0;
        this.cnt = 0;
        if (s > 1) s = 1; else if (s < -1) s = -1;
        this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === this.out.length) {
          const copy = this.out.slice(0);
          this.port.postMessage({ type: 'pcm', buf: copy.buffer }, [copy.buffer]);
          this.n = 0;
        }
      }
    }

    if (++this.blocks % 8 === 0) {
      this.port.postMessage({ type: 'level', rms: Math.sqrt(this.sq / Math.max(1, this.sqCount)) });
      this.sq = 0;
      this.sqCount = 0;
    }
    return true;
  }
}

registerProcessor('pcm16k', Pcm16kProcessor);
