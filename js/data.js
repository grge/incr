// Game content: buildings, upgrades, kiln (prestige) upgrades, doctrines,
// trials, achievements, journal entries and the Great Hourglass.
import { CRYSTAL, STONE, PRISM } from './sim.js';

export const ROUNDS_PER_SEC = 30;
export const START_SIZE = 5;

export const BUILDINGS = {
  hourglass: {
    kind: -1, name: 'Hourglass', icon: '⧗', base: 10, growth: 1.15,
    desc: 'Pours a steady trickle of sand. Hourglasses stack: put them where sand does the most good.',
  },
  crystal: {
    kind: CRYSTAL, name: 'Crystal', icon: '◆', base: 1500, growth: 1.9, unlock: 'crystal',
    desc: 'Topples on this cell are worth much more dust.',
  },
  stone: {
    kind: STONE, name: 'Stone', icon: '●', base: 2.5e5, growth: 2.2, unlock: 'stone',
    desc: 'Blocks sand. Grains sent towards a stone bounce back, so sand lingers nearby.',
  },
  prism: {
    kind: PRISM, name: 'Prism', icon: '▲', base: 5e9, growth: 3.5, unlock: 'prism',
    desc: 'Each adjacent crystal shines brighter. Diagonals do not count.',
  },
};
export const KIND_TO_BUILDING = { [CRYSTAL]: 'crystal', [STONE]: 'stone', [PRISM]: 'prism' };

// Owning this many hourglasses doubles their flow (each milestone).
export const HG_MILESTONES = Array.from({ length: 60 }, (_, i) => 25 * (i + 1));

