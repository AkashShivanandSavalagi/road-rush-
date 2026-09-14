"use strict";
/* ROAD RUSH — physics.js: registries + simulation. Pure rules; no DOM.
   Contract: VehicleState + Input + Terrain + Surface + MapModifier = NextState. */

const MAX_STEER_RAD = 0.55;                 // ≈31° — bounded steering (spec §5 fix #1)
const MAX_STEER_DEG = MAX_STEER_RAD * 180 / Math.PI;
const AIR_STEER_RESP = 7.6;
const GRAVITY_BASE = 1800;
const GROUND_FRICTION = 0.985;
const START_X = 120;
const JUMP_HEIGHT = 90;
const JUMP_COOLDOWN = 1.2;
const SEG_LEN = 900;
const UNIT_TO_M = 0.1;

/* spec §5 corrected functions (verbatim) */
function equilibriumSpeed(engineForce, dragCoeff, rollCoeff) {
  const a = dragCoeff, b = rollCoeff, c = -engineForce;
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}
function computeTurnRadius(wheelbase, normalizedSteer) {
  const steerRad = normalizedSteer * MAX_STEER_RAD;
  return wheelbase / Math.tan(steerRad || 0.0001);
}

/* 15 vehicles, exactly 2 motorcycles. engine/drag/roll DERIVED so that
   equilibriumSpeed(...) === maxSpeed exactly → the per-vehicle anti-cheat cap
   (plausible) is genuinely derived from the vehicle's own constants. */
