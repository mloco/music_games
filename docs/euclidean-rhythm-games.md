# Euclidean Rhythm Games — Design Log

A working exploration of game concepts built on Euclidean rhythms. Six concepts,
progressing from "learn the subject" puzzles toward a world-sim where the rhythm
is a *force* rather than a subject. Five have paste-ready Claude Code build prompts
(noted per concept).

---

## The core instrument

A Euclidean rhythm E(k, n) places **k** onsets as evenly as possible across **n**
steps, optionally shifted by a **rotation** r. Small number changes produce
nameable, musical results — E(3,8) is the tresillo, E(5,8) the Cuban cinquillo,
E(7,12) the bembé. That legibility (number → recognizable feel) is the hook every
concept leans on.

Three number-theory properties do the heavy lifting throughout:

- **Coprimality = richness/validity.** gcd(k,n)=1 means the pattern uses the whole
  cycle with no internal repeat and is rotationally unique. gcd>1 means it's just
  repeated copies of a smaller pattern (E(4,8) = two E(2,4)s). This became the
  central "is this a real rhythm" gate again and again.
- **Complementarity = interlocking.** E(k,n) and E(n−k,n) tile the same bar; two
  patterns perfectly tile when **A XOR B = all-ones**. The complement of a
  maximally-even pattern is itself maximally even.
- **Different cycle lengths = polyrhythm.** Two loops realign only every
  **lcm(n₁,n₂)** beats — an audible number-theory fact.

The recurring difficulty ladder across concepts: **gcd → coprimality/complement →
lcm**.

---

## The six concepts

### 1. Euclidle — cozy daily deduction  *(build prompt written)*

Hear a secret Euclidean rhythm, guess the numbers (k, n), get Wordle-style hi-lo
feedback plus a per-step pattern diff. Daily puzzle, streaks, shareable emoji grid,
codex reveal of the day's named world rhythm.

- **The fork:** is audio *load-bearing* (ear-trainer, stingy feedback) or is it the
  *reward* (numbers guide you, cozy)? **Chose cozy.** Numeric hi-lo + free
  re-listening; the payoff is hearing the groove resolve on a correct solve.
- **Well-posedness rule (critical):** the secret must be coprime and have an audible
  downbeat, or the puzzle is unfair — E(4,8) would sound identical to E(2,4), and
  phase would be ambiguous. Coprimality kills both the scale and phase ambiguities.
- Guess (k, n) only; rotation dropped to a would-be advanced mode. k is countable;
  hearing **n** (the spacing signature) is the real skill.
- Baked-in build choices: pattern diff handles unequal-length guesses honestly
  (align from step 0, show true lengths); re-hearing is free, not budgeted.
- Open item: the named-rhythm codex table was written from memory — the aksak
  (E(4,9)) and bossa (E(5,16)) entries especially should be checked against a real
  reference before shipping as cultural claims.

### 2. Rhythm Factory — number-tile allocation  *(build prompt written)*

A shared pool of number tiles + arithmetic operators. Several target rhythms shown
as necklaces; build each target's (k, n) from the tiles, which are consumed from
one pool. How many grooves can you unlock before the tiles run out?

- **The trap:** an audio-only target = two puzzles in series (deduce the rhythm,
  *then* do the arithmetic). **Fix:** show targets as necklaces so reading k and n
  is trivial and the arithmetic/allocation is the only puzzle.