// ---------------------------------------------------------------- upgrades
// Dust upgrades. Reset on every sweep.
// fx keys: rate, hand, dust (multipliers); size (table size); crystal (+bonus);
// unlock (flag); quake (power mult); quakeCd; gleamFreq; prism (+power)
export const UPGRADES = [
  { id: 'u_hands', name: 'Cupped Hands', cost: 30, fx: { hand: 3 },
    desc: 'Each click drops 3 grains instead of 1.' },
  { id: 'u_fine', name: 'Fine Sand', cost: 200, fx: { rate: 2 },
    desc: 'Hourglasses pour twice as fast.' },
  { id: 'u_t7', name: 'Wider Table', cost: 1200, fx: { size: 7 },
    desc: 'Extend the table to 7×7. Sand travels further before it falls off.' },
  { id: 'u_sift', name: 'Sifting', cost: 5000, fx: { dust: 2 }, req: ['u_t7'],
    desc: 'Every topple gives twice the dust.' },
  { id: 'u_crystal', name: 'Crystals', cost: 15000, fx: { unlock: 'crystal' }, req: ['u_t7'],
    desc: 'Unlock crystals: buildings that make topples on their cell worth ×3.' },
  { id: 'u_finer', name: 'Finer Sand', cost: 50000, fx: { rate: 2 }, req: ['u_fine'],
    desc: 'Hourglasses pour twice as fast.' },
  { id: 'u_t9', name: 'Wider Table II', cost: 150000, fx: { size: 9 }, req: ['u_t7'],
    desc: 'Extend the table to 9×9.' },
  { id: 'u_quake', name: 'Quake', cost: 250000, fx: { unlock: 'quake' }, req: ['u_t9'],
    desc: 'Unlock the Quake: shake the table, scattering half a minute of sand across every cell.' },
  { id: 'u_facet', name: 'Cut Facets', cost: 800000, fx: { crystal: 3 }, req: ['u_crystal'],
    desc: 'Crystals give +3 to their multiplier.' },
  { id: 'u_glimmer', name: 'Glimmer', cost: 2e06, fx: { unlock: 'gleam' }, req: ['u_t9'],
    desc: 'Sometimes a grain catches the light. Click gleaming grains for a reward.' },
  { id: 'u_t11', name: 'Wider Table III', cost: 4e06, fx: { size: 11 }, req: ['u_t9'],
    desc: 'Extend the table to 11×11.' },
  { id: 'u_winnow', name: 'Winnowing', cost: 6e06, fx: { dust: 2 }, req: ['u_sift'],
    desc: 'Every topple gives twice the dust.' },
  { id: 'u_finest', name: 'Finest Sand', cost: 1.2e07, fx: { rate: 2 }, req: ['u_finer'],
    desc: 'Hourglasses pour twice as fast.' },
  { id: 'u_t13', name: 'Wider Table IV', cost: 4e07, fx: { size: 13 }, req: ['u_t11'],
    desc: 'Extend the table to 13×13.' },
  { id: 'u_brill', name: 'Brilliant Cut', cost: 1.2e08, fx: { crystal: 6 }, req: ['u_facet'],
    desc: 'Crystals give +6 to their multiplier.' },
  // ---- Unlocked by kiln upgrades
  { id: 'u_aftershock', name: 'Aftershock', cost: 1.5e10, fx: { unlock: 'aftershock' }, req: ['u_quake'], kreq: 'k_seismic',
    desc: 'For 10 seconds after a quake, every topple gives triple dust.' },
  { id: 'u_t15', name: 'Long Table', cost: 8e9, fx: { size: 15 }, req: ['u_t13'], kreq: 'k_long',
    desc: 'Extend the table to 15×15.' },
  { id: 'u_temper', name: 'Tempering', cost: 3e10, fx: { dust: 3 }, req: ['u_winnow'], kreq: 'k_long',
    desc: 'Every topple gives triple dust.' },
  { id: 'u_lustre', name: 'Lustre', cost: 4e10, fx: { gleamPow: 2 }, req: ['u_glimmer'], kreq: 'k_seismic',
    desc: 'Gleam rewards are twice as strong.' },
  { id: 'u_t17', name: 'Longer Table', cost: 6e11, fx: { size: 17 }, req: ['u_t15'], kreq: 'k_long',
    desc: 'Extend the table to 17×17.' },
  { id: 'u_silt', name: 'Silt', cost: 2e12, fx: { rate: 2 }, req: ['u_finest'], kreq: 'k_long',
    desc: 'Hourglasses pour twice as fast.' },
  { id: 'u_marquise', name: 'Marquise Cut', cost: 2.5e14, fx: { crystal: 15 }, req: ['u_brill'], kreq: 'k_prisms',
    desc: 'Crystals give +15 to their multiplier.' },
  { id: 'u_refract', name: 'Refraction', cost: 2e15, fx: { prism: 1 }, req: ['u_marquise'], kreq: 'k_prisms',
    desc: 'Prisms are twice as strong.' },
  { id: 'u_t19', name: 'Great Table', cost: 1e15, fx: { size: 19 }, req: ['u_t17'], kreq: 'k_vast',
    desc: 'Extend the table to 19×19.' },
  { id: 'u_loess', name: 'Loess', cost: 1e16, fx: { dust: 5 }, req: ['u_temper'], kreq: 'k_vast',
    desc: 'Every topple gives five times the dust.' },
  { id: 'u_t21', name: 'Grand Table', cost: 1e18, fx: { size: 21 }, req: ['u_t19'], kreq: 'k_vast',
    desc: 'Extend the table to 21×21.' },
  { id: 'u_powder', name: 'Powder', cost: 1e20, fx: { rate: 3 }, req: ['u_silt'], kreq: 'k_vast',
    desc: 'Hourglasses pour three times as fast.' },
  { id: 'u_t23', name: 'Endless Table', cost: 6e18, fx: { size: 23 }, req: ['u_t21'], kreq: 'k_horizon',
    desc: 'Extend the table to 23×23.' },
  { id: 'u_rose', name: 'Rose Cut', cost: 1e20, fx: { crystal: 60 }, req: ['u_marquise'], kreq: 'k_horizon',
    desc: 'Crystals give +60 to their multiplier.' },
  { id: 'u_t25', name: 'Horizon Table', cost: 2e24, fx: { size: 25 }, req: ['u_t23'], kreq: 'k_horizon',
    desc: 'Extend the table to 25×25.' },
  { id: 'u_starlight', name: 'Starlight', cost: 1e33, fx: { dust: 10 }, req: ['u_loess'], kreq: 'k_horizon',
    desc: 'Every topple gives ten times the dust.' },
];
export const UPGRADE_MAP = Object.fromEntries(UPGRADES.map(u => [u.id, u]));

