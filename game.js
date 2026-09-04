"use strict";
/* =====================================================================================
   ROAD RUSH — web edition, host-authoritative multiplayer build.
   Multiplayer model (honest description):
   - Transport: WebRTC data channels via PeerJS, star topology through the host.
   - Authority: the HOST's browser is the referee — room membership, passwords,
     kicks, chat moderation, race start ("GO"), pickup allocation, standings and
     finish validation all happen host-side. This is host-authoritative, NOT
     server-authoritative: the host is a single point of failure and a malicious
     host can cheat. A true authoritative server (Node+Colyseus) requires hosting
     that GitHub Pages cannot provide — see README "Phase B".
   - Identity: every client generates a random 12-hex session id (sid). The host
     roster is keyed by sid, so a dropped/reloaded player reconnects with the same
     identity within a 30 s grace window.
===================================================================================== */

/* ------------------------------ configuration ------------------------------ */
const CONFIG = {
  MAX_PLAYERS: 4,          // competitive racers per room (raise if desired; star topology stays fine to ~8)
  CODE_LEN: 6,             // 6-character room code
  NET_SEND_HZ: 15,         // own-state broadcast rate
  RACE_TIMEOUT: 240,       // hard race time limit (s)
  CHAT_MAX_LEN: 200,
  CHAT_COOLDOWN_MS: 1500,  // per player
  EMOTE_COOLDOWN_MS: 2000, // per player
  PASS_ATTEMPTS: 5,        // password guesses per connection
  RECONNECT_GRACE: 30,     // seconds a disconnected player keeps their slot
  RECONNECT_ATTEMPTS: 15,  // guest retry cycles (2 s apart)
  STRIKES_KICK: 3,         // RoadGuard: suspicious packets before removal
};
const FEEDBACK_EMAIL = "you@example.com"; // ← put your real email here for the feedback page

const FINISH_DISTANCE = 24000;   // world units (1 unit = 0.1 m → 2400 m)
const UNIT_TO_M = 0.1;
const GRAVITY_BASE = 1800;
const GROUND_FRICTION = 0.985;
const START_X = 120;
const JUMP_HEIGHT = 90;
const JUMP_COOLDOWN = 1.2;

/* STUN + TURN: TURN relays traffic when direct P2P is blocked (carrier NATs). */
const PEER_OPTS = {
  debug: 0,
  config: {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
      { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
      { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
      { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
    ],
    iceCandidatePoolSize: 8,
  },
};

/* ------------------------------ generic helpers ------------------------------ */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function fmtTime(t) { const m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ":" + (s < 10 ? "0" : "") + s; }
function fmtPlace(n) { return n + (n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"); }
function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(1) + "km" : Math.floor(m) + "m"; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function hash01(n) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const $ = id => document.getElementById(id);
function nowMs() { return performance.now(); }
function randomHex(n) {
  const c = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * 16)];
  return s;
}

/* ------------------------------ pure, unit-testable rules (tested by tests.html) ------------------------------ */

/* Username rules: strip control chars, trim, collapse inner whitespace, 2–16 chars. */
function validateName(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "Name required." };
  const name = raw.replace(/[\u0000-\u001F\u007F]/g, "").trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, reason: "Name required." };
  if (name.length < 2) return { ok: false, reason: "At least 2 characters." };
  if (name.length > 16) return { ok: false, reason: "Maximum 16 characters." };
  return { ok: true, name };
}

/* Room code: 6 chars from an unambiguous set (no O/0, I/1, S/5). */
const CODE_CHARS = "ABCDEFGHJKMNPQRTUVWXYZ2346789";
function makeRoomCode(rng) {
  const r = rng || Math.random;
  let s = "";
  for (let i = 0; i < CONFIG.CODE_LEN; i++) s += CODE_CHARS[Math.floor(r() * CODE_CHARS.length)];
  return s;
}

/* Sliding-interval rate limiter (host-side moderation + tests). */
class RateLimiter {
  constructor(minIntervalMs) { this.min = minIntervalMs; this.last = -Infinity; }
  allow(now) {
    const t = (now == null) ? nowMs() : now;
    if (t - this.last < this.min) return false;
    this.last = t; return true;
  }
}

/* Game-rule pure helpers. */
function fillFuel(cur, cap) { return cap; }                 // fuel pickup refills to FULL
function addNitro(cur, max) { return Math.min(max, cur + 1); }
function validFinishMsg(elapsed, t, dist, finishDist) {      // RoadGuard finish plausibility
  return typeof t === "number" && t >= 0 && t <= elapsed + 2 &&
         typeof dist === "number" && dist >= finishDist - 400;
}
function deltaOk(maxSpeed, dtSec, delta, slack) {            // RoadGuard speed bound
  return delta <= maxSpeed * 2.2 * dtSec + (slack == null ? 120 : slack);
}
const PLACE_BONUS = { 1: 1000, 2: 700, 3: 400 };
function computeScore(distanceM, coins, place, fuelRemaining) {
  let s = distanceM * 10 + coins * 10 + fuelRemaining * 2;
  if (PLACE_BONUS[place]) s += PLACE_BONUS[place];
  else if (place && place > 3) s += Math.max(0, 200 - (place - 4) * 20);
  return Math.round(s);
}

/* ------------------------------ maps & vehicles ------------------------------ */
const MAPS = {
  Highway: { label:"Highway", base:380, amp:22, freq:1.0, smooth:0.2, gravity:1.0, traction:1.0,
    obstacleDensity:0.55, fuelMult:1.0, sky:["#78aae6","#c8e1f5"], ground:"#3c4146", accent:"#e6d23c",
    far:null, dust:"#9a9aa0", desc:"Smooth asphalt, moving traffic." },
  Hills:   { label:"Hills", base:350, amp:85, freq:1.4, smooth:0.55, gravity:1.0, traction:0.95,
    obstacleDensity:0.5, fuelMult:1.0, sky:["#78be8c","#d2ebbe"], ground:"#507838", accent:"#785028",
    far:"#3c5c2c", dust:"#b8c9a0", desc:"Rolling green slopes and jumps." },
  Moon:    { label:"Moon", base:380, amp:50, freq:0.8, smooth:0.4, gravity:0.35, traction:0.9,
    obstacleDensity:0.45, fuelMult:1.0, sky:["#08081a","#191428"], ground:"#96969b", accent:"#5a5a5f",
    far:"#141020", dust:"#c8c8d2", desc:"Low gravity — huge jumps." },
  Desert:  { label:"Desert", base:370, amp:55, freq:1.1, smooth:0.35, gravity:1.0, traction:0.92,
    obstacleDensity:0.5, fuelMult:1.35, sky:["#fabe6e","#ffe1aa"], ground:"#c8a564", accent:"#a8824c",
    far:"#b08a52", dust:"#e2cba0", desc:"Dunes and cacti — thirsty engines." },
  Snow:    { label:"Snow", base:370, amp:65, freq:1.2, smooth:0.45, gravity:1.0, traction:0.55,
    obstacleDensity:0.45, fuelMult:1.0, sky:["#c8d7eb","#ebf0f5"], ground:"#ebf0f5", accent:"#7896c8",
    far:"#aebfd4", dust:"#ffffff", desc:"Ice — low traction, lots of sliding." },
};
const MAP_ORDER = ["Highway", "Hills", "Moon", "Desert", "Snow"];

const VEHICLES = {
  Car:  { accel:620, maxSpeed:520, brake:780, mass:1.0, stability:0.8, fuelCap:100, fuelUse:4.2,
          color:"#d43c3c", w:62, h:26, drop:6, desc:"Balanced all-rounder.",
          stats:"Accel ●●●  Speed ●●●  Grip ●●●  Tank ●●●" },
  Bike: { accel:820, maxSpeed:640, brake:700, mass:0.6, stability:0.45, fuelCap:80, fuelUse:3.4,
          color:"#3c82d2", w:48, h:22, drop:4, desc:"Fast, but flips easily.",
          stats:"Accel ●●●●  Speed ●●●●  Grip ●  Tank ●●" },
  Bus:  { accel:460, maxSpeed:410, brake:650, mass:1.6, stability:1.0, fuelCap:140, fuelUse:4.8,
          color:"#e6be3c", w:84, h:34, drop:7, desc:"Slow, heavy, very stable.",
          stats:"Accel ●  Speed ●●  Grip ●●●●  Tank ●●●●" },
};

/* ------------------------------ save ------------------------------ */
const SAVE_KEY = "roadrush_save_v3";
const save = {
  name: "", vehicle: "Car", map: "Highway",
  sound: true, music: true, pedals: false,
  quality: "auto", vibration: true, reducedMotion: false, firstRun: true,
  best: 0, coins: 0,
};
function loadSave() {
  try {
    const obj = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (!obj || typeof obj !== "object") return;
    if (typeof obj.name === "string") save.name = obj.name.slice(0, 16);
    if (VEHICLES[obj.vehicle]) save.vehicle = obj.vehicle;
    if (MAPS[obj.map]) save.map = obj.map;
    ["sound", "music", "pedals", "vibration", "reducedMotion", "firstRun"].forEach(k => {
      if (typeof obj[k] === "boolean") save[k] = obj[k];
    });
    if (["auto", "low", "medium", "high"].includes(obj.quality)) save.quality = obj.quality;
    if (typeof obj.best === "number" && isFinite(obj.best)) save.best = Math.max(0, Math.floor(obj.best));
    if (typeof obj.coins === "number" && isFinite(obj.coins)) save.coins = Math.max(0, Math.floor(obj.coins));
  } catch (e) {}
}
function persist() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) {} }

/* session identity (survives page reload within the tab, per room) */
function sidFor(code) {
  try {
    let sid = sessionStorage.getItem("rr_sid_" + code);
    if (!sid) { sid = randomHex(12); sessionStorage.setItem("rr_sid_" + code, sid); }
    return sid;
  } catch (e) { return randomHex(12); }
}

/* ------------------------------ terrain + world ------------------------------ */
class Terrain {
  constructor(mapDef, seed) {
    this.def = mapDef;
    const rng = mulberry32(seed >>> 0);
    this.phases = [rng() * 6.283, rng() * 6.283, rng() * 6.283, rng() * 6.283];
  }
  heightAt(x) {
    const { base, amp, freq, smooth } = this.def;
    let h = 0;
    h += Math.sin(x * freq * 0.001 + this.phases[0]) * amp;
    h += Math.sin(x * freq * 0.0025 + this.phases[1]) * (amp * 0.5) * smooth;
    h += Math.sin(x * freq * 0.0006 + this.phases[2]) * (amp * 1.3) * (1 - smooth * 0.4);
    h += Math.sin(x * freq * 0.006 + this.phases[3]) * (amp * 0.15);
    if (x < 300) h *= x / 300;
    return base + h;
  }
  slopeAt(x) { return (this.heightAt(x + 2) - this.heightAt(x - 2)) / 4; }
}

/* Pickups get stable ids so the host can validate claims atomically. */
function generateWorldObjects(terrain, seed, length) {
  const rng = mulberry32((seed ^ 0xC0FFEE) >>> 0);
  const pickups = [], obstacles = [];
  let pid = 0;
  const addPk = (x, kind) => pickups.push({ id: pid++, x, kind, taken: false, bob: rng() * 6.28 });
  for (let fx = 900; fx < length - 400; fx += 3500) addPk(fx, "fuel"); // guaranteed fuel ~every 350 m
  let x = 600;
  while (x < length - 400) {
    x += 150 + rng() * 130;
    const roll = rng();
    if (roll < 0.17) addPk(x, "fuel");
    else if (roll < 0.30) addPk(x, "nitro");
    else if (roll < 0.58) addPk(x, "coin");
  }
  const kindMap = { Highway: "traffic", Hills: "log", Moon: "crater", Desert: "cactus", Snow: "ice" };
  const kind = kindMap[terrain.def.label] || "rock";
  const dens = terrain.def.obstacleDensity;
  x = 900;
  while (x < length - 500) {
    x += (520 + rng() * 420) / (0.4 + dens * 0.8);
    if (rng() < 0.55 + dens * 0.4) {
      const w = kind === "traffic" ? 48 : (kind === "crater" ? 30 + rng() * 8 : 28 + rng() * 8);
      const h = kind === "traffic" ? 26 : (kind === "crater" ? 22 : 24 + rng() * 8);
      obstacles.push({ x, x0: x, kind, w, h, v: kind === "traffic" ? -(70 + rng() * 50) : 0, cd: 0 });
    }
  }
  return { pickups, obstacles };
}

