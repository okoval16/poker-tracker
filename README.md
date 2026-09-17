# Poker Tracker ♠

A tiny static poker tracker for home games. No build step, no backend: one HTML page,
one stylesheet, one script. Profit and loss is logged per night; standings are ranked by net result.

## Features

- **Dashboard** with a podium for the top three, KPI tiles, a leaderboard ranked by net
  result, a net-profit chart, and the most recent game nights.
- **Players** page: add, edit and remove players, pick an emoji avatar, see each player's
  net result, win rate, average, best and worst night.
- **Log results**: enter a whole game night at once (one amount per player, with a
  balance check that the table sums to zero), or log a single result from a player card.
  Full history with per-player filter and delete.
- **Data menu** (footer link "export / import"): export / import JSON, currency symbol, reset.

## Where the data lives

Everything is saved in the browser's `localStorage`. To share standings with the whole table:

1. Open the **Data** menu and click **Export data.json**.
2. Commit the downloaded `data.json` next to `index.html` in the repo.
3. Every visitor loads the published `data.json` automatically when it is newer than
   the copy in their browser. Repeat the export whenever you log new results.

The published file is the source of truth: when it is newer than a visitor's local copy,
it replaces it.

## Deploy to GitHub Pages

1. Create a new repository on GitHub (for example `poker-tracker`).
2. Upload `index.html`, `style.css`, `app.js`, `.nojekyll` and, optionally, `data.json`.
3. In the repo go to **Settings → Pages**, choose **Deploy from a branch**, pick
   `main` and the `/ (root)` folder, and save.
4. After a minute the site is live at `https://<your-user>.github.io/<repo>/`.

Or from the command line:

```bash
cd poker-tracker
git init
git add .
git commit -m "Poker tracker"
git branch -M main
git remote add origin https://github.com/<your-user>/<repo>.git
git push -u origin main
```

Then enable Pages as described in step 3.

## Run locally

Just open `index.html` in a browser. The `data.json` sync is skipped for `file://` URLs;
to test it, serve the folder instead:

```bash
npx serve .
```

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page shell, navigation and dialogs |
| `style.css` | Theme and layout |
| `app.js` | State, rendering, chart, import/export |
| `.nojekyll` | Tells GitHub Pages to serve the files as-is |
| `data.json` | Optional published standings (created by you via Export) |
