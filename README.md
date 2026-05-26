# TSIP Leaderboard

A weekly-resetting, manually-managed task leaderboard. Static site that runs on GitHub Pages. Firebase Firestore (free tier) provides shared persistent storage so every visitor sees the same data. Chart.js renders the top-5 bar chart. No build step.

## What it does

- Shows tasks completed **this week only** — Monday 12:00 AM through Sunday 11:59 PM **Eastern**.
- Everyone resets to 0 every Monday morning automatically (entries are filed by the date the work was done, not when they were typed in).
- Click a contributor's name to see their full week-by-week history, including last week's results from the one-time Google Sheet import.
- Admins enter task counts manually behind a password gate — single entry, bulk paste, edit/delete, rename, one-time historical import.

## Files

- `index.html` — markup for the public view, history modal, password gate, and admin panel.
- `styles.css` — all visual styling.
- `script.js` — Firebase init, real-time listeners, render logic, admin flows, historical-import parser.
- `README.md` — this file.

## 1. Firebase project setup

1. Go to <https://console.firebase.google.com> and click **Add project**. Disable Google Analytics (not needed).
2. In the project, open **Build → Firestore Database → Create database**. Pick a region close to your users (e.g. `nam5`). Start in **Test mode** for the first day so writes work without auth — you'll lock it down below.
3. Open **Project settings → General → Your apps**. Click the `</>` "Web" icon and register a new web app (no Firebase Hosting needed). You'll get a config object that looks like:

   ```js
   const firebaseConfig = {
     apiKey:            "AIza…",
     authDomain:        "your-proj.firebaseapp.com",
     projectId:         "your-proj",
     storageBucket:     "your-proj.appspot.com",
     messagingSenderId: "1234567890",
     appId:             "1:1234567890:web:abc123…",
   };
   ```

4. Open `script.js` and paste those values into the `FIREBASE_CONFIG` object at the top.
5. Set the `ADMIN_PASSWORD` constant directly below it to whatever shared password you want admins to use.

### Firestore security rules (do this after launch)

Test mode lets anyone read or write. Replace the rules under **Firestore → Rules** with the snippet below to keep public reads but disallow public writes. Admin writes will then need to be brokered through a small Cloud Function or temporarily re-opened. Since this app has no server-side auth, a pragmatic compromise is:

```firestore
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /entries/{id} {
      allow read: if true;
      allow write: if true;  // gated client-side by ADMIN_PASSWORD
    }
    match /meta/{id} {
      allow read: if true;
      allow write: if true;
    }
  }
}
```

The password is enforced client-side only — anyone who can read the JavaScript can see it. If you need a real lock, enable Firebase Auth + Anonymous sign-in and require `request.auth != null` plus a custom claim. For an internal team tool this is usually unnecessary.

## 2. Deploy to GitHub Pages

1. Create a new GitHub repo (e.g. `tsip-leaderboard`) and commit `index.html`, `styles.css`, `script.js`, `README.md` to the default branch.
2. In the repo, open **Settings → Pages**. Source: **Deploy from a branch**. Branch: `main` / folder: `/ (root)`. Save.
3. Wait ~30 seconds, then visit `https://<your-user>.github.io/tsip-leaderboard/`.
4. Back in the Firebase Console under **Authentication → Settings → Authorized domains**, add your GitHub Pages domain. (You can skip this if you're not using Firebase Auth — Firestore reads/writes don't require it.)

The site is purely static — no build, no bundler. Edit the three files and push; GitHub Pages will redeploy automatically.

## 3. One-time historical import