// ---------------------------------------------------------------- kiln
// Glass upgrades. Permanent (survive sweeps).
export const KILN = [
  // tier I
  { id: 'k_warm', name: 'Warm Glass', cost: 1, fx: { dust: 3 }, row: 0,
    desc: 'Every topple gives triple dust. Forever.' },
  { id: 'k_glasshg', name: 'Glass Hourglasses', cost: 2, fx: { rate: 2 }, row: 0,
    desc: 'Hourglasses pour twice as fast.' },
  { id: 'k_memory', name: 'Memory of Sand', cost: 25, fx: { memory: 1 }, row: 0,
    desc: 'Start each sweep with Cupped Hands, Fine Sand and a 7×7 table.' },
  { id: 'k_stones', name: 'Stones', cost: 30, fx: { unlock: 'stone', stones: 4 }, row: 0, req: ['k_warm'],
    desc: 'Unlock stones (up to 4). Sand bounces off them and lingers. Build pockets.' },
  // tier II
  { id: 'k_lens', name: 'Lenses', cost: 30, fx: { crystalMul: 2 }, row: 1, req: ['k_warm'],
    desc: 'Crystal multipliers are doubled.' },
  { id: 'k_apprentice', name: 'Apprentice', cost: 30, fx: { auto: 'hourglass' }, row: 1, req: ['k_glasshg'],
    desc: 'Automatically buys hourglasses when you can afford them.' },
  { id: 'k_seismic', name: 'Seismology', cost: 30, fx: { quake: 2, quakeCd: 0.75 }, row: 1, req: ['k_memory'],
    desc: 'Quakes are twice as strong and recharge 25% faster. Reveals new dust upgrades.' },
  { id: 'k_long', name: 'The Long Table', cost: 30, fx: { reveal: 1 }, row: 1, req: ['k_stones'],
    desc: 'Reveals new dust upgrades, including 15×15 and 17×17 tables.' },
  { id: 'k_doctrines', name: 'Doctrines', cost: 30, fx: { unlock: 'doctrine' }, row: 1, req: ['k_lens'],
    desc: 'Each sweep, choose a doctrine to shape the next run.' },
  { id: 'k_blow', name: 'Glassblowing', cost: 100, fx: { glass: 2 }, row: 1, req: ['k_apprentice'],
    desc: 'Sweeps yield twice as much glass.' },
  // tier III
  { id: 'k_cairn', name: 'Cairn', cost: 120, fx: { stones: 6 }, row: 2, req: ['k_long'],
    desc: '+6 stone limit.' },
  { id: 'k_fold', name: 'The Fold', cost: 250, fx: { unlock: 'fold' }, row: 2, req: ['k_long'],
    desc: 'Fold the table so its east and west edges meet. Sand can only fall off the north and south.' },
  { id: 'k_journeyman', name: 'Journeyman', cost: 400, fx: { auto: 'upgrades' }, row: 2, req: ['k_blow'],
    desc: 'Automatically buys dust upgrades when you can afford them.' },
  { id: 'k_prisms', name: 'Prisms', cost: 700, fx: { unlock: 'prism' }, row: 2, req: ['k_doctrines'],
    desc: 'Unlock prisms, which double the multiplier of each crystal they touch.' },
  { id: 'k_deep', name: 'Deep Memory', cost: 2500, fx: { memory: 2 }, row: 2, req: ['k_memory', 'k_journeyman'],
    desc: 'Start each sweep with every Table I upgrade up to 11×11.' },
  { id: 'k_trials', name: 'Trials', cost: 5000, fx: { unlock: 'trials' }, row: 2, req: ['k_fold'],
    desc: 'Unlock Trials: constrained runs with permanent rewards.' },
  // tier IV
  { id: 'k_artisan', name: 'Artisan', cost: 7000, fx: { auto: 'crystal' }, row: 3, req: ['k_journeyman'],
    desc: 'Automatically buys crystals and prisms when you can afford them.' },
  { id: 'k_seismograph', name: 'Seismograph', cost: 10000, fx: { auto: 'quake' }, row: 3, req: ['k_seismic'],
    desc: 'Automatically triggers quakes when they are ready.' },
  { id: 'k_vast', name: 'Vast Tables', cost: 10000, fx: { reveal: 2 }, row: 3, req: ['k_long', 'k_prisms'],
    desc: 'Reveals new dust upgrades, including 19×19 and 21×21 tables.' },
  { id: 'k_tremor', name: 'Tremor Doctrine', cost: 10000, fx: { unlock: 'tremor' }, row: 3, req: ['k_doctrines', 'k_seismic'],
    desc: 'A fourth doctrine, for those who like to shake things.' },
  { id: 'k_kiln2', name: 'Bellows', cost: 15000, fx: { glass: 3 }, row: 3, req: ['k_blow'],
    desc: 'Sweeps yield three times as much glass.' },
  { id: 'k_quarry', name: 'Quarry', cost: 25000, fx: { stones: 10 }, row: 3, req: ['k_cairn'],
    desc: '+10 stone limit.' },
  // tier V
  { id: 'k_cascade', name: 'Cascade', cost: 40000, fx: { tables: 1 }, row: 4, req: ['k_vast'],
    desc: 'Build a second table beneath the first. Sand that falls from the first pours into it.' },
  { id: 'k_horizon', name: 'Horizon', cost: 3e5, fx: { reveal: 3 }, row: 4, req: ['k_vast'],
    desc: 'Reveals the last dust upgrades, including 23×23 and 25×25 tables.' },
  { id: 'k_cascade2', name: 'Third Table', cost: 5e5, fx: { tables: 1 }, row: 4, req: ['k_cascade'],
    desc: 'A third table, beneath the second.' },
  { id: 'k_furnace', name: 'Furnace', cost: 2e6, fx: { glass: 4 }, row: 4, req: ['k_kiln2'],
    desc: 'Sweeps yield four times as much glass.' },
  { id: 'k_great', name: 'The Plans', cost: 1e7, fx: { unlock: 'great' }, row: 4, req: ['k_cascade2'],
    desc: 'Plans for an hourglass larger than the house. Larger than the sky.' },
];
export const KILN_MAP = Object.fromEntries(KILN.map(k => [k.id, k]));

