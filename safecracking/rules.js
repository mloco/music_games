/* SafeCracker — deterministic game rules.
 *
 * This module holds ONLY the pure game logic: the candidate pool, the seeded
 * secret pick, the action costs, the resource caps, and the resolution order
 * of every action. It touches neither the DOM nor the audio clock, so the
 * entire rules surface is testable in Node (see tests.js).
 *
 * DESIGN (candidate pool + budgets)
 * ---------------------------------
 * The secret is always one of the 10 curated coprime pairs in POOL, all with
 * an onset on step 0 (the downbeat). The player controls k in [K_MIN..K_MAX]
 * and n in [N_MIN..N_MAX] and can act three ways:
 *
 *   Listen        -2 beats  +1 noise   you hear one full secret cycle
 *                                        (HEARD requires working audio; a
 *                                        listen that never plays charges nothing)
 *   Probe k / n   -4 beats  +2 noise   higher / lower / equal against the
 *                                        value currently entered on that axis.
 *                                        Limited to MAX_PROBES total.
 *   Try (k,n)     -1 beat   +3 noise   correct pair opens the lock; a wrong
 *                                        pair costs noise and tells you nothing
 *                                        but "still locked".
 *
 * The tradeoff is information vs risk:
 *   - Listening is the ONLY information-rich action and it is load-bearing by
 *     rule: probing requires having HEARD the lock first (you calibrate your
 *     pick to its acoustic signature). A player who never listens can never
 *     probe, so blind action-arithmetic cannot be a dominant strategy.
 *   - Probing (3 max) is a strong *verifier*: higher/lower/equal against the
 *     value you entered. With a known 10-pair pool it is powerful enough to
 *     confirm a hypothesis, but it costs more time than listening and, being
 *     gated behind a listen, can only ever refine what the ear started.
 *   - A wrong try costs a third of the noise budget, so you cannot enumerate
 *     the pool blindly — you get at most 2 survivable wrong tries.
 *
 * RESOLUTION ORDER (consistent, tested in tests.js)
 * -----------------------------------------------
 * Charges are applied to every committed action. A CORRECT try wins BEFORE the
 * limit check, so the lock can legitimately "click open on the same beat the
 * guard would have caught you" — that exception only applies to the winning
 * attempt. A wrong try, listen, or probe that pushes noise to NOISE_LIMIT or
 * beats to GUARD_BEATS is a loss.
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

  // Entered-value ranges. The secret is never outside them, but they are wider
  // than the pool so probing is a genuine search, not a menu of the answer.
  const K_MIN = 2, K_MAX = 5;
  const N_MIN = 4, N_MAX = 12;

  // Resource caps. GUARD_BEATS = how many committed beats before the guard
  // arrives; NOISE_LIMIT = noise at which the alarm trips. Being at or past a
  // cap on a non-winning action is a loss.
  const GUARD_BEATS = 20;
  const NOISE_LIMIT = 9;

  // Probing is the strong verifier; capping it stops "always probe both
  // numbers" from dominating. 3 < the 4 probes it takes to pin k and n both.
  const MAX_PROBES = 3;

  // Tempo is FIXED for a challenge (and across challenges) so that timing
  // comparisons between the secret and remembered rhythms stay meaningful.
  const TEMPO_BPM = 100;

  const COSTS = Object.freeze({
    listen: Object.freeze({ beats: 2, noise: 1 }),
    probe: Object.freeze({ beats: 4, noise: 2 }),
    try: Object.freeze({ beats: 1, noise: 3 }),
  });

  const LOSS_REASONS = Object.freeze({
    out_of_time: 'out_of_time',
    too_loud: 'too_loud',
  });

  // Structurally: all pairs coprime so there is exactly one answer candidate
  // per sound (no scale/phase ambiguity). Curated for ear-distinct spacing.
  const POOL = Object.freeze([
    Object.freeze({ k: 2, n: 5 }),
    Object.freeze({ k: 2, n: 7 }),
    Object.freeze({ k: 3, n: 4 }),
    Object.freeze({ k: 3, n: 8 }),
    Object.freeze({ k: 3, n: 10 }),
    Object.freeze({ k: 4, n: 7 }),
    Object.freeze({ k: 5, n: 7 }),
    Object.freeze({ k: 5, n: 8 }),
    Object.freeze({ k: 5, n: 9 }),
    Object.freeze({ k: 5, n: 12 }),
  ]);

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
      probesUsed: 0,
      listenedCount: 0,                                   // heard listens (calibration)
      k: clampK(opts.k !== undefined ? opts.k : 3),      // entered values (never charged)
      n: clampN(opts.n !== undefined ? opts.n : 8),
      attempts: [],                                      // previous tried pairs {k,n}
      history: [],                                       // committed-action log
    };
  }

  const guardRemaining = (r) => GUARD_BEATS - r.beatsUsed;
  const noiseRemaining = (r) => NOISE_LIMIT - r.noise;
  const probesRemaining = (r) => MAX_PROBES - r.probesUsed;
  const isEnded = (r) => r.status !== 'active';

  // Changing inputs is free — only committed actions advance the clock.
  function setK(run, v) { if (run.status === 'active') run.k = clampK(v); }
  function setN(run, v) { if (run.status === 'active') run.n = clampN(v); }

  function compareEntered(entered, target) {
    if (entered === target) return 'equal';
    return entered < target ? 'higher' : 'lower';
  }

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

  function listen(run, opts) {
    if (isEnded(run)) return { ok: false, reason: 'run_ended' };
    if (!opts || opts.heard !== true) return { ok: false, reason: 'audio_unavailable' };
    charge(run, COSTS.listen);
    run.listenedCount += 1;
    pushHistory(run, {
      type: 'listen', label: 'Listen',
      beats: COSTS.listen.beats, noise: COSTS.listen.noise,
      detail: 'Heard one full cycle.',
    });
    const lost = failByLimits(run);
    return {
      ok: true, lost: lost, reason: lost ? run.reason : null,
      charged: COSTS.listen,
      guardRemaining: guardRemaining(run), noiseRemaining: noiseRemaining(run),
    };
  }

  function probe(run, axis) {
    if (isEnded(run)) return { ok: false, reason: 'run_ended' };
    if (run.listenedCount === 0) return { ok: false, reason: 'need_listen' };
    if (axis !== 'k' && axis !== 'n') return { ok: false, reason: 'bad_axis' };
    if (run.probesUsed >= MAX_PROBES) return { ok: false, reason: 'probe_limit' };

    const value = run[axis];
    const result = compareEntered(value, run.secret[axis]);
    charge(run, COSTS.probe);
    run.probesUsed += 1;
    pushHistory(run, {
      type: 'probe', axis: axis, label: 'Probe ' + axis,
      beats: COSTS.probe.beats, noise: COSTS.probe.noise,
      value: value, result: result,
    });
    const lost = failByLimits(run);
    return {
      ok: true, lost: lost, reason: lost ? run.reason : null,
      axis: axis, value: value, result: result, probesUsed: run.probesUsed,
      charged: COSTS.probe,
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
    GUARD_BEATS: GUARD_BEATS, NOISE_LIMIT: NOISE_LIMIT, MAX_PROBES: MAX_PROBES,
    TEMPO_BPM: TEMPO_BPM,
    COSTS: COSTS, POOL: POOL, LOSS_REASONS: LOSS_REASONS,
    secretFromSeed: secretFromSeed, randomSeed: randomSeed,
    clampK: clampK, clampN: clampN,
    createRun: createRun,
    guardRemaining: guardRemaining, noiseRemaining: noiseRemaining,
    probesRemaining: probesRemaining, isEnded: isEnded,
    setK: setK, setN: setN,
    listen: listen, probe: probe, tryCombination: tryCombination,
  });
});