# JoshAl Workout Generator — iPhone PWA

A standalone, offline-ready iPhone Progressive Web App (PWA) port of your Google Sheets + Apps Script Workout Generator, enhanced with:
* **100% Algorithm & Data Parity**: All 68 exercises (`Exercises!A2:O69`) and all 11 workout formats (`Workouts!A2:F12`) with audited biomechanical muscle mappings.
* **Exercise Swap Picker (`⇄ Swap`)**: Swap any exercise in any round via a searchable dropdown (filtered by active inputs or expanded to all 68 exercises, plus a 1-tap random swap).
* **Tappable Exercise Guides + 68 SVG Diagrams**: Tap any exercise name to open an iOS bottom sheet with fact-checked step-by-step form cues and a bespoke vector diagram illustrating posture, equipment, movement vectors, and target muscles.
* **Tappable Workout Format Guides**: Tap the workout title (or `ⓘ Format Info`) to view how the timing, sets, pyramids, or constants work.
* **Per-User Profiles & Settings (`⚙️`)**:
  * **Exercise Exclusion List**: Exclude specific exercises per user profile.
  * **Multi-Option Exercise Slots (`1x`, `2x`, or `3x`)**: Generate 1, 2, or 3 balanced exercise options per slot to pick from on the fly.
  * **Muscle Overload Detection & 1-Tap Auto-Balance**: Automatically warns you if manual exercise selections overload a muscle group (e.g., `Triceps`) and offers 1-tap balanced replacements.

---

## Running Locally

```bash
cd /Users/joshal/workspace/workouts
python3 -m http.server 8080
```
Then open:
* **Workout Generator App**: `http://localhost:8080/index.html`
* **68-Exercise Fact-Check & Diagram Gallery**: `http://localhost:8080/qa-gallery.html`

---

## Running the Automated QA & Diagram Audit Suite

```bash
node tests/run-qa-suite.mjs
node tests/audit-diagrams-to-descriptions.mjs
```

---

## Deploying to GitHub Pages (`workouts.joshal.com`)

1. Push this directory to your GitHub repository `joshal7/workouts`:
   ```bash
   git add CNAME README.md
   git commit -m "Configure custom domain workouts.joshal.com"
   git push origin main
   ```
2. In your DNS provider where you manage `joshal.com` (Cloudflare, Namecheap, Google/Squarespace, etc.), add a DNS record:
   * **Type**: `CNAME`
   * **Name / Host**: `workouts`
   * **Target / Value**: `joshal7.github.io`
   * *(If using Cloudflare, set Proxy to "DNS only" initially so GitHub can verify and issue the Let's Encrypt SSL certificate).*
3. In GitHub: Go to [joshal7/workouts → Settings → Pages](https://github.com/joshal7/workouts/settings/pages):
   * **Source**: `Deploy from a branch`
   * **Branch**: `main` / `/(root)`
   * **Custom domain**: `workouts.joshal.com` (picked up automatically from the `CNAME` file)
   * Check **Enforce HTTPS** (once DNS finishes propagating, usually 1-5 minutes).
4. On your iPhone in Safari, open `https://workouts.joshal.com` and tap **Share → Add to Home Screen** for a full-screen native app experience.

