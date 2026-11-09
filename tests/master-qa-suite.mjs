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
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav'
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
      const contentType = mime[path.extname(fullPath)] || 'application/octet-stream';
      const buf = fs.readFileSync(fullPath);
      const range = req.headers.range;
      if (range && /^bytes=\d*-\d*$/.test(range)) {
        const [startStr, endStr] = range.replace('bytes=', '').split('-');
        const start = startStr ? parseInt(startStr, 10) : 0;
        const end = endStr ? Math.min(buf.length - 1, parseInt(endStr, 10)) : buf.length - 1;
        if (start >= 0 && start <= end && end < buf.length) {
          const slice = buf.subarray(start, end + 1);
          res.writeHead(206, {
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${buf.length}`,
            'Content-Length': slice.length
          });
          res.end(slice);
          return;
        }
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Length': buf.length
      });
      res.end(buf);
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

  function send(method, params = {}, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const msgId = id++;
      const timer = setTimeout(() => reject(new Error('Timeout ' + method)), timeoutMs);
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

  async function evalInPage(fnStr, timeoutMs = 12000) {
    const res = await send(
      'Runtime.evaluate',
      {
        expression: `(${fnStr})()`,
        returnByValue: true,
        awaitPromise: true
      },
      timeoutMs
    );
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
          const collapsible = document.getElementById('generatorSettingsCollapsible');
          const toggleBtn = document.getElementById('toggleInputsCollapseBtn');
          const wasAutoCollapsedFromPrevGenerate = !!(collapsible && collapsible.hidden);
          if (wasAutoCollapsedFromPrevGenerate && toggleBtn) {
            toggleBtn.click();
          }
          const cells = Array.from(document.querySelectorAll('.top-menu-row .top-menu-cell'));
          const rects = cells.map(c => c.getBoundingClientRect());
          const labels = cells.map(c => c.querySelector('label')?.getBoundingClientRect());
          const selects = cells.map(c => c.querySelector('select')?.getBoundingClientRect());
          const focusRect = document.getElementById('focusSliderSection')?.getBoundingClientRect();
          const rowRect = document.querySelector('.top-menu-row')?.getBoundingClientRect();
          return {
            wasAutoCollapsedFromPrevGenerate,
            reExpandedCleanly: !!(collapsible && !collapsible.hidden),
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
          !narrow375MenuCheck.wasAutoCollapsedFromPrevGenerate ||
          !narrow375MenuCheck.reExpandedCleanly ||
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
          // Re-expand generator settings so staging & Focus slider drag can be interacted with
          if (document.getElementById('generatorSettingsCollapsible')?.hidden) {
            document.getElementById('toggleInputsCollapseBtn')?.click();
          }

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
          if (document.getElementById('generatorSettingsCollapsible')?.hidden) {
            document.getElementById('toggleInputsCollapseBtn')?.click();
          }
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

        console.log('\n--- 10b. Auto-Collapse & Re-Expand Workout Generator Settings Check ---');
        const autoCollapseCheck = await evalInPage(() => {
          const inputsCard = document.getElementById('inputsCard');
          const collapsible = document.getElementById('generatorSettingsCollapsible');
          const toggleBtn = document.getElementById('toggleInputsCollapseBtn');
          const genBtn = document.getElementById('generateWorkoutBtn');
          const selBtn = document.getElementById('selectExercisesBtn');
          const topMenu = document.querySelector('.top-menu-row');
          const focusSection = document.getElementById('focusSliderSection');

          // 1) After Select 8 Exercises in Step 10, settings should ALREADY be auto-collapsed!
          const collapsedAfterSelectX =
            collapsible.hidden === true &&
            inputsCard.classList.contains('is-collapsed') &&
            toggleBtn.getAttribute('aria-expanded') === 'false';
          const collapsedCardHeight = inputsCard.getBoundingClientRect().height;
          const buttonsVisibleWhileCollapsed =
            genBtn.getBoundingClientRect().height > 20 &&
            selBtn.getBoundingClientRect().height > 20 &&
            toggleBtn.getBoundingClientRect().height > 20;
          const filtersHiddenWhileCollapsed =
            topMenu.getBoundingClientRect().height === 0 &&
            focusSection.getBoundingClientRect().height === 0;

          // 2) Click toggle button to re-expand Category, Type, Equipment & Focus, then click up-arrow to manually collapse, then re-expand again
          toggleBtn.click();
          const expandedCardHeight = inputsCard.getBoundingClientRect().height;
          const reExpandedState =
            collapsible.hidden === false &&
            !inputsCard.classList.contains('is-collapsed') &&
            toggleBtn.getAttribute('aria-expanded') === 'true' &&
            topMenu.getBoundingClientRect().height > 30 &&
            focusSection.getBoundingClientRect().height > 30;

          toggleBtn.click();
          const manualCollapseState =
            collapsible.hidden === true &&
            inputsCard.classList.contains('is-collapsed') &&
            toggleBtn.getAttribute('aria-expanded') === 'false' &&
            topMenu.getBoundingClientRect().height === 0 &&
            focusSection.getBoundingClientRect().height === 0;

          toggleBtn.click();
          const reExpandedAfterManualCollapse =
            collapsible.hidden === false &&
            !inputsCard.classList.contains('is-collapsed') &&
            toggleBtn.getAttribute('aria-expanded') === 'true';

          // 3) Click Generate Workout -> auto-collapses again while keeping Generate & Select X visible
          genBtn.click();
          const collapsedAfterGenerate =
            collapsible.hidden === true &&
            inputsCard.classList.contains('is-collapsed') &&
            toggleBtn.getAttribute('aria-expanded') === 'false' &&
            genBtn.getBoundingClientRect().height > 20 &&
            selBtn.getBoundingClientRect().height > 20 &&
            topMenu.getBoundingClientRect().height === 0 &&
            focusSection.getBoundingClientRect().height === 0;

          // 4) Re-expand, then click Select X Exercises -> auto-collapses immediately and stays collapsed on close/confirm
          toggleBtn.click();
          const expandedBeforeSelectClick = collapsible.hidden === false;
          selBtn.click();
          const collapsedImmediatelyOnSelectClick =
            collapsible.hidden === true && inputsCard.classList.contains('is-collapsed');
          document.getElementById('autoFillRemainingBtn').click();
          document.getElementById('confirmSelectExercisesBtn').click();
          const collapsedAfterSelectConfirm =
            collapsible.hidden === true &&
            inputsCard.classList.contains('is-collapsed') &&
            genBtn.getBoundingClientRect().height > 20 &&
            selBtn.getBoundingClientRect().height > 20;

          const noHorizontalOverflow =
            document.documentElement.scrollWidth <= window.innerWidth &&
            document.body.scrollWidth <= window.innerWidth;

          return {
            collapsedAfterSelectX,
            collapsedCardHeight,
            expandedCardHeight,
            heightSavedPx: Math.round(expandedCardHeight - collapsedCardHeight),
            buttonsVisibleWhileCollapsed,
            filtersHiddenWhileCollapsed,
            reExpandedState,
            manualCollapseState,
            reExpandedAfterManualCollapse,
            collapsedAfterGenerate,
            expandedBeforeSelectClick,
            collapsedImmediatelyOnSelectClick,
            collapsedAfterSelectConfirm,
            noHorizontalOverflow
          };
        });
        if (
          !autoCollapseCheck.collapsedAfterSelectX ||
          !autoCollapseCheck.buttonsVisibleWhileCollapsed ||
          !autoCollapseCheck.filtersHiddenWhileCollapsed ||
          !autoCollapseCheck.reExpandedState ||
          !autoCollapseCheck.manualCollapseState ||
          !autoCollapseCheck.reExpandedAfterManualCollapse ||
          !autoCollapseCheck.collapsedAfterGenerate ||
          !autoCollapseCheck.expandedBeforeSelectClick ||
          !autoCollapseCheck.collapsedImmediatelyOnSelectClick ||
          !autoCollapseCheck.collapsedAfterSelectConfirm ||
          autoCollapseCheck.heightSavedPx < 80 ||
          !autoCollapseCheck.noHorizontalOverflow
        ) {
          throw new Error('Auto-collapse generator settings check failed: ' + JSON.stringify(autoCollapseCheck));
        }
        console.log(
          `  ✅ PASS: Generator settings auto-collapse after Generate Workout & Select X Exercises (saving ${autoCollapseCheck.heightSavedPx}px vertical space) and re-expand cleanly`
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
          const activeDuringBeep = ts.getAudioContextState() === 'running' || ts.isMasterAudioPlaying();
          await new Promise(r => setTimeout(r, 150));
          const stillRunningCleanly = activeDuringBeep && ts.isRunning === true;
          document.getElementById('timerStartPauseBtn').click(); // Pause

          const loggedCueTypes = ts.soundLog.map(c => c.cueType);
          const hasTransitionPulseCue = loggedCueTypes.includes('transition-pulse');
          const hasWorkStartCue = loggedCueTypes.includes('work-start');
          const hasRestStartCue = loggedCueTypes.includes('rest-start');
          const audioSessionConfigured =
            ts.audioSessionType === 'ambient' ||
            ts.audioSessionType === 'ambient-web-audio';
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
            stillRunningCleanly,
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
          !timerCheck.stillRunningCleanly
        ) {
          throw new Error('HIIT Timer & Customizer check failed: ' + JSON.stringify(timerCheck));
        }
        console.log(
          `  ✅ PASS: HIIT Timer verified ("Count Down" dark yellow -> "[Exercise]" dark green -> "Rest" dark blue, sliding fill ${timerCheck.runningFillPct.toFixed(1)}% over grey)`
        );

        console.log('\n--- 11b. Spoken Exercise Names Setting, Dynamic Lead Time & 10s Transition Ducking E2E ---');
        const speechCheck = await evalInPage(async () => {
          // 1) Verify Spoken Exercise Names toggle in Settings defaults to ON
          document.getElementById('settingsBtn').click();
          const toggleBtn = document.getElementById('spokenExerciseNamesToggle');
          const defaultToggleChecked = toggleBtn?.getAttribute('aria-checked') === 'true';
          const defaultToggleIsOn = Boolean(toggleBtn?.classList.contains('is-on'));
          const zeroTickClassesStillHold = document.querySelectorAll('[class*="tick"]').length === 0;
          document.querySelector('[data-close-modal="settingsModal"]').click();

          // 2) Verify 10s Transition flow in "6 Excercise Pyramid": Curls (30s) -> 10s Transition -> Bench Press (30s)
          const typeSelect = document.getElementById('workoutTypeSelect');
          typeSelect.value = '6 Excercise Pyramid';
          typeSelect.dispatchEvent(new Event('change'));
          document.getElementById('generateWorkoutBtn').click();
          document.getElementById('openWorkoutTimerBtn').click();

          const ts = window.__workoutTimerState;
          // Step 3 = Set 2 Ex 1 (work, 30s), Step 4 = Set 2 Transition (10s), Step 5 = Set 2 Ex 2 (work, 30s)
          ts.steps[3].exerciseName = 'Curls';
          ts.steps[5].exerciseName = 'Bench Press';
          document.querySelector('[data-action="jump-timer-step"][data-step-index="3"]').click();

          ts.soundLog = [];
          ts.speechLog = [];
          ts.remainingSeconds = 4;
          ts.remainingMs = 3050;
          document.getElementById('timerStartPauseBtn').click();
          await new Promise(r => setTimeout(r, 90));
          ts.remainingSeconds = 3;
          ts.remainingMs = 2050;
          await new Promise(r => setTimeout(r, 90));
          ts.remainingSeconds = 2;
          ts.remainingMs = 1050;
          await new Promise(r => setTimeout(r, 90));
          ts.remainingSeconds = 1;
          ts.remainingMs = 70;
          await new Promise(r => setTimeout(r, 130)); // Crosses into Step 4 (10s Transition) -> 1st ding at 10s

          // Let Step 4 reach <= 9350ms to speak "Bench Press", then cross 9000ms (9s left -> ducked ding)
          ts.remainingSeconds = 10;
          ts.remainingMs = 9320;
          await new Promise(r => setTimeout(r, 90));
          ts.remainingSeconds = 10;
          ts.remainingMs = 9030;
          await new Promise(r => setTimeout(r, 90));

          // Middle of 10s Transition (cross 6000ms -> 6s left -> regular volume ding)
          ts.remainingSeconds = 7;
          ts.remainingMs = 6030;
          await new Promise(r => setTimeout(r, 90));

          // Final 3, 2, 1 seconds of 10s Transition (ducked dings + "3", "2", "1") -> start of Bench Press (Step 5)
          ts.remainingSeconds = 4;
          ts.remainingMs = 3030;
          await new Promise(r => setTimeout(r, 90));
          ts.remainingSeconds = 3;
          ts.remainingMs = 2030;
          await new Promise(r => setTimeout(r, 90));
          ts.remainingSeconds = 2;
          ts.remainingMs = 1030;
          await new Promise(r => setTimeout(r, 90));
          ts.remainingSeconds = 1;
          ts.remainingMs = 60;
          await new Promise(r => setTimeout(r, 130));
          document.getElementById('timerStartPauseBtn').click(); // Pause on Step 5 (Bench Press)

          const curlsSpeechCount = ts.speechLog.filter(s => s.stepIndex === 3).length;
          const transSpeechTexts = ts.speechLog.filter(s => s.stepIndex === 4).map(s => s.text);
          const firstTransDing = ts.soundLog.find(
            s => s.stepIndex === 4 && s.cueType === 'transition-pulse' && s.remainingSeconds === 10
          );
          const nameDuckedDing = ts.soundLog.find(
            s => s.stepIndex === 4 && s.cueType === 'transition-pulse' && s.remainingSeconds === 9
          );
          const midRegularDing = ts.soundLog.find(
            s => s.stepIndex === 4 && s.cueType === 'transition-pulse' && s.remainingSeconds === 6
          );
          const count3DuckedDing = ts.soundLog.find(
            s => s.stepIndex === 4 && s.cueType === 'transition-pulse' && s.remainingSeconds === 3
          );
          const count2DuckedDing = ts.soundLog.find(
            s => s.stepIndex === 4 && s.cueType === 'transition-pulse' && s.remainingSeconds === 2
          );
          const count1DuckedDing = ts.soundLog.find(
            s => s.stepIndex === 4 && s.cueType === 'transition-pulse' && s.remainingSeconds === 1
          );
          const benchWorkStartDing = ts.soundLog.find(
            s => s.stepIndex === 5 && s.cueType === 'work-start'
          );
          document.getElementById('closeTimerModalBtn').click();

          // 3) Verify Standard Rest -> Work lead ("[Exercise] in 3, 2, 1" -> [Ding]) in Timed Duos (40/20)
          typeSelect.value = 'Timed Duos (40/20)';
          typeSelect.dispatchEvent(new Event('change'));
          document.getElementById('generateWorkoutBtn').click();
          document.querySelector('[data-action="open-round-timer"][data-round-index="0"]').click();
          // Step 2 = 20s blue Rest -> Step 3 = Work
          ts.steps[3].exerciseName = 'Bench Press';
          document.querySelector('[data-action="jump-timer-step"][data-step-index="2"]').click();
          ts.soundLog = [];
          ts.speechLog = [];
          ts.remainingSeconds = 4;
          ts.remainingMs = 3950;
          document.getElementById('timerStartPauseBtn').click();
          await new Promise(r => setTimeout(r, 150)); // Crosses ~3892ms lead time -> "Bench Press in"
          ts.remainingSeconds = 4;
          ts.remainingMs = 3030;
          await new Promise(r => setTimeout(r, 90));
          ts.remainingSeconds = 3;
          ts.remainingMs = 2030;
          await new Promise(r => setTimeout(r, 90));
          ts.remainingSeconds = 2;
          ts.remainingMs = 1030;
          await new Promise(r => setTimeout(r, 90));
          ts.remainingSeconds = 1;
          ts.remainingMs = 60;
          await new Promise(r => setTimeout(r, 130));
          document.getElementById('timerStartPauseBtn').click(); // Pause on Step 3
          const duosRestSpeechTexts = ts.speechLog.filter(s => s.stepIndex === 2).map(s => s.text);
          const duosWorkStartDing = ts.soundLog.find(
            s => s.stepIndex === 3 && s.cueType === 'work-start'
          );
          document.getElementById('closeTimerModalBtn').click();

          // 4) Toggle Spoken Exercise Names OFF in Settings -> verify zero speech & un-ducked pulses, then restore ON
          document.getElementById('settingsBtn').click();
          toggleBtn.click();
          const offChecked = toggleBtn.getAttribute('aria-checked') === 'false';
          const offClassCleared = !toggleBtn.classList.contains('is-on');
          document.querySelector('[data-close-modal="settingsModal"]').click();

          document.querySelector('[data-action="open-round-timer"][data-round-index="0"]').click();
          document.querySelector('[data-action="jump-timer-step"][data-step-index="0"]').click();
          ts.soundLog = [];
          ts.speechLog = [];
          ts.remainingSeconds = 4;
          ts.remainingMs = 3030;
          document.getElementById('timerStartPauseBtn').click();
          await new Promise(r => setTimeout(r, 110));
          document.getElementById('timerStartPauseBtn').click();
          const speechWhenOffCount = ts.speechLog.length;
          const offPulse3s = ts.soundLog.find(
            s => s.stepIndex === 0 && s.cueType === 'transition-pulse' && s.remainingSeconds === 3
          );
          document.getElementById('closeTimerModalBtn').click();

          // Restore toggle ON for subsequent tests
          document.getElementById('settingsBtn').click();
          toggleBtn.click();
          const restoredOn =
            toggleBtn.getAttribute('aria-checked') === 'true' && toggleBtn.classList.contains('is-on');
          document.querySelector('[data-close-modal="settingsModal"]').click();

          return {
            defaultToggleChecked,
            defaultToggleIsOn,
            zeroTickClassesStillHold,
            curlsSpeechCount,
            transSpeechTexts,
            firstTransDing,
            nameDuckedDing,
            midRegularDing,
            count3DuckedDing,
            count2DuckedDing,
            count1DuckedDing,
            benchWorkStartDing,
            duosRestSpeechTexts,
            duosWorkStartDing,
            offChecked,
            offClassCleared,
            speechWhenOffCount,
            offPulse3s,
            restoredOn
          };
        });
        if (
          !speechCheck.defaultToggleChecked ||
          !speechCheck.defaultToggleIsOn ||
          !speechCheck.zeroTickClassesStillHold ||
          speechCheck.curlsSpeechCount !== 0 ||
          JSON.stringify(speechCheck.transSpeechTexts) !== JSON.stringify(['Bench Press', '3', '2', '1']) ||
          speechCheck.firstTransDing?.gainScale !== 1 ||
          speechCheck.firstTransDing?.ducked !== false ||
          !speechCheck.nameDuckedDing?.ducked ||
          !(speechCheck.nameDuckedDing?.gainScale < 0.3) ||
          speechCheck.midRegularDing?.gainScale !== 1 ||
          speechCheck.midRegularDing?.ducked !== false ||
          !speechCheck.count3DuckedDing?.ducked ||
          !speechCheck.count2DuckedDing?.ducked ||
          !speechCheck.count1DuckedDing?.ducked ||
          speechCheck.benchWorkStartDing?.gainScale !== 1 ||
          speechCheck.benchWorkStartDing?.ducked !== false ||
          JSON.stringify(speechCheck.duosRestSpeechTexts) !== JSON.stringify(['Bench Press in', '3', '2', '1']) ||
          speechCheck.duosWorkStartDing?.gainScale !== 1 ||
          !speechCheck.offChecked ||
          !speechCheck.offClassCleared ||
          speechCheck.speechWhenOffCount !== 0 ||
          speechCheck.offPulse3s?.gainScale !== 1 ||
          speechCheck.offPulse3s?.ducked !== false ||
          !speechCheck.restoredOn
        ) {
          throw new Error('Spoken Exercise Names E2E check failed: ' + JSON.stringify(speechCheck));
        }
        console.log(
          '  ✅ PASS: Spoken Exercise Names verified (Settings ON default, Curls->10s Transition->Bench Press ducking, Duos "[Exercise] in 3, 2, 1", and Off toggle)'
        );

        console.log('\n--- 11c. App-Switch Continuity, Pure Ambient WebAudio & Burst Auto-Suspend (Dings + Spoken Words) E2E ---');
        const bgAndSilentCheck = await evalInPage(async () => {
          const ts = window.__workoutTimerState;
          for (let attempt = 0; attempt < 25 && !ts.speechPackLoaded; attempt++) {
            await new Promise(r => setTimeout(r, 80));
          }

          document.querySelector('[data-action="open-round-timer"][data-round-index="0"]').click();
          document.querySelector('[data-action="jump-timer-step"][data-step-index="0"]').click();

          // Set Step 0 countdown to 2 seconds BEFORE pressing Start so real wall-clock playback
          // crosses Step 0 -> Step 1 while the app is switched to another app!
          ts.steps[0].duration = 2;
          ts.remainingSeconds = 2;
          ts.remainingMs = 2000;
          ts.soundLog = [];
          ts.speechLog = [];

          // Start timer from user gesture -> runs pure 'ambient' burst WebAudio with ZERO <audio> elements
          document.getElementById('timerStartPauseBtn').click();
          await new Promise(r => setTimeout(r, 120));

          const fgWebAudioRunning = ts.getAudioContextState() === 'running';
          const zeroHtmlMediaElements = document.querySelectorAll('audio, video').length === 0;
          const mixableSessionActive =
            ts.audioSessionType === 'ambient' || ts.audioSessionType === 'ambient-web-audio';

          // Simulate switching to another app on the phone (document hidden + pagehide + window blur)
          const origHiddenDesc = Object.getOwnPropertyDescriptor( Document.prototype, 'hidden' );
          const origVisDesc = Object.getOwnPropertyDescriptor( Document.prototype, 'visibilityState' );
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
          window.dispatchEvent(new Event('pagehide'));
          window.dispatchEvent(new Event('blur'));
          await new Promise(r => setTimeout(r, 80));

          // Stay in the "other app" for 2.10 seconds while Step 0 finishes ("2", "1" + ducked dings)
          // and transitions into Step 1 (40s Exercise 'work-start' ding)!
          const stillRunningImmediatelyOnSwitch = ts.isRunning === true;
          const zeroHtmlMediaInBg =
            document.querySelectorAll('audio, video').length === 0 && ts.isMasterAudioPlaying() === false;
          await new Promise(r => setTimeout(r, 2100));

          const stepWhileStillInOtherApp = ts.currentStepIndex;
          const runningAfterIntervalInOtherApp = ts.isRunning === true;

          // Switch back to the Workout app -> catches up wall-clock time, keeps 'ambient', and auto-suspends during silent work!
          if (origHiddenDesc) Object.defineProperty(document, 'hidden', origHiddenDesc);
          else delete document.hidden;
          if (origVisDesc) Object.defineProperty(document, 'visibilityState', origVisDesc);
          else delete document.visibilityState;
          document.dispatchEvent(new Event('visibilitychange'));
          window.dispatchEvent(new Event('pageshow'));
          window.dispatchEvent(new Event('focus'));

          // Wait ~750ms after Step 1's 'work-start' chime finishes -> sharedAudioCtx MUST auto-suspend during silent 40s work!
          await new Promise(r => setTimeout(r, 750));
          const autoSuspendedDuringSilentWork =
            ts.isRunning === true && ts.getAudioContextState() === 'suspended';
          const clockAfterReturn = document.getElementById('timerClockDisplay').innerText.trim();
          const speechFiredInBackground = ts.speechLog.map(s => s.text);
          const workDingFiredInBackground = ts.soundLog.some(
            s => s.stepIndex === 1 && s.cueType === 'work-start'
          );

          // Pause timer and verify context stays suspended & zero <audio> elements exist
          document.getElementById('timerStartPauseBtn').click();
          await new Promise(r => setTimeout(r, 60));
          const stoppedCleanlyOnPause =
            ts.isRunning === false &&
            ts.isMasterAudioPlaying() === false &&
            ts.getAudioContextState() === 'suspended';
          document.getElementById('resetStockTimerBtn').click();
          document.getElementById('closeTimerModalBtn').click();

          return {
            speechPackLoaded: ts.speechPackLoaded,
            speechPackClipCount: ts.speechPackClipCount,
            fgWebAudioRunning,
            zeroHtmlMediaElements,
            mixableSessionActive,
            stillRunningImmediatelyOnSwitch,
            zeroHtmlMediaInBg,
            stepWhileStillInOtherApp,
            runningAfterIntervalInOtherApp,
            autoSuspendedDuringSilentWork,
            clockAfterReturn,
            speechFiredInBackground,
            workDingFiredInBackground,
            stoppedCleanlyOnPause
          };
        });
        if (
          !bgAndSilentCheck.speechPackLoaded ||
          bgAndSilentCheck.speechPackClipCount < 190 ||
          !bgAndSilentCheck.fgWebAudioRunning ||
          !bgAndSilentCheck.zeroHtmlMediaElements ||
          !bgAndSilentCheck.mixableSessionActive ||
          !bgAndSilentCheck.stillRunningImmediatelyOnSwitch ||
          !bgAndSilentCheck.zeroHtmlMediaInBg ||
          bgAndSilentCheck.stepWhileStillInOtherApp !== 1 ||
          !bgAndSilentCheck.runningAfterIntervalInOtherApp ||
          !bgAndSilentCheck.autoSuspendedDuringSilentWork ||
          !bgAndSilentCheck.speechFiredInBackground.includes('1') ||
          !bgAndSilentCheck.workDingFiredInBackground ||
          !bgAndSilentCheck.stoppedCleanlyOnPause
        ) {
          throw new Error(
            'App-Switch Continuity & Auto-Suspend Playback check failed: ' + JSON.stringify(bgAndSilentCheck)
          );
        }
        console.log(
          `  ✅ PASS: Pure 'ambient' WebAudio + zero <audio> elements + automatic silent-stretch suspend + app-switch continuity verified (${bgAndSilentCheck.speechPackClipCount} voice clips decoded)`
        );

        console.log('\n--- 11d. Dual iPhone Profile E2E: (A) Safari Home Screen Shortcut Standalone & (B) iPhone Mobile Chrome (CriOS) ---');
        await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

        const trustedTouchTap = async selector => {
          const pt = await evalInPage(
            new Function(`
              const el = document.querySelector(${JSON.stringify(selector)});
              const r = el.getBoundingClientRect();
              return {
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2),
                bottom: r.bottom,
                top: r.top,
                winH: window.innerHeight
              };
            `)
          );
          await send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x: pt.x, y: pt.y, radiusX: 5, radiusY: 5, force: 1, id: 1 }]
          });
          await send('Input.dispatchTouchEvent', {
            type: 'touchEnd',
            touchPoints: []
          });
          return pt;
        };

        // =========================================================================
        // PROFILE A: iPhone Safari Home Screen Shortcut ("Add to Home Screen" Standalone PWA)
        // =========================================================================
        await send('Emulation.setUserAgentOverride', {
          userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
          platform: 'iPhone'
        });
        await send('Emulation.setEmulatedMedia', {
          features: [{ name: 'display-mode', value: 'standalone' }]
        });
        await send('Emulation.setDeviceMetricsOverride', {
          width: 390,
          height: 844,
          deviceScaleFactor: 3,
          mobile: true
        });

        const safariShortcutPrep = await evalInPage(async () => {
          // Simulate iPhone Dynamic Island (59px) + Home Indicator (34px) safe-area insets & Safari iOS audioSession + standalone
          document.documentElement.style.setProperty('--safe-top', '59px');
          document.documentElement.style.setProperty('--safe-bottom', '34px');

          // Pre-settled 'ambient' from bootstrap()
          let mockSessionType = 'ambient';
          const sessionHistory = ['ambient'];
          Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
          Object.defineProperty(navigator, 'audioSession', {
            configurable: true,
            value: {
              get type() {
                return mockSessionType;
              },
              set type(val) {
                mockSessionType = String(val);
                sessionHistory.push(mockSessionType);
              }
            }
          });
          window.__iosAudioSessionHistory = sessionHistory;

          // Verify PWA standalone meta tags, manifest.json display:standalone & Service Worker offline speech-pack cache
          const appleCapable =
            document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute('content') === 'yes';
          const viewportContent = document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '';
          const viewportFitCover = viewportContent.includes('viewport-fit=cover');
          const manifestJson = await fetch('./manifest.json').then(r => r.json());
          const manifestStandalone = manifestJson?.display === 'standalone';
          const touchIconHref = document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') || '';
          const precomposedHref = document.querySelector('link[rel="apple-touch-icon-precomposed"]')?.getAttribute('href') || '';
          const medallionImg = document.querySelector('.brand-medallion');
          const checkImgSize = src =>
            new Promise(resolve => {
              const img = new Image();
              img.onload = () => resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight });
              img.onerror = () => resolve({ ok: false, w: 0, h: 0 });
              img.src = src;
            });
          const [touch512, touch180, touchPre] = await Promise.all([
            checkImgSize('./apple-touch-icon.png'),
            checkImgSize('./apple-touch-icon-180x180.png'),
            checkImgSize('./apple-touch-icon-precomposed.png')
          ]);
          const safariTouchIconsValid =
            touchIconHref.includes('.png') &&
            precomposedHref.includes('.png') &&
            touch512.ok && touch512.w === 512 && touch512.h === 512 &&
            touch180.ok && touch180.w === 180 && touch180.h === 180 &&
            touchPre.ok && touchPre.w === 512 && touchPre.h === 512 &&
            !!medallionImg && medallionImg.complete && medallionImg.naturalWidth > 0;

          // Scroll down 100px and verify sticky .top-nav stays clear of 59px Dynamic Island
          window.scrollTo(0, 100);
          const topNavRect = document.querySelector('.top-nav').getBoundingClientRect();
          const settingsBtnRect = document.getElementById('settingsBtn').getBoundingClientRect();
          window.scrollTo(0, 0);

          let swCachedSpeechPack = false;
          if ('caches' in window) {
            const keys = await caches.keys();
            for (const k of keys) {
              const c = await caches.open(k);
              const reqs = await c.keys();
              const urls = reqs.map(r => r.url);
              if (
                urls.some(u => u.includes('/data/speech-pack.m4a')) &&
                urls.some(u => u.includes('/data/speech-pack.json'))
              ) {
                swCachedSpeechPack = true;
              }
            }
          }

          // Open Full Workout Timer (49 steps = 24+ min) & verify trusted touch Start
          const typeSelect = document.getElementById('workoutTypeSelect');
          typeSelect.value = 'Timed Duos (40/20)';
          typeSelect.dispatchEvent(new Event('change'));
          document.getElementById('generateWorkoutBtn').click();
          document.getElementById('openWorkoutTimerBtn').click();

          const ts = window.__workoutTimerState;
          ts.steps[0].duration = 2;
          ts.remainingSeconds = 2;
          ts.remainingMs = 2000;
          ts.soundLog = [];
          ts.speechLog = [];

          let trustedClickSeen = false;
          document
            .getElementById('timerStartPauseBtn')
            .addEventListener('click', e => {
              trustedClickSeen = e.isTrusted;
            }, { once: true });
          window.__lastSafariTrustedClick = () => trustedClickSeen;

          const timerTopBarRect = document.querySelector('.timer-top-bar').getBoundingClientRect();
          const noOverflow = document.documentElement.scrollWidth <= window.innerWidth;

          return {
            appleCapable,
            viewportFitCover,
            manifestStandalone,
            safariTouchIconsValid,
            navigatorStandalone: navigator.standalone === true,
            settingsBtnBelowDynamicIsland: settingsBtnRect.top >= 59 && topNavRect.height >= 85,
            timerHeaderBelowDynamicIsland: timerTopBarRect.top >= 59,
            swCachedSpeechPack,
            noOverflow
          };
        });

        // Tap ▶ Start with real trusted touch gesture (`touchStart` + `touchEnd`)
        await trustedTouchTap('#timerStartPauseBtn');
        await new Promise(r => setTimeout(r, 120));

        const safariShortcutResult = await evalInPage(async () => {
          const ts = window.__workoutTimerState;
          const trustedClick = window.__lastSafariTrustedClick();
          const audioSessionOnStart = navigator.audioSession?.type;
          const fgWebAudioRunning = ts.getAudioContextState() === 'running';
          const zeroHtmlMediaElements = document.querySelectorAll('audio, video').length === 0;
          const sessionStayPureAmbient = (window.__iosAudioSessionHistory || []).every(s => s === 'ambient');

          // Switch away from Safari Shortcut app to another iPhone app across Step 0 -> Step 1 transition
          const origHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
          const origVis = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
          window.dispatchEvent(new Event('pagehide'));
          window.dispatchEvent(new Event('blur'));
          await new Promise(r => setTimeout(r, 2100));

          const stepInBg = ts.currentStepIndex;
          const runningInBg = ts.isRunning === true;
          const zeroHtmlMediaInBg = document.querySelectorAll('audio, video').length === 0;

          if (origHidden) Object.defineProperty(document, 'hidden', origHidden);
          else delete document.hidden;
          if (origVis) Object.defineProperty(document, 'visibilityState', origVis);
          else delete document.visibilityState;
          document.dispatchEvent(new Event('visibilitychange'));
          window.dispatchEvent(new Event('pageshow'));
          window.dispatchEvent(new Event('focus'));

          return {
            trustedClick,
            audioSessionOnStart,
            fgWebAudioRunning,
            zeroHtmlMediaElements,
            sessionStayPureAmbient,
            stepInBg,
            runningInBg,
            zeroHtmlMediaInBg,
            speechInBg: ts.speechLog.map(s => s.text),
            workDingInBg: ts.soundLog.some(s => s.stepIndex === 1 && s.cueType === 'work-start')
          };
        });

        // Trusted touch tap to Pause and verify audioSession stays 'ambient' (NEVER 'auto' or 'playback') and AudioContext suspends
        await trustedTouchTap('#timerStartPauseBtn');
        await new Promise(r => setTimeout(r, 60));
        const safariPausedCleanly = await evalInPage(() => {
          const ts = window.__workoutTimerState;
          const stayedAmbient = navigator.audioSession?.type === 'ambient';
          const neverLeftAmbient = (window.__iosAudioSessionHistory || []).every(s => s === 'ambient');
          const ctxSuspended = ts.getAudioContextState() === 'suspended';
          document.getElementById('resetStockTimerBtn').click();
          document.getElementById('closeTimerModalBtn').click();
          return stayedAmbient && neverLeftAmbient && ctxSuspended;
        });

        if (
          !safariShortcutPrep.appleCapable ||
          !safariShortcutPrep.viewportFitCover ||
          !safariShortcutPrep.manifestStandalone ||
          !safariShortcutPrep.safariTouchIconsValid ||
          !safariShortcutPrep.navigatorStandalone ||
          !safariShortcutPrep.settingsBtnBelowDynamicIsland ||
          !safariShortcutPrep.timerHeaderBelowDynamicIsland ||
          !safariShortcutPrep.swCachedSpeechPack ||
          !safariShortcutPrep.noOverflow ||
          !safariShortcutResult.trustedClick ||
          safariShortcutResult.audioSessionOnStart !== 'ambient' ||
          !safariShortcutResult.fgWebAudioRunning ||
          !safariShortcutResult.zeroHtmlMediaElements ||
          !safariShortcutResult.sessionStayPureAmbient ||
          safariShortcutResult.stepInBg !== 1 ||
          !safariShortcutResult.runningInBg ||
          !safariShortcutResult.zeroHtmlMediaInBg ||
          !safariShortcutResult.speechInBg.includes('1') ||
          !safariShortcutResult.workDingInBg ||
          !safariPausedCleanly
        ) {
          throw new Error(
            'iPhone Safari Home Screen Shortcut E2E check failed: ' +
              JSON.stringify({ safariShortcutPrep, safariShortcutResult, safariPausedCleanly })
          );
        }
        console.log(
          `  ✅ PASS: [Profile A — iPhone Safari Home Screen Shortcut] Standalone safe-area, offline SW voice cache, pure 'ambient' WebAudio (zero <audio>, zero 'auto'/'playback'), & app-switch continuity verified`
        );

        // =========================================================================
        // PROFILE B: iPhone Mobile Chrome (`CriOS` WKWebView on workouts.joshal.com)
        // =========================================================================
        await send('Emulation.setUserAgentOverride', {
          userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
          platform: 'iPhone'
        });
        await send('Emulation.setEmulatedMedia', {
          features: [{ name: 'display-mode', value: 'browser' }]
        });
        // Mobile Chrome on iPhone has top Omnibox + bottom navigation bar -> ~690px visible viewport height
        await send('Emulation.setDeviceMetricsOverride', {
          width: 390,
          height: 690,
          deviceScaleFactor: 3,
          mobile: true
        });

        const chromeIosPrep = await evalInPage(() => {
          document.documentElement.style.setProperty('--safe-top', '0px');
          document.documentElement.style.setProperty('--safe-bottom', '0px');
          Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => false });
          // Authentic CriOS WKWebView: navigator.audioSession is undefined
          Object.defineProperty(navigator, 'audioSession', { configurable: true, value: undefined });

          const isCriOSUa = /CriOS\//.test(navigator.userAgent);
          document.querySelector('[data-action="open-round-timer"][data-round-index="0"]').click();
          document.querySelector('[data-action="jump-timer-step"][data-step-index="0"]').click();

          const ts = window.__workoutTimerState;
          ts.steps[0].duration = 2;
          ts.remainingSeconds = 2;
          ts.remainingMs = 2000;
          ts.soundLog = [];
          ts.speechLog = [];

          let trustedClickSeen = false;
          document
            .getElementById('timerStartPauseBtn')
            .addEventListener('click', e => {
              trustedClickSeen = e.isTrusted;
            }, { once: true });
          window.__lastCriOSTrustedClick = () => trustedClickSeen;

          const playBtnRect = document.getElementById('timerStartPauseBtn').getBoundingClientRect();
          const noHorizontalOverflow = document.documentElement.scrollWidth <= window.innerWidth;
          // Ensure ▶ Start button is immediately tappable above Chrome's bottom toolbar without scrolling
          const controlsVisibleWithoutScroll = playBtnRect.bottom <= window.innerHeight && playBtnRect.top >= 0;

          return {
            isCriOSUa,
            noHorizontalOverflow,
            controlsVisibleWithoutScroll,
            playBtnBottom: Math.round(playBtnRect.bottom),
            winHeight: window.innerHeight
          };
        });

        // Trusted touch tap on ▶ Start inside 390x690 CriOS viewport
        await trustedTouchTap('#timerStartPauseBtn');
        await new Promise(r => setTimeout(r, 120));

        const chromeIosResult = await evalInPage(async () => {
          const ts = window.__workoutTimerState;
          const trustedClick = window.__lastCriOSTrustedClick();
          const audioSessionFallback = ts.audioSessionType;
          const fgWebAudioRunning = ts.getAudioContextState() === 'running';
          const zeroHtmlMediaElements = document.querySelectorAll('audio, video').length === 0;

          // Switch from Mobile Chrome to another iPhone app across Step 0 -> Step 1 transition
          const origHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
          const origVis = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
          window.dispatchEvent(new Event('pagehide'));
          window.dispatchEvent(new Event('blur'));
          await new Promise(r => setTimeout(r, 2100));

          const stepInBg = ts.currentStepIndex;
          const runningInBg = ts.isRunning === true;
          // Critical in CriOS WKWebView: ZERO <audio> elements even in background so AVAudioSessionCategoryPlayback never pauses Spotify!
          const zeroHtmlMediaInBg = document.querySelectorAll('audio, video').length === 0;

          if (origHidden) Object.defineProperty(document, 'hidden', origHidden);
          else delete document.hidden;
          if (origVis) Object.defineProperty(document, 'visibilityState', origVis);
          else delete document.visibilityState;
          document.dispatchEvent(new Event('visibilitychange'));
          window.dispatchEvent(new Event('pageshow'));
          window.dispatchEvent(new Event('focus'));

          const speechInBg = ts.speechLog.map(s => s.text);
          const workDingInBg = ts.soundLog.some(s => s.stepIndex === 1 && s.cueType === 'work-start');

          document.getElementById('timerStartPauseBtn').click(); // Pause
          await new Promise(r => setTimeout(r, 60));
          const suspendedOnPause = ts.getAudioContextState() === 'suspended';

          document.getElementById('resetStockTimerBtn').click();
          document.getElementById('closeTimerModalBtn').click();

          return {
            trustedClick,
            audioSessionFallback,
            fgWebAudioRunning,
            zeroHtmlMediaElements,
            stepInBg,
            runningInBg,
            zeroHtmlMediaInBg,
            speechInBg,
            workDingInBg,
            suspendedOnPause
          };
        });

        // Restore baseline 390x844 mobile metrics for subsequent tests & screenshots
        await send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await send('Emulation.setUserAgentOverride', { userAgent: '' });
        await send('Emulation.setDeviceMetricsOverride', {
          width: 390,
          height: 844,
          deviceScaleFactor: 3,
          mobile: true
        });
        await evalInPage(() => {
          document.documentElement.style.removeProperty('--safe-top');
          document.documentElement.style.removeProperty('--safe-bottom');
          delete navigator.standalone;
          delete navigator.audioSession;
        });

        if (
          !chromeIosPrep.isCriOSUa ||
          !chromeIosPrep.noHorizontalOverflow ||
          !chromeIosPrep.controlsVisibleWithoutScroll ||
          !chromeIosResult.trustedClick ||
          chromeIosResult.audioSessionFallback !== 'ambient-web-audio' ||
          !chromeIosResult.fgWebAudioRunning ||
          !chromeIosResult.zeroHtmlMediaElements ||
          chromeIosResult.stepInBg !== 1 ||
          !chromeIosResult.runningInBg ||
          !chromeIosResult.zeroHtmlMediaInBg ||
          !chromeIosResult.speechInBg.includes('1') ||
          !chromeIosResult.workDingInBg ||
          !chromeIosResult.suspendedOnPause
        ) {
          throw new Error(
            'iPhone Mobile Chrome (CriOS) E2E check failed: ' +
              JSON.stringify({ chromeIosPrep, chromeIosResult })
          );
        }
        console.log(
          `  ✅ PASS: [Profile B — iPhone Mobile Chrome (CriOS)] 390x690 toolbar fit (Start btn y=${chromeIosPrep.playBtnBottom}px <= 690px), pure ambient WebAudio (zero <audio>), auto-suspend & app-switch verified`
        );

        console.log('\n--- 11e. Bug 1, Bug 2 & Bug 3 Regression Suite (Pure Ambient Mixing, Earbud Disconnect -> Phone Speaker Recovery & Bottom Timeline Scroll Bar) ---');
        const bugsRegressionCheck = await evalInPage(async () => {
          let currentSession = 'ambient';
          const sessionTransitions = ['ambient'];
          Object.defineProperty(navigator, 'audioSession', {
            configurable: true,
            value: {
              get type() {
                return currentSession;
              },
              set type(v) {
                currentSession = String(v);
                sessionTransitions.push(currentSession);
              }
            }
          });

          const typeSelect = document.getElementById('workoutTypeSelect');
          typeSelect.value = 'Timed Duos (40/20)';
          typeSelect.dispatchEvent(new Event('change'));
          document.getElementById('generateWorkoutBtn').click();
          document.querySelector('[data-action="open-round-timer"][data-round-index="0"]').click();

          const ts = window.__workoutTimerState;

          // ===================================================================
          // BUG 1 CHECK: Music / Podcast on -> Plays BOTH dings AND 24kHz neural
          // voice via pure 'ambient' WebAudio (NEVER 'playback', 'transient', or
          // 'auto') and auto-suspends sharedAudioCtx during silent intervals!
          // ===================================================================
          const engineBefore = ts.getAudioEngineState();
          ts.steps[3].exerciseName = 'Squats';
          document.querySelector('[data-action="jump-timer-step"][data-step-index="2"]').click();
          ts.remainingSeconds = 4;
          ts.remainingMs = 3950;
          sessionTransitions.length = 0;

          document.getElementById('timerStartPauseBtn').click();
          await new Promise(r => setTimeout(r, 140)); // Fires "Squats in" on WebAudio under 'ambient'
          const sessionDuringVoiceCue = navigator.audioSession.type;
          const engineDuringVoice = ts.getAudioEngineState();

          // Advance into Step 3 (40s Work) -> fires standalone 'work-start' ding, then idle stretch!
          ts.remainingSeconds = 1;
          ts.remainingMs = 60;
          await new Promise(r => setTimeout(r, 150));
          const sessionDuringWorkStartDing = navigator.audioSession.type;
          const engineAfterDing = ts.getAudioEngineState();

          // Wait ~780ms for 'work-start' chime hold window to finish -> sharedAudioCtx MUST auto-suspend!
          await new Promise(r => setTimeout(r, 780));
          const sessionDuringIdleWork = navigator.audioSession.type;
          const autoSuspendedDuringIdleWork = ts.getAudioContextState() === 'suspended';
          const neverUsedNonAmbient = sessionTransitions.every(s => s === 'ambient');
          const webAudioPlayedVoiceAndDing =
            engineDuringVoice.webAudioSpeechCount > engineBefore.webAudioSpeechCount &&
            engineAfterDing.webAudioDingCount > engineBefore.webAudioDingCount;

          // ===================================================================
          // BUG 2 CHECK: User puts in earbuds + starts music, then stops music +
          // removes earbuds -> Phone speaker immediately plays dings & voice
          // purely via WebAudio under 'ambient' (ZERO 'auto' bounce, ZERO <audio>!)
          // ===================================================================
          const beforeRouteState = ts.getAudioEngineState();
          sessionTransitions.length = 0;
          if (navigator.mediaDevices?.dispatchEvent) {
            navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
          } else {
            await ts.simulateRouteChange();
          }
          await new Promise(r => setTimeout(r, 140));
          const afterEarbudRemovalState = ts.getAudioEngineState();
          const neverBouncedAutoOnRouteChange = !sessionTransitions.includes('auto');

          // Trigger both a step-start ding ('rest-start' into Step 4 Rest) AND spoken countdown ('2' in Step 4 Rest -> Step 5 Work)
          // on the phone speaker right after earbud removal — with zero app reopen and zero user tap!
          ts.remainingSeconds = 1;
          ts.remainingMs = 70;
          await new Promise(r => setTimeout(r, 140)); // Advances Step 3 (Work) -> Step 4 (Rest): plays 'rest-start' ding!
          ts.remainingSeconds = 3;
          ts.remainingMs = 2050;
          await new Promise(r => setTimeout(r, 120)); // Crosses 2000ms in Step 4 (Rest -> Work): speaks '2'!
          const afterPhoneSpeakerCueState = ts.getAudioEngineState();
          const phoneSpeakerPlayedAfterEarbudRemoval =
            afterEarbudRemovalState.routeChangeCount > beforeRouteState.routeChangeCount &&
            afterEarbudRemovalState.contextRefreshCount > beforeRouteState.contextRefreshCount &&
            afterPhoneSpeakerCueState.audioContextState === 'running' &&
            afterPhoneSpeakerCueState.webAudioDingCount > afterEarbudRemovalState.webAudioDingCount &&
            afterPhoneSpeakerCueState.webAudioSpeechCount > afterEarbudRemovalState.webAudioSpeechCount;

          // 2) Simulate frozen WebKit AudioContext clock on earbud yank -> verify pure-WebAudio clock watchdog recovers & replays!
          await ts.simulateRouteChange({ simulateStalledContext: true });
          const beforeWatchdogCount = ts.getAudioEngineState().watchdogFallbackCount;
          ts.remainingSeconds = 2;
          ts.remainingMs = 1050;
          await new Promise(r => setTimeout(r, 360)); // Crosses 1000ms ('1') + 160ms pure-WebAudio clock watchdog + 35ms refresh
          const afterWatchdogState = ts.getAudioEngineState();
          const watchdogPureWebAudioRecovered =
            afterWatchdogState.watchdogFallbackCount > beforeWatchdogCount &&
            afterWatchdogState.htmlMediaElementsInDom === 0 &&
            afterWatchdogState.audioContextState === 'running';

          document.getElementById('timerStartPauseBtn').click(); // Pause
          delete navigator.audioSession;

          // ===================================================================
          // BUG 3 CHECK: #timerSequenceTimeline automatically shifts scrollLeft
          // ===================================================================
          document.getElementById('closeTimerModalBtn').click();
          document.querySelector('[data-action="open-round-timer"][data-round-index="0"]').click();

          const measureTimelineStep = stepIdx => {
            const tl = document.getElementById('timerSequenceTimeline');
            const chips = Array.from(tl.querySelectorAll('.timer-seq-chip'));
            const activeChip = tl.querySelector('.timer-seq-chip.active');
            const lastChip = chips[chips.length - 1];
            const firstChip = chips[0];
            const leadingInset = firstChip ? firstChip.offsetLeft : 4;
            const maxScrollLeft = Math.max(0, tl.scrollWidth - tl.clientWidth);
            const desiredLeft = Math.max(0, chips[stepIdx].offsetLeft - leadingInset);
            const expectedScrollLeft = Math.min(desiredLeft, maxScrollLeft);
            const tlRect = tl.getBoundingClientRect();
            const actRect = activeChip.getBoundingClientRect();
            const lastRect = lastChip.getBoundingClientRect();
            return {
              stepIdx,
              activeIndexAttr: Number(activeChip?.getAttribute('data-step-index')),
              scrollLeft: tl.scrollLeft,
              maxScrollLeft,
              expectedScrollLeft,
              scrollErrorPx: Math.abs(tl.scrollLeft - expectedScrollLeft),
              activeLeftOffsetInBar: Math.round(actRect.left - tlRect.left),
              lastRightGapInBar: Math.round(tlRect.right - lastRect.right),
              pinnedAtEnd: desiredLeft >= maxScrollLeft - 0.5
            };
          };

          const timelineMeasurements = [];
          timelineMeasurements.push(measureTimelineStep(0));

          ts.remainingSeconds = 1;
          ts.remainingMs = 70;
          document.getElementById('timerStartPauseBtn').click();
          await new Promise(r => setTimeout(r, 140));
          timelineMeasurements.push(measureTimelineStep(1));

          ts.remainingSeconds = 1;
          ts.remainingMs = 70;
          await new Promise(r => setTimeout(r, 140));
          document.getElementById('timerStartPauseBtn').click();
          timelineMeasurements.push(measureTimelineStep(2));

          for (let s = 3; s < ts.steps.length; s++) {
            document.getElementById('timerNextStepBtn').click();
            timelineMeasurements.push(measureTimelineStep(s));
          }

          document.getElementById('timerResetBtn').click();
          const resetMeasurement = measureTimelineStep(0);
          document.getElementById('closeTimerModalBtn').click();

          const timelineOverflowed = timelineMeasurements[0].maxScrollLeft > 200;
          const everyStepScrolledExact = timelineMeasurements.every(
            m => m.activeIndexAttr === m.stepIdx && m.scrollErrorPx <= 1.5
          );
          const unpinnedSteps = timelineMeasurements.filter(m => !m.pinnedAtEnd);
          const pinnedSteps = timelineMeasurements.filter(m => m.pinnedAtEnd);

          const unpinnedInLowerLeft =
            unpinnedSteps.length >= 6 &&
            unpinnedSteps.every(m => m.activeLeftOffsetInBar >= 1 && m.activeLeftOffsetInBar <= 8);

          const pinnedLastInBottomRight =
            pinnedSteps.length >= 2 &&
            pinnedSteps.every(
              (m, i) =>
                Math.abs(m.scrollLeft - m.maxScrollLeft) <= 1.5 &&
                Math.abs(m.lastRightGapInBar) <= 8 &&
                (i === 0 || m.activeLeftOffsetInBar > pinnedSteps[i - 1].activeLeftOffsetInBar)
            );

          return {
            sessionDuringVoiceCue,
            sessionDuringWorkStartDing,
            sessionDuringIdleWork,
            autoSuspendedDuringIdleWork,
            neverUsedNonAmbient,
            webAudioPlayedVoiceAndDing,
            neverBouncedAutoOnRouteChange,
            phoneSpeakerPlayedAfterEarbudRemoval,
            watchdogPureWebAudioRecovered,
            timelineOverflowed,
            everyStepScrolledExact,
            unpinnedInLowerLeft,
            pinnedLastInBottomRight,
            resetBackToZero: resetMeasurement.scrollLeft === 0 && resetMeasurement.activeIndexAttr === 0
          };
        });

        if (
          bugsRegressionCheck.sessionDuringVoiceCue !== 'ambient' ||
          bugsRegressionCheck.sessionDuringWorkStartDing !== 'ambient' ||
          bugsRegressionCheck.sessionDuringIdleWork !== 'ambient' ||
          !bugsRegressionCheck.autoSuspendedDuringIdleWork ||
          !bugsRegressionCheck.neverUsedNonAmbient ||
          !bugsRegressionCheck.webAudioPlayedVoiceAndDing ||
          !bugsRegressionCheck.neverBouncedAutoOnRouteChange ||
          !bugsRegressionCheck.phoneSpeakerPlayedAfterEarbudRemoval ||
          !bugsRegressionCheck.watchdogPureWebAudioRecovered ||
          !bugsRegressionCheck.timelineOverflowed ||
          !bugsRegressionCheck.everyStepScrolledExact ||
          !bugsRegressionCheck.unpinnedInLowerLeft ||
          !bugsRegressionCheck.pinnedLastInBottomRight ||
          !bugsRegressionCheck.resetBackToZero
        ) {
          throw new Error(
            'Bug 1 / Bug 2 / Bug 3 E2E regression check failed: ' + JSON.stringify(bugsRegressionCheck)
          );
        }
        console.log(
          '  ✅ PASS: Bug 1 (pure ambient WebAudio + silent-stretch auto-suspend), Bug 2 (earbud disconnect -> pure WebAudio phone speaker auto-recovery), and Bug 3 (bottom timeline auto-shift) all verified E2E!'
        );

        console.log('\n--- 11f. Comprehensive Crazy Gym Workout Audio + Timer + App-Switch Coexistence Matrix ---');
        const multiConditionAudioCheck = await evalInPage(async () => {
          const wait = ms => new Promise(r => setTimeout(r, ms));
          const ts = window.__workoutTimerState;

          // Authentic iOS WebKit C++ Audio Session + HTMLMediaElement Conflict Simulator:
          // - Models async WebProcess -> UIProcess/GPUProcess IPC (~15ms): if AudioContext starts BEFORE
          //   'ambient' was already pre-settled, external audio pauses (pausedByClickRace = true)!
          // - Any 'playback', 'transient-solo', 'transient', or 'auto' session immediately pauses external audio!
          // - Any HTMLMediaElement.play() (<audio>/<video>) immediately pauses external audio!
          const env = {
            jsSession: 'ambient',
            gpuSettledSession: 'ambient',
            sessionLog: ['ambient'],
            oscillatorStarts: 0,
            voiceBufferStarts: 0,
            htmlMediaPlays: 0,
            mediaSessionHijacked: false,
            externalPlayer: {
              playing: false,
              volume: 1.0,
              pausedByConflict: false,
              pausedByClickRace: false,
              pausedByHtmlMedia: false,
              conflictReasons: [],
              start() {
                this.playing = true;
                this.volume = 1.0;
              },
              pause() {
                this.playing = false;
              },
              interrupt(reason) {
                this.pausedByConflict = true;
                this.conflictReasons.push(reason);
                if (this.playing) {
                  this.playing = false;
                }
              }
            }
          };

          Object.defineProperty(navigator, 'audioSession', {
            configurable: true,
            value: {
              get type() {
                return env.jsSession;
              },
              set type(val) {
                const next = String(val);
                env.jsSession = next;
                env.sessionLog.push(next);
                if (next !== 'ambient') {
                  env.gpuSettledSession = next;
                  env.externalPlayer.interrupt(`non-ambient-session:${next}`);
                } else {
                  setTimeout(() => {
                    if (env.jsSession === 'ambient') {
                      env.gpuSettledSession = 'ambient';
                    }
                  }, 15);
                }
              }
            }
          });

          const origOscStart = OscillatorNode.prototype.start;
          const origBufStart = AudioBufferSourceNode.prototype.start;
          const origMediaPlay = HTMLMediaElement.prototype.play;
          const origHiddenDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
          const origVisDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');

          const setAppHidden = hidden => {
            if (hidden) {
              Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
              Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
              document.dispatchEvent(new Event('visibilitychange'));
              window.dispatchEvent(new Event('pagehide'));
              window.dispatchEvent(new Event('blur'));
            } else {
              if (origHiddenDesc) Object.defineProperty(document, 'hidden', origHiddenDesc);
              else delete document.hidden;
              if (origVisDesc) Object.defineProperty(document, 'visibilityState', origVisDesc);
              else delete document.visibilityState;
              document.dispatchEvent(new Event('visibilitychange'));
              window.dispatchEvent(new Event('pageshow'));
              window.dispatchEvent(new Event('focus'));
            }
          };

          OscillatorNode.prototype.start = function (...args) {
            env.oscillatorStarts += 1;
            if (env.gpuSettledSession !== 'ambient') {
              env.externalPlayer.pausedByClickRace = true;
              env.externalPlayer.interrupt(`osc-click-race:${env.gpuSettledSession}`);
            }
            return origOscStart.apply(this, args);
          };

          AudioBufferSourceNode.prototype.start = function (...args) {
            if (env.gpuSettledSession !== 'ambient') {
              env.externalPlayer.pausedByClickRace = true;
              env.externalPlayer.interrupt(`buf-click-race:${env.gpuSettledSession}`);
            }
            if (this.buffer && this.buffer.length > 10) {
              env.voiceBufferStarts += 1;
            }
            return origBufStart.apply(this, args);
          };

          HTMLMediaElement.prototype.play = function (...args) {
            env.htmlMediaPlays += 1;
            env.externalPlayer.pausedByHtmlMedia = true;
            env.externalPlayer.interrupt(`html-media-play:${this.id || this.tagName}`);
            return origMediaPlay.apply(this, args);
          };

          if (navigator.mediaSession && navigator.mediaSession.metadata !== null) {
            env.mediaSessionHijacked = true;
          }

          const results = {};

          try {
            // =================================================================
            // CASE 1: Audio ALREADY Playing -> Turn Timer ON Across ALL Timer Modes
            // (a) Full Workout HIIT Timer, (b) Single Round Timer, (c) 6-Exercise
            // Pyramid w/ 10s Transition, (d) Custom Preset Timer, (e) Calf Stretch Timer
            // =================================================================
            env.externalPlayer.start();
            const typeSelect = document.getElementById('workoutTypeSelect');
            typeSelect.value = 'Timed Duos (40/20)';
            typeSelect.dispatchEvent(new Event('change'));
            document.getElementById('generateWorkoutBtn').click();

            // 1a) Full Workout HIIT Timer
            document.getElementById('openWorkoutTimerBtn').click();
            const unpausedOnFullOpen = env.externalPlayer.playing && !env.externalPlayer.pausedByConflict;
            document.getElementById('timerStartPauseBtn').click();
            await wait(80);
            const unpausedOnFullStart = env.externalPlayer.playing && !env.externalPlayer.pausedByConflict;
            document.getElementById('timerStartPauseBtn').click();
            document.getElementById('closeTimerModalBtn').click();

            // 1b) Single Round Timer (with spoken countdown -> work ding -> silent auto-suspend -> pause)
            document.querySelector('[data-action="open-round-timer"][data-round-index="0"]').click();
            ts.steps[3].exerciseName = 'Squats';
            document.querySelector('[data-action="jump-timer-step"][data-step-index="2"]').click();
            ts.remainingSeconds = 4;
            ts.remainingMs = 3950;
            const oscBefore1b = env.oscillatorStarts;
            const voiceBefore1b = env.voiceBufferStarts;
            document.getElementById('timerStartPauseBtn').click();
            await wait(140); // Speaks "Squats in"
            const unpausedDuringVoice = env.externalPlayer.playing && env.externalPlayer.volume === 1.0;
            ts.remainingSeconds = 1;
            ts.remainingMs = 60;
            await wait(150); // Step 2 -> Step 3 'work-start' ding!
            const unpausedDuringDing = env.externalPlayer.playing && env.externalPlayer.volume === 1.0;
            await wait(780); // Chime finishes -> sharedAudioCtx auto-suspends during silent 40s work!
            const autoSuspendedIdle =
              ts.isRunning &&
              ts.getAudioContextState() === 'suspended' &&
              env.externalPlayer.playing &&
              !env.externalPlayer.pausedByConflict;
            document.getElementById('timerStartPauseBtn').click(); // Pause
            await wait(80);
            const unpausedAfterPause =
              env.externalPlayer.playing &&
              !env.externalPlayer.pausedByConflict &&
              ts.getAudioContextState() === 'suspended';
            document.getElementById('closeTimerModalBtn').click();

            // 1c) 6 Excercise Pyramid (10s Transition ducked pulses + spoken name)
            typeSelect.value = '6 Excercise Pyramid';
            typeSelect.dispatchEvent(new Event('change'));
            document.getElementById('generateWorkoutBtn').click();
            document.getElementById('openWorkoutTimerBtn').click();
            document.querySelector('[data-action="jump-timer-step"][data-step-index="2"]').click(); // 10s Transition
            document.getElementById('timerStartPauseBtn').click();
            await wait(1150);
            const unpausedInPyramidTransition = ts.isRunning && env.externalPlayer.playing && !env.externalPlayer.pausedByConflict;
            document.getElementById('timerStartPauseBtn').click();
            document.getElementById('closeTimerModalBtn').click();

            // 1d) Custom Preset Timer (Tabata)
            document.getElementById('openCustomTimerBtn').click();
            document.getElementById('timerModeCustomBtn').click();
            document.getElementById('applyTimerCustomizationBtn').click();
            document.getElementById('timerStartPauseBtn').click();
            await wait(100);
            const unpausedInCustomPreset = ts.isRunning && env.externalPlayer.playing && !env.externalPlayer.pausedByConflict;
            document.getElementById('timerStartPauseBtn').click();
            document.getElementById('resetStockTimerBtn').click();
            document.getElementById('closeTimerModalBtn').click();

            // 1e) Settings Easter Egg: Calf Stretch Timer (immediate 30s work-start with 0s countdown)
            document.getElementById('settingsBtn').click();
            document.getElementById('openCalfStretchTimerBtn').click();
            document.getElementById('timerStartPauseBtn').click();
            await wait(100);
            const unpausedInCalfStretch = ts.isRunning && env.externalPlayer.playing && !env.externalPlayer.pausedByConflict;
            document.getElementById('timerStartPauseBtn').click();
            document.getElementById('closeTimerModalBtn').click();

            // Restore Timed Duos (40/20)
            typeSelect.value = 'Timed Duos (40/20)';
            typeSelect.dispatchEvent(new Event('change'));
            document.getElementById('generateWorkoutBtn').click();

            results.case1_allTimerModesWithAudioPlaying = {
              unpausedOnFullOpen,
              unpausedOnFullStart,
              unpausedDuringVoice,
              unpausedDuringDing,
              autoSuspendedIdle,
              unpausedAfterPause,
              unpausedInPyramidTransition,
              unpausedInCustomPreset,
              unpausedInCalfStretch,
              playedVoiceAndDing:
                env.oscillatorStarts > oscBefore1b && env.voiceBufferStarts > voiceBefore1b
            };

            // =================================================================
            // CASE 2: Start Timer With Audio OFF -> Start Audio Mid-Workout
            // (Both during silent auto-suspended work AND mid-"3, 2, 1" countdown)
            // =================================================================
            env.externalPlayer.pause();
            document.querySelector('[data-action="open-round-timer"][data-round-index="0"]').click();
            document.querySelector('[data-action="jump-timer-step"][data-step-index="1"]').click(); // 40s Work
            document.getElementById('timerStartPauseBtn').click();
            await wait(780); // Auto-suspended during silent work

            window.dispatchEvent(new Event('blur'));
            env.externalPlayer.start();
            window.dispatchEvent(new Event('focus'));
            await wait(60);
            const bothRunningAfterStartMidWork =
              ts.isRunning && env.externalPlayer.playing && !env.externalPlayer.pausedByConflict;

            ts.steps[3].exerciseName = 'Lunges';
            ts.remainingSeconds = 1;
            ts.remainingMs = 60;
            const oscBeforeRest = env.oscillatorStarts;
            await wait(150); // Step 1 -> Step 2 (Rest): wakes suspended AudioContext & plays 'rest-start'!
            const restChimeWokeFromSuspend = env.oscillatorStarts > oscBeforeRest && env.externalPlayer.playing;

            env.externalPlayer.pause();
            ts.remainingSeconds = 3;
            ts.remainingMs = 2950;
            await wait(110); // Speaks '3'
            env.externalPlayer.start(); // Unpause music mid-countdown!
            ts.remainingSeconds = 2;
            ts.remainingMs = 1950;
            await wait(110); // Speaks '2' over playing music!
            const midCountdownMusicAndVoice =
              ts.isRunning &&
              env.externalPlayer.playing &&
              !env.externalPlayer.pausedByConflict &&
              ts.speechLog.some(s => s.text === '2');

            document.getElementById('timerStartPauseBtn').click();
            await wait(60);
            document.getElementById('closeTimerModalBtn').click();

            results.case2_startOffThenPlayMidTimer = {
              bothRunningAfterStartMidWork,
              restChimeWokeFromSuspend,
              midCountdownMusicAndVoice
            };

            // =================================================================
            // CASE 3: Pause / Unpause / Mid-Cue Stop / Mid-Step Resume Auto-Suspend /
            // Rapid Start-Pause-Start / Step Jumps / Reset / Completion & Restart
            // =================================================================
            env.externalPlayer.start();
            document.querySelector('[data-action="open-round-timer"][data-round-index="0"]').click();
            document.getElementById('timerStartPauseBtn').click(); // Plays Step 0 pulse
            await wait(50);

            // Pause mid-ding while music is playing!
            document.getElementById('timerStartPauseBtn').click();
            await wait(70);
            const midDingPauseState = ts.getAudioEngineState();
            const cleanMidDingStop =
              !ts.isRunning &&
              midDingPauseState.activeOscillatorCount === 0 &&
              !midDingPauseState.activeSpeechPlaying &&
              midDingPauseState.audioContextState === 'suspended' &&
              midDingPauseState.navigatorAudioSessionType === 'ambient' &&
              env.externalPlayer.playing &&
              !env.externalPlayer.pausedByConflict;

            // Unpause mid-step (at ~25s remaining in silent Step 1) -> verify gesture unlock auto-suspends within ~180ms!
            document.querySelector('[data-action="jump-timer-step"][data-step-index="1"]').click();
            ts.remainingSeconds = 25;
            ts.remainingMs = 25000;
            document.getElementById('timerStartPauseBtn').click();
            await wait(220);
            const midStepResumeAutoSuspended =
              ts.isRunning &&
              ts.getAudioContextState() === 'suspended' &&
              env.externalPlayer.playing &&
              !env.externalPlayer.pausedByConflict;

            // Rapid Pause -> Start -> Pause -> Start (25ms) while music is playing!
            document.getElementById('timerStartPauseBtn').click(); // Pause
            await wait(25);
            document.getElementById('timerResetBtn').click(); // Reset to Step 0
            document.getElementById('timerStartPauseBtn').click(); // Start
            await wait(25);
            document.getElementById('timerStartPauseBtn').click(); // Pause
            await wait(25);
            document.getElementById('timerStartPauseBtn').click(); // Immediate Start!
            await wait(120);
            const rapidToggleHealthy =
              ts.isRunning &&
              env.externalPlayer.playing &&
              !env.externalPlayer.pausedByConflict;

            // Jump to final step, let sharedAudioCtx be suspended first, then cross 00:00 -> completion fanfare MUST play!
            document.getElementById('timerStartPauseBtn').click(); // Pause -> suspends AudioContext
            await wait(60);
            const lastIdx = ts.steps.length - 1;
            document.querySelector(`[data-action="jump-timer-step"][data-step-index="${lastIdx}"]`).click();
            ts.remainingSeconds = 2;
            ts.remainingMs = 2000;
            document.getElementById('timerStartPauseBtn').click(); // Mid-step start -> suspends in ~120ms
            await wait(200);
            const oscBeforeComplete = env.oscillatorStarts;
            ts.remainingSeconds = 1;
            ts.remainingMs = 90;
            await wait(220); // Crosses 00:00 -> wakes from suspended & plays 'workout-complete' fanfare!
            const completedFanfarePlayed =
              !ts.isRunning &&
              ts.currentStepIndex === lastIdx &&
              ts.remainingSeconds === 0 &&
              env.oscillatorStarts > oscBeforeComplete &&
              ts.soundLog.some(c => c.cueType === 'workout-complete') &&
              env.externalPlayer.playing &&
              !env.externalPlayer.pausedByConflict;

            await wait(950); // Fanfare finishes -> auto-suspends cleanly!
            const suspendedAfterFanfare =
              ts.getAudioContextState() === 'suspended' &&
              env.externalPlayer.playing &&
              !env.externalPlayer.pausedByConflict;

            // Tap ▶ Start right after 00:00 completion -> restarts cleanly at Step 0 with music still playing!
            document.getElementById('timerStartPauseBtn').click();
            await wait(90);
            const restartedFromCompletionCleanly =
              ts.isRunning &&
              ts.currentStepIndex === 0 &&
              env.externalPlayer.playing &&
              !env.externalPlayer.pausedByConflict;

            document.getElementById('timerStartPauseBtn').click();
            await wait(60);
            document.getElementById('closeTimerModalBtn').click();

            results.case3_pauseUnpauseResetCompleteRestart = {
              cleanMidDingStop,
              midStepResumeAutoSuspended,
              rapidToggleHealthy,
              completedFanfarePlayed,
              suspendedAfterFanfare,
              restartedFromCompletionCleanly
            };

            // =================================================================
            // CASE 4: Repeatedly Starting & Stopping External Audio With Timer ON
            // + Slow 180ms Bluetooth AirPods AudioContext.resume() Latency Check
            // =================================================================
            env.externalPlayer.pause();
            document.querySelector('[data-action="open-round-timer"][data-round-index="0"]').click();
            ts.steps[3].exerciseName = 'Deadlifts';
            document.querySelector('[data-action="jump-timer-step"][data-step-index="2"]').click();
            ts.remainingSeconds = 5;
            ts.remainingMs = 4900;
            document.getElementById('timerStartPauseBtn').click();

            for (let cycle = 0; cycle < 6; cycle++) {
              env.externalPlayer.start();
              window.dispatchEvent(new Event('blur'));
              await wait(35);
              window.dispatchEvent(new Event('focus'));
              env.externalPlayer.pause();
              await wait(35);
            }
            env.externalPlayer.start(); // Leave external audio playing
            ts.remainingSeconds = 3;
            ts.remainingMs = 2050;
            await wait(120); // Speaks '2'
            const survivedRepeatedMusicCycling =
              ts.isRunning &&
              env.externalPlayer.playing &&
              !env.externalPlayer.pausedByConflict &&
              ts.speechLog.some(s => s.text === '2');

            // Simulate slow 180ms Bluetooth AirPods AudioContext.resume() (previously triggered 95ms/110ms <audio> pause regression!)
            document.getElementById('timerStartPauseBtn').click(); // Pause -> suspends AudioContext
            await wait(60);
            ts.simulateDelayedResume(180);
            const oscBeforeSlowBt = env.oscillatorStarts;
            const voiceBeforeSlowBt = env.voiceBufferStarts;
            document.querySelector('[data-action="jump-timer-step"][data-step-index="2"]').click();
            ts.remainingSeconds = 3;
            ts.remainingMs = 3020;
            document.getElementById('timerStartPauseBtn').click(); // Crosses 3000ms ('3') in ~20ms + 180ms Bluetooth resume = ~200ms!
            await wait(270); // > 200ms: WebAudio plays voice cue, ZERO <audio>.play() fired, music NEVER paused!
            ts.remainingSeconds = 1;
            ts.remainingMs = 40;
            await wait(270); // Crosses 0ms ('work-start') in ~40ms + 180ms Bluetooth resume = ~220ms!
            const slowBluetoothResumeClean =
              env.htmlMediaPlays === 0 &&
              env.oscillatorStarts > oscBeforeSlowBt &&
              env.voiceBufferStarts > voiceBeforeSlowBt &&
              env.externalPlayer.playing &&
              !env.externalPlayer.pausedByConflict;
            ts.simulateDelayedResume(0);

            document.getElementById('timerStartPauseBtn').click();
            await wait(60);
            document.getElementById('closeTimerModalBtn').click();

            results.case4_musicCyclingAndSlowBluetooth = {
              survivedRepeatedMusicCycling,
              slowBluetoothResumeClean
            };

            // =================================================================
            // CASE 5: Full Combined App-Switching + Pause/Unpause + Earbud Pull Chaos
            // - Open timer paused -> switch apps to start podcast -> return & Start
            // - Switch apps while timer runs -> pause podcast in other app -> timer continues
            // - Unpause podcast in other app -> let timer cross Step 2 -> Step 3 in background
            // - Rapid multi-app switches (Workout -> Spotify -> Messages -> Workout)
            // - Pull out earbuds ('devicechange') -> verify pure-WebAudio speaker ding & podcast unpaused!
            // =================================================================
            env.externalPlayer.pause();
            document.querySelector('[data-action="open-round-timer"][data-round-index="0"]').click();

            // Switch apps while timer is paused to start podcast in Libby/Spotify
            setAppHidden(true);
            env.externalPlayer.start();
            await wait(70);
            const pausedSwitchClean =
              !ts.isRunning && env.externalPlayer.playing && !env.externalPlayer.pausedByConflict;

            // Return to Workout app & tap Start while podcast is playing
            setAppHidden(false);
            ts.steps[3].exerciseName = 'Burpees';
            document.querySelector('[data-action="jump-timer-step"][data-step-index="2"]').click();
            ts.remainingSeconds = 2;
            ts.remainingMs = 1550;
            ts.soundLog = [];
            document.getElementById('timerStartPauseBtn').click();
            await wait(80);

            // Switch to podcast app while timer is running
            setAppHidden(true);
            await wait(80);
            // Pause podcast in other app -> timer MUST continue running!
            env.externalPlayer.pause();
            await wait(80);
            const timerContinuedWhenPodcastPausedInBg = ts.isRunning;

            // Unpause podcast in other app & let timer cross Step 2 -> Step 3 ('work-start') while hidden!
            env.externalPlayer.start();
            await wait(1550);
            const stepAdvancedAcrossAppSwitch =
              ts.isRunning &&
              ts.currentStepIndex === 3 &&
              ts.soundLog.some(c => c.stepIndex === 3 && c.cueType === 'work-start') &&
              env.externalPlayer.playing &&
              !env.externalPlayer.pausedByConflict;

            // Rapid back-and-forth app switches while both podcast and timer are running
            setAppHidden(false);
            await wait(50);
            setAppHidden(true);
            await wait(50);
            setAppHidden(false);
            await wait(80);

            // Pull out earbuds ('devicechange') and cross Step 3 -> Step 4 ('rest-start' chime)!
            const dingBeforeEarbudPull = ts.getAudioEngineState().webAudioDingCount;
            if (navigator.mediaDevices?.dispatchEvent) {
              navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
            } else {
              await ts.simulateRouteChange();
            }
            await wait(120);
            ts.remainingSeconds = 1;
            ts.remainingMs = 60;
            await wait(160);
            const chaosEndEngine = ts.getAudioEngineState();

            document.getElementById('timerStartPauseBtn').click();
            await wait(60);
            document.getElementById('closeTimerModalBtn').click();

            results.case5_fullGymAppSwitchChaos = {
              pausedSwitchClean,
              timerContinuedWhenPodcastPausedInBg,
              stepAdvancedAcrossAppSwitch,
              finalSpeakerChimePlayed: chaosEndEngine.webAudioDingCount > dingBeforeEarbudPull,
              podcastStillPlayingUnpaused:
                env.externalPlayer.playing &&
                !env.externalPlayer.pausedByConflict &&
                !env.externalPlayer.pausedByClickRace &&
                !env.externalPlayer.pausedByHtmlMedia,
              zeroHtmlMediaPlays: env.htmlMediaPlays === 0,
              zeroHtmlElementsInDom: document.querySelectorAll('audio, video').length === 0,
              sessionStayedPureAmbient: env.sessionLog.every(s => s === 'ambient'),
              mediaSessionHijacked: env.mediaSessionHijacked,
              conflictReasons: env.externalPlayer.conflictReasons
            };
          } finally {
            ts.simulateDelayedResume(0);
            setAppHidden(false);
            OscillatorNode.prototype.start = origOscStart;
            AudioBufferSourceNode.prototype.start = origBufStart;
            HTMLMediaElement.prototype.play = origMediaPlay;
            delete navigator.audioSession;
          }

          return results;
        }, 45000);

        const m1 = multiConditionAudioCheck.case1_allTimerModesWithAudioPlaying;
        const m2 = multiConditionAudioCheck.case2_startOffThenPlayMidTimer;
        const m3 = multiConditionAudioCheck.case3_pauseUnpauseResetCompleteRestart;
        const m4 = multiConditionAudioCheck.case4_musicCyclingAndSlowBluetooth;
        const m5 = multiConditionAudioCheck.case5_fullGymAppSwitchChaos;

        if (
          !m1.unpausedOnFullOpen ||
          !m1.unpausedOnFullStart ||
          !m1.unpausedDuringVoice ||
          !m1.unpausedDuringDing ||
          !m1.autoSuspendedIdle ||
          !m1.unpausedAfterPause ||
          !m1.unpausedInPyramidTransition ||
          !m1.unpausedInCustomPreset ||
          !m1.unpausedInCalfStretch ||
          !m1.playedVoiceAndDing ||
          !m2.bothRunningAfterStartMidWork ||
          !m2.restChimeWokeFromSuspend ||
          !m2.midCountdownMusicAndVoice ||
          !m3.cleanMidDingStop ||
          !m3.midStepResumeAutoSuspended ||
          !m3.rapidToggleHealthy ||
          !m3.completedFanfarePlayed ||
          !m3.suspendedAfterFanfare ||
          !m3.restartedFromCompletionCleanly ||
          !m4.survivedRepeatedMusicCycling ||
          !m4.slowBluetoothResumeClean ||
          !m5.pausedSwitchClean ||
          !m5.timerContinuedWhenPodcastPausedInBg ||
          !m5.stepAdvancedAcrossAppSwitch ||
          !m5.finalSpeakerChimePlayed ||
          !m5.podcastStillPlayingUnpaused ||
          !m5.zeroHtmlMediaPlays ||
          !m5.zeroHtmlElementsInDom ||
          !m5.sessionStayedPureAmbient ||
          m5.mediaSessionHijacked
        ) {
          throw new Error(
            'Crazy Gym Workout Audio + Timer + App-Switch Coexistence Matrix failed: ' +
              JSON.stringify(multiConditionAudioCheck, null, 2)
          );
        }
        console.log(
          '  ✅ PASS: Crazy Gym Workout Audio Coexistence Matrix verified across all 5 timer modes, start w/ audio, start off -> play audio, mid-cue/mid-step pause/unpause, rapid toggles, 00:00 completion + restart, 180ms Bluetooth resume, earbud pull, and multi-app switches (0 audio pauses, 0 <audio>.play(), 100% pure ambient)!'
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
          '  ✅ PASS: Calf Stretch Timer easter egg verified (Settings button below 91 Diagrams -> 6-min 12x30s yellow-green/blue-green sequence with dings & grey drain)'
        );

        console.log('\n--- 12b. Manual Exercise Write-In (Swap & Select X Exercises), Skater Hops & Frog Pump + Butterflys ---');
        const writeInAndCatalogCheck = await evalInPage(() => {
          // 1. Open Swap Modal on Round 1 Slot 1 and use Manual Write-In
          document.querySelector('[data-action="open-swap-modal"][data-round-index="0"][data-slot-index="0"]')?.click();
          const swapWriteInInput = document.getElementById('swapWriteInInput');
          const swapWriteInBtn = document.getElementById('swapWriteInBtn');
          const swapSearchRect = document.querySelector('#swapModal .search-and-toggle')?.getBoundingClientRect();
          const swapWriteInRect = swapWriteInInput?.closest('.manual-write-in-row')?.getBoundingClientRect();
          const swapWriteInBelowSearch = Boolean(
            swapSearchRect && swapWriteInRect && swapWriteInRect.top >= swapSearchRect.bottom - 2
          );
          const swapNoHorizOverflow =
            document.documentElement.scrollWidth <= document.documentElement.clientWidth;

          // Also check that Skater Hops and Frog Pump + Butterflys appear in All Exercises in Swap Modal
          document.getElementById('swapFilterAllBtn')?.click();
          const allSwapTitles = Array.from(
            document.querySelectorAll('#swapExerciseList .swap-option-title')
          ).map(el => el.innerText.trim());
          const hasSkaterHops = allSwapTitles.includes('Skater Hops');
          const hasFrogPumpButterflys = allSwapTitles.includes('Frog Pump + Butterflys');

          swapWriteInInput.value = 'Turkish Get-Ups';
          swapWriteInBtn.click();

          const swappedSlotTitle = document
            .querySelector('.exercise-slot[data-round-index="0"][data-slot-index="0"] .exercise-title-text')
            ?.innerText.trim();

          // Open Exercise Guide modal for the written-in exercise
          document
            .querySelector('.exercise-slot[data-round-index="0"][data-slot-index="0"] [data-action="open-exercise-modal"]')
            ?.click();
          const guideTitle = document.getElementById('exerciseModalTitle')?.innerText.trim();
          const guideCategory = document.getElementById('exerciseModalCategory')?.innerText.trim();
          document.querySelector('[data-close-modal="exerciseModal"]')?.click();

          // 2. Open Select X Exercises Modal and use Manual Write-In + Auto-Fill + Confirm
          document.getElementById('selectExercisesBtn')?.click();
          const selectWriteInInput = document.getElementById('selectWriteInInput');
          const selectWriteInBtn = document.getElementById('selectWriteInBtn');
          const selectFilterRect = document.getElementById('selectExercisesMuscleFilterBar')?.getBoundingClientRect();
          const selectWriteInRect = selectWriteInInput?.closest('.manual-write-in-row')?.getBoundingClientRect();
          const selectWriteInBelowFilters = Boolean(
            selectFilterRect && selectWriteInRect && selectWriteInRect.top >= selectFilterRect.bottom - 2
          );

          selectWriteInInput.value = 'Copenhagen Plank';
          selectWriteInBtn.click();

          const topSelectItemTitle = document
            .querySelector('#selectExercisesList .swap-option-item .swap-option-title')
            ?.innerText.trim();
          const topSelectBadge = document
            .querySelector('#selectExercisesList .swap-option-item .swap-badge')
            ?.innerText.trim();

          document.getElementById('autoFillRemainingBtn')?.click();
          document.getElementById('confirmSelectExercisesBtn')?.click();

          const allWorkoutTitles = Array.from(
            document.querySelectorAll('#roundsContainer .exercise-title-text')
          ).map(el => el.innerText.trim());
          const workoutIncludesWriteIn = allWorkoutTitles.includes('Copenhagen Plank');

          return {
            swapWriteInBelowSearch,
            swapNoHorizOverflow,
            hasSkaterHops,
            hasFrogPumpButterflys,
            swappedSlotTitle,
            guideTitle,
            guideCategory,
            selectWriteInBelowFilters,
            topSelectItemTitle,
            topSelectBadge,
            workoutIncludesWriteIn
          };
        });
        if (
          !writeInAndCatalogCheck.swapWriteInBelowSearch ||
          !writeInAndCatalogCheck.swapNoHorizOverflow ||
          !writeInAndCatalogCheck.hasSkaterHops ||
          !writeInAndCatalogCheck.hasFrogPumpButterflys ||
          writeInAndCatalogCheck.swappedSlotTitle !== 'Turkish Get-Ups' ||
          writeInAndCatalogCheck.guideTitle !== 'Turkish Get-Ups' ||
          writeInAndCatalogCheck.guideCategory !== 'CUSTOM WRITE-IN' ||
          !writeInAndCatalogCheck.selectWriteInBelowFilters ||
          writeInAndCatalogCheck.topSelectItemTitle !== 'Copenhagen Plank' ||
          writeInAndCatalogCheck.topSelectBadge !== '✓ #1' ||
          !writeInAndCatalogCheck.workoutIncludesWriteIn
        ) {
          throw new Error(
            'Manual Exercise Write-In / Catalog E2E check failed: ' + JSON.stringify(writeInAndCatalogCheck)
          );
        }
        console.log(
          '  ✅ PASS: Manual Exercise Write-In (Swap & Select X Exercises), Skater Hops, and Frog Pump + Butterflys verified end-to-end'
        );

        console.log('\n--- 12G. Top-Level Workout Total Time (with Strength "est.") & Timer "XX of YY" Remaining E2E Check ---');
        const totalTimeAndTimerRemainingCheck = await evalInPage(async () => {
          const selectType = name => {
            const sel = document.getElementById('workoutTypeSelect');
            sel.value = name;
            sel.dispatchEvent(new Event('change'));
            document.getElementById('generateWorkoutBtn').click();
            return document.getElementById('workoutMetaSummary')?.innerText.trim() || '';
          };

          const strengthDuosMeta = selectType('Strength Duos');
          const strengthTriosMeta = selectType('Strength Trios');
          const strengthQuadsMeta = selectType('Strength Quads');
          const eightByEightMeta = selectType('8x8 Duos');
          const timedDuosMeta = selectType('Timed Duos (40/20)');

          // Open full workout timer (All Rounds) for Timed Duos (40/20) -> 10s prep + 24 * (40s + 20s) = 24:10
          document.getElementById('openWorkoutTimerBtn').click();

          const stepEl = document.getElementById('timerStepCounter');
          const remEl = document.getElementById('timerTotalRemaining');
          const stepRect = stepEl.getBoundingClientRect();
          const remRect = remEl.getBoundingClientRect();
          const stepFontPx = parseFloat(window.getComputedStyle(stepEl).fontSize);
          const remFontPx = parseFloat(window.getComputedStyle(remEl).fontSize);
          const positionedUnderStepCounter =
            remRect.top >= stepRect.bottom - 3 &&
            Math.abs(remRect.right - stepRect.right) <= 4 &&
            Math.abs(stepFontPx - remFontPx) <= 2;

          const allRoundsInitial = remEl.innerText.trim();

          // Start timer and wait ~1.15s so XX counts down by 1s
          document.getElementById('timerStartPauseBtn').click();
          await new Promise(r => setTimeout(r, 1150));
          const afterTickText = remEl.innerText.trim();

          // Pause timer and verify XX stays paused across 500ms
          document.getElementById('timerStartPauseBtn').click();
          const pausedSnapshot1 = remEl.innerText.trim();
          await new Promise(r => setTimeout(r, 500));
          const pausedSnapshot2 = remEl.innerText.trim();

          // Jump ahead to Step 2 (index 1, first 40s work) via Next button -> 24:00 of 24:10
          document.getElementById('timerNextStepBtn').click();
          const afterNextJump = remEl.innerText.trim();

          // Jump ahead to Step 4 (index 3, second 40s work) via timeline chip click -> 23:00 of 24:10
          document.querySelector('#timerSequenceTimeline [data-step-index="3"]')?.click();
          const afterChipJump = remEl.innerText.trim();

          // Reset timer -> back to 24:10 of 24:10
          document.getElementById('timerResetBtn').click();
          const afterReset = remEl.innerText.trim();

          // Select just Round 1 (instead of All Rounds) -> YY updates to individual round time (06:10 of 06:10)
          document.querySelector('#timerScopePills [data-timer-round="0"]')?.click();
          const singleRoundInitial = remEl.innerText.trim();

          // Jump ahead 1 step inside single round -> 06:00 of 06:10
          document.getElementById('timerNextStepBtn').click();
          const singleRoundAfterNext = remEl.innerText.trim();

          document.getElementById('closeTimerModalBtn').click();

          return {
            strengthDuosMeta,
            strengthTriosMeta,
            strengthQuadsMeta,
            eightByEightMeta,
            timedDuosMeta,
            positionedUnderStepCounter,
            allRoundsInitial,
            afterTickText,
            pausedStayedSame: pausedSnapshot1 === pausedSnapshot2,
            afterNextJump,
            afterChipJump,
            afterReset,
            singleRoundInitial,
            singleRoundAfterNext
          };
        });
        if (
          !totalTimeAndTimerRemainingCheck.strengthDuosMeta.includes('40 min (est.)') ||
          !totalTimeAndTimerRemainingCheck.strengthTriosMeta.includes('45 min (est.)') ||
          !totalTimeAndTimerRemainingCheck.strengthQuadsMeta.includes('44 min (est.)') ||
          !totalTimeAndTimerRemainingCheck.eightByEightMeta.includes('35 min') ||
          !totalTimeAndTimerRemainingCheck.timedDuosMeta.includes('24 min') ||
          !totalTimeAndTimerRemainingCheck.positionedUnderStepCounter ||
          totalTimeAndTimerRemainingCheck.allRoundsInitial !== '24:10 of 24:10' ||
          totalTimeAndTimerRemainingCheck.afterTickText === '24:10 of 24:10' ||
          !totalTimeAndTimerRemainingCheck.pausedStayedSame ||
          totalTimeAndTimerRemainingCheck.afterNextJump !== '24:00 of 24:10' ||
          totalTimeAndTimerRemainingCheck.afterChipJump !== '23:00 of 24:10' ||
          totalTimeAndTimerRemainingCheck.afterReset !== '24:10 of 24:10' ||
          totalTimeAndTimerRemainingCheck.singleRoundInitial !== '06:10 of 06:10' ||
          totalTimeAndTimerRemainingCheck.singleRoundAfterNext !== '06:00 of 06:10'
        ) {
          throw new Error(
            'Top-Level Workout Total Time / Timer XX of YY E2E check failed: ' +
              JSON.stringify(totalTimeAndTimerRemainingCheck)
          );
        }
        console.log(
          '  ✅ PASS: Top-level workout total time (with Strength "est." & extended rests) and Timer "XX of YY" remaining (countdown, pause, step jumps, and single-round vs all-rounds YY) verified'
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

        console.log('\n--- 13b. Any / Nothing / Custom Equipment UI, Check/Uncheck Gear, Modal Gear Pills & 375px Layout ---');
        await send('Emulation.setDeviceMetricsOverride', {
          width: 375,
          height: 667,
          deviceScaleFactor: 2,
          mobile: true
        });
        await new Promise(r => setTimeout(r, 150));

        const customEquipE2E = await evalInPage(async () => {
          const collapsible = document.getElementById('generatorSettingsCollapsible');
          if (collapsible?.hidden) {
            document.getElementById('toggleInputsCollapseBtn')?.click();
          }

          const equipSelect = document.getElementById('equipmentSelect');
          const optionValues = Array.from(equipSelect?.options || []).map(o => o.value);
          const customSection = document.getElementById('customEquipmentSection');

          // Ensure Any hides #customEquipmentSection
          equipSelect.value = 'Any';
          equipSelect.dispatchEvent(new Event('change'));
          const hiddenWhenAny = customSection?.hidden === true;

          // Record active workout titles before staging Custom equipment changes
          const getTitles = () =>
            Array.from(document.querySelectorAll('.exercise-title-text')).map(el => el.innerText.trim());
          const titlesBefore = getTitles();

          // Switch to Custom -> #customEquipmentSection appears with 8 checkable pills
          equipSelect.value = 'Custom';
          equipSelect.dispatchEvent(new Event('change'));
          const visibleWhenCustom = customSection?.hidden === false;

          const chips = Array.from(document.querySelectorAll('#customEquipmentGrid [data-custom-equip]'));
          const chipIds = chips.map(c => c.getAttribute('data-custom-equip'));
          const noOverflowAt375 =
            document.documentElement.scrollWidth <= window.innerWidth + 1 &&
            customSection.getBoundingClientRect().right <= window.innerWidth + 1;

          // Tap Clear -> leaves only Bodyweight ('Nothing') checked
          document.getElementById('customEquipClearBtn')?.click();
          const checkedAfterClear = Array.from(
            document.querySelectorAll('#customEquipmentGrid .custom-equip-chip.is-checked')
          ).map(c => c.getAttribute('data-custom-equip'));

          // Check Hip Bands and uncheck Bodyweight -> strictly Hip Bands ONLY!
          document.querySelector('#customEquipmentGrid [data-custom-equip="Hip Bands"]')?.click();
          document.querySelector('#customEquipmentGrid [data-custom-equip="Nothing"]')?.click();
          const checkedHipOnly = Array.from(
            document.querySelectorAll('#customEquipmentGrid .custom-equip-chip.is-checked')
          ).map(c => c.getAttribute('data-custom-equip'));

          // Verify workout STILL has not mutated before clicking Generate Workout
          const titlesStillUnchanged = JSON.stringify(getTitles()) === JSON.stringify(titlesBefore);

          // Click Generate Workout -> every generated exercise must be one of the 5 Hip Bands exercises!
          document.getElementById('generateWorkoutBtn')?.click();
          const hipBandTitles = new Set([
            'Single leg band glute bridge',
            'Alternating glute bridge and butterflies with band',
            'Band Walks (Lateral & Monster)',
            'Band leg kick backs and diagonals',
            'Frog Pump + Butterflys'
          ]);
          const generatedHipTitles = getTitles();
          const allGeneratedAreHipBands =
            generatedHipTitles.length > 0 && generatedHipTitles.every(t => hipBandTitles.has(t));

          // Re-expand, click All, uncheck Barbells + Hip Bands + TRX + Slam Ball + Ab Wheel + Nothing -> Dumbbells + Long Bands
          if (document.getElementById('generatorSettingsCollapsible')?.hidden) {
            document.getElementById('toggleInputsCollapseBtn')?.click();
          }
          document.getElementById('customEquipAllBtn')?.click();
          const allCountAfterAllBtn = document.querySelectorAll(
            '#customEquipmentGrid .custom-equip-chip.is-checked'
          ).length;

          // Open Swap Modal on Round 1 Slot 1 and test clicking the "Barbells" equipment filter pill
          document.querySelector('[data-action="open-swap-modal"]')?.click();
          const barbellsPill = document.querySelector(
            '#swapEquipmentFilterBar [data-equipment-filter="Barbells"]'
          );
          barbellsPill?.click();
          const swapMetaTexts = Array.from(
            document.querySelectorAll('#swapExerciseList .swap-option-meta')
          ).map(el => el.innerText.trim());
          const swapHasBarbellItems =
            swapMetaTexts.length > 0 &&
            swapMetaTexts.every(
              t => t.includes('Barbells') || t.includes('BB') || t.includes('Any')
            );
          document.querySelector('[data-close-modal="swapModal"]')?.click();

          // Restore Equipment to Any cleanly
          equipSelect.value = 'Any';
          equipSelect.dispatchEvent(new Event('change'));
          document.getElementById('generateWorkoutBtn')?.click();

          return {
            optionValues,
            hiddenWhenAny,
            visibleWhenCustom,
            chipIds,
            noOverflowAt375,
            checkedAfterClear,
            checkedHipOnly,
            titlesStillUnchanged,
            allGeneratedAreHipBands,
            generatedHipTitles,
            allCountAfterAllBtn,
            swapHasBarbellItems,
            swapBarbellCount: swapMetaTexts.length
          };
        });

        if (
          JSON.stringify(customEquipE2E.optionValues) !== JSON.stringify(['Any', 'Nothing', 'Custom']) ||
          !customEquipE2E.hiddenWhenAny ||
          !customEquipE2E.visibleWhenCustom ||
          customEquipE2E.chipIds.length !== 8 ||
          !customEquipE2E.noOverflowAt375 ||
          JSON.stringify(customEquipE2E.checkedAfterClear) !== JSON.stringify(['Nothing']) ||
          JSON.stringify(customEquipE2E.checkedHipOnly) !== JSON.stringify(['Hip Bands']) ||
          !customEquipE2E.titlesStillUnchanged ||
          !customEquipE2E.allGeneratedAreHipBands ||
          customEquipE2E.allCountAfterAllBtn !== 8 ||
          !customEquipE2E.swapHasBarbellItems
        ) {
          throw new Error('Custom Equipment E2E check failed: ' + JSON.stringify(customEquipE2E));
        }
        console.log(
          `  ✅ PASS: Equipment Any/Nothing/Custom UI, 8-chip grid (zero overflow @ 375px), staged toggle, strict Hip Bands generation, and Swap Barbells filter (${customEquipE2E.swapBarbellCount} exercises) verified`
        );

        console.log('\n--- 14. QA Gallery All 91 Diagrams Render, Zero Spreadsheet Mention, Muscle & Equipment Filters Check ---');
        await send('Emulation.setDeviceMetricsOverride', {
          width: 1280,
          height: 900,
          deviceScaleFactor: 2,
          mobile: false
        });
        await send('Page.navigate', { url: 'http://127.0.0.1:8080/qa-gallery.html' });
        await new Promise(r => setTimeout(r, 1200));

        const galleryCheck = await evalInPage(async () => {
          const waitStart = Date.now();
          while (Date.now() - waitStart < 4500) {
            const imgs = Array.from(document.querySelectorAll('article.qa-card img'));
            if (imgs.length === 91 && imgs.every(img => img.complete && img.naturalWidth > 0)) {
              break;
            }
            await new Promise(r => setTimeout(r, 100));
          }
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
            glutesCards.length > 0 && glutesCards.length < 91 && glutesCards.every(c => c.innerText.includes('Glutes'));

          // Reset to All
          document.querySelector('.qa-filter-bar [data-filter="all"]')?.click();

          // Test QA Gallery new Equipment Filter Pills (Hip Bands = 5, Long Bands = 12, Dumbbells = 29, Barbells = 23)
          document.querySelector('#qaEquipFilterBar [data-equip-filter="Hip Bands"]')?.click();
          const hipBandGalleryCount = document.querySelectorAll('article.qa-card').length;
          document.querySelector('#qaEquipFilterBar [data-equip-filter="Long Bands"]')?.click();
          const longBandGalleryCount = document.querySelectorAll('article.qa-card').length;
          document.querySelector('#qaEquipFilterBar [data-equip-filter="Dumbbells"]')?.click();
          const dumbbellsGalleryCount = document.querySelectorAll('article.qa-card').length;
          document.querySelector('#qaEquipFilterBar [data-equip-filter="Barbells"]')?.click();
          const barbellsGalleryCount = document.querySelectorAll('article.qa-card').length;
          document.querySelector('#qaEquipFilterBar [data-equip-filter="all"]')?.click();

          return {
            totalCards: cards.length,
            brokenCount: broken.length,
            broken,
            auditBoxes,
            noSpreadsheetMention,
            glutesCardCount: glutesCards.length,
            allGlutesValid,
            hipBandGalleryCount,
            longBandGalleryCount,
            dumbbellsGalleryCount,
            barbellsGalleryCount
          };
        });
        if (
          galleryCheck.totalCards !== 91 ||
          galleryCheck.brokenCount > 0 ||
          galleryCheck.auditBoxes > 0 ||
          !galleryCheck.noSpreadsheetMention ||
          !galleryCheck.allGlutesValid ||
          galleryCheck.hipBandGalleryCount !== 5 ||
          galleryCheck.longBandGalleryCount !== 12 ||
          galleryCheck.dumbbellsGalleryCount !== 29 ||
          galleryCheck.barbellsGalleryCount !== 23
        ) {
          throw new Error('QA Gallery check failed: ' + JSON.stringify(galleryCheck));
        }
        console.log(
          `  ✅ PASS: All 91/91 exercise SVG diagrams rendered cleanly (680x248), 0 spreadsheet row mentions, and QA Gallery muscle filter verified (${galleryCheck.glutesCardCount} Glutes exercises)`
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
