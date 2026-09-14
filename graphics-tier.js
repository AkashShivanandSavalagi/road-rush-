"use strict";
/* ROAD RUSH — graphics-tier.js: tier detection + adaptive degradation.
   FIXED order: particles → scenery → shadows → resolution → terrain detail.
   Physics/input/UI are structurally absent from this list — never degraded. */

const TIER_SETTINGS = {
  low:     { maxParticles: 40,  dprCap: 1.0,  shadows: false, scenery: false },
  medium:  { maxParticles: 120, dprCap: 1.25, shadows: false, scenery: true  },
  high:    { maxParticles: 300, dprCap: 1.5,  shadows: true,  scenery: true  },
  extreme: { maxParticles: 600, dprCap: 2.0,  shadows: true,  scenery: true  },
};
function detectGraphicsTier() {
  const cores = navigator.hardwareConcurrency || 2;
  const mem = navigator.deviceMemory || 4; // Chrome-only, guarded
  const isMobile = matchMedia("(pointer: coarse)").matches;
  const score = cores * 2 + mem - (isMobile ? 3 : 0);
  return score <= 4 ? "low" : score <= 8 ? "medium" : score <= 14 ? "high" : "extreme";
}
const Graphics = { tier: detectGraphicsTier(), degraded: 0, _win: [], _last: 0 };
function qLevel() { return save.quality !== "auto" ? save.quality : Graphics.tier; }
function qSettings() { return TIER_SETTINGS[qLevel()] || TIER_SETTINGS.medium; }
function qNum(lo, mid, hi) { const q = qLevel(); return q === "low" ? lo : q === "medium" ? mid : hi; }
function qBool(hi, mid) { const q = qLevel(); return q === "high" || q === "extreme" ? hi : q === "medium" ? mid : false; }
function dprCap() { return qSettings().dprCap; }
function applyTierToBody() { document.body.setAttribute("data-graphics-tier", qLevel()); }
function trackFrameTime(dt) {
  const t = nowMs();
  if (t - Graphics._last < 200) return;
  Graphics._last = t;
  Graphics._win.push(dt);
  while (Graphics._win.length > 25) Graphics._win.shift();
  if (Graphics._win.length < 15) return;
  const avg = Graphics._win.reduce((a, b) => a + b, 0) / Graphics._win.length;
  const floor = [40, 30, 25][Math.min(Graphics.degraded, 2)];
  if (1 / avg < floor && Graphics.degraded < 5) {
    Graphics.degraded++;
    Graphics._win = [];
    if (typeof Game !== "undefined" && Game.state !== "menu" && typeof hudToast === "function")
      hudToast("Adjusting graphics for smoothness…");
  }
}
function resetDegradation() { Graphics.degraded = 0; Graphics._win = []; }
