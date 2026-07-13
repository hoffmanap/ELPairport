# Texas OD & Catchment Console — GitHub Pages deployment

This is a **zero-build static site**. No npm install, no bundler, no local dev
environment needed — every file here can be uploaded directly through
GitHub's web UI and it will just work.

## How it's built

- `index.html` loads React, Recharts, lucide-react, and d3 straight from a
  CDN (esm.sh) as native browser ES modules — no build step.
- `app.js` is the dashboard component, already compiled from JSX to plain
  JavaScript, so the browser can run it as-is.
- `data/summary.json`, `data/tx_counties.geo.json`, `data/regions.json` are
  the static data files the app fetches at runtime. **These are the files
  you'll replace each time you process a new extract** — the app code never
  needs to change for that.

## One-time setup

1. Create a new GitHub repository (public, unless you're on a paid plan that
   supports Pages on private repos).
2. Upload these files, **keeping the folder structure**:
   ```
   index.html
   app.js
   data/summary.json
   data/tx_counties.geo.json
   data/regions.json
   ```
   In GitHub's web UI: **Add file → Upload files**, then drag the whole
   `data` folder in along with `index.html` and `app.js` — modern GitHub
   supports dragging a folder and it preserves the path.
3. Go to **Settings → Pages**. Under "Build and deployment", set **Source:
   Deploy from a branch**, branch **main**, folder **/ (root)**. Save.
4. GitHub gives you a URL like `https://yourusername.github.io/repo-name/`
   within a minute or two. That's it — live.

## Updating with new data (every time you run a new extract)

1. Run the pipeline locally (you have Python, so this runs on your machine):
   ```
   python aggregate.py --manifest manifest_small.json --history history.json --out data/
   python aggregate.py --manifest manifest_large.json --history history.json --out data/
   ```
   (or single-file mode for one airport at a time — see `aggregate.py`'s
   own docstring for both usages)
2. This regenerates `data/summary.json` in your local `data/` folder.
3. In GitHub's web UI, open `data/summary.json` in the repo and use the
   pencil (edit) icon, or just re-upload via **Add file → Upload files** —
   uploading a file with the same name and path overwrites it.
4. Nothing else needs to change. `index.html` and `app.js` stay exactly the
   same; the site picks up the new numbers on next page load.

## Important: keep `history.json` OUT of the public repo

`history.json` (produced by `aggregate.py`) is more granular than
`summary.json` — it's still county-level, never device-level, but there's
no reason to publish it. Keep it on your own machine, not in the GitHub
repo. Only `data/summary.json`, `data/tx_counties.geo.json`, and
`data/regions.json` need to be in the Pages repo — those are what
`index.html` actually fetches.

## Files in this delivery

| File | Purpose |
|---|---|
| `index.html` | Page shell, CDN imports, mounts the app |
| `app.js` | The dashboard, pre-compiled from JSX — don't hand-edit unless you also have a JSX→JS toolchain |
| `data/summary.json` | ELP catchment data (only airport processed so far) |
| `data/tx_counties.geo.json` | Texas county boundary geometry for the map |
| `data/regions.json` | El Paso Borderplex region rollup |
| `aggregate.py` | Pipeline script — run locally to regenerate `data/summary.json` from new extracts |
| `county_names.json` | County FIPS → name lookup used by `aggregate.py` |
| `manifest_small.json` / `manifest_large.json` | Batch file lists matching your small/large extract split |

## If you ever want a "real" build instead

This zero-build setup is the right call for uploading via the GitHub web UI.
If you later move to pushing from your own machine, a proper Vite + Tailwind
build (with `npm run build`) will load faster and is more maintainable long
term — happy to set that up when you're ready for it.