// Repeatable glass sink.
export const POLISH = { id: 'k_polish', name: 'Polish', base: 5, growth: 4, mult: 2,
  desc: 'Every topple gives twice the dust. Can be bought again and again.' };

// ---------------------------------------------------------------- doctrines
export const DOCTRINES = {
  flow: { name: 'Flow', icon: '⧗', desc: 'Hourglasses pour three times as fast.' },
  facet: { name: 'Facet', icon: '◆', desc: 'Crystal multipliers are tripled.' },
  patience: { name: 'Patience', icon: '◌', desc: 'Dust multiplier grows the longer this sweep lasts: ×1 rising to ×8 over 40 minutes.' },
  tremor: { name: 'Tremor', icon: '≋', req: 'tremor', desc: 'Quakes are twice as strong and recharge twice as fast. Gleams appear twice as often.' },
};

// ---------------------------------------------------------------- trials
// goal: dust earned this run
export const TRIALS = [
  { id: 't_narrow', name: 'The Narrow Table', goal: 5e16,
    rule: 'The table can never grow beyond 9×9.',
    reward: 'Crystal multipliers ×2.', fx: { crystalMul: 2 } },
  { id: 't_still', name: 'Still Hands', goal: 5e15,
    rule: 'No clicking, no quakes, no gleams. Only hourglasses.',
    reward: 'Hourglasses pour twice as fast.', fx: { rate: 2 } },
  { id: 't_wind', name: 'The East Wind', goal: 4e18,
    rule: 'Every topple sends two grains east, one north, one south and none west.',
    reward: 'Folded tables give ×3 dust.', fx: { foldBonus: 3 } },
  { id: 't_scatter', name: 'Scattered Glass', goal: 8e19,
    rule: 'Hourglasses drop their sand on random cells.',
    reward: 'Gleams appear twice as often and last longer.', fx: { gleamFreq: 2 } },
  { id: 't_crumble', name: 'Crumbling Sand', goal: 1.5e20,
    rule: 'Every topple loses one of its four grains to the wind.',
    reward: '+8 stone limit, and stones make neighbouring topples worth ×1.5.', fx: { stones: 8, stoneGlow: 1.5 } },
  { id: 't_glassless', name: 'Glassless', goal: 1.5e10,
    rule: 'Every kiln upgrade is disabled (Polish too).',
    reward: 'Sweeps yield ×3 glass.', fx: { glass: 3 } },
];
export const TRIAL_MAP = Object.fromEntries(TRIALS.map(t => [t.id, t]));

