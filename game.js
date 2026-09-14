"use strict";
/* ROAD RUSH — game.js: everything that touches the DOM.
   Load order before this: storage → graphics-tier → physics → audio →
   moderation → network. Contains: game state, race flow, rendering,
   spectate-after-finish, race emoji system, garage/map carousels, lobby,
   chat, feedback, ads policy hooks, input, init. */

let ctx = null, W = 0, H = 0;
const isTouch = (window.matchMedia && matchMedia("(pointer: coarse)").matches) || ("ontouchstart" in window);
const input = { accel: false, brake: false, left: false, right: false };
let nitroQueued = false, jumpQueued = false;
let toastT = 0, toastMsg = "";
let pendingRoom = null, DEBUG_MODE = false;
let garageIdx = 0, mapIdx = 0, gTrans = 0, mTrans = 0, mCache = null;
let musicProbed = false;
let fbShotData = null, fbKind = "feedback", fbSev = "MEDIUM", fbReportTarget = null;

const Game = {
  mode: null, state: "menu", mapName: "highway",
  terrain: null, world: null, mapLen: 20000, raceTimeout: 240,
  boosts: [], hazards: [],
  players: [], local: null, bots: [], ghosts: new Map(),
  particles: null, sfx: null, music: null, voice: null,
  cam: { x: 0, y: 0, shake: 0, zoom: 1 },
  raceTime: 0, countdownT: 0, goT: 0, lastCountNum: 4, hintT: 0, awaitingGo: false,
  afterFinishTimer: 0, stalledFor: 0, hostEndStarted: false, hostEndTimer: 0,
  posAcc: 0, posList: null, bubbles: [], waiting: false,
  net: null, netAcc: 0, hudAcc: 0, listTick: 0, dbgAcc: 0, fpsAvg: 60, musAcc: 0,
  lastT: 0, paused: false, _engAcc: 0,
  spectate: null, _lastEmoji: -Infinity,
};

const SCREENS = ["screen-home","screen-play","screen-create","screen-vehicle","screen-map","screen-join",
  "screen-lobby","screen-settings","screen-race","screen-howto","screen-feedback"];
function showScreen(id) { for (const s of SCREENS) $(s).classList.add("hidden"); if (id) $(id).classList.remove("hidden"); }
function currentScreen() { for (const s of SCREENS) if (!$(s).classList.contains("hidden")) return s; return null; }
function hideOverlays() { ["overlay-pause","overlay-result","overlay-rotate","overlay-qr","emojiPanel"].forEach(o => $(o).classList.add("hidden")); }
function hudToast(msg) { toastMsg = msg; toastT = 2.4; }
function setStatus(id, text, state) {
  const el = $(id); if (!el) return;
  el.className = (id === "joinError" || (state === "err" && (id === "fbStatus" || id === "joinError"))) ? "error-text" : "status-text";
  if (state === "ok") el.className = "status-text success-text";
  el.innerHTML = "";
  if (state === "load") { const sp = document.createElement("span"); sp.className = "spinner"; el.appendChild(sp); el.appendChild(document.createTextNode(" " + text)); }
  else el.textContent = text || "";
}
function autoName() { return "Player" + (1000 + Math.floor(Math.random() * 9000)); }
function vehicleOwned(id) { return save.owned.includes(id); }

/* ---------- modal system (no native dialogs) ---------- */
function rrModal(opts) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "rr-modal-wrap";
    const isInput = typeof opts.input === "string";
    wrap.innerHTML = '<div class="rr-modal" role="dialog" aria-modal="true"><div class="rr-title"></div>' +
      (opts.body ? '<div class="rr-body"></div>' : "") +
      (isInput ? '<input class="rr-input" maxlength="24" autocomplete="off">' : "") +
      '<div class="rr-actions"><button class="btn btn-back rr-no">CANCEL</button>' +
      '<button class="btn ' + (opts.danger ? "btn-race" : "btn-primary") + ' rr-ok"></button></div></div>';
    wrap.querySelector(".rr-title").textContent = opts.title || "";
    if (opts.body) wrap.querySelector(".rr-body").textContent = opts.body;
    const okBtn = wrap.querySelector(".rr-ok");
    okBtn.textContent = opts.confirm || "CONFIRM";
    const inp = wrap.querySelector(".rr-input");
    let done = false;
    const close = (val) => { if (done) return; done = true; document.removeEventListener("keydown", onKey); wrap.remove(); resolve(val); };
    const onKey = (e) => { if (e.key === "Escape") close(null); else if (e.key === "Enter" && !e.repeat) okBtn.click(); };
    wrap.querySelector(".rr-no").onclick = () => close(isInput ? null : false);
    okBtn.onclick = () => close(isInput ? inp.value : true);
    if (isInput) { inp.value = opts.input; inp.placeholder = opts.placeholder || ""; setTimeout(() => inp.focus(), 30); }
    wrap.onclick = (e) => { if (e.target === wrap) close(isInput ? null : false); };
    document.addEventListener("keydown", onKey);
    document.body.appendChild(wrap);
    okBtn.focus();
  });
}

/* ---------- canvas / caches / orientation / wake lock ---------- */
let _hyBuf = null;
const _gradCache = new Map();
function cachedGrad(key, W2, H2, make) {
  const k = key + ":" + W2 + "x" + H2;
  let g = _gradCache.get(k);
  if (!g) { g = make(); _gradCache.set(k, g); }
  return g;
}
function clearGradCache() { _gradCache.clear(); }
let _fontCur = "";
function setFont(c, f) { if (_fontCur !== f) { c.font = f; _fontCur = f; } }
function resizeCanvas() {
  const c = $("raceCanvas"); if (!c || !ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, dprCap());
  c.width = Math.floor(innerWidth * dpr); c.height = Math.floor(innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  W = innerWidth; H = innerHeight;
  clearGradCache();
}
function checkOrientation() {
  if (!window.matchMedia) return;
  $("overlay-rotate").classList.toggle("hidden", !(isTouch && matchMedia("(orientation: portrait)").matches && currentScreen() === "screen-race"));
}
let wakeLock = null;
async function requestWakeLock() { try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {} }
function releaseWakeLock() { try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {} }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Game.state !== "menu") requestWakeLock(); });

/* ---------- pooled particles ---------- */
class ParticleSystem {
  constructor() { this.list = []; this.pool = []; }
  cap() { return TIER_SETTINGS[qLevel()].maxParticles; }
  emit(x, y, n, color, opts = {}) {
    if (this.list.length > this.cap()) n = Math.min(n, 2);
    const speed = opts.speed || 140, spread = opts.spread || 100, life = opts.life || 0.5,
          size = opts.size || 3, gravity = opts.gravity != null ? opts.gravity : 800;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * TAU, spd = speed * (0.3 + Math.random() * 0.7);
      const p = this.pool.pop() || {};
      p.x = x; p.y = y; p.vx = Math.cos(ang) * spd * (spread / 120); p.vy = Math.sin(ang) * spd - 60;
      p.life = life * (0.6 + Math.random() * 0.6); p.maxLife = life; p.color = color; p.size = size; p.gravity = gravity;
      p.rect = opts.shape === "rect"; p.pw = opts.pw || 8; p.ph = opts.ph || 3;
      p.rot = Math.random() * TAU; p.vr = (Math.random() - 0.5) * 6;
      this.list.push(p);
    }
  }
  update(dt) {
    const L = this.list; let k = 0;
    for (let i = 0; i < L.length; i++) {
      const p = L[i];
      p.vy += p.gravity * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      if (p.rect) p.rot += p.vr * dt;
      if (p.life > 0) L[k++] = p; else this.pool.push(p);
    }
    L.length = k;
  }
  draw(c, camX, camY) {
    for (let i = 0; i < this.list.length; i++) {
      const p = this.list[i], a = clamp(p.life / p.maxLife, 0, 1);
      c.globalAlpha = a; c.fillStyle = p.color;
      if (p.rect) { c.save(); c.translate(p.x - camX, p.y - camY); c.rotate(p.rot); c.fillRect(-p.pw * a / 2, -p.ph * a / 2, p.pw * a, p.ph * a); c.restore(); }
      else { c.beginPath(); c.arc(p.x - camX, p.y - camY, Math.max(1, p.size * a), 0, TAU); c.fill(); }
    }
    c.globalAlpha = 1;
  }
}

/* ---------- race setup ---------- */
function startRace(seed) {
  const mapDef = MAPS[Game.mapName] || MAPS.highway;
  Game.terrain = new Terrain(mapDef, seed);
  const usePreset = Game.net && Game.net.roomCfg && Game.mode !== "single";
  Game.mapLen = usePreset ? presetFinishUnits(Game.net.roomCfg.duration) : mapDef.length;
  Game.raceTimeout = clamp(Math.round((usePreset ? DURATION_PRESETS[Game.net.roomCfg.duration].targetSeconds : mapDef.targetTime) * 2.4), 150, 900);
  const solo = Game.mode === "single";
  Game.world = generateWorldObjects(Game.terrain, seed, Game.mapLen + START_X + 800, { noFuel: !solo });
  Game.boosts = generateBoosts(mapDef, seed, Game.mapLen);
  Game.hazards = generateHazards(mapDef, seed, Game.mapLen);
  Game.particles = new ParticleSystem();
  Game.raceTime = 0; Game.afterFinishTimer = 0; Game.stalledFor = 0;
  Game.hostEndStarted = false; Game.hostEndTimer = 0;
  Game.waiting = false; toastT = 0; Game.posList = null; Game.bubbles = [];
  Game.countdownT = 3.0; Game.lastCountNum = 4; Game.goT = 0; Game.hintT = 6;
  Game.awaitingGo = !solo;
  Game.state = "countdown"; Game.paused = false;
  Game.spectate = null; Game._lastEmoji = -Infinity;
  Game.cam = { x: START_X - W * 0.35, y: 0, shake: 0, zoom: 1 };
  const veh = (save.vehicle && VEHICLES[save.vehicle] && vehicleOwned(save.vehicle)) ? save.vehicle : "sedan";
  const lockedVeh = usePreset && Game.net.roomCfg.vehicleMode === "locked" ? Game.net.roomCfg.vehicle : veh;
  Game.local = new VehiclePhysics(lockedVeh, Game.terrain,
    { id: "local", name: save.name, sid: Game.net ? Game.net.mySid : null, fuelEnabled: solo, fuelMult: mapDef.fuelMult });
  Game.players = [Game.local]; Game.ghosts.clear(); Game.bots = [];
  if (solo) {
    const names = ["Rex 🤖", "Mia 🤖", "Zig 🤖"];
    const pool = VEHICLE_ORDER.slice();
    for (let i = 0; i < 3; i++) {
      const vid = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      const skill = 0.82 + (i / 3) * 0.16 + Math.random() * 0.04;
      const b = new VehiclePhysics(vid, Game.terrain, { id: "bot" + i, name: names[i], isBot: true, fuelEnabled: true, fuelMult: mapDef.fuelMult });
      b.accelPower *= skill; b.maxSpeed *= skill; b.fuelUsePerSec *= 0.9;
      b.botTimer = 4 + Math.random() * 8;
      Game.bots.push(b); Game.players.push(b);
    }
  } else if (Game.net) {
    for (const p of Game.net._playerListArr()) {
      if (p.sid === Game.net.mySid) continue;
      if (Game.net.isHost && p.isBot) continue;          // host renders roster bots via Game.bots
      const v = VEHICLES[p.vehicle] ? p.vehicle : "sedan", vd = VEHICLES[v];
      Game.ghosts.set(p.sid, { sid: p.sid, name: p.name, isRemote: true, vehicleName: v,
        color: vd.color, w: vd.w, h: vd.h,
        x: START_X, y: Game.terrain.heightAt(START_X) - vd.h / 2 - vd.drop,
        angle: 0, tx: START_X, ty: 0, ta: 0, wheelAngle: 0,
        nitro: false, finished: false, finishTime: null, distance: 0 });
      Game.players.push(Game.ghosts.get(p.sid));
    }
    if (Game.net.isHost) {
      for (const p of Game.net._playerListArr()) {
        if (p.sid === Game.net.mySid || !p.isBot) continue;
        const b = new VehiclePhysics(p.vehicle, Game.terrain, { id: p.sid, sid: p.sid, name: p.name, isBot: true, fuelEnabled: false });
        b.botTimer = 4 + Math.random() * 8;
        Game.bots.push(b);
      }
    }
  }
  showScreen("screen-race"); hideOverlays();
  $("spectateBar").classList.add("hidden");
  $("touchControls").classList.toggle("hidden", !(isTouch || save.pedals));
  $("btnPTT").classList.toggle("hidden", !(Game.voice && Game.voice.on));
  $("hudFuelRow").style.display = solo ? "" : "none";    // MP: fuel entirely absent
  $("keyHints").classList.toggle("hidden", isTouch);
  $("keyHints").classList.remove("faded");
  $("raceList").innerHTML = "";
  $("raceList").classList.toggle("hidden", Game.players.length < 2);
  $("hudWarning").textContent = "";
  Game.sfx.engineStart();
  Game.music.setEnabled(save.music);
  if (save.music) { if (!musicProbed) { musicProbed = true; Game.music.probeExternal(); } Game.music.start(); }
  resetDegradation(); applyTierToBody();
  requestWakeLock();
}
function beginGo() {
  if (Game.state !== "countdown") return;
  Game.state = "racing"; Game.awaitingGo = false; Game.goT = 0.9;
  setCountdown("GO!"); Game.sfx.play("go");
  if (Game.local) {
    Game.local.squash = 0.7;
    Game.particles.emit(Game.local.x, Game.local.y + Game.local.h / 2, 14, SURF_DUST[Game.local.surfaceId] || Game.terrain.def.dust,
      { spread: 80, speed: 160, life: 0.55, size: 3, gravity: 400 });
    Game.cam.shake = Math.max(Game.cam.shake, 0.4);
  }
}

/* ---------- bot AI ---------- */
function botInput(bot, dt) {
  const inp = { accel: false, brake: false, left: false, right: false, nitro: false, jump: false };
  bot.stuckT = bot.stuckT || 0; bot.revT = bot.revT || 0;
  if (bot.revT > 0) { bot.revT -= dt; inp.brake = true; return inp; }
  if (Game.raceTime > 4 && bot.onGround && bot.vx < 25) {
    bot.stuckT += dt;
    if (bot.stuckT > 1.6) { bot.revT = 1.1; bot.stuckT = 0; return inp; }
  } else bot.stuckT = 0;
  inp.accel = !bot.fuelEnabled || bot.fuel > 5;
  if (bot.onGround && (bot.jumpCd || 0) <= 0) {
    for (const o of Game.world.obstacles) { const dx = o.x - bot.x; if (dx > 40 && dx < 170) { inp.jump = true; break; } }
    if (!inp.jump) for (const hz of Game.hazards) { const dx = hz.x - bot.x; if (dx > 40 && dx < 260) { inp.jump = true; break; } }
  }
  if (!bot.onGround) {
    const target = Math.atan(Game.terrain.slopeAt(bot.x + bot.vx * 0.35)) * 180 / Math.PI;
    const diff = target - bot.angle;
    if (diff > 6) inp.right = true; else if (diff < -6) inp.left = true;
  }
  bot.botTimer -= dt;
  if (bot.botTimer <= 0) {
    bot.botTimer = 5 + Math.random() * 9;
    if (bot.nitroCharges > 0 && bot.onGround && Math.abs(Game.terrain.slopeAt(bot.x)) < 0.15) inp.nitro = true;
  }
  return inp;
}

/* ---------- pickups / interactions ---------- */
function applyPickup(p, kind) {
  if (kind === "fuel") { p.fuel = fillFuel(p.fuel, p.fuelCap); if (p === Game.local) { Game.sfx.play("fuel"); vibrate(15); } }
  else if (kind === "nitro") { p.nitroCharges = addNitro(p.nitroCharges, p.maxNitro); if (p === Game.local) Game.sfx.play("pickup"); }
  else { p.coins += 1; if (p === Game.local) Game.sfx.play("coin"); }
  if (p === Game.local) {
    const col = kind === "fuel" ? "#f0c828" : kind === "nitro" ? "#3cc8ff" : "#ffd73c";
    Game.particles.emit(p.x, p.y - 10, 6, col, { spread: 80, speed: 120, life: 0.4, size: 2, gravity: 300 });
  }
}
function tryPickup(pk) {
  if (Game.mode === "single" || !Game.net) { if (!pk.taken) { pk.taken = true; applyPickup(Game.local, pk.kind); } }
  else if (Game.net.isHost) {
    if (!pk.taken) { pk.taken = true; Game.net.broadcast({ t: "pk", id: pk.id, by: Game.net.mySid }); applyPickup(Game.local, pk.kind); }
  } else if (!pk.taken) { pk.taken = true; Game.net.claimPickup(pk.id); }
}
function onAuthoritativePickup(id, by) {
  const pk = Game.world && (Game.world.pkMap ? Game.world.pkMap.get(id) : Game.world.pickups[id]);
  if (!pk || pk.taken) return;
  pk.taken = true;
  if (Game.net && by === Game.net.mySid) applyPickup(Game.local, pk.kind);
}
function hitObstacle(p, o) {
  o.cd = 1.2;
  const massFactor = clamp((p.mass - 0.6) / 1.0, 0, 1);
  p.vx *= lerp(0.35, 0.62, massFactor);
  p.stunned = Math.max(p.stunned, 0.35);
  if (p === Game.local) {
    p.shake = 1; Game.sfx.play("collision");
    Game.particles.emit(p.x + p.w * 0.3, p.y, 10, "#ffb050", { spread: 120, speed: 180, life: 0.4, size: 2, gravity: 500 });
  } else if (Math.abs(p.x - Game.local.x) < 900) {
    Game.particles.emit(p.x, p.y, 5, "#ffb050", { spread: 100, speed: 140, life: 0.35, size: 2, gravity: 500 });
  }
}
function updateWorldInteractions(dt) {
  for (const o of Game.world.obstacles) { if (o.v) o.x = o.x0 + o.v * Math.max(0, Game.raceTime); if (o.cd > 0) o.cd -= dt; }
  for (const bp of Game.boosts) if (bp.cd > 0) bp.cd -= dt;
  for (const hz of Game.hazards) if (hz.cd > 0) hz.cd -= dt;
  const locals = [Game.local].concat(Game.bots);
  for (const p of locals) {
    if (p.finished) continue;
    const arr = Game.world.pickups;
    let lo = 0, hi = arr.length;
    const tMin = p.x - 40;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].x < tMin) lo = m + 1; else hi = m; }
    for (let i = lo; i < arr.length && arr[i].x <= p.x + 40; i++) {
      const pk = arr[i];
      if (pk.taken) continue;
      const py = Game.terrain.heightAt(pk.x) - 28;
      if (Math.abs(p.y - py) < 46) {
        if (p === Game.local) tryPickup(pk);
        else if (!pk.taken && Game.mode === "single") { pk.taken = true; applyPickup(p, pk.kind); }
      }
    }
    for (const o of Game.world.obstacles) {
      if (o.cd > 0) continue;
      const dx = p.x - o.x; if (dx > 70 || dx < -70) continue;
      const gy = Game.terrain.heightAt(o.x);
      if (rectsOverlap(p.rect(), { x: o.x - o.w / 2, y: gy - o.h, w: o.w, h: o.h })) hitObstacle(p, o);
    }
    for (const bp of Game.boosts) {
      if (bp.cd > 0 || !p.onGround) continue;
      if (Math.abs(p.x - bp.x) < bp.w / 2 + 20) {
        bp.cd = 1; p.vx = Math.min(p.vx + 280, p.maxSpeed * 1.5); p.boostT = 0.5;
        if (p === Game.local) { Game.sfx.play("boost"); Game.particles.emit(p.x, p.y + p.h / 2, 10, "#6ee7a8", { spread: 90, speed: 200, life: 0.4, size: 3, gravity: 300 }); }
      }
    }
    for (const hz of Game.hazards) {
      if (hz.cd > 0 || !p.onGround) continue;
      if (Math.abs(p.x - hz.x) < hz.w / 2) {
        hz.cd = 1.5; p.vx *= 0.3; p.stunned = Math.max(p.stunned, 0.5);
        if (p === Game.local) { p.shake = 1; Game.sfx.play("burn"); vibrate(60); Game.particles.emit(p.x, p.y, 14, "#ff7a2c", { spread: 130, speed: 200, life: 0.6, size: 3, gravity: 400 }); }
      }
    }
  }
}

