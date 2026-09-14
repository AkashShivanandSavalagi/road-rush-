"use strict";
/* ROAD RUSH — storage.js: config, shared helpers, versioned save. Loads FIRST. */

const GAME_VERSION = "2.1.0";
const SAVE_SCHEMA_VERSION = 5;

const CONFIG = {
  MAX_PLAYERS: 18,
  ROOM_SIZES: [2, 5, 10, 15, 18],
  CODE_LEN: 5,
  NET_SEND_HZ: 15,
  CHAT_MAX_LEN: 120,
  CHAT_COOLDOWN_MS: 1500,
  EMOTE_COOLDOWN_MS: 10000,      // race emojis: 1 per 10 s (client + host)
  PASS_ATTEMPTS: 5,
  RECONNECTING_MS: 3000,         // CONNECTED → RECONNECTING (0-3s) →
  TAKEOVER_MS: 15000,            // OFFLINE (3-15s) → CPU takeover
  STRIKES_KICK: 3,
  MUTE_MS: 30 * 60 * 1000,
};
const FEEDBACK_EMAIL = "you@example.com";   // ← set before launch

const TAU = Math.PI * 2;
const $ = id => document.getElementById(id);
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
function nowMs() { return performance.now(); }
function randomHex(n) {
  const c = "0123456789abcdef"; let s = "";
  for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * 16)];
  return s;
}
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp(Math.round(((n >> 16) & 255) * f), 0, 255);
  const g = clamp(Math.round(((n >> 8) & 255) * f), 0, 255);
  const b = clamp(Math.round((n & 255) * f), 0, 255);
  return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
}
function validateName(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "Name required." };
  const name = raw.replace(/[\u0000-\u001F\u007F]/g, "").trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, reason: "Name required." };
  if (name.length < 2) return { ok: false, reason: "At least 2 characters." };
  if (name.length > 16) return { ok: false, reason: "Maximum 16 characters." };
  return { ok: true, name };
}
const CODE_CHARS = "ABCDEFGHJKMNPQRTUVWXYZ2346789";
function makeRoomCode(rng) {
  const r = rng || Math.random; let s = "";
  for (let i = 0; i < CONFIG.CODE_LEN; i++) s += CODE_CHARS[Math.floor(r() * CODE_CHARS.length)];
  return s;
}
class RateLimiter {
  constructor(minIntervalMs) { this.min = minIntervalMs; this.last = -Infinity; }
  allow(now) {
    const t = (now == null) ? nowMs() : now;
    if (t - this.last < this.min) return false;
    this.last = t; return true;
  }
}

const SAVE_KEY = "roadrush_save_v5";
const save = {
  name: "", vehicle: "", map: "",
  sound: true, music: true, pedals: false,
  quality: "auto", vibration: true, reducedMotion: false, firstRun: true,
  best: 0, coins: 0, owned: [], mapBests: {},
};
function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || obj.v !== SAVE_SCHEMA_VERSION) return;  // discard on mismatch
    if (typeof obj.name === "string") save.name = obj.name.slice(0, 16);
    if (typeof obj.vehicle === "string") save.vehicle = obj.vehicle;
    if (typeof obj.map === "string") save.map = obj.map;
    ["sound","music","pedals","vibration","reducedMotion","firstRun"].forEach(k => {
      if (typeof obj[k] === "boolean") save[k] = obj[k];
    });
    if (["auto","low","medium","high","extreme"].includes(obj.quality)) save.quality = obj.quality;
    if (typeof obj.best === "number" && isFinite(obj.best)) save.best = Math.max(0, Math.floor(obj.best));
    if (typeof obj.coins === "number" && isFinite(obj.coins)) save.coins = Math.max(0, Math.floor(obj.coins));
    if (Array.isArray(obj.owned)) save.owned = obj.owned.filter(x => typeof x === "string");
    if (obj.mapBests && typeof obj.mapBests === "object") save.mapBests = obj.mapBests;
  } catch (e) { /* corrupt/inaccessible: keep defaults */ }
}
function persist() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(Object.assign({ v: SAVE_SCHEMA_VERSION }, save))); } catch (e) {}
}
function sidFor(code) {
  try {
    let sid = sessionStorage.getItem("rr_sid_" + code);
    if (!sid) { sid = randomHex(12); sessionStorage.setItem("rr_sid_" + code, sid); }
    return sid;
  } catch (e) { return randomHex(12); }
}
/* per-device id for mute enforcement — NOT an account; clearing browser data
   resets it (documented limitation in ToS, not hidden). */
function getDeviceId() {
  try {
    let id = localStorage.getItem("rr_device");
    if (!id) { id = randomHex(16); localStorage.setItem("rr_device", id); }
    return id;
  } catch (e) { return randomHex(16); }
                       }
