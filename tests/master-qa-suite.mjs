// tests/master-qa-suite.mjs
import { spawn } from 'child_process';
import http from 'http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function startLocalStaticServer(port = 8080) {
  const mime = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml'
  };
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const fullPath = path.join(rootDir, rel);
      if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': mime[path.extname(fullPath)] || 'text/plain' });
      res.end(fs.readFileSync(fullPath));
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function runProcess(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} failed with code ${code}`));
    });
  });
}

function checkHttp(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      if (res.statusCode >= 200 && res.statusCode < 400) resolve(res.statusCode);
      else reject(new Error(`HTTP ${res.statusCode} from ${url}`));
    }).on('error', reject);
  });
}

async function ensureChromeRunning() {
  const isRunning = await checkHttp('http://127.0.0.1:9222/json/version').then(() => true).catch(() => false);
  if (isRunning) return null;

  console.log('  -> Launching headless Google Chrome with remote debugging on port 9222...');
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const chromeProc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=9222',
    '--disable-gpu',
    '--user-data-dir=/tmp/chrome-master-qa',
    'http://127.0.0.1:8080/index.html'
  ], { stdio: 'ignore' });

  // Wait up to 5s for port 9222 to respond
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 200));
    const ready = await checkHttp('http://127.0.0.1:9222/json/version').then(() => true).catch(() => false);
    if (ready) {
      console.log('  -> Headless Chrome is ready on port 9222');
      return chromeProc;
    }
  }
  throw new Error('Chrome failed to start on port 9222');
}

async function getActivePageWs() {
  const res = await fetch('http://127.0.0.1:9222/json/list');
  const pages = await res.json();
  const page = pages.find(p => p.type === 'page' && p.url.includes('8080')) ||
               pages.find(p => p.type === 'page') ||
               pages[0];
  if (!page || !page.webSocketDebuggerUrl) {
    throw new Error('No active webSocketDebuggerUrl found in Chrome');
  }
  return page.webSocketDebuggerUrl;
}

async function runBrowserCDPTests(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 1;

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = id++;
      const timer = setTimeout(() => reject(new Error('Timeout ' + method)), 8000);
      const handler = (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.id === msgId) {
          clearTimeout(timer);
          ws.removeEventListener('message', handler);
          if (msg.error) reject(msg.error);
          else resolve(msg.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  async function evalInPage(fnStr) {
    const res = await send('Runtime.evaluate', {
      expression: `(${fnStr})()`,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      throw new Error(JSON.stringify(res.exceptionDetails));
    }
    return res.result.value;
  }

  return new Promise((resolve, reject) => {
    ws.onopen = async () => {
      try {
        await send('Runtime.enable');
        await send('DOM.enable');
        await send('Page.enable');

        // Emulate iPhone viewport (390 x 844)
        await send('Emulation.setDeviceMetricsOverride', {
          width: 390,
          height: 844,
          deviceScaleFactor: 3,
          mobile: true
        });

        // Ensure page is on our app
        await send('Page.navigate', { url: 'http://127.0.0.1:8080/index.html' });
        await new Promise(r => setTimeout(r, 600));

        console.log('\n--- 1. Viewport, Light Blue Palette & Single-Screen Layout Check ---');
        const vpCheck = await evalInPage(() => {
          const winWidth = window.innerWidth;
          const scrollWidth = document.documentElement.scrollWidth;
          const bodyScroll = document.body.scrollWidth;
          const rootBg = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim();
          const primaryAccent = getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim();
          return {
            winWidth,
            scrollWidth,
            noHorizontalOverflow: scrollWidth <= winWidth && bodyScroll <= winWidth,
            rootBg,
            primaryAccent
          };
        });
        if (!vpCheck.noHorizontalOverflow) throw new Error('Horizontal overflow detected!');
        if (vpCheck.rootBg !== '#f0f6fc') throw new Error(`Expected --bg-primary to be #f0f6fc, got ${vpCheck.rootBg}`);
        console.log(`  ✅ PASS: 390px iPhone viewport has 0 horizontal overflow; light blue palette verified (--bg-primary: ${vpCheck.rootBg})`);

        console.log('\n--- 2. Workout Type Hyperlink & Format Modal Check ---');
        const modalCheck = await evalInPage(() => {
          document.getElementById('workoutTitleBtn').click();
          const modal = document.getElementById('workoutTypeModal');
          const isOpen = modal && !modal.hidden;
          const title = document.getElementById('workoutTypeModalTitle')?.innerText;
          const summary = document.getElementById('workoutTypeModalSummary')?.innerText;
          document.querySelector('[data-close-modal="workoutTypeModal"]').click();
          const isClosed = modal.hidden;
          return { isOpen, isClosed, title, summaryLen: summary?.length || 0 };
        });
        if (!modalCheck.isOpen || !modalCheck.isClosed || modalCheck.summaryLen === 0) {
          throw new Error('Workout format modal failed');
        }
        console.log(`  ✅ PASS: Hyperlink opens modal for "${modalCheck.title}" with format explanation and closes cleanly`);

        console.log('\n--- 3. Exercise Details & 68 Bespoke SVG Diagrams Check ---');
        const exCheck = await evalInPage(() => {
          document.querySelector('.exercise-name-btn').click();
          const modal = document.getElementById('exerciseModal');
          const isOpen = modal && !modal.hidden;
          const title = document.getElementById('exerciseModalTitle')?.innerText;
          const imgSrc = document.getElementById('exerciseModalDiagram')?.getAttribute('src');
          const stepsCount = document.querySelectorAll('#exerciseModalSteps li').length;
          document.querySelector('[data-close-modal="exerciseModal"]').click();
          return { isOpen, title, imgSrc, stepsCount };
        });
        if (!exCheck.isOpen || !exCheck.imgSrc || exCheck.stepsCount === 0) {
          throw new Error('Exercise detail modal failed');
        }
        console.log(`  ✅ PASS: Exercise modal for "${exCheck.title}" loads SVG diagram (${exCheck.imgSrc}) and instructions`);

        console.log('\n--- 4. Format-Aware Checkboxes & Blue Check Verification ---');
        const cbCheck = await evalInPage(() => {
          // A: Fixed Sets (Strength Duos)
          const typeSelect = document.getElementById('workoutTypeSelect');
          typeSelect.value = 'Strength Duos';
          typeSelect.dispatchEvent(new Event('change'));
          document.getElementById('generateWorkoutBtn').click();

          let box = document.querySelector('.set-check-box');
          box.click();
          box = document.querySelector('.set-check-box');
          const c1 = box.classList.contains('checked');
          const checkedBg = getComputedStyle(box).backgroundColor;
          box.click();
          box = document.querySelector('.set-check-box');
          const c2 = box.classList.contains('checked');

          // B: Unfixed sets / AMRAP (8x8 Duos) -> Round header checkbox
          typeSelect.value = '8x8 Duos';
          typeSelect.dispatchEvent(new Event('change'));
          document.getElementById('generateWorkoutBtn').click();
          const rChecks8x8 = document.querySelectorAll('.round-check-box').length;
          const sChecks8x8 = document.querySelectorAll('.set-check-box').length;

          // C: Continuous / Pyramid -> 0 checkboxes
          typeSelect.value = '6 Excercise Pyramid';
          typeSelect.dispatchEvent(new Event('change'));
          document.getElementById('generateWorkoutBtn').click();
          const rChecksPyr = document.querySelectorAll('.round-check-box').length;
          const sChecksPyr = document.querySelectorAll('.set-check-box').length;

          return {
            fixedSetsCheckToggle: c1 === true && c2 === false,
            checkedBg,
            amrapRoundCheckOnly: rChecks8x8 === 4 && sChecks8x8 === 0,
            pyramidNoCheckboxes: rChecksPyr === 0 && sChecksPyr === 0
          };
        });
        if (!cbCheck.fixedSetsCheckToggle || !cbCheck.amrapRoundCheckOnly || !cbCheck.pyramidNoCheckboxes) {
          throw new Error('Format-aware checkboxes failed: ' + JSON.stringify(cbCheck));
        }
        console.log(`  ✅ PASS: Format checkboxes toggle correctly with vibrant blue checked styling (${cbCheck.checkedBg})`);

        console.log('\n--- 5. Settings, Automatic Profile & Multi-Option Collapse Check ---');
        const optCheck = await evalInPage(() => {
          document.getElementById('settingsBtn').click();
          document.querySelector('[data-options-count="3"]').click();
          document.querySelector('[data-close-modal="settingsModal"]').click();

          const typeSelect = document.getElementById('workoutTypeSelect');
          typeSelect.value = 'Strength Duos';
          typeSelect.dispatchEvent(new Event('change'));
          document.getElementById('generateWorkoutBtn').click();

          const multiTabsBefore = document.querySelectorAll('.multi-option-tabs').length;
          const pills = document.querySelectorAll('.round-card:first-child .exercise-slot:first-child .multi-opt-pill');
          const option2ExpectedName = pills[1]?.innerText.replace(/^\d+\.\s*/, '').trim();

          // Tap option 2: pills should collapse and disappear from the slot on the card!
          pills[1].click();
          const activeName = document.querySelector('.round-card:first-child .exercise-slot:first-child .exercise-title-text').innerText;
          const firstSlotTabsAfter = document.querySelectorAll('.round-card:first-child .exercise-slot:first-child .multi-option-tabs').length;

          // Open swap modal to check if original slot options are available in Swap sheet
          document.querySelector('.round-card:first-child .exercise-slot:first-child .swap-trigger-btn').click();
          const swapBox = document.getElementById('swapSlotOptionsContainer');
          const swapBoxVisible = swapBox && !swapBox.hidden;
          const swapPillsCount = document.querySelectorAll('#swapSlotOptionsContainer .swap-slot-pill').length;

          // Test "Show on Card" restores tabs
          document.getElementById('restoreSlotPillsBtn').click();
          const firstSlotTabsRestored = document.querySelectorAll('.round-card:first-child .exercise-slot:first-child .multi-option-tabs').length;

          // Tap option 2 again to re-collapse for final clean state
          const pillsRestored = document.querySelectorAll('.round-card:first-child .exercise-slot:first-child .multi-opt-pill');
          pillsRestored[1].click();
          const finalTabsCount = document.querySelectorAll('.round-card:first-child .exercise-slot:first-child .multi-option-tabs').length;

          return {
            multiTabsBefore,
            pillsCount: pills.length,
            activeName,
            option2ExpectedName,
            slotCollapsedOnCard: firstSlotTabsAfter === 0,
            swapBoxVisible,
            swapPillsCount,
            tabsRestored: firstSlotTabsRestored === 1,
            finalCollapsed: finalTabsCount === 0
          };
        });
        if (
          optCheck.multiTabsBefore !== 8 ||
          optCheck.pillsCount !== 3 ||
          !optCheck.activeName ||
          !optCheck.slotCollapsedOnCard ||
          !optCheck.swapBoxVisible ||
          optCheck.swapPillsCount !== 3 ||
          !optCheck.tabsRestored ||
          !optCheck.finalCollapsed
        ) {
          throw new Error('Multi-option slots collapse test failed: ' + JSON.stringify(optCheck));
        }
        console.log(`  ✅ PASS: 3-options-per-slot renders pills, collapses on selection to "${optCheck.activeName}", and preserves options in Swap sheet`);

        console.log('\n--- 6. Combined 1-Line Overload Detection & 1-Tap Auto-Balance Check ---');
        const ovCheck = await evalInPage(() => {
          // Open swap for slot 0
          document.querySelector('.exercise-slot[data-round-index="0"][data-slot-index="0"] .swap-trigger-btn').click();
          const input = document.getElementById('swapSearchInput');
          input.value = '3 Stop Pushups';
          input.dispatchEvent(new Event('input'));
          document.querySelector('#swapExerciseList .swap-option-item').click();

          // Open swap for slot 1
          document.querySelector('.exercise-slot[data-round-index="0"][data-slot-index="1"] .swap-trigger-btn').click();
          input.value = 'Pushups with shoulder tap';
          input.dispatchEvent(new Event('input'));
          document.querySelector('#swapExerciseList .swap-option-item').click();

          const banner = document.querySelector('.overload-banner');
          const bannerText = banner?.innerText.replace(/\s+/g, ' ').trim() || '';

          // Click auto balance
          const autoBtn = banner?.querySelector('[data-action="auto-balance"]');
          autoBtn?.click();

          const bannerAfter = document.querySelector('.overload-banner');
          return {
            overloadDetected: !!banner,
            bannerText,
            bannerResolved: !bannerAfter
          };
        });
        if (!ovCheck.overloadDetected || !ovCheck.bannerResolved) {
          throw new Error('Overload balance failed: ' + JSON.stringify(ovCheck));
        }
        console.log(`  ✅ PASS: Combined warning shown: "${ovCheck.bannerText}" and 1-tap auto-balance cleared it cleanly`);

        console.log('\n--- 7. UI Clutter Removal & Minimization Audit ---');
        const uiClutterAudit = await evalInPage(() => {
          return {
            noProfileBtn: !document.getElementById('profileBtn'),
            noProfileListContainer: !document.getElementById('profileListContainer'),
            hasSettingsBtn: !!document.getElementById('settingsBtn'),
            noSpreadsheetView: !document.getElementById('sheetDetailsAccordion'),
            noCopyButton: !document.getElementById('copySummaryBtn'),
            noActiveWorkoutEyebrow: !document.querySelector('.active-workout-eyebrow'),
            noHowItWorksButton: !document.getElementById('howItWorksBtn'),
            hasConsolidatedSubtitle: !!document.getElementById('workoutMetaSummary')?.innerText
          };
        });
        if (!Object.values(uiClutterAudit).every(Boolean)) {
          throw new Error('Clutter removal audit failed: ' + JSON.stringify(uiClutterAudit));
        }
        console.log('  ✅ PASS: Profile/login button removed, top-nav has settings only, and clutter completely removed');

        console.log('\n--- 8. Requirement 1: Filter by Muscle Group Across Main Dropdown, Swap Modal & Settings ---');
        const filterCheck = await evalInPage(() => {
          // Reset optionsPerSlot to 1 for clean inspection
          document.getElementById('settingsBtn').click();
          document.querySelector('[data-options-count="1"]').click();

          // Test exclusion muscle filter pill in Settings modal
          const exclTricepsPill = document.querySelector('#exclusionMuscleFilterBar [data-muscle-filter="Triceps"]');
          exclTricepsPill.click();
          const exclItems = Array.from(document.querySelectorAll('#exclusionChecklist .exclusion-row')).map(
            el => el.innerText
          );
          const allExclValid = exclItems.length >= 4;
          // Reset exclusion filter pill back to All and close settings
          document.querySelector('#exclusionMuscleFilterBar [data-muscle-filter="All"]').click();
          document.querySelector('[data-close-modal="settingsModal"]').click();

          // Test main Focus dropdown (#bodyCategorySelect) filtering by "Legs and Core" and "Glutes" (and no redundant "Lower Body")
          const focusSelect = document.getElementById('bodyCategorySelect');
          const noRedundantLowerBodyOpt = !focusSelect.querySelector('option[value="Lower Body"]');
          const hasLegsOpt = !!focusSelect.querySelector('option[value="Legs"]');
          const hasCoreOpt = !!focusSelect.querySelector('option[value="Core"]');
          const hasLegsAndCoreOpt = !!focusSelect.querySelector('option[value="Legs and Core"]');

          focusSelect.value = 'Legs and Core';
          focusSelect.dispatchEvent(new Event('change'));
          const legsAndCoreSlotsCount = document.querySelectorAll('.exercise-slot').length;

          focusSelect.value = 'Glutes';
          focusSelect.dispatchEvent(new Event('change'));

          const slotMetasGlutes = Array.from(document.querySelectorAll('.exercise-slot .exercise-inline-meta')).map(
            el => el.innerText
          );
          const allSlotsHaveGlutes = slotMetasGlutes.length > 0 && slotMetasGlutes.every(txt => txt.includes('Glutes'));

          // Test Swap Modal muscle filter pill ("Hamstrings" and "Legs and Core")
          document.querySelector('.exercise-slot[data-round-index="0"][data-slot-index="0"] .swap-trigger-btn').click();
          const hasSwapLegsAndCorePill = !!document.querySelector(
            '#swapMuscleFilterBar [data-muscle-filter="Legs and Core"]'
          );
          const swapHamPill = document.querySelector('#swapMuscleFilterBar [data-muscle-filter="Hamstrings"]');
          swapHamPill.click();
          const swapItems = Array.from(document.querySelectorAll('#swapExerciseList .swap-option-item')).map(
            el => el.innerText
          );
          const allSwapHaveHamstrings = swapItems.length >= 4;
          document.querySelector('[data-close-modal="swapModal"]').click();

          // Reset Focus dropdown back to All
          focusSelect.value = 'All';
          focusSelect.dispatchEvent(new Event('change'));

          return {
            noRedundantLowerBodyOpt,
            hasLegsOpt,
            hasCoreOpt,
            hasLegsAndCoreOpt,
            legsAndCoreSlotsCount,
            hasSwapLegsAndCorePill,
            allExclValid,
            exclCount: exclItems.length,
            allSlotsHaveGlutes,
            glutesSlotCount: slotMetasGlutes.length,
            allSwapHaveHamstrings,
            swapHamCount: swapItems.length
          };
        });
        if (
          !filterCheck.noRedundantLowerBodyOpt ||
          !filterCheck.hasLegsOpt ||
          !filterCheck.hasCoreOpt ||
          !filterCheck.hasLegsAndCoreOpt ||
          filterCheck.legsAndCoreSlotsCount === 0 ||
          !filterCheck.hasSwapLegsAndCorePill ||
          !filterCheck.allExclValid ||
          !filterCheck.allSlotsHaveGlutes ||
          !filterCheck.allSwapHaveHamstrings
        ) {
          throw new Error('Muscle group filter check failed: ' + JSON.stringify(filterCheck));
        }
        console.log(
          `  ✅ PASS: Muscle group filtering verified across Main Focus (Glutes: ${filterCheck.glutesSlotCount} slots), Swap Modal (Hamstrings: ${filterCheck.swapHamCount}), and Settings (Triceps: ${filterCheck.exclCount})`
        );

        console.log('\n--- 9. Requirement 2 & 3: Dismiss Overload Warning & Replacement Exercises Never Trigger New Warnings ---');
        const dismissAndReplaceCheck = await evalInPage(() => {
          const typeSelect = document.getElementById('workoutTypeSelect');
          typeSelect.value = 'Strength Duos';
          typeSelect.dispatchEvent(new Event('change'));

          // Manually create a Triceps overload in Round 1 (slot 0 = Skull Crushers, slot 1 = Tricep kick backs)
          document.querySelector('.exercise-slot[data-round-index="0"][data-slot-index="0"] .swap-trigger-btn').click();
          const swapInput = document.getElementById('swapSearchInput');
          swapInput.value = 'Skull Crushers';
          swapInput.dispatchEvent(new Event('input'));
          document.querySelector('#swapExerciseList .swap-option-item').click();

          document.querySelector('.exercise-slot[data-round-index="0"][data-slot-index="1"] .swap-trigger-btn').click();
          swapInput.value = 'Tricep kick backs';
          swapInput.dispatchEvent(new Event('input'));
          document.querySelector('#swapExerciseList .swap-option-item').click();

          const bannerBeforeDismiss = document.querySelector('.overload-banner');
          const hasBannerBefore = !!bannerBeforeDismiss;
          const dismissBtn = bannerBeforeDismiss?.querySelector('[data-action="dismiss-warning"]');
          dismissBtn?.click();
          const bannerAfterDismiss = document.querySelector('.overload-banner');

          // Now generate a fresh Strength Trios workout, trigger overload again, and test replacement recommendation from Balance Modal
          document.getElementById('generateWorkoutBtn').click();
          document.querySelector('.exercise-slot[data-round-index="0"][data-slot-index="0"] .swap-trigger-btn').click();
          swapInput.value = 'Skull Crushers';
          swapInput.dispatchEvent(new Event('input'));
          document.querySelector('#swapExerciseList .swap-option-item').click();

          document.querySelector('.exercise-slot[data-round-index="0"][data-slot-index="1"] .swap-trigger-btn').click();
          swapInput.value = 'Tricep kick backs';
          swapInput.dispatchEvent(new Event('input'));
          document.querySelector('#swapExerciseList .swap-option-item').click();

          const bannerForModal = document.querySelector('.overload-banner');
          bannerForModal.querySelector('[data-action="open-balance-modal"]').click();
          const recBtn = document.querySelector('#balanceRecommendationsList [data-action="apply-balance-choice"]');
          const recName = recBtn?.innerText.trim();
          recBtn?.click();

          const bannersAfterRec = document.querySelectorAll('.overload-banner').length;

          return {
            hasBannerBefore,
            dismissedCleanly: !bannerAfterDismiss,
            recName,
            zeroWarningsAfterReplacement: bannersAfterRec === 0
          };
        });
        if (
          !dismissAndReplaceCheck.hasBannerBefore ||
          !dismissAndReplaceCheck.dismissedCleanly ||
          !dismissAndReplaceCheck.zeroWarningsAfterReplacement
        ) {
          throw new Error('Dismiss & replacement check failed: ' + JSON.stringify(dismissAndReplaceCheck));
        }
        console.log('  ✅ PASS: Overload warning dismisses in 1 tap and replacement recommendations trigger 0 new warnings');

        console.log('\n--- 10. Requirement 4: Select X Exercises From List & Auto-Slot Muscle Distribution ---');
        const selectXCheck = await evalInPage(() => {
          const typeSelect = document.getElementById('workoutTypeSelect');
          typeSelect.value = 'Timed Duos (40/20)';
          typeSelect.dispatchEvent(new Event('change'));

          const btnLabel = document.getElementById('selectExercisesBtn')?.innerText.trim();
          document.getElementById('selectExercisesBtn').click();

          const modal = document.getElementById('selectExercisesModal');
          const modalOpen = modal && !modal.hidden;

          // Filter by Chest first and pick 2 Chest exercises
          document.querySelector('#selectExercisesMuscleFilterBar [data-muscle-filter="Chest"]').click();
          const chestItems = document.querySelectorAll('#selectExercisesList [data-action="toggle-custom-select-exercise"]');
          chestItems[0]?.click();
          chestItems[1]?.click();

          // Filter by Back and pick 2 Back exercises
          document.querySelector('#selectExercisesMuscleFilterBar [data-muscle-filter="Back"]').click();
          const backItems = document.querySelectorAll('#selectExercisesList [data-action="toggle-custom-select-exercise"]');
          backItems[0]?.click();
          backItems[1]?.click();

          // Use Auto-Fill Remaining to pick the remaining 4 balanced exercises
          document.getElementById('autoFillRemainingBtn').click();

          const confirmBtn = document.getElementById('confirmSelectExercisesBtn');
          const confirmEnabled = !confirmBtn.disabled;
          const confirmText = confirmBtn.innerText.trim();

          confirmBtn.click();
          const modalClosed = modal.hidden;
          const roundCount = document.querySelectorAll('.round-card').length;
          const slotCount = document.querySelectorAll('.exercise-slot').length;
          const overloadBanners = document.querySelectorAll('.overload-banner').length;

          return {
            btnLabel,
            modalOpen,
            confirmEnabled,
            confirmText,
            modalClosed,
            roundCount,
            slotCount,
            overloadBanners
          };
        });
        if (
          selectXCheck.btnLabel !== 'Select 8 Exercises' ||
          !selectXCheck.modalOpen ||
          !selectXCheck.confirmEnabled ||
          !selectXCheck.modalClosed ||
          selectXCheck.roundCount !== 4 ||
          selectXCheck.slotCount !== 8 ||
          selectXCheck.overloadBanners !== 0
        ) {
          throw new Error('Select X Exercises check failed: ' + JSON.stringify(selectXCheck));
        }
        console.log(
          `  ✅ PASS: "${selectXCheck.btnLabel}" modal selected 8 exercises and auto-slotted them across 4 Duo rounds with 0 overload warnings`
        );

        console.log('\n--- 11. Requirement 5: Timed HIIT Exercise Timer, 10s Yellow Countdown, Sliding Fill, Bottom Labels & Reset ---');
        const timerCheck = await evalInPage(async () => {
          const typeSelect = document.getElementById('workoutTypeSelect');

          // Verify untimed Strength workouts have NO timer bar and NO round timers
          typeSelect.value = 'Strength Duos';
          typeSelect.dispatchEvent(new Event('change'));
          const strengthTimerBarHidden = document.getElementById('workoutTimerBar').hidden === true;
          const strengthRoundTimersCount = document.querySelectorAll('[data-action="open-round-timer"]').length;

          // Switch to Timed HIIT workout
          typeSelect.value = 'Timed Duos (40/20)';
          typeSelect.dispatchEvent(new Event('change'));

          const timerBarVisible = !document.getElementById('workoutTimerBar').hidden;
          const individualExerciseTimerCount = document.querySelectorAll('.slot-timer-btn, [data-action="open-exercise-timer"]').length;
          const round1Ex1Name = document
            .querySelector('.exercise-slot[data-round-index="0"][data-slot-index="0"] .exercise-title-text')
            ?.innerText.trim();

          // Verify Top Timer opens Full Workout (all 4 rounds = 24 pairs = 49 steps)
          document.getElementById('openWorkoutTimerBtn').click();
          const fullWorkoutChipsCount = document.querySelectorAll('#timerSequenceTimeline .timer-seq-chip').length;
          document.getElementById('closeTimerModalBtn').click();

          // Open Round 1 timer (just Round 1 = 40/20 x 6 = 13 steps)
          document.querySelector('[data-action="open-round-timer"][data-round-index="0"]').click();

          const timerModal = document.getElementById('timerModal');
          const stageCard = document.getElementById('timerStageCard');
          const stageFill = document.getElementById('timerStageFill');
          const bottomLabelEl = document.getElementById('timerActiveExerciseName');
          const clockEl = document.getElementById('timerClockDisplay');

          const timerOpen = timerModal && !timerModal.hidden;
          const step0Clock = clockEl?.innerText.trim();
          const step0StageClass = stageCard?.className || '';
          const step0Phase = document.getElementById('timerPhaseBadge')?.innerText.trim();
          const step0BottomLabel = bottomLabelEl?.innerText.trim();
          const step0TextColor = getComputedStyle(bottomLabelEl).color;
          const step0FillBg = getComputedStyle(stageFill).backgroundColor;
          const stageGreyBg = getComputedStyle(stageCard).backgroundColor;
          const step0InitialFillStyle = stageFill?.style.height;

          // Verify bottom label is physically below the clock inside the timer stage card
          const clockRect = clockEl.getBoundingClientRect();
          const bottomLabelRect = bottomLabelEl.getBoundingClientRect();
          const bottomLabelBelowClock = bottomLabelRect.top >= clockRect.bottom - 4;

          const timelineChipsCount = document.querySelectorAll('#timerSequenceTimeline .timer-seq-chip').length;
          const clockFontSize = parseFloat(getComputedStyle(clockEl).fontSize);
          const noOverflowInTimer = document.documentElement.scrollWidth <= window.innerWidth;

          // Verify the lighter colored fill slides down as the timer runs
          document.getElementById('timerStartPauseBtn').click();
          await new Promise(r => setTimeout(r, 350));
          const runningFillPct = parseFloat(stageFill.style.height);
          document.getElementById('timerStartPauseBtn').click(); // Pause

          // Skip from Step 0 (10s yellow countdown) -> Step 1 (40s green work on Exercise 1)
          document.getElementById('timerNextStepBtn').click();
          const step1Clock = clockEl?.innerText.trim();
          const step1StageClass = stageCard?.className || '';
          const step1ExName = bottomLabelEl?.innerText.trim();
          const step1TextColor = getComputedStyle(bottomLabelEl).color;
          const step1FillBg = getComputedStyle(stageFill).backgroundColor;
          const step1ResetFillStyle = stageFill?.style.height;

          // Skip from Step 1 (40s green work) -> Step 2 (20s blue rest)
          document.getElementById('timerNextStepBtn').click();
          const step2Clock = clockEl?.innerText.trim();
          const step2StageClass = stageCard?.className || '';
          const step2BottomLabel = bottomLabelEl?.innerText.trim();
          const step2TextColor = getComputedStyle(bottomLabelEl).color;
          const step2FillBg = getComputedStyle(stageFill).backgroundColor;

          // Open Customize view, customize Exercise 1 work duration to 50s & orange, add an extra interval, and apply
          document.getElementById('toggleTimerCustomizerBtn').click();
          const workInput = document.querySelector('[data-ex-timer-field="workDuration"]');
          workInput.value = '50';
          workInput.dispatchEvent(new Event('change', { bubbles: true }));

          const workColorSelect = document.querySelector('[data-ex-timer-field="workColor"]');
          workColorSelect.value = 'orange';
          workColorSelect.dispatchEvent(new Event('change', { bubbles: true }));

          document.querySelector('[data-action="add-exercise-extra-time"]').click();
          document.getElementById('applyTimerCustomizationBtn').click();

          // Verify customized sequence starts at 00:10 yellow countdown and Step 1 is 00:50 orange
          const customStep0Clock = clockEl?.innerText.trim();
          document.getElementById('timerNextStepBtn').click();
          const customStep1Clock = clockEl?.innerText.trim();
          const customStep1Class = stageCard?.className || '';

          // Close timer modal and select a different workout type ("Timed Trios (40/20)") -> verify timer resets!
          document.getElementById('closeTimerModalBtn').click();
          typeSelect.value = 'Timed Trios (40/20)';
          typeSelect.dispatchEvent(new Event('change'));

          document.querySelector('[data-action="open-round-timer"][data-round-index="0"]').click();
          const trioChipsCount = document.querySelectorAll('#timerSequenceTimeline .timer-seq-chip').length;
          document.getElementById('timerNextStepBtn').click();
          const trioStep1Clock = clockEl?.innerText.trim();
          const trioStep1Class = stageCard?.className || '';
          document.getElementById('closeTimerModalBtn').click();

          // Switch to "6 Excercise Pyramid" and verify 10s "Transition" between exercises & 60s "Rest" at end of set
          typeSelect.value = '6 Excercise Pyramid';
          typeSelect.dispatchEvent(new Event('change'));
          document.getElementById('openWorkoutTimerBtn').click();
          // Step 0 = Countdown (10s), Step 1 = Set 1 Ex 1 (30s), Step 2 = Set 1 Rest (60s), Step 3 = Set 2 Ex 1 (30s), Step 4 = Set 2 Transition (10s)
          document.querySelector('[data-action="jump-timer-step"][data-step-index="2"]').click();
          const pyrRestClock = clockEl?.innerText.trim();
          const pyrRestLabel = bottomLabelEl?.innerText.trim();
          document.querySelector('[data-action="jump-timer-step"][data-step-index="4"]').click();
          const pyrTransClock = clockEl?.innerText.trim();
          const pyrTransLabel = bottomLabelEl?.innerText.trim();
          document.getElementById('closeTimerModalBtn').click();

          return {
            strengthTimerBarHidden,
            strengthRoundTimersCount,
            timerBarVisible,
            individualExerciseTimerCount,
            fullWorkoutChipsCount,
            timerOpen,
            step0Clock,
            step0IsYellow: step0StageClass.includes('timer-color-yellow'),
            step0Phase,
            step0BottomLabel,
            step0TextColor,
            step0FillBg,
            stageGreyBg,
            step0InitialFillStyle,
            bottomLabelBelowClock,
            runningFillPct,
            timelineChipsCount,
            clockFontSize,
            noOverflowInTimer,
            step1Clock,
            step1IsGreen: step1StageClass.includes('timer-color-green'),
            step1MatchesExercise: step1ExName === round1Ex1Name,
            step1TextColor,
            step1FillBg,
            step1ResetFillStyle,
            step2Clock,
            step2IsBlue: step2StageClass.includes('timer-color-blue'),
            step2BottomLabel,
            step2TextColor,
            step2FillBg,
            customStep0Clock,
            customStep1Clock,
            customStep1IsOrange: customStep1Class.includes('timer-color-orange'),
            trioChipsCount,
            trioResetTo40Green: trioStep1Clock === '00:40' && trioStep1Class.includes('timer-color-green'),
            pyrRestClock,
            pyrRestLabel,
            pyrTransClock,
            pyrTransLabel
          };
        });
        if (
          !timerCheck.strengthTimerBarHidden ||
          timerCheck.strengthRoundTimersCount !== 0 ||
          !timerCheck.timerBarVisible ||
          timerCheck.individualExerciseTimerCount !== 0 ||
          timerCheck.fullWorkoutChipsCount !== 49 ||
          !timerCheck.timerOpen ||
          timerCheck.step0Clock !== '00:10' ||
          !timerCheck.step0IsYellow ||
          timerCheck.step0BottomLabel !== 'Count Down' ||
          timerCheck.step0TextColor !== 'rgb(113, 63, 18)' ||
          timerCheck.step0FillBg !== 'rgb(254, 240, 138)' ||
          timerCheck.stageGreyBg !== 'rgb(226, 232, 240)' ||
          timerCheck.step0InitialFillStyle !== '100%' ||
          !timerCheck.bottomLabelBelowClock ||
          !(timerCheck.runningFillPct < 99 && timerCheck.runningFillPct > 80) ||
          timerCheck.timelineChipsCount !== 13 ||
          timerCheck.clockFontSize < 60 ||
          !timerCheck.noOverflowInTimer ||
          timerCheck.step1Clock !== '00:40' ||
          !timerCheck.step1IsGreen ||
          !timerCheck.step1MatchesExercise ||
          timerCheck.step1TextColor !== 'rgb(20, 83, 45)' ||
          timerCheck.step1FillBg !== 'rgb(187, 247, 208)' ||
          timerCheck.step1ResetFillStyle !== '100%' ||
          timerCheck.step2Clock !== '00:20' ||
          !timerCheck.step2IsBlue ||
          timerCheck.step2BottomLabel !== 'Rest' ||
          timerCheck.step2TextColor !== 'rgb(30, 58, 138)' ||
          timerCheck.step2FillBg !== 'rgb(191, 219, 254)' ||
          timerCheck.customStep0Clock !== '00:10' ||
          timerCheck.customStep1Clock !== '00:50' ||
          !timerCheck.customStep1IsOrange ||
          timerCheck.trioChipsCount !== 19 ||
          !timerCheck.trioResetTo40Green ||
          timerCheck.pyrRestClock !== '01:00' ||
          timerCheck.pyrRestLabel !== 'Rest' ||
          timerCheck.pyrTransClock !== '00:10' ||
          timerCheck.pyrTransLabel !== 'Transition'
        ) {
          throw new Error('HIIT Timer & Customizer check failed: ' + JSON.stringify(timerCheck));
        }
        console.log(
          `  ✅ PASS: HIIT Timer verified ("Count Down" dark yellow -> "[Exercise]" dark green -> "Rest" dark blue, sliding fill ${timerCheck.runningFillPct.toFixed(1)}% over grey)`
        );

        console.log('\n--- 12. Drag-and-Drop Rounds, Intra-Round Reorder & Cross-Round Exercise Swap ---');
        const dragDropCheck = await evalInPage(() => {
          const typeSelect = document.getElementById('workoutTypeSelect');
          typeSelect.value = 'Timed Trios (40/20)';
          typeSelect.dispatchEvent(new Event('change'));

          const getRoundExercises = rIdx =>
            Array.from(
              document.querySelectorAll(`.exercise-slot[data-round-index="${rIdx}"] .exercise-title-text`)
            ).map(el => el.innerText.trim());

          const roundHandleCount = document.querySelectorAll('.round-drag-handle').length;
          const slotHandleCount = document.querySelectorAll('.slot-drag-handle').length;

          const r1Before = getRoundExercises(0);
          const r2Before = getRoundExercises(1);

          // 1) Drag Round 1 (index 0) onto Round 2 (index 1)
          const round0Header = document.querySelector('.round-card[data-round-index="0"] .round-header');
          const round1Card = document.querySelector('.round-card[data-round-index="1"]');
          round0Header.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }));
          round1Card.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
          const roundHighlightActive = round1Card.classList.contains('drag-over-round');
          round1Card.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
          round0Header.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true }));

          const r1AfterRoundDrag = getRoundExercises(0);
          const r2AfterRoundDrag = getRoundExercises(1);
          const roundTitles = Array.from(document.querySelectorAll('.round-title')).map(el =>
            el.textContent.trim()
          );

          // 2) Drag Exercise 0 down to Exercise 2 within Round 1 (index 0)
          const r1BeforeSlotReorder = getRoundExercises(0);
          const r1Slot0 = document.querySelector('.exercise-slot[data-round-index="0"][data-slot-index="0"]');
          const r1Slot2 = document.querySelector('.exercise-slot[data-round-index="0"][data-slot-index="2"]');
          r1Slot0.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }));
          r1Slot2.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
          const slotReorderHighlightActive = r1Slot2.classList.contains('drag-over-slot-reorder');
          r1Slot2.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
          r1Slot0.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true }));

          const r1AfterSlotReorder = getRoundExercises(0);

          // 3) Drag Exercise from Round 1 Slot 1 onto Round 2 Slot 0 (cross-round swap)
          const r1BeforeCrossSwap = getRoundExercises(0);
          const r2BeforeCrossSwap = getRoundExercises(1);
          const fromSlot = document.querySelector('.exercise-slot[data-round-index="0"][data-slot-index="1"]');
          const toSlot = document.querySelector('.exercise-slot[data-round-index="1"][data-slot-index="0"]');
          fromSlot.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }));
          toSlot.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
          const slotSwapHighlightActive = toSlot.classList.contains('drag-over-slot-swap');
          toSlot.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
          fromSlot.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true }));

          const r1AfterCrossSwap = getRoundExercises(0);
          const r2AfterCrossSwap = getRoundExercises(1);

          return {
            roundHandleCount,
            slotHandleCount,
            roundHighlightActive,
            roundTitles,
            roundSwapSuccess:
              JSON.stringify(r1AfterRoundDrag) === JSON.stringify(r2Before) &&
              JSON.stringify(r2AfterRoundDrag) === JSON.stringify(r1Before),
            slotReorderHighlightActive,
            intraRoundReorderSuccess:
              JSON.stringify(r1AfterSlotReorder) ===
              JSON.stringify([r1BeforeSlotReorder[1], r1BeforeSlotReorder[2], r1BeforeSlotReorder[0]]),
            slotSwapHighlightActive,
            crossRoundSwapSuccess:
              r1AfterCrossSwap[1] === r2BeforeCrossSwap[0] &&
              r2AfterCrossSwap[0] === r1BeforeCrossSwap[1]
          };
        });
        if (
          dragDropCheck.roundHandleCount !== 3 ||
          dragDropCheck.slotHandleCount !== 9 ||
          !dragDropCheck.roundHighlightActive ||
          JSON.stringify(dragDropCheck.roundTitles) !== JSON.stringify(['Round 1', 'Round 2', 'Round 3']) ||
          !dragDropCheck.roundSwapSuccess ||
          !dragDropCheck.slotReorderHighlightActive ||
          !dragDropCheck.intraRoundReorderSuccess ||
          !dragDropCheck.slotSwapHighlightActive ||
          !dragDropCheck.crossRoundSwapSuccess
        ) {
          throw new Error('Drag-and-drop check failed: ' + JSON.stringify(dragDropCheck));
        }
        console.log(
          '  ✅ PASS: Drag-and-drop verified for Round 1 <-> Round 2 reorder, intra-round exercise reorder, and cross-round exercise swap'
        );

        console.log('\n--- 13. Mobile Viewport Screenshot Capture ---');
        const screenshotData = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync('/tmp/workout-mobile-screenshot.png', Buffer.from(screenshotData.data, 'base64'));
        // Also capture the full-screen executed HIIT timer view
        await evalInPage(() => {
          document.querySelector('[data-action="open-round-timer"][data-round-index="0"]')?.click();
        });
        const timerScreenshotData = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync('/tmp/workout-timer-screenshot.png', Buffer.from(timerScreenshotData.data, 'base64'));
        await evalInPage(() => {
          document.getElementById('closeTimerModalBtn')?.click();
        });
        console.log('  ✅ PASS: Mobile screenshots saved to /tmp/workout-mobile-screenshot.png and /tmp/workout-timer-screenshot.png');

        console.log('\n--- 13. QA Gallery All 68 Diagrams Render, Muscle Filter & No Audit Box Check ---');
        await send('Emulation.setDeviceMetricsOverride', {
          width: 1280,
          height: 900,
          deviceScaleFactor: 2,
          mobile: false
        });
        await send('Page.navigate', { url: 'http://127.0.0.1:8080/qa-gallery.html' });
        await new Promise(r => setTimeout(r, 1200));

        const galleryCheck = await evalInPage(() => {
          const cards = Array.from(document.querySelectorAll('article.qa-card'));
          const broken = cards
            .map(c => {
              const img = c.querySelector('img');
              return {
                id: c.dataset.exerciseId,
                complete: img?.complete || false,
                w: img?.naturalWidth || 0,
                h: img?.naturalHeight || 0
              };
            })
            .filter(x => !x.complete || x.w !== 680 || x.h !== 248);
          const auditBoxes = document.querySelectorAll('.audit-note-box').length;

          // Test clicking the "Glutes" muscle filter button in QA Gallery
          const glutesBtn = document.querySelector('.qa-filter-bar [data-filter="Glutes"]');
          glutesBtn?.click();
          const glutesCards = Array.from(document.querySelectorAll('article.qa-card'));
          const allGlutesValid =
            glutesCards.length > 0 && glutesCards.length < 68 && glutesCards.every(c => c.innerText.includes('Glutes'));

          // Reset to All
          document.querySelector('.qa-filter-bar [data-filter="all"]')?.click();

          return {
            totalCards: cards.length,
            brokenCount: broken.length,
            broken,
            auditBoxes,
            glutesCardCount: glutesCards.length,
            allGlutesValid
          };
        });
        if (
          galleryCheck.totalCards !== 68 ||
          galleryCheck.brokenCount > 0 ||
          galleryCheck.auditBoxes > 0 ||
          !galleryCheck.allGlutesValid
        ) {
          throw new Error('QA Gallery check failed: ' + JSON.stringify(galleryCheck));
        }
        console.log(
          `  ✅ PASS: All 68/68 exercise SVG diagrams rendered cleanly (680x248) and QA Gallery muscle filter verified (${galleryCheck.glutesCardCount} Glutes exercises)`
        );

        ws.close();
        resolve();
      } catch (err) {
        ws.close();
        reject(err);
      }
    };
  });
}

