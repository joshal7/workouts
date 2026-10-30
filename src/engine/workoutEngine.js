/**
 * Workout Generator Engine
 * 1:1 Port of Google Apps Script `generateWorkout()` +
 * Per-User Exercise Exclusions, Clarified Equipment Filtering, Multi-Option Slots (1, 2, or 3),
 * Format-Aware Checkbox Modes, Conflict-Free Generation, and Custom X-Exercise Auto-Slotting.
 */

export const BODY_AREAS = ['Upper Body', 'Core', 'Legs'];

export const SPECIFIC_MUSCLE_LIST = [
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

export const MAX_BODY_CATEGORY_PERCENTAGES = {
  'All': 0.33,
  'Upper Body': 1.0,
  'Lower Body': 1.0,
  'Core': 1.0,
  'Legs': 1.0,
  'Upper Body and Core': 0.5,
  'Lower Body and Core': 0.5,
  'Lower Body & Core': 0.5,
  'Legs and Core': 0.5,
  'Upper Body and Legs': 0.5,
  'Upper Body and Lower Body': 0.5
};

const CONTINUOUS_WORKOUT_IDS = new Set([
  '6-excercise-pyramid',
  '10-to-1-to-10',
  '30-20-10-10-20-30',
  '5-constant-5-change-40-20'
]);

/**
 * Determine the checkbox behavior for a given workout type:
 * - 'none': Continuous / pyramid / ladder / complex interval workouts -> skip checkboxes altogether
 * - 'round': Unfixed sets per round (e.g., 8x8 Duos AMRAP) -> single checkbox next to each Round
 * - 'exercise-sets': Fixed sets per round (e.g., 3 sets in Strength/Timed Duos/Trios/Quads/8-Ex) -> small checkbox per set next to each exercise
 */
export function getWorkoutCheckMode(workout) {
  if (!workout) return { mode: 'none', count: 0 };
  if (CONTINUOUS_WORKOUT_IDS.has(workout.id)) {
    return { mode: 'none', count: 0 };
  }
  const rawSets = workout.setsPerRound;
  if (rawSets === null || rawSets === undefined || rawSets === '') {
    return { mode: 'round', count: 1 };
  }
  const sets = Number(rawSets);
  if (Number.isNaN(sets) || sets <= 0) {
    return { mode: 'round', count: 1 };
  }
  if (sets > 5) {
    return { mode: 'none', count: 0 };
  }
  return { mode: 'exercise-sets', count: sets };
}

/**
 * Consolidate workout structure and comments into a single non-duplicative summary line.
 */
export function getConsolidatedWorkoutSubtitle(workoutState) {
  const wk = workoutState?.workout;
  if (!wk) return '';

  const consolidatedMap = {
    'strength-duos': '4 rounds · 2 exercises · 3 sets/round',
    'strength-trios': '3 rounds · 3 exercises · 3 sets/round',
    'strength-quads': '2 rounds · 4 exercises · 3 sets (2 supersets + 2 burnout)',
    'timed-duos-40-20': '4 rounds · 2 exercises · 3 sets (40s work / 20s rest)',
    'timed-trios-40-20': '3 rounds · 3 exercises · 3 sets (40s work / 20s rest)',
    '8-excercises-40-20': '1 round · 8 exercises · 3 sets (40s work / 20s rest)',
    '30-20-10-10-20-30': '8 exercises · 6 sets each (30/20/10/10/20/30s work/rest)',
    '10-to-1-to-10': '5 exercises · 10 reps (per side) down to 1, back up to 10',
    '6-excercise-pyramid': '6 exercises · 11 pyramid sets (30s work / 30s rest)',
    '8x8-duos': '4 rounds · 2 exercises · 8-min AMRAP (8 reps each, no rest)',
    '5-constant-5-change-40-20': '3 rounds · 6 exercises · 10 sets (first 3 are round constants)'
  };

  if (consolidatedMap[wk.id]) {
    return consolidatedMap[wk.id];
  }

  const setsStr =
    wk.setsPerRound !== null && wk.setsPerRound !== ''
      ? `${wk.setsPerRound} sets/round`
      : 'AMRAP';
  return `${wk.rounds} round${wk.rounds > 1 ? 's' : ''} · ${wk.exercisesPerRound} exercises · ${setsStr}`;
}

/**
 * Pick a random element from an array using an optional RNG function (defaults to Math.random).
 */
export function getRandomEntry(arr, rng = Math.random) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Determine the primary muscle for an exercise (e.g., 'Chest', 'Triceps', 'Quads').
 */
export function getPrimaryMuscle(exercise) {
  if (!exercise || !exercise.muscles) return '';
  for (const m of SPECIFIC_MUSCLE_LIST) {
    if (exercise.muscles[m] === 'Pri') return m;
  }
  return '';
}

/**
 * Determine the primary body area ('Upper Body', 'Core', or 'Legs') for an exercise.
 */
export function getPrimaryBodyArea(exercise) {
  if (!exercise || !exercise.bodyCategories) return 'All';
  for (const area of BODY_AREAS) {
    if (exercise.bodyCategories[area] === 'Pri') return area;
  }
  return 'All';
}

/**
 * Filter exercises based on Workout Category, Equipment, Body Category / Specific Muscle Group, and User Exclusion List.
 */
export function filterEligibleExercises(allExercises, {
  workoutCategory,
  bodyCategory = 'All',
  equipment = 'Any',
  excludedExerciseIds = [],
  muscleGroup = null
}) {
  const excludedSet = new Set(excludedExerciseIds);

  // 1. Exclude user's excluded exercises
  let pool = allExercises.filter(ex => !excludedSet.has(ex.id) && !excludedSet.has(ex.name));

  // 2. Filter by workoutCategory ('Strength' or 'HIIT' matches exact or 'Either')
  if (workoutCategory && workoutCategory !== 'Either') {
    pool = pool.filter(
      ex => ex.workoutCategory === workoutCategory || ex.workoutCategory === 'Either'
    );
  }

  // 3. Filter by equipment
  if (equipment === 'Weights') {
    pool = pool.filter(ex => ex.equipment !== 'Bands');
  } else if (equipment === 'Bands') {
    pool = pool.filter(ex => ex.equipment !== 'Weights');
  } else if (equipment === 'Nothing') {
    pool = pool.filter(
      ex => ex.equipment === 'Nothing' || ex.equipment === 'Any' || ex.equipment === 'All'
    );
  }

  // 4. Filter by bodyCategory or specific muscle group
  const targetFilter = muscleGroup && muscleGroup !== 'All' ? muscleGroup : bodyCategory;
  if (targetFilter === 'Upper Body') {
    pool = pool.filter(ex => ex.bodyCategories['Upper Body'] === 'Pri');
  } else if (targetFilter === 'Core') {
    pool = pool.filter(ex => ex.bodyCategories['Core'] === 'Pri');
  } else if (targetFilter === 'Legs' || targetFilter === 'Lower Body') {
    pool = pool.filter(ex => ex.bodyCategories['Legs'] === 'Pri');
  } else if (targetFilter === 'Upper Body and Core' || targetFilter === 'Upper & Core') {
    pool = pool.filter(
      ex => ex.bodyCategories['Upper Body'] === 'Pri' || ex.bodyCategories['Core'] === 'Pri'
    );
  } else if (
    targetFilter === 'Legs and Core' ||
    targetFilter === 'Lower Body and Core' ||
    targetFilter === 'Lower Body & Core'
  ) {
    pool = pool.filter(
      ex => ex.bodyCategories['Legs'] === 'Pri' || ex.bodyCategories['Core'] === 'Pri'
    );
  } else if (
    targetFilter === 'Upper Body and Legs' ||
    targetFilter === 'Upper Body and Lower Body' ||
    targetFilter === 'Upper & Lower Body'
  ) {
    pool = pool.filter(
      ex => ex.bodyCategories['Upper Body'] === 'Pri' || ex.bodyCategories['Legs'] === 'Pri'
    );
  } else if (SPECIFIC_MUSCLE_LIST.includes(targetFilter)) {
    const priPool = pool.filter(ex => ex.muscles?.[targetFilter] === 'Pri');
    const secPool = pool.filter(ex => ex.muscles?.[targetFilter] === 'Sec');
    pool = priPool.length >= 3 ? priPool : [...priPool, ...secPool];
  }

  return pool;
}

/**
 * Shared filter helper for Swap Modal, Select X Exercises Modal, Exclusion List, and QA Gallery.
 * Accurately matches muscle groups (Primary muscle or Body Area) and text search queries.
 */
export function filterExercisesByMuscleAndQuery(exercises, {
  muscleFilter = 'All',
  query = ''
} = {}) {
  let result = [...exercises];

  if (muscleFilter && muscleFilter !== 'All' && muscleFilter !== 'all') {
    if (muscleFilter === 'Lower Body' || muscleFilter === 'Legs') {
      result = result.filter(ex => ex.bodyCategories?.['Legs'] === 'Pri');
    } else if (BODY_AREAS.includes(muscleFilter)) {
      result = result.filter(ex => ex.bodyCategories?.[muscleFilter] === 'Pri');
    } else if (muscleFilter === 'Upper Body and Core' || muscleFilter === 'Upper & Core') {
      result = result.filter(
        ex => ex.bodyCategories?.['Upper Body'] === 'Pri' || ex.bodyCategories?.['Core'] === 'Pri'
      );
    } else if (
      muscleFilter === 'Legs and Core' ||
      muscleFilter === 'Lower Body and Core' ||
      muscleFilter === 'Lower Body & Core'
    ) {
      result = result.filter(
        ex => ex.bodyCategories?.['Legs'] === 'Pri' || ex.bodyCategories?.['Core'] === 'Pri'
      );
    } else if (
      muscleFilter === 'Upper Body and Legs' ||
      muscleFilter === 'Upper Body and Lower Body' ||
      muscleFilter === 'Upper & Lower Body'
    ) {
      result = result.filter(
        ex => ex.bodyCategories?.['Upper Body'] === 'Pri' || ex.bodyCategories?.['Legs'] === 'Pri'
      );
    } else if (SPECIFIC_MUSCLE_LIST.includes(muscleFilter)) {
      const priMatches = result.filter(ex => ex.muscles?.[muscleFilter] === 'Pri');
      const secMatches = result.filter(ex => ex.muscles?.[muscleFilter] === 'Sec');
      result = [...priMatches, ...secMatches];
    }
  }

  const q = (query || '').trim().toLowerCase();
  if (q) {
    // Check if the query specifically names a muscle group or body area
    const matchedMuscle = SPECIFIC_MUSCLE_LIST.find(
      m => m.toLowerCase() === q || m.toLowerCase().startsWith(q) && q.length >= 3
    );

    result = result.filter(ex => {
      const priMuscles = Object.entries(ex.muscles || {})
        .filter(([, v]) => v === 'Pri')
        .map(([k]) => k.toLowerCase());
      const allMuscles = Object.entries(ex.muscles || {})
        .filter(([, v]) => v)
        .map(([k]) => k.toLowerCase());
      const priAreas = Object.entries(ex.bodyCategories || {})
        .filter(([, v]) => v === 'Pri')
        .map(([k]) => k.toLowerCase());

      if (ex.name.toLowerCase().includes(q)) return true;
      if ((ex.equipment || '').toLowerCase().includes(q)) return true;
      if (priMuscles.some(m => m.includes(q))) return true;
      if (priAreas.some(a => a.includes(q))) return true;
      if (('lower body'.includes(q) && q.length >= 4) && ex.bodyCategories?.['Legs'] === 'Pri') return true;
      if (allMuscles.some(m => m.includes(q))) return true;
      if (ex.enrichment?.pose && ex.enrichment.pose.toLowerCase().includes(q)) return true;
      return false;
    });

    if (matchedMuscle) {
      result.sort((a, b) => {
        const aPri = a.muscles?.[matchedMuscle] === 'Pri' ? 1 : 0;
        const bPri = b.muscles?.[matchedMuscle] === 'Pri' ? 1 : 0;
        return bPri - aPri;
      });
    }
  }

  return result;
}

/**
 * Determine the target workout object and how many unique exercises (X) it requires.
 */
export function getTargetExerciseCount(sheetData, inputs = {}, fallbackWorkout = null) {
  // Support direct call getTargetExerciseCount(workoutObj)
  if (sheetData && !sheetData.workouts && sheetData.rounds !== undefined) {
    const r = parseInt(sheetData.rounds, 10) || 1;
    const e = parseInt(sheetData.exercisesPerRound, 10) || 1;
    return r * e;
  }
  if (!sheetData || !sheetData.workouts) {
    return { workout: null, count: 8, rounds: 4, exercisesPerRound: 2 };
  }
  const { workoutCategory = 'HIIT', workoutType = 'Random' } = inputs;
  let wk = null;
  if (workoutType && workoutType !== 'Random') {
    wk = sheetData.workouts.find(w => w.name === workoutType || w.id === workoutType);
  }
  if (!wk && fallbackWorkout) {
    if (
      workoutCategory === 'Either' ||
      fallbackWorkout.workoutCategory === workoutCategory
    ) {
      wk = fallbackWorkout;
    }
  }
  if (!wk) {
    const cat = workoutCategory === 'Either' ? 'HIIT' : workoutCategory;
    wk = sheetData.workouts.find(w => w.workoutCategory === cat) || sheetData.workouts[0];
  }
  const rounds = parseInt(wk.rounds, 10) || 1;
  const exercisesPerRound = parseInt(wk.exercisesPerRound, 10) || 1;
  return {
    workout: wk,
    count: rounds * exercisesPerRound,
    rounds,
    exercisesPerRound
  };
}

/**
 * Helper to prune a pool of exercises by the round's current bodyCategoryPercent.
 */
function prunePoolByBodyCategory(pool, bodyCategoryPercent, maxBodyCategoryPercent) {
  let pruned = [...pool];
  BODY_AREAS.forEach(area => {
    if (bodyCategoryPercent[area] >= maxBodyCategoryPercent - 1e-9) {
      const next = pruned.filter(ex => ex.bodyCategories[area] !== 'Pri');
      if (next.length > 0) {
        pruned = next;
      }
    }
  });
  return pruned;
}

/**
 * Generate a complete workout matching the Apps Script algorithm + multi-option slots,
 * while guaranteeing zero avoidable muscle overload warnings in any round.
 */
export function generateWorkout(sheetData, inputs = {}, rng = Math.random) {
  const {
    workoutCategory: rawWorkoutCategory = 'HIIT',
    bodyCategory = 'All',
    equipment = 'Any',
    workoutType = 'Random',
    excludedExerciseIds = [],
    optionsPerSlot = 1
  } = inputs;

  const numOptions = Math.min(3, Math.max(1, Number(optionsPerSlot) || 1));

  // Step 1: Resolve Workout Category if 'Either'
  let resolvedWorkoutCategory = rawWorkoutCategory;
  if (resolvedWorkoutCategory === 'Either') {
    resolvedWorkoutCategory = getRandomEntry(['Strength', 'HIIT'], rng);
  }

  // Step 2: Resolve Workout Type (Random vs Manually Selected)
  let selectedWorkout = null;
  if (!workoutType || workoutType === 'Random') {
    const categoryWorkouts = sheetData.workouts.filter(
      w => w.workoutCategory === resolvedWorkoutCategory
    );
    selectedWorkout = getRandomEntry(categoryWorkouts, rng) || sheetData.workouts[0];
  } else {
    selectedWorkout =
      sheetData.workouts.find(w => w.name === workoutType || w.id === workoutType) ||
      sheetData.workouts[0];
    // Parity with Apps Script line 74: manually selected workout updates workout_category
    resolvedWorkoutCategory = selectedWorkout.workoutCategory;
  }

  const checkMode = getWorkoutCheckMode(selectedWorkout);

  // Step 3: Filter eligible exercises
  const allFiltered = filterEligibleExercises(sheetData.exercises, {
    workoutCategory: resolvedWorkoutCategory,
    bodyCategory,
    equipment,
    excludedExerciseIds
  });

  // Fallback if user excluded almost everything
  const basePool = allFiltered.length > 0
    ? [...allFiltered]
    : sheetData.exercises.filter(ex => !excludedExerciseIds.includes(ex.id));

  let masterExercises = [...basePool];

  const nRounds = parseInt(selectedWorkout.rounds, 10) || 1;
  const nExercisesPerRound = parseInt(selectedWorkout.exercisesPerRound, 10) || 1;
  const maxBodyCategoryPercent =
    MAX_BODY_CATEGORY_PERCENTAGES[bodyCategory] !== undefined
      ? MAX_BODY_CATEGORY_PERCENTAGES[bodyCategory]
      : 1.0;

  const usedExerciseIds = new Set();
  const rounds = [];

  // Step 4: Loop over rounds and select balanced exercises
  for (let rnd = 0; rnd < nRounds; rnd++) {
    let exercisesRound = masterExercises.filter(ex => !usedExerciseIds.has(ex.id));
    const roundSlots = [];

    const bodyCategoryPercent = {
      'Upper Body': 0,
      'Core': 0,
      'Legs': 0
    };

    for (let exIdx = 0; exIdx < nExercisesPerRound; exIdx++) {
      if (exercisesRound.length === 0) {
        exercisesRound = prunePoolByBodyCategory(
          masterExercises.filter(ex => !usedExerciseIds.has(ex.id)),
          bodyCategoryPercent,
          maxBodyCategoryPercent
        );
      }
      if (exercisesRound.length === 0) {
        const roundIds = new Set(
          roundSlots.flatMap(s => s.options.map(o => o.id))
        );
        exercisesRound = prunePoolByBodyCategory(
          basePool.filter(ex => !roundIds.has(ex.id)),
          bodyCategoryPercent,
          maxBodyCategoryPercent
        );
      }
      if (exercisesRound.length === 0) {
        exercisesRound = [...basePool];
      }

      // Count how many times each Primary muscle is already used in this round
      const roundPriMuscleCounts = {};
      SPECIFIC_MUSCLE_LIST.forEach(m => {
        roundPriMuscleCounts[m] = 0;
      });
      const roundUsedPriMuscles = new Set();
      roundSlots.forEach(s => {
        const active = s.options[0];
        if (!active?.muscles) return;
        Object.entries(active.muscles).forEach(([m, lvl]) => {
          if (lvl === 'Pri') {
            roundUsedPriMuscles.add(m);
            roundPriMuscleCounts[m] = (roundPriMuscleCounts[m] || 0) + 1;
          }
        });
      });

      let nonCollidingRoundPool = exercisesRound.filter(ex => {
        const exPri = getPrimaryMuscle(ex);
        return !exPri || !roundUsedPriMuscles.has(exPri);
      });

      // If unused masterExercises ran out of non-colliding muscles for this round,
      // check basePool (not already in this round) before allowing any muscle collision in the round!
      if (nonCollidingRoundPool.length === 0) {
        const roundIds = new Set(roundSlots.flatMap(s => s.options.map(o => o.id)));
        const fallbackCandidates = prunePoolByBodyCategory(
          basePool.filter(ex => !roundIds.has(ex.id) && !usedExerciseIds.has(ex.id)),
          bodyCategoryPercent,
          maxBodyCategoryPercent
        ).filter(ex => {
          const exPri = getPrimaryMuscle(ex);
          return !exPri || !roundUsedPriMuscles.has(exPri);
        });
        if (fallbackCandidates.length > 0) {
          nonCollidingRoundPool = fallbackCandidates;
        }
      }

      // Try inter-round swap with an earlier round if nonCollidingRoundPool is still empty
      let primaryExercise = null;
      if (nonCollidingRoundPool.length === 0 && rnd > 0 && exercisesRound.length > 0) {
        outerSwap: for (const strandedEx of exercisesRound) {
          const strandedPri = getPrimaryMuscle(strandedEx);
          const strandedArea = getPrimaryBodyArea(strandedEx);
          for (let prevR = 0; prevR < rnd; prevR++) {
            const prevRound = rounds[prevR];
            const prevMuscles = new Set(
              prevRound.slots.map(s => getPrimaryMuscle(s.options[0]))
            );
            if (prevMuscles.has(strandedPri)) continue;
            for (let prevS = 0; prevS < prevRound.slots.length; prevS++) {
              const candidateFromPrev = prevRound.slots[prevS].options[0];
              const candPri = getPrimaryMuscle(candidateFromPrev);
              const candArea = getPrimaryBodyArea(candidateFromPrev);
              if (
                candPri &&
                !roundUsedPriMuscles.has(candPri) &&
                candArea === strandedArea &&
                prevRound.slots[prevS].options.length === 1
              ) {
                // Swap strandedEx into prevRound and use candidateFromPrev here!
                prevRound.slots[prevS].options[0] = strandedEx;
                usedExerciseIds.add(strandedEx.id);
                masterExercises = masterExercises.filter(ex => ex.id !== strandedEx.id);
                exercisesRound = exercisesRound.filter(ex => ex.id !== strandedEx.id);
                primaryExercise = candidateFromPrev;
                break outerSwap;
              }
            }
          }
        }
      }

      // If still no non-colliding exercise from unused pool, check basePool (not in current round)
      if (!primaryExercise && nonCollidingRoundPool.length === 0) {
        const roundIds = new Set(roundSlots.flatMap(s => s.options.map(o => o.id)));
        const reuseNonColliding = prunePoolByBodyCategory(
          basePool.filter(ex => !roundIds.has(ex.id)),
          bodyCategoryPercent,
          maxBodyCategoryPercent
        ).filter(ex => {
          const exPri = getPrimaryMuscle(ex);
          return !exPri || !roundUsedPriMuscles.has(exPri);
        });
        if (reuseNonColliding.length > 0) {
          nonCollidingRoundPool = reuseNonColliding;
        }
      }

      if (!primaryExercise) {
        if (nonCollidingRoundPool.length > 0) {
          primaryExercise = getRandomEntry(nonCollidingRoundPool, rng);
        } else {
          // If round has more slots than distinct primary muscles in pool (e.g. 8-slot Upper Body round with 5 muscles),
          // pick from candidates whose primary muscle has the MINIMUM count in the current round so far!
          const roundIds = new Set(roundSlots.flatMap(s => s.options.map(o => o.id)));
          const candidatePool =
            exercisesRound.length > 0
              ? exercisesRound
              : basePool.filter(ex => !roundIds.has(ex.id));
          const poolToScore = candidatePool.length > 0 ? candidatePool : basePool;
          const minCount = Math.min(
            ...poolToScore.map(ex => roundPriMuscleCounts[getPrimaryMuscle(ex)] || 0)
          );
          const minCountPool = poolToScore.filter(
            ex => (roundPriMuscleCounts[getPrimaryMuscle(ex)] || 0) === minCount
          );
          primaryExercise = getRandomEntry(minCountPool, rng);
        }
      }

      usedExerciseIds.add(primaryExercise.id);

      masterExercises = masterExercises.filter(ex => ex.id !== primaryExercise.id);
      exercisesRound = exercisesRound.filter(ex => ex.id !== primaryExercise.id);

      BODY_AREAS.forEach(area => {
        const isPri = primaryExercise.bodyCategories[area] === 'Pri' ? 1 : 0;
        bodyCategoryPercent[area] += isPri / nExercisesPerRound;
      });

      exercisesRound = prunePoolByBodyCategory(
        exercisesRound,
        bodyCategoryPercent,
        maxBodyCategoryPercent
      );

      const slotOptions = [primaryExercise];

      roundSlots.push({
        roundIndex: rnd,
        slotIndex: exIdx,
        options: slotOptions,
        selectedOptionIndex: 0,
        optionChosen: false,
        completed: false,
        completedSets:
          checkMode.mode === 'exercise-sets'
            ? Array.from({ length: checkMode.count }, () => false)
            : [],
        manuallyModified: false
      });
    }

    rounds.push({
      roundNumber: rnd + 1,
      completed: false,
      slots: roundSlots
    });
  }

  // Step 5: Populate additional options (Option 2 / Option 3) if optionsPerSlot > 1
  // Done after all primary slot exercises are chosen so every round's full muscle profile is known
  if (numOptions > 1) {
    for (const round of rounds) {
      for (let sIdx = 0; sIdx < round.slots.length; sIdx++) {
        const slot = round.slots[sIdx];
        const primaryExercise = slot.options[0];
        const targetArea = getPrimaryBodyArea(primaryExercise);

        // Collect primary muscle counts used in OTHER slots of this round
        const otherSlotsPriMuscles = new Set();
        const otherSlotsPriCounts = {};
        round.slots.forEach((otherSlot, otherIdx) => {
          if (otherIdx === sIdx) return;
          const activeOther = otherSlot.options[0];
          if (activeOther?.muscles) {
            Object.entries(activeOther.muscles).forEach(([m, lvl]) => {
              if (lvl === 'Pri') {
                otherSlotsPriCounts[m] = (otherSlotsPriCounts[m] || 0) + 1;
              }
            });
          }
          otherSlot.options.forEach(optEx => {
            Object.entries(optEx.muscles || {}).forEach(([m, lvl]) => {
              if (lvl === 'Pri') otherSlotsPriMuscles.add(m);
            });
          });
        });

        const roundExerciseIds = new Set(
          round.slots.flatMap(s => s.options.map(o => o.id))
        );

        for (let optIdx = 1; optIdx < numOptions; optIdx++) {
          const isZeroCollision = ex =>
            !Object.entries(ex.muscles || {}).some(
              ([m, lvl]) => lvl === 'Pri' && otherSlotsPriMuscles.has(m)
            );
          const maxOtherAllowed = round.slots.length > 4 ? 1 : 0;
          const isSafeForRound = ex =>
            !Object.entries(ex.muscles || {}).some(
              ([m, lvl]) => lvl === 'Pri' && (otherSlotsPriCounts[m] || 0) > maxOtherAllowed
            );

          // Tier 1: Unused in workout, same body area, zero muscle collision in round
          let altCandidates = basePool.filter(
            ex =>
              !usedExerciseIds.has(ex.id) &&
              !roundExerciseIds.has(ex.id) &&
              (targetArea === 'All' || ex.bodyCategories[targetArea] === 'Pri') &&
              isZeroCollision(ex)
          );

          // Tier 2: Unused in workout, any body area in pool, zero muscle collision in round
          if (altCandidates.length === 0) {
            altCandidates = basePool.filter(
              ex =>
                !usedExerciseIds.has(ex.id) &&
                !roundExerciseIds.has(ex.id) &&
                isZeroCollision(ex)
            );
          }

          // Tier 3: Not in current round, same body area, safe for round (no overload)
          if (altCandidates.length === 0) {
            altCandidates = basePool.filter(
              ex =>
                !roundExerciseIds.has(ex.id) &&
                !slot.options.some(o => o.id === ex.id) &&
                (targetArea === 'All' || ex.bodyCategories[targetArea] === 'Pri') &&
                isSafeForRound(ex)
            );
          }

          // Tier 4: Not in current round, safe for round (no overload)
          if (altCandidates.length === 0) {
            altCandidates = basePool.filter(
              ex =>
                !roundExerciseIds.has(ex.id) &&
                !slot.options.some(o => o.id === ex.id) &&
                isSafeForRound(ex)
            );
          }

          // Tier 4b: If narrow filter pool exhausted a muscle group (e.g. only 1 Glutes in Strength+Legs+Weights),
          // expand to non-excluded exercises in the same body area / equipment that are safe for the round
          if (altCandidates.length === 0) {
            const nonExcludedAll = sheetData.exercises.filter(
              ex =>
                !excludedExerciseIds.includes(ex.id) &&
                !excludedExerciseIds.includes(ex.name) &&
                !roundExerciseIds.has(ex.id) &&
                !slot.options.some(o => o.id === ex.id) &&
                isSafeForRound(ex)
            );
            altCandidates = nonExcludedAll.filter(
              ex => targetArea === 'All' || ex.bodyCategories[targetArea] === 'Pri'
            );
            if (altCandidates.length === 0) {
              altCandidates = nonExcludedAll;
            }
          }

          // Tier 5: Pick from candidates not in current round with minimum primary muscle count in other slots
          if (altCandidates.length === 0) {
            let fallbackPool = basePool.filter(
              ex => !roundExerciseIds.has(ex.id) && !slot.options.some(o => o.id === ex.id)
            );
            if (fallbackPool.length === 0) {
              fallbackPool = basePool.filter(ex => !slot.options.some(o => o.id === ex.id));
            }
            if (fallbackPool.length > 0) {
              const minOtherCount = Math.min(
                ...fallbackPool.map(ex => otherSlotsPriCounts[getPrimaryMuscle(ex)] || 0)
              );
              altCandidates = fallbackPool.filter(
                ex => (otherSlotsPriCounts[getPrimaryMuscle(ex)] || 0) === minOtherCount
              );
            }
          }

          const altEx = getRandomEntry(altCandidates, rng);
          if (altEx) {
            slot.options.push(altEx);
            usedExerciseIds.add(altEx.id);
            roundExerciseIds.add(altEx.id);
          }
        }
      }
    }
  }

  const generated = {
    id: `wk-${Date.now()}-${Math.floor(rng() * 10000)}`,
    createdAt: new Date().toISOString(),
    inputs: {
      workoutCategory: rawWorkoutCategory,
      effectiveWorkoutCategory: resolvedWorkoutCategory,
      bodyCategory,
      equipment,
      workoutType,
      optionsPerSlot: numOptions
    },
    workout: selectedWorkout,
    workoutName: `WORKOUT: ${selectedWorkout.name}`,
    workoutInfo: {
      rounds: selectedWorkout.rounds,
      exercisesPerRound: selectedWorkout.exercisesPerRound,
      setsPerRound: selectedWorkout.setsPerRound ?? ''
    },
    workoutComments: selectedWorkout.comments || '',
    dismissedWarnings: [],
    rounds
  };

  generated.summaryText = formatWorkoutSummary(generated);
  generated.exercisesText = formatExercisesText(generated);
  return generated;
}

/**
 * Compute conflict score for a group (pair, trio, quad) of exercises.
 * Lower score = better muscle & body-area distribution.
 */
function scoreExerciseGroup(group, idealAreaBounds = null) {
  let cost = 0;
  const priMuscleCounts = {};
  const secMuscleCounts = {};
  const areaCounts = { 'Upper Body': 0, 'Core': 0, 'Legs': 0 };

  for (const ex of group) {
    const area = getPrimaryBodyArea(ex);
    if (areaCounts[area] !== undefined) {
      areaCounts[area] += 1;
    }
    for (const m of SPECIFIC_MUSCLE_LIST) {
      const lvl = ex.muscles?.[m];
      if (lvl === 'Pri') {
        priMuscleCounts[m] = (priMuscleCounts[m] || 0) + 1;
      } else if (lvl === 'Sec') {
        secMuscleCounts[m] = (secMuscleCounts[m] || 0) + 1;
      }
    }
  }

  // 1. Heavy penalty for duplicate Primary muscles in the same pair/trio/quad
  for (const m of SPECIFIC_MUSCLE_LIST) {
    const c = priMuscleCounts[m] || 0;
    if (c >= 2) {
      cost += (c - 1) * 1000;
    }
    // Small penalty for Pri + Sec overlap
    if (c >= 1 && (secMuscleCounts[m] || 0) >= 1) {
      cost += (secMuscleCounts[m] || 0) * 8;
    }
  }

  // 2. Penalty for imbalanced body areas within the group
  for (const area of BODY_AREAS) {
    const c = areaCounts[area];
    if (idealAreaBounds && idealAreaBounds[area]) {
      const { min, max } = idealAreaBounds[area];
      if (c < min) cost += (min - c) * 200;
      if (c > max) cost += (c - max) * 200;
    }
    if (c >= 2) {
      cost += (c - 1) * 40;
    }
  }

  return cost;
}

/**
 * Order a 4-exercise Quad round into 2 balanced pairs [(0,1), (2,3)],
 * or order a single-round sequence of exercises so adjacent pairs/trios alternate muscle groups & body areas.
 */
function orderSingleSequenceForDistribution(exercises, workoutId = '') {
  const n = exercises.length;
  if (n <= 2) return [...exercises];

  if (n === 4) {
    // 3 ways to split 4 items into 2 pairs: [(0,1),(2,3)], [(0,2),(1,3)], [(0,3),(1,2)]
    const pairings = [
      [exercises[0], exercises[1], exercises[2], exercises[3]],
      [exercises[0], exercises[2], exercises[1], exercises[3]],
      [exercises[0], exercises[3], exercises[1], exercises[2]]
    ];
    let best = pairings[0];
    let bestScore = Infinity;
    for (const cand of pairings) {
      const s =
        scoreExerciseGroup([cand[0], cand[1]]) +
        scoreExerciseGroup([cand[2], cand[3]]);
      if (s < bestScore) {
        bestScore = s;
        best = cand;
      }
    }
    return best;
  }

  // For single-round circuits of 5..8 exercises, order so adjacent pairs (i, i+1) and trios (i, i+1, i+2)
  // have maximum muscle & body area separation.
  let bestPerm = [...exercises];
  let bestCost = Infinity;
  let statesVisited = 0;
  const maxStates = 10000;

  function transitionCost(a, b) {
    let c = 0;
    const priA = getPrimaryMuscle(a);
    const priB = getPrimaryMuscle(b);
    if (priA && priA === priB) c += 1000;
    if (getPrimaryBodyArea(a) === getPrimaryBodyArea(b)) c += 120;
    if (priA && b.muscles?.[priA] === 'Sec') c += 15;
    if (priB && a.muscles?.[priB] === 'Sec') c += 15;
    return c;
  }

  const used = new Array(n).fill(false);
  const current = [];

  function search(currentCost) {
    if (statesVisited >= maxStates) return;
    if (current.length === n) {
      statesVisited++;
      let extraCost = 0;
      if (workoutId === '5-constant-5-change-40-20' && n >= 6) {
        // First 3 exercises are the 3 Round Constants; avoid duplicate muscles among the 3 constants
        extraCost += scoreExerciseGroup(current.slice(0, 3));
      }
      if (currentCost + extraCost < bestCost) {
        bestCost = currentCost + extraCost;
        bestPerm = [...current];
      }
      return;
    }

    if (currentCost >= bestCost) return;

    const k = current.length;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const cand = exercises[i];
      let stepCost = 0;
      if (k >= 1) {
        stepCost += transitionCost(current[k - 1], cand);
      }
      if (k >= 2) {
        const priPrev2 = getPrimaryMuscle(current[k - 2]);
        const priCand = getPrimaryMuscle(cand);
        if (priPrev2 && priPrev2 === priCand) stepCost += 250;
        if (getPrimaryBodyArea(current[k - 2]) === getPrimaryBodyArea(cand)) stepCost += 30;
      }

      if (currentCost + stepCost < bestCost) {
        used[i] = true;
        current.push(cand);
        search(currentCost + stepCost);
        current.pop();
        used[i] = false;
      }
    }
  }

  search(0);
  return bestPerm;
}

