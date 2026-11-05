# Duo Checkbook v2.0 — Setup Guide

A private checkbook web app for your phone and computer. Every entry is saved on the device first, then synced to **your own Google Sheet**, which is the official ledger. It works offline and catches up when you reconnect.

```
Phone / Chrome app (GitHub Pages)  ──►  Apps Script web app  ──►  Google Sheet (official ledger)
   saves locally first                   checks device key          nightly backup to Drive
   queues changes offline                no duplicates, conflicts
```

Setup takes about 20 minutes. Do it on a computer, signed in to **ajstclair2@gmail.com**.

---

## Part 1 — Create the Sheet and backend

1. **Create the Sheet.** Go to sheets.google.com → Blank. Name it **Duo Checkbook**.
2. **Open Apps Script.** Choose **Extensions → Apps Script**.
3. **Paste the code.** Delete everything in `Code.gs`, then paste in the contents of `backend/Code.gs` from this package.
4. **Paste the manifest.**
   1. Click ⚙️ **Project Settings** and turn on **Show "appsscript.json" manifest file in editor**.
   2. Back in the editor, open `appsscript.json` and replace its contents with `backend/appsscript.json`.
   3. Click 💾 **Save**.
5. **Run setup.** Go back to the Sheet tab and reload it. A **Checkbook** menu appears; choose **Checkbook → Set Up / Repair Sheet**.
   - Google asks for permission. Because this is your own script, it shows "Google hasn't verified this app." Click **Advanced → Go to Duo Checkbook (unsafe) → Allow**. This is normal for personal scripts.
   - Setup creates these tabs:

     | Tab | What it holds |
     |---|---|
     | Transactions | Every entry |
     | Accounts | Your accounts and starting balances |
     | Categories | Spending and income categories, already filled in |
     | Devices | Each paired phone or computer |
     | Audit | A log of every change |
     | Monthly Summary, Annual Summary, Category Summary | Totals, rebuilt by the script |

   - Setup also turns on the nightly backup.
6. **Deploy the web app.**
   1. In Apps Script, choose **Deploy → New deployment**. Click the gear and pick **Web app**.
   2. Set **Execute as: Me** and **Who has access: Anyone**.
   3. Click **Deploy**, then copy the **Web app URL**. It ends in `/exec`.

> **Why "Anyone" is safe:** the address only answers devices you've paired. Pairing needs a one-time code that only appears inside your Sheet.

## Part 2 — Publish the app on GitHub Pages

1. **Create the repository.** Make a new **public** repository named `duo-checkbook`. Free GitHub Pages needs a public repo.
2. **Upload the files.** Upload everything in this package to the repository root, keeping the `backend/` folder. Upload the files themselves, not the ZIP.
   - The code contains no secrets. Your data lives only in your Sheet and on your devices.
3. **Add your Sheet address.** Edit `config.js` in GitHub and paste the `/exec` address between the quotes on the `live:` line. Commit.
4. **Turn on Pages.** Go to **Settings → Pages → Deploy from a branch → `main` → `/(root)` → Save**.
5. **Open the app.** After a minute or two it's at `https://YOUR-USERNAME.github.io/duo-checkbook/`.

## Part 3 — Install and pair each device

### iPhone

1. Open the GitHub Pages address in **Safari**, then tap **Share → Add to Home Screen**.
2. **Open the app from the new Home Screen icon**, not from Safari. On iPhone, the installed app keeps its own storage, separate from Safari, so you pair inside the installed app.
3. On your computer, in the Sheet, choose **Checkbook → Pair New Device**. An 8-character code appears; it works once and expires in 10 minutes.
4. In the app, go to **Settings → Sync & Devices**, type the code, and tap **Pair device**. The status changes to **✓ Synced**.

### Computer (Chrome)

1. Open the same address in Chrome. Click the install icon in the address bar, or use **⋮ → Cast, save, and share → Install page as app**.
2. Pair it the same way, with a new code from the Sheet.

### First real use

1. Add each account. Use the bank's balance on your starting date as the **Starting balance**.
2. Enter any checks or payments that haven't cleared yet, and leave them marked **Outstanding**.

---

## Everyday use

**Entering money**

- Tap **Spending**, **Income** or **Transfer** and fill in the amount, payee and category.
- Check # is optional and only appears on Spending.
- Payee tiles remember your stores and fill in the category you last used for them.

**Offline**

- Entries save on the phone right away and the balance updates.
- The status shows **Offline · N waiting**. When you reconnect and open the app, the waiting entries go to the Sheet.

