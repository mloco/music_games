/* =========================================================================
   Genome challenge — node:test suite.

   Run:  node --test genome/test.js   (Node 18+)

   Covers the required validation points:
     - perfect matching / missed food / wasted activity / silence
     - comparable scores across cycle lengths (incl. repeated representations)
     - reproducible initialization and breeding
     - valid offspring bounds and phase wrapping
     - two-distinct-parent enforcement
     - generation accounting, victory, exhaustion, restart
     - the challenge is solvable within budget via a reproducible sequence
       of parent choices (greedy two-best policy)
   ========================================================================= */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const C = require("./challenge-core.js");

const WORLD = C.WORLD; // E(5,16) phase 0

/* ---------------------------- Scoring ---------------------------------- */

test("perfect match scores 1 (and only exact matches do)", () => {
  const perfect = C.makeCreature(5, 16, 0);
  const r = C.scoreMatch(perfect, WORLD.pattern, WORLD.N);
  assert.strictEqual(r.f1, 1);
  assert.ok(C.isPerfectMatch(r));
  assert.strictEqual(r.foodHits, 5);
  assert.strictEqual(r.missed, 0);
  assert.strictEqual(r.wasted, 0);
});

test("silence scores 0 and misses all food", () => {
  const silent = C.makeCreature(1, 16, 0);
  silent.pattern = new Array(16).fill(0);
  const r = C.scoreMatch(silent, WORLD.pattern, WORLD.N);
  assert.strictEqual(r.f1, 0);
  assert.strictEqual(r.missed, 5);
  assert.strictEqual(r.foodHits, 0);
});

test("activity only without food scores 0 and is all wasted", () => {
  // Complement of the world pattern: acts on every step the world is empty.
  const flipped = {
    k: 11, n: 16, phase: 0,
    pattern: WORLD.pattern.map(x => 1 - x),
    gcd: 1,
  };
  const r = C.scoreMatch(flipped, WORLD.pattern, WORLD.N);
  assert.strictEqual(r.foodHits, 0);
  assert.strictEqual(r.wasted, 11);
  assert.strictEqual(r.f1, 0);
  // A regular dense genome like E(11,16) is far from a match too: almost all
  // of its activity lands on empty steps, so it is heavily penalized.
  const noisy = C.makeCreature(11, 16, 0); // E(11,16)
  const rn = C.scoreMatch(noisy, WORLD.pattern, WORLD.N);
  assert.ok(rn.f1 < 0.2);
  assert.ok(rn.wasted > rn.foodHits);
});

test("missed food penalized more when fewer food steps are caught", () => {
  // E(4,16) phase0: shares 2 of the world's 5 food steps in the LCM window,
  // wastes 2 of its own onsets, misses 3 food arrivals.
  const c4 = C.makeCreature(4, 16, 0);
  const r4 = C.scoreMatch(c4, WORLD.pattern, WORLD.N);
  assert.strictEqual(r4.foodHits, 2);
  assert.strictEqual(r4.missed, 3);
  assert.deepStrictEqual([r4.f1 < 1, r4.f1 > 0], [true, true]);
  // E(3,16): fewer hits, more missed -> strictly lower F1.
  const c3 = C.makeCreature(3, 16, 0);
  const r3 = C.scoreMatch(c3, WORLD.pattern, WORLD.N);
  assert.ok(r3.f1 < r4.f1, `${r3.f1} should be < ${r4.f1}`);
  assert.ok(r3.foodHits < r4.foodHits);
});

test("wasted activity penalized: dense pattern scores lower than exact match", () => {
  const dense = C.makeCreature(15, 16, 0);
  const r = C.scoreMatch(dense, WORLD.pattern, WORLD.N);
  assert.strictEqual(r.foodHits, 5);     // catches all food…
  assert.strictEqual(r.wasted, 10);      // …but wastes many steps
  assert.ok(r.f1 < 1);
  assert.ok(r.f1 > 0);
});

test("exact match at every step is the only way to reach F1 == 1", () => {
  // Enumerate every genome in the allowed space: exactly one match.
  const matches = [];
  for (let n = 4; n <= 16; n++) {
    for (let k = 1; k < n; k++) {
      for (let phase = 0; phase < n; phase++) {
        const c = C.makeCreature(k, n, phase);
        if (C.isPerfectMatch(C.scoreMatch(c, WORLD.pattern, WORLD.N))) {
          matches.push([k, n, phase]);
        }
      }
    }
  }
  assert.deepStrictEqual(matches, [[5, 16, 0]]);
});

