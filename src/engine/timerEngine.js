/**
 * HIIT & Custom Workout Timer Engine
 * Automatically tunes interval sequences to each timed HIIT workout and exercise,
 * always starting with a 10-second yellow countdown, and supports full per-exercise
 * and per-interval customization (adding new times, changing colors and durations),
 * plus custom timer presets and automatic reset on workout type change.
 */

import { getActiveSlotExercise } from './workoutEngine.js';

export const TIMER_COLORS = {
  yellow: {
    id: 'yellow',
    label: 'Yellow',
    hex: '#eab308',
    bg: '#fef08a',
    cardBg: '#fef9c3',
    border: '#facc15',
    text: '#713f12',
    pillBg: '#ca8a04',
    pillText: '#ffffff'
  },
  green: {
    id: 'green',
    label: 'Green',
    hex: '#16a34a',
    bg: '#bbf7d0',
    cardBg: '#dcfce7',
    border: '#22c55e',
    text: '#14532d',
    pillBg: '#15803d',
    pillText: '#ffffff'
  },
  blue: {
    id: 'blue',
    label: 'Blue',
    hex: '#2563eb',
    bg: '#bfdbfe',
    cardBg: '#dbeafe',
    border: '#3b82f6',
    text: '#1e3a8a',
    pillBg: '#1d4ed8',
    pillText: '#ffffff'
  },
  red: {
    id: 'red',
    label: 'Red',
    hex: '#dc2626',
    bg: '#fecaca',
    cardBg: '#fee2e2',
    border: '#ef4444',
    text: '#7f1d1d',
    pillBg: '#b91c1c',
    pillText: '#ffffff'
  },
  orange: {
    id: 'orange',
    label: 'Orange',
    hex: '#ea580c',
    bg: '#fed7aa',
    cardBg: '#ffedd5',
    border: '#f97316',
    text: '#7c2d12',
    pillBg: '#c2410c',
    pillText: '#ffffff'
  },
  purple: {
    id: 'purple',
    label: 'Purple',
    hex: '#9333ea',
    bg: '#e9d5ff',
    cardBg: '#f3e8ff',
    border: '#a855f7',
    text: '#581c87',
    pillBg: '#7e22ce',
    pillText: '#ffffff'
  }
};

export const TIMED_HIIT_WORKOUT_IDS = new Set([
  'timed-duos-40-20',
  'timed-trios-40-20',
  '8-excercises-40-20',
  '30-20-10-10-20-30',
  '6-excercise-pyramid',
  '5-constant-5-change-40-20',
  '8x8-duos'
]);

export const CUSTOM_TIMER_PRESETS = [
  {
    id: 'custom-40-20-6',
    name: '40/20 Duo (6 Pairs)',
    description: '10s yellow countdown + 6 pairs of 40s green work & 20s blue rest',
    pairs: 6,
    workDuration: 40,
    workColor: 'green',
    restDuration: 20,
    restColor: 'blue'
  },
  {
    id: 'custom-tabata-20-10',
    name: 'Tabata 20/10 (8 Pairs)',
    description: '10s yellow countdown + 8 pairs of 20s green work & 10s blue rest',
    pairs: 8,
    workDuration: 20,
    workColor: 'green',
    restDuration: 10,
    restColor: 'blue'
  },
  {
    id: 'custom-45-15-6',
    name: 'HIIT 45/15 (6 Pairs)',
    description: '10s yellow countdown + 6 pairs of 45s green work & 15s blue rest',
    pairs: 6,
    workDuration: 45,
    workColor: 'green',
    restDuration: 15,
    restColor: 'blue'
  },
  {
    id: 'custom-30-30-6',
    name: '30/30 Intervals (6 Pairs)',
    description: '10s yellow countdown + 6 pairs of 30s green work & 30s blue rest',
    pairs: 6,
    workDuration: 30,
    workColor: 'green',
    restDuration: 30,
    restColor: 'blue'
  },
  {
    id: 'custom-burnout-60-20',
    name: 'Endurance 60/20 (4 Pairs)',
    description: '10s yellow countdown + 4 pairs of 60s green work & 20s blue rest',
    pairs: 4,
    workDuration: 60,
    workColor: 'green',
    restDuration: 20,
    restColor: 'blue'
  }
];

/**
 * Check whether a workout is a timed HIIT workout (excludes untimed Strength workouts and rep-only ladders).
 */
export function isTimedHiitWorkout(workout) {
  if (!workout) return false;
  return TIMED_HIIT_WORKOUT_IDS.has(workout.id);
}

/**
 * Format seconds into MM:SS.
 */
