import { DataService } from './services/dataService.js?v=19';
import {
  FOCUS_SNAP_STEPS,
  DEFAULT_FOCUS_WEIGHTS,
  DEFAULT_FOCUS_ENABLED,
  normalizeFocusWeights,
  deriveBodyCategoryFromFocus,
  resetFocusState,
  isDefaultFocusState,
  toggleFocusAreaState,
  computeFocusSliderPositions,
  updateFocusFromHandleDrag,
  pickAutoFillExercises,
  generateWorkout,
  generateWorkoutFromSelectedExercises,
  getTargetExerciseCount,
  filterEligibleExercises,
  filterExercisesByMuscleAndQuery,
  getActiveSlotExercise,
  swapExerciseInSlot,
  reorderRounds,
  reorderExerciseInRound,
  swapExercisesAcrossRounds,
  getValidReplacementCandidates,
  getWorkoutCheckMode,
  getConsolidatedWorkoutSubtitle,
  getRandomEntry,
  getPrimaryMuscle,
  getPrimaryBodyArea
} from './engine/workoutEngine.js?v=19';
import {
  analyzeMuscleLoad,
  applyBalancedRecommendation,
  SPECIFIC_MUSCLES
} from './engine/muscleLoadAnalyzer.js?v=19';
import {
  TIMER_COLORS,
  CUSTOM_TIMER_PRESETS,
  TIMER_SOUND_PROFILES,
  isTimedHiitWorkout,
  formatTimerClock,
  getTimerBottomLabel,
  getDefaultExerciseTimerConfig,
  buildStockTimerSequence,
  buildCustomPresetTimerSequence,
  finalizeWithCountdown,
  getStepStartSoundType,
  shouldPlaySteadyTransitionPulse
} from './engine/timerEngine.js?v=19';

const dataService = new DataService();

const MUSCLE_FILTER_PILLS = [
  { value: 'All', label: 'All' },
  { value: 'Upper Body', label: 'Upper Body' },
  { value: 'Core', label: 'Core' },
  { value: 'Legs', label: 'Legs' },
  { value: 'Legs and Core', label: 'Legs & Core' },
  { value: 'Upper Body and Core', label: 'Upper & Core' },
  { value: 'Chest', label: 'Chest' },
  { value: 'Back', label: 'Back' },
  { value: 'Shoulders', label: 'Shoulders' },
  { value: 'Biceps', label: 'Biceps' },
  { value: 'Triceps', label: 'Triceps' },
  { value: 'Abs', label: 'Abs' },
  { value: 'Glutes', label: 'Glutes' },
  { value: 'Quads', label: 'Quads' },
  { value: 'Hamstrings', label: 'Hamstrings' }
];

// UI State for active modals
let currentSwapContext = null; // { roundIndex, slotIndex }
let currentSwapShowAll = false;
let currentSwapMuscleFilter = 'All';

let currentExclusionMuscleFilter = 'All';

let currentSelectShowAll = false;
let currentSelectMuscleFilter = 'All';
let selectedCustomExerciseIds = [];
let targetCustomExerciseCount = 9;
let targetCustomWorkout = null;

let currentBalanceWarningId = null;
let currentAnalysis = null;

// Timer State
const timerState = {
  workoutTypeKey: null,
  mode: 'stock', // 'stock' | 'custom-preset'
  presetId: CUSTOM_TIMER_PRESETS[0].id,
  roundIndex: 0,
  slotIndex: null,
  includeAllRounds: false,
  countdownDuration: 10,
  exerciseConfigs: {}, // { [exerciseId]: { workDuration, workColor, restDuration, restColor, extraIntervals: [] } }
  customStepsOverride: null, // array of steps if manually edited in step editor
  steps: [],
  currentStepIndex: 0,
  remainingSeconds: 10,
  remainingMs: 10000,
  isRunning: false,
  intervalId: null,
  customizerOpen: false,
  soundLog: [],
  wakeLockActive: false,
  audioSessionType: null,
  getAudioContextState: () => (sharedAudioCtx ? sharedAudioCtx.state : 'uncreated')
};

let focusState = {
  weights: { ...DEFAULT_FOCUS_WEIGHTS },
  enabled: { ...DEFAULT_FOCUS_ENABLED }
};

if (typeof window !== 'undefined') {
  window.__workoutTimerState = timerState;
}

// DOM Elements
const els = {
  settingsBtn: document.getElementById('settingsBtn'),
  excludedCountBadge: document.getElementById('excludedCountBadge'),

  workoutCategorySelect: document.getElementById('workoutCategorySelect'),
  equipmentSelect: document.getElementById('equipmentSelect'),
  workoutTypeSelect: document.getElementById('workoutTypeSelect'),

  focusSliderSection: document.getElementById('focusSliderSection'),
  resetFocusBtn: document.getElementById('resetFocusBtn'),
  focusLabelUpper: document.getElementById('focusLabelUpper'),
  focusLabelCore: document.getElementById('focusLabelCore'),
  focusLabelLower: document.getElementById('focusLabelLower'),
  focusPctUpper: document.getElementById('focusPctUpper'),
  focusPctCore: document.getElementById('focusPctCore'),
  focusPctLower: document.getElementById('focusPctLower'),
  focusBarTrack: document.getElementById('focusBarTrack'),
  focusSegUpper: document.getElementById('focusSegUpper'),
  focusSegCore: document.getElementById('focusSegCore'),
  focusSegLower: document.getElementById('focusSegLower'),
  focusHandlesLayer: document.getElementById('focusHandlesLayer'),

  generateWorkoutBtn: document.getElementById('generateWorkoutBtn'),
  selectExercisesBtn: document.getElementById('selectExercisesBtn'),

  workoutNameText: document.getElementById('workoutNameText'),
  workoutTitleBtn: document.getElementById('workoutTitleBtn'),
  workoutMetaSummary: document.getElementById('workoutMetaSummary'),
  workoutTimerBar: document.getElementById('workoutTimerBar'),
  openWorkoutTimerBtn: document.getElementById('openWorkoutTimerBtn'),
  workoutTimerBtnLabel: document.getElementById('workoutTimerBtnLabel'),
  openCustomTimerBtn: document.getElementById('openCustomTimerBtn'),
  roundsContainer: document.getElementById('roundsContainer'),

  modalBackdrop: document.getElementById('modalBackdrop'),
  exerciseModal: document.getElementById('exerciseModal'),
  workoutTypeModal: document.getElementById('workoutTypeModal'),
  swapModal: document.getElementById('swapModal'),
  balanceModal: document.getElementById('balanceModal'),
  settingsModal: document.getElementById('settingsModal'),
  selectExercisesModal: document.getElementById('selectExercisesModal'),
  timerModal: document.getElementById('timerModal'),
  toast: document.getElementById('toast')
};

async function bootstrap() {
  // Pre-configure OS Ambient audio mixing policy at startup so WebKit flushes AVAudioSessionCategoryAmbient
  // long before any timer AudioContext is created or resumed (prevents synchronous click race condition).
  configureAmbientAudioSession();

  await dataService.init('./data/sheet-data.json?v=19', './data/enrichments.json?v=19');
  populateWorkoutTypeSelect();
  populateCustomTimerPresetsSelect();
  syncUIFromActiveProfile();
  bindEvents();

  // Register offline Service Worker if supported and auto-reload when an existing SW updates
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    const hadController = !!navigator.serviceWorker.controller;
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || refreshing || timerState.isRunning) return;
      refreshing = true;
      window.location.reload();
    });
    navigator.serviceWorker.register('./sw.js?v=19', { updateViaCache: 'none' }).then(reg => {
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          reg.update().catch(() => {});
        }
      });
    }).catch(() => {});
  }
}

function populateWorkoutTypeSelect() {
  const select = els.workoutTypeSelect;
  select.innerHTML = `<option value="Random">Random</option>`;
  for (const wk of dataService.sheetData.workouts) {
    const opt = document.createElement('option');
    opt.value = wk.name;
    opt.textContent = wk.name;
    select.appendChild(opt);
  }
}

function populateCustomTimerPresetsSelect() {
  const select = document.getElementById('customTimerPresetSelect');
  if (!select) return;
  select.innerHTML = CUSTOM_TIMER_PRESETS.map(
    p => `<option value="${p.id}">${p.name} — ${p.description}</option>`
  ).join('');
}

function formatAreaUiName(area) {
  return area === 'Legs' ? 'Lower Body' : area;
}

function formatFocusPercentLabel(val) {
  return `${Math.round((val || 0) * 100)}%`;
}

function renderFocusSliderUI(activeDragHandleIndex = null) {
  if (!els.focusSliderSection) return;
  const { handles, weights, enabled } = computeFocusSliderPositions(
    focusState.weights,
    focusState.enabled
  );
  focusState = { weights: { ...weights }, enabled: { ...enabled } };

  const labelSpecs = [
    { area: 'Upper Body', btn: els.focusLabelUpper, pct: els.focusPctUpper, seg: els.focusSegUpper },
    { area: 'Core', btn: els.focusLabelCore, pct: els.focusPctCore, seg: els.focusSegCore },
    { area: 'Legs', btn: els.focusLabelLower, pct: els.focusPctLower, seg: els.focusSegLower }
  ];

  labelSpecs.forEach(({ area, btn, pct, seg }) => {
    const isEnabled = !!enabled[area];
    const wPct = isEnabled ? Math.max(0, Math.min(100, (weights[area] || 0) * 100)) : 0;
    if (btn) {
      btn.classList.toggle('is-deselected', !isEnabled);
      btn.setAttribute('aria-pressed', String(isEnabled));
    }
    if (pct) {
      pct.textContent = formatFocusPercentLabel(weights[area]);
    }
    if (seg) {
      seg.hidden = !isEnabled;
      seg.style.width = `${wPct.toFixed(4)}%`;
    }
  });

  if (els.focusHandlesLayer) {
    const existingThumbs = Array.from(
      els.focusHandlesLayer.querySelectorAll('.focus-slider-thumb')
    );
    if (existingThumbs.length !== handles.length) {
      els.focusHandlesLayer.innerHTML = handles
        .map(h => {
          const pctNow = Math.round(h.position * 100);
          const leftLabel = formatAreaUiName(h.leftArea);
          const rightLabel = formatAreaUiName(h.rightArea);
          return `<button
            type="button"
            class="focus-slider-thumb ${activeDragHandleIndex === h.index ? 'is-active' : ''}"
            role="slider"
            data-handle-index="${h.index}"
            aria-label="Adjust focus split between ${leftLabel} and ${rightLabel}"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow="${pctNow}"
            style="left: ${(h.position * 100).toFixed(4)}%;"
          ></button>`;
        })
        .join('');
    } else {
      handles.forEach((h, idx) => {
        const thumb = existingThumbs[idx];
        const pctNow = Math.round(h.position * 100);
        const leftLabel = formatAreaUiName(h.leftArea);
        const rightLabel = formatAreaUiName(h.rightArea);
        thumb.dataset.handleIndex = String(h.index);
        thumb.style.left = `${(h.position * 100).toFixed(4)}%`;
        thumb.setAttribute('aria-valuenow', String(pctNow));
        thumb.setAttribute(
          'aria-label',
          `Adjust focus split between ${leftLabel} and ${rightLabel}`
        );
        thumb.classList.toggle('is-active', activeDragHandleIndex === h.index);
      });
    }
  }
  if (els.resetFocusBtn) {
    const atDefault = isDefaultFocusState(weights, enabled);
    els.resetFocusBtn.classList.toggle('is-default', atDefault);
  }
}

function updateExcludedCountBadge() {
  const profile = dataService.getActiveProfile();
  const excludedCount = (profile.excludedExerciseIds || []).length;
  if (excludedCount > 0) {
    els.excludedCountBadge.textContent = `${excludedCount} Excluded`;
    els.excludedCountBadge.hidden = false;
  } else {
    els.excludedCountBadge.hidden = true;
  }
}

function syncUIFromActiveProfile() {
  const profile = dataService.getActiveProfile();
  updateExcludedCountBadge();

  // Inputs
  const inputs = profile.inputs || {};
  els.workoutCategorySelect.value = inputs.workoutCategory || 'HIIT';
  els.equipmentSelect.value = inputs.equipment === 'All' ? 'Any' : (inputs.equipment || 'Any');
  els.workoutTypeSelect.value = inputs.workoutType || 'Timed Trios (40/20)';

  const normFocus = normalizeFocusWeights(inputs);
  focusState = {
    weights: { ...normFocus.weights },
    enabled: { ...normFocus.enabled }
  };
  renderFocusSliderUI();

  // Ensure an active workout exists
  if (!profile.activeWorkout) {
    handleGenerateWorkout(false);
  } else {
    rehydrateActiveWorkout(profile.activeWorkout);
    const wkId = profile.activeWorkout.workout?.id || 'timed-trios-40-20';
    if (timerState.workoutTypeKey !== wkId) {
      resetTimerForWorkoutType(wkId);
    } else {
      rebuildTimerSteps(false);
    }
    renderActiveWorkout();
  }
}

function rehydrateActiveWorkout(workoutState) {
  if (!workoutState || !workoutState.rounds) return;
  const exMap = new Map(dataService.sheetData.exercises.map(e => [e.id, e]));
  const wkMap = new Map(dataService.sheetData.workouts.map(w => [w.id, w]));
  if (workoutState.workout?.id && wkMap.has(workoutState.workout.id)) {
    workoutState.workout = wkMap.get(workoutState.workout.id);
  }
  if (workoutState.inputs && !workoutState.inputs.focusWeights) {
    const norm = normalizeFocusWeights(workoutState.inputs);
    workoutState.inputs.focusWeights = { ...norm.weights };
    workoutState.inputs.focusEnabled = { ...norm.enabled };
  }
  if (!Array.isArray(workoutState.dismissedWarnings)) {
    workoutState.dismissedWarnings = [];
  }
  const checkMode = getWorkoutCheckMode(workoutState.workout);
  workoutState.rounds.forEach(r => {
    if (typeof r.completed !== 'boolean') r.completed = false;
    r.slots.forEach(s => {
      s.options = s.options.map(o => exMap.get(o.id) || o);
      s.optionChosen = !!s.optionChosen;
      s.selectedOptionIndex = s.selectedOptionIndex || 0;
      if (checkMode.mode === 'exercise-sets') {
        if (!Array.isArray(s.completedSets) || s.completedSets.length !== checkMode.count) {
          s.completedSets = Array.from({ length: checkMode.count }, () => !!s.completed);
        }
      } else {
        s.completedSets = [];
      }
    });
  });
}