/**
 * Optimally partition X selected exercises into `nRounds` of `nExercisesPerRound` exercises each
 * to distribute muscle groups and body areas across every pair, trio, quad, or circuit round.
 */
export function autoSlotExercises(selectedExercises, workout, maybeExercisesPerRound = null) {
  const workoutObj =
    typeof workout === 'number'
      ? { rounds: workout, exercisesPerRound: maybeExercisesPerRound || selectedExercises.length }
      : workout;
  const nRounds = parseInt(workoutObj?.rounds, 10) || 1;
  const k = parseInt(workoutObj?.exercisesPerRound, 10) || selectedExercises.length;
  const totalNeeded = nRounds * k;
  const list = selectedExercises.slice(0, totalNeeded);

  if (nRounds <= 1) {
    return [orderSingleSequenceForDistribution(list, workoutObj?.id)];
  }

  // Compute ideal body-area bounds per round across the X selected exercises
  const totalAreaCounts = { 'Upper Body': 0, 'Core': 0, 'Legs': 0 };
  for (const ex of list) {
    const area = getPrimaryBodyArea(ex);
    if (totalAreaCounts[area] !== undefined) {
      totalAreaCounts[area] += 1;
    }
  }
  const idealAreaBounds = {};
  for (const area of BODY_AREAS) {
    idealAreaBounds[area] = {
      min: Math.floor(totalAreaCounts[area] / nRounds),
      max: Math.ceil(totalAreaCounts[area] / nRounds)
    };
  }

  // Exact branch-and-bound over all ways to partition `list` into `nRounds` groups of size `k`.
  // (For 8 into 4 pairs: 105 partitions; for 9 into 3 trios: 280 partitions; for 8 into 2 quads: 35 partitions.)
  const N = list.length;
  const used = new Array(N).fill(false);
  let bestPartition = null;
  let bestCost = Infinity;
  const currentGroups = [];

  function buildCombinations(startIdx, groupSoFar, onGroupComplete) {
    if (groupSoFar.length === k) {
      onGroupComplete([...groupSoFar]);
      return;
    }
    const remainingNeeded = k - groupSoFar.length;
    for (let i = startIdx; i < N; i++) {
      if (used[i]) continue;
      // Count remaining unused from i..N-1
      let availableCount = 0;
      for (let j = i; j < N; j++) {
        if (!used[j]) availableCount++;
      }
      if (availableCount < remainingNeeded) break;

      used[i] = true;
      groupSoFar.push(list[i]);
      buildCombinations(i + 1, groupSoFar, onGroupComplete);
      groupSoFar.pop();
      used[i] = false;
    }
  }

  function searchPartitions(costSoFar) {
    if (costSoFar >= bestCost) return;
    if (currentGroups.length === nRounds) {
      bestCost = costSoFar;
      bestPartition = currentGroups.map(g => [...g]);
      return;
    }

    // Symmetry breaking: the first unused item MUST go into the next group
    const firstUnused = used.indexOf(false);
    if (firstUnused === -1) return;

    used[firstUnused] = true;
    const seedGroup = [list[firstUnused]];

    buildCombinations(firstUnused + 1, seedGroup, completedGroup => {
      const groupCost = scoreExerciseGroup(completedGroup, idealAreaBounds);
      if (costSoFar + groupCost < bestCost) {
        currentGroups.push(completedGroup);
        searchPartitions(costSoFar + groupCost);
        currentGroups.pop();
      }
    });

    used[firstUnused] = false;
  }

  searchPartitions(0);

  if (!bestPartition) {
    // Fallback chunking
    bestPartition = [];
    for (let r = 0; r < nRounds; r++) {
      bestPartition.push(list.slice(r * k, (r + 1) * k));
    }
  }

  // Order within each round (e.g. for Quads, order into 2 balanced pairs)
  return bestPartition.map(group => orderSingleSequenceForDistribution(group, workout?.id));
}

