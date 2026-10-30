import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DataService } from '../src/services/dataService.js';
import {
  generateWorkout,
  filterEligibleExercises,
  filterExercisesByMuscleAndQuery,
  getActiveSlotExercise,
  swapExerciseInSlot,
  getValidReplacementCandidates,
  getWorkoutCheckMode,
  getConsolidatedWorkoutSubtitle,
  getTargetExerciseCount,
  autoSlotExercises,
  generateWorkoutFromSelectedExercises
} from '../src/engine/workoutEngine.js';
import {
  analyzeMuscleLoad,
  applyBalancedRecommendation,
  formatCombinedMuscles,
  SPECIFIC_MUSCLES
} from '../src/engine/muscleLoadAnalyzer.js';
import {
  TIMER_COLORS,
  CUSTOM_TIMER_PRESETS,
  isTimedHiitWorkout,
  formatTimerClock,
  getDefaultExerciseTimerConfig,
  buildStockTimerSequence,
  buildCustomPresetTimerSequence,
  finalizeWithCountdown,
  getTimerSequenceSummary
} from '../src/engine/timerEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const rawSheet = JSON.parse(
  fs.readFileSync(path.join(rootDir, 'data', 'sheet-data.json'), 'utf8')
);
const rawEnrich = JSON.parse(
  fs.readFileSync(path.join(rootDir, 'data', 'enrichments.json'), 'utf8')
);

const ds = new DataService().initFromObjects(rawSheet, rawEnrich);
const sheetData = ds.sheetData;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ PASS: ${name}`);
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

console.log('================================================================');
console.log('RUNNING WORKOUT GENERATOR QA, FACT-CHECK & DIAGRAM AUDIT SUITE');
console.log('================================================================\n');

// ----------------------------------------------------------------------------
// 1. DATA INTEGRITY & BIOMECHANICAL AUDIT TESTS
// ----------------------------------------------------------------------------
console.log('1. Data Integrity & Biomechanical Muscle Audit');

test('Contains all 68 exercises (rows 2..69) and all 11 workout types', () => {
  assert.equal(sheetData.exercises.length, 68, 'Expected exactly 68 exercises');
  assert.equal(sheetData.workouts.length, 11, 'Expected exactly 11 workout types');

  const rows = sheetData.exercises.map(e => e.row);
  for (let r = 2; r <= 69; r++) {
    assert.ok(rows.includes(r), `Missing sheet row #${r}`);
  }
});

test('Biomechanical muscle audit fixes are applied with clean single-Primary + Secondary synergist hierarchy', () => {
  const byId = Object.fromEntries(sheetData.exercises.map(e => [e.id, e]));

  const lungeIds = [
    'lunges-split-squats',
    'lunge-jumps',
    'lunges-with-one-dumbbell-up',
    'lunge-with-one-foot-on-bench',
    'lunge-twists-with-slam-ball'
  ];
  for (const id of lungeIds) {
    assert.equal(byId[id].muscles.Quads, 'Pri', `${id} must have Quads: Pri`);
    assert.equal(byId[id].muscles.Glutes, 'Sec', `${id} must have Glutes: Sec`);
  }

  assert.equal(byId['swings'].muscles.Back, 'Pri');
  assert.equal(byId['swings'].muscles.Glutes, 'Sec');
  assert.equal(byId['swings'].muscles.Hamstrings, 'Sec');

  assert.equal(byId['trx-wood-choppers'].muscles.Back, 'Pri');
  assert.equal(byId['trx-wood-choppers'].muscles.Abs, 'Sec');

  assert.equal(byId['push-ups'].muscles.Triceps, 'Sec');
  assert.equal(byId['3-stop-pushups'].muscles.Triceps, 'Sec');
  assert.equal(byId['shoulder-press'].muscles.Triceps, 'Sec');
  assert.equal(byId['arnold-press'].muscles.Triceps, 'Sec');
  assert.equal(byId['up-up-down-ups'].muscles.Triceps, 'Sec');

  assert.equal(byId['opposite-arm-and-leg-lifts'].muscles.Back, 'Sec');
  assert.equal(byId['opposite-arm-and-leg-lifts'].muscles.Glutes, 'Sec');
});

// ----------------------------------------------------------------------------
// 2. EXERCISE FACT-CHECKING & 68 SVG DIAGRAM ASSESSMENT
// ----------------------------------------------------------------------------
console.log('\n2. Fact-Checking & 68 SVG Diagram-to-Description Verification');

test('All 11 workout types have complete fact-checked descriptions matching sheet metadata', () => {
  for (const wk of sheetData.workouts) {
    assert.ok(wk.enrichment, `Missing enrichment for workout ${wk.name}`);
    assert.ok(wk.enrichment.summary.length > 20, `Short summary for ${wk.name}`);
    assert.ok(Array.isArray(wk.enrichment.howItWorks) && wk.enrichment.howItWorks.length >= 3);
    assert.ok(wk.enrichment.timerStructure.length > 10);
    assert.ok(wk.enrichment.pacingTip.length > 20);
  }
});

test('Specialty exercises have accurate, movement-specific fact-checked instructions', () => {
  const byId = Object.fromEntries(sheetData.exercises.map(e => [e.id, e]));

  const cp666Text = JSON.stringify(byId['chest-press-6-6-6'].enrichment);
  assert.ok(cp666Text.includes('6') && cp666Text.toLowerCase().includes('single-arm'));

  const stop3Text = JSON.stringify(byId['3-stop-pushups'].enrichment);
  assert.ok(stop3Text.includes('Stop 1') && stop3Text.includes('Stop 2') && stop3Text.includes('Stop 3'));

  const v3Text = JSON.stringify(byId['3-way-v-ups'].enrichment).toLowerCase();
  assert.ok(v3Text.includes('left') && v3Text.includes('center') && v3Text.includes('right'));

  const cpRollerText = JSON.stringify(byId['crunch-pike-on-roller'].enrichment);
  assert.ok(cpRollerText.includes('Crunch') && cpRollerText.includes('Pike'));
});