/* ---------- finishing / spectating / results ---------- */
function posKey(p) { return p.finished ? 500000 - (p.finishTime || 400) : p.distance; }
function computePosition() {
  if (Game.mode !== "single" && Game.posList && Game.net) {
    const me = Game.posList.find(e => e.id === Game.net.mySid);
    if (me) return me.p;
  }
  return Game.players.slice().sort((a, b) => posKey(b) - posKey(a)).indexOf(Game.local) + 1;
}
function checkFinishes() {
  const finishX = START_X + Game.mapLen;
  if (Game.state === "racing" && !Game.local.finished && Game.local.x >= finishX) {
    Game.local.finished = true; Game.local.finishTime = Game.raceTime; onLocalFinish();
  }
  for (const b of Game.bots) if (!b.finished && b.x >= finishX) { b.finished = true; b.finishTime = Game.raceTime; }
}
function onLocalFinish() {
  Game.sfx.play("finish");
  for (let i = 0; i < 3; i++) Game.particles.emit(Game.local.x, Game.local.y - 30, 14, ["#f3d34a", "#6ee7a8", "#4fd6ff"][i],
    { spread: 160, speed: 260, life: 0.9, size: 3, gravity: 400 });
  if (Game.mode !== "single") {
    Game.waiting = true;
    Game.net.sendFinish({ time: Game.raceTime, distance: Math.round(Game.local.distance * UNIT_TO_M),
      coins: Game.local.coins, fuel: Math.round(Game.local.fuel) });
    enterSpectate();
  }
}
/* ---- SPECTATE: view other players after finishing, switch between them ---- */
function spectateTargets() {
  const list = [];
  for (const g of Game.ghosts.values()) list.push(g);
  if (Game.net && Game.net.isHost) for (const b of Game.bots) list.push(b);
  return list;
}
function spectateObj() {
  for (const g of Game.ghosts.values()) if (g.sid === Game.spectate) return g;
  for (const b of Game.bots) if (b.sid === Game.spectate) return b;
  return null;
}
function enterSpectate() {
  if (Game.mode === "single" || !Game.net) return;
  const unfinished = spectateTargets().filter(t => !t.finished);
  const first = unfinished.length ? unfinished[0] : spectateTargets()[0];
  if (!first) return;
  Game.spectate = first.sid;
  $("spectateBar").classList.remove("hidden");
  updateSpectateBar();
  hudToast("Spectating " + first.name + " — Tab to switch");
}
function cycleSpectate(dir) {
  const list = spectateTargets(); if (!list.length) return;
  let i = list.findIndex(t => t.sid === Game.spectate);
  if (i < 0) i = 0;
  i = (i + dir + list.length) % list.length;
  Game.spectate = list[i].sid;
  updateSpectateBar();
}
function updateSpectateBar() {
  const o = spectateObj();
  $("spName").textContent = o ? (o.name + (o.finished ? " ✓" : "")) : "—";
}
function exitSpectate() { Game.spectate = null; $("spectateBar").classList.add("hidden"); }

function buildStandingsEntries() {
  const fin = Game.players.filter(p => p.finished).sort((a, b) => a.finishTime - b.finishTime);
  const rest = Game.players.filter(p => !p.finished).sort((a, b) => b.distance - a.distance);
  const st = fin.concat(rest);
  st.forEach((p, i) => { p.finalPlace = i + 1; });
  return st.map(p => ({ name: p.name, place: p.finalPlace, time: p.finished ? p.finishTime : null,
    distance: Math.round(p.distance * UNIT_TO_M), coins: p.coins, fuel: Math.round(p.fuel),
    score: computeScore(p.distance * UNIT_TO_M, p.coins, p.finalPlace, p.fuel), me: p === Game.local }));
}
function recordMapResult(mapId, timeSec, score, vehicleId) {
  const md = MAPS[mapId]; if (!md) return null;
  const medal = medalFor(md, timeSec);
  const rec = save.mapBests[mapId] || {};
  if (timeSec != null && (rec.time == null || timeSec < rec.time)) { rec.time = timeSec; rec.medal = medal; rec.vehicle = vehicleId; }
  if (score > (rec.score || 0)) rec.score = score;
  save.mapBests[mapId] = rec;
  return medal;
}
function applyRecordAndCoins(timeSec, score, vehicleId) {
  const medal = recordMapResult(Game.mapName, timeSec, score, vehicleId);
  save.coins += (MEDAL_COINS[medal] || (timeSec != null ? 30 : 0));
  save.firstRun = false; persist();
  return medal;
}
function endSingle(title) {
  if (Game.state === "done") return;
  Game.state = "done";
  const entries = buildStandingsEntries();
  const me = entries.find(e => e.me);
  const medal = applyRecordAndCoins(me.time, me.score, Game.local.vehicleName);
  const isBest = me.score > save.best;
  if (isBest) save.best = me.score;
  persist();
  presentLeaderboard(title,
    `You finished ${fmtPlace(me.place)}${me.time != null ? " — " + fmtTime(me.time) : ""}` +
    (medal ? ` • ${medal} MEDAL!` : "") + (isBest ? " • NEW BEST!" : ` • Best: ${save.best.toLocaleString()}`),
    entries, "single");
  if (save.firstRun) deferredNamePrompt(me.place);
}
async function deferredNamePrompt(place) {
  save.firstRun = false; persist();
  setTimeout(async () => {
    const nm = await rrModal({ title: "YOU FINISHED " + fmtPlace(place),
      body: "What name goes on the leaderboard?", input: "", placeholder: "Your name", confirm: "SAVE" });
    const v = validateName(nm == null ? "" : nm);
    if (v.ok) { save.name = v.name; persist(); updateHomeStats(); }
  }, 900);
}
function checkSingleRaceEnd(dt) {
  if (Game.state !== "racing" || Game.mode !== "single") return;
  if (Game.local.finished) Game.afterFinishTimer += dt;
  const allDone = Game.players.every(p => p.finished);
  if (allDone || Game.raceTime > Game.raceTimeout || (Game.local.finished && Game.afterFinishTimer > 10)) endSingle("RACE COMPLETE");
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
  const allFin = active.length > 0 && active.every(sid => fl.some(f => f.id === sid));
  if (allFin || (Game.hostEndStarted && Game.hostEndTimer > 45) || Game.raceTime > Game.raceTimeout) hostCompileLeaderboard();
}
function hostCompileLeaderboard() {
  if (Game.state === "done") return;
  Game.state = "done"; Game.sfx.engineStop(); Game.music.stop();
  const fl = Game.net.finishList.slice().sort((a, b) => a.time - b.time);
  const entries = []; let place = 1;
  for (const f of fl) {
    if (!Game.net.players.has(f.id)) continue;
    entries.push({ id: f.id, name: (Game.net.players.get(f.id) || {}).name || "Player", place, time: f.time,
      distance: f.distance, coins: f.coins, fuel: f.fuel, score: computeScore(f.distance, f.coins, place, f.fuel) });
    place++;
  }
  for (const r of Game.net.raceRoster.filter(sid => !fl.some(f => f.id === sid) && Game.net.players.has(sid))
      .map(sid => ({ id: sid, name: (Game.net.players.get(sid) || {}).name || "Player", d: ((Game.net.lastStates.get(sid) || {}).d) || 0 }))
      .sort((a, b) => b.d - a.d)) {
    entries.push({ id: r.id, name: r.name, place, time: null, distance: Math.round(r.d * UNIT_TO_M), coins: 0, fuel: 0,
      score: computeScore(Math.round(r.d * UNIT_TO_M), 0, place, 0) });
    place++;
  }
  Game.net.broadcastLeaderboard(entries);
}
function checkGuestRaceEnd() {
  if (Game.state !== "racing" || Game.mode !== "guest") return;
  if (Game.raceTime > Game.raceTimeout + 10) {
    const entries = Game.players.slice().sort((a, b) => posKey(b) - posKey(a)).map((p, i) => ({
      id: p.sid || p.id, name: p.name, place: i + 1, time: p.finishTime != null ? p.finishTime : null,
      distance: Math.round(p.distance * UNIT_TO_M), coins: p.coins || 0, fuel: Math.round(p.fuel || 0),
      score: computeScore(Math.round(p.distance * UNIT_TO_M), p.coins || 0, i + 1, Math.round(p.fuel || 0)) }));
    presentLeaderboard("RESULTS (provisional)", "Waiting for the host to confirm final standings.", entries, "guest");
  }
}
function presentLeaderboard(title, sub, entries, mode) {
  Game.state = "done"; Game.waiting = false;
  Game.sfx.engineStop(); Game.music.stop(); releaseWakeLock();
  hideOverlays(); exitSpectate();
  $("touchControls").classList.add("hidden"); $("raceList").classList.add("hidden");
  $("resultTitle").textContent = title; $("resultSub").textContent = sub || "";
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
    pod.style.display = "flex";
    pod.innerHTML = [p2, p1, p3].filter(Boolean).map(e =>
      `<div class="pod pod-${e.place}"><div class="medal">${e.place}</div><div class="pname">${escapeHtml(e.me ? "YOU" : e.name)}</div>` +
      `<div class="ptime">${e.time != null ? fmtTime(e.time) : fmtDist(e.distance || 0)}</div></div>`).join("");
  } else { pod.style.display = "none"; pod.innerHTML = ""; }
  const ul = $("resultBoard"); ul.innerHTML = "";
  for (const e of entries) {
    if (p1 && e.place <= 3) continue;
    const li = document.createElement("li");
    if (e.me) li.className = "me";
    li.innerHTML = `<span class="lb-place">${fmtPlace(e.place)}</span>` +
      `<span class="lb-name">${escapeHtml(e.name)}${e.me ? ' <span class="you-tag">(you)</span>' : ""}</span>` +
      `<span class="lb-detail">${(e.time != null ? fmtTime(e.time) : fmtDist(e.distance || 0))} • ${(e.coins || 0)} • ${Math.round(e.score).toLocaleString()} pts</span>`;
    ul.appendChild(li);
  }
  $("btnResultAgain").classList.toggle("hidden", mode !== "single");
  $("btnResultLobby").classList.toggle("hidden", mode !== "host");
  $("overlay-result").classList.remove("hidden");
  if (mode !== "single" && Game.net && Game.net.roomCfg) showResultsInterstitial(Game.net.roomCfg.adSec);
}

/* ---------- ads policy (structural placement: results-only interstitial,
   home/lobby banner slots; empty config renders nothing) ---------- */
const AD_CONFIG = { publisherId: "" };
async function loadAdWithTimeout(ms) {
  if (!AD_CONFIG.publisherId) return false;
  return Promise.race([
    new Promise(res => { /* invoke your ad network SDK here; res(true) on fill */ }),
    new Promise(res => setTimeout(() => res(false), ms)),
  ]);
}
async function showResultsInterstitial(durationSec) {
  try {
    await loadAdWithTimeout(2000);   // never let an ad SDK hang the results screen
    if (AD_CONFIG.publisherId) {
      const el = $("adResult");
      el.classList.remove("hidden");
      el.textContent = "Ad break — " + durationSec + "s (skips automatically; ads never appear during racing or countdown)";
      setTimeout(() => el.classList.add("hidden"), Math.min(30000, Math.max(3000, durationSec * 1000)));
    }
  } catch (e) { /* fail silently, show results immediately */ }
}

/* ---------- camera / HUD / standings ---------- */
function updateCamera(dt) {
  const tgt = (Game.spectate ? spectateObj() : null) || Game.local;
  if (!tgt) return;
  const vx = tgt.vx != null ? tgt.vx : ((tgt.tx != null ? (tgt.tx - tgt.x) : 0) * 8);
  const look = clamp(vx * 0.28, -60, 240);
  Game.cam.x += ((tgt.x + look) - W * 0.38 - Game.cam.x) * Math.min(1, 5 * dt);
  Game.cam.y += (tgt.y - H * 0.55 - Game.cam.y) * Math.min(1, 4 * dt);
  if (save.reducedMotion || qLevel() === "low" || Graphics.degraded >= 3) Game.cam.shake = 0;
  else Game.cam.shake = Math.max(0, Game.cam.shake - 3.5 * dt);
  const maxV = (VEHICLES[tgt.vehicleName] || VEHICLES.sedan).maxSpeed;
  Game.cam.zoom = (save.reducedMotion || qLevel() === "low") ? 1 : clamp(1 - (Math.abs(vx) / maxV) * 0.07, 0.93, 1);
}
function updateRaceList() {
  const el = $("raceList"); if (!el || Game.players.length < 2) return;
  let rows;
  if (Game.mode !== "single" && Game.posList) rows = Game.posList.map(e => ({ sid: e.id, name: e.n, place: e.p, d: e.d, fin: e.f }));
  else rows = Game.players.slice().sort((a, b) => posKey(b) - posKey(a)).map((p, i) => ({
    sid: p.sid || p.id, name: p.name, place: i + 1, d: Math.round(p.distance * UNIT_TO_M), fin: p.finished ? 1 : 0 }));
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
  if (state === "connected") state = rtt < 90 ? "good" : rtt < 150 ? "unstable" : "poor";
  const label = { connected: "CONNECTED", good: "CONNECTED", unstable: "UNSTABLE", connecting: "CONNECTING…",
    reconnecting: "RECONNECTING", disconnected: "DISCONNECTED", poor: "POOR CONN", offline: "OFFLINE" }[state] || state.toUpperCase();
  chip.textContent = label;
  chip.className = "hud-chip hud-conn " + (state === "good" ? "ok" : state === "unstable" ? "warn" : "bad");
  const isHost = net.isHost;
  const shown = isHost ? (Array.from(net.conns.values()).some(e => e.conn.open) ? Math.max(1, rtt || 1) : 1) : rtt;
  if (!shown || state === "reconnecting") { ping.textContent = isHost ? "HOST" : "PING —"; ping.className = "ping-chip"; }
  else { ping.textContent = "PING " + shown + " ms"; ping.className = "ping-chip " + (shown < 90 ? "good" : shown < 150 ? "fair" : "poor"); }
}
function updateEmojiCd() {
  const cd = $("emojiCd"); if (!cd) return;
  const rem = CONFIG.EMOTE_COOLDOWN_MS - (nowMs() - Game._lastEmoji);
  if (rem <= 0) { cd.textContent = "READY"; cd.className = "emoji-cd ready"; }
  else { cd.textContent = "NEXT IN " + Math.ceil(rem / 1000) + "s"; cd.className = "emoji-cd"; }
}
function updateHud(dt) {
  Game.hudAcc += dt; if (Game.hudAcc < 0.1) return; Game.hudAcc = 0;
  const p = Game.local; if (!p) return;
  $("hudPos").textContent = fmtPlace(computePosition());
  $("hudSpeed").textContent = Math.abs(Math.round(p.vx * 0.36)) + " km/h";
  $("hudTime").textContent = fmtTime(Game.raceTime);
  if (p.fuelEnabled) {
    const pct = clamp(p.fuel / p.fuelCap * 100, 0, 100);
    const bar = $("hudFuelBar");
    bar.style.width = pct + "%"; bar.style.background = pct < 25 ? "#e6403c" : "";
    $("hudFuelPct").textContent = Math.round(pct) + "%";
  }
  const pips = $("nitroPips").children;
  for (let i = 0; i < pips.length; i++) pips[i].className = "pip" + (i < p.nitroCharges ? " on" : "");
  $("hudDist").textContent = fmtDist(p.distance * UNIT_TO_M);
  $("hudScore").textContent = Math.floor(p.distance * UNIT_TO_M * 10 + p.coins * 10).toLocaleString();
  let warn = "";
  if (toastT > 0) warn = toastMsg;
  else if (Game.waiting && Game.spectate) warn = "Finished! Spectating — Tab to switch players";
  else if (Game.waiting) warn = "Finished! Waiting for the other players…";
  else if (Game.awaitingGo) warn = "Waiting for host GO…";
  else if (p.fuelEnabled && p.fuel <= 0 && !p.finished) warn = "OUT OF FUEL — coast to a pickup!";
  else if (p.fuelEnabled && p.fuel / p.fuelCap < 0.2 && !p.finished) warn = "LOW FUEL";
  $("hudWarning").textContent = warn;
  updateConnHud(); updateEmojiCd();
  Game.listTick = (Game.listTick + 1) % 3;
  if (Game.listTick === 0) { updateRaceList(); if (Game.spectate) updateSpectateBar(); }
}
function setCountdown(v) {
  const ov = $("countdownOverlay"), el = $("countdownNum");
  ov.classList.remove("hidden");
  el.textContent = v; el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
}

/* ---------- main loop ---------- */
function update(dt) {
  if (Game.state === "countdown") {
    Game.countdownT -= dt;
    const num = Math.ceil(Game.countdownT);
    if (num !== Game.lastCountNum && num > 0) { Game.lastCountNum = num; Game.sfx.play("countdown"); setCountdown(num); }
    if (Game.countdownT <= 0) {
      if (Game.mode === "single") beginGo();
      else if (Game.countdownT < -6) { hudToast("Lost the host — returning to menu"); setTimeout(goHome, 1200); }
    }
    for (const p of Game.players) if (p instanceof VehiclePhysics) p.step(dt, {}, Game.terrain.def, null);
  } else {
    if (Game.goT > 0) { Game.goT -= dt; if (Game.goT <= 0) $("countdownOverlay").classList.add("hidden"); }
    if (Game.state === "racing") Game.raceTime += dt;
    const raceStarted = Game.state === "racing";
    if (Game.hintT > 0) { Game.hintT -= dt; if (Game.hintT <= 0 && !isTouch) $("keyHints").classList.add("faded"); }
    const inp = { accel: input.accel, brake: input.brake, left: input.left, right: input.right, nitro: nitroQueued, jump: jumpQueued };
    nitroQueued = false; jumpQueued = false;
    if (Game.local.finished) { inp.accel = false; inp.brake = true; inp.left = inp.right = false; }
    Game.local.step(dt, inp, Game.terrain.def, { particles: Game.particles, sfx: Game.sfx, raceStarted });
    if (Game.local.shake) { Game.cam.shake = Math.max(Game.cam.shake, Game.local.shake); Game.local.shake = 0; }
    if (!Game.local.fuelEnabled && raceStarted && !Game.local.finished)
      Game.local.nitroCharges = clamp(Game.local.nitroCharges + driftOrDraftCharge(Game.local, Game.players, dt), 0, Game.local.maxNitro);
    const L = Game.local, Ldef = VEHICLES[L.vehicleName] || VEHICLES.sedan;
    if (L.nitroTimer > 0 && !save.reducedMotion) {
      L._flameCd -= dt;
      if (L._flameCd <= 0) { L._flameCd = 0.03; Game.particles.emit(L.x - L.w * 0.55, L.y + 3, 1, Ldef.flame[1], { spread: 30, speed: 60, life: 0.35, size: 4, gravity: -60 }); }
    }
    if (L.boostT > 0 && !save.reducedMotion) {
      L._streakCd -= dt;
      if (L._streakCd <= 0) { L._streakCd = 0.05; Game.particles.emit(L.x - L.w * 0.6, L.y + L.h * 0.2, 1, "#6ee7a8", { spread: 10, speed: 240, life: 0.25, size: 1, gravity: 0, shape: "rect", pw: 26, ph: 3 }); }
    }
    if (Game.mode === "single" || Game.mode === "host") {
      for (const b of Game.bots) if (!b.finished) b.step(dt, raceStarted ? botInput(b, dt) : {}, Game.terrain.def, { particles: Game.particles });
      if (Game.mode === "host" && Game.net) {
        for (const b of Game.bots) {
          const s = { x: Math.round(b.x), y: Math.round(b.y), a: Math.round(b.angle), v: b.vehicleName,
            n: b.nitroTimer > 0, f: b.finished, d: Math.round(b.distance) };
          Game.net.lastStates.set(b.sid, s);
          Game.net.broadcast({ t: "peerstate", id: b.sid, s });
        }
      }
    }
    for (const g of Game.ghosts.values()) {
      g.x = lerp(g.x, g.tx, Math.min(1, 10 * dt));
      g.y = lerp(g.y, g.ty, Math.min(1, 10 * dt));
      g.angle = lerp(g.angle, g.ta, Math.min(1, 10 * dt));
      g.wheelAngle += (Math.abs(g.tx - g.x) / Math.max(6, VEHICLES[g.vehicleName].wr || 8)) * 0.5;
    }
    updateWorldInteractions(dt);
    checkFinishes();
    if (Game.state === "racing" && Game.mode === "single" && !Game.local.finished && Game.local.fuelEnabled) {
      if (Game.local.fuel <= 0 && Math.abs(Game.local.vx) < 15) Game.stalledFor += dt; else Game.stalledFor = 0;
      if (Game.stalledFor > 5) { endSingle("OUT OF FUEL"); return; }
    }
    if (Game.mode === "single") checkSingleRaceEnd(dt);
    else if (Game.mode === "host") {
      checkHostRaceEnd(dt);
      Game.posAcc += dt;
      if (Game.posAcc >= 0.5) { Game.posAcc = 0; Game.net.broadcastPositions(); }
    } else checkGuestRaceEnd();
    if (Game.mode !== "single" && Game.net) {
      Game.netAcc += dt;
      if (Game.netAcc >= 1 / CONFIG.NET_SEND_HZ) {
        Game.netAcc = 0;
        Game.net.sendState({
          q: (Game.net._seqSelf = (Game.net._seqSelf || 0) + 1),
          x: Math.round(Game.local.x), y: Math.round(Game.local.y), a: Math.round(Game.local.angle),
          v: Game.local.vehicleName, n: Game.local.nitroTimer > 0, f: Game.local.finished,
          d: Math.round(Game.local.distance), fuel: Math.round(Game.local.fuel * 10) / 10, vx: Math.round(Game.local.vx),
        });
      }
    }
    Game.musAcc += dt;
    if (Game.musAcc >= 0.5) { Game.musAcc = 0; updateMusicIntensity(Game.local.distance / Math.max(1, Game.mapLen), computePosition(), Game.players.length); }
    Game._engAcc += dt;
    if (Game._engAcc >= 0.1) {
      Game._engAcc = 0;
      Game.sfx.engineUpdate(Game.local.vx, raceStarted && input.accel && !Game.local.finished, Game.local.nitroTimer > 0);
    }
  }
  if (toastT > 0) toastT -= dt;
  for (const b of Game.bubbles) b.t -= dt;
  Game.bubbles = Game.bubbles.filter(b => b.t > 0);
  Game.particles.update(dt);
  updateCamera(dt);
  updateHud(dt);
  trackFrameTime(dt);
  if (DEBUG_MODE) updateDebug(dt);
}
function updateDebug(dt) {
  Game.dbgAcc += dt;
  Game.fpsAvg = Game.fpsAvg * 0.95 + (1 / Math.max(dt, 0.001)) * 0.05;
  if (Game.dbgAcc < 0.5) return;
  Game.dbgAcc = 0;
  const net = Game.net, md = MAPS[Game.mapName] || {};
  $("debugPanel").innerHTML =
    `FPS ${Math.round(Game.fpsAvg)} · state ${Game.state} · tier ${qLevel()}+${Graphics.degraded}<br>` +
    `map ${Game.mapName} (${md.difficulty || "—"}) · seed ${Game.terrain ? Game.terrain.seed : "—"}<br>` +
    `veh ${Game.local ? Game.local.vehicleName : "—"} · surf ${Game.local ? Game.local.surfaceId : "—"}<br>` +
    `vx ${Game.local ? Math.round(Game.local.vx) : 0} · fuel ${Game.local ? Math.round(Game.local.fuel) : 0} · crashes ${Game.local ? Game.local.crashes : 0}<br>` +
    `spectate ${Game.spectate || "—"} · players ${net ? net.players.size : "—"} · conn ${net ? net.connState : "—"} · rtt ${net ? net.rtt : "—"}ms<br>` +
    (net && net.audit && net.audit.length ? "roadguard " + net.audit.slice(-3).map(e => e.sev + ":" + e.rule).join(" | ") : "");
}