function deriveSpec(v) {
  v.engineForce = v.accel * v.mass;
  v.brakeForce = v.brake * v.mass;
  v.rollCoeff = 0.5 * v.mass;
  v.dragCoeff = (v.engineForce - v.rollCoeff * v.maxSpeed) / (v.maxSpeed * v.maxSpeed);
  v.wheelbase = v.w;
  v.plausible = equilibriumSpeed(v.engineForce, v.dragCoeff, v.rollCoeff) * Math.max(v.nitroBoost, 1.5) * 1.1;
  return v;
}
const VEHICLES = {};
[
  { id:"sedan",  name:"Sedan",        type:"SEDAN",      rarity:"COMMON",    body:"compact", desc:"Balanced all-rounder — the default.",
    accel:640, maxSpeed:480, brake:820, mass:1.0,  stability:0.85, traction:1.05, airControl:0.9,  suspension:0.8,  fuelCap:95,  fuelUse:3.9, nitroBoost:1.5,  cornerStiffness:1.0,  color:"#7fb069", w:56, h:24, drop:5,  unlock:0 },
  { id:"hatch",  name:"Hatchback",    type:"HATCHBACK",  rarity:"COMMON",    body:"compact", desc:"Light, agile, twitchy — easy to flip on big jumps.",
    accel:700, maxSpeed:460, brake:840, mass:0.75, stability:0.7,  traction:1.02, airControl:1.0,  suspension:0.75, fuelCap:80,  fuelUse:3.6, nitroBoost:1.5,  cornerStiffness:1.3,  color:"#c9a24a", w:48, h:22, drop:5,  unlock:0 },
  { id:"muscle", name:"Muscle Car",   type:"MUSCLE",     rarity:"COMMON",    body:"muscle",  desc:"Drag-strip fast; rewards skill, punishes mistakes.",
    accel:860, maxSpeed:560, brake:700, mass:1.25, stability:0.65, traction:1.0,  airControl:0.8,  suspension:0.6,  fuelCap:90,  fuelUse:5.4, nitroBoost:1.55, cornerStiffness:0.9,  color:"#8a4fd0", w:70, h:26, drop:6,  unlock:0 },
  { id:"suv",    name:"SUV",          type:"SUV",        rarity:"COMMON",    body:"suv",     desc:"Forgiving and stable — the second pick for new players.",
    accel:560, maxSpeed:480, brake:800, mass:1.15, stability:0.95, traction:1.18, airControl:0.9,  suspension:1.0,  fuelCap:110, fuelUse:4.6, nitroBoost:1.5,  cornerStiffness:0.8,  color:"#3c82d2", w:68, h:32, drop:7,  unlock:0 },
  { id:"pickup", name:"Pickup Truck", type:"PICKUP",     rarity:"RARE",      body:"pickup",  desc:"Momentum-heavy; plows through small obstacles.",
    accel:580, maxSpeed:500, brake:780, mass:1.35, stability:0.9,  traction:1.12, airControl:0.95, suspension:0.95, fuelCap:105, fuelUse:4.4, nitroBoost:1.5,  cornerStiffness:0.75, color:"#d0822c", w:72, h:28, drop:7,  unlock:150 },
  { id:"sports", name:"Sports Car",   type:"SPORTS",     rarity:"RARE",      body:"sport",   desc:"Fastest on flat, worst off-road — Highway specialist.",
    accel:800, maxSpeed:630, brake:780, mass:0.9,  stability:0.55, traction:0.92, airControl:1.0,  suspension:0.5,  fuelCap:85,  fuelUse:4.6, nitroBoost:1.6,  cornerStiffness:1.2,  color:"#d43c5a", w:66, h:22, drop:5,  unlock:200 },
  { id:"jeep",   name:"Off-Roader",   type:"OFF-ROADER", rarity:"RARE",      body:"suv",     desc:"Best rough-terrain grip — Hills/Forest specialist.",
    accel:600, maxSpeed:470, brake:820, mass:1.2,  stability:0.95, traction:1.25, airControl:0.95, suspension:1.0,  fuelCap:105, fuelUse:4.5, nitroBoost:1.5,  cornerStiffness:0.85, color:"#5a8c5a", w:66, h:33, drop:7,  unlock:300 },
  { id:"van",    name:"Cargo Van",    type:"VAN",        rarity:"RARE",      body:"truck",   desc:"Huge capacity, slow — comedy factor, very hard to flip.",
    accel:440, maxSpeed:410, brake:680, mass:1.6,  stability:1.0,  traction:1.05, airControl:0.6,  suspension:0.85, fuelCap:150, fuelUse:5.2, nitroBoost:1.45, cornerStiffness:0.6,  color:"#5a8c8c", w:84, h:34, drop:8,  unlock:350 },
  { id:"bus",    name:"City Bus",     type:"BUS",        rarity:"EPIC",      body:"bus",     desc:"Extreme stability, extreme slowness. Never crashes, never wins on speed.",
    accel:380, maxSpeed:380, brake:640, mass:2.0,  stability:1.0,  traction:1.0,  airControl:0.5,  suspension:0.8,  fuelCap:170, fuelUse:5.8, nitroBoost:1.4,  cornerStiffness:0.5,  color:"#e6be3c", w:92, h:38, drop:8,  unlock:500 },
  { id:"rally",  name:"Rally Car",    type:"RALLY",      rarity:"EPIC",      body:"rally",   desc:"Tuned for mixed and slippery terrain — Snow/Desert specialist.",
    accel:760, maxSpeed:560, brake:820, mass:0.95, stability:0.8,  traction:1.22, airControl:1.25, suspension:0.95, fuelCap:100, fuelUse:4.3, nitroBoost:1.6,  cornerStiffness:1.15, color:"#2cc4a0", w:64, h:26, drop:6,  unlock:450 },
  { id:"sbike",  name:"Sport Bike",   type:"MOTORCYCLE", rarity:"EPIC",      body:"moto",    desc:"Fastest accel, most fragile — flips easily, huge risk/reward.",
    accel:840, maxSpeed:620, brake:700, mass:0.55, stability:0.45, traction:0.95, airControl:1.4,  suspension:0.55, fuelCap:70,  fuelUse:3.2, nitroBoost:1.65, cornerStiffness:1.5,  color:"#3c82d2", w:50, h:22, drop:4,  unlock:400 },
  { id:"cbike",  name:"Cruiser Bike", type:"MOTORCYCLE", rarity:"EPIC",      body:"moto",    desc:"Heavier, steadier bike — for players who keep crashing the Sport Bike.",
    accel:720, maxSpeed:540, brake:760, mass:0.8,  stability:0.62, traction:1.05, airControl:1.1,  suspension:0.7,  fuelCap:85,  fuelUse:3.8, nitroBoost:1.5,  cornerStiffness:1.35, color:"#b0693c", w:54, h:24, drop:4,  unlock:550 },
  { id:"buggy",  name:"Dune Buggy",   type:"BUGGY",      rarity:"EPIC",      body:"pickup",  desc:"Sand/desert specialist — weak on ice and snow.",
    accel:700, maxSpeed:500, brake:800, mass:0.85, stability:0.85, traction:1.15, airControl:1.15, suspension:1.0,  fuelCap:90,  fuelUse:4.0, nitroBoost:1.55, cornerStiffness:1.1,  color:"#e6a83c", w:62, h:28, drop:7,  unlock:600 },
  { id:"monsta", name:"Monster Truck",type:"MONSTER",    rarity:"LEGENDARY", body:"truck",   desc:"Crushes obstacles, slow — obstacles barely slow it down.",
    accel:460, maxSpeed:430, brake:700, mass:1.9,  stability:1.0,  traction:1.2,  airControl:0.7,  suspension:1.0,  fuelCap:140, fuelUse:5.0, nitroBoost:1.5,  cornerStiffness:0.55, color:"#c94a3c", w:88, h:42, drop:10, unlock:900 },
  { id:"racer",  name:"Race Car",     type:"RACE",       rarity:"LEGENDARY", body:"sport",   desc:"Pure top speed, terrible handling — Highway/City only.",
    accel:820, maxSpeed:660, brake:720, mass:0.85, stability:0.4,  traction:0.9,  airControl:0.9,  suspension:0.4,  fuelCap:75,  fuelUse:4.8, nitroBoost:1.65, cornerStiffness:1.25, color:"#f3d34a", w:70, h:20, drop:5,  unlock:1200 },
].forEach(v => {
  v.isMotorcycle = v.type === "MOTORCYCLE";
  VEHICLES[v.id] = deriveSpec(Object.assign(v, {
    wf: v.body === "moto" ? 8 : 9, wr: v.body === "moto" ? 8 : (v.mass > 1.5 ? 10 : 9),
    rim: "#c9c9d4", flame: ["#ff9a2e", "#ffe86e"],
    idleAmp: 1 + v.mass * 0.7, idleSpd: 3 - v.mass * 0.8, squashVis: 1.2 - v.mass * 0.3,
  }));
});
const VEHICLE_ORDER = Object.keys(VEHICLES);
const FREE_VEHICLES = ["sedan","hatch","suv","cbike"];
const VEHICLE_MIGRATE = { compact:"sedan", sport:"sports", muscle:"muscle", suv:"suv", pickup:"pickup",
  truck:"van", rally:"rally", bus:"bus", moto:"sbike", legend:"cbike", Car:"sedan", Bike:"sbike", Bus:"bus" };