test('All 68 SVG diagrams exist, contain valid SVG, highlight Pri/Sec muscles, and map back to descriptions', () => {
  for (const ex of sheetData.exercises) {
    const enrich = ex.enrichment;
    assert.ok(enrich, `Missing enrichment for ${ex.id}`);
    assert.ok(enrich.summary.length > 25, `Summary too short for ${ex.id}`);
    assert.ok(enrich.steps.length >= 3, `Expected >= 3 steps for ${ex.id}`);
    assert.ok(enrich.formTip.length > 15, `Form tip too short for ${ex.id}`);

    const svgPath = path.join(rootDir, enrich.diagram);
    assert.ok(fs.existsSync(svgPath), `Missing SVG diagram file: ${svgPath}`);

    const svgContent = fs.readFileSync(svgPath, 'utf8');
    const escapedName = ex.name.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const escapedBadge = enrich.badge.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    assert.ok(svgContent.startsWith('<svg') && svgContent.endsWith('</svg>'), `Invalid SVG wrapper for ${ex.id}`);
    assert.ok(svgContent.includes(escapedName), `SVG aria-label should reference ${escapedName}`);
    assert.ok(svgContent.includes(escapedBadge), `SVG missing XML-escaped badge for ${ex.id}`);
    assert.ok(svgContent.includes(`Equip: ${ex.equipment}`), `SVG missing equipment label for ${ex.id}`);

    const priMuscles = SPECIFIC_MUSCLES.filter(m => ex.muscles[m] === 'Pri');
    assert.ok(priMuscles.length >= 1, `${ex.id} must have at least 1 Primary muscle`);
    for (const pm of priMuscles) {
      assert.ok(
        svgContent.includes(`${pm} (PRI)`),
        `SVG for ${ex.id} must list ${pm} (PRI) in its target muscle map`
      );
    }
    assert.ok(svgContent.includes('#f97316'), `SVG for ${ex.id} must include primary muscle highlight color #f97316`);
  }
});

// ----------------------------------------------------------------------------
// 3. GENERATOR ENGINE, EQUIPMENT RULES, EXCLUSIONS & MULTI-OPTION STRESS TESTS
// ----------------------------------------------------------------------------
console.log('\n3. Generator Engine, Equipment Rules, Exclusions & Multi-Option Slots');

test('Equipment = "Nothing" strictly returns only bodyweight-capable exercises (Nothing or Any)', () => {
  const pool = filterEligibleExercises(sheetData.exercises, {
    workoutCategory: 'Either',
    bodyCategory: 'All',
    equipment: 'Nothing'
  });
  assert.ok(pool.length >= 20, 'Should have at least 20 bodyweight exercises');
  for (const ex of pool) {
    assert.ok(
      ex.equipment === 'Nothing' || ex.equipment === 'Any',
      `Unexpected non-bodyweight exercise "${ex.name}" (${ex.equipment}) when Equipment = Nothing`
    );
  }
});

test('Equipment = "Any" makes all 68 exercises eligible', () => {
  const pool = filterEligibleExercises(sheetData.exercises, {
    workoutCategory: 'Either',
    bodyCategory: 'All',
    equipment: 'Any'
  });
  assert.equal(pool.length, 68);
});

test('Selecting a manual Workout Type overrides Workout Category to match that workout (Apps Script parity)', () => {
  const wk = generateWorkout(sheetData, {
    workoutCategory: 'HIIT',
    bodyCategory: 'All',
    equipment: 'Any',
    workoutType: 'Strength Duos'
  });
  assert.equal(wk.inputs.effectiveWorkoutCategory, 'Strength');
  assert.equal(wk.workout.name, 'Strength Duos');
  assert.equal(wk.rounds.length, 4);
  assert.equal(wk.rounds[0].slots.length, 2);
});

test('User Exercise Exclusion List prevents excluded exercises from ever appearing', () => {
  const excludedIds = ['push-ups', 'burpees', 'squats', 'plank', 'mountain-climbers'];
  for (let i = 0; i < 100; i++) {
    const wk = generateWorkout(sheetData, {
      workoutCategory: 'Either',
      bodyCategory: 'All',
      equipment: 'Any',
      workoutType: 'Random',
      excludedExerciseIds: excludedIds,
      optionsPerSlot: 3
    });
    for (const r of wk.rounds) {
      for (const s of r.slots) {
        for (const opt of s.options) {
          assert.ok(
            !excludedIds.includes(opt.id),
            `Excluded exercise ${opt.id} appeared in generated workout`
          );
        }
      }
    }
  }
});

test('Multi-Option Slots (1, 2, or 3 options per exercise slide) generate distinct valid options per slot', () => {
  for (const optionsPerSlot of [1, 2, 3]) {
    const wk = generateWorkout(sheetData, {
      workoutCategory: 'HIIT',
      bodyCategory: 'All',
      equipment: 'Any',
      workoutType: 'Timed Trios (40/20)',
      optionsPerSlot
    });
    for (const r of wk.rounds) {
      for (const s of r.slots) {
        assert.equal(
          s.options.length,
          optionsPerSlot,
          `Expected ${optionsPerSlot} options in slot, got ${s.options.length}`
        );
        const uniqueIds = new Set(s.options.map(o => o.id));
        assert.equal(uniqueIds.size, optionsPerSlot, 'Options within a slot must be distinct');
      }
    }
  }
});

test('Monte Carlo Stress Test: 1,000+ generated workouts across all filter permutations never crash or return undefined', () => {
  const workoutCats = ['Either', 'Strength', 'HIIT'];
  const bodyCats = ['All', 'Upper Body', 'Core', 'Legs', 'Upper Body and Core', 'Legs and Core'];
  const equips = ['Any', 'Weights', 'Bands', 'Nothing'];
  const workoutTypes = ['Random', ...sheetData.workouts.map(w => w.name)];

  let runs = 0;
  for (const workoutCategory of workoutCats) {
    for (const bodyCategory of bodyCats) {
      for (const equipment of equips) {
        for (const workoutType of workoutTypes) {
          const wk = generateWorkout(sheetData, {
            workoutCategory,
            bodyCategory,
            equipment,
            workoutType,
            optionsPerSlot: (runs % 3) + 1
          });
          assert.ok(wk && wk.rounds.length >= 1);
          for (const r of wk.rounds) {
            assert.ok(r.slots.length >= 1);
            for (const s of r.slots) {
              const active = getActiveSlotExercise(s);
              assert.ok(active && active.id && active.name);
            }
          }
          runs++;
        }
      }
    }
  }
  console.log(`     (Completed ${runs} full filter combinations without a single failure)`);
});

