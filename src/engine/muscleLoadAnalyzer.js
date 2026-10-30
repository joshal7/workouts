/**
 * Muscle Load Analyzer & Auto-Balance Recommender
 * Inspects active exercises across each round and the full workout to detect
 * accidental muscle group or Focus body-area overloading (e.g., stacking Triceps,
 * Glutes & Quads, or exceeding the Focus slider weighting via manual selections)
 * and combines overloaded muscles in the same round into a single warning line.
 * Guarantees that recommended replacements never trigger a new muscle or Focus overload warning.
 */

import {
  BODY_AREAS,
  MANUAL_FOCUS_ERROR_BAR,
  computeWorkoutAreaQuotas,
  filterEligibleExercises,
  getActiveSlotExercise,
  getPrimaryBodyArea,
  normalizeFocusWeights,
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

function formatBodyAreaDisplay(area) {
  return area === 'Legs' ? 'Lower Body' : area;
}

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
 * Analyze a workout for muscle group & Focus body-area overload and compute balanced replacement recommendations.
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
      workoutAreaTotals: { 'Upper Body': 0, 'Core': 0, 'Legs': 0 },
      roundSummaries: []
    };
  }

  const bodyCategory = workoutState.inputs?.bodyCategory || 'All';
  const equipment = workoutState.inputs?.equipment || 'Any';
  const effectiveWorkoutCategory =
    workoutState.inputs?.effectiveWorkoutCategory ||
    workoutState.workout?.workoutCategory ||
    'Either';

  const isSpecificMuscleFilter = SPECIFIC_MUSCLES.includes(bodyCategory);
  const { weights: focusWeights, enabled: focusEnabled } = normalizeFocusWeights(
    workoutState.inputs || { bodyCategory }
  );

  const dismissedSet = new Set([
    ...(workoutState.dismissedWarnings || []),
    ...(Array.isArray(dismissedWarnings) ? dismissedWarnings : [])
  ]);

  // Collect all currently active exercise IDs, muscle totals, and body-area counts across the workout
  const activeWorkoutExerciseIds = new Set();
  const workoutMuscleTotals = {};
  SPECIFIC_MUSCLES.forEach(m => {
    workoutMuscleTotals[m] = { pri: 0, sec: 0, score: 0, exercises: [] };
  });
  const workoutAreaCounts = { 'Upper Body': 0, 'Core': 0, 'Legs': 0 };
  let hasAnyManualSlot = false;

  workoutState.rounds.forEach(round => {
    round.slots.forEach(slot => {
      if (slot.manuallyModified) hasAnyManualSlot = true;
      const ex = getActiveSlotExercise(slot);
      if (!ex) return;
      activeWorkoutExerciseIds.add(ex.id);
      const area = getPrimaryBodyArea(ex);
      if (workoutAreaCounts[area] !== undefined) {
        workoutAreaCounts[area] += 1;
      }
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

  // Eligible replacement pool respecting user filters, Focus weights, & exclusions
  const eligiblePool = filterEligibleExercises(sheetData.exercises, {
    workoutCategory: effectiveWorkoutCategory,
    bodyCategory,
    equipment,
    excludedExerciseIds,
    focusWeights: isSpecificMuscleFilter ? null : focusWeights,
    focusEnabled: isSpecificMuscleFilter ? null : focusEnabled
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
  const expectedAreaQuotas = computeWorkoutAreaQuotas(totalWorkoutSlots, focusWeights);

  const warnings = [];
  const roundSummaries = [];

  // Check each round for specific muscle overload & minority Focus bunching
  workoutState.rounds.forEach((round, roundIndex) => {
    const roundStats = {};
    SPECIFIC_MUSCLES.forEach(m => {
      roundStats[m] = { pri: 0, sec: 0, score: 0, contributingSlots: [] };
    });

    const roundAreaStats = {
      'Upper Body': { count: 0, slots: [] },
      'Core': { count: 0, slots: [] },
      'Legs': { count: 0, slots: [] }
    };
    let hasManualInRound = false;

    round.slots.forEach((slot, slotIndex) => {
      if (slot.manuallyModified) hasManualInRound = true;
      const ex = getActiveSlotExercise(slot);
      if (!ex) return;

      const area = getPrimaryBodyArea(ex);
      if (roundAreaStats[area]) {
        roundAreaStats[area].count += 1;
        roundAreaStats[area].slots.push({
          slotIndex,
          exercise: ex,
          manuallyModified: !!slot.manuallyModified
        });
      }

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

      // If the user explicitly asked for 100% Core, Abs being hit on every exercise is expected
      if (muscle === 'Abs' && focusWeights['Core'] >= 0.999) return;

      const hasManualContributor = st.contributingSlots.some(
        c => c.level === 'Pri' && c.manuallyModified
      );

      // If the user explicitly filtered by this single muscle group, it is expected
      if (muscle === bodyCategory || (isSpecificMuscleFilter && !hasManualContributor)) return;

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
      const expectedAreaInWorkout =
        expectedAreaQuotas[area] ?? Math.round((focusWeights[area] || 0) * totalWorkoutSlots);
      const areaSlotsInRound = Math.ceil(expectedAreaInWorkout / Math.max(1, nRounds));

      const nonMuscleAreaConsumedInAlts = round.slots.filter(
        s =>
          (s.selectedOptionIndex || 0) > 0 &&
          s.options?.[0]?.bodyCategories?.[area] === 'Pri' &&
          s.options?.[0]?.muscles?.[muscle] !== 'Pri' &&
          nonMuscleInArea <= areaSlotsInRound
      ).length;
      const effectiveNonMuscleInArea = Math.max(0, nonMuscleInArea - nonMuscleAreaConsumedInAlts);
      const unavoidableInAreaPerRound = Math.max(0, areaSlotsInRound - effectiveNonMuscleInArea);

      // Every Core exercise has Abs as Pri: if Core focus is high (>=60%) and expects `areaSlotsInRound` Core slots,
      // up to `areaSlotsInRound` Abs in a round is expected even after manual Core-to-Core swaps
      const maxManualCoreAllowed = Math.ceil((focusWeights['Core'] || 0) * totalWorkoutSlots - 1e-9) + 1;
      if (
        muscle === 'Abs' &&
        !isSpecificMuscleFilter &&
        focusWeights['Core'] >= 0.6 - 1e-9 &&
        st.pri <= areaSlotsInRound &&
        workoutAreaCounts['Core'] <= maxManualCoreAllowed
      ) {
        return;
      }

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

      const isLegsMuscleInLegsFilter =
        (muscle === 'Glutes' || muscle === 'Quads') &&
        !isSpecificMuscleFilter &&
        focusWeights['Legs'] >= 0.5 - 1e-9;

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

      const targetExArea = getPrimaryBodyArea(targetSlotInfo.exercise);
      const maxManualTargetArea =
        Math.ceil((focusWeights[targetExArea] || 0) * totalWorkoutSlots - 1e-9) + 1;
      const isTargetAreaOverloaded =
        !isSpecificMuscleFilter && (workoutAreaCounts[targetExArea] || 0) > maxManualTargetArea;

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
        bodyCategory,
        focusWeights: isSpecificMuscleFilter ? null : focusWeights,
        workoutAreaCounts,
        expectedAreaQuotas,
        nRounds,
        totalWorkoutSlots,
        forceDifferentBodyArea: isTargetAreaOverloaded
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
      return;
    }

    // Intra-round minority Focus bunching check (e.g., manually placing 2 Lower Body exercises into the same Duo round
    // when Lower Body is a minority focus < 45% across a multi-round workout)
    if (!isSpecificMuscleFilter && nRounds >= 2 && (hasManualInRound || workoutState.customSelected)) {
      for (const area of BODY_AREAS) {
        const w = focusWeights[area] || 0;
        const roundCount = roundAreaStats[area].count;
        const expectedPerRound = Math.max(
          1,
          Math.ceil((expectedAreaQuotas[area] || 0) / nRounds)
        );
        // (b) Larger error bar for manual intra-round Focus bunching:
        // - If minority focus (w <= 0.30, e.g. 25% Lower in Duos): warn if >=2 stacked in one round (> expectedPerRound)
        // - If ~1/3 to <50% focus (0.30 < w < 0.50): tolerate 2-exercise agonist/antagonist pairs (e.g. Chest+Back)
        //   or 2/3 in a Trio, and only warn intra-round if an entire >=3-slot round is 100% one <50% body area
        const isMinorityRoundBunch = w <= 0.3 + 1e-9 && roundCount >= 2 && roundCount > expectedPerRound;
        const isFullMultiSlotRoundSkew =
          w > 0.3 + 1e-9 && w < 0.5 - 1e-9 && nSlots >= 3 && roundCount >= nSlots;

        if (isMinorityRoundBunch || isFullMultiSlotRoundSkew) {
          const areaSlug = area.toLowerCase().replace(/\s+/g, '-');
          const warningId = `warn-r${round.roundNumber}-${areaSlug}-focus`;
          if (dismissedSet.has(warningId) || dismissedSet.has(`round-${roundIndex}`)) {
            break;
          }

          const sortedAreaSlots = [...roundAreaStats[area].slots].sort((a, b) => {
            if (a.manuallyModified !== b.manuallyModified) return a.manuallyModified ? -1 : 1;
            return b.slotIndex - a.slotIndex;
          });
          const targetSlotInfo = sortedAreaSlots[0];
          if (!targetSlotInfo) break;

          const recommendations = getBalancedAlternatives({
            overloadedMuscles: [],
            overloadedBodyArea: area,
            round,
            targetSlotIndex: targetSlotInfo.slotIndex,
            targetExercise: targetSlotInfo.exercise,
            eligiblePool,
            categoryEquipmentPool,
            allNonExcludedPool,
            activeWorkoutExerciseIds,
            workoutMuscleTotals,
            roundStats,
            bodyCategory,
            focusWeights,
            workoutAreaCounts,
            expectedAreaQuotas,
            nRounds,
            totalWorkoutSlots,
            forceDifferentBodyArea: true
          });

          if (recommendations.length > 0) {
            const areaLabel = formatBodyAreaDisplay(area);
            const contributingNames = roundAreaStats[area].slots.map(s => s.exercise.name);
            warnings.push({
              id: warningId,
              roundIndex,
              roundNumber: round.roundNumber,
              muscle: areaLabel,
              overloadedMuscles: [areaLabel],
              bodyArea: area,
              isFocusOverload: true,
              priCount: roundCount,
              secCount: 0,
              score: roundCount,
              contributingExercises: contributingNames,
              targetSlotIndex: targetSlotInfo.slotIndex,
              targetExercise: targetSlotInfo.exercise,
              recommendations,
              message: `${areaLabel} exercises are bunched in Round ${round.roundNumber} (${contributingNames.join(', ')}) relative to your ${Math.round(w * 100)}% Focus setting.`
            });
          }
          break;
        }
      }
    }
  });

  // (b) Workout-wide Focus overload check from manual selections using larger error bar (MANUAL_FOCUS_ERROR_BAR)
  if (!isSpecificMuscleFilter && (hasAnyManualSlot || workoutState.customSelected)) {
    for (const area of BODY_AREAS) {
      const w = focusWeights[area] || 0;
      const actual = workoutAreaCounts[area] || 0;
      const maxAllowedManual = Math.ceil(w * totalWorkoutSlots - 1e-9) + 1;
      const excessRatio = actual / Math.max(1, totalWorkoutSlots) - w;

      if (actual > maxAllowedManual && excessRatio >= MANUAL_FOCUS_ERROR_BAR - 1e-9) {
        const areaSlug = area.toLowerCase().replace(/\s+/g, '-');
        // If user already dismissed this body area's focus warning anywhere in the workout, do not move it to another round
        const focusWarnDismissed = [...dismissedSet].some(id => id.endsWith(`-${areaSlug}-focus`));
        if (focusWarnDismissed) continue;

        // If an existing warning already targets an exercise of this overloaded body area,
        // applying its 1-tap swap already reduces `actual` without adding a duplicate banner
        const alreadyAddressed = warnings.some(
          warn => getPrimaryBodyArea(warn.targetExercise) === area
        );
        if (alreadyAddressed) continue;

        const roundsWithWarn = new Set(warnings.map(warn => warn.roundIndex));
        const candidateRounds = [];

        workoutState.rounds.forEach((round, roundIndex) => {
          if (roundsWithWarn.has(roundIndex)) return;
          const roundPrefix = `warn-r${round.roundNumber}-`;
          const roundWasDismissed =
            dismissedSet.has(`round-${roundIndex}`) ||
            [...dismissedSet].some(id => id.startsWith(roundPrefix));
          if (roundWasDismissed) return;

          const matchingSlots = [];
          round.slots.forEach((slot, slotIndex) => {
            const ex = getActiveSlotExercise(slot);
            if (ex && getPrimaryBodyArea(ex) === area) {
              matchingSlots.push({
                slotIndex,
                exercise: ex,
                manuallyModified: !!slot.manuallyModified
              });
            }
          });
          const hasManual = matchingSlots.some(s => s.manuallyModified);
          if (matchingSlots.length > 0 && (hasManual || workoutState.customSelected)) {
            candidateRounds.push({
              round,
              roundIndex,
              matchingSlots,
              hasManual
            });
          }
        });

        candidateRounds.sort((a, b) => {
          if (a.hasManual !== b.hasManual) return a.hasManual ? -1 : 1;
          if (b.matchingSlots.length !== a.matchingSlots.length) {
            return b.matchingSlots.length - a.matchingSlots.length;
          }
          return b.roundIndex - a.roundIndex;
        });

        for (const candRound of candidateRounds) {
          const warningId = `warn-r${candRound.round.roundNumber}-${areaSlug}-focus`;
          if (dismissedSet.has(warningId) || dismissedSet.has(`round-${candRound.roundIndex}`)) {
            continue;
          }

          const sortedSlots = [...candRound.matchingSlots].sort((a, b) => {
            if (a.manuallyModified !== b.manuallyModified) return a.manuallyModified ? -1 : 1;
            return b.slotIndex - a.slotIndex;
          });
          const targetSlotInfo = sortedSlots[0];
          const roundSummary = roundSummaries[candRound.roundIndex];

          const recommendations = getBalancedAlternatives({
            overloadedMuscles: [],
            overloadedBodyArea: area,
            round: candRound.round,
            targetSlotIndex: targetSlotInfo.slotIndex,
            targetExercise: targetSlotInfo.exercise,
            eligiblePool,
            categoryEquipmentPool,
            allNonExcludedPool,
            activeWorkoutExerciseIds,
            workoutMuscleTotals,
            roundStats: roundSummary?.stats || {},
            bodyCategory,
            focusWeights,
            workoutAreaCounts,
            expectedAreaQuotas,
            nRounds,
            totalWorkoutSlots,
            forceDifferentBodyArea: true
          });

          if (recommendations.length > 0) {
            const areaLabel = formatBodyAreaDisplay(area);
            const contributingNames = candRound.matchingSlots.map(s => s.exercise.name);
            warnings.push({
              id: warningId,
              roundIndex: candRound.roundIndex,
              roundNumber: candRound.round.roundNumber,
              muscle: areaLabel,
              overloadedMuscles: [areaLabel],
              bodyArea: area,
              isFocusOverload: true,
              priCount: actual,
              secCount: 0,
              score: actual,
              contributingExercises: contributingNames,
              targetSlotIndex: targetSlotInfo.slotIndex,
              targetExercise: targetSlotInfo.exercise,
              recommendations,
              message: `${areaLabel} Focus is overloaded across the workout (${actual} of ${totalWorkoutSlots} exercises vs ${Math.round(w * 100)}% target).`
            });
            break;
          }
        }
      }
    }
  }

  warnings.sort((a, b) => a.roundIndex - b.roundIndex);

  return {
    hasWarnings: warnings.length > 0,
    warnings,
    workoutMuscleTotals,
    workoutAreaTotals: workoutAreaCounts,
    roundSummaries
  };
}

/**
 * Compute ranked replacement exercises that relieve the overloaded muscles or Focus body area
 * AND never collide with any other exercise's primary muscle in that round or push another
 * Focus body area into overload.
 */
function getBalancedAlternatives({
  overloadedMuscles,
  overloadedBodyArea = null,
  round,
  targetSlotIndex,
  targetExercise,
  eligiblePool,
  categoryEquipmentPool = [],
  allNonExcludedPool = [],
  activeWorkoutExerciseIds,
  workoutMuscleTotals,
  roundStats,
  bodyCategory,
  focusWeights = null,
  workoutAreaCounts = null,
  expectedAreaQuotas = null,
  nRounds = 1,
  totalWorkoutSlots = 8,
  forceDifferentBodyArea = false
}) {
  const musclesList = Array.isArray(overloadedMuscles) ? overloadedMuscles : [overloadedMuscles];
  const combinedLabel =
    musclesList.length > 0
      ? formatCombinedMuscles(musclesList)
      : formatBodyAreaDisplay(overloadedBodyArea || getPrimaryBodyArea(targetExercise));

  const targetExArea = getPrimaryBodyArea(targetExercise);
  const nSlots = round?.slots?.length || 2;
  const otherSlotsExercises = (round?.slots || [])
    .filter((_, idx) => idx !== targetSlotIndex)
    .map(s => getActiveSlotExercise(s))
    .filter(Boolean);

  const roundExerciseIds = new Set(
    (round?.slots || []).map(s => getActiveSlotExercise(s)?.id).filter(Boolean)
  );

  // Count primary muscles and body areas in the OTHER slots of this round
  const otherSlotsPriCounts = {};
  SPECIFIC_MUSCLES.forEach(m => {
    otherSlotsPriCounts[m] = 0;
  });
  const otherRoundAreaCounts = { 'Upper Body': 0, 'Core': 0, 'Legs': 0 };

  otherSlotsExercises.forEach(ex => {
    const a = getPrimaryBodyArea(ex);
    if (otherRoundAreaCounts[a] !== undefined) {
      otherRoundAreaCounts[a] += 1;
    }
    SPECIFIC_MUSCLES.forEach(m => {
      if (ex.muscles?.[m] === 'Pri') {
        otherSlotsPriCounts[m] += 1;
      }
    });
  });

  // Helper: does replacing targetSlotIndex with `candidate` cause any new muscle or Focus overload?
  function causesNoNewOverload(candidate, enforceFocusBounds = true) {
    // 1. Must not hit any of the currently overloaded muscles as Primary
    if (musclesList.some(m => candidate.muscles?.[m] === 'Pri')) {
      return false;
    }

    const candArea = getPrimaryBodyArea(candidate);
    if (forceDifferentBodyArea && candArea === targetExArea) {
      return false;
    }

    // 2. Must not hit any muscle as Primary if that would create a >=2 (or >=3) primary overload with other slots in this round
    const maxAllowedOtherPri = nSlots <= 4 ? 0 : 1;
    const expectedCoreInRound = expectedAreaQuotas
      ? Math.ceil((expectedAreaQuotas['Core'] || 0) / Math.max(1, nRounds))
      : 1;
    for (const m of SPECIFIC_MUSCLES) {
      if (candidate.muscles?.[m] === 'Pri') {
        if (m === 'Abs') {
          if (focusWeights && focusWeights['Core'] >= 0.999) continue;
          if (!focusWeights && bodyCategory === 'Core') continue;
          if (
            focusWeights &&
            focusWeights['Core'] >= 0.6 - 1e-9 &&
            (otherRoundAreaCounts['Core'] || 0) + 1 <= expectedCoreInRound &&
            !musclesList.includes('Abs')
          ) {
            continue;
          }
        }
        if (otherSlotsPriCounts[m] > maxAllowedOtherPri) {
          return false;
        }
      }
    }

    // 3. Respect Focus weighting bounds so swapping never creates a new Focus overload or minority bunching
    if (enforceFocusBounds && focusWeights && workoutAreaCounts) {
      const wCand = focusWeights[candArea] || 0;
      if (wCand <= 1e-9) return false;

      const newCandAreaCount =
        (workoutAreaCounts[candArea] || 0) - (candArea === targetExArea ? 1 : 0) + 1;
      const maxManualCand = Math.ceil(wCand * totalWorkoutSlots - 1e-9) + 1;
      if (newCandAreaCount > maxManualCand) {
        return false;
      }

      if (nRounds >= 2 && wCand < 0.45) {
        const expectedCand = expectedAreaQuotas?.[candArea] || 0;
        const maxBalancedInRound = Math.max(
          1,
          Math.ceil(Math.max(newCandAreaCount, expectedCand) / nRounds)
        );
        if ((otherRoundAreaCounts[candArea] || 0) + 1 > maxBalancedInRound) {
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
      causesNoNewOverload(ex, true)
  );

  // Tier 2: Unused in entire workout, from eligiblePool, zero Pri on overloaded muscles, zero new overload
  if (candidates.length === 0) {
    candidates = eligiblePool.filter(
      ex =>
        !activeWorkoutExerciseIds.has(ex.id) &&
        ex.id !== targetExercise.id &&
        causesNoNewOverload(ex, true)
    );
  }

  // Tier 3: Unused in current round, from eligiblePool, zero new overload
  if (candidates.length === 0) {
    candidates = eligiblePool.filter(
      ex =>
        !roundExerciseIds.has(ex.id) &&
        ex.id !== targetExercise.id &&
        causesNoNewOverload(ex, true)
    );
  }

  // Tier 4: Unused in entire workout, from categoryEquipmentPool (wider body area), respecting focus bounds first
  if (candidates.length === 0 && categoryEquipmentPool.length > 0) {
    candidates = categoryEquipmentPool.filter(
      ex =>
        !activeWorkoutExerciseIds.has(ex.id) &&
        ex.id !== targetExercise.id &&
        causesNoNewOverload(ex, true)
    );
    if (candidates.length === 0) {
      candidates = categoryEquipmentPool.filter(
        ex =>
          !activeWorkoutExerciseIds.has(ex.id) &&
          ex.id !== targetExercise.id &&
          causesNoNewOverload(ex, false)
      );
    }
  }

  // Tier 5: Unused in current round, from allNonExcludedPool, zero new overload
  if (candidates.length === 0 && allNonExcludedPool.length > 0) {
    candidates = allNonExcludedPool.filter(
      ex =>
        !roundExerciseIds.has(ex.id) &&
        ex.id !== targetExercise.id &&
        causesNoNewOverload(ex, true)
    );
    if (candidates.length === 0) {
      candidates = allNonExcludedPool.filter(
        ex =>
          !roundExerciseIds.has(ex.id) &&
          ex.id !== targetExercise.id &&
          causesNoNewOverload(ex, false)
      );
    }
  }

  // Score candidates by how well they balance under-used muscles and Focus body areas
  const scored = candidates.map(ex => {
    let balanceScore = 0;
    const candArea = getPrimaryBodyArea(ex);

    // Bonus if candidate is from the user's primary eligiblePool and unused in the workout
    if (eligiblePool.some(e => e.id === ex.id)) balanceScore += 25;
    if (!activeWorkoutExerciseIds.has(ex.id)) balanceScore += 15;
    if (musclesList.length > 0 && musclesList.every(m => !ex.muscles?.[m])) balanceScore += 10;

    SPECIFIC_MUSCLES.forEach(m => {
      if (ex.muscles?.[m] === 'Pri') {
        const roundLoad = otherSlotsPriCounts[m] || 0;
        const workoutLoad = workoutMuscleTotals[m]?.score || 0;
        if (roundLoad === 0) balanceScore += 15;
        if (workoutLoad === 0) balanceScore += 10;
        balanceScore -= roundLoad * 6 + workoutLoad * 2;
      } else if (ex.muscles?.[m] === 'Sec') {
        const roundLoad = roundStats?.[m]?.score || 0;
        balanceScore -= roundLoad * 1.5;
      }
    });

    if (focusWeights && workoutAreaCounts) {
      const targetSlotsForCand = (focusWeights[candArea] || 0) * totalWorkoutSlots;
      const currentAfterRemove =
        (workoutAreaCounts[candArea] || 0) - (candArea === targetExArea ? 1 : 0);
      const areaDeficit = targetSlotsForCand - currentAfterRemove;
      balanceScore += areaDeficit * 12;
      if ((otherRoundAreaCounts[candArea] || 0) === 0) {
        balanceScore += 8;
      }
    } else if (musclesList.length > 0) {
      const overloadedArea = MUSCLE_TO_BODY_AREA[musclesList[0]];
      if (bodyCategory === 'Upper Body' && ex.bodyCategories['Upper Body'] === 'Pri') {
        balanceScore += 8;
      } else if (bodyCategory === 'All' && ex.bodyCategories[overloadedArea] !== 'Pri') {
        balanceScore += 6;
      }
    }

    const primaryMuscles = SPECIFIC_MUSCLES.filter(m => ex.muscles?.[m] === 'Pri');
    const reason =
      musclesList.length > 0
        ? `Targets ${primaryMuscles.join(' & ')} with zero ${combinedLabel} strain`
        : `Restores ${formatBodyAreaDisplay(candArea)} Focus (${primaryMuscles.join(' & ')})`;

    return {
      exercise: ex,
      balanceScore,
      targetMuscles: primaryMuscles,
      reason
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