/* ------------------------------ particles (quality-aware) ------------------------------ */
class ParticleSystem {
  constructor() { this.list = []; }
  cap() {
    if (save.quality === "low") return 60;
    if (save.quality === "medium") return 150;
    if (save.quality === "high") return 350;
    return isTouch ? 150 : 350; // auto
  }
  emit(x, y, n, color, opts = {}) {
    if (this.list.length > this.cap()) n = Math.min(n, 2);
    const speed = opts.speed || 140, spread = opts.spread || 100, life = opts.life || 0.5,
          size = opts.size || 3, gravity = opts.gravity != null ? opts.gravity : 800;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * 6.283, spd = speed * (0.3 + Math.random() * 0.7);
      this.list.push({ x, y, vx: Math.cos(ang) * spd * (spread / 120), vy: Math.sin(ang) * spd - 60,
        life: life * (0.6 + Math.random() * 0.6), maxLife: life, color, size, gravity });
    }
  }
  update(dt) {
    this.list = this.list.filter(p => {
      p.vy += p.gravity * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      return p.life > 0;
    });
  }
  draw(ctx, camX, camY) {
    for (const p of this.list) {
      const a = clamp(p.life / p.maxLife, 0, 1);
      ctx.globalAlpha = a; ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x - camX, p.y - camY, Math.max(1, p.size * a), 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

/* ------------------------------ SFX ------------------------------ */
class Sfx {
  constructor() { this.enabled = true; this.ctx = null; this.engine = null; }
  _ensureCtx() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { this.enabled = false; return; }
    }
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
      osc.connect(gain).connect(this.ctx.destination);
      osc.start();
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
function vibrate(ms) { if (save.vibration && navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) {} } }

/* ------------------------------ vehicle physics ------------------------------ */
class RacePlayer {
  constructor(vehicleName, terrain, opts = {}) {
    const v = VEHICLES[vehicleName];
    this.vehicleName = vehicleName;
    this.accelPower = v.accel; this.maxSpeed = v.maxSpeed; this.brakePower = v.brake;
    this.mass = v.mass; this.stability = v.stability;
    this.fuelCap = v.fuelCap; this.fuelUse = v.fuelUse;
    this.color = v.color; this.w = v.w; this.h = v.h; this.wheelDrop = v.drop;
    this.fuelMult = opts.fuelMult || 1;
    this.terrain = terrain;
    this.id = opts.id || "local";
    this.sid = opts.sid || null;      // network identity
    this.name = opts.name || "Player";
    this.isRemote = !!opts.isRemote;
    this.isBot = !!opts.isBot;
    this.x = START_X;
    this.y = terrain.heightAt(this.x) - this.h / 2 - this.wheelDrop;
    this.vx = 0; this.vy = 0;
    this.angle = 0; this.angVel = 0;
    this.onGround = true; this.airtime = 0; this.jumpCd = 0;
    this.fuel = this.fuelCap;
    this.nitroCharges = 0; this.maxNitro = 3; this.nitroTimer = 0;
    this.coins = 0; this.distance = 0;
    this.finished = false; this.finishTime = null;
    this.stunned = 0; this.shake = 0; this._dustCd = 0;
  }

  useNitro(particles, sfx) {
    if (this.nitroCharges > 0 && this.nitroTimer <= 0) {
      this.nitroCharges -= 1;
      this.nitroTimer = 2.0;
      if (sfx) sfx.play("nitro");
      particles.emit(this.x - this.w * 0.5, this.y, 12, "#ffb050",
        { spread: 60, speed: 200, life: 0.4, size: 4, gravity: 200 });
      return true;
    }
    return false;
  }

  update(dt, input, particles, sfx, raceStarted) {
    const t = this.terrain;
    const gravity = GRAVITY_BASE * t.def.gravity;

    if (this.stunned > 0) {
      this.stunned -= dt;
      input = { accel: false, brake: false, left: false, right: false, nitro: false, jump: false };
    }
    let { accel, brake, left, right, nitro, jump } = input;
    if (!raceStarted) { accel = brake = left = right = nitro = jump = false; }
    if (this.jumpCd > 0) this.jumpCd -= dt;

    if (nitro && raceStarted) this.useNitro(particles, sfx);
    if (this.nitroTimer > 0) this.nitroTimer -= dt;
    const nitroBoost = this.nitroTimer > 0 ? 1.55 : 1.0;

    /* JUMP: vy = sqrt(2·g·h) ⇒ identical hop height on every map (Moon just
       gets a slower launch). Cooldown prevents mid-air spam. */
    if (jump && raceStarted && this.onGround && this.stunned <= 0 && this.jumpCd <= 0) {
      this.vy = -Math.sqrt(2 * gravity * JUMP_HEIGHT);
      this.onGround = false;
      this.jumpCd = JUMP_COOLDOWN;
      if (sfx) sfx.play("jump");
      particles.emit(this.x, this.y + this.h / 2, 8, t.def.dust,
        { spread: 70, speed: 110, life: 0.35, size: 2, gravity: 500 });
    }

    const outOfFuel = this.fuel <= 0;
    const powerMult = outOfFuel ? 0.15 : 1.0;
    const groundY = t.heightAt(this.x);
    const slope = t.slopeAt(this.x);
    const slopeDeg = Math.atan(slope) * 180 / Math.PI;

    if (this.onGround) {
      if (accel) {
        this.vx += this.accelPower * powerMult * nitroBoost * dt;
        if (this.fuel > 0) this.fuel -= this.fuelUse * this.fuelMult * dt * (1 + Math.abs(slope) * 0.5);
      }
      if (brake) {
        if (this.vx > 5) this.vx -= this.brakePower * dt;
        else this.vx -= this.accelPower * 0.5 * dt;
      }
      const frameF = GROUND_FRICTION + (1 - GROUND_FRICTION) * (1 - t.def.traction);
      this.vx *= Math.pow(frameF, dt * 60);
      this.vx -= slope * gravity * dt * 0.5;
    } else {
      this.airtime += dt;
      this.vx *= Math.pow(0.999, dt * 60);
    }
    this.vx = clamp(this.vx, -this.maxSpeed * 0.4, this.maxSpeed * nitroBoost);

    if (!this.onGround) {
      const turnRate = 240;
      if (left) this.angVel -= turnRate * dt;
      if (right) this.angVel += turnRate * dt;
      this.angVel *= Math.pow(0.98, dt * 60);
      this.angle += this.angVel * dt;
    } else {
      this.angle = lerp(this.angle, slopeDeg, clamp(12 * dt, 0, 1));
      this.angVel = 0;
    }

    if (this.onGround) { this.vy = 0; this.y = groundY - this.h / 2 - this.wheelDrop; }
    else { this.vy += gravity * dt; this.y += this.vy * dt; }

    this.x += this.vx * dt;
    if (this.x < 60) { this.x = 60; if (this.vx < 0) this.vx = 0; }
    this.distance = Math.max(this.distance, this.x - START_X);

    const gy = t.heightAt(this.x) - this.h / 2 - this.wheelDrop;
    if (this.y >= gy) {
      const wasAirborne = !this.onGround;
      this.y = gy;
      if (wasAirborne) {
        const impact = Math.abs(this.vy);
        this.vy = 0;
        const angleOff = Math.abs(this.angle - slopeDeg);
        const crashChance = (impact / 1400) * (angleOff / 45) * (1.2 - this.stability);
        if ((crashChance > 0.55 && this.airtime > 0.25) || angleOff > 110) this._crash(particles, sfx);
        else particles.emit(this.x, this.y + this.h / 2, 5, t.def.dust,
          { spread: 60, speed: 90, life: 0.3, size: 2, gravity: 500 });
      }
      this.onGround = true; this.airtime = 0;
    } else this.onGround = false;
    this.angle = ((this.angle + 180) % 360 + 360) % 360 - 180;

    if (this.onGround && accel && !outOfFuel && Math.abs(this.vx) > 80) {
      this._dustCd -= dt;
      if (this._dustCd <= 0) {
        this._dustCd = 0.07;
        particles.emit(this.x - this.w * 0.4, this.y + this.h * 0.4, 2, t.def.dust,
          { spread: 40, speed: 70, life: 0.35, size: 2, gravity: 400 });
      }
    }
  }

  _crash(particles, sfx) {
    if (sfx) sfx.play("collision");
    vibrate(40);
    particles.emit(this.x, this.y, 14, "#ff8c28", { spread: 140, speed: 180, life: 0.5, size: 3, gravity: 700 });
    this.vx *= 0.35; this.stunned = 0.5; this.shake = 1;
    this.angle = clamp(this.angle, -35, 35);
  }
  rect() { return { x: this.x - this.w / 2, y: this.y - this.h / 2, w: this.w, h: this.h }; }
}
function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/* =====================================================================================
   NETWORKING — host-authoritative star topology.
   Identity: sid (session id) generated by each client, roster keyed by it.
   Authority held by the host: join gate (lock/password/name/full/dup session),
   chat/emote moderation, pickup allocation ("pk" claims), speed-bound validation
   (RoadGuard strikes), finish validation, race start ("go"), standings broadcast.
===================================================================================== */
class NetManager {
  constructor() {
    this.peer = null; this.isHost = false; this.roomCode = null;
    this.mySid = null; this.myName = "Player"; this.hostPeerId = null;
    this.conns = new Map();      // peerId -> {conn, sid}
    this.hostConn = null;
    this.players = new Map();    // sid -> {sid, peerId, name, vehicle, isHost, ping, disconnectedAt}
    this.selectedMap = "Highway";
    this.password = "";          // host only, never transmitted except comparison at join
    this.locked = false;
    this.raceRoster = []; this.finishList = []; this.lastStates = new Map(); // sid -> state
    this._lastD = new Map(); this._lastDT = new Map();  // RoadGuard speed tracking
    this.strikes = new Map();    // sid -> {n, lastT}
    this._chatL = new Map(); this._emoteL = new Map(); this._passN = new Map();
    this._joinSettle = null; this._pingTimer = null; this._guestPing = null;
    this._destroyed = false; this._reconn = null; this._kicked = false;
    this._graceTimers = new Map();
    this.rtt = 0; this.connState = "offline";
    // callbacks (assigned by the Game)
    this.onPlayersChanged = null; this.onMapChanged = null; this.onRaceStart = null;
    this.onGo = null; this.onWorldUpdate = null; this.onLeaderboard = null;
    this.onError = null; this.onHostLeft = null; this.onReturnToLobby = null;
    this.onKicked = null; this.onChat = null; this.onEmote = null;
    this.onRoomCfg = null; this.onPositions = null; this.onPickup = null;
    this.onConnState = null;
    this._onGuestFinish = null;
  }

  _setConnState(s) {
    if (this.connState !== s) { this.connState = s; if (this.onConnState) this.onConnState(s); }
  }

  createRoom(name, pass) {
    return new Promise((resolve, reject) => {
      if (!window.Peer) { reject(new Error("no-peerjs")); return; }
      const v = validateName(name);
      if (!v.ok) { reject(new Error("badname:" + v.reason)); return; }
      this.myName = v.name;
      this.password = (pass || "").toString().slice(0, 24);
      this.isHost = true;
      this.mySid = randomHex(12);
      this._setConnState("connecting");
      this._createWithRetry(0, resolve, reject);
    });
  }

  _createWithRetry(attempt, resolve, reject) {
    const code = makeRoomCode();
    let settled = false;
    try { this.peer = new Peer("roadrush-" + code, PEER_OPTS); }
    catch (e) { reject(e); return; }
    this.peer.on("error", (err) => {
      if (settled || this._destroyed) return;
      const type = err && err.type;
      if ((type === "unavailable-id" || type === "network") && attempt < 4) {
        settled = true;
        try { this.peer.destroy(); } catch (e2) {}
        setTimeout(() => this._createWithRetry(attempt + 1, resolve, reject), 500 + attempt * 600);
        return;
      }
      settled = true; reject(err);
    });
    this.peer.on("open", (id) => {
      if (settled || this._destroyed) return;
      settled = true;
      this.roomCode = code; this.hostPeerId = id;
      this.players.set(this.mySid, {
        sid: this.mySid, peerId: id, name: this.myName, vehicle: save.vehicle,
        isHost: true, ping: 0,
      });
      this._setConnState("connected");
      this._startPingLoop();
      resolve(code);
    });
    this.peer.on("connection", (conn) => this._handleIncoming(conn));
    this.peer.on("disconnected", () => {
      if (this._destroyed) return;
      try { this.peer.reconnect(); } catch (e) {}
      this._setConnState("reconnecting");
      if (this.onError) this.onError("Reconnecting to the signaling service…");
    });
  }

  /* host: heartbeat to guests (lobby ping display) */
  _startPingLoop() {
    this._stopPingLoop();
    this._pingTimer = setInterval(() => {
      if (this._destroyed || !this.isHost) return;
      for (const { conn, sid} of this.conns.values()) {
        const p = this.players.get(sid);
        if (conn.open && p && p.disconnectedAt == null) {
          try { conn.send({ t: "ping", ts: nowMs() }); } catch (e) {}
        }
      }
    }, 3000);
  }
  _stopPingLoop() { if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; } }

  _handleIncoming(conn) {
    conn.on("open", () => {
      conn.on("data", (data) => this._handleGuestMessage(conn, data));
    });
    conn.on("close", () => this._peerDropped(conn));
    conn.on("error", () => this._peerDropped(conn));
  }

  /* host: connection lost → grace window, not instant removal */
  _peerDropped(conn) {
    const entry = this.conns.get(conn.peer);
    if (!entry) return;
    this.conns.delete(conn.peer);
    const p = this.players.get(entry.sid);
    if (!p || p.disconnectedAt != null) return;
    p.disconnectedAt = nowMs();
    p.ping = null;
    this._emitPlayers();
    this._sys(p.name + " disconnected — reconnecting…");
    const sid = entry.sid;
    const to = setTimeout(() => {
      this._graceTimers.delete(sid);
      const pl = this.players.get(sid);
      if (pl && pl.disconnectedAt != null) this._removePlayer(sid, "left after grace");
    }, CONFIG.RECONNECT_GRACE * 1000);
    this._graceTimers.set(sid, to);
  }

  _removePlayer(sid, why) {
    const p = this.players.get(sid);
    const to = this._graceTimers.get(sid);
    if (to) { clearTimeout(to); this._graceTimers.delete(sid); }
    // close any live conn for this sid
    for (const [pid, e] of this.conns) if (e.sid === sid) { try { e.conn.close(); } catch (x) {} this.conns.delete(pid); }
    this.players.delete(sid);
    this.lastStates.delete(sid);
    this._lastD.delete(sid); this._lastDT.delete(sid);
    this.strikes.delete(sid);
    this._emitPlayers();
    this.broadcast({ t: "players", list: this._playerListArr() });
    if (p) this._sys(p.name + " left the room" + (why ? " (" + why + ")" : "") + ".");
  }

  _sys(text) {
    this.broadcast({ t: "sys", text });
    if (this.onChat) this.onChat({ sys: true, text });
  }

  /* ---------------- host: the join gate ---------------- */
  _handleGuestMessage(conn, data) {
    if (!data || !data.t) return;
    switch (data.t) {
      case "hello": {
        // Order: locked → password → token restore → capacity → name validity+uniqueness
        const deny = (reason) => {
          try { conn.send({ t: "denied", reason }); setTimeout(() => { try { conn.close(); } catch (e) {} }, 300); } catch (e) {}
        };
        if (this.locked) { deny("locked"); return; }

        // restore path (reconnect / rejoin after reload / after host transfer)
        const token = (typeof data.token === "string") ? data.token.slice(0, 16) : null;
        if (token && this.players.has(token)) {
          const p = this.players.get(token);
          // duplicate active session guard: same sid already connected elsewhere
          for (const e of this.conns.values()) {
            if (e.sid === token && e.conn !== conn && e.conn.open) { deny("dupsession"); return; }
          }
          // re-key the connection and refresh the roster entry
          for (const [pid, e] of this.conns) if (e.sid === token) this.conns.delete(pid);
          this.conns.set(conn.peer, { conn, sid: token });
          p.peerId = conn.peer; p.disconnectedAt = null;
          const to = this._graceTimers.get(token);
          if (to) { clearTimeout(to); this._graceTimers.delete(token); }
          conn.send({ t: "welcome", map: this.selectedMap, players: this._playerListArr(),
                      locked: this.locked, hasPass: !!this.password });
          this.broadcast({ t: "players", list: this._playerListArr() });
          this._emitPlayers();
          this._sys(p.name + " reconnected.");
          this._setWire(conn);
          return;
        }

        // password check (rate-limited)
        if (this.password) {
          let n = this._passN.get(conn.peer) || 0;
          if (n >= CONFIG.PASS_ATTEMPTS) { deny("toomany"); return; }
          this._passN.set(conn.peer, n + 1);
          if (data.pass !== this.password) { deny("password"); return; }
        }

        if (this.players.size >= CONFIG.MAX_PLAYERS) { deny("full"); return; }
        const v = validateName(data.name);
        if (!v.ok) { deny("badname"); return; }
        const lower = v.name.toLowerCase();
        for (const p of this.players.values()) {
          if (p.name.toLowerCase() === lower) { deny("name"); return; }
        }

        const sid = token || randomHex(12);
        this.conns.set(conn.peer, { conn, sid });
        this.players.set(sid, {
          sid, peerId: conn.peer, name: v.name,
          vehicle: VEHICLES[data.vehicle] ? data.vehicle : "Car",
          isHost: false, ping: null, disconnectedAt: null,
        });
        this._emitPlayers();
        conn.send({ t: "welcome", map: this.selectedMap, players: this._playerListArr(),
                    locked: this.locked, hasPass: !!this.password, yourSid: sid });
        this.broadcast({ t: "players", list: this._playerListArr() }, conn.peer);
        this._sys(v.name + " joined the room.");
        this._setWire(conn);
        break;
      }
      case "vehicle": {
        const sid = this._sidOf(conn);
        const p = sid && this.players.get(sid);
        if (p && VEHICLES[data.vehicle]) {
          p.vehicle = data.vehicle;
          this._emitPlayers();
          this.broadcast({ t: "players", list: this._playerListArr() });
        }
        break;
      }
      case "state": {
        const sid = this._sidOf(conn);
        if (!sid || !data.s) return;
        // ROADGUARD layer 4: speed-bound validation on reported distance.
        const p = this.players.get(sid);
        const maxV = VEHICLES[(p && p.vehicle) || "Car"].maxSpeed;
        const tNow = nowMs();
        const prevD = this._lastD.has(sid) ? this._lastD.get(sid) : data.s.d;
        const prevT = this._lastDT.has(sid) ? this._lastDT.get(sid) : tNow;
        const dtSec = Math.max(0.016, (tNow - prevT) / 1000);
        if (!deltaOk(maxV, dtSec, data.s.d - prevD)) {
          this._strike(sid, "impossible speed");
          return; // reject the packet entirely
        }
        this._lastD.set(sid, data.s.d); this._lastDT.set(sid, tNow);
        this.lastStates.set(sid, data.s);
        if (this.onWorldUpdate) this.onWorldUpdate(sid, data.s);
        this.broadcast({ t: "peerstate", id: sid, s: data.s }, conn.peer);
        break;
      }
      case "finish": {
        const sid = this._sidOf(conn);
        if (!sid || !this._onGuestFinish) return;
        // ROADGUARD: finish must be plausible vs the host's own race clock + distance.
        const st = this.lastStates.get(sid) || {};
        if (!validFinishMsg(Game.raceTime, data.time, st.d != null ? st.d : 0, FINISH_DISTANCE)) {
          this._strike(sid, "implausible finish");
          return;
        }
        this._onGuestFinish(sid, data);
        break;
      }
      case "pkc": { // pickup claim — host validates and atomically awards
        const sid = this._sidOf(conn);
        const pk = Game.world && Game.world.pickups[data.id];
        if (!sid || !pk || pk.taken || Game.state !== "racing") return;
        const st = this.lastStates.get(sid) || {};
        if (Math.abs((st.x != null ? st.x : 0) - pk.x) > 220) { this._strike(sid, "fake pickup"); return; }
        pk.taken = true;
        this.broadcast({ t: "pk", id: data.id, by: sid }); // recipient applies the effect
        break;
      }
      case "chat": {
        const sid = this._sidOf(conn);
        const p = sid && this.players.get(sid);
        if (!p) return;
        let text = String(data.text || "").slice(0, CONFIG.CHAT_MAX_LEN).trim();
        if (!text) return;
        let lim = this._chatL.get(sid);
        if (!lim) { lim = new RateLimiter(CONFIG.CHAT_COOLDOWN_MS); this._chatL.set(sid, lim); }
        if (!lim.allow()) return;
        if (p._lastMsg === text && nowMs() - (p._lastMsgT || 0) < 3000) return; // duplicate throttle
        p._lastMsg = text; p._lastMsgT = nowMs();
        this.broadcast({ t: "chat", sid, name: p.name, text, ts: Date.now() });
        if (this.onChat) this.onChat({ name: p.name, text, ts: Date.now() });
        break;
      }
      case "emote": {
        const sid = this._sidOf(conn);
        const p = sid && this.players.get(sid);
        if (!p || !EMOTES.includes(data.code)) return;
        let lim = this._emoteL.get(sid);
        if (!lim) { lim = new RateLimiter(CONFIG.EMOTE_COOLDOWN_MS); this._emoteL.set(sid, lim); }
        if (!lim.allow()) return;
        this.broadcast({ t: "emote", sid, name: p.name, code: data.code });
        if (this.onEmote) this.onEmote({ sid, name: p.name, code: data.code });
        break;
      }
      case "ping": {
        if (typeof data.ts === "number") { try { conn.send({ t: "pong", ts: data.ts }); } catch (e) {} }
        break;
      }
      case "pong": {
        const sid = this._sidOf(conn);
        const p = sid && this.players.get(sid);
        if (p && typeof data.ts === "number") {
          p.ping = Math.round(nowMs() - data.ts);
          this.broadcast({ t: "players", list: this._playerListArr() });
        }
        break;
      }
    }
  }

  _setWire(conn) {
    // reconnect handling wire for restored/accepted guests
    conn.on("close", () => this._peerDropped(conn));
  }
  _sidOf(conn) {
    const e = this.conns.get(conn.peer);
    return e ? e.sid : null;
  }

  /* ROADGUARD strikes: thresholds, not instant bans; poor networks get slack. */
  _strike(sid, why) {
    let s = this.strikes.get(sid) || { n: 0, lastT: 0 };
    const t = nowMs();
    if (t - s.lastT > 10000) s.n = 0; // decay after 10 s clean
    s.n++; s.lastT = t;
    this.strikes.set(sid, s);
    const p = this.players.get(sid);
    if (s.n >= CONFIG.STRIKES_KICK && p) {
      this._sys("RoadGuard: removed " + p.name + " (" + why + ").");
      const e = Array.from(this.conns.values()).find(x => x.sid === sid);
      if (e) { try { e.conn.send({ t: "kicked", reason: "suspicious data" }); } catch (x) {} }
      this._removePlayer(sid, "RoadGuard");
    }
  }

  /* ---------------- guest side ---------------- */
  _handleHostMessage(data) {
    if (!data || !data.t) return;
    switch (data.t) {
      case "welcome":
        this.selectedMap = data.map;
        this.players = new Map(data.players.map(p => [p.sid, p]));
        this.locked = !!data.locked;
        this.hasPass = !!data.hasPass;
        if (data.yourSid && !this.mySid) this.mySid = data.yourSid;
        if (this._joinSettle) { this._joinSettle.ok(); this._joinSettle = null; }
        this._setConnState("connected");
        if (this.onPlayersChanged) this.onPlayersChanged(data.players);
        if (this.onMapChanged) this.onMapChanged(data.map);
        if (this.onRoomCfg) this.onRoomCfg(this.locked, this.hasPass);
        break;
      case "players":
        this.players = new Map(data.list.map(p => [p.sid, p]));
        if (this.onPlayersChanged) this.onPlayersChanged(data.list);
        break;
      case "map":
        this.selectedMap = data.map;
        if (this.onMapChanged) this.onMapChanged(data.map);
        break;
      case "roomcfg":
        this.locked = !!data.locked; this.hasPass = !!data.hasPass;
        if (this.onRoomCfg) this.onRoomCfg(this.locked, this.hasPass);
        break;
      case "start":
        this._stopReconnect();
        if (this.onRaceStart) this.onRaceStart(data.seed, data.map);
        break;
      case "go":
        this._setConnState("connected");
        if (this.onGo) this.onGo();
        break;
      case "peerstate":
        if (this.onWorldUpdate) this.onWorldUpdate(data.id, data.s);
        break;
      case "pos":
        if (this.onPositions) this.onPositions(data.list);
        break;
      case "pk":
        if (this.onPickup) this.onPickup(data.id, data.by);
        break;
      case "chat":
        if (this.onChat) this.onChat({ name: data.name, text: data.text, ts: data.ts });
        break;
      case "sys":
        if (this.onChat) this.onChat({ sys: true, text: data.text });
        break;
      case "emote":
        if (this.onEmote) this.onEmote({ sid: data.sid, name: data.name, code: data.code });
        break;
      case "leaderboard":
        if (this.onLeaderboard) this.onLeaderboard(data.list);
        break;
      case "lobby":
        if (this.onReturnToLobby) this.onReturnToLobby();
        break;
      case "ping":
        if (this.hostConn && this.hostConn.open) {
          try { this.hostConn.send({ t: "pong", ts: data.ts }); } catch (e) {}
        }
        break;
      case "pong":
        if (typeof data.ts === "number") this.rtt = Math.max(1, Math.round(nowMs() - data.ts));
        break;
      case "denied":
        if (this._joinSettle) { this._joinSettle.err(data.reason || "denied"); this._joinSettle = null; }
        break;
      case "full":
        if (this._joinSettle) { this._joinSettle.err("full"); this._joinSettle = null; }
        try { this.hostConn.close(); } catch (e) {}
        break;
      case "kicked":
        this._kicked = true;
        if (this.onKicked) this.onKicked(data.reason || "removed by host");
        break;
      case "xfer":
        if (this.onHostTransfer) this.onHostTransfer(data.to, data.toPeerId);
        break;
    }
  }

  _playerListArr() { return Array.from(this.players.values()); }
  _emitPlayers() { if (this.onPlayersChanged) this.onPlayersChanged(this._playerListArr()); }

  /* host: room configuration (server-authorized because only the host executes it) */
  setPassword(pw) {
    if (!this.isHost) return;
    this.password = (pw || "").toString().slice(0, 24);
    this.broadcast({ t: "roomcfg", locked: this.locked, hasPass: !!this.password });
    if (this.onRoomCfg) this.onRoomCfg(this.locked, !!this.password);
    this._sys(this.password ? "Room password set." : "Room password removed.");
  }
  setLocked(v) {
    if (!this.isHost) return;
    this.locked = !!v;
    this.broadcast({ t: "roomcfg", locked: this.locked, hasPass: !!this.password });
    if (this.onRoomCfg) this.onRoomCfg(this.locked, !!this.password);
    this._sys(this.locked ? "Room locked — no new players." : "Room unlocked.");
  }
  kick(sid) {
    if (!this.isHost) return;
    const p = this.players.get(sid);
    if (!p || p.isHost) return;
    const e = Array.from(this.conns.values()).find(x => x.sid === sid);
    if (e) { try { e.conn.send({ t: "kicked", reason: "removed by host" }); } catch (x) {} }
    this._removePlayer(sid, "kicked by host");
  }

  /* Host transfer — lobby only. The successor keeps the roster; guests reconnect
     to the successor's peer id (announced in the message). */
  transferHost(sid) {
    if (!this.isHost) return;
    const p = this.players.get(sid);
    if (!p || p.isHost || !p.peerId) return;
    this.broadcast({ t: "xfer", to: sid, toPeerId: p.peerId });
    // give guests a moment to receive it, then step down
    setTimeout(() => { try { this.destroy(); } catch (e) {} }, 800);
  }

  setMap(mapName) {
    this.selectedMap = mapName;
    if (this.isHost) this.broadcast({ t: "map", map: mapName });
  }
  setMyVehicle(vehicle) {
    const me = this.players.get(this.mySid);
    if (me) me.vehicle = vehicle;
    if (this.isHost) {
      this._emitPlayers();
      this.broadcast({ t: "players", list: this._playerListArr() });
    } else if (this.hostConn && this.hostConn.open) this.hostConn.send({ t: "vehicle", vehicle });
  }

  /* Authoritative race start: host broadcasts 'start' (seed+map) then 'go' 3 s later.
     Clients animate the countdown locally but movement unlocks only on 'go'. */
  startRace() {
    if (!this.isHost) return;
    const seed = Math.floor(Math.random() * 999999) + 1;
    this.raceRoster = this._playerListArr().filter(p => p.disconnectedAt == null).map(p => p.sid);
    this.finishList = [];
    this.lastStates.clear();
    this._lastD.clear(); this._lastDT.clear();
    this.locked = true; // no joins mid-race
    this.broadcast({ t: "start", seed, map: this.selectedMap });
    if (this.onRaceStart) this.onRaceStart(seed, this.selectedMap);
    setTimeout(() => {
      if (this._destroyed) return;
      this.broadcast({ t: "go" });
      if (this.onGo) this.onGo();
    }, 3000);
  }

  broadcastPositions() {
    if (!this.isHost || this._destroyed) return;
    // Standings from finishList + lastStates + own live distance → authoritative.
    const entries = [];
    for (const sid of this.raceRoster) {
      if (!this.players.has(sid)) continue;
      const p = this.players.get(sid);
      const f = this.finishList.find(x => x.id === sid);
      if (f) entries.push({ id: sid, d: f.distance, f: 1, t: f.time, n: p.name });
      else {
        const st = (sid === this.mySid && Game.local)
          ? { d: Math.round(Game.local.distance), x: Math.round(Game.local.x) }
          : (this.lastStates.get(sid) || { d: 0, x: 0 });
        entries.push({ id: sid, d: st.d || 0, f: 0, t: null, n: p.name });
      }
    }
    entries.sort((a, b) => (b.f - a.f) || (b.f ? a.t - b.t : b.d - a.d));
    entries.forEach((e, i) => { e.p = i + 1; });
    this.broadcast({ t: "pos", list: entries });
    if (this.onPositions) this.onPositions(entries);
  }

  sendState(s) {
    if (this.isHost) {
      this.lastStates.set(this.mySid, s);
      if (this.onWorldUpdate) this.onWorldUpdate(this.mySid, s);
      this.broadcast({ t: "peerstate", id: this.mySid, s });
    } else if (this.hostConn && this.hostConn.open) {
      try { this.hostConn.send({ t: "state", s }); } catch (e) {}
    }
  }
  sendFinish(payload) {
    if (this.isHost) { if (this._onGuestFinish) this._onGuestFinish(this.mySid, payload); }
    else if (this.hostConn && this.hostConn.open) {
      try { this.hostConn.send(Object.assign({ t: "finish" }, payload)); } catch (e) {}
    }
  }
  claimPickup(id) {
    if (this.hostConn && this.hostConn.open) {
      try { this.hostConn.send({ t: "pkc", id }); } catch (e) {}
    }
  }
  sendChat(text) {
    if (this.isHost) {
      // host moderates itself through the same rules
      let t2 = String(text || "").slice(0, CONFIG.CHAT_MAX_LEN).trim();
      if (!t2) return;
      let lim = this._chatL.get(this.mySid);
      if (!lim) { lim = new RateLimiter(CONFIG.CHAT_COOLDOWN_MS); this._chatL.set(this.mySid, lim); }
      if (!lim.allow()) return;
      this.broadcast({ t: "chat", sid: this.mySid, name: this.myName, text: t2, ts: Date.now() });
      if (this.onChat) this.onChat({ name: this.myName, text: t2, ts: Date.now() });
    } else if (this.hostConn && this.hostConn.open) {
      try { this.hostConn.send({ t: "chat", text }); } catch (e) {}
    }
  }
  sendEmote(code) {
    if (this.isHost) {
      let lim = this._emoteL.get(this.mySid);
      if (!lim) { lim = new RateLimiter(CONFIG.EMOTE_COOLDOWN_MS); this._emoteL.set(this.mySid, lim); }
      if (!lim.allow()) return;
      this.broadcast({ t: "emote", sid: this.mySid, name: this.myName, code });
      if (this.onEmote) this.onEmote({ sid: this.mySid, name: this.myName, code });
    } else if (this.hostConn && this.hostConn.open) {
      try { this.hostConn.send({ t: "emote", code }); } catch (e) {}
    }
  }
  returnAllToLobby() {
    if (!this.isHost) return;
    this.locked = false;
    this.broadcast({ t: "lobby" });
    if (this.onReturnToLobby) this.onReturnToLobby();
  }
  broadcastLeaderboard(list) {
    if (!this.isHost) return;
    this.broadcast({ t: "leaderboard", list });
    if (this.onLeaderboard) this.onLeaderboard(list);
  }
  broadcast(obj, excludePeerId) {
    for (const [pid, e] of this.conns) {
      if (pid === excludePeerId) continue;
      if (e.conn.open) { try { e.conn.send(obj); } catch (x) {} }
    }
  }

  joinRoom(code, name, pass) {
    this.myName = name || "Player";
    this.isHost = false;
    this._joinPass = pass || "";
    return this._joinAttempt(code, 0);
  }

  _joinAttempt(code, attempt) {
    const target = "roadrush-" + code.trim().toUpperCase();
    return new Promise((resolve, reject) => {
      const settle = {
        ok: () => { if (!settle.done) { settle.done = true; clearTimeout(settle.to); resolve(code.trim().toUpperCase()); } },
        err: (m) => { if (!settle.done) { settle.done = true; clearTimeout(settle.to); reject(new Error(m)); } },
      };
      settle.to = setTimeout(() => settle.err("timeout"), 10000);
      this._joinSettle = settle;
      this._setConnState("connecting");
      const retryNetwork = () => {
        if (settle.done || this._destroyed) return;
        if (attempt < 1) {
          settle.done = true; clearTimeout(settle.to);
          try { if (this.peer) this.peer.destroy(); } catch (e) {}
          setTimeout(() => this._joinAttempt(code, attempt + 1).then(resolve, reject), 700);
        } else settle.err("network");
      };
      try { this.peer = new Peer(undefined, PEER_OPTS); }
      catch (e) { settle.err("network"); return; }
      this.peer.on("error", (err) => {
        if (settle.done) return;
        if (err && err.type === "peer-unavailable") settle.err("notfound");
        else retryNetwork();
      });
      this.peer.on("disconnected", () => {
        if (!settle.done && !this._destroyed) { try { this.peer.reconnect(); } catch (e) {} }
      });
      this.peer.on("open", () => {
        this.hostPeerId = target;
        const sid = sidFor(code.trim().toUpperCase());
        const conn = this.peer.connect(target, { reliable: true });
        this.hostConn = conn;
        conn.on("open", () => {
          this.mySid = sid;
          conn.send({ t: "hello", name: this.myName, vehicle: save.vehicle, token: sid, pass: this._joinPass });
          this._startGuestPing();
        });
        conn.on("data", (data) => this._handleHostMessage(data));
        conn.on("close", () => {
          if (!settle.done) settle.err("closed");
          else this._onHostConnLost();
        });
      });
    });
  }

  /* guest: measure REAL round-trip latency to the host every 2 s */
  _startGuestPing() {
    this._stopGuestPing();
    this._guestPing = setInterval(() => {
      if (this._destroyed || !this.hostConn || !this.hostConn.open) return;
      try { this.hostConn.send({ t: "ping", ts: nowMs() }); } catch (e) {}
    }, 2000);
  }
  _stopGuestPing() { if (this._guestPing) { clearInterval(this._guestPing); this._guestPing = null; } }

  /* guest: host connection lost mid-room → reconnect loop, identity preserved */
  _onHostConnLost() {
    if (this._destroyed || this._kicked) return;
    this._setConnState("reconnecting");
    this._startReconnect();
  }
  _startReconnect() {
    if (this._destroyed || this._reconn) return;
    this._reconn = { attempts: 0, timer: setInterval(() => this._reconnTick(), 2000) };
    this._reconnTick();
  }
  _reconnTick() {
    if (!this._reconn || this._destroyed || this._kicked) return;
    if (this.hostConn && this.hostConn.open) { this._stopReconnect(); return; }
    if (this._reconn.attempts >= CONFIG.RECONNECT_ATTEMPTS) {
      this._stopReconnect();
      this._setConnState("disconnected");
      if (this.onHostLeft) this.onHostLeft();
      return;
    }
    this._reconn.attempts++;
    try {
      const conn = this.peer.connect(this.hostPeerId, { reliable: true });
      conn.on("open", () => {
        this.hostConn = conn;
        this._reconn.attempts = 0;
        conn.send({ t: "hello", name: this.myName, vehicle: save.vehicle, token: this.mySid, pass: "" });
        this._startGuestPing();
        conn.on("data", (data) => this._handleHostMessage(data));
        conn.on("close", () => this._onHostConnLost());
      });
      setTimeout(() => { if (!conn.open) { try { conn.close(); } catch (e) {} } }, 1800);
    } catch (e) {}
  }
  _stopReconnect() {
    if (this._reconn) { clearInterval(this._reconn.timer); this._reconn = null; }
  }

  destroy() {
    this._destroyed = true;
    this._stopPingLoop(); this._stopGuestPing(); this._stopReconnect();
    for (const to of this._graceTimers.values()) clearTimeout(to);
    this._graceTimers.clear();
    try { if (this.hostConn) this.hostConn.close(); } catch (e) {}
    for (const e of this.conns.values()) { try { e.conn.close(); } catch (x) {} }
    try { if (this.peer) this.peer.destroy(); } catch (e) {}
    this.peer = null; this.hostConn = null;
    this.conns.clear(); this.players.clear(); this.lastStates.clear();
    this._lastD.clear(); this._lastDT.clear(); this.strikes.clear();
    this.raceRoster = []; this.finishList = [];
    this.isHost = false; this.roomCode = null; this._joinSettle = null;
    this._setConnState("offline");
  }
}

