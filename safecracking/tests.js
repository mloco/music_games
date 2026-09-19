/* SafeCracker rules tests — runs with: node tests.js
 *
 * The rules module (rules.js) is deliberately free of DOM and audio, so this
 * suite exercises the full deterministic game: secret generation, the listen
 * schedule (what the ear gets), costs and caps, resolution order, no-charge
 * invariants, win/loss and restart, and candidate-pool solvability under the
 * chosen budgets.
 *
 * The solvability checks use an IDEALIZED ear model DERIVED FROM THE LISTEN
 * SCHEDULE (see hear()): the player counts lock hits between two lock
 * downbeats (k) and hears whether their dial downbeat lands on, behind, or
 * ahead of the lock's second downbeat (direction of n). It deliberately does
 * NOT credit hearing drift size. This establishes LOGICAL feasibility within
 * the budgets, NOT that real players hear the drift reliably. That stays a
 * playtesting question.
 */
'use strict';

const assert = require('assert');
const R = require('./rules.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok -', name); }
  catch (e) { failed++; console.error('  FAIL -', name); console.error('        ' + (e && e.message)); }
}

/* What an attentive ear extracts from one listen of `secret` against `dial`.
 * Returns the secret's k and where the secret's n sits relative to the dial. */
function hear(secret, dial) {
  const ev = R.listenSchedule(secret, dial);
  const steps = (voice) => ev.filter((e) => e.voice === voice).map((e) => e.step);
  const lockDowns = steps('lockDownbeat');
  const dialDowns = steps('dialDownbeat');
  const k = ev.filter((e) => e.voice.startsWith('lock') && e.step < lockDowns[1]).length;
  const drift = dialDowns[1] - lockDowns[1];   // > 0: dial lags -> dial n too high
  return { k: k, n: drift === 0 ? 'equal' : (drift > 0 ? 'lower' : 'higher') };
}

/* ---------------------------------------------------------------- */
console.log('Seed / secret generation');
(function () {
  t('bjorklund canonical vectors (E(3,8), E(5,8), E(2,5))', () => {
    assert.strictEqual(R.bjorklund(3, 8).join(''), '10010010');
    assert.strictEqual(R.bjorklund(5, 8).join(''), '10110110');
    assert.strictEqual(R.bjorklund(2, 5).join(''), '10100');
  });

  t('pool is every coprime pair in range, and nothing else', () => {
    for (const p of R.POOL) {
      assert.strictEqual(R.gcd(p.k, p.n), 1, `E(${p.k},${p.n}) must be coprime`);
      assert.ok(p.k >= R.K_MIN && p.k <= R.K_MAX && p.n >= R.N_MIN && p.n <= R.N_MAX, 'pool inside dial ranges');
      assert.ok(p.k < p.n, 'at least one rest');
    }
    let expected = 0;
    for (let k = R.K_MIN; k <= R.K_MAX; k++) {
      for (let n = R.N_MIN; n <= R.N_MAX; n++) if (k < n && R.gcd(k, n) === 1) expected++;
    }
    assert.strictEqual(R.POOL.length, expected);
  });

  t('every pool pattern: length n, k onsets, onset on step 0 (downbeat)', () => {
    for (const p of R.POOL) {
      const pat = R.bjorklund(p.k, p.n);
      assert.strictEqual(pat.length, p.n);
      assert.strictEqual(pat.reduce((a, b) => a + b, 0), p.k);
      assert.strictEqual(pat[0], 1, `step 0 of E(${p.k},${p.n}) must be an onset`);
    }
  });

  t('same seed -> same secret, reproducibly', () => {
    const a = R.secretFromSeed('the-vault-42');
    const b = R.secretFromSeed('the-vault-42');
    assert.deepStrictEqual(a, b);
  });

  t('many seeds spread across the pool (reproducible selection is not degenerate)', () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) {
      const s = R.secretFromSeed('seed-' + i);
      seen.add(s.k + ',' + s.n);
    }
    assert.ok(seen.size >= R.POOL.length - 2, `expected most of the pool across 1000 seeds, got ${seen.size}`);
    assert.ok(seen.size <= R.POOL.length, 'never a secret outside the pool');
  });
})();

