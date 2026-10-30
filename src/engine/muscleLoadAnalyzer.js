/**
 * Muscle Load Analyzer & Auto-Balance Recommender
 * Inspects active exercises across each round and the full workout to detect
 * accidental muscle group overloading (e.g., stacking Triceps or Glutes & Quads)
 * and combines multiple overloaded muscles in the same round into a single warning line.
 * Guarantees that recommended replacements never trigger a new muscle overload warning.
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
export function analyzeMuscleLoad(
  workoutState,
  sheetData,
  excludedExerciseIds = [],
  dismissedWarnings = null
) {
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

  const dismissedSet = new Set([
    ...(workoutState.dismissedWarnings || []),
    ...(Array.isArray(dismissedWarnings) ? dismissedWarnings : [])
  ]);

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

  // Fallback pools if current filter combination is super narrow (e.g. Strength + Legs + Nothing)
  const categoryEquipmentPool = filterEligibleExercises(sheetData.exercises, {
    workoutCategory: effectiveWorkoutCategory,
    bodyCategory: 'All',
    equipment,
    excludedExerciseIds
  });
  const allNonExcludedPool = sheetData.exercises.filter(
    ex => !excludedExerciseIds.includes(ex.id) && !excludedExerciseIds.includes(ex.name)
  );

  // Count distinct primary muscles available in the eligiblePool
  const distinctPriMusclesInPool = new Set();
  eligiblePool.forEach(ex => {
    SPECIFIC_MUSCLES.forEach(m => {
      if (ex.muscles?.[m] === 'Pri') distinctPriMusclesInPool.add(m);
    });
  });

  const nRounds = workoutState.rounds.length || 1;
  const totalWorkoutSlots = workoutState.rounds.reduce((acc, r) => acc + r.slots.length, 0);

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
      const hasManualContributor = st.contributingSlots.some(
        c => c.level === 'Pri' && c.manuallyModified
      );

      // If the user explicitly filtered by this single muscle group, it is expected
      if (muscle === bodyCategory || (SPECIFIC_MUSCLES.includes(bodyCategory) && !hasManualContributor)) return;

      // Compute unavoidable minimum per round given the eligiblePool size & muscle distribution
      const nonMuscleInPool = eligiblePool.filter(e => e.muscles?.[muscle] !== 'Pri').length;
      const nonMuscleConsumedInSlotAlts = round.slots.filter(
        s =>
          (s.selectedOptionIndex || 0) > 0 &&
          s.options?.[0]?.muscles?.[muscle] !== 'Pri' &&
          nonMuscleInPool <= nSlots
      ).length;
      const effectiveNonMuscle = Math.max(0, nonMuscleInPool - nonMuscleConsumedInSlotAlts);

      // Also check unavoidable minimum within this muscle's specific body area (Upper Body, Core, or Legs)
      const area = MUSCLE_TO_BODY_AREA[muscle];
      const areaPool = eligiblePool.filter(e => e.bodyCategories?.[area] === 'Pri');
      const nonMuscleInArea = areaPool.filter(e => e.muscles?.[muscle] !== 'Pri').length;
      const areaSlotsInRound =
        bodyCategory === area
          ? nSlots
          : bodyCategory.includes(area)
          ? Math.ceil(nSlots * 0.5)
          : Math.ceil(nSlots / 3);
      const nonMuscleAreaConsumedInAlts = round.slots.filter(
        s =>
          (s.selectedOptionIndex || 0) > 0 &&
          s.options?.[0]?.bodyCategories?.[area] === 'Pri' &&
          s.options?.[0]?.muscles?.[muscle] !== 'Pri' &&
          nonMuscleInArea <= areaSlotsInRound
      ).length;
      const effectiveNonMuscleInArea = Math.max(0, nonMuscleInArea - nonMuscleAreaConsumedInAlts);
      const unavoidableInAreaPerRound = Math.max(0, areaSlotsInRound - effectiveNonMuscleInArea);

      const hasMultiOptionSelectionInTightPool =
        distinctPriMusclesInPool.size < nSlots &&
        round.slots.some(s => (s.selectedOptionIndex || 0) > 0);
      const pigeonholePerRound =
        Math.ceil(nSlots / Math.max(1, distinctPriMusclesInPool.size)) +
        (hasMultiOptionSelectionInTightPool ? 1 : 0);

      const uniqueTargets = Math.min(totalWorkoutSlots, eligiblePool.length);
      const unavoidableInWorkout = Math.max(0, uniqueTargets - effectiveNonMuscle);
      const unavoidablePerRound = Math.max(
        1,
        Math.max(0, nSlots - effectiveNonMuscle),
        unavoidableInAreaPerRound,
        Math.ceil(unavoidableInWorkout / nRounds),
        pigeonholePerRound
      );

      if (!hasManualContributor && st.pri <= unavoidablePerRound) {
        return;
      }

      // In 'Upper Body and Core' or 'Legs and Core', 50% of the round is Core (which only has Abs as Pri)
      if (
        muscle === 'Abs' &&
        (bodyCategory === 'Upper Body and Core' || bodyCategory === 'Legs and Core') &&
        st.pri <= Math.ceil(nSlots * 0.5) &&
        !hasManualContributor
      ) {
        return;
      }

      const isLegsMuscleInLegsFilter =
        (muscle === 'Glutes' || muscle === 'Quads') &&
        (bodyCategory === 'Legs' ||
          bodyCategory === 'Legs and Core' ||
          bodyCategory === 'Upper Body and Legs');

      let isOverloaded = false;
      if (!isLegsMuscleInLegsFilter) {
        if (nSlots <= 4 && st.pri >= 2 && (muscle !== 'Abs' || st.pri >= 3 || hasManualContributor)) {
          isOverloaded = true;
        } else if (nSlots > 4 && st.pri >= 3 && (muscle !== 'Abs' || st.pri >= 4)) {
          isOverloaded = true;
        }
      } else {
        if ((nSlots <= 4 && st.pri >= 3) || (hasManualContributor && st.pri >= 2)) {
          isOverloaded = true;
        } else if (nSlots > 4 && st.pri >= 4) {
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
      const warningId = `warn-r${round.roundNumber}-${overloadedInRound.map(m => m.toLowerCase()).join('-')}`;

      // Skip if user explicitly dismissed this warning
      if (dismissedSet.has(warningId) || dismissedSet.has(`round-${roundIndex}`)) {
        return;
      }

      // Collect all Primary contributing slots across the overloaded muscles in this round
      const slotContributionMap = new Map();
      const contributingExerciseNames = [];

      overloadedInRound.forEach(muscle => {
        roundStats[muscle].contributingSlots.forEach(c => {
          if (c.level === 'Pri' && !contributingExerciseNames.includes(c.exercise.name)) {
            contributingExerciseNames.push(c.exercise.name);
          }
          if (c.level !== 'Pri') return;
          const prev = slotContributionMap.get(c.slotIndex) || {
            slotIndex: c.slotIndex,
            exercise: c.exercise,
            manuallyModified: c.manuallyModified,
            priHits: 0,
            totalHits: 0
          };
          prev.priHits += 1;
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
      if (!targetSlotInfo) return;

      const recommendations = getBalancedAlternatives({
        overloadedMuscles: overloadedInRound,
        round,
        targetSlotIndex: targetSlotInfo.slotIndex,
        targetExercise: targetSlotInfo.exercise,
        eligiblePool,
        categoryEquipmentPool,
        allNonExcludedPool,
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
          id: warningId,
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
 * Compute ranked replacement exercises that relieve the overloaded muscles in the round
 * AND never collide with any other exercise's primary muscle in that round (so swapping
 * never triggers a new muscle overload warning!).
 */
