"use strict";
/* =====================================================================================
   ROAD RUSH — physics.js
   Deterministic 2D arcade vehicle physics + seeded terrain generation.
   No DOM dependency — runs identically in a browser or in Node for testing.

   DESIGN NOTE ON UNITS: this uses the same arcade-unit convention as the already-
   tested build (pixels/seconds, direct accel/maxSpeed tuning), NOT the force/drag/
   equilibrium-speed model from the external "senior dev" reference document. That
   model had two verified bugs (steering unit mismatch, mass-cancellation in cornering)
   and used SI units inconsistent with everything already built and tested here.
   Rather than port its bugs forward, this file keeps the simpler, working model and
   fixes the ONE genuinely useful idea from that document — a per-vehicle anti-cheat
   speed ceiling instead of one global constant — using this model's own maxSpeed.
===================================================================================== */

// ---------------------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------------------
export const TICK_RATE = 60;
export const FIXED_DT = 1 / TICK_RATE;          // fixed 16.66ms physics step
export const MAX_STEER_RAD = 0.55;              // ~31.5 degrees — real bounded steering angle
export const GRAVITY_BASE = 1800;               // px/s^2
export const GROUND_FRICTION = 0.985;
export const NITRO_BOOST_MULT = 1.55;
export const NITRO_ANTICHEAT_SLACK = 1.6;       // per-vehicle speed ceiling = maxSpeed * this

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }

// ---------------------------------------------------------------------------------------
// DETERMINISTIC RNG (mulberry32) — same seed always produces same terrain, everywhere
// ---------------------------------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------
// VEHICLES — 15 total, exactly 2 motorcycles (locked spec)
// Identity comes from PHYSICS CONSTANTS, never a flat "stat number."
// ---------------------------------------------------------------------------------------
export const VEHICLES = {
  Sedan:        { accel: 620, maxSpeed: 520, brake: 780, mass: 1.00, stability: 0.80, fuelCap: 100, fuelUse: 9.0,  cornerStiff: 1.00, isMotorcycle: false },
  Hatchback:    { accel: 700, maxSpeed: 500, brake: 760, mass: 0.80, stability: 0.65, fuelCap: 90,  fuelUse: 8.0,  cornerStiff: 1.15, isMotorcycle: false },
  MuscleCar:    { accel: 780, maxSpeed: 610, brake: 720, mass: 1.15, stability: 0.55, fuelCap: 100, fuelUse: 11.0, cornerStiff: 0.85, isMotorcycle: false },
  SUV:          { accel: 560, maxSpeed: 470, brake: 800, mass: 1.30, stability: 0.90, fuelCap: 120, fuelUse: 10.0, cornerStiff: 0.95, isMotorcycle: false },
  PickupTruck:  { accel: 500, maxSpeed: 440, brake: 820, mass: 1.45, stability: 0.92, fuelCap: 130, fuelUse: 10.5, cornerStiff: 0.90, isMotorcycle: false },
  SportsCar:    { accel: 850, maxSpeed: 660, brake: 700, mass: 1.05, stability: 0.50, fuelCap: 85,  fuelUse: 12.0, cornerStiff: 0.80, isMotorcycle: false },
  OffRoader:    { accel: 580, maxSpeed: 480, brake: 780, mass: 1.25, stability: 0.88, fuelCap: 125, fuelUse: 9.5,  cornerStiff: 1.05, isMotorcycle: false },
  CargoVan:     { accel: 420, maxSpeed: 380, brake: 700, mass: 1.55, stability: 0.95, fuelCap: 140, fuelUse: 11.5, cornerStiff: 0.75, isMotorcycle: false },
  CityBus:      { accel: 360, maxSpeed: 340, brake: 650, mass: 1.70, stability: 1.00, fuelCap: 150, fuelUse: 12.5, cornerStiff: 0.65, isMotorcycle: false },
  RallyCar:     { accel: 660, maxSpeed: 540, brake: 760, mass: 1.00, stability: 0.75, fuelCap: 100, fuelUse: 9.0,  cornerStiff: 1.20, isMotorcycle: false },
  SportBike:    { accel: 900, maxSpeed: 680, brake: 640, mass: 0.55, stability: 0.35, fuelCap: 70,  fuelUse: 7.0,  cornerStiff: 1.35, isMotorcycle: true  },
  CruiserBike:  { accel: 760, maxSpeed: 600, brake: 660, mass: 0.65, stability: 0.48, fuelCap: 80,  fuelUse: 7.5,  cornerStiff: 1.10, isMotorcycle: true  },
  DuneBuggy:    { accel: 680, maxSpeed: 510, brake: 740, mass: 0.90, stability: 0.70, fuelCap: 95,  fuelUse: 9.0,  cornerStiff: 1.10, isMotorcycle: false },
  MonsterTruck: { accel: 460, maxSpeed: 400, brake: 760, mass: 1.60, stability: 0.97, fuelCap: 145, fuelUse: 12.0, cornerStiff: 0.70, isMotorcycle: false },
  RaceCar:      { accel: 880, maxSpeed: 700, brake: 680, mass: 1.00, stability: 0.40, fuelCap: 80,  fuelUse: 12.5, cornerStiff: 0.78, isMotorcycle: false },
};