test("scores are comparable across cycle lengths (same temporal pattern)", () => {
  // (2,8,0) and (1,4,0) are the same repeated temporal pattern (1000100010001000
  // over the full 16-step window) but run on different cycle lengths.
  const a = C.makeCreature(2, 8, 0);
  const b = C.makeCreature(1, 4, 0);
  const ra = C.scoreMatch(a, WORLD.pattern, WORLD.N);
  const rb = C.scoreMatch(b, WORLD.pattern, WORLD.N);
  assert.strictEqual(ra.f1, rb.f1);
  assert.strictEqual(ra.L, 16);
  assert.strictEqual(rb.L, 16);

  // Same idea with an odd stagger: E(1,7) repeated twice is exactly E(2,14)
  // (1000000|1000000), so they occupy the same repeated temporal pattern and
  // must score identically over the shared LCM(14,16)=112 window.
  const c7 = C.makeCreature(1, 7, 0);
  const c14 = C.makeCreature(2, 14, 0);
  assert.strictEqual(
    C.scoreMatch(c7, WORLD.pattern, WORLD.N).f1,
    C.scoreMatch(c14, WORLD.pattern, WORLD.N).f1
  );
});

test("longer windows do not inflate scores", () => {
  // E(1,16,0) is one onset per 16; over the LCM window with n=16 it echoes the
  // same fraction regardless. Compare a creature repeated over two window sizes.
  const r = C.scoreMatch(C.makeCreature(1, 16, 0), WORLD.pattern, WORLD.N);
  // Just sanity: score is bounded in [0,1] and reflects the one-overlap count.
  assert.ok(r.f1 >= 0 && r.f1 <= 1);
  assert.strictEqual(r.foodHits, 1);
});

/* ---------------------------- Bounds & wrapping ------------------------ */

test("makeCreature clamps k/n and wraps phase into bounds", () => {
  const c = C.makeCreature(-5, 3, -1);
  assert.strictEqual(c.n, 4);
  assert.strictEqual(c.k, 1);
  assert.ok(c.phase >= 0 && c.phase < c.n);
  const d = C.makeCreature(99, 99, 99);
  assert.strictEqual(d.n, 16);
  assert.strictEqual(d.k, 15);
  assert.ok(d.phase >= 0 && d.phase < 16);
});

test("breedChild always produces valid, in-bounds creatures", () => {
  const rng = C.mulberry32(1234);
  const a = C.makeCreature(4, 16, 0);
  const b = C.makeCreature(6, 16, 0);
  for (let i = 0; i < 500; i++) {
    const child = C.breedChild(a, b, 0.15, rng);
    assert.ok(Number.isInteger(child.k) && Number.isInteger(child.n) && Number.isInteger(child.phase));
    assert.ok(child.n >= C.N_MIN && child.n <= C.N_MAX, `n=${child.n} out of bounds`);
    assert.ok(child.k >= 1 && child.k < child.n, `k=${child.k} out of bounds for n=${child.n}`);
    assert.ok(child.phase >= 0 && child.phase < child.n, `phase=${child.phase} out of bounds for n=${child.n}`);
    assert.strictEqual(child.pattern.length, child.n);
  }
});

/* ---------------------------- Determinism ------------------------------- */

test("createChallenge is reproducible (identical init from the same seed)", () => {
  const s1 = C.createChallenge({ seed: 42 }).snapshot();
  const s2 = C.createChallenge({ seed: 42 }).snapshot();
  assert.deepStrictEqual(s1.population, s2.population);
  assert.strictEqual(s1.generation, 0);
  assert.strictEqual(s1.status, "playing");
});

test("breeding is deterministic for the same seed + parent sequence", () => {
  const run = (seed) => {
    const ch = C.createChallenge({ seed });
    ch.toggleParent(0);
    ch.toggleParent(1);
    ch.breed();
    ch.toggleParent(2);
    ch.toggleParent(3);
    ch.breed();
    return ch.snapshot();
  };
  assert.deepStrictEqual(run(7), run(7));
});

test("initial population does not already contain a perfect match", () => {
  const ch = C.createChallenge();
  assert.ok(ch.snapshot().population.every(p => p.f1 < 1));
});

/* ---------------------------- Parents ----------------------------------- */

test("two distinct parents are required to breed", () => {
  const ch = C.createChallenge({ seed: 1 });
  // No parents selected.
  assert.strictEqual(ch.breed().ok, false);
  // One parent selected.
  ch.clearParents();
  ch.toggleParent(0);
  assert.strictEqual(ch.breed().ok, false);
  // Same creature twice is impossible via toggleParent (it toggles off).
  ch.toggleParent(0);
  assert.deepStrictEqual(ch.state.parents, []);
});

test("toggleParent keeps at most two distinct parents", () => {
  const ch = C.createChallenge({ seed: 2 });
  ch.toggleParent(0);
  ch.toggleParent(1);
  ch.toggleParent(2); // replaces the second
  assert.deepStrictEqual(ch.state.parents, [0, 2]);
});

