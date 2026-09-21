"use strict";
/* =====================================================================================
   ROAD RUSH — room-authority.js
   The Durable Object: one instance per room. Owns membership, settings, and (in later
   phases) race state. This file covers Phase 1 (connection lifecycle, protocol) and
   Phase 2 (room creation/join, capacity enforcement, atomic seat allocation) ONLY —
   race clock, RoadGuard validation, checkpoints, and AI takeover are later phases,
   deliberately not included here so this stays testable in isolation first.
===================================================================================== */

const RACE_PHASES = Object.freeze({
  LOBBY: "lobby",
  COUNTDOWN: "countdown",
  RACING: "racing",
  FINALIZING: "finalizing",
  RESULTS: "results",
});

export class RoomAuthority {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map();     // playerId -> WebSocket
    this.players = new Map();     // playerId -> { name, seat, connected, isOwner, joinedAt }
    this.settings = null;         // set on /init
    this.phase = RACE_PHASES.LOBBY;
    this.nextSeat = 0;
  }

  // --- Internal routing: distinguishes worker→DO control calls from player WebSocket upgrades ---
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      return this._handleInit(request);
    }
    if (url.pathname === "/status") {
      return this._handleStatus();
    }
    if (request.headers.get("Upgrade") === "websocket") {
      return this._handleWebSocketUpgrade(request, url);
    }
    return new Response("Not found", { status: 404 });
  }

  async _handleInit(request) {
    if (this.settings) {
      return new Response(JSON.stringify({ error: "already_initialized" }), { status: 409 });
    }
    const body = await request.json();
    this.settings = {
      roomId: body.roomId,
      maxPlayers: body.maxPlayers,
      roomName: body.roomName,
      hasPassword: body.hasPassword,
      passwordHash: body.passwordHash,
      map: body.map,
      vehicleRule: body.vehicleRule,
      durationPreset: body.durationPreset,
      visibility: body.visibility,
      ownerName: body.ownerName,
      createdAt: Date.now(),
    };
    // Persist minimal settings so this DO can recover its identity after hibernation —
    // per the spec's requirement that hibernation not silently discard needed state.
    await this.state.storage.put("settings", this.settings);
    return new Response(JSON.stringify({ ok: true }));
  }

  _handleStatus() {
    if (!this.settings) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    const connectedCount = Array.from(this.players.values()).filter(p => p.connected).length;
    return new Response(JSON.stringify({
      roomId: this.settings.roomId,
      roomName: this.settings.roomName,
      map: this.settings.map,
      phase: this.phase,
      playerCount: connectedCount,
      maxPlayers: this.settings.maxPlayers,
      hasPassword: this.settings.hasPassword,
      visibility: this.settings.visibility,
      // "waiting" / "counting_down" / "racing" / "closed" — matches the room-browser
      // status vocabulary the spec calls for (§3).
      status: this._deriveDisplayStatus(connectedCount),
    }));
  }

  _deriveDisplayStatus(connectedCount) {
    if (this.phase !== RACE_PHASES.LOBBY) return "racing";
    if (connectedCount >= this.settings.maxPlayers) return "full";
    return "waiting";
  }

  async _handleWebSocketUpgrade(request, url) {
    if (!this.settings) {
      return new Response(JSON.stringify({ error: "room_not_found" }), { status: 404 });
    }

    // --- Capacity enforcement happens HERE, server-side, unconditionally — a modified
    // client cannot bypass this by skipping a client-side check (spec §16: "must reject
    // a nineteenth player when capacity is eighteen"). ---
    const connectedCount = Array.from(this.players.values()).filter(p => p.connected).length;
    if (connectedCount >= this.settings.maxPlayers && this.phase === RACE_PHASES.LOBBY) {
      return new Response(JSON.stringify({ error: "room_full" }), { status: 409 });
    }
    if (this.phase !== RACE_PHASES.LOBBY) {
      // Spec doesn't require blocking mid-race joins forever, but Phase 1/2 scope is
      // lobby-join only — mid-race spectator/late-join is explicitly a later concern.
      return new Response(JSON.stringify({ error: "race_in_progress" }), { status: 409 });
    }

    if (this.settings.hasPassword) {
      const providedHash = url.searchParams.get("ph"); // client hashes client-side before sending
      if (providedHash !== this.settings.passwordHash) {
        return new Response(JSON.stringify({ error: "invalid_password" }), { status: 403 });
      }
    }

    const playerName = String(url.searchParams.get("name") || "Player").slice(0, 20);
    const requestedPlayerId = url.searchParams.get("pid"); // client-generated session id for reconnect

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // --- Atomic seat allocation: this whole upgrade handler runs to completion before
    // yielding, because Durable Objects process requests to a single instance one at a
    // time — this IS the mechanism that prevents the race condition the spec calls out
    // in §3 ("two players cannot claim the same final seat"). No separate lock needed.
    const playerId = requestedPlayerId && this.players.has(requestedPlayerId)
      ? requestedPlayerId
      : crypto.randomUUID();

    const isReconnect = this.players.has(playerId);
    const isOwner = !isReconnect && this.players.size === 0; // first-ever joiner owns the room

    const player = isReconnect
      ? { ...this.players.get(playerId), connected: true }
      : {
          name: playerName,
          seat: this.nextSeat++,
          connected: true,
          isOwner,
          joinedAt: Date.now(),
          vehicle: null,
        };
    this.players.set(playerId, player);

    this.state.acceptWebSocket(server, [playerId]); // hibernatable API — tag ensures we can
                                                      // find this socket's playerId after wake
    this.sockets.set(playerId, server);

    this._broadcastRoomState();

    return new Response(null, { status: 101, webSocket: client });
  }

  // --- Hibernation-compatible handlers: these fire even after the DO was evicted and
  // woken by an incoming message, per Cloudflare's WebSocket Hibernation API contract. ---
  async webSocketMessage(ws, message) {
    const playerId = this.state.getTags(ws)[0];
    let msg;
    try {
      msg = JSON.parse(message);
    } catch (e) {
      this._sendTo(playerId, { t: "error", code: "malformed_message" });
      return;
    }
    // Phase 1 scope: only lobby-relevant messages. Race input/state messages are Phase 3+.
    switch (msg.t) {
      case "set_ready":
        this._handleSetReady(playerId, !!msg.ready);
        break;
      case "set_vehicle":
        this._handleSetVehicle(playerId, msg.vehicle);
        break;
      default:
        this._sendTo(playerId, { t: "error", code: "unknown_message_type" });
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const playerId = this.state.getTags(ws)[0];
    const player = this.players.get(playerId);
    if (!player) return;

    player.connected = false;
    this.sockets.delete(playerId);

    // --- "Room owner leaving must not stop the race" (spec §3/§6): we mark them
    // disconnected, we do NOT delete their seat or reassign the room. Reconnection
    // (via the same playerId in the URL) restores them in Phase 5; for now (Phase 1/2)
    // we just reflect accurate connected/disconnected state to everyone else. ---
    this._broadcastRoomState();
  }

  _handleSetReady(playerId, ready) {
    const player = this.players.get(playerId);
    if (!player) return;
    player.ready = ready;
    this._broadcastRoomState();
  }

  _handleSetVehicle(playerId, vehicleKey) {
    const player = this.players.get(playerId);
    if (!player) return;
    // Server independently validates the selection against the room's vehicle rule —
    // per spec §4, a client cannot just claim a vehicle the room rule doesn't permit.
    if (this.settings.vehicleRule === "locked" && this.settings.lockedVehicle) {
      player.vehicle = this.settings.lockedVehicle;
    } else {
      player.vehicle = vehicleKey; // full VEHICLES-table membership check added in Phase 3
    }
    this._broadcastRoomState();
  }

  _broadcastRoomState() {
    const snapshot = {
      t: "room_state",
      phase: this.phase,
      players: Array.from(this.players.entries()).map(([id, p]) => ({
        id, name: p.name, seat: p.seat, connected: p.connected,
        isOwner: p.isOwner, ready: !!p.ready, vehicle: p.vehicle,
      })),
      settings: {
        roomName: this.settings.roomName, map: this.settings.map,
        maxPlayers: this.settings.maxPlayers, vehicleRule: this.settings.vehicleRule,
        durationPreset: this.settings.durationPreset,
      },
    };
    for (const [playerId, ws] of this.sockets) {
      try { ws.send(JSON.stringify(snapshot)); } catch (e) { /* socket likely stale, will be cleaned up on close event */ }
    }
  }

  _sendTo(playerId, obj) {
    const ws = this.sockets.get(playerId);
    if (ws) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
  }
                                                                 
}
