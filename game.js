"use strict";
/* =====================================================================================
   ROAD RUSH — web edition
   Complete single-player + peer-to-peer multiplayer 2D hill-climb racer.
   - Terrain, pickups, obstacles: procedurally generated from a shared seed.
   - Graphics: canvas primitives only. Audio: WebAudio synthesis only.
   - Multiplayer: WebRTC data channels via PeerJS (star topology through the host).
     PeerJS's public broker is used ONLY for the initial handshake; all race data
     flows directly between browsers.
===================================================================================== */

/* ------------------------------ constants & helpers ------------------------------ */
const FINISH_DISTANCE = 24000;   // world units (1 unit = 0.1 m → 2400 m race)
const UNIT_TO_M = 0.1;
const GRAVITY_BASE = 1800;       // world units / s^2
const GROUND_FRICTION = 0.985;   // baseline, converted to dt-based below
const MAX_PLAYERS = 4;           // host + 3 guests (matches single player: you + 3 bots)
const NET_SEND_HZ = 15;          // own-state broadcast rate
const RACE_TIMEOUT = 240;        // hard race time limit (s)
const START_X = 120;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function fmtTime(t) { const m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ":" + (s < 10 ? "0" : "") + s; }
function fmtPlace(n) { return n + (n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"); }
function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.floor(m) + " m"; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function hash01(n) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

// Deterministic seeded RNG (mulberry32): with the same seed every client
// generates identical terrain phases, pickups, and obstacles.
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

/* ------------------------------ maps ------------------------------ */
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

/* ------------------------------ vehicles ------------------------------ */
const VEHICLES = {
  Car:  { accel:620, maxSpeed:520, brake:780, mass:1.0, stability:0.8, fuelCap:100, fuelUse:4.5,
          color:"#d43c3c", w:62, h:26, drop:6, desc:"Balanced all-rounder.",
          stats:"Accel ●●●  Speed ●●●  Grip ●●●  Tank ●●●" },
  Bike: { accel:820, maxSpeed:640, brake:700, mass:0.6, stability:0.45, fuelCap:80, fuelUse:3.5,
          color:"#3c82d2", w:48, h:22, drop:4, desc:"Fast, but flips easily.",
          stats:"Accel ●●●●  Speed ●●●●  Grip ●  Tank ●●" },
  Bus:  { accel:460, maxSpeed:410, brake:650, mass:1.6, stability:1.0, fuelCap:140, fuelUse:5.2,
          color:"#e6be3c", w:84, h:34, drop:7, desc:"Slow, heavy, very stable.",
          stats:"Accel ●  Speed ●●  Grip ●●●●  Tank ●●●●" },
};

/* ------------------------------ persistence (localStorage, corrupt-safe) ------------------------------ */
const SAVE_KEY = "roadrush_save_v1";
const save = { name: "Player", vehicle: "Car", map: "Highway", sound: true, best: 0, coins: 0 };
function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return;
    if (typeof obj.name === "string" && obj.name) save.name = obj.name.slice(0, 12);
    if (VEHICLES[obj.vehicle]) save.vehicle = obj.vehicle;
    if (MAPS[obj.map]) save.map = obj.map;
    if (typeof obj.sound === "boolean") save.sound = obj.sound;
    if (typeof obj.best === "number" && isFinite(obj.best)) save.best = Math.max(0, Math.floor(obj.best));
    if (typeof obj.coins === "number" && isFinite(obj.coins)) save.coins = Math.max(0, Math.floor(obj.coins));
  } catch (e) { /* corrupt or unavailable save: keep defaults */ }
}
function persist() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) {} }

/* ------------------------------ procedural terrain ------------------------------
   heightAt(x) = base + Σ amp_k * sin(x * freq_k + phase_k). The four phases come
   from the seeded RNG, so the same seed ⇒ the same road on every client. The first
   300 units are flattened (h *= x/300) so everyone starts on level ground.        */
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

/* Deterministic pickups + obstacles from the same seed (different mixer constant). */
function generateWorldObjects(terrain, seed, length) {
  const rng = mulberry32((seed ^ 0xC0FFEE) >>> 0);
  const pickups = [], obstacles = [];
  let x = 600;
  while (x < length - 400) {
    x += 150 + rng() * 130;
    const roll = rng();
    if (roll < 0.17) pickups.push({ x, kind: "fuel", taken: false, bob: rng() * 6.28 });
    else if (roll < 0.30) pickups.push({ x, kind: "nitro", taken: false, bob: rng() * 6.28 });
    else if (roll < 0.58) pickups.push({ x, kind: "coin", taken: false, bob: rng() * 6.28 });
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
      // Traffic moves as a deterministic function of race time (o.x0 + v*t),
      // so every client agrees on its position without syncing it.
      obstacles.push({ x, x0: x, kind, w, h, v: kind === "traffic" ? -(70 + rng() * 50) : 0, cd: 0 });
    }
  }
  return { pickups, obstacles };
}

/* ------------------------------ particles ------------------------------ */
class ParticleSystem {
  constructor() { this.list = []; }
  emit(x, y, n, color, opts = {}) {
    if (this.list.length > 350) n = Math.min(n, 2); // hard cap for low-end devices
    const speed = opts.speed || 140, spread = opts.spread || 100, life = opts.life || 0.5,
          size = opts.size || 3, gravity = opts.gravity != null ? opts.gravity : 800;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * 6.283;
      const spd = speed * (0.3 + Math.random() * 0.7);
      this.list.push({
        x, y, vx: Math.cos(ang) * spd * (spread / 120), vy: Math.sin(ang) * spd - 60,
        life: life * (0.6 + Math.random() * 0.6), maxLife: life, color, size, gravity,
      });
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
      ctx.beginPath();
      ctx.arc(p.x - camX, p.y - camY, Math.max(1, p.size * a), 0, 6.283);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

/* ------------------------------ audio (WebAudio synthesis, no files) ------------------------------ */
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
      click:     { f: 880,  d: 0.06, type: "square",   g: 0.12 },
      countdown: { f: 520,  d: 0.15, type: "square",   g: 0.18 },
      go:        { f: 1046, d: 0.25, type: "square",   g: 0.22 },
      pickup:    { f: 1200, d: 0.12, type: "sine",     g: 0.18 },
      fuel:      { f: 700,  d: 0.15, type: "sine",     g: 0.18 },
      nitro:     { f: 300,  d: 0.35, type: "sawtooth", g: 0.18 },
      collision: { f: 120,  d: 0.2,  type: "square",   g: 0.22 },
      finish:    { f: 880,  d: 0.5,  type: "square",   g: 0.22 },
      coin:      { f: 1500, d: 0.08, type: "sine",     g: 0.14 },
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
    } catch (e) { /* audio is optional — never crash for it */ }
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
    this.engine.osc.frequency.setTargetAtTime(
      55 + Math.abs(speed) * 0.22 + (nitro ? 70 : 0), this.ctx.currentTime, 0.08);
  }
  engineStop() {
    if (this.engine) { try { this.engine.osc.stop(); } catch (e) {} this.engine = null; }
  }
}