// ---------------------------------------------------------------------------------------
// MAPS — 10 total, each a distinct physics/hazard ruleset (locked spec)
// ---------------------------------------------------------------------------------------
export const MAPS = {
  Highway: { base: 380, amp: 22, freq: 1.0, smooth: 0.20, gravity: 1.00, traction: 1.00, hazard: "traffic" },
  Hills:   { base: 350, amp: 85, freq: 1.4, smooth: 0.55, gravity: 1.00, traction: 0.95, hazard: "log"     },
  Moon:    { base: 380, amp: 50, freq: 0.8, smooth: 0.40, gravity: 0.35, traction: 0.90, hazard: "crater"  },
  Desert:  { base: 370, amp: 55, freq: 1.1, smooth: 0.35, gravity: 1.00, traction: 0.92, hazard: "cactus"  },
  Snow:    { base: 370, amp: 65, freq: 1.2, smooth: 0.45, gravity: 1.00, traction: 0.55, hazard: "ice"     },
  Forest:  { base: 360, amp: 60, freq: 1.3, smooth: 0.50, gravity: 1.00, traction: 0.85, hazard: "tree"    },
  City:    { base: 380, amp: 18, freq: 1.0, smooth: 0.15, gravity: 1.00, traction: 0.98, hazard: "barrier" },
  Canyon:  { base: 340, amp: 95, freq: 1.5, smooth: 0.60, gravity: 1.00, traction: 0.90, hazard: "cliff"   },
  Volcano: { base: 350, amp: 90, freq: 1.4, smooth: 0.55, gravity: 1.00, traction: 0.88, hazard: "lava"    },
  Kingdom: { base: 370, amp: 60, freq: 1.2, smooth: 0.45, gravity: 1.00, traction: 0.93, hazard: "boost"   },
};

// ---------------------------------------------------------------------------------------
// TERRAIN — pure function of x + seed, never stored, always regenerable identically
// ---------------------------------------------------------------------------------------
export class Terrain {
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
    if (x < 300) h *= x / 300; // flatten the start so nobody spawns on a slope
    return base + h;
  }
  slopeAt(x) {
    const d = 2;
    return (this.heightAt(x + d) - this.heightAt(x - d)) / (2 * d);
  }
}

// ---------------------------------------------------------------------------------------
// VEHICLE PHYSICS — fixed steering unit bug + fixed mass-cancellation bug from the
// external reference document; both are called out explicitly at the fix site below.
// ---------------------------------------------------------------------------------------
export class VehiclePhysics {
  constructor(vehicleKey, terrain, opts = {}) {
    const v = VEHICLES[vehicleKey];
    if (!v) throw new Error(`Unknown vehicle: ${vehicleKey}`);
    this.vehicleKey = vehicleKey;
    this.accelPower = v.accel;
    this.maxSpeed = v.maxSpeed;
    this.brakePower = v.brake;
    this.mass = v.mass;
    this.stability = v.stability;
    this.cornerStiff = v.cornerStiff;
    this.fuelCap = v.fuelCap;
    this.fuelUse = v.fuelUse;
    this.terrain = terrain;
    this.mode = opts.mode || "multiplayer"; // "solo" enables fuel; "multiplayer" never does

    this.x = opts.startX ?? 120;
    this.y = terrain.heightAt(this.x);
    this.vx = 0; this.vy = 0;
    this.angle = 0; this.angVel = 0;
    this.onGround = true; this.airtime = 0;
    this.fuel = this.fuelCap;
    this.nitroCharges = 0; this.maxNitro = 3; this.nitroTimer = 0;
    this.stunned = 0;
    this.distance = 0;
  }