function getBalancedAlternatives({
  overloadedMuscles,
  round,
  targetSlotIndex,
  targetExercise,
  eligiblePool,
  categoryEquipmentPool = [],
  allNonExcludedPool = [],
  activeWorkoutExerciseIds,
  workoutMuscleTotals,
  roundStats,
  bodyCategory
}) {
  const musclesList = Array.isArray(overloadedMuscles) ? overloadedMuscles : [overloadedMuscles];
  const combinedLabel = formatCombinedMuscles(musclesList);

  const nSlots = round?.slots?.length || 2;
  const otherSlotsExercises = (round?.slots || [])
    .filter((_, idx) => idx !== targetSlotIndex)
    .map(s => getActiveSlotExercise(s))
    .filter(Boolean);

  const roundExerciseIds = new Set(
    (round?.slots || []).map(s => getActiveSlotExercise(s)?.id).filter(Boolean)
  );

  // Count primary muscles in the OTHER slots of this round
  const otherSlotsPriCounts = {};
  SPECIFIC_MUSCLES.forEach(m => {
    otherSlotsPriCounts[m] = 0;
  });
  otherSlotsExercises.forEach(ex => {
    SPECIFIC_MUSCLES.forEach(m => {
      if (ex.muscles?.[m] === 'Pri') {
        otherSlotsPriCounts[m] += 1;
      }
    });
  });

  // Helper: does replacing targetSlotIndex with `candidate` cause any new muscle overload in this round?
  function causesNoNewOverload(candidate) {
    // 1. Must not hit any of the currently overloaded muscles as Primary
    if (musclesList.some(m => candidate.muscles?.[m] === 'Pri')) {
      return false;
    }
    // 2. Must not hit any muscle as Primary if that would create a >=2 (or >=3) primary overload with other slots in this round
    const maxAllowedOtherPri = nSlots <= 4 ? 0 : 1;
    for (const m of SPECIFIC_MUSCLES) {
      if (candidate.muscles?.[m] === 'Pri') {
        if (m === 'Abs' && bodyCategory === 'Core') continue;
        if (otherSlotsPriCounts[m] > maxAllowedOtherPri) {
          return false;
        }
      }
    }
    return true;
  }

  // Tier 1: Unused in entire workout, from eligiblePool, zero Pri/Sec on overloaded muscles, zero new overload
  let candidates = eligiblePool.filter(
    ex =>
      !activeWorkoutExerciseIds.has(ex.id) &&
      ex.id !== targetExercise.id &&
      musclesList.every(m => !ex.muscles?.[m]) &&
      causesNoNewOverload(ex)
  );

  // Tier 2: Unused in entire workout, from eligiblePool, zero Pri on overloaded muscles, zero new overload
  if (candidates.length === 0) {
    candidates = eligiblePool.filter(
      ex =>
        !activeWorkoutExerciseIds.has(ex.id) &&
        ex.id !== targetExercise.id &&
        causesNoNewOverload(ex)
    );
  }

  // Tier 3: Unused in current round, from eligiblePool, zero new overload
  if (candidates.length === 0) {
    candidates = eligiblePool.filter(
      ex =>
        !roundExerciseIds.has(ex.id) &&
        ex.id !== targetExercise.id &&
        causesNoNewOverload(ex)
    );
  }

  // Tier 4: Unused in entire workout, from categoryEquipmentPool (wider body area), zero new overload
  if (candidates.length === 0 && categoryEquipmentPool.length > 0) {
    candidates = categoryEquipmentPool.filter(
      ex =>
        !activeWorkoutExerciseIds.has(ex.id) &&
        ex.id !== targetExercise.id &&
        causesNoNewOverload(ex)
    );
  }

  // Tier 5: Unused in current round, from allNonExcludedPool, zero new overload
  if (candidates.length === 0 && allNonExcludedPool.length > 0) {
    candidates = allNonExcludedPool.filter(
      ex =>
        !roundExerciseIds.has(ex.id) &&
        ex.id !== targetExercise.id &&
        causesNoNewOverload(ex)
    );
  }

  // Score candidates by how well they balance under-used muscles in the round & workout
  const scored = candidates.map(ex => {
    let balanceScore = 0;

    // Bonus if candidate is from the user's primary eligiblePool and unused in the workout
    if (eligiblePool.some(e => e.id === ex.id)) balanceScore += 25;
    if (!activeWorkoutExerciseIds.has(ex.id)) balanceScore += 15;
    if (musclesList.every(m => !ex.muscles?.[m])) balanceScore += 10;

    SPECIFIC_MUSCLES.forEach(m => {
      if (ex.muscles?.[m] === 'Pri') {
        const roundLoad = otherSlotsPriCounts[m] || 0;
        const workoutLoad = workoutMuscleTotals[m]?.score || 0;
        if (roundLoad === 0) balanceScore += 15;
        if (workoutLoad === 0) balanceScore += 10;
        balanceScore -= roundLoad * 6 + workoutLoad * 2;
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
 * Note: passes isManual = false so auto-balancing doesn't mark the slot as a manual override.
 */
export function applyBalancedRecommendation(workoutState, warning, chosenExercise = null) {
  if (!workoutState || !warning) return workoutState;
  const replacement =
    typeof chosenExercise === 'number'
      ? warning.recommendations?.[chosenExercise]?.exercise
      : chosenExercise || warning.recommendations?.[0]?.exercise;
  if (!replacement) return workoutState;

  return swapExerciseInSlot(
    workoutState,
    warning.roundIndex,
    warning.targetSlotIndex,
    replacement,
    null,
    false
  );
}
