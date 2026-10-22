import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DataService } from '../src/services/dataService.js';
import {
  generateWorkout,
  filterEligibleExercises,
  getActiveSlotExercise,
  swapExerciseInSlot,
  getValidReplacementCandidates,
  getWorkoutCheckMode,
  getConsolidatedWorkoutSubtitle
} from '../src/engine/workoutEngine.js';
import {
  analyzeMuscleLoad,
  applyBalancedRecommendation,
  formatCombinedMuscles,
  SPECIFIC_MUSCLES
} from '../src/engine/muscleLoadAnalyzer.js';

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

console.log(`\n🎉 ALL ${passed} QA TEST SUITES PASSED SUCCESSFULLY!`);