function vehicleBars(v) {
  const c = (x, lo, hi) => clamp(Math.round((x - lo) / (hi - lo) * 10), 0, 10);
  return { speed: c(v.maxSpeed, 370, 670), accel: c(v.accel, 360, 880), stab: c(v.stability, 0.4, 1.0),
    grip: c(v.traction, 0.85, 1.25), fuel: c(v.fuelCap / v.fuelUse, 16, 32), nitro: c(v.nitroBoost, 1.4, 1.7) };
}
function rarityGlow(r) {
  return { COMMON:"rgba(120,140,180,0.16)", RARE:"rgba(95,168,255,0.22)",
           EPIC:"rgba(192,123,255,0.26)", LEGENDARY:"rgba(243,211,74,0.34)" }[r] || "rgba(120,140,180,0.16)";
}

const SURFACES = {
  asphalt:{label:"Asphalt",traction:1.0,roll:1.0,band:"#4a4f55"}, grass:{label:"Grass",traction:0.94,roll:1.04,band:"#4e7a3c"},
  sand:{label:"Sand",traction:0.74,roll:1.22,band:"#d8b878"}, ice:{label:"Ice",traction:0.5,roll:0.92,band:"#bcd8ec"},
  snow:{label:"Snow",traction:0.62,roll:1.12,band:"#f0f4fa"}, mud:{label:"Mud",traction:0.66,roll:1.4,band:"#5a4632"},
  rock:{label:"Rock",traction:0.96,roll:1.0,band:"#6e6e73"}, ash:{label:"Ash",traction:0.8,roll:1.05,band:"#4a4048"},
  regolith:{label:"Regolith",traction:0.9,roll:1.0,band:"#8a8a92"}, cobble:{label:"Cobble",traction:0.98,roll:1.06,band:"#7a7466"},
};
const SURF_DUST = { asphalt:"#8a8a92", grass:"#9ac47a", sand:"#e8c88a", ice:"#dff0ff", snow:"#ffffff",
  mud:"#6a4a2c", rock:"#a8a8ad", ash:"#b0a8a0", regolith:"#c8c8d2", cobble:"#b0a898" };
const WEATHER = { clear:{traction:1}, rain:{traction:0.88}, snowfall:{traction:0.9}, dust:{traction:0.97}, ashfall:{traction:0.95}, night:{traction:1}, fog:{traction:1} };

