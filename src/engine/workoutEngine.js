/**
 * Workout Generator Engine
 * 1:1 Port of Google Apps Script `generateWorkout()` +
 * Per-User Exercise Exclusions, Clarified Equipment Filtering, Multi-Option Slots (1, 2, or 3),
 * Format-Aware Checkbox Modes, Conflict-Free Generation, and Custom X-Exercise Auto-Slotting.
 */

export const BODY_AREAS = ['Upper Body', 'Core', 'Legs'];

export const FOCUS_SNAP_STEPS = [
  0,
  0.1,
  0.2,
  0.25,
  1 / 3,
  0.4,
  0.5,
  0.6,
  2 / 3,
  0.75,
  0.8,
  0.9,
  1
];

export const DEFAULT_FOCUS_WEIGHTS = {
  'Upper Body': 1 / 3,
  'Core': 1 / 3,
  'Legs': 1 / 3
};

export const DEFAULT_FOCUS_ENABLED = {
  'Upper Body': true,
  'Core': true,
  'Legs': true
};

// (a) Reasonable error bar (±15%) for auto-recommendations / valid replacement candidates
export const AUTO_FOCUS_ERROR_BAR = 0.15;
// (b) Larger error bar (+22% and >=2 slots over ceiling) for overload warnings from manual selections
export const MANUAL_FOCUS_ERROR_BAR = 0.22;

const MUSCLE_TO_AREA = {
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

/**
 * Normalize a body area name ('Lower Body' -> 'Legs').
 */
export function normalizeBodyAreaKey(area) {
  if (area === 'Lower Body' || area === 'Legs') return 'Legs';
  if (area === 'Upper Body') return 'Upper Body';
  if (area === 'Core') return 'Core';
  return area;
}

/**
 * Snap a raw [0, 1] slider position to the nearest allowed focus stop:
 * 0%, 10%, 20%, 25%, 1/3, 40%, 50%, 60%, 2/3, 75%, 80%, 90%, 100%.
 */
export function snapToFocusStep(value) {
  const clamped = Math.max(0, Math.min(1, Number(value) || 0));
  let best = FOCUS_SNAP_STEPS[0];
  let bestDiff = Math.abs(clamped - best);
  for (let i = 1; i < FOCUS_SNAP_STEPS.length; i++) {
    const diff = Math.abs(clamped - FOCUS_SNAP_STEPS[i]);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = FOCUS_SNAP_STEPS[i];
    }
  }
  return best;
}

/**
 * Normalize focus weights and enabled flags from inputs (supporting both 3-part slider state
 * and legacy `bodyCategory` strings for backward compatibility).
 */
export function normalizeFocusWeights(inputs = {}) {
  const rawWeights = inputs?.focusWeights;
  const rawEnabled = inputs?.focusEnabled;

  if (rawWeights && typeof rawWeights === 'object') {
    const enabled = {
      'Upper Body': rawEnabled ? rawEnabled['Upper Body'] !== false : true,
      'Core': rawEnabled ? rawEnabled['Core'] !== false : true,
      'Legs': rawEnabled
        ? rawEnabled['Legs'] !== false && rawEnabled['Lower Body'] !== false
        : true
    };

    if (!enabled['Upper Body'] && !enabled['Core'] && !enabled['Legs']) {
      enabled['Upper Body'] = true;
      enabled['Core'] = true;
      enabled['Legs'] = true;
    }

    const w = {
      'Upper Body': enabled['Upper Body']
        ? Math.max(0, Number(rawWeights['Upper Body']) || 0)
        : 0,
      'Core': enabled['Core'] ? Math.max(0, Number(rawWeights['Core']) || 0) : 0,
      'Legs': enabled['Legs']
        ? Math.max(0, Number(rawWeights['Legs'] ?? rawWeights['Lower Body']) || 0)
        : 0
    };

    const sum = w['Upper Body'] + w['Core'] + w['Legs'];
    if (sum > 1e-9) {
      return {
        weights: {
          'Upper Body': w['Upper Body'] / sum,
          'Core': w['Core'] / sum,
          'Legs': w['Legs'] / sum
        },
        enabled
      };
    }

    const activeCount = BODY_AREAS.filter(a => enabled[a]).length || 3;
    return {
      weights: {
        'Upper Body': enabled['Upper Body'] ? 1 / activeCount : 0,
        'Core': enabled['Core'] ? 1 / activeCount : 0,
        'Legs': enabled['Legs'] ? 1 / activeCount : 0
      },
      enabled
    };
  }

  // Fallback: derive from legacy bodyCategory string
  const cat = inputs?.bodyCategory || 'All';
  if (cat === 'Upper Body') {
    return {
      weights: { 'Upper Body': 1, 'Core': 0, 'Legs': 0 },
      enabled: { 'Upper Body': true, 'Core': false, 'Legs': false }
    };
  }
  if (cat === 'Core') {
    return {
      weights: { 'Upper Body': 0, 'Core': 1, 'Legs': 0 },
      enabled: { 'Upper Body': false, 'Core': true, 'Legs': false }
    };
  }
  if (cat === 'Legs' || cat === 'Lower Body') {
    return {
      weights: { 'Upper Body': 0, 'Core': 0, 'Legs': 1 },
      enabled: { 'Upper Body': false, 'Core': false, 'Legs': true }
    };
  }
  if (cat === 'Upper Body and Core' || cat === 'Upper & Core') {
    return {
      weights: { 'Upper Body': 0.5, 'Core': 0.5, 'Legs': 0 },
      enabled: { 'Upper Body': true, 'Core': true, 'Legs': false }
    };
  }
  if (
    cat === 'Legs and Core' ||
    cat === 'Lower Body and Core' ||
    cat === 'Lower Body & Core'
  ) {
    return {
      weights: { 'Upper Body': 0, 'Core': 0.5, 'Legs': 0.5 },
      enabled: { 'Upper Body': false, 'Core': true, 'Legs': true }
    };
  }
  if (
    cat === 'Upper Body and Legs' ||
    cat === 'Upper Body and Lower Body' ||
    cat === 'Upper & Lower Body'
  ) {
    return {
      weights: { 'Upper Body': 0.5, 'Core': 0, 'Legs': 0.5 },
      enabled: { 'Upper Body': true, 'Core': false, 'Legs': true }
    };
  }
  if (SPECIFIC_MUSCLE_LIST.includes(cat)) {
    const targetArea = MUSCLE_TO_AREA[cat] || 'Upper Body';
    return {
      weights: {
        'Upper Body': targetArea === 'Upper Body' ? 1 : 0,
        'Core': targetArea === 'Core' ? 1 : 0,
        'Legs': targetArea === 'Legs' ? 1 : 0
      },
      enabled: {
        'Upper Body': targetArea === 'Upper Body',
        'Core': targetArea === 'Core',
        'Legs': targetArea === 'Legs'
      }
    };
  }

  return {
    weights: { ...DEFAULT_FOCUS_WEIGHTS },
    enabled: { ...DEFAULT_FOCUS_ENABLED }
  };
}

