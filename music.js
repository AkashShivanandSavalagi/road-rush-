"use strict";
/* ROAD RUSH — music engine.
   Original synthesized racing loop (WebAudio): drums + bass + arpeggio lead at 144 BPM.
   100% original — no copyrighted audio.
   OPTIONAL: put your own royalty-free file named "race-music.mp3" next to index.html
   and it will be used automatically instead of the synth loop. */

class MusicEngine {
  constructor() {
    this.enabled = true;
    this.ctx = null; this.master = null;
    this.timer = null; this.step = 0; this.nextT = 0;
    this.bpm = 144; this.lookahead = 0.12; this.interval = 30;
    this.ext = null; this._noiseBuf = null;
  }

  // Probe for an external music file once at page load.
  probeExternal() {
    try {
      const a = new Audio();
      a.src = "race-music.mp3"; a.loop = true; a.volume = 0.45; a.preload = "auto";
      let done = false;
      new Promise(res => {
        a.addEventListener("canplaythrough", () => { if (!done) { done = true; res(true); } });
        a.addEventListener("error", () => { if (!done) { done = true; res(false); } });
        setTimeout(() => { if (!done) { done = true; res(false); } }, 1500);
      }).then(ok => { this.ext = ok ? a : null; });
    } catch (e) { this.ext = null; }
  }

  _ensure() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { return false; }
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.15;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return true;
  }

  _noise() {
    if (this._noiseBuf) return this._noiseBuf;
    const len = Math.floor(this.ctx.sampleRate * 0.3);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._noiseBuf = buf;
    return buf;
  }

  _kick(t) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.11);
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.14);
  }

  _snare(t) {
    const src = this.ctx.createBufferSource(); src.buffer = this._noise();
    const f = this.ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1800; f.Q.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    src.connect(f).connect(g).connect(this.master); src.start(t); src.stop(t + 0.1);
  }

  _hat(t, open) {
    const src = this.ctx.createBufferSource(); src.buffer = this._noise();
    const f = this.ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 7000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + (open ? 0.08 : 0.03));
    src.connect(f).connect(g).connect(this.master); src.start(t); src.stop(t + 0.1);
  }

  _bass(t, freq) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain(), f = this.ctx.createBiquadFilter();
    o.type = "sawtooth"; o.frequency.value = freq;
    f.type = "lowpass"; f.frequency.value = 420;
    g.gain.setValueAtTime(0.45, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.connect(f).connect(g).connect(this.master); o.start(t); o.stop(t + 0.22);
  }

  _lead(t, freq) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = "square"; o.frequency.value = freq;
    g.gain.setValueAtTime(0.09, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.12);
  }

  // One bar = 16 sixteenth-steps. 4-bar loop: bass throughout, lead on bars 2 & 4.
  _scheduleStep(step, t) {
    const s = step % 16;
    const bar = Math.floor(step / 16) % 4;
    if (s % 4 === 0) this._kick(t);
    if (s === 4 || s === 12) this._snare(t);
    if (s % 2 === 1) this._hat(t, s === 15);
    // E-minor bass groove (E1 G1 A1 B1 Bb1)
    const bassSeq = [41.2, 0, 41.2, 0, 49.0, 0, 41.2, 0, 55.0, 0, 41.2, 0, 61.7, 0, 58.3, 0];
    if (bassSeq[s]) this._bass(t, bassSeq[s]);
    if (bar === 1 || bar === 3) {
      const leadSeq = [329.6, 392, 493.9, 659.3, 493.9, 392, 329.6, 392,
                       329.6, 392, 493.9, 659.3, 587.3, 493.9, 392, 329.6];
      this._lead(t, leadSeq[s]);
    }
  }

  _tick() {
    const stepDur = 60 / this.bpm / 4; // 16th note
    while (this.nextT < this.ctx.currentTime + this.lookahead) {
      this._scheduleStep(this.step, this.nextT);
      this.nextT += stepDur;
      this.step++;
    }
  }

  start() {
    if (!this.enabled) return;
    if (this.ext) { try { this.ext.currentTime = 0; this.ext.play().catch(() => {}); } catch (e) {} return; }
    if (!this._ensure()) return;
    if (this.timer) return; // already playing
    this.step = 0;
    this.nextT = this.ctx.currentTime + 0.05;
    this.timer = setInterval(() => this._tick(), this.interval);
  }

  stop() {
    if (this.ext) { try { this.ext.pause(); } catch (e) {} }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.stop();
  }
}
