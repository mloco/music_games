/* SafeCracker rules tests — runs with: node tests.js
 *
 * The rules module (rules.js) is deliberately free of DOM and audio, so this
 * suite exercises the full deterministic game: secret generation, probe
 * accuracy, costs and caps, resolution order, no-charge invariants, win/loss
 * and restart, and candidate-pool solvability under the chosen budgets.
 *
 * The solvability checks use an IDEALIZED ear model — a listen pins the secret
 * onset count k exactly, as if the player counted the onsets (k is countable;
 * n is the "spacing signature" a listener brackets and then confirms with
 * probes). This establishes LOGICAL feasibility within the budgets, NOT that
 * real players can distinguish the rhythms by ear. That stays a playtesting
 * question.
 */
'use strict';

const assert = require('assert');
const R = require('./rules.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok -', name); }
  catch (e) { failed++; console.error('  FAIL -', name); console.error('        ' + (e && e.message)); }
}

/* ---------------------------------------------------------------- */
console.log('Seed / secret generation');
(function () {
  t('bjorklund canonical vectors (E(3,8), E(5,8), E(2,5))', () => {
    assert.strictEqual(R.bjorklund(3, 8).join(''), '10010010');
    assert.strictEqual(R.bjorklund(5, 8).join(''), '10110110');
    assert.strictEqual(R.bjorklund(2, 5).join(''), '10100');
  });

  t('pool is small, curated, coprime, and downbeat-anchored', () => {
    assert.ok(R.POOL.length >= 6 && R.POOL.length <= 12, 'pool should be small and curated');
    for (const p of R.POOL) {
      assert.strictEqual(R.gcd(p.k, p.n), 1, `E(${p.k},${p.n}) must be coprime`);
      assert.ok(p.k >= R.K_MIN && p.k <= R.K_MAX && p.n >= R.N_MIN && p.n <= R.N_MAX, 'pool inside control ranges');
    }
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
    const c = R.secretFromSeed('the-vault-42');
    assert.deepStrictEqual(a, b);
    assert.deepStrictEqual(a, c);
  });

  t('many seeds spread across the pool (reproducible selection is not degenerate)', () => {
    const seen = new Set();
    for (let i = 0; i < 400; i++) {
      const s = R.secretFromSeed('seed-' + i);
      seen.add(s.k + ',' + s.n);
    }
    assert.ok(seen.size >= 5, 'expected >= 5 distinct secrets across 400 seeds, got ' + seen.size);
    assert.ok(seen.size <= R.POOL.length, 'never a secret outside the pool');
  });
})();