function getSelectedInputs() {
  const profile = dataService.getActiveProfile();
  const bodyCategory = deriveBodyCategoryFromFocus(focusState.weights, focusState.enabled);
  return {
    workoutCategory: els.workoutCategorySelect.value,
    bodyCategory,
    focusWeights: { ...focusState.weights },
    focusEnabled: { ...focusState.enabled },
    equipment: els.equipmentSelect.value,
    workoutType: els.workoutTypeSelect.value,
    excludedExerciseIds: profile.excludedExerciseIds || [],
    optionsPerSlot: profile.optionsPerSlot || 1
  };
}

function updateSelectExercisesButtonLabel() {
  if (!els.selectExercisesBtn) return;
  const profile = dataService.getActiveProfile();
  const target = getTargetExerciseCount(
    dataService.sheetData,
    getSelectedInputs(),
    profile.activeWorkout?.workout
  );
  targetCustomWorkout = target.workout;
  targetCustomExerciseCount = target.count;
  els.selectExercisesBtn.textContent = `Select ${target.count} Exercises`;
}

function handleGenerateWorkout(showFeedback = true) {
  const prevWorkoutId = dataService.getActiveProfile().activeWorkout?.workout?.id || null;
  const inputs = getSelectedInputs();
  const workoutState = generateWorkout(dataService.sheetData, inputs);

  // Sync Workout Category select if manual Workout Type updated effective category
  if (inputs.workoutType !== 'Random' && workoutState.inputs.effectiveWorkoutCategory) {
    els.workoutCategorySelect.value = workoutState.inputs.effectiveWorkoutCategory;
    inputs.workoutCategory = workoutState.inputs.effectiveWorkoutCategory;
  }

  dataService.updateActiveProfile({
    inputs: {
      workoutCategory: inputs.workoutCategory,
      bodyCategory: inputs.bodyCategory,
      focusWeights: { ...inputs.focusWeights },
      focusEnabled: { ...inputs.focusEnabled },
      equipment: inputs.equipment,
      workoutType: inputs.workoutType
    },
    activeWorkout: workoutState
  });

  const newWorkoutId = workoutState.workout?.id || null;
  if (newWorkoutId !== prevWorkoutId || timerState.workoutTypeKey !== newWorkoutId) {
    resetTimerForWorkoutType(newWorkoutId);
  } else {
    timerState.customStepsOverride = null;
    rebuildTimerSteps(true);
  }

  renderActiveWorkout();
  if (showFeedback) {
    showToast('Workout generated');
  }
}

function formatCompactEquipment(equip) {
  if (!equip || equip === 'Any' || equip === 'All') return '';
  if (equip === 'Nothing') return 'Bodyweight';
  if (equip === 'Band or Weights') return 'Bands/Weights';
  return equip;
}

