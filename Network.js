"use strict";
/* ROAD RUSH — network.js: NetManager over PeerJS (never raw RTCPeerConnection —
   locked decision). Star topology, host holds up to 17 guests (18 total).
   Pipeline per guest message: SCHEMA → AUTH → RATE → STRUCTURAL/NaN →
   PER-VEHICLE PLAUSIBILITY (physics.js equilibrium-derived) → RULES → APPLY. */

/* Snapshot buffer + spec §5 Bug-4-corrected reconciliation (exact-seq match). */
class SnapshotBuffer {
  constructor() { this.frames = []; }
  push(seq, state) {
    if (this.frames.length && seq <= this.frames[this.frames.length - 1].seq) return;  // stale/dup drop
    this.frames.push({ seq, t: nowMs(), state });
    while (this.frames.length > 20) this.frames.shift();
  }
  latest() { return this.frames.length ? this.frames[this.frames.length - 1].state : null; }
}
function reconcileSnapshot(authoritativeState, lastProcessedSeq, pendingInputs) {
  const matchFrame = pendingInputs.find(f => f.sequence === lastProcessedSeq);  // EXACT match
  pendingInputs = pendingInputs.filter(f => f.sequence > lastProcessedSeq);
  if (!matchFrame) return { pendingInputs, error: 0, resimulate: false };
  const error = Math.hypot(authoritativeState.x - matchFrame.predicted.x, authoritativeState.y - matchFrame.predicted.y);
  return { pendingInputs, error, resimulate: error > 40 };
}

