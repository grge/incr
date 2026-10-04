# Topple

*An incremental game about sand, avalanches and patience.*

**Play it:** https://grge.github.io/incr/

A table. A trickle of sand. Every cell can hold three grains; a fourth makes it
**topple**, sending one grain to each neighbour — which may make *them* topple,
and so on, in avalanches that ripple across the whole table. Every topple
throws up a little dust, and dust buys you more sand, more table, and stranger
ways of making the sand stay.

Under the hood the table is a real
[abelian sandpile](https://en.wikipedia.org/wiki/Abelian_sandpile_model) — the
textbook model of *self‑organised criticality*. Pour sand on one cell for long
enough and the famous fractal mandala appears.

## What you do

- **Pour sand** by clicking or holding on cells, and buy **hourglasses** that
  pour for you. New hourglasses join your stack; drag the stack to move it.
- **Every table has its own ground.** Geodes (crystals only grow there, and
  richer ones further out), **dig sites** with things buried in them, and —
  on later tables — bedrock, springs that pour sand of their own, slopes that
  carry sand downhill, and cracks that swallow it.
- **Dig up relics.** Sand toppling on a dig site digs it, so moving your stack
  onto a site (or clicking it) digs fast — at the cost of income while you do.
  The 24 relics are permanent: stones, prisms, doctrines, the fold, trials,
  a pickaxe for bedrock, a weathervane for slopes… The later ones lie deeper,
  under the outer rings that only the largest tables uncover.
- **Grow the table.** Bigger tables keep sand around longer — and uncover what
  lies further out.
- **Stones** reflect sand. Hover a cell while placing (or dragging) and the
  game tells you exactly how much the move would earn or cost.
- **Quake** the table and catch **gleaming grains** for bursts of dust.
- **Sweep** the table to fire the kiln and make **glass** for permanent
  upgrades, then **choose your next table** from the ones on offer.
- Take on **Trials** (runs with strange rules — east winds, crumbling sand,
  no hands), build a **cascade** of tables where sand from one pours onto the
  next, and finally assemble **the Great Hourglass**.

There are no dead ends: buildings can be rearranged freely at any time, stones
can never trap sand, doctrines and tables are chosen afresh every sweep, and
income never stops.

## Running locally

It is a static site with no build step. Serve the folder with any web server
(ES modules don't load from `file://`):

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

## How it's made

Plain JavaScript modules, a canvas and WebAudio — no dependencies.

| File | What it does |
| --- | --- |
| `js/sim.js` | The sandpile: synchronous toppling rounds, stones, terrain (bedrock, slopes, cracks), folding, windy toppling, and a steady-state solver |
| `js/terrain.js` | Seeded table generator: archetypes, geodes, dig sites, bedrock ridges, springs, slope fields, cracks |
| `js/game.js` | Game state and rules: economy, digging, relics, previews, prestige and table choice, trials, cascade, saving |
| `js/data.js` | All content: upgrades, kiln, relics, doctrines, trials, achievements, journal |
| `js/render.js` | Canvas renderer for the table |
| `js/ui.js` | Panels, board interaction, toasts |
| `js/audio.js` | Synthesised sound (no audio files) |
| `tools/bot.mjs` | A headless bot that plays the whole game, used for balancing |
| `tools/calibrate_seq.mjs` | Tunes costs so the bot reaches each unlock at a target time |

### The maths

Because the sandpile is abelian, its long-run behaviour is linear: the average
number of times cell *y* topples per grain dropped at *x* is the Green's
function of the table's (generalised) graph Laplacian. The game solves this
with SOR whenever the layout changes, which gives:

- the exact expected dust per grain dropped on every cell (the *Survey* map),
- exact income for offline progress,
- exact previews of what moving the stack or setting a stone would earn,
- and, by duality, instant re-evaluation when you buy hourglasses.

Slopes and the east wind make the Laplacian non-symmetric, where
over-relaxation can diverge; the solver detects that and falls back to plain
Gauss–Seidel.

Income is the exact steady-state expectation; the table you watch is a faithful
live simulation of the same rules, with its pour rate softly capped so it stays
near the critical state (and keeps its fractal look) even when the real flow is
millions of grains per second.

### Balancing

`node tools/bot.mjs 5 active` plays five hours of the game in under a minute
and prints a timeline (profiles: `active`, `casual`, `idle`) — it digs for
relics, chooses tables and doctrines, and reports the longest stretches with
nothing new happening. `node tools/summary.mjs` compares the profiles'
milestones.
`node tools/calibrate_seq.mjs tools/targets.json` re-tunes costs against the
target schedule in `tools/targets.json`, and `node tools/tune_late.mjs`
jointly tunes trial goals and the late game. `node tools/test.mjs` runs the
logic tests (also run by the deploy workflow).