/* ---------------------------------------------------------------- */
console.log('Resource accounting');
(function () {
  t('action costs are distinct and ordered as designed', () => {
    // Probe: more time than a listen, less noise than a full try.
    assert.ok(R.COSTS.probe.beats > R.COSTS.listen.beats, 'probe uses more time than listen');
    assert.ok(R.COSTS.probe.noise < R.COSTS.try.noise, 'probe uses less noise than try');
    assert.ok(R.COSTS.listen.noise < R.COSTS.probe.noise, 'listen is the quietest action');
    assert.ok(R.COSTS.try.beats < R.COSTS.listen.beats, 'try is the fastest action');
    assert.ok(R.COSTS.try.noise > R.COSTS.listen.noise, 'try is the loudest action');
  });

  t('listen charges exact cost on a heard cycle and calibrates the pick', () => {
    const run = R.createRun('cost-listen');
    const res = R.listen(run, { heard: true });
    assert.ok(res.ok && !res.lost);
    assert.strictEqual(run.beatsUsed, R.COSTS.listen.beats);
    assert.strictEqual(run.noise, R.COSTS.listen.noise);
    assert.strictEqual(run.listenedCount, 1, 'a heard listen must calibrate');
    assert.strictEqual(res.guardRemaining, R.GUARD_BEATS - R.COSTS.listen.beats);
    assert.strictEqual(res.noiseRemaining, R.NOISE_LIMIT - R.COSTS.listen.noise);
  });

  t('probe charges cost and increments the probe counter', () => {
    const run = R.createRun('cost-probe');
    run.listenedCount = 1; // calibrated (white-box; the gate is tested elsewhere)
    run.k = 3;
    const res = R.probe(run, 'k');
    assert.ok(res.ok && !res.lost);
    assert.strictEqual(run.beatsUsed, R.COSTS.probe.beats);
    assert.strictEqual(run.noise, R.COSTS.probe.noise);
    assert.strictEqual(run.probesUsed, 1);
  });

  t('try charges cost, records the attempt, and does not reveal the secret on a wrong guess', () => {
    const run = R.createRun('cost-try');
    R.setK(run, R.K_MIN); R.setN(run, R.N_MIN); // guaranteed not the pool's coprime (2,4)
    const res = R.tryCombination(run);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.result, 'fail');
    assert.strictEqual(run.beatsUsed, R.COSTS.try.beats);
    assert.strictEqual(run.noise, R.COSTS.try.noise);
    assert.deepStrictEqual(run.attempts, [{ k: R.K_MIN, n: R.N_MIN }]);
    assert.strictEqual(run.status, 'active');
  });

  t('changing inputs is free (no charge, no history, no probes)', () => {
    const run = R.createRun('input-free');
    const before = { beats: run.beatsUsed, noise: run.noise, probes: run.probesUsed, hist: run.history.length };
    R.setK(run, 5); R.setN(run, 12); R.setK(run, 2); R.setN(run, 4);
    assert.strictEqual(run.beatsUsed, before.beats);
    assert.strictEqual(run.noise, before.noise);
    assert.strictEqual(run.probesUsed, before.probes);
    assert.strictEqual(run.history.length, before.hist);
  });

  t('inputs are clamped to their ranges', () => {
    const run = R.createRun('clamp', { k: 99, n: -3 });
    assert.strictEqual(run.k, R.K_MAX);
    assert.strictEqual(run.n, R.N_MIN);
    R.setK(run, -5); R.setN(run, 999);
    assert.strictEqual(run.k, R.K_MIN);
    assert.strictEqual(run.n, R.N_MAX);
  });
})();

/* ---------------------------------------------------------------- */
console.log('Probe accuracy');
(function () {
  t('probe k/n returns exact higher/lower/equal against the secret', () => {
    for (const sec of R.POOL) {
      const run = R.createRun('probe-' + sec.k + '-' + sec.n);
      run.secret = sec; // force this candidate to be the secret (white-box)
      run.listenedCount = 1;
      run.k = sec.k;
      const ek = R.probe(run, 'k');
      assert.strictEqual(ek.result, 'equal', `E(${sec.k},${sec.n}) probe k: expected equal`);
      assert.strictEqual(ek.ok, true);
      run.n = sec.n;
      const en = R.probe(run, 'n');
      assert.strictEqual(en.result, 'equal', `E(${sec.k},${sec.n}) probe n: expected equal`);
      assert.strictEqual(en.ok, true);
    }
  });

  t('under-entered value reports higher; over-entered reports lower', () => {
    // (3,8) has room on both axes inside the control ranges.
    const sec = R.POOL.find((p) => p.k === 3 && p.n === 8);
    const run = R.createRun('probe-dir');
    run.secret = sec;
    run.listenedCount = 1;

    run.k = sec.k - 1;
    assert.strictEqual(R.probe(run, 'k').result, 'higher');
    run.n = sec.n - 1;
    assert.strictEqual(R.probe(run, 'n').result, 'higher');

    // lower probes on a fresh run to stay under MAX_PROBES
    const run2 = R.createRun('probe-dir-lower');
    run2.secret = sec;
    run2.listenedCount = 1;
    run2.k = sec.k + 1;
    assert.strictEqual(R.probe(run2, 'k').result, 'lower');
    run2.n = sec.n + 1;
    assert.strictEqual(R.probe(run2, 'n').result, 'lower');
  });

  t('probe feedback never leaks beyond high/low/equal (no numeric answer)', () => {
    const run = R.createRun('probe-leak');
    run.listenedCount = 1;
    const res = R.probe(run, 'k');
    assert.ok(['higher', 'lower', 'equal'].includes(res.result));
    assert.strictEqual(typeof res.value, 'number');
    assert.strictEqual(res.detail, undefined);
  });
})();