export function formatTimerClock(totalSeconds) {
  const sec = Math.max(0, Math.ceil(Number(totalSeconds) || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Return the bottom display label for a timer step:
 * - "Count Down" for the yellow countdown timer
 * - "[name of exercise]" for the green exercise timer
 * - "Rest" for the blue rest timer
 */
export function getTimerBottomLabel(step) {
  if (!step) return '';
  if (step.type === 'countdown') {
    return step.customLabel || 'Count Down';
  }
  if (step.type === 'transition') {
    return step.customLabel || 'Transition';
  }
  if (step.type === 'rest') {
    return step.customLabel || 'Rest';
  }
  return step.exerciseName || 'Work';
}

/**
 * Return the default work/rest configuration for an exercise inside a given workout type.
 */
export function getDefaultExerciseTimerConfig(workout) {
  const wkId = workout?.id || '';
  if (wkId === '6-excercise-pyramid') {
    return {
      workDuration: 30,
      workColor: 'green',
      restDuration: 60,
      restColor: 'blue',
      transitionDuration: 10,
      transitionColor: 'yellow',
      extraIntervals: []
    };
  }
  if (wkId === '30-20-10-10-20-30') {
    return {
      workDuration: 30,
      workColor: 'green',
      restDuration: 30,
      restColor: 'blue',
      extraIntervals: []
    };
  }
  if (wkId === '8x8-duos') {
    return {
      workDuration: 480,
      workColor: 'green',
      restDuration: 60,
      restColor: 'blue',
      extraIntervals: []
    };
  }
  return {
    workDuration: 40,
    workColor: 'green',
    restDuration: 20,
    restColor: 'blue',
    extraIntervals: []
  };
}

/**
 * Helper to resolve effective work/rest settings for a specific exercise ID.
 */
function resolveExConfig(workout, exerciseId, exerciseConfigs = {}) {
  const defaults = getDefaultExerciseTimerConfig(workout);
  const custom = (exerciseId && exerciseConfigs[exerciseId]) || {};
  return {
    workDuration: Math.max(1, Number(custom.workDuration ?? defaults.workDuration) || defaults.workDuration),
    workColor: TIMER_COLORS[custom.workColor] ? custom.workColor : defaults.workColor,
    restDuration: Math.max(0, Number(custom.restDuration ?? defaults.restDuration) || defaults.restDuration),
    restColor: TIMER_COLORS[custom.restColor] ? custom.restColor : defaults.restColor,
    extraIntervals: Array.isArray(custom.extraIntervals) ? custom.extraIntervals : []
  };
}

/**
 * Append any extra user-configured intervals for a specific exercise.
 */
function appendExtraExerciseIntervals(steps, ex, cfg, roundNumber, pairCounterRef) {
  if (!cfg.extraIntervals || cfg.extraIntervals.length === 0) return;
  cfg.extraIntervals.forEach((extra, idx) => {
    const dur = Math.max(1, Number(extra.duration) || 20);
    const col = TIMER_COLORS[extra.color] ? extra.color : 'orange';
    const type = extra.type || (col === 'blue' ? 'rest' : 'work');
    steps.push({
      id: `step-${steps.length + 1}`,
      type,
      phaseLabel: extra.label || `${ex.name} (Extra ${idx + 1})`,
      exerciseId: ex.id,
      exerciseName: ex.name,
      roundNumber,
      pairIndex: pairCounterRef.count,
      duration: dur,
      color: col
    });
  });
}

/**
 * Build the tuned Stock Timer interval sequence for a workout, round, or specific exercise.
 * Always starts with a 10-second yellow countdown.
 */
export function buildStockTimerSequence(
  workoutState,
  {
    roundIndex = 0,
    slotIndex = null,
    includeAllRounds = false,
    exerciseConfigs = {},
    countdownDuration = 10
  } = {}
) {
  if (!workoutState || !workoutState.rounds || workoutState.rounds.length === 0) {
    return [];
  }

  const workout = workoutState.workout || {};
  const wkId = workout.id || '';
  const safeRoundIdx = Math.min(workoutState.rounds.length - 1, Math.max(0, Number(roundIndex) || 0));
  const targetRounds = includeAllRounds
    ? workoutState.rounds.map((r, idx) => ({ round: r, idx }))
    : [{ round: workoutState.rounds[safeRoundIdx], idx: safeRoundIdx }];

  const steps = [];
  const pairCounter = { count: 0 };

  // Helper to push a work + rest pair
  function pushWorkRestPair({
    ex,
    roundNumber,
    setNumber,
    totalSets,
    workDuration,
    workColor,
    restDuration,
    restColor,
    customWorkLabel = null,
    customRestLabel = null
  }) {
    pairCounter.count += 1;
    const pIdx = pairCounter.count;
    const setTag = totalSets ? `Set ${setNumber}/${totalSets}` : `Interval ${pIdx}`;

    steps.push({
      id: `step-${steps.length + 1}`,
      type: 'work',
      phaseLabel: customWorkLabel || `Work · ${setTag}`,
      exerciseId: ex?.id || null,
      exerciseName: ex?.name || 'Work',
      roundNumber,
      setNumber,
      totalSets,
      pairIndex: pIdx,
      duration: Math.max(1, Number(workDuration) || 40),
      color: TIMER_COLORS[workColor] ? workColor : 'green'
    });

    if (restDuration > 0) {
      steps.push({
        id: `step-${steps.length + 1}`,
        type: 'rest',
        phaseLabel: customRestLabel || `Rest · ${setTag}`,
        exerciseId: ex?.id || null,
        exerciseName: 'Rest',
        roundNumber,
        setNumber,
        totalSets,
        pairIndex: pIdx,
        duration: Math.max(1, Number(restDuration) || 20),
        color: TIMER_COLORS[restColor] ? restColor : 'blue'
      });
    }

    if (ex) {
      const cfg = resolveExConfig(workout, ex.id, exerciseConfigs);
      appendExtraExerciseIntervals(steps, ex, cfg, roundNumber, pairCounter);
    }
  }

  // If a single exercise slot was explicitly requested for a per-exercise timer
  if (slotIndex !== null && slotIndex !== undefined) {
    const round = workoutState.rounds[safeRoundIdx];
    const slot = round?.slots?.[slotIndex];
    const ex = getActiveSlotExercise(slot);
    if (ex) {
      const cfg = resolveExConfig(workout, ex.id, exerciseConfigs);
      if (wkId === '30-20-10-10-20-30') {
        const hasCustomWork = exerciseConfigs[ex.id]?.workDuration !== undefined;
        const hasCustomRest = exerciseConfigs[ex.id]?.restDuration !== undefined;
        const pyramidPairs = [
          [hasCustomWork ? cfg.workDuration : 30, hasCustomRest ? cfg.restDuration : 30],
          [hasCustomWork ? cfg.workDuration : 20, hasCustomRest ? cfg.restDuration : 20],
          [hasCustomWork ? cfg.workDuration : 10, hasCustomRest ? cfg.restDuration : 10],
          [hasCustomWork ? cfg.workDuration : 10, hasCustomRest ? cfg.restDuration : 10],
          [hasCustomWork ? cfg.workDuration : 20, hasCustomRest ? cfg.restDuration : 20],
          [hasCustomWork ? cfg.workDuration : 30, hasCustomRest ? cfg.restDuration : 60]
        ];
        pyramidPairs.forEach(([wDur, rDur], idx) => {
          pushWorkRestPair({
            ex,
            roundNumber: round.roundNumber,
            setNumber: idx + 1,
            totalSets: 6,
            workDuration: wDur,
            workColor: cfg.workColor,
            restDuration: rDur,
            restColor: cfg.restColor,
            customWorkLabel: `${ex.name} · Set ${idx + 1}/6 (${wDur}s)`,
            customRestLabel: idx === 5 ? `Recovery Rest (${rDur}s)` : `Rest · Set ${idx + 1}/6 (${rDur}s)`
          });
        });
      } else if (wkId === '8x8-duos') {
        pushWorkRestPair({
          ex,
          roundNumber: round.roundNumber,
          setNumber: 1,
          totalSets: 1,
          workDuration: cfg.workDuration,
          workColor: cfg.workColor,
          restDuration: cfg.restDuration,
          restColor: cfg.restColor,
          customWorkLabel: `${ex.name} · 8-Min AMRAP`
        });
      } else {
        // Standard sets for this exercise (or full round pairs if Duos/Trios)
        const sets = Number(workout.setsPerRound) || 3;
        const numPairs = sets <= 5 ? sets : 6;
        for (let s = 0; s < numPairs; s++) {
          pushWorkRestPair({
            ex,
            roundNumber: round.roundNumber,
            setNumber: s + 1,
            totalSets: numPairs,
            workDuration: cfg.workDuration,
            workColor: cfg.workColor,
            restDuration: cfg.restDuration,
            restColor: cfg.restColor
          });
        }
      }
      return finalizeWithCountdown(steps, countdownDuration);
    }
  }

  // Otherwise build the workout/round-level tuned sequence
  if (wkId === 'timed-duos-40-20' || wkId === 'strength-duos') {
    // 4 rounds, 2 exercises per round, 3 sets per round -> 6 pairs of 40s green + 20s blue per round
    for (const { round } of targetRounds) {
      const sets = Number(workout.setsPerRound) || 3;
      for (let s = 0; s < sets; s++) {
        for (let sl = 0; sl < round.slots.length; sl++) {
          const ex = getActiveSlotExercise(round.slots[sl]);
          if (!ex) continue;
          const cfg = resolveExConfig(workout, ex.id, exerciseConfigs);
          pushWorkRestPair({
            ex,
            roundNumber: round.roundNumber,
            setNumber: s + 1,
            totalSets: sets,
            workDuration: cfg.workDuration,
            workColor: cfg.workColor,
            restDuration: cfg.restDuration,
            restColor: cfg.restColor
          });
        }
      }
    }
  } else if (wkId === 'timed-trios-40-20' || wkId === 'strength-trios') {
    // 3 rounds, 3 exercises per round, 3 sets per round -> 9 pairs of 40s green + 20s blue per round
    for (const { round } of targetRounds) {
      const sets = Number(workout.setsPerRound) || 3;
      for (let s = 0; s < sets; s++) {
        for (let sl = 0; sl < round.slots.length; sl++) {
          const ex = getActiveSlotExercise(round.slots[sl]);
          if (!ex) continue;
          const cfg = resolveExConfig(workout, ex.id, exerciseConfigs);
          pushWorkRestPair({
            ex,
            roundNumber: round.roundNumber,
            setNumber: s + 1,
            totalSets: sets,
            workDuration: cfg.workDuration,
            workColor: cfg.workColor,
            restDuration: cfg.restDuration,
            restColor: cfg.restColor
          });
        }
      }
    }
  } else if (wkId === '8-excercises-40-20') {
    // 8 exercises repeated for 3 rounds/sets -> 8 pairs per round, or 24 pairs for full workout
    const round = workoutState.rounds[0];
    const sets = Number(workout.setsPerRound) || 3;
    const passIndices = includeAllRounds
      ? Array.from({ length: sets }, (_, i) => i)
      : [Math.min(sets - 1, Math.max(0, Number(roundIndex) || 0))];
    for (const s of passIndices) {
      for (let sl = 0; sl < round.slots.length; sl++) {
        const ex = getActiveSlotExercise(round.slots[sl]);
        if (!ex) continue;
        const cfg = resolveExConfig(workout, ex.id, exerciseConfigs);
        pushWorkRestPair({
          ex,
          roundNumber: s + 1,
          setNumber: s + 1,
          totalSets: sets,
          workDuration: cfg.workDuration,
          workColor: cfg.workColor,
          restDuration: cfg.restDuration,
          restColor: cfg.restColor
        });
      }
    }
  } else if (wkId === '30-20-10-10-20-30') {
    // 8 exercises, 6 sets per exercise: 30/30, 20/20, 10/10, 10/10, 20/20, 30 + 60s rest between exercises
    const round = workoutState.rounds[0];
    round.slots.forEach((slot, slIdx) => {
      const ex = getActiveSlotExercise(slot);
      if (!ex) return;
      const cfg = resolveExConfig(workout, ex.id, exerciseConfigs);
      const hasCustomWork = exerciseConfigs[ex.id]?.workDuration !== undefined;
      const hasCustomRest = exerciseConfigs[ex.id]?.restDuration !== undefined;
      const intervals = [
        [hasCustomWork ? cfg.workDuration : 30, hasCustomRest ? cfg.restDuration : 30],
        [hasCustomWork ? cfg.workDuration : 20, hasCustomRest ? cfg.restDuration : 20],
        [hasCustomWork ? cfg.workDuration : 10, hasCustomRest ? cfg.restDuration : 10],
        [hasCustomWork ? cfg.workDuration : 10, hasCustomRest ? cfg.restDuration : 10],
        [hasCustomWork ? cfg.workDuration : 20, hasCustomRest ? cfg.restDuration : 20],
        [hasCustomWork ? cfg.workDuration : 30, hasCustomRest ? cfg.restDuration : 60]
      ];
      intervals.forEach(([wDur, rDur], setIdx) => {
        pushWorkRestPair({
          ex,
          roundNumber: slIdx + 1,
          setNumber: setIdx + 1,
          totalSets: 6,
          workDuration: wDur,
          workColor: cfg.workColor,
          restDuration: rDur,
          restColor: cfg.restColor,
          customWorkLabel: `Ex ${slIdx + 1}/8 · Set ${setIdx + 1}/6 (${wDur}s)`,
          customRestLabel:
            setIdx === 5
              ? `60s Transition Rest (Before Ex ${ Math.min(8, slIdx + 2) })`
              : `Rest · Set ${setIdx + 1}/6 (${rDur}s)`
        });
      });
    });
  } else if (wkId === '6-excercise-pyramid') {
    // 6 exercises, 11 progressive/regressive pyramid sets:
    // Set 1: Ex 1 (30s) + Rest (60s)
    // Set 2: Ex 1 (30s) + Transition (10s) + Ex 2 (30s) + Rest (60s)
    // ... Set 6: Ex 1..6 (30s each with 10s Transition between exercises) + Rest (60s)
    // Set 7: Ex 2..6 (30s each with 10s Transition between exercises) + Rest (60s)
    // ... Set 11: Ex 6 (30s) + Rest (60s)
    const round = workoutState.rounds[0];
    const exList = round.slots.map(s => getActiveSlotExercise(s)).filter(Boolean);
    const n = exList.length; // 6
    const rungs = [];
    for (let end = 1; end <= n; end++) {
      rungs.push(exList.slice(0, end));
    }
    for (let start = 1; start < n; start++) {
      rungs.push(exList.slice(start, n));
    }
    rungs.forEach((rungExercises, rungIdx) => {
      pairCounter.count += 1;
      const setNum = rungIdx + 1;
      rungExercises.forEach((ex, idxInRung) => {
        const cfg = resolveExConfig(workout, ex.id, exerciseConfigs);
        steps.push({
          id: `step-${steps.length + 1}`,
          type: 'work',
          phaseLabel: `Pyramid Set ${setNum}/${rungs.length} · Move ${idxInRung + 1}/${rungExercises.length}`,
          exerciseId: ex.id,
          exerciseName: ex.name,
          roundNumber: setNum,
          setNumber: setNum,
          totalSets: rungs.length,
          pairIndex: pairCounter.count,
          duration: cfg.workDuration,
          color: cfg.workColor
        });
        appendExtraExerciseIntervals(steps, ex, cfg, setNum, pairCounter);

        // 10-second Transition timer between exercises within a pyramid set
        if (idxInRung < rungExercises.length - 1) {
          const nextExInRung = rungExercises[idxInRung + 1];
          steps.push({
            id: `step-${steps.length + 1}`,
            type: 'transition',
            phaseLabel: `Pyramid Set ${setNum}/${rungs.length} · 10s Transition`,
            exerciseId: nextExInRung?.id || ex.id,
            exerciseName: 'Transition',
            customLabel: 'Transition',
            roundNumber: setNum,
            setNumber: setNum,
            totalSets: rungs.length,
            pairIndex: pairCounter.count,
            duration: 10,
            color: 'yellow'
          });
        }
      });
      const lastEx = rungExercises[rungExercises.length - 1];
      const lastCfg = resolveExConfig(workout, lastEx?.id, exerciseConfigs);
      steps.push({
        id: `step-${steps.length + 1}`,
        type: 'rest',
        phaseLabel: `Pyramid Rest · End of Set ${setNum}/${rungs.length}`,
        exerciseId: lastEx?.id || null,
        exerciseName: 'Rest',
        roundNumber: setNum,
        setNumber: setNum,
        totalSets: rungs.length,
        pairIndex: pairCounter.count,
        duration: lastCfg.restDuration,
        color: lastCfg.restColor
      });
    });
  } else if (wkId === '5-constant-5-change-40-20') {
    // 8 exercises: first 3 (indices 0,1,2) are Round 1,2,3 Constants; next 5 (indices 3..7) are shared Changing exercises.
    // Each of the 3 rounds has 10 pairs of 40s Green + 20s Blue alternating Constant #r with Change #1..5.
    const allSlots = workoutState.rounds[0]?.slots || [];
    const exList = allSlots.map(s => getActiveSlotExercise(s)).filter(Boolean);
    const constants = exList.slice(0, 3);
    const changes = exList.slice(3, 8);
    const roundsToBuild = includeAllRounds ? [0, 1, 2] : [Math.min(2, Math.max(0, roundIndex))];

    for (const cIdx of roundsToBuild) {
      const constEx = constants[cIdx] || exList[0];
      const constCfg = resolveExConfig(workout, constEx?.id, exerciseConfigs);
      changes.forEach((changeEx, chIdx) => {
        const changeCfg = resolveExConfig(workout, changeEx?.id, exerciseConfigs);
        // Constant interval pair
        pushWorkRestPair({
          ex: constEx,
          roundNumber: cIdx + 1,
          setNumber: chIdx * 2 + 1,
          totalSets: 10,
          workDuration: constCfg.workDuration,
          workColor: constCfg.workColor,
          restDuration: constCfg.restDuration,
          restColor: constCfg.restColor,
          customWorkLabel: `Round ${cIdx + 1} Constant · Set ${chIdx * 2 + 1}/10`
        });
        // Changing interval pair
        pushWorkRestPair({
          ex: changeEx,
          roundNumber: cIdx + 1,
          setNumber: chIdx * 2 + 2,
          totalSets: 10,
          workDuration: changeCfg.workDuration,
          workColor: changeCfg.workColor,
          restDuration: changeCfg.restDuration,
          restColor: changeCfg.restColor,
          customWorkLabel: `Round ${cIdx + 1} Change · Set ${chIdx * 2 + 2}/10`
        });
      });
    }
  } else if (wkId === '8x8-duos') {
    // 4 rounds, 2 exercises per round, 8-minute (480s) AMRAP per round (+ 60s rest between rounds when timing full workout)
    targetRounds.forEach(({ round }, rIdx) => {
      const ex1 = getActiveSlotExercise(round.slots[0]);
      const ex2 = getActiveSlotExercise(round.slots[1]);
      const comboName = [ex1?.name, ex2?.name].filter(Boolean).join(' ↔ ');
      const cfg = resolveExConfig(workout, ex1?.id, exerciseConfigs);
      pairCounter.count += 1;
      steps.push({
        id: `step-${steps.length + 1}`,
        type: 'work',
        phaseLabel: `Round ${round.roundNumber} · 8-Min AMRAP (8 reps each)`,
        exerciseId: ex1?.id || null,
        exerciseName: comboName || '8x8 Duo AMRAP',
        roundNumber: round.roundNumber,
        setNumber: 1,
        totalSets: 1,
        pairIndex: pairCounter.count,
        duration: cfg.workDuration,
        color: cfg.workColor
      });
      if (targetRounds.length > 1 && rIdx < targetRounds.length - 1 && cfg.restDuration > 0) {
        steps.push({
          id: `step-${steps.length + 1}`,
          type: 'rest',
          phaseLabel: `Round ${round.roundNumber} Recovery Rest`,
          exerciseId: ex2?.id || ex1?.id || null,
          exerciseName: 'Rest',
          roundNumber: round.roundNumber,
          setNumber: 1,
          totalSets: 1,
          pairIndex: pairCounter.count,
          duration: cfg.restDuration,
          color: cfg.restColor
        });
      }
    });
  } else {
    // Generic fallback for any other workout type (e.g. 10-to-1-to-10, Strength Quads, etc.)
    for (const { round } of targetRounds) {
      const rawSets = Number(workout.setsPerRound) || 3;
      const sets = rawSets <= 5 ? rawSets : 3;
      for (let s = 0; s < sets; s++) {
        for (let sl = 0; sl < round.slots.length; sl++) {
          const ex = getActiveSlotExercise(round.slots[sl]);
          if (!ex) continue;
          const cfg = resolveExConfig(workout, ex.id, exerciseConfigs);
          pushWorkRestPair({
            ex,
            roundNumber: round.roundNumber,
            setNumber: s + 1,
            totalSets: sets,
            workDuration: cfg.workDuration,
            workColor: cfg.workColor,
            restDuration: cfg.restDuration,
            restColor: cfg.restColor
          });
        }
      }
    }
  }

  return finalizeWithCountdown(steps, countdownDuration);
}

/**
 * Build a timer sequence from a selected Custom Timer preset, mapped onto the active workout's exercises.
 */
export function buildCustomPresetTimerSequence(
  presetId,
  workoutState,
  { roundIndex = 0, includeAllRounds = false, countdownDuration = 10, exerciseConfigs = {} } = {}
) {
  const preset =
    CUSTOM_TIMER_PRESETS.find(p => p.id === presetId) || CUSTOM_TIMER_PRESETS[0];

  const allRounds = workoutState?.rounds || [];
  const safeRoundIdx = Math.min(
    Math.max(0, allRounds.length - 1),
    Math.max(0, Number(roundIndex) || 0)
  );
  const targetRounds =
    includeAllRounds && allRounds.length > 1
      ? allRounds
      : [allRounds[safeRoundIdx]].filter(Boolean);

  const steps = [];
  const totalPairsPerRound = preset.pairs || 6;

  targetRounds.forEach(round => {
    const exList = (round?.slots || [])
      .map(s => getActiveSlotExercise(s))
      .filter(Boolean);

    for (let p = 0; p < totalPairsPerRound; p++) {
      const ex = exList.length > 0 ? exList[p % exList.length] : null;
      const customEx = (ex && exerciseConfigs[ex.id]) || {};
      const wDur = Number(customEx.workDuration ?? preset.workDuration) || preset.workDuration;
      const wCol = customEx.workColor || preset.workColor || 'green';
      const rDur = Number(customEx.restDuration ?? preset.restDuration) || preset.restDuration;
      const rCol = customEx.restColor || preset.restColor || 'blue';

      steps.push({
        id: `step-${steps.length + 1}`,
        type: 'work',
        phaseLabel: `${preset.name} · Round ${round?.roundNumber || 1} · Pair ${p + 1}/${totalPairsPerRound}`,
        exerciseId: ex?.id || null,
        exerciseName: ex?.name || `Work Interval ${p + 1}`,
        roundNumber: round?.roundNumber || 1,
        setNumber: p + 1,
        totalSets: totalPairsPerRound,
        pairIndex: p + 1,
        duration: wDur,
        color: wCol
      });

      if (rDur > 0) {
        steps.push({
          id: `step-${steps.length + 1}`,
          type: 'rest',
          phaseLabel: `Rest · Round ${round?.roundNumber || 1} · Pair ${p + 1}/${totalPairsPerRound}`,
          exerciseId: ex?.id || null,
          exerciseName: 'Rest',
          roundNumber: round?.roundNumber || 1,
          setNumber: p + 1,
          totalSets: totalPairsPerRound,
          pairIndex: p + 1,
          duration: rDur,
          color: rCol
        });
      }
    }
  });

  return finalizeWithCountdown(steps, countdownDuration);
}

/**
 * Ensure the timer sequence always starts with a 10-second yellow countdown and has "Up Next" metadata.
 */
export function finalizeWithCountdown(rawSteps, countdownDuration = 10, customCountdownLabel = null) {
  const workAndRest = rawSteps.filter(s => s.type !== 'countdown');
  const firstStep = workAndRest[0];

  const countdownStep = {
    id: 'step-countdown-0',
    type: 'countdown',
    phaseLabel: '10s Prep Countdown',
    exerciseId: firstStep?.exerciseId || null,
    exerciseName: customCountdownLabel || 'Count Down',
    customLabel: customCountdownLabel || null,
    roundNumber: firstStep?.roundNumber || 1,
    setNumber: 0,
    totalSets: firstStep?.totalSets || 0,
    pairIndex: 0,
    duration: Math.max(1, Number(countdownDuration) || 10),
    color: 'yellow'
  };

  const allSteps = [countdownStep, ...workAndRest];
  for (let i = 0; i < allSteps.length; i++) {
    const nextWork = allSteps.slice(i + 1).find(s => s.type === 'work') || allSteps[i + 1] || null;
    allSteps[i].index = i;
    allSteps[i].nextExerciseName = nextWork ? nextWork.exerciseName : 'Workout Complete!';
  }
  return allSteps;
}

/**
 * Summarize a timer sequence for UI badges (e.g., "10s Yellow + 6 pairs (40s Green / 20s Blue)").
 */
export function getTimerSequenceSummary(steps) {
  if (!steps || steps.length === 0) return '';
  const workSteps = steps.filter(s => s.type === 'work');
  const restSteps = steps.filter(s => s.type === 'rest');
  const firstWork = workSteps[0];
  const firstRest = restSteps[0];
  if (!firstWork) return `${steps.length} intervals`;

  const wCol = TIMER_COLORS[firstWork.color]?.label || 'Green';
  const rCol = firstRest ? (TIMER_COLORS[firstRest.color]?.label || 'Blue') : '';
  if (firstRest) {
    return `10s Yellow · ${workSteps.length} pairs (${firstWork.duration}s ${wCol} / ${firstRest.duration}s ${rCol})`;
  }
  return `10s Yellow · ${workSteps.length} intervals (${firstWork.duration}s ${wCol})`;
}

/**
 * Distinct sound profiles for:
 * 1) Starting an exercise block ('work-start'): bright rising double-chime ding
 * 2) Starting a rest block ('rest-start'): warm descending two-tone recovery bell
 * 3) Steady light noise during a short transition block ('transition-pulse'): gentle steady marimba pulse
 * 4) Finishing the entire timer ('workout-complete'): 3-note completion fanfare
 */
export const TIMER_SOUND_PROFILES = {
  'work-start': {
    id: 'work-start',
    label: 'Exercise Block Start Ding',
    durationSec: 0.44,
    notes: [
      { startSec: 0.0, durationSec: 0.16, freq: 880.0, overtoneFreq: 1760.0, gain: 0.42 },
      { startSec: 0.14, durationSec: 0.30, freq: 1318.5, overtoneFreq: 2637.0, gain: 0.48 }
    ]
  },
  'rest-start': {
    id: 'rest-start',
    label: 'Rest Block Start Chime',
    durationSec: 0.50,
    notes: [
      { startSec: 0.0, durationSec: 0.20, freq: 783.99, overtoneFreq: 1174.66, gain: 0.38 },
      { startSec: 0.18, durationSec: 0.32, freq: 523.25, overtoneFreq: 1046.5, gain: 0.42 }
    ]
  },
  'transition-pulse': {
    id: 'transition-pulse',
    label: 'Steady Light Transition Pulse',
    durationSec: 0.12,
    notes: [
      { startSec: 0.0, durationSec: 0.12, freq: 587.33, overtoneFreq: 880.0, gain: 0.16 }
    ]
  },
  'workout-complete': {
    id: 'workout-complete',
    label: 'Workout Complete Fanfare',
    durationSec: 0.65,
    notes: [
      { startSec: 0.0, durationSec: 0.16, freq: 523.25, overtoneFreq: 1046.5, gain: 0.38 },
      { startSec: 0.16, durationSec: 0.16, freq: 659.25, overtoneFreq: 1318.5, gain: 0.40 },
      { startSec: 0.32, durationSec: 0.33, freq: 1046.5, overtoneFreq: 2093.0, gain: 0.46 }
    ]
  }
};

/**
 * Determine which sound cue plays at the start of a timer step:
 * 1) 'work-start' when starting an exercise block (step.type === 'work')
 * 2) 'rest-start' when starting a rest block (step.type === 'rest')
 * 3) 'transition-pulse' when starting a short transition or countdown block
 */
export function getStepStartSoundType(step) {
  if (!step) return 'transition-pulse';
  if (step.type === 'work') return 'work-start';
  if (step.type === 'rest') return 'rest-start';
  return 'transition-pulse';
}

/**
 * Return true if the step is a short transition / countdown block to another exercise
 * that should emit a steady light pulse every second.
 */
export function shouldPlaySteadyTransitionPulse(step) {
  if (!step) return false;
  return step.type === 'transition' || step.type === 'countdown';
}

/**
 * Build the complete schedule of upcoming audio cues ({ offsetSec, cueType, stepIndex })
 * from the current step and remainingMs through the end of the timer sequence.
 */
export function buildRemainingTimelineCues(steps, currentStepIndex = 0, remainingMs = null) {
  if (!Array.isArray(steps) || steps.length === 0 || currentStepIndex >= steps.length) {
    return [];
  }

  const cues = [];
  const firstStep = steps[currentStepIndex];
  const fullFirstStepMs = Math.max(1, Number(firstStep?.duration) || 1) * 1000;
  const startRemainingMs =
    typeof remainingMs === 'number' && remainingMs > 0 ? remainingMs : fullFirstStepMs;

  // If starting right at the beginning of the current step, emit its start cue at offset 0
  if (Math.abs(startRemainingMs - fullFirstStepMs) < 50) {
    cues.push({
      offsetSec: 0,
      cueType: getStepStartSoundType(firstStep),
      stepIndex: currentStepIndex
    });
  }

  // If the current step is a transition/countdown block, emit steady 1-second pulses for remaining whole seconds
  if (shouldPlaySteadyTransitionPulse(firstStep)) {
    const maxWholeSec = Math.floor((startRemainingMs - 50) / 1000);
    for (let s = maxWholeSec; s >= 1; s--) {
      const offsetSec = (startRemainingMs - s * 1000) / 1000;
      if (offsetSec >= 0.05) {
        cues.push({
          offsetSec: Number(offsetSec.toFixed(3)),
          cueType: 'transition-pulse',
          stepIndex: currentStepIndex
        });
      }
    }
  }

  let cursorSec = startRemainingMs / 1000;

  for (let idx = currentStepIndex + 1; idx < steps.length; idx++) {
    const step = steps[idx];
    const dur = Math.max(1, Number(step?.duration) || 1);

    // Start of block sound ('work-start', 'rest-start', or 'transition-pulse')
    cues.push({
      offsetSec: Number(cursorSec.toFixed(3)),
      cueType: getStepStartSoundType(step),
      stepIndex: idx
    });

    // Steady light noise every second during a short transition / countdown block
    if (shouldPlaySteadyTransitionPulse(step)) {
      for (let secElapsed = 1; secElapsed < dur; secElapsed++) {
        cues.push({
          offsetSec: Number((cursorSec + secElapsed).toFixed(3)),
          cueType: 'transition-pulse',
          stepIndex: idx
        });
      }
    }

    cursorSec += dur;
  }

  cues.push({
    offsetSec: Number(cursorSec.toFixed(3)),
    cueType: 'workout-complete',
    stepIndex: steps.length - 1
  });

  return cues;
}

const wavUriCache = new Map();

function encodeUint8ToBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Synthesize a 16-bit mono PCM WAV data URI for a timer sound cue ('work-start', 'rest-start',
 * 'transition-pulse', 'workout-complete', or 'keepalive').
 * Playing PCM WAV via an HTML5 <audio> element uses the OS Media Playback channel, which
 * plays even when the phone's hardware Silent switch is on and stays active during sleep.
 */
export function synthesizeCueWavDataUri(cueType = 'work-start') {
  if (wavUriCache.has(cueType)) {
    return wavUriCache.get(cueType);
  }

  const sampleRate = 22050;
  const profile = TIMER_SOUND_PROFILES[cueType];
  const durationSec = profile ? profile.durationSec : 1.0;
  const numSamples = Math.max(1, Math.floor(sampleRate * durationSec));
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // Standard 44-byte RIFF WAVE header (16-bit mono PCM)
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let sample = 0;

    if (profile) {
      for (const note of profile.notes) {
        if (t >= note.startSec && t <= note.startSec + note.durationSec) {
          const localT = t - note.startSec;
          const progress = localT / note.durationSec;
          // Crisp bell attack (4ms) + exponential decay
          const attack = Math.min(1, localT / 0.004);
          const decay = Math.exp(-3.8 * progress);
          const env = attack * decay * note.gain;
          const fundamental = Math.sin(2 * Math.PI * note.freq * localT);
          const overtone = note.overtoneFreq
            ? 0.28 * Math.sin(2 * Math.PI * note.overtoneFreq * localT)
            : 0;
          sample += env * (fundamental + overtone);
        }
      }
    } else {
      // Sub-audible keepalive carrier so mobile OS never suspends the media playback session during sleep
      sample = 0.0004 * Math.sin(2 * Math.PI * 60 * t);
    }

    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }

  const uri = `data:audio/wav;base64,${encodeUint8ToBase64(new Uint8Array(buffer))}`;
  wavUriCache.set(cueType, uri);
  return uri;
}
