'use strict';
// A scripted player for solo playtesting Playback. Joins a room like a real
// player and, once the jam starts, forever places notes at a paced interval
// within its own role-restricted rows -- occasionally biased toward a column
// someone else is already using, so convergence actually shows up during solo
// testing. There's no "layer" or "lock" step anymore (see server.js v6):
// every toggle takes effect immediately, and the server evicts this bot's own
// oldest note automatically once it's past the note budget.
//
// Usage:
//   node bot.js                 -- creates a new room, prints the code, waits for you to join + start
//   node bot.js ROOMCODE        -- joins an existing room (e.g. one you created in the browser)
//   node bot.js ROOMCODE Name   -- also sets the bot's display name
//
// Note: the room lobby now has its own "Add bot" button that does this
// in-process, without a second terminal. This script is still useful for
// driving a bot from outside the server process (e.g. against a deployed
// instance) or for scripted load/playtesting.

const WebSocket = require('ws');

process.on('uncaughtException', (e) => { console.error('[bot] uncaught exception:', e.stack); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('[bot] unhandled rejection:', e); process.exit(1); });

const PORT = process.env.PORT || 4001;
const URL = `ws://localhost:${PORT}`;
const roomCodeArg = process.argv[2] ? process.argv[2].toUpperCase() : null;
const name = process.argv[3] || 'Bot';

const PACING = { minDelayMs: 600, maxDelayMs: 1500 };

let ws = null;
let myId = null;
let state = null;
let started = false; // guards against starting the loop twice

function log(...args) {
  console.log(`[bot:${name}]`, ...args);
}

function connect() {
  ws = new WebSocket(URL);
  ws.on('open', () => {
    if (roomCodeArg) {
      ws.send(JSON.stringify({ type: 'join', roomCode: roomCodeArg, name }));
    } else {
      ws.send(JSON.stringify({ type: 'create', name }));
    }
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'joined') {
      myId = msg.playerId;
      log(`joined room ${msg.roomCode} as ${msg.playerId}`);
      if (!roomCodeArg) log(`room code is ${msg.roomCode} -- open the app, join with this code, then hit Start.`);
    } else if (msg.type === 'error') {
      log('error:', msg.message);
      process.exit(1);
    } else if (msg.type === 'state') {
      onState(msg.state);
    }
  });
  ws.on('close', () => {
    log('disconnected');
    process.exit(0);
  });
  ws.on('error', (e) => {
    log('connection error:', e.message, '-- is the server running? (npm start)');
    process.exit(1);
  });
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function me() {
  return state ? state.players.find((p) => p.id === myId) : null;
}

function onState(newState) {
  const wasEnded = state && state.phase === 'ended';
  state = newState;
  const self = me();
  if (!self) return;

  if (state.phase === 'ended') {
    if (!wasEnded) log('jam ended -- piece is finished. Ctrl+C to disconnect.');
    return;
  }

  if (state.phase === 'playing' && !started) {
    started = true;
    runLoop();
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }

function columnsInUse() {
  const cols = new Set();
  if (!state) return [];
  for (const p of state.players) {
    if (!p.connected) continue;
    for (let col = 0; col < state.steps; col++) {
      if (p.grid.some((row) => row[col])) cols.add(col);
    }
  }
  return [...cols];
}

async function runLoop() {
  for (;;) {
    await sleep(randInt(PACING.minDelayMs, PACING.maxDelayMs));
    const self = me();
    if (!self || !self.connected || !state || state.phase !== 'playing') return;

    const usedCols = columnsInUse();
    const wantConverge = usedCols.length > 0 && Math.random() < 0.4;
    const col = wantConverge ? pick(usedCols) : randInt(0, state.steps - 1);
    const row = pick(self.allowedRows);

    send({ type: 'toggle', row, col });
    log(`toggled row ${row}, col ${col}${wantConverge ? ' (going for convergence)' : ''}`);
  }
}

connect();
