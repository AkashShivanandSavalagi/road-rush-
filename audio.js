"use strict";
/* ROAD RUSH — audio.js: procedural music + SFX (zero files, zero licensed
   references) + voice policy layer. Consent BEFORE getUserMedia; independent
   mic/speaker toggles; push-to-talk default; per-player local mute. */

function vibrate(ms) { if (save.vibration && navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) {} } }

class MusicEngine {
  constructor() {
    this.enabled = true; this.ctx = null; this.master = null; this.filter = null;
    this.timer = null; this.step = 0; this.nextT = 0;
    this.bpm = 118; this.lookahead = 0.12; this.interval = 30;
    this.ext = null; this._noiseBuf = null;
  }
  probeExternal() {
    try {
      const a = new Audio(); a.src = "race-music.mp3"; a.loop = true; a.volume = 0.45; a.preload = "auto";
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
      this.master = this.ctx.createGain(); this.master.gain.value = 0.15;
      this.filter = this.ctx.createBiquadFilter(); this.filter.type = "lowpass"; this.filter.frequency.value = 2000;
      this.filter.connect(this.master); this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return true;
  }
  setTempo(bpm) { this.bpm = clamp(Math.round(bpm), 80, 200); }
  setFilter(hz) { if (this.filter && this.ctx) this.filter.frequency.setTargetAtTime(clamp(hz, 300, 4000), this.ctx.currentTime, 0.4); }
  _noise() {
    if (this._noiseBuf) return this._noiseBuf;
    const len = Math.floor(this.ctx.sampleRate * 0.3);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._noiseBuf = buf; return buf;
  }
  _osc(t, freq, dur, type, gain) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.filter); o.start(t); o.stop(t + dur + 0.02);
  }
  _kick(t) { const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = "sine"; o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.11);
    g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.14); }
  _snare(t) { const s = this.ctx.createBufferSource(); s.buffer = this._noise();
    const f = this.ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1800; f.Q.value = 0.8;
    const g = this.ctx.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    s.connect(f).connect(g).connect(this.master); s.start(t); s.stop(t + 0.1); }
  _hat(t, open) { const s = this.ctx.createBufferSource(); s.buffer = this._noise();
    const f = this.ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 7000;
    const g = this.ctx.createGain(); g.gain.setValueAtTime(0.22, t); g.gain.exponentialRampToValueAtTime(0.001, t + (open ? 0.08 : 0.03));
    s.connect(f).connect(g).connect(this.master); s.start(t); s.stop(t + 0.1); }
  _scheduleStep(step, t) {
    const s = step % 16, bar = Math.floor(step / 16) % 4;
    if (s % 4 === 0) this._kick(t);
    if (s === 4 || s === 12) this._snare(t);
    if (s % 2 === 1) this._hat(t, s === 15);
    const bassSeq = [41.2, 0, 41.2, 0, 49.0, 0, 41.2, 0, 55.0, 0, 41.2, 0, 61.7, 0, 58.3, 0];
    if (bassSeq[s]) this._osc(t, bassSeq[s], 0.2, "sawtooth", 0.45);
    if (bar === 1 || bar === 3) {
      const leadSeq = [329.6, 392, 493.9, 659.3, 493.9, 392, 329.6, 392, 329.6, 392, 493.9, 659.3, 587.3, 493.9, 392, 329.6];
      this._osc(t, leadSeq[s], 0.11, "square", 0.09);
    }
  }
  _tick() {
    const stepDur = 60 / this.bpm / 4;
    while (this.nextT < this.ctx.currentTime + this.lookahead) {
      this._scheduleStep(this.step, this.nextT);
      this.nextT += stepDur; this.step++;
    }
  }
  start() {
    if (!this.enabled) return;
    if (this.ext) { try { this.ext.currentTime = 0; this.ext.play().catch(() => {}); } catch (e) {} return; }
    if (!this._ensure() || this.timer) return;
    this.step = 0; this.nextT = this.ctx.currentTime + 0.05;
    this.timer = setInterval(() => this._tick(), this.interval);
  }
  stop() {
    if (this.ext) { try { this.ext.pause(); } catch (e) {} }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  setEnabled(on) { this.enabled = on; if (!on) this.stop(); }
}
/* spec §14: intensity scales with race progress and position */
function updateMusicIntensity(raceProgress, position, totalPlayers) {
  const tempo = 100 + clamp(raceProgress, 0, 1) * 40;
  const filterCutoff = 800 + (1 - clamp(position, 1, Math.max(1, totalPlayers)) / Math.max(1, totalPlayers)) * 2000;
  Game.music.setTempo(tempo);
  Game.music.setFilter(filterCutoff);
}