/* ---------------------------------------------------------------- */
console.log('Listen schedule (the contact point)');
(function () {
  const dials = [];
  for (let k = R.K_MIN; k <= R.K_MAX; k++) for (let n = R.N_MIN; n <= R.N_MAX; n++) dials.push({ k, n });

  t('listen length is fixed and independent of the secret (duration leaks nothing)', () => {
    assert.ok(R.LISTEN_STEPS >= 2 * R.N_MAX + 1, 'even the longest lock must repeat within a listen');
    for (const sec of R.POOL) {
      const ev = R.listenSchedule(sec, { k: 3, n: 8 });
      assert.ok(ev.every((e) => e.step >= 0 && e.step < R.LISTEN_STEPS));
    }
  });

  t('lock and dial both loop from a shared downbeat on step 0', () => {
    for (const sec of R.POOL) {
      for (const d of dials) {
        const ev = R.listenSchedule(sec, d);
        const lockDowns = ev.filter((e) => e.voice === 'lockDownbeat').map((e) => e.step);
        const dialDowns = ev.filter((e) => e.voice === 'dialDownbeat').map((e) => e.step);
        assert.deepStrictEqual(lockDowns, Array.from({ length: Math.ceil(R.LISTEN_STEPS / sec.n) }, (_, i) => i * sec.n));
        assert.deepStrictEqual(dialDowns, Array.from({ length: Math.ceil(R.LISTEN_STEPS / d.n) }, (_, i) => i * d.n));
      }
    }
  });

  t('dial == lock: every hit fuses (full unison)', () => {
    for (const sec of R.POOL) {
      const ev = R.listenSchedule(sec, sec);
      const lock = ev.filter((e) => e.voice.startsWith('lock')).map((e) => e.step);
      const dial = ev.filter((e) => e.voice.startsWith('dial')).map((e) => e.step);
      assert.deepStrictEqual(lock, dial);
    }
  });

  t('right n, wrong k: downbeats fuse but some hits flam', () => {
    for (const sec of R.POOL) {
      for (let k = R.K_MIN; k <= R.K_MAX; k++) {
        if (k === sec.k) continue;
        const ev = R.listenSchedule(sec, { k, n: sec.n });
        const downs = (v) => ev.filter((e) => e.voice === v).map((e) => e.step);
        assert.deepStrictEqual(downs('lockDownbeat'), downs('dialDownbeat'));
        const lock = new Set(ev.filter((e) => e.voice.startsWith('lock')).map((e) => e.step));
        const dial = new Set(ev.filter((e) => e.voice.startsWith('dial')).map((e) => e.step));
        const mismatch = [...lock].some((s) => !dial.has(s)) || [...dial].some((s) => !lock.has(s));
        assert.ok(mismatch, `E(${k},${sec.n}) must sound different from E(${sec.k},${sec.n})`);
      }
    }
  });

  t('wrong n: dial downbeat drifts by (n_dial - n_lock) more steps every cycle', () => {
    for (const sec of R.POOL) {
      for (const d of dials) {
        if (d.n === sec.n) continue;
        const ev = R.listenSchedule(sec, d);
        const lockDowns = ev.filter((e) => e.voice === 'lockDownbeat').map((e) => e.step);
        const dialDowns = ev.filter((e) => e.voice === 'dialDownbeat').map((e) => e.step);
        const cycles = Math.min(lockDowns.length, dialDowns.length);
        assert.ok(cycles >= 2, 'at least one drift comparison per listen');
        for (let c = 1; c < cycles; c++) {
          assert.strictEqual(dialDowns[c] - lockDowns[c], c * (d.n - sec.n));
        }
      }
    }
  });

  t('the ear model recovers k and the direction of n for every lock x dial', () => {
    for (const sec of R.POOL) {
      for (const d of dials) {
        const h = hear(sec, d);
        assert.strictEqual(h.k, sec.k);
        assert.strictEqual(h.n, sec.n === d.n ? 'equal' : (sec.n > d.n ? 'higher' : 'lower'));
      }
    }
  });
})();