/* ------------------------------ rendering ------------------------------ */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function drawTerrain(ctx, terrain, camX, camY, W, H) {
  const def = terrain.def;
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, def.sky[0]); grad.addColorStop(1, def.sky[1]);
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
  const q = save.quality;
  const starN = q === "low" ? 20 : 60;
  const snowN = q === "low" ? 12 : 30;
  if (def.label === "Moon") {
    ctx.fillStyle = "#e8e8f2";
    for (let i = 0; i < starN; i++) {
      const sx = (i * 137.5) % W, sy = (i * 91.7) % (H * 0.65);
      ctx.fillRect(sx, sy, (i % 7 === 0) ? 2 : 1.4, (i % 7 === 0) ? 2 : 1.4);
    }
  } else if (def.label === "Snow") {
    ctx.fillStyle = "#ffffff";
    const t = performance.now() * 0.03;
    for (let i = 0; i < snowN; i++) {
      const sx = ((i * 173 + t * (0.4 + (i % 3) * 0.3)) % (W + 40)) - 20;
      const sy = (i * 67 + t * 0.15) % H;
      ctx.beginPath(); ctx.arc(sx, sy, 1.8, 0, 6.283); ctx.fill();
    }
  } else if (def.label === "Desert") {
    ctx.fillStyle = "#fff2c8";
    ctx.beginPath(); ctx.arc(W * 0.78, H * 0.2, 34, 0, 6.283); ctx.fill();
  }
  if (def.far) {
    ctx.fillStyle = def.far;
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let sx = 0; sx <= W; sx += 16) {
      const wx = camX * 0.3 + sx;
      ctx.lineTo(sx, H * 0.62 + Math.sin(wx * 0.0011 + 1) * 60 + Math.sin(wx * 0.0041 + 3) * 26);
    }
    ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  }
  ctx.beginPath(); ctx.moveTo(0, H + 60);
  const step = 8;
  for (let sx = 0; sx <= W + step; sx += step) ctx.lineTo(sx, terrain.heightAt(camX + sx) - camY);
  ctx.lineTo(W, H + 60); ctx.closePath();
  ctx.fillStyle = def.ground; ctx.fill();
  ctx.beginPath();
  ctx.strokeStyle = def.accent; ctx.lineWidth = 3;
  for (let sx = 0; sx <= W + step; sx += step) {
    const gy = terrain.heightAt(camX + sx) - camY + 4;
    if (sx === 0) ctx.moveTo(sx, gy); else ctx.lineTo(sx, gy);
  }
  ctx.stroke();
  if (def.label === "Highway") {
    ctx.fillStyle = "#e6d23c";
    const first = Math.floor(camX / 46) * 46;
    for (let wx = first; wx < camX + W + 46; wx += 46) {
      const gy = terrain.heightAt(wx) - camY + 9;
      ctx.save(); ctx.translate(wx - camX, gy); ctx.rotate(Math.atan(terrain.slopeAt(wx)));
      ctx.fillRect(0, 0, 24, 3.5); ctx.restore();
    }
  }
}
function drawScenery(ctx, terrain, camX, camY, W, H, mapName) {
  const step = save.quality === "low" ? 340 : 230; // low quality = sparser scenery
  const first = Math.floor((camX - 100) / step) * step;
  for (let wx = first; wx < camX + W + step; wx += step) {
    if (wx < 400) continue;
    const h1 = hash01(Math.floor(wx / step));
    if (h1 < 0.4) continue;
    const h2 = hash01(Math.floor(wx / step) + 7);
    const sx = wx - camX + (h1 - 0.5) * 60;
    const gy = terrain.heightAt(wx) - camY;
    if (gy < -100 || gy > H + 100) continue;
    if (mapName === "Highway") {
      if (h1 > 0.82) {
        const bh = 60 + h2 * 90, bw = 46 + h2 * 30;
        ctx.fillStyle = "#33404f"; ctx.fillRect(sx - bw / 2, gy - bh, bw, bh);
        ctx.fillStyle = "#ffd97a";
        for (let r = 0; r < Math.floor(bh / 22); r++)
          for (let c = 0; c < 3; c++)
            if (hash01(r * 13 + c + Math.floor(wx / step)) > 0.55)
              ctx.fillRect(sx - bw / 2 + 6 + c * (bw - 12) / 3, gy - bh + 8 + r * 22, (bw - 18) / 4, 8);
      } else {
        ctx.fillStyle = "#586070"; ctx.fillRect(sx - 2, gy - 78, 4, 78); ctx.fillRect(sx - 2, gy - 78, 22, 4);
        ctx.fillStyle = "#ffe9a0"; ctx.fillRect(sx + 14, gy - 75, 8, 5);
      }
    } else if (mapName === "Hills") {
      ctx.fillStyle = "#5a4028"; ctx.fillRect(sx - 3, gy - 26, 6, 26);
      ctx.fillStyle = "#3f7a34";
      const r = 16 + h2 * 8;
      ctx.beginPath(); ctx.arc(sx, gy - 34, r, 0, 6.283); ctx.fill();
      ctx.beginPath(); ctx.arc(sx - 10, gy - 26, r * 0.7, 0, 6.283); ctx.fill();
      ctx.beginPath(); ctx.arc(sx + 10, gy - 26, r * 0.7, 0, 6.283); ctx.fill();
    } else if (mapName === "Snow") {
      ctx.fillStyle = "#5a4028"; ctx.fillRect(sx - 3, gy - 24, 6, 24);
      ctx.fillStyle = "#2e5c40";
      for (let i = 0; i < 3; i++) {
        const ty = gy - 24 - i * 14, tw = 22 - i * 5;
        ctx.beginPath(); ctx.moveTo(sx, ty - 18); ctx.lineTo(sx - tw, ty); ctx.lineTo(sx + tw, ty); ctx.closePath(); ctx.fill();
      }
    } else if (mapName === "Desert") {
      ctx.fillStyle = "#a08250"; ctx.beginPath(); ctx.arc(sx, gy - 6, 8 + h2 * 6, 0, 6.283); ctx.fill();
    } else if (mapName === "Moon") {
      ctx.fillStyle = "#1c1c26"; ctx.beginPath(); ctx.ellipse(sx, gy + 4, 16 + h2 * 14, 5, 0, 0, 6.283); ctx.fill();
    }
  }
}
function drawFlag(ctx, terrain, camX, camY, W, wx, color, label) {
  const sx = wx - camX;
  if (sx < -80 || sx > W + 80) return;
  const gy = terrain.heightAt(wx) - camY;
  ctx.fillStyle = "#20242c"; ctx.fillRect(sx - 2, gy - 130, 5, 130);
  if (color) {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(sx + 3, gy - 130); ctx.lineTo(sx + 46, gy - 118); ctx.lineTo(sx + 3, gy - 106); ctx.closePath(); ctx.fill();
  } else {
    for (let r = 0; r < 2; r++) for (let c = 0; c < 5; c++) {
      ctx.fillStyle = ((r + c) % 2 === 0) ? "#fff" : "#16161c";
      ctx.fillRect(sx + 3 + c * 9, gy - 130 + r * 9, 9, 9);
    }
  }
  ctx.fillStyle = "#fff"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center";
  ctx.fillText(label, sx, gy - 138);
}
function drawRaceMarkers(ctx, terrain, camX, camY, W) {
  drawFlag(ctx, terrain, camX, camY, W, START_X, "#39c96b", "START");
  drawFlag(ctx, terrain, camX, camY, W, START_X + FINISH_DISTANCE, null, "FINISH");
  const stepU = 5000;
  const first = Math.floor((camX - 100) / stepU) * stepU;
  for (let wx = Math.max(stepU, first); wx < camX + W + stepU; wx += stepU) {
    const sx = wx - camX;
    if (sx < -60 || sx > W + 60) continue;
    const gy = terrain.heightAt(wx) - camY;
    ctx.fillStyle = "#333"; ctx.fillRect(sx - 2, gy - 34, 4, 34);
    ctx.fillStyle = "#f3f3f3"; ctx.fillRect(sx - 20, gy - 46, 40, 15);
    ctx.fillStyle = "#222"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText((wx * UNIT_TO_M / 1000).toFixed(1) + "km", sx, gy - 35);
  }
}
function drawVehicleShape(ctx, name, color, w, h) {
  const wheel = (wx, wy, r) => {
    ctx.fillStyle = "#181820"; ctx.beginPath(); ctx.arc(wx, wy, r, 0, 6.283); ctx.fill();
    ctx.fillStyle = "#555"; ctx.beginPath(); ctx.arc(wx, wy, r * 0.45, 0, 6.283); ctx.fill();
  };
  if (name === "Bike") {
    wheel(-w * 0.34, h * 0.30, 8); wheel(w * 0.34, h * 0.30, 8);
    ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-w * 0.34, h * 0.3); ctx.lineTo(-w * 0.05, -h * 0.1); ctx.lineTo(w * 0.34, h * 0.3); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-w * 0.05, -h * 0.1); ctx.lineTo(w * 0.16, h * 0.22); ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(w * 0.02, -h * 0.45, 5, 0, 6.283); ctx.fill();
    ctx.fillRect(-w * 0.1, -h * 0.35, w * 0.28, h * 0.3);
  } else if (name === "Bus") {
    ctx.fillStyle = color; roundRect(ctx, -w / 2, -h / 2, w, h, 5); ctx.fill();
    ctx.fillStyle = "#b09220"; ctx.fillRect(-w / 2, h * 0.05, w, h * 0.18);
    ctx.fillStyle = "#cfe8fa";
    for (const fx of [-w * 0.34, -w * 0.13, w * 0.08, w * 0.29]) ctx.fillRect(fx, -h / 2 + 5, w * 0.15, h * 0.34);
    wheel(-w * 0.28, h * 0.42, 9); wheel(w * 0.28, h * 0.42, 9);
  } else {
    ctx.fillStyle = color; roundRect(ctx, -w / 2, -h / 2, w, h, 7); ctx.fill();
    ctx.fillStyle = "#cfe8fa";
    ctx.beginPath();
    ctx.moveTo(-w * 0.12, -h / 2); ctx.lineTo(w * 0.22, -h / 2);
    ctx.lineTo(w * 0.12, -h * 0.05); ctx.lineTo(-w * 0.26, -h * 0.05);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#ffe9a0"; ctx.fillRect(w / 2 - 4, -h * 0.2, 4, 6);
    wheel(-w * 0.28, h * 0.42, 8); wheel(w * 0.30, h * 0.42, 8);
  }
}
function drawVehicle(ctx, p, camX, camY, alpha) {
  const cx = p.x - camX, cy = p.y - camY;
  ctx.save();
  if (alpha) ctx.globalAlpha = alpha;
  ctx.translate(cx, cy);
  ctx.rotate(p.angle * Math.PI / 180);
  drawVehicleShape(ctx, p.vehicleName, p.color, p.w, p.h);
  if (p.nitroTimer > 0 || p.nitro === true) {
    const fl = 14 + Math.sin(performance.now() * 0.03) * 5;
    ctx.fillStyle = "#ff9a2e";
    ctx.beginPath(); ctx.moveTo(-p.w / 2 - 2, -5); ctx.lineTo(-p.w / 2 - 2, 5); ctx.lineTo(-p.w / 2 - fl, 0); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#ffe86e";
    ctx.beginPath(); ctx.moveTo(-p.w / 2 - 2, -2.5); ctx.lineTo(-p.w / 2 - 2, 2.5); ctx.lineTo(-p.w / 2 - fl * 0.55, 0); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  if (p.isRemote || p.isBot) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#fff"; ctx.font = "11px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(p.name, cx, cy - p.h / 2 - 12);
  }
}
/* emote bubbles drawn above the vehicle that sent them */
function drawEmoteBubbles(ctx, camX, camY) {
  ctx.font = "bold 12px sans-serif"; ctx.textAlign = "center";
  for (const b of Game.bubbles) {
    const pl = playerBySid(b.sid);
    if (!pl) continue;
    const cx = pl.x - camX, cy = pl.y - camY - pl.h / 2 - 26;
    const tw = ctx.measureText(b.text).width;
    ctx.fillStyle = "#000d";
    roundRect(ctx, cx - tw / 2 - 8, cy - 12, tw + 16, 22, 8); ctx.fill();
    ctx.strokeStyle = "#ffffff44"; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.fillText(b.text, cx, cy + 4);
  }
}
function playerBySid(sid) {
  if (Game.net && Game.net.mySid === sid) return Game.local;
  return Game.ghosts.get(sid) || null;
}
function drawPickup(ctx, pk, camX, camY, terrain, W) {
  if (pk.taken) return;
  const x = pk.x - camX;
  if (x < -30 || x > W + 30) return;
  const yOff = Math.sin(performance.now() * 0.004 + pk.bob) * 5;
  const cy = terrain.heightAt(pk.x) - 28 + yOff - camY;
  if (pk.kind === "fuel") {
    ctx.fillStyle = "#f0a028"; roundRect(ctx, x - 8, cy - 10, 16, 20, 3); ctx.fill();
    ctx.fillStyle = "#c87c14"; ctx.fillRect(x - 4, cy - 13, 8, 4);
    ctx.fillStyle = "#fff"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("F", x, cy + 3);
  } else if (pk.kind === "nitro") {
    ctx.save(); ctx.translate(x, cy); ctx.rotate(Math.PI / 4);
    ctx.fillStyle = "#3cc8ff"; ctx.fillRect(-8, -8, 16, 16);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.strokeRect(-4, -4, 8, 8);
    ctx.restore();
  } else {
    ctx.fillStyle = "#ffd73c"; ctx.beginPath(); ctx.arc(x, cy, 9, 0, 6.283); ctx.fill();
    ctx.strokeStyle = "#b8860b"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, cy, 5.5, 0, 6.283); ctx.stroke();
  }
}
function drawObstacle(ctx, o, camX, camY, terrain, W) {
  const x = o.x - camX;
  if (x < -80 || x > W + 80) return;
  const gy = terrain.heightAt(o.x) - camY;
  if (o.kind === "traffic") {
    ctx.fillStyle = "#b04848"; roundRect(ctx, x - 24, gy - 26, 48, 18, 4); ctx.fill();
    ctx.fillStyle = "#2a2e38"; roundRect(ctx, x + 2, gy - 23, 16, 10, 2); ctx.fill();
    ctx.fillStyle = "#ffd97a"; ctx.fillRect(x - 24, gy - 20, 4, 5);
    ctx.fillStyle = "#1a1a20";
    ctx.beginPath(); ctx.arc(x - 14, gy - 5, 6, 0, 6.283); ctx.fill();
    ctx.beginPath(); ctx.arc(x + 14, gy - 5, 6, 0, 6.283); ctx.fill();
  } else if (o.kind === "log") {
    ctx.fillStyle = "#6e4b28"; roundRect(ctx, x - 16, gy - 14, 32, 13, 6); ctx.fill();
    ctx.fillStyle = "#8a6038"; ctx.beginPath(); ctx.arc(x + 16, gy - 7.5, 6.5, 0, 6.283); ctx.fill();
    ctx.strokeStyle = "#4a3018"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x + 16, gy - 7.5, 3, 0, 6.283); ctx.stroke();
  } else if (o.kind === "cactus") {
    ctx.fillStyle = "#3c825a";
    ctx.fillRect(x - 5, gy - 30, 10, 30);
    ctx.fillRect(x - 14, gy - 22, 9, 6); ctx.fillRect(x - 14, gy - 22, 5, 10);
    ctx.fillRect(x + 5, gy - 26, 9, 6); ctx.fillRect(x + 9, gy - 26, 5, 12);
  } else if (o.kind === "ice") {
    ctx.fillStyle = "rgba(150,200,230,0.85)"; roundRect(ctx, x - 14, gy - 24, 28, 24, 3); ctx.fill();
    ctx.strokeStyle = "#e8f4ff"; ctx.lineWidth = 1.5; ctx.stroke();
  } else {
    ctx.fillStyle = o.kind === "crater" ? "#74747c" : "#6e6e73";
    ctx.beginPath();
    ctx.moveTo(x - 15, gy); ctx.lineTo(x - 10, gy - 16); ctx.lineTo(x + 2, gy - 22);
    ctx.lineTo(x + 13, gy - 12); ctx.lineTo(x + 15, gy);
    ctx.closePath(); ctx.fill();
    if (o.kind === "crater") {
      ctx.fillStyle = "#3c3c44"; ctx.beginPath(); ctx.ellipse(x, gy + 2, 14, 4, 0, 0, 6.283); ctx.fill();
    }
  }
}

