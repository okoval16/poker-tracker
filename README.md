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
- **Live sharing**: point `config.js` at a free Firebase Realtime Database and the whole
  group sees one dashboard that updates in real time (see below).
- **Data menu** (footer link "data & sharing"): export / import JSON, currency symbol, reset.

## Where the data lives

Two modes, chosen by `config.js`:

| Mode | When | Who sees what |
|------|------|---------------|
| **Shared** (recommended) | `config.js` contains your Firebase settings | One live table. Everyone who opens the page sees the same standings, and every change appears for all of them within a second. |
| **Local** | `config.js` has `POKER_CONFIG = null` (the default) | Each visitor's browser keeps its own copy. You can publish a snapshot as `data.json` (below). |

The footer shows which mode is active: **Live · shared table** or **Local only**.

### Shared database (Firebase Realtime Database)

Free tier, no server to run, about five minutes of setup:

1. Go to [console.firebase.google.com](https://console.firebase.google.com), click
   **Add project**, give it a name, and turn Google Analytics off (not needed).
2. In the left menu choose **Build → Realtime Database → Create database**. Pick the
   location closest to you and start in **locked mode**.
3. Open the **Rules** tab, replace the contents with the rules below, and click **Publish**.
4. Click the gear icon → **Project settings** → **Your apps** → the web icon `</>`.
   Register the app (any nickname, no hosting) and copy the `firebaseConfig` values.
5. Open `config.js`, replace `window.POKER_CONFIG = null;` with your values following the
   example in that file, commit and push.
6. Reload the site. The footer should say **Live · shared table**. Send the link to your friends.

Rules to paste in step 3:

```json
{
  "rules": {
    "tables": {
      "$tableId": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```

**Who can edit?** Anyone who can open the page can also log results, exactly like a shared
spreadsheet with an "anyone with the link can edit" setting. For a private group of friends
that is usually what you want. If it ever becomes a problem, the next step is Google sign-in
with a list of allowed emails in the rules; ask and it can be added.

**Moving existing data into the shared table:** before switching, open the Data menu and
**Export** in local mode. After the site says Live, use **Import** once; that fills the
shared table for everyone.

**Several groups or seasons:** change `tableId` in `config.js` (for example `season-2027`).
Each id is its own independent table in the same Firebase project.

### Publishing a snapshot instead (local mode)

If you prefer not to set up Firebase:

1. Open the Data menu (footer link) and click **Export data.json**.
2. Commit the downloaded `data.json` next to `index.html` in the repo.
3. Every visitor loads the published `data.json` automatically when it is newer than
   the copy in their browser. Repeat the export whenever you log new results.

## Deploy to GitHub Pages

1. Create a new repository on GitHub (for example `poker-tracker`).
2. Upload `index.html`, `style.css`, `app.js`, `config.js`, `.nojekyll` and, optionally, `data.json`.
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
| `app.js` | State, rendering, chart, import/export, Firebase sync |
| `config.js` | Sharing settings: `null` for local mode, or your Firebase project for a live shared table |
| `.nojekyll` | Tells GitHub Pages to serve the files as-is |
| `data.json` | Optional published snapshot for local mode (created by you via Export) |