function renderActiveWorkout() {
  const profile = dataService.getActiveProfile();
  const wkState = profile.activeWorkout;
  if (!wkState) return;

  updateSelectExercisesButtonLabel();

  // Run Muscle Load Analyzer (combines multi-muscle overloads per round into 1 line & respects dismissedWarnings)
  currentAnalysis = analyzeMuscleLoad(
    wkState,
    dataService.sheetData,
    profile.excludedExerciseIds || []
  );

  // 1. Consolidated Workout Header (Hyperlink + Single Consolidated Subtitle)
  const cleanWorkoutTypeName =
    wkState.workout?.name || wkState.workoutName.replace(/^WORKOUT:\s*/i, '');
  els.workoutNameText.textContent = cleanWorkoutTypeName;
  els.workoutMetaSummary.textContent = getConsolidatedWorkoutSubtitle(wkState);

  // Update Workout Timer Bar
  updateWorkoutTimerBarUI(wkState);

  const checkMode = getWorkoutCheckMode(wkState.workout);
  const showTimedHiitControls = isTimedHiitWorkout(wkState.workout);

  // 2. Render Compact Rounds & Exercise Slots
  els.roundsContainer.innerHTML = '';

  wkState.rounds.forEach((round, roundIndex) => {
    const roundCard = document.createElement('div');
    roundCard.className = `round-card ${round.completed ? 'round-completed' : ''}`;
    roundCard.dataset.roundIndex = String(roundIndex);
    if (wkState.rounds.length > 1) {
      roundCard.draggable = true;
    }

    const roundWarnings = currentAnalysis.warnings.filter(w => w.roundIndex === roundIndex);

    // Combined 1-line warning banner per round (with Swap, More, and Dismiss)
    let warningsHtml = '';
    if (roundWarnings.length > 0) {
      warningsHtml = roundWarnings
        .map(
          w => `
        <div class="overload-banner" data-warning-id="${w.id}">
          <span class="overload-banner-text">
            <strong>${w.muscle} overload</strong> (${w.contributingExercises.join(', ')})
          </span>
          <span class="overload-banner-actions">
            <button class="balance-now-btn" data-action="auto-balance" data-warning-id="${w.id}" type="button">
              Swap: ${w.recommendations[0].exercise.name}
            </button>
            <button class="balance-options-btn" data-action="open-balance-modal" data-warning-id="${w.id}" type="button">
              More (${w.recommendations.length})
            </button>
            <button class="dismiss-warning-btn" data-action="dismiss-warning" data-warning-id="${w.id}" type="button" title="Dismiss overload warning" aria-label="Dismiss overload warning">
              Dismiss
            </button>
          </span>
        </div>`
        )
        .join('');
    }

    const slotsHtml = round.slots
      .map((slot, slotIndex) => {
        const activeEx = getActiveSlotExercise(slot);
        if (!activeEx) return '';

        const priMuscles = SPECIFIC_MUSCLES.filter(m => activeEx.muscles?.[m] === 'Pri');
        const equipLabel = formatCompactEquipment(activeEx.equipment);
        const inlineMetaParts = [...priMuscles];
        if (equipLabel) inlineMetaParts.push(equipLabel);
        const inlineMeta = inlineMetaParts.join(' · ');

        // Multi-option tabs if slot has 2 or 3 options and user hasn't chosen one yet
        let multiTabsHtml = '';
        if (slot.options.length > 1 && !slot.optionChosen) {
          multiTabsHtml = `
            <div class="multi-option-tabs" role="tablist" aria-label="Exercise slot options">
              ${slot.options
                .map(
                  (optEx, optIdx) => `
                <button
                  type="button"
                  class="multi-opt-pill ${optIdx === (slot.selectedOptionIndex || 0) ? 'active' : ''}"
                  data-action="select-slot-option"
                  data-round-index="${roundIndex}"
                  data-slot-index="${slotIndex}"
                  data-option-index="${optIdx}"
                >
                  ${optIdx + 1}. ${optEx.name}
                </button>`
                )
                .join('')}
            </div>
          `;
        }

        // Format-aware per-set checkboxes next to exercise (only when checkMode.mode === 'exercise-sets')
        let checkboxesHtml = '';
        let isSlotAllDone = !!slot.completed;
        if (checkMode.mode === 'exercise-sets') {
          const setsArr = Array.isArray(slot.completedSets) && slot.completedSets.length === checkMode.count
            ? slot.completedSets
            : Array.from({ length: checkMode.count }, () => false);
          isSlotAllDone = setsArr.length > 0 && setsArr.every(Boolean);

          checkboxesHtml = `
            <div class="set-checkboxes" role="group" aria-label="Sets for ${activeEx.name}">
              ${setsArr
                .map(
                  (done, setIdx) => `
                <button
                  type="button"
                  class="set-check-box ${done ? 'checked' : ''}"
                  data-action="toggle-set"
                  data-round-index="${roundIndex}"
                  data-slot-index="${slotIndex}"
                  data-set-index="${setIdx}"
                  title="Set ${setIdx + 1}"
                  aria-label="Mark ${activeEx.name} set ${setIdx + 1} complete"
                >${done ? '✓' : ''}</button>`
                )
                .join('')}
            </div>
          `;
        }

        return `
          <div class="exercise-slot ${isSlotAllDone ? 'completed' : ''}" draggable="true" data-round-index="${roundIndex}" data-slot-index="${slotIndex}">
            ${multiTabsHtml}
            <div class="slot-main-row">
              <div class="slot-left">
                <span
                  class="drag-handle slot-drag-handle"
                  data-drag-handle="slot"
                  data-round-index="${roundIndex}"
                  data-slot-index="${slotIndex}"
                  title="Drag to reorder or swap exercise"
                  aria-label="Drag ${activeEx.name}"
                >⠿</span>
                ${checkboxesHtml}
                <button
                  type="button"
                  class="exercise-name-btn"
                  data-action="open-exercise-modal"
                  data-exercise-id="${activeEx.id}"
                  data-round-index="${roundIndex}"
                  data-slot-index="${slotIndex}"
                >
                  <span class="exercise-title-text">${activeEx.name}</span>
                  <span class="exercise-inline-meta">${inlineMeta}</span>
                </button>
              </div>

              <div class="slot-actions">
                <button
                  type="button"
                  class="swap-trigger-btn"
                  data-action="open-swap-modal"
                  data-round-index="${roundIndex}"
                  data-slot-index="${slotIndex}"
                  title="Swap exercise"
                  aria-label="Swap ${activeEx.name}"
                >⇄</button>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    // Round header checkbox only when checkMode.mode === 'round' (e.g. 8x8 Duos)
    const roundCheckHtml =
      checkMode.mode === 'round'
        ? `<button
            type="button"
            class="round-check-box ${round.completed ? 'checked' : ''}"
            data-action="toggle-round-complete"
            data-round-index="${roundIndex}"
            aria-label="Mark Round ${round.roundNumber} complete"
          >${round.completed ? '✓' : ''}</button>`
        : '';

    const roundDragHandleHtml =
      wkState.rounds.length > 1
        ? `<span
            class="drag-handle round-drag-handle"
            data-drag-handle="round"
            data-round-index="${roundIndex}"
            title="Drag to reorder Round ${round.roundNumber}"
            aria-label="Drag Round ${round.roundNumber}"
          >⠿</span>`
        : '';

    const roundTimerBtnHtml = showTimedHiitControls
      ? `<button
          type="button"
          class="round-timer-btn"
          data-action="open-round-timer"
          data-round-index="${roundIndex}"
          aria-label="Open Round ${round.roundNumber} timer"
        >⏱ Timer</button>`
      : '';

    const showRoundHeader =
      wkState.rounds.length > 1 || checkMode.mode === 'round' || showTimedHiitControls;

    roundCard.innerHTML = `
      ${
        showRoundHeader
          ? `<div class="round-header">
              <div class="round-header-left">
                ${roundDragHandleHtml}
                ${roundCheckHtml}
                <span class="round-title">Round ${round.roundNumber}</span>
              </div>
              <div class="round-header-right">
                ${roundTimerBtnHtml}
              </div>
            </div>`
          : ''
      }
      ${warningsHtml}
      <div class="slots-list">
        ${slotsHtml}
      </div>
    `;

    els.roundsContainer.appendChild(roundCard);
  });
}

// ============================================================================
// Muscle Filter Pill Bar Helper
// ============================================================================
function renderMuscleFilterPills(containerEl, activeValue, onSelect) {
  if (!containerEl) return;
  containerEl.innerHTML = MUSCLE_FILTER_PILLS.map(
    pill => `
      <button
        type="button"
        class="muscle-filter-pill ${pill.value === activeValue ? 'active' : ''}"
        data-muscle-filter="${pill.value}"
      >${pill.label}</button>`
  ).join('');

  containerEl.onclick = e => {
    const btn = e.target.closest('[data-muscle-filter]');
    if (!btn) return;
    const val = btn.getAttribute('data-muscle-filter');
    onSelect(val);
  };
}

// ============================================================================
// HIIT & Custom Timer Controller
// ============================================================================
function stopTimerLoop() {
  if (timerState.intervalId) {
    clearInterval(timerState.intervalId);
    timerState.intervalId = null;
  }
  timerState.isRunning = false;
  stopTimerSessionKeepAlive();
}

function resetTimerForWorkoutType(workoutTypeKey) {
  stopTimerLoop();
  timerState.workoutTypeKey = workoutTypeKey;
  timerState.mode = 'stock';
  timerState.presetId = CUSTOM_TIMER_PRESETS[0].id;
  timerState.roundIndex = 0;
  timerState.slotIndex = null;
  timerState.includeAllRounds = false;
  timerState.countdownDuration = 10;
  timerState.exerciseConfigs = {};
  timerState.customStepsOverride = null;
  timerState.customizerOpen = false;
  rebuildTimerSteps(true);
}

function rebuildTimerSteps(resetCursor = true) {
  const wkState = dataService.getActiveProfile().activeWorkout;
  if (!wkState) return;

  if (timerState.customStepsOverride && timerState.customStepsOverride.length > 0) {
    const cdOverride = timerState.customStepsOverride.find(s => s.type === 'countdown');
    timerState.steps = finalizeWithCountdown(
      timerState.customStepsOverride.filter(s => s.type !== 'countdown'),
      timerState.countdownDuration,
      cdOverride?.customLabel || null
    );
  } else if (timerState.mode === 'custom-preset') {
    timerState.steps = buildCustomPresetTimerSequence(timerState.presetId, wkState, {
      roundIndex: timerState.roundIndex,
      includeAllRounds: timerState.includeAllRounds,
      countdownDuration: timerState.countdownDuration,
      exerciseConfigs: timerState.exerciseConfigs
    });
  } else {
    timerState.steps = buildStockTimerSequence(wkState, {
      roundIndex: timerState.roundIndex,
      slotIndex: timerState.slotIndex,
      includeAllRounds: timerState.includeAllRounds,
      exerciseConfigs: timerState.exerciseConfigs,
      countdownDuration: timerState.countdownDuration
    });
  }

  if (resetCursor || timerState.currentStepIndex >= timerState.steps.length) {
    timerState.currentStepIndex = 0;
    const initDur = timerState.steps[0]?.duration || timerState.countdownDuration || 10;
    timerState.remainingSeconds = initDur;
    timerState.remainingMs = initDur * 1000;
  }
}

function updateWorkoutTimerBarUI(wkState) {
  if (!els.workoutTimerBar || !wkState) return;
  const wk = wkState.workout;
  const isHiit = isTimedHiitWorkout(wk);

  // Do not show any timer bar for untimed Strength workouts
  if (!isHiit) {
    els.workoutTimerBar.hidden = true;
    return;
  }

  els.workoutTimerBar.hidden = false;

  // Always rebuild steps if empty or out of sync with active exercises
  if (!timerState.steps || timerState.steps.length === 0) {
    rebuildTimerSteps(true);
  } else if (!timerState.isRunning && !timerState.customStepsOverride) {
    rebuildTimerSteps(false);
  }

  // Top workout timer button always reflects the full workout sequence
  const fullWorkoutSteps = timerState.customStepsOverride
    ? timerState.steps
    : timerState.mode === 'custom-preset'
    ? buildCustomPresetTimerSequence(timerState.presetId, wkState, {
        roundIndex: 0,
        includeAllRounds: true,
        countdownDuration: timerState.countdownDuration,
        exerciseConfigs: timerState.exerciseConfigs
      })
    : buildStockTimerSequence(wkState, {
        roundIndex: 0,
        slotIndex: null,
        includeAllRounds: true,
        exerciseConfigs: timerState.exerciseConfigs,
        countdownDuration: timerState.countdownDuration
      });

  const workSteps = fullWorkoutSteps.filter(s => s.type === 'work');
  const firstWork = workSteps[0];
  const firstTransition = fullWorkoutSteps.find(s => s.type === 'transition');
  const firstRest = fullWorkoutSteps.find(s => s.type === 'rest');
  const cdSec = fullWorkoutSteps[0]?.duration || 10;

  els.openWorkoutTimerBtn.hidden = false;
  if (firstWork && firstTransition && firstRest) {
    els.workoutTimerBtnLabel.textContent = `Timer (${cdSec}s Yellow · ${workSteps.length}× ${firstWork.duration}s / ${firstTransition.duration}s trans / ${firstRest.duration}s rest)`;
  } else if (firstWork && firstRest) {
    els.workoutTimerBtnLabel.textContent = `Timer (${cdSec}s Yellow · ${workSteps.length}× ${firstWork.duration}s/${firstRest.duration}s)`;
  } else if (firstWork) {
    els.workoutTimerBtnLabel.textContent = `Timer (${cdSec}s Yellow · ${workSteps.length}× ${firstWork.duration}s)`;
  } else {
    els.workoutTimerBtnLabel.textContent = 'Start HIIT Timer';
  }
}

function openTimerModal({
  roundIndex = 0,
  slotIndex = null,
  includeAllRounds = false,
  openCustomizer = false
} = {}) {
  const wkState = dataService.getActiveProfile().activeWorkout;
  if (!wkState) return;

  const wkId = wkState.workout?.id || 'timed-duos-40-20';
  if (timerState.workoutTypeKey !== wkId) {
    resetTimerForWorkoutType(wkId);
  }

  const scopeChanged =
    timerState.roundIndex !== roundIndex ||
    timerState.slotIndex !== slotIndex ||
    timerState.includeAllRounds !== includeAllRounds;

  timerState.roundIndex = roundIndex;
  timerState.slotIndex = slotIndex;
  timerState.includeAllRounds = includeAllRounds;

  if (scopeChanged || timerState.steps.length === 0 || !timerState.isRunning) {
    stopTimerLoop();
    rebuildTimerSteps(true);
  }

  timerState.customizerOpen = !!openCustomizer;
  configureAmbientAudioSession();
  renderTimerModal();
  els.timerModal.hidden = false;
}

function closeTimerModal() {
  stopTimerLoop();
  els.timerModal.hidden = true;
}

function renderTimerModal() {
  const wkState = dataService.getActiveProfile().activeWorkout;
  if (!wkState) return;

  const wk = wkState.workout || {};
  const scopeTag = timerState.includeAllRounds
    ? 'FULL WORKOUT TIMER'
    : `ROUND ${timerState.roundIndex + 1} TIMER`;
  document.getElementById('timerModalEyebrow').textContent =
    timerState.mode === 'custom-preset' ? `CUSTOM TIMER · ${scopeTag}` : `TUNED HIIT · ${scopeTag}`;
  document.getElementById('timerModalTitle').textContent = wk.name || 'Workout Timer';

  const toggleBtn = document.getElementById('toggleTimerCustomizerBtn');
  toggleBtn.textContent = timerState.customizerOpen ? '← Back to Timer' : 'Customize';

  document.getElementById('timerExecutionView').hidden = timerState.customizerOpen;
  document.getElementById('timerCustomizerView').hidden = !timerState.customizerOpen;

  renderTimerScopePills(wkState);

  if (timerState.customizerOpen) {
    renderTimerCustomizerView(wkState);
  } else {
    renderTimerExecutionView();
  }
}

function renderTimerScopePills(wkState) {
  const container = document.getElementById('timerScopePills');
  if (!container) return;

  const wkId = wkState.workout?.id || '';
  const pills = [];

  if (wkId === '5-constant-5-change-40-20') {
    for (let r = 0; r < 3; r++) {
      const isAct = !timerState.includeAllRounds && timerState.roundIndex === r && timerState.slotIndex === null;
      pills.push(
        `<button type="button" class="timer-scope-pill ${isAct ? 'active' : ''}" data-timer-round="${r}">Round ${r + 1} (10 Pairs)</button>`
      );
    }
    const allAct = timerState.includeAllRounds;
    pills.push(
      `<button type="button" class="timer-scope-pill ${allAct ? 'active' : ''}" data-timer-all-rounds="true">All Rounds</button>`
    );
  } else if (wkId === '8-excercises-40-20') {
    for (let r = 0; r < 3; r++) {
      const isAct = !timerState.includeAllRounds && timerState.roundIndex === r && timerState.slotIndex === null;
      pills.push(
        `<button type="button" class="timer-scope-pill ${isAct ? 'active' : ''}" data-timer-round="${r}">Round ${r + 1} (8 Pairs)</button>`
      );
    }
    const allAct = timerState.includeAllRounds;
    pills.push(
      `<button type="button" class="timer-scope-pill ${allAct ? 'active' : ''}" data-timer-all-rounds="true">All Rounds</button>`
    );
  } else if (wkState.rounds.length > 1) {
    wkState.rounds.forEach((r, idx) => {
      const isAct = !timerState.includeAllRounds && timerState.roundIndex === idx && timerState.slotIndex === null;
      pills.push(
        `<button type="button" class="timer-scope-pill ${isAct ? 'active' : ''}" data-timer-round="${idx}">Round ${r.roundNumber}</button>`
      );
    });
    const allAct = timerState.includeAllRounds;
    pills.push(
      `<button type="button" class="timer-scope-pill ${allAct ? 'active' : ''}" data-timer-all-rounds="true">All Rounds</button>`
    );
  } else if (wkId === '30-20-10-10-20-30') {
    const allAct = timerState.slotIndex === null;
    pills.push(
      `<button type="button" class="timer-scope-pill ${allAct ? 'active' : ''}" data-timer-round="0">All 8 Exercises</button>`
    );
    wkState.rounds[0].slots.forEach((s, sIdx) => {
      const ex = getActiveSlotExercise(s);
      const isAct = timerState.slotIndex === sIdx;
      pills.push(
        `<button type="button" class="timer-scope-pill ${isAct ? 'active' : ''}" data-timer-slot="${sIdx}">Ex ${sIdx + 1}: ${ex?.name || ''}</button>`
      );
    });
  }

  container.innerHTML = pills.join('');
}

function renderTimerExecutionView() {
  const steps = timerState.steps;
  if (!steps || steps.length === 0) return;

  const idx = Math.min(steps.length - 1, Math.max(0, timerState.currentStepIndex));
  const step = steps[idx];
  const colorKey = TIMER_COLORS[step.color] ? step.color : 'green';

  const stageCard = document.getElementById('timerStageCard');
  stageCard.className = `timer-stage-card timer-color-${colorKey}`;

  document.getElementById('timerPhaseBadge').textContent = step.phaseLabel || step.type.toUpperCase();
  document.getElementById('timerStepCounter').textContent = `Step ${idx + 1} of ${steps.length}`;
  document.getElementById('timerActiveExerciseName').textContent = getTimerBottomLabel(step);
  document.getElementById('timerClockDisplay').textContent = formatTimerClock(timerState.remainingSeconds);

  const totalDur = Math.max(1, step.duration || 1);
  const totalMs = totalDur * 1000;
  const effectiveMs =
    typeof timerState.remainingMs === 'number' &&
    Math.ceil(timerState.remainingMs / 1000) === timerState.remainingSeconds
      ? timerState.remainingMs
      : timerState.remainingSeconds * 1000;
  const pct = Math.max(0, Math.min(100, (effectiveMs / totalMs) * 100));

  const stageFill = document.getElementById('timerStageFill');
  if (stageFill) {
    stageFill.style.height = `${pct}%`;
  }

  const nextStep = steps[idx + 1];
  const nextLabel = nextStep ? getTimerBottomLabel(nextStep) : '';
  document.getElementById('timerUpNextText').textContent = nextStep
    ? `Up Next: ${nextLabel} (${nextStep.duration}s ${TIMER_COLORS[nextStep.color]?.label || nextStep.color})`
    : 'Final Interval — Finish Strong!';

  const playBtn = document.getElementById('timerStartPauseBtn');
  playBtn.textContent = timerState.isRunning ? '⏸ Pause' : '▶ Start';

  // Sequence timeline chips
  const timeline = document.getElementById('timerSequenceTimeline');
  timeline.innerHTML = steps
    .map((s, sIdx) => {
      const col = TIMER_COLORS[s.color] ? s.color : 'green';
      const shortName =
        s.type === 'countdown'
          ? 'Count Down'
          : s.type === 'transition'
          ? 'Transition'
          : s.type === 'rest'
          ? 'Rest'
          : (s.exerciseName || 'Work').slice(0, 14);
      return `
        <button
          type="button"
          class="timer-seq-chip chip-${col} ${sIdx === idx ? 'active' : ''}"
          data-action="jump-timer-step"
          data-step-index="${sIdx}"
        >
          <span>${s.duration}s ${TIMER_COLORS[col].label}</span>
          <small>${shortName}</small>
        </button>`;
    })
    .join('');
}

function renderTimerCustomizerView(wkState) {
  const stockBtn = document.getElementById('timerModeStockBtn');
  const customBtn = document.getElementById('timerModeCustomBtn');
  const presetBox = document.getElementById('customPresetSelectorBox');

  stockBtn.classList.toggle('active', timerState.mode === 'stock');
  customBtn.classList.toggle('active', timerState.mode === 'custom-preset');
  presetBox.hidden = timerState.mode !== 'custom-preset';

  const presetSelect = document.getElementById('customTimerPresetSelect');
  if (presetSelect) {
    presetSelect.value = timerState.presetId;
  }

  const cdInput = document.getElementById('timerCountdownInput');
  if (cdInput) {
    cdInput.value = timerState.countdownDuration;
  }

  // Per-Exercise Durations & Colors List
  const uniqueExercises = [];
  const seenIds = new Set();
  wkState.rounds.forEach(r => {
    r.slots.forEach(s => {
      const ex = getActiveSlotExercise(s);
      if (ex && !seenIds.has(ex.id)) {
        seenIds.add(ex.id);
        uniqueExercises.push(ex);
      }
    });
  });

  const colorOptionsHtml = selectedColor =>
    Object.values(TIMER_COLORS)
      .map(
        c =>
          `<option value="${c.id}" ${c.id === selectedColor ? 'selected' : ''}>${c.label}</option>`
      )
      .join('');

  const defaults = getDefaultExerciseTimerConfig(wkState.workout);
  const perExContainer = document.getElementById('perExerciseTimerList');
  perExContainer.innerHTML = uniqueExercises
    .map(ex => {
      const cfg = timerState.exerciseConfigs[ex.id] || {};
      const wDur = cfg.workDuration ?? defaults.workDuration;
      const wCol = cfg.workColor ?? defaults.workColor;
      const rDur = cfg.restDuration ?? defaults.restDuration;
      const rCol = cfg.restColor ?? defaults.restColor;
      const extrasCount = (cfg.extraIntervals || []).length;

      return `
        <div class="per-exercise-timer-row" data-exercise-id="${ex.id}">
          <div class="per-exercise-row-header">
            <span>${ex.name} ${extrasCount > 0 ? `<small>(+${extrasCount} extra)</small>` : ''}</span>
            <button type="button" class="text-link-btn" data-action="add-exercise-extra-time" data-exercise-id="${ex.id}">
              + Add Time
            </button>
          </div>
          <div class="per-exercise-row-controls">
            <label>Work (s):
              <input type="number" min="1" max="3600" value="${wDur}" class="timer-num-input" data-ex-timer-field="workDuration" data-exercise-id="${ex.id}" />
            </label>
            <select class="timer-color-select" data-ex-timer-field="workColor" data-exercise-id="${ex.id}" aria-label="Work color for ${ex.name}">
              ${colorOptionsHtml(wCol)}
            </select>
            <label>Rest (s):
              <input type="number" min="0" max="3600" value="${rDur}" class="timer-num-input" data-ex-timer-field="restDuration" data-exercise-id="${ex.id}" />
            </label>
            <select class="timer-color-select" data-ex-timer-field="restColor" data-exercise-id="${ex.id}" aria-label="Rest color for ${ex.name}">
              ${colorOptionsHtml(rCol)}
            </select>
          </div>
        </div>
      `;
    })
    .join('');

  // Interval Sequence Steps Editor
  const stepsContainer = document.getElementById('customIntervalStepsList');
  stepsContainer.innerHTML = timerState.steps
    .map(
      (step, idx) => `
      <div class="interval-step-edit-row" data-step-index="${idx}">
        <span style="font-weight:700;min-width:22px;">#${idx + 1}</span>
        <input
          type="text"
          class="interval-step-edit-label"
          value="${(step.exerciseName || '').replace(/"/g, '&quot;')}"
          data-step-field="exerciseName"
          data-step-index="${idx}"
          aria-label="Step ${idx + 1} label"
        />
        <input
          type="number"
          min="1"
          max="3600"
          class="timer-num-input"
          value="${step.duration}"
          data-step-field="duration"
          data-step-index="${idx}"
          aria-label="Step ${idx + 1} duration"
        />
        <select
          class="timer-color-select"
          data-step-field="color"
          data-step-index="${idx}"
          aria-label="Step ${idx + 1} color"
        >
          ${colorOptionsHtml(step.color)}
        </select>
        ${
          idx > 0
            ? `<button type="button" class="dismiss-warning-btn" data-action="delete-timer-step" data-step-index="${idx}" aria-label="Delete step ${idx + 1}">✕</button>`
            : ''
        }
      </div>`
    )
    .join('');
}

// ============================================================================
// Timer Audio Engine (Ambient Audio Mixing & Burst-Only Web Audio Cues)
// ============================================================================
let sharedAudioCtx = null;
let activeWakeLockSentinel = null;
let audioIdleSuspendTimer = null;

function configureAmbientAudioSession() {
  // Pre-configure OS Ambient audio session ahead of time so WebKit flushes AVAudioSessionCategoryAmbient
  // before any AudioContext renders. Ambient overlays cleanly on top of music, books on tape, and podcasts
  // (Libby, Hoopla, Spotify, Apple Music, Podcasts) without ever pausing or ducking them.
  try {
    if (typeof navigator !== 'undefined' && navigator.audioSession) {
      if (navigator.audioSession.type !== 'ambient') {
        navigator.audioSession.type = 'ambient';
      }
      timerState.audioSessionType = navigator.audioSession.type || 'ambient';
    } else {
      timerState.audioSessionType = 'ambient-web-audio';
    }
  } catch {
    timerState.audioSessionType = 'ambient-web-audio';
  }
}

function clearAudioIdleSuspendTimer() {
  if (audioIdleSuspendTimer) {
    clearTimeout(audioIdleSuspendTimer);
    audioIdleSuspendTimer = null;
  }
}

function suspendAudioContextNow() {
  clearAudioIdleSuspendTimer();
  try {
    if (sharedAudioCtx && sharedAudioCtx.state === 'running') {
      sharedAudioCtx.suspend().catch(() => {});
    }
  } catch {}
}

function scheduleIdleAudioSuspend(delayMs) {
  clearAudioIdleSuspendTimer();
  audioIdleSuspendTimer = setTimeout(() => {
    audioIdleSuspendTimer = null;
    try {
      if (sharedAudioCtx && sharedAudioCtx.state === 'running') {
        sharedAudioCtx.suspend().catch(() => {});
      }
    } catch {}
  }, delayMs);
}

function unlockAmbientAudioContextFromGesture() {
  configureAmbientAudioSession();
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
      sharedAudioCtx = new AudioCtx();
    }
    if (sharedAudioCtx.state === 'suspended') {
      // Unlock user-gesture requirement on iOS Safari; we immediately suspend again once idle
      sharedAudioCtx.resume().catch(() => {});
    }
    return sharedAudioCtx;
  } catch {
    return null;
  }
}

async function requestScreenWakeLock() {
  try {
    if (typeof navigator !== 'undefined' && navigator.wakeLock?.request) {
      if (activeWakeLockSentinel) {
        await activeWakeLockSentinel.release().catch(() => {});
      }
      activeWakeLockSentinel = await navigator.wakeLock.request('screen');
      timerState.wakeLockActive = true;
      activeWakeLockSentinel.addEventListener('release', () => {
        timerState.wakeLockActive = false;
      });
    }
  } catch {
    timerState.wakeLockActive = false;
  }
}

function releaseScreenWakeLock() {
  if (activeWakeLockSentinel) {
    activeWakeLockSentinel.release().catch(() => {});
    activeWakeLockSentinel = null;
  }
  timerState.wakeLockActive = false;
}

function scheduleSoundProfileOnContext(ctx, profile, startAtContextTime) {
  if (!ctx || !profile) return;
  for (const note of profile.notes) {
    const t0 = startAtContextTime + note.startSec;
    const tEnd = t0 + note.durationSec;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(note.freq, t0);

    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(note.gain, t0 + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0005, tEnd);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(tEnd + 0.01);

    if (note.overtoneFreq) {
      const overOsc = ctx.createOscillator();
      const overGain = ctx.createGain();
      overOsc.type = 'triangle';
      overOsc.frequency.setValueAtTime(note.overtoneFreq, t0);
      overGain.gain.setValueAtTime(0.0001, t0);
      overGain.gain.linearRampToValueAtTime(note.gain * 0.28, t0 + 0.005);
      overGain.gain.exponentialRampToValueAtTime(0.0005, tEnd);
      overOsc.connect(overGain);
      overGain.connect(ctx.destination);
      overOsc.start(t0);
      overOsc.stop(tEnd + 0.01);
    }
  }
}

function startTimerSessionKeepAlive() {
  unlockAmbientAudioContextFromGesture();
  requestScreenWakeLock();
}

function stopTimerSessionKeepAlive() {
  suspendAudioContextNow();
  releaseScreenWakeLock();
}

/**
 * Play one of the distinct timer sound cues as a short ambient burst:
 * - 'work-start': bright rising double bell ding when starting an exercise block
 * - 'rest-start': warm descending two-tone chime when starting a rest block
 * - 'transition-pulse': steady light sound during a short transition / 10s countdown block
 * - 'workout-complete': 3-note completion fanfare
 * Automatically suspends the AudioContext right after the beep finishes so no audio stream
 * stays open when the timer is silent.
 */
function playTimerSoundCue(cueType, stepIndex = timerState.currentStepIndex) {
  const profile = TIMER_SOUND_PROFILES[cueType] || TIMER_SOUND_PROFILES['transition-pulse'];
  const step = timerState.steps?.[stepIndex] || null;

  timerState.soundLog.push({
    cueType: profile.id,
    stepIndex,
    stepType: step?.type || null,
    remainingSeconds: timerState.remainingSeconds,
    timestamp: Date.now()
  });
  if (timerState.soundLog.length > 300) {
    timerState.soundLog.shift();
  }

  configureAmbientAudioSession();
  clearAudioIdleSuspendTimer();

  let maxNoteEndSec = 0.08;
  for (const note of profile.notes) {
    const endSec = note.startSec + note.durationSec;
    if (endSec > maxNoteEndSec) maxNoteEndSec = endSec;
  }

  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
      sharedAudioCtx = new AudioCtx();
    }

    const emitNotesAndScheduleSuspend = () => {
      if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') return;
      scheduleSoundProfileOnContext(sharedAudioCtx, profile, sharedAudioCtx.currentTime + 0.008);
      // Keep context open across consecutive 1s transition ticks, but suspend immediately (~150ms)
      // after work-start, rest-start, or workout-complete chimes so silent intervals have zero active stream.
      const idlePadSec =
        profile.id === 'transition-pulse' && timerState.isRunning && timerState.remainingSeconds > 1
          ? 1.15
          : 0.15;
      scheduleIdleAudioSuspend(Math.ceil((maxNoteEndSec + idlePadSec) * 1000));
    };

    if (sharedAudioCtx.state === 'running') {
      emitNotesAndScheduleSuspend();
    } else {
      sharedAudioCtx
        .resume()
        .then(emitNotesAndScheduleSuspend)
        .catch(() => {});
    }
  } catch {}
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      configureAmbientAudioSession();
      if (timerState.isRunning) {
        requestScreenWakeLock();
      }
    }
  });
}

function toggleTimerPlayPause() {
  if (timerState.isRunning) {
    stopTimerLoop();
    renderTimerExecutionView();
    return;
  }

  timerState.isRunning = true;
  if (
    typeof timerState.remainingMs !== 'number' ||
    timerState.remainingMs <= 0 ||
    Math.ceil(timerState.remainingMs / 1000) !== timerState.remainingSeconds
  ) {
    const startDur =
      timerState.remainingSeconds > 0
        ? timerState.remainingSeconds
        : timerState.steps[timerState.currentStepIndex]?.duration || 10;
    timerState.remainingSeconds = startDur;
    timerState.remainingMs = startDur * 1000;
  }

  startTimerSessionKeepAlive();

  // Play the initial cue if starting at the beginning of a step; otherwise suspend immediately after gesture unlock
  const initialStep = timerState.steps[timerState.currentStepIndex];
  if (
    initialStep &&
    Math.abs(timerState.remainingMs - (initialStep.duration || 10) * 1000) < 80
  ) {
    playTimerSoundCue(getStepStartSoundType(initialStep), timerState.currentStepIndex);
  } else {
    scheduleIdleAudioSuspend(120);
  }

  let lastTickTime = Date.now();
  renderTimerExecutionView();

  timerState.intervalId = setInterval(() => {
    const now = Date.now();
    let deltaMs = Math.max(0, now - lastTickTime);
    lastTickTime = now;

    let stepChangedOrSecondTicked = false;

    // Advance across one or more steps using wall-clock elapsed time (handles sleep/wake catch-up accurately)
    while (deltaMs > 0 && timerState.isRunning) {
      const currentStep = timerState.steps[timerState.currentStepIndex];
      if (!currentStep) {
        stopTimerLoop();
        break;
      }

      if (deltaMs < timerState.remainingMs) {
        const prevSec = timerState.remainingSeconds;
        timerState.remainingMs = Math.max(0, timerState.remainingMs - deltaMs);
        deltaMs = 0;
        const nextSec = Math.ceil(timerState.remainingMs / 1000);
        if (nextSec !== prevSec) {
          timerState.remainingSeconds = nextSec;
          stepChangedOrSecondTicked = true;
          // Steady light sound every second during a short transition / countdown block
          if (shouldPlaySteadyTransitionPulse(currentStep) && nextSec >= 1) {
            playTimerSoundCue('transition-pulse', timerState.currentStepIndex);
          }
        }
      } else {
        // Consume remaining time of current step and advance to next interval step
        deltaMs -= timerState.remainingMs;
        if (timerState.currentStepIndex < timerState.steps.length - 1) {
          timerState.currentStepIndex += 1;
          const nextStep = timerState.steps[timerState.currentStepIndex];
          const nextDur = nextStep.duration;
          timerState.remainingSeconds = nextDur;
          timerState.remainingMs = nextDur * 1000;
          stepChangedOrSecondTicked = true;
          // Distinct noise when starting:
          // 1) an exercise block ('work-start'),
          // 2) a rest block ('rest-start'), or
          // 3) a short transition block ('transition-pulse')
          playTimerSoundCue(getStepStartSoundType(nextStep), timerState.currentStepIndex);
        } else {
          // Timer finished -> full grey (0% fill)
          timerState.remainingSeconds = 0;
          timerState.remainingMs = 0;
          deltaMs = 0;
          stepChangedOrSecondTicked = true;
          stopTimerLoop();
          playTimerSoundCue('workout-complete', timerState.currentStepIndex);
          showToast('Timer complete!');
        }
      }
    }

    if (stepChangedOrSecondTicked) {
      renderTimerExecutionView();
    } else if (timerState.isRunning) {
      const currentStep = timerState.steps[timerState.currentStepIndex];
      const totalMs = Math.max(1000, (currentStep?.duration || 1) * 1000);
      const pct = Math.max(0, Math.min(100, (timerState.remainingMs / totalMs) * 100));
      const stageFill = document.getElementById('timerStageFill');
      if (stageFill) {
        stageFill.style.height = `${pct}%`;
      }
    }
  }, 50);
}

// ============================================================================
// Modal Controllers
// ============================================================================
function openModal(modalEl) {
  els.modalBackdrop.hidden = false;
  modalEl.hidden = false;
}

function closeAllModals() {
  els.modalBackdrop.hidden = true;
  els.exerciseModal.hidden = true;
  els.workoutTypeModal.hidden = true;
  els.swapModal.hidden = true;
  els.balanceModal.hidden = true;
  els.settingsModal.hidden = true;
  if (els.selectExercisesModal) els.selectExercisesModal.hidden = true;
}

function openExerciseModal(exerciseId, roundIndex = null, slotIndex = null) {
  const ex = dataService.sheetData.exercises.find(e => e.id === exerciseId);
  if (!ex) return;

  currentSwapContext =
    roundIndex !== null && slotIndex !== null ? { roundIndex, slotIndex } : null;

  const enrich = ex.enrichment || {};
  document.getElementById('exerciseModalCategory').textContent =
    `${Object.entries(ex.bodyCategories)
      .filter(([, v]) => v === 'Pri')
      .map(([k]) => formatAreaUiName(k))
      .join(' · ')} · ${ex.workoutCategory}`;
  document.getElementById('exerciseModalTitle').textContent = ex.name;

  const diagramImg = document.getElementById('exerciseModalDiagram');
  diagramImg.src = enrich.diagram || `./diagrams/${ex.id}.svg`;
  diagramImg.alt = `${ex.name} multi-frame movement diagram`;

  const priMuscles = SPECIFIC_MUSCLES.filter(m => ex.muscles?.[m] === 'Pri');
  const secMuscles = SPECIFIC_MUSCLES.filter(m => ex.muscles?.[m] === 'Sec');

  document.getElementById('exerciseModalBadges').innerHTML = [
    ...priMuscles.map(m => `<span class="mini-tag pri-muscle">Primary: ${m}</span>`),
    ...secMuscles.map(m => `<span class="mini-tag sec-muscle">Secondary: ${m}</span>`),
    `<span class="mini-tag">Equipment: ${ex.equipment}</span>`
  ].join('');

  document.getElementById('exerciseModalSummary').textContent = enrich.summary || '';

  const stepsEl = document.getElementById('exerciseModalSteps');
  stepsEl.innerHTML = (enrich.steps || []).map(s => `<li>${s}</li>`).join('');

  document.getElementById('exerciseModalTip').textContent = enrich.formTip || '';

  document.getElementById('exerciseModalFooterActions').hidden = !currentSwapContext;
  openModal(els.exerciseModal);
}

function openWorkoutTypeModal(workoutNameOrId) {
  const wkState = dataService.getActiveProfile().activeWorkout;
  let wk = dataService.sheetData.workouts.find(
    w => w.name === workoutNameOrId || w.id === workoutNameOrId
  );
  if (!wk && wkState?.workout) {
    wk = wkState.workout;
  }
  if (!wk) {
    wk = dataService.sheetData.workouts[0];
  }

  const enrich = wk.enrichment || {};
  document.getElementById('workoutTypeModalCategory').textContent =
    `${wk.workoutCategory.toUpperCase()} FORMAT`;
  document.getElementById('workoutTypeModalTitle').textContent = wk.name;

  document.getElementById('workoutTypeModalPills').textContent =
    getConsolidatedWorkoutSubtitle({ workout: wk });

  document.getElementById('workoutTypeModalSummary').textContent = enrich.summary || '';

  document.getElementById('workoutTypeModalSteps').innerHTML = (enrich.howItWorks || [])
    .map(step => `<li>${step}</li>`)
    .join('');

  document.getElementById('workoutTypeModalTimer').textContent = enrich.timerStructure || '';
  document.getElementById('workoutTypeModalPacing').textContent = enrich.pacingTip || '';

  openModal(els.workoutTypeModal);
}

function openSwapModal(roundIndex, slotIndex) {
  currentSwapContext = { roundIndex, slotIndex };
  currentSwapShowAll = false;
  currentSwapMuscleFilter = 'All';

  const wkState = dataService.getActiveProfile().activeWorkout;
  const slot = wkState?.rounds?.[roundIndex]?.slots?.[slotIndex];
  const currentEx = getActiveSlotExercise(slot);

  document.getElementById('swapModalSlotLabel').textContent =
    `ROUND ${roundIndex + 1} · EXERCISE ${slotIndex + 1}`;
  document.getElementById('swapModalTitle').textContent =
    currentEx ? currentEx.name : 'Swap Exercise';

  const slotOptionsContainer = document.getElementById('swapSlotOptionsContainer');
  if (slot && slot.options && slot.options.length > 1) {
    slotOptionsContainer.hidden = false;
    slotOptionsContainer.innerHTML = `
      <div class="swap-slot-options-header">
        <span class="swap-slot-options-title">Slot Alternatives (${slot.options.length})</span>
        <button type="button" class="text-link-btn" id="restoreSlotPillsBtn">Show on Card</button>
      </div>
      <div class="swap-slot-options-pills">
        ${slot.options
          .map(
            (optEx, idx) => `
          <button
            type="button"
            class="swap-slot-pill ${idx === (slot.selectedOptionIndex || 0) ? 'active' : ''}"
            data-action="pick-original-option"
            data-option-index="${idx}"
          >
            ${idx + 1}. ${optEx.name}
          </button>`
          )
          .join('')}
      </div>
    `;
  } else if (slotOptionsContainer) {
    slotOptionsContainer.hidden = true;
    slotOptionsContainer.innerHTML = '';
  }

  document.getElementById('swapSearchInput').value = '';
  document.getElementById('swapFilterMatchingBtn').classList.add('active');
  document.getElementById('swapFilterAllBtn').classList.remove('active');

  renderSwapMuscleFilterBar();
  renderSwapExerciseList();
  openModal(els.swapModal);
}

function renderSwapMuscleFilterBar() {
  renderMuscleFilterPills(
    document.getElementById('swapMuscleFilterBar'),
    currentSwapMuscleFilter,
    val => {
      currentSwapMuscleFilter = val;
      renderSwapMuscleFilterBar();
      renderSwapExerciseList();
    }
  );
}

function renderSwapExerciseList() {
  if (!currentSwapContext) return;
  const profile = dataService.getActiveProfile();
  const wkState = profile.activeWorkout;
  const query = (document.getElementById('swapSearchInput').value || '').trim();

  const validBalancedCandidates = getValidReplacementCandidates({
    workoutState: wkState,
    roundIndex: currentSwapContext.roundIndex,
    slotIndex: currentSwapContext.slotIndex,
    sheetData: dataService.sheetData,
    excludedExerciseIds: profile.excludedExerciseIds || [],
    analyzeMuscleLoadFn: analyzeMuscleLoad
  });
  const balancedIds = new Set(validBalancedCandidates.map(e => e.id));

  let pool = [];
  if (currentSwapShowAll) {
    pool = [...dataService.sheetData.exercises];
  } else {
    // If user explicitly clicked a muscle group filter pill in the Swap modal,
    // use that muscle filter rather than locking to the active workout's Focus weights
    const hasExplicitChip = currentSwapMuscleFilter !== 'All';
    const activeFocus = normalizeFocusWeights(wkState.inputs || {});
    pool = filterEligibleExercises(dataService.sheetData.exercises, {
      workoutCategory: wkState.inputs.effectiveWorkoutCategory,
      bodyCategory: hasExplicitChip
        ? currentSwapMuscleFilter
        : deriveBodyCategoryFromFocus(activeFocus.weights, activeFocus.enabled),
      muscleGroup: hasExplicitChip ? currentSwapMuscleFilter : null,
      focusWeights: hasExplicitChip ? null : activeFocus.weights,
      focusEnabled: hasExplicitChip ? null : activeFocus.enabled,
      equipment: wkState.inputs.equipment || els.equipmentSelect.value,
      excludedExerciseIds: profile.excludedExerciseIds || []
    });
  }

  pool = filterExercisesByMuscleAndQuery(pool, {
    muscleFilter: currentSwapMuscleFilter,
    query
  });

  pool.sort((a, b) => {
    const aBal = balancedIds.has(a.id) ? 1 : 0;
    const bBal = balancedIds.has(b.id) ? 1 : 0;
    return bBal - aBal;
  });

  const listEl = document.getElementById('swapExerciseList');
  if (pool.length === 0) {
    listEl.innerHTML = `<p class="settings-help">No matching exercises found. Tap "All Exercises" to browse all ${dataService.sheetData.exercises.length} movements.</p>`;
    return;
  }

  listEl.innerHTML = pool
    .map(ex => {
      const pri = SPECIFIC_MUSCLES.filter(m => ex.muscles?.[m] === 'Pri').join(', ');
      const isBalanced = balancedIds.has(ex.id);
      return `
      <button type="button" class="swap-option-item" data-action="confirm-swap" data-exercise-id="${ex.id}">
        <div>
          <div class="swap-option-title">${ex.name}</div>
          <div class="swap-option-meta">${pri} · ${ex.equipment}</div>
        </div>
        <span class="swap-badge ${isBalanced ? 'balanced' : ''}">${isBalanced ? 'Balanced' : 'Select'}</span>
      </button>`;
    })
    .join('');
}

function openBalanceModal(warningId) {
  if (!currentAnalysis) return;
  const warning = currentAnalysis.warnings.find(w => w.id === warningId);
  if (!warning) return;

  currentBalanceWarningId = warningId;

  document.getElementById('balanceModalTitle').textContent =
    `Balance Round ${warning.roundNumber} (${warning.muscle})`;
  document.getElementById('balanceModalDescription').textContent =
    `${warning.message} Select an alternative to replace "${warning.targetExercise.name}":`;

  const listEl = document.getElementById('balanceRecommendationsList');
  listEl.innerHTML = warning.recommendations
    .map(
      rec => `
      <button
        type="button"
        class="swap-option-item"
        data-action="apply-balance-choice"
        data-warning-id="${warning.id}"
        data-exercise-id="${rec.exercise.id}"
      >
        <div>
          <div class="swap-option-title">${rec.exercise.name}</div>
          <div class="swap-option-meta">${rec.reason} · ${rec.exercise.equipment}</div>
        </div>
        <span class="swap-badge balanced">Swap</span>
      </button>`
    )
    .join('');

  openModal(els.balanceModal);
}

function dismissWarning(warningId) {
  const profile = dataService.getActiveProfile();
  const wkState = profile.activeWorkout;
  if (!wkState || !warningId) return;

  if (!Array.isArray(wkState.dismissedWarnings)) {
    wkState.dismissedWarnings = [];
  }
  if (!wkState.dismissedWarnings.includes(warningId)) {
    wkState.dismissedWarnings.push(warningId);
  }
  dataService.saveProfilesToStorage();
  renderActiveWorkout();
  showToast('Overload warning dismissed');
}

// ============================================================================
// Select X Exercises (Custom Exercise Picker & Auto-Slotter) Modal
// ============================================================================
function openSelectExercisesModal() {
  const profile = dataService.getActiveProfile();
  const inputs = getSelectedInputs();
  const target = getTargetExerciseCount(
    dataService.sheetData,
    inputs,
    profile.activeWorkout?.workout
  );

  targetCustomWorkout = target.workout;
  targetCustomExerciseCount = target.count;
  selectedCustomExerciseIds = [];
  currentSelectShowAll = false;
  currentSelectMuscleFilter = 'All';

  document.getElementById('selectExercisesEyebrow').textContent =
    `CUSTOM WORKOUT · ${target.workout.name.toUpperCase()}`;
  document.getElementById('selectExercisesSearchInput').value = '';
  document.getElementById('selectFilterMatchingBtn').classList.add('active');
  document.getElementById('selectFilterAllBtn').classList.remove('active');

  renderSelectExercisesMuscleFilterBar();
  renderSelectExercisesModalContent();
  openModal(els.selectExercisesModal);
}

function renderSelectExercisesMuscleFilterBar() {
  renderMuscleFilterPills(
    document.getElementById('selectExercisesMuscleFilterBar'),
    currentSelectMuscleFilter,
    val => {
      currentSelectMuscleFilter = val;
      renderSelectExercisesMuscleFilterBar();
      renderSelectExercisesModalContent();
    }
  );
}

function renderSelectExercisesModalContent() {
  const profile = dataService.getActiveProfile();
  const inputs = getSelectedInputs();
  const count = selectedCustomExerciseIds.length;
  const needed = targetCustomExerciseCount;

  document.getElementById('selectExercisesModalTitle').textContent =
    `Select ${needed} Exercises (${count}/${needed})`;

  const confirmBtn = document.getElementById('confirmSelectExercisesBtn');
  confirmBtn.textContent =
    count === needed
      ? `Auto-Slot ${needed} Exercises`
      : count > 0
      ? `Auto-Fill & Slot (${count}/${needed} Picked)`
      : `Select ${needed} Exercises (0/${needed})`;

  // Summarize distribution of selected exercises so far
  const exMap = new Map(dataService.sheetData.exercises.map(e => [e.id, e]));
  const selectedObjs = selectedCustomExerciseIds.map(id => exMap.get(id)).filter(Boolean);
  const distEl = document.getElementById('selectExercisesDistributionText');
  if (selectedObjs.length === 0) {
    distEl.textContent = `Pick ${needed} exercises; the app will auto-slot them across rounds to balance muscle groups.`;
  } else {
    const muscleCounts = {};
    selectedObjs.forEach(e => {
      const pm = getPrimaryMuscle(e) || getPrimaryBodyArea(e);
      muscleCounts[pm] = (muscleCounts[pm] || 0) + 1;
    });
    const summaryStr = Object.entries(muscleCounts)
      .map(([m, c]) => `${m}: ${c}`)
      .join(' · ');
    distEl.textContent = `Selected (${count}/${needed}): ${summaryStr}`;
  }

  const query = (document.getElementById('selectExercisesSearchInput').value || '').trim();
  let pool = [];
  if (currentSelectShowAll) {
    pool = [...dataService.sheetData.exercises];
  } else {
    const hasExplicitChip = currentSelectMuscleFilter !== 'All';
    pool = filterEligibleExercises(dataService.sheetData.exercises, {
      workoutCategory: inputs.workoutCategory,
      bodyCategory: hasExplicitChip ? currentSelectMuscleFilter : inputs.bodyCategory,
      muscleGroup: hasExplicitChip ? currentSelectMuscleFilter : null,
      focusWeights: hasExplicitChip ? null : inputs.focusWeights,
      focusEnabled: hasExplicitChip ? null : inputs.focusEnabled,
      equipment: inputs.equipment,
      excludedExerciseIds: profile.excludedExerciseIds || []
    });
  }

  pool = filterExercisesByMuscleAndQuery(pool, {
    muscleFilter: currentSelectMuscleFilter,
    query
  });

  const selectedSet = new Set(selectedCustomExerciseIds);
  const listEl = document.getElementById('selectExercisesList');
  if (pool.length === 0) {
    listEl.innerHTML = `<p class="settings-help">No matching exercises found. Tap "All Exercises" to browse all ${dataService.sheetData.exercises.length} movements.</p>`;
    return;
  }

  listEl.innerHTML = pool
    .map(ex => {
      const isSelected = selectedSet.has(ex.id);
      const orderNum = isSelected ? selectedCustomExerciseIds.indexOf(ex.id) + 1 : null;
      const pri = SPECIFIC_MUSCLES.filter(m => ex.muscles?.[m] === 'Pri').join(', ');
      const area = getPrimaryBodyArea(ex);
      return `
        <button
          type="button"
          class="swap-option-item ${isSelected ? 'selected-exercise-item' : ''}"
          data-action="toggle-custom-select-exercise"
          data-exercise-id="${ex.id}"
        >
          <div>
            <div class="swap-option-title">${ex.name}</div>
            <div class="swap-option-meta">${area} (${pri}) · ${ex.equipment}</div>
          </div>
          <span class="swap-badge ${isSelected ? 'selected-badge' : ''}">
            ${isSelected ? `✓ #${orderNum}` : 'Select'}
          </span>
        </button>
      `;
    })
    .join('');
}

function openSettingsModal() {
  currentExclusionMuscleFilter = 'All';
  renderSettingsModalContent();
  openModal(els.settingsModal);
}

function renderSettingsModalContent() {
  const profile = dataService.getActiveProfile();

  document.querySelectorAll('[data-options-count]').forEach(btn => {
    const count = Number(btn.getAttribute('data-options-count'));
    btn.classList.toggle('active', count === (profile.optionsPerSlot || 1));
  });

  renderMuscleFilterPills(
    document.getElementById('exclusionMuscleFilterBar'),
    currentExclusionMuscleFilter,
    val => {
      currentExclusionMuscleFilter = val;
      renderSettingsModalContent();
    }
  );

  renderExclusionChecklist();
}

function renderExclusionChecklist() {
  const profile = dataService.getActiveProfile();
  const excludedSet = new Set(profile.excludedExerciseIds || []);
  const query = (document.getElementById('exclusionSearchInput').value || '').trim();

  const exercises = filterExercisesByMuscleAndQuery(dataService.sheetData.exercises, {
    muscleFilter: currentExclusionMuscleFilter,
    query
  });

  const container = document.getElementById('exclusionChecklist');
  container.innerHTML = exercises
    .map(ex => {
      const isExcluded = excludedSet.has(ex.id);
      const pri = getPrimaryMuscle(ex);
      return `
        <label class="exclusion-row ${isExcluded ? 'is-excluded' : ''}">
          <span>${ex.name} <small style="color:var(--text-muted)">(${pri ? `${pri} · ` : ''}${ex.equipment})</small></span>
          <input
            type="checkbox"
            data-action="toggle-exclusion"
            data-exercise-id="${ex.id}"
            ${!isExcluded ? 'checked' : ''}
          />
        </label>
      `;
    })
    .join('');
}

function weightsDiffer(a, b) {
  return (
    Math.abs((a?.['Upper Body'] || 0) - (b?.['Upper Body'] || 0)) > 1e-4 ||
    Math.abs((a?.['Core'] || 0) - (b?.['Core'] || 0)) > 1e-4 ||
    Math.abs((a?.['Legs'] || 0) - (b?.['Legs'] || 0)) > 1e-4
  );
}

function bindFocusSliderEvents() {
  if (!els.focusSliderSection || !els.focusBarTrack) return;

  // 0. Reset Focus button (1/3 Upper Body, 1/3 Core, 1/3 Lower Body — staged until Generate Workout or Select X Exercises)
  if (els.resetFocusBtn) {
    els.resetFocusBtn.addEventListener('click', () => {
      focusState = resetFocusState();
      renderFocusSliderUI();
    });
  }

  // Double-clicking a slider handle also resets Focus to 1/3 each
  els.focusBarTrack.addEventListener('dblclick', e => {
    if (!e.target.closest('[data-handle-index]')) return;
    focusState = resetFocusState();
    renderFocusSliderUI();
  });

  // 1. Tapping Upper Body, Core, or Lower Body label toggles deselection/reselection
  //    (updates Focus UI only; workout does not change until user taps Generate Workout or Select X Exercises)
  els.focusSliderSection.addEventListener('click', e => {
    const labelBtn = e.target.closest('[data-focus-area]');
    if (!labelBtn) return;
    const area = labelBtn.getAttribute('data-focus-area');
    const result = toggleFocusAreaState(focusState.weights, focusState.enabled, area);
    if (result.blockedLastActive) {
      showToast('Keep at least one body area active');
      return;
    }
    if (result.changed) {
      focusState = { weights: result.weights, enabled: result.enabled };
      renderFocusSliderUI();
    }
  });

  // 2. Dragging slider handles or tapping on the 3-color bar track
  let dragSession = null;

  function getTrackFraction(clientX) {
    const rect = els.focusBarTrack.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  els.focusBarTrack.addEventListener('pointerdown', e => {
    if (e.button !== undefined && e.button !== 0) return;
    const { handles } = computeFocusSliderPositions(focusState.weights, focusState.enabled);
    if (handles.length === 0) return;

    e.preventDefault();
    const rawFrac = getTrackFraction(e.clientX);
    const thumbEl = e.target.closest('[data-handle-index]');

    let handleIndex = null;
    let isOverlappingAmbiguous = false;
    let overlapPos = 0;

    if (handles.length === 1) {
      handleIndex = 0;
    } else if (Math.abs(handles[0].position - handles[1].position) < 0.005) {
      overlapPos = handles[0].position;
      if (!thumbEl && Math.abs(rawFrac - overlapPos) > 0.015) {
        handleIndex = rawFrac < overlapPos ? 0 : 1;
      } else {
        isOverlappingAmbiguous = true;
        handleIndex = 0;
      }
    } else if (thumbEl) {
      handleIndex = Number(thumbEl.getAttribute('data-handle-index')) || 0;
    } else {
      const d0 = Math.abs(rawFrac - handles[0].position);
      const d1 = Math.abs(rawFrac - handles[1].position);
      handleIndex = d0 <= d1 ? 0 : 1;
    }

    dragSession = {
      pointerId: e.pointerId,
      initialWeights: { ...focusState.weights },
      startWeights: { ...focusState.weights },
      handleIndex,
      isOverlappingAmbiguous,
      overlapPos
    };

    els.focusBarTrack.classList.add('is-dragging');
    try {
      els.focusBarTrack.setPointerCapture(e.pointerId);
    } catch {}

    // If user tapped directly on the track away from an ambiguous overlap, snap immediately
    if (!thumbEl && !isOverlappingAmbiguous) {
      const updated = updateFocusFromHandleDrag(
        dragSession.startWeights,
        focusState.enabled,
        dragSession.handleIndex,
        rawFrac
      );
      focusState.weights = updated.weights;
    }
    renderFocusSliderUI(dragSession.handleIndex);
  });

  els.focusBarTrack.addEventListener('pointermove', e => {
    if (!dragSession || e.pointerId !== dragSession.pointerId) return;
    const rawFrac = getTrackFraction(e.clientX);

    if (dragSession.isOverlappingAmbiguous) {
      if (Math.abs(rawFrac - dragSession.overlapPos) < 0.012) return;
      dragSession.handleIndex = rawFrac < dragSession.overlapPos ? 0 : 1;
      dragSession.isOverlappingAmbiguous = false;
    }

    const updated = updateFocusFromHandleDrag(
      dragSession.startWeights,
      focusState.enabled,
      dragSession.handleIndex,
      rawFrac
    );
    focusState.weights = updated.weights;
    renderFocusSliderUI(dragSession.handleIndex);
  });

  function finishFocusDrag(e) {
    if (!dragSession || (e && e.pointerId !== dragSession.pointerId)) return;
    dragSession = null;
    els.focusBarTrack.classList.remove('is-dragging');
    try {
      if (e && els.focusBarTrack.hasPointerCapture?.(e.pointerId)) {
        els.focusBarTrack.releasePointerCapture(e.pointerId);
      }
    } catch {}
    renderFocusSliderUI(null);
  }

  els.focusBarTrack.addEventListener('pointerup', finishFocusDrag);
  els.focusBarTrack.addEventListener('pointercancel', finishFocusDrag);

  // 3. Keyboard arrow accessibility along FOCUS_SNAP_STEPS
  //    (updates Focus UI only; workout does not change until user taps Generate Workout)
  els.focusBarTrack.addEventListener('keydown', e => {
    const thumb = e.target.closest('[data-handle-index]');
    if (!thumb) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      return;
    }
    e.preventDefault();
    const handleIndex = Number(thumb.getAttribute('data-handle-index')) || 0;
    const { handles } = computeFocusSliderPositions(focusState.weights, focusState.enabled);
    const h = handles[handleIndex];
    if (!h) return;

    let currentStepIdx = 0;
    let bestDiff = Infinity;
    FOCUS_SNAP_STEPS.forEach((stepVal, idx) => {
      const diff = Math.abs(stepVal - h.position);
      if (diff < bestDiff) {
        bestDiff = diff;
        currentStepIdx = idx;
      }
    });

    let nextIdx = currentStepIdx;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      nextIdx = Math.max(0, currentStepIdx - 1);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      nextIdx = Math.min(FOCUS_SNAP_STEPS.length - 1, currentStepIdx + 1);
    } else if (e.key === 'Home') {
      nextIdx = 0;
    } else if (e.key === 'End') {
      nextIdx = FOCUS_SNAP_STEPS.length - 1;
    }

    const updated = updateFocusFromHandleDrag(
      focusState.weights,
      focusState.enabled,
      handleIndex,
      FOCUS_SNAP_STEPS[nextIdx]
    );
    focusState.weights = updated.weights;
    renderFocusSliderUI(null);
  });
}

// ============================================================================
// Event Listeners
// ============================================================================
function bindEvents() {
  els.generateWorkoutBtn.addEventListener('click', () => handleGenerateWorkout(true));

  bindFocusSliderEvents();

  // Stage top menu dropdown selections without updating the active workout until
  // the user hits Generate Workout or Select X Exercises
  els.workoutCategorySelect.addEventListener('change', () => {
    const cat = els.workoutCategorySelect.value;
    const curType = els.workoutTypeSelect.value;
    if (cat !== 'Either' && curType !== 'Random') {
      const wk = dataService.sheetData.workouts.find(w => w.name === curType);
      if (wk && wk.workoutCategory !== cat) {
        els.workoutTypeSelect.value = 'Random';
      }
    }
    updateSelectExercisesButtonLabel();
  });

  els.equipmentSelect.addEventListener('change', () => {
    updateSelectExercisesButtonLabel();
  });

  els.workoutTypeSelect.addEventListener('change', () => {
    const val = els.workoutTypeSelect.value;
    if (val !== 'Random') {
      const wk = dataService.sheetData.workouts.find(w => w.name === val);
      if (wk) {
        els.workoutCategorySelect.value = wk.workoutCategory;
      }
    }
    updateSelectExercisesButtonLabel();
  });

  // Select X Exercises Modal
  els.selectExercisesBtn.addEventListener('click', openSelectExercisesModal);

  document.getElementById('selectExercisesSearchInput').addEventListener('input', () => {
    renderSelectExercisesModalContent();
  });

  document.getElementById('selectFilterMatchingBtn').addEventListener('click', () => {
    currentSelectShowAll = false;
    document.getElementById('selectFilterMatchingBtn').classList.add('active');
    document.getElementById('selectFilterAllBtn').classList.remove('active');
    renderSelectExercisesModalContent();
  });

  document.getElementById('selectFilterAllBtn').addEventListener('click', () => {
    currentSelectShowAll = true;
    document.getElementById('selectFilterAllBtn').classList.add('active');
    document.getElementById('selectFilterMatchingBtn').classList.remove('active');
    renderSelectExercisesModalContent();
  });

  document.getElementById('clearSelectedExercisesBtn').addEventListener('click', () => {
    selectedCustomExerciseIds = [];
    renderSelectExercisesModalContent();
  });

  document.getElementById('autoFillRemainingBtn').addEventListener('click', () => {
    const inputs = getSelectedInputs();
    const filled = pickAutoFillExercises(
      dataService.sheetData,
      inputs,
      selectedCustomExerciseIds,
      targetCustomExerciseCount
    );
    selectedCustomExerciseIds = filled.map(ex => ex.id);
    renderSelectExercisesModalContent();
  });

  document.getElementById('selectExercisesList').addEventListener('click', e => {
    const btn = e.target.closest('[data-action="toggle-custom-select-exercise"]');
    if (!btn) return;
    const exId = btn.getAttribute('data-exercise-id');
    const existingIdx = selectedCustomExerciseIds.indexOf(exId);
    if (existingIdx !== -1) {
      selectedCustomExerciseIds.splice(existingIdx, 1);
    } else {
      if (selectedCustomExerciseIds.length >= targetCustomExerciseCount) {
        showToast(`Already selected ${targetCustomExerciseCount} exercises`);
        return;
      }
      selectedCustomExerciseIds.push(exId);
    }
    renderSelectExercisesModalContent();
  });

  document.getElementById('confirmSelectExercisesBtn').addEventListener('click', () => {
    const inputs = getSelectedInputs();
    const effectiveWorkoutType =
      inputs.workoutType === 'Random' && targetCustomWorkout
        ? targetCustomWorkout.name
        : inputs.workoutType;
    const workoutState = generateWorkoutFromSelectedExercises(
      dataService.sheetData,
      { ...inputs, workoutType: effectiveWorkoutType },
      selectedCustomExerciseIds
    );
    dataService.updateActiveProfile({
      inputs: {
        workoutCategory: workoutState.inputs.effectiveWorkoutCategory,
        bodyCategory: inputs.bodyCategory,
        focusWeights: { ...inputs.focusWeights },
        focusEnabled: { ...inputs.focusEnabled },
        equipment: inputs.equipment,
        workoutType: workoutState.workout.name
      },
      activeWorkout: workoutState
    });
    els.workoutCategorySelect.value = workoutState.inputs.effectiveWorkoutCategory;
    els.workoutTypeSelect.value = workoutState.workout.name;
    resetTimerForWorkoutType(workoutState.workout.id);
    closeAllModals();
    renderActiveWorkout();
    showToast(`Auto-slotted ${targetCustomExerciseCount} exercises`);
  });

  // Workout Timer Bar buttons (Top Timer defaults to Full Workout)
  els.openWorkoutTimerBtn.addEventListener('click', () => {
    openTimerModal({
      roundIndex: 0,
      slotIndex: null,
      includeAllRounds: true,
      openCustomizer: false
    });
  });

  els.openCustomTimerBtn.addEventListener('click', () => {
    openTimerModal({
      roundIndex: 0,
      slotIndex: null,
      includeAllRounds: true,
      openCustomizer: true
    });
  });

  // Timer Modal internal controls
  document.getElementById('closeTimerModalBtn').addEventListener('click', closeTimerModal);

  document.getElementById('toggleTimerCustomizerBtn').addEventListener('click', () => {
    stopTimerLoop();
    timerState.customizerOpen = !timerState.customizerOpen;
    renderTimerModal();
  });

  document.getElementById('applyTimerCustomizationBtn').addEventListener('click', () => {
    timerState.customizerOpen = false;
    renderTimerModal();
    showToast('Timer updated');
  });

  const startPauseBtn = document.getElementById('timerStartPauseBtn');
  startPauseBtn.addEventListener('pointerdown', configureAmbientAudioSession, { passive: true });
  startPauseBtn.addEventListener('touchstart', configureAmbientAudioSession, { passive: true });
  startPauseBtn.addEventListener('click', toggleTimerPlayPause);

  document.getElementById('timerPrevStepBtn').addEventListener('click', () => {
    stopTimerLoop();
    if (timerState.currentStepIndex > 0) {
      timerState.currentStepIndex -= 1;
    }
    const dur = timerState.steps[timerState.currentStepIndex]?.duration || 10;
    timerState.remainingSeconds = dur;
    timerState.remainingMs = dur * 1000;
    renderTimerExecutionView();
  });

  document.getElementById('timerNextStepBtn').addEventListener('click', () => {
    stopTimerLoop();
    if (timerState.currentStepIndex < timerState.steps.length - 1) {
      timerState.currentStepIndex += 1;
    }
    const dur = timerState.steps[timerState.currentStepIndex]?.duration || 10;
    timerState.remainingSeconds = dur;
    timerState.remainingMs = dur * 1000;
    renderTimerExecutionView();
  });

  document.getElementById('timerResetBtn').addEventListener('click', () => {
    stopTimerLoop();
    timerState.currentStepIndex = 0;
    const dur = timerState.steps[0]?.duration || timerState.countdownDuration || 10;
    timerState.remainingSeconds = dur;
    timerState.remainingMs = dur * 1000;
    renderTimerExecutionView();
  });

  document.getElementById('timerSequenceTimeline').addEventListener('click', e => {
    const chip = e.target.closest('[data-action="jump-timer-step"]');
    if (!chip) return;
    stopTimerLoop();
    const idx = Number(chip.getAttribute('data-step-index'));
    if (!Number.isNaN(idx) && timerState.steps[idx]) {
      timerState.currentStepIndex = idx;
      const dur = timerState.steps[idx].duration;
      timerState.remainingSeconds = dur;
      timerState.remainingMs = dur * 1000;
      renderTimerExecutionView();
    }
  });

  document.getElementById('timerScopePills').addEventListener('click', e => {
    const rBtn = e.target.closest('[data-timer-round]');
    const sBtn = e.target.closest('[data-timer-slot]');
    const allBtn = e.target.closest('[data-timer-all-rounds]');
    if (!rBtn && !sBtn && !allBtn) return;

    stopTimerLoop();
    timerState.customStepsOverride = null;
    if (allBtn) {
      timerState.includeAllRounds = true;
      timerState.slotIndex = null;
    } else if (sBtn) {
      timerState.includeAllRounds = false;
      timerState.slotIndex = Number(sBtn.getAttribute('data-timer-slot'));
    } else if (rBtn) {
      timerState.includeAllRounds = false;
      timerState.slotIndex = null;
      timerState.roundIndex = Number(rBtn.getAttribute('data-timer-round'));
    }
    rebuildTimerSteps(true);
    renderTimerModal();
  });

  // Timer Customizer Mode & Inputs
  document.getElementById('timerModeStockBtn').addEventListener('click', () => {
    timerState.mode = 'stock';
    timerState.customStepsOverride = null;
    rebuildTimerSteps(true);
    renderTimerModal();
    updateWorkoutTimerBarUI(dataService.getActiveProfile().activeWorkout);
  });

  document.getElementById('timerModeCustomBtn').addEventListener('click', () => {
    timerState.mode = 'custom-preset';
    timerState.customStepsOverride = null;
    rebuildTimerSteps(true);
    renderTimerModal();
    updateWorkoutTimerBarUI(dataService.getActiveProfile().activeWorkout);
  });

  document.getElementById('customTimerPresetSelect').addEventListener('change', e => {
    timerState.presetId = e.target.value;
    timerState.mode = 'custom-preset';
    timerState.customStepsOverride = null;
    rebuildTimerSteps(true);
    renderTimerModal();
    updateWorkoutTimerBarUI(dataService.getActiveProfile().activeWorkout);
  });

  document.getElementById('timerCountdownInput').addEventListener('change', e => {
    const val = Math.max(1, Number(e.target.value) || 10);
    timerState.countdownDuration = val;
    rebuildTimerSteps(true);
    renderTimerModal();
    updateWorkoutTimerBarUI(dataService.getActiveProfile().activeWorkout);
  });

  document.getElementById('perExerciseTimerList').addEventListener('change', e => {
    const input = e.target.closest('[data-ex-timer-field]');
    if (!input) return;
    const exId = input.getAttribute('data-exercise-id');
    const field = input.getAttribute('data-ex-timer-field');
    if (!exId || !field) return;

    const wk = dataService.getActiveProfile().activeWorkout?.workout;
    const defaults = getDefaultExerciseTimerConfig(wk);
    if (!timerState.exerciseConfigs[exId]) {
      timerState.exerciseConfigs[exId] = { ...defaults, extraIntervals: [] };
    }
    if (field === 'workDuration' || field === 'restDuration') {
      timerState.exerciseConfigs[exId][field] = Math.max(0, Number(input.value) || 0);
    } else {
      timerState.exerciseConfigs[exId][field] = input.value;
    }
    timerState.customStepsOverride = null;
    rebuildTimerSteps(true);
    renderTimerModal();
    updateWorkoutTimerBarUI(dataService.getActiveProfile().activeWorkout);
  });

  document.getElementById('perExerciseTimerList').addEventListener('click', e => {
    const addBtn = e.target.closest('[data-action="add-exercise-extra-time"]');
    if (!addBtn) return;
    const exId = addBtn.getAttribute('data-exercise-id');
    const wk = dataService.getActiveProfile().activeWorkout?.workout;
    const defaults = getDefaultExerciseTimerConfig(wk);
    if (!timerState.exerciseConfigs[exId]) {
      timerState.exerciseConfigs[exId] = { ...defaults, extraIntervals: [] };
    }
    if (!Array.isArray(timerState.exerciseConfigs[exId].extraIntervals)) {
      timerState.exerciseConfigs[exId].extraIntervals = [];
    }
    timerState.exerciseConfigs[exId].extraIntervals.push({
      duration: 20,
      color: 'orange',
      type: 'work'
    });
    timerState.customStepsOverride = null;
    rebuildTimerSteps(true);
    renderTimerModal();
    updateWorkoutTimerBarUI(dataService.getActiveProfile().activeWorkout);
    showToast('Added extra time interval for exercise');
  });

  document.getElementById('addCustomIntervalBtn').addEventListener('click', () => {
    const labelInput = document.getElementById('newIntervalLabelInput');
    const durInput = document.getElementById('newIntervalDurationInput');
    const colSelect = document.getElementById('newIntervalColorSelect');

    const label = (labelInput.value || '').trim() || 'Custom Interval';
    const dur = Math.max(1, Number(durInput.value) || 30);
    const col = colSelect.value || 'green';

    const currentSteps = timerState.steps.map(s => ({ ...s }));
    currentSteps.push({
      id: `step-custom-${Date.now()}`,
      type: col === 'blue' ? 'rest' : 'work',
      phaseLabel: `Custom (${dur}s)`,
      exerciseId: null,
      exerciseName: label,
      roundNumber: 1,
      duration: dur,
      color: col
    });
    timerState.customStepsOverride = currentSteps;
    labelInput.value = '';
    rebuildTimerSteps(true);
    renderTimerModal();
    updateWorkoutTimerBarUI(dataService.getActiveProfile().activeWorkout);
    showToast(`Added ${dur}s ${col} interval`);
  });

  document.getElementById('customIntervalStepsList').addEventListener('change', e => {
    const fieldEl = e.target.closest('[data-step-field]');
    if (!fieldEl) return;
    const idx = Number(fieldEl.getAttribute('data-step-index'));
    const field = fieldEl.getAttribute('data-step-field');
    if (Number.isNaN(idx) || !timerState.steps[idx]) return;

    const cloned = timerState.steps.map(s => ({ ...s }));
    if (field === 'duration') {
      const d = Math.max(1, Number(fieldEl.value) || 10);
      cloned[idx].duration = d;
      if (idx === 0 && cloned[0].type === 'countdown') {
        timerState.countdownDuration = d;
      }
    } else if (field === 'color') {
      cloned[idx].color = fieldEl.value;
    } else if (field === 'exerciseName') {
      cloned[idx].exerciseName = fieldEl.value;
      cloned[idx].customLabel = fieldEl.value;
    }
    timerState.customStepsOverride = cloned;
    rebuildTimerSteps(true);
    renderTimerModal();
    updateWorkoutTimerBarUI(dataService.getActiveProfile().activeWorkout);
  });

  document.getElementById('customIntervalStepsList').addEventListener('click', e => {
    const delBtn = e.target.closest('[data-action="delete-timer-step"]');
    if (!delBtn) return;
    const idx = Number(delBtn.getAttribute('data-step-index'));
    if (Number.isNaN(idx) || idx <= 0) return;
    const cloned = timerState.steps.filter((_, i) => i !== idx).map(s => ({ ...s }));
    timerState.customStepsOverride = cloned;
    rebuildTimerSteps(true);
    renderTimerModal();
    updateWorkoutTimerBarUI(dataService.getActiveProfile().activeWorkout);
  });

  document.getElementById('resetStockTimerBtn').addEventListener('click', () => {
    const wkId = dataService.getActiveProfile().activeWorkout?.workout?.id || 'timed-duos-40-20';
    resetTimerForWorkoutType(wkId);
    timerState.customizerOpen = true;
    renderTimerModal();
    updateWorkoutTimerBarUI(dataService.getActiveProfile().activeWorkout);
    showToast('Reset to stock timer');
  });

  // Hyperlink click on Workout Type opens Workout Format guide
  els.workoutTitleBtn.addEventListener('click', e => {
    e.preventDefault();
    const wk = dataService.getActiveProfile().activeWorkout?.workout;
    if (wk) openWorkoutTypeModal(wk.id);
  });

  els.settingsBtn.addEventListener('click', openSettingsModal);

  els.modalBackdrop.addEventListener('click', closeAllModals);
  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', closeAllModals);
  });

  // Dismiss warning button inside Balance Modal
  document.getElementById('dismissWarningModalBtn').addEventListener('click', () => {
    if (currentBalanceWarningId) {
      dismissWarning(currentBalanceWarningId);
      closeAllModals();
    }
  });

  // Transition from Exercise Guide Modal -> Swap Modal
  document.getElementById('openSwapFromExerciseModalBtn').addEventListener('click', () => {
    if (!currentSwapContext) return;
    const { roundIndex, slotIndex } = currentSwapContext;
    closeAllModals();
    openSwapModal(roundIndex, slotIndex);
  });

  // Swap Modal Controls
  document.getElementById('swapSearchInput').addEventListener('input', renderSwapExerciseList);
  document.getElementById('swapFilterMatchingBtn').addEventListener('click', () => {
    currentSwapShowAll = false;
    document.getElementById('swapFilterMatchingBtn').classList.add('active');
    document.getElementById('swapFilterAllBtn').classList.remove('active');
    renderSwapExerciseList();
  });
  document.getElementById('swapFilterAllBtn').addEventListener('click', () => {
    currentSwapShowAll = true;
    document.getElementById('swapFilterAllBtn').classList.add('active');
    document.getElementById('swapFilterMatchingBtn').classList.remove('active');
    renderSwapExerciseList();
  });

  document.getElementById('randomSwapBtn').addEventListener('click', () => {
    if (!currentSwapContext) return;
    const profile = dataService.getActiveProfile();
    const wkState = profile.activeWorkout;

    const validCandidates = getValidReplacementCandidates({
      workoutState: wkState,
      roundIndex: currentSwapContext.roundIndex,
      slotIndex: currentSwapContext.slotIndex,
      sheetData: dataService.sheetData,
      excludedExerciseIds: profile.excludedExerciseIds || [],
      analyzeMuscleLoadFn: analyzeMuscleLoad
    });

    const chosen = getRandomEntry(
      validCandidates.length > 0 ? validCandidates : dataService.sheetData.exercises
    );
    if (chosen) {
      performSlotSwap(currentSwapContext.roundIndex, currentSwapContext.slotIndex, chosen, false);
      closeAllModals();
    }
  });

  // Delegated clicks inside roundsContainer
  els.roundsContainer.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const roundIndex = Number(btn.getAttribute('data-round-index'));
    const slotIndex = Number(btn.getAttribute('data-slot-index'));

    const profile = dataService.getActiveProfile();
    const wkState = profile.activeWorkout;

    if (action === 'toggle-set') {
      const setIndex = Number(btn.getAttribute('data-set-index'));
      const slot = wkState.rounds[roundIndex]?.slots[slotIndex];
      const checkMode = getWorkoutCheckMode(wkState.workout);
      if (slot && checkMode.mode === 'exercise-sets') {
        if (!Array.isArray(slot.completedSets) || slot.completedSets.length !== checkMode.count) {
          slot.completedSets = Array.from({ length: checkMode.count }, () => false);
        }
        slot.completedSets[setIndex] = !slot.completedSets[setIndex];
        slot.completed = slot.completedSets.every(Boolean);
        slot.optionChosen = true;
        dataService.saveProfilesToStorage();
        renderActiveWorkout();
      }
    } else if (action === 'toggle-round-complete') {
      const round = wkState.rounds[roundIndex];
      if (round) {
        round.completed = !round.completed;
        dataService.saveProfilesToStorage();
        renderActiveWorkout();
      }
    } else if (action === 'select-slot-option') {
      const optionIndex = Number(btn.getAttribute('data-option-index'));
      const slot = wkState.rounds[roundIndex]?.slots[slotIndex];
      if (slot) {
        slot.selectedOptionIndex = optionIndex;
        slot.optionChosen = true;
        dataService.saveProfilesToStorage();
        rebuildTimerSteps(false);
        renderActiveWorkout();
        const chosenEx = getActiveSlotExercise(slot);
        if (chosenEx) {
          showToast(`Selected: ${chosenEx.name}`);
        }
      }
    } else if (action === 'open-exercise-modal') {
      const exId = btn.getAttribute('data-exercise-id');
      openExerciseModal(exId, roundIndex, slotIndex);
    } else if (action === 'open-swap-modal') {
      openSwapModal(roundIndex, slotIndex);
    } else if (action === 'open-round-timer') {
      openTimerModal({
        roundIndex,
        slotIndex: null,
        includeAllRounds: false,
        openCustomizer: false
      });
    } else if (action === 'auto-balance') {
      const warningId = btn.getAttribute('data-warning-id');
      const warning = currentAnalysis?.warnings.find(w => w.id === warningId);
      if (warning) {
        profile.activeWorkout = applyBalancedRecommendation(wkState, warning);
        dataService.saveProfilesToStorage();
        rebuildTimerSteps(false);
        renderActiveWorkout();
        showToast(`Balanced Round ${warning.roundNumber}`);
      }
    } else if (action === 'open-balance-modal') {
      const warningId = btn.getAttribute('data-warning-id');
      openBalanceModal(warningId);
    } else if (action === 'dismiss-warning') {
      const warningId = btn.getAttribute('data-warning-id');
      dismissWarning(warningId);
    }
  });

  // Delegated clicks in Swap Modal list
  document.getElementById('swapExerciseList').addEventListener('click', e => {
    const btn = e.target.closest('[data-action="confirm-swap"]');
    if (!btn || !currentSwapContext) return;
    const exId = btn.getAttribute('data-exercise-id');
    const ex = dataService.sheetData.exercises.find(item => item.id === exId);
    if (ex) {
      performSlotSwap(currentSwapContext.roundIndex, currentSwapContext.slotIndex, ex);
      closeAllModals();
    }
  });

  // Delegated clicks in Balance Recommendations Modal
  document.getElementById('balanceRecommendationsList').addEventListener('click', e => {
    const btn = e.target.closest('[data-action="apply-balance-choice"]');
    if (!btn) return;
    const warningId = btn.getAttribute('data-warning-id');
    const exId = btn.getAttribute('data-exercise-id');
    const warning = currentAnalysis?.warnings.find(w => w.id === warningId);
    const chosenEx = dataService.sheetData.exercises.find(item => item.id === exId);
    if (warning && chosenEx) {
      const profile = dataService.getActiveProfile();
      profile.activeWorkout = applyBalancedRecommendation(profile.activeWorkout, warning, chosenEx);
      dataService.saveProfilesToStorage();
      rebuildTimerSteps(false);
      closeAllModals();
      renderActiveWorkout();
      showToast(`Swapped to ${chosenEx.name}`);
    }
  });

  // Swap Modal original slot options selection & restore
  const slotOptionsBox = document.getElementById('swapSlotOptionsContainer');
  if (slotOptionsBox) {
    slotOptionsBox.addEventListener('click', e => {
      const optBtn = e.target.closest('[data-action="pick-original-option"]');
      if (optBtn && currentSwapContext) {
        const optIdx = Number(optBtn.getAttribute('data-option-index'));
        const profile = dataService.getActiveProfile();
        const slot = profile.activeWorkout?.rounds?.[currentSwapContext.roundIndex]?.slots?.[currentSwapContext.slotIndex];
        if (slot && slot.options[optIdx]) {
          slot.selectedOptionIndex = optIdx;
          slot.optionChosen = true;
          dataService.saveProfilesToStorage();
          rebuildTimerSteps(false);
          closeAllModals();
          renderActiveWorkout();
          showToast(`Selected: ${slot.options[optIdx].name}`);
        }
        return;
      }

      const restoreBtn = e.target.closest('#restoreSlotPillsBtn');
      if (restoreBtn && currentSwapContext) {
        const profile = dataService.getActiveProfile();
        const slot = profile.activeWorkout?.rounds?.[currentSwapContext.roundIndex]?.slots?.[currentSwapContext.slotIndex];
        if (slot) {
          slot.optionChosen = false;
          dataService.saveProfilesToStorage();
          closeAllModals();
          renderActiveWorkout();
          showToast('Options restored to card');
        }
      }
    });
  }

  // Settings Modal interactions
  document.querySelectorAll('[data-options-count]').forEach(btn => {
    btn.addEventListener('click', () => {
      const count = Number(btn.getAttribute('data-options-count'));
      dataService.setOptionsPerSlot(count);
      renderSettingsModalContent();
      showToast(`${count} option${count > 1 ? 's' : ''} per slot`);
    });
  });

  document.getElementById('exclusionSearchInput').addEventListener('input', renderExclusionChecklist);

  document.getElementById('exclusionChecklist').addEventListener('change', e => {
    const input = e.target.closest('[data-action="toggle-exclusion"]');
    if (!input) return;
    const exId = input.getAttribute('data-exercise-id');
    dataService.toggleExerciseExclusion(exId);
    updateExcludedCountBadge();
    renderActiveWorkout();
    renderExclusionChecklist();
  });

  document.getElementById('clearExclusionsBtn').addEventListener('click', () => {
    dataService.updateActiveProfile({ excludedExerciseIds: [] });
    updateExcludedCountBadge();
    renderActiveWorkout();
    renderExclusionChecklist();
    showToast(`All ${dataService.sheetData.exercises.length} exercises included`);
  });

  bindDragAndDropEvents();
}

// ============================================================================
// Drag and Drop (Rounds & Exercise Slots — HTML5 DnD + Touch/Pointer Handle)
// ============================================================================
let activeDragState = null;

function clearDragHighlights() {
  els.roundsContainer
    .querySelectorAll(
      '.is-dragging, .drag-over-round, .drag-over-slot-reorder, .drag-over-slot-swap'
    )
    .forEach(el => {
      el.classList.remove(
        'is-dragging',
        'drag-over-round',
        'drag-over-slot-reorder',
        'drag-over-slot-swap'
      );
    });
}

function updateDropTargetHighlight(dragState, targetEl) {
  els.roundsContainer
    .querySelectorAll('.drag-over-round, .drag-over-slot-reorder, .drag-over-slot-swap')
    .forEach(el => {
      el.classList.remove('drag-over-round', 'drag-over-slot-reorder', 'drag-over-slot-swap');
    });
  if (!dragState || !targetEl) return;

  if (dragState.type === 'round') {
    const roundCard = targetEl.closest('.round-card');
    if (roundCard && Number(roundCard.dataset.roundIndex) !== dragState.fromRoundIndex) {
      roundCard.classList.add('drag-over-round');
    }
  } else if (dragState.type === 'slot') {
    const slotEl = targetEl.closest('.exercise-slot');
    if (!slotEl) return;
    const toRoundIndex = Number(slotEl.dataset.roundIndex);
    const toSlotIndex = Number(slotEl.dataset.slotIndex);
    if (toRoundIndex === dragState.fromRoundIndex && toSlotIndex !== dragState.fromSlotIndex) {
      slotEl.classList.add('drag-over-slot-reorder');
    } else if (toRoundIndex !== dragState.fromRoundIndex) {
      slotEl.classList.add('drag-over-slot-swap');
    }
  }
}

function applyRoundReorder(fromRoundIndex, toRoundIndex) {
  const profile = dataService.getActiveProfile();
  if (!profile.activeWorkout) return;
  if (fromRoundIndex === toRoundIndex) return;

  profile.activeWorkout = reorderRounds(profile.activeWorkout, fromRoundIndex, toRoundIndex);
  dataService.saveProfilesToStorage();
  rebuildTimerSteps(false);
  renderActiveWorkout();
  showToast(`Moved Round ${fromRoundIndex + 1} → Round ${toRoundIndex + 1}`);
}

function applyIntraRoundReorder(roundIndex, fromSlotIndex, toSlotIndex) {
  const profile = dataService.getActiveProfile();
  if (!profile.activeWorkout) return;
  if (fromSlotIndex === toSlotIndex) return;

  profile.activeWorkout = reorderExerciseInRound(
    profile.activeWorkout,
    roundIndex,
    fromSlotIndex,
    toSlotIndex
  );
  dataService.saveProfilesToStorage();
  rebuildTimerSteps(false);
  renderActiveWorkout();
  showToast(`Reordered Round ${roundIndex + 1} exercises`);
}

function applyCrossRoundSwap(fromRoundIndex, fromSlotIndex, toRoundIndex, toSlotIndex) {
  const profile = dataService.getActiveProfile();
  if (!profile.activeWorkout) return;

  const fromSlot = profile.activeWorkout.rounds?.[fromRoundIndex]?.slots?.[fromSlotIndex];
  const toSlot = profile.activeWorkout.rounds?.[toRoundIndex]?.slots?.[toSlotIndex];
  const exA = getActiveSlotExercise(fromSlot)?.name || 'Exercise';
  const exB = getActiveSlotExercise(toSlot)?.name || 'Exercise';

  profile.activeWorkout = swapExercisesAcrossRounds(
    profile.activeWorkout,
    fromRoundIndex,
    fromSlotIndex,
    toRoundIndex,
    toSlotIndex
  );
  dataService.saveProfilesToStorage();
  rebuildTimerSteps(false);
  renderActiveWorkout();
  showToast(`Swapped ${exA} ⇄ ${exB}`);
}

function executeDropAction(dragState, targetEl) {
  if (!dragState || !targetEl) return;

  if (dragState.type === 'round') {
    const roundCard = targetEl.closest('.round-card');
    if (!roundCard) return;
    const toRoundIndex = Number(roundCard.dataset.roundIndex);
    if (!Number.isNaN(toRoundIndex) && toRoundIndex !== dragState.fromRoundIndex) {
      applyRoundReorder(dragState.fromRoundIndex, toRoundIndex);
    }
  } else if (dragState.type === 'slot') {
    const slotEl = targetEl.closest('.exercise-slot');
    if (!slotEl) return;
    const toRoundIndex = Number(slotEl.dataset.roundIndex);
    const toSlotIndex = Number(slotEl.dataset.slotIndex);
    if (Number.isNaN(toRoundIndex) || Number.isNaN(toSlotIndex)) return;

    if (toRoundIndex === dragState.fromRoundIndex) {
      if (toSlotIndex !== dragState.fromSlotIndex) {
        applyIntraRoundReorder(toRoundIndex, dragState.fromSlotIndex, toSlotIndex);
      }
    } else {
      applyCrossRoundSwap(
        dragState.fromRoundIndex,
        dragState.fromSlotIndex,
        toRoundIndex,
        toSlotIndex
      );
    }
  }
}

function bindDragAndDropEvents() {
  // 1. HTML5 Drag-and-Drop (Desktop Mouse & Keyboard/Assistive Drag)
  els.roundsContainer.addEventListener('dragstart', e => {
    const slotEl = e.target.closest('.exercise-slot');
    if (slotEl) {
      const fromRoundIndex = Number(slotEl.dataset.roundIndex);
      const fromSlotIndex = Number(slotEl.dataset.slotIndex);
      activeDragState = {
        type: 'slot',
        fromRoundIndex,
        fromSlotIndex
      };
      slotEl.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try {
          e.dataTransfer.setData('text/plain', JSON.stringify(activeDragState));
        } catch {}
      }
      return;
    }

    const roundCard = e.target.closest('.round-card');
    if (roundCard && roundCard.draggable) {
      const fromRoundIndex = Number(roundCard.dataset.roundIndex);
      activeDragState = {
        type: 'round',
        fromRoundIndex
      };
      roundCard.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try {
          e.dataTransfer.setData('text/plain', JSON.stringify(activeDragState));
        } catch {}
      }
    }
  });

  els.roundsContainer.addEventListener('dragover', e => {
    if (!activeDragState) return;
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    updateDropTargetHighlight(activeDragState, e.target);
  });

  els.roundsContainer.addEventListener('drop', e => {
    let state = activeDragState;
    if (!state && e.dataTransfer) {
      try {
        state = JSON.parse(e.dataTransfer.getData('text/plain'));
      } catch {}
    }
    if (!state) return;
    e.preventDefault();
    clearDragHighlights();
    activeDragState = null;
    executeDropAction(state, e.target);
  });

  els.roundsContainer.addEventListener('dragend', () => {
    clearDragHighlights();
    activeDragState = null;
  });

  // 2. Touch / Pointer Drag on .drag-handle (for mobile touch devices where HTML5 DnD isn't used)
  let pointerDragState = null;

  els.roundsContainer.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse') return; // Mouse uses native HTML5 dragstart/drop
    const handle = e.target.closest('[data-drag-handle]');
    if (!handle) return;

    const dragKind = handle.getAttribute('data-drag-handle');
    const fromRoundIndex = Number(handle.getAttribute('data-round-index'));
    if (dragKind === 'round') {
      const roundCard = handle.closest('.round-card');
      if (!roundCard) return;
      pointerDragState = {
        type: 'round',
        fromRoundIndex,
        pointerId: e.pointerId
      };
      roundCard.classList.add('is-dragging');
    } else if (dragKind === 'slot') {
      const slotEl = handle.closest('.exercise-slot');
      if (!slotEl) return;
      const fromSlotIndex = Number(handle.getAttribute('data-slot-index'));
      pointerDragState = {
        type: 'slot',
        fromRoundIndex,
        fromSlotIndex,
        pointerId: e.pointerId
      };
      slotEl.classList.add('is-dragging');
    }

    if (pointerDragState) {
      e.preventDefault();
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {}
    }
  });

  els.roundsContainer.addEventListener('pointermove', e => {
    if (!pointerDragState || e.pointerId !== pointerDragState.pointerId) return;
    e.preventDefault();
    const targetEl = document.elementFromPoint(e.clientX, e.clientY);
    updateDropTargetHighlight(pointerDragState, targetEl);
  });

  const finishPointerDrag = (e, shouldCommit) => {
    if (!pointerDragState || e.pointerId !== pointerDragState.pointerId) return;
    const state = pointerDragState;
    pointerDragState = null;
    const targetEl = shouldCommit ? document.elementFromPoint(e.clientX, e.clientY) : null;
    clearDragHighlights();
    if (shouldCommit && targetEl) {
      executeDropAction(state, targetEl);
    }
  };

  els.roundsContainer.addEventListener('pointerup', e => finishPointerDrag(e, true));
  els.roundsContainer.addEventListener('pointercancel', e => finishPointerDrag(e, false));
}

function performSlotSwap(roundIndex, slotIndex, newExercise, isManual = true) {
  const profile = dataService.getActiveProfile();
  profile.activeWorkout = swapExerciseInSlot(
    profile.activeWorkout,
    roundIndex,
    slotIndex,
    newExercise,
    null,
    isManual
  );
  // Clear any dismissed warnings for that round so new state is evaluated fresh
  if (Array.isArray(profile.activeWorkout.dismissedWarnings)) {
    const prefix = `warn-r${roundIndex + 1}-`;
    profile.activeWorkout.dismissedWarnings = profile.activeWorkout.dismissedWarnings.filter(
      id => !id.startsWith(prefix) && id !== `round-${roundIndex}`
    );
  }
  dataService.saveProfilesToStorage();
  rebuildTimerSteps(false);
  renderActiveWorkout();
  showToast(`Swapped to ${newExercise.name}`);
}

let toastTimer = null;
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2000);
}

bootstrap();