/**
 * Derive a backward-compatible bodyCategory string summary from focus weights.
 */
export function deriveBodyCategoryFromFocus(weights, enabled) {
  const { weights: w } = normalizeFocusWeights({ focusWeights: weights, focusEnabled: enabled });
  if (w['Upper Body'] > 0.999) return 'Upper Body';
  if (w['Core'] > 0.999) return 'Core';
  if (w['Legs'] > 0.999) return 'Legs';
  if (Math.abs(w['Upper Body'] - 0.5) < 0.01 && Math.abs(w['Core'] - 0.5) < 0.01 && w['Legs'] < 0.001) {
    return 'Upper Body and Core';
  }
  if (Math.abs(w['Core'] - 0.5) < 0.01 && Math.abs(w['Legs'] - 0.5) < 0.01 && w['Upper Body'] < 0.001) {
    return 'Legs and Core';
  }
  if (Math.abs(w['Upper Body'] - 0.5) < 0.01 && Math.abs(w['Legs'] - 0.5) < 0.01 && w['Core'] < 0.001) {
    return 'Upper Body and Legs';
  }
  if (
    Math.abs(w['Upper Body'] - 1 / 3) < 0.02 &&
    Math.abs(w['Core'] - 1 / 3) < 0.02 &&
    Math.abs(w['Legs'] - 1 / 3) < 0.02
  ) {
    return 'All';
  }
  return 'Custom';
}

/**
 * Return the default balanced Focus state (1/3 Upper Body, 1/3 Core, 1/3 Legs).
 */
export function resetFocusState() {
  return {
    weights: { ...DEFAULT_FOCUS_WEIGHTS },
    enabled: { ...DEFAULT_FOCUS_ENABLED }
  };
}

/**
 * Return true when all three body areas are enabled and at ~1/3 each.
 */
export function isDefaultFocusState(weights, enabled) {
  const norm = normalizeFocusWeights({ focusWeights: weights, focusEnabled: enabled });
  return (
    !!norm.enabled['Upper Body'] &&
    !!norm.enabled['Core'] &&
    !!norm.enabled['Legs'] &&
    Math.abs((norm.weights['Upper Body'] || 0) - 1 / 3) < 0.005 &&
    Math.abs((norm.weights['Core'] || 0) - 1 / 3) < 0.005 &&
    Math.abs((norm.weights['Legs'] || 0) - 1 / 3) < 0.005
  );
}

/**
 * Toggle selection state of a focus body group ('Upper Body', 'Core', or 'Legs' / 'Lower Body'):
 * - Deselecting removes its color and spreads the remaining enabled color(s) across 100% in their current ratio.
 *   (Cannot deselect the last remaining active body group.)
 * - Reselecting sets that body group to 50% if only one other area is selected, or 1/3 if two others are selected
 *   (scaling the two other enabled groups across 2/3 in their current ratio).
 */
export function toggleFocusAreaState(currentWeights, currentEnabled, areaInput) {
  const area = normalizeBodyAreaKey(areaInput);
  if (!BODY_AREAS.includes(area)) {
    return { weights: { ...currentWeights }, enabled: { ...currentEnabled }, changed: false };
  }

  const norm = normalizeFocusWeights({ focusWeights: currentWeights, focusEnabled: currentEnabled });
  const w = { ...norm.weights };
  const en = { ...norm.enabled };

  if (en[area]) {
    const activeAreas = BODY_AREAS.filter(a => en[a]);
    if (activeAreas.length <= 1) {
      return { weights: w, enabled: en, changed: false, blockedLastActive: true };
    }
    en[area] = false;
    const remainingAreas = BODY_AREAS.filter(a => en[a]);
    const remSum = remainingAreas.reduce((acc, a) => acc + (w[a] || 0), 0);
    const nextWeights = { 'Upper Body': 0, 'Core': 0, 'Legs': 0 };
    if (remSum > 1e-9) {
      remainingAreas.forEach(a => {
        nextWeights[a] = w[a] / remSum;
      });
    } else {
      remainingAreas.forEach(a => {
        nextWeights[a] = 1 / remainingAreas.length;
      });
    }
    return { weights: nextWeights, enabled: en, changed: true };
  } else {
    en[area] = true;
    const otherActive = BODY_AREAS.filter(a => a !== area && en[a]);
    const nextWeights = { 'Upper Body': 0, 'Core': 0, 'Legs': 0 };
    if (otherActive.length === 0) {
      nextWeights[area] = 1;
    } else if (otherActive.length === 1) {
      nextWeights[area] = 0.5;
      nextWeights[otherActive[0]] = 0.5;
    } else {
      nextWeights[area] = 1 / 3;
      const otherSum = otherActive.reduce((acc, a) => acc + (w[a] || 0), 0);
      if (otherSum > 1e-9) {
        otherActive.forEach(a => {
          nextWeights[a] = (2 / 3) * (w[a] / otherSum);
        });
      } else {
        otherActive.forEach(a => {
          nextWeights[a] = (2 / 3) / otherActive.length;
        });
      }
    }
    return { weights: nextWeights, enabled: en, changed: true };
  }
}