// ----------------------------------------------------------------------------
// 4. MUSCLE GROUP OVERLOAD DETECTION, SINGLE-LINE COMBINED WARNINGS & AUTO-BALANCE
// ----------------------------------------------------------------------------
console.log('\n4. Muscle Group Overload Detection, Single-Line Combined Warnings & Auto-Balance');

test('Detects accidental Triceps overload when user manually selects multiple Triceps exercises and balances in 1 tap', () => {
  let wk = generateWorkout(sheetData, {
    workoutCategory: 'HIIT',
    bodyCategory: 'Upper Body',
    equipment: 'Weights',
    workoutType: 'Timed Trios (40/20)'
  });

  const byId = Object.fromEntries(sheetData.exercises.map(e => [e.id, e]));
  wk = swapExerciseInSlot(wk, 0, 0, byId['skull-crushers']);
  wk = swapExerciseInSlot(wk, 0, 1, byId['tricep-kick-backs']);
  wk = swapExerciseInSlot(wk, 0, 2, byId['trx-triceps']);

  const analysis = analyzeMuscleLoad(wk, sheetData, []);
  assert.ok(analysis.hasWarnings, 'Should flag muscle overload warning');

  const tricepWarning = analysis.warnings.find(
    w => w.roundIndex === 0 && w.muscle === 'Triceps'
  );
  assert.ok(tricepWarning, 'Should specifically warn about Triceps overload in Round 1');
  assert.equal(tricepWarning.priCount, 3);
  assert.ok(tricepWarning.recommendations.length >= 1, 'Should provide balanced replacement recommendations');

  const topRec = tricepWarning.recommendations[0].exercise;
  assert.notEqual(topRec.muscles.Triceps, 'Pri', 'Recommended alternative must not overload Triceps');

  const balancedOnce = applyBalancedRecommendation(wk, tricepWarning);
  const analysisAfterOne = analyzeMuscleLoad(balancedOnce, sheetData, []);
  const tricepWarning2 = analysisAfterOne.warnings.find(
    w => w.roundIndex === 0 && w.muscle === 'Triceps'
  );
  assert.ok(tricepWarning2 && tricepWarning2.priCount === 2);

  const balancedTwice = applyBalancedRecommendation(balancedOnce, tricepWarning2);
  const analysisFinal = analyzeMuscleLoad(balancedTwice, sheetData, []);
  const remainingTricepWarn = analysisFinal.warnings.find(
    w => w.roundIndex === 0 && w.muscle === 'Triceps'
  );
  assert.equal(remainingTricepWarn, undefined, 'Triceps overload should be completely resolved');
});

test('Combines multiple overloaded muscles in the same round into a single 1-line warning (e.g. "Glutes & Quads")', () => {
  assert.equal(formatCombinedMuscles(['Glutes', 'Quads']), 'Glutes & Quads');
  assert.equal(formatCombinedMuscles(['Glutes', 'Quads', 'Hamstrings']), 'Glutes, Quads & Hamstrings');

  let wk = generateWorkout(sheetData, {
    workoutCategory: 'Strength',
    bodyCategory: 'All',
    equipment: 'Any',
    workoutType: 'Strength Quads'
  });

  const byId = Object.fromEntries(sheetData.exercises.map(e => [e.id, e]));
  // Overload BOTH Glutes (2 Pri: frog-pumps, single-leg-band-glute-bridge) and Quads (2 Pri: squats, sumo-squats) in Round 1
  wk = swapExerciseInSlot(wk, 0, 0, byId['frog-pumps']);
  wk = swapExerciseInSlot(wk, 0, 1, byId['single-leg-band-glute-bridge']);
  wk = swapExerciseInSlot(wk, 0, 2, byId['squats']);
  wk = swapExerciseInSlot(wk, 0, 3, byId['sumo-squats']);

  const analysis = analyzeMuscleLoad(wk, sheetData, []);
  const round1Warnings = analysis.warnings.filter(w => w.roundIndex === 0);

  assert.equal(
    round1Warnings.length,
    1,
    'Multiple overloaded muscles in Round 1 must be combined into exactly 1 warning entry'
  );
  assert.equal(
    round1Warnings[0].muscle,
    'Glutes & Quads',
    `Expected combined warning muscle "Glutes & Quads", got "${round1Warnings[0].muscle}"`
  );
  assert.deepEqual(round1Warnings[0].overloadedMuscles, ['Glutes', 'Quads']);
  assert.ok(round1Warnings[0].recommendations.length >= 1);
  // Top recommendation should not hit either Glutes or Quads as Pri
  const recEx = round1Warnings[0].recommendations[0].exercise;
  assert.notEqual(recEx.muscles.Glutes, 'Pri');
  assert.notEqual(recEx.muscles.Quads, 'Pri');
});