// ---------------------------------------------------------------- the Great Hourglass
export const GREAT = [
  { id: 'g_frame', name: 'The Frame', glass: 1.5e7, sand: 0,
    desc: 'Four pillars of black wood.', reward: 'Dust ×10.', fx: { dust: 10 } },
  { id: 'g_lower', name: 'The Lower Bulb', glass: 6e8, sand: 0,
    desc: 'A bulb to catch everything that falls.', reward: 'Glass ×3. Sand falling from your last table is now collected.', fx: { glass: 3, collectSand: 1 } },
  { id: 'g_neck', name: 'The Neck', glass: 0, sand: 2e8, trials: true,
    desc: 'Narrow enough for one grain at a time. Requires every trial completed.', reward: 'Hourglasses pour ×5 faster.', fx: { rate: 5 } },
  { id: 'g_upper', name: 'The Upper Bulb', glass: 7e9, sand: 0,
    desc: 'A bulb to hold everything that will fall.', reward: 'Dust ×100.', fx: { dust: 100 } },
  { id: 'g_fill', name: 'The Filling', glass: 0, sand: 2e11,
    desc: 'Pour in the sand of every table you have kept.', reward: 'The Great Hourglass is complete.', fx: {} },
];

// ---------------------------------------------------------------- achievements
// Each achievement: +3% dust (additive).
export const ACH_BONUS = 0.03;
export const ACHIEVEMENTS = [
  { id: 'a_first', name: 'First Fall', desc: 'Topple a cell.', check: g => g.s.stats.topples >= 1 },
  { id: 'a_t1k', name: 'Restless', desc: 'Topple 1,000 times in total.', check: g => g.s.stats.topples >= 1e3 },
  { id: 'a_t1m', name: 'Landslide', desc: 'Topple a million times in total.', check: g => g.s.stats.topples >= 1e6 },
  { id: 'a_t1b', name: 'Erosion', desc: 'Topple a billion times in total.', check: g => g.s.stats.topples >= 1e9 },
  { id: 'a_t1t', name: 'Geology', desc: 'Topple a trillion times in total.', check: g => g.s.stats.topples >= 1e12 },
  { id: 'a_hg1', name: 'Timekeeper', desc: 'Own an hourglass.', check: g => g.s.owned.hourglass >= 1 },
  { id: 'a_hg10', name: 'Clockmaker', desc: 'Own 10 hourglasses.', check: g => g.s.owned.hourglass >= 10 },
  { id: 'a_hg25', name: 'Horologist', desc: 'Own 25 hourglasses.', check: g => g.s.owned.hourglass >= 25 },
  { id: 'a_hg50', name: 'Time Enough', desc: 'Own 50 hourglasses.', check: g => g.s.owned.hourglass >= 50 },
  { id: 'a_hg80', name: 'All the Time in the World', desc: 'Own 80 hourglasses.', check: g => g.s.owned.hourglass >= 80 },
  { id: 'a_cr1', name: 'Facet', desc: 'Own a crystal.', check: g => g.s.owned.crystal >= 1 },
  { id: 'a_cr10', name: 'Geode', desc: 'Own 10 crystals.', check: g => g.s.owned.crystal >= 10 },
  { id: 'a_cr20', name: 'Cave of Wonders', desc: 'Own 20 crystals.', check: g => g.s.owned.crystal >= 20 },
  { id: 'a_wave25', name: 'Ripple', desc: '25 cells topple in a single moment.', check: g => g.s.stats.maxWave >= 25 },
  { id: 'a_wave80', name: 'Swell', desc: '80 cells topple in a single moment.', check: g => g.s.stats.maxWave >= 80 },
  { id: 'a_wave200', name: 'Tsunami', desc: '200 cells topple in a single moment.', check: g => g.s.stats.maxWave >= 200 },
  { id: 'a_wave400', name: 'The Whole World Shakes', desc: '400 cells topple in a single moment.', check: g => g.s.stats.maxWave >= 400 },
  { id: 'a_hand', name: 'Sandbox', desc: 'Drop 500 grains by hand.', check: g => g.s.stats.handGrains >= 500 },
  { id: 'a_t13', name: 'Room to Breathe', desc: 'Grow the table to 13×13.', check: g => g.maxSize() >= 13 },
  { id: 'a_t21', name: 'Expanse', desc: 'Grow the table to 21×21.', check: g => g.maxSize() >= 21 },
  { id: 'a_t25', name: 'Horizon', desc: 'Grow the table to 25×25.', check: g => g.maxSize() >= 25 },
  { id: 'a_quake1', name: 'Tremor', desc: 'Trigger a quake.', check: g => g.s.stats.quakes >= 1 },
  { id: 'a_quake50', name: 'Fault Line', desc: 'Trigger 50 quakes.', check: g => g.s.stats.quakes >= 50 },
  { id: 'a_gleam1', name: 'Glint', desc: 'Catch a gleaming grain.', check: g => g.s.stats.gleams >= 1 },
  { id: 'a_gleam25', name: 'Magpie', desc: 'Catch 25 gleaming grains.', check: g => g.s.stats.gleams >= 25 },
  { id: 'a_sweep1', name: 'Clean Slate', desc: 'Sweep the table.', check: g => g.s.sweeps >= 1 },
  { id: 'a_sweep10', name: 'Ritual', desc: 'Sweep 10 times.', check: g => g.s.sweeps >= 10 },
  { id: 'a_sweep30', name: 'Habit', desc: 'Sweep 30 times.', check: g => g.s.sweeps >= 30 },
  { id: 'a_glass100', name: 'Glazier', desc: 'Hold 100 glass.', check: g => g.s.glass >= 100 },
  { id: 'a_glass1m', name: 'Glass House', desc: 'Hold a million glass.', check: g => g.s.glass >= 1e6 },
  { id: 'a_stone', name: 'Cornerstone', desc: 'Place a stone.', check: g => g.s.owned.stone >= 1 },
  { id: 'a_pocket', name: 'Pocket', desc: 'Make sand linger: one grain dropped somewhere causes 60 topples on average.', check: g => g.bestLinger >= 60 },
  { id: 'a_pocket2', name: 'Labyrinth', desc: 'One grain dropped somewhere causes 250 topples on average.', check: g => g.bestLinger >= 250 },
  { id: 'a_trap', name: 'Nowhere to Go', desc: 'Try to trap the sand. It always finds a way.', check: g => g.s.flags.triedTrap },
  { id: 'a_fold', name: 'Origami', desc: 'Fold the table.', check: g => g.s.fold },
  { id: 'a_prism', name: 'Spectrum', desc: 'Make a crystal touch three prisms.', check: g => g.s.flags.prism3 },
  { id: 'a_mandala', name: 'Mandala', desc: 'Make a 9×9 or larger table perfectly symmetric (in four mirrors), with at least 100 grains on it.', check: g => g.s.flags.mandala, secret: true },
  { id: 'a_overflow', name: 'Overflowing', desc: 'Have 1,000 grains on a single cell.', check: g => g.s.flags.overflow, secret: true },
  { id: 'a_quick', name: 'Brisk', desc: 'Sweep within 3 minutes of the previous sweep.', check: g => g.s.flags.quickSweep },
  { id: 'a_trial1', name: 'Tested', desc: 'Complete a trial.', check: g => Object.keys(g.s.trials).length >= 1 },
  { id: 'a_trial6', name: 'Proven', desc: 'Complete every trial.', check: g => Object.keys(g.s.trials).length >= 6 },
  { id: 'a_cascade', name: 'Waterfall', desc: 'Build a second table.', check: g => g.s.tables.length >= 2 },
  { id: 'a_cascade3', name: 'Terraces', desc: 'Build a third table.', check: g => g.s.tables.length >= 3 },
  { id: 'a_great', name: 'Keeper', desc: 'Complete the Great Hourglass.', check: g => g.s.great >= 5 },
];

