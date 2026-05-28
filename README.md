# TSIP Leaderboard

A static website that reads a Google Sheets claim sheet live, computes three leaderboards (Full Task, Rubric-Only, Combined), and lets admins overlay corrections and snapshot weekly archives. Deploys to GitHub Pages. No build step.

## What it does

- Live-fetches two tabs (`Full Task` and `[RTF] Rubric-Only`) from the configured Google Sheet on every page load, plus on demand via the **Refresh** button.
- Computes per-person scores: `net = max(0, completed − outstanding redos)`. A row counts as completed when its `Done?` checkbox is `TRUE`. A row that is flagged `REDO` but hasn't been re-done yet subtracts 1 from the score.
- Tracks a cumulative redo counter (each `REDO` flag = 1; Full Task adds an extra 1 when the row hits a second redo).
- Three in-page tabs across the top of the page: **Combined** (default), **Full Task**, **Rubric-Only**.
- A **View** dropdown switches between the current live data and any past week that's been archived.
- Click any name on any board to see the row-level breakdown.
- A password-protected admin overlay lets an admin override counts, add overlay-only people, add aliases (to merge `Antoniio V` and `Antonio V`), and start a new week (which snapshots current standings to the archive and points the site at a new sheet).

## Files

- `index.html` — markup for the public page, history modal, password gate, admin panel, overlay editor, and swap-week modal.
- `styles.css` — visual styling.
- `script.js` — Firebase init + status pill, CSV fetch + parse, scoring engine, overlay application, all admin flows, real-time Firestore listeners.
- `README.md` — this file.

## 1. Firebase project setup

The repo ships with Firebase config pre-filled for the existing TSIP Leaderboard project. If you're re-using it, **skip to §2**. To wire up a new project:

1. Go to <https://console.firebase.google.com> → **Add project** → disable Google Analytics.
2. Open the new project → **Databases & Storage → Firestore Database → Create database**. Pick a region (`nam5 (us-central)` is a good default), choose **Standard edition** if asked, and **Start in test mode**.
3. Project Settings → **General** → scroll to **Your apps** → click the `</>` (web) icon → register a web app. Copy the `firebaseConfig` it shows.
4. Open `script.js` and replace the values inside the `FIREBASE_CONFIG = { … }` block at the top with the ones you just copied.

### Firestore security rules

Test mode allows public reads + writes for 30 days, then locks down. To extend access, replace the rules under **Firestore → Rules** with the snippet below (public read, open write — gated client-side by `ADMIN_PASSWORD`):

```firestore
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /meta/{id}        { allow read: if true; allow write: if true; }
    match /overlays/{id}    { allow read: if true; allow write: if true; }
    match /aliases/{id}     { allow read: if true; allow write: if true; }
    match /archives/{id}    { allow read: if true; allow write: if true; }
  }
}
```

The password is enforced only in JavaScript — anyone reading the page source can see it. For an internal team tool that's usually fine. If you need a stronger lock, enable Firebase Auth (anonymous sign-in) and gate writes on `request.auth != null` plus a custom claim.

## 2. Setting / changing the admin password

Open `script.js`, find `ADMIN_PASSWORD = "Meridian_Admin_26"` near the top, change the string, save, and redeploy. Same session timeout: passwords aren't remembered between page refreshes — admins re-enter it after closing the tab.

## 3. Deploy to GitHub Pages

1. Create a new public repo (or reuse the existing `tsip-leaderboard` repo). Add the four files at the repo root.
2. **Settings → Pages → Source: Deploy from a branch → Branch: `main` / (root)** → Save.
3. After ~30 seconds, the URL is `https://<your-username>.github.io/<repo-name>/`. Updates to the files are deployed automatically when you commit.

If you're updating the existing repo, just upload the four files (let GitHub overwrite the old ones) and commit — Pages picks up the change.

## 4. How to swap the weekly sheet

When you're ready to "close" the current week and start fresh on a new sheet:

1. Open the live site → click **Admin** in the footer → enter the password → set "Your name" if it asks.
2. Scroll to **Start new week / swap sheet** → click the button.
3. In the modal:
   - **New claim-sheet URL** — paste the new sheet's link (anything containing `/d/<sheetId>/` works; the app extracts the ID).
   - **Label for the week being closed** — pre-filled from the date range it found in the current sheet. Edit if you'd like a friendlier label (e.g. `5/25 – 5/31`).
4. Click **Snapshot & swap**.

What happens behind the scenes:

- The current overlaid standings for all three boards (plus each person's row-level breakdown) are written to a new `archives/<id>` document.
- All existing overlays are deleted (new week starts clean — admins can add fresh overlays for the new week).
- `meta.currentSheetId` is updated to point at the new sheet.
- The page immediately re-fetches the new sheet and renders it.

The archived week is permanently browsable via the **View** dropdown at the top of every leaderboard.

## 5. Day-to-day admin usage

All admin actions live behind the footer **Admin** link.

- **Overrides** — Lists every person currently on the boards. Click **Edit overlay** to set custom Full Task or Rubric values. Each input shows the live value as a placeholder; leave a field blank to revert it to live. Use **Remove all overlays for this person** to wipe their adjustments entirely.
- **Add overlay-only person** — Adds someone who isn't in the sheet. They appear on the boards with whatever counts you set.
- **Aliases / rename** — If someone is typed as `Antoniio V` in the sheet but should display as `Antonio V`, add an alias here. Aliases also merge two name variants into one contributor on the board.
- **Start new week / swap sheet** — see §4.

Every adjustment is attributed to the name you set under "Logged in as" and logged in that person's history modal with a timestamp.

## 6. If it's not working

### Firebase status pill

The pill in the top right of the page shows the Firebase connection state:

- **Grey "Firebase: connecting…"** — initial state while the page boots. Should change within a couple of seconds.
- **Green "Firebase: connected"** — Firestore is reachable. Admin features available.
- **Red "Firebase: not connected"** — initialization or the first Firestore read failed. Hover (or click) the pill to see the error.

If the pill is red:

- The live leaderboards **will still render** from the Google Sheet — the page degrades gracefully. Only the admin overlay and the archive selector go offline until Firebase recovers.
- **Top 3 causes:**
  1. **`FIREBASE_CONFIG` was pasted wrong.** Re-check the values in `script.js` against the snippet in **Firebase → Project Settings → General → Your apps**. The pill tooltip usually says `Failed to get document because the client is offline` or similar in this case.
  2. **Firestore database isn't enabled.** Go to **Firebase Console → Firestore Database** and click Create database if it hasn't been done yet.
  3. **Test-mode rules expired.** Test mode auto-locks after ~30 days. Open **Firestore → Rules** and paste the snippet from §1.

### Sheet not loading

If the leaderboards show "Couldn't load the claim sheet":

- Open the sheet in a separate tab. It must be shared **Anyone with the link can view** (the gviz CSV endpoint won't authenticate per-user).
- The current sheet ID is shown at the top of the admin panel — verify it's the one you expect. If not, swap to the correct sheet via the **Start new week / swap sheet** flow (you can re-use the same ID by pasting the same URL).

### Numbers look wrong

Open the browser console (F12 → Console). On every fetch the page logs grouped `[scoring] Full Task` and `[scoring] Rubric-Only` blocks with per-person breakdowns (completed, outstanding redos, net, redo counter). Compare those to the sheet. If something's off, the fastest way to get help is to copy the relevant `[scoring]` lines into a message — they tell us what the parser saw.

### "How do I read the browser console?"

Right-click anywhere on the page → **Inspect** → click the **Console** tab. Any errors appear in red. Selecting and copy-pasting the red text into a help message is usually enough for diagnosis.

## 7. Data model (Firestore)

```
/meta/site
  currentSheetId: string      // active claim sheet
  schemaVersion:  number
  updatedAt:      serverTimestamp

/overlays/{personKey}         // personKey = normalized lowercase display name
  displayName:    string
  addedByOverlayOnly: boolean // true if this person isn't in the sheet
  fullTask: { completed?: number, redoCounter?: number }
  rubric:   { completed?: number, redoCounter?: number }
  adjustments: [{ board, field, from, to, by, at }]
  updatedAt:      serverTimestamp

/aliases/{sheetNameKey}       // sheetNameKey = lowercase of the source spelling
  canonical:      string      // display name to use instead
  by:             string
  at:             serverTimestamp

/archives/{weekLabel}         // weekLabel slug like "2026-05-25_to_2026-05-31"
  weekLabel:      string
  rangeLabel:     string      // human label, e.g. "5/25 – 5/31"
  sourceSheetId:  string
  archivedBy:     string
  archivedAt:     serverTimestamp
  boards: {
    fullTask: [{ rank, name, completed, outstandingRedo, redoCounter, netScore }],
    rubric:   [{ rank, name, completed, outstandingRedo, redoCounter, netScore }],
    combined: [{ rank, name, fullTaskNet, rubricNet, totalRedos, score }],
  }
  perPersonHistory: { [personKey]: { displayName, fullTask, rubric, adjustments } }
```