- Single-target arithmetic is too thin. Depth comes from: the **coprime gate**
  (you can't just reach any two numbers — non-coprime pairs are degenerate rhythms),
  a **shared tile pool** (tiles for a clean k are the ones you wanted for n), and
  **par/elegance scoring**.
- **The fork:** arithmetic (reach the numbers) vs. allocation (spend one pool across
  many targets). **Chose allocation** — the chewier optimization version.
- Baked-in choices: integer division rejects non-integer results (rounding would
  kill the "tiles don't cleanly reach that number" tension); "play all unlocked"
  layers claimed grooves so the round accumulates audibly. Left the match **loose**
  (right final numbers by any path) rather than requiring specific tiles.

### 3. Interlock — boolean-operator circuit puzzle  *(build prompt written)*

Combine Euclidean voices through boolean operators (OR / AND / XOR / NOT / ROT) to
perfectly tile a bar (composite = target mask, no gaps, no collisions).

- **The trap:** pure "complement to fill the bar" is mathematically too clean — the
  numbers are forced, leaving only rotation as a free variable. **Fix:** the
  **operator circuit is the engine** — chain verbs so the composite resolves to the
  target; multiple solutions, solvable by ear (collisions clash, gaps are audible
  silence-holes).
- Win condition generalized to an arbitrary **target mask** (not hardcoded
  all-ones) so forbidden-step puzzles exist without a rewrite.
- Difficulty ladder: same-n coprimality → complement-tiling with forbidden steps →
  mixed lengths (lcm) as bosses.
- Genuinely novel angle noted: **hidden-hand co-op** — each player controls their
  own lanes, can't see the other's rotations, and coordinates purely by ear.
- **The fork:** free variable = rotation (taut puzzler) vs. operator choice (sprawly
  roguelike). Left unresolved; prompt scoped to the single-bar core with roguelike
  scaffolding explicitly out of scope.

### 4. Patrol — polyrhythm stealth gauntlet  *(build prompt written)*

Cross a grid room to an exit. Hazards (patrols) threaten regions on Euclidean
rhythms — deadly on onsets, safe on rests. Find a route through **space and time**.
Beat-stepped (turn-based): the clock advances one beat per action.

- **The trap:** "safety = the globally-quiet beat" makes standing still optimal —
  a game about patience. **Fix:** threat is **per-cell in space-time**; you're
  forced to cross, so the safe path is a route, not a beat. (Frogger with
  polyrhythmic traffic lights.)
- **The diegetic hook that makes it not-lame:** a Euclidean rhythm is the *optimal
  patrol* (maximal evenness = smallest coverage gap). So **evenness = the enemy's
  competence** — sloppy guards patrol lopsided (exploitable gap); the boss patrols
  perfectly even. The math is the antagonist's skill.
- **Sound density = danger:** distinct timbre per hazard; a dense beat = few safe
  cells, a global rest = a silence you dash through. The level sounds exactly as
  dangerous as it is.
- Number theory as level design: the whole threat field repeats every
  **L = lcm(cycle lengths)**; state space is (cell, beat mod L), so a **BFS**
  verifies solvability and yields difficulty metrics. Coprime cycles = long
  sight-read gauntlet; shared factors = short memorizable loop.
- **The fork:** real-time (react) vs. beat-stepped (deliberate). **Chose
  beat-stepped** first — a strict superset that proves the space-time threading
  without the reflex layer; real-time is later "auto-advance the clock."
- Baked-in choices: next-beat danger always visible (the whole skill is looking
  ahead); solvability BFS built for real (untuned rooms can wall off the exit).
- Open question: cone/sightline hazards may be too illegible at prototype fidelity —
  consider rows/columns only for the first pass.

### 5. Genome — rhythm-as-DNA evolution sim  *(minimal build prompt written)*

Each creature *is* a Euclidean pattern; (k, n, phase) is its genome and its way of
being in the world. Considered the most novel concept of the set.

- **The soft center:** an emergence sim with no stakes is a screensaver. The real
  game needs a **player verb + goal**. Frame chosen: **selective breeding toward a
  target** — the world has a food rhythm, and you evolve a population to interlock
  with it. (Held two weaker verbs in reserve: ecosystem gardener; predator/prey as
  a phase-shifting arms race.)
- The genome must *be* the body: **n = metabolism/tempo**, **k/n = effort/density**,
  **spacing = gait/behavior texture**, **phase = social sync**.
- Number theory as lived selection pressure: **coprimality = fertility** (emergent —
  two creatures breed only if their patterns interlock cleanly for a full cycle);
  the **environment's (k,n) = the fitness landscape** (Euclidle inverted — the
  *population* discovers the world's rhythm through selection); a **±1 mutation on n
  can flip a lineage fertile↔sterile** — a dramatic, audible evolutionary event.
- Breeding done right: treat (k, n, phase) as a chromosome and use **crossover +
  mutation**, not OR/XOR of raw patterns (which degenerate toward dense or empty).
- **What we're building first:** a **minimal breed-and-listen sanity check** — no
  energy economy, no death, no player verb, automatic fitness-based selection — to
  answer the one hypothesis the whole concept rests on: *is watching and hearing a
  population converge from noise into the world's groove actually satisfying?*
- Baked-in choices: selection fully automatic (adding player choice would confound
  the test); the **noise → locked-in-groove audio arc** named as a hard requirement,
  since that's the novel hook.
- Open risk on first run: sonifying ~24 creatures at once may turn to mud even when
  genomes have converged — fallback is to sonify a rotating sample of the fittest few.

### 6. (Considered, not built) other "weird" framings

Brainstormed to escape the educational-veggies feel of concepts 1–3, by making the
rhythm a force acting on a world:

- **Orbital mechanics** — onsets as planets; coprime orbits collide only every lcm;
  gcd = phase-locked orbits.
- **Euclidean golf / bouncing ball** — onsets as bumpers; a clean trick-shot is
  audibly a clean rhythm.
- **Dueling metronomes** — onsets as attacks, rests as openings; XOR weaponized
  (hit where they don't defend).
- **Cellular-automaton city** — buildings demand resource on Euclidean schedules;
  SimCity load-balancing with a polyrhythmic clock.
- **Rhythm as a lock / safecracking heist** — deduction (like Euclidle) reframed with
  a noise budget and a guard timer.
- **Idle/incremental** — onsets as production ticks; coprime generator stacks run
  smooth, gcd-sharing ones stutter and waste.

The two flagged as highest weird-to-effort ratio: **Genome** (novelty) and **Patrol**
(fastest path to genuine tension).

---

## Cross-cutting design principles that emerged

1. **Name the fork before building.** Nearly every concept had one axis that
   silently decides the whole genre (audio load-bearing vs. reward; arithmetic vs.
   allocation; rotation vs. operators; real-time vs. beat-stepped; sim vs. game).
2. **Make the number theory *do work*, not be trivia.** The strongest concepts use
   gcd/coprimality/lcm as mechanics (fertility, validity gates, patrol competence,
   level repetition) rather than as facts to memorize.
3. **Audio should be a channel, not decoration.** Best uses: sound density = danger
   (Patrol), noise → groove = population health (Genome), the resolve moment =
   reward (Euclidle), collisions/gaps audible (Interlock).
4. **The necklace visualization is connective tissue** — it makes number → feel
   legible and appears across every concept.
5. **Watch the reskin risk.** Several skeletons are genre-adjacent (Wordle,
   24-game, NecroDancer/Frogger, Conway). The differentiators *are* the game; the
   familiar structure is just the stage.

---

## Status

| # | Name | Genre | Decision | Build prompt |
|---|------|-------|----------|--------------|
| 1 | Euclidle | Daily deduction | Cozy | ✅ full |
| 2 | Rhythm Factory | Tile allocation | Allocation variant | ✅ full |
| 3 | Interlock | Operator-circuit puzzle | Rotation-vs-operator fork open | ✅ core only |
| 4 | Patrol | Polyrhythm stealth | Beat-stepped first | ✅ beat-stepped |
| 5 | Genome | Evolution sim | Minimal sanity check first | ✅ minimal |
| 6 | Weird framings | (assorted) | Genome + Patrol nominated | — |