/**
 * Compute active body areas and slider handle positions between adjacent active areas.
 */
export function computeFocusSliderPositions(weights, enabled) {
  const norm = normalizeFocusWeights({ focusWeights: weights, focusEnabled: enabled });
  const activeAreas = BODY_AREAS.filter(a => norm.enabled[a]);
  const handles = [];
  let cumulative = 0;
  for (let i = 0; i < activeAreas.length - 1; i++) {
    cumulative += norm.weights[activeAreas[i]];
    handles.push({
      index: i,
      leftArea: activeAreas[i],
      rightArea: activeAreas[i + 1],
      position: Math.max(0, Math.min(1, cumulative))
    });
  }
  return {
    activeAreas,
    handles,
    weights: norm.weights,
    enabled: norm.enabled
  };
}

/**
 * Update focus weights when dragging handle `handleIndex` to `rawFraction` in [0, 1],
 * snapping to FOCUS_SNAP_STEPS.
 */
export function updateFocusFromHandleDrag(weights, enabled, handleIndex, rawFraction) {
  const { activeAreas, handles, enabled: en } = computeFocusSliderPositions(weights, enabled);
  if (handles.length === 0 || handleIndex < 0 || handleIndex >= handles.length) {
    return { weights: { ...weights }, enabled: { ...en }, snappedPosition: null };
  }

  const snapped = snapToFocusStep(rawFraction);
  const nextWeights = { 'Upper Body': 0, 'Core': 0, 'Legs': 0 };

  if (activeAreas.length === 2) {
    nextWeights[activeAreas[0]] = snapped;
    nextWeights[activeAreas[1]] = Math.max(0, 1 - snapped);
  } else if (activeAreas.length === 3) {
    let p0 = handles[0].position;
    let p1 = handles[1].position;
    if (handleIndex === 0) {
      p0 = snapped;
      if (p0 > p1) p1 = p0;
    } else {
      p1 = snapped;
      if (p1 < p0) p0 = p1;
    }
    nextWeights[activeAreas[0]] = p0;
    nextWeights[activeAreas[1]] = Math.max(0, p1 - p0);
    nextWeights[activeAreas[2]] = Math.max(0, 1 - p1);
  }

  return {
    weights: nextWeights,
    enabled: { ...en },
    snappedPosition: snapped
  };
}

/**
 * Compute integer exercise slot quotas across the full workout (sum = totalSlots)
 * matching `focusWeights` via Largest-Remainder (Hamilton's method).
 */
export function computeWorkoutAreaQuotas(totalSlots, focusWeights, areaPoolSizes = null) {
  const n = Math.max(1, parseInt(totalSlots, 10) || 1);
  const { weights } = normalizeFocusWeights({ focusWeights });
  const quotas = { 'Upper Body': 0, 'Core': 0, 'Legs': 0 };
  const exact = { 'Upper Body': 0, 'Core': 0, 'Legs': 0 };

  const activeAreas = BODY_AREAS.filter(a => weights[a] > 1e-9);
  if (activeAreas.length === 0) {
    quotas['Upper Body'] = Math.ceil(n / 3);
    quotas['Core'] = Math.floor(n / 3);
    quotas['Legs'] = n - quotas['Upper Body'] - quotas['Core'];
    return quotas;
  }

  let assigned = 0;
  for (const a of activeAreas) {
    exact[a] = weights[a] * n;
    quotas[a] = Math.floor(exact[a] + 1e-9);
    assigned += quotas[a];
  }

  let remaining = n - assigned;
  if (remaining > 0) {
    const ranked = [...activeAreas].sort((a, b) => {
      const remA = exact[a] - quotas[a];
      const remB = exact[b] - quotas[b];
      if (Math.abs(remB - remA) > 1e-6) return remB - remA;
      // Tie-breaker: favor a non-zero active area that currently has 0 slots
      if ((quotas[a] === 0) !== (quotas[b] === 0)) {
        return quotas[a] === 0 ? -1 : 1;
      }
      return weights[b] - weights[a];
    });
    for (let i = 0; i < remaining; i++) {
      quotas[ranked[i % ranked.length]] += 1;
    }
  }

  // Optional capacity smoothing when multiple areas are active and an active area
  // has 0 exercises (all excluded) or fewer unique exercises than its quota
  if (areaPoolSizes && activeAreas.length > 1) {
    for (const a of activeAreas) {
      const cap = areaPoolSizes[a] ?? Infinity;
      if (cap === 0 && quotas[a] > 0) {
        const receivers = activeAreas.filter(b => b !== a && (areaPoolSizes[b] ?? Infinity) > 0);
        if (receivers.length > 0) {
          let idx = 0;
          while (quotas[a] > 0) {
            quotas[a] -= 1;
            quotas[receivers[idx % receivers.length]] += 1;
            idx += 1;
          }
        }
        continue;
      }
      while (cap > 0 && quotas[a] > cap) {
        const donorPctAfter = (quotas[a] - 1) / n;
        if (weights[a] - donorPctAfter > AUTO_FOCUS_ERROR_BAR + 1e-9) break;
        const receiver = activeAreas
          .filter(
            b =>
              b !== a &&
              quotas[b] < (areaPoolSizes[b] ?? Infinity) &&
              (quotas[b] + 1) / n - weights[b] <= AUTO_FOCUS_ERROR_BAR + 1e-9
          )
          .sort((x, y) => (exact[y] - quotas[y]) - (exact[x] - quotas[x]))[0];
        if (!receiver) break;
        quotas[a] -= 1;
        quotas[receiver] += 1;
      }
    }
  }

  return quotas;
}

