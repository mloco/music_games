/* =========================================================================
   GENOME challenge core — pure, deterministic, environment-agnostic.

   A small player-directed breeding challenge: evolve a population of
   rhythm-creatures (each just a Euclidean (k, n, phase)) until one of them
   exactly matches the world's fixed food rhythm before the generation budget
   runs out.

   This module deliberately mirrors the instrument's Euclidean machinery
   (bjorklundRaw/euclid/rotatePattern, per-gene crossover, ±1 mutation) but as
   pure functions with an injected RNG, so the whole challenge can be unit
   tested in Node and driven by the browser UI without any shared mutable
   state.

   Exported as CommonJS (Node require) and window.GenomeChallenge (browser).
   ========================================================================= */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GenomeChallenge = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------------------------- Utils ------------------------------------ */

  function gcd(a, b) {
    a = Math.abs(a); b = Math.abs(b);
    while (b) { [a, b] = [b, a % b]; }
    return a || 1;
  }

  function lcm(a, b) { return Math.abs(a * b) / gcd(a, b); }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function wrap(v, n) { return ((v % n) + n) % n; }

  // Deterministic 32-bit PRNG (mulberry32). Same seed -> same stream.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------------------- Bjorklund -------------------------------- */

  function bjorklundRaw(k, n) {
    let pattern = [];
    const counts = [];
    const remainders = [k];
    let divisor = n - k;
    let level = 0;
    while (true) {
      counts.push(Math.floor(divisor / remainders[level]));
      remainders.push(divisor % remainders[level]);
      divisor = remainders[level];
      level++;
      if (remainders[level] <= 1) break;
    }
    counts.push(divisor);
    function build(lvl) {
      if (lvl === -1) pattern.push(0);
      else if (lvl === -2) pattern.push(1);
      else {
        for (let i = 0; i < counts[lvl]; i++) build(lvl - 1);
        if (remainders[lvl] !== 0) build(lvl - 2);
      }
    }
    build(level);
    return pattern;
  }

  function euclid(k, n) {
    k = clamp(k, 0, n);
    if (k <= 0) return new Array(n).fill(0);
    if (k >= n) return new Array(n).fill(1);
    const raw = bjorklundRaw(k, n);
    const onsets = [];
    for (let i = 0; i < n; i++) if (raw[i]) onsets.push(i);
    let bestOnset = onsets[0], bestGap = -1;
    for (let idx = 0; idx < onsets.length; idx++) {
      const cur = onsets[idx];
      const next = onsets[(idx + 1) % onsets.length];
      const gap = ((next - cur + n) % n) || n;
      if (gap > bestGap) { bestGap = gap; bestOnset = cur; }
    }
    const rotated = new Array(n);
    for (let i = 0; i < n; i++) rotated[i] = raw[(i + bestOnset) % n];
    return rotated;
  }

  function rotatePattern(base, phase) {
    const n = base.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = base[(i + phase) % n];
    return out;
  }

  /* ---------------------------- Creature ---------------------------------- */

  const N_MIN = 4, N_MAX = 16;

  function makeCreature(k, n, phase) {
    n = clamp(Math.round(n), N_MIN, N_MAX);
    k = clamp(Math.round(k), 1, n - 1);
    phase = wrap(Math.round(phase), n);
    return {
      k, n, phase,
      pattern: rotatePattern(euclid(k, n), phase),
      gcd: gcd(k, n),
    };
  }

  /* ---------------------------- Matching score -----------------------------
     F1 score of the creature's onsets against the world's food onsets over
     ONE complete LCM window L = lcm(creature.n, world.N).

       foodHits = steps where both act
       missed   = steps where world has food, creature rests ("missed food")
       wasted   = steps where creature acts, world empty ("activity without food")

     Precision = foodHits / (foodHits + wasted)
     Recall    = foodHits / (foodHits + missed)
     F1        = 2*P*R / (P+R), 0 when no hits.

     Why F1: it is normalized to [0,1] regardless of window length, so
     creatures with different n compare on the same footing (a longer cycle
     scales both the hits and the miss/waste counts proportionally without
     changing the score). It rewards catching food (raises recall), punishes
     acting on empty steps (lowers precision) and missing food (lowers recall),
     gives silence score 0, penalizes excessive density, and is exactly 1 only
     when the creature matches the world at every step of the window.
     ---------------------------------------------------------------------- */
  function scoreMatch(creature, worldPattern, worldN) {
    const n = creature.n;
    const L = lcm(n, worldN);
    let foodHits = 0, missed = 0, wasted = 0;
    for (let i = 0; i < L; i++) {
      const c = creature.pattern[i % n];
      const w = worldPattern[i % worldN];
      if (c === 1 && w === 1) foodHits++;
      else if (c === 1) wasted++;
      else if (w === 1) missed++;
    }
    const precision = (foodHits + wasted) > 0 ? foodHits / (foodHits + wasted) : 0;
    const recall = (foodHits + missed) > 0 ? foodHits / (foodHits + missed) : 0;
    const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    return { f1, foodHits, missed, wasted, L, precision, recall };
  }

  // A creature matches the world exactly iff F1 === 1 over the LCM window.
  function isPerfectMatch(result) { return result.f1 === 1; }

  /* ---------------------------- Breeding -----------------------------------
     Same machinery as the instrument: each gene is independently inherited as
     parent A's value, parent B's value, or the midpoint (rounded); then each
     gene independently nudges by ±1 with probability `rate`. Bounds are
     enforced by makeCreature (n clamped, 1 <= k < n, phase wrapped mod n).
     No fertility/coprimality restriction: any distinct pair may breed.
     ---------------------------------------------------------------------- */
  function crossover(a, b, rng) {
    function gene(ga, gb) {
      const r = rng();
      if (r < 1 / 3) return ga;
      if (r < 2 / 3) return gb;
      return Math.round((ga + gb) / 2);
    }
    return {
      k: gene(a.k, b.k),
      n: gene(a.n, b.n),
      phase: gene(a.phase, b.phase),
    };
  }

  function mutate(genes, rate, rng) {
    let { k, n, phase } = genes;
    if (rng() < rate) n += rng() < 0.5 ? -1 : 1;
    if (rng() < rate) k += rng() < 0.5 ? -1 : 1;
    if (rng() < rate) phase += rng() < 0.5 ? -1 : 1;
    return { k, n, phase };
  }

  function breedChild(parentA, parentB, mutationRate, rng) {
    const genes = mutate(crossover(parentA, parentB, rng), mutationRate, rng);
    return makeCreature(genes.k, genes.n, genes.phase);
  }

  /* ---------------------------- Challenge state --------------------------- */

  const WORLD = {
    K: 5, N: 16, phase: 0,
    pattern: rotatePattern(euclid(5, 16), 0),
  };

  // Starter gene pool: close enough to E(5,16) phase 0 that the challenge is
  // solvable by deliberate breeding — the two top-rated starters, E(4,16) and
  // E(6,16) at phase 0, can cross into k=5 directly — but NOT containing the
  // perfect match itself.
  const STARTER_POPULATION = [
    [4, 16, 0],  // one fewer onset, phase right
    [6, 16, 0],  // one extra onset, phase right
    [5, 15, 0],  // one step shorter cycle
    [5, 14, 0],  // k/phase right-ish on a shorter cycle
    [5, 16, 1],  // phase off by one beat
    [3, 16, 0],  // sparser but aligned
    [5, 13, 0],  // shorter cycle, right k
    [6, 15, 0],  // one extra onset on a shorter cycle
  ];

  const DEFAULT_POPULATION_SIZE = 8;
  const DEFAULT_MUTATION_RATE = 0.15;
  const DEFAULT_BUDGET = 12;
  const DEFAULT_SEED = 20260918;

  function createChallenge(opts) {
    opts = opts || {};
    const seed = opts.seed !== undefined ? opts.seed : DEFAULT_SEED;
    const budget = opts.budget !== undefined ? opts.budget : DEFAULT_BUDGET;
    const mutationRate = opts.mutationRate !== undefined ? opts.mutationRate : DEFAULT_MUTATION_RATE;
    const starter = opts.starter || STARTER_POPULATION;

    function initState() {
      return {
        seed,
        world: { K: WORLD.K, N: WORLD.N, phase: WORLD.phase, pattern: WORLD.pattern.slice() },
        population: starter.map(([k, n, phase]) => makeCreature(k, n, phase)),
        populationSize: DEFAULT_POPULATION_SIZE,
        generation: 0,
        budget,
        mutationRate,
        rng: mulberry32(seed),
        parents: [],           // up to 2 selected population indices
        status: "playing",      // "playing" | "won" | "lost"
        message: "",
        bestF1: 0,
        lastBreed: null,        // { parents, offspring, replaced, generation, winner }
      };
    }

    let state = initState();

    function scorePopulation() {
      let best = 0;
      for (const c of state.population) {
        c.score = scoreMatch(c, state.world.pattern, state.world.N);
        if (c.score.f1 > best) best = c.score.f1;
      }
      state.bestF1 = best;
    }
    scorePopulation();

    function selectedParentCount() { return state.parents.length; }

    // Toggle creature i into/out of the parent slots (at most two, distinct).
    function toggleParent(i) {
      if (state.status !== "playing") return state.parents.slice();
      const pos = state.parents.indexOf(i);
      if (pos !== -1) {
        state.parents.splice(pos, 1);
      } else if (state.parents.length < 2) {
        state.parents.push(i);
      } else {
        state.parents[1] = i;  // replace the second parent
      }
      return state.parents.slice();
    }

    function clearParents() {
      state.parents = [];
      return state.parents.slice();
    }

    // Offspring replace the two weakest creatures, excluding the parents so
    // a selection is never immediately discarded. Population size is fixed.
    function weakestIndicesExcludingParents() {
      const excluded = new Set(state.parents);
      const ranked = state.population
        .map((c, i) => ({ i, f1: c.score.f1 }))
        .filter(({ i }) => !excluded.has(i))
        .sort((x, y) => x.f1 - y.f1);
      return ranked.slice(0, 2).map(({ i }) => i);
    }

    function breed() {
      if (state.status !== "playing") {
        return { ok: false, message: state.status === "won" ? "run already won" : "run already over" };
      }
      if (state.parents.length !== 2) {
        return { ok: false, message: "select two distinct parents" };
      }
      const [pa, pb] = state.parents;
      if (pa === pb) {
        return { ok: false, message: "two distinct parents required" };
      }
      const parentA = state.population[pa];
      const parentB = state.population[pb];

      const offspring = [
        breedChild(parentA, parentB, state.mutationRate, state.rng),
        breedChild(parentA, parentB, state.mutationRate, state.rng),
      ];

      const replacedIndices = weakestIndicesExcludingParents();
      const replacedCreatures = replacedIndices.map(i => state.population[i]);
      // Remove weakest in descending index order so earlier indices stay valid.
      const removedSorted = replacedIndices.slice().sort((a, b) => b - a);
      for (const i of removedSorted) state.population.splice(i, 1);

      // Two offspring -> freed slots (== replaced count, usually 2) hold them.
      for (let i = 0; i < offspring.length; i++) {
        state.population.push(offspring[i]);
      }

      state.generation++;
      scorePopulation();

      const winnerIndex = state.population.findIndex(c => c.score.f1 === 1);
      state.lastBreed = {
        parents: [pa, pb],
        parentCreatures: [parentA, parentB],
        offspring,
        replaced: replacedCreatures,
        generation: state.generation,
      };

      if (winnerIndex !== -1) {
        state.status = "won";
        state.message = `Perfect match! A creature now matches the food rhythm exactly.`;
        state.lastBreed.winner = winnerIndex;
      } else if (state.generation >= state.budget) {
        state.status = "lost";
        state.message = `Generation budget spent — no creature matched the food rhythm.`;
        state.lastBreed.winner = -1;
      } else {
        state.message = ``;
      }
      return { ok: true, state };
    }

    function restart() {
      // Reuse the same state object (mutate in place) so external references
      // taken before a restart keep viewing the live state.
      const next = initState();
      for (const key of Object.keys(next)) state[key] = next[key];
      scorePopulation();
      return state;
    }

    function snapshot() {
      return {
        seed: state.seed,
        generation: state.generation,
        budget: state.budget,
        status: state.status,
        bestF1: state.bestF1,
        message: state.message,
        parents: state.parents.slice(),
        population: state.population.map(c => ({
          k: c.k, n: c.n, phase: c.phase,
          pattern: c.pattern.slice(),
          f1: c.score.f1,
          foodHits: c.score.foodHits,
          missed: c.score.missed,
          wasted: c.score.wasted,
          L: c.score.L,
        })),
      };
    }

    return {
      state,
      scoreMatch,
      isPerfectMatch,
      toggleParent,
      clearParents,
      breed,
      restart,
      snapshot,
      WORLD,
      rescore: scorePopulation,
    };
  }

  return {
    // pure math / scoring / breeding
    gcd, lcm, clamp, wrap, mulberry32,
    euclid, rotatePattern, makeCreature,
    scoreMatch, isPerfectMatch,
    crossover, mutate, breedChild,
    // challenge factory + constants
    createChallenge,
    WORLD, STARTER_POPULATION,
    N_MIN, N_MAX,
    DEFAULT_POPULATION_SIZE, DEFAULT_MUTATION_RATE, DEFAULT_BUDGET, DEFAULT_SEED,
  };
});