const MAPS = {
  highway:{ id:"highway", label:"Highway Run", difficulty:"EASY", biome:"HIGHWAY", hazardType:"traffic",
    base:380, amp:20, freq:1.0, smooth:0.2, gravity:1.0, traction:1.0, length:20000, fuelMult:1.0, fuelStep:3000,
    nitroMult:1.0, obstDensity:0.5, surfaces:["asphalt"], weather:"clear", boostPads:3, hazard:false,
    sky:["#78aae6","#c8e1f5"], ground:"#3c4146", accent:"#e6d23c", far:null, dust:"#9a9aa0",
    targetTime:70, recommended:["sports","sedan"], desc:"Smooth asphalt, moving traffic — the speed map." },
  hills:{ id:"hills", label:"Green Hills", difficulty:"EASY", biome:"HILLS", hazardType:"logs",
    base:350, amp:80, freq:1.4, smooth:0.55, gravity:1.0, traction:0.95, length:21000, fuelMult:1.0, fuelStep:3200,
    nitroMult:1.0, obstDensity:0.48, surfaces:["grass","grass","mud"], weather:"clear", boostPads:2, hazard:false,
    sky:["#78be8c","#d2ebbe"], ground:"#507838", accent:"#785028", far:"#3c5c2c", dust:"#b8c9a0",
    targetTime:75, recommended:["jeep","pickup"], desc:"Rolling green jumps — the air map." },
  desert:{ id:"desert", label:"Desert Storm", difficulty:"MEDIUM", biome:"DESERT", hazardType:"cacti",
    base:370, amp:55, freq:1.1, smooth:0.35, gravity:1.0, traction:0.92, length:23000, fuelMult:1.3, fuelStep:3400,
    nitroMult:1.1, obstDensity:0.5, surfaces:["sand","sand","rock"], weather:"dust", boostPads:4, hazard:false,
    sky:["#fabe6e","#ffe1aa"], ground:"#c8a564", accent:"#a8824c", far:"#b08a52", dust:"#e2cba0",
    targetTime:90, recommended:["buggy","rally"], desc:"Slippery dunes, thirsty engines — the momentum map." },
  snow:{ id:"snow", label:"Snow Pass", difficulty:"MEDIUM", biome:"SNOW", hazardType:"iceblocks",
    base:370, amp:65, freq:1.2, smooth:0.45, gravity:1.0, traction:0.55, length:23000, fuelMult:1.0, fuelStep:3400,
    nitroMult:1.0, obstDensity:0.45, surfaces:["snow","ice","ice","snow"], weather:"snowfall", boostPads:3, hazard:false,
    sky:["#c8d7eb","#ebf0f5"], ground:"#ebf0f5", accent:"#7896c8", far:"#aebfd4", dust:"#ffffff",
    targetTime:95, recommended:["rally","suv"], desc:"Ice glides, snow banks — the drift map." },
  forest:{ id:"forest", label:"Forest Rush", difficulty:"MEDIUM", biome:"FOREST", hazardType:"trees",
    base:355, amp:75, freq:1.5, smooth:0.5, gravity:1.0, traction:0.85, length:23500, fuelMult:1.0, fuelStep:3500,
    nitroMult:1.0, obstDensity:0.6, surfaces:["grass","mud","mud","grass"], weather:"fog", boostPads:3, hazard:false,
    sky:["#5a7a6a","#aec4a8"], ground:"#3c5c2c", accent:"#28502a", far:"#2a4424", dust:"#8aa878",
    targetTime:100, recommended:["rally","pickup"], desc:"Dense trees, mud drags, fog — the precision map." },
  city:{ id:"city", label:"City After Dark", difficulty:"HARD", biome:"CITY", hazardType:"barriers",
    base:380, amp:45, freq:1.3, smooth:0.3, gravity:1.0, traction:0.98, length:24000, fuelMult:1.1, fuelStep:3600,
    nitroMult:1.15, obstDensity:0.65, surfaces:["asphalt","asphalt","cobble"], weather:"night", boostPads:5, hazard:false,
    sky:["#0c1226","#22203c"], ground:"#2e3238", accent:"#e6d23c", far:"#141628", dust:"#666670",
    targetTime:105, recommended:["sports","muscle"], desc:"Neon ramps, barriers — the reflex map." },
  canyon:{ id:"canyon", label:"Canyon Edge", difficulty:"HARD", biome:"CANYON", hazardType:"cliffs",
    base:350, amp:100, freq:1.3, smooth:0.4, gravity:1.0, traction:0.9, length:26000, fuelMult:1.1, fuelStep:3800,
    nitroMult:1.1, obstDensity:0.5, surfaces:["rock","rock","sand"], weather:"clear", boostPads:3, hazard:false,
    sky:["#e8a86e","#f8d8b0"], ground:"#a86f4a", accent:"#5c3a28", far:"#7a4a34", dust:"#d8a882",
    targetTime:115, recommended:["rally","pickup"], desc:"Steep drops, risky lines — the gamble map." },
  volcano:{ id:"volcano", label:"Volcano Run", difficulty:"HARD", biome:"VOLCANO", hazardType:"lava",
    base:360, amp:92, freq:1.2, smooth:0.35, gravity:1.0, traction:0.88, length:26000, fuelMult:1.25, fuelStep:3800,
    nitroMult:1.2, obstDensity:0.55, surfaces:["ash","rock","ash"], weather:"ashfall", boostPads:4, hazard:true,
    sky:["#2a1018","#5c2418"], ground:"#3a2a28", accent:"#e6531c", far:"#241418", dust:"#c8b8a8",
    targetTime:120, recommended:["monsta","suv"], desc:"Timed lava pulses — the timing map." },
  moon:{ id:"moon", label:"Moon Gravity", difficulty:"HARD", biome:"MOON", hazardType:"craters",
    base:380, amp:60, freq:0.8, smooth:0.4, gravity:0.35, traction:0.9, length:27000, fuelMult:1.0, fuelStep:3800,
    nitroMult:1.2, obstDensity:0.45, surfaces:["regolith"], weather:"clear", boostPads:4, hazard:false,
    sky:["#08081a","#191428"], ground:"#96969b", accent:"#5a5a5f", far:"#141020", dust:"#c8c8d2",
    targetTime:100, recommended:["sbike","cbike"], desc:"0.35 G — the float map." },
  kingdom:{ id:"kingdom", label:"Kingdom Trail", difficulty:"SPECIAL", biome:"KINGDOM", hazardType:"none",
    base:355, amp:72, freq:1.25, smooth:0.5, gravity:1.0, traction:0.93, length:25000, fuelMult:1.0, fuelStep:3300,
    nitroMult:1.3, obstDensity:0.55, surfaces:["grass","cobble","grass","rock"], weather:"clear", boostPads:8, hazard:false,
    sky:["#8aa8e0","#e0d8f0"], ground:"#5c7a48", accent:"#c8a24a", far:"#4a5a70", dust:"#c0c8a8",
    targetTime:95, recommended:["rally","sbike"], desc:"Boost-pad chains — the rhythm map." },
};
const MAP_ORDER = Object.keys(MAPS);
const MAP_MIGRATE = { Highway:"highway", Hills:"hills", Moon:"moon", Desert:"desert", Snow:"snow" };
const DIFF_GATE = { MEDIUM:"EASY", HARD:"MEDIUM", SPECIAL:"HARD" };
function mapUnlocked(mapId, bests) {
  const b = (bests == null) ? save.mapBests : bests;
  const d = MAPS[mapId] && MAPS[mapId].difficulty;
  if (!d || d === "EASY") return true;
  return MAP_ORDER.some(m => MAPS[m].difficulty === DIFF_GATE[d] && b && b[m]);
}
function mapUnlockText(mapId) {
  const d = MAPS[mapId].difficulty;
  return d === "EASY" ? "" : "Finish any " + DIFF_GATE[d] + " road to unlock";
}
function surfaceFor(mapDef, seed, x) {
  const list = mapDef.surfaces;
  if (list.length === 1) return list[0];
  const seg = Math.floor(Math.max(0, x) / SEG_LEN);
  return list[Math.floor(hash01(((seed >>> 0) % 100003) * 131 + seg * 7919) * list.length) % list.length];
}