/* ---------- RENDERING ---------- */
function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function drawSkyExtras(c, def, W2, H2, t) {
  if (def.biome === "MOON") {
    c.fillStyle = "#e8e8f2";
    for (let i = 0; i < 60; i++) {
      const sx = (i * 137.5) % W2, sy = (i * 91.7) % (H2 * 0.65);
      c.fillRect(sx, sy, (i % 7 === 0) ? 2 : 1.4, (i % 7 === 0) ? 2 : 1.4);
    }
    c.save();
    c.beginPath(); c.arc(W2 * 0.8, H2 * 0.18, 24, 0, TAU);
    c.fillStyle = "#3c6fd0"; c.fill(); c.clip();
    c.fillStyle = "#5a9c50";
    c.beginPath(); c.arc(W2 * 0.8 - 10, H2 * 0.18 - 4, 9, 0, TAU); c.fill();
    c.beginPath(); c.arc(W2 * 0.8 + 8, H2 * 0.18 + 8, 7, 0, TAU); c.fill();
    c.fillStyle = "#ffffff55";
    c.beginPath(); c.ellipse(W2 * 0.8 + 6, H2 * 0.18 - 8, 14, 5, -0.5, 0, TAU); c.fill();
    c.restore();
    c.strokeStyle = "#ffffff33"; c.lineWidth = 1;
    c.beginPath(); c.arc(W2 * 0.8, H2 * 0.18, 26, 0, TAU); c.stroke();
  } else if (def.biome === "KINGDOM") {
    c.fillStyle = "#f0e8ff";
    for (let i = 0; i < 24; i++) c.fillRect((i * 151.3) % W2, (i * 73.1) % (H2 * 0.5), 1.6, 1.6);
    c.fillStyle = "#f8f4e0"; c.beginPath(); c.arc(W2 * 0.16, H2 * 0.16, 16, 0, TAU); c.fill();
    c.fillStyle = "#d0c8e8"; c.beginPath(); c.arc(W2 * 0.23, H2 * 0.22, 8, 0, TAU); c.fill();
  } else if (def.biome === "DESERT") {
    c.fillStyle = "#fff2c8";
    c.beginPath(); c.arc(W2 * 0.78, H2 * 0.2, 34, 0, TAU); c.fill();
    c.strokeStyle = "#fff2c866"; c.lineWidth = 3;
    c.beginPath(); c.arc(W2 * 0.78, H2 * 0.2, 44, 0, TAU); c.stroke();
  } else if (def.biome === "VOLCANO") {
    c.fillStyle = "#3c1a14";
    c.beginPath(); c.moveTo(W2 * 0.55, H2 * 0.55); c.lineTo(W2 * 0.62, H2 * 0.1); c.lineTo(W2 * 0.7, H2 * 0.55); c.closePath(); c.fill();
    const pulse = 0.6 + 0.4 * Math.sin(t * 0.002);
    c.fillStyle = "#e6531c"; c.fillRect(W2 * 0.615, H2 * 0.1, 6, 26);
    const gg = c.createRadialGradient(W2 * 0.62, H2 * 0.12, 2, W2 * 0.62, H2 * 0.12, 60);
    gg.addColorStop(0, "rgba(255,120,40," + 0.35 * pulse + ")"); gg.addColorStop(1, "rgba(255,120,40,0)");
    c.fillStyle = gg; c.fillRect(W2 * 0.5, 0, W2 * 0.25, H2 * 0.4);
  } else if (def.biome === "CITY") {
    c.fillStyle = "#e8e8f2";
    for (let i = 0; i < 40; i++) {
      const sx = (i * 127.7) % W2, sy = (i * 61.3) % (H2 * 0.4);
      c.globalAlpha = 0.4 + 0.5 * Math.sin(t * 0.001 * (i % 5 + 2) + i);
      c.fillRect(sx, sy, 1.6, 1.6);
    }
    c.globalAlpha = 1;
  }
}
function drawClouds(c, def, W2, H2, t) {
  const n = qNum(0, 3, 6);
  if (!n) return;
  const dark = def.weather === "night";
  for (let i = 0; i < n; i++) {
    const x = ((i * 337 + t * 0.012 * (30 + (i % 3) * 12)) % (W2 + 240)) - 120;
    const y = H2 * 0.1 + (i % 3) * 28;
    c.fillStyle = dark ? "rgba(40,44,70,0.7)" : "rgba(255,255,255,0.75)";
    c.beginPath();
    c.ellipse(x, y, 34, 12, 0, 0, TAU);
    c.ellipse(x - 20, y + 4, 20, 9, 0, 0, TAU);
    c.ellipse(x + 22, y + 5, 24, 10, 0, 0, TAU);
    c.fill();
  }
}
function drawMidLayer(c, terrain, camX, camY, W2, H2, t) {
  const b = terrain.def.biome;
  const px = camX * 0.55;
  const baseY = H2 * 0.66 - camY * 0.25;
  if (baseY > H2 + 60) return;
  switch (b) {
    case "HIGHWAY":
      c.fillStyle = "#4a5a78";
      for (let sx = -40; sx < W2 + 40; sx += 60) {
        const wx = px + sx;
        const bh = 50 + hash01(Math.floor(wx / 60)) * 70;
        c.fillRect(sx, baseY - bh, 44, bh + 40);
        if (qBool(true, true)) {
          c.fillStyle = "#ffd97a";
          for (let r = 0; r < Math.floor(bh / 24); r++)
            for (let cc = 0; cc < 2; cc++)
              if (hash01(r * 11 + cc + Math.floor(wx / 60)) > 0.55)
                c.fillRect(sx + 8 + cc * 18, baseY - bh + 10 + r * 24, 8, 9);
          c.fillStyle = "#4a5a78";
        }
      }
      break;
    case "CITY":
      for (let sx = -40; sx < W2 + 40; sx += 52) {
        const wx = px + sx;
        const bh = 80 + hash01(Math.floor(wx / 52)) * 130;
        c.fillStyle = "#181c30"; c.fillRect(sx, baseY - bh, 40, bh + 40);
        if (qBool(true, true)) {
          for (let r = 0; r < Math.floor(bh / 22); r++)
            for (let cc = 0; cc < 3; cc++) {
              if (hash01(r * 17 + cc + Math.floor(wx / 52)) <= 0.5) continue;
              const tw = Math.sin(t * 0.001 * (1 + (r % 3)) + r * cc) > -0.6;
              c.fillStyle = tw ? (hash01(r + cc) > 0.5 ? "#5fd0ff" : "#ff6ba8") : "#2a2e48";
              c.fillRect(sx + 6 + cc * 11, baseY - bh + 8 + r * 22, 7, 8);
            }
        }
        c.strokeStyle = "#2c3450"; c.lineWidth = 1.5; c.strokeRect(sx, baseY - bh, 40, bh + 40);
      }
      break;
    case "HILLS":
      c.fillStyle = "#3e6234";
      c.beginPath(); c.moveTo(-10, baseY + 40);
      for (let sx = 0; sx <= W2 + 10; sx += 24) {
        const wx = px * 1.1 + sx;
        c.lineTo(sx, baseY - 40 - Math.sin(wx * 0.004) * 34 - Math.sin(wx * 0.0013) * 26);
      }
      c.lineTo(W2 + 10, baseY + 40); c.closePath(); c.fill();
      break;
    case "FOREST":
      c.fillStyle = "#22381e";
      c.beginPath(); c.moveTo(-10, baseY + 40);
      for (let sx = 0; sx <= W2 + 10; sx += 18) {
        const wx = px + sx;
        const j = Math.sin(wx * 0.01) * 8 + (hash01(Math.floor(wx / 18)) - 0.5) * 14;
        c.lineTo(sx, baseY - 30 + j);
      }
      c.lineTo(W2 + 10, baseY + 40); c.closePath(); c.fill();
      break;
    case "DESERT":
      for (let d = 0; d < 2; d++) {
        c.fillStyle = d === 0 ? "#c89858" : "#b8844a";
        c.beginPath(); c.moveTo(-10, baseY + 40);
        for (let sx = 0; sx <= W2 + 10; sx += 30) {
          const wx = px * (0.8 + d * 0.2) + sx;
          c.lineTo(sx, baseY - 16 - d * 14 - Math.sin(wx * 0.0022 + d * 2) * 30);
        }
        c.lineTo(W2 + 10, baseY + 40); c.closePath(); c.fill();
      }
      break;
    case "SNOW":
      c.fillStyle = "#d8e4f0";
      c.beginPath(); c.moveTo(-10, baseY + 40);
      for (let sx = 0; sx <= W2 + 10; sx += 46) {
        const wx = px + sx;
        const pk = 60 + hash01(Math.floor(wx / 46)) * 70;
        c.lineTo(sx, baseY - pk); c.lineTo(sx + 23, baseY - pk * 0.4);
      }
      c.lineTo(W2 + 10, baseY + 40); c.closePath(); c.fill();
      c.fillStyle = "#b8cce0";
      c.beginPath(); c.moveTo(-10, baseY + 40);
      for (let sx = 0; sx <= W2 + 10; sx += 46) {
        const wx = px + sx;
        const pk = 60 + hash01(Math.floor(wx / 46)) * 70;
        c.lineTo(sx + 18, baseY - pk); c.lineTo(sx + 23, baseY - pk * 0.4);
      }
      c.lineTo(W2 + 10, baseY + 40); c.closePath(); c.fill();
      break;
    case "CANYON":
      for (let row = 0; row < 2; row++) {
        c.fillStyle = row === 0 ? "#8a5a40" : "#6e4430";
        for (let sx = -30; sx < W2 + 30; sx += 90) {
          const wx = px * (0.8 + row * 0.15) + sx;
          const hgt = 60 + hash01(Math.floor(wx / 90) + row * 7) * 80;
          const wdt = 60 + hash01(Math.floor(wx / 90) + 3) * 30;
          c.beginPath();
          c.moveTo(sx, baseY + 40); c.lineTo(sx + 12, baseY - hgt); c.lineTo(sx + 12 + wdt, baseY - hgt);
          c.lineTo(sx + 24 + wdt, baseY + 40); c.closePath(); c.fill();
        }
      }
      break;
    case "VOLCANO":
      c.fillStyle = "#2a1614";
      c.beginPath(); c.moveTo(-10, baseY + 40);
      for (let sx = 0; sx <= W2 + 10; sx += 34) {
        const wx = px + sx;
        c.lineTo(sx, baseY - 30 - Math.abs(Math.sin(wx * 0.0016)) * 90);
      }
      c.lineTo(W2 + 10, baseY + 40); c.closePath(); c.fill();
      if (qBool(true, true)) {
        for (let i = 0; i < 3; i++) {
          const cx = ((i * 281 + px * 0.4) % (W2 + 100)) - 50;
          for (let s = 0; s < 4; s++) {
            const yy = baseY - 90 - s * 16 - ((t * 0.01) % 16);
            c.fillStyle = "rgba(90,80,84," + (0.35 - s * 0.07) + ")";
            c.beginPath(); c.ellipse(cx + Math.sin(t * 0.001 + s + i) * 6, yy, 12 + s * 5, 8 + s * 3, 0, 0, TAU); c.fill();
          }
        }
      }
      break;
    case "MOON":
      c.fillStyle = "#22222e";
      for (let sx = -30; sx < W2 + 30; sx += 120) {
        const wx = px + sx;
        const r = 40 + hash01(Math.floor(wx / 120)) * 50;
        c.beginPath(); c.ellipse(sx, baseY + 10, r, r * 0.35, 0, 0, TAU); c.fill();
      }
      break;
    case "KINGDOM": {
      c.fillStyle = "#5a6480";
      const cx = (px * 0.5) % (W2 * 2);
      const drawCastle = (bx) => {
        if (bx < -200 || bx > W2 + 200) return;
        c.fillRect(bx - 70, baseY - 60, 140, 100);
        for (const tx of [bx - 70, bx - 30, bx + 30, bx + 66]) {
          c.fillRect(tx, baseY - 130, 22, 170);
          c.beginPath(); c.moveTo(tx - 4, baseY - 130); c.lineTo(tx + 11, baseY - 152); c.lineTo(tx + 26, baseY - 130); c.closePath(); c.fill();
        }
        c.fillStyle = "#e6533c";
        c.beginPath(); c.moveTo(bx + 44, baseY - 138); c.lineTo(bx + 66, baseY - 132); c.lineTo(bx + 44, baseY - 126); c.closePath(); c.fill();
        c.fillStyle = "#5a6480";
      };
      drawCastle(cx); drawCastle(cx + W2 * 1.2); drawCastle(cx - W2 * 1.2);
      break;
    }
  }
}
function drawTerrain(c, terrain, camX, camY, W2, H2) {
  const def = terrain.def;
  const t = performance.now();
  const q = qLevel();
  c.fillStyle = cachedGrad("sky:" + def.id, W2, H2, () => {
    const g = c.createLinearGradient(0, 0, 0, H2);
    g.addColorStop(0, def.sky[0]); g.addColorStop(1, def.sky[1]); return g;
  });
  c.fillRect(0, 0, W2, H2);
  drawSkyExtras(c, def, W2, H2, t);
  if (def.weather !== "night" && def.biome !== "MOON" && def.biome !== "VOLCANO") drawClouds(c, def, W2, H2, t);
  if (def.far) {
    c.fillStyle = def.far;
    c.beginPath(); c.moveTo(0, H2);
    for (let sx = 0; sx <= W2; sx += 16) {
      const wx = camX * 0.3 + sx;
      c.lineTo(sx, H2 * 0.62 + Math.sin(wx * 0.0011 + 1) * 60 + Math.sin(wx * 0.0041 + 3) * 26);
    }
    c.lineTo(W2, H2); c.closePath(); c.fill();
  }
  if (q !== "low" && qSettings().scenery) drawMidLayer(c, terrain, camX, camY, W2, H2, t);
  const step = 8;
  const n = Math.ceil(W2 / step) + 2;
  if (!_hyBuf || _hyBuf.length < n) _hyBuf = new Float32Array(n);
  const hy = _hyBuf;
  for (let i = 0; i < n; i++) hy[i] = terrain.heightAt(camX + i * step) - camY;
  const lutY = (sx) => hy[clamp(Math.round(sx / step), 0, n - 1)];
  if (q !== "low") {
    c.beginPath(); c.moveTo(0, H2 + 60);
    for (let i = 0; i < n; i++) c.lineTo(i * step, hy[i] + 15);
    c.lineTo(W2, H2 + 60); c.closePath();
    c.fillStyle = shade(def.ground, 0.55); c.fill();
  }
  c.beginPath(); c.moveTo(0, H2 + 60);
  for (let i = 0; i < n; i++) c.lineTo(i * step, hy[i]);
  c.lineTo(W2, H2 + 60); c.closePath();
  c.fillStyle = def.ground; c.fill();
  c.beginPath();
  c.strokeStyle = def.accent; c.lineWidth = 3;
  c.moveTo(0, hy[0] + 4);
  for (let i = 1; i < n; i++) c.lineTo(i * step, hy[i] + 4);
  c.stroke();
  if (terrain.def.surfaces.length > 1) {
    const firstSeg = Math.floor(camX / SEG_LEN);
    const lastSeg = firstSeg + Math.ceil(W2 / SEG_LEN) + 1;
    for (let seg = firstSeg; seg <= lastSeg; seg++) {
      const sx0 = seg * SEG_LEN - camX, sx1 = sx0 + SEG_LEN;
      if (sx1 < 0 || sx0 > W2) continue;
      const sid = surfaceFor(terrain.def, terrain.seed, seg * SEG_LEN);
      const surf = SURFACES[sid];
      if (!surf) continue;
      c.strokeStyle = surf.band; c.lineWidth = 6; c.globalAlpha = 0.9;
      c.beginPath();
      let first = true;
      for (let sx = Math.max(0, sx0); sx <= Math.min(W2, sx1); sx += 8) {
        const gy = lutY(sx) + 9;
        if (first) { c.moveTo(sx, gy); first = false; } else c.lineTo(sx, gy);
      }
      c.stroke();
      c.globalAlpha = 1;
      if (q === "low") continue;
      if (sid === "ice") {
        c.strokeStyle = "#ffffffcc"; c.lineWidth = 2;
        for (let k = 1; k <= 2; k++) {
          const px2 = Math.max(0, sx0) + (SEG_LEN / 3) * k - camX % SEG_LEN;
          if (px2 < 0 || px2 > W2) continue;
          c.beginPath(); c.moveTo(px2, lutY(px2) + 8); c.lineTo(px2 + 26, lutY(px2 + 26) + 6); c.stroke();
        }
      } else if (sid === "sand" || sid === "snow") {
        c.fillStyle = sid === "sand" ? "#f0d8a0" : "#ffffff";
        for (let k = 0; k < 4; k++) {
          const px2 = Math.max(0, sx0) + 90 + k * 200 - (camX % SEG_LEN);
          if (px2 < 0 || px2 > W2) continue;
          c.fillRect(px2, lutY(px2) + 8, 4, 3);
          c.fillRect(px2 + 30, lutY(px2 + 30) + 10, 3, 3);
        }
      } else if (sid === "mud") {
        c.strokeStyle = shade(surf.band, 0.7); c.lineWidth = 3;
        for (let k = 0; k < 3; k++) {
          const px2 = Math.max(0, sx0) + 120 + k * 250 - (camX % SEG_LEN);
          if (px2 < 0 || px2 > W2) continue;
          c.beginPath(); c.moveTo(px2, lutY(px2) + 9);
          c.quadraticCurveTo(px2 + 14, lutY(px2 + 14) + 4, px2 + 28, lutY(px2 + 28) + 9); c.stroke();
        }
      } else if (sid === "rock") {
        c.strokeStyle = shade(surf.band, 0.75); c.lineWidth = 2;
        for (let k = 0; k < 4; k++) {
          const px2 = Math.max(0, sx0) + 100 + k * 190 - (camX % SEG_LEN);
          if (px2 < 0 || px2 > W2) continue;
          c.beginPath(); c.moveTo(px2, lutY(px2) + 8); c.lineTo(px2 + 10, lutY(px2 + 10) + 13); c.stroke();
        }
      }
    }
  }
  if (def.biome === "HIGHWAY" || def.biome === "CITY") {
    c.fillStyle = "#e6d23c";
    const first = Math.floor(camX / 46) * 46;
    for (let wx = first; wx < camX + W2 + 46; wx += 46) {
      const gy = terrain.heightAt(wx) - camY + (def.surfaces.length > 1 ? 16 : 9);
      c.save(); c.translate(wx - camX, gy); c.rotate(Math.atan(terrain.slopeAt(wx)));
      c.fillRect(0, 0, 24, 3.5); c.restore();
    }
  }
}
function drawScenery(c, terrain, camX, camY, W2, H2) {
  const biome = terrain.def.biome;
  const step = qNum(420, 300, 230);
  const t = performance.now();
  const first = Math.floor((camX - 100) / step) * step;
  for (let wx = first; wx < camX + W2 + step; wx += step) {
    if (wx < 400) continue;
    const h1 = hash01(Math.floor(wx / step));
    if (h1 < 0.4) continue;
    const h2 = hash01(Math.floor(wx / step) + 7);
    const sx = wx - camX + (h1 - 0.5) * 60;
    const gy = terrain.heightAt(wx) - camY;
    if (gy < -160 || gy > H2 + 160) continue;
    if (biome === "HIGHWAY") {
      if (h1 > 0.82) {
        const bh = 60 + h2 * 90, bw = 46 + h2 * 30;
        c.fillStyle = "#33404f"; c.fillRect(sx - bw / 2, gy - bh, bw, bh);
        c.fillStyle = "#ffd97a";
        for (let r = 0; r < Math.floor(bh / 22); r++)
          for (let cc = 0; cc < 3; cc++)
            if (hash01(r * 13 + cc + Math.floor(wx / step)) > 0.55)
              c.fillRect(sx - bw / 2 + 6 + cc * (bw - 12) / 3, gy - bh + 8 + r * 22, (bw - 18) / 4, 8);
      } else if (h1 > 0.6) {
        c.fillStyle = "#c9c9d4";
        c.fillRect(sx - 26, gy - 18, 52, 5);
        c.fillRect(sx - 24, gy - 13, 4, 13); c.fillRect(sx + 20, gy - 13, 4, 13);
        c.fillStyle = "#3c82d2"; c.fillRect(sx - 8, gy - 34, 16, 12);
        c.fillStyle = "#fff"; c.fillRect(sx - 5, gy - 31, 10, 2);
        c.fillStyle = "#8a8a96"; c.fillRect(sx - 1, gy - 22, 2, 22);
      } else {
        c.fillStyle = "#586070"; c.fillRect(sx - 2, gy - 78, 4, 78); c.fillRect(sx - 2, gy - 78, 22, 4);
        c.fillStyle = "#ffe9a0"; c.fillRect(sx + 14, gy - 75, 8, 5);
      }
    } else if (biome === "CITY") {
      if (h1 > 0.75) {
        c.fillStyle = "#3a3f52"; c.fillRect(sx - 2, gy - 86, 5, 86); c.fillRect(sx - 2, gy - 86, 26, 5);
        c.fillStyle = "#ffe9a0"; c.fillRect(sx + 18, gy - 84, 9, 6);
        const lg = c.createRadialGradient(sx + 22, gy - 78, 4, sx + 22, gy - 40, 60);
        lg.addColorStop(0, "rgba(255,220,120,0.22)"); lg.addColorStop(1, "rgba(255,220,120,0)");
        c.fillStyle = lg;
        c.beginPath(); c.moveTo(sx + 22, gy - 78); c.lineTo(sx - 20, gy); c.lineTo(sx + 64, gy); c.closePath(); c.fill();
      } else {
        c.fillStyle = "#c94a3c"; c.fillRect(sx - 5, gy - 14, 10, 14); c.fillRect(sx - 7, gy - 16, 14, 4);
        c.fillStyle = "#e8e8f0"; c.fillRect(sx - 3, gy - 10, 6, 2);
      }
    } else if (biome === "HILLS") {
      c.fillStyle = "#5a4028"; c.fillRect(sx - 3, gy - 26, 6, 26);
      c.fillStyle = "#3f7a34";
      const r = 16 + h2 * 8;
      c.beginPath(); c.arc(sx, gy - 34, r, 0, TAU); c.fill();
      c.beginPath(); c.arc(sx - 10, gy - 26, r * 0.7, 0, TAU); c.fill();
      c.beginPath(); c.arc(sx + 10, gy - 26, r * 0.7, 0, TAU); c.fill();
      if (h2 > 0.6) { c.fillStyle = "#8a8a90"; c.beginPath(); c.ellipse(sx + 40, gy - 5, 10, 7, 0, 0, TAU); c.fill(); }
    } else if (biome === "FOREST") {
      const big = h2 > 0.5;
      const th = big ? 40 : 30;
      c.fillStyle = "#4a3320"; c.fillRect(sx - 3, gy - th, 6, th);
      c.fillStyle = big ? "#234a1e" : "#2c5a26";
      for (let i = 0; i < 3; i++) {
        const ty = gy - th - i * 12, tw = (big ? 26 : 20) - i * 5;
        c.beginPath(); c.moveTo(sx, ty - 20); c.lineTo(sx - tw, ty); c.lineTo(sx + tw, ty); c.closePath(); c.fill();
      }
      if (h2 > 0.7) {
        c.strokeStyle = "#4a3320"; c.lineWidth = 3;
        c.beginPath(); c.moveTo(sx + 3, gy); c.quadraticCurveTo(sx + 16, gy - 6, sx + 26, gy - 2); c.stroke();
        c.fillStyle = "#6e6e73"; c.beginPath(); c.ellipse(sx - 34, gy - 4, 9, 6, 0, 0, TAU); c.fill();
      }
    } else if (biome === "SNOW") {
      c.fillStyle = "#5a4028"; c.fillRect(sx - 3, gy - 24, 6, 24);
      for (let i = 0; i < 3; i++) {
        const ty = gy - 24 - i * 14, tw = 22 - i * 5;
        c.fillStyle = "#2e5c40";
        c.beginPath(); c.moveTo(sx, ty - 18); c.lineTo(sx - tw, ty); c.lineTo(sx + tw, ty); c.closePath(); c.fill();
        c.fillStyle = "#e8f0f8";
        c.beginPath(); c.moveTo(sx, ty - 18); c.lineTo(sx - tw * 0.5, ty - 9); c.lineTo(sx + tw * 0.5, ty - 9); c.closePath(); c.fill();
      }
    } else if (biome === "DESERT") {
      const tall = h2 > 0.5;
      const ch = tall ? 46 : 32;
      c.fillStyle = "#3c825a";
      c.fillRect(sx - 5, gy - ch, 10, ch);
      c.fillRect(sx - 16, gy - ch + 8, 10, 6); c.fillRect(sx - 16, gy - ch + 8, 5, tall ? 18 : 12);
      c.fillRect(sx + 6, gy - ch + 12, 10, 6); c.fillRect(sx + 11, gy - ch + 12, 5, tall ? 20 : 14);
      if (h2 > 0.6) { c.fillStyle = "#b09060"; c.beginPath(); c.ellipse(sx + 44, gy - 4, 12, 8, 0, 0, TAU); c.fill(); }
    } else if (biome === "CANYON") {
      const th = 70 + h2 * 110;
      c.fillStyle = "#5c3a28";
      c.beginPath();
      c.moveTo(sx - 22, gy); c.lineTo(sx - 10, gy - th); c.lineTo(sx + 10, gy - th * 0.85); c.lineTo(sx + 22, gy);
      c.closePath(); c.fill();
      c.fillStyle = "#7a4a34"; c.fillRect(sx - 10, gy - th, 6, th * 0.8);
    } else if (biome === "VOLCANO") {
      c.fillStyle = "#2a1a18";
      c.beginPath(); c.moveTo(sx - 22, gy); c.lineTo(sx - 8, gy - 30 - h2 * 24);
      c.lineTo(sx + 8, gy - 22 - h2 * 18); c.lineTo(sx + 24, gy); c.closePath(); c.fill();
      c.strokeStyle = "#e6531c"; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(sx - 6, gy - 26); c.lineTo(sx + 2, gy - 14); c.lineTo(sx - 2, gy); c.stroke();
      if (h2 > 0.6) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 0.004 + wx);
        c.fillStyle = "rgba(255,110,40," + (0.5 + pulse * 0.4) + ")";
        c.beginPath(); c.ellipse(sx + 34, gy - 3, 8, 4, 0, 0, TAU); c.fill();
      }
    } else if (biome === "MOON") {
      c.fillStyle = "#1c1c26";
      c.beginPath(); c.ellipse(sx, gy + 4, 16 + h2 * 14, 5, 0, 0, TAU); c.fill();
      if (h2 > 0.6) { c.fillStyle = "#74747e"; c.beginPath(); c.ellipse(sx + 38, gy - 6, 9, 6, h2, 0, TAU); c.fill(); }
    } else if (biome === "KINGDOM") {
      if (h1 > 0.7) {
        const th = 70 + h2 * 70;
        c.fillStyle = "#7a7484"; c.fillRect(sx - 14, gy - th, 28, th);
        c.fillStyle = "#5a5464";
        for (let i = 0; i < 4; i++) c.fillRect(sx - 14 + i * 8, gy - th - 6, 5, 8);
        c.fillStyle = "#4a4454"; c.fillRect(sx - 4, gy - th + 16, 8, 12);
        c.fillStyle = "#e6533c";
        c.beginPath(); c.moveTo(sx, gy - th - 4); c.lineTo(sx + 22, gy - th + 2); c.lineTo(sx, gy - th + 8); c.closePath(); c.fill();
        const fl = 3 + Math.sin(t * 0.01 + wx) * 2;
        c.fillStyle = "#ff9a2e"; c.beginPath(); c.ellipse(sx + 18, gy - th + 26, 3, fl, 0, 0, TAU); c.fill();
        c.fillStyle = "#ffe86e"; c.beginPath(); c.ellipse(sx + 18, gy - th + 26, 1.5, fl * 0.6, 0, 0, TAU); c.fill();
      } else if (h1 > 0.55) {
        c.fillStyle = "#5a4028";
        c.fillRect(sx - 30, gy - 40, 8, 40); c.fillRect(sx + 22, gy - 40, 8, 40);
        c.fillStyle = "#6e4b28"; c.fillRect(sx - 30, gy - 44, 60, 8);
        c.strokeStyle = "#5a4028"; c.lineWidth = 3;
        c.beginPath(); c.moveTo(sx - 26, gy - 44); c.quadraticCurveTo(sx, gy - 60, sx + 26, gy - 44); c.stroke();
      } else {
        c.fillStyle = "#8a8494"; c.fillRect(sx - 2, gy - 56, 4, 56);
        const sway = Math.sin(t * 0.002 + wx) * 3;
        c.fillStyle = "#4f7fd0";
        c.beginPath(); c.moveTo(sx + 2, gy - 56); c.lineTo(sx + 26 + sway, gy - 50); c.lineTo(sx + 2, gy - 44); c.closePath(); c.fill();
      }
    }
  }
}
function drawFlag(c, terrain, camX, camY, W2, wx, color, label) {
  const sx = wx - camX;
  if (sx < -80 || sx > W2 + 80) return;
  const gy = terrain.heightAt(wx) - camY;
  c.fillStyle = "#20242c"; c.fillRect(sx - 2, gy - 130, 5, 130);
  if (color) {
    c.fillStyle = color;
    c.beginPath(); c.moveTo(sx + 3, gy - 130); c.lineTo(sx + 46, gy - 118); c.lineTo(sx + 3, gy - 106); c.closePath(); c.fill();
  } else {
    for (let r = 0; r < 2; r++) for (let cc = 0; cc < 5; cc++) {
      c.fillStyle = ((r + cc) % 2 === 0) ? "#fff" : "#16161c";
      c.fillRect(sx + 3 + cc * 9, gy - 130 + r * 9, 9, 9);
    }
  }
  c.fillStyle = "#fff"; setFont(c, "bold 11px sans-serif"); c.textAlign = "center";
  c.fillText(label, sx, gy - 138);
}
function drawRaceMarkers(c, terrain, camX, camY, W2, mapLen) {
  drawFlag(c, terrain, camX, camY, W2, START_X, "#39c96b", "START");
  drawFlag(c, terrain, camX, camY, W2, START_X + mapLen, null, "FINISH");
  const stepU = 5000;
  const first = Math.floor((camX - 100) / stepU) * stepU;
  for (let wx = Math.max(stepU, first); wx < camX + W2 + stepU; wx += stepU) {
    const sx = wx - camX;
    if (sx < -60 || sx > W2 + 60) continue;
    const gy = terrain.heightAt(wx) - camY;
    c.fillStyle = "#333"; c.fillRect(sx - 2, gy - 34, 4, 34);
    c.fillStyle = "#f3f3f3"; c.fillRect(sx - 20, gy - 46, 40, 15);
    c.fillStyle = "#222"; setFont(c, "bold 10px sans-serif"); c.textAlign = "center";
    c.fillText((wx * UNIT_TO_M / 1000).toFixed(1) + "km", sx, gy - 35);
  }
}
function drawWheel(c, x, y, r, rot, rim) {
  c.fillStyle = "#14141c";
  c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
  c.strokeStyle = "#2c2c38"; c.lineWidth = Math.max(1, r * 0.16);
  for (let i = 0; i < 6; i++) {
    const a = rot + i * TAU / 6;
    c.beginPath();
    c.moveTo(x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8);
    c.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    c.stroke();
  }
  c.fillStyle = rim || "#8a8a96";
  c.beginPath(); c.arc(x, y, r * 0.55, 0, TAU); c.fill();
  c.strokeStyle = shade(rim || "#8a8a96", 0.6); c.lineWidth = Math.max(1, r * 0.08);
  c.beginPath(); c.arc(x, y, r * 0.55, 0, TAU); c.stroke();
  c.strokeStyle = "#d8d8e2"; c.lineWidth = Math.max(1, r * 0.12);
  for (let i = 0; i < 4; i++) {
    const a = rot + i * Math.PI / 2;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * r * 0.48, y + Math.sin(a) * r * 0.48); c.stroke();
  }
  c.fillStyle = "#e8e8f0";
  c.beginPath(); c.arc(x, y, r * 0.14, 0, TAU); c.fill();
}
function drawFlame(c, def, strength) {
  const fl = (14 + Math.sin(performance.now() * 0.03) * 5) * (strength || 1);
  const x = -def.w / 2 - 2;
  c.fillStyle = def.flame[0];
  c.beginPath(); c.moveTo(x, -5); c.lineTo(x, 5); c.lineTo(x - fl, 0); c.closePath(); c.fill();
  c.fillStyle = def.flame[1];
  c.beginPath(); c.moveTo(x, -2.5); c.lineTo(x, 2.5); c.lineTo(x - fl * 0.55, 0); c.closePath(); c.fill();
}
function drawBody(c, def, wa) {
  const w = def.w, h = def.h, col = def.color;
  const wf = def.wf || 8, wr = def.wr || 8, rim = def.rim;
  const glass = "#cfe8fa", glassDark = "#9cc4e0";
  switch (def.body) {
    case "compact":
      c.fillStyle = col; roundRect(c, -w / 2, -h / 2, w, h, 8); c.fill();
      c.fillStyle = shade(col, 0.8); c.fillRect(-w / 2 + 2, h * 0.18, w - 4, 3);
      c.fillStyle = glass;
      c.beginPath(); c.moveTo(-w * 0.14, -h / 2); c.lineTo(w * 0.2, -h / 2);
      c.lineTo(w * 0.1, -h * 0.05); c.lineTo(-w * 0.28, -h * 0.05); c.closePath(); c.fill();
      c.fillStyle = "#ffe9a0"; c.fillRect(w / 2 - 4, -h * 0.18, 4, 5);
      c.fillStyle = "#e6533c"; c.fillRect(-w / 2, -h * 0.18, 3, 5);
      drawWheel(c, -w * 0.28, h * 0.42, wf, wa, rim);
      drawWheel(c, w * 0.3, h * 0.42, wf, wa, rim);
      break;
    case "sport":
      c.fillStyle = col;
      c.beginPath();
      c.moveTo(-w / 2, h * 0.1); c.lineTo(-w * 0.36, -h / 2); c.lineTo(w * 0.42, -h / 2);
      c.lineTo(w / 2, h * 0.1); c.lineTo(w * 0.2, h / 2 * 0.9); c.lineTo(-w * 0.3, h / 2 * 0.9);
      c.closePath(); c.fill();
      c.fillStyle = shade(col, 1.2);
      c.beginPath(); c.moveTo(w * 0.2, -h / 2); c.lineTo(w * 0.42, -h / 2); c.lineTo(w / 2, h * 0.1); c.lineTo(w * 0.24, h * 0.05); c.closePath(); c.fill();
      c.fillStyle = glassDark; c.fillRect(-w * 0.3, -h * 0.38, w * 0.5, h * 0.3);
      c.fillStyle = shade(col, 0.7); c.fillRect(-w * 0.58, -h * 0.4, w * 0.14, 4); c.fillRect(-w * 0.52, -h * 0.38, 3, h * 0.55);
      c.fillStyle = "#ffe9a0"; c.fillRect(w * 0.42, -h * 0.2, 5, 6);
      drawWheel(c, -w * 0.3, h * 0.4, wr, wa, rim);
      drawWheel(c, w * 0.32, h * 0.4, wf, wa, rim);
      break;
    case "muscle":
      c.fillStyle = col; roundRect(c, -w / 2, -h / 2, w, h, 6); c.fill();
      c.fillStyle = "#1a1e30"; c.fillRect(-w * 0.1, -h / 2 - 4, w * 0.26, 7);
      c.fillStyle = "#e8e8f0"; c.fillRect(-w / 2 + 3, -h * 0.08, w - 6, 3);
      c.fillStyle = glass;
      c.beginPath(); c.moveTo(-w * 0.12, -h / 2); c.lineTo(w * 0.22, -h / 2);
      c.lineTo(w * 0.12, -h * 0.05); c.lineTo(-w * 0.26, -h * 0.05); c.closePath(); c.fill();
      c.fillStyle = "#e6533c"; c.fillRect(-w / 2, -h * 0.2, 4, 7);
      c.fillStyle = "#ffe9a0"; c.fillRect(w / 2 - 5, -h * 0.2, 5, 7);
      drawWheel(c, -w * 0.32, h * 0.44, wr, wa, rim);
      drawWheel(c, w * 0.34, h * 0.44, wf, wa, rim);
      break;
    case "suv":
      c.fillStyle = col; roundRect(c, -w / 2, -h / 2, w, h, 6); c.fill();
      c.fillStyle = shade(col, 0.75); c.fillRect(-w / 2, h * 0.32, w, h * 0.16);
      c.fillStyle = "#20242c"; c.fillRect(-w * 0.34, -h / 2 - 6, w * 0.7, 4);
      c.fillRect(-w * 0.3, -h / 2 - 6, 3, 8); c.fillRect(w * 0.3, -h / 2 - 6, 3, 8);
      c.fillStyle = glass;
      c.beginPath(); c.moveTo(-w * 0.16, -h / 2 + 2); c.lineTo(w * 0.24, -h / 2 + 2);
      c.lineTo(w * 0.18, -h * 0.12); c.lineTo(-w * 0.3, -h * 0.12); c.closePath(); c.fill();
      c.fillStyle = "#c9c9d4"; c.fillRect(w / 2 - 4, -h * 0.28, 5, h * 0.5);
      drawWheel(c, -w * 0.28, h * 0.42, wr, wa, rim);
      drawWheel(c, w * 0.3, h * 0.42, wr, wa, rim);
      break;
    case "pickup":
      c.fillStyle = col; roundRect(c, -w / 2, -h / 2, w * 0.55, h, 5); c.fill();
      c.fillStyle = "#8a5a24"; roundRect(c, -w * 0.02, -h * 0.1, w * 0.48, h * 0.55, 3); c.fill();
      c.strokeStyle = "#6a4418"; c.lineWidth = 2; c.strokeRect(-w * 0.02, -h * 0.1, w * 0.48, h * 0.55);
      c.fillStyle = glass;
      c.beginPath(); c.moveTo(-w * 0.42, -h / 2); c.lineTo(-w * 0.12, -h / 2);
      c.lineTo(-w * 0.16, -h * 0.05); c.lineTo(-w * 0.44, -h * 0.05); c.closePath(); c.fill();
      c.fillStyle = "#ffe9a0"; c.fillRect(w * 0.4, -h * 0.2, 4, 5);
      drawWheel(c, -w * 0.28, h * 0.44, wr, wa, rim);
      drawWheel(c, w * 0.3, h * 0.44, wf, wa, rim);
      break;
    case "truck":
      c.fillStyle = col; roundRect(c, -w * 0.18, -h / 2, w * 0.36, h, 4); c.fill();
      c.fillStyle = shade(col, 1.25); roundRect(c, -w * 0.18, -h * 0.45, w * 0.36, h * 0.5, 2); c.fill();
      c.fillStyle = "#7a7466"; roundRect(c, w * 0.02, -h / 2, w * 0.46, h * 0.8, 3); c.fill();
      c.strokeStyle = "#5a5448"; c.lineWidth = 1.5;
      for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo(w * 0.02 + i * w * 0.115, -h / 2); c.lineTo(w * 0.02 + i * w * 0.115, -h / 2 + h * 0.8); c.stroke(); }
      c.fillStyle = "#20242c"; c.fillRect(w * 0.06, -h * 0.42, w * 0.38, 4);
      c.fillStyle = glass; c.fillRect(-w * 0.14, -h * 0.4, w * 0.28, h * 0.24);
      c.fillStyle = "#ffe9a0"; c.fillRect(-w * 0.17, -h * 0.16, 4, 6);
      drawWheel(c, -w * 0.1, h * 0.46, wr, wa, rim);
      drawWheel(c, w * 0.14, h * 0.46, wr, wa, rim);
      drawWheel(c, w * 0.38, h * 0.46, wr, wa, rim);
      break;
    case "rally":
      c.fillStyle = col; roundRect(c, -w / 2, -h / 2, w, h * 0.9, 6); c.fill();
      c.fillStyle = "#e8e8f0"; c.fillRect(-w / 2 + 2, -h * 0.05, w - 4, 5);
      c.fillStyle = "#20242c"; c.fillRect(-w * 0.56, -h / 2 - 7, w * 0.16, 5); c.fillRect(-w * 0.52, -h / 2 - 4, 3, h * 0.6);
      c.fillStyle = glass;
      c.beginPath(); c.moveTo(-w * 0.12, -h * 0.45); c.lineTo(w * 0.2, -h * 0.45);
      c.lineTo(w * 0.14, -h * 0.05); c.lineTo(-w * 0.24, -h * 0.05); c.closePath(); c.fill();
      c.fillStyle = "#ffe9a0"; c.fillRect(w / 2 - 6, -h * 0.25, 5, 6); c.fillRect(w / 2 - 6, -h * 0.1, 5, 6);
      c.fillStyle = "#1a1a22"; c.fillRect(-w * 0.36, h * 0.55, 8, 6); c.fillRect(w * 0.26, h * 0.55, 8, 6);
      drawWheel(c, -w * 0.28, h * 0.42, wr, wa, rim);
      drawWheel(c, w * 0.32, h * 0.42, wf, wa, rim);
      break;
    case "bus":
      c.fillStyle = col; roundRect(c, -w / 2, -h / 2, w, h, 5); c.fill();
      c.fillStyle = shade(col, 0.8); c.fillRect(-w / 2, h * 0.05, w, h * 0.18);
      c.fillStyle = glass;
      for (const fx of [-w * 0.36, -w * 0.15, w * 0.06, w * 0.27]) c.fillRect(fx, -h / 2 + 5, w * 0.14, h * 0.34);
      c.fillStyle = "#20242c"; c.fillRect(-w * 0.44, -h / 2 + 2, w * 0.2, 7);
      c.fillStyle = "#ffe9a0"; setFont(c, "bold 6px sans-serif"); c.textAlign = "left";
      c.fillText("RUSH", -w * 0.42, -h / 2 + 8);
      c.fillStyle = "#e6533c"; c.fillRect(-w / 2, -h * 0.1, w, h * 0.08);
      drawWheel(c, -w * 0.28, h * 0.42, wr, wa, rim);
      drawWheel(c, w * 0.28, h * 0.42, wr, wa, rim);
      break;
    case "moto":
      drawWheel(c, -w * 0.34, h * 0.3, wr, wa, rim);
      drawWheel(c, w * 0.34, h * 0.3, wf, wa, rim);
      c.strokeStyle = col; c.lineWidth = 4; c.lineCap = "round";
      c.beginPath(); c.moveTo(-w * 0.34, h * 0.3); c.lineTo(-w * 0.05, -h * 0.1); c.lineTo(w * 0.34, h * 0.3); c.stroke();
      c.beginPath(); c.moveTo(-w * 0.05, -h * 0.1); c.lineTo(w * 0.16, h * 0.22); c.stroke();
      c.fillStyle = shade(col, 1.15); roundRect(c, -w * 0.14, -h * 0.32, w * 0.34, h * 0.28, 4); c.fill();
      c.fillStyle = "#1a1a22"; c.fillRect(-w * 0.3, -h * 0.3, w * 0.2, h * 0.12);
      c.strokeStyle = "#8a8a96"; c.lineWidth = 2;
      c.beginPath(); c.moveTo(-w * 0.1, h * 0.05); c.lineTo(-w * 0.4, h * 0.12); c.stroke();
      c.fillStyle = col;
      c.beginPath(); c.arc(w * 0.02, -h * 0.48, 5, 0, TAU); c.fill();
      c.fillRect(-w * 0.1, -h * 0.4, w * 0.26, h * 0.28);
      c.fillStyle = "#1a1a22"; c.beginPath(); c.arc(w * 0.06, -h * 0.5, 3, 0, TAU); c.fill();
      break;
    case "legend":
      drawWheel(c, -w * 0.36, h * 0.3, wr, wa, rim);
      drawWheel(c, w * 0.36, h * 0.3, wf, wa, rim);
      c.strokeStyle = "#f3d34a"; c.lineWidth = 5; c.lineCap = "round";
      c.beginPath(); c.moveTo(-w * 0.36, h * 0.3); c.lineTo(-w * 0.06, -h * 0.15); c.lineTo(w * 0.36, h * 0.3); c.stroke();
      c.strokeStyle = "#fff2c0"; c.lineWidth = 2;
      c.beginPath(); c.moveTo(-w * 0.3, h * 0.25); c.lineTo(-w * 0.05, -h * 0.1); c.stroke();
      c.fillStyle = "#f3d34a";
      c.beginPath(); c.moveTo(-w * 0.02, -h * 0.5); c.lineTo(w * 0.26, -h * 0.3);
      c.lineTo(w * 0.2, -h * 0.02); c.lineTo(-w * 0.16, -h * 0.18); c.closePath(); c.fill();
      c.fillStyle = "#1a1e30"; c.fillRect(w * 0.12, -h * 0.42, w * 0.15, h * 0.15);
      c.strokeStyle = "#e8b820"; c.lineWidth = 2;
      c.beginPath(); c.moveTo(-w * 0.05, h * 0.1); c.lineTo(-w * 0.42, h * 0.16); c.stroke();
      c.beginPath(); c.moveTo(-w * 0.05, h * 0.02); c.lineTo(-w * 0.42, h * 0.06); c.stroke();
      c.fillStyle = "#e8b820"; c.beginPath(); c.arc(w * 0.0, -h * 0.55, 4.5, 0, TAU); c.fill();
      c.fillStyle = "#f3d34a"; c.fillRect(-w * 0.12, -h * 0.5, w * 0.22, h * 0.22);
      break;
  }
}
function drawVehicle(c, p, camX, camY, alpha) {
  const def = VEHICLES[p.vehicleName] || VEHICLES.sedan;
  const cx = p.x - camX, cy = p.y - camY;
  c.save();
  if (alpha) c.globalAlpha = alpha;
  c.translate(cx, cy);
  const bob = (p.onGround && !p.isRemote)
    ? Math.sin(p.distance * 0.05) * def.suspension * 1.6 * clamp(Math.abs(p.vx) / 200, 0, 1)
    : 0;
  const sq = clamp(p.squash || 0, 0, 1);
  c.translate(0, -bob + sq * def.h * 0.12);
  c.rotate(p.angle * Math.PI / 180);
  c.scale(1 + sq * 0.12, 1 - sq * 0.2);
  drawBody(c, def, p.wheelAngle);
  if (p.nitroTimer > 0 || p.nitro === true) drawFlame(c, def, 1);
  c.restore();
  if (p.isRemote || p.isBot) {
    c.globalAlpha = 1;
    c.fillStyle = "#fff"; setFont(c, "11px sans-serif"); c.textAlign = "center";
    c.fillText(p.name, cx, cy - def.h / 2 - 12);
  }
}
function playerBySid(sid) {
  if (Game.net && Game.net.mySid === sid) return Game.local;
  return Game.ghosts.get(sid) || null;
}
function drawEmoteBubbles(c, camX, camY) {
  setFont(c, "16px sans-serif"); c.textAlign = "center";
  for (const b of Game.bubbles) {
    const pl = playerBySid(b.sid);
    if (!pl) continue;
    const def = VEHICLES[pl.vehicleName] || VEHICLES.sedan;
    const cx = pl.x - camX, cy = pl.y - camY - def.h / 2 - 28;
    c.fillStyle = "#000d";
    roundRect(c, cx - 14, cy - 14, 28, 26, 8); c.fill();
    c.strokeStyle = "#ffffff44"; c.lineWidth = 1; c.stroke();
    c.fillStyle = "#fff";
    c.fillText(b.text, cx, cy + 4);
  }
}
function drawPickup(c, pk, camX, camY, terrain, W2) {
  if (pk.taken) return;
  const x = pk.x - camX;
  if (x < -30 || x > W2 + 30) return;
  const t = performance.now();
  const yOff = Math.sin(t * 0.004 + pk.bob) * 5;
  const cy = terrain.heightAt(pk.x) - 28 + yOff - camY;
  if (pk.kind === "fuel") {
    c.fillStyle = "#f0a028"; roundRect(c, x - 8, cy - 10, 16, 20, 3); c.fill();
    c.fillStyle = "#c87c14"; c.fillRect(x - 4, cy - 13, 8, 4);
    c.fillStyle = "#fff"; setFont(c, "bold 10px sans-serif"); c.textAlign = "center";
    c.fillText("F", x, cy + 3);
  } else if (pk.kind === "nitro") {
    c.save(); c.translate(x, cy); c.rotate(Math.PI / 4 + Math.sin(t * 0.002 + pk.bob) * 0.2);
    c.fillStyle = "#3cc8ff"; c.fillRect(-8, -8, 16, 16);
    c.strokeStyle = "#fff"; c.lineWidth = 2; c.strokeRect(-4, -4, 8, 8);
    c.restore();
  } else {
    c.fillStyle = "#ffd73c"; c.beginPath(); c.arc(x, cy, 9, 0, TAU); c.fill();
    c.strokeStyle = "#b8860b"; c.lineWidth = 2; c.beginPath(); c.arc(x, cy, 5.5, 0, TAU); c.stroke();
  }
}
function drawObstacle(c, o, camX, camY, terrain, W2) {
  const x = o.x - camX;
  if (x < -80 || x > W2 + 80) return;
  const gy = terrain.heightAt(o.x) - camY;
  if (o.kind === "traffic") {
    c.fillStyle = "#b04848"; roundRect(c, x - 24, gy - 26, 48, 18, 4); c.fill();
    c.fillStyle = "#2a2e38"; roundRect(c, x + 2, gy - 23, 16, 10, 2); c.fill();
    c.fillStyle = "#ffd97a"; c.fillRect(x - 24, gy - 20, 4, 5);
    c.fillStyle = "#1a1a20";
    c.beginPath(); c.arc(x - 14, gy - 5, 6, 0, TAU); c.fill();
    c.beginPath(); c.arc(x + 14, gy - 5, 6, 0, TAU); c.fill();
  } else if (o.kind === "log") {
    c.fillStyle = "#6e4b28"; roundRect(c, x - 16, gy - 14, 32, 13, 6); c.fill();
    c.fillStyle = "#8a6038"; c.beginPath(); c.arc(x + 16, gy - 7.5, 6.5, 0, TAU); c.fill();
  } else if (o.kind === "cactus") {
    c.fillStyle = "#3c825a";
    c.fillRect(x - 5, gy - 30, 10, 30);
    c.fillRect(x - 14, gy - 22, 9, 6); c.fillRect(x - 14, gy - 22, 5, 10);
    c.fillRect(x + 5, gy - 26, 9, 6); c.fillRect(x + 9, gy - 26, 5, 12);
  } else if (o.kind === "ice") {
    c.fillStyle = "rgba(150,200,230,0.85)"; roundRect(c, x - 14, gy - 24, 28, 24, 3); c.fill();
    c.strokeStyle = "#e8f4ff"; c.lineWidth = 1.5; c.stroke();
  } else if (o.kind === "barrier") {
    c.fillStyle = "#e6772c"; c.fillRect(x - 20, gy - 24, 40, 8);
    c.fillStyle = "#f3f3f3"; c.fillRect(x - 20, gy - 16, 40, 8);
    c.fillStyle = "#20242c"; c.fillRect(x - 16, gy - 8, 4, 8); c.fillRect(x + 12, gy - 8, 4, 8);
  } else if (o.kind === "crate") {
    c.fillStyle = "#8a6038"; c.fillRect(x - 14, gy - 24, 28, 24);
    c.strokeStyle = "#5a4028"; c.lineWidth = 2; c.strokeRect(x - 14, gy - 24, 28, 24);
    c.beginPath(); c.moveTo(x - 14, gy - 24); c.lineTo(x + 14, gy); c.stroke();
  } else {
    c.fillStyle = o.kind === "crater" ? "#74747c" : "#6e6e73";
    c.beginPath();
    c.moveTo(x - 15, gy); c.lineTo(x - 10, gy - 16); c.lineTo(x + 2, gy - 22);
    c.lineTo(x + 13, gy - 12); c.lineTo(x + 15, gy);
    c.closePath(); c.fill();
    if (o.kind === "crater") { c.fillStyle = "#3c3c44"; c.beginPath(); c.ellipse(x, gy + 2, 14, 4, 0, 0, TAU); c.fill(); }
  }
}
function drawBoostPads(c, terrain, camX, camY, W2) {
  for (const bp of Game.boosts) {
    const sx = bp.x - camX;
    if (sx < -80 || sx > W2 + 80) continue;
    const gy = terrain.heightAt(bp.x) - camY;
    c.save();
    c.translate(sx, gy - 4);
    c.rotate(Math.atan(terrain.slopeAt(bp.x)));
    const pulse = 0.75 + 0.25 * Math.sin(performance.now() * 0.006);
    c.globalAlpha = pulse;
    c.fillStyle = "#2cc46e";
    roundRect(c, -bp.w / 2, -5, bp.w, 10, 3); c.fill();
    c.fillStyle = "#a8f0c8";
    for (let i = 0; i < 3; i++) {
      c.beginPath();
      c.moveTo(-bp.w / 2 + 14 + i * 22, -3); c.lineTo(-bp.w / 2 + 24 + i * 22, 0); c.lineTo(-bp.w / 2 + 14 + i * 22, 3);
      c.closePath(); c.fill();
    }
    c.restore();
    c.globalAlpha = 1;
  }
}
function drawHazards(c, terrain, camX, camY, W2) {
  const t = performance.now();
  for (const hz of Game.hazards) {
    const sx = hz.x - camX;
    if (sx < -140 || sx > W2 + 140) continue;
    const gy = terrain.heightAt(hz.x) - camY;
    const glow = 0.6 + 0.3 * Math.sin(t * 0.004 + hz.x);
    c.globalAlpha = glow;
    c.fillStyle = "#e6531c";
    c.beginPath(); c.ellipse(sx, gy + 2, hz.w / 2, 10, 0, 0, TAU); c.fill();
    c.fillStyle = "#ffc23c";
    c.beginPath(); c.ellipse(sx, gy + 1, hz.w / 2.6, 5, 0, 0, TAU); c.fill();
    if (qBool(true, false)) {
      c.fillStyle = "#ffe0a0";
      for (let i = 0; i < 3; i++) {
        const bx = sx + Math.sin(t * 0.003 + i * 2.1) * hz.w * 0.3;
        const by = gy - 4 - ((t * 0.02 + i * 20) % 14);
        c.beginPath(); c.arc(bx, by, 2, 0, TAU); c.fill();
      }
    }
    c.globalAlpha = 1;
  }
}
function drawWeather(c, W2, H2) {
  const w = Game.mapName && MAPS[Game.mapName] ? MAPS[Game.mapName].weather : "clear";
  if (w === "clear") return;
  const q = qLevel();
  const n = q === "low" ? 0 : (q === "medium" ? 30 : 70);
  const t = performance.now() * 0.001;
  if (w === "rain") {
    c.strokeStyle = "rgba(160,190,230,0.35)"; c.lineWidth = 1;
    c.beginPath();
    for (let i = 0; i < n; i++) {
      const sx = ((i * 131 + t * 900) % (W2 + 60)) - 30;
      const sy = (i * 197 + t * 1300) % H2;
      c.moveTo(sx, sy); c.lineTo(sx - 5, sy + 14);
    }
    c.stroke();
  } else if (w === "snowfall") {
    c.fillStyle = "rgba(255,255,255,0.85)";
    for (let i = 0; i < n; i++) {
      const sx = ((i * 173 + t * 60 * (0.4 + (i % 3) * 0.3)) % (W2 + 40)) - 20;
      const sy = (i * 97 + t * 90) % H2;
      c.beginPath(); c.arc(sx, sy, 1.8, 0, TAU); c.fill();
    }
  } else if (w === "dust" || w === "ashfall") {
    c.fillStyle = w === "dust" ? "rgba(220,190,140,0.25)" : "rgba(160,150,150,0.35)";
    for (let i = 0; i < n; i++) {
      const sx = ((i * 149 + t * 320) % (W2 + 60)) - 30;
      const sy = (i * 83 + (w === "ashfall" ? t * 60 : Math.sin(t + i) * 20)) % H2;
      c.fillRect(sx, sy, 2.2, 2.2);
    }
    if (w === "ashfall" && q !== "low") {
      c.fillStyle = "rgba(255,130,50,0.7)";
      const en = q === "medium" ? 10 : 22;
      for (let i = 0; i < en; i++) {
        const sy = H2 + 20 - ((t * 45 + i * 137) % (H2 + 60));
        const sx = (i * 211 + Math.sin(t * 0.8 + i) * 26) % W2;
        c.globalAlpha = clamp(sy / H2, 0.1, 0.8);
        c.fillRect(sx, sy, 2.5, 2.5);
      }
      c.globalAlpha = 1;
    }
  } else if (w === "night") {
    c.fillStyle = "rgba(8,10,30,0.22)"; c.fillRect(0, 0, W2, H2);
    const vg = cachedGrad("night:" + W2 + "x" + H2, W2, H2, () => {
      const g = c.createRadialGradient(W2 / 2, H2 / 2, H2 * 0.3, W2 / 2, H2 / 2, H2);
      g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,10,0.5)"); return g;
    });
    c.fillStyle = vg; c.fillRect(0, 0, W2, H2);
  } else if (w === "fog") {
    const fg = cachedGrad("fog:" + W2 + "x" + H2, W2, H2, () => {
      const g = c.createLinearGradient(0, H2 * 0.3, 0, H2);
      g.addColorStop(0, "rgba(190,205,190,0)"); g.addColorStop(0.6, "rgba(190,205,190,0.3)");
      g.addColorStop(1, "rgba(190,205,190,0.05)"); return g;
    });
    c.fillStyle = fg; c.fillRect(0, 0, W2, H2);
    if (q !== "low") {
      c.fillStyle = "rgba(120,170,90,0.6)";
      for (let i = 0; i < 12; i++) {
        const sy = (i * 89 + t * 70) % H2;
        const sx = (i * 173 + Math.sin(t + i * 2) * 50) % W2;
        c.save(); c.translate(sx, sy); c.rotate(t * 2 + i);
        c.fillRect(-3, -1.5, 6, 3); c.restore();
      }
    }
  }
}
function render() {
  if (!ctx || !Game.terrain) return;
  drawTerrain(ctx, Game.terrain, Game.cam.x, Game.cam.y, W, H);
  const sx = Game.cam.shake > 0 ? (Math.random() - 0.5) * Game.cam.shake * 14 : 0;
  const sy = Game.cam.shake > 0 ? (Math.random() - 0.5) * Game.cam.shake * 10 : 0;
  ctx.save();
  if (Game.cam.zoom !== 1) {
    ctx.translate(W * 0.5, H * 0.5);
    ctx.scale(Game.cam.zoom, Game.cam.zoom);
    ctx.translate(-W * 0.5, -H * 0.5);
  }
  ctx.translate(sx, sy);
  if (qSettings().scenery) drawScenery(ctx, Game.terrain, Game.cam.x, Game.cam.y, W, H);
  drawRaceMarkers(ctx, Game.terrain, Game.cam.x, Game.cam.y, W, Game.mapLen);
  drawHazards(ctx, Game.terrain, Game.cam.x, Game.cam.y, W);
  drawBoostPads(ctx, Game.terrain, Game.cam.x, Game.cam.y, W);
  for (const o of Game.world.obstacles) drawObstacle(ctx, o, Game.cam.x, Game.cam.y, Game.terrain, W);
  for (const pk of Game.world.pickups) drawPickup(ctx, pk, Game.cam.x, Game.cam.y, Game.terrain, W);
  for (const g of Game.ghosts.values()) drawVehicle(ctx, g, Game.cam.x, Game.cam.y, 0.5);
  for (const b of Game.bots) drawVehicle(ctx, b, Game.cam.x, Game.cam.y, 1);
  if (Game.local) drawVehicle(ctx, Game.local, Game.cam.x, Game.cam.y, 1);
  drawEmoteBubbles(ctx, Game.cam.x, Game.cam.y);
  Game.particles.draw(ctx, Game.cam.x, Game.cam.y);
  ctx.restore();
  drawWeather(ctx, W, H);
}
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.033, (t - Game.lastT) / 1000 || 0.016);
  Game.lastT = t;
  const scr = currentScreen();
  if (scr === "screen-vehicle") { renderGarageFrame(t); return; }
  if (scr === "screen-map") { renderMapFrame(t); return; }
  if (Game.state === "menu" || !Game.terrain) return;
  if (!Game.paused) update(dt);
  render();
}

