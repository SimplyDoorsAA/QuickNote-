# QuickNote

Personal quick-note capture app — see [`SPEC.md`](SPEC.md) for the full
design and open decisions.

## What's here

- **Frontend** (`index.html`, `app.js`, `sw.js`, `manifest.webmanifest`,
  `icon.svg`) — an installable PWA. Capture is local-first: a note saves
  to the browser's IndexedDB and returns instantly, then syncs to the
  backend in the background when online.
- **Backend** (`backend/`) — a Google Apps Script Web App you deploy
  yourself under your own Google account. See
  [`backend/README.md`](backend/README.md) for exact setup steps — this
  part needs your Google account and a Gemini API key, so it can't be
  deployed from here.

## Running the frontend locally

Service workers require `http(s)://`, not `file://`. Serve the folder with
any static server, e.g.:

```
npx serve .
# or
python3 -m http.server 8080
```

Then open it in a browser. Without the backend deployed yet, capture and
local storage work fully; sync will just stay in "pending" state until
Settings has a real endpoint URL and token (see `backend/README.md`).

## Deploying the frontend

Push this repo (or just these files) to GitHub Pages, or any static host.
No build step — it's plain HTML/CSS/JS.

## Status

Architecture-stage build, not yet tested end-to-end against a real Google
account. See `SPEC.md` §7 for open decisions (call audio retention, Gmail
backfill window, editable vs. append-only notes, photos) and the honest
"untested" note at the bottom of `backend/README.md`.