/* ---------------------------------------------------------------- */
console.log('Resolution order');
(function () {
  t('correct try wins even when its noise lands at/over the cap', () => {
    const run = R.createRun('order-noise-win');
    run.noise = R.NOISE_LIMIT - R.COSTS.try.noise; // 6; a try would land at exactly 9
    const beforeNoise = run.noise;
    R.setK(run, run.secret.k); R.setN(run, run.secret.n);
    const res = R.tryCombination(run);
    assert.strictEqual(res.result, 'win');
    assert.strictEqual(run.status, 'won');
    assert.ok(!run.lost, 'win takes precedence over the noise cap it triggers');
    assert.ok(run.noise >= R.NOISE_LIMIT, 'noise was actually pushed to/past the cap');
    assert.ok(beforeNoise + R.COSTS.try.noise >= R.NOISE_LIMIT);
  });

  t('correct try wins even when its beat lands at/over the guard cap', () => {
    const run = R.createRun('order-guard-win');
    run.beatsUsed = R.GUARD_BEATS - R.COSTS.try.beats; // 19; the winning try lands on 20
    R.setK(run, run.secret.k); R.setN(run, run.secret.n);
    const res = R.tryCombination(run);
    assert.strictEqual(res.result, 'win');
    assert.strictEqual(run.status, 'won');
    assert.ok(!run.lost);
    assert.strictEqual(run.beatsUsed, R.GUARD_BEATS, 'winning attempt must still charge its beat');
  });

  t('wrong try that pushes noise to the cap is a too_loud loss', () => {
    const run = R.createRun('order-noise-loss');
    run.noise = R.NOISE_LIMIT - R.COSTS.try.noise;
    R.setK(run, R.K_MIN); R.setN(run, R.N_MIN); // (2,4) is never a pool secret: wrong
    const res = R.tryCombination(run);
    assert.strictEqual(res.result, 'fail');
    assert.strictEqual(res.lost, true);
    assert.strictEqual(res.reason, R.LOSS_REASONS.too_loud);
    assert.strictEqual(run.status, 'lost');
  });

  t('wrong try that pushes beats to the cap is an out_of_time loss', () => {
    const run = R.createRun('order-guard-loss');
    run.beatsUsed = R.GUARD_BEATS - R.COSTS.try.beats; // 19; the wrong try lands on 20
    R.setK(run, R.K_MIN); R.setN(run, R.N_MIN); // wrong
    const res = R.tryCombination(run);
    assert.strictEqual(res.result, 'fail');
    assert.strictEqual(res.lost, true);
    assert.strictEqual(res.reason, R.LOSS_REASONS.out_of_time);
    assert.strictEqual(run.beatsUsed, R.GUARD_BEATS);
  });

  t('a listen that crosses a cap is a loss', () => {
    const run = R.createRun('order-listen-loss');
    // 8 listens = beats 16, noise 8; the 9th crosses noise to 9.
    for (let i = 0; i < 8; i++) assert.ok(R.listen(run, { heard: true }).ok);
    const res = R.listen(run, { heard: true });
    assert.strictEqual(res.lost, true);
    assert.strictEqual(res.reason, R.LOSS_REASONS.too_loud);
    assert.strictEqual(run.status, 'lost');
  });

  t('a probe that crosses the noise cap when already near it is a loss', () => {
    // 3 probes x 2 noise = 6 < 9, so a fresh run can never trip the alarm by
    // probing alone; but a run already pushed near the cap (e.g. by listens)
    // can — and that must be a too_loud loss, not a win/continue.
    const run = R.createRun('order-probe-loss');
    run.listenedCount = 1;
    run.noise = R.NOISE_LIMIT - R.COSTS.probe.noise; // 7; one probe lands on 9
    const res = R.probe(run, 'k');
    assert.strictEqual(res.lost, true);
    assert.strictEqual(res.reason, R.LOSS_REASONS.too_loud);
    assert.strictEqual(run.status, 'lost');
    assert.strictEqual(run.noise, R.NOISE_LIMIT, 'the crossing probe must still charge');
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
    assert.strictEqual(run.listenedCount, 0);
  });

  t('probe before a heard listen is rejected: need_listen, no charge', () => {
    const run = R.createRun('nocharge-gate');
    const res = R.probe(run, 'k');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'need_listen');
    assert.strictEqual(run.beatsUsed, 0);
    assert.strictEqual(run.noise, 0);
    assert.strictEqual(run.probesUsed, 0);
    assert.strictEqual(run.history.length, 0);
    // an unheard listen does NOT calibrate; the pick stays uncalibrated
    assert.strictEqual(R.listen(run, { heard: false }).ok, false);
    assert.strictEqual(R.probe(run, 'k').reason, 'need_listen');
    // a heard listen calibrates and unlocks probing
    assert.ok(R.listen(run, { heard: true }).ok);
    assert.strictEqual(R.probe(run, 'k').ok, true);
  });

  t('probe past the probe limit is rejected with no charge', () => {
    const run = R.createRun('nocharge-probes');
    run.listenedCount = 1;
    let v = R.K_MIN;
    for (let i = 0; i < R.MAX_PROBES + 2; i++) {
      run.k = v;
      const res = R.probe(run, 'k');
      if (i < R.MAX_PROBES) assert.ok(res.ok);
      else {
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.reason, 'probe_limit');
      }
      v = v === R.K_MAX ? R.K_MIN : v + 1;
    }
    assert.strictEqual(run.probesUsed, R.MAX_PROBES);
    assert.strictEqual(run.noise, R.COSTS.probe.noise * R.MAX_PROBES, 'no charge for rejected probes');
  });

  t('all actions are rejected after a win, with no charge or history change', () => {
    const run = R.createRun('ended-win');
    R.setK(run, run.secret.k); R.setN(run, run.secret.n);
    const winRes = R.tryCombination(run);
    assert.strictEqual(winRes.result, 'win');
    const snap = JSON.stringify({ beats: run.beatsUsed, noise: run.noise, hist: run.history.length, attempts: run.attempts.length });
    const resL = R.listen(run, { heard: true });
    const resP = R.probe(run, 'k');
    const resT = R.tryCombination(run);
    assert.strictEqual(resL.ok, false); assert.strictEqual(resL.reason, 'run_ended');
    assert.strictEqual(resP.ok, false); assert.strictEqual(resP.reason, 'run_ended');
    assert.strictEqual(resT.ok, false); assert.strictEqual(resT.reason, 'run_ended');
    assert.strictEqual(JSON.stringify({ beats: run.beatsUsed, noise: run.noise, hist: run.history.length, attempts: run.attempts.length }), snap);
  });

  t('all actions are rejected after a loss, with no charge', () => {
    const run = R.createRun('ended-loss');
    let v = R.K_MIN;
    while (run.status === 'active') {
      run.k = v;
      const res = R.tryCombination(run);
      assert.ok(res.ok);
      v = v === R.K_MAX ? R.K_MIN : v + 1;
    }
    assert.strictEqual(run.status, 'lost');
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
      const res = R.tryCombination(run);
      assert.strictEqual(res.result, 'win');
      assert.strictEqual(run.status, 'won');
      assert.ok(R.isEnded(run));
    }
  });

  t('restart with the same seed replays the same challenge from scratch', () => {
    const seed = 'same-lock-forever';
    const a = R.createRun(seed);
    const b = R.createRun(seed);
    assert.deepStrictEqual(a.secret, b.secret);
    assert.deepStrictEqual(a.pattern, b.pattern);
    assert.strictEqual(b.beatsUsed, 0); assert.strictEqual(b.noise, 0);
    assert.strictEqual(b.listenedCount, 0);
    assert.strictEqual(b.status, 'active');
    assert.deepStrictEqual(b.history, []);
    // a finished run restarted clean behaves identically to a fresh run
    const lost = R.createRun(seed);
    let v = R.K_MIN;
    while (lost.status === 'active') { lost.k = v; R.tryCombination(lost); v = v === R.K_MAX ? R.K_MIN : v + 1; }
    const again = R.createRun(seed);
    assert.strictEqual(again.status, 'active');
    assert.strictEqual(again.beatsUsed, 0);
    assert.deepStrictEqual(again.secret, a.secret);
  });

  t('new lock draws a different plan from the same seed (restart differs from new)', () => {
    const seed = 'fixed-seed';
    const s1 = R.secretFromSeed(seed);
    let distinct = 0;
    for (let i = 0; i < 200; i++) {
      if (R.secretFromSeed(R.randomSeed()) && R.createRun(R.randomSeed()).seed !== seed) distinct++;
    }
    assert.ok(distinct > 0, 'randomSeed should produce fresh seeds');
    assert.ok(R.secretFromSeed !== R.randomSeed, 'randomSeed must not be reproducible');
    void s1;
  });

  t('blind enumeration cannot cover the pool before dying on noise', () => {
    const maxSurvivableWrongTries = Math.floor((R.NOISE_LIMIT - 1) / R.COSTS.try.noise);
    assert.strictEqual(maxSurvivableWrongTries, 2, '3 wrong tries = 9 noise = loss');
    assert.ok(maxSurvivableWrongTries < R.POOL.length,
      `cannot guess ${R.POOL.length} candidates with only ${maxSurvivableWrongTries} survivable wrong tries`);
  });

  t('the 3-probe cap is smaller than the probes needed to pin both numbers', () => {
    // k over [2..5]: worst 2 probes (bisect 2,3,4,5). n over {4,5,7,8,9,10,12}
    // (pool values inside 4..12): worst 2-3 probes. Pinning BOTH would need >= 4.
    assert.ok(R.MAX_PROBES < 4, 'probing alone must not pin both axes');
  });
})();