The historical-import button appears in the admin panel **only when `meta.historicalImported` is false** (the default before it's been run).

What it does:

1. Fetches two tabs from the source Google Sheet as CSV via the public `gviz` endpoint:
   - **Claim Sheet** — counts every row whose `Task Completed` is truthy, grouped by `Claimed By`. Tasks flagged "Sent Back for Fixes" still count as long as `Task Completed` = TRUE.
   - **Model Decomp Summary** — scans for every header cell containing "task" + "done"/"completed" (excluding "prompt"), reads the (name, count) table under each, and takes the **higher** value per person across the two side-by-side tables. The "Prompts Done" table is intentionally skipped.
2. Applies name normalization (whitespace collapse, alias map, drop `End`).
3. Builds the roster from the **union** of names across both tabs — every unique person is written, including those with 0 tasks.
4. Writes one entry per person with `type: "historical"`, `enteredBy: "System"`, `date: "2026-05-25"`, `weekStart: "2026-05-19"`, `taskCount` = non-decomp + decomp-max.
5. Sets `meta.historicalImported = true` so the button disappears.

To run it: open the admin panel, scroll to **One-time historical import (last week)**, click the button, and confirm. Watch the console (and the in-panel log) — it prints the full per-person breakdown:

```
[import] Per-person breakdown:
   Antonio V         non-decomp=4  decomp(small=0, big=2, used=2)  total=6
   Richards C        non-decomp=2  decomp(small=1, big=3, used=3)  total=5
   …
```

The script auto-logs a sanity check that **Richards C** picks up ≥ 3 model decomp tasks (the "higher of two tables" rule). If it logs less than 3, the parser didn't find the bigger table — re-check the Model Decomp Summary tab's headers.

### Re-importing

There is no built-in re-import. If something looks wrong:

- Use **Edit existing entries** in the admin panel to fix individual rows.
- To wipe the historical block and try again, delete every `entries` doc with `type == "historical"` in the Firestore console, then delete the `meta/site` doc, then reload the page. The button will reappear.

### A note on the constants

The source spec sets `HISTORICAL_WEEK_START = "2026-05-19"` and labels it as "the Monday of the week being imported". In the 2026 calendar that date is technically a Tuesday — but those values are written **verbatim** onto every historical entry as its `weekStart` and `date`, so the user-facing label "Week of 5/19 – 5/25" comes out exactly as specified, and current-week queries (which compute Monday from `now()`) won't collide with it. If you'd rather have the historical bucket sit on a real Monday, update the two constants in `script.js` to `2026-05-18` / `2026-05-24` before running the import.

## 4. Day-to-day admin usage

Open the page, click **Admin** at the bottom, enter the password. The first time you click in during a session you'll be prompted for "Your name" — every entry you save is attributed to that name, kept in `sessionStorage` for the rest of the browser session, and clearable via the "change" link.

Sections, top to bottom:

- **How the admin panel works** — built-in walkthrough.
- **One-time historical import** — only visible until you run it.
- **Add a single entry** — pick a person from the dropdown or type a new name; pick a date; enter the count; Save.
- **Bulk paste** — one date for the whole paste, then rows of `Name <tab/space/comma> Count`. Multi-word names work — the last token is the count. Click **Preview** to see the parsed table, then **Save all**.
- **Edit existing entries** — filterable by person/week; Edit recomputes `weekStart` if the date changes; Delete confirms before removing.
- **Rename a person (bulk)** — merge two name variants by rewriting every entry tied to the original.

There is no "reset" button. Weeks roll over automatically at midnight Eastern because the leaderboard query is `where weekStart == thisMonday`.

## 5. Backdating

If you enter a task with last Sunday's date today, the entry lands in **last week's** bucket — it shows up in that person's history view for last week, not this week's leaderboard. To credit a task to the current week, give it a date in the current week (Monday → Sunday, Eastern).

## 6. Data model (Firestore)

`entries` collection — one doc per task entry:

| Field         | Type              | Description |
|---------------|-------------------|-------------|
| `name`        | string            | Lowercase normalized name (matching key) |
| `displayName` | string            | Original capitalization for UI |
| `taskCount`   | number            | Can be 0 |
| `date`        | string YYYY-MM-DD | Date the work was done |
| `weekStart`   | string YYYY-MM-DD | Monday of the week `date` falls in (Eastern) |
| `enteredBy`   | string            | Admin's name, or "System" for the import |
| `type`        | "historical" \| "manual" | |
| `createdAt`   | serverTimestamp   | When the doc was written |

`meta/site` doc:

| Field                  | Type            |
|------------------------|-----------------|
| `historicalImported`   | boolean         |
| `historicalImportedAt` | serverTimestamp |

## 7. Troubleshooting

- **"Firebase init failed"** toast — `FIREBASE_CONFIG` still has the placeholder values. Paste the real config from the Firebase console.
- **Permission-denied on writes** — Firestore rules are blocking writes. Check the rules tab and use the snippet in §1.
- **Import button does nothing** — open DevTools console; the import logs every step. The most common cause is the Google Sheet not being shared publicly ("Anyone with the link can view").
- **Richards C has fewer than 3 decomp tasks after import** — the parser didn't find the larger of the two Model Decomp Summary tables. The import log lists every detected "task done" header cell with its row/column — verify the larger table's header reads something like "Tasks Done" or "Tasks Completed" (and doesn't contain the word "prompt").
- **The leaderboard shows the wrong week** — check the console: on every load the script logs `[tsip] current Eastern date … → weekStart …`. If that doesn't match what you expect, the browser's clock or timezone tables are off.