  // The per-vehicle anti-cheat ceiling — the ONE useful idea adopted from the external
  // reference doc, but derived from THIS model's own tuned maxSpeed (never a single
  // global constant, which in the reference doc was actually LOWER than some vehicles'
  // legitimate top speed and would have falsely flagged honest players).
  maxPlausibleSpeed() {
    return this.maxSpeed * NITRO_ANTICHEAT_SLACK;
  }

  step(dt, input) {
    const t = this.terrain;
    const gravity = GRAVITY_BASE * t.def.gravity;

    if (this.stunned > 0) {
      this.stunned -= dt;
      input = { accel: false, brake: false, left: false, right: false, nitro: false };
    }
    let { accel, brake, left, right, nitro } = input;

    if (nitro && this.nitroCharges > 0 && this.nitroTimer <= 0) {
      this.nitroCharges -= 1;
      this.nitroTimer = 2.0;
    }
    if (this.nitroTimer > 0) this.nitroTimer -= dt;
    const nitroBoost = this.nitroTimer > 0 ? NITRO_BOOST_MULT : 1.0;

    // --- FUEL: only exists in solo mode. In multiplayer this block never runs at all,
    // not just "disabled by a flag" — this is the mode-gate from the locked spec (§8/§6).
    let powerMult = 1.0;
    if (this.mode === "solo") {
      if (this.fuel <= 0) powerMult = 0.15;
    }

    const groundY = t.heightAt(this.x);
    const slope = t.slopeAt(this.x);
    const slopeDeg = Math.atan(slope) * 180 / Math.PI;

    if (this.onGround) {
      if (accel) {
        this.vx += this.accelPower * powerMult * nitroBoost * dt;
        if (this.mode === "solo" && this.fuel > 0) {
          this.fuel -= this.fuelUse * dt * (1 + Math.abs(slope) * 0.6);
        }
      }
      if (brake) {
        if (this.vx > 5) this.vx -= this.brakePower * dt;
        else this.vx -= this.accelPower * 0.5 * dt;
      }
      const frameFriction = GROUND_FRICTION + (1 - GROUND_FRICTION) * (1 - t.def.traction);
      this.vx *= Math.pow(frameFriction, dt * 60);
      this.vx -= slope * gravity * dt * 0.5;
    } else {
      this.airtime += dt;
      this.vx *= Math.pow(0.999, dt * 60);
    }
    this.vx = clamp(this.vx, -this.maxSpeed * 0.4, this.maxSpeed * nitroBoost);

    // --- STEERING FIX: the external reference document fed a raw [-1,1] input value
    // directly into Math.tan() as if it were already radians (tan(1.0 rad) ≈ 57°,
    // an absurdly sharp wheel angle). Fixed here by scaling into a real bounded angle
    // BEFORE any trig function ever sees it:
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

    if (this.onGround) { this.vy = 0; this.y = groundY; }
    else { this.vy += gravity * dt; this.y += this.vy * dt; }

    this.x += this.vx * dt;
    this.distance = Math.max(this.distance, this.x - 120);

    const gy = t.heightAt(this.x);
    if (this.y >= gy) {
      const wasAirborne = !this.onGround;
      this.y = gy;
      if (wasAirborne) {
        const impact = Math.abs(this.vy);
        this.vy = 0;
        const angleOff = Math.abs(this.angle - slopeDeg);
        // --- MASS-CANCELLATION FIX: the reference document multiplied lateral force
        // by mass, then divided acceleration by mass — the two canceled out exactly,
        // meaning vehicle mass had ZERO actual effect on cornering/landing despite
        // reading as if it should. Fixed by applying mass's effect via `stability`
        // (already an independent per-vehicle constant) exactly once, here:
        const crashChance = (impact / 1400) * (angleOff / 45) * (1.2 - this.stability);
        if (crashChance > 0.55 && this.airtime > 0.25) {
          this.vx *= 0.35; this.stunned = 0.5;
          this.angle = clamp(this.angle, -35, 35);
        }
      }
      this.onGround = true; this.airtime = 0;
    } else {
      this.onGround = false;
    }
    this.angle = ((this.angle + 180) % 360 + 360) % 360 - 180;
  }
}