/* ------------------------------ game state ------------------------------ */
let ctx = null, W = 0, H = 0;
const isTouch = (window.matchMedia && matchMedia("(pointer: coarse)").matches) || ("ontouchstart" in window);
document.body.classList.add(isTouch ? "is-touch" : "is-desktop");
if (save.reducedMotion) document.body.classList.add("no-motion");

const EMOTES = ["GO!", "NICE!", "GG", "LOL", "WOW!", "WAIT!", "FUEL!", "NITRO!", "CLUTCH!"];

const input = { accel: false, brake: false, left: false, right: false };
let nitroQueued = false, jumpQueued = false;
let toastT = 0, toastMsg = "";
let pendingRoom = null, DEBUG_MODE = false;

const Game = {
  mode: null, state: "menu", mapName: "Highway",
  terrain: null, world: null,
  players: [], local: null, bots: [], ghosts: new Map(),
  particles: new ParticleSystem(),
  sfx: new Sfx(),
  music: new MusicEngine(),
  cam: { x: 0, y: 0, shake: 0 },
  raceTime: 0, countdownT: 0, goT: 0, lastCountNum: 4, hintT: 0,
  awaitingGo: false,
  afterFinishTimer: 0, stalledFor: 0,
  hostEndStarted: false, hostEndTimer: 0,
  posAcc: 0, posList: null,
  bubbles: [],
  waiting: false,
  net: null, netAcc: 0, hudAcc: 0, listTick: 0, dbgAcc: 0, fpsAvg: 60,
  lastT: 0, paused: false,
};

