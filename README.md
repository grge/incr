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
  pour for you. Hourglasses stack; where you put the stack matters.
- **Grow the table.** Bigger tables keep sand around longer, so each grain
  causes more topples.
- **Crystals** make topples on their cell worth more; **prisms** make the
  crystals they touch shine brighter. Put them where the sand falls hardest.
- **Stones** reflect sand. Wall in your hourglasses — but always leave a way
  out — and grains linger, toppling again and again.
- **Quake** the table and catch **gleaming grains** for bursts of dust.
- **Sweep** the table to fire the kiln and make **glass**, which buys permanent
  upgrades, automation, doctrines and new ways to play.
- Take on **Trials** (runs with strange rules — east winds, crumbling sand,
  no hands), build a **cascade** of tables where sand from one pours onto the
  next, and finally assemble **the Great Hourglass**.

There are no dead ends: buildings can be rearranged freely at any time,
doctrines can be changed every sweep, and income never stops.

A full playthrough to the ending is roughly 4½–6 hours of play (about 4h40m
if you play actively, longer if you play idly — the game keeps earning while
the tab is closed). New mechanics keep arriving the whole way: the kiln at
~20 minutes, stones within the hour, doctrines, the fold and prisms in the
second hour, trials and a cascade of tables in the third, and the Great
Hourglass in the fourth.

## Tips

- **Survey** (S) shows where a grain is worth most (*value*) and where the table
  topples most (*flow*). Hourglasses want value; crystals want flow.
- Drag hourglasses and buildings to move them. Drag them off the table, or
  right-click, to put them back in your pocket.
- Keys: **Q** quake · **S** survey · **1–3** switch tables · **Esc** cancel.

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
| `js/sim.js` | The sandpile: synchronous toppling rounds, stones, folding, biased (windy) toppling, and a steady-state solver |
| `js/game.js` | Game state and rules: economy, prestige, trials, cascade, saving |
| `js/data.js` | All content: upgrades, kiln, trials, achievements, journal |
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
- and, by duality, instant re-evaluation when you buy hourglasses.

Income is the exact steady-state expectation; the table you watch is a faithful
live simulation of the same rules, with its pour rate softly capped so it stays
near the critical state (and keeps its fractal look) even when the real flow is
millions of grains per second.

### Balancing

`node tools/bot.mjs 5 active` plays five hours of the game in a few seconds
and prints a timeline (profiles: `active`, `casual`, `idle`), and
`node tools/summary.mjs` compares the profiles' milestones.
`node tools/calibrate_seq.mjs tools/targets.json` re-tunes costs against the
target schedule in `tools/targets.json`, and `node tools/tune_late.mjs`
jointly tunes trial goals and the late game. `node tools/test.mjs` runs the
logic tests (also run by the deploy workflow).