// ---------------------------------------------------------------- journal
export const JOURNAL = [
  { id: 'j_start', text: 'A table. A trickle of sand from somewhere above. You put out your hand.', when: () => true },
  { id: 'j_topple', text: 'Four grains is all a place can hold. The fourth sends them tumbling, one to each neighbour.', when: g => g.s.stats.topples >= 1 },
  { id: 'j_dust', text: 'Each collapse throws up a little shimmer of dust. You start keeping it.', when: g => g.s.stats.topples >= 20 },
  { id: 'j_hourglass', text: 'An old hourglass in the drawer. It does not measure time so much as spend it.', when: g => g.s.owned.hourglass >= 1 },
  { id: 'j_table7', text: 'The table is bigger than you remembered. Or you are smaller.', when: g => g.maxSize() >= 7 },
  { id: 'j_crystal', text: 'Crystals grow where the sand falls hardest. They ring when it does.', when: g => g.s.owned.crystal >= 1 },
  { id: 'j_wave', text: 'An avalanche crosses the whole table and you hold your breath the whole way.', when: g => g.s.stats.maxWave >= 25 },
  { id: 'j_quake', text: 'You lean on the table. Everything that was waiting, goes.', when: g => g.s.stats.quakes >= 1 },
  { id: 'j_gleam', text: 'Sometimes a grain catches the light. It seems a shame to let it go.', when: g => g.has('gleam') },
  { id: 'j_kiln', text: 'Behind a curtain: a kiln, still warm. Somebody was here before you.', when: g => g.kilnVisible() },
  { id: 'j_sweep', text: 'You sweep the table clean. The kiln takes the dust and gives back glass, clear as a held breath.', when: g => g.s.sweeps >= 1 },
  { id: 'j_stone', text: 'Stones do not move. Sand goes around them, or back, but never nowhere.', when: g => g.has('stone') },
  { id: 'j_sweep3', text: 'Every sweep is easier. The hands remember what the table forgets.', when: g => g.s.sweeps >= 3 },
  { id: 'j_doctrine', text: 'There is more than one way to keep a table.', when: g => g.has('doctrine') },
  { id: 'j_fold', text: 'You fold the table until its east edge meets its west. The sand does not seem to mind.', when: g => g.s.fold },
  { id: 'j_prism', text: 'A prism splits a crystal\'s light, and the crystal sings twice.', when: g => g.has('prism') },
  { id: 'j_hundred', text: 'A hundred hourglasses, all pouring onto one spot. The table hums like something alive.', when: g => g.s.owned.hourglass >= 100 },
  { id: 'j_pocket', text: 'Walled in, the sand goes round and round, and every time it falls, it pays.', when: g => g.bestLinger >= 60 },
  { id: 'j_note1', text: 'A note in the drawer, in a hand like yours: "Where the sand cannot leave, it stays. Where it stays, it falls."', when: g => g.s.sweeps >= 6 },
  { id: 'j_trials', text: 'Another note: "Test yourself. The table will be here when you get back."', when: g => g.has('trials') },
  { id: 'j_trial', text: 'You did it the hard way. The kiln burns a little brighter for it.', when: g => Object.keys(g.s.trials).length >= 1 },
  { id: 'j_trial3', text: 'Halfway through the old keeper\'s tests. Their handwriting is getting steadier, or yours is.', when: g => Object.keys(g.s.trials).length >= 3 },
  { id: 'j_glass', text: 'So much glass that the kiln room glitters. You could see through the walls, if there were still walls.', when: g => g.s.glassAll >= 1e6 },
  { id: 'j_note2', text: 'The notes are getting older, the paper thinner. "Every grain falls off the edge eventually. Where does the edge fall to?"', when: g => g.s.sweeps >= 15 },
  { id: 'j_cascade', text: 'Below your table, another. The sand you thought was lost was only falling.', when: g => g.s.tables.length >= 2 },
  { id: 'j_cascade3', text: 'Three tables now, like steps down to a river.', when: g => g.s.tables.length >= 3 },
  { id: 'j_plans', text: 'Plans for an hourglass, larger than the room. Larger than the house. The keeper never finished it.', when: g => g.has('great') },
  { id: 'j_frame', text: 'The frame stands in the dark like a doorway with no wall.', when: g => g.s.great >= 1 },
  { id: 'j_lower', text: 'The lower bulb fills with the sand from your last table. It sounds like rain.', when: g => g.s.great >= 2 },
  { id: 'j_neck', text: 'The neck is so narrow that a grain must wait its turn. Everything does, in the end.', when: g => g.s.great >= 3 },
  { id: 'j_upper', text: 'The upper bulb is empty, and so large that it has weather.', when: g => g.s.great >= 4 },
  { id: 'j_full', text: 'It is full. All of it. Every grain you ever dropped.', when: g => g.s.great >= 5 },
];