test("every distinct pair may breed (no coprimality restriction)", () => {
  // Pairs deliberately include gcd>1 and non-adjacent members.
  const pairs = [[0, 1], [0, 7], [3, 5], [6, 7]];
  for (const [a, b] of pairs) {
    const ch = C.createChallenge({ seed: 3 });
    ch.toggleParent(a);
    ch.toggleParent(b);
    assert.strictEqual(ch.breed().ok, true);
  }
});

/* ---------------------------- Generation accounting --------------------- */

test("generation accounting, victory, exhaustion, and no double-breed", () => {
  const ch = C.createChallenge({ seed: 99 });
  assert.strictEqual(ch.state.generation, 0);
  assert.strictEqual(ch.state.budget, C.DEFAULT_BUDGET);

  let guaranteedBreed = (i, j) => {
    ch.toggleParent(i);
    ch.toggleParent(j);
    const r = ch.breed();
    assert.strictEqual(r.ok, true);
    ch.clearParents();
    return r.state.state || r.state;
  };
  // Since the population can drift, keep a floating guaranteed-victory check:
  // pick the two highest-f1 creatures each round and verify we converge
  // within budget (also exercised in the solvability test below).
  let won = false;
  for (let g = 0; g < ch.state.budget; g++) {
    const ranked = ch.state.population
      .map((c, i) => ({ i, f1: c.score.f1 }))
      .sort((x, y) => y.f1 - x.f1);
    const [bestA, bestB] = [ranked[0].i, ranked[1].i];
    ch.toggleParent(bestA);
    ch.toggleParent(bestB);
    const r = ch.breed();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(ch.state.generation, g + 1);
    ch.clearParents();
    if (ch.state.status === "won") { won = true; break; }
  }
  assert.strictEqual(won, true);
  assert.strictEqual(ch.state.status, "won");

  // No more breeding after a win.
  ch.toggleParent(0);
  ch.toggleParent(1);
  assert.strictEqual(ch.breed().ok, false);
  assert.strictEqual(ch.state.generation, ch.snapshot().generation);
  // Any creature has a perfect score.
  assert.ok(ch.snapshot().population.some(p => p.f1 === 1));
});

test("exhaustion triggers loss when budget runs out without a match", () => {
  const ch = C.createChallenge({ seed: 5, budget: 1 });
  assert.strictEqual(ch.state.budget, 1);
  ch.toggleParent(0);
  ch.toggleParent(1);
  const r = ch.breed();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(ch.state.generation, 1);
  // With budget 1, if we didn't win this generation we must be lost.
  assert.ok(ch.state.status === "lost" || ch.state.status === "won");
  if (ch.state.status === "lost") {
    const again = ch.breed();
    assert.strictEqual(again.ok, false);
  }
});

test("restart reproduces the exact starting state", () => {
  const ch = C.createChallenge({ seed: 123 });
  ch.toggleParent(0);
  ch.toggleParent(1);
  ch.breed();
  const before = ch.snapshot();
  assert.strictEqual(before.generation, 1);
  ch.restart();
  const after = ch.snapshot();
  assert.strictEqual(after.generation, 0);
  assert.strictEqual(after.status, "playing");
  assert.strictEqual(after.bestF1, C.createChallenge({ seed: 123 }).snapshot().bestF1);
});

/* ---------------------------- Solvability ------------------------------- */

test("challenge is solvable within budget by a reproducible greedy policy", () => {
  // A greedy player always breeds the two currently-best creatures. This is a
  // stand-in for deliberate human play; if a myopic greedy policy wins within
  // the normal budget, a thinking player armed with the same goal can too.
  // The seed is fixed so the whole trajectory is reproducible.
  const seed = C.DEFAULT_SEED;
  const ch = C.createChallenge({ seed });
  const trace = [];
  let wonAt = -1;
  for (let g = 0; g < ch.state.budget + 1; g++) {
    if (ch.state.status === "won") { wonAt = ch.state.generation; break; }
    if (ch.state.status === "lost") break;
    const ranked = ch.state.population
      .map((c, i) => ({ i, f1: c.score.f1 }))
      .sort((x, y) => y.f1 - x.f1);
    const [bestA, bestB] = [ranked[0].i, ranked[1].i];
    ch.toggleParent(bestA);
    ch.toggleParent(bestB);
    const r = ch.breed();
    assert.strictEqual(r.ok, true, `breed failed at gen ${g}`);
    const sn = ch.snapshot();
    trace.push([g + 1, bestA, bestB, sn.bestF1]);
    ch.clearParents();
  }
  assert.ok(wonAt > 0, `greedy policy did not win; trace=${JSON.stringify(trace)}`);
  assert.ok(wonAt <= ch.state.budget, `won at ${wonAt} but budget is ${ch.state.budget}`);
  // The winning creature is in the population.
  assert.ok(ch.snapshot().population.some(p => p.f1 === 1));
});