class Sfx {
  constructor() { this.enabled = true; this.ctx = null; this.engine = null; }
  _ensureCtx() {
    if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.enabled = false; return; } }
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  }
  play(name) {
    if (!this.enabled) return;
    this._ensureCtx();
    if (!this.ctx) return;
    const ctx = this.ctx;
    const specs = {
      click:{f:880,d:.06,type:"square",g:.12}, countdown:{f:520,d:.15,type:"square",g:.18},
      go:{f:1046,d:.25,type:"square",g:.22}, pickup:{f:1200,d:.12,type:"sine",g:.18},
      fuel:{f:700,d:.15,type:"sine",g:.18}, nitro:{f:300,d:.35,type:"sawtooth",g:.18},
      collision:{f:120,d:.2,type:"square",g:.22}, finish:{f:880,d:.5,type:"square",g:.22},
      coin:{f:1500,d:.08,type:"sine",g:.14}, jump:{f:620,d:.1,type:"triangle",g:.15},
      boost:{f:940,d:.18,type:"sawtooth",g:.16}, burn:{f:90,d:.3,type:"sawtooth",g:.2},
      land:{f:180,d:.09,type:"triangle",g:.14},
    };
    const s = specs[name];
    if (!s) return;
    try {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = s.type; osc.frequency.value = s.f;
      gain.gain.setValueAtTime(s.g, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + s.d);
      osc.connect(gain).connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + s.d);
    } catch (e) {}
  }
  engineStart() {
    if (this.engine || !this.enabled) return;
    this._ensureCtx();
    if (!this.ctx) return;
    try {
      const osc = this.ctx.createOscillator(), gain = this.ctx.createGain();
      osc.type = "sawtooth"; osc.frequency.value = 60; gain.gain.value = 0;
      osc.connect(gain).connect(ctx.destination); osc.start();
      this.engine = { osc, gain };
    } catch (e) { this.engine = null; }
  }
  engineUpdate(speed, accel, nitro) {
    if (!this.engine || !this.ctx) return;
    const vol = this.enabled ? (accel ? 0.05 : 0.02) * (nitro ? 1.7 : 1) : 0;
    this.engine.gain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.1);
    this.engine.osc.frequency.setTargetAtTime(55 + Math.abs(speed) * 0.22 + (nitro ? 70 : 0), this.ctx.currentTime, 0.08);
  }
  engineStop() { if (this.engine) { try { this.engine.osc.stop(); } catch (e) {} this.engine = null; } }
}

/* VoiceChat — consent FIRST, then getUserMedia. Mesh between voice-enabled
   players only; practical ceiling ~6 speakers (warned, never silently degraded).
   Sustained-volume heuristic FEEDS a vote prompt — never auto-mutes alone. */
