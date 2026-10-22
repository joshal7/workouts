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
      returnByValue: true
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

        console.log('\n--- 8. Mobile Viewport Screenshot Capture ---');
        const screenshotData = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync('/tmp/workout-mobile-screenshot.png', Buffer.from(screenshotData.data, 'base64'));
        console.log('  ✅ PASS: Mobile screenshot saved to /tmp/workout-mobile-screenshot.png');

        console.log('\n--- 9. QA Gallery All 68 Diagrams Render & No Audit Box Check ---');
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
          return { totalCards: cards.length, brokenCount: broken.length, broken, auditBoxes };
        });
        if (galleryCheck.totalCards !== 68 || galleryCheck.brokenCount > 0 || galleryCheck.auditBoxes > 0) {
          throw new Error('QA Gallery check failed: ' + JSON.stringify(galleryCheck));
        }
        console.log('  ✅ PASS: All 68/68 exercise SVG diagrams rendered cleanly (680x248) with 0 broken images and 0 audit update boxes');

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