/**
 * Generate a complete workout from a list of user-selected exercises (X exercises),
 * auto-slotting them to distribute muscle groups per pair, trio, or round.
 */
export function generateWorkoutFromSelectedExercises(
  sheetData,
  inputsOrExercises = {},
  exercisesOrInputs = [],
  rng = Math.random
) {
  const inputs = Array.isArray(inputsOrExercises) ? exercisesOrInputs : inputsOrExercises;
  const selectedExercises = Array.isArray(inputsOrExercises) ? inputsOrExercises : exercisesOrInputs;
  const {
    workoutCategory: rawWorkoutCategory = 'HIIT',
    bodyCategory = 'All',
    equipment = 'Any',
    workoutType = 'Random',
    excludedExerciseIds = []
  } = inputs;

  // Resolve target workout
  let resolvedWorkoutCategory = rawWorkoutCategory;
  if (resolvedWorkoutCategory === 'Either') {
    resolvedWorkoutCategory = getRandomEntry(['Strength', 'HIIT'], rng);
  }

  let selectedWorkout = null;
  if (!workoutType || workoutType === 'Random') {
    const categoryWorkouts = sheetData.workouts.filter(
      w => w.workoutCategory === resolvedWorkoutCategory
    );
    selectedWorkout = getRandomEntry(categoryWorkouts, rng) || sheetData.workouts[0];
  } else {
    selectedWorkout =
      sheetData.workouts.find(w => w.name === workoutType || w.id === workoutType) ||
      sheetData.workouts[0];
    resolvedWorkoutCategory = selectedWorkout.workoutCategory;
  }

  const nRounds = parseInt(selectedWorkout.rounds, 10) || 1;
  const nExercisesPerRound = parseInt(selectedWorkout.exercisesPerRound, 10) || 1;
  const totalNeeded = nRounds * nExercisesPerRound;
  const checkMode = getWorkoutCheckMode(selectedWorkout);

  // Map IDs or objects to full exercise objects
  const exMap = new Map(sheetData.exercises.map(e => [e.id, e]));
  const chosenList = [];
  const chosenIds = new Set();

  for (const item of selectedExercises) {
    const ex = typeof item === 'string' ? exMap.get(item) : exMap.get(item?.id) || item;
    if (ex && !chosenIds.has(ex.id)) {
      chosenList.push(ex);
      chosenIds.add(ex.id);
    }
  }

  // If fewer than totalNeeded were provided, auto-fill remaining with balanced eligible exercises
  if (chosenList.length < totalNeeded) {
    const eligible = filterEligibleExercises(sheetData.exercises, {
      workoutCategory: resolvedWorkoutCategory,
      bodyCategory,
      equipment,
      excludedExerciseIds
    }).filter(e => !chosenIds.has(e.id));

    const fallbackPool =
      eligible.length >= totalNeeded - chosenList.length
        ? eligible
        : sheetData.exercises.filter(e => !chosenIds.has(e.id));

    while (chosenList.length < totalNeeded && fallbackPool.length > 0) {
      // Pick an exercise whose primary muscle & body area are least represented so far
      const muscleCounts = {};
      const areaCounts = { 'Upper Body': 0, 'Core': 0, 'Legs': 0 };
      chosenList.forEach(e => {
        const pm = getPrimaryMuscle(e);
        if (pm) muscleCounts[pm] = (muscleCounts[pm] || 0) + 1;
        const area = getPrimaryBodyArea(e);
        if (areaCounts[area] !== undefined) areaCounts[area] += 1;
      });

      const available = fallbackPool.filter(e => !chosenIds.has(e.id));
      if (available.length === 0) break;

      available.sort((a, b) => {
        const mA = muscleCounts[getPrimaryMuscle(a)] || 0;
        const mB = muscleCounts[getPrimaryMuscle(b)] || 0;
        if (mA !== mB) return mA - mB;
        const aA = areaCounts[getPrimaryBodyArea(a)] || 0;
        const aB = areaCounts[getPrimaryBodyArea(b)] || 0;
        return aA - aB;
      });

      const pick = available[0];
      chosenList.push(pick);
      chosenIds.add(pick.id);
    }
  }

  // Auto-slot the X exercises across rounds to distribute muscle groups per pair/trio/round
  const slottedRounds = autoSlotExercises(chosenList.slice(0, totalNeeded), selectedWorkout);

  const rounds = slottedRounds.map((roundExercises, rndIdx) => ({
    roundNumber: rndIdx + 1,
    completed: false,
    slots: roundExercises.map((ex, slIdx) => ({
      roundIndex: rndIdx,
      slotIndex: slIdx,
      options: [ex],
      selectedOptionIndex: 0,
      optionChosen: true,
      completed: false,
      completedSets:
        checkMode.mode === 'exercise-sets'
          ? Array.from({ length: checkMode.count }, () => false)
          : [],
      manuallyModified: false
    }))
  }));

  const generated = {
    id: `wk-custom-${Date.now()}-${Math.floor(rng() * 10000)}`,
    createdAt: new Date().toISOString(),
    customSelected: true,
    inputs: {
      workoutCategory: rawWorkoutCategory,
      effectiveWorkoutCategory: resolvedWorkoutCategory,
      bodyCategory,
      equipment,
      workoutType: selectedWorkout.name,
      optionsPerSlot: 1
    },
    workout: selectedWorkout,
    workoutName: `WORKOUT: ${selectedWorkout.name}`,
    workoutInfo: {
      rounds: selectedWorkout.rounds,
      exercisesPerRound: selectedWorkout.exercisesPerRound,
      setsPerRound: selectedWorkout.setsPerRound ?? ''
    },
    workoutComments: selectedWorkout.comments || '',
    dismissedWarnings: [],
    rounds
  };

  generated.summaryText = formatWorkoutSummary(generated);
  generated.exercisesText = formatExercisesText(generated);
  return generated;
}

