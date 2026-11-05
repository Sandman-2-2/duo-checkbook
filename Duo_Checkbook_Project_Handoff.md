# Duo Checkbook: Project Handoff and Development Specification

**Last updated:** November 4, 2026
**Current version:** v2.0.0 (front end) · API version 2 (backend)
**Status:** Feature-complete for a single user. It passed an automated end-to-end test suite run against a simulated Sheet. Before entering real balances it still needs the manual test checklist in README.md, run on a real iPhone Duo with the real Google Sheet.

## 1. Goal

Duo Checkbook is a free, private, offline-first checkbook Progressive Web App (PWA) for the iPhone Duo (folded and unfolded), desktop Chrome, and other devices. The owner's Google Sheet (ajstclair2@gmail.com) is the **official ledger**.

There is a single user for now. Each record stores the `deviceId` that wrote it, so adding users later means adding a Users tab, not rewriting the data model.

## 2. Architecture

| Layer | Technology | Role |
|---|---|---|
| Front end | Static PWA on GitHub Pages (public repo) | UI, IndexedDB local store, outbox, sync engine |
| Backend | Apps Script web app, container-bound to the Sheet (Execute as: Me, Access: Anyone) | Device auth, validation, idempotent writes, conflicts, summaries, backups |
| Ledger | Google Sheet "Duo Checkbook" | Transactions, Accounts, Categories, Devices, Audit, summary tabs |

- **Transport:** `POST` with a `text/plain` JSON body to avoid CORS preflight. Body: `{action, apiVersion, deviceId, token, ...}`. Actions are `ping`, `pair`, `push`, `pull`.
- **No secrets in the repository.** The `/exec` URL is public. Every request except `ping` and `pair` must carry a valid device token.

## 3. Decisions made (Nov 4, 2026)

| # | Decision |
|---|---|
| 1 | **Categories:** included. A user-editable list (hide/restore) with fixed-ID defaults; payee memory remembers each payee's last category. |
| 2 | **Check numbers:** an optional field on Spending; search with `#1042`. |
| 3 | **Credit cards:** deferred. v2.0 supports Checking, Savings, Cash and Other. |
| 4 | **Hand edits:** the Sheet is managed by the app. Tabs carry warning-only protection. Changes happen in the app (phone, or desktop Chrome via the same URL). Full resync re-pulls everything after any hand edit. |
| 5 | **Conflicts:** the newer edit (by `updatedAt`) wins. The losing version is written to the Audit tab and the app shows a notice. Sequential edits from the same device never count as conflicts. |
| 6 | **Opening balances:** each account has `openingCents` plus `openingDate`, the bank's balance on the start date. Uncleared items are entered as Outstanding. |
| 7 | **v2.0 scope:** sync, pairing, Duo layout, transfers, categories, check numbers, reconciliation. **Later:** recurring entries, credit cards, Face ID lock, PDF statements. |
| 8 | **v1.5 data:** not migrated. Start fresh. |
| — | **One spreadsheet, not one per year.** The 10M-cell cap allows roughly 600k transactions. Annual Summary rolls each year's closing balance into the next year's opening balance and recalculates on every change, so backdated edits stay correct. |
| — | **Device pairing replaces Google sign-in.** In the Sheet, Checkbook → Pair New Device gives a one-time 8-character code (10-minute expiry, 5 attempts). The device receives a 244-bit token, and the Devices tab stores only its SHA-256 hash. A device is revoked with the checkbox on the Devices tab. |

## 4. Data model (Sheet columns)

- **Transactions:** `id`, `seq`, `version`, `date` (YYYY-MM-DD text), `type` (expense/income/transfer), `accountId`, `account`*, `toAccountId`, `toAccount`*, `amountCents`, `amount`*, `payee`, `category`, `checkNumber`, `note`, `receiptUrl`, `cleared`, `toCleared`, `createdAt`, `updatedAt`, `deletedAt`, `deviceId`
- **Accounts:** `id`, `seq`, `version`, `name`, `kind`, `openingCents`, `openingBalance`*, `openingDate`, `color`, `logo` (data URL ≤45k chars, or an https link), `archived`, `sortOrder`, `createdAt`, `updatedAt`, `deviceId`
- **Categories:** `id`, `seq`, `version`, `name`, `kind` (expense/income), `archived`, `sortOrder`, `createdAt`, `updatedAt`, `deviceId`
- **Devices:** `deviceId`, `name`, `tokenHash`, `pairedAt`, `lastSeen`, `revoked`, `userAgent`
- **Audit:** `timestamp`, `mutationId`, `deviceId`, `entity`, `entityId`, `action`, `result`, `before`, `after`