**Editing and deleting**

- Tap an entry to edit it.
- On the phone, swipe left and tap the trash. On a computer, click the trash icon.
- Undo appears right after a delete. Deleted entries are kept in **Settings → Recently deleted**.

**Duo unfolded or wide window**

- The left side shows the entry form. The right side shows the searchable history.
- Tap a history row to edit it on the left.
- Whatever you're typing carries over when you fold or unfold.

**Search**

| Type | Finds |
|---|---|
| `Meijer` | Payee, note or category |
| `$42.50` | That exact amount |
| `$20-$100` | Amounts in that range |
| `over 50`, `under 25` | Amounts above or below |
| `#1042` | That check number |

The **Filter** button adds Spending, Income or Transfer chips and min/max amount fields.

**Reconcile** (from an account)

1. Enter the statement's ending date and balance.
2. Check off each entry that's on the statement until the difference is $0.00.

**Reports**

- Monthly income and spending, plus spending by category.
- Transfers between your accounts aren't counted as income or spending.
- The Sheet's summary tabs carry opening and closing balances for every year.

## If two devices edit the same entry

The newer edit wins. The older version is saved on the Sheet's **Audit** tab, and the app shows a notice.

## Lost phone

On the Sheet's **Devices** tab, check **revoked** on that phone's row. It's locked out immediately.

## Please don't edit the Transactions tab by hand

Make changes through the app; editing the Transactions tab directly will show a warning. If you do edit by hand, open the app on each device and tap **Settings → Full resync**.

---

## Updating the app later

**Front end (the files on GitHub)**

1. Upload the changed files.
2. Raise the version in **two** places: `appVersion` in `config.js` and `CACHE` in `sw.js`. The `CACHE` change is what makes the app notice an update.
3. Open the app. A **"New version ready → Refresh"** bar appears.

**Backend (`Code.gs`)**

1. Paste the new code and save.
2. Choose **Deploy → Manage deployments → ✏️ Edit**, set **Version: New version**, and click **Deploy**.
3. Editing the existing deployment keeps the same `/exec` address. **Don't** create a new deployment, or the address changes.

## Optional: a TEST setup for trying changes safely

1. Make a copy of the Sheet named **Duo Checkbook TEST**.
2. Open the copy's Apps Script, run Set Up, and deploy it as a web app.
3. Paste that address on the `test:` line in `config.js`.
4. In the app, choose **Settings → Switch to TEST**. TEST has its own separate data on the device and its own Sheet; switch back the same way.

## Backups

- Every night around 2 AM, a copy of the Sheet is saved to the Drive folder **Duo Checkbook Backups**. The last 30 are kept.
- **Checkbook → Back Up Now** makes one on demand.
- Google Sheets' own version history also works: **File → Version history**.

---

## Before entering real money: test checklist

- [ ] Pair the phone and add a test account and entry; it appears on the Transactions tab.
- [ ] Turn on Airplane mode and add 3 entries. The balance updates and the status shows "3 waiting."
- [ ] Force-quit the app, reopen it in Airplane mode, and confirm the 3 entries are still there.
- [ ] Turn Airplane mode off and open the app. All 3 reach the Sheet, with no duplicates.
- [ ] Fold and unfold the Duo while typing an entry; nothing you typed is lost.
- [ ] Pair Chrome on a computer and confirm both devices show the same entries.
- [ ] Revoke a device on the Devices tab; that device shows "Not paired."
- [ ] Run **Checkbook → Back Up Now** and open the copy in Drive.
- [ ] Then delete the test account's entries (or start a fresh Sheet) and enter real starting balances.

Run it alongside your bank for 2–4 weeks and reconcile each statement before relying on it alone.

## Good to know

- **No background sync on iPhone.** Apple doesn't let web apps sync while closed. Entries sync when you next open the app with a connection. Opening it for a few seconds after a shopping trip is enough.
- **Phone storage isn't encrypted by the app.** Your phone's passcode and Face ID protect it. Never enter account numbers, passwords or card numbers anywhere in the app.
- **Logos sync with each account.** They're shrunk to small icons so they fit in a Sheet cell.
- **The app logo is per device.** The Home Screen icon comes from the `icon-*.png` files in GitHub.
- **Adjusting the two-panel layout.** **Settings → Screen** shows the current screen width. If the two-panel layout doesn't turn on when the Duo is open, change `widePanelMinWidth` in `config.js`.