/**
 * Get the currently active exercise for a given slot.
 */
export function getActiveSlotExercise(slot) {
  if (!slot || !slot.options || slot.options.length === 0) return null;
  const idx = Math.min(slot.options.length - 1, Math.max(0, slot.selectedOptionIndex || 0));
  return slot.options[idx];
}

/**
 * Format the plain-text exercises block (matching cell B13 in Google Sheet).
 */
export function formatExercisesText(workoutState, showAllOptionsInText = false) {
  if (!workoutState || !workoutState.rounds) return '';
  let txt = '';
  for (const round of workoutState.rounds) {
    txt += `\nROUND ${round.roundNumber}\n`;
    for (const slot of round.slots) {
      if (showAllOptionsInText && slot.options.length > 1) {
        const names = slot.options.map(o => o.name);
        txt += `  - ${names.join(' OR ')}\n`;
      } else {
        const active = getActiveSlotExercise(slot);
        if (active) {
          txt += `  - ${active.name}\n`;
        }
      }
    }
  }
  return txt.trim();
}

/**
 * Format the complete Workout Summary text block (matching cell B9 in Google Sheet).
 */
export function formatWorkoutSummary(workoutState, showAllOptionsInText = false) {
  if (!workoutState) return '';
  const exTxt = formatExercisesText(workoutState, showAllOptionsInText);
  return `${workoutState.workoutName}\n\n${exTxt}`;
}

