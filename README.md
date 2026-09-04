# ROAD RUSH - Web Edition (live multiplayer, no backend to host)

A 2D side-view hill-climb racer that runs entirely in the browser — desktop or mobile,
auto-fits and prompts for landscape on phones. Play solo against bots, or race friends
live using a room code, with **no server for you to set up or run**.

## How multiplayer works (and why there's "no backend")

There's no game server. When you create or join a room, your browser connects **directly**
to your friend's browser over WebRTC (peer-to-peer) — all race positions, the countdown,
and the leaderboard travel straight between your devices.

The one thing every peer-to-peer app needs is a way for two browsers that don't know each
other's address yet to find each other — that's called "signaling," and it's a one-time
handshake, not something that carries game data. This uses **PeerJS's free public
signaling server** for that handshake only. It's bundled locally (`peerjs.min.js`) so you
don't depend on a CDN, but the signaling handshake itself still needs an internet
connection (both players' devices need internet access — the same network isn't required,
PeerJS's broker works across networks).

## Running it

**Easiest: just open `index.html` in a browser.** Everything (HTML/CSS/JS + the bundled
PeerJS library) is local — no build step, no npm install, no server needed for single
player or to browse the menus.

**For multiplayer, host it somewhere reachable over HTTPS** rather than opening the raw
file, because some browsers restrict WebRTC under a `file://` page. The easiest free
options:

- **GitHub Pages**: push this folder to a repo, enable Pages, share the resulting URL.
- **Netlify / Vercel drop**: drag the folder onto netlify.com/drop (no account needed) or
  vercel.com — you get a live HTTPS URL in seconds.
- Any static host works — it's 4 plain files, nothing to configure.

Once it's hosted, share the URL with friends. Whoever creates a room gets a 5-character
room code to read out loud or copy/paste — the other players tap "Join Race" and type it in.

## Controls

| Input | Action |
|---|---|
| `W` / `Up` / **GAS** button | Accelerate |
| `S` / `Down` / **BRAKE** button | Brake |
| `A`/`D` or `Left`/`Right` | Tilt (mainly matters mid-air) |
| `Space` / **NOS** button | Nitro boost (up to 3 charges) |
| `Esc` / pause icon | Pause |
| `R` | Restart |

On phones the gas/brake/nitro buttons appear automatically; the page also detects
portrait orientation on phones and asks you to rotate to landscape.

## Game flow

**Home** → **Play** → **Single Player** / **Create Competition** / **Join Race**

- **Single Player**: race against 3 AI bots on whichever map/vehicle you've picked.
- **Create Competition**: generates a room code immediately. You (the host) pick the
  map; everyone in the room picks their own vehicle. Tap **Start Race** once your
  friends (up to 4 more, 5 total) have joined.
- **Join Race**: enter the host's room code to connect.

Race: **3-2-1-GO** countdown → live race with gravity/friction physics, fuel, nitro,
coin pickups, and environment obstacles → first to the finish line wins → **leaderboard**
with placement, time, and score for everyone in the room.

From the leaderboard: **Cancel** returns everyone to the same room to race again (host
starts it), or **Home** leaves entirely.

## Maps & vehicles

5 procedurally-generated maps (Highway, Hills, Moon, Desert, Snow) — each with distinct
gravity, traction, and obstacle types — and 3 vehicles (Car/Bike/Bus) with different
accel/top-speed/stability trade-offs. All graphics are drawn with Canvas primitives and
all sound effects are synthesized with the Web Audio API at runtime — no image or audio
files to download or license.

## What I verified before handing this over

Using a headless browser test harness, I confirmed (with zero console errors):
- Full single-player race start-to-finish, including physics, obstacles, pickups, HUD,
  countdown, pause, and the final ranked leaderboard with correct scoring
- Vehicle selection and settings persistence
- Mobile portrait → rotate-to-landscape prompt appears/disappears correctly, and gas/
  brake/nitro touch buttons genuinely trigger the same input path as the keyboard
  (verified by dispatching a real `touchstart` event, not just calling a function)
- The full multiplayer **logic** end-to-end — lobby player list rendering, map selection,
  race start with a shared seed, remote-ghost creation and position updates, host-side
  finish compilation combining a local and a networked finish, and a correctly sorted
  final leaderboard — by driving the same code paths the real network layer uses
- A real bug (the HUD being hidden immediately after being shown, from a call-order
  mistake) was caught and fixed during testing

**What I could not verify directly**: the actual live WebRTC handshake between two
separate real devices, since this sandbox has no outbound internet access to reach
PeerJS's public signaling server. The connection code follows PeerJS's standard,
well-documented pattern, and every downstream step (lobby, race, leaderboard) is tested
as above — but **please do one quick real test with a friend before presenting**, just to
confirm the room-code handshake itself works smoothly on your networks. If a room fails
to create or join, the on-screen error message will tell you what happened (e.g. "check
the code" or a connection timeout) rather than silently hanging.

## Known limitations

- Requires both players to have internet access (for the initial PeerJS handshake) —
  it is not fully offline, and it is not real Bluetooth.
- No reconnect-on-drop: if a player's connection drops mid-race, they're removed from
  that race's leaderboard compilation.
- Up to 5 players total (1 host + 4 joining), star-topology (all guests connect through
  the host) rather than full mesh — simpler and reliable at this scale.
- AI bots (single-player) use a simple heuristic, not full pathing.

## Realistic future improvements

- A small relay/fallback signaling option for stricter networks where direct WebRTC is
  blocked (corporate/school Wi-Fi sometimes filters it).
- Reconnect handling if a player's connection drops mid-race.
- Replay/ghost recording of best runs, and a cosmetic coin shop.