const SCREENS = ["screen-home", "screen-play", "screen-vehicle", "screen-map", "screen-join",
  "screen-lobby", "screen-settings", "screen-race", "screen-howto", "screen-feedback"];
function showScreen(id) {
  for (const s of SCREENS) $(s).classList.add("hidden");
  if (id) $(id).classList.remove("hidden");
}
function currentScreen() {
  for (const s of SCREENS) if (!$(s).classList.contains("hidden")) return s;
  return null;
}
function hideOverlays() {
  ["overlay-pause", "overlay-result", "overlay-rotate", "overlay-qr", "emotePanel"].forEach(o => $(o).classList.add("hidden"));
}
function hudToast(msg) { toastMsg = msg; toastT = 2.4; }
function resizeCanvas() {
  const c = $("raceCanvas");
  if (!c || !ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width = Math.floor(innerWidth * dpr);
  c.height = Math.floor(innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  W = innerWidth; H = innerHeight;
}
function checkOrientation() {
  if (!window.matchMedia) return;
  const portrait = matchMedia("(orientation: portrait)").matches;
  $("overlay-rotate").classList.toggle("hidden", !(isTouch && portrait && currentScreen() === "screen-race"));
}

let wakeLock = null;
async function requestWakeLock() {
  try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {}
}
function releaseWakeLock() { try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {} }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Game.state !== "menu") requestWakeLock();
});

/* ------------------------------ race setup ------------------------------ */
function startRace(seed) {
  const mapDef = MAPS[Game.mapName];
  Game.terrain = new Terrain(mapDef, seed);
  Game.world = generateWorldObjects(Game.terrain, seed, FINISH_DISTANCE + START_X + 800);
  Game.particles = new ParticleSystem();
  Game.raceTime = 0; Game.afterFinishTimer = 0; Game.stalledFor = 0;
  Game.hostEndStarted = false; Game.hostEndTimer = 0;
  Game.waiting = false; toastT = 0; Game.posList = null; Game.bubbles = [];
  Game.countdownT = 3.0; Game.lastCountNum = 4; Game.goT = 0; Game.hintT = 6;
  Game.awaitingGo = Game.mode !== "single";   // multiplayer waits for the host's GO
  Game.state = "countdown"; Game.paused = false;
  Game.cam = { x: START_X - W * 0.35, y: 0, shake: 0 };

  Game.local = new RacePlayer(save.vehicle, Game.terrain,
    { id: "local", name: save.name, fuelMult: mapDef.fuelMult, sid: Game.net ? Game.net.mySid : null });
  Game.players = [Game.local];
  Game.ghosts.clear();
  Game.bots = [];

  if (Game.mode === "single") {
    const names = ["Rex", "Mia", "Zig"];
    const vehs = Object.keys(VEHICLES);
    for (let i = 0; i < 3; i++) {
      const skill = 0.82 + (i / 3) * 0.16 + Math.random() * 0.04;
      const b = new RacePlayer(vehs[i % 3], Game.terrain,
        { id: "bot" + i, name: names[i], isBot: true, fuelMult: mapDef.fuelMult });
      b.accelPower *= skill; b.maxSpeed *= skill; b.fuelUse *= 0.9;
      b.botTimer = 4 + Math.random() * 8;
      Game.bots.push(b);
      Game.players.push(b);
    }
  } else if (Game.net) {
    for (const p of Game.net._playerListArr()) {
      if (p.sid === Game.net.mySid) continue;
      const v = VEHICLES[p.vehicle] ? p.vehicle : "Car";
      Game.ghosts.set(p.sid, {
        sid: p.sid, name: p.name, isRemote: true, vehicleName: v,
        color: VEHICLES[v].color, w: VEHICLES[v].w, h: VEHICLES[v].h,
        x: START_X, y: Game.terrain.heightAt(START_X) - VEHICLES[v].h / 2 - VEHICLES[v].drop,
        angle: 0, tx: START_X, ty: 0, ta: 0,
        nitro: false, finished: false, finishTime: null, distance: 0,
      });
      Game.players.push(Game.ghosts.get(p.sid));
    }
  }

  showScreen("screen-race");
  hideOverlays();
  $("touchControls").classList.toggle("hidden", !(isTouch || save.pedals));
  $("keyHints").classList.toggle("hidden", isTouch);
  $("keyHints").classList.remove("faded");
  $("raceList").innerHTML = "";
  $("raceList").classList.toggle("hidden", Game.players.length < 2);
  $("hudWarning").textContent = "";
  Game.sfx.engineStart();
  Game.music.setEnabled(save.music);
  Game.music.start();
  requestWakeLock();
}

function beginGo() { // called by host schedule (host) or 'go' message (guest)
  if (Game.state !== "countdown") return;
  Game.state = "racing";
  Game.awaitingGo = false;
  Game.goT = 0.9;
  setCountdown("GO!");
  Game.sfx.play("go");
}

/* ------------------------------ bot AI ------------------------------ */
function botInput(bot, dt) {
  const inp = { accel: false, brake: false, left: false, right: false, nitro: false, jump: false };
  bot.stuckT = bot.stuckT || 0;
  bot.revT = bot.revT || 0;
  if (bot.revT > 0) { bot.revT -= dt; inp.brake = true; return inp; }
  if (Game.raceTime > 4 && bot.onGround && bot.vx < 25) {
    bot.stuckT += dt;
    if (bot.stuckT > 1.6) { bot.revT = 1.1; bot.stuckT = 0; return inp; }
  } else bot.stuckT = 0;
  inp.accel = bot.fuel > 5;
  if (bot.onGround && (bot.jumpCd || 0) <= 0) {
    for (const o of Game.world.obstacles) {
      const dx = o.x - bot.x;
      if (dx > 40 && dx < 170) { inp.jump = true; break; }
    }
  }
  if (!bot.onGround) {
    const target = Math.atan(Game.terrain.slopeAt(bot.x + bot.vx * 0.35)) * 180 / Math.PI;
    const diff = target - bot.angle;
    if (diff > 6) inp.right = true;
    else if (diff < -6) inp.left = true;
  }
  bot.botTimer -= dt;
  if (bot.botTimer <= 0) {
    bot.botTimer = 5 + Math.random() * 9;
    if (bot.nitroCharges > 0 && bot.onGround && Math.abs(Game.terrain.slopeAt(bot.x)) < 0.15) inp.nitro = true;
  }
  return inp;
}

/* ------------------------------ pickups (host-atomic in multiplayer) ------------------------------ */
function applyPickup(p, kind) {
  if (kind === "fuel") {
    p.fuel = fillFuel(p.fuel, p.fuelCap); // refills to FULL
    if (p === Game.local) { Game.sfx.play("fuel"); vibrate(15); }
  } else if (kind === "nitro") {
    p.nitroCharges = addNitro(p.nitroCharges, p.maxNitro);
    if (p === Game.local) Game.sfx.play("pickup");
  } else {
    p.coins += 1;
    if (p === Game.local) Game.sfx.play("coin");
  }
  if (p === Game.local) {
    const col = kind === "fuel" ? "#f0c828" : kind === "nitro" ? "#3cc8ff" : "#ffd73c";
    Game.particles.emit(p.x, p.y - 10, 6, col, { spread: 80, speed: 120, life: 0.4, size: 2, gravity: 300 });
  }
}
function tryPickup(pk) { // called when the LOCAL player overlaps a pickup
  if (Game.mode === "single" || !Game.net) {           // solo: instant
    if (!pk.taken) { pk.taken = true; applyPickup(Game.local, pk.kind); }
  } else if (Game.net.isHost) {                        // host: validate + broadcast + apply
    if (!pk.taken) {
      pk.taken = true;
      Game.net.broadcast({ t: "pk", id: pk.id, by: Game.net.mySid });
      applyPickup(Game.local, pk.kind);
    }
  } else {                                             // guest: claim; host decides
    if (!pk.taken) { pk.taken = true; Game.net.claimPickup(pk.id); } // optimistic hide, host confirms
  }
}
function onAuthoritativePickup(id, by) { // all clients receive host ruling
  const pk = Game.world && Game.world.pickups[id];
  if (!pk || pk.taken) return;
  pk.taken = true;
  if (Game.net && by === Game.net.mySid) applyPickup(Game.local, pk.kind); // you won the claim
}

function hitObstacle(p, o) {
  o.cd = 1.2;
  const massFactor = clamp((p.mass - 0.6) / 1.0, 0, 1);
  p.vx *= lerp(0.35, 0.62, massFactor);
  p.stunned = Math.max(p.stunned, 0.35);
  if (p === Game.local) {
    p.shake = 1;
    Game.sfx.play("collision");
    Game.particles.emit(p.x + p.w * 0.3, p.y, 10, "#ffb050", { spread: 120, speed: 180, life: 0.4, size: 2, gravity: 500 });
  } else if (Math.abs(p.x - Game.local.x) < 900) {
    Game.particles.emit(p.x, p.y, 5, "#ffb050", { spread: 100, speed: 140, life: 0.35, size: 2, gravity: 500 });
  }
}
function updateWorldInteractions(dt) {
  for (const o of Game.world.obstacles) {
    if (o.v) o.x = o.x0 + o.v * Math.max(0, Game.raceTime);
    if (o.cd > 0) o.cd -= dt;
  }
  const locals = [Game.local].concat(Game.bots); // bots only exist in solo
  for (const p of locals) {
    if (p.finished) continue;
    for (const pk of Game.world.pickups) {
      if (pk.taken) continue;
      const dx = p.x - pk.x;
      if (dx > 40 || dx < -40) continue;
      const py = Game.terrain.heightAt(pk.x) - 28;
      if (Math.abs(p.y - py) < 46) {
        if (p === Game.local) tryPickup(pk);
        else if (!pk.taken && Game.mode === "single") { pk.taken = true; applyPickup(p, pk.kind); }
      }
    }
    for (const o of Game.world.obstacles) {
      if (o.cd > 0) continue;
      const dx = p.x - o.x;
      if (dx > 70 || dx < -70) continue;
      const gy = Game.terrain.heightAt(o.x);
      if (rectsOverlap(p.rect(), { x: o.x - o.w / 2, y: gy - o.h, w: o.w, h: o.h })) hitObstacle(p, o);
    }
  }
}