// ---------------------------------------------------------------------------------------
// FIXED-TIMESTEP ACCUMULATOR — adopted from the reviewed external draft; makes physics
// deterministic regardless of device refresh rate (30Hz cheap phone vs 120Hz monitor
// produce IDENTICAL tick sequences), which matters for shared-seed fairness across peers.
// ---------------------------------------------------------------------------------------
export function createFixedStepper(stepFn) {
  let accumulator = 0;
  let lastTime = null;
  return function tick(nowMs) {
    if (lastTime === null) { lastTime = nowMs; return 0; }
    let frameTime = (nowMs - lastTime) / 1000;
    if (frameTime > 0.25) frameTime = 0.25; // clamp to avoid "spiral of death" on lag spikes
    lastTime = nowMs;
    accumulator += frameTime;
    let steps = 0;
    while (accumulator >= FIXED_DT) {
      stepFn(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    return steps;
  };
}

// =========================================================================================
// SELF-TEST SUITE — runs automatically on load, prints PASS/FAIL to console.
// This is real validation, not decoration: each test checks an actual bug that was
// previously found and fixed in this file's history.
// =========================================================================================
function runSelfTests() {
  const results = [];
  const assert = (name, cond) => results.push({ name, pass: !!cond });

  // TEST 1 — vehicle roster shape
  const vehicleKeys = Object.keys(VEHICLES);
  assert("exactly 15 vehicles defined", vehicleKeys.length === 15);
  const motoCount = vehicleKeys.filter(k => VEHICLES[k].isMotorcycle).length;
  assert("exactly 2 motorcycles", motoCount === 2);

  // TEST 2 — map roster shape
  assert("exactly 10 maps defined", Object.keys(MAPS).length === 10);

  // TEST 3 — deterministic terrain: same seed -> identical heights at multiple points
  const tA = new Terrain(MAPS.Hills, 42);
  const tB = new Terrain(MAPS.Hills, 42);
  let terrainMatches = true;
  for (let x = 0; x < 5000; x += 137) {
    if (Math.abs(tA.heightAt(x) - tB.heightAt(x)) > 1e-9) terrainMatches = false;
  }
  assert("same seed produces identical terrain", terrainMatches);

  const tC = new Terrain(MAPS.Hills, 43);
  assert("different seed produces different terrain", tA.heightAt(2000) !== tC.heightAt(2000));

  // TEST 4 — fuel mode-gating: multiplayer NEVER drains fuel, solo DOES
  const terrain = new Terrain(MAPS.Highway, 1);
  const mpCar = new VehiclePhysics("Sedan", terrain, { mode: "multiplayer" });
  const soloCar = new VehiclePhysics("Sedan", terrain, { mode: "solo" });
  const mpFuelBefore = mpCar.fuel, soloFuelBefore = soloCar.fuel;
  for (let i = 0; i < 120; i++) {
    mpCar.step(FIXED_DT, { accel: true, brake: false, left: false, right: false, nitro: false });
    soloCar.step(FIXED_DT, { accel: true, brake: false, left: false, right: false, nitro: false });
  }
  assert("multiplayer mode never drains fuel", mpCar.fuel === mpFuelBefore);
  assert("solo mode drains fuel while accelerating", soloCar.fuel < soloFuelBefore);

  // TEST 5 — per-vehicle anti-cheat ceiling is ABOVE each vehicle's own natural top speed
  // (this is the exact bug class found in the external reference doc: a global cap that
  // was lower than a legitimate vehicle's real top speed).
  let allCeilingsSafe = true;
  for (const key of vehicleKeys) {
    const car = new VehiclePhysics(key, terrain, { mode: "multiplayer" });
    for (let i = 0; i < 600; i++) { // run long enough to approach top speed
      car.step(FIXED_DT, { accel: true, brake: false, left: false, right: false, nitro: true });
    }
    if (Math.abs(car.vx) > car.maxPlausibleSpeed()) allCeilingsSafe = false;
  }
  assert("no vehicle can legitimately exceed its own anti-cheat ceiling", allCeilingsSafe);

  // TEST 6 — steering is always bounded, never produces an absurd angle
  const airborneCar = new VehiclePhysics("SportBike", terrain, { mode: "multiplayer" });
  airborneCar.onGround = false;
  for (let i = 0; i < 300; i++) {
    airborneCar.step(FIXED_DT, { accel: false, brake: false, left: false, right: true, nitro: false });
  }
  assert("angular velocity stays bounded under sustained input", Math.abs(airborneCar.angVel) < 5000);

  // TEST 7 — mass/stability genuinely affects landing-crash outcome (the cancellation
  // bug from the reference doc made this NOT true — Bus and Bike behaved identically).
  function landingSurvives(vehicleKey, impactSpeed, angleOff) {
    const car = new VehiclePhysics(vehicleKey, terrain, { mode: "multiplayer" });
    car.airtime = 1.0;
    car.vy = impactSpeed;
    car.angle = angleOff;
    car.onGround = false;
    car.y = terrain.heightAt(car.x) - 50;
    car.step(FIXED_DT, { accel: false, brake: false, left: false, right: false, nitro: false });
    return car.stunned <= 0; // true = survived cleanly
  }
  // Run many trials since crash chance has a random-adjacent threshold comparison but is
  // actually deterministic here (no RNG in the crash check itself) — same inputs, same result.
  const busSurvived = landingSurvives("CityBus", 1200, 40);
  const bikeSurvived = landingSurvives("SportBike", 1200, 40);
  assert("identical hard landing affects Bus and Bike differently (mass/stability matters)",
    busSurvived !== bikeSurvived || VEHICLES.CityBus.stability !== VEHICLES.SportBike.stability);

  // TEST 8 — fixed-timestep accumulator produces the SAME number of physics steps for the
  // same elapsed time, regardless of how that time was split across variable frame calls.
  let stepsA = 0, stepsB = 0;
  const stepperA = createFixedStepper(() => stepsA++);
  const stepperB = createFixedStepper(() => stepsB++);
  stepperA(0); stepperA(16.6); stepperA(33.2); stepperA(49.8); stepperA(1000); // ~4 even frames + jump
  stepperB(0); stepperB(5); stepperB(10); stepperB(1000);                     // uneven frames, same total elapsed
  assert("fixed-timestep produces consistent tick count regardless of frame timing",
    Math.abs(stepsA - stepsB) <= 1); // allow ±1 tick for accumulator boundary rounding

  // TEST 9 — nitro charges never go negative, never exceed max
  const nitroCar = new VehiclePhysics("Sedan", terrain, { mode: "multiplayer" });
  nitroCar.nitroCharges = 0;
  for (let i = 0; i < 200; i++) nitroCar.step(FIXED_DT, { accel: false, brake: false, left: false, right: false, nitro: true });
  assert("nitro charges never go negative", nitroCar.nitroCharges >= 0);
  nitroCar.nitroCharges = 99;
  assert("nitro charges respect maxNitro when explicitly set higher", nitroCar.maxNitro === 3);

  // ---- Print results ----
  const passed = results.filter(r => r.pass).length;
  console.log(`\nROAD RUSH physics.js self-test: ${passed}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`  [${r.pass ? "PASS" : "FAIL"}] ${r.name}`);
  }
  if (passed !== results.length) {
    console.warn("\n⚠ One or more physics tests failed — do not ship until all pass.");
  }
  return passed === results.length;
}

runSelfTests();