/* ------------------------------ vehicle physics ------------------------------
   Arcade model: point mass + heading angle.
   - Grounded: throttle/brake change vx, slope gravity pulls vx downhill, a
     dt-corrected traction multiplier bleeds speed (Snow keeps ~2x more momentum),
     and the angle eases toward the terrain slope ("suspension" feel).
   - Airborne: gravity on vy, A/D apply angular velocity for flips and landings.
   - Landing: crash check from impact speed × angle mismatch × (1.2 - stability),
     plus an automatic crash if landing near-upside-down. Crashes stun briefly
     and cut speed — they never end the race.
   - Fuel: drains only while accelerating (× vehicle use × map multiplier × slope
     effort). Empty fuel cuts engine power to 15% instead of ending the race.   */
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
    this.name = opts.name || "Player";
    this.isRemote = !!opts.isRemote;
    this.isBot = !!opts.isBot;

    this.x = START_X;
    this.y = terrain.heightAt(this.x) - this.h / 2 - this.wheelDrop;
    this.vx = 0; this.vy = 0;
    this.angle = 0; this.angVel = 0;
    this.onGround = true; this.airtime = 0;

    this.fuel = this.fuelCap;
    this.nitroCharges = 0; this.maxNitro = 3; this.nitroTimer = 0;
    this.coins = 0; this.distance = 0;
    this.finished = false; this.finishTime = null;
    this.stunned = 0; this.shake = 0; this._dustCd = 0;
  }

  useNitro(particles, sfx) {
    if (this.nitroCharges > 0 && this.nitroTimer <= 0) {
      this.nitroCharges -= 1;
      this.nitroTimer = 2.0; // ~2 s boost
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
      input = { accel: false, brake: false, left: false, right: false, nitro: false };
    }
    let { accel, brake, left, right, nitro } = input;
    if (!raceStarted) { accel = brake = left = right = nitro = false; }

    if (nitro && raceStarted) this.useNitro(particles, sfx);
    if (this.nitroTimer > 0) this.nitroTimer -= dt;
    const nitroBoost = this.nitroTimer > 0 ? 1.55 : 1.0;

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
        else this.vx -= this.accelPower * 0.5 * dt; // reverse
      }
      // dt-corrected traction: lower map traction ⇒ less speed bleed ⇒ sliding
      const frameF = GROUND_FRICTION + (1 - GROUND_FRICTION) * (1 - t.def.traction);
      this.vx *= Math.pow(frameF, dt * 60);
      this.vx -= slope * gravity * dt * 0.5; // slope pulls you downhill
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

    if (this.onGround) {
      this.vy = 0;
      this.y = groundY - this.h / 2 - this.wheelDrop;
    } else {
      this.vy += gravity * dt;
      this.y += this.vy * dt;
    }

    this.x += this.vx * dt;
    if (this.x < 60) { this.x = 60; if (this.vx < 0) this.vx = 0; } // start wall
    this.distance = Math.max(this.distance, this.x - START_X);

    // ground snap + landing resolution
    const gy = t.heightAt(this.x) - this.h / 2 - this.wheelDrop;
    if (this.y >= gy) {
      const wasAirborne = !this.onGround;
      this.y = gy;
      if (wasAirborne) {
        const impact = Math.abs(this.vy);
        this.vy = 0;
        const angleOff = Math.abs(this.angle - slopeDeg);
        const crashChance = (impact / 1400) * (angleOff / 45) * (1.2 - this.stability);
        if ((crashChance > 0.55 && this.airtime > 0.25) || angleOff > 110) {
          this._crash(particles, sfx);
        } else {
          particles.emit(this.x, this.y + this.h / 2, 5, t.def.dust,
            { spread: 60, speed: 90, life: 0.3, size: 2, gravity: 500 });
        }
      }
      this.onGround = true; this.airtime = 0;
    } else {
      this.onGround = false;
    }
    this.angle = ((this.angle + 180) % 360 + 360) % 360 - 180;

    // rolling dust while accelerating
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
    particles.emit(this.x, this.y, 14, "#ff8c28",
      { spread: 140, speed: 180, life: 0.5, size: 3, gravity: 700 });
    this.vx *= 0.35;
    this.stunned = 0.5;
    this.shake = 1;
    this.angle = clamp(this.angle, -35, 35);
  }

  rect() { return { x: this.x - this.w / 2, y: this.y - this.h / 2, w: this.w, h: this.h }; }
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/* ------------------------------ scoring ------------------------------
   Transparent formula: distance(m)*10 + coins*10 + fuelRemaining*2 + place bonus. */
const PLACE_BONUS = { 1: 1000, 2: 700, 3: 400, 4: 200 };
function computeScore(distanceM, coins, place, fuelRemaining) {
  let s = distanceM * 10 + coins * 10 + fuelRemaining * 2;
  if (PLACE_BONUS[place]) s += PLACE_BONUS[place];
  return Math.round(s);
}

/* ------------------------------ networking ------------------------------
   Star topology: all guests connect to the host; the host relays peer state.
   Messages are tiny and event-driven except 15 Hz "state" updates:
     guest → host: {t:'state', s:{x,y,a,v,n,f,d}}
     host → all:   {t:'peerstate', id, s} (relayed, excluding the sender)
   Race start carries the shared seed so terrain/pickups/obstacles match everywhere.
   The host compiles the final leaderboard from finish messages + last-known state. */
class NetManager {
  constructor() {
    this.peer = null; this.isHost = false; this.roomCode = null;
    this.myId = null; this.myName = "Player";
    this.conns = new Map();     // host: peerId → DataConnection
    this.hostConn = null;       // guest: connection to host
    this.players = new Map();   // id → {id, name, vehicle, ready, isHost}
    this.selectedMap = "Highway";
    this.raceRoster = []; this.finishList = []; this.lastStates = new Map();
    this._joinSettle = null;
    // callbacks (assigned by the Game)
    this.onPlayersChanged = null; this.onMapChanged = null; this.onRaceStart = null;
    this.onWorldUpdate = null; this.onLeaderboard = null; this.onError = null;
    this.onHostLeft = null; this.onReturnToLobby = null;
    this._onGuestFinish = null;
  }

  _makeRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  createRoom(name) {
    return new Promise((resolve, reject) => {
      if (!window.Peer) { reject(new Error("no-peerjs")); return; }
      this.myName = name || "Host";
      this.isHost = true;
      this._createWithRetry(0, resolve, reject);
    });
  }

  _createWithRetry(attempt, resolve, reject) {
    const code = this._makeRoomCode();
    let settled = false;
    try { this.peer = new Peer("roadrush-" + code, { debug: 0 }); }
    catch (e) { reject(e); return; }
    this.peer.on("error", (err) => {
      if (settled) return;
      // 5-char codes can collide on the public broker — just pick another
      if (err && err.type === "unavailable-id" && attempt < 4) {
        settled = true;
        try { this.peer.destroy(); } catch (e2) {}
        this._createWithRetry(attempt + 1, resolve, reject);
        return;
      }
      settled = true;
      reject(err);
    });
    this.peer.on("open", (id) => {
      if (settled) return;
      settled = true;
      this.roomCode = code; this.myId = id;
      this.players.set(id, { id, name: this.myName, vehicle: save.vehicle, ready: true, isHost: true });
      resolve(code);
    });
    this.peer.on("connection", (conn) => this._handleIncoming(conn));
    this.peer.on("disconnected", () => {
      if (this.onError) this.onError("Lost the signaling service — new players can't join, but the race continues.");
    });
  }

  _handleIncoming(conn) {
    conn.on("open", () => {
      this.conns.set(conn.peer, conn);
      conn.on("data", (data) => this._handleGuestMessage(conn, data));
    });
    conn.on("close", () => this._removePlayer(conn.peer));
    conn.on("error", () => this._removePlayer(conn.peer));
  }

  _removePlayer(id) {
    this.conns.delete(id);
    if (this.players.has(id)) {
      this.players.delete(id);
      this.lastStates.delete(id);
      this._emitPlayers();
      this.broadcast({ t: "players", list: this._playerListArr() });
      if (this.onError) this.onError("A player left the room.");
    }
  }