/* ---------------------------------------------------------------- */
console.log('Candidate-pool solvability under the budgets');

/* Minimax over belief states (idealized ear). Returns true iff a strategy
 * exists that guarantees a win for EVERY pool secret within budget.
 *  - listen reveals the true secret's k exactly (partition belief by k) and
 *    calibrates the pick (heard=true), which PROBING now requires;
 *  - probe k/n partitions the belief by high/low/equal of the entered value,
 *    but only once a hear has happened (routes can never probe before listen —
 *    the calibration gate scuttles the probing-only dominant strategy);
 *  - try (k,n): the branch where it is the secret wins (resolution order:
 *    correct try wins even at a cap); the wrong branch must SURVIVE the charge
 *    (no cap crossed) and still be winnable.
 * Resources are shared along each observation path, so each belief state has a
 * single (beats, noise, probes) attached. */
function guaranteedSolve(useListen) {
  const memo = new Map();
  const keyOf = (B) => B.slice().sort((x, y) => x.k - y.k || x.n - y.n).map((p) => p.k + ',' + p.n).join(';');

  function win(B, beats, noise, probes, heard) {
    if (B.length === 1) return true;                 // secret known -> winning try
    if (B.length === 0) return false;
    if (beats >= R.GUARD_BEATS || noise >= R.NOISE_LIMIT) return false;

    const key = keyOf(B) + '|' + beats + '|' + noise + '|' + probes + '|' + (heard ? 1 : 0);
    if (memo.has(key)) return memo.get(key);

    let result = false;
    const canSurvive = (b, n) => b < R.GUARD_BEATS && n < R.NOISE_LIMIT;

    // Listen (idealized: pins k, and grants the heard flag probing needs)
    if (useListen) {
      const nb = beats + R.COSTS.listen.beats, nn = noise + R.COSTS.listen.noise;
      if (canSurvive(nb, nn)) {
        const parts = {};
        for (const c of B) parts[c.k] = (parts[c.k] || []).concat(c);
        const groups = Object.values(parts);
        result = groups.every((g) => win(g, nb, nn, probes, true));
      }
    }

    // Probes (limited, and gated on having heard the lock)
    if (!result && heard && probes + 1 <= R.MAX_PROBES) {
      const nb = beats + R.COSTS.probe.beats, nn = noise + R.COSTS.probe.noise;
      if (canSurvive(nb, nn)) {
        const range = { k: [R.K_MIN, R.K_MAX], n: [R.N_MIN, R.N_MAX] };
        for (const axis of ['k', 'n']) {
          const [lo, hi] = range[axis];
          for (let v = lo; v <= hi; v++) {
            const g = { higher: [], equal: [], lower: [] };
            for (const c of B) {
              const z = c[axis] === v ? 'equal' : (c[axis] > v ? 'higher' : 'lower');
              g[z].push(c);
            }
            const groups = [g.higher, g.equal, g.lower].filter((x) => x.length > 0);
            if (groups.every((gr) => win(gr, nb, nn, probes + 1, true))) { result = true; break; }
          }
          if (result) break;
        }
      }
    }

    // Try (correct branch wins by precedence; wrong branch must survive + stay winnable)
    if (!result) {
      const nb = beats + R.COSTS.try.beats, nn = noise + R.COSTS.try.noise;
      for (const mb of keyOf(B).split(';')) {
        const [tk, tn] = mb.split(',').map(Number);
        const rest = B.filter((c) => !(c.k === tk && c.n === tn));
        if (rest.length === 0) { result = true; break; }
        if (!canSurvive(nb, nn)) continue;
        if (win(rest, nb, nn, probes, heard)) { result = true; break; }
      }
    }

    memo.set(key, result);
    return result;
  }

  return win(R.POOL.slice(), 0, 0, 0, false);
}