/**
 * Format the Workout Info text block (matching cell B14 in Google Sheet).
 */
export function formatWorkoutInfoText(workoutState) {
  if (!workoutState || !workoutState.workoutInfo) return '';
  const { rounds, exercisesPerRound, setsPerRound } = workoutState.workoutInfo;
  return (
    `# Rounds            : ${rounds}\n` +
    `# Exercise Per Round: ${exercisesPerRound}\n` +
    `# Sets Per Round    : ${setsPerRound ?? ''}`
  );
}

/**
 * Swap an exercise in a specific round & slot (either replacing the active option or setting a new exercise).
 */
export function swapExerciseInSlot(workoutState, roundIndex, slotIndex, newExercise, optionIndex = null, isManual = true) {
  const nextState = structuredClone(workoutState);
  const round = nextState.rounds[roundIndex];
  if (!round) return nextState;
  const slot = round.slots[slotIndex];
  if (!slot) return nextState;

  const targetOptIdx = optionIndex !== null ? optionIndex : (slot.selectedOptionIndex || 0);
  slot.options[targetOptIdx] = newExercise;
  slot.selectedOptionIndex = targetOptIdx;
  slot.optionChosen = true;
  slot.manuallyModified = isManual;

  nextState.exercisesText = formatExercisesText(nextState);
  nextState.summaryText = formatWorkoutSummary(nextState);
  return nextState;
}