/* ---------------------------------------------------------------- */
console.log('Resource accounting');
(function () {
  t('listen is quiet but slow; try is fast but loud', () => {
    assert.ok(R.COSTS.try.beats < R.COSTS.listen.beats, 'try is the fastest action');
    assert.ok(R.COSTS.try.noise > R.COSTS.listen.noise, 'try is the loudest action');
  });

  t('listen charges exact cost and records the dial it was heard against', () => {
    const run = R.createRun('cost-listen', { k: 4, n: 9 });
    const res = R.listen(run, { heard: true });
    assert.ok(res.ok && !res.lost);
    assert.strictEqual(run.beatsUsed, R.COSTS.listen.beats);
    assert.strictEqual(run.noise, R.COSTS.listen.noise);
    assert.strictEqual(res.guardRemaining, R.GUARD_BEATS - R.COSTS.listen.beats);
    assert.strictEqual(res.noiseRemaining, R.NOISE_LIMIT - R.COSTS.listen.noise);
    const h = run.history[0];
    assert.strictEqual(h.type, 'listen');
    assert.strictEqual(h.k, 4); assert.strictEqual(h.n, 9);
  });

  t('listen result and history never carry a verdict (the audio is the only answer)', () => {
    const run = R.createRun('listen-leak');
    R.setK(run, run.secret.k); R.setN(run, run.secret.n);
    const res = R.listen(run, { heard: true });
    for (const obj of [res, run.history[0]]) {
      assert.strictEqual(obj.result, undefined);
      assert.strictEqual(obj.detail, undefined);
    }
  });

  t('try charges cost, records the attempt, and does not reveal the secret on a wrong guess', () => {
    const run = R.createRun('cost-try');
    R.setK(run, R.K_MIN); R.setN(run, R.N_MIN); // (2,4) is not coprime: never a secret
    const res = R.tryCombination(run);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.result, 'fail');
    assert.strictEqual(run.beatsUsed, R.COSTS.try.beats);
    assert.strictEqual(run.noise, R.COSTS.try.noise);
    assert.deepStrictEqual(run.attempts, [{ k: R.K_MIN, n: R.N_MIN }]);
    assert.strictEqual(run.status, 'active');
  });

  t('turning the dial is free (no charge, no history)', () => {
    const run = R.createRun('input-free');
    R.setK(run, 5); R.setN(run, 12); R.setK(run, 2); R.setN(run, 4);
    assert.strictEqual(run.beatsUsed, 0);
    assert.strictEqual(run.noise, 0);
    assert.strictEqual(run.history.length, 0);
  });

  t('dial values are clamped to their ranges', () => {
    const run = R.createRun('clamp', { k: 99, n: -3 });
    assert.strictEqual(run.k, R.K_MAX);
    assert.strictEqual(run.n, R.N_MIN);
    R.setK(run, -5); R.setN(run, 999);
    assert.strictEqual(run.k, R.K_MIN);
    assert.strictEqual(run.n, R.N_MAX);
  });
})();