class VoiceChat {
  constructor(net) {
    this.net = net; this.on = false; this.speaker = true;
    this.micStream = null; this.calls = new Map();
    this.localMutes = new Set(); this.ptt = false;
    this._rms = new Map();
  }
  async requestEnable() {
    const go = await rrModal({ title: "ENABLE VOICE?",
      body: "Road Rush doesn't record or store audio. Voice connects you directly to your room. Please be respectful with your race partners. Mute or disable the speaker anytime.",
      confirm: "ENABLE MIC" });
    if (!go) return false;
    try { this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { setStatus("lobbyStatus", "Microphone unavailable or denied.", "err"); return false; }
    this.micStream.getAudioTracks().forEach(t => t.enabled = false);   // PTT default
    this.on = true;
    this.net.setMyVoice(true);
    this.connectToPeers();
    return true;
  }
  connectToPeers() {
    if (!this.on || !this.micStream || !this.net.peer) return;
    for (const p of this.net._playerListArr()) {
      if (p.sid === this.net.mySid || !p.voice || !p.peerId || this.calls.has(p.peerId)) continue;
      if (this.calls.size >= 6) { setStatus("lobbyStatus", "Voice is practical up to ~6 participants — some peers won't be connected.", "err"); break; }
      this.dial(p.peerId, p.sid);
    }
  }
  dial(peerId, sid) {
    try { const call = this.net.peer.call(peerId, this.micStream); this.calls.set(peerId, { call, sid, audio: null }); }
    catch (e) {}
  }
  handleIncoming(call) {
    if (!this.on) { try { call.close(); } catch (e) {} return; }
    call.answer(this.micStream || undefined);
    call.on("stream", (remote) => this.attach(call.peer, remote));
    this.calls.set(call.peer, { call, sid: null, audio: null });
  }
  attach(peerId, remote) {
    const entry = this.calls.get(peerId) || { call: null, sid: null, audio: null };
    const audio = new Audio(); audio.autoplay = true; audio.srcObject = remote;
    audio.muted = !this.speaker || (entry.sid && this.localMutes.has(entry.sid));
    document.body.appendChild(audio);
    entry.audio = audio; this.calls.set(peerId, entry);
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const src = ac.createMediaStreamSource(remote);
      const an = ac.createAnalyser(); an.fftSize = 256; src.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      const sid = entry.sid;
      const probe = setInterval(() => {
        if (!this.calls.has(peerId)) { clearInterval(probe); try { ac.close(); } catch (e) {} return; }
        an.getByteFrequencyData(buf);
        let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i];
        const r = (this._rms.get(sid) || { loud: 0 });
        r.loud = sum / buf.length > 150 ? r.loud + 1 : 0;
        this._rms.set(sid, r);
        if (r.loud > 200 && sid && !this.localMutes.has(sid)) { r.loud = 0; this._promptVote(sid); }
      }, 100);
    } catch (e) {}
  }
  async _promptVote(sid) {
    const go = await rrModal({ title: "LOUD PLAYER?", body: "This player has been extremely loud for a while. Report them for a room vote to mute? (A volume heuristic alone never mutes anyone.)", confirm: "REPORT" });
    if (go && this.net) this.net.sendVoteMute(sid);
  }
  setPTT(down) { this.ptt = down; if (this.micStream) this.micStream.getAudioTracks().forEach(t => t.enabled = down); }
  toggleSpeaker() {
    this.speaker = !this.speaker;
    this.calls.forEach(c => { if (c.audio) c.audio.muted = !this.speaker || (c.sid && this.localMutes.has(c.sid)); });
  }
  mutePlayer(sid) {
    this.localMutes.has(sid) ? this.localMutes.delete(sid) : this.localMutes.add(sid);
    this.calls.forEach(c => { if (c.sid === sid && c.audio) c.audio.muted = this.localMutes.has(sid); });
  }
  disable() {
    this.on = false;
    this.calls.forEach(c => { try { if (c.call) c.call.close(); if (c.audio) c.audio.remove(); } catch (e) {} });
    this.calls.clear();
    if (this.micStream) { this.micStream.getTracks().forEach(t => t.stop()); this.micStream = null; }
    if (this.net) this.net.setMyVoice(false);
  }
}