/**
 * Compute valid replacement exercises for a specific round & slot that:
 * 1) Match active filters and user exclusions
 * 2) Are not already used in the workout
 * 3) Respect the round's body-category balance
 * 4) Do NOT trigger any muscle overload warning in that round!
 */
export function getValidReplacementCandidates({
  workoutState,
  roundIndex,
  slotIndex,
  sheetData,
  excludedExerciseIds = [],
  analyzeMuscleLoadFn
}) {
  const round = workoutState.rounds[roundIndex];
  const currentSlot = round?.slots[slotIndex];
  const currentEx = getActiveSlotExercise(currentSlot);
  const targetBodyArea = currentEx ? getPrimaryBodyArea(currentEx) : 'All';

  const usedIds = new Set(
    workoutState.rounds.flatMap(r => r.slots.flatMap(s => s.options.map(o => o.id)))
  );

  // Other slots' primary muscles in this round
  const otherSlotsPriMuscles = new Set(
    (round?.slots || [])
      .filter((_, idx) => idx !== slotIndex)
      .map(s => getPrimaryMuscle(getActiveSlotExercise(s)))
      .filter(Boolean)
  );

  const eligible = filterEligibleExercises(sheetData.exercises, {
    workoutCategory: workoutState.inputs.effectiveWorkoutCategory,
    bodyCategory: workoutState.inputs.bodyCategory,
    equipment: workoutState.inputs.equipment,
    excludedExerciseIds
  }).filter(ex => !usedIds.has(ex.id) && ex.id !== currentEx?.id);

  function isCandidateWarningFree(candidate) {
    const candPri = getPrimaryMuscle(candidate);
    if ((round?.slots?.length || 2) <= 4 && candPri && otherSlotsPriMuscles.has(candPri)) {
      return false;
    }
    if (!analyzeMuscleLoadFn) return true;
    const simulated = swapExerciseInSlot(
      workoutState,
      roundIndex,
      slotIndex,
      candidate,
      null,
      false
    );
    simulated.dismissedWarnings = [];
    const analysis = analyzeMuscleLoadFn(simulated, sheetData, excludedExerciseIds);
    const roundWarnings = analysis.warnings.filter(w => w.roundIndex === roundIndex);
    return roundWarnings.length === 0;
  }

  let warningFree = eligible.filter(isCandidateWarningFree);

  // If restrictive filters left 0 warning-free candidates in `eligible`,
  // widen to all non-excluded exercises not used in the workout that are warning-free!
  if (warningFree.length === 0) {
    const widerPool = filterEligibleExercises(sheetData.exercises, {
      workoutCategory: workoutState.inputs.effectiveWorkoutCategory,
      bodyCategory: 'All',
      equipment: workoutState.inputs.equipment,
      excludedExerciseIds
    }).filter(ex => !usedIds.has(ex.id) && ex.id !== currentEx?.id);
    warningFree = widerPool.filter(isCandidateWarningFree);
  }

  if (warningFree.length === 0) {
    const allPool = sheetData.exercises.filter(
      ex =>
        !excludedExerciseIds.includes(ex.id) &&
        !usedIds.has(ex.id) &&
        ex.id !== currentEx?.id
    );
    warningFree = allPool.filter(isCandidateWarningFree);
  }

  const sameAreaWarningFree = warningFree.filter(
    ex => targetBodyArea === 'All' || ex.bodyCategories[targetBodyArea] === 'Pri'
  );

  if (sameAreaWarningFree.length > 0) return sameAreaWarningFree;
  if (warningFree.length > 0) return warningFree;
  return eligible;
}