/* ---------------------------------------------------------------- */
console.log('Resolution order');
(function () {
  t('correct try wins even when its noise lands at/over the cap', () => {
    const run = R.createRun('order-noise-win');
    run.noise = R.NOISE_LIMIT - R.COSTS.try.noise;
    R.setK(run, run.secret.k); R.setN(run, run.secret.n);
    const res = R.tryCombination(run);
    assert.strictEqual(res.result, 'win');
    assert.strictEqual(run.status, 'won');
    assert.ok(!run.lost, 'win takes precedence over the noise cap it triggers');
    assert.ok(run.noise >= R.NOISE_LIMIT, 'noise was actually pushed to/past the cap');
  });

  t('correct try wins even when its beat lands at/over the guard cap', () => {
    const run = R.createRun('order-guard-win');
    run.beatsUsed = R.GUARD_BEATS - R.COSTS.try.beats;
    R.setK(run, run.secret.k); R.setN(run, run.secret.n);
    const res = R.tryCombination(run);
    assert.strictEqual(res.result, 'win');
    assert.ok(!run.lost);
    assert.strictEqual(run.beatsUsed, R.GUARD_BEATS, 'winning attempt must still charge its beat');
  });

  t('wrong try that pushes noise to the cap is a too_loud loss', () => {
    const run = R.createRun('order-noise-loss');
    run.noise = R.NOISE_LIMIT - R.COSTS.try.noise;
    R.setK(run, R.K_MIN); R.setN(run, R.N_MIN); // wrong
    const res = R.tryCombination(run);
    assert.strictEqual(res.lost, true);
    assert.strictEqual(res.reason, R.LOSS_REASONS.too_loud);
    assert.strictEqual(run.status, 'lost');
  });

  t('wrong try that pushes beats to the cap is an out_of_time loss', () => {
    const run = R.createRun('order-guard-loss');
    run.beatsUsed = R.GUARD_BEATS - R.COSTS.try.beats;
    R.setK(run, R.K_MIN); R.setN(run, R.N_MIN); // wrong
    const res = R.tryCombination(run);
    assert.strictEqual(res.lost, true);
    assert.strictEqual(res.reason, R.LOSS_REASONS.out_of_time);
    assert.strictEqual(run.beatsUsed, R.GUARD_BEATS);
  });

  t('a listen that crosses the guard cap is a loss', () => {
    const run = R.createRun('order-listen-loss');
    const safe = Math.ceil(R.GUARD_BEATS / R.COSTS.listen.beats) - 1;
    for (let i = 0; i < safe; i++) assert.ok(!R.listen(run, { heard: true }).lost);
    const res = R.listen(run, { heard: true });
    assert.strictEqual(res.lost, true);
    assert.strictEqual(res.reason, R.LOSS_REASONS.out_of_time);
    assert.strictEqual(run.status, 'lost');
  });
})();

/* ---------------------------------------------------------------- */
console.log('Invalid actions are rejected without charge');
(function () {
  t('listen with no heard audio charges nothing and is not recorded', () => {
    const run = R.createRun('nocharge-audio');
    const res = R.listen(run, { heard: false });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'audio_unavailable');
    assert.strictEqual(run.beatsUsed, 0);
    assert.strictEqual(run.noise, 0);
    assert.strictEqual(run.history.length, 0);
  });

  t('all actions are rejected after a win, with no charge or history change', () => {
    const run = R.createRun('ended-win');
    R.setK(run, run.secret.k); R.setN(run, run.secret.n);
    assert.strictEqual(R.tryCombination(run).result, 'win');
    const snap = JSON.stringify({ beats: run.beatsUsed, noise: run.noise, hist: run.history.length, attempts: run.attempts.length });
    const resL = R.listen(run, { heard: true });
    const resT = R.tryCombination(run);
    assert.strictEqual(resL.ok, false); assert.strictEqual(resL.reason, 'run_ended');
    assert.strictEqual(resT.ok, false); assert.strictEqual(resT.reason, 'run_ended');
    assert.strictEqual(JSON.stringify({ beats: run.beatsUsed, noise: run.noise, hist: run.history.length, attempts: run.attempts.length }), snap);
  });

  t('all actions are rejected after a loss, with no charge', () => {
    const run = R.createRun('ended-loss');
    R.setK(run, R.K_MIN); R.setN(run, R.N_MIN); // never a secret
    while (run.status === 'active') assert.ok(R.tryCombination(run).ok);
    const snap = JSON.stringify({ beats: run.beatsUsed, noise: run.noise, hist: run.history.length });
    const res = R.listen(run, { heard: true });
    assert.strictEqual(res.ok, false); assert.strictEqual(res.reason, 'run_ended');
    assert.strictEqual(JSON.stringify({ beats: run.beatsUsed, noise: run.noise, hist: run.history.length }), snap);
  });
})();