/* ---------- pause / nav ---------- */
function buildPauseControls() {
  const el = $("pauseControls");
  if (isTouch) el.innerHTML = `<div class="pc-note">Left: <b>GAS + BRAKE</b> · Right: <b>NOS + JUMP</b> · Center: tilt</div>`;
  else {
    const rows = [
      ["W · ↑ · Num 8", "Gas"], ["S · ↓ · Num 2", "Brake / reverse"],
      ["A / D · Num 4 / 6", "Tilt mid-air"], ["Space", "Nitro boost"],
      ["J", "Jump"], ["E", "Emojis (1 per 10 s)"], ["Tab", "Switch spectated player"], ["Esc", "Pause"], ["R", "Restart"],
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
  $("pauseSub").textContent = (MAPS[Game.mapName] ? MAPS[Game.mapName].label : Game.mapName) + " • " + (VEHICLES[save.vehicle] ? VEHICLES[save.vehicle].name : "");
  if (Game.paused) buildPauseControls();
  $("overlay-pause").classList.toggle("hidden", !Game.paused);
  if (Game.paused) { Game.sfx.engineStop(); Game.music.stop(); }
  else { Game.sfx.engineStart(); Game.music.start(); }
};
Game.handleRestartKey = function () {
  if (Game.state === "menu") return;
  if (Game.mode === "single") { hideOverlays(); Game.paused = false; startRace(Math.floor(Math.random() * 999999) + 1); }
  else hudToast("Only the host can start a new race (from the leaderboard)");
};
function goHome() {
  hideOverlays(); exitSpectate();
  $("touchControls").classList.add("hidden");
  $("raceList").classList.add("hidden");
  Game.sfx.engineStop(); Game.music.stop(); releaseWakeLock();
  Game.state = "menu"; Game.paused = false;
  if (Game.voice) { Game.voice.disable(); Game.voice = null; }
  if (Game.net) { Game.net.destroy(); Game.net = null; }
  Game.mode = null;
  updateHomeStats();
  showScreen("screen-home");
}

/* ---------- lazy loaders ---------- */
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

/* ---------- QR / invite ---------- */
function buildInviteUrl() {
  let base = location.href.split("?")[0].split("#")[0];
  return base + (base.includes("?") ? "&" : "?") + "room=" + Game.net.roomCode;
}
async function showQrOverlay() {
  if (!Game.net || !Game.net.roomCode) return;
  Game.sfx.play("click");
  $("qrBox").innerHTML = "";
  $("qrCodeText").textContent = Game.net.roomCode;
  $("qrUrl").textContent = buildInviteUrl();
  $("overlay-qr").classList.remove("hidden");
  await ensureQrLib();
  if (window.QRCode) {
    try {
      new QRCode($("qrBox"), { text: buildInviteUrl(), width: 190, height: 190,
        correctLevel: window.QRCode.CorrectLevel ? window.QRCode.CorrectLevel.M : undefined });
    } catch (e) { $("qrBox").innerHTML = '<div class="status-text" style="color:#333">QR unavailable — use the link below.</div>'; }
  } else $("qrBox").innerHTML = '<div class="status-text" style="color:#333">QR unavailable — use the link below.</div>';
}
async function copyInviteLink() {
  Game.sfx.play("click");
  const url = buildInviteUrl();
  try {
    await navigator.clipboard.writeText(url);
    setStatus("lobbyStatus", "Invite link copied — send it to a friend!", "ok");
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = url; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta);
      setStatus("lobbyStatus", "Invite link copied — send it to a friend!", "ok");
    } catch (e2) { setStatus("lobbyStatus", "Copy failed — use the QR popup link.", "err"); }
  }
}