\* Display-only columns written by the server. Code reads only the cents and ID columns.

**Rules:**

- **Money:** always integer cents.
- **Balances:** derived as opening balance plus the effects of all non-deleted transactions.
- **Transfers:** one row with a from-account and a to-account, so they apply atomically. They are excluded from income and spending totals. Each side clears separately (`cleared` / `toCleared`).
- **Deletes:** tombstones (`deletedAt`). Rows are never removed.
- **Spreadsheet-formula safety:** text that starts with `= + - @` is written with a leading apostrophe.

## 5. Sync protocol

- **Local save:** writes the record and an outbox entry in **one IndexedDB transaction** before showing "Saved." Edits to the same record that haven't been sent are merged into one outbox entry, which gets a new `mutationId` and keeps the original `baseVersion`.
- **Push:** sends up to 50 mutations as `{mutationId, entity, record, baseVersion}`. The server checks the Audit tab's `mutationId` column, so a duplicate is acknowledged and not reapplied. Per-mutation result statuses are `applied`, `duplicate`, `conflict_won`, `conflict_lost` and `rejected`. An entry leaves the outbox only once its result comes back.
- **Pull:** `since = lastSeq` returns every record with `seq > since`. With `since = 0` the server returns a full snapshot and the client replaces its stores, keeping any records with pending outbox entries.
- **Triggers:** app start, `online`, `visibilitychange`/`pageshow`, about 0.7 seconds after each save, every 60 seconds while the app is visible, and manual Sync now / Full resync. On error the app retries with backoff from 5 seconds up to 2 minutes.
- **Version checks:**
  - The client sends `apiVersion: 2`. A mismatch returns `upgrade_required`, and the app shows a Refresh banner.
  - The service worker waits for the user to tap Refresh before activating (`SKIP_WAITING`).
- **Write safety:** writes run under `LockService`. Summary tabs are rebuilt after every push that changes data.

## 6. Files

| File | Purpose |
|---|---|
| `index.html` | Shell, early theme script |
| `styles.css` | Light/dark tokens, phone layout, two-panel layout at ≥760px (`widePanelMinWidth` in config) |
| `app.js` | All UI, IndexedDB, outbox, sync engine, pairing, reports, reconcile, branding |
| `config.js` | `/exec` endpoints (live/test), version, wide-layout breakpoint |
| `sw.js` | Network-first app-shell cache, user-approved updates; never touches Google requests |
| `manifest.webmanifest`, `icon-180/192/512.png`, `icon-maskable-512.png` | PWA install |
| `backend/Code.gs`, `backend/appsscript.json` | Apps Script backend (paste into the Sheet's script project) |
| `README.md` | Setup, everyday use, update procedure, test checklist |

## 7. Verified by automated test (simulated Sheet + Chromium)

44 checks passed on three consecutive runs:

- **Pairing:** a wrong code is rejected and a code works only once.
- **Local first:** an account created before pairing syncs afterward.
- **Offline:** offline entries update the balance and survive an offline reload served from the service-worker cache, then all sync on reconnect.
- **No duplicates:** when the response to a push is lost, the retry does not create a duplicate row.
- **Audit:** every change is logged.
- **Formula safety:** a formula injection is neutralized.
- **Transfers:** balances and totals are correct, and the annual summary shows opening and closing balances.
- **Delete:** swipe-to-delete with Undo works.
- **Conflicts:** the newer edit wins, the conflict is written to Audit, and the app shows the winning version.
- **Refusals:** revoked devices, wrong tokens and outdated app versions are refused.
- **Fold/unfold:** the draft is kept in both directions.
- **Search:** amount search and range search work.
- **Reconcile:** the outstanding list is correct.
- **Payee memory:** suggestions appear.
- **Errors:** no page errors.

**Not verifiable in automation, so test manually:**

- Real Apps Script deployment, including the redirect to googleusercontent and real quotas.
- iOS Safari behavior: the installed Home Screen app's storage, keyboard, gestures and real Duo screen widths.
- The nightly backup trigger running in Google Drive.

## 8. Next priorities

1. Run the README test checklist on the real Duo and the real Sheet. Tune `widePanelMinWidth` using Settings → Screen.
2. Run alongside the bank for 2–4 weeks with monthly reconciliation.
3. Then decide on v2.1: recurring entries, credit card accounts (liability sign, payments as transfers), an optional Face ID/WebAuthn app lock, and PDF statements per account and month.
4. If other users are added: a Users tab, a per-user allowlist, and scoping every read and write by user.