test('"Pick Random Valid Replacement" (getValidReplacementCandidates) never triggers a muscle overload warning across 200+ swaps', () => {
  for (let i = 0; i < 200; i++) {
    let wk = generateWorkout(sheetData, {
      workoutCategory: 'HIIT',
      bodyCategory: 'All',
      equipment: 'Any',
      workoutType: 'Timed Trios (40/20)'
    });

    const roundIndex = i % wk.rounds.length;
    const slotIndex = i % wk.rounds[roundIndex].slots.length;

    const validCandidates = getValidReplacementCandidates({
      workoutState: wk,
      roundIndex,
      slotIndex,
      sheetData,
      excludedExerciseIds: [],
      analyzeMuscleLoadFn: analyzeMuscleLoad
    });

    assert.ok(validCandidates.length > 0, 'Expected at least 1 valid replacement candidate');
    const chosen = validCandidates[Math.floor(Math.random() * validCandidates.length)];
    const swapped = swapExerciseInSlot(wk, roundIndex, slotIndex, chosen, null, true);

    const analysis = analyzeMuscleLoad(swapped, sheetData, []);
    const roundWarnings = analysis.warnings.filter(w => w.roundIndex === roundIndex);
    assert.equal(
      roundWarnings.length,
      0,
      `Random valid replacement "${chosen.name}" unexpectedly caused warning: ${roundWarnings.map(w => w.message).join('; ')}`
    );
  }
});

// ----------------------------------------------------------------------------
// 5. FORMAT-AWARE CHECKBOX MODES, CONSOLIDATED HEADER & COMPACT LIGHT UI QA
// ----------------------------------------------------------------------------
console.log('\n5. Format-Aware Checkbox Modes, Consolidated Header & Light Motif UI');

test('Format-aware checkbox logic: per-set checkboxes for fixed sets, round checkbox for 8x8 Duos, and no checkboxes for continuous pyramids/ladders', () => {
  const byId = Object.fromEntries(sheetData.workouts.map(w => [w.id, w]));

  // 1. Fixed sets per round -> mode: 'exercise-sets', count: 3
  for (const id of [
    'strength-duos',
    'strength-trios',
    'strength-quads',
    'timed-duos-40-20',
    'timed-trios-40-20',
    '8-excercises-40-20'
  ]) {
    const mode = getWorkoutCheckMode(byId[id]);
    assert.equal(mode.mode, 'exercise-sets', `Expected exercise-sets mode for ${id}`);
    assert.equal(mode.count, 3, `Expected 3 set checkboxes per exercise for ${id}`);
    const generated = generateWorkout(sheetData, { workoutType: byId[id].name });
    assert.equal(generated.rounds[0].slots[0].completedSets.length, 3);
  }

  // 2. Unfixed sets (8x8 Duos AMRAP) -> mode: 'round', count: 1
  const mode8x8 = getWorkoutCheckMode(byId['8x8-duos']);
  assert.equal(mode8x8.mode, 'round', '8x8 Duos must use round-level checkbox mode');
  const gen8x8 = generateWorkout(sheetData, { workoutType: '8x8 Duos' });
  assert.equal(gen8x8.rounds[0].completed, false);
  assert.equal(gen8x8.rounds[0].slots[0].completedSets.length, 0);

  // 3. Continuous workouts (Pyramids, 10->1->10, 30-20-10-10-20-30, 5 Constant 5 Change) -> mode: 'none'
  for (const id of [
    '6-excercise-pyramid',
    '10-to-1-to-10',
    '30-20-10-10-20-30',
    '5-constant-5-change-40-20'
  ]) {
    const mode = getWorkoutCheckMode(byId[id]);
    assert.equal(mode.mode, 'none', `Expected 'none' checkbox mode for continuous workout ${id}`);
  }
});

test('Consolidated workout subtitle eliminates duplicate pills/comments across all 11 workouts', () => {
  for (const wk of sheetData.workouts) {
    const subtitle = getConsolidatedWorkoutSubtitle({ workout: wk });
    assert.ok(subtitle && subtitle.length > 10, `Missing consolidated subtitle for ${wk.name}`);
  }
});

test('HTML/CSS/JS UI audit: Light motif, hyperlinked workout type, and removed Spreadsheet/Copy/HowItWorks/Eyebrow clutter', () => {
  const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(rootDir, 'src', 'styles.css'), 'utf8');
  const appJs = fs.readFileSync(path.join(rootDir, 'src', 'app.js'), 'utf8');

  // Hyperlink on Workout Type (#2)
  assert.ok(html.includes('<a href="#workout-format" id="workoutTitleBtn" class="workout-type-link">'));
  assert.ok(!html.includes('How it works'), 'Must not include "How it works" button text');
  assert.ok(!html.includes('Format Info'), 'Must not include "Format Info" button text');

  // Removed Spreadsheet view (#3), Copy (#5), and ACTIVE WORKOUT eyebrow (#6)
  assert.ok(!html.includes('sheetDetailsAccordion') && !html.includes('Spreadsheet View') && !html.includes('Spreadsheet Summary'));
  assert.ok(!html.includes('copySummaryBtn') && !appJs.includes('copySummaryBtn'));
  assert.ok(!html.includes('ACTIVE WORKOUT'));

  // Light blue motif and unbolded inline muscle/equipment text (#4)
  assert.ok(css.includes('--bg-primary: #f0f6fc') && css.includes('--bg-card: #ffffff'));
  assert.ok(css.includes('.exercise-inline-meta') && css.includes('font-weight: 400'));

  // Removed Audit Update box from app and gallery
  const galleryHtml = fs.readFileSync(path.join(rootDir, 'qa-gallery.html'), 'utf8');
  assert.ok(!html.includes('exerciseModalAuditBox') && !html.includes('audit-note-box'), 'Audit box must be removed from index.html');
  assert.ok(!galleryHtml.includes('audit-note-box') && !galleryHtml.includes('Audit Update:'), 'Audit box must be removed from qa-gallery.html');
  assert.ok(!appJs.includes('exerciseModalAuditBox'), 'Audit box logic must be removed from src/app.js');
});

// ----------------------------------------------------------------------------
// 6. REQUIREMENT 1: FILTER BY MUSCLE GROUP & BODY AREA
// ----------------------------------------------------------------------------
console.log('\n6. Requirement 1: Filter by Muscle Group & Body Area');

