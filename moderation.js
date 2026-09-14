"use strict";
/* ROAD RUSH — moderation.js: text filter, strike/mute tracker, voice votes,
   and the RACE EMOJI vocabulary (network.js validates against this set).
   Enforcement is device-bound (no accounts) — disclosed in the ToS. */

const BANNED_PATTERNS = [
  /\bfuck/, /\bshit/, /\bbitch/, /\bcunt/, /\bastard/, /\bkys\b/, /\bfaggot/,
  /\bretard/, /\brapei?st?\b/, /\bkill\s*your\s*self\b/,
];

function filterMessage(raw) {
  let text = raw.slice(0, 120).replace(/<[^>]*>/g, "");           // hard cap + strip HTML (XSS)
  text = text.replace(/(.)\1{4,}/g, "$1$1$1");                    // collapse spam repeats: "😂😂😂😂😂😂😂😂" → "😂😂😂"
  const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const flagged = BANNED_PATTERNS.some(p => p.test(normalized));
  return { text, blocked: flagged };
}

/* RACE EMOJIS — exactly 10; first 5 are the "recommended" quick set.
   Sendable 1 per 10 s (client gate in game.js + host limiter in network.js).
   No text chat exists on the race screen — emojis, voice and music only. */
const EMOJI_RACE = ["😂","😮","🔥","🏆","👏","😎","💀","🎉","😤","👋"];
const EMOJI_QUICK = EMOJI_RACE.slice(0, 5);

/* MuteTracker (host-side): 3 strikes → 30-minute mute, persisted to
   localStorage keyed by per-device ID (NOT an account). */
class MuteTracker {
  constructor() { this.strikes = new Map(); this.muted = this._load(); }
  _load() { try { return JSON.parse(localStorage.getItem("rr_mutelog")) || {}; } catch (e) { return {}; } }
  _save() { try { localStorage.setItem("rr_mutelog", JSON.stringify(this.muted)); } catch (e) {} }
  isMuted(deviceId) { const u = this.muted[deviceId]; return !!u && u > Date.now(); }
  muteRemaining(deviceId) { const u = this.muted[deviceId]; return u && u > Date.now() ? Math.ceil((u - Date.now()) / 60000) : 0; }
  strike(deviceId) {
    const s = (this.strikes.get(deviceId) || 0) + 1;
    this.strikes.set(deviceId, s);
    if (s >= 3) { this.muted[deviceId] = Date.now() + CONFIG.MUTE_MS; this._save(); this.strikes.delete(deviceId); return true; }
    return false;
  }
}

/* VoiceReportVote: heuristic FEEDS this vote — majority-of-room reports
   required; one report per reporter (Set). Heuristic never auto-mutes. */
class VoiceReportVote {
  constructor() { this.reports = new Map(); }
  report(targetSid, reporterSid) {
    if (!this.reports.has(targetSid)) this.reports.set(targetSid, new Set());
    this.reports.get(targetSid).add(reporterSid);
  }
  threshold(connectedHumans) { return Math.max(2, Math.ceil(connectedHumans * 0.5)); }
  decided(targetSid, connectedHumans) {
    const r = this.reports.get(targetSid);
    return !!r && r.size >= this.threshold(Math.max(1, connectedHumans));
  }
  clear(targetSid) { this.reports.delete(targetSid); }
}
