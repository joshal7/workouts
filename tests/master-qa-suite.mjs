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
    '--autoplay-policy=no-user-gesture-required',
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

        const pageErrors = [];
        ws.addEventListener('message', evt => {
          try {
            const msg = JSON.parse(evt.data);
            if (msg.method === 'Runtime.exceptionThrown') {
              pageErrors.push(msg.params?.exceptionDetails?.text || JSON.stringify(msg.params));
            }
          } catch {}
        });

        // Emulate iPhone viewport (390 x 844)
        await send('Emulation.setDeviceMetricsOverride', {
          width: 390,
          height: 844,
          deviceScaleFactor: 3,
          mobile: true
        });

        // Ensure page is on our app (allow time for any SW controllerchange reload & stylesheet + bootstrap to settle)
        await send('Page.navigate', { url: 'http://127.0.0.1:8080/index.html' });
        await new Promise(r => setTimeout(r, 1200));
        for (let attempt = 0; attempt < 25; attempt++) {
          const ready = await evalInPage(() => {
            const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim();
            const slots = document.querySelectorAll('.exercise-slot').length;
            return document.readyState === 'complete' && bg !== '' && slots > 0;
          }).catch(() => false);
          if (ready) break;
          await new Promise(r => setTimeout(r, 150));
        }
        if (pageErrors.length > 0) {
          throw new Error('Uncaught browser JS exception(s): ' + pageErrors.join(' | '));
        }

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

        console.log('\n--- 3. Exercise Details, No Spreadsheet Mention & Bespoke SVG Diagrams Check ---');
        const exCheck = await evalInPage(() => {
          document.querySelector('.exercise-name-btn').click();
          const modal = document.getElementById('exerciseModal');
          const isOpen = modal && !modal.hidden;
          const title = document.getElementById('exerciseModalTitle')?.innerText;
          const modalText = modal?.innerText || '';
          const noSpreadsheetMention = !/sheet\s*row|spreadsheet|row\s*#\s*\d+/i.test(modalText);
          const imgSrc = document.getElementById('exerciseModalDiagram')?.getAttribute('src');
          const stepsCount = document.querySelectorAll('#exerciseModalSteps li').length;
          document.querySelector('[data-close-modal="exerciseModal"]').click();
          return { isOpen, title, imgSrc, stepsCount, noSpreadsheetMention };
        });
        if (!exCheck.isOpen || !exCheck.imgSrc || exCheck.stepsCount === 0 || !exCheck.noSpreadsheetMention) {
          throw new Error('Exercise detail modal failed: ' + JSON.stringify(exCheck));
        }
        console.log(`  ✅ PASS: Exercise modal for "${exCheck.title}" loads SVG diagram (${exCheck.imgSrc}), instructions, and has 0 spreadsheet mentions`);

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

        console.log('\n--- 8. Top Menu 1-Row Layout (375px & 390px), 3-Part Focus Slider, Deselect/Reselect, Drag & Modal Filters ---');
        // First test narrow 375px iPhone SE/Mini width for Top Menu layout squishing/overflow
        await send('Emulation.setDeviceMetricsOverride', {
          width: 375,
          height: 812,
          deviceScaleFactor: 3,
          mobile: true
        });
        const narrow375MenuCheck = await evalInPage(() => {
          const cells = Array.from(document.querySelectorAll('.top-menu-row .top-menu-cell'));
          const rects = cells.map(c => c.getBoundingClientRect());
          const labels = cells.map(c => c.querySelector('label')?.getBoundingClientRect());
          const selects = cells.map(c => c.querySelector('select')?.getBoundingClientRect());
          const focusRect = document.getElementById('focusSliderSection')?.getBoundingClientRect();
          const rowRect = document.querySelector('.top-menu-row')?.getBoundingClientRect();
          return {
            cellCount: cells.length,
            sameRow:
              rects.length === 3 &&
              Math.abs(rects[0].top - rects[1].top) < 2 &&
              Math.abs(rects[1].top - rects[2].top) < 2,
            nonOverlapping:
              rects.length === 3 &&
              rects[0].right <= rects[1].left + 1 &&
              rects[1].right <= rects[2].left + 1,
            labelsAboveSelects:
              labels.length === 3 &&
              labels.every((l, idx) => l && selects[idx] && l.bottom <= selects[idx].top + 4),
            aboveFocusSection: !!(rowRect && focusRect && rowRect.bottom <= focusRect.top + 4),
            noHorizontalOverflow:
              document.documentElement.scrollWidth <= window.innerWidth &&
              document.body.scrollWidth <= window.innerWidth,
            minSelectWidth: Math.min(...selects.map(s => s?.width || 0))
          };
        });
        if (
          narrow375MenuCheck.cellCount !== 3 ||
          !narrow375MenuCheck.sameRow ||
          !narrow375MenuCheck.nonOverlapping ||
          !narrow375MenuCheck.labelsAboveSelects ||
          !narrow375MenuCheck.aboveFocusSection ||
          !narrow375MenuCheck.noHorizontalOverflow ||
          narrow375MenuCheck.minSelectWidth < 80
        ) {
          throw new Error('Top menu 375px layout check failed: ' + JSON.stringify(narrow375MenuCheck));
        }

        // Restore 390px iPhone Pro viewport
        await send('Emulation.setDeviceMetricsOverride', {
          width: 390,
          height: 844,
          deviceScaleFactor: 3,
          mobile: true
        });

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
          document.querySelector('#exclusionMuscleFilterBar [data-muscle-filter="All"]').click();
          document.querySelector('[data-close-modal="settingsModal"]').click();

          // Verify old Focus dropdown is completely removed
          const noLegacyFocusDropdown = !document.getElementById('bodyCategorySelect');

          // Verify 3-Part Focus Slider initial colors, alignment, 2 handles, and zero tick marks
          const upperBtn = document.getElementById('focusLabelUpper');
          const coreBtn = document.getElementById('focusLabelCore');
          const lowerBtn = document.getElementById('focusLabelLower');
          const segUpper = document.getElementById('focusSegUpper');
          const segCore = document.getElementById('focusSegCore');
          const segLower = document.getElementById('focusSegLower');
          const track = document.getElementById('focusBarTrack');

          const upperTextColor = getComputedStyle(upperBtn).color;
          const coreTextColor = getComputedStyle(coreBtn).color;
          const lowerTextColor = getComputedStyle(lowerBtn).color;
          const upperBarColor = getComputedStyle(segUpper).backgroundColor;
          const coreBarColor = getComputedStyle(segCore).backgroundColor;
          const lowerBarColor = getComputedStyle(segLower).backgroundColor;

          const uRect = upperBtn.getBoundingClientRect();
          const cRect = coreBtn.getBoundingClientRect();
          const lRect = lowerBtn.getBoundingClientRect();
          const labelsOrderedLeftCenterRight = uRect.left < cRect.left && cRect.left < lRect.left;
          const initialHandlesCount = document.querySelectorAll('#focusHandlesLayer .focus-slider-thumb').length;
          const zeroTickMarks = document.querySelectorAll('[class*="tick"]').length === 0;
          const resetFocusBtn = document.getElementById('resetFocusBtn');
          const hasResetFocusBtn = !!resetFocusBtn && resetFocusBtn.classList.contains('is-default');

          // Establish a clean Timed Trios (40/20) baseline first so we can verify that changing
          // Category, Type, Equipment, AND Focus slider percentages does NOT update the workout until Generate Workout!
          const catSelect = document.getElementById('workoutCategorySelect');
          const typeSelect = document.getElementById('workoutTypeSelect');
          const equipSelect = document.getElementById('equipmentSelect');
          typeSelect.value = 'Timed Trios (40/20)';
          typeSelect.dispatchEvent(new Event('change'));
          document.getElementById('generateWorkoutBtn').click();

          const getActiveExerciseTitles = () =>
            Array.from(document.querySelectorAll('.exercise-title-text')).map(el => el.innerText.trim());
          const workoutNameBeforeStaging = document.getElementById('workoutNameText').innerText.trim();
          const titlesBeforeStaging = getActiveExerciseTitles();

          // Stage Category, Equipment, and Type changes WITHOUT hitting Generate Workout
          catSelect.value = 'Strength';
          catSelect.dispatchEvent(new Event('change'));
          const workoutNameAfterCatChange = document.getElementById('workoutNameText').innerText.trim();
          const titlesAfterCatChange = getActiveExerciseTitles();

          equipSelect.value = 'Nothing';
          equipSelect.dispatchEvent(new Event('change'));
          const titlesAfterEquipChange = getActiveExerciseTitles();
          equipSelect.value = 'Any';
          equipSelect.dispatchEvent(new Event('change'));

          typeSelect.value = 'Strength Duos';
          typeSelect.dispatchEvent(new Event('change'));
          const workoutNameAfterTypeChange = document.getElementById('workoutNameText').innerText.trim();
          const titlesAfterTypeChange = getActiveExerciseTitles();
          const stagedSelectXLabel = document.getElementById('selectExercisesBtn').innerText.trim();

          // 1) Tap "Core" to deselect -> turns grey, yellow bar hidden, 50%/50% Upper/Lower, 1 handle (workout NOT changed yet!)
          coreBtn.click();
          const coreDeselectedGrey = getComputedStyle(coreBtn).color;
          const coreSegHidden = segCore.hidden === true;
          const handlesAfterDeselectCore = document.querySelectorAll('#focusHandlesLayer .focus-slider-thumb').length;
          const resetHighlightedWhenModified = !resetFocusBtn.classList.contains('is-default');
          const pctAfterDeselectCore = {
            upper: document.getElementById('focusPctUpper').innerText.trim(),
            core: document.getElementById('focusPctCore').innerText.trim(),
            lower: document.getElementById('focusPctLower').innerText.trim()
          };
          const titlesAfterDeselectBeforeGen = getActiveExerciseTitles();

          // 2) Drag the single handle to 75% of track width -> snaps to 75% Upper / 25% Lower (workout STILL unchanged until Generate Workout!)
          const trackRect = track.getBoundingClientRect();
          const thumb0 = document.querySelector('#focusHandlesLayer .focus-slider-thumb');
          const startX = trackRect.left + trackRect.width * 0.5;
          const endX75 = trackRect.left + trackRect.width * 0.75;
          thumb0.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: startX, pointerId: 1, button: 0 }));
          track.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: endX75, pointerId: 1 }));
          track.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: endX75, pointerId: 1 }));

          const pctAfterDrag75 = {
            upper: document.getElementById('focusPctUpper').innerText.trim(),
            lower: document.getElementById('focusPctLower').innerText.trim()
          };
          const titlesAfterDragBeforeGen = getActiveExerciseTitles();
          const workoutUnchangedBeforeGenerate =
            workoutNameBeforeStaging === 'Timed Trios (40/20)' &&
            workoutNameAfterCatChange === 'Timed Trios (40/20)' &&
            workoutNameAfterTypeChange === 'Timed Trios (40/20)' &&
            stagedSelectXLabel === 'Select 8 Exercises' &&
            JSON.stringify(titlesBeforeStaging) === JSON.stringify(titlesAfterCatChange) &&
            JSON.stringify(titlesBeforeStaging) === JSON.stringify(titlesAfterEquipChange) &&
            JSON.stringify(titlesBeforeStaging) === JSON.stringify(titlesAfterTypeChange) &&
            JSON.stringify(titlesBeforeStaging) === JSON.stringify(titlesAfterDeselectBeforeGen) &&
            JSON.stringify(titlesBeforeStaging) === JSON.stringify(titlesAfterDragBeforeGen);

          // Now hit Generate Workout -> applies Strength Duos + 75% Upper / 25% Lower -> 6 Upper + 2 Lower, max 1 Lower per Duo round!
          document.getElementById('generateWorkoutBtn').click();
          const workoutNameAfterGenerate = document.getElementById('workoutNameText').innerText.trim();

          const legMuscles = ['Glutes', 'Quads', 'Hamstrings'];
          const roundLegCounts = Array.from(document.querySelectorAll('.round-card')).map(card => {
            const metas = Array.from(card.querySelectorAll('.exercise-inline-meta')).map(m => m.innerText);
            return metas.filter(txt => legMuscles.some(lm => txt.startsWith(lm))).length;
          });
          const totalLower75 = roundLegCounts.reduce((a, b) => a + b, 0);
          const maxLowerPerRound75 = Math.max(...roundLegCounts);
          const bannersOnAuto75 = document.querySelectorAll('.overload-banner').length;

          // 3) Live Manual Focus Overload & 1-Tap Resolution:
          // Swap 2 Upper Body slots in separate rounds to Lower Body exercises -> triggers Lower Body overload -> 1-tap auto-balance clears it!
          const upperRoundIndices = roundLegCounts
            .map((cnt, idx) => (cnt === 0 ? idx : -1))
            .filter(idx => idx >= 0);
          const swapInput = document.getElementById('swapSearchInput');

          document
            .querySelector(`.exercise-slot[data-round-index="${upperRoundIndices[0]}"][data-slot-index="0"] .swap-trigger-btn`)
            .click();
          swapInput.value = 'Squats';
          swapInput.dispatchEvent(new Event('input'));
          document.querySelector('#swapExerciseList .swap-option-item').click();
          const bannersAfterPlus1Manual = document.querySelectorAll('.overload-banner').length;

          document
            .querySelector(`.exercise-slot[data-round-index="${upperRoundIndices[1]}"][data-slot-index="0"] .swap-trigger-btn`)
            .click();
          document.querySelector('#swapMuscleFilterBar [data-muscle-filter="Hamstrings"]').click();
          document.querySelector('#swapExerciseList .swap-option-item').click();
          const focusOverloadBanner = document.querySelector('.overload-banner');
          const focusOverloadText = focusOverloadBanner?.innerText.replace(/\s+/g, ' ').trim() || '';
          focusOverloadBanner?.querySelector('[data-action="auto-balance"]')?.click();
          const bannersAfterFocusAutoBalance = document.querySelectorAll('.overload-banner').length;

          // 4) Tap "Lower Body" to deselect -> 0 handles, 100% Upper Body; tapping "Upper Body" blocked as last active group
          lowerBtn.click();
          const handlesWhenOneActive = document.querySelectorAll('#focusHandlesLayer .focus-slider-thumb').length;
          upperBtn.click(); // Attempt to deselect last remaining active group -> blocked!
          const lastActiveStillEnabled = !upperBtn.classList.contains('is-deselected');

          // 5) Re-add "Lower Body" when ONLY 1 other area ("Upper Body") is selected -> takes up 50% (50% / 50%)!
          lowerBtn.click();
          const pctAfterReselectLower = {
            upper: document.getElementById('focusPctUpper').innerText.trim(),
            lower: document.getElementById('focusPctLower').innerText.trim()
          };

          // Drag handle to 75% Upper / 25% Lower, then re-add "Core" when 2 other areas are selected -> Core takes up 1/3 (33%)!
          const thumbBeforeCoreReadd = document.querySelector('#focusHandlesLayer .focus-slider-thumb');
          thumbBeforeCoreReadd.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: startX, pointerId: 4, button: 0 }));
          track.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: endX75, pointerId: 4 }));
          track.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: endX75, pointerId: 4 }));

          // 6) Re-add "Core" when 2 other areas are selected -> Core goes to 1/3 (33%), Upper/Lower scale across 2/3 (50% / 17%), 2 handles reappear!
          coreBtn.click();
          const pctOnReselectWithTwoOthers = {
            upper: document.getElementById('focusPctUpper').innerText.trim(),
            core: document.getElementById('focusPctCore').innerText.trim(),
            lower: document.getElementById('focusPctLower').innerText.trim()
          };
          const handlesAfterReselectAll = document.querySelectorAll('#focusHandlesLayer .focus-slider-thumb').length;

          // 7) Click Reset button (#resetFocusBtn) -> resets to 1/3, 1/3, 1/3 (33%/33%/33%) WITHOUT changing active workout until Generate Workout!
          const titlesBeforeResetBtn = getActiveExerciseTitles();
          resetFocusBtn.click();
          const pctAfterResetBtn = {
            upper: document.getElementById('focusPctUpper').innerText.trim(),
            core: document.getElementById('focusPctCore').innerText.trim(),
            lower: document.getElementById('focusPctLower').innerText.trim()
          };
          const resetBackToDefaultClass = resetFocusBtn.classList.contains('is-default');
          const workoutUnchangedOnResetClick =
            JSON.stringify(titlesBeforeResetBtn) === JSON.stringify(getActiveExerciseTitles());

          document.getElementById('generateWorkoutBtn').click();

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

          return {
            noLegacyFocusDropdown,
            hasResetFocusBtn,
            resetHighlightedWhenModified,
            colorsMatchSpec:
              upperTextColor === 'rgb(127, 29, 29)' &&
              upperBarColor === 'rgb(254, 202, 202)' &&
              coreTextColor === 'rgb(113, 63, 18)' &&
              coreBarColor === 'rgb(254, 240, 138)' &&
              lowerTextColor === 'rgb(88, 28, 135)' &&
              lowerBarColor === 'rgb(233, 213, 255)',
            labelsOrderedLeftCenterRight,
            initialHandlesCount,
            zeroTickMarks,
            coreDeselectedGrey,
            coreSegHidden,
            handlesAfterDeselectCore,
            pctAfterDeselectCore,
            pctAfterDrag75,
            workoutUnchangedBeforeGenerate,
            workoutNameAfterGenerate,
            totalLower75,
            maxLowerPerRound75,
            bannersOnAuto75,
            bannersAfterPlus1Manual,
            focusOverloadDetected: !!focusOverloadBanner && focusOverloadText.includes('overload'),
            focusOverloadText,
            bannersAfterFocusAutoBalance,
            handlesWhenOneActive,
            lastActiveStillEnabled,
            pctAfterReselectLower,
            pctOnReselectWithTwoOthers,
            handlesAfterReselectAll,
            pctAfterResetBtn,
            resetBackToDefaultClass,
            workoutUnchangedOnResetClick,
            hasSwapLegsAndCorePill,
            allExclValid,
            exclCount: exclItems.length,
            allSwapHaveHamstrings,
            swapHamCount: swapItems.length
          };
        });
        if (
          !filterCheck.noLegacyFocusDropdown ||
          !filterCheck.hasResetFocusBtn ||
          !filterCheck.resetHighlightedWhenModified ||
          !filterCheck.colorsMatchSpec ||
          !filterCheck.labelsOrderedLeftCenterRight ||
          filterCheck.initialHandlesCount !== 2 ||
          !filterCheck.zeroTickMarks ||
          filterCheck.coreDeselectedGrey !== 'rgb(148, 163, 184)' ||
          !filterCheck.coreSegHidden ||
          filterCheck.handlesAfterDeselectCore !== 1 ||
          filterCheck.pctAfterDeselectCore.upper !== '50%' ||
          filterCheck.pctAfterDeselectCore.lower !== '50%' ||
          filterCheck.pctAfterDrag75.upper !== '75%' ||
          filterCheck.pctAfterDrag75.lower !== '25%' ||
          !filterCheck.workoutUnchangedBeforeGenerate ||
          filterCheck.workoutNameAfterGenerate !== 'Strength Duos' ||
          filterCheck.totalLower75 !== 2 ||
          filterCheck.maxLowerPerRound75 > 1 ||
          filterCheck.bannersOnAuto75 !== 0 ||
          filterCheck.bannersAfterPlus1Manual !== 0 ||
          !filterCheck.focusOverloadDetected ||
          filterCheck.bannersAfterFocusAutoBalance !== 0 ||
          filterCheck.handlesWhenOneActive !== 0 ||
          !filterCheck.lastActiveStillEnabled ||
          filterCheck.pctAfterReselectLower.lower !== '50%' ||
          filterCheck.pctAfterReselectLower.upper !== '50%' ||
          filterCheck.pctOnReselectWithTwoOthers.core !== '33%' ||
          filterCheck.pctOnReselectWithTwoOthers.upper !== '50%' ||
          filterCheck.pctOnReselectWithTwoOthers.lower !== '17%' ||
          filterCheck.handlesAfterReselectAll !== 2 ||
          filterCheck.pctAfterResetBtn.upper !== '33%' ||
          filterCheck.pctAfterResetBtn.core !== '33%' ||
          filterCheck.pctAfterResetBtn.lower !== '33%' ||
          !filterCheck.resetBackToDefaultClass ||
          !filterCheck.workoutUnchangedOnResetClick ||
          !filterCheck.hasSwapLegsAndCorePill ||
          !filterCheck.allExclValid ||
          !filterCheck.allSwapHaveHamstrings
        ) {
          throw new Error('Top Menu & 3-Part Focus Slider check failed: ' + JSON.stringify(filterCheck));
        }
        console.log(
          `  ✅ PASS: Staged Category/Type/Equipment/Focus verified, 50% (1 other) & 1/3 (2 others) re-add verified, and ↺ Reset (33%/33%/33%) verified`
        );

        console.log('\n--- 9. Requirement 2 & 3: Dismiss Overload Warning & Replacement Exercises Never Trigger New Warnings ---');
        const dismissAndReplaceCheck = await evalInPage(() => {
          const typeSelect = document.getElementById('workoutTypeSelect');
          typeSelect.value = 'Strength Duos';
          typeSelect.dispatchEvent(new Event('change'));
          document.getElementById('generateWorkoutBtn').click();

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

          // Active workout should STILL be Strength Duos until Select 8 Exercises is confirmed!
          const workoutNameBeforeSelectXConfirm = document.getElementById('workoutNameText').innerText.trim();
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
          const workoutNameAfterSelectXConfirm = document.getElementById('workoutNameText').innerText.trim();
          const roundCount = document.querySelectorAll('.round-card').length;
          const slotCount = document.querySelectorAll('.exercise-slot').length;
          const overloadBanners = document.querySelectorAll('.overload-banner').length;

          return {
            workoutNameBeforeSelectXConfirm,
            workoutNameAfterSelectXConfirm,
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
          selectXCheck.workoutNameBeforeSelectXConfirm !== 'Strength Duos' ||
          selectXCheck.workoutNameAfterSelectXConfirm !== 'Timed Duos (40/20)' ||
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
          document.getElementById('generateWorkoutBtn').click();
          const strengthTimerBarHidden = document.getElementById('workoutTimerBar').hidden === true;
          const strengthRoundTimersCount = document.querySelectorAll('[data-action="open-round-timer"]').length;

          // Switch to Timed HIIT workout
          typeSelect.value = 'Timed Duos (40/20)';
          typeSelect.dispatchEvent(new Event('change'));
          document.getElementById('generateWorkoutBtn').click();

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
          const bottomLabelFontSize = parseFloat(getComputedStyle(bottomLabelEl).fontSize);
          const noOverflowOnWorkStep = document.documentElement.scrollWidth <= window.innerWidth;

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

          // Close timer modal and select a different workout type ("Timed Trios (40/20)") + Generate Workout -> verify timer resets!
          document.getElementById('closeTimerModalBtn').click();
          typeSelect.value = 'Timed Trios (40/20)';
          typeSelect.dispatchEvent(new Event('change'));
          document.getElementById('generateWorkoutBtn').click();

          document.querySelector('[data-action="open-round-timer"][data-round-index="0"]').click();
          const trioChipsCount = document.querySelectorAll('#timerSequenceTimeline .timer-seq-chip').length;
          document.getElementById('timerNextStepBtn').click();
          const trioStep1Clock = clockEl?.innerText.trim();
          const trioStep1Class = stageCard?.className || '';
          document.getElementById('closeTimerModalBtn').click();

          // Switch to "6 Excercise Pyramid" + Generate Workout and verify 10s "Transition" between exercises & 60s "Rest" at end of set
          typeSelect.value = '6 Excercise Pyramid';
          typeSelect.dispatchEvent(new Event('change'));
          document.getElementById('generateWorkoutBtn').click();
          document.getElementById('openWorkoutTimerBtn').click();
          // Step 0 = Countdown (10s), Step 1 = Set 1 Ex 1 (30s), Step 2 = Set 1 Rest (60s), Step 3 = Set 2 Ex 1 (30s), Step 4 = Set 2 Transition (10s)
          document.querySelector('[data-action="jump-timer-step"][data-step-index="2"]').click();
          const pyrRestClock = clockEl?.innerText.trim();
          const pyrRestLabel = bottomLabelEl?.innerText.trim();
          document.querySelector('[data-action="jump-timer-step"][data-step-index="4"]').click();
          const pyrTransClock = clockEl?.innerText.trim();
          const pyrTransLabel = bottomLabelEl?.innerText.trim();

          // Verify distinct sound cues fire when transitioning across Transition -> Work -> Rest
          const ts = window.__workoutTimerState;
          ts.soundLog = [];
          // Jump to Step 4 (Set 2 10s Transition), set remainingMs to 1150ms so in ~220ms it ticks 1s (transition-pulse)
          document.querySelector('[data-action="jump-timer-step"][data-step-index="4"]').click();
          ts.remainingSeconds = 2;
          ts.remainingMs = 1150;
          document.getElementById('timerStartPauseBtn').click();
          await new Promise(r => setTimeout(r, 240));
          // Now fast-forward remaining time of Step 4 (Transition) to 60ms so it advances into Step 5 (Work -> 'work-start')
          ts.remainingSeconds = 1;
          ts.remainingMs = 60;
          await new Promise(r => setTimeout(r, 150));
          // Now fast-forward remaining time of Step 5 (Work) to 60ms so it advances into Step 6 (Rest -> 'rest-start')
          ts.remainingSeconds = 1;
          ts.remainingMs = 60;
          await new Promise(r => setTimeout(r, 150));
          const activeDuringBeep = ts.getAudioContextState() === 'running';
          // Wait ~650ms while timer is STILL running during silent Rest so 'rest-start' chime finishes and auto-suspends
          await new Promise(r => setTimeout(r, 650));
          const autoSuspendedWhileSilentRunning =
            activeDuringBeep && ts.isRunning === true && ts.getAudioContextState() === 'suspended';
          document.getElementById('timerStartPauseBtn').click(); // Pause

          const loggedCueTypes = ts.soundLog.map(s => s.cueType);
          const hasTransitionPulseCue = loggedCueTypes.includes('transition-pulse');
          const hasWorkStartCue = loggedCueTypes.includes('work-start');
          const hasRestStartCue = loggedCueTypes.includes('rest-start');
          const audioSessionConfigured = String(ts.audioSessionType || '').startsWith('ambient');
          const mediaSessionUntouched = !navigator.mediaSession?.metadata;

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
            bottomLabelFontSize,
            noOverflowOnWorkStep,
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
            pyrTransLabel,
            hasTransitionPulseCue,
            hasWorkStartCue,
            hasRestStartCue,
            audioSessionConfigured,
            mediaSessionUntouched,
            autoSuspendedWhileSilentRunning,
            loggedCueTypes
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
          Math.abs(timerCheck.bottomLabelFontSize - 35.1) > 0.6 ||
          !timerCheck.noOverflowOnWorkStep ||
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
          timerCheck.pyrTransLabel !== 'Transition' ||
          !timerCheck.hasTransitionPulseCue ||
          !timerCheck.hasWorkStartCue ||
          !timerCheck.hasRestStartCue ||
          !timerCheck.audioSessionConfigured ||
          !timerCheck.mediaSessionUntouched ||
          !timerCheck.autoSuspendedWhileSilentRunning
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
          document.getElementById('generateWorkoutBtn').click();

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

        console.log('\n--- 12b. Settings Easter Egg: Calf Stretch Timer End-to-End Check ---');
        const calfStretchCheck = await evalInPage(async () => {
          document.getElementById('settingsBtn').click();
          const settingsModal = document.getElementById('settingsModal');
          const qaLink = settingsModal.querySelector('.qa-link-block a');
          const calfBtn = document.getElementById('openCalfStretchTimerBtn');
          const qaRect = qaLink.getBoundingClientRect();
          const calfRect = calfBtn.getBoundingClientRect();
          const buttonBelowQaLink = calfRect.top >= qaRect.bottom - 2;
          const buttonText = calfBtn.innerText.trim();

          // Click Calf Stretch Timer button
          calfBtn.click();
          const settingsClosed = settingsModal.hidden === true;
          const timerModal = document.getElementById('timerModal');
          const timerOpen = !timerModal.hidden;
          const modalTitle = document.getElementById('timerModalTitle').innerText.trim();
          const chipsCount = document.querySelectorAll('#timerSequenceTimeline .timer-seq-chip').length;

          const stageCard = document.getElementById('timerStageCard');
          const stageFill = document.getElementById('timerStageFill');
          const bottomLabelEl = document.getElementById('timerActiveExerciseName');
          const clockEl = document.getElementById('timerClockDisplay');

          // Step 0 is immediately 30s Right calf, straight leg (gastrox) (yellow-green), no 10s countdown
          const step1Clock = clockEl.innerText.trim();
          const step1Label = bottomLabelEl.innerText.trim();
          const step1Class = stageCard.className;
          const step1FillBg = getComputedStyle(stageFill).backgroundColor;
          const noOverflowStep1 = document.documentElement.scrollWidth <= window.innerWidth;

          // Verify fill fades toward grey while running & dings on transition to Step 2 (blue-green)
          const ts = window.__workoutTimerState;
          ts.soundLog = [];
          ts.remainingSeconds = 1;
          ts.remainingMs = 120;
          document.getElementById('timerStartPauseBtn').click();
          await new Promise(r => setTimeout(r, 40));
          const midDrainPct = parseFloat(stageFill.style.height);
          await new Promise(r => setTimeout(r, 180));
          document.getElementById('timerStartPauseBtn').click(); // Pause on Step 2 (index 1)

          const step2Clock = clockEl.innerText.trim();
          const step2Label = bottomLabelEl.innerText.trim();
          const step2Class = stageCard.className;
          const step2FillBg = getComputedStyle(stageFill).backgroundColor;
          const dingedOnTransition = ts.soundLog.some(s => s.cueType === 'work-start' && s.stepIndex === 1);

          // Step 3 & Step 4 labels/colors
          document.getElementById('timerNextStepBtn').click();
          const step3Label = bottomLabelEl.innerText.trim();
          const step3Class = stageCard.className;
          document.getElementById('timerNextStepBtn').click();
          const step4Label = bottomLabelEl.innerText.trim();
          const step4Class = stageCard.className;

          document.getElementById('closeTimerModalBtn').click();

          // Verify opening the regular HIIT workout timer afterward still restores the workout timer cleanly
          document.querySelector('[data-action="open-round-timer"][data-round-index="0"]')?.click();
          const restoredWorkoutTitle = document.getElementById('timerModalTitle').innerText.trim();
          document.getElementById('closeTimerModalBtn').click();

          return {
            buttonBelowQaLink,
            buttonText,
            settingsClosed,
            timerOpen,
            modalTitle,
            chipsCount,
            step1Clock,
            step1Label,
            step1IsYellowGreen: step1Class.includes('timer-color-yellow-green'),
            step1FillBg,
            noOverflowStep1,
            midDrainPct,
            step2Clock,
            step2Label,
            step2IsBlueGreen: step2Class.includes('timer-color-blue-green'),
            step2FillBg,
            dingedOnTransition,
            step3Label,
            step3IsYellowGreen: step3Class.includes('timer-color-yellow-green'),
            step4Label,
            step4IsBlueGreen: step4Class.includes('timer-color-blue-green'),
            restoredWorkoutTitle
          };
        });
        if (
          !calfStretchCheck.buttonBelowQaLink ||
          calfStretchCheck.buttonText !== 'Calf Stretch Timer' ||
          !calfStretchCheck.settingsClosed ||
          !calfStretchCheck.timerOpen ||
          calfStretchCheck.modalTitle !== 'Calf Stretch Timer' ||
          calfStretchCheck.chipsCount !== 12 ||
          calfStretchCheck.step1Clock !== '00:30' ||
          calfStretchCheck.step1Label !== 'Right calf, straight leg (gastrox)' ||
          !calfStretchCheck.step1IsYellowGreen ||
          calfStretchCheck.step1FillBg !== 'rgb(217, 249, 157)' ||
          !calfStretchCheck.noOverflowStep1 ||
          !(calfStretchCheck.midDrainPct < 20) ||
          calfStretchCheck.step2Label !== 'Left calf, straight leg (gastrox)' ||
          !calfStretchCheck.step2IsBlueGreen ||
          calfStretchCheck.step2FillBg !== 'rgb(153, 246, 228)' ||
          !calfStretchCheck.dingedOnTransition ||
          calfStretchCheck.step3Label !== 'Right calf, bent leg (soleus)' ||
          !calfStretchCheck.step3IsYellowGreen ||
          calfStretchCheck.step4Label !== 'Left calf, bent leg (soleus)' ||
          !calfStretchCheck.step4IsBlueGreen ||
          calfStretchCheck.restoredWorkoutTitle !== 'Timed Trios (40/20)'
        ) {
          throw new Error('Calf Stretch Timer E2E check failed: ' + JSON.stringify(calfStretchCheck));
        }
        console.log(
          '  ✅ PASS: Calf Stretch Timer easter egg verified (Settings button below 90 Diagrams -> 6-min 12x30s yellow-green/blue-green sequence with dings & grey drain)'
        );

        console.log('\n--- 13. Mobile Viewport Screenshot Capture ---');
        await evalInPage(() => {
          document.getElementById('generateWorkoutBtn')?.click();
          const toast = document.getElementById('toastContainer');
          if (toast) toast.innerHTML = '';
        });
        const screenshotData = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync('/tmp/workout-mobile-screenshot.png', Buffer.from(screenshotData.data, 'base64'));
        // Also capture the full-screen executed HIIT timer view on an active Exercise Work Step (+50% font size)
        await evalInPage(() => {
          document.querySelector('[data-action="open-round-timer"][data-round-index="0"]')?.click();
          document.getElementById('timerNextStepBtn')?.click();
        });
        const timerScreenshotData = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync('/tmp/workout-timer-screenshot.png', Buffer.from(timerScreenshotData.data, 'base64'));
        await evalInPage(() => {
          document.getElementById('closeTimerModalBtn')?.click();
        });
        console.log('  ✅ PASS: Mobile screenshots saved to /tmp/workout-mobile-screenshot.png and /tmp/workout-timer-screenshot.png');

        console.log('\n--- 14. QA Gallery All 90 Diagrams Render, Zero Spreadsheet Mention, Muscle Filter & No Audit Box Check ---');
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
          const noSpreadsheetMention = !/sheet\s*row|spreadsheet|row\s*#\s*\d+/i.test(document.body.innerText);

          // Test clicking the "Glutes" muscle filter button in QA Gallery
          const glutesBtn = document.querySelector('.qa-filter-bar [data-filter="Glutes"]');
          glutesBtn?.click();
          const glutesCards = Array.from(document.querySelectorAll('article.qa-card'));
          const allGlutesValid =
            glutesCards.length > 0 && glutesCards.length < 90 && glutesCards.every(c => c.innerText.includes('Glutes'));

          // Reset to All
          document.querySelector('.qa-filter-bar [data-filter="all"]')?.click();

          return {
            totalCards: cards.length,
            brokenCount: broken.length,
            broken,
            auditBoxes,
            noSpreadsheetMention,
            glutesCardCount: glutesCards.length,
            allGlutesValid
          };
        });
        if (
          galleryCheck.totalCards !== 90 ||
          galleryCheck.brokenCount > 0 ||
          galleryCheck.auditBoxes > 0 ||
          !galleryCheck.noSpreadsheetMention ||
          !galleryCheck.allGlutesValid
        ) {
          throw new Error('QA Gallery check failed: ' + JSON.stringify(galleryCheck));
        }
        console.log(
          `  ✅ PASS: All 90/90 exercise SVG diagrams rendered cleanly (680x248), 0 spreadsheet row mentions, and QA Gallery muscle filter verified (${galleryCheck.glutesCardCount} Glutes exercises)`
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