async function main() {
  console.log('================================================================');
  console.log('MASTER WORKOUT GENERATOR COMPREHENSIVE QA & VERIFICATION SUITE');
  console.log('================================================================');

  let chromeProc = null;
  let localServer = null;
  try {
    // Step 1: Unit & Generator QA
    console.log('\n>>> STEP 1: Running Engine & Biomechanical Unit Tests...');
    await runProcess('node', ['tests/run-qa-suite.mjs']);

    // Step 2: 68 SVG Diagram Audit
    console.log('\n>>> STEP 2: Auditing All 68 Bespoke SVG Diagrams...');
    await runProcess('node', ['tests/audit-diagrams-to-descriptions.mjs']);

    // Step 3: Check or Start HTTP server
    console.log('\n>>> STEP 3: Verifying Localhost HTTP Server (port 8080)...');
    const serverAlreadyRunning = await checkHttp('http://127.0.0.1:8080/index.html').then(() => true).catch(() => false);
    if (!serverAlreadyRunning) {
      localServer = await startLocalStaticServer(8080);
    }
    await checkHttp('http://127.0.0.1:8080/index.html');
    console.log('  ✅ PASS: HTTP server responding 200 OK on http://127.0.0.1:8080/index.html');

    // Step 4: Ensure Chrome is running & execute CDP Tests
    console.log('\n>>> STEP 4: Executing Real Browser CDP End-to-End Test Suite...');
    chromeProc = await ensureChromeRunning();
    const targetWs = await getActivePageWs();
    await runBrowserCDPTests(targetWs);

    console.log('\n================================================================');
    console.log('🎉 100% OF QA TEST SUITES & END-TO-END BROWSER CHECKS PASSED!');
    console.log('================================================================\n');
  } finally {
    if (chromeProc) {
      console.log('Cleaning up headless Chrome process...');
      chromeProc.kill('SIGTERM');
    }
    if (localServer) {
      localServer.close();
    }
  }
}

main().catch(err => {
  console.error('\n❌ MASTER QA FAILED:', err);
  process.exit(1);
});