const PEER_OPTS = {
  debug: 0,
  config: {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
      { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
      { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
      { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
    ],
    iceCandidatePoolSize: 8,
  },
};

class NetManager {
  constructor() {
    this.peer = null; this.isHost = false; this.roomCode = null;
    this.mySid = null; this.myName = "Player"; this.hostPeerId = null;
    this.conns = new Map(); this.hostConn = null;
    this.players = new Map();
    this.selectedMap = "highway";
    this.roomCfg = null;
    this.password = ""; this.locked = false;
    this.raceRoster = []; this.finishList = []; this.lastStates = new Map();
    this._lastD = new Map(); this._lastDT = new Map(); this._lastV = new Map(); this._lastFuel = new Map();
    this.strikes = new Map(); this.audit = []; this._seq = new Map();
    this._chatL = new Map(); this._emoteL = new Map(); this._passN = new Map();
    this.muteTracker = new MuteTracker();
    this.voiceVotes = new VoiceReportVote();
    this._joinSettle = null; this._pingTimer = null; this._guestPing = null;
    this._destroyed = false; this._reconn = null; this._kicked = false;
    this._graceTimers = new Map(); this._takeoverTimers = new Map();
    this.rtt = 0; this.connState = "offline"; this.clockOffset = 0;
    this._seqSelf = 0;
    this.onPlayersChanged = null; this.onMapChanged = null; this.onRaceStart = null;
    this.onGo = null; this.onWorldUpdate = null; this.onLeaderboard = null;
    this.onError = null; this.onHostLeft = null; this.onReturnToLobby = null;
    this.onKicked = null; this.onChat = null; this.onEmote = null;
    this.onRoomCfg = null; this.onPositions = null; this.onPickup = null;
    this.onConnState = null; this.onMuted = null;
    this._onGuestFinish = null;
  }
  _setConnState(s) { if (this.connState !== s) { this.connState = s; if (this.onConnState) this.onConnState(s); } }
  maxPlayers() { return this.roomCfg ? this.roomCfg.maxPlayers : CONFIG.MAX_PLAYERS; }

  createRoom(name, pass, cfg) {
    return new Promise((resolve, reject) => {
      if (!window.Peer) { reject(new Error("no-peerjs")); return; }
      const v = validateName(name);
      if (!v.ok) { reject(new Error("badname:" + v.reason)); return; }
      this.myName = v.name;
      this.password = (pass || "").toString().slice(0, 24);
      this.roomCfg = Object.assign({ name: v.name + "'s Room", map: "highway", vehicleMode: "individual",
        vehicle: "sedan", maxPlayers: 5, duration: "moderate", adSec: 5 }, cfg || {});
      this.isHost = true; this.mySid = randomHex(12);
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
      this.players.set(this.mySid, { sid: this.mySid, peerId: id, name: this.myName,
        vehicle: save.vehicle, isHost: true, ping: 0, deviceId: getDeviceId(), ready: true });
      this._setConnState("connected");
      this._startPingLoop();
      resolve(code);
    });
    this.peer.on("connection", (conn) => this._handleIncoming(conn));
    this.peer.on("call", (call) => { if (this.voice) this.voice.handleIncoming(call); });
    this.peer.on("disconnected", () => {
      if (this._destroyed) return;
      try { this.peer.reconnect(); } catch (e) {}
      this._setConnState("reconnecting");
      if (this.onError) this.onError("Reconnecting to the signaling service…");
    });
  }
  _startPingLoop() {
    this._stopPingLoop();
    this._pingTimer = setInterval(() => {
      if (this._destroyed || !this.isHost) return;
      for (const { conn, sid } of this.conns.values()) {
        const p = this.players.get(sid);
        if (conn.open && p && p.disconnectedAt == null) {
          try { conn.send({ t: "ping", ts: nowMs() }); } catch (e) {}
        }
      }
    }, 3000);
  }
  _stopPingLoop() { if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; } }
  _handleIncoming(conn) {
    conn.on("open", () => { conn.on("data", (data) => this._handleGuestMessage(conn, data)); });
    conn.on("close", () => this._peerDropped(conn));
    conn.on("error", () => this._peerDropped(conn));
  }
  /* Disconnect machine: CONNECTED → RECONNECTING (0-3s) → OFFLINE (3-15s) → CPU takeover */
  _peerDropped(conn) {
    const entry = this.conns.get(conn.peer);
    if (!entry) return;
    this.conns.delete(conn.peer);
    const p = this.players.get(entry.sid);
    if (!p || p.disconnectedAt != null) return;
    p.disconnectedAt = nowMs(); p.ping = null;
    this._emitPlayers();
    this._sys(p.name + " disconnected — reconnecting…");
    const sid = entry.sid;
    const t1 = setTimeout(() => {
      const pl = this.players.get(sid);
      if (pl && pl.disconnectedAt != null) this._sys(pl.name + " offline…");
    }, CONFIG.RECONNECTING_MS);
    const t2 = setTimeout(() => {
      this._graceTimers.delete(sid);
      const pl = this.players.get(sid);
      if (!pl || pl.disconnectedAt == null) return;
      if (typeof Game !== "undefined" && Game.state === "racing" && this.raceRoster.includes(sid) && Game.terrain) {
        pl.isBot = true;
        if (!/🤖/.test(pl.name)) pl.name += " 🤖";
        const st = this.lastStates.get(sid) || { x: START_X, d: 0 };
        const b = new VehiclePhysics(pl.vehicle, Game.terrain, { id: sid, sid, name: pl.name, isBot: true, fuelEnabled: false });
        b.x = st.x || START_X; b.distance = st.d || 0;
        Game.bots.push(b);
        this.broadcast({ t: "players", list: this._playerListArr() });
        this._sys(pl.name + " — CPU took over.");
      } else this._removePlayer(sid, "left after grace");
    }, CONFIG.TAKEOVER_MS);
    this._graceTimers.set(sid, t1);
    this._takeoverTimers.set(sid, t2);
  }
  _removePlayer(sid, why) {
    const p = this.players.get(sid);
    [this._graceTimers, this._takeoverTimers].forEach(m => {
      const to = m.get(sid); if (to) { clearTimeout(to); m.delete(sid); }
    });
    for (const [pid, e] of this.conns) if (e.sid === sid) { try { e.conn.close(); } catch (x) {} this.conns.delete(pid); }
    this.players.delete(sid); this.lastStates.delete(sid);
    this._lastD.delete(sid); this._lastDT.delete(sid); this._lastV.delete(sid); this._lastFuel.delete(sid);
    this._seq.delete(sid); this.strikes.delete(sid);
    this._emitPlayers();
    this.broadcast({ t: "players", list: this._playerListArr() });
    if (p) this._sys(p.name + " left the room" + (why ? " (" + why + ")" : "") + ".");
  }
  _sys(text) { this.broadcast({ t: "sys", text }); if (this.onChat) this.onChat({ sys: true, text }); }

  _handleGuestMessage(conn, data) {
    if (!data || typeof data !== "object" || typeof data.t !== "string" || data.t.length > 8) {
      this._roadguard(this._sidOf(conn), "SCHEMA", 2, "malformed envelope"); return;
    }
    switch (data.t) {
      case "hello": {
        const deny = (reason) => {
          try { conn.send({ t: "denied", reason }); setTimeout(() => { try { conn.close(); } catch (e) {} }, 300); } catch (e) {}
        };
        if (this.locked) { deny("locked"); return; }
        const token = (typeof data.token === "string") ? data.token.slice(0, 16) : null;
        if (token && this.players.has(token)) {
          const p = this.players.get(token);
          for (const e of this.conns.values()) {
            if (e.sid === token && e.conn !== conn && e.conn.open) { deny("dupsession"); return; }
          }
          for (const [pid, e] of this.conns) if (e.sid === token) this.conns.delete(pid);
          this.conns.set(conn.peer, { conn, sid: token });
          p.peerId = conn.peer; p.disconnectedAt = null;
          if (p.isBot && Game && Game.bots) {   // reclaim a CPU-taken-over seat
            Game.bots = Game.bots.filter(b => b.sid !== token);
            p.isBot = false;
            p.name = p.name.replace(" 🤖", "");
          }
          [this._graceTimers, this._takeoverTimers].forEach(m => {
            const to = m.get(token); if (to) { clearTimeout(to); m.delete(token); }
          });
          conn.send({ t: "welcome", map: this.selectedMap, players: this._playerListArr(),
            locked: this.locked, hasPass: !!this.password, cfg: this.roomCfg });
          this.broadcast({ t: "players", list: this._playerListArr() });
          this._emitPlayers();
          this._sys(p.name + " reconnected.");
          return;
        }
        if (this.password) {
          let n = this._passN.get(conn.peer) || 0;
          if (n >= CONFIG.PASS_ATTEMPTS) { deny("toomany"); return; }
          this._passN.set(conn.peer, n + 1);
          if (data.pass !== this.password) { deny("password"); return; }
        }
        if (this.players.size >= this.maxPlayers()) { deny("full"); return; }
        const v = validateName(data.name);
        if (!v.ok) { deny("badname"); return; }
        for (const p of this.players.values()) {
          if (p.name.toLowerCase() === v.name.toLowerCase()) { deny("name"); return; }
        }
        const sid = token || randomHex(12);
        const deviceId = (typeof data.deviceId === "string") ? data.deviceId.slice(0, 32) : randomHex(16);
        if (this.muteTracker.isMuted(deviceId)) { deny("muted:" + this.muteTracker.muteRemaining(deviceId)); return; }
        this.conns.set(conn.peer, { conn, sid });
        this.players.set(sid, { sid, peerId: conn.peer, name: v.name,
          vehicle: VEHICLES[data.vehicle] ? data.vehicle : "sedan",
          isHost: false, ping: null, disconnectedAt: null, deviceId, ready: false, voice: false });
        this._emitPlayers();
        conn.send({ t: "welcome", map: this.selectedMap, players: this._playerListArr(),
          locked: this.locked, hasPass: !!this.password, cfg: this.roomCfg, yourSid: sid });
        this.broadcast({ t: "players", list: this._playerListArr() }, conn.peer);
        this._sys(v.name + " joined the room.");
        break;
      }
      case "ready": {
        const sid = this._sidOf(conn); const p = sid && this.players.get(sid);
        if (p) { p.ready = !!data.v; this._emitPlayers(); this.broadcast({ t: "players", list: this._playerListArr() }); }
        break;
      }
      case "vehicle": {
        const sid = this._sidOf(conn); const p = sid && this.players.get(sid);
        if (this.roomCfg && this.roomCfg.vehicleMode === "locked") return;
        if (p && VEHICLES[data.vehicle]) {
          p.vehicle = data.vehicle;
          this._emitPlayers(); this.broadcast({ t: "players", list: this._playerListArr() });
        }
        break;
      }
      case "state": {
        const sid = this._sidOf(conn);
        if (!sid) { this._roadguard(null, "AUTH", 3, "state without binding"); return; }
        const s = data.s;
        if (!s || typeof s !== "object" || typeof s.d !== "number" || !isFinite(s.d) ||
            typeof s.x !== "number" || !isFinite(s.x) || typeof s.f !== "boolean") {
          this._roadguard(sid, "STATE-SCHEMA", 2, "bad state fields"); return;
        }
        const seqOk = typeof data.q === "number" && isFinite(data.q);
        const lastSeq = this._seq.get(sid);
        if (seqOk) {
          if (lastSeq != null && data.q <= lastSeq) { this._roadguard(sid, "SEQ", 1, "stale/duplicate seq"); return; }
          this._seq.set(sid, data.q);
        }
        const p = this.players.get(sid);
        const vd = (p && VEHICLES[p.vehicle]) || VEHICLES.sedan;
        const tNow = nowMs();
        const prevD = this._lastD.has(sid) ? this._lastD.get(sid) : s.d;
        const prevT = this._lastDT.has(sid) ? this._lastDT.get(sid) : tNow;
        const dtSec = Math.max(0.016, (tNow - prevT) / 1000);
        const delta = s.d - prevD;
        if (!deltaOk(vd.plausible, dtSec, delta)) {   // per-vehicle equilibrium-derived cap
          this._roadguard(sid, "SPEED", 2, delta + " units in " + dtSec.toFixed(2) + "s"); return;
        }
        const vNew = (s.vx != null && isFinite(s.vx)) ? s.vx : null;
        const vOld = this._lastV.get(sid);
        if (vNew != null && vOld != null && Math.abs(vNew - vOld) > (vd.accel * 1.7) * (dtSec + 0.15) + 120) {
          this._roadguard(sid, "ACCEL", 2, vOld + "→" + vNew); return;
        }
        if (vNew != null) this._lastV.set(sid, vNew);
        if (Math.abs(s.x - (START_X + s.d)) > 600) { this._roadguard(sid, "TELEPORT", 2, "x=" + s.x + " d=" + s.d); return; }
        if (delta < -800) { this._roadguard(sid, "DIST-REVERSE", 1, String(delta)); return; }
        if (s.fuel != null && isFinite(s.fuel)) {
          const prev = this._lastFuel.get(sid);
          if (prev != null && s.fuel > prev + 0.01) { this._roadguard(sid, "FUEL-INJECT", 2, prev + "→" + s.fuel); return; }
          this._lastFuel.set(sid, s.fuel);
        }
        this._lastD.set(sid, s.d); this._lastDT.set(sid, tNow);
        this.lastStates.set(sid, s);
        if (p) p.lastStateT = tNow;
        if (this.onWorldUpdate) this.onWorldUpdate(sid, s);
        this.broadcast({ t: "peerstate", id: sid, s: data.s }, conn.peer);
        break;
      }
      case "finish": {
        const sid = this._sidOf(conn);
        if (!sid || !this._onGuestFinish) return;
        if (!netFinishSchemaOk(data)) { this._roadguard(sid, "FINISH-SCHEMA", 2, "bad fields"); return; }
        if (this.finishList.some(f => f.id === sid)) { this._roadguard(sid, "FINISH-DUP", 2, "already finished"); return; }
        const st = this.lastStates.get(sid) || {};
        const pl = this.players.get(sid);
        const staleMs = pl && pl.lastStateT ? nowMs() - pl.lastStateT : 99999;
        if (staleMs > 1500 && Game.state === "racing") { this._roadguard(sid, "STALE-FINISH", 2, staleMs + "ms silent"); return; }
        const tol = 2 + Math.min(1, ((pl && pl.ping) || 0) / 400);
        if (data.time < 5 || data.time > Game.raceTime + tol) { this._roadguard(sid, "FINISH-TIME", 2, "t=" + data.time); return; }
        if ((st.d != null ? st.d : 0) < Game.mapLen - 400) { this._roadguard(sid, "FINISH-SHORT", 2, "d=" + st.d); return; }
        this._onGuestFinish(sid, data);
        break;
      }
      case "pkc": {
        const sid = this._sidOf(conn);
        if (typeof data.id !== "number" || !isFinite(data.id)) { this._roadguard(sid, "PK-SCHEMA", 2, "bad id"); return; }
        const pk = Game.world && (Game.world.pkMap ? Game.world.pkMap.get(data.id) : Game.world.pickups[data.id]);
        if (!sid || !pk || pk.taken || Game.state !== "racing") return;
        const st = this.lastStates.get(sid) || {};
        if (Math.abs((st.x != null ? st.x : 0) - pk.x) > 220) { this._roadguard(sid, "PK-FAKE", 2, "far claim"); return; }
        pk.taken = true;
        this.broadcast({ t: "pk", id: data.id, by: sid });
        break;
      }
      case "chat": {
        const sid = this._sidOf(conn);
        const p = sid && this.players.get(sid);
        if (!p) return;
        if (p.mutedUntil && p.mutedUntil > Date.now()) return;
        const f = filterMessage(String(data.text || ""));
        if (!f.text.trim()) return;
        if (f.blocked) {
          if (this.muteTracker.strike(p.deviceId)) {
            p.mutedUntil = Date.now() + CONFIG.MUTE_MS;
            this._sys(p.name + " muted for 30 minutes (abuse filter).");
            this.broadcast({ t: "muted", sid, until: p.mutedUntil });
            this.broadcast({ t: "players", list: this._playerListArr() });
          } else { try { conn.send({ t: "rgwarn", rule: "LANGUAGE" }); } catch (e) {} }
          return;
        }
        let lim = this._chatL.get(sid);
        if (!lim) { lim = new RateLimiter(CONFIG.CHAT_COOLDOWN_MS); this._chatL.set(sid, lim); }
        if (!lim.allow()) return;
        if (p._lastMsg === f.text && nowMs() - (p._lastMsgT || 0) < 3000) return;
        p._lastMsg = f.text; p._lastMsgT = nowMs();
        this.broadcast({ t: "chat", sid, name: p.name, text: f.text, ts: Date.now() });
        if (this.onChat) this.onChat({ name: p.name, text: f.text, ts: Date.now() });
        break;
      }
      case "emote": {   // RACE EMOJI — validated against the 10-emoji set, 1 per 10 s host-side
        const sid = this._sidOf(conn);
        const p = sid && this.players.get(sid);
        if (!p || !EMOJI_RACE.includes(data.code)) return;
        let lim = this._emoteL.get(sid);
        if (!lim) { lim = new RateLimiter(CONFIG.EMOTE_COOLDOWN_MS); this._emoteL.set(sid, lim); }
        if (!lim.allow()) return;
        this.broadcast({ t: "emote", sid, name: p.name, code: data.code });
        if (this.onEmote) this.onEmote({ sid, name: p.name, code: data.code });
        break;
      }
      case "votemute": {
        const sid = this._sidOf(conn);
        const target = data.target;
        if (!sid || !target || target === sid || !this.players.has(target)) return;
        this.voiceVotes.report(target, sid);
        const humans = Array.from(this.players.values())
          .filter(x => !x.isHost && !x.isBot && x.disconnectedAt == null).length;
        if (this.voiceVotes.decided(target, humans)) {
          const tp = this.players.get(target);
          if (tp) {
            tp.mutedUntil = Date.now() + CONFIG.MUTE_MS;
            this.muteTracker.muted[tp.deviceId] = tp.mutedUntil;
            this.muteTracker._save();
            this.broadcast({ t: "muted", sid: target, until: tp.mutedUntil });
            this._sys(tp.name + " muted for 30 minutes (room vote).");
            this.broadcast({ t: "players", list: this._playerListArr() });
          }
          this.voiceVotes.clear(target);
        }
        break;
      }
      case "ping": { if (typeof data.ts === "number") { try { conn.send({ t: "pong", ts: data.ts }); } catch (e) {} } break; }
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
  sendVoteMute(targetSid) {
    if (this.isHost) this._handleGuestMessage({ peer: "self", open: true, send() {} }, { t: "votemute", target: targetSid });
    else if (this.hostConn && this.hostConn.open) { try { this.hostConn.send({ t: "votemute", target: targetSid }); } catch (e) {} }
  }
  setMyVoice(v) {
    const me = this.players.get(this.mySid);
    if (me) me.voice = !!v;
    this.broadcast({ t: "players", list: this._playerListArr() });
  }
  _sidOf(conn) { const e = this.conns.get(conn.peer); return e ? e.sid : null; }
  _roadguard(sid, ruleId, severity, detail) {
    const p = sid ? this.players.get(sid) : null;
    this.audit.push({ ts: Date.now(), sid, rule: ruleId,
      sev: ["LOG","WARN","VIOLATION","CRITICAL"][severity] || "LOG",
      detail: detail || "", raceT: (typeof Game !== "undefined" && Game.state === "racing") ? +Game.raceTime.toFixed(1) : null });
    if (this.audit.length > 200) this.audit.shift();
    if (severity === 0) return;
    const n = severity === 2 ? 2 : 1;
    let s = this.strikes.get(sid) || { n: 0, lastT: 0 };
    const t = nowMs();
    if (t - s.lastT > 10000) s.n = 0;
    s.n += n; s.lastT = t;
    this.strikes.set(sid, s);
    const e = sid && Array.from(this.conns.values()).find(x => x.sid === sid);
    if (severity === 3 || s.n >= CONFIG.STRIKES_KICK) {
      this._sys("RoadGuard: removed " + (p ? p.name : sid) + " (" + ruleId + ").");
      if (e) { try { e.conn.send({ t: "kicked", reason: "suspicious activity (" + ruleId + ")" }); } catch (x) {} }
      this._removePlayer(sid, "RoadGuard:" + ruleId);
    } else if (severity === 1 && e) { try { e.conn.send({ t: "rgwarn", rule: ruleId }); } catch (x) {} }
  }
  _handleHostMessage(data) {
    if (!data || !data.t) return;
    switch (data.t) {
      case "welcome":
        this.selectedMap = MAPS[data.map] ? data.map : "highway";
        this.roomCfg = data.cfg || this.roomCfg;
        this.players = new Map(data.players.map(p => [p.sid, p]));
        this.locked = !!data.locked; this.hasPass = !!data.hasPass;
        if (data.yourSid && !this.mySid) this.mySid = data.yourSid;
        if (this._joinSettle) { this._joinSettle.ok(); this._joinSettle = null; }
        this._setConnState("connected");
        if (this.onPlayersChanged) this.onPlayersChanged(data.players);
        if (this.onMapChanged) this.onMapChanged(data.map);
        if (this.onRoomCfg) this.onRoomCfg(this.locked, this.hasPass);
        break;
      case "players": this.players = new Map(data.list.map(p => [p.sid, p])); if (this.onPlayersChanged) this.onPlayersChanged(data.list); break;
      case "map": if (MAPS[data.map]) this.selectedMap = data.map; if (this.onMapChanged) this.onMapChanged(data.map); break;
      case "roomcfg": this.locked = !!data.locked; this.hasPass = !!data.hasPass; if (this.onRoomCfg) this.onRoomCfg(this.locked, this.hasPass); break;
      case "start": this._stopReconnect(); if (this.onRaceStart) this.onRaceStart(data.seed, data.map); break;
      case "go": this._setConnState("connected"); this.clockOffset = nowMs() - data.hostT; if (this.onGo) this.onGo(data.hostT); break;
      case "peerstate": if (this.onWorldUpdate) this.onWorldUpdate(data.id, data.s); break;
      case "pos": if (this.onPositions) this.onPositions(data.list); break;
      case "pk": if (this.onPickup) this.onPickup(data.id, data.by); break;
      case "chat": if (this.onChat) this.onChat({ name: data.name, text: data.text, ts: data.ts }); break;
      case "sys": if (this.onChat) this.onChat({ sys: true, text: data.text }); break;
      case "emote": if (this.onEmote) this.onEmote({ sid: data.sid, name: data.name, code: data.code }); break;
      case "leaderboard": if (this.onLeaderboard) this.onLeaderboard(data.list); break;
      case "lobby": if (this.onReturnToLobby) this.onReturnToLobby(); break;
      case "muted": if (this.onMuted) this.onMuted(data.sid, data.until); break;
      case "ping": if (this.hostConn && this.hostConn.open) { try { this.hostConn.send({ t: "pong", ts: data.ts }); } catch (e) {} } break;
      case "pong":
        if (typeof data.ts === "number") {
          this.rtt = Math.max(1, Math.round(nowMs() - data.ts));
          this.clockOffset = nowMs() - data.ts - this.rtt / 2;   // NTP-offset (single-sided)
        }
        break;
      case "denied": if (this._joinSettle) { this._joinSettle.err(data.reason || "denied"); this._joinSettle = null; } break;
      case "kicked": this._kicked = true; if (this.onKicked) this.onKicked(data.reason || "removed by host"); break;
      case "xfer": if (this.onHostTransfer) this.onHostTransfer(data.to, data.toPeerId); break;
      case "rgwarn": if (this.onError) this.onError("RoadGuard warning: " + data.rule); break;
    }
  }
  _playerListArr() { return Array.from(this.players.values()); }
  _emitPlayers() { if (this.onPlayersChanged) this.onPlayersChanged(this._playerListArr()); }
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
  transferHost(sid) {
    if (!this.isHost) return;
    const p = this.players.get(sid);
    if (!p || p.isHost || !p.peerId) return;
    this.broadcast({ t: "xfer", to: sid, toPeerId: p.peerId });
    setTimeout(() => { try { this.destroy(); } catch (e) {} }, 800);
  }
  setMap(mapName) { if (!MAPS[mapName]) return; this.selectedMap = mapName; if (this.isHost) this.broadcast({ t: "map", map: mapName }); }
  setMyVehicle(vehicle) {
    if (!VEHICLES[vehicle]) return;
    const me = this.players.get(this.mySid);
    if (me) me.vehicle = vehicle;
    if (this.isHost) { this._emitPlayers(); this.broadcast({ t: "players", list: this._playerListArr() }); }
    else if (this.hostConn && this.hostConn.open) this.hostConn.send({ t: "vehicle", vehicle });
  }
  setReady(v) {
    const me = this.players.get(this.mySid);
    if (me) me.ready = !!v;
    if (this.isHost) this.broadcast({ t: "players", list: this._playerListArr() });
    else if (this.hostConn && this.hostConn.open) { try { this.hostConn.send({ t: "ready", v: !!v }); } catch (e) {} }
  }
  /* Bot backfill: bots run ONLY on host (never per-client); labeled 🤖. */
  backfill() {
    if (!this.isHost) return;
    const humans = this.raceRoster.filter(sid => { const p = this.players.get(sid); return p && !p.isBot; }).length;
    const botNames = ["Rex 🤖","Mia 🤖","Zig 🤖","Ava 🤖","Kai 🤖","Nia 🤖","Leo 🤖","Zoe 🤖","Max 🤖","Ida 🤖","Ola 🤖","Raj 🤖","Mit 🤖","Sam 🤖","Ana 🤖","Pia 🤖","Taj 🤖"];
    for (let i = humans; i < this.maxPlayers(); i++) {
      const sid = "bot" + i;
      if (this.players.has(sid)) continue;
      this.players.set(sid, { sid, peerId: null, name: botNames[i % botNames.length],
        vehicle: VEHICLE_ORDER[(i * 3) % VEHICLE_ORDER.length], isBot: true, ping: null, disconnectedAt: null, ready: true });
      this.raceRoster.push(sid);
    }
    this.broadcast({ t: "players", list: this._playerListArr() });
  }
  startRace() {
    if (!this.isHost) return;
    const seed = Math.floor(Math.random() * 999999) + 1;
    this.raceRoster = this._playerListArr().filter(p => p.disconnectedAt == null).map(p => p.sid);
    this.finishList = [];
    this.lastStates.clear(); this._lastD.clear(); this._lastDT.clear(); this._lastV.clear(); this._lastFuel.clear();
    this._chatL.clear(); this._emoteL.clear(); this._seq.clear();          // per-race limiter reset
    this.locked = true;
    this.backfill();
    this.broadcast({ t: "start", seed, map: this.selectedMap });
    if (this.onRaceStart) this.onRaceStart(seed, this.selectedMap);
    setTimeout(() => {
      if (this._destroyed) return;
      const hostT = nowMs();
      this.broadcast({ t: "go", hostT });
      if (this.onGo) this.onGo(hostT);
    }, 3000);
  }
  broadcastPositions() {
    if (!this.isHost || this._destroyed) return;
    const entries = [];
    for (const sid of this.raceRoster) {
      if (!this.players.has(sid)) continue;
      const p = this.players.get(sid);
      const f = this.finishList.find(x => x.id === sid);
      if (f) entries.push({ id: sid, d: f.distance, f: 1, t: f.time, n: p.name });
      else {
        const st = (sid === this.mySid && Game.local) ? { d: Math.round(Game.local.distance) } : (this.lastStates.get(sid) || { d: 0 });
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
    else if (this.hostConn && this.hostConn.open) { try { this.hostConn.send(Object.assign({ t: "finish" }, payload)); } catch (e) {} }
  }
  claimPickup(id) { if (this.hostConn && this.hostConn.open) { try { this.hostConn.send({ t: "pkc", id }); } catch (e) {} } }
  sendChat(text) {
    if (this.isHost) {
      const f = filterMessage(String(text || ""));
      if (!f.text.trim() || f.blocked) return;
      let lim = this._chatL.get(this.mySid);
      if (!lim) { lim = new RateLimiter(CONFIG.CHAT_COOLDOWN_MS); this._chatL.set(this.mySid, lim); }
      if (!lim.allow()) return;
      this.broadcast({ t: "chat", sid: this.mySid, name: this.myName, text: f.text, ts: Date.now() });
      if (this.onChat) this.onChat({ name: this.myName, text: f.text, ts: Date.now() });
    } else if (this.hostConn && this.hostConn.open) { try { this.hostConn.send({ t: "chat", text }); } catch (e) {} }
  }
  sendEmote(emoji) {
    if (!EMOJI_RACE.includes(emoji)) return;
    if (this.isHost) {
      let lim = this._emoteL.get(this.mySid);
      if (!lim) { lim = new RateLimiter(CONFIG.EMOTE_COOLDOWN_MS); this._emoteL.set(this.mySid, lim); }
      if (!lim.allow()) return;
      this.broadcast({ t: "emote", sid: this.mySid, name: this.myName, code: emoji });
      if (this.onEmote) this.onEmote({ sid: this.mySid, name: this.myName, code: emoji });
    } else if (this.hostConn && this.hostConn.open) { try { this.hostConn.send({ t: "emote", code: emoji }); } catch (e) {} }
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
      this.peer.on("call", (call) => { if (this.voice) this.voice.handleIncoming(call); });
      this.peer.on("disconnected", () => { if (!settle.done && !this._destroyed) { try { this.peer.reconnect(); } catch (e) {} } });
      this.peer.on("open", () => {
        this.hostPeerId = target;
        const sid = sidFor(code.trim().toUpperCase());
        const conn = this.peer.connect(target, { reliable: true });
        this.hostConn = conn;
        conn.on("open", () => {
          this.mySid = sid;
          conn.send({ t: "hello", name: this.myName, vehicle: save.vehicle, token: sid,
            pass: this._joinPass, deviceId: getDeviceId() });
          this._startGuestPing();
        });
        conn.on("data", (data) => this._handleHostMessage(data));
        conn.on("close", () => { if (!settle.done) settle.err("closed"); else this._onHostConnLost(); });
      });
    });
  }
  _startGuestPing() {
    this._stopGuestPing();
    this._guestPing = setInterval(() => {
      if (this._destroyed || !this.hostConn || !this.hostConn.open) return;
      try { this.hostConn.send({ t: "ping", ts: nowMs() }); } catch (e) {}
    }, 2000);
  }
  _stopGuestPing() { if (this._guestPing) { clearInterval(this._guestPing); this._guestPing = null; } }
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
    if (this._reconn.attempts >= 7) {
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
        conn.send({ t: "hello", name: this.myName, vehicle: save.vehicle, token: this.mySid, pass: "", deviceId: getDeviceId() });
        this._startGuestPing();
        conn.on("data", (data) => this._handleHostMessage(data));
        conn.on("close", () => this._onHostConnLost());
      });
      setTimeout(() => { if (!conn.open) { try { conn.close(); } catch (e) {} } }, 1800);
    } catch (e) {}
  }
  _stopReconnect() { if (this._reconn) { clearInterval(this._reconn.timer); this._reconn = null; } }
  destroy() {
    this._destroyed = true;
    this._stopPingLoop(); this._stopGuestPing(); this._stopReconnect();
    [this._graceTimers, this._takeoverTimers].forEach(m => { for (const to of m.values()) clearTimeout(to); m.clear(); });
    try { if (this.hostConn) this.hostConn.close(); } catch (e) {}
    for (const e of this.conns.values()) { try { e.conn.close(); } catch (x) {} }
    try { if (this.peer) this.peer.destroy(); } catch (e) {}
    this.peer = null; this.hostConn = null;
    this.conns.clear(); this.players.clear(); this.lastStates.clear();
    this._lastD.clear(); this._lastDT.clear(); this._lastV.clear(); this._lastFuel.clear();
    this._seq.clear(); this.strikes.clear(); this.audit = [];
    this.raceRoster = []; this.finishList = [];
    this.isHost = false; this.roomCode = null; this._joinSettle = null;
    this._setConnState("offline");
  }
}