/**
 * Reorder rounds by moving a round from `fromRoundIndex` to `toRoundIndex`,
 * and renumbering all rounds sequentially (1, 2, 3...).
 */
export function reorderRounds(workoutState, fromRoundIndex, toRoundIndex) {
  if (!workoutState || !Array.isArray(workoutState.rounds)) return workoutState;
  const n = workoutState.rounds.length;
  if (
    fromRoundIndex < 0 ||
    fromRoundIndex >= n ||
    toRoundIndex < 0 ||
    toRoundIndex >= n ||
    fromRoundIndex === toRoundIndex
  ) {
    return workoutState;
  }

  const nextState = structuredClone(workoutState);
  const oldIndexOrder = nextState.rounds.map((_, idx) => idx);
  const [movedOldIdx] = oldIndexOrder.splice(fromRoundIndex, 1);
  oldIndexOrder.splice(toRoundIndex, 0, movedOldIdx);

  const [movedRound] = nextState.rounds.splice(fromRoundIndex, 1);
  nextState.rounds.splice(toRoundIndex, 0, movedRound);
  nextState.rounds.forEach((r, idx) => {
    r.roundNumber = idx + 1;
  });

  // Remap any dismissed warning IDs to follow their reordered round indices
  if (Array.isArray(nextState.dismissedWarnings) && nextState.dismissedWarnings.length > 0) {
    const oldToNewIdx = new Map();
    oldIndexOrder.forEach((oldIdx, newIdx) => {
      oldToNewIdx.set(oldIdx, newIdx);
    });
    nextState.dismissedWarnings = nextState.dismissedWarnings.map(id => {
      const warnMatch = /^warn-r(\d+)-(.+)$/.exec(id);
      if (warnMatch) {
        const oldIdx = Number(warnMatch[1]) - 1;
        if (oldToNewIdx.has(oldIdx)) {
          return `warn-r${oldToNewIdx.get(oldIdx) + 1}-${warnMatch[2]}`;
        }
      }
      const roundMatch = /^round-(\d+)$/.exec(id);
      if (roundMatch) {
        const oldIdx = Number(roundMatch[1]);
        if (oldToNewIdx.has(oldIdx)) {
          return `round-${oldToNewIdx.get(oldIdx)}`;
        }
      }
      return id;
    });
  }

  nextState.exercisesText = formatExercisesText(nextState);
  nextState.summaryText = formatWorkoutSummary(nextState);
  return nextState;
}