/* ---------- chat & EMOJI system ---------- */
function appendChat(msg) {
  const log = $("chatLog");
  if (!log) return;
  const div = document.createElement("div");
  const time = new Date(msg.ts || Date.now());
  const hh = String(time.getHours()).padStart(2, "0"), mm = String(time.getMinutes()).padStart(2, "0");
  if (msg.sys) {
    div.className = "c-line c-sys";
    div.textContent = hh + ":" + mm + " " + msg.text;
  } else {
    div.className = "c-line";
    const b = document.createElement("b");
    b.textContent = msg.name;
    const pre = document.createElement("span");
    pre.className = "c-time"; pre.textContent = hh + ":" + mm + " ";
    div.appendChild(pre); div.appendChild(b);
    div.appendChild(document.createTextNode(": " + String(msg.text).slice(0, CONFIG.CHAT_MAX_LEN)));
  }
  log.appendChild(div);
  while (log.children.length > 60) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}
function showEmoteBubble(sid, name, code) {
  Game.bubbles.push({ sid, text: code, t: 2.5 });
  if (currentScreen() === "screen-lobby") appendChat({ name, text: code, ts: Date.now() });
}
function buildEmojiPanel() {
  const grid = $("emojiGrid");
  grid.innerHTML = "";
  EMOJI_RACE.forEach((e, i) => {
    const b = document.createElement("button");
    b.className = "emoji-btn" + (i < 5 ? " rec" : "");
    b.textContent = e;
    b.title = i < 5 ? "Recommended" : "";
    b.onclick = () => sendEmoji(e);
    grid.appendChild(b);
  });
}
function buildLobbyEmojiRow() {
  const row = $("emoteRow");
  row.innerHTML = "";
  EMOJI_RACE.forEach((e, i) => {
    const b = document.createElement("button");
    b.className = "emote-btn-s";
    b.textContent = e;
    b.title = i < 5 ? "Recommended" : "";
    b.onclick = () => sendEmoji(e);
    row.appendChild(b);
  });
}
function sendEmoji(e) {
  if (!EMOJI_RACE.includes(e)) return;
  const now = nowMs();
  const rem = CONFIG.EMOTE_COOLDOWN_MS - (now - Game._lastEmoji);
  if (rem > 0) { hudToast("Emoji ready in " + Math.ceil(rem / 1000) + "s"); return; }
  Game._lastEmoji = now;
  if (Game.net) Game.net.sendEmote(e);
  else showEmoteBubble("local", save.name, e);
  $("emojiPanel").classList.add("hidden");
}
function sendChatFromInput() {
  if (!Game.net) return;
  const el = $("chatInput");
  const text = el.value.trim();
  if (!text) return;
  Game.net.sendChat(text);
  el.value = "";
}

