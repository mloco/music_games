'use strict';
// Playback -- networked prototype server, v6 (post-playtest revision #5).
//
// v5 and earlier built the piece out of per-player LAYERS -- each player worked
// through a queue of small (2-note) layers, locking each one in turn, with a
// separate "building" vs "evolving" stage machine and per-layer lock deadlines.
// Playtesting found this confusing: the lock/current/layers split obscured what
// was actually playing, and the building/evolving distinction added ceremony
// without adding anything players could feel.
//
// v6 replaces all of that with one persistent, always-live grid per player.
// There is no locking and no separate "current" vs "committed" content -- every
// toggle takes effect immediately and is heard on the very next loop. Each
// player can have at most NOTE_BUDGET notes active at once; placing a note past
// the cap replaces (evicts) that same player's own oldest note, FIFO. Nobody's
// notes are ever touched by anyone but themselves. Lane restrictions
// (ROLE_ROWS, keyed by colorIndex) are unchanged from v5.
//
// Room lifecycle is now just: 'lobby' -> 'playing' -> 'ended'. 'ended' freezes
// every grid (no more toggles); the loop keeps playing whatever's left.

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 4001;
const PUBLIC_DIR = path.join(__dirname, 'public');

const STEPS = 16;
const PITCH_ROWS = 5;
const STEP_MS = 225;
const MAX_PLAYERS = 4;
const NOTE_BUDGET = 6; // per player, total, always -- not per-layer

// Row 0 = lowest pitch (see client.js SCALE comment). Giving each colorIndex a
// fixed, restricted slice of the 5 rows turns 4 people freely soloing over the
// same range into bass/harmony/melody/lead roles instead. The ranges overlap
// by one row at the harmonic middle so players 1 and 2 can still lock in
// together, but nobody can plant a note in someone else's register.
const ROLE_ROWS = [
  [0, 1],       // colorIndex 0: bass anchor, bottom two pitches only
  [1, 2, 3],    // colorIndex 1: harmony, middle three
  [1, 2, 3],    // colorIndex 2: melody, middle three
  [3, 4],       // colorIndex 3: lead, top two pitches only
];

function allowedRows(colorIndex) {
  return ROLE_ROWS[colorIndex % ROLE_ROWS.length];
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const reqPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(PUBLIC_DIR, decodeURIComponent(reqPath.split('?')[0]));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function emptyGrid() {
  return Array.from({ length: PITCH_ROWS }, () => Array(STEPS).fill(false));
}

function createRoom() {
  const code = makeRoomCode();
  const room = { code, players: [], phase: 'lobby', loopStartAt: null };
  rooms.set(code, room);
  return room;
}

function addPlayer(room, ws, name, isBot = false) {
  const id = 'p' + Math.random().toString(36).slice(2, 8);
  const colorIndex = room.players.length % MAX_PLAYERS;
  room.players.push({
    id, ws, name: (name || 'Player').slice(0, 20), colorIndex, connected: true, isBot,
    grid: emptyGrid(),
    noteOrder: [], // {row, col} in the order they were placed, oldest first -- drives FIFO eviction
  });
  return id;
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}

function roomState(room) {
  return {
    code: room.code,
    phase: room.phase,
    steps: STEPS,
    pitchRows: PITCH_ROWS,
    stepMs: STEP_MS,
    maxPlayers: MAX_PLAYERS,
    loopStartAt: room.loopStartAt,
    noteBudget: NOTE_BUDGET,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      colorIndex: p.colorIndex,
      allowedRows: allowedRows(p.colorIndex),
      connected: p.connected,
      isBot: p.isBot,
      grid: p.grid,
      activeCount: p.noteOrder.length,
    })),
  };
}

function sync(room) {
  broadcast(room, { type: 'state', state: roomState(room) });
}

// The single mutation path for every note change -- human clicks and bot
// placements both go through this, so they're held to identical rules.
// Clicking an already-active cell just turns it off. Clicking an empty one
// turns it on, evicting this player's own oldest note first if they're
// already at NOTE_BUDGET. No cross-player effects, ever.
function applyToggle(room, player, row, col) {
  if (room.phase !== 'playing') return;
  if (row < 0 || row >= PITCH_ROWS || col < 0 || col >= STEPS) return;
  if (!allowedRows(player.colorIndex).includes(row)) return;

  if (player.grid[row][col]) {
    player.grid[row][col] = false;
    player.noteOrder = player.noteOrder.filter((n) => !(n.row === row && n.col === col));
  } else {
    if (player.noteOrder.length >= NOTE_BUDGET) {
      const oldest = player.noteOrder.shift();
      player.grid[oldest.row][oldest.col] = false;
    }
    player.grid[row][col] = true;
    player.noteOrder.push({ row, col });
  }
  sync(room);
}

