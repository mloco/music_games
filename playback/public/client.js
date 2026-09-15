'use strict';

// v6: one persistent, always-live grid per player -- no layers, no locking.
// Every toggle takes effect immediately and is heard on the next loop pass.
// Placing a note past noteBudget replaces that same player's own oldest note
// (server-side FIFO eviction); this client just renders whatever grid state
// it's given.

const SCALE = [261.63, 293.66, 329.63, 392.0, 440.0]; // pentatonic C4 D4 E4 G4 A4, row 0 = lowest
const PLAYER_TIMBRE = [
  { wave: 'sine', octave: 0 },
  { wave: 'triangle', octave: -1 },
  { wave: 'sawtooth', octave: 0, lowpass: 1800 },
  { wave: 'square', octave: 1, lowpass: 2200 },
];
const PLAYER_COLORS = ['#d9a441', '#c97b6b', '#8a9a6b', '#6b8a9a'];

let ws = null;
let myId = null;
let roomCode = null;
let state = null;
let audioCtx = null;

const $ = (id) => document.getElementById(id);

function showScreen(name) {
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  $(`screen-${name}`).classList.remove('hidden');
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'joined') {
      myId = msg.playerId;
      roomCode = msg.roomCode;
      $('room-code-display').textContent = roomCode;
      $('room-code-display-2').textContent = roomCode;
    } else if (msg.type === 'error') {
      $('lobby-error').textContent = msg.message;
    } else if (msg.type === 'state') {
      const wasPlaying = state && state.phase === 'playing';
      state = msg.state;
      if (state.phase === 'playing' && !wasPlaying) startScheduler();
      render();
    }
  };
  ws.onclose = () => {
    $('lobby-error').textContent = 'Disconnected. Refresh to reconnect.';
    stopScheduler();
  };
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---- Lobby ----

$('create-btn').onclick = () => {
  ensureAudio();
  connect();
  ws.addEventListener('open', () => send({ type: 'create', name: $('name-input').value }), { once: true });
};

$('join-btn').onclick = () => {
  const code = $('room-code-input').value.trim().toUpperCase();
  if (!code) return;
  ensureAudio();
  connect();
  ws.addEventListener('open', () => send({ type: 'join', roomCode: code, name: $('name-input').value }), { once: true });
};

$('start-btn').onclick = () => send({ type: 'start' });
$('add-bot-btn').onclick = () => send({ type: 'add-bot' });
$('end-btn').onclick = () => send({ type: 'end' });

function me() {
  if (!state) return null;
  return state.players.find((p) => p.id === myId) || null;
}

// ---- Render ----

function render() {
  if (!state) return;

  if (state.phase === 'lobby') {
    showScreen('room');
    $('player-list').innerHTML = state.players
      .map((p) => {
        const tag = p.isBot ? ' (bot)' : p.id === myId ? ' (you)' : '';
        const removeBtn = p.isBot && p.connected ? ` <button class="remove-bot-btn" data-id="${p.id}">remove</button>` : '';
        return `<li style="border-left-color:${PLAYER_COLORS[p.colorIndex]}">${escapeHtml(p.name)}${p.connected ? '' : ' (left)'}${tag}${removeBtn}</li>`;
      })
      .join('');
    document.querySelectorAll('.remove-bot-btn').forEach((btn) => {
      btn.onclick = () => send({ type: 'remove-bot', playerId: btn.dataset.id });
    });
    const connectedCount = state.players.filter((p) => p.connected).length;
    $('add-bot-btn').disabled = connectedCount >= state.maxPlayers;
    return;
  }

  showScreen('game');
  renderStageChrome();
  renderGrids();
}

function renderStageChrome() {
  $('stage-label').textContent = state.phase === 'ended' ? 'Ended' : 'Playing';
  $('end-btn').classList.toggle('hidden', state.phase === 'ended');

  const banner = $('stage-banner');
  banner.className = '';
  if (state.phase === 'ended') {
    banner.textContent = 'The jam has ended. The loop keeps playing whatever notes remain -- listen back, or start a new room to jam again.';
    banner.classList.add('ended');
  } else {
    banner.classList.add('hidden');
  }
}

function renderGrids() {
  const convergedCols = columnsWithConvergence();
  const ordered = [...state.players].sort((a, b) => (a.id === myId ? -1 : b.id === myId ? 1 : 0));

  $('grids-panel').innerHTML = ordered.map((p) => renderPlayerBlock(p, convergedCols)).join('');

  document.querySelectorAll('.pitch-cell.mine').forEach((cell) => {
    cell.onclick = () => send({ type: 'toggle', row: Number(cell.dataset.row), col: Number(cell.dataset.col) });
  });
}

function renderGridHtml(grid, cellClasses, colClasses) {
  const rows = [];
  for (let row = SCALE.length - 1; row >= 0; row--) {
    for (let col = 0; col < state.steps; col++) {
      const active = grid[row][col];
      const classes = ['pitch-cell', ...cellClasses(row, col, active)];
      const colored = active ? colClasses(active) : '';
      rows.push(`<div class="${classes.join(' ')}" data-row="${row}" data-col="${col}" style="${colored}"></div>`);
    }
  }
  return `<div class="pitch-grid" style="grid-template-columns:repeat(${state.steps},1fr)">${rows.join('')}</div>`;
}