/**
 * Reorder an exercise slot up or down within the same round.
 */
export function reorderExerciseInRound(workoutState, roundIndex, fromSlotIndex, toSlotIndex) {
  if (!workoutState || !Array.isArray(workoutState.rounds)) return workoutState;
  const round = workoutState.rounds[roundIndex];
  if (!round || !Array.isArray(round.slots)) return workoutState;
  const m = round.slots.length;
  if (
    fromSlotIndex < 0 ||
    fromSlotIndex >= m ||
    toSlotIndex < 0 ||
    toSlotIndex >= m ||
    fromSlotIndex === toSlotIndex
  ) {
    return workoutState;
  }

  const nextState = structuredClone(workoutState);
  const targetRound = nextState.rounds[roundIndex];
  const [movedSlot] = targetRound.slots.splice(fromSlotIndex, 1);
  targetRound.slots.splice(toSlotIndex, 0, movedSlot);
  targetRound.slots.forEach((s, idx) => {
    s.slotIndex = idx;
  });

  nextState.exercisesText = formatExercisesText(nextState);
  nextState.summaryText = formatWorkoutSummary(nextState);
  return nextState;
}

/**
 * Swap an exercise slot from one round with an exercise slot in another round
 * (or reorder within the same round if `fromRoundIndex === toRoundIndex`).
 */
export function swapExercisesAcrossRounds(
  workoutState,
  fromRoundIndex,
  fromSlotIndex,
  toRoundIndex,
  toSlotIndex
) {
  if (!workoutState || !Array.isArray(workoutState.rounds)) return workoutState;
  if (fromRoundIndex === toRoundIndex) {
    return reorderExerciseInRound(workoutState, fromRoundIndex, fromSlotIndex, toSlotIndex);
  }

  const fromRound = workoutState.rounds[fromRoundIndex];
  const toRound = workoutState.rounds[toRoundIndex];
  if (
    !fromRound ||
    !toRound ||
    !fromRound.slots?.[fromSlotIndex] ||
    !toRound.slots?.[toSlotIndex]
  ) {
    return workoutState;
  }

  const nextState = structuredClone(workoutState);
  const slotA = nextState.rounds[fromRoundIndex].slots[fromSlotIndex];
  const slotB = nextState.rounds[toRoundIndex].slots[toSlotIndex];

  slotA.slotIndex = toSlotIndex;
  slotB.slotIndex = fromSlotIndex;

  nextState.rounds[fromRoundIndex].slots[fromSlotIndex] = slotB;
  nextState.rounds[toRoundIndex].slots[toSlotIndex] = slotA;

  // Clear dismissed warnings for both affected rounds so new pairings are evaluated fresh
  if (Array.isArray(nextState.dismissedWarnings)) {
    const p1 = `warn-r${fromRoundIndex + 1}-`;
    const p2 = `warn-r${toRoundIndex + 1}-`;
    nextState.dismissedWarnings = nextState.dismissedWarnings.filter(
      id =>
        !id.startsWith(p1) &&
        !id.startsWith(p2) &&
        id !== `round-${fromRoundIndex}` &&
        id !== `round-${toRoundIndex}`
    );
  }

  nextState.exercisesText = formatExercisesText(nextState);
  nextState.summaryText = formatWorkoutSummary(nextState);
  return nextState;
}