function endJam(room) {
  room.phase = 'ended';
  sync(room);
}

// ---- Bots ----
// A bot just clicks like a (slow, lane-respecting) player would: forever,
// every so often, place a note somewhere in its own role range -- occasionally
// biased toward a column someone else is already using, for a convergence
// moment. NOTE_BUDGET + applyToggle's own eviction rule handle the "replace
// the oldest note" behavior automatically; there's no separate bot-only path.
const BOT_PACING = { minDelayMs: 600, maxDelayMs: 1500 };

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }

function columnsInUse(room) {
  const cols = new Set();
  for (const p of room.players) {
    if (!p.connected) continue;
    for (let col = 0; col < STEPS; col++) {
      if (p.grid.some((row) => row[col])) cols.add(col);
    }
  }
  return [...cols];
}

async function runBot(room, playerId) {
  for (;;) {
    await sleep(randInt(BOT_PACING.minDelayMs, BOT_PACING.maxDelayMs));
    const player = room.players.find((p) => p.id === playerId);
    if (!player || !player.connected || room.phase !== 'playing') return;

    const usedCols = columnsInUse(room);
    const wantConverge = usedCols.length > 0 && Math.random() < 0.4;
    const col = wantConverge ? pick(usedCols) : randInt(0, STEPS - 1);
    const row = pick(allowedRows(player.colorIndex));
    applyToggle(room, player, row, col);
  }
}

wss.on('connection', (ws) => {
  let room = null;
  let playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    if (msg.type === 'create') {
      room = createRoom();
      playerId = addPlayer(room, ws, msg.name);
      ws.send(JSON.stringify({ type: 'joined', roomCode: room.code, playerId }));
      sync(room);
      return;
    }

    if (msg.type === 'join') {
      room = rooms.get((msg.roomCode || '').toUpperCase());
      if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found' })); return; }
      if (room.players.filter((p) => p.connected).length >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room full' }));
        return;
      }
      playerId = addPlayer(room, ws, msg.name);
      ws.send(JSON.stringify({ type: 'joined', roomCode: room.code, playerId }));
      sync(room);
      return;
    }

    if (!room) return;

    if (msg.type === 'start' && room.phase === 'lobby') {
      room.phase = 'playing';
      room.loopStartAt = Date.now() + 300;
      for (const p of room.players) {
        if (p.isBot) runBot(room, p.id);
      }
      sync(room);
      return;
    }

    if (msg.type === 'toggle' && room.phase === 'playing') {
      const p = room.players.find((pl) => pl.id === playerId);
      if (!p) return;
      const { row, col } = msg;
      if (!Number.isInteger(row) || !Number.isInteger(col)) return;
      applyToggle(room, p, row, col);
      return;
    }

    if (msg.type === 'add-bot' && room.phase === 'lobby') {
      if (room.players.filter((p) => p.connected).length >= MAX_PLAYERS) return;
      const botNumber = room.players.filter((p) => p.isBot).length + 1;
      addPlayer(room, null, `Bot ${botNumber}`, true);
      sync(room);
      return;
    }

    if (msg.type === 'remove-bot' && room.phase === 'lobby') {
      // Marked disconnected rather than spliced out, same as a human leaving --
      // colorIndex assignment and capacity checks are both keyed off `connected`
      // elsewhere, so this reuses that path instead of needing to renumber.
      const target = room.players.find((pl) => pl.id === msg.playerId && pl.isBot);
      if (target) target.connected = false;
      sync(room);
      return;
    }

    if (msg.type === 'end' && room.phase === 'playing') {
      endJam(room);
      return;
    }
  });

  ws.on('close', () => {
    if (!room) return;
    const p = room.players.find((pl) => pl.id === playerId);
    if (p) p.connected = false;
    sync(room);
  });
});

server.listen(PORT, () => {
  console.log(`Playback prototype listening on http://localhost:${PORT}`);
});