test('filterEligibleExercises filters accurately across all Body Areas and all 9 Specific Muscle Groups', () => {
  const bodyAreas = ['All', 'Upper Body', 'Core', 'Legs', 'Upper Body and Core', 'Legs and Core', 'Upper Body and Legs'];
  for (const area of bodyAreas) {
    const pool = filterEligibleExercises(sheetData.exercises, {
      workoutCategory: 'Either',
      bodyCategory: area,
      equipment: 'Any'
    });
    assert.ok(pool.length > 0, `Expected non-empty pool for bodyCategory="${area}"`);
    for (const ex of pool) {
      if (area === 'Upper Body' || area === 'Core' || area === 'Legs') {
        assert.equal(ex.bodyCategories[area], 'Pri', `${ex.name} must have ${area}: Pri`);
      } else if (area === 'Upper Body and Core') {
        assert.ok(ex.bodyCategories['Upper Body'] === 'Pri' || ex.bodyCategories['Core'] === 'Pri');
      } else if (area === 'Legs and Core') {
        assert.ok(ex.bodyCategories['Legs'] === 'Pri' || ex.bodyCategories['Core'] === 'Pri');
      } else if (area === 'Upper Body and Legs') {
        assert.ok(ex.bodyCategories['Upper Body'] === 'Pri' || ex.bodyCategories['Legs'] === 'Pri');
      }
    }
  }

  for (const muscle of SPECIFIC_MUSCLES) {
    const pool = filterEligibleExercises(sheetData.exercises, {
      workoutCategory: 'Either',
      bodyCategory: muscle,
      equipment: 'Any'
    });
    assert.ok(pool.length >= 2, `Expected at least 2 exercises for specific muscle "${muscle}"`);
    for (const ex of pool) {
      assert.ok(
        ex.muscles[muscle] === 'Pri' || ex.muscles[muscle] === 'Sec',
        `${ex.name} in ${muscle} pool must target ${muscle} as Pri or Sec`
      );
    }
  }
});

test('filterExercisesByMuscleAndQuery filters by muscle pill AND search text (name, muscle, equipment, body area)', () => {
  for (const muscle of SPECIFIC_MUSCLES) {
    const list = filterExercisesByMuscleAndQuery(sheetData.exercises, {
      muscleFilter: muscle,
      query: ''
    });
    assert.ok(list.length >= 2, `Expected exercises for muscleFilter=${muscle}`);
    for (const ex of list) {
      assert.ok(ex.muscles[muscle] === 'Pri' || ex.muscles[muscle] === 'Sec');
    }
    // Primary exercises should be sorted before Secondary exercises
    const firstSecIdx = list.findIndex(e => e.muscles[muscle] !== 'Pri');
    if (firstSecIdx !== -1) {
      for (let i = firstSecIdx; i < list.length; i++) {
        assert.notEqual(list[i].muscles[muscle], 'Pri', 'Primary muscle matches must sort before Secondary');
      }
    }
  }

  // Search by muscle name text when muscleFilter = 'All'
  const hamMatches = filterExercisesByMuscleAndQuery(sheetData.exercises, {
    muscleFilter: 'All',
    query: 'hamstrings'
  });
  assert.ok(hamMatches.length >= 4);
  for (const ex of hamMatches) {
    assert.ok(ex.muscles.Hamstrings === 'Pri' || ex.muscles.Hamstrings === 'Sec');
  }
});

// ----------------------------------------------------------------------------
// 7. REQUIREMENT 2: ALLOW USER TO DISMISS MUSCLE OVERLOAD WARNINGS
// ----------------------------------------------------------------------------
console.log('\n7. Requirement 2: Dismiss Muscle Overload Warning');

test('analyzeMuscleLoad suppresses warnings whose warning.id or round key is in dismissedWarnings', () => {
  let wk = generateWorkout(sheetData, {
    workoutCategory: 'Strength',
    bodyCategory: 'All',
    equipment: 'Any',
    workoutType: 'Strength Duos'
  });
  const byId = Object.fromEntries(sheetData.exercises.map(e => [e.id, e]));
  // Trigger Chest overload in Round 1 and Triceps overload in Round 2
  wk = swapExerciseInSlot(wk, 0, 0, byId['push-ups']);
  wk = swapExerciseInSlot(wk, 0, 1, byId['chest-flys']);
  wk = swapExerciseInSlot(wk, 1, 0, byId['skull-crushers']);
  wk = swapExerciseInSlot(wk, 1, 1, byId['tricep-kick-backs']);

  const before = analyzeMuscleLoad(wk, sheetData, [], []);
  assert.equal(before.warnings.length, 2, 'Should have 2 warnings before dismissal');
  const r1WarnId = before.warnings.find(w => w.roundIndex === 0).id;
  const r2WarnId = before.warnings.find(w => w.roundIndex === 1).id;

  // Dismiss Round 1 warning by ID
  const afterDismissR1 = analyzeMuscleLoad(wk, sheetData, [], [r1WarnId]);
  assert.equal(afterDismissR1.warnings.length, 1, 'Round 1 warning should be dismissed');
  assert.equal(afterDismissR1.warnings[0].id, r2WarnId, 'Round 2 warning should remain');

  // Dismiss Round 2 warning by round key
  const afterDismissBoth = analyzeMuscleLoad(wk, sheetData, [], [r1WarnId, 'round-1']);
  assert.equal(afterDismissBoth.warnings.length, 0, 'All warnings should be dismissed');
  assert.equal(afterDismissBoth.hasWarnings, false);
});

// ----------------------------------------------------------------------------
// 8. REQUIREMENT 3: ZERO NEW WARNINGS ON NEW WORKOUTS OR REPLACEMENT EXERCISES
// ----------------------------------------------------------------------------
console.log('\n8. Requirement 3: Newly Generated Workouts & Replacement Exercises Never Trigger New Warnings');