/* ------------------------------ finishing / results ------------------------------ */
function posKey(p) { return p.finished ? 500000 - (p.finishTime || 400) : p.distance; }
function computePosition() {
  if (Game.mode !== "single" && Game.posList && Game.net) {
    const me = Game.posList.find(e => e.id === Game.net.mySid);
    if (me) return me.p;
  }
  const racers = Game.players.slice().sort((a, b) => posKey(b) - posKey(a));
  return racers.indexOf(Game.local) + 1;
}
function checkFinishes() {
  const finishX = START_X + FINISH_DISTANCE;
  if (Game.state === "racing" && !Game.local.finished && Game.local.x >= finishX) {
    Game.local.finished = true;
    Game.local.finishTime = Game.raceTime;
    onLocalFinish();
  }
  for (const b of Game.bots) {
    if (!b.finished && b.x >= finishX) { b.finished = true; b.finishTime = Game.raceTime; }
  }
}
function onLocalFinish() {
  Game.sfx.play("finish");
  const colors = ["#f3d34a", "#6ee7a8", "#4fd6ff"];
  for (let i = 0; i < 3; i++) {
    Game.particles.emit(Game.local.x, Game.local.y - 30, 14, colors[i],
      { spread: 160, speed: 260, life: 0.9, size: 3, gravity: 400 });
  }
  if (Game.mode !== "single") {
    Game.waiting = true;
    Game.net.sendFinish({
      time: Game.raceTime,
      distance: Math.round(Game.local.distance * UNIT_TO_M),
      coins: Game.local.coins,
      fuel: Math.round(Game.local.fuel),
    });
  }
}
function buildStandingsEntries() {
  const finishers = Game.players.filter(p => p.finished).sort((a, b) => a.finishTime - b.finishTime);
  const rest = Game.players.filter(p => !p.finished).sort((a, b) => b.distance - a.distance);
  const standings = finishers.concat(rest);
  standings.forEach((p, i) => { p.finalPlace = i + 1; });
  return standings.map(p => ({
    name: p.name, place: p.finalPlace, time: p.finished ? p.finishTime : null,
    distance: Math.round(p.distance * UNIT_TO_M), coins: p.coins, fuel: Math.round(p.fuel),
    score: computeScore(p.distance * UNIT_TO_M, p.coins, p.finalPlace, p.fuel), me: p === Game.local,
  }));
}
function endSingle(title) {
  if (Game.state === "done") return;
  Game.state = "done";
  const entries = buildStandingsEntries();
  const me = entries.find(e => e.me);
  const isBest = me && me.score > save.best;
  if (isBest) save.best = me.score;
  save.coins += me ? me.coins : 0;
  save.firstRun = false;
  persist();
  presentLeaderboard(title,
    `You finished ${fmtPlace(me.place)}${me.time != null ? " — " + fmtTime(me.time) : ""}` +
    (isBest ? " • NEW BEST!" : ` • Best: ${save.best.toLocaleString()}`),
    entries, "single");
}
function checkSingleRaceEnd(dt) {
  if (Game.state !== "racing" || Game.mode !== "single") return;
  if (Game.local.finished) Game.afterFinishTimer += dt;
  const allDone = Game.players.every(p => p.finished);
  if (allDone || Game.raceTime > RACE_TIMEOUT || (Game.local.finished && Game.afterFinishTimer > 10)) endSingle("RACE COMPLETE");
}
function hostHandleFinish(sid, data) {
  if (!Game.net.raceRoster.includes(sid)) return;
  if (Game.net.finishList.some(f => f.id === sid)) return;
  Game.net.finishList.push({ id: sid, time: data.time, distance: data.distance, coins: data.coins, fuel: data.fuel });
}
function checkHostRaceEnd(dt) {
  if (Game.state !== "racing" || Game.mode !== "host") return;
  const fl = Game.net.finishList;
  if (fl.length > 0 && !Game.hostEndStarted) Game.hostEndStarted = true;
  if (Game.hostEndStarted) Game.hostEndTimer += dt;
  const active = Game.net.raceRoster.filter(sid => Game.net.players.has(sid));
  const allFinished = active.length > 0 && active.every(sid => fl.some(f => f.id === sid));
  if (allFinished || (Game.hostEndStarted && Game.hostEndTimer > 45) || Game.raceTime > RACE_TIMEOUT) {
    hostCompileLeaderboard();
  }
}
function hostCompileLeaderboard() {
  if (Game.state === "done") return;
  Game.state = "done";
  Game.sfx.engineStop();
  Game.music.stop();
  const fl = Game.net.finishList.slice().sort((a, b) => a.time - b.time);
  const entries = [];
  let place = 1;
  for (const f of fl) {
    if (!Game.net.players.has(f.id)) continue;
    entries.push({ id: f.id, name: (Game.net.players.get(f.id) || {}).name || "Player",
      place, time: f.time, distance: f.distance, coins: f.coins, fuel: f.fuel,
      score: computeScore(f.distance, f.coins, place, f.fuel) });
    place++;
  }
  const unfinished = Game.net.raceRoster
    .filter(sid => !fl.some(f => f.id === sid) && Game.net.players.has(sid))
    .map(sid => ({ id: sid, name: (Game.net.players.get(sid) || {}).name || "Player", d: ((Game.net.lastStates.get(sid) || {}).d) || 0 }))
    .sort((a, b) => b.d - a.d);
  for (const r of unfinished) {
    const distM = Math.round(r.d * UNIT_TO_M);
    entries.push({ id: r.id, name: r.name, place, time: null, distance: distM, coins: 0, fuel: 0,
      score: computeScore(distM, 0, place, 0) });
    place++;
  }
  Game.net.broadcastLeaderboard(entries);
}
function checkGuestRaceEnd() {
  if (Game.state !== "racing" || Game.mode !== "guest") return;
  if (Game.raceTime > RACE_TIMEOUT + 10) {
    const racers = Game.players.slice().sort((a, b) => posKey(b) - posKey(a));
    const entries = racers.map((p, i) => ({
      id: p.sid || p.id, name: p.name, place: i + 1, time: p.finishTime != null ? p.finishTime : null,
      distance: Math.round(p.distance * UNIT_TO_M), coins: p.coins || 0, fuel: Math.round(p.fuel || 0),
      score: computeScore(Math.round(p.distance * UNIT_TO_M), p.coins || 0, i + 1, Math.round(p.fuel || 0)),
    }));
    presentLeaderboard("RESULTS (provisional)", "Waiting for the host to confirm final standings.", entries, "guest");
  }
}
function presentLeaderboard(title, sub, entries, mode) {
  Game.state = "done";
  Game.waiting = false;
  Game.sfx.engineStop();
  Game.music.stop();
  releaseWakeLock();
  hideOverlays();
  $("touchControls").classList.add("hidden");
  $("raceList").classList.add("hidden");
  $("resultTitle").textContent = title;
  $("resultSub").textContent = sub || "";
  const mine = entries.find(e => e.me);
  if (mine) {
    $("resultStats").innerHTML =
      `<span class="rs-chip">Place <b>${fmtPlace(mine.place)}</b></span>` +
      `<span class="rs-chip">Time <b>${mine.time != null ? fmtTime(mine.time) : "—"}</b></span>` +
      `<span class="rs-chip">Dist <b>${fmtDist(mine.distance || 0)}</b></span>` +
      `<span class="rs-chip">Coins <b>${mine.coins || 0}</b></span>` +
      `<span class="rs-chip">Fuel <b>${mine.fuel || 0}%</b></span>` +
      `<span class="rs-chip">Score <b>${Math.round(mine.score).toLocaleString()}</b></span>`;
  } else $("resultStats").innerHTML = "";
  const pod = $("podium");
  const p1 = entries.find(e => e.place === 1), p2 = entries.find(e => e.place === 2), p3 = entries.find(e => e.place === 3);
  if (p1) {
    const cols = [p2, p1, p3].filter(Boolean);
    pod.style.display = "flex";
    pod.innerHTML = cols.map(e =>
      `<div class="pod pod-${e.place}"><div class="medal">${e.place}</div>` +
      `<div class="pname">${escapeHtml(e.me ? "YOU" : e.name)}</div>` +
      `<div class="ptime">${e.time != null ? fmtTime(e.time) : fmtDist(e.distance || 0)}</div></div>`).join("");
  } else { pod.style.display = "none"; pod.innerHTML = ""; }
  const ul = $("resultBoard");
  ul.innerHTML = "";
  for (const e of entries) {
    if (p1 && e.place <= 3) continue;
    const li = document.createElement("li");
    if (e.me) li.className = "me";
    const detail = (e.time != null ? fmtTime(e.time) : fmtDist(e.distance || 0)) +
      " • " + (e.coins || 0) + " • " + Math.round(e.score).toLocaleString() + " pts";
    li.innerHTML = `<span class="lb-place">${fmtPlace(e.place)}</span>` +
      `<span class="lb-name">${escapeHtml(e.name)}${e.me ? ' <span class="you-tag">(you)</span>' : ""}</span>` +
      `<span class="lb-detail">${detail}</span>`;
    ul.appendChild(li);
  }
  $("btnResultAgain").classList.toggle("hidden", mode !== "single");
  $("btnResultLobby").classList.toggle("hidden", mode !== "host");
  $("overlay-result").classList.remove("hidden");
}

/* ------------------------------ camera / HUD / standings ------------------------------ */
function updateCamera(dt) {
  const p = Game.local;
  if (!p) return;
  Game.cam.x += (p.x - W * 0.35 - Game.cam.x) * Math.min(1, 6 * dt);
  Game.cam.y += (p.y - H * 0.55 - Game.cam.y) * Math.min(1, 4 * dt);
  const shakeMult = (save.reducedMotion || save.quality === "low") ? 0 : 1;
  Game.cam.shake = Math.max(0, Game.cam.shake - 3.5 * dt) * (Game.cam.shake > 0 ? 1 : 0);
  if (shakeMult === 0) Game.cam.shake = 0;
}
function updateRaceList() {
  const el = $("raceList");
  if (!el || Game.players.length < 2) return;
  let rows;
  if (Game.mode !== "single" && Game.posList) {
    rows = Game.posList.map(e => ({ sid: e.id, name: e.n, place: e.p, d: e.d, fin: e.f }));
  } else {
    const racers = Game.players.slice().sort((a, b) => posKey(b) - posKey(a));
    rows = racers.map((p, i) => ({
      sid: p.sid || p.id, name: p.name, place: i + 1,
      d: Math.round(p.distance * UNIT_TO_M), fin: p.finished ? 1 : 0,
    }));
  }
  const mySid = Game.net ? Game.net.mySid : "local";
  const leadD = rows.length ? rows[0].d : 0;
  const myIdx = rows.findIndex(r => r.sid === mySid);
  const row = (r) => {
    const me = r.sid === mySid;
    const gap = r.fin ? "✓ fin" : (r.place === 1 ? fmtDist(r.d) : "+" + fmtDist(Math.max(0, leadD - r.d)));
    return `<div class="rl-row${me ? " me" : ""}"><span class="rl-place">${r.place}</span>` +
      `<span class="rl-name">${escapeHtml(me ? "YOU" : (r.name || "?"))}</span><span class="rl-gap">${gap}</span></div>`;
  };
  let html = "";
  rows.slice(0, 5).forEach(r => { html += row(r); });
  if (myIdx >= 5) html += '<div class="rl-sep">⋯</div>' + row(rows[myIdx]);
  el.innerHTML = html;
}
function updateConnHud() {
  const chip = $("connChip"), ping = $("pingChip");
  if (Game.mode === "single" || !Game.net) { chip.textContent = "SOLO"; chip.className = "hud-chip hud-conn"; ping.textContent = "PING —"; ping.className = "ping-chip"; return; }
  const net = Game.net;
  let state = net.connState, rtt = net.rtt;
  if (state === "connected" && rtt > 180) state = "poor";
  const label = { connected: "ONLINE", connecting: "CONNECTING…", reconnecting: "RECONNECTING", disconnected: "OFFLINE", poor: "POOR CONN", offline: "OFFLINE" }[state] || state.toUpperCase();
  chip.textContent = label;
  chip.className = "hud-chip hud-conn " + (state === "connected" ? "ok" : state === "poor" ? "warn" : "bad");
  const isHost = net.isHost;
  const shown = isHost ? (Array.from(net.conns.values()).some(e => e.conn.open) ? Math.max(1, rtt || 1) : 1) : rtt;
  if (!shown || state === "reconnecting") { ping.textContent = (isHost ? "HOST" : "PING —"); ping.className = "ping-chip"; }
  else {
    ping.textContent = "PING " + shown + " ms";
    ping.className = "ping-chip " + (shown < 80 ? "good" : shown < 180 ? "fair" : "poor");
  }
}
function updateHud(dt) {
  Game.hudAcc += dt;
  if (Game.hudAcc < 0.1) return;
  Game.hudAcc = 0;
  const p = Game.local;
  if (!p) return;
  $("hudPos").textContent = fmtPlace(computePosition());
  $("hudSpeed").textContent = Math.abs(Math.round(p.vx * 0.36)) + " km/h";
  $("hudTime").textContent = fmtTime(Game.raceTime);
  const pct = clamp(p.fuel / p.fuelCap * 100, 0, 100);
  const bar = $("hudFuelBar");
  bar.style.width = pct + "%";
  bar.style.background = pct < 25 ? "#e6403c" : "";
  $("hudFuelPct").textContent = Math.round(pct) + "%";
  const pips = $("nitroPips").children;
  for (let i = 0; i < pips.length; i++) pips[i].className = "pip" + (i < p.nitroCharges ? " on" : "");
  $("hudDist").textContent = fmtDist(p.distance * UNIT_TO_M);
  $("hudScore").textContent = Math.floor(p.distance * UNIT_TO_M * 10 + p.coins * 10).toLocaleString();
  let warn = "";
  if (toastT > 0) warn = toastMsg;
  else if (Game.waiting) warn = "Finished! Waiting for the other players…";
  else if (Game.awaitingGo) warn = "Waiting for host GO…";
  else if (p.fuel <= 0 && !p.finished) warn = "OUT OF FUEL — coast to a pickup!";
  else if (pct < 20 && !p.finished) warn = "LOW FUEL";
  $("hudWarning").textContent = warn;
  updateConnHud();
  Game.listTick = (Game.listTick + 1) % 3;
  if (Game.listTick === 0) updateRaceList();
}
function setCountdown(v) {
  const ov = $("countdownOverlay"), el = $("countdownNum");
  ov.classList.remove("hidden");
  el.textContent = v;
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";
}

/* ------------------------------ main loop ------------------------------ */
function update(dt) {
  if (Game.state === "countdown") {
    Game.countdownT -= dt;
    const num = Math.ceil(Game.countdownT);
    if (num !== Game.lastCountNum && num > 0) {
      Game.lastCountNum = num;
      Game.sfx.play("countdown");
      setCountdown(num);
    }
    if (Game.countdownT <= 0) {
      if (Game.mode === "single") beginGo();
      else if (Game.countdownT < -6) { // failsafe: host died during countdown
        hudToast("Lost the host — returning to menu");
        setTimeout(goHome, 1200);
      }
    }
    for (const p of Game.players) if (p instanceof RacePlayer) p.update(dt, {}, Game.particles, null, false);
  } else {
    if (Game.goT > 0) {
      Game.goT -= dt;
      if (Game.goT <= 0) $("countdownOverlay").classList.add("hidden");
    }
    if (Game.state === "racing") Game.raceTime += dt;
    const raceStarted = Game.state === "racing";
    if (Game.hintT > 0) {
      Game.hintT -= dt;
      if (Game.hintT <= 0 && !isTouch) $("keyHints").classList.add("faded");
    }
    const inp = { accel: input.accel, brake: input.brake, left: input.left, right: input.right,
      nitro: nitroQueued, jump: jumpQueued };
    nitroQueued = false; jumpQueued = false;
    if (Game.local.finished) { inp.accel = false; inp.brake = true; inp.left = inp.right = false; }
    Game.local.update(dt, inp, Game.particles, Game.sfx, raceStarted);
    if (Game.local.shake) { Game.cam.shake = Math.max(Game.cam.shake, Game.local.shake); Game.local.shake = 0; }
    if (Game.mode === "single") {
      for (const b of Game.bots) {
        const bi = raceStarted && !b.finished ? botInput(b, dt) : { accel: false, brake: b.finished };
        b.update(dt, bi, Game.particles, null, raceStarted);
      }
    }
    for (const g of Game.ghosts.values()) {
      g.x = lerp(g.x, g.tx, Math.min(1, 10 * dt));
      g.y = lerp(g.y, g.ty, Math.min(1, 10 * dt));
      g.angle = lerp(g.angle, g.ta, Math.min(1, 10 * dt));
    }
    updateWorldInteractions(dt);
    checkFinishes();
    if (Game.state === "racing" && Game.mode === "single" && !Game.local.finished) {
      if (Game.local.fuel <= 0 && Math.abs(Game.local.vx) < 15) Game.stalledFor += dt;
      else Game.stalledFor = 0;
      if (Game.stalledFor > 5) { endSingle("OUT OF FUEL"); return; }
    }
    if (Game.mode === "single") checkSingleRaceEnd(dt);
    else if (Game.mode === "host") {
      checkHostRaceEnd(dt);
      Game.posAcc += dt; // authoritative standings every 0.5 s
      if (Game.posAcc >= 0.5) { Game.posAcc = 0; Game.net.broadcastPositions(); }
    }
    else checkGuestRaceEnd();
    if (Game.mode !== "single" && Game.net) {
      Game.netAcc += dt;
      if (Game.netAcc >= 1 / CONFIG.NET_SEND_HZ) {
        Game.netAcc = 0;
        Game.net.sendState({
          x: Math.round(Game.local.x), y: Math.round(Game.local.y),
          a: Math.round(Game.local.angle), v: Game.local.vehicleName,
          n: Game.local.nitroTimer > 0, f: Game.local.finished,
          d: Math.round(Game.local.distance),
        });
      }
    }
    Game.sfx.engineUpdate(Game.local.vx, raceStarted && input.accel && !Game.local.finished, Game.local.nitroTimer > 0);
  }
  if (toastT > 0) toastT -= dt;
  for (const b of Game.bubbles) b.t -= dt;
  Game.bubbles = Game.bubbles.filter(b => b.t > 0);
  Game.particles.update(dt);
  updateCamera(dt);
  updateHud(dt);
  if (DEBUG_MODE) updateDebug(dt);
}
function updateDebug(dt) {
  Game.dbgAcc += dt;
  Game.fpsAvg = Game.fpsAvg * 0.95 + (1 / Math.max(dt, 0.001)) * 0.05;
  if (Game.dbgAcc < 0.5) return;
  Game.dbgAcc = 0;
  const net = Game.net;
  $("debugPanel").innerHTML =
    `FPS ${Math.round(Game.fpsAvg)} · state ${Game.state}<br>` +
    `mode ${Game.mode || "—"} · room ${net ? net.roomCode : "—"} · sid ${net ? net.mySid : "—"}<br>` +
    `players ${net ? net.players.size : "—"} · conn ${net ? net.connState : "—"} · rtt ${net ? net.rtt : "—"}ms<br>` +
    `particles ${Game.particles.list.length} · quality ${save.quality}`;
}
function render() {
  if (!ctx || !Game.terrain) return;
  drawTerrain(ctx, Game.terrain, Game.cam.x, Game.cam.y, W, H);
  const sx = Game.cam.shake > 0 ? (Math.random() - 0.5) * Game.cam.shake * 14 : 0;
  const sy = Game.cam.shake > 0 ? (Math.random() - 0.5) * Game.cam.shake * 10 : 0;
  ctx.save();
  ctx.translate(sx, sy);
  drawScenery(ctx, Game.terrain, Game.cam.x, Game.cam.y, W, H, Game.mapName);
  drawRaceMarkers(ctx, Game.terrain, Game.cam.x, Game.cam.y, W);
  for (const o of Game.world.obstacles) drawObstacle(ctx, o, Game.cam.x, Game.cam.y, Game.terrain, W);
  for (const pk of Game.world.pickups) drawPickup(ctx, pk, Game.cam.x, Game.cam.y, Game.terrain, W);
  for (const g of Game.ghosts.values()) drawVehicle(ctx, g, Game.cam.x, Game.cam.y, 0.5);
  for (const b of Game.bots) drawVehicle(ctx, b, Game.cam.x, Game.cam.y, 1);
  if (Game.local) drawVehicle(ctx, Game.local, Game.cam.x, Game.cam.y, 1);
  drawEmoteBubbles(ctx, Game.cam.x, Game.cam.y);
  Game.particles.draw(ctx, Game.cam.x, Game.cam.y);
  ctx.restore();
}
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.033, (t - Game.lastT) / 1000 || 0.016);
  Game.lastT = t;
  if (Game.state === "menu" || !Game.terrain) return;
  if (!Game.paused) update(dt);
  render();
}