/* duration presets (spec §4 verbatim) */
const AVG_VEHICLE_SPEED_MPS = 26;
const DURATION_PRESETS = {
  instant:  { label: "Instant (~1 min)",   targetSeconds: 60  },
  moderate: { label: "Moderate (~2 min)",  targetSeconds: 120 },
  long:     { label: "Long (~4 min)",      targetSeconds: 240 },
  marathon: { label: "Marathon (~10 min)", targetSeconds: 600 },
};
function computeFinishDistance(presetKey) {
  return Math.round(AVG_VEHICLE_SPEED_MPS * DURATION_PRESETS[presetKey].targetSeconds);
}
function presetFinishUnits(presetKey) { return Math.round(computeFinishDistance(presetKey) / UNIT_TO_M); }

class Terrain {
  constructor(mapDef, seed) {
    this.def = mapDef; this.seed = seed >>> 0;
    const rng = mulberry32(seed >>> 0);
    this.phases = [rng() * TAU, rng() * TAU, rng() * TAU, rng() * TAU];
  }
  heightAt(x) {
    const { base, amp, freq, smooth } = this.def;
    let h = Math.sin(x * freq * 0.001 + this.phases[0]) * amp
          + Math.sin(x * freq * 0.0025 + this.phases[1]) * (amp * 0.5) * smooth
          + Math.sin(x * freq * 0.0006 + this.phases[2]) * (amp * 1.3) * (1 - smooth * 0.4)
          + Math.sin(x * freq * 0.006 + this.phases[3]) * (amp * 0.15);
    if (x < 300) h *= x / 300;
    return base + h;
  }
  slopeAt(x) { return (this.heightAt(x + 2) - this.heightAt(x - 2)) / 4; }
}
function generateWorldObjects(terrain, seed, length, opts) {
  const noFuel = !!(opts && opts.noFuel);      // multiplayer: fuel entirely absent
  const md = terrain.def;
  const rng = mulberry32((seed ^ 0xC0FFEE) >>> 0);
  const pickups = [], obstacles = [];
  let pid = 0;
  const addPk = (x, kind) => pickups.push({ id: pid++, x, kind, taken: false, bob: rng() * TAU });
  if (!noFuel) for (let fx = 900; fx < length - 400; fx += md.fuelStep) addPk(fx, "fuel");
  let x = 600;
  while (x < length - 400) {
    x += 150 + rng() * 130;
    const roll = rng();
    if (roll < 0.17) { if (!noFuel) addPk(x, "fuel"); }
    else if (roll < 0.30 * md.nitroMult + 0.17) addPk(x, "nitro");
    else if (roll < 0.58) addPk(x, "coin");
  }
  const kindMap = { HIGHWAY:"traffic", HILLS:"log", DESERT:"cactus", SNOW:"ice", FOREST:"log",
    CITY:"barrier", CANYON:"rock", VOLCANO:"rock", MOON:"crater", KINGDOM:"crate" };
  const kind = kindMap[md.biome] || "rock";
  x = 900;
  while (x < length - 500) {
    x += (520 + rng() * 420) / (0.4 + md.obstDensity * 0.8);
    if (rng() < 0.55 + md.obstDensity * 0.4) {
      obstacles.push({ x, x0: x, kind, w: kind === "traffic" ? 48 : 28 + rng() * 8,
        h: kind === "traffic" ? 26 : 24 + rng() * 8, v: kind === "traffic" ? -(70 + rng() * 50) : 0, cd: 0 });
    }
  }
  pickups.sort((a, b) => a.x - b.x);
  const pkMap = new Map(pickups.map(p => [p.id, p]));
  return { pickups, obstacles, pkMap };
}
function generateBoosts(mapDef, seed, length) {
  const n = mapDef.boostPads || 0;
  if (!n) return [];
  const rng = mulberry32((seed ^ 0xB0057) >>> 0);
  const pads = [];
  let x = 1900 + rng() * 1200;
  const step = (length - 2600) / n;
  for (let i = 0; i < n; i++) { if (x > length - 700) break; pads.push({ x, w: 90, cd: 0 }); x += step + rng() * 600; }
  return pads;
}
function generateHazards(mapDef, seed, length) {
  if (!mapDef.hazard) return [];
  const rng = mulberry32((seed ^ 0xFACE) >>> 0);
  const pools = [];
  let x = 2600;
  while (x < length - 700) { x += 2200 + rng() * 1800; pools.push({ x, w: 200 + rng() * 160, cd: 0 }); }
  return pools;
}