/* ---------- multiplayer UI wiring ---------- */
function setupNetCallbacks(net) {
  net.onPlayersChanged = (list) => { if (currentScreen() === "screen-lobby") renderLobbyPlayers(list); };
  net.onMapChanged = () => { if (currentScreen() === "screen-lobby") renderLobbyMap(); };
  net.onRoomCfg = (locked, hasPass) => { if (currentScreen() === "screen-lobby") renderLobbyBadges(locked, hasPass); };
  net.onRaceStart = (seed, mapName) => {
    Game.mode = net.isHost ? "host" : "guest";
    Game.mapName = MAPS[mapName] ? mapName : "highway";
    Game.net = net;
    startRace(seed);
  };
  net.onGo = () => beginGo();
  net.onWorldUpdate = (sid, s) => {
    const g = Game.ghosts.get(sid);
    if (g && s) { g.tx = s.x; g.ty = s.y; g.ta = s.a; g.nitro = !!s.n; g.finished = !!s.f; g.distance = s.d || 0; }
  };
  net.onPositions = (list) => { Game.posList = list; };
  net.onPickup = (id, by) => onAuthoritativePickup(id, by);
  net.onChat = (msg) => appendChat(msg);
  net.onEmote = (e) => showEmoteBubble(e.sid, e.name, e.code);
  net.onLeaderboard = (list) => {
    for (const e of list) e.me = (e.id === net.mySid);
    const mine = list.find(e => e.me);
    let medal = null;
    if (mine) {
      if (mine.score > save.best) save.best = mine.score;
      medal = recordMapResult(Game.mapName, mine.time, mine.score, save.vehicle);
      save.coins += (MEDAL_COINS[medal] || (mine.time != null ? 30 : 0));
      persist();
    }
    presentLeaderboard("RACE COMPLETE",
      mine ? `You finished ${fmtPlace(mine.place)} — ${mine.time != null ? fmtTime(mine.time) : ""}` + (medal ? ` • ${medal} MEDAL!` : "") : "",
      list, net.isHost ? "host" : "guest");
  };
  net.onError = (msg) => {
    if (Game.state === "racing" || Game.state === "countdown") hudToast(String(msg).slice(0, 60));
    else if (currentScreen() === "screen-lobby") setStatus("lobbyStatus", msg, "err");
  };
  net.onConnState = () => { if (Game.state === "racing" || Game.state === "countdown") updateConnHud(); };
  net.onHostLeft = () => {
    Game.sfx.engineStop(); Game.music.stop();
    Game.state = "menu"; Game.paused = false;
    hideOverlays(); exitSpectate();
    $("touchControls").classList.add("hidden");
    net.destroy();
    Game.net = null; Game.mode = null;
    updateHomeStats();
    showScreen("screen-play");
    setStatus("playStatus", "Connection lost — the host is no longer reachable.", "err");
  };
  net.onKicked = (reason) => {
    Game.sfx.engineStop(); Game.music.stop();
    Game.state = "menu"; Game.paused = false;
    hideOverlays(); exitSpectate();
    $("touchControls").classList.add("hidden");
    net.destroy(); Game.net = null; Game.mode = null;
    updateHomeStats();
    showScreen("screen-home");
    rrModal({ title: "REMOVED FROM ROOM", body: "Reason: " + (reason || "removed by host"), confirm: "OK" });
  };
  net.onReturnToLobby = () => {
    hideOverlays(); exitSpectate();
    $("touchControls").classList.add("hidden");
    Game.state = "menu";
    Game.sfx.engineStop(); Game.music.stop();
    Game.net.setReady(false);
    updateReadyButton();
    enterLobby();
  };
  net.onMuted = (sid) => {
    const p = Game.net.players.get(sid);
    if (Game.voice) Game.voice.mutePlayer(sid);
    setStatus("lobbyStatus", (p ? p.name : "A player") + " was muted for 30 minutes.", "ok");
  };
  net._onGuestFinish = (sid, data) => hostHandleFinish(sid, data);
}
function enterLobby() {
  showScreen("screen-lobby");
  const net = Game.net;
  const isHost = net.isHost;
  $("roomCodeBox").style.display = isHost ? "" : "none";
  $("inviteRow").style.display = isHost ? "" : "none";
  $("roomTools").classList.toggle("hidden", !isHost);
  if (isHost) $("roomCode").textContent = net.roomCode || "-----";
  $("lobbyStatus").textContent = isHost
    ? "Share the QR / link / code. Start when everyone is in."
    : "Connected! Waiting for the host to start the race.";
  $("btnStartRace").classList.toggle("hidden", !isHost);
  $("btnReady").classList.toggle("hidden", isHost);
  renderLobbyPlayers(net._playerListArr());
  renderLobbyMap();
  renderLobbyVehicle();
  renderLobbyBadges(net.locked, !!net.password);
  updateReadyButton();
  $("chatLog").innerHTML = "";
  requestWakeLock();
}
function updateReadyButton() {
  const me = Game.net && Game.net.players.get(Game.net.mySid);
  const ready = me && me.ready;
  $("btnReady").textContent = ready ? "READY ✓ (tap to un-ready)" : "READY";
  $("btnReady").className = "btn " + (ready ? "btn-primary" : "");
}
function renderLobbyBadges(locked, hasPass) {
  const el = $("lobbyBadges");
  if (!el) return;
  const md = MAPS[Game.net.selectedMap] || MAPS.highway;
  const size = Game.net.maxPlayers();
  const dur = Game.net.roomCfg ? DURATION_PRESETS[Game.net.roomCfg.duration].label : "";
  el.innerHTML =
    (hasPass ? '<span class="badge">PASSWORD</span>' : '<span class="badge">PUBLIC</span>') +
    (locked ? '<span class="badge locked">LOCKED</span>' : '<span class="badge">OPEN</span>') +
    `<span class="badge">${escapeHtml(md.label)} · ${md.difficulty}</span>` +
    `<span class="badge">${size} players · ${escapeHtml(dur)}</span>`;
}
function renderLobbyPlayers(list) {
  const ul = $("lobbyPlayers");
  $("playerCount").textContent = `(${list.filter(p => p.disconnectedAt == null).length}/${Game.net.maxPlayers()})`;
  ul.innerHTML = "";
  const iAmHost = Game.net.isHost;
  let readyCount = 0;
  for (const p of list) {
    if (p.ready && p.disconnectedAt == null && !p.isBot) readyCount++;
    const li = document.createElement("li");
    const you = p.sid === Game.net.mySid ? ' <span class="you-tag">you</span>' : "";
    const left = document.createElement("span");
    const vname = VEHICLES[p.vehicle] ? VEHICLES[p.vehicle].name : "";
    left.innerHTML = escapeHtml(p.name) + you +
      (p.isHost ? ' <span class="you-tag">host</span>' : "") +
      (p.ready ? ' <span class="rdy">✓</span>' : "") +
      (p.disconnectedAt != null ? ' <span class="recon">reconnecting…</span>' : "");
    li.appendChild(left);
    const right = document.createElement("span");
    right.className = "pl-right";
    let txt = vname;
    if (p.disconnectedAt == null && !p.isHost && typeof p.ping === "number") txt += ` <span class="ping">${p.ping}ms</span>`;
    right.innerHTML = txt;
    if (p.sid !== Game.net.mySid && p.disconnectedAt == null) {
      const acts = document.createElement("span");
      acts.className = "pl-act";
      const mb = document.createElement("button");
      mb.className = "mini-btn"; mb.title = "Mute voice locally"; mb.textContent = "🔇";
      mb.onclick = () => { if (Game.voice) Game.voice.mutePlayer(p.sid); };
      acts.appendChild(mb);
      const vb = document.createElement("button");
      vb.className = "mini-btn"; vb.title = "Vote to mute (voice abuse)"; vb.textContent = "🗳";
      vb.onclick = () => { Game.net.sendVoteMute(p.sid); setStatus("lobbyStatus", "Vote registered — majority of the room mutes them.", "ok"); };
      acts.appendChild(vb);
      const rb = document.createElement("button");
      rb.className = "mini-btn"; rb.title = "Report player"; rb.textContent = "⚑";
      rb.onclick = () => {
        fbKind = "player"; fbReportTarget = p.name;
        Game.sfx.play("click");
        showScreen("screen-feedback");
        $("fbTabs").querySelectorAll(".fb-tab").forEach(x => x.classList.toggle("on", x.dataset.tab === "player"));
        $("fbTargetLabel").style.display = ""; $("fbTarget").style.display = "";
        fbRefreshTargets();
        if (fbReportTarget) $("fbTarget").value = fbReportTarget;
        $("fbCategory").value = "CHEATING";
        fbRenderDiag();
        setStatus("fbStatus", "", null);
      };
      acts.appendChild(rb);
      if (iAmHost && !p.isHost) {
        const kb = document.createElement("button");
        kb.className = "mini-btn"; kb.title = "Kick"; kb.textContent = "✕";
        kb.onclick = async () => {
          const go = await rrModal({ title: "KICK PLAYER?", body: p.name + " will be removed from the room.", danger: true, confirm: "KICK" });
          if (go) Game.net.kick(p.sid);
        };
        acts.appendChild(kb);
        const tb = document.createElement("button");
        tb.className = "mini-btn"; tb.title = "Make host"; tb.textContent = "★";
        tb.onclick = async () => {
          const go = await rrModal({ title: "TRANSFER HOST?", body: p.name + " becomes the host and you leave the room.", danger: true, confirm: "TRANSFER" });
          if (go) Game.net.transferHost(p.sid);
        };
        acts.appendChild(tb);
      }
      li.appendChild(acts);
    }
    li.appendChild(right);
    ul.appendChild(li);
  }
  if (iAmHost) $("btnStartRace").textContent = "START RACE (" + readyCount + " ready)";
}
function renderLobbyMap() {
  const el = $("lobbyMap");
  el.innerHTML = "";
  if (Game.net.isHost) {
    for (const m of MAP_ORDER) {
      const unlocked = mapUnlocked(m);
      const d = document.createElement("div");
      d.className = "map-opt" + (Game.net.selectedMap === m ? " selected" : "") + (unlocked ? "" : " disabled");
      d.textContent = MAPS[m].label + " — " + MAPS[m].difficulty + (unlocked ? "" : " 🔒");
      d.onclick = () => {
        if (!unlocked) { Game.sfx.play("click"); return; }
        Game.net.setMap(m); renderLobbyMap(); renderLobbyBadges(Game.net.locked, !!Game.net.password); Game.sfx.play("click");
      };
      el.appendChild(d);
    }
  } else {
    const m = MAPS[Game.net.selectedMap] || MAPS.highway;
    el.innerHTML = `<div class="map-select-readonly">${m.label} — ${m.difficulty} (chosen by host)</div>`;
  }
}
function renderLobbyVehicle() {
  const el = $("lobbyVehicle");
  el.innerHTML = "";
  const lockedMode = Game.net.roomCfg && Game.net.roomCfg.vehicleMode === "locked";
  if (lockedMode) {
    const v = VEHICLES[Game.net.roomCfg.vehicle] || VEHICLES.sedan;
    el.innerHTML = `<div class="map-select-readonly">${escapeHtml(v.name)} — locked by host for everyone</div>`;
    return;
  }
  const me = Game.net.players.get(Game.net.mySid);
  const cur = (me && me.vehicle) || save.vehicle;
  for (const v of VEHICLE_ORDER) {
    const owned = vehicleOwned(v);
    const d = document.createElement("div");
    d.className = "map-opt" + (cur === v ? " selected" : "") + (owned ? "" : " disabled");
    d.textContent = VEHICLES[v].name + (owned ? "" : " 🔒 " + VEHICLES[v].unlock + " coins");
    d.onclick = () => {
      if (!owned) { Game.sfx.play("click"); return; }
      Game.net.setMyVehicle(v);
      save.vehicle = v; persist();
      renderLobbyVehicle();
      renderLobbyPlayers(Game.net._playerListArr());
      Game.sfx.play("click");
    };
    el.appendChild(d);
  }
}

/* ---------- garage (animated hero) ---------- */
function renderGarageFrame(now) {
  const id = VEHICLE_ORDER[garageIdx];
  const v = VEHICLES[id];
  if (!v) return;
  const c = $("gCanvas").getContext("2d");
  const cw = 320, ch = 190;
  const g = c.createLinearGradient(0, 0, 0, ch);
  g.addColorStop(0, "#10141f"); g.addColorStop(1, "#05070c");
  c.fillStyle = g; c.fillRect(0, 0, cw, ch);
  const tl = c.createRadialGradient(cw / 2, -20, 10, cw / 2, -20, 160);
  tl.addColorStop(0, "rgba(140,170,255,0.16)"); tl.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = tl; c.fillRect(0, 0, cw, ch);
  const rg = c.createRadialGradient(cw / 2, ch * 0.62, 8, cw / 2, ch * 0.62, 150);
  rg.addColorStop(0, rarityGlow(v.rarity)); rg.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = rg; c.fillRect(0, 0, cw, ch);
  const fy = ch * 0.8;
  c.fillStyle = "#0d1220"; c.fillRect(0, fy, cw, ch - fy);
  c.strokeStyle = "#243050"; c.lineWidth = 1;
  for (let i = 1; i <= 5; i++) {
    c.globalAlpha = 0.4 - i * 0.06;
    c.beginPath(); c.moveTo(0, fy + i * 4); c.lineTo(cw, fy + i * 4); c.stroke();
  }
  c.globalAlpha = 1;
  c.strokeStyle = "#3a4a78"; c.beginPath(); c.moveTo(0, fy); c.lineTo(cw, fy); c.stroke();
  gTrans = Math.min(1, (gTrans || 0) + 0.08);
  const e = 1 - Math.pow(1 - gTrans, 3);
  const bob = Math.sin(now * 0.001 * v.idleSpd) * v.idleAmp;
  const sc = 2.2 * (0.86 + 0.14 * e);
  c.globalAlpha = 0.25 + 0.75 * e;
  c.save();
  c.translate(cw / 2, fy - 4);
  c.scale(1, 0.3);
  c.fillStyle = "rgba(0,0,0,0.55)";
  c.beginPath(); c.arc(0, 4 - bob * 0.5, v.w * sc * 0.42, 0, TAU); c.fill();
  c.restore();
  c.save();
  c.translate(cw / 2, fy - v.h * sc * 0.55 - bob);
  c.scale(sc, sc);
  drawBody(c, v, now * 0.0006);
  if ((now * 0.001) % 1.6 < 0.35) drawFlame(c, v, 0.7);
  c.restore();
  c.save();
  c.globalAlpha = 0.10 * e;
  c.translate(cw / 2, fy + v.h * sc * 0.55 + bob * 0.5);
  c.scale(sc, -sc);
  drawBody(c, v, now * 0.0006);
  c.restore();
  c.globalAlpha = 1;
}
function renderGarageInfo() {
  const id = VEHICLE_ORDER[garageIdx];
  const v = VEHICLES[id];
  if (!v) return;
  const owned = vehicleOwned(id);
  const selected = save.vehicle === id;
  $("gInfo").innerHTML =
    `<div class="g-name">${escapeHtml(v.name)}${selected ? ' <span class="you-tag">✔ SELECTED</span>' : ""}</div>` +
    `<div class="g-sub"><span class="rar-${v.rarity}">${v.rarity}</span> · ${escapeHtml(v.type)} · ` +
    `${owned ? "OWNED" : v.unlock.toLocaleString() + " coins to unlock"}</div>` +
    `<div class="g-desc">${escapeHtml(v.desc)}</div>`;
  const bars = vehicleBars(v);
  const rows = [["SPEED", bars.speed], ["ACCEL", bars.accel], ["STABILITY", bars.stab],
    ["GRIP", bars.grip], ["FUEL EFF", bars.fuel], ["NITRO", bars.nitro]];
  $("gBars").innerHTML = rows.map(r =>
    `<div class="gbar${v.rarity === "LEGENDARY" ? " gold" : ""}"><span class="lbl">${r[0]}</span>` +
    `<span class="track"><span class="fill" style="width:${r[1] * 10}%"></span></span></div>`).join("");
  $("gDots").innerHTML = "";
  VEHICLE_ORDER.forEach((vid, i) => {
    const b = document.createElement("button");
    b.className = "g-dot" + (i === garageIdx ? " on" : "") + (vehicleOwned(vid) ? "" : " lock");
    b.title = VEHICLES[vid].name;
    b.onclick = () => { Game.sfx.play("click"); garageIdx = i; gTrans = 0; renderGarageInfo(); };
    $("gDots").appendChild(b);
  });
  const lock = $("gLock");
  if (!owned) {
    lock.classList.remove("hidden");
    lock.innerHTML = `<b>🔒 LOCKED</b><span>${v.name} — ${v.unlock.toLocaleString()} coins</span>` +
      `<span>You have ${save.coins.toLocaleString()} coins</span>`;
    $("gUnlock").classList.remove("hidden");
    $("gUnlock").disabled = save.coins < v.unlock;
    $("gUnlock").textContent = "UNLOCK · " + v.unlock.toLocaleString();
    $("gSelect").disabled = true;
  } else {
    lock.classList.add("hidden");
    $("gUnlock").classList.add("hidden");
    $("gSelect").disabled = false;
    $("gSelect").textContent = selected ? "SELECTED ✔" : "SELECT";
  }
}