/* ------------------------------ pause / restart / nav ------------------------------ */
function buildPauseControls() {
  const el = $("pauseControls");
  if (isTouch) {
    el.innerHTML = `<div class="pc-note">Left: <b>GAS + BRAKE</b> · Right: <b>NOS + JUMP</b> · Center: tilt</div>`;
  } else {
    const rows = [
      ["W · ↑ · Num 8", "Gas"], ["S · ↓ · Num 2", "Brake / reverse"],
      ["A / D · Num 4 / 6", "Tilt mid-air"], ["Space", "Nitro boost"],
      ["J", "Jump"], ["Esc", "Pause"], ["R", "Restart"],
    ];
    el.innerHTML = rows.map(r => `<div class="pc-row"><kbd>${r[0]}</kbd><span>${r[1]}</span></div>`).join("");
  }
}
Game.togglePause = function () {
  if (Game.mode !== "single" || (Game.state !== "racing" && Game.state !== "countdown")) {
    if (Game.state === "racing" || Game.state === "countdown") hudToast("Pause is not available in multiplayer");
    return;
  }
  Game.paused = !Game.paused;
  $("pauseSub").textContent = Game.mapName + " • " + save.vehicle;
  if (Game.paused) buildPauseControls();
  $("overlay-pause").classList.toggle("hidden", !Game.paused);
  if (Game.paused) { Game.sfx.engineStop(); Game.music.stop(); }
  else { Game.sfx.engineStart(); Game.music.start(); }
};
Game.handleRestartKey = function () {
  if (Game.state === "menu") return;
  if (Game.mode === "single") {
    hideOverlays();
    Game.paused = false;
    startRace(Math.floor(Math.random() * 999999) + 1);
  } else hudToast("Only the host can start a new race (from the leaderboard)");
};
function goHome() {
  hideOverlays();
  $("touchControls").classList.add("hidden");
  $("raceList").classList.add("hidden");
  Game.sfx.engineStop();
  Game.music.stop();
  releaseWakeLock();
  Game.state = "menu";
  Game.paused = false;
  if (Game.net) { Game.net.destroy(); Game.net = null; }
  Game.mode = null;
  try { sessionStorage.removeItem("rr_room"); } catch (e) {}
  updateHomeStats();
  showScreen("screen-home");
}

/* ------------------------------ lazy loaders ------------------------------ */
let peerJsLoading = null;
function ensurePeerJs() {
  if (window.Peer) return Promise.resolve(true);
  if (peerJsLoading) return peerJsLoading;
  peerJsLoading = new Promise(res => {
    const s = document.createElement("script");
    s.src = "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js";
    s.onload = () => res(!!window.Peer);
    s.onerror = () => res(false);
    (document.head || document.documentElement).appendChild(s);
    setTimeout(() => res(!!window.Peer), 10000);
  });
  return peerJsLoading;
}
let qrLibLoading = null;
function ensureQrLib() {
  if (window.QRCode) return Promise.resolve(true);
  if (qrLibLoading) return qrLibLoading;
  qrLibLoading = new Promise(res => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
    s.onload = () => res(!!window.QRCode);
    s.onerror = () => res(false);
    (document.head || document.documentElement).appendChild(s);
    setTimeout(() => res(!!window.QRCode), 8000);
  });
  return qrLibLoading;
}

/* ------------------------------ QR / invite (never encodes the password) ------------------------------ */
function buildInviteUrl() {
  let base = location.href.split("?")[0].split("#")[0];
  return base + (base.includes("?") ? "&" : "?") + "room=" + Game.net.roomCode;
}
async function showQrOverlay() {
  if (!Game.net || !Game.net.roomCode) return;
  Game.sfx.play("click");
  $("qrBox").innerHTML = "";
  $("qrCodeText").textContent = Game.net.roomCode;
  const url = buildInviteUrl();
  $("qrUrl").textContent = url;
  $("overlay-qr").classList.remove("hidden");
  await ensureQrLib();
  if (window.QRCode) {
    try {
      new QRCode($("qrBox"), { text: url, width: 190, height: 190,
        correctLevel: window.QRCode.CorrectLevel ? window.QRCode.CorrectLevel.M : undefined });
    } catch (e) { $("qrBox").innerHTML = '<div class="status-text" style="color:#333">QR unavailable — use the link below.</div>'; }
  } else $("qrBox").innerHTML = '<div class="status-text" style="color:#333">QR unavailable — use the link below.</div>';
}
async function copyInviteLink() {
  Game.sfx.play("click");
  const url = buildInviteUrl();
  try {
    await navigator.clipboard.writeText(url);
    $("lobbyStatus").textContent = "Invite link copied — send it to a friend!";
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = url; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta);
      $("lobbyStatus").textContent = "Invite link copied — send it to a friend!";
    } catch (e2) { $("lobbyStatus").textContent = "Copy failed — use the QR popup link."; }
  }
}

/* ------------------------------ chat & emotes (client side) ------------------------------ */
function appendChat(msg) {
  const log = $("chatLog");
  if (!log) return;
  const div = document.createElement("div");
  const time = new Date(msg.ts || Date.now());
  const hh = String(time.getHours()).padStart(2, "0"), mm = String(time.getMinutes()).padStart(2, "0");
  if (msg.sys) {
    div.className = "c-line c-sys";
    div.textContent = hh + ":" + mm + " " + msg.text; // system text is host-generated, still rendered as text
  } else {
    div.className = "c-line";
    const b = document.createElement("b");
    b.textContent = msg.name;                     // user text via textContent — no XSS surface
    const pre = document.createElement("span");
    pre.className = "c-time"; pre.textContent = hh + ":" + mm + " ";
    div.appendChild(pre); div.appendChild(b);
    div.appendChild(document.createTextNode(": " + String(msg.text).slice(0, CONFIG.CHAT_MAX_LEN)));
  }
  log.appendChild(div);
  while (log.children.length > 60) log.removeChild(log.firstChild); // bounded
  log.scrollTop = log.scrollHeight;
}
function showEmoteBubble(sid, name, code) {
  Game.bubbles.push({ sid, text: code, t: 2.5 });
  if (currentScreen() === "screen-lobby") appendChat({ name, text: code, ts: Date.now() });
}
function buildEmoteRow() {
  const row = $("emoteRow");
  row.innerHTML = "";
  for (const code of EMOTES) {
    const b = document.createElement("button");
    b.className = "emote-btn-s";
    b.textContent = code;
    b.onclick = () => { if (Game.net) Game.net.sendEmote(code); };
    row.appendChild(b);
  }
  const panel = $("emotePanel");
  panel.innerHTML = "";
  for (const code of EMOTES) {
    const b = document.createElement("button");
    b.className = "emote-btn-s";
    b.style.pointerEvents = "auto";
    b.textContent = code;
    b.onclick = () => { if (Game.net) Game.net.sendEmote(code); panel.classList.add("hidden"); };
    panel.appendChild(b);
  }
}
function sendChatFromInput() {
  if (!Game.net) return;
  const el = $("chatInput");
  const text = el.value.trim();
  if (!text) return;
  Game.net.sendChat(text);
  el.value = "";
}

/* ------------------------------ multiplayer UI wiring ------------------------------ */
function setupNetCallbacks(net) {
  net.onPlayersChanged = (list) => { if (currentScreen() === "screen-lobby") renderLobbyPlayers(list); };
  net.onMapChanged = () => { if (currentScreen() === "screen-lobby") renderLobbyMap(); };
  net.onRoomCfg = (locked, hasPass) => { if (currentScreen() === "screen-lobby") renderLobbyBadges(locked, hasPass); };
  net.onRaceStart = (seed, mapName) => {
    Game.mode = net.isHost ? "host" : "guest";
    Game.mapName = mapName;
    Game.net = net;
    try { sessionStorage.setItem("rr_room", net.roomCode || ""); } catch (e) {}
    startRace(seed);
  };
  net.onGo = () => beginGo();
  net.onWorldUpdate = (sid, s) => {
    const g = Game.ghosts.get(sid);
    if (g && s) {
      g.tx = s.x; g.ty = s.y; g.ta = s.a;
      g.nitro = !!s.n; g.finished = !!s.f; g.distance = s.d || 0;
    }
  };
  net.onPositions = (list) => { Game.posList = list; };
  net.onPickup = (id, by) => onAuthoritativePickup(id, by);
  net.onChat = (msg) => appendChat(msg);
  net.onEmote = (e) => showEmoteBubble(e.sid, e.name, e.code);
  net.onLeaderboard = (list) => {
    for (const e of list) e.me = (e.id === net.mySid);
    const mine = list.find(e => e.me);
    if (mine) {
      if (mine.score > save.best) save.best = mine.score;
      save.coins += (mine.coins || 0);
      save.firstRun = false;
      persist();
    }
    presentLeaderboard("RACE COMPLETE",
      mine ? `You finished ${fmtPlace(mine.place)} — ${mine.time != null ? fmtTime(mine.time) : ""}` : "",
      list, net.isHost ? "host" : "guest");
  };
  net.onError = (msg) => {
    if (Game.state === "racing" || Game.state === "countdown") hudToast(String(msg).slice(0, 60));
    else if (currentScreen() === "screen-lobby") $("lobbyStatus").textContent = msg;
  };
  net.onConnState = () => { if (Game.state === "racing" || Game.state === "countdown") updateConnHud(); };
  net.onHostLeft = () => {
    Game.sfx.engineStop(); Game.music.stop();
    Game.state = "menu"; Game.paused = false;
    hideOverlays();
    $("touchControls").classList.add("hidden");
    net.destroy();
    Game.net = null; Game.mode = null;
    updateHomeStats();
    showScreen("screen-play");
    $("playStatus").textContent = "Connection lost — the host is no longer reachable.";
  };
  net.onKicked = (reason) => {
    Game.sfx.engineStop(); Game.music.stop();
    Game.state = "menu"; Game.paused = false;
    hideOverlays();
    $("touchControls").classList.add("hidden");
    net.destroy(); Game.net = null; Game.mode = null;
    updateHomeStats();
    showScreen("screen-home");
    hudToastSafe("You were removed from the room (" + reason + ").");
  };
  net.onReturnToLobby = () => {
    hideOverlays();
    $("touchControls").classList.add("hidden");
    Game.state = "menu";
    Game.sfx.engineStop(); Game.music.stop();
    enterLobby();
  };
  net._onGuestFinish = (sid, data) => hostHandleFinish(sid, data);
}
function hudToastSafe(msg) { alert(msg); } // rare, explicit user feedback path

function enterLobby() {
  showScreen("screen-lobby");
  const net = Game.net;
  const isHost = net.isHost;
  $("roomCodeBox").style.display = isHost ? "" : "none";
  $("inviteRow").style.display = isHost ? "" : "none";
  $("roomTools").classList.toggle("hidden", !isHost);
  if (isHost) $("roomCode").textContent = net.roomCode || "------";
  $("lobbyStatus").textContent = isHost
    ? "Share the QR / link / code. Start when everyone is in."
    : "Connected! Waiting for the host to start the race.";
  $("btnStartRace").classList.toggle("hidden", !isHost);
  renderLobbyPlayers(net._playerListArr());
  renderLobbyMap();
  renderLobbyVehicle();
  renderLobbyBadges(net.locked, !!net.password);
  $("chatLog").innerHTML = "";
  requestWakeLock();
}
function renderLobbyBadges(locked, hasPass) {
  const el = $("lobbyBadges");
  if (!el) return;
  el.innerHTML =
    (hasPass ? '<span class="badge">PASSWORD</span>' : '<span class="badge">PUBLIC</span>') +
    (locked ? '<span class="badge locked">LOCKED</span>' : '<span class="badge">OPEN</span>');
}
function renderLobbyPlayers(list) {
  const ul = $("lobbyPlayers");
  $("playerCount").textContent = `(${list.filter(p => p.disconnectedAt == null).length}/${CONFIG.MAX_PLAYERS})`;
  ul.innerHTML = "";
  const iAmHost = Game.net.isHost;
  for (const p of list) {
    const li = document.createElement("li");
    const you = p.sid === Game.net.mySid ? ' <span class="you-tag">you</span>' : "";
    const right = document.createElement("span");
    right.className = "pl-right";
    let txt = p.isHost ? "★ host" : (VEHICLES[p.vehicle] ? p.vehicle : "");
    if (p.disconnectedAt != null) txt = '<span class="recon">reconnecting…</span>';
    else if (!p.isHost && typeof p.ping === "number") txt += ` <span class="ping">${p.ping}ms</span>`;
    right.innerHTML = txt;
    const left = document.createElement("span");
    left.innerHTML = escapeHtml(p.name) + you;
    li.appendChild(left);
    if (iAmHost && !p.isHost && p.sid !== Game.net.mySid) {
      const acts = document.createElement("span");
      acts.className = "pl-act";
      const kb = document.createElement("button");
      kb.className = "mini-btn"; kb.title = "Kick"; kb.textContent = "✕";
      kb.onclick = () => { if (confirm("Kick " + p.name + "?")) Game.net.kick(p.sid); };
      const tb = document.createElement("button");
      tb.className = "mini-btn"; tb.title = "Make host"; tb.textContent = "★";
      tb.onclick = () => {
        if (confirm("Transfer host to " + p.name + " and leave?")) Game.net.transferHost(p.sid);
      };
      acts.appendChild(tb); acts.appendChild(kb);
      li.appendChild(acts);
    }
    li.appendChild(right);
    ul.appendChild(li);
  }
}
function renderLobbyMap() {
  const el = $("lobbyMap");
  el.innerHTML = "";
  if (Game.net.isHost) {
    for (const m of MAP_ORDER) {
      const d = document.createElement("div");
      d.className = "map-opt" + (Game.net.selectedMap === m ? " selected" : "");
      d.textContent = MAPS[m].label + " — " + MAPS[m].desc;
      d.onclick = () => { Game.net.setMap(m); renderLobbyMap(); Game.sfx.play("click"); };
      el.appendChild(d);
    }
  } else {
    const m = MAPS[Game.net.selectedMap] || MAPS.Highway;
    el.innerHTML = `<div class="map-select-readonly">${m.label} — ${m.desc} (chosen by host)</div>`;
  }
}
function renderLobbyVehicle() {
  const el = $("lobbyVehicle");
  el.innerHTML = "";
  const me = Game.net.players.get(Game.net.mySid);
  const cur = (me && me.vehicle) || save.vehicle;
  for (const v of Object.keys(VEHICLES)) {
    const d = document.createElement("div");
    d.className = "map-opt" + (cur === v ? " selected" : "");
    d.textContent = v + " — " + VEHICLES[v].desc;
    d.onclick = () => {
      Game.net.setMyVehicle(v);
      save.vehicle = v;
      persist();
      renderLobbyVehicle();
      renderLobbyPlayers(Game.net._playerListArr());
      Game.sfx.play("click");
    };
    el.appendChild(d);
  }
}

/* ------------------------------ menu builders ------------------------------ */
function buildVehicleScreen() {
  const grid = $("vehicleGrid");
  grid.innerHTML = "";
  for (const name of Object.keys(VEHICLES)) {
    const v = VEHICLES[name];
    const card = document.createElement("div");
    card.className = "vehicle-card" + (save.vehicle === name ? " selected" : "");
    card.innerHTML = `<canvas class="vshape" width="64" height="40"></canvas>` +
      `<div class="vinfo"><div class="vname">${name}</div><div class="vdesc">${v.desc}</div><div class="vstats">${v.stats}</div></div>`;
    const c2 = card.querySelector("canvas").getContext("2d");
    c2.save(); c2.translate(32, 22); c2.scale(0.72, 0.72);
    drawVehicleShape(c2, name, v.color, v.w, v.h);
    c2.restore();
    card.onclick = () => { save.vehicle = name; persist(); buildVehicleScreen(); Game.sfx.play("click"); };
    grid.appendChild(card);
  }
}
function buildMapScreen() {
  const grid = $("mapGrid");
  grid.innerHTML = "";
  for (const name of MAP_ORDER) {
    const m = MAPS[name];
    const card = document.createElement("div");
    card.className = "vehicle-card" + (save.map === name ? " selected" : "");
    card.innerHTML = `<canvas class="vshape" width="64" height="40"></canvas>` +
      `<div class="vinfo"><div class="vname">${m.label}</div><div class="vdesc">${m.desc}</div>` +
      `<div class="vstats">Gravity ${Math.round(m.gravity * 100)}% • Grip ${Math.round(m.traction * 100)}%${m.fuelMult > 1 ? " • Thirsty engines" : ""}</div></div>`;
    const c2 = card.querySelector("canvas").getContext("2d");
    const t = new Terrain(m, 12345);
    c2.fillStyle = m.sky[0]; c2.fillRect(0, 0, 64, 40);
    if (m.far) { c2.fillStyle = m.far; c2.fillRect(0, 26, 64, 14); }
    c2.fillStyle = m.ground;
    c2.beginPath(); c2.moveTo(0, 40);
    for (let sx = 0; sx <= 64; sx += 2) {
      const wy = t.heightAt(sx / 64 * 4000);
      c2.lineTo(sx, clamp((wy - (m.base - m.amp * 2)) / (m.amp * 4) * 30 + 10, 8, 38));
    }
    c2.lineTo(64, 40); c2.closePath(); c2.fill();
    c2.strokeStyle = m.accent; c2.lineWidth = 1.5; c2.stroke();
    card.onclick = () => { save.map = name; persist(); buildMapScreen(); Game.sfx.play("click"); };
    grid.appendChild(card);
  }
}
function updateHomeStats() {
  $("homeStats").textContent =
    `Best ${save.best.toLocaleString()} pts • ${save.coins.toLocaleString()} coins • ${save.vehicle} on ${save.map}`;
}
function updateSettingsUI() {
  $("btnMusicToggle").textContent = save.music ? "ON" : "OFF";
  $("btnSoundToggle").textContent = save.sound ? "ON" : "OFF";
  $("btnQuality").textContent = save.quality.toUpperCase();
  $("btnVibToggle").textContent = save.vibration ? "ON" : "OFF";
  $("btnMotionToggle").textContent = save.reducedMotion ? "ON" : "OFF";
  $("btnPedalsToggle").textContent = save.pedals ? "ON" : "OFF";
  $("settingsBest").textContent = save.best.toLocaleString();
  $("settingsCoins").textContent = save.coins.toLocaleString();
  applyPedalStyle();
}
function applyPedalStyle() {
  const s = (parseInt($("pedalSize").value, 10) || 100) / 100;
  const o = (parseInt($("pedalOpacity").value, 10) || 90) / 100;
  document.documentElement.style.setProperty("--pedal-scale", s);
  document.documentElement.style.setProperty("--pedal-opacity", o);
}