test('Newly generated workouts across all filters & multi-option selections produce 0 overload warnings', () => {
  const workoutCats = ['Either', 'Strength', 'HIIT'];
  const bodyCats = [
    'All',
    'Upper Body',
    'Core',
    'Legs',
    'Upper Body and Core',
    'Legs and Core',
    'Upper Body and Legs',
    ...SPECIFIC_MUSCLES
  ];
  const equips = ['Any', 'Weights', 'Bands', 'Nothing'];
  const workoutTypes = sheetData.workouts.map(w => w.name);

  for (const workoutCategory of workoutCats) {
    for (const bodyCategory of bodyCats) {
      for (const equipment of equips) {
        for (const workoutType of workoutTypes) {
          const wk = generateWorkout(sheetData, {
            workoutCategory,
            bodyCategory,
            equipment,
            workoutType,
            optionsPerSlot: 2
          });
          const analysis = analyzeMuscleLoad(wk, sheetData, []);
          assert.equal(
            analysis.warnings.length,
            0,
            `Generated workout triggered unexpected warning for (${workoutCategory}, ${bodyCategory}, ${equipment}, ${workoutType}): ${analysis.warnings.map(w => w.message).join('; ')}`
          );

          // Also verify selecting Option 2 on slot 0 in Round 1 does not trigger a warning
          if (wk.rounds[0].slots[0].options.length > 1) {
            const wkOpt2 = structuredClone(wk);
            wkOpt2.rounds[0].slots[0].selectedOptionIndex = 1;
            const analysisOpt2 = analyzeMuscleLoad(wkOpt2, sheetData, []);
            assert.equal(
              analysisOpt2.warnings.length,
              0,
              `Selecting Option 2 triggered warning for (${workoutCategory}, ${bodyCategory}, ${equipment}, ${workoutType}): ${analysisOpt2.warnings.map(w => w.message).join('; ')}`
            );
          }
        }
      }
    }
  }
});

test('Every recommended replacement exercise in warning.recommendations resolves the overload and triggers 0 new warnings', () => {
  const overloadPairs = [
    ['push-ups', 'chest-flys'],
    ['skull-crushers', 'tricep-kick-backs'],
    ['shoulder-press', 'arnold-press'],
    ['rows', 'pull-ups'],
    ['crunches', 'plank'],
    ['frog-pumps', 'single-leg-band-glute-bridge'],
    ['squats', 'lunges-split-squats'],
    ['single-leg-deadlift', 'trx-hamstring-curls']
  ];
  const byId = Object.fromEntries(sheetData.exercises.map(e => [e.id, e]));

  let verifiedRecs = 0;
  for (const workoutType of ['Strength Duos', 'Strength Trios', 'Strength Quads', 'Timed Duos (40/20)', 'Timed Trios (40/20)']) {
    for (const [idA, idB] of overloadPairs) {
      let wk = generateWorkout(sheetData, {
        workoutCategory: 'Either',
        bodyCategory: 'All',
        equipment: 'Any',
        workoutType
      });
      wk = swapExerciseInSlot(wk, 0, 0, byId[idA]);
      wk = swapExerciseInSlot(wk, 0, 1, byId[idB]);

      const analysis = analyzeMuscleLoad(wk, sheetData, []);
      const r0Warn = analysis.warnings.find(w => w.roundIndex === 0);
      assert.ok(r0Warn, `Expected overload warning for ${idA} + ${idB} in ${workoutType}`);
      assert.ok(r0Warn.recommendations.length > 0, `Expected recommendations for ${idA} + ${idB}`);

      for (let recIdx = 0; recIdx < r0Warn.recommendations.length; recIdx++) {
        let balanced = applyBalancedRecommendation(wk, r0Warn, recIdx);
        let afterAnalysis = analyzeMuscleLoad(balanced, sheetData, []);
        let afterR0Warnings = afterAnalysis.warnings.filter(w => w.roundIndex === 0);

        // Must NEVER trigger a new muscle overload warning that wasn't already in r0Warn.overloadedMuscles
        const newlyOverloaded = afterR0Warnings.flatMap(w =>
          w.overloadedMuscles.filter(m => !r0Warn.overloadedMuscles.includes(m))
        );
        assert.equal(
          newlyOverloaded.length,
          0,
          `Recommendation #${recIdx} (${r0Warn.recommendations[recIdx].exercise.name}) triggered a NEW muscle warning: ${newlyOverloaded.join(', ')}`
        );

        // If 3 slots in a Trio/Quad had the same muscle, a second 1-tap balance resolves the remaining pair
        if (afterR0Warnings.length > 0) {
          balanced = applyBalancedRecommendation(balanced, afterR0Warnings[0], 0);
          afterAnalysis = analyzeMuscleLoad(balanced, sheetData, []);
          afterR0Warnings = afterAnalysis.warnings.filter(w => w.roundIndex === 0);
        }

        assert.equal(
          afterR0Warnings.length,
          0,
          `Recommendation #${recIdx} (${r0Warn.recommendations[recIdx].exercise.name}) for ${idA}+${idB} in ${workoutType} left unresolved warning: ${afterR0Warnings.map(w => w.message).join('; ')}`
        );
        verifiedRecs++;
      }
    }
  }
  console.log(`     (Verified ${verifiedRecs} replacement recommendations with 0 new warnings)`);
});

// ----------------------------------------------------------------------------
// 9. REQUIREMENT 4: SELECT X EXERCISES & AUTO-SLOT MUSCLE DISTRIBUTION
// ----------------------------------------------------------------------------
console.log('\n9. Requirement 4: Select X Exercises & Auto-Slot Muscle Distribution');

test('getTargetExerciseCount returns X = rounds * exercisesPerRound for all 11 workout types', () => {
  const expectedCounts = {
    'strength-duos': 8,
    'strength-trios': 9,
    'strength-quads': 8,
    '8-excercises-40-20': 8,
    'timed-duos-40-20': 8,
    'timed-trios-40-20': 9,
    '6-excercise-pyramid': 6,
    '10-to-1-to-10': 5,
    '30-20-10-10-20-30': 8,
    '5-constant-5-change-40-20': 8,
    '8x8-duos': 8
  };
  for (const wk of sheetData.workouts) {
    assert.equal(
      getTargetExerciseCount(wk),
      expectedCounts[wk.id],
      `Expected target exercise count ${expectedCounts[wk.id]} for ${wk.name}`
    );
  }
});