/* VehiclePhysics — fuel NEVER branches on game mode here; the CALLER sets
   fuelEnabled (solo true, MP false). MP nitro economy lives in game.js. */
class VehiclePhysics {
  constructor(vehicleId, terrain, opts = {}) {
    const def = VEHICLES[vehicleId] || VEHICLES.sedan;
    this.vehicleName = vehicleId; this.def = def;
    this.accelPower = def.accel; this.maxSpeed = def.maxSpeed; this.brakePower = def.brake;
    this.mass = def.mass; this.stability = def.stability;
    this.vehTraction = def.traction; this.airControl = def.airControl; this.suspension = def.suspension;
    this.nitroStrength = def.nitroBoost;
    this.fuelCap = def.fuelCap; this.fuelUsePerSec = def.fuelUse;
    this.color = def.color; this.w = def.w; this.h = def.h; this.wheelDrop = def.drop;
    this.fuelMult = opts.fuelMult || 1;
    this.fuelEnabled = opts.fuelEnabled !== false;
    this.terrain = terrain;
    this.id = opts.id || "local"; this.sid = opts.sid || null;
    this.name = opts.name || "Player";
    this.isRemote = !!opts.isRemote; this.isBot = !!opts.isBot;
    this.x = START_X; this.y = terrain.heightAt(START_X) - this.h / 2 - this.wheelDrop;
    this.vx = 0; this.vy = 0; this.angle = 0; this.angVel = 0;
    this.onGround = true; this.airtime = 0; this.jumpCd = 0; this.wheelAngle = 0;
    this.fuel = this.fuelCap;
    this.nitroCharges = 0; this.maxNitro = 3; this.nitroTimer = 0;
    this.coins = 0; this.distance = 0;
    this.finished = false; this.finishTime = null;
    this.stunned = 0; this.shake = 0; this._dustCd = 0;
    this.squash = 0; this.boostT = 0; this._flameCd = 0; this._streakCd = 0;
    this.crashes = 0; this.nitroUsed = 0;
    this.surfaceId = terrain.def.surfaces[0];
  }
  /* Lateral reference model — uses BOTH spec-corrected functions; mass
     applied exactly ONCE (heavier vehicles measurably corner differently). */
  corneringRadius(speed) {
    const kin = computeTurnRadius(this.def.wheelbase, 1.0);
    const latMax = (this.def.cornerStiffness * 600) / this.mass;
    return Math.max(kin, (speed * speed) / latMax);
  }
  useNitro(particles, sfx) {
    if (this.nitroCharges > 0 && this.nitroTimer <= 0) {
      this.nitroCharges -= 1; this.nitroTimer = 2.0; this.nitroUsed++;
      if (sfx) sfx.play("nitro");
      if (particles) particles.emit(this.x - this.w * 0.5, this.y, 12, "#ffb050",
        { spread: 60, speed: 200, life: 0.4, size: 4, gravity: 200 });
      return true;
    }
    return false;
  }
  step(dt, input, mapModifier, ctx) {
    const particles = ctx && ctx.particles, sfx = ctx && ctx.sfx;
    const raceStarted = !ctx || ctx.raceStarted !== false;
    const t = this.terrain;
    const gravity = GRAVITY_BASE * (mapModifier ? mapModifier.gravity : t.def.gravity);
    if (this.stunned > 0) {
      this.stunned -= dt;
      input = { accel: false, brake: false, left: false, right: false, nitro: false, jump: false };
    }
    let { accel, brake, left, right, nitro, jump } = input;
    if (!raceStarted) { accel = brake = left = right = nitro = jump = false; }
    if (this.jumpCd > 0) this.jumpCd -= dt;
    if (this.squash > 0) this.squash = Math.max(0, this.squash - 3.2 * dt);
    if (this.boostT > 0) this.boostT -= dt;
    if (nitro && raceStarted) this.useNitro(particles, sfx);
    if (this.nitroTimer > 0) this.nitroTimer -= dt;
    const nitroBoost = this.nitroTimer > 0 ? this.nitroStrength : 1.0;
    if (jump && raceStarted && this.onGround && this.stunned <= 0 && this.jumpCd <= 0) {
      this.vy = -Math.sqrt(2 * gravity * JUMP_HEIGHT);
      this.onGround = false; this.jumpCd = JUMP_COOLDOWN;
      if (sfx) sfx.play("jump");
      if (particles) particles.emit(this.x, this.y + this.h / 2, 8, t.def.dust, { spread: 70, speed: 110, life: 0.35, size: 2, gravity: 500 });
    }
    const outOfFuel = this.fuelEnabled && this.fuel <= 0;    // MP: never stalls (no fuel at all)
    const powerMult = outOfFuel ? 0.15 : 1.0;
    const slope = t.slopeAt(this.x);
    const slopeDeg = Math.atan(slope) * 180 / Math.PI;
    this.surfaceId = surfaceFor(t.def, t.seed, this.x);
    const surf = SURFACES[this.surfaceId] || SURFACES.asphalt;
    const wx = (WEATHER[t.def.weather] || WEATHER.clear).traction;
    const effTraction = clamp(t.def.traction * this.vehTraction * wx * surf.traction, 0.25, 1.25);
    if (this.onGround) {
      if (accel) {
        this.vx += this.accelPower * powerMult * nitroBoost * dt;
        if (this.fuelEnabled && this.fuel > 0)
          this.fuel -= this.fuelUsePerSec * this.fuelMult * dt * (1 + Math.abs(slope) * 0.5);
      }
      if (brake) { this.vx > 5 ? this.vx -= this.brakePower * dt : this.vx -= this.accelPower * 0.5 * dt; }
      const frameF = GROUND_FRICTION + (1 - GROUND_FRICTION) * (1 - effTraction);
      this.vx *= Math.pow(frameF, surf.roll * dt * 60);
      this.vx -= slope * gravity * dt * 0.5 * (0.7 + this.mass * 0.25);   // mass applied exactly once
    } else { this.airtime += dt; this.vx *= Math.pow(0.999, dt * 60); }
    this.vx = clamp(this.vx, -this.maxSpeed * 0.4, this.maxSpeed * nitroBoost);
    /* Airborne tilt = bounded steering (spec fix #1 live): normalized × MAX_STEER */
    if (!this.onGround) {
      const steerNorm = (right ? 1 : 0) - (left ? 1 : 0);
      this.angVel += (steerNorm * MAX_STEER_DEG) * AIR_STEER_RESP * this.airControl * dt * 0.13;
      this.angVel *= Math.pow(0.98, dt * 60);
      this.angle += this.angVel * dt;
    } else { this.angle = lerp(this.angle, slopeDeg, clamp(12 * dt, 0, 1)); this.angVel = 0; }
    const groundY = t.heightAt(this.x);
    if (this.onGround) { this.vy = 0; this.y = groundY - this.h / 2 - this.wheelDrop; }
    else { this.vy += gravity * dt; this.y += this.vy * dt; }
    this.x += this.vx * dt;
    if (this.x < 60) { this.x = 60; if (this.vx < 0) this.vx = 0; }
    this.distance = Math.max(this.distance, this.x - START_X);
    this.wheelAngle += (this.vx * dt) / Math.max(6, this.def.wr || 8);
    const gy = t.heightAt(this.x) - this.h / 2 - this.wheelDrop;
    if (this.y >= gy) {
      const wasAirborne = !this.onGround;
      this.y = gy;
      if (wasAirborne) {
        const impact = Math.abs(this.vy);
        this.vy = 0;
        this.squash = clamp(impact / 1500, 0.2, 1) * (this.def.squashVis || 1);
        const angleOff = Math.abs(this.angle - slopeDeg);
        const crashChance = (impact / 1400) * (angleOff / 45) * (1.2 - this.stability) * (1.25 - this.suspension * 0.45);
        const dcol = SURF_DUST[this.surfaceId] || t.def.dust;
        if ((crashChance > 0.55 && this.airtime > 0.25) || angleOff > 110) this._crash(particles, sfx);
        else {
          if (sfx) sfx.play("land");
          const muddy = this.surfaceId === "mud";
          if (particles) particles.emit(this.x, this.y + this.h / 2, 4 + Math.round(this.suspension * 4) + (muddy ? 2 : 0), dcol,
            { spread: 60, speed: muddy ? 130 : 90, life: 0.3, size: muddy ? 3 : 2, gravity: muddy ? 900 : 500, shape: muddy ? "rect" : undefined, pw: 5, ph: 4 });
        }
      }
      this.onGround = true; this.airtime = 0;
    } else this.onGround = false;
    this.angle = ((this.angle + 180) % 360 + 360) % 360 - 180;
    if (this.onGround && accel && !outOfFuel && Math.abs(this.vx) > 80) {
      this._dustCd -= dt;
      if (this._dustCd <= 0) {
        this._dustCd = this.surfaceId === "mud" ? 0.1 : 0.07;
        const dcol = SURF_DUST[this.surfaceId] || t.def.dust, muddy = this.surfaceId === "mud";
        if (particles) particles.emit(this.x - this.w * 0.4, this.y + this.h * 0.4, 2, dcol,
          { spread: 40, speed: 70, life: 0.35, size: muddy ? 3 : 2, gravity: muddy ? 900 : 400, shape: muddy ? "rect" : undefined, pw: 5, ph: 3 });
      }
    }
  }
  _crash(particles, sfx) {
    if (sfx) sfx.play("collision");
    if (typeof vibrate === "function") vibrate(40);
    this.crashes++;
    if (particles) {
      particles.emit(this.x, this.y, 14, "#ff8c28", { spread: 140, speed: 180, life: 0.5, size: 3, gravity: 700 });
      particles.emit(this.x, this.y, 8, shade(this.color, 0.85), { spread: 120, speed: 220, life: 0.7, size: 3, gravity: 900, shape: "rect", pw: 6, ph: 4 });
    }
    this.vx *= 0.35; this.stunned = 0.5; this.shake = 1; this.squash = 1;
    this.angle = clamp(this.angle, -35, 35);
  }
  rect() { return { x: this.x - this.w / 2, y: this.y - this.h / 2, w: this.w, h: this.h }; }
}
function rectsOverlap(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }

/* MP nitro economy (fuel-free mode): drafting charges */
function driftOrDraftCharge(p, allPlayers, dt) {
  let rate = 0.02;
  for (const o of allPlayers) {
    if (o === p || o.finished) continue;
    const dx = o.x - p.x;
    if (dx > 60 && dx < 180 && Math.abs(o.y - p.y) < 90) { rate = 0.12; break; }
  }
  return rate * dt;
}

/* pure rules */
const PLACE_BONUS = { 1: 1000, 2: 700, 3: 400 };
function computeScore(distanceM, coins, place, fuelRemaining) {
  let s = distanceM * 10 + coins * 10 + fuelRemaining * 2;
  if (PLACE_BONUS[place]) s += PLACE_BONUS[place];
  else if (place && place > 3) s += Math.max(0, 200 - (place - 4) * 20);
  return Math.round(s);
}
function medalFor(mapDef, timeSec) {
  if (timeSec == null || !mapDef || !mapDef.targetTime) return null;
  if (timeSec <= mapDef.targetTime) return "GOLD";
  if (timeSec <= mapDef.targetTime * 1.25) return "SILVER";
  if (timeSec <= mapDef.targetTime * 1.6) return "BRONZE";
  return null;
}
const MEDAL_COINS = { GOLD: 150, SILVER: 80, BRONZE: 50 };
function fillFuel(cur, cap) { return cap; }
function addNitro(cur, max) { return Math.min(max, cur + 1); }
function deltaOk(plausibleUnitsPerSec, dtSec, delta, slack) {
  return delta <= plausibleUnitsPerSec * dtSec + (slack == null ? 120 : slack);
}
function netFinishSchemaOk(d) {
  return d && typeof d.time === "number" && isFinite(d.time) && d.time >= 0 &&
    typeof d.distance === "number" && isFinite(d.distance) &&
    typeof d.coins === "number" && isFinite(d.coins) && d.coins >= 0 && d.coins < 1000 &&
    typeof d.fuel === "number" && isFinite(d.fuel) && d.fuel >= 0;
}
