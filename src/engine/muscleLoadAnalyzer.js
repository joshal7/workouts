/**
 * Muscle Load Analyzer & Auto-Balance Recommender
 * Inspects active exercises across each round and the full workout to detect
 * accidental muscle group overloading (e.g., stacking Triceps or Glutes & Quads)
 * and combines multiple overloaded muscles in the same round into a single warning line.
 */

import {
  filterEligibleExercises,
  getActiveSlotExercise,
  swapExerciseInSlot
} from './workoutEngine.js';

export const SPECIFIC_MUSCLES = [
  'Chest',
  'Biceps',
  'Triceps',
  'Shoulders',
  'Back',
  'Abs',
  'Glutes',
  'Quads',
  'Hamstrings'
];

export const MUSCLE_TO_BODY_AREA = {
  Chest: 'Upper Body',
  Biceps: 'Upper Body',
  Triceps: 'Upper Body',
  Shoulders: 'Upper Body',
  Back: 'Upper Body',
  Abs: 'Core',
  Glutes: 'Legs',
  Quads: 'Legs',
  Hamstrings: 'Legs'
};

/**
 * Format an array of muscle names into a single combined label (e.g., "Glutes & Quads").
 */
export function formatCombinedMuscles(muscles) {
  if (!muscles || muscles.length === 0) return '';
  if (muscles.length === 1) return muscles[0];
  if (muscles.length === 2) return `${muscles[0]} & ${muscles[1]}`;
  return `${muscles.slice(0, -1).join(', ')} & ${muscles[muscles.length - 1]}`;
}

/**
 * Analyze a workout for muscle group overload and compute balanced replacement recommendations.
 * Multiple overloaded muscles within the same round are combined into a single warning per round.
 */