/* ------------------------------ feedback (honest: mailto, no fake server) ------------------------------ */
function feedbackValidate() {
  const msg = $("fbMsg").value.trim();
  if (msg.length < 10) return { ok: false, err: "Message must be at least 10 characters." };
  if (msg.length > 1000) return { ok: false, err: "Message too long (max 1000)." };
  return { ok: true, msg };
}
function feedbackBody() {
  return `Category: ${$("fbCategory").value}\nRating: ${$("fbRating").value}/5\n` +
    `Message:\n${feedbackValidate().msg}\n\nContact: ${$("fbContact").value.trim() || "—"}\n` +
    `App: ROAD RUSH web · ${new Date().toISOString()}`;
}
function submitFeedback() {
  const v = feedbackValidate();
  if (!v.ok) { $("fbStatus").textContent = v.err; return; }
  Game.sfx.play("click");
  try {
    const log = JSON.parse(localStorage.getItem("rr_feedback") || "[]");
    log.push({ cat: $("fbCategory").value, rating: $("fbRating").value, msg: v.msg, ts: Date.now() });
    while (log.length > 20) log.shift();
    localStorage.setItem("rr_feedback", JSON.stringify(log));
  } catch (e) {}
  if (FEEDBACK_EMAIL === "you@example.com") {
    $("fbStatus").textContent = "Saved locally. Set FEEDBACK_EMAIL in game.js to enable email.";
    return;
  }
  const url = "mailto:" + FEEDBACK_EMAIL +
    "?subject=" + encodeURIComponent("[ROAD RUSH] " + $("fbCategory").value) +
    "&body=" + encodeURIComponent(feedbackBody());
  window.location.href = url;
  $("fbStatus").textContent = "Opening your email app…";
}

/* ------------------------------ input (WASD + arrows + numpad 8/4/6/2) ------------------------------ */
window.addEventListener("keydown", (e) => {
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
  const k = e.key;
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(k)) e.preventDefault();
  if (k === "w" || k === "W" || k === "ArrowUp" || k === "8") input.accel = true;
  else if (k === "s" || k === "S" || k === "ArrowDown" || k === "2") input.brake = true;
  else if (k === "a" || k === "A" || k === "ArrowLeft" || k === "4") input.left = true;
  else if (k === "d" || k === "D" || k === "ArrowRight" || k === "6") input.right = true;
  else if ((k === " " || k === "n" || k === "N") && !e.repeat) nitroQueued = true;
  else if ((k === "j" || k === "J" || k === "x" || k === "X") && !e.repeat) jumpQueued = true;
  else if (k === "Escape") Game.togglePause();
  else if ((k === "r" || k === "R") && Game.state !== "menu") Game.handleRestartKey();
});
window.addEventListener("keyup", (e) => {
  const k = e.key;
  if (k === "w" || k === "W" || k === "ArrowUp" || k === "8") input.accel = false;
  else if (k === "s" || k === "S" || k === "ArrowDown" || k === "2") input.brake = false;
  else if (k === "a" || k === "A" || k === "ArrowLeft" || k === "4") input.left = false;
  else if (k === "d" || k === "D" || k === "ArrowRight" || k === "6") input.right = false;
});
window.addEventListener("blur", () => { input.accel = input.brake = input.left = input.right = false; });

function bindPedal(el, down, up) {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    el.classList.add("pressed");
    down();
  });
  const release = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    el.classList.remove("pressed");
    if (up) up();
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);
  el.addEventListener("pointerleave", release);
  el.addEventListener("lostpointercapture", release);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

/* ------------------------------ init ------------------------------ */
function init() {
  loadSave();
  ctx = $("raceCanvas").getContext("2d");
  resizeCanvas();
  Game.sfx.enabled = save.sound;
  Game.music.probeExternal();
  buildVehicleScreen();
  buildMapScreen();
  buildEmoteRow();
  updateHomeStats();
  updateSettingsUI();
  $("inpName").value = save.name;
  $("pedalSize").value = save.pedalSizeVal || 100;
  $("pedalOpacity").value = save.pedalOpVal || 90;

  // ?debug diagnostics + ?room=CODE invite links
  try {
    const qp = new URLSearchParams(location.search);
    DEBUG_MODE = qp.has("debug");
    pendingRoom = (qp.get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || null;
  } catch (e) { pendingRoom = null; }
  $("debugPanel").classList.toggle("hidden", !DEBUG_MODE);
  if (pendingRoom) {
    showScreen("screen-play");
    $("playStatus").textContent = `Invited to room ${pendingRoom} — enter your name, then JOIN ROOM.`;
  }

  bindPedal($("btnGas"), () => input.accel = true, () => input.accel = false);
  bindPedal($("btnBrake"), () => input.brake = true, () => input.brake = false);
  bindPedal($("btnTiltL"), () => input.left = true, () => input.left = false);
  bindPedal($("btnTiltR"), () => input.right = true, () => input.right = false);
  bindPedal($("btnJump"), () => jumpQueued = true, null);
  bindPedal($("btnNitro"), () => nitroQueued = true, null);

  $("btnPlay").onclick = () => { Game.sfx.play("click"); $("playStatus").textContent = ""; showScreen("screen-play"); };
  $("btnVehicle").onclick = () => { Game.sfx.play("click"); buildVehicleScreen(); showScreen("screen-vehicle"); };
  $("btnVehicleBack").onclick = () => { Game.sfx.play("click"); updateHomeStats(); showScreen("screen-home"); };
  $("btnMap").onclick = () => { Game.sfx.play("click"); buildMapScreen(); showScreen("screen-map"); };
  $("btnMapBack").onclick = () => { Game.sfx.play("click"); updateHomeStats(); showScreen("screen-home"); };
  $("btnHowTo").onclick = () => { Game.sfx.play("click"); showScreen("screen-howto"); };
  $("btnHowToBack").onclick = () => { Game.sfx.play("click"); showScreen("screen-home"); };
  $("btnFeedback").onclick = () => { Game.sfx.play("click"); $("fbStatus").textContent = ""; showScreen("screen-feedback"); };
  $("btnFbBack").onclick = () => { Game.sfx.play("click"); showScreen("screen-home"); };
  $("btnFbSubmit").onclick = submitFeedback;
  $("btnFbCopy").onclick = async () => {
    const v = feedbackValidate();
    if (!v.ok) { $("fbStatus").textContent = v.err; return; }
    try { await navigator.clipboard.writeText(feedbackBody()); $("fbStatus").textContent = "Copied to clipboard."; }
    catch (e) { $("fbStatus").textContent = "Copy failed — select and copy manually."; }
  };
  $("btnPlayBack").onclick = () => { Game.sfx.play("click"); updateHomeStats(); showScreen("screen-home"); };

  $("btnJoinMenu").onclick = () => {
    Game.sfx.play("click");
    const v = validateName($("inpName").value);
    if (!v.ok) { $("playStatus").textContent = v.reason; return; }
    save.name = v.name; persist();
    $("inpName").value = v.name;
    $("joinStatus").textContent = ""; $("joinError").textContent = ""; $("inpRoomCode").value = "";
    showScreen("screen-join");
    if (pendingRoom) {
      $("inpRoomCode").value = pendingRoom;
      const code = pendingRoom;
      pendingRoom = null;
      setTimeout(() => { if ($("inpRoomCode").value === code) $("btnJoinConnect").click(); }, 400);
    }
  };
  $("btnJoinBack").onclick = () => { Game.sfx.play("click"); showScreen("screen-play"); };
  $("btnSettings").onclick = () => { Game.sfx.play("click"); updateSettingsUI(); showScreen("screen-settings"); };
  $("btnSettingsBack").onclick = () => { Game.sfx.play("click"); updateHomeStats(); showScreen("screen-home"); };
  $("btnMusicToggle").onclick = () => {
    save.music = !save.music; Game.music.setEnabled(save.music);
    persist(); updateSettingsUI(); Game.sfx.play("click");
  };
  $("btnSoundToggle").onclick = () => {
    save.sound = !save.sound; Game.sfx.enabled = save.sound;
    persist(); updateSettingsUI(); Game.sfx.play("click");
  };
  $("btnQuality").onclick = () => {
    const order = ["auto", "low", "medium", "high"];
    save.quality = order[(order.indexOf(save.quality) + 1) % order.length];
    persist(); updateSettingsUI(); Game.sfx.play("click");
  };
  $("btnVibToggle").onclick = () => { save.vibration = !save.vibration; persist(); updateSettingsUI(); Game.sfx.play("click"); };
  $("btnMotionToggle").onclick = () => {
    save.reducedMotion = !save.reducedMotion;
    document.body.classList.toggle("no-motion", save.reducedMotion);
    persist(); updateSettingsUI(); Game.sfx.play("click");
  };
  $("btnPedalsToggle").onclick = () => { save.pedals = !save.pedals; persist(); updateSettingsUI(); Game.sfx.play("click"); };
  $("pedalSize").oninput = () => { save.pedalSizeVal = parseInt($("pedalSize").value, 10); persist(); applyPedalStyle(); };
  $("pedalOpacity").oninput = () => { save.pedalOpVal = parseInt($("pedalOpacity").value, 10); persist(); applyPedalStyle(); };
  $("btnResetSave").onclick = () => {
    save.best = 0; save.coins = 0;
    persist(); updateSettingsUI(); updateHomeStats();
    Game.sfx.play("click");
  };

  $("btnSingle").onclick = () => {
    Game.sfx.play("click");
    const v = validateName($("inpName").value);
    if (!v.ok) { $("playStatus").textContent = v.reason; return; }
    save.name = v.name; $("inpName").value = v.name; persist();
    Game.mode = "single";
    Game.net = null;
    Game.mapName = save.map;
    startRace(Math.floor(Math.random() * 999999) + 1);
  };

  $("btnCreate").onclick = async () => {
    Game.sfx.play("click");
    const v = validateName($("inpName").value);
    if (!v.ok) { $("playStatus").textContent = v.reason; return; }
    save.name = v.name; $("inpName").value = v.name; persist();
    $("playStatus").textContent = "Creating room…";
    await ensurePeerJs();
    if (!window.Peer) {
      $("playStatus").textContent = "Multiplayer unavailable — the connection library could not load. Solo still works.";
      return;
    }
    const pass = prompt("Optional room password (leave empty for a public room):", "") || "";
    const net = new NetManager();
    setupNetCallbacks(net);
    try {
      await net.createRoom(save.name, pass);
      Game.net = net;
      Game.mode = "host";
      $("playStatus").textContent = "";
      enterLobby();
    } catch (e) {
      net.destroy();
      $("playStatus").textContent = e.message && e.message.startsWith("badname:")
        ? e.message.slice(8)
        : "Could not create a room — check your internet and try again.";
    }
  };

  $("btnJoinConnect").onclick = async () => {
    const code = $("inpRoomCode").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== CONFIG.CODE_LEN) { $("joinError").textContent = "Enter the " + CONFIG.CODE_LEN + "-character room code."; return; }
    Game.sfx.play("click");
    const v = validateName($("inpName").value);
    if (!v.ok) { $("joinError").textContent = v.reason; return; }
    save.name = v.name; $("inpName").value = v.name; persist();
    $("joinStatus").textContent = "Connecting…";
    $("joinError").textContent = "";
    await ensurePeerJs();
    if (!window.Peer) {
      $("joinStatus").textContent = "";
      $("joinError").textContent = "Multiplayer unavailable — the connection library could not load.";
      return;
    }
    const net = new NetManager();
    setupNetCallbacks(net);
    try {
      await net.joinRoom(code, save.name, $("inpRoomPass").value);
      Game.net = net;
      Game.mode = "guest";
      $("joinStatus").textContent = "";
      enterLobby();
    } catch (e) {
      net.destroy();
      const msg =
        e.message === "notfound" ? "Room not found — check the code, or the host may have left." :
        e.message === "full" ? "That room is full (" + CONFIG.MAX_PLAYERS + "/" + CONFIG.MAX_PLAYERS + ")." :
        e.message === "password" ? "Wrong password." :
        e.message === "locked" ? "Room is locked." :
        e.message === "name" ? "Username already in use." :
        e.message === "badname" ? "Invalid username." :
        e.message === "dupsession" ? "Already connected in another tab." :
        e.message === "toomany" ? "Too many attempts — wait a moment." :
        e.message === "timeout" ? "Connection timed out — check both devices' internet." :
        e.message === "network" ? "Network blocked the connection — try again or another network." :
        "Could not connect — check your internet.";
      $("joinStatus").textContent = "";
      $("joinError").textContent = msg;
    }
  };
  $("inpRoomCode").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnJoinConnect").click(); });
  $("inpName").addEventListener("blur", () => {
    const v = validateName($("inpName").value);
    $("nameHint").textContent = v.ok ? "✓ " + v.name.length + " characters" : v.reason;
  });
  $("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChatFromInput(); });
  $("btnChatSend").onclick = sendChatFromInput;
  $("btnChatToggle").onclick = () => { $("chatPanel").classList.toggle("collapsed"); };

  $("btnStartRace").onclick = () => { Game.sfx.play("click"); Game.net.startRace(); };
  $("btnLeaveLobby").onclick = () => { Game.sfx.play("click"); releaseWakeLock(); goHome(); };
  $("btnSetPass").onclick = () => {
    const pw = prompt("Room password (leave empty to remove):", "");
    if (pw === null) return;
    Game.net.setPassword(pw);
  };
  $("btnLockToggle").onclick = () => { Game.net.setLocked(!Game.net.locked); };
  $("btnCopyLink").onclick = () => copyInviteLink();
  $("btnShowQr").onclick = () => showQrOverlay();
  $("btnQrClose").onclick = () => { Game.sfx.play("click"); $("overlay-qr").classList.add("hidden"); };

  $("btnPause").onclick = () => Game.togglePause();
  $("btnEmote").onclick = () => { $("emotePanel").classList.toggle("hidden"); };
  $("btnResume").onclick = () => { Game.sfx.play("click"); Game.togglePause(); };
  $("btnRestart").onclick = () => { Game.sfx.play("click"); Game.handleRestartKey(); };
  $("btnQuit").onclick = () => { Game.sfx.play("click"); goHome(); };

  $("btnResultAgain").onclick = () => {
    Game.sfx.play("click");
    hideOverlays();
    startRace(Math.floor(Math.random() * 999999) + 1);
  };
  $("btnResultLobby").onclick = () => { Game.sfx.play("click"); Game.net.returnAllToLobby(); };
  $("btnResultHome").onclick = () => { Game.sfx.play("click"); goHome(); };

  window.addEventListener("resize", () => { resizeCanvas(); checkOrientation(); });
  window.addEventListener("orientationchange", () => setTimeout(checkOrientation, 200));
  checkOrientation();
  if (!pendingRoom) showScreen("screen-home");
  requestAnimationFrame(frame);
}

/* init() only runs in the real app DOM — tests.html loads this file without it. */
if (document.getElementById("raceCanvas")) init();
