# Browser and AI-guard tests

Scripts that drive the running app in Chrome (Playwright) and send attack prompts to the chat APIs.
They are not part of the deployed app: Render never installs this folder's packages.

## Run

1. `cd tests/browser && npm install` (installs `playwright-core`; it uses your installed Chrome)
2. Start the app from the project root: `npm start` (port 8080). Treeko, Aqua and Hazard Lens
   need `GEMINI_API_KEY` in the project's `.env` (never commit it).
3. `node forest.js`

| Script | What it checks |
|---|---|
| `survey.js` | Every page loads; lists visible controls and console errors |
| `forest.js` | Forest Eyes: search, coordinates, radius, Analyze, layers, planner, Treeko, globe |
| `other.js` | Forest/River tabs, Hazard Lens, River Eyes controls |
| `river2.js` | River Eyes nav tabs, water quality, picking a river, Aqua quick chips |
| `water.js` | Water-quality run (Sentinel-2 + Gemma) |
| `slow.js` | Slow AI paths with long waits: Hazard reading, dam sites, Aqua, Treeko site buttons |
| `probe.js` | Whether the map zoom buttons are covered by a panel |
| `guard-test.js` | 12 attacks and 10 real questions against Treeko and Aqua, plus the rate limit |
| `heldout.js` | 5 further attacks not used to tune the guard, plus the 5-turn history case |

The tree planner's recall check against GBIF is `node backend/scripts/validate-tree-fit.js 3 fresh`.

## Results (28 Oct 2026)

`results/` holds the saved output of each run. `shots/` holds the screenshots (about 78 MB, not in git).

Untested: the Retry buttons that only appear after an error.