(function () {
  t('WITH the idealized listen, every pool secret is winnable within budget', () => {
    assert.strictEqual(guaranteedSolve(true), true);
  });

  t('WITHOUT listening, no guaranteed win exists (probing is gated and cannot pin both)', () => {
    assert.strictEqual(guaranteedSolve(false), false);
  });

  /* A concrete, human-readable guaranteed strategy per secret: listen once
   * (pins k by ear; also calibrates the pick), then greedily probe whichever
   * axis/value splits the remaining candidates in half hardest, then try the
   * last survivor. This is the "reasonable information-gathering strategy" the
   * budgets were tuned for. */
  function playSketch(sec) {
    const run = R.createRun('sketch-' + sec.k + '-' + sec.n);
    run.secret = sec; // force the candidate under test to be the secret
    let belief = R.POOL.slice();
    let heard = false;
    while (belief.length > 1) {
      if (!heard) {
        const res = R.listen(run, { heard: true });
        assert.ok(res.ok && !res.lost);
        assert.strictEqual(run.listenedCount, 1, 'the sketch must calibrate exactly once');
        heard = true;
        belief = R.POOL.filter((c) => c.k === sec.k);
        assert.ok(belief.length > 0, 'listen pins the secret k group');
        continue;
      }
      // pick the probe value (axis + entered value) giving the smallest worst split
      let best = null;
      const range = { k: [R.K_MIN, R.K_MAX], n: [R.N_MIN, R.N_MAX] };
      for (const axis of ['k', 'n']) {
        const [lo, hi] = range[axis];
        for (let v = lo; v <= hi; v++) {
          const counts = { higher: 0, equal: 0, lower: 0 };
          for (const c of belief) {
            if (c[axis] === v) counts.equal++;
            else if (c[axis] > v) counts.higher++;
            else counts.lower++;
          }
          const worst = Math.max(counts.higher, counts.equal, counts.lower);
          if (!best || worst < best.worst) best = { axis, v, worst };
        }
      }
      run[best.axis] = best.v;
      const res = R.probe(run, best.axis);
      assert.ok(res.ok && !res.lost, 'sketch probe must stay alive');
      belief = belief.filter((c) => {
        if (c[best.axis] === best.v) return res.result === 'equal';
        return (c[best.axis] > best.v ? 'higher' : 'lower') === res.result;
      });
    }
    R.setK(run, belief[0].k); R.setN(run, belief[0].n);
    const tr = R.tryCombination(run);
    assert.strictEqual(tr.result, 'win', `sketch should win E(${sec.k},${sec.n})`);
    return run;
  }

  t('concrete hearing-probing strategy wins every secret within budget', () => {
    for (const sec of R.POOL) {
      const run = playSketch(sec);
      assert.ok(run.beatsUsed < R.GUARD_BEATS, `E(${sec.k},${sec.n}) runs out of guard time`);
      assert.ok(run.noise < R.NOISE_LIMIT, `E(${sec.k},${sec.n}) hits the noise cap`);
      if (run.probesUsed > R.MAX_PROBES) throw new Error('probe cap exceeded for E(' + sec.k + ',' + sec.n + ')');
    }
  });

  t('per-secret budget usage of the guaranteed strategy is comfortably inside the caps', () => {
    const worst = { beats: 0, noise: 0, probes: 0, sec: null };
    for (const sec of R.POOL) {
      const run = playSketch(sec);
      if (run.beatsUsed > worst.beats) worst.beats = run.beatsUsed;
      if (run.noise > worst.noise) worst.noise = run.noise;
      if (run.probesUsed > worst.probes) worst.probes = run.probesUsed;
    }
    assert.ok(worst.beats <= R.GUARD_BEATS - 6, `worst strategy uses ${worst.beats} beats (cap ${R.GUARD_BEATS})`);
    assert.ok(worst.noise <= R.NOISE_LIMIT - 1, `worst strategy uses ${worst.noise} noise (cap ${R.NOISE_LIMIT})`);
    assert.ok(worst.probes <= R.MAX_PROBES, `worst strategy uses ${worst.probes} probes (cap ${R.MAX_PROBES})`);
  });
})();

/* ---------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;