/* ---------------------------------------------------------------- */
console.log('Win / loss / restart');
(function () {
  t('direct correct try wins for every secret', () => {
    for (const sec of R.POOL) {
      const run = R.createRun('win-each-' + sec.k + '-' + sec.n);
      run.secret = sec; // force the candidate under test to be the secret
      R.setK(run, sec.k); R.setN(run, sec.n);
      assert.strictEqual(R.tryCombination(run).result, 'win');
      assert.ok(R.isEnded(run));
    }
  });

  t('restart with the same seed replays the same challenge from scratch', () => {
    const seed = 'same-lock-forever';
    const a = R.createRun(seed);
    R.listen(a, { heard: true });
    const b = R.createRun(seed);
    assert.deepStrictEqual(a.secret, b.secret);
    assert.deepStrictEqual(a.pattern, b.pattern);
    assert.strictEqual(b.beatsUsed, 0); assert.strictEqual(b.noise, 0);
    assert.strictEqual(b.status, 'active');
    assert.deepStrictEqual(b.history, []);
  });

  t('blind enumeration cannot cover the pool before dying on noise', () => {
    const maxSurvivableWrongTries = Math.floor((R.NOISE_LIMIT - 1) / R.COSTS.try.noise);
    assert.ok(maxSurvivableWrongTries < R.POOL.length);
  });
})();

/* ---------------------------------------------------------------- */
console.log('Candidate-pool solvability under the budgets');

/* Minimax over belief states. Returns the fewest beats that GUARANTEE a win
 * for every secret in the pool (Infinity if none within budget), given an ear:
 *   'contact' — hear(): k + direction of n against the dial (the real game)
 *   'countK'  — only counts k (the old "count hits, then guess n upward" play)
 *   'deaf'    — never listens
 * Listen with dial n=v partitions the belief by what the ear reports. Try:
 * the branch where it is the secret wins (resolution order: correct try wins
 * even at a cap); the wrong branch must SURVIVE the charge and stay winnable. */
function minBeatsToGuarantee(ear) {
  const memo = new Map();
  const keyOf = (B) => B.map((p) => p.k + ',' + p.n).sort().join(';');
  const canSurvive = (b, n) => b < R.GUARD_BEATS && n < R.NOISE_LIMIT;

  function cost(B, beats, noise) {
    if (B.length === 0) return Infinity;
    if (B.length === 1) return beats + R.COSTS.try.beats;   // winning try (precedence)
    const key = keyOf(B) + '|' + beats + '|' + noise;
    if (memo.has(key)) return memo.get(key);

    let best = Infinity;
    if (ear !== 'deaf') {
      const nb = beats + R.COSTS.listen.beats, nn = noise + R.COSTS.listen.noise;
      if (canSurvive(nb, nn)) {
        for (let v = R.N_MIN; v <= R.N_MAX; v++) {
          const parts = new Map();
          for (const c of B) {
            const h = hear(c, { k: 3, n: v });
            const obs = ear === 'contact' ? h.k + h.n : String(h.k);
            parts.set(obs, (parts.get(obs) || []).concat(c));
          }
          if (parts.size < 2) continue;
          let worst = 0;
          for (const g of parts.values()) worst = Math.max(worst, cost(g, nb, nn));
          best = Math.min(best, worst);
        }
      }
    }

    const nb = beats + R.COSTS.try.beats, nn = noise + R.COSTS.try.noise;
    for (const guess of B) {
      const rest = B.filter((c) => c !== guess);
      // correct branch finishes at nb; wrong branch must survive and continue
      const wrong = canSurvive(nb, nn) ? cost(rest, nb, nn) : Infinity;
      best = Math.min(best, Math.max(nb, wrong));
    }

    memo.set(key, best);
    return best;
  }

  const c = cost(R.POOL.slice(), 0, 0);
  return c <= R.GUARD_BEATS ? c : Infinity;
}

(function () {
  const contact = minBeatsToGuarantee('contact');

  t('WITH the contact-point ear, every pool secret is winnable within budget', () => {
    assert.ok(Number.isFinite(contact), 'no guaranteed strategy found');
  });

  t('a perfect ear still leaves >= 3 spare listens for real, imperfect ears', () => {
    const spare = Math.floor((R.GUARD_BEATS - contact) / R.COSTS.listen.beats);
    assert.ok(spare >= 3, `perfect play needs ${contact} of ${R.GUARD_BEATS} beats (${spare} spare listens)`);
  });

  t('counting k alone (the old strategy) cannot guarantee a win', () => {
    assert.strictEqual(minBeatsToGuarantee('countK'), Infinity);
  });

  t('without listening, no guaranteed win exists', () => {
    assert.strictEqual(minBeatsToGuarantee('deaf'), Infinity);
  });
})();

/* ---------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