/**
 * Check whether replacing `oldArea` with `candArea` in a workout of `totalSlots`
 * stays within (a) the reasonable auto-recommendation error bar around `focusWeights`.
 */
export function isWithinAutoFocusErrorBar({
  focusWeights,
  currentAreaCounts,
  totalSlots,
  oldArea,
  candArea
}) {
  const n = Math.max(1, totalSlots || 1);
  const wCand = focusWeights?.[candArea] || 0;
  // Never auto-recommend a 0% / deselected body area
  if (wCand <= 1e-9) return false;

  const newCandCount =
    (currentAreaCounts[candArea] || 0) - (candArea === oldArea ? 1 : 0) + 1;
  const targetCand = wCand * n;
  const maxCandAllowed = Math.min(
    n,
    Math.max(
      Math.ceil(targetCand - 1e-9),
      Math.floor((wCand + AUTO_FOCUS_ERROR_BAR) * n + 1e-9)
    )
  );
  if (newCandCount > maxCandAllowed) return false;

  if (oldArea && candArea !== oldArea && (focusWeights?.[oldArea] || 0) > 1e-9) {
    const wOld = focusWeights[oldArea];
    const newOldCount = Math.max(0, (currentAreaCounts[oldArea] || 0) - 1);
    const minOldAllowed = Math.max(
      0,
      Math.min(
        Math.floor(wOld * n + 1e-9),
        Math.ceil((wOld - AUTO_FOCUS_ERROR_BAR) * n - 1e-9)
      )
    );
    if (newOldCount < minOldAllowed) return false;
  }

  return true;
}

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
    '6-excercise-pyramid': '6 exercises · 11 pyramid sets (30s work / 10s transition / 60s rest)',
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
  muscleGroup = null,
  focusWeights = null,
  focusEnabled = null
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

  // 4. Filter by explicit muscleGroup, specific muscle bodyCategory, focusWeights, or legacy bodyCategory
  const hasExplicitMuscleGroup = Boolean(muscleGroup && muscleGroup !== 'All');
  const targetFilter = hasExplicitMuscleGroup ? muscleGroup : bodyCategory;

  if (!hasExplicitMuscleGroup && !SPECIFIC_MUSCLE_LIST.includes(targetFilter) && focusWeights && typeof focusWeights === 'object') {
    const { weights } = normalizeFocusWeights({ focusWeights, focusEnabled, bodyCategory });
    pool = pool.filter(ex => {
      const area = getPrimaryBodyArea(ex);
      return (weights[area] || 0) > 1e-9;
    });
  } else if (targetFilter === 'Upper Body') {
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
 * Fisher-Yates shuffle returning a new array using the supplied RNG.
 */
function shuffleArrayWithRng(items, rng = Math.random) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Pick `quota` exercises from `areaPool` while balancing primary muscles and avoiding
 * avoidable intra-round collisions when partitioned across `nRounds`.
 */
function selectAreaExercisesWithMuscleBalance(areaPool, quota, nRounds, nExercisesPerRound, rng = Math.random) {
  if (quota <= 0 || !areaPool || areaPool.length === 0) return [];

  const idCounts = new Map();
  const muscleCounts = {};
  const picked = [];

  function pickFromTiedByMuscle(candidates) {
    const minM = Math.min(...candidates.map(ex => muscleCounts[getPrimaryMuscle(ex)] || 0));
    const minMuscleCands = candidates.filter(
      ex => (muscleCounts[getPrimaryMuscle(ex)] || 0) === minM
    );
    const minId = Math.min(...minMuscleCands.map(ex => idCounts.get(ex.id) || 0));
    const bestCands = minMuscleCands.filter(ex => (idCounts.get(ex.id) || 0) === minId);

    const byMuscle = new Map();
    for (const ex of bestCands) {
      const m = getPrimaryMuscle(ex) || '__none__';
      if (!byMuscle.has(m)) byMuscle.set(m, []);
      byMuscle.get(m).push(ex);
    }
    const chosenMuscle = getRandomEntry([...byMuscle.keys()], rng);
    return getRandomEntry(byMuscle.get(chosenMuscle), rng);
  }

  const multiRoundSmallGroup = nRounds >= 2 && nExercisesPerRound <= 4;

  for (let i = 0; i < quota; i++) {
    let candidatePool = null;
    if (multiRoundSmallGroup) {
      const unusedCollisionFree = areaPool.filter(
        ex =>
          (idCounts.get(ex.id) || 0) === 0 &&
          (muscleCounts[getPrimaryMuscle(ex)] || 0) < nRounds
      );
      if (unusedCollisionFree.length > 0) {
        candidatePool = unusedCollisionFree;
      } else {
        const reusableCollisionFree = areaPool.filter(
          ex =>
            (idCounts.get(ex.id) || 0) < nRounds &&
            (muscleCounts[getPrimaryMuscle(ex)] || 0) < nRounds
        );
        if (reusableCollisionFree.length > 0) {
          candidatePool = reusableCollisionFree;
        }
      }
    }

    if (!candidatePool) {
      const unusedAny = areaPool.filter(ex => (idCounts.get(ex.id) || 0) === 0);
      if (unusedAny.length > 0) {
        candidatePool = unusedAny;
      } else if (multiRoundSmallGroup) {
        const reusableBounded = areaPool.filter(ex => (idCounts.get(ex.id) || 0) < nRounds);
        candidatePool = reusableBounded.length > 0 ? reusableBounded : areaPool;
      } else {
        candidatePool = areaPool;
      }
    }

    const chosen = pickFromTiedByMuscle(candidatePool);
    if (!chosen) break;
    picked.push(chosen);
    idCounts.set(chosen.id, (idCounts.get(chosen.id) || 0) + 1);
    const pm = getPrimaryMuscle(chosen);
    if (pm) {
      muscleCounts[pm] = (muscleCounts[pm] || 0) + 1;
    }
  }

  return picked;
}

/**
 * Randomize round ordering and intra-round slot ordering while preserving balanced
 * superset pairings (e.g., Quads pairs) and single-round sequence separation.
 */
function randomizePartitionOrdering(partitionedGroups, workoutId = '', rng = Math.random) {
  if (!partitionedGroups || partitionedGroups.length === 0) return [];
  const nRounds = partitionedGroups.length;
  if (nRounds === 1) {
    const seq = [...partitionedGroups[0]];
    if (seq.length <= 3) {
      return [shuffleArrayWithRng(seq, rng)];
    }
    if (workoutId !== '5-constant-5-change-40-20' && rng() < 0.5) {
      return [[...seq].reverse()];
    }
    return [seq];
  }

  const randomizedRounds = partitionedGroups.map(group => {
    if (group.length <= 3) {
      return shuffleArrayWithRng(group, rng);
    }
    if (group.length === 4) {
      let p1 = rng() < 0.5 ? [group[0], group[1]] : [group[1], group[0]];
      let p2 = rng() < 0.5 ? [group[2], group[3]] : [group[3], group[2]];
      return rng() < 0.5 ? [...p1, ...p2] : [...p2, ...p1];
    }
    return [...group];
  });

  return shuffleArrayWithRng(randomizedRounds, rng);
}

/**
 * Generate a complete workout matching the Apps Script algorithm + Focus weighting + multi-option slots,
 * while guaranteeing zero avoidable muscle overload warnings and balanced round distributions.
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
  const isSpecificMuscleMode = SPECIFIC_MUSCLE_LIST.includes(bodyCategory);
  const { weights: focusWeights, enabled: focusEnabled } = normalizeFocusWeights(inputs);
  const effectiveBodyCategory = isSpecificMuscleMode
    ? bodyCategory
    : deriveBodyCategoryFromFocus(focusWeights, focusEnabled);

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
    bodyCategory: effectiveBodyCategory,
    equipment,
    excludedExerciseIds,
    focusWeights: isSpecificMuscleMode ? null : focusWeights,
    focusEnabled: isSpecificMuscleMode ? null : focusEnabled
  });

  // Fallback if user excluded almost everything
  const basePool = allFiltered.length > 0
    ? [...allFiltered]
    : sheetData.exercises.filter(
        ex => !excludedExerciseIds.includes(ex.id) && !excludedExerciseIds.includes(ex.name)
      );

  const nRounds = parseInt(selectedWorkout.rounds, 10) || 1;
  const nExercisesPerRound = parseInt(selectedWorkout.exercisesPerRound, 10) || 1;
  const totalSlots = nRounds * nExercisesPerRound;

  const usedExerciseIds = new Set();
  const rounds = [];

  if (!isSpecificMuscleMode) {
    // Step 4A: Focus-weighted full-workout quota selection + balanced round partitioning
    const areaPools = {
      'Upper Body': basePool.filter(ex => ex.bodyCategories?.['Upper Body'] === 'Pri'),
      'Core': basePool.filter(ex => ex.bodyCategories?.['Core'] === 'Pri'),
      'Legs': basePool.filter(ex => ex.bodyCategories?.['Legs'] === 'Pri')
    };
    const areaPoolSizes = {
      'Upper Body': areaPools['Upper Body'].length,
      'Core': areaPools['Core'].length,
      'Legs': areaPools['Legs'].length
    };
    const quotas = computeWorkoutAreaQuotas(totalSlots, focusWeights, areaPoolSizes);

    let chosenExercises = [];
    for (const area of BODY_AREAS) {
      const q = quotas[area] || 0;
      if (q <= 0) continue;
      const poolForArea = areaPools[area].length > 0 ? areaPools[area] : basePool;
      const pickedForArea = selectAreaExercisesWithMuscleBalance(
        poolForArea,
        q,
        nRounds,
        nExercisesPerRound,
        rng
      );
      chosenExercises.push(...pickedForArea);
    }

    while (chosenExercises.length < totalSlots && basePool.length > 0) {
      const fallbackEx = getRandomEntry(basePool, rng);
      if (!fallbackEx) break;
      chosenExercises.push(fallbackEx);
    }

    const shuffledChosen = shuffleArrayWithRng(chosenExercises.slice(0, totalSlots), rng);
    const partitioned = autoSlotExercises(shuffledChosen, selectedWorkout);
    const orderedGroups = randomizePartitionOrdering(partitioned, selectedWorkout.id, rng);

    orderedGroups.forEach((group, rndIdx) => {
      const roundSlots = group.map((primaryExercise, exIdx) => {
        usedExerciseIds.add(primaryExercise.id);
        return {
          roundIndex: rndIdx,
          slotIndex: exIdx,
          options: [primaryExercise],
          selectedOptionIndex: 0,
          optionChosen: false,
          completed: false,
          completedSets:
            checkMode.mode === 'exercise-sets'
              ? Array.from({ length: checkMode.count }, () => false)
              : [],
          manuallyModified: false
        };
      });
      rounds.push({
        roundNumber: rndIdx + 1,
        completed: false,
        slots: roundSlots
      });
    });
  } else {
    // Step 4B: Specific single-muscle filter mode
    let masterExercises = [...basePool];
    const maxBodyCategoryPercent =
      MAX_BODY_CATEGORY_PERCENTAGES[bodyCategory] !== undefined
        ? MAX_BODY_CATEGORY_PERCENTAGES[bodyCategory]
        : 1.0;

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

        roundSlots.push({
          roundIndex: rnd,
          slotIndex: exIdx,
          options: [primaryExercise],
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
  }

  // Step 5: Populate additional options (Option 2 / Option 3) if optionsPerSlot > 1
  // Done after all primary slot exercises are chosen so every round's full muscle profile is known
  if (numOptions > 1) {
    const currentPrimaryAreaCounts = { 'Upper Body': 0, 'Core': 0, 'Legs': 0 };
    rounds.forEach(r =>
      r.slots.forEach(s => {
        const a = getPrimaryBodyArea(s.options[0]);
        if (currentPrimaryAreaCounts[a] !== undefined) currentPrimaryAreaCounts[a] += 1;
      })
    );

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

        const coreMaxPerRound = isSpecificMuscleMode
          ? 1
          : Math.ceil((currentPrimaryAreaCounts['Core'] || 0) / Math.max(1, nRounds));

        for (let optIdx = 1; optIdx < numOptions; optIdx++) {
          const getMaxOtherForMuscle = m => {
            if (isSpecificMuscleMode && m === bodyCategory) return round.slots.length;
            if (m === 'Abs' && coreMaxPerRound > 1) return coreMaxPerRound - 1;
            return round.slots.length > 4 ? 1 : 0;
          };
          const isZeroCollision = ex =>
            !Object.entries(ex.muscles || {}).some(([m, lvl]) => {
              if (lvl !== 'Pri') return false;
              if (isSpecificMuscleMode && m === bodyCategory) return false;
              if (m === 'Abs' && coreMaxPerRound > 1) {
                return (otherSlotsPriCounts[m] || 0) > coreMaxPerRound - 1;
              }
              return otherSlotsPriMuscles.has(m);
            });
          const isSafeForRound = ex =>
            !Object.entries(ex.muscles || {}).some(
              ([m, lvl]) => lvl === 'Pri' && (otherSlotsPriCounts[m] || 0) > getMaxOtherForMuscle(m)
            );
          const isWithinFocusBand = ex =>
            isSpecificMuscleMode ||
            isWithinAutoFocusErrorBar({
              focusWeights,
              currentAreaCounts: currentPrimaryAreaCounts,
              totalSlots,
              oldArea: targetArea,
              candArea: getPrimaryBodyArea(ex)
            });

          // Tier 1: Unused in workout, same body area, zero muscle collision in round
          let altCandidates = basePool.filter(
            ex =>
              !usedExerciseIds.has(ex.id) &&
              !roundExerciseIds.has(ex.id) &&
              (targetArea === 'All' || ex.bodyCategories[targetArea] === 'Pri') &&
              isZeroCollision(ex)
          );

          // Tier 2: Unused in workout, within focus error bar, zero muscle collision in round
          if (altCandidates.length === 0) {
            altCandidates = basePool.filter(
              ex =>
                !usedExerciseIds.has(ex.id) &&
                !roundExerciseIds.has(ex.id) &&
                isWithinFocusBand(ex) &&
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

          // Tier 4: Not in current round, within focus error bar, safe for round (no overload)
          if (altCandidates.length === 0) {
            altCandidates = basePool.filter(
              ex =>
                !roundExerciseIds.has(ex.id) &&
                !slot.options.some(o => o.id === ex.id) &&
                isWithinFocusBand(ex) &&
                isSafeForRound(ex)
            );
          }

          // Tier 4b: If narrow filter pool exhausted a muscle group (e.g. only 1 Glutes in Strength+Legs+Weights),
          // expand to non-excluded exercises in the same body area / active focus areas that are safe for the round
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
              altCandidates = nonExcludedAll.filter(isWithinFocusBand);
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
      bodyCategory: effectiveBodyCategory,
      focusWeights: { ...focusWeights },
      focusEnabled: { ...focusEnabled },
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
  const seenIds = new Set();
  const priMuscleCounts = {};
  const secMuscleCounts = {};
  const areaCounts = { 'Upper Body': 0, 'Core': 0, 'Legs': 0 };

  for (const ex of group) {
    if (ex?.id) {
      if (seenIds.has(ex.id)) {
        cost += 10000;
      }
      seenIds.add(ex.id);
    }
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
 * Auto-fill remaining exercises up to `totalNeeded` from `sheetData` respecting `focusWeights`
 * quotas across the full workout and balancing primary muscle groups.
 */
export function pickAutoFillExercises(
  sheetData,
  inputs = {},
  existingExercises = [],
  totalNeeded = 8,
  rng = Math.random
) {
  const {
    workoutCategory: rawWorkoutCategory = 'HIIT',
    bodyCategory = 'All',
    equipment = 'Any',
    excludedExerciseIds = []
  } = inputs;

  const isSpecificMuscleMode = SPECIFIC_MUSCLE_LIST.includes(bodyCategory);
  const { weights: focusWeights, enabled: focusEnabled } = normalizeFocusWeights(inputs);
  const effectiveBodyCategory = isSpecificMuscleMode
    ? bodyCategory
    : deriveBodyCategoryFromFocus(focusWeights, focusEnabled);

  const exMap = new Map((sheetData?.exercises || []).map(e => [e.id, e]));
  const chosenList = [];
  const chosenIds = new Set();

  for (const item of existingExercises) {
    const ex = typeof item === 'string' ? exMap.get(item) : exMap.get(item?.id) || item;
    if (ex && !chosenIds.has(ex.id)) {
      chosenList.push(ex);
      chosenIds.add(ex.id);
    }
  }

  if (chosenList.length >= totalNeeded) {
    return chosenList.slice(0, totalNeeded);
  }

  const eligible = filterEligibleExercises(sheetData?.exercises || [], {
    workoutCategory: rawWorkoutCategory,
    bodyCategory: effectiveBodyCategory,
    equipment,
    excludedExerciseIds,
    focusWeights: isSpecificMuscleMode ? null : focusWeights,
    focusEnabled: isSpecificMuscleMode ? null : focusEnabled
  }).filter(e => !chosenIds.has(e.id));

  const fallbackPool =
    eligible.length >= totalNeeded - chosenList.length
      ? eligible
      : (sheetData?.exercises || []).filter(
          e =>
            !chosenIds.has(e.id) &&
            !excludedExerciseIds.includes(e.id) &&
            !excludedExerciseIds.includes(e.name)
        );

  const areaPoolSizes = {
    'Upper Body':
      chosenList.filter(e => getPrimaryBodyArea(e) === 'Upper Body').length +
      fallbackPool.filter(e => getPrimaryBodyArea(e) === 'Upper Body').length,
    'Core':
      chosenList.filter(e => getPrimaryBodyArea(e) === 'Core').length +
      fallbackPool.filter(e => getPrimaryBodyArea(e) === 'Core').length,
    'Legs':
      chosenList.filter(e => getPrimaryBodyArea(e) === 'Legs').length +
      fallbackPool.filter(e => getPrimaryBodyArea(e) === 'Legs').length
  };
  const targetQuotas = isSpecificMuscleMode
    ? null
    : computeWorkoutAreaQuotas(totalNeeded, focusWeights, areaPoolSizes);

  while (chosenList.length < totalNeeded && fallbackPool.length > 0) {
    const muscleCounts = {};
    const areaCounts = { 'Upper Body': 0, 'Core': 0, 'Legs': 0 };
    chosenList.forEach(e => {
      const pm = getPrimaryMuscle(e);
      if (pm) muscleCounts[pm] = (muscleCounts[pm] || 0) + 1;
      const area = getPrimaryBodyArea(e);
      if (areaCounts[area] !== undefined) areaCounts[area] += 1;
    });

    const available = shuffleArrayWithRng(
      fallbackPool.filter(e => !chosenIds.has(e.id)),
      rng
    );
    if (available.length === 0) break;

    available.sort((a, b) => {
      const areaA = getPrimaryBodyArea(a);
      const areaB = getPrimaryBodyArea(b);
      if (!isSpecificMuscleMode && targetQuotas) {
        const activeA = (focusWeights[areaA] || 0) > 1e-9 ? 1 : 0;
        const activeB = (focusWeights[areaB] || 0) > 1e-9 ? 1 : 0;
        if (activeA !== activeB) return activeB - activeA;

        const defA = (targetQuotas[areaA] || 0) - (areaCounts[areaA] || 0);
        const defB = (targetQuotas[areaB] || 0) - (areaCounts[areaB] || 0);
        const needsA = defA > 0 ? 1 : 0;
        const needsB = defB > 0 ? 1 : 0;
        if (needsA !== needsB) return needsB - needsA;
        if (defA !== defB) return defB - defA;
      }

      const mA = muscleCounts[getPrimaryMuscle(a)] || 0;
      const mB = muscleCounts[getPrimaryMuscle(b)] || 0;
      if (mA !== mB) return mA - mB;

      const aA = areaCounts[areaA] || 0;
      const aB = areaCounts[areaB] || 0;
      return aA - aB;
    });

    const pick = available[0];
    chosenList.push(pick);
    chosenIds.add(pick.id);
  }

  return chosenList;
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

  const isSpecificMuscleMode = SPECIFIC_MUSCLE_LIST.includes(bodyCategory);
  const { weights: focusWeights, enabled: focusEnabled } = normalizeFocusWeights(inputs);
  const effectiveBodyCategory = isSpecificMuscleMode
    ? bodyCategory
    : deriveBodyCategoryFromFocus(focusWeights, focusEnabled);

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
  let chosenList = [];
  const chosenIds = new Set();

  for (const item of selectedExercises) {
    const ex = typeof item === 'string' ? exMap.get(item) : exMap.get(item?.id) || item;
    if (ex && !chosenIds.has(ex.id)) {
      chosenList.push(ex);
      chosenIds.add(ex.id);
    }
  }

  // If fewer than totalNeeded were provided, auto-fill remaining with focus-weighted balanced exercises
  if (chosenList.length < totalNeeded) {
    chosenList = pickAutoFillExercises(
      sheetData,
      {
        ...inputs,
        workoutCategory: resolvedWorkoutCategory,
        bodyCategory: effectiveBodyCategory,
        equipment,
        excludedExerciseIds,
        focusWeights,
        focusEnabled
      },
      chosenList,
      totalNeeded,
      rng
    );
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
      bodyCategory: effectiveBodyCategory,
      focusWeights: { ...focusWeights },
      focusEnabled: { ...focusEnabled },
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
 * 1) Match active filters, Focus weights (within AUTO_FOCUS_ERROR_BAR), and user exclusions
 * 2) Are not already used in the workout
 * 3) Respect both full-workout Focus distribution and intra-round body-area balance
 * 4) Do NOT trigger any muscle or focus overload warning!
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

  const bodyCategory = workoutState.inputs?.bodyCategory || 'All';
  const isSpecificMuscleMode = SPECIFIC_MUSCLE_LIST.includes(bodyCategory);
  const { weights: focusWeights, enabled: focusEnabled } = normalizeFocusWeights(
    workoutState.inputs || { bodyCategory }
  );

  const nRounds = workoutState.rounds.length || 1;
  const totalSlots = workoutState.rounds.reduce((acc, r) => acc + r.slots.length, 0);
  const currentAreaCounts = { 'Upper Body': 0, 'Core': 0, 'Legs': 0 };
  workoutState.rounds.forEach(r =>
    r.slots.forEach(s => {
      const a = getPrimaryBodyArea(getActiveSlotExercise(s));
      if (currentAreaCounts[a] !== undefined) currentAreaCounts[a] += 1;
    })
  );
  const expectedAreaQuotas = computeWorkoutAreaQuotas(totalSlots, focusWeights);

  const otherRoundAreaCounts = { 'Upper Body': 0, 'Core': 0, 'Legs': 0 };
  (round?.slots || []).forEach((s, idx) => {
    if (idx === slotIndex) return;
    const a = getPrimaryBodyArea(getActiveSlotExercise(s));
    if (otherRoundAreaCounts[a] !== undefined) otherRoundAreaCounts[a] += 1;
  });

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
    bodyCategory,
    equipment: workoutState.inputs.equipment,
    excludedExerciseIds,
    focusWeights: isSpecificMuscleMode ? null : focusWeights,
    focusEnabled: isSpecificMuscleMode ? null : focusEnabled
  }).filter(ex => !usedIds.has(ex.id) && ex.id !== currentEx?.id);

  function isCandidateWarningFree(candidate) {
    const candPri = getPrimaryMuscle(candidate);
    const maxExpectedCoreInRound = Math.ceil((expectedAreaQuotas['Core'] || 0) / Math.max(1, nRounds));
    const allowAbsInRound =
      candPri === 'Abs' &&
      focusWeights['Core'] >= 0.5 - 1e-9 &&
      (otherRoundAreaCounts['Core'] + 1) <= maxExpectedCoreInRound;
    if (
      (round?.slots?.length || 2) <= 4 &&
      candPri &&
      otherSlotsPriMuscles.has(candPri) &&
      !allowAbsInRound
    ) {
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

  function passesAutoFocus(candidate) {
    if (isSpecificMuscleMode) return true;
    return isWithinAutoFocusErrorBar({
      focusWeights,
      currentAreaCounts,
      totalSlots,
      oldArea: targetBodyArea,
      candArea: getPrimaryBodyArea(candidate)
    });
  }

  function passesRoundAreaBalance(candidate) {
    if (isSpecificMuscleMode || nRounds < 2) return true;
    const candArea = getPrimaryBodyArea(candidate);
    const newTotalCandArea =
      (currentAreaCounts[candArea] || 0) - (candArea === targetBodyArea ? 1 : 0) + 1;
    const maxBalancedInRound = Math.max(1, Math.ceil(newTotalCandArea / nRounds));
    return (otherRoundAreaCounts[candArea] || 0) + 1 <= maxBalancedInRound;
  }

  function focusDeviationAfterSwap(candidate) {
    if (isSpecificMuscleMode) return 0;
    const candArea = getPrimaryBodyArea(candidate);
    let l1 = 0;
    for (const a of BODY_AREAS) {
      const nextCount =
        (currentAreaCounts[a] || 0) - (a === targetBodyArea ? 1 : 0) + (a === candArea ? 1 : 0);
      l1 += Math.abs(nextCount / Math.max(1, totalSlots) - (focusWeights[a] || 0));
    }
    return l1;
  }

  function sortByFocusAlignment(list) {
    return [...list].sort((a, b) => {
      const diff = focusDeviationAfterSwap(a) - focusDeviationAfterSwap(b);
      if (Math.abs(diff) > 1e-6) return diff;
      const sameA = a.bodyCategories?.[targetBodyArea] === 'Pri' ? 0 : 1;
      const sameB = b.bodyCategories?.[targetBodyArea] === 'Pri' ? 0 : 1;
      return sameA - sameB;
    });
  }

  let warningFree = eligible.filter(isCandidateWarningFree);

  if (!isSpecificMuscleMode && warningFree.length > 0) {
    const strictFocusAndRound = warningFree.filter(
      ex => passesAutoFocus(ex) && passesRoundAreaBalance(ex)
    );
    if (strictFocusAndRound.length > 0) {
      return sortByFocusAlignment(strictFocusAndRound);
    }
    const strictFocusOnly = warningFree.filter(passesAutoFocus);
    if (strictFocusOnly.length > 0) {
      return sortByFocusAlignment(strictFocusOnly);
    }
    return sortByFocusAlignment(warningFree);
  }

  // If restrictive filters left 0 warning-free candidates in `eligible`,
  // widen to equipment-matching non-excluded exercises not used in the workout that are warning-free!
  if (warningFree.length === 0) {
    const widerPool = filterEligibleExercises(sheetData.exercises, {
      workoutCategory: workoutState.inputs.effectiveWorkoutCategory,
      bodyCategory: 'All',
      equipment: workoutState.inputs.equipment,
      excludedExerciseIds
    }).filter(ex => !usedIds.has(ex.id) && ex.id !== currentEx?.id);
    const widerWarningFree = widerPool.filter(isCandidateWarningFree);
    const widerInFocus = widerWarningFree.filter(passesAutoFocus);
    warningFree = widerInFocus.length > 0 ? widerInFocus : widerWarningFree;
  }

  if (warningFree.length === 0) {
    const allPool = sheetData.exercises.filter(
      ex =>
        !excludedExerciseIds.includes(ex.id) &&
        !excludedExerciseIds.includes(ex.name) &&
        !usedIds.has(ex.id) &&
        ex.id !== currentEx?.id
    );
    const allWarningFree = allPool.filter(isCandidateWarningFree);
    const allInFocus = allWarningFree.filter(passesAutoFocus);
    warningFree = allInFocus.length > 0 ? allInFocus : allWarningFree;
  }

  if (!isSpecificMuscleMode && warningFree.length > 0) {
    return sortByFocusAlignment(warningFree);
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

  slotA.roundIndex = toRoundIndex;
  slotA.slotIndex = toSlotIndex;
  slotA.manuallyModified = true;
  slotB.roundIndex = fromRoundIndex;
  slotB.slotIndex = fromSlotIndex;
  slotB.manuallyModified = true;

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