test('autoSlotExercises & generateWorkoutFromSelectedExercises separate same-muscle exercises into balanced pairs and trios with 0 overload warnings', () => {
  const byId = Object.fromEntries(sheetData.exercises.map(e => [e.id, e]));

  // Test 1: 8 exercises for Timed Duos (40/20) intentionally clustered in pairs of identical muscles:
  // 2 Chest, 2 Back, 2 Quads, 2 Glutes
  const clustered8 = [
    byId['push-ups'],
    byId['chest-flys'],
    byId['rows'],
    byId['pull-ups'],
    byId['squats'],
    byId['lunges-split-squats'],
    byId['frog-pumps'],
    byId['single-leg-band-glute-bridge']
  ];
  const wkDuos = generateWorkoutFromSelectedExercises(sheetData, clustered8, {
    workoutCategory: 'HIIT',
    bodyCategory: 'All',
    equipment: 'Any',
    workoutType: 'Timed Duos (40/20)'
  });

  assert.equal(wkDuos.rounds.length, 4);
  for (const r of wkDuos.rounds) {
    assert.equal(r.slots.length, 2);
    const m0 = Object.keys(r.slots[0].options[0].muscles).find(m => r.slots[0].options[0].muscles[m] === 'Pri');
    const m1 = Object.keys(r.slots[1].options[0].muscles).find(m => r.slots[1].options[0].muscles[m] === 'Pri');
    assert.notEqual(m0, m1, `Duo Round ${r.roundNumber} should not pair two ${m0} exercises together`);
  }
  const analysisDuos = analyzeMuscleLoad(wkDuos, sheetData, []);
  assert.equal(analysisDuos.warnings.length, 0, 'Auto-slotted Duos workout must have 0 muscle overload warnings');

  // Test 2: 9 exercises for Timed Trios (40/20) intentionally clustered in triples:
  // 3 Chest (Upper), 3 Abs (Core), 3 Quads (Legs) -> should auto-slot into 3 Trios each containing 1 Chest + 1 Abs + 1 Quads!
  const clustered9 = [
    byId['push-ups'],
    byId['chest-flys'],
    byId['3-stop-pushups'],
    byId['crunches'],
    byId['plank'],
    byId['bicycle-crunches'],
    byId['squats'],
    byId['lunges-split-squats'],
    byId['sumo-squats']
  ];
  const wkTrios = generateWorkoutFromSelectedExercises(sheetData, clustered9, {
    workoutCategory: 'HIIT',
    bodyCategory: 'All',
    equipment: 'Any',
    workoutType: 'Timed Trios (40/20)'
  });

  assert.equal(wkTrios.rounds.length, 3);
  for (const r of wkTrios.rounds) {
    assert.equal(r.slots.length, 3);
    const priMuscles = r.slots.map(s =>
      Object.keys(s.options[0].muscles).find(m => s.options[0].muscles[m] === 'Pri')
    );
    assert.equal(new Set(priMuscles).size, 3, `Trio Round ${r.roundNumber} must have 3 distinct primary muscles, got ${priMuscles.join(', ')}`);
  }
  const analysisTrios = analyzeMuscleLoad(wkTrios, sheetData, []);
  assert.equal(analysisTrios.warnings.length, 0, 'Auto-slotted Trios workout must have 0 muscle overload warnings');

  // Test 3: Single-round 6-Exercise Pyramid sequence optimization avoids adjacent same-muscle exercises
  const clustered6 = [
    byId['push-ups'],
    byId['chest-flys'],
    byId['rows'],
    byId['pull-ups'],
    byId['squats'],
    byId['lunges-split-squats']
  ];
  const slotted6 = autoSlotExercises(clustered6, 1, 6);
  assert.equal(slotted6.length, 1);
  assert.equal(slotted6[0].length, 6);
  for (let i = 1; i < 6; i++) {
    const prevPri = Object.keys(slotted6[0][i - 1].muscles).find(m => slotted6[0][i - 1].muscles[m] === 'Pri');
    const currPri = Object.keys(slotted6[0][i].muscles).find(m => slotted6[0][i].muscles[m] === 'Pri');
    assert.notEqual(prevPri, currPri, `Adjacent exercises in 6-Exercise Pyramid should not share primary muscle ${currPri}`);
  }
});

// ----------------------------------------------------------------------------
// 10. REQUIREMENT 5: TIMED HIIT TUNED TIMERS & CUSTOM TIMERS
// ----------------------------------------------------------------------------
console.log('\n10. Requirement 5: Timed HIIT Exercise Timer & Custom Timer Engine');

test('Timed Duos (40/20) round timer starts with 10s yellow countdown followed by 6 pairs of 40s green and 20s blue intervals', () => {
  const wk = generateWorkout(sheetData, {
    workoutCategory: 'HIIT',
    bodyCategory: 'All',
    equipment: 'Any',
    workoutType: 'Timed Duos (40/20)'
  });
  assert.equal(isTimedHiitWorkout(wk.workout), true);

  const seq = buildStockTimerSequence(wk, { roundIndex: 0 });
  // 1 countdown + 6 * 2 (work + rest) = 13 steps
  assert.equal(seq.length, 13, `Expected 13 timer steps for 40x20 duo (1 countdown + 6 pairs), got ${seq.length}`);

  // Step 0: 10s yellow countdown
  assert.equal(seq[0].type, 'countdown');
  assert.equal(seq[0].duration, 10);
  assert.equal(seq[0].color, 'yellow');
  assert.equal(formatTimerClock(seq[0].duration), '00:10');

  const exA = getActiveSlotExercise(wk.rounds[0].slots[0]).name;
  const exB = getActiveSlotExercise(wk.rounds[0].slots[1]).name;

  // Steps 1..12: 6 pairs of 40s green work and 20s blue rest
  for (let pairIdx = 0; pairIdx < 6; pairIdx++) {
    const workStep = seq[1 + pairIdx * 2];
    const restStep = seq[2 + pairIdx * 2];
    const expectedExName = pairIdx % 2 === 0 ? exA : exB;

    assert.equal(workStep.type, 'work');
    assert.equal(workStep.duration, 40);
    assert.equal(workStep.color, 'green');
    assert.equal(workStep.exerciseName, expectedExName);

    assert.equal(restStep.type, 'rest');
    assert.equal(restStep.duration, 20);
    assert.equal(restStep.color, 'blue');
  }
});