/* ---------- map select (animated panning preview) ---------- */
function renderMapFrame(now) {
  const id = MAP_ORDER[mapIdx];
  const m = MAPS[id];
  if (!m) return;
  if (!mCache || mCache.id !== id) {
    const t = new Terrain(m, 12345);
    mCache = { id, terrain: t,
      world: generateWorldObjects(t, 12345, m.length, {}),
      boosts: generateBoosts(m, 12345, m.length),
      hazards: generateHazards(m, 12345, m.length) };
    mTrans = 0;
  }
  const t = mCache.terrain;
  const c = $("mCanvas").getContext("2d");
  const cw = 320, ch = 190;
  const g = c.createLinearGradient(0, 0, 0, ch);
  g.addColorStop(0, m.sky[0]); g.addColorStop(1, m.sky[1]);
  c.fillStyle = g; c.fillRect(0, 0, cw, ch);
  const tt = now * 0.001;
  if (m.biome === "MOON") {
    c.fillStyle = "#e8e8f2";
    for (let i = 0; i < 30; i++) c.fillRect((i * 61.7) % cw, (i * 43.3) % 60, 1.4, 1.4);
    c.fillStyle = "#3c6fd0"; c.beginPath(); c.arc(cw * 0.82, 26, 12, 0, TAU); c.fill();
    c.fillStyle = "#5a9c50"; c.beginPath(); c.arc(cw * 0.79, 24, 4, 0, TAU); c.fill();
  } else if (m.biome === "VOLCANO") {
    c.fillStyle = "#3c1a14";
    c.beginPath(); c.moveTo(cw * 0.6, 60); c.lineTo(cw * 0.68, 6); c.lineTo(cw * 0.76, 60); c.closePath(); c.fill();
    c.fillStyle = "#e6531c"; c.fillRect(cw * 0.67, 6, 4, 16);
    c.fillStyle = "rgba(255,110,40," + (0.2 + 0.15 * Math.sin(tt * 2)) + ")";
    c.beginPath(); c.arc(cw * 0.68, 8, 22, 0, TAU); c.fill();
  } else if (m.biome === "KINGDOM") {
    c.fillStyle = "#f0e8ff";
    for (let i = 0; i < 14; i++) c.fillRect((i * 71.3) % cw, (i * 37.1) % 50, 1.4, 1.4);
    c.fillStyle = "#f8f4e0"; c.beginPath(); c.arc(cw * 0.15, 24, 9, 0, TAU); c.fill();
  } else if (m.biome === "CITY") {
    c.fillStyle = "#e8e8f2";
    for (let i = 0; i < 20; i++) {
      c.globalAlpha = 0.4 + 0.5 * Math.sin(tt * (1 + (i % 4)) + i);
      c.fillRect((i * 83.7) % cw, (i * 29.3) % 50, 1.4, 1.4);
    }
    c.globalAlpha = 1;
  }
  const span = 4200;
  const u = Math.abs(((now * 0.000012) % 2) - 1);
  const camX = 300 + u * Math.max(0, m.length - span - 600);
  const toY = (wx) => clamp(ch * 0.52 - (t.heightAt(wx) - m.base) / (m.amp * 2.3 + 1) * (ch * 0.3), 34, ch - 26);
  const wAt = (sx) => camX + (sx / cw) * span;
  if (m.far) { c.fillStyle = m.far; c.fillRect(0, ch * 0.55, cw, ch * 0.2); }
  c.beginPath(); c.moveTo(0, ch);
  for (let sx = 0; sx <= cw; sx += 5) c.lineTo(sx, toY(wAt(sx)) + 9);
  c.lineTo(cw, ch); c.closePath();
  c.fillStyle = shade(m.ground, 0.55); c.fill();
  c.beginPath(); c.moveTo(0, ch);
  for (let sx = 0; sx <= cw; sx += 5) c.lineTo(sx, toY(wAt(sx)));
  c.lineTo(cw, ch); c.closePath();
  c.fillStyle = m.ground; c.fill();
  c.strokeStyle = m.accent; c.lineWidth = 2;
  c.beginPath();
  for (let sx = 0; sx <= cw; sx += 5) {
    const y = toY(wAt(sx)) + 2;
    if (sx === 0) c.moveTo(sx, y); else c.lineTo(sx, y);
  }
  c.stroke();
  if (m.surfaces.length > 1) {
    for (let sx = 0; sx <= cw; sx += 6) {
      const sid = surfaceFor(m, 12345, wAt(sx));
      c.strokeStyle = (SURFACES[sid] || SURFACES.asphalt).band;
      c.lineWidth = 4;
      c.beginPath(); c.moveTo(sx, toY(wAt(sx)) + 5); c.lineTo(sx + 6, toY(wAt(sx + 6)) + 5); c.stroke();
    }
  }
  for (let wx = Math.floor(camX / 260) * 260; wx < camX + span; wx += 260) {
    const h1 = hash01(Math.floor(wx / 260));
    if (h1 < 0.45) continue;
    const sx = (wx - camX) / span * cw;
    const gy = toY(wx);
    const b = m.biome;
    if (b === "HILLS" || b === "FOREST") {
      c.fillStyle = b === "FOREST" ? "#234a1e" : "#3f7a34";
      c.beginPath(); c.moveTo(sx, gy); c.lineTo(sx - 6, gy - 14); c.lineTo(sx + 6, gy - 14); c.closePath(); c.fill();
      c.fillStyle = "#5a4028"; c.fillRect(sx - 1, gy - 14, 2, 14);
    } else if (b === "CITY" || b === "HIGHWAY") {
      c.fillStyle = b === "CITY" ? "#181c30" : "#33404f";
      const bh = 16 + h1 * 26;
      c.fillRect(sx - 6, gy - bh, 12, bh);
      if (b === "CITY") { c.fillStyle = "#5fd0ff"; c.fillRect(sx - 4, gy - bh + 3, 3, 3); c.fillStyle = "#ff6ba8"; c.fillRect(sx, gy - bh + 9, 3, 3); }
    } else if (b === "DESERT") {
      c.fillStyle = "#3c825a"; c.fillRect(sx - 2, gy - 14, 4, 14); c.fillRect(sx - 5, gy - 10, 3, 2); c.fillRect(sx + 2, gy - 12, 3, 2);
    } else if (b === "SNOW") {
      c.fillStyle = "#2e5c40";
      c.beginPath(); c.moveTo(sx, gy - 16); c.lineTo(sx - 6, gy); c.lineTo(sx + 6, gy); c.closePath(); c.fill();
      c.fillStyle = "#e8f0f8";
      c.beginPath(); c.moveTo(sx, gy - 16); c.lineTo(sx - 3, gy - 8); c.lineTo(sx + 3, gy - 8); c.closePath(); c.fill();
    } else if (b === "CANYON") {
      c.fillStyle = "#5c3a28";
      c.beginPath(); c.moveTo(sx - 7, gy); c.lineTo(sx - 3, gy - 22); c.lineTo(sx + 3, gy - 18); c.lineTo(sx + 7, gy); c.closePath(); c.fill();
    } else if (b === "VOLCANO") {
      c.fillStyle = "#2a1a18";
      c.beginPath(); c.moveTo(sx - 7, gy); c.lineTo(sx, gy - 16); c.lineTo(sx + 7, gy); c.closePath(); c.fill();
      c.fillStyle = "#e6531c"; c.fillRect(sx - 1, gy - 10, 2, 6);
    } else if (b === "MOON") {
      c.fillStyle = "#1c1c26";
      c.beginPath(); c.ellipse(sx, gy + 2, 7, 2.5, 0, 0, TAU); c.fill();
    } else if (b === "KINGDOM") {
      if (h1 > 0.7) {
        c.fillStyle = "#7a7484"; c.fillRect(sx - 4, gy - 24, 8, 24);
        c.fillStyle = "#5a5464"; c.fillRect(sx - 5, gy - 27, 3, 3); c.fillRect(sx + 2, gy - 27, 3, 3);
        c.fillStyle = "#e6533c"; c.fillRect(sx + 4, gy - 24, 5, 3);
      } else {
        c.fillStyle = "#5a4028"; c.fillRect(sx - 8, gy - 12, 3, 12); c.fillRect(sx + 5, gy - 12, 3, 12);
        c.fillRect(sx - 8, gy - 14, 16, 3);
      }
    }
  }
  for (const pk of mCache.world.pickups) {
    if (pk.taken || pk.x < camX || pk.x > camX + span) continue;
    const sx = (pk.x - camX) / span * cw;
    const sy = toY(pk.x) - 8 + Math.sin(tt * 3 + pk.bob) * 2;
    c.fillStyle = pk.kind === "fuel" ? "#f0a028" : pk.kind === "nitro" ? "#3cc8ff" : "#ffd73c";
    c.beginPath(); c.arc(sx, sy, 3, 0, TAU); c.fill();
  }
  for (const bp of mCache.boosts) {
    if (bp.x < camX || bp.x > camX + span) continue;
    const sx = (bp.x - camX) / span * cw;
    c.fillStyle = "#2cc46e";
    c.globalAlpha = 0.7 + 0.3 * Math.sin(tt * 4);
    c.fillRect(sx - 5, toY(bp.x) + 2, 10, 3);
    c.globalAlpha = 1;
  }
  for (const hz of mCache.hazards) {
    if (hz.x < camX || hz.x > camX + span) continue;
    const sx = (hz.x - camX) / span * cw;
    c.fillStyle = "rgba(230,83,28," + (0.6 + 0.3 * Math.sin(tt * 3)) + ")";
    c.beginPath(); c.ellipse(sx, toY(hz.x) + 2, 9, 3, 0, 0, TAU); c.fill();
  }
  const fx = (START_X + m.length - camX) / span * cw;
  if (fx > -10 && fx < cw + 10) {
    const gy = toY(START_X + m.length);
    c.fillStyle = "#20242c"; c.fillRect(fx, gy - 34, 2, 34);
    for (let r = 0; r < 2; r++) for (let cc = 0; cc < 3; cc++) {
      c.fillStyle = ((r + cc) % 2 === 0) ? "#fff" : "#16161c";
      c.fillRect(fx + 2 + cc * 4, gy - 34 + r * 4, 4, 4);
    }
  }
  if (m.weather === "snowfall") {
    c.fillStyle = "rgba(255,255,255,0.85)";
    for (let i = 0; i < 18; i++) {
      const px = ((i * 61 + tt * 24) % (cw + 20)) - 10;
      const py = (i * 37 + tt * 34) % ch;
      c.beginPath(); c.arc(px, py, 1.2, 0, TAU); c.fill();
    }
  } else if (m.weather === "ashfall") {
    c.fillStyle = "rgba(160,150,150,0.4)";
    for (let i = 0; i < 14; i++) c.fillRect(((i * 53 + tt * 30) % cw), (i * 31 + tt * 22) % ch, 1.8, 1.8);
  } else if (m.weather === "night") {
    c.fillStyle = "rgba(8,10,30,0.25)"; c.fillRect(0, 0, cw, ch);
  } else if (m.weather === "fog") {
    const fg = c.createLinearGradient(0, ch * 0.4, 0, ch);
    fg.addColorStop(0, "rgba(190,205,190,0)"); fg.addColorStop(1, "rgba(190,205,190,0.35)");
    c.fillStyle = fg; c.fillRect(0, 0, cw, ch);
  } else if (m.weather === "rain") {
    c.strokeStyle = "rgba(160,190,230,0.4)";
    for (let i = 0; i < 16; i++) {
      const px = ((i * 47 + tt * 130) % (cw + 20)) - 10;
      const py = (i * 29 + tt * 190) % ch;
      c.beginPath(); c.moveTo(px, py); c.lineTo(px - 3, py + 7); c.stroke();
    }
  }
  mTrans = Math.min(1, (mTrans || 0) + 0.09);
  if (mTrans < 1) { c.fillStyle = "rgba(5,7,12," + (1 - mTrans) + ")"; c.fillRect(0, 0, cw, ch); }
}
function renderMapInfo() {
  const id = MAP_ORDER[mapIdx];
  const m = MAPS[id];
  if (!m) return;
  const unlocked = mapUnlocked(id);
  const selected = save.map === id;
  const rec = save.mapBests[id];
  $("mInfo").innerHTML =
    `<div class="g-name">${escapeHtml(m.label)}${selected ? ' <span class="you-tag">✔ SELECTED</span>' : ""}</div>` +
    `<div class="g-sub"><span class="diff-${m.difficulty}">${m.difficulty}</span> · ${escapeHtml(m.biome)} · ` +
    `${m.weather.toUpperCase()} · ${Math.round(m.length * UNIT_TO_M / 100) / 10} km · target ${m.targetTime}s<br>` +
    (rec && rec.time != null
      ? `Best: ${fmtTime(rec.time)} ${rec.medal ? rec.medal + " medal" : ""} (${VEHICLES[rec.vehicle] ? VEHICLES[rec.vehicle].name : "—"}) · best score ${rec.score.toLocaleString()}`
      : "No record yet — finish this road to set one") +
    (unlocked ? "" : ` · 🔒 ${escapeHtml(mapUnlockText(id))}`) + `</div>` +
    `<div class="g-desc">${escapeHtml(m.desc)}</div>`;
  $("mTags").innerHTML =
    m.recommended.map(r => `<span class="g-tag rec">✔ ${escapeHtml(VEHICLES[r].name)}</span>`).join("") +
    `<span class="g-tag">fuel ${m.fuelMult > 1 ? "×" + m.fuelMult : "normal"}</span>` +
    `<span class="g-tag${m.hazard ? " hazard" : ""}">hazards ${m.hazard ? "lava pools" : "none"}</span>` +
    `<span class="g-tag">boost pads ${m.boostPads}</span>` +
    `<span class="g-tag">surfaces ${m.surfaces.length > 1 ? "mixed" : "uniform"}</span>`;
  $("mDots").innerHTML = "";
  MAP_ORDER.forEach((mid, i) => {
    const b = document.createElement("button");
    b.className = "g-dot" + (i === mapIdx ? " on" : "") + (mapUnlocked(mid) ? "" : " lock");
    b.title = MAPS[mid].label;
    b.onclick = () => { Game.sfx.play("click"); mapIdx = i; renderMapInfo(); };
    $("mDots").appendChild(b);
  });
  const lock = $("mLock");
  if (!unlocked) {
    lock.classList.remove("hidden");
    lock.innerHTML = `<b>🔒 LOCKED</b><span>${escapeHtml(mapUnlockText(id))}</span>`;
    $("mSelect").disabled = true;
    $("mPlaySolo").disabled = true;
  } else {
    lock.classList.add("hidden");
    $("mSelect").disabled = false;
    $("mPlaySolo").disabled = false;
    $("mSelect").textContent = selected ? "SELECTED ✔" : "SELECT";
  }
}