export function analyzeMuscleLoad(workoutState, sheetData, excludedExerciseIds = []) {
  if (!workoutState || !workoutState.rounds || !sheetData) {
    return {
      hasWarnings: false,
      warnings: [],
      workoutMuscleTotals: {},
      roundSummaries: []
    };
  }

  const bodyCategory = workoutState.inputs?.bodyCategory || 'All';
  const equipment = workoutState.inputs?.equipment || 'Any';
  const effectiveWorkoutCategory =
    workoutState.inputs?.effectiveWorkoutCategory ||
    workoutState.workout?.workoutCategory ||
    'Either';

  // Collect all currently active exercise IDs across the workout
  const activeWorkoutExerciseIds = new Set();
  const workoutMuscleTotals = {};
  SPECIFIC_MUSCLES.forEach(m => {
    workoutMuscleTotals[m] = { pri: 0, sec: 0, score: 0, exercises: [] };
  });

  workoutState.rounds.forEach(round => {
    round.slots.forEach(slot => {
      const ex = getActiveSlotExercise(slot);
      if (!ex) return;
      activeWorkoutExerciseIds.add(ex.id);
      SPECIFIC_MUSCLES.forEach(m => {
        const level = ex.muscles?.[m] || '';
        if (level === 'Pri') {
          workoutMuscleTotals[m].pri += 1;
          workoutMuscleTotals[m].score += 1.0;
          workoutMuscleTotals[m].exercises.push(ex.name);
        } else if (level === 'Sec') {
          workoutMuscleTotals[m].sec += 1;
          workoutMuscleTotals[m].score += 0.5;
          workoutMuscleTotals[m].exercises.push(`${ex.name} (sec)`);
        }
      });
    });
  });

  // Eligible replacement pool respecting user filters & exclusions
  const eligiblePool = filterEligibleExercises(sheetData.exercises, {
    workoutCategory: effectiveWorkoutCategory,
    bodyCategory,
    equipment,
    excludedExerciseIds
  });

  const warnings = [];
  const roundSummaries = [];

  // Check each round for specific muscle overload
  workoutState.rounds.forEach((round, roundIndex) => {
    const roundStats = {};
    SPECIFIC_MUSCLES.forEach(m => {
      roundStats[m] = { pri: 0, sec: 0, score: 0, contributingSlots: [] };
    });

    round.slots.forEach((slot, slotIndex) => {
      const ex = getActiveSlotExercise(slot);
      if (!ex) return;
      SPECIFIC_MUSCLES.forEach(m => {
        const level = ex.muscles?.[m] || '';
        if (level === 'Pri') {
          roundStats[m].pri += 1;
          roundStats[m].score += 1.0;
          roundStats[m].contributingSlots.push({
            slotIndex,
            exercise: ex,
            level: 'Pri',
            manuallyModified: !!slot.manuallyModified
          });
        } else if (level === 'Sec') {
          roundStats[m].sec += 1;
          roundStats[m].score += 0.5;
          roundStats[m].contributingSlots.push({
            slotIndex,
            exercise: ex,
            level: 'Sec',
            manuallyModified: !!slot.manuallyModified
          });
        }
      });
    });

    roundSummaries.push({ roundNumber: round.roundNumber, stats: roundStats });

    const nSlots = round.slots.length;
    if (nSlots < 2) return;

    const overloadedInRound = [];

    // Determine which muscles are overloaded in this round
    SPECIFIC_MUSCLES.forEach(muscle => {
      const st = roundStats[muscle];
      if (st.pri === 0) return;

      // If the user explicitly asked for 'Core' only, Abs being hit on every exercise is expected
      if (muscle === 'Abs' && bodyCategory === 'Core') return;

      const isLegsMuscleInLegsFilter =
        (muscle === 'Glutes' || muscle === 'Quads') &&
        (bodyCategory === 'Legs' || bodyCategory === 'Legs and Core');

      const hasManualContributor = st.contributingSlots.some(c => c.manuallyModified);

      let isOverloaded = false;
      if (!isLegsMuscleInLegsFilter) {
        if (nSlots <= 4 && st.pri >= 2 && (muscle !== 'Abs' || st.pri >= 3 || hasManualContributor)) {
          isOverloaded = true;
        } else if (nSlots > 4 && st.pri >= 3 && (muscle !== 'Abs' || st.pri >= 4)) {
          isOverloaded = true;
        } else if (hasManualContributor && st.pri >= 1 && st.score >= 2.0 && st.contributingSlots.length >= 2) {
          isOverloaded = true;
        }
      } else {
        if ((nSlots <= 4 && st.pri >= 3) || (hasManualContributor && st.pri >= 2 && st.score >= 2.5)) {
          isOverloaded = true;
        }
      }

      if (isOverloaded) {
        overloadedInRound.push(muscle);
      }
    });

    // Combine all overloaded muscles in this round into a SINGLE warning entry
    if (overloadedInRound.length > 0) {
      const combinedMuscleLabel = formatCombinedMuscles(overloadedInRound);

      // Collect all contributing slots across the overloaded muscles in this round
      const slotContributionMap = new Map();
      const contributingExerciseNames = [];

      overloadedInRound.forEach(muscle => {
        roundStats[muscle].contributingSlots.forEach(c => {
          if (!contributingExerciseNames.includes(c.exercise.name)) {
            contributingExerciseNames.push(c.exercise.name);
          }
          const prev = slotContributionMap.get(c.slotIndex) || {
            slotIndex: c.slotIndex,
            exercise: c.exercise,
            manuallyModified: c.manuallyModified,
            priHits: 0,
            totalHits: 0
          };
          if (c.level === 'Pri') prev.priHits += 1;
          prev.totalHits += 1;
          prev.manuallyModified = prev.manuallyModified || c.manuallyModified;
          slotContributionMap.set(c.slotIndex, prev);
        });
      });

      const sortedContributors = [...slotContributionMap.values()].sort((a, b) => {
        if (a.manuallyModified !== b.manuallyModified) return a.manuallyModified ? -1 : 1;
        if (b.priHits !== a.priHits) return b.priHits - a.priHits;
        if (b.totalHits !== a.totalHits) return b.totalHits - a.totalHits;
        return b.slotIndex - a.slotIndex;
      });

      const targetSlotInfo = sortedContributors[0];
      const recommendations = getBalancedAlternatives({
        overloadedMuscles: overloadedInRound,
        targetExercise: targetSlotInfo.exercise,
        eligiblePool,
        activeWorkoutExerciseIds,
        workoutMuscleTotals,
        roundStats,
        bodyCategory
      });

      if (recommendations.length > 0) {
        const totalPri = Math.max(...overloadedInRound.map(m => roundStats[m].pri));
        const totalSec = Math.max(...overloadedInRound.map(m => roundStats[m].sec));
        const maxScore = Math.max(...overloadedInRound.map(m => roundStats[m].score));

        warnings.push({
          id: `warn-r${round.roundNumber}-${overloadedInRound.map(m => m.toLowerCase()).join('-')}`,
          roundIndex,
          roundNumber: round.roundNumber,
          muscle: combinedMuscleLabel,
          overloadedMuscles: overloadedInRound,
          bodyArea: MUSCLE_TO_BODY_AREA[overloadedInRound[0]],
          priCount: totalPri,
          secCount: totalSec,
          score: maxScore,
          contributingExercises: contributingExerciseNames,
          targetSlotIndex: targetSlotInfo.slotIndex,
          targetExercise: targetSlotInfo.exercise,
          recommendations,
          message: `${combinedMuscleLabel} ${overloadedInRound.length > 1 ? 'are' : 'is'} heavily loaded in Round ${round.roundNumber} (${contributingExerciseNames.join(', ')}).`
        });
      }
    }
  });

  return {
    hasWarnings: warnings.length > 0,
    warnings,
    workoutMuscleTotals,
    roundSummaries
  };
}