test('Timed Trios (40/20) round timer starts with 10s yellow countdown followed by 9 pairs of 40s green and 20s blue intervals', () => {
  const wk = generateWorkout(sheetData, {
    workoutCategory: 'HIIT',
    bodyCategory: 'All',
    equipment: 'Any',
    workoutType: 'Timed Trios (40/20)'
  });
  const seq = buildStockTimerSequence(wk, { roundIndex: 0 });
  assert.equal(seq.length, 19, 'Expected 19 steps (1 yellow countdown + 9 green/blue pairs)');
  assert.equal(seq[0].duration, 10);
  assert.equal(seq[0].color, 'yellow');

  for (let pairIdx = 0; pairIdx < 9; pairIdx++) {
    assert.equal(seq[1 + pairIdx * 2].duration, 40);
    assert.equal(seq[1 + pairIdx * 2].color, 'green');
    assert.equal(seq[2 + pairIdx * 2].duration, 20);
    assert.equal(seq[2 + pairIdx * 2].color, 'blue');
  }
});

test('All other Timed HIIT formats (30-20-10-10-20-30, 6 Excercise Pyramid, 5 Constant 5 Change, 8 excercises 40/20, 8x8 Duos) tune accurately and start with 10s yellow countdown', () => {
  // 1. 30-20-10-10-20-30
  const wkWave = generateWorkout(sheetData, { workoutType: '30-20-10-10-20-30' });
  const seqWave = buildStockTimerSequence(wkWave);
  assert.equal(seqWave[0].duration, 10);
  assert.equal(seqWave[0].color, 'yellow');
  const waveWorkDurations = seqWave.filter(s => s.type === 'work').slice(0, 6).map(s => s.duration);
  assert.deepEqual(waveWorkDurations, [30, 20, 10, 10, 20, 30]);

  // 2. 6 Excercise Pyramid
  const wkPyr = generateWorkout(sheetData, { workoutType: '6 Excercise Pyramid' });
  const seqPyr = buildStockTimerSequence(wkPyr);
  assert.equal(seqPyr[0].duration, 10);
  assert.equal(seqPyr[0].color, 'yellow');
  // Set 1 has 1 work step, Set 2 has 2, ..., Set 6 has 6, Set 7 has 5, ..., Set 11 has 1 -> total work steps = 1+2+3+4+5+6+5+4+3+2+1 = 36
  const pyrWorkSteps = seqPyr.filter(s => s.type === 'work');
  assert.equal(pyrWorkSteps.length, 36);
  assert.ok(pyrWorkSteps.every(s => s.duration === 30 && s.color === 'green'));

  // 3. 5 Constant 5 Change (40/20) per round = 10 pairs of 40s green / 20s blue
  const wk55 = generateWorkout(sheetData, { workoutType: '5 Constant 5 Change (40/20)' });
  const seq55 = buildStockTimerSequence(wk55, { roundIndex: 0 });
  assert.equal(seq55.length, 1 + 20);
  assert.equal(seq55[0].color, 'yellow');

  // 4. 8 excercises (40/20) = 24 pairs of 40s green / 20s blue
  const wk8 = generateWorkout(sheetData, { workoutType: '8 excercises (40/20)' });
  const seq8 = buildStockTimerSequence(wk8);
  assert.equal(seq8.length, 1 + 48);

  // 5. 8x8 Duos per round = 10s yellow countdown + 480s green AMRAP
  const wk8x8 = generateWorkout(sheetData, { workoutType: '8x8 Duos' });
  const seq8x8 = buildStockTimerSequence(wk8x8, { roundIndex: 0 });
  assert.equal(seq8x8[0].duration, 10);
  assert.equal(seq8x8[0].color, 'yellow');
  assert.equal(seq8x8[1].duration, 480);
  assert.equal(seq8x8[1].color, 'green');
});

test('Custom Timer presets and per-exercise timer configs customize durations, colors, and added intervals while preserving 10s yellow countdown', () => {
  const wk = generateWorkout(sheetData, { workoutType: 'Timed Duos (40/20)' });
  const ex0 = getActiveSlotExercise(wk.rounds[0].slots[0]);

  const exerciseConfigs = {
    [ex0.id]: {
      workDuration: 45,
      workColor: 'orange',
      restDuration: 15,
      restColor: 'purple',
      extraIntervals: [{ duration: 10, color: 'red', label: 'Burnout Hold' }]
    }
  };

  const seqCustomEx = buildStockTimerSequence(wk, {
    roundIndex: 0,
    slotIndex: 0,
    exerciseConfigs
  });
  assert.equal(seqCustomEx[0].duration, 10);
  assert.equal(seqCustomEx[0].color, 'yellow');
  assert.equal(seqCustomEx[1].duration, 45);
  assert.equal(seqCustomEx[1].color, 'orange');
  assert.equal(seqCustomEx[1].exerciseName, ex0.name);
  assert.equal(seqCustomEx[2].duration, 15);
  assert.equal(seqCustomEx[2].color, 'purple');
  assert.equal(seqCustomEx[3].duration, 10);
  assert.equal(seqCustomEx[3].color, 'red');
  assert.equal(seqCustomEx[3].phaseLabel, 'Burnout Hold');

  // Custom preset sequence
  for (const preset of CUSTOM_TIMER_PRESETS) {
    const pSeq = buildCustomPresetTimerSequence(preset.id, wk);
    assert.equal(pSeq[0].duration, 10);
    assert.equal(pSeq[0].color, 'yellow');
    assert.ok(pSeq.length >= 3);
    const summary = getTimerSequenceSummary(pSeq);
    assert.ok(summary.includes('10s Yellow'));
  }
});

console.log(`\n🎉 ALL ${passed} QA TEST SUITES PASSED SUCCESSFULLY!`);