function renderPlayerBlock(p, convergedCols) {
  const isMine = p.id === myId;
  const editable = isMine && state.phase === 'playing';
  const color = PLAYER_COLORS[p.colorIndex];
  const inRole = (row) => p.allowedRows.includes(row);

  const html = renderGridHtml(
    p.grid,
    (row, col, active) => {
      const classes = [];
      if (!inRole(row)) classes.push('role-locked');
      else if (editable) classes.push('mine');
      if (active) classes.push('active');
      if (convergedCols.has(col)) classes.push('converged');
      return classes;
    },
    () => `background:${color};border-color:${color}`
  );

  const budgetHtml = isMine
    ? `<div class="budget-label">${p.activeCount} of ${state.noteBudget} notes -- placing a new one past the cap replaces your oldest</div>`
    : '';

  return `<div class="player-grid-block">
    <div class="player-grid-header ${p.connected ? '' : 'disconnected'}">
      <span class="swatch" style="background:${color}"></span>
      <span>${escapeHtml(p.name)}${p.isBot ? ' (bot)' : ''}${isMine ? ' (you)' : ''}${p.connected ? '' : ' -- left'}</span>
    </div>
    ${html}
    ${budgetHtml}
  </div>`;
}

function columnsWithConvergence() {
  const result = new Set();
  if (!state) return result;
  for (let col = 0; col < state.steps; col++) {
    let contributors = 0;
    for (const p of state.players) {
      if (!p.connected) continue;
      if (p.grid.some((row) => row[col])) contributors++;
    }
    if (contributors >= 2) result.add(col);
  }
  return result;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- Visual playhead (runs every frame, independent of render) ----

function visualLoop() {
  if (state && state.phase === 'playing' && state.loopStartAt) {
    const elapsed = Date.now() - state.loopStartAt;
    const col = elapsed >= 0 ? Math.floor(elapsed / state.stepMs) % state.steps : -1;
    document.querySelectorAll('.pitch-cell.playhead').forEach((el) => el.classList.remove('playhead'));
    if (col >= 0) {
      document.querySelectorAll(`.pitch-cell[data-col="${col}"]`).forEach((el) => el.classList.add('playhead'));
    }
  }
  requestAnimationFrame(visualLoop);
}
requestAnimationFrame(visualLoop);

// ---- Audio ----

function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playNote(ctx, when, pitchRow, colorIndex) {
  // Every note a player places plays in that same player's fixed register --
  // their identity stays consistent no matter how many times individual notes
  // get replaced.
  const timbre = PLAYER_TIMBRE[colorIndex % PLAYER_TIMBRE.length];
  const freq = SCALE[pitchRow] * Math.pow(2, timbre.octave);
  const osc = ctx.createOscillator();
  osc.type = timbre.wave;
  osc.frequency.value = freq;

  // Low rows ring out like a bass anchor; high rows are short and percussive.
  // Without this every note had the same 0.35s pluck regardless of pitch, which
  // is a big part of why simultaneous notes across players read as a pile of
  // identical bleeps instead of parts with distinct roles.
  const t = pitchRow / (SCALE.length - 1); // 0 = lowest row, 1 = highest row
  const decay = 0.7 - t * 0.5; // 0.7s at the bottom, 0.2s at the top
  const peakGain = 0.18 - t * 0.05; // low notes sit slightly louder/grounded

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(peakGain, when + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.001, when + decay);

  let node = osc;
  if (timbre.lowpass) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = timbre.lowpass;
    node.connect(filter);
    node = filter;
  }
  node.connect(gain).connect(ctx.destination);
  osc.start(when);
  osc.stop(when + decay + 0.05);
}

function playPulse(ctx, when, accent) {
  // A fixed, non-editable downbeat thump -- nobody places it, nobody can
  // remove it. Gives the ear one constant thing to lock onto across an
  // otherwise fully player-authored (and thus unpredictable) loop; a soft
  // kick-like click, well below the pentatonic register so it never competes
  // tonally with anything players place. Fires twice per loop (beat 1 and
  // the halfway point) so a 16-step loop reads as two felt bars, not one
  // long one -- beat 1 hits harder so "one" stays audibly the strong beat.
  const peak = accent ? 0.22 : 0.14;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(110, when);
  osc.frequency.exponentialRampToValueAtTime(45, when + 0.09);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(peak, when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + 0.12);

  osc.connect(gain).connect(ctx.destination);
  osc.start(when);
  osc.stop(when + 0.14);
}

const SCHEDULE_AHEAD_MS = 150;
let schedulerTimer = null;
let nextStepToSchedule = 0;

function startScheduler() {
  stopScheduler();
  ensureAudio();
  nextStepToSchedule = Math.max(0, Math.floor((Date.now() - state.loopStartAt) / state.stepMs));
  schedulerTimer = setInterval(schedulerTick, 50);
}

function stopScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
}

function schedulerTick() {
  if (!state || state.phase !== 'playing') return;
  const ctx = ensureAudio();
  for (;;) {
    const stepAbsoluteMs = state.loopStartAt + nextStepToSchedule * state.stepMs;
    const msUntil = stepAbsoluteMs - Date.now();
    if (msUntil > SCHEDULE_AHEAD_MS) break;
    const when = ctx.currentTime + Math.max(0, msUntil) / 1000;
    const col = ((nextStepToSchedule % state.steps) + state.steps) % state.steps;
    if (col === 0) playPulse(ctx, when, true);
    else if (col === Math.floor(state.steps / 2)) playPulse(ctx, when, false);
    for (const p of state.players) {
      if (!p.connected) continue;
      for (let row = 0; row < state.pitchRows; row++) {
        if (p.grid[row][col]) playNote(ctx, when, row, p.colorIndex);
      }
    }
    nextStepToSchedule++;
  }
}