/**
 * Compute ranked replacement exercises that relieve all overloaded muscles in the round and target under-used muscles.
 */
function getBalancedAlternatives({
  overloadedMuscles,
  targetExercise,
  eligiblePool,
  activeWorkoutExerciseIds,
  workoutMuscleTotals,
  roundStats,
  bodyCategory
}) {
  const musclesList = Array.isArray(overloadedMuscles) ? overloadedMuscles : [overloadedMuscles];
  const combinedLabel = formatCombinedMuscles(musclesList);

  // Filter candidates not already in workout and not hitting any of the overloaded muscles
  let candidates = eligiblePool.filter(
    ex =>
      !activeWorkoutExerciseIds.has(ex.id) &&
      ex.id !== targetExercise.id &&
      musclesList.every(m => !ex.muscles?.[m])
  );

  // Fallback if all unused exercises hit one of those muscles as Sec: allow Sec but not Pri
  if (candidates.length === 0) {
    candidates = eligiblePool.filter(
      ex =>
        !activeWorkoutExerciseIds.has(ex.id) &&
        ex.id !== targetExercise.id &&
        musclesList.every(m => ex.muscles?.[m] !== 'Pri')
    );
  }

  // Score candidates by how well they balance under-used muscles in the round & workout
  const scored = candidates.map(ex => {
    let balanceScore = 0;

    SPECIFIC_MUSCLES.forEach(m => {
      if (ex.muscles?.[m] === 'Pri') {
        const roundLoad = roundStats[m]?.score || 0;
        const workoutLoad = workoutMuscleTotals[m]?.score || 0;
        if (roundLoad === 0) balanceScore += 15;
        if (workoutLoad === 0) balanceScore += 10;
        balanceScore -= roundLoad * 4 + workoutLoad * 2;
      } else if (ex.muscles?.[m] === 'Sec') {
        const roundLoad = roundStats[m]?.score || 0;
        balanceScore -= roundLoad * 1.5;
      }
    });

    const overloadedArea = MUSCLE_TO_BODY_AREA[musclesList[0]];
    if (bodyCategory === 'Upper Body' && ex.bodyCategories['Upper Body'] === 'Pri') {
      balanceScore += 8;
    } else if (bodyCategory === 'All' && ex.bodyCategories[overloadedArea] !== 'Pri') {
      balanceScore += 6;
    }

    const primaryMuscles = SPECIFIC_MUSCLES.filter(m => ex.muscles?.[m] === 'Pri');

    return {
      exercise: ex,
      balanceScore,
      targetMuscles: primaryMuscles,
      reason: `Targets ${primaryMuscles.join(' & ')} with zero ${combinedLabel} strain`
    };
  });

  scored.sort((a, b) => b.balanceScore - a.balanceScore);
  return scored.slice(0, 5);
}

/**
 * Apply the top recommended balanced alternative for a specific warning in 1 tap.
 */
export function applyBalancedRecommendation(workoutState, warning, chosenExercise = null) {
  if (!workoutState || !warning) return workoutState;
  const replacement = chosenExercise || warning.recommendations?.[0]?.exercise;
  if (!replacement) return workoutState;

  return swapExerciseInSlot(
    workoutState,
    warning.roundIndex,
    warning.targetSlotIndex,
    replacement
  );
}