  _handleGuestMessage(conn, data) {
    if (!data || !data.t) return;
    switch (data.t) {
      case "hello":
        if (this.players.size >= MAX_PLAYERS) { conn.send({ t: "full" }); return; }
        this.players.set(conn.peer, {
          id: conn.peer, name: (data.name || "Player").slice(0, 12),
          vehicle: VEHICLES[data.vehicle] ? data.vehicle : "Car", ready: true, isHost: false,
        });
        this._emitPlayers();
        conn.send({ t: "welcome", map: this.selectedMap, players: this._playerListArr() });
        this.broadcast({ t: "players", list: this._playerListArr() }, conn.peer);
        break;
      case "vehicle": {
        const p = this.players.get(conn.peer);
        if (p && VEHICLES[data.vehicle]) {
          p.vehicle = data.vehicle;
          this._emitPlayers();
          this.broadcast({ t: "players", list: this._playerListArr() });
        }
        break;
      }
      case "state":
        this.lastStates.set(conn.peer, data.s);
        if (this.onWorldUpdate) this.onWorldUpdate(conn.peer, data.s);
        this.broadcast({ t: "peerstate", id: conn.peer, s: data.s }, conn.peer);
        break;
      case "finish":
        if (this._onGuestFinish) this._onGuestFinish(conn.peer, data);
        break;
    }
  }

  _handleHostMessage(data) {
    if (!data || !data.t) return;
    switch (data.t) {
      case "welcome":
        this.selectedMap = data.map;
        this.players = new Map(data.players.map(p => [p.id, p]));
        if (this._joinSettle) { this._joinSettle.ok(); this._joinSettle = null; }
        if (this.onPlayersChanged) this.onPlayersChanged(data.players);
        if (this.onMapChanged) this.onMapChanged(data.map);
        break;
      case "players":
        this.players = new Map(data.list.map(p => [p.id, p]));
        if (this.onPlayersChanged) this.onPlayersChanged(data.list);
        break;
      case "map":
        this.selectedMap = data.map;
        if (this.onMapChanged) this.onMapChanged(data.map);
        break;
      case "start":
        if (this.onRaceStart) this.onRaceStart(data.seed, data.map);
        break;
      case "peerstate":
        if (this.onWorldUpdate) this.onWorldUpdate(data.id, data.s);
        break;
      case "leaderboard":
        if (this.onLeaderboard) this.onLeaderboard(data.list);
        break;
      case "lobby":
        if (this.onReturnToLobby) this.onReturnToLobby();
        break;
      case "full":
        if (this._joinSettle) { this._joinSettle.err("full"); this._joinSettle = null; }
        try { this.hostConn.close(); } catch (e) {}
        break;
    }
  }

  _playerListArr() { return Array.from(this.players.values()); }
  _emitPlayers() { if (this.onPlayersChanged) this.onPlayersChanged(this._playerListArr()); }

  setMap(mapName) {
    this.selectedMap = mapName;
    if (this.isHost) this.broadcast({ t: "map", map: mapName });
  }

  setMyVehicle(vehicle) {
    const me = this.players.get(this.myId);
    if (me) me.vehicle = vehicle;
    if (this.isHost) {
      this._emitPlayers();
      this.broadcast({ t: "players", list: this._playerListArr() });
    } else if (this.hostConn && this.hostConn.open) {
      this.hostConn.send({ t: "vehicle", vehicle });
    }
  }

  startRace() {
    if (!this.isHost) return;
    const seed = Math.floor(Math.random() * 999999) + 1; // shared by everyone
    this.raceRoster = this._playerListArr().map(p => p.id);
    this.finishList = [];
    this.lastStates.clear();
    this.broadcast({ t: "start", seed, map: this.selectedMap });
    if (this.onRaceStart) this.onRaceStart(seed, this.selectedMap);
  }

  sendState(s) {
    if (this.isHost) {
      this.lastStates.set(this.myId, s);
      if (this.onWorldUpdate) this.onWorldUpdate(this.myId, s);
      this.broadcast({ t: "peerstate", id: this.myId, s });
    } else if (this.hostConn && this.hostConn.open) {
      this.hostConn.send({ t: "state", s });
    }
  }

  sendFinish(payload) {
    if (this.isHost) {
      if (this._onGuestFinish) this._onGuestFinish(this.myId, payload);
    } else if (this.hostConn && this.hostConn.open) {
      this.hostConn.send(Object.assign({ t: "finish" }, payload));
    }
  }

  returnAllToLobby() {
    if (!this.isHost) return;
    this.broadcast({ t: "lobby" });
    if (this.onReturnToLobby) this.onReturnToLobby();
  }

  broadcastLeaderboard(list) {
    if (!this.isHost) return;
    this.broadcast({ t: "leaderboard", list });
    if (this.onLeaderboard) this.onLeaderboard(list);
  }

  broadcast(obj, excludeId) {
    for (const [id, conn] of this.conns) {
      if (id === excludeId) continue;
      if (conn.open) { try { conn.send(obj); } catch (e) {} }
    }
  }

  joinRoom(code, name) {
    return new Promise((resolve, reject) => {
      if (!window.Peer) { reject(new Error("no-peerjs")); return; }
      this.myName = name || "Player";
      this.isHost = false;
      const target = "roadrush-" + code.trim().toUpperCase();
      const settle = {
        ok: () => { if (!settle.done) { settle.done = true; clearTimeout(settle.to); resolve(code.trim().toUpperCase()); } },
        err: (m) => { if (!settle.done) { settle.done = true; clearTimeout(settle.to); reject(new Error(m)); } },
      };
      settle.to = setTimeout(() => settle.err("timeout"), 12000);
      this._joinSettle = settle;
      try { this.peer = new Peer(undefined, { debug: 0 }); }
      catch (e) { settle.err("network"); return; }
      this.peer.on("error", (err) => {
        if (err && err.type === "peer-unavailable") settle.err("notfound");
        else settle.err("network");
      });
      this.peer.on("open", (id) => {
        this.myId = id;
        const conn = this.peer.connect(target, { reliable: true });
        this.hostConn = conn;
        conn.on("open", () => conn.send({ t: "hello", name: this.myName, vehicle: save.vehicle }));
        conn.on("data", (data) => this._handleHostMessage(data));
        conn.on("close", () => {
          if (!settle.done) settle.err("closed");
          else if (this.onHostLeft) this.onHostLeft();
        });
      });
    });
  }

