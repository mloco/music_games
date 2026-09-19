/* SafeCracker — deterministic game rules.
 *
 * This module holds ONLY the pure game logic: the candidate pool, the seeded
 * secret pick, the listen schedule, the action costs, the resource caps, and
 * the resolution order of every action. It touches neither the DOM nor the
 * audio clock, so the entire rules surface is testable in Node (see tests.js).
 *
 * DESIGN (contact point)
 * ----------------------
 * The secret is a coprime Euclidean rhythm E(k, n) with an onset on step 0
 * (the downbeat). The player sets a DIAL (k, n) and acts two ways:
 *
 *   Listen        -2 beats  +1 noise   plays the lock AND your dial together
 *                                        for a fixed LISTEN_STEPS steps, both
 *                                        looping from a shared downbeat.
 *                                        (Requires working audio; a listen
 *                                        that never plays charges nothing.)
 *   Try (k,n)     -1 beat   +3 noise   correct pair opens the lock; a wrong
 *                                        pair costs noise and tells you nothing
 *                                        but "still locked".
 *
 * Why the dial overlay: a lone Euclidean cycle hides n — the trailing rests
 * are silence with nothing to close them. Looping the lock against the dial
 * makes n audible as PHASE DRIFT, like a safecracker listening for the
 * contact point:
 *   - dial n == lock n: your dial downbeat lands on the lock's downbeat every
 *     cycle (they fuse). If k matches too, every hit fuses — full unison.
 *   - dial n  > lock n: your downbeat falls (n_dial - n_lock) steps further
 *     BEHIND the lock's each cycle.  -> turn n down.
 *   - dial n  < lock n: it creeps AHEAD by the same amount.  -> turn n up.
 *   - k is countable: lock hits between two lock downbeats.
 * The drift direction is a higher/lower probe delivered by ear, so there is
 * no separate probe action. Drift SIZE is the skilled-ear bonus: hearing
 * "off by one" vs "way off" lets a good listener skip listens.
 *
 * The listen length is fixed (never a function of n), so its duration leaks
 * nothing.
 *
 * RESOLUTION ORDER (consistent, tested in tests.js)
 * -----------------------------------------------
 * Charges are applied to every committed action. A CORRECT try wins BEFORE the
 * limit check, so the lock can legitimately "click open on the same beat the
 * guard would have caught you" — that exception only applies to the winning
 * attempt. A wrong try or a listen that pushes noise to NOISE_LIMIT or beats
 * to GUARD_BEATS is a loss.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SafeCracking = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Rhythm math
  // -------------------------------------------------------------------------

  /* Björklund's algorithm: distribute k onsets as evenly as possible across
   * n steps. Returns a binary array (1 = onset). The construction starts from
   * onset-groups first, so the result is always anchored with an onset on
   * step 0 — the downbeat every secret needs to be unambiguously audible. */
  function bjorklund(k, n) {
    k = Math.max(0, Math.min(Math.floor(k), Math.floor(n)));
    n = Math.floor(n);
    if (n <= 0) return [];
    if (k === 0) return new Array(n).fill(0);
    if (k === n) return new Array(n).fill(1);

    let onsets = Array.from({ length: k }, () => [1]);
    let rests = Array.from({ length: n - k }, () => [0]);
    while (rests.length > 1) {
      const pairs = Math.min(onsets.length, rests.length);
      const merged = [];
      for (let i = 0; i < pairs; i++) merged.push(onsets[i].concat(rests[i]));
      const leftoverOnsets = onsets.slice(pairs);
      const leftoverRests = rests.slice(pairs);
      onsets = merged;
      rests = leftoverOnsets.length > 0 ? leftoverOnsets : leftoverRests;
    }
    return onsets.concat(rests).flat();
  }

  function gcd(a, b) {
    while (b) { const t = a % b; a = b; b = t; }
    return a;
  }

  // -------------------------------------------------------------------------
  // Parameters (single source of truth for the UI and the tests)
  // -------------------------------------------------------------------------

  // Dial ranges. Every coprime pair inside them is a possible secret.
  const K_MIN = 2, K_MAX = 5;
  const N_MIN = 4, N_MAX = 12;

  // Resource caps. GUARD_BEATS = how many committed beats before the guard
  // arrives; NOISE_LIMIT = noise at which the alarm trips. Being at or past a
  // cap on a non-winning action is a loss. Tuned so a perfect ear (direction
  // only) needs 2 listens + 1 try, leaving ~3 spare listens for real ears.
  const GUARD_BEATS = 12;
  const NOISE_LIMIT = 9;

  // Tempo is FIXED for a challenge (and across challenges) so that drift
  // heard on one listen is comparable to drift heard on the next.
  const TEMPO_BPM = 100;

  // Steps per listen: 3 full cycles of the longest possible lock, so even at
  // n = N_MAX the drift is heard growing twice. Independent of the secret.
  const LISTEN_STEPS = 3 * N_MAX;

  const COSTS = Object.freeze({
    listen: Object.freeze({ beats: 2, noise: 1 }),
    try: Object.freeze({ beats: 1, noise: 3 }),
  });

  const LOSS_REASONS = Object.freeze({
    out_of_time: 'out_of_time',
    too_loud: 'too_loud',
  });

  // Every coprime pair in range: exactly one answer per sound (no scale/phase
  // ambiguity), and wide enough that counting k alone never narrows the lock
  // to something two wrong tries can cover.
  const POOL = Object.freeze((function () {
    const out = [];
    for (let k = K_MIN; k <= K_MAX; k++) {
      for (let n = Math.max(N_MIN, k + 1); n <= N_MAX; n++) {
        if (gcd(k, n) === 1) out.push(Object.freeze({ k: k, n: n }));
      }
    }
    return out;
  })());

  // -------------------------------------------------------------------------
  // Listen schedule — what the ear gets. The UI plays exactly these events.
  // -------------------------------------------------------------------------

  /* Both rhythms loop from a shared step 0 for LISTEN_STEPS steps. Voices:
   *   lockDownbeat / lockOnset  — the secret (kick / click)
   *   dialDownbeat / dialOnset  — the player's dial (metal tick / soft tick) */
  function listenSchedule(secret, dial) {
    const lock = bjorklund(secret.k, secret.n);
    const mine = bjorklund(dial.k, dial.n);
    const events = [];
    for (let s = 0; s < LISTEN_STEPS; s++) {
      const li = s % lock.length, di = s % mine.length;
      if (lock[li]) events.push({ step: s, voice: li === 0 ? 'lockDownbeat' : 'lockOnset' });
      if (mine[di]) events.push({ step: s, voice: di === 0 ? 'dialDownbeat' : 'dialOnset' });
    }
    return events;
  }

  // -------------------------------------------------------------------------
  // Seeded PRNG — reproducible secret selection.
  // -------------------------------------------------------------------------

  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
  }

  function mulberry32(seed) {
    let a = seed;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Same seed -> same secret, forever. "Restart" replays the same challenge by
   * reusing the seed; "New lock" draws a fresh seed. */
  function secretFromSeed(seedStr) {
    const h = xmur3('safecracker-' + String(seedStr));
    const rand = mulberry32(h());
    const idx = Math.floor(rand() * POOL.length);
    return { k: POOL[idx].k, n: POOL[idx].n };
  }

  function randomSeed() {
    return 'lock-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 0xFFFFFF).toString(36);
  }

  // -------------------------------------------------------------------------
  // Game state
  // -------------------------------------------------------------------------

  const clampK = (v) => Math.min(K_MAX, Math.max(K_MIN, Math.round(v) || K_MIN));
  const clampN = (v) => Math.min(N_MAX, Math.max(N_MIN, Math.round(v) || N_MIN));

  function createRun(seed, opts) {
    opts = opts || {};
    const secret = secretFromSeed(seed);
    return {
      seed: seed,
      secret: secret,
      pattern: bjorklund(secret.k, secret.n),
      status: 'active',                                  // 'active' | 'won' | 'lost'
      won: false,
      lost: false,
      reason: null,                                      // LOSS_REASONS entry when lost
      beatsUsed: 0,
      noise: 0,
      k: clampK(opts.k !== undefined ? opts.k : 3),      // dial values (never charged)
      n: clampN(opts.n !== undefined ? opts.n : 8),
      attempts: [],                                      // previous tried pairs {k,n}
      history: [],                                       // committed-action log
    };
  }

  const guardRemaining = (r) => GUARD_BEATS - r.beatsUsed;
  const noiseRemaining = (r) => NOISE_LIMIT - r.noise;
  const isEnded = (r) => r.status !== 'active';

  // Turning the dial is free — only committed actions advance the clock.
  function setK(run, v) { if (run.status === 'active') run.k = clampK(v); }
  function setN(run, v) { if (run.status === 'active') run.n = clampN(v); }

  function pushHistory(run, entry) {
    run.history.push(Object.assign({ beats: 0, noise: 0 }, entry));
  }

  function charge(run, cost) {
    run.beatsUsed += cost.beats;
    run.noise += cost.noise;
  }

  /* Loss check for non-winning resolutions. Aggregated so the two limits can
   * both be crossed by one action and still produce one deterministic reason
   * (guard first). */
  function failByLimits(run) {
    if (run.beatsUsed >= GUARD_BEATS) {
      run.status = 'lost'; run.lost = true; run.reason = LOSS_REASONS.out_of_time;
      return true;
    }
    if (run.noise >= NOISE_LIMIT) {
      run.status = 'lost'; run.lost = true; run.reason = LOSS_REASONS.too_loud;
      return true;
    }
    return false;
  }

  /* Records a listen against the current dial. The result carries no verdict —
   * what the lock "said" is only in the audio (listenSchedule). */
  function listen(run, opts) {
    if (isEnded(run)) return { ok: false, reason: 'run_ended' };
    if (!opts || opts.heard !== true) return { ok: false, reason: 'audio_unavailable' };
    charge(run, COSTS.listen);
    pushHistory(run, {
      type: 'listen', label: 'Listen',
      beats: COSTS.listen.beats, noise: COSTS.listen.noise,
      k: run.k, n: run.n,
    });
    const lost = failByLimits(run);
    return {
      ok: true, lost: lost, reason: lost ? run.reason : null,
      charged: COSTS.listen,
      guardRemaining: guardRemaining(run), noiseRemaining: noiseRemaining(run),
    };
  }

  function tryCombination(run) {
    if (isEnded(run)) return { ok: false, reason: 'run_ended' };

    const correct = run.k === run.secret.k && run.n === run.secret.n;
    run.attempts.push({ k: run.k, n: run.n });
    charge(run, COSTS.try);

    // A correct try wins BEFORE any loss check — the lock can click open on the
    // very beat the guard would otherwise catch you. Consistent and tested.
    if (correct) {
      run.status = 'won'; run.won = true;
      pushHistory(run, {
        type: 'try', label: 'Try combination',
        beats: COSTS.try.beats, noise: COSTS.try.noise,
        k: run.k, n: run.n, result: 'win',
      });
      return {
        ok: true, result: 'win', charged: COSTS.try,
        guardRemaining: guardRemaining(run), noiseRemaining: noiseRemaining(run),
      };
    }

    pushHistory(run, {
      type: 'try', label: 'Try combination',
      beats: COSTS.try.beats, noise: COSTS.try.noise,
      k: run.k, n: run.n, result: 'fail',
    });
    const lost = failByLimits(run);
    return {
      ok: true, result: 'fail', lost: lost, reason: lost ? run.reason : null,
      charged: COSTS.try,
      guardRemaining: guardRemaining(run), noiseRemaining: noiseRemaining(run),
    };
  }

  return Object.freeze({
    bjorklund: bjorklund,
    gcd: gcd,
    K_MIN: K_MIN, K_MAX: K_MAX, N_MIN: N_MIN, N_MAX: N_MAX,
    GUARD_BEATS: GUARD_BEATS, NOISE_LIMIT: NOISE_LIMIT,
    TEMPO_BPM: TEMPO_BPM, LISTEN_STEPS: LISTEN_STEPS,
    COSTS: COSTS, POOL: POOL, LOSS_REASONS: LOSS_REASONS,
    listenSchedule: listenSchedule,
    secretFromSeed: secretFromSeed, randomSeed: randomSeed,
    clampK: clampK, clampN: clampN,
    createRun: createRun,
    guardRemaining: guardRemaining, noiseRemaining: noiseRemaining,
    isEnded: isEnded,
    setK: setK, setN: setN,
    listen: listen, tryCombination: tryCombination,
  });
});