/* ---------- misc UI ---------- */
function updateHomeStats() {
  const v = VEHICLES[save.vehicle] || VEHICLES.sedan;
  const m = MAPS[save.map] || MAPS.highway;
  $("homeStats").textContent =
    `Best ${save.best.toLocaleString()} pts • ${save.coins.toLocaleString()} coins • ${v.name} on ${m.label}`;
  updateProfileStrip();
}
function updateProfileStrip() {
  const el = $("profileStrip");
  if (!el) return;
  let medals = 0;
  for (const m of Object.keys(save.mapBests)) {
    const r = save.mapBests[m];
    if (r && r.medal && ["GOLD", "SILVER", "BRONZE"].includes(r.medal)) medals++;
  }
  const letter = (save.name || "?").trim().charAt(0).toUpperCase() || "?";
  el.innerHTML =
    '<div class="ps-avatar">' + escapeHtml(letter) + "</div>" +
    '<div class="ps-info"><div class="ps-name">' + escapeHtml(save.name || "Guest") + "</div>" +
    '<div class="ps-stats">' + save.coins.toLocaleString() + " coins · best " +
    save.best.toLocaleString() + " pts · " + medals + (medals === 1 ? " medal" : " medals") +
    "</div></div>";
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

/* ---------- feedback & reporting ---------- */
const FB_LIMITS = { feedback: { n: 5, windowMs: 3600000 }, bug: { n: 3, windowMs: 3600000 }, player: { n: 3, windowMs: 3600000 } };
function fbRateOk(channel) {
  try {
    const now = Date.now();
    const log = JSON.parse(localStorage.getItem("rr_fb_log") || "[]");
    const lim = FB_LIMITS[channel] || FB_LIMITS.feedback;
    if (log.filter(e => e.c === channel && now - e.ts < lim.windowMs).length >= lim.n) return false;
    log.push({ c: channel, ts: now });
    while (log.length > 60) log.shift();
    localStorage.setItem("rr_fb_log", JSON.stringify(log));
    return true;
  } catch (e) { return true; }
}
function fbDuplicate(text) {
  try {
    const last = JSON.parse(localStorage.getItem("rr_fb_last") || "null");
    if (last && last.t === text && Date.now() - last.ts < 120000) return true;
    localStorage.setItem("rr_fb_last", JSON.stringify({ t: text, ts: Date.now() }));
    return false;
  } catch (e) { return false; }
}
function fbDiagnostics(kind) {
  const net = Game.net;
  const map = (Game.terrain && MAPS[Game.mapName]) ? MAPS[Game.mapName].label + " (" + Game.mapName + ")" : (MAPS[save.map] ? MAPS[save.map].label : "—");
  const veh = (Game.local && VEHICLES[Game.local.vehicleName]) ? VEHICLES[Game.local.vehicleName].name : (VEHICLES[save.vehicle] || VEHICLES.sedan).name;
  let conn = "solo";
  if (net) conn = net.isHost ? "host · " + (net.connState || "—") : (net.connState || "—") + (net.rtt ? " · " + net.rtt + "ms" : "");
  const br = (navigator.userAgent.match(/(Chrome|Firefox|Safari|Edg|OPR)\/[\d.]+/) || ["unknown"])[0];
  const rows = [
    ["version", GAME_VERSION], ["map", map], ["vehicle", veh], ["connection", conn],
    ["quality", qLevel().toUpperCase()], ["browser", br],
    ["screen", screen.width + "×" + screen.height + " @dpr " + (window.devicePixelRatio || 1).toFixed(1)],
  ];
  if (kind === "player" && net && net.roomCode) rows.push(["room", net.roomCode]);
  return rows;
}
function fbDiagText(kind) { return fbDiagnostics(kind).map(r => "  " + r[0] + ": " + r[1]).join("\n"); }
function fbCaptureRace() {
  const c = document.getElementById("raceCanvas");
  if (!c || !ctx || Game.state === "menu" || !Game.terrain) return null;
  try {
    const w = Math.min(540, c.width);
    const h = Math.round(c.height * (w / c.width));
    const t = document.createElement("canvas");
    t.width = w; t.height = h;
    t.getContext("2d").drawImage(c, 0, 0, w, h);
    return t.toDataURL("image/jpeg", 0.7);
  } catch (e) { return null; }
}
function fbValidate(kind) {
  const msg = $("fbMsg").value.trim();
  if (msg.length < 10) return { ok: false, err: "Description must be at least 10 characters." };
  if (msg.length > 1000) return { ok: false, err: "Description too long (max 1000)." };
  if (/<script/i.test(msg) || /javascript:/i.test(msg)) return { ok: false, err: "Report contains code-like content; describe it in words." };
  if (kind === "player" && !$("fbTarget").value) return { ok: false, err: "Select a player to report." };
  return { ok: true, msg };
}
function fbCompose(kind, sev, msg, contact) {
  const target = kind === "player" ? $("fbTarget").value : null;
  return "ROAD RUSH " + kind.toUpperCase() + " REPORT\n" +
    "severity: " + sev + "\ncategory: " + $("fbCategory").value + "\n" +
    (target ? "reported player: " + target + "\n" : "") +
    "time: " + new Date().toISOString() + "\n\n" +
    "DESCRIPTION:\n" + msg + "\n\nDIAGNOSTICS:\n" + fbDiagText(kind) + "\n\n" +
    "contact: " + (contact || "—") + "\n";
}
function fbTransport(kind, body) {
  const subject = "[ROAD RUSH " + kind.toUpperCase() + "] " + $("fbCategory").value;
  if (FEEDBACK_EMAIL === "you@example.com") return { mode: "outbox", body };
  return { mode: "mailto", url: "mailto:" + FEEDBACK_EMAIL +
    "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body), body };
}
function fbSaveOutbox(kind, sev, body) {
  try {
    const ob = JSON.parse(localStorage.getItem("rr_outbox") || "[]");
    ob.push({ kind, sev, cat: $("fbCategory").value, body, ts: Date.now(), shot: fbShotData || null });
    while (ob.length > 10) ob.shift();
    localStorage.setItem("rr_outbox", JSON.stringify(ob));
    return ob.length;
  } catch (e) { return 0; }
}
function fbRefreshTargets() {
  const sel = $("fbTarget");
  if (!sel) return;
  sel.innerHTML = "";
  if (Game.net) {
    for (const p of Game.net._playerListArr()) {
      if (p.sid === Game.net.mySid) continue;
      const o = document.createElement("option");
      o.value = p.name;
      o.textContent = p.name + (p.disconnectedAt != null ? " (disconnected)" : "");
      sel.appendChild(o);
    }
  }
  if (!sel.options.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "— join a room to report a player —";
    sel.appendChild(o);
  }
}
function fbRenderDiag() {
  const el = $("fbDiag");
  if (!el) return;
  let html = "<b>ATTACHED DIAGNOSTICS</b><br>";
  for (const r of fbDiagnostics(fbKind)) html += escapeHtml(r[0]) + ": <b>" + escapeHtml(r[1]) + "</b><br>";
  el.innerHTML = html;
}
function fbInit() {
  $("fbTabs").querySelectorAll(".fb-tab").forEach(b => {
    b.onclick = () => {
      Game.sfx.play("click");
      fbKind = b.dataset.tab;
      $("fbTabs").querySelectorAll(".fb-tab").forEach(x => x.classList.toggle("on", x === b));
      if (fbKind === "bug") $("fbCategory").value = "BUG";
      const isPlayer = fbKind === "player";
      $("fbTargetLabel").style.display = isPlayer ? "" : "none";
      $("fbTarget").style.display = isPlayer ? "" : "none";
      fbRefreshTargets();
      fbRenderDiag();
      $("fbMsg").placeholder = fbKind === "player"
        ? "What did this player do? (cheating, abuse, exploiting)"
        : fbKind === "bug" ? "What happened? Steps to reproduce if known."
        : "What happened? What did you expect? (min 10 characters)";
    };
  });
  $("fbSeverity").querySelectorAll(".sev-btn").forEach(b => {
    b.onclick = () => {
      Game.sfx.play("click");
      fbSev = b.dataset.sev;
      $("fbSeverity").querySelectorAll(".sev-btn").forEach(x => x.classList.toggle("on", x === b));
    };
  });
  $("fbMsg").addEventListener("input", () => { $("fbCount").textContent = $("fbMsg").value.length + " / 1000"; });
  $("fbShot").onclick = () => {
    const data = fbCaptureRace();
    if (!data) { setStatus("fbStatus", "No race view to capture — screenshots work during/after a race.", "err"); return; }
    fbShotData = data;
    $("fbShotImg").src = data;
    $("fbShotBox").classList.remove("hidden");
    setStatus("fbStatus", "", null);
  };
  $("fbShotDel").onclick = () => { fbShotData = null; $("fbShotBox").classList.add("hidden"); };
  $("fbSend").onclick = async () => {
    const v = fbValidate(fbKind);
    if (!v.ok) { setStatus("fbStatus", v.err, "err"); return; }
    if (!fbRateOk(fbKind)) { setStatus("fbStatus", "Too many reports — wait a while before sending more.", "err"); return; }
    if (fbDuplicate(v.msg)) { setStatus("fbStatus", "This report was just submitted.", "err"); return; }
    setStatus("fbStatus", "Preparing report…", "load");
    await new Promise(r => setTimeout(r, 250));
    const body = fbCompose(fbKind, fbSev, v.msg, $("fbContact").value.trim());
    const t = fbTransport(fbKind, body);
    const n = fbSaveOutbox(fbKind, fbSev, body);
    if (t.mode === "mailto") {
      window.location.href = t.url;
      setStatus("fbStatus", "Opening your email app — review and send.", "ok");
    } else setStatus("fbStatus", "Saved to local outbox (" + n + " stored). Set FEEDBACK_EMAIL in game.js to enable email.", "ok");
  };
  $("fbCopy").onclick = async () => {
    const v = fbValidate(fbKind);
    if (!v.ok) { setStatus("fbStatus", v.err, "err"); return; }
    const body = fbCompose(fbKind, fbSev, v.msg, $("fbContact").value.trim());
    fbSaveOutbox(fbKind, fbSev, body);
    try {
      await navigator.clipboard.writeText(body);
      setStatus("fbStatus", "Report copied to clipboard.", "ok");
    } catch (e) {
      try {
        const ta = document.createElement("textarea");
        ta.value = body; document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta);
        setStatus("fbStatus", "Report copied to clipboard.", "ok");
      } catch (e2) { setStatus("fbStatus", "Copy failed — select the diagnostics box text manually.", "err"); }
    }
  };
}

/* ---------- create-room screen ---------- */
let crSizeVal = 5, crDurVal = "moderate";
function buildCreateScreen() {
  const mapSel = $("crMap");
  mapSel.innerHTML = "";
  for (const m of MAP_ORDER) {
    if (!mapUnlocked(m)) continue;
    const o = document.createElement("option");
    o.value = m; o.textContent = MAPS[m].label + " — " + MAPS[m].difficulty;
    mapSel.appendChild(o);
  }
  if (!mapSel.options.length) { const o = document.createElement("option"); o.value = "highway"; o.textContent = "Highway Run"; mapSel.appendChild(o); }
  const vehSel = $("crVeh");
  vehSel.innerHTML = "";
  for (const v of VEHICLE_ORDER) {
    const o = document.createElement("option");
    o.value = v; o.textContent = VEHICLES[v].name;
    vehSel.appendChild(o);
  }
  const sizeBox = $("crSize");
  sizeBox.innerHTML = "";
  CONFIG.ROOM_SIZES.forEach(sz => {
    const b = document.createElement("button");
    b.className = "sev-btn" + (sz === crSizeVal ? " on" : "");
    b.textContent = sz;
    b.onclick = async () => {
      Game.sfx.play("click");
      crSizeVal = sz;
      sizeBox.querySelectorAll(".sev-btn").forEach(x => x.classList.toggle("on", x === b));
      if (sz >= 15) {
        await rrModal({ title: "LARGE ROOM",
          body: "Large rooms relay through the host's device — they work best on a stronger phone and Wi-Fi. 2 and 5 player rooms run anywhere.",
          confirm: "GOT IT" });
      }
    };
    sizeBox.appendChild(b);
  });
  const durBox = $("crDur");
  durBox.innerHTML = "";
  Object.keys(DURATION_PRESETS).forEach(k => {
    const b = document.createElement("button");
    b.className = "sev-btn" + (k === crDurVal ? " on" : "");
    b.textContent = DURATION_PRESETS[k].label;
    b.onclick = () => {
      Game.sfx.play("click");
      crDurVal = k;
      durBox.querySelectorAll(".sev-btn").forEach(x => x.classList.toggle("on", x === b));
    };
    durBox.appendChild(b);
  });
  $("crVehMode").onchange = () => { $("crVeh").classList.toggle("hidden", $("crVehMode").value !== "locked"); };
}

/* ---------- input ---------- */
window.addEventListener("keydown", (e) => {
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT")) return;
  const k = e.key;
  if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"," ","Tab"].includes(k)) e.preventDefault();
  if (k === "w" || k === "W" || k === "ArrowUp" || k === "8") input.accel = true;
  else if (k === "s" || k === "S" || k === "ArrowDown" || k === "2") input.brake = true;
  else if (k === "a" || k === "A" || k === "ArrowLeft" || k === "4") input.left = true;
  else if (k === "d" || k === "D" || k === "ArrowRight" || k === "6") input.right = true;
  else if ((k === " " || k === "n" || k === "N") && !e.repeat) nitroQueued = true;
  else if ((k === "j" || k === "J" || k === "x" || k === "X") && !e.repeat) jumpQueued = true;
  else if ((k === "e" || k === "E") && !e.repeat) { if (currentScreen() === "screen-race") $("emojiPanel").classList.toggle("hidden"); }
  else if (k === "Tab" && Game.spectate) cycleSpectate(1);
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

/* ---------- init ---------- */
function init() {
  loadSave();
  /* registry migration (older save ids → v2 ids) */
  if (save.vehicle && !VEHICLES[save.vehicle]) save.vehicle = VEHICLE_MIGRATE[save.vehicle] || "sedan";
  if (save.map && !MAPS[save.map]) save.map = MAP_MIGRATE[save.map] || "highway";
  save.owned = (save.owned || []).map(v => VEHICLES[v] ? v : (VEHICLE_MIGRATE[v] || null)).filter(Boolean);
  if (!save.owned.length) save.owned = FREE_VEHICLES.slice();
  if (!save.owned.includes(save.vehicle)) save.owned.push(save.vehicle);
  persist();
  ctx = $("raceCanvas").getContext("2d");
  resizeCanvas();
  applyTierToBody();
  Game.sfx = new Sfx();
  Game.sfx.enabled = save.sound;
  Game.music = new MusicEngine();
  buildEmojiPanel();
  buildLobbyEmojiRow();
  buildCreateScreen();
  updateHomeStats();
  updateSettingsUI();
  $("inpName").value = save.name;
  $("pedalSize").value = save.pedalSizeVal || 100;
  $("pedalOpacity").value = save.pedalOpVal || 90;
  garageIdx = Math.max(0, VEHICLE_ORDER.indexOf(save.vehicle));
  mapIdx = Math.max(0, MAP_ORDER.indexOf(save.map));
  try {
    const qp = new URLSearchParams(location.search);
    DEBUG_MODE = qp.has("debug");
    pendingRoom = (qp.get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (pendingRoom.length > CONFIG.CODE_LEN) { pendingRoom = null; }
  } catch (e) { pendingRoom = null; }
  $("debugPanel").classList.toggle("hidden", !DEBUG_MODE);
  if (pendingRoom) {
    showScreen("screen-play");
    setStatus("playStatus", "Invited to room " + pendingRoom + " — enter your name, then JOIN ROOM.", null);
  }
  bindPedal($("btnGas"), () => input.accel = true, () => input.accel = false);
  bindPedal($("btnBrake"), () => input.brake = true, () => input.brake = false);
  bindPedal($("btnTiltL"), () => input.left = true, () => input.left = false);
  bindPedal($("btnTiltR"), () => input.right = true, () => input.right = false);
  bindPedal($("btnJump"), () => jumpQueued = true, null);
  bindPedal($("btnNitro"), () => nitroQueued = true, null);
  bindPedal($("btnPTT"), () => { if (Game.voice) Game.voice.setPTT(true); }, () => { if (Game.voice) Game.voice.setPTT(false); });
  /* 1-click race: zero prior input, name defaults, prompt after first race */
  $("btnPlay").onclick = () => {
    Game.sfx.play("click");
    if (!save.name) { save.name = autoName(); persist(); }
    Game.mode = "single"; Game.net = null;
    Game.mapName = save.map;
    startRace(Math.floor(Math.random() * 999999) + 1);
  };
  $("btnVehicle").onclick = () => { Game.sfx.play("click"); gTrans = 0; renderGarageInfo(); showScreen("screen-vehicle"); };
  $("btnVehicleBack").onclick = () => { Game.sfx.play("click"); updateHomeStats(); showScreen("screen-home"); };
  $("btnMap").onclick = () => { Game.sfx.play("click"); mCache = null; renderMapInfo(); showScreen("screen-map"); };
  $("btnMapBack").onclick = () => { Game.sfx.play("click"); mCache = null; updateHomeStats(); showScreen("screen-home"); };
  $("btnHowTo").onclick = () => { Game.sfx.play("click"); showScreen("screen-howto"); };
  $("btnHowToBack").onclick = () => { Game.sfx.play("click"); showScreen("screen-home"); };
  $("btnFeedback").onclick = () => {
    Game.sfx.play("click");
    fbKind = "feedback"; fbReportTarget = null;
    $("fbTabs").querySelectorAll(".fb-tab").forEach(x => x.classList.toggle("on", x.dataset.tab === "feedback"));
    $("fbTargetLabel").style.display = "none"; $("fbTarget").style.display = "none";
    setStatus("fbStatus", "", null);
    fbShotData = null; $("fbShotBox").classList.add("hidden");
    $("fbMsg").value = ""; $("fbCount").textContent = "0 / 1000";
    fbRenderDiag();
    showScreen("screen-feedback");
  };
  $("btnFbBack").onclick = () => { Game.sfx.play("click"); fbShotData = null; showScreen("screen-home"); };
  $("btnSettings").onclick = () => { Game.sfx.play("click"); updateSettingsUI(); showScreen("screen-settings"); };
  $("btnSettingsBack").onclick = () => { Game.sfx.play("click"); updateHomeStats(); showScreen("screen-home"); };
  $("btnPlayBack").onclick = () => { Game.sfx.play("click"); updateHomeStats(); showScreen("screen-home"); };
  fbInit();
  /* garage */
  $("gPrev").onclick = () => { Game.sfx.play("click"); garageIdx = (garageIdx + VEHICLE_ORDER.length - 1) % VEHICLE_ORDER.length; gTrans = 0; renderGarageInfo(); };
  $("gNext").onclick = () => { Game.sfx.play("click"); garageIdx = (garageIdx + 1) % VEHICLE_ORDER.length; gTrans = 0; renderGarageInfo(); };
  $("gSelect").onclick = () => {
    if (!vehicleOwned(VEHICLE_ORDER[garageIdx])) return;
    Game.sfx.play("click");
    save.vehicle = VEHICLE_ORDER[garageIdx]; persist();
    renderGarageInfo(); updateHomeStats();
  };
  $("gUnlock").onclick = () => {
    const id = VEHICLE_ORDER[garageIdx];
    const v = VEHICLES[id];
    if (vehicleOwned(id) || save.coins < v.unlock) return;
    Game.sfx.play("finish");
    save.coins -= v.unlock;
    save.owned.push(id);
    persist();
    renderGarageInfo(); updateSettingsUI(); updateHomeStats();
  };
  /* map select */
  $("mPrev").onclick = () => { Game.sfx.play("click"); mapIdx = (mapIdx + MAP_ORDER.length - 1) % MAP_ORDER.length; renderMapInfo(); };
  $("mNext").onclick = () => { Game.sfx.play("click"); mapIdx = (mapIdx + 1) % MAP_ORDER.length; renderMapInfo(); };
  $("mSelect").onclick = () => {
    if (!mapUnlocked(MAP_ORDER[mapIdx])) return;
    Game.sfx.play("click");
    save.map = MAP_ORDER[mapIdx]; persist();
    renderMapInfo(); updateHomeStats();
  };
  $("mPlaySolo").onclick = () => {
    if (!mapUnlocked(MAP_ORDER[mapIdx])) return;
    Game.sfx.play("click");
    save.map = MAP_ORDER[mapIdx];
    const v = validateName($("inpName").value);
    if (v.ok) save.name = v.name;
    persist();
    Game.mode = "single"; Game.net = null;
    Game.mapName = save.map;
    startRace(Math.floor(Math.random() * 999999) + 1);
  };
  /* name live validation */
  const nameHint = $("nameHint");
  $("inpName").addEventListener("input", () => {
    const v = validateName($("inpName").value);
    const el = $("inpName");
    if (v.ok) { el.classList.remove("err"); el.classList.add("ok"); nameHint.textContent = "✓ " + v.name.length + "/16"; }
    else { el.classList.remove("ok"); el.classList.add("err"); nameHint.textContent = v.reason; }
  });
  $("inpName").addEventListener("blur", () => {
    const v = validateName($("inpName").value);
    if (!v.ok && $("inpName").value !== "") { $("inpName").value = ""; nameHint.textContent = "2–16 characters"; }
    $("inpName").classList.remove("ok", "err");
  });
  /* mode screen */
  $("btnSingle").onclick = () => {
    Game.sfx.play("click");
    const v = validateName($("inpName").value);
    if (!v.ok) { setStatus("playStatus", v.reason, "err"); return; }
    save.name = v.name; $("inpName").value = v.name; persist();
    Game.mode = "single"; Game.net = null;
    Game.mapName = save.map;
    startRace(Math.floor(Math.random() * 999999) + 1);
  };
  /* create room */
  $("btnCreateMenu").onclick = () => {
    Game.sfx.play("click");
    $("crName").value = (save.name || "Player") + "'s Room";
    setStatus("crStatus", "", null);
    showScreen("screen-create");
  };
  $("crBack").onclick = () => { Game.sfx.play("click"); showScreen("screen-home"); };
  $("crGo").onclick = async () => {
    Game.sfx.play("click");
    const nv = validateName($("inpName").value || save.name);
    if (!nv.ok) { setStatus("crStatus", "Set your name first (2–16 characters).", "err"); return; }
    save.name = nv.name; persist();
    setStatus("crStatus", "Creating room…", "load");
    await ensurePeerJs();
    if (!window.Peer) { setStatus("crStatus", "Multiplayer unavailable — the connection library could not load. Solo still works.", "err"); return; }
    const cfg = {
      name: ($("crName").value.trim() || nv.name + "'s Room").slice(0, 24),
      map: MAPS[$("crMap").value] ? $("crMap").value : "highway",
      vehicleMode: $("crVehMode").value,
      vehicle: VEHICLES[$("crVeh").value] ? $("crVeh").value : "sedan",
      maxPlayers: crSizeVal,
      duration: DURATION_PRESETS[crDurVal] ? crDurVal : "moderate",
      adSec: clamp(parseInt($("crAd").value, 10) || 5, 3, 30),
    };
    const net = new NetManager();
    setupNetCallbacks(net);
    try {
      await net.createRoom(save.name, $("crPass").value, cfg);
      Game.net = net;
      Game.mode = "host";
      Game.voice = new VoiceChat(net);
      net.voice = Game.voice;
      setStatus("crStatus", "", null);
      enterLobby();
    } catch (e) {
      net.destroy();
      setStatus("crStatus", e.message && e.message.startsWith("badname:")
        ? e.message.slice(8) : "Could not create a room — check your internet and try again.", "err");
    }
  };
  /* join room */
  $("btnJoinMenu").onclick = () => {
    Game.sfx.play("click");
    const v = validateName($("inpName").value);
    if (!v.ok) { setStatus("playStatus", v.reason, "err"); return; }
    save.name = v.name; persist();
    $("inpName").value = v.name;
    setStatus("joinStatus", "", null); setStatus("joinError", "", null);
    $("inpRoomCode").value = "";
    showScreen("screen-join");
    if (pendingRoom) {
      $("inpRoomCode").value = pendingRoom;
      const code = pendingRoom;
      pendingRoom = null;
      setTimeout(() => { if ($("inpRoomCode").value === code) $("btnJoinConnect").click(); }, 400);
    }
  };
  $("btnJoinBack").onclick = () => { Game.sfx.play("click"); showScreen("screen-play"); };
  $("btnJoinConnect").onclick = async () => {
    const code = $("inpRoomCode").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== CONFIG.CODE_LEN) { setStatus("joinError", "Enter the " + CONFIG.CODE_LEN + "-character room code.", "err"); return; }
    Game.sfx.play("click");
    const v = validateName($("inpName").value || save.name);
    if (!v.ok) { setStatus("joinError", v.reason, "err"); return; }
    save.name = v.name; persist();
    setStatus("joinStatus", "Connecting…", "load");
    setStatus("joinError", "", null);
    await ensurePeerJs();
    if (!window.Peer) { setStatus("joinStatus", "", null); setStatus("joinError", "Multiplayer unavailable — the connection library could not load.", "err"); return; }
    const net = new NetManager();
    setupNetCallbacks(net);
    try {
      await net.joinRoom(code, save.name, $("inpRoomPass").value);
      Game.net = net;
      Game.mode = "guest";
      Game.voice = new VoiceChat(net);
      net.voice = Game.voice;
      setStatus("joinStatus", "", null);
      enterLobby();
    } catch (e) {
      net.destroy();
      const msg =
        e.message === "notfound" ? "Room not found — check the code, or the host may have left." :
        e.message === "full" ? "That room is full (" + CONFIG.MAX_PLAYERS + " max)." :
        e.message === "password" ? "Wrong password." :
        e.message === "locked" ? "Room is locked." :
        e.message === "name" ? "Username already in use." :
        e.message === "badname" ? "Invalid username." :
        e.message === "dupsession" ? "Already connected in another tab." :
        e.message === "toomany" ? "Too many attempts — wait a moment." :
        (e.message && e.message.indexOf("muted:") === 0) ? "You are muted for " + e.message.slice(6) + " more minutes." :
        e.message === "timeout" ? "Connection timed out — check both devices' internet." :
        e.message === "network" ? "Network blocked the connection — try again or another network." :
        "Could not connect — check your internet.";
      setStatus("joinStatus", "", null);
      setStatus("joinError", msg, "err");
    }
  };
  $("inpRoomCode").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnJoinConnect").click(); });
  /* lobby */
  $("btnReady").onclick = () => {
    Game.sfx.play("click");
    const me = Game.net.players.get(Game.net.mySid);
    Game.net.setReady(!(me && me.ready));
    updateReadyButton();
  };
  $("btnStartRace").onclick = () => { Game.sfx.play("click"); Game.net.startRace(); };
  $("btnLeaveLobby").onclick = () => { Game.sfx.play("click"); releaseWakeLock(); goHome(); };
  $("btnSetPass").onclick = async () => {
    const pw = await rrModal({ title: "ROOM PASSWORD", input: Game.net.password || "",
      placeholder: "Leave empty to remove the password", confirm: "APPLY" });
    if (pw === null) return;
    Game.net.setPassword(pw);
  };
  $("btnLockToggle").onclick = () => { Game.net.setLocked(!Game.net.locked); };
  $("btnCopyLink").onclick = () => copyInviteLink();
  $("btnShowQr").onclick = () => showQrOverlay();
  $("btnQrClose").onclick = () => { Game.sfx.play("click"); $("overlay-qr").classList.add("hidden"); };
  $("btnMic").onclick = async () => {
    if (!Game.voice) return;
    if (!Game.voice.on) {
      const ok = await Game.voice.requestEnable();
      $("btnMic").textContent = ok ? "🎙 MIC ON" : "🎙 MIC OFF";
      $("btnPTT").classList.toggle("hidden", !ok);
    } else {
      Game.voice.disable();
      $("btnMic").textContent = "🎙 MIC OFF";
      $("btnPTT").classList.add("hidden");
    }
  };
  $("btnSpeaker").onclick = () => {
    if (!Game.voice) return;
    Game.voice.toggleSpeaker();
    $("btnSpeaker").textContent = Game.voice.speaker ? "🔊 SPEAKER ON" : "🔇 SPEAKER OFF";
  };
  $("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChatFromInput(); });
  $("btnChatSend").onclick = sendChatFromInput;
  $("btnChatToggle").onclick = () => {
    $("chatPanel").classList.toggle("collapsed");
    const log = $("chatLog");
    if (!$("chatPanel").classList.contains("collapsed")) log.scrollTop = log.scrollHeight;
  };
  /* race screen */
  $("btnPause").onclick = () => Game.togglePause();
  $("btnEmojis").onclick = () => { if (currentScreen() === "screen-race") $("emojiPanel").classList.toggle("hidden"); };
  $("spPrev").onclick = () => { Game.sfx.play("click"); cycleSpectate(-1); };
  $("spNext").onclick = () => { Game.sfx.play("click"); cycleSpectate(1); };
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
  /* settings */
  $("btnMusicToggle").onclick = () => { save.music = !save.music; Game.music.setEnabled(save.music); persist(); updateSettingsUI(); Game.sfx.play("click"); };
  $("btnSoundToggle").onclick = () => { save.sound = !save.sound; Game.sfx.enabled = save.sound; persist(); updateSettingsUI(); Game.sfx.play("click"); };
  $("btnQuality").onclick = () => {
    const order = ["auto","low","medium","high","extreme"];
    save.quality = order[(order.indexOf(save.quality) + 1) % order.length];
    persist(); updateSettingsUI();
    applyTierToBody(); resizeCanvas(); resetDegradation();
    Game.sfx.play("click");
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
  $("btnResetSave").onclick = async () => {
    const go = await rrModal({ title: "RESET ALL PROGRESS?",
      body: "Coins, records, medals and unlocked vehicles will be wiped. This cannot be undone.",
      danger: true, confirm: "RESET" });
    if (!go) return;
    save.best = 0; save.coins = 0; save.mapBests = {}; save.owned = FREE_VEHICLES.slice();
    persist(); updateSettingsUI(); updateHomeStats();
    Game.sfx.play("click");
  };
  window.addEventListener("resize", () => { resizeCanvas(); checkOrientation(); });
  window.addEventListener("orientationchange", () => setTimeout(checkOrientation, 200));
  checkOrientation();
  if (!pendingRoom) showScreen("screen-home");
  requestAnimationFrame(frame);
}

/* init() runs only in the real app DOM — QA harnesses load these modules bare. */
if (document.getElementById("raceCanvas")) init();
