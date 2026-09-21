"use strict";
/* =====================================================================================
   ROAD RUSH — worker.js
   Phase 1: Worker routing layer. Validates requests, resolves room IDs to their
   Durable Object, and upgrades to WebSocket. This file does NOT hold game state —
   that lives entirely in room-authority.js (the Durable Object class below).
===================================================================================== */

const PROTOCOL_VERSION = 1; // bump this if message shapes change incompatibly

export { RoomAuthority } from "./room-authority.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- Room creation: POST /room/create ---
    if (url.pathname === "/room/create" && request.method === "POST") {
      return handleCreateRoom(request, env);
    }

    // --- Room join / WebSocket upgrade: GET /room/:id/join ---
    const joinMatch = url.pathname.match(/^\/room\/([A-Z0-9]{5,8})\/join$/);
    if (joinMatch) {
      return handleJoinRoom(request, env, joinMatch[1]);
    }

    // --- Room status lookup (for the "room not found / full" UX, no upgrade) ---
    const statusMatch = url.pathname.match(/^\/room\/([A-Z0-9]{5,8})\/status$/);
    if (statusMatch) {
      return handleRoomStatus(env, statusMatch[1]);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleCreateRoom(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonError(400, "malformed_request", "Request body must be valid JSON.");
  }

  // Protocol version check happens at every entry point, not just WebSocket messages —
  // per the spec's requirement that an incompatible client gets a clear error, not a
  // room it can't correctly interpret.
  if (body.protocolVersion !== PROTOCOL_VERSION) {
    return jsonError(409, "incompatible_version",
      `This client speaks protocol v${body.protocolVersion}, server requires v${PROTOCOL_VERSION}.`);
  }

  const capacity = [2, 5, 10, 15, 18].includes(body.maxPlayers) ? body.maxPlayers : 5;
  const roomId = generateRoomId();

  // One Durable Object instance per room, addressed by the room's own generated ID —
  // this is what makes Room A and Room B genuinely independent (spec §1/§13).
  const id = env.ROOM_AUTHORITY.idFromName(roomId);
  const stub = env.ROOM_AUTHORITY.get(id);

  const initResponse = await stub.fetch("https://internal/init", {
    method: "POST",
    body: JSON.stringify({
      roomId,
      maxPlayers: capacity,
      roomName: String(body.roomName || "Untitled Room").slice(0, 40),
      hasPassword: !!body.password,
      passwordHash: body.password ? await hashPassword(body.password) : null,
      map: body.map || "Highway",
      vehicleRule: ["individual", "host_selected", "random", "locked"].includes(body.vehicleRule)
        ? body.vehicleRule : "individual",
      durationPreset: ["instant", "short", "long", "max"].includes(body.durationPreset)
        ? body.durationPreset : "short",
      visibility: body.visibility === "private" ? "private" : "public",
      ownerName: String(body.ownerName || "Player").slice(0, 20),
    }),
  });

  if (!initResponse.ok) {
    return jsonError(500, "room_init_failed", "Could not initialize room authority.");
  }

  return new Response(JSON.stringify({ roomId, protocolVersion: PROTOCOL_VERSION }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleJoinRoom(request, env, roomId) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return jsonError(426, "upgrade_required", "This endpoint requires a WebSocket upgrade.");
  }

  const url = new URL(request.url);
  const protocolVersion = Number(url.searchParams.get("v"));
  if (protocolVersion !== PROTOCOL_VERSION) {
    return jsonError(409, "incompatible_version",
      `This client speaks protocol v${protocolVersion}, server requires v${PROTOCOL_VERSION}.`);
  }

  const id = env.ROOM_AUTHORITY.idFromName(roomId);
  const stub = env.ROOM_AUTHORITY.get(id);

  // Forward the upgrade request straight to the room's Durable Object — it owns the
  // actual WebSocket lifecycle from here (seat allocation, password check, etc.)
  return stub.fetch(request);
}

async function handleRoomStatus(env, roomId) {
  const id = env.ROOM_AUTHORITY.idFromName(roomId);
  const stub = env.ROOM_AUTHORITY.get(id);
  const res = await stub.fetch("https://internal/status");
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------
function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I ambiguity for QR/manual entry
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function hashPassword(pw) {
  // Plain hashing (not a login credential store) — this is friction against casual
  // guessing, not a claim of cryptographic account security. Stated honestly per
  // the earlier-agreed security wording.
  const enc = new TextEncoder().encode(pw);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function jsonError(status, code, message) {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
    }