  destroy() {
    try { if (this.hostConn) this.hostConn.close(); } catch (e) {}
    for (const [, c] of this.conns) { try { c.close(); } catch (e) {} }
    try { if (this.peer) this.peer.destroy(); } catch (e) {}
    this.peer = null; this.hostConn = null;
    this.conns.clear(); this.players.clear(); this.lastStates.clear();
    this.raceRoster = []; this.finishList = [];
    this.isHost = false; this.roomCode = null; this._joinSettle = null;
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
  grad.addColorStop(0, def.sky[0]);
  grad.addColorStop(1, def.sky[1]);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  if (def.label === "Moon") {
    ctx.fillStyle = "#e8e8f2";
    for (let i = 0; i < 60; i++) {
      const sx = (i * 137.5) % W, sy = (i * 91.7) % (H * 0.65);
      ctx.fillRect(sx, sy, (i % 7 === 0) ? 2 : 1.4, (i % 7 === 0) ? 2 : 1.4);
    }
  } else if (def.label === "Snow") {
    ctx.fillStyle = "#ffffff";
    const t = performance.now() * 0.03;
    for (let i = 0; i < 30; i++) {
      const sx = ((i * 173 + t * (0.4 + (i % 3) * 0.3)) % (W + 40)) - 20;
      const sy = (i * 67 + t * 0.15) % H;
      ctx.beginPath(); ctx.arc(sx, sy, 1.8, 0, 6.283); ctx.fill();
    }
  } else if (def.label === "Desert") {
    ctx.fillStyle = "#fff2c8";
    ctx.beginPath(); ctx.arc(W * 0.78, H * 0.2, 34, 0, 6.283); ctx.fill();
  }

  if (def.far) { // parallax silhouette
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
  ctx.fillStyle = def.ground;
  ctx.fill();

  ctx.beginPath();
  ctx.strokeStyle = def.accent; ctx.lineWidth = 3;
  for (let sx = 0; sx <= W + step; sx += step) {
    const gy = terrain.heightAt(camX + sx) - camY + 4;
    if (sx === 0) ctx.moveTo(sx, gy); else ctx.lineTo(sx, gy);
  }
  ctx.stroke();

  if (def.label === "Highway") { // lane dashes
    ctx.fillStyle = "#e6d23c";
    const first = Math.floor(camX / 46) * 46;
    for (let wx = first; wx < camX + W + 46; wx += 46) {
      const gy = terrain.heightAt(wx) - camY + 9;
      ctx.save();
      ctx.translate(wx - camX, gy);
      ctx.rotate(Math.atan(terrain.slopeAt(wx)));
      ctx.fillRect(0, 0, 24, 3.5);
      ctx.restore();
    }
  }
}

function drawScenery(ctx, terrain, camX, camY, W, H, mapName) {
  const step = 230;
  const first = Math.floor((camX - 100) / step) * step;
  for (let wx = first; wx < camX + W + step; wx += step) {
    if (wx < 400) continue; // keep the start area clean
    const h1 = hash01(Math.floor(wx / step));
    if (h1 < 0.4) continue;
    const h2 = hash01(Math.floor(wx / step) + 7);
    const sx = wx - camX + (h1 - 0.5) * 60;
    const gy = terrain.heightAt(wx) - camY;
    if (gy < -100 || gy > H + 100) continue;
    if (mapName === "Highway") {
      if (h1 > 0.82) { // building
        const bh = 60 + h2 * 90, bw = 46 + h2 * 30;
        ctx.fillStyle = "#33404f";
        ctx.fillRect(sx - bw / 2, gy - bh, bw, bh);
        ctx.fillStyle = "#ffd97a";
        for (let r = 0; r < Math.floor(bh / 22); r++)
          for (let c = 0; c < 3; c++)
            if (hash01(r * 13 + c + Math.floor(wx / step)) > 0.55)
              ctx.fillRect(sx - bw / 2 + 6 + c * (bw - 12) / 3, gy - bh + 8 + r * 22, (bw - 18) / 4, 8);
      } else { // lamppost
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
      ctx.fillStyle = "#a08250";
      ctx.beginPath(); ctx.arc(sx, gy - 6, 8 + h2 * 6, 0, 6.283); ctx.fill();
    } else if (mapName === "Moon") {
      ctx.fillStyle = "#1c1c26";
      ctx.beginPath(); ctx.ellipse(sx, gy + 4, 16 + h2 * 14, 5, 0, 0, 6.283); ctx.fill();
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
  const stepU = 5000; // 500 m signs
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
    wheel(-w * 0.34, h * 0.30, 8);
    wheel(w * 0.34, h * 0.30, 8);
    ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-w * 0.34, h * 0.3); ctx.lineTo(-w * 0.05, -h * 0.1); ctx.lineTo(w * 0.34, h * 0.3); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-w * 0.05, -h * 0.1); ctx.lineTo(w * 0.16, h * 0.22); ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(w * 0.02, -h * 0.45, 5, 0, 6.283); ctx.fill(); // rider head
    ctx.fillRect(-w * 0.1, -h * 0.35, w * 0.28, h * 0.3);                  // rider body
  } else if (name === "Bus") {
    ctx.fillStyle = color; roundRect(ctx, -w / 2, -h / 2, w, h, 5); ctx.fill();
    ctx.fillStyle = "#b09220"; ctx.fillRect(-w / 2, h * 0.05, w, h * 0.18);
    ctx.fillStyle = "#cfe8fa";
    for (const fx of [-w * 0.34, -w * 0.13, w * 0.08, w * 0.29]) ctx.fillRect(fx, -h / 2 + 5, w * 0.15, h * 0.34);
    wheel(-w * 0.28, h * 0.42, 9); wheel(w * 0.28, h * 0.42, 9);
  } else { // Car
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
  if (p.nitroTimer > 0 || p.nitro === true) { // boost flame
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
    ctx.fillStyle = "#ffd73c";
    ctx.beginPath(); ctx.arc(x, cy, 9, 0, 6.283); ctx.fill();
    ctx.strokeStyle = "#b8860b"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, cy, 5.5, 0, 6.283); ctx.stroke();
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
    ctx.strokeStyle = "#4a3018"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x + 16, gy - 7.5, 3, 0, 6.283); ctx.stroke();
  } else if (o.kind === "cactus") {
    ctx.fillStyle = "#3c825a";
    ctx.fillRect(x - 5, gy - 30, 10, 30);
    ctx.fillRect(x - 14, gy - 22, 9, 6); ctx.fillRect(x - 14, gy - 22, 5, 10);
    ctx.fillRect(x + 5, gy - 26, 9, 6); ctx.fillRect(x + 9, gy - 26, 5, 12);
  } else if (o.kind === "ice") {
    ctx.fillStyle = "rgba(150,200,230,0.85)";
    roundRect(ctx, x - 14, gy - 24, 28, 24, 3); ctx.fill();
    ctx.strokeStyle = "#e8f4ff"; ctx.lineWidth = 1.5; ctx.stroke();
  } else { // rock / crater
    ctx.fillStyle = o.kind === "crater" ? "#74747c" : "#6e6e73";
    ctx.beginPath();
    ctx.moveTo(x - 15, gy); ctx.lineTo(x - 10, gy - 16); ctx.lineTo(x + 2, gy - 22);
    ctx.lineTo(x + 13, gy - 12); ctx.lineTo(x + 15, gy);
    ctx.closePath(); ctx.fill();
    if (o.kind === "crater") {
      ctx.fillStyle = "#3c3c44";
      ctx.beginPath(); ctx.ellipse(x, gy + 2, 14, 4, 0, 0, 6.283); ctx.fill();
    }
  }
}

/* ------------------------------ game state ------------------------------ */
let ctx = null, W = 0, H = 0;
const isTouch = (window.matchMedia && matchMedia("(pointer: coarse)").matches) || ("ontouchstart" in window);

const input = { accel: false, brake: false, left: false, right: false };
let nitroQueued = false;
let toastT = 0, toastMsg = "";

const Game = {
  mode: null,          // 'single' | 'host' | 'guest'
  state: "menu",       // menu | countdown | racing | done
  mapName: "Highway",
  terrain: null, world: null,
  players: [], local: null, bots: [], ghosts: new Map(),
  particles: new ParticleSystem(),
  sfx: new Sfx(),
  cam: { x: 0, y: 0, shake: 0 },
  raceTime: 0, countdownT: 0, goT: 0, lastCountNum: 4,
  finishCount: 0, afterFinishTimer: 0, stalledFor: 0,
  hostEndStarted: false, hostEndTimer: 0,
  waiting: false,
  net: null, netAcc: 0, hudAcc: 0,
  lastT: 0, paused: false,
};

const SCREENS = ["screen-home", "screen-play", "screen-vehicle", "screen-map",
                 "screen-join", "screen-lobby", "screen-settings", "screen-race"];
function showScreen(id) {
  for (const s of SCREENS) $(s).classList.add("hidden");
  if (id) $(id).classList.remove("hidden");
}
function currentScreen() {
  for (const s of SCREENS) if (!$(s).classList.contains("hidden")) return s;
  return null;
}
function hideOverlays() {
  ["overlay-pause", "overlay-result", "overlay-rotate"].forEach(o => $(o).classList.add("hidden"));
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
  const show = isTouch && portrait && currentScreen() === "screen-race";
  $("overlay-rotate").classList.toggle("hidden", !show);
}

/* ------------------------------ race setup ------------------------------ */
function startRace(seed) {
  const mapDef = MAPS[Game.mapName];
  Game.terrain = new Terrain(mapDef, seed);
  Game.world = generateWorldObjects(Game.terrain, seed, FINISH_DISTANCE + START_X + 800);
  Game.particles = new ParticleSystem();
  Game.raceTime = 0; Game.finishCount = 0; Game.afterFinishTimer = 0; Game.stalledFor = 0;
  Game.hostEndStarted = false; Game.hostEndTimer = 0;
  Game.waiting = false; toastT = 0;
  Game.countdownT = 3.0; Game.lastCountNum = 4; Game.goT = 0;
  Game.state = "countdown"; Game.paused = false;
  Game.cam = { x: START_X - W * 0.35, y: 0, shake: 0 };

  Game.local = new RacePlayer(save.vehicle, Game.terrain,
    { id: "local", name: save.name, fuelMult: mapDef.fuelMult });
  Game.players = [Game.local];
  Game.ghosts.clear();
  Game.bots = [];

  if (Game.mode === "single") {
    const botVehs = ["Car", "Bike", "Bus"].filter(n => n !== save.vehicle);
    const names = ["Rex", "Mia", "Zig"];
    for (let i = 0; i < 3; i++) {
      const skill = 0.88 + Math.random() * 0.13;
      const b = new RacePlayer(botVehs[i % 2], Game.terrain,
        { id: "bot" + i, name: names[i], isBot: true, fuelMult: mapDef.fuelMult });
      b.accelPower *= skill; b.maxSpeed *= skill; b.fuelUse *= 0.9;
      b.botTimer = 4 + Math.random() * 8;
      Game.bots.push(b);
      Game.players.push(b);
    }
  } else if (Game.net) {
    for (const p of Game.net._playerListArr()) {
      if (p.id === Game.net.myId) continue;
      const v = VEHICLES[p.vehicle] ? p.vehicle : "Car";
      Game.ghosts.set(p.id, {
        id: p.id, name: p.name, isRemote: true, vehicleName: v,
        color: VEHICLES[v].color, w: VEHICLES[v].w, h: VEHICLES[v].h,
        x: START_X, y: Game.terrain.heightAt(START_X) - VEHICLES[v].h / 2 - VEHICLES[v].drop,
        angle: 0, tx: START_X, ty: 0, ta: 0,
        nitro: false, finished: false, finishTime: null, distance: 0,
      });
      Game.players.push(Game.ghosts.get(p.id));
    }
  }

  showScreen("screen-race");
  hideOverlays();
  $("touchControls").classList.toggle("hidden", !isTouch);
  $("hudWarning").textContent = "";
  Game.sfx.engineStart();
}

/* ------------------------------ bot AI (single player) ------------------------------ */
function botInput(bot, dt) {
  const inp = { accel: false, brake: false, left: false, right: false, nitro: false };
  bot.stuckT = bot.stuckT || 0;
  bot.revT = bot.revT || 0;
  if (bot.revT > 0) { // back up to take another run at a hill
    bot.revT -= dt;
    inp.brake = true;
    return inp;
  }
  if (Game.raceTime > 4 && bot.onGround && bot.vx < 25) {
    bot.stuckT += dt;
    if (bot.stuckT > 1.6) { bot.revT = 1.1; bot.stuckT = 0; return inp; }
  } else bot.stuckT = 0;

  inp.accel = bot.fuel > 5;
  if (!bot.onGround) { // tilt toward the landing slope
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

/* ------------------------------ world interactions ------------------------------ */
function applyPickup(p, kind) {
  if (kind === "fuel") {
    p.fuel = Math.min(p.fuelCap, p.fuel + p.fuelCap * 0.25); // +25% of tank
    if (p === Game.local) Game.sfx.play("fuel");
  } else if (kind === "nitro") {
    p.nitroCharges = Math.min(p.maxNitro, p.nitroCharges + 1);
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

function hitObstacle(p, o) {
  o.cd = 1.2; // per-obstacle cooldown so overlap can't spam hits
  const massFactor = clamp((p.mass - 0.6) / 1.0, 0, 1); // bus plows, bike gets knocked
  p.vx *= lerp(0.35, 0.62, massFactor);
  p.stunned = Math.max(p.stunned, 0.35);
  if (p === Game.local) {
    p.shake = 1;
    Game.sfx.play("collision");
    Game.particles.emit(p.x + p.w * 0.3, p.y, 10, "#ffb050",
      { spread: 120, speed: 180, life: 0.4, size: 2, gravity: 500 });
  } else if (Math.abs(p.x - Game.local.x) < 900) {
    Game.particles.emit(p.x, p.y, 5, "#ffb050", { spread: 100, speed: 140, life: 0.35, size: 2, gravity: 500 });
  }
}

function updateWorldInteractions(dt) {
  for (const o of Game.world.obstacles) {
    if (o.v) o.x = o.x0 + o.v * Math.max(0, Game.raceTime); // deterministic traffic motion
    if (o.cd > 0) o.cd -= dt;
  }
  const locals = [Game.local].concat(Game.bots);
  for (const p of locals) {
    if (p.finished) continue;
    for (const pk of Game.world.pickups) {
      if (pk.taken) continue;
      const dx = p.x - pk.x;
      if (dx > 40 || dx < -40) continue;
      const py = Game.terrain.heightAt(pk.x) - 28;
      if (Math.abs(p.y - py) < 46) { pk.taken = true; applyPickup(p, pk.kind); }
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
    if (!b.finished && b.x >= finishX) {
      b.finished = true; b.finishTime = Game.raceTime;
    }
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

function finishSingleRace() {
  if (Game.state === "done") return;
  Game.state = "done";
  const finishers = Game.players.filter(p => p.finished).sort((a, b) => a.finishTime - b.finishTime);
  const rest = Game.players.filter(p => !p.finished).sort((a, b) => b.distance - a.distance);
  const standings = finishers.concat(rest);
  standings.forEach((p, i) => { p.finalPlace = i + 1; });
  const me = Game.local;
  const myScore = computeScore(me.distance * UNIT_TO_M, me.coins, me.finalPlace, me.fuel);
  const isBest = myScore > save.best;
  if (isBest) save.best = myScore;
  save.coins += me.coins;
  persist();
  const entries = standings.map(p => ({
    name: p.name, place: p.finalPlace,
    time: p.finished ? p.finishTime : null,
    distance: Math.round(p.distance * UNIT_TO_M),
    score: computeScore(p.distance * UNIT_TO_M, p.coins, p.finalPlace, p.fuel),
    me: p === me,
  }));
  presentLeaderboard("RACE COMPLETE",
    `You finished ${fmtPlace(me.finalPlace)}${me.finished ? " — " + fmtTime(me.finishTime) : ""}` +
    (isBest ? " • NEW BEST!" : ` • Best: ${save.best.toLocaleString()}`),
    entries, "single");
}

function gameOver(title) {
  if (Game.state === "done") return;
  Game.state = "done";
  const me = Game.local;
  const score = computeScore(me.distance * UNIT_TO_M, me.coins, 0, me.fuel);
  const isBest = score > save.best;
  if (isBest) save.best = score;
  save.coins += me.coins;
  persist();
  presentLeaderboard(title,
    `Score ${score.toLocaleString()} • Best ${save.best.toLocaleString()}` +
    (isBest ? " — new best!" : ""), [], "single");
}

function checkSingleRaceEnd(dt) {
  if (Game.state !== "racing" || Game.mode !== "single") return;
  if (Game.local.finished) Game.afterFinishTimer += dt;
  const allDone = Game.players.every(p => p.finished);
  const timeout = Game.raceTime > RACE_TIMEOUT;
  if (allDone || timeout || (Game.local.finished && Game.afterFinishTimer > 10)) finishSingleRace();
}

/* Host-side finish compilation: finish messages (sorted by time), then anyone
   still connected but unfinished, ranked by last-known distance. */
function hostHandleFinish(id, data) {
  if (!Game.net.raceRoster.includes(id)) return;
  if (Game.net.finishList.some(f => f.id === id)) return;
  Game.net.finishList.push({ id, time: data.time, distance: data.distance, coins: data.coins, fuel: data.fuel });
}

function checkHostRaceEnd(dt) {
  if (Game.state !== "racing" || Game.mode !== "host") return;
  const fl = Game.net.finishList;
  if (fl.length > 0 && !Game.hostEndStarted) Game.hostEndStarted = true;
  if (Game.hostEndStarted) Game.hostEndTimer += dt;
  const active = Game.net.raceRoster.filter(id => Game.net.players.has(id));
  const allFinished = active.length > 0 && active.every(id => fl.some(f => f.id === id));
  if (allFinished || (Game.hostEndStarted && Game.hostEndTimer > 45) || Game.raceTime > RACE_TIMEOUT) {
    hostCompileLeaderboard();
  }
}

function hostCompileLeaderboard() {
  if (Game.state === "done") return;
  Game.state = "done";
  Game.sfx.engineStop();
  const fl = Game.net.finishList.slice().sort((a, b) => a.time - b.time);
  const entries = [];
  let place = 1;
  for (const f of fl) {
    if (!Game.net.players.has(f.id)) continue; // disconnected mid-race → excluded
    const name = (Game.net.players.get(f.id) || {}).name || "Player";
    entries.push({ id: f.id, name, place, time: f.time, distance: f.distance, coins: f.coins,
                   fuel: f.fuel, score: computeScore(f.distance, f.coins, place, f.fuel) });
    place++;
  }
  const unfinished = Game.net.raceRoster
    .filter(id => !fl.some(f => f.id === id) && Game.net.players.has(id))
    .map(id => ({
      id, name: (Game.net.players.get(id) || {}).name || "Player",
      d: ((Game.net.lastStates.get(id) || {}).d) || 0,
    }))
    .sort((a, b) => b.d - a.d);
  for (const r of unfinished) {
    const distM = Math.round(r.d * UNIT_TO_M);
    entries.push({ id: r.id, name: r.name, place, time: null, distance: distM, coins: 0, fuel: 0,
                   score: computeScore(distM, 0, place, 0) });
    place++;
  }
  Game.net.broadcastLeaderboard(entries); // also triggers local onLeaderboard
}

/* Guests show provisional standings if the host is unreachable at timeout;
   a real leaderboard arriving later replaces it. */
function checkGuestRaceEnd() {
  if (Game.state !== "racing" || Game.mode !== "guest") return;
  if (Game.raceTime > RACE_TIMEOUT + 10) {
    const racers = Game.players.slice().sort((a, b) => posKey(b) - posKey(a));
    const entries = racers.map((p, i) => ({
      id: p.id, name: p.name, place: i + 1,
      time: p.finishTime != null ? p.finishTime : null,
      distance: Math.round(p.distance * UNIT_TO_M), coins: p.coins || 0,
      score: computeScore(Math.round(p.distance * UNIT_TO_M), p.coins || 0, i + 1, Math.round(p.fuel || 0)),
    }));
    presentLeaderboard("RESULTS (provisional)",
      "Waiting for the host to confirm final standings.", entries, "guest");
  }
}

function presentLeaderboard(title, sub, entries, mode) {
  Game.state = "done";
  Game.waiting = false;
  Game.sfx.engineStop();
  hideOverlays();
  $("resultTitle").textContent = title;
  $("resultSub").textContent = sub || "";
  const ul = $("resultBoard");
  ul.innerHTML = "";
  for (const e of entries) {
    const li = document.createElement("li");
    if (e.place === 1) li.className = "place-1";
    const meTag = e.me ? ' <span class="you-tag">(you)</span>' : "";
    const detail = (e.time != null ? fmtTime(e.time) : fmtDist(e.distance || 0)) +
      " • " + Math.round(e.score).toLocaleString() + " pts";
    li.innerHTML = `<span class="lb-place">${fmtPlace(e.place)}</span>` +
      `<span class="lb-name">${escapeHtml(e.name)}${meTag}</span>` +
      `<span class="lb-detail">${detail}</span>`;
    ul.appendChild(li);
  }
  $("btnResultAgain").classList.toggle("hidden", mode !== "single");
  $("btnResultLobby").classList.toggle("hidden", mode !== "host");
  if (mode === "guest" && sub) $("resultSub").textContent = sub + " The host can start a new race from the lobby.";
  $("overlay-result").classList.remove("hidden");
}

/* ------------------------------ camera & HUD ------------------------------ */
function updateCamera(dt) {
  const p = Game.local;
  if (!p) return;
  Game.cam.x += (p.x - W * 0.35 - Game.cam.x) * Math.min(1, 6 * dt);
  Game.cam.y += (p.y - H * 0.55 - Game.cam.y) * Math.min(1, 4 * dt);
  Game.cam.shake = Math.max(0, Game.cam.shake - 3.5 * dt);
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
  else if (p.fuel <= 0 && !p.finished) warn = "OUT OF FUEL — coast to a pickup!";
  else if (pct < 20 && !p.finished) warn = "LOW FUEL";
  $("hudWarning").textContent = warn;
}

function setCountdown(v) {
  const ov = $("countdownOverlay"), el = $("countdownNum");
  ov.classList.remove("hidden");
  el.textContent = v;
  el.style.animation = "none";
  void el.offsetWidth; // restart the pop animation
  el.style.animation = "";
}

/* ------------------------------ main update / render loop ------------------------------ */
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
      Game.state = "racing";
      Game.goT = 0.9;
      setCountdown("GO!");
      Game.sfx.play("go");
    }
    for (const p of Game.players) if (p instanceof RacePlayer) p.update(dt, {}, Game.particles, null, false);
  } else { // racing or done
    if (Game.goT > 0) {
      Game.goT -= dt;
      if (Game.goT <= 0) $("countdownOverlay").classList.add("hidden");
    }
    if (Game.state === "racing") Game.raceTime += dt;
    const raceStarted = Game.state === "racing";

    // local player
    const inp = {
      accel: input.accel, brake: input.brake, left: input.left, right: input.right,
      nitro: nitroQueued,
    };
    nitroQueued = false;
    if (Game.local.finished) { inp.accel = false; inp.brake = true; inp.left = inp.right = false; }
    Game.local.update(dt, inp, Game.particles, Game.sfx, raceStarted);
    if (Game.local.shake) { Game.cam.shake = Math.max(Game.cam.shake, Game.local.shake); Game.local.shake = 0; }

    // bots (single player only)
    if (Game.mode === "single") {
      for (const b of Game.bots) {
        const bi = raceStarted && !b.finished ? botInput(b, dt) : { accel: false, brake: b.finished };
        b.update(dt, bi, Game.particles, null, raceStarted);
      }
    }

    // ghosts: smooth toward the last received network state
    for (const g of Game.ghosts.values()) {
      g.x = lerp(g.x, g.tx, Math.min(1, 10 * dt));
      g.y = lerp(g.y, g.ty, Math.min(1, 10 * dt));
      g.angle = lerp(g.angle, g.ta, Math.min(1, 10 * dt));
    }

    updateWorldInteractions(dt);
    checkFinishes();

    // fuel-out game over (single player only — MP races end via the host)
    if (Game.state === "racing" && Game.mode === "single" && !Game.local.finished) {
      if (Game.local.fuel <= 0 && Math.abs(Game.local.vx) < 15) Game.stalledFor += dt;
      else Game.stalledFor = 0;
      if (Game.stalledFor > 5) { gameOver("OUT OF FUEL"); return; }
    }

    if (Game.mode === "single") checkSingleRaceEnd(dt);
    else if (Game.mode === "host") checkHostRaceEnd(dt);
    else checkGuestRaceEnd();

    // broadcast own state at NET_SEND_HZ
    if (Game.mode !== "single" && Game.net) {
      Game.netAcc += dt;
      if (Game.netAcc >= 1 / NET_SEND_HZ) {
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
  Game.particles.update(dt);
  updateCamera(dt);
  updateHud(dt);
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

/* ------------------------------ pause / restart / navigation ------------------------------ */
Game.togglePause = function () {
  if (Game.mode !== "single" || (Game.state !== "racing" && Game.state !== "countdown")) {
    if (Game.state === "racing" || Game.state === "countdown") hudToast("Pause is not available in multiplayer");
    return;
  }
  Game.paused = !Game.paused;
  $("pauseSub").textContent = Game.mapName + " • " + save.vehicle;
  $("overlay-pause").classList.toggle("hidden", !Game.paused);
  if (Game.paused) Game.sfx.engineStop(); else Game.sfx.engineStart();
};

Game.handleRestartKey = function () {
  if (Game.state === "menu") return;
  if (Game.mode === "single") {
    hideOverlays();
    Game.paused = false;
    startRace(Math.floor(Math.random() * 999999) + 1);
  } else {
    hudToast("Only the host can start a new race (from the leaderboard)");
  }
};

function goHome() {
  hideOverlays();
  $("touchControls").classList.add("hidden");
  Game.sfx.engineStop();
  Game.state = "menu";
  Game.paused = false;
  if (Game.net) { Game.net.destroy(); Game.net = null; }
  Game.mode = null;
  updateHomeStats();
  showScreen("screen-home");
}

/* ------------------------------ PeerJS lazy loader ------------------------------ */
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

/* ------------------------------ multiplayer UI ------------------------------ */
function setupNetCallbacks(net) {
  net.onPlayersChanged = (list) => { if (currentScreen() === "screen-lobby") renderLobbyPlayers(list); };
  net.onMapChanged = () => { if (currentScreen() === "screen-lobby") renderLobbyMap(); };
  net.onRaceStart = (seed, mapName) => {
    Game.mode = net.isHost ? "host" : "guest";
    Game.mapName = mapName;
    Game.net = net;
    startRace(seed);
  };
  net.onWorldUpdate = (id, s) => {
    const g = Game.ghosts.get(id);
    if (g && s) {
      g.tx = s.x; g.ty = s.y; g.ta = s.a;
      g.nitro = !!s.n; g.finished = !!s.f; g.distance = s.d || 0;
    }
  };
  net.onLeaderboard = (list) => {
    for (const e of list) e.me = (e.id === net.myId);
    const mine = list.find(e => e.me);
    if (mine) {
      if (mine.score > save.best) save.best = mine.score;
      save.coins += (mine.coins || 0);
      persist();
    }
    presentLeaderboard("RACE COMPLETE",
      mine ? `You finished ${fmtPlace(mine.place)} — ${fmtTime(mine.time || 0)}` : "",
      list, net.isHost ? "host" : "guest");
  };
  net.onError = (msg) => {
    if (Game.state === "racing" || Game.state === "countdown") hudToast(String(msg).slice(0, 60));
    else if (currentScreen() === "screen-lobby") $("lobbyStatus").textContent = msg;
  };
  net.onHostLeft = () => {
    Game.sfx.engineStop();
    Game.state = "menu";
    Game.paused = false;
    hideOverlays();
    $("touchControls").classList.add("hidden");
    net.destroy();
    Game.net = null;
    Game.mode = null;
    updateHomeStats();
    showScreen("screen-play");
    $("playStatus").textContent = "The host left the room.";
  };
  net.onReturnToLobby = () => {
    hideOverlays();
    $("touchControls").classList.add("hidden");
    Game.state = "menu";
    Game.sfx.engineStop();
    enterLobby();
  };
  net._onGuestFinish = (id, data) => hostHandleFinish(id, data);
}

function enterLobby() {
  showScreen("screen-lobby");
  const net = Game.net;
  const isHost = net.isHost;
  $("roomCodeBox").style.display = isHost ? "" : "none";
  if (isHost) $("roomCode").textContent = net.roomCode || "-----";
  $("lobbyStatus").textContent = isHost
    ? "Share this code with friends. Start when everyone is in."
    : "Connected! Waiting for the host to start the race.";
  $("btnStartRace").classList.toggle("hidden", !isHost);
  renderLobbyPlayers(net._playerListArr());
  renderLobbyMap();
  renderLobbyVehicle();
}

function renderLobbyPlayers(list) {
  const ul = $("lobbyPlayers");
  ul.innerHTML = "";
  for (const p of list) {
    const li = document.createElement("li");
    const you = p.id === Game.net.myId ? ' <span class="you-tag">you</span>' : "";
    const right = p.isHost ? "host" : (VEHICLES[p.vehicle] ? p.vehicle : "");
    li.innerHTML = `<span>${escapeHtml(p.name)}${you}</span><span>${right}</span>`;
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
  const me = Game.net.players.get(Game.net.myId);
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
    card.innerHTML =
      `<canvas class="vshape" width="64" height="40"></canvas>` +
      `<div class="vinfo"><div class="vname">${name}</div>` +
      `<div class="vdesc">${v.desc}</div><div class="vstats">${v.stats}</div></div>`;
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
    card.innerHTML =
      `<canvas class="vshape" width="64" height="40"></canvas>` +
      `<div class="vinfo"><div class="vname">${m.label}</div>` +
      `<div class="vdesc">${m.desc}</div>` +
      `<div class="vstats">Gravity ${Math.round(m.gravity * 100)}% • Grip ${Math.round(m.traction * 100)}%` +
      `${m.fuelMult > 1 ? " • Thirsty engines" : ""}</div></div>`;
    // mini terrain preview from a fixed seed
    const c2 = card.querySelector("canvas").getContext("2d");
    const t = new Terrain(m, 12345);
    c2.fillStyle = m.sky[0]; c2.fillRect(0, 0, 64, 40);
    if (m.far) { c2.fillStyle = m.far; c2.fillRect(0, 26, 64, 14); }
    c2.fillStyle = m.ground;
    c2.beginPath(); c2.moveTo(0, 40);
    for (let sx = 0; sx <= 64; sx += 2) {
      const wy = t.heightAt(sx / 64 * 4000);
      const cy = clamp((wy - (m.base - m.amp * 2)) / (m.amp * 4) * 30 + 10, 8, 38);
      c2.lineTo(sx, cy);
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
  $("btnSoundToggle").textContent = save.sound ? "ON" : "OFF";
  $("settingsBest").textContent = save.best.toLocaleString();
  $("settingsCoins").textContent = save.coins.toLocaleString();
}

/* ------------------------------ input ------------------------------ */
window.addEventListener("keydown", (e) => {
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
  const k = e.key;
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(k)) e.preventDefault();
  if (k === "w" || k === "W" || k === "ArrowUp") input.accel = true;
  else if (k === "s" || k === "S" || k === "ArrowDown") input.brake = true;
  else if (k === "a" || k === "A" || k === "ArrowLeft") input.left = true;
  else if (k === "d" || k === "D" || k === "ArrowRight") input.right = true;
  else if (k === " " && !e.repeat) nitroQueued = true; // edge-triggered
  else if (k === "Escape") Game.togglePause();
  else if ((k === "r" || k === "R") && Game.state !== "menu") Game.handleRestartKey();
});
window.addEventListener("keyup", (e) => {
  const k = e.key;
  if (k === "w" || k === "W" || k === "ArrowUp") input.accel = false;
  else if (k === "s" || k === "S" || k === "ArrowDown") input.brake = false;
  else if (k === "a" || k === "A" || k === "ArrowLeft") input.left = false;
  else if (k === "d" || k === "D" || k === "ArrowRight") input.right = false;
});
window.addEventListener("blur", () => { input.accel = input.brake = input.left = input.right = false; });

/* Touch pedals — pointer capture so a finger sliding off a button can't leave it stuck */
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
  el.addEventListener("lostpointercapture", release);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

/* ------------------------------ init ------------------------------ */
function init() {
  loadSave();
  ctx = $("raceCanvas").getContext("2d");
  resizeCanvas();
  Game.sfx.enabled = save.sound;

  buildVehicleScreen();
  buildMapScreen();
  updateHomeStats();
  updateSettingsUI();
  $("inpName").value = save.name;

  // pedals
  bindPedal($("btnGas"), () => input.accel = true, () => input.accel = false);
  bindPedal($("btnBrake"), () => input.brake = true, () => input.brake = false);
  bindPedal($("btnTiltL"), () => input.left = true, () => input.left = false);
  bindPedal($("btnTiltR"), () => input.right = true, () => input.right = false);
  bindPedal($("btnNitro"), () => nitroQueued = true, null);

  // menu buttons
  $("btnPlay").onclick = () => { Game.sfx.play("click"); $("playStatus").textContent = ""; showScreen("screen-play"); };
  $("btnMulti").onclick = () => { Game.sfx.play("click"); $("playStatus").textContent = ""; showScreen("screen-play"); };
  $("btnVehicle").onclick = () => { Game.sfx.play("click"); buildVehicleScreen(); showScreen("screen-vehicle"); };
  $("btnVehicleBack").onclick = () => { Game.sfx.play("click"); updateHomeStats(); showScreen("screen-home"); };
  $("btnMap").onclick = () => { Game.sfx.play("click"); buildMapScreen(); showScreen("screen-map"); };
  $("btnMapBack").onclick = () => { Game.sfx.play("click"); updateHomeStats(); showScreen("screen-home"); };
  $("btnPlayBack").onclick = () => { Game.sfx.play("click"); updateHomeStats(); showScreen("screen-home"); };
  $("btnJoinMenu").onclick = () => {
    Game.sfx.play("click");
    save.name = ($("inpName").value.trim() || "Player").slice(0, 12); persist();
    $("joinStatus").textContent = ""; $("joinError").textContent = ""; $("inpRoomCode").value = "";
    showScreen("screen-join");
  };
  $("btnJoinBack").onclick = () => { Game.sfx.play("click"); showScreen("screen-play"); };
  $("btnSettings").onclick = () => { Game.sfx.play("click"); updateSettingsUI(); showScreen("screen-settings"); };
  $("btnSettingsBack").onclick = () => { Game.sfx.play("click"); updateHomeStats(); showScreen("screen-home"); };
  $("btnSoundToggle").onclick = () => {
    save.sound = !save.sound;
    Game.sfx.enabled = save.sound;
    persist(); updateSettingsUI();
    Game.sfx.play("click");
  };
  $("btnResetSave").onclick = () => {
    save.best = 0; save.coins = 0;
    persist(); updateSettingsUI(); updateHomeStats();
    Game.sfx.play("click");
  };

  // single player
  $("btnSingle").onclick = () => {
    Game.sfx.play("click");
    save.name = ($("inpName").value.trim() || "Player").slice(0, 12); persist();
    Game.mode = "single";
    Game.net = null;
    Game.mapName = save.map;
    startRace(Math.floor(Math.random() * 999999) + 1);
  };

  // create room (host)
  $("btnCreate").onclick = async () => {
    Game.sfx.play("click");
    save.name = ($("inpName").value.trim() || "Player").slice(0, 12); persist();
    $("playStatus").textContent = "Creating room…";
    await ensurePeerJs();
    if (!window.Peer) {
      $("playStatus").textContent = "Multiplayer unavailable — the connection library could not load. Single player still works.";
      return;
    }
    const net = new NetManager();
    setupNetCallbacks(net);
    try {
      await net.createRoom(save.name);
      Game.net = net;
      Game.mode = "host";
      $("playStatus").textContent = "";
      enterLobby();
    } catch (e) {
      net.destroy();
      $("playStatus").textContent = "Could not create a room — check your internet connection.";
    }
  };

  // join room (guest)
  $("btnJoinConnect").onclick = async () => {
    const code = $("inpRoomCode").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== 5) { $("joinError").textContent = "Enter the 5-character room code."; return; }
    Game.sfx.play("click");
    save.name = ($("inpName").value.trim() || save.name || "Player").slice(0, 12); persist();
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
      await net.joinRoom(code, save.name);
      Game.net = net;
      Game.mode = "guest";
      $("joinStatus").textContent = "";
      enterLobby();
    } catch (e) {
      net.destroy();
      const msg =
        e.message === "notfound" ? "Room not found — check the code." :
        e.message === "full" ? "That room is full (4 players max)." :
        e.message === "timeout" ? "Connection timed out — check your internet." :
        "Could not connect — check your internet.";
      $("joinStatus").textContent = "";
      $("joinError").textContent = msg;
    }
  };
  $("inpRoomCode").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btnJoinConnect").click();
  });
  $("inpName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.target.blur();
  });

  // lobby
  $("btnStartRace").onclick = () => { Game.sfx.play("click"); Game.net.startRace(); };
  $("btnLeaveLobby").onclick = () => { Game.sfx.play("click"); goHome(); };

  // pause overlay
  $("btnPause").onclick = () => Game.togglePause();
  $("btnResume").onclick = () => { Game.sfx.play("click"); Game.togglePause(); };
  $("btnRestart").onclick = () => { Game.sfx.play("click"); Game.handleRestartKey(); };
  $("btnQuit").onclick = () => { Game.sfx.play("click"); goHome(); };

  // result overlay
  $("btnResultAgain").onclick = () => { // single player only
    Game.sfx.play("click");
    hideOverlays();
    startRace(Math.floor(Math.random() * 999999) + 1);
  };
  $("btnResultLobby").onclick = () => { // host only — everyone returns
    Game.sfx.play("click");
    Game.net.returnAllToLobby();
  };
  $("btnResultHome").onclick = () => { Game.sfx.play("click"); goHome(); };

  window.addEventListener("resize", () => { resizeCanvas(); checkOrientation(); });
  window.addEventListener("orientationchange", () => setTimeout(checkOrientation, 200));
  checkOrientation();

  showScreen("screen-home");
  requestAnimationFrame(frame);
}

init();
