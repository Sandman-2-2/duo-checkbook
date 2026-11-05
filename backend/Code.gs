/**
 * Duo Checkbook — Apps Script backend v2.0
 * Container-bound to the "Duo Checkbook" Google Sheet (the official ledger).
 *
 * Deploy: Deploy → New deployment → Web app
 *   Execute as: Me (owner of this Sheet)
 *   Who has access: Anyone
 * Every request except "pair" and "ping" must carry a valid device token.
 * Device tokens are issued only after entering a one-time code generated
 * from this Sheet's Checkbook menu, so owning the Sheet is the security.
 *
 * No secrets live in this file. It is safe to keep in a public GitHub repo.
 */

const API_VERSION = 2;
const APP_VERSION = '2.0.0';
const BACKUP_FOLDER = 'Duo Checkbook Backups';
const BACKUPS_TO_KEEP = 30;
const PAIR_CODE_MINUTES = 10;
const PAIR_MAX_FAILS = 5;
const MAX_BATCH = 100;
const CELL_SAFE_LIMIT = 45000;

const TABLES = {
  tx: {
    name: 'Transactions',
    cols: ['id', 'seq', 'version', 'date', 'type', 'accountId', 'account', 'toAccountId', 'toAccount',
      'amountCents', 'amount', 'payee', 'category', 'checkNumber', 'note', 'receiptUrl',
      'cleared', 'toCleared', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'],
    numbers: ['seq', 'version', 'amountCents', 'amount'],
    bools: ['cleared', 'toCleared']
  },
  acct: {
    name: 'Accounts',
    cols: ['id', 'seq', 'version', 'name', 'kind', 'openingCents', 'openingBalance', 'openingDate',
      'color', 'logo', 'archived', 'sortOrder', 'createdAt', 'updatedAt', 'deviceId'],
    numbers: ['seq', 'version', 'openingCents', 'openingBalance', 'sortOrder'],
    bools: ['archived']
  },
  cat: {
    name: 'Categories',
    cols: ['id', 'seq', 'version', 'name', 'kind', 'archived', 'sortOrder', 'createdAt', 'updatedAt', 'deviceId'],
    numbers: ['seq', 'version', 'sortOrder'],
    bools: ['archived']
  },
  dev: {
    name: 'Devices',
    cols: ['deviceId', 'name', 'tokenHash', 'pairedAt', 'lastSeen', 'revoked', 'userAgent'],
    numbers: [],
    bools: ['revoked']
  },
  audit: {
    name: 'Audit',
    cols: ['timestamp', 'mutationId', 'deviceId', 'entity', 'entityId', 'action', 'result', 'before', 'after'],
    numbers: [],
    bools: []
  }
};

const SUMMARY_TABS = ['Monthly Summary', 'Annual Summary', 'Category Summary'];

// Same IDs are seeded in the app so defaults never duplicate.
const DEFAULT_CATEGORIES = [
  ['cat-groceries', 'Groceries', 'expense'], ['cat-dining', 'Dining Out', 'expense'],
  ['cat-gas-auto', 'Gas & Auto', 'expense'], ['cat-bills', 'Bills & Utilities', 'expense'],
  ['cat-housing', 'Housing', 'expense'], ['cat-shopping', 'Shopping', 'expense'],
  ['cat-health', 'Health', 'expense'], ['cat-subscriptions', 'Subscriptions', 'expense'],
  ['cat-entertainment', 'Entertainment', 'expense'], ['cat-kids-school', 'Kids & School', 'expense'],
  ['cat-personal', 'Personal Care', 'expense'], ['cat-gifts', 'Gifts & Giving', 'expense'],
  ['cat-other-expense', 'Other Spending', 'expense'],
  ['cat-paycheck', 'Paycheck', 'income'], ['cat-refund', 'Refund', 'income'],
  ['cat-interest', 'Interest', 'income'], ['cat-gift-received', 'Gift Received', 'income'],
  ['cat-other-income', 'Other Income', 'income']
];

/* ───────────────────────── Sheet menu ───────────────────────── */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Checkbook')
    .addItem('Pair New Device…', 'pairNewDevice')
    .addItem('Refresh Summaries', 'refreshSummaries')
    .addItem('Back Up Now', 'backupNow')
    .addSeparator()
    .addItem('Set Up / Repair Sheet', 'setupCheckbook')
    .addToUi();
}

function setupCheckbook() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(TABLES).forEach(function (key) {
    const t = TABLES[key];
    let sh = ss.getSheetByName(t.name);
    if (!sh) sh = ss.insertSheet(t.name);
    sh.getRange(1, 1, 1, t.cols.length).setValues([t.cols]).setFontWeight('bold').setBackground('#e8eef8');
    sh.setFrozenRows(1);
    // Keep IDs, dates, check numbers and timestamps as plain text (no auto-conversion).
    t.cols.forEach(function (c, i) {
      if (t.numbers.indexOf(c) < 0 && t.bools.indexOf(c) < 0) {
        sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
      }
    });
    ['amount', 'openingBalance'].forEach(function (c) {
      const i = t.cols.indexOf(c);
      if (i >= 0) sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1).setNumberFormat('$#,##0.00;-$#,##0.00');
    });
    const existing = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    if (!existing.length) {
      sh.protect().setDescription('Managed by Duo Checkbook. Edit through the app.').setWarningOnly(true);
    }
  });
  SUMMARY_TABS.forEach(function (name) { if (!ss.getSheetByName(name)) ss.insertSheet(name); });

  const def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);

  withLock_(function () {
    const cat = loadTable_('cat');
    if (!cat.rows.length) {
      const now = new Date().toISOString();
      let seq = getSeq_();
      DEFAULT_CATEGORIES.forEach(function (c, i) {
        seq++;
        appendRows_('cat', [objToRow_('cat', {
          id: c[0], seq: seq, version: 1, name: c[1], kind: c[2], archived: false,
          sortOrder: i, createdAt: now, updatedAt: now, deviceId: 'setup'
        })]);
      });
      setSeq_(seq);
    }
    rebuildSummaries_();
  });

  const hasTrigger = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'nightlyBackup'; });
  if (!hasTrigger) ScriptApp.newTrigger('nightlyBackup').timeBased().everyDays(1).atHour(2).create();
  getBackupFolder_();

  SpreadsheetApp.getUi().alert('Duo Checkbook is set up.',
    'Tabs, default categories, and the nightly backup are ready.\n\n' +
    'Next: Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone), ' +
    'then copy the /exec address into config.js in your GitHub repo.',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

function pairNewDevice() {
  const code = makePairCode_();
  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    PAIR_HASH: hash_(normalizeCode_(code)),
    PAIR_EXPIRES: String(Date.now() + PAIR_CODE_MINUTES * 60000),
    PAIR_FAILS: '0'
  });
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:-apple-system,Segoe UI,sans-serif;text-align:center;padding:8px">' +
    '<p style="color:#555;margin:0 0 10px">On your phone or computer, open Duo Checkbook → Settings → Sync &amp; Devices and enter:</p>' +
    '<div style="font:700 38px ui-monospace,Menlo,monospace;letter-spacing:4px;background:#eef3fb;border-radius:14px;padding:16px 8px;margin:6px 0 12px">' + code + '</div>' +
    '<p style="color:#777;font-size:13px;margin:0">Works once. Expires in ' + PAIR_CODE_MINUTES + ' minutes.<br>Revoke a device any time by checking <b>revoked</b> on the Devices tab.</p></div>'
  ).setWidth(380).setHeight(270);
  SpreadsheetApp.getUi().showModalDialog(html, 'Pair New Device');
}

function refreshSummaries() {
  withLock_(function () { rebuildSummaries_(); });
  SpreadsheetApp.getActive().toast('Summaries refreshed.', 'Duo Checkbook');
}

function backupNow() {
  const name = nightlyBackup();
  SpreadsheetApp.getActive().toast('Saved ' + name, 'Duo Checkbook backup');
}

function nightlyBackup() {
  const ss = SpreadsheetApp.getActive();
  const folder = getBackupFolder_();
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HHmm');
  const name = 'Duo Checkbook Backup ' + stamp;
  DriveApp.getFileById(ss.getId()).makeCopy(name, folder);
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName().indexOf('Duo Checkbook Backup ') === 0) files.push(f);
  }
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  files.slice(BACKUPS_TO_KEEP).forEach(function (f) { f.setTrashed(true); });
  return name;
}

function getBackupFolder_() {
  const it = DriveApp.getFoldersByName(BACKUP_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(BACKUP_FOLDER);
}

/* ───────────────────────── Web app entry ───────────────────────── */

function doGet() {
  return json_({ ok: true, app: 'Duo Checkbook', apiVersion: API_VERSION, appVersion: APP_VERSION });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad_request', message: 'Request was not valid JSON.' });
  }
  return json_(handleRequest(req));
}

/** Pure request router (used by doPost; also handy for testing). */
function handleRequest(req) {
  try {
    if (!req || typeof req !== 'object') throw apiError_('bad_request', 'Empty request.');
    if (req.action === 'ping') return { ok: true, apiVersion: API_VERSION, appVersion: APP_VERSION };
    if (Number(req.apiVersion) !== API_VERSION) {
      throw apiError_('upgrade_required', 'This copy of the app is out of date. Refresh to update.');
    }
    if (req.action === 'pair') return pair_(req);
    return withLock_(function () {
      const device = authDevice_(req);
      if (req.action === 'push') return push_(req, device);
      if (req.action === 'pull') return pull_(req);
      throw apiError_('bad_request', 'Unknown action.');
    });
  } catch (err) {
    if (err && err.apiCode) return { ok: false, error: err.apiCode, message: err.message };
    console.error(err && err.stack || err);
    return { ok: false, error: 'server_error', message: String(err && err.message || err) };
  }
}

/* ───────────────────────── Pairing & auth ───────────────────────── */

function pair_(req) {
  return withLock_(function () {
    const props = PropertiesService.getScriptProperties();
    const h = props.getProperty('PAIR_HASH');
    const exp = Number(props.getProperty('PAIR_EXPIRES') || 0);
    if (!h || Date.now() > exp) {
      clearPair_(props);
      throw apiError_('pair_failed', 'No active pairing code. In the Sheet choose Checkbook → Pair New Device.');
    }
    if (hash_(normalizeCode_(req.code)) !== h) {
      const fails = Number(props.getProperty('PAIR_FAILS') || 0) + 1;
      if (fails >= PAIR_MAX_FAILS) {
        clearPair_(props);
        throw apiError_('pair_failed', 'Too many wrong codes. Generate a new one from the Sheet.');
      }
      props.setProperty('PAIR_FAILS', String(fails));
      throw apiError_('pair_failed', 'That code did not match. Check it and try again.');
    }
    clearPair_(props);
    const deviceId = 'dev-' + Utilities.getUuid();
    const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    const now = new Date().toISOString();
    appendRows_('dev', [objToRow_('dev', {
      deviceId: deviceId,
      name: cleanText_(req.deviceName, 60) || 'Device',
      tokenHash: hash_(token),
      pairedAt: now, lastSeen: now, revoked: false,
      userAgent: cleanText_(req.userAgent, 200)
    })]);
    return { ok: true, deviceId: deviceId, token: token, apiVersion: API_VERSION };
  });
}

function clearPair_(props) {
  props.deleteProperty('PAIR_HASH');
  props.deleteProperty('PAIR_EXPIRES');
  props.deleteProperty('PAIR_FAILS');
}

function authDevice_(req) {
  if (!req.deviceId || !req.token) throw apiError_('unauthorized', 'This device is not paired.');
  const t = loadTable_('dev');
  const idx = t.index[String(req.deviceId)];
  const row = idx === undefined ? null : t.rows[idx];
  if (!row || row.revoked || row.tokenHash !== hash_(String(req.token))) {
    throw apiError_('unauthorized', 'This device is not paired or was revoked. Pair it again from Settings.');
  }
  const last = Date.parse(row.lastSeen) || 0;
  if (Date.now() - last > 5 * 60000) {
    row.lastSeen = new Date().toISOString();
    writeRow_('dev', idx, row);
  }
  return row;
}

/* ───────────────────────── Sync: push ───────────────────────── */

function push_(req, device) {
  const muts = Array.isArray(req.mutations) ? req.mutations : [];
  if (muts.length > MAX_BATCH) throw apiError_('bad_request', 'Too many changes in one request.');
  const tables = { tx: loadTable_('tx'), acct: loadTable_('acct'), cat: loadTable_('cat') };
  const seen = loadMutationIds_();
  let seq = getSeq_();
  const audit = [];
  const results = [];
  let changed = false;
  const now = new Date().toISOString();

  muts.forEach(function (m) {
    const mid = String(m && m.mutationId || '');
    const entity = m && m.entity;
    if (!/^[A-Za-z0-9-]{8,80}$/.test(mid) || !tables[entity]) {
      results.push({ mutationId: mid, status: 'rejected', error: 'Malformed change.' });
      return;
    }
    const table = tables[entity];
    if (seen[mid]) {
      const id = m.record && m.record.id;
      const cur = id !== undefined && table.index[id] !== undefined ? table.rows[table.index[id]] : null;
      results.push({ mutationId: mid, status: 'duplicate', record: cur ? publicRecord_(entity, cur) : null });
      return;
    }
    let rec;
    try {
      rec = CLEANERS[entity](m.record || {}, tables);
    } catch (err) {
      const msg = err && err.message || 'Invalid change.';
      results.push({ mutationId: mid, status: 'rejected', error: msg });
      audit.push([now, mid, device.deviceId, entity, String(m.record && m.record.id || ''), 'upsert', 'rejected: ' + msg, '', auditJson_(m.record)]);
      seen[mid] = true;
      return;
    }
    const idx = table.index[rec.id];
    const existing = idx === undefined ? null : table.rows[idx];
    const base = Number(m.baseVersion || 0);
    let status = 'applied';

    if (existing && existing.version !== base && existing.deviceId !== device.deviceId) {
      // Two devices edited the same record. Newer edit (by edit time) wins; the other is kept in Audit.
      if ((Date.parse(rec.updatedAt) || 0) >= (Date.parse(existing.updatedAt) || 0)) {
        status = 'conflict_won';
      } else {
        results.push({ mutationId: mid, status: 'conflict_lost', record: publicRecord_(entity, existing) });
        audit.push([now, mid, device.deviceId, entity, rec.id, 'upsert', 'conflict: incoming older, kept server copy', auditJson_(existing), auditJson_(rec)]);
        seen[mid] = true;
        return;
      }
    }

    seq++;
    rec.seq = seq;
    rec.version = (existing ? existing.version : 0) + 1;
    rec.createdAt = existing ? existing.createdAt : (rec.createdAt || now);
    rec.deviceId = device.deviceId;
    if (entity === 'tx') {
      rec.account = nameOf_(tables.acct, rec.accountId);
      rec.toAccount = rec.toAccountId ? nameOf_(tables.acct, rec.toAccountId) : '';
      rec.amount = rec.amountCents / 100;
    }
    if (entity === 'acct') {
      rec.openingBalance = rec.openingCents / 100;
      if (existing && existing.name !== rec.name) renameAccountInTx_(tables.tx, rec.id, rec.name);
    }

    if (existing) {
      table.rows[idx] = rec;
      table.dirty[idx] = true;
    } else {
      table.index[rec.id] = table.rows.length;
      table.rows.push(rec);
      table.appended.push(table.rows.length - 1);
    }
    changed = true;
    seen[mid] = true;
    const action = existing ? (rec.deletedAt && !existing.deletedAt ? 'delete' : (!rec.deletedAt && existing.deletedAt ? 'restore' : 'update')) : 'create';
    audit.push([now, mid, device.deviceId, entity, rec.id, action,
      status === 'conflict_won' ? 'conflict: incoming newer, replaced server copy' : 'applied',
      existing ? auditJson_(existing) : '', auditJson_(rec)]);
    results.push({ mutationId: mid, status: status, record: publicRecord_(entity, rec) });
  });

  if (changed) {
    ['acct', 'cat', 'tx'].forEach(function (k) { flushTable_(k, tables[k]); });
    setSeq_(seq);
  }
  if (audit.length) appendRawRows_('audit', audit);
  if (changed) rebuildSummaries_(tables);
  return { ok: true, results: results, serverSeq: seq };
}

function renameAccountInTx_(txTable, accountId, name) {
  txTable.rows.forEach(function (r, i) {
    let hit = false;
    if (r.accountId === accountId && r.account !== name) { r.account = name; hit = true; }
    if (r.toAccountId === accountId && r.toAccount !== name) { r.toAccount = name; hit = true; }
    if (hit) txTable.dirty[i] = true;
  });
}

function nameOf_(acctTable, id) {
  const i = acctTable.index[id];
  return i === undefined ? '' : acctTable.rows[i].name;
}

/* ───────────────────────── Sync: pull ───────────────────────── */

function pull_(req) {
  const since = Math.max(0, Number(req.since) || 0);
  const out = { ok: true, serverSeq: getSeq_(), serverTime: new Date().toISOString(), full: since === 0 };
  [['acct', 'accounts'], ['cat', 'categories'], ['tx', 'transactions']].forEach(function (p) {
    out[p[1]] = loadTable_(p[0]).rows
      .filter(function (r) { return r.seq > since; })
      .map(function (r) { return publicRecord_(p[0], r); });
  });
  return out;
}

function publicRecord_(entity, r) {
  const o = {};
  TABLES[entity].cols.forEach(function (c) { o[c] = r[c]; });
  delete o.account; delete o.toAccount; delete o.amount; delete o.openingBalance;
  return o;
}

/* ───────────────────────── Validation ───────────────────────── */

const ID_RE = /^[A-Za-z0-9-]{3,80}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CLEANERS = {
  tx: function (r, tables) {
    const o = {};
    o.id = needId_(r.id);
    o.type = oneOf_(r.type, ['expense', 'income', 'transfer'], 'type');
    o.accountId = needId_(r.accountId);
    if (tables.acct.index[o.accountId] === undefined) throw new Error('Unknown account.');
    o.toAccountId = '';
    if (o.type === 'transfer') {
      o.toAccountId = needId_(r.toAccountId);
      if (tables.acct.index[o.toAccountId] === undefined) throw new Error('Unknown transfer account.');
      if (o.toAccountId === o.accountId) throw new Error('Transfer accounts must be different.');
    }
    o.amountCents = cents_(r.amountCents, false);
    o.date = needDate_(r.date);
    o.payee = cleanText_(r.payee, 120);
    if (o.type !== 'transfer' && !o.payee) throw new Error('Payee is required.');
    o.category = o.type === 'transfer' ? '' : cleanText_(r.category, 60);
    o.checkNumber = o.type === 'expense' ? cleanText_(r.checkNumber, 20) : '';
    o.note = cleanText_(r.note, 1000);
    o.receiptUrl = httpsOrBlank_(r.receiptUrl, 2000);
    o.cleared = r.cleared === true;
    o.toCleared = o.type === 'transfer' && r.toCleared === true;
    o.createdAt = isoOr_(r.createdAt, new Date().toISOString());
    o.updatedAt = isoOr_(r.updatedAt, new Date().toISOString());
    o.deletedAt = r.deletedAt ? isoOr_(r.deletedAt, new Date().toISOString()) : '';
    return o;
  },
  acct: function (r) {
    const o = {};
    o.id = needId_(r.id);
    o.name = cleanText_(r.name, 60);
    if (!o.name) throw new Error('Account name is required.');
    o.kind = oneOf_(r.kind, ['Checking', 'Savings', 'Cash', 'Other'], 'account type');
    o.openingCents = cents_(r.openingCents, true);
    o.openingDate = r.openingDate ? needDate_(r.openingDate) : '';
    o.color = /^#[0-9a-fA-F]{6}$/.test(String(r.color || '')) ? String(r.color) : '#3b6fd8';
    o.logo = cleanLogo_(r.logo);
    o.archived = r.archived === true;
    o.sortOrder = Number.isFinite(Number(r.sortOrder)) ? Number(r.sortOrder) : 0;
    o.createdAt = isoOr_(r.createdAt, new Date().toISOString());
    o.updatedAt = isoOr_(r.updatedAt, new Date().toISOString());
    return o;
  },
  cat: function (r) {
    const o = {};
    o.id = needId_(r.id);
    o.name = cleanText_(r.name, 40);
    if (!o.name) throw new Error('Category name is required.');
    o.kind = oneOf_(r.kind, ['expense', 'income'], 'category type');
    o.archived = r.archived === true;
    o.sortOrder = Number.isFinite(Number(r.sortOrder)) ? Number(r.sortOrder) : 0;
    o.createdAt = isoOr_(r.createdAt, new Date().toISOString());
    o.updatedAt = isoOr_(r.updatedAt, new Date().toISOString());
    return o;
  }
};

function needId_(v) { const s = String(v || ''); if (!ID_RE.test(s)) throw new Error('Invalid ID.'); return s; }
function needDate_(v) {
  const s = String(v || '');
  if (!DATE_RE.test(s) || isNaN(Date.parse(s + 'T00:00:00Z'))) throw new Error('Invalid date.');
  return s;
}
function oneOf_(v, list, label) { if (list.indexOf(v) < 0) throw new Error('Invalid ' + label + '.'); return v; }
function cents_(v, allowNegZero) {
  const n = Number(v);
  if (!Number.isInteger(n) || Math.abs(n) > 99999999999) throw new Error('Invalid amount.');
  if (!allowNegZero && n <= 0) throw new Error('Amount must be more than zero.');
  return n;
}
function cleanText_(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max); }
function isoOr_(v, fallback) { const s = String(v || ''); return !isNaN(Date.parse(s)) && s.length <= 40 ? s : fallback; }
function httpsOrBlank_(v, max) {
  const s = cleanText_(v, max);
  if (!s) return '';
  if (!/^https:\/\/[^\s"'<>]+$/i.test(s)) throw new Error('Receipt link must start with https://');
  return s;
}
function cleanLogo_(v) {
  const s = String(v || '');
  if (!s) return '';
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length <= CELL_SAFE_LIMIT) return s;
  if (/^https:\/\/[^\s"'<>]+$/i.test(s) && s.length <= 2000) return s;
  throw new Error('Logo must be a small PNG/JPG/WebP image or an https:// link.');
}

/* ───────────────────────── Summaries ───────────────────────── */

function rebuildSummaries_(tables) {
  tables = tables || { tx: loadTable_('tx'), acct: loadTable_('acct') };
  const accts = tables.acct.rows.slice().sort(function (a, b) { return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name); });
  const txs = tables.tx.rows.filter(function (t) { return !t.deletedAt; })
    .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });

  const thisYear = new Date().getFullYear();
  let minYear = thisYear;
  txs.forEach(function (t) { minYear = Math.min(minYear, Number(t.date.slice(0, 4))); });

  // Per-account effects
  const monthly = {}; // acctId|YYYY-MM -> {inc,spend,tin,tout}
  const yearly = {};  // acctId|YYYY -> same
  function bump(map, key, field, v) {
    if (!map[key]) map[key] = { inc: 0, spend: 0, tin: 0, tout: 0 };
    map[key][field] += v;
  }
  txs.forEach(function (t) {
    const ym = t.date.slice(0, 7), y = t.date.slice(0, 4);
    if (t.type === 'income') { bump(monthly, t.accountId + '|' + ym, 'inc', t.amountCents); bump(yearly, t.accountId + '|' + y, 'inc', t.amountCents); }
    if (t.type === 'expense') { bump(monthly, t.accountId + '|' + ym, 'spend', t.amountCents); bump(yearly, t.accountId + '|' + y, 'spend', t.amountCents); }
    if (t.type === 'transfer') {
      bump(monthly, t.accountId + '|' + ym, 'tout', t.amountCents); bump(yearly, t.accountId + '|' + y, 'tout', t.amountCents);
      bump(monthly, t.toAccountId + '|' + ym, 'tin', t.amountCents); bump(yearly, t.toAccountId + '|' + y, 'tin', t.amountCents);
    }
  });
  function net(v) { return v ? v.inc - v.spend + v.tin - v.tout : 0; }

  // Annual: opening rolls forward year to year, so backdated edits recalc every later year.
  const annual = [['Year', 'Account', 'Opening Balance', 'Income', 'Spending', 'Transfers In', 'Transfers Out', 'Closing Balance']];
  accts.forEach(function (a) {
    let running = a.openingCents;
    for (let y = minYear; y <= thisYear; y++) {
      const v = yearly[a.id + '|' + y];
      const open = running;
      running += net(v);
      if (!v && y < thisYear && open === a.openingCents && y < minYearFor_(txs, a.id)) continue;
      annual.push([String(y), a.name + (a.archived ? ' (archived)' : ''), open / 100,
        (v ? v.inc : 0) / 100, (v ? v.spend : 0) / 100, (v ? v.tin : 0) / 100, (v ? v.tout : 0) / 100, running / 100]);
    }
  });

  const monthlyRows = [['Month', 'Account', 'Income', 'Spending', 'Transfers In', 'Transfers Out', 'Net', 'Ending Balance']];
  accts.forEach(function (a) {
    const keys = Object.keys(monthly).filter(function (k) { return k.indexOf(a.id + '|') === 0; })
      .map(function (k) { return k.split('|')[1]; }).sort();
    let running = a.openingCents;
    keys.forEach(function (ym) {
      const v = monthly[a.id + '|' + ym];
      running += net(v);
      monthlyRows.push([ym, a.name, v.inc / 100, v.spend / 100, v.tin / 100, v.tout / 100, net(v) / 100, running / 100]);
    });
  });
  monthlyRows.splice(1, monthlyRows.length - 1, ...monthlyRows.slice(1).sort(function (a, b) {
    return a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : String(a[1]).localeCompare(String(b[1]));
  }));

  const catMap = {};
  txs.forEach(function (t) {
    if (t.type === 'transfer') return;
    const k = t.date.slice(0, 7) + '|' + (t.category || '(none)') + '|' + t.type;
    if (!catMap[k]) catMap[k] = { total: 0, count: 0 };
    catMap[k].total += t.amountCents; catMap[k].count++;
  });
  const catRows = [['Month', 'Category', 'Type', 'Total', 'Count']];
  Object.keys(catMap).sort().reverse().forEach(function (k) {
    const p = k.split('|');
    catRows.push([p[0], p[1], p[2] === 'expense' ? 'Spending' : 'Income', catMap[k].total / 100, catMap[k].count]);
  });

  writeSummary_('Annual Summary', annual, [3, 4, 5, 6, 7, 8]);
  writeSummary_('Monthly Summary', monthlyRows, [3, 4, 5, 6, 7, 8]);
  writeSummary_('Category Summary', catRows, [4]);
}

function minYearFor_(txs, acctId) {
  for (let i = 0; i < txs.length; i++) {
    if (txs[i].accountId === acctId || txs[i].toAccountId === acctId) return Number(txs[i].date.slice(0, 4));
  }
  return new Date().getFullYear();
}

function writeSummary_(name, rows, moneyCols) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sh.getRange(1, 1, 1, rows[0].length).setFontWeight('bold').setBackground('#e8eef8');
  sh.setFrozenRows(1);
  if (rows.length > 1) {
    moneyCols.forEach(function (c) { sh.getRange(2, c, rows.length - 1, 1).setNumberFormat('$#,##0.00;-$#,##0.00'); });
  }
}

/* ───────────────────────── Table I/O ───────────────────────── */

function sheetFor_(key) {
  const t = TABLES[key];
  const sh = SpreadsheetApp.getActive().getSheetByName(t.name);
  if (!sh) throw apiError_('server_error', 'Missing tab "' + t.name + '". In the Sheet run Checkbook → Set Up / Repair Sheet.');
  return sh;
}

function loadTable_(key) {
  const t = TABLES[key];
  const sh = sheetFor_(key);
  const n = sh.getLastRow() - 1;
  const values = n > 0 ? sh.getRange(2, 1, n, t.cols.length).getValues() : [];
  const rows = [], index = {};
  values.forEach(function (v) {
    const o = rowToObj_(key, v);
    const id = key === 'dev' ? o.deviceId : o.id;
    if (!id) return;
    index[id] = rows.length;
    rows.push(o);
  });
  return { key: key, rows: rows, index: index, dirty: {}, appended: [] };
}

function flushTable_(key, table) {
  const sh = sheetFor_(key);
  Object.keys(table.dirty).forEach(function (i) {
    if (table.appended.indexOf(Number(i)) >= 0) return;
    sh.getRange(Number(i) + 2, 1, 1, TABLES[key].cols.length).setValues([objToRow_(key, table.rows[i])]);
  });
  if (table.appended.length) {
    appendRows_(key, table.appended.map(function (i) { return objToRow_(key, table.rows[i]); }));
  }
  table.dirty = {}; table.appended = [];
}

function writeRow_(key, index, obj) {
  sheetFor_(key).getRange(index + 2, 1, 1, TABLES[key].cols.length).setValues([objToRow_(key, obj)]);
}

function appendRows_(key, rows) {
  if (!rows.length) return;
  const sh = sheetFor_(key);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, TABLES[key].cols.length).setValues(rows);
}

function appendRawRows_(key, rows) {
  appendRows_(key, rows.map(function (r) {
    return r.map(function (v) { return typeof v === 'string' ? sheetSafe_(v) : v; });
  }));
}

function rowToObj_(key, v) {
  const t = TABLES[key], o = {};
  t.cols.forEach(function (c, i) {
    let x = v[i];
    if (t.numbers.indexOf(c) >= 0) x = Number(x) || 0;
    else if (t.bools.indexOf(c) >= 0) x = x === true || String(x).toUpperCase() === 'TRUE';
    else x = unSheetSafe_(x instanceof Date ? x.toISOString() : String(x == null ? '' : x));
    o[c] = x;
  });
  return o;
}

function objToRow_(key, o) {
  const t = TABLES[key];
  return t.cols.map(function (c) {
    const x = o[c];
    if (t.numbers.indexOf(c) >= 0) return Number(x) || 0;
    if (t.bools.indexOf(c) >= 0) return x === true;
    return sheetSafe_(String(x == null ? '' : x));
  });
}

// Stop text like "=IMPORTXML(...)" from becoming a live formula in the Sheet.
function sheetSafe_(s) { return /^[=+\-@]/.test(s) ? "'" + s : s; }
function unSheetSafe_(s) { return /^'[=+\-@]/.test(s) ? s.slice(1) : s; }

function loadMutationIds_() {
  const sh = sheetFor_('audit');
  const n = sh.getLastRow() - 1;
  const seen = {};
  if (n > 0) sh.getRange(2, 2, n, 1).getValues().forEach(function (r) { if (r[0]) seen[r[0]] = true; });
  return seen;
}

function auditJson_(o) {
  if (!o) return '';
  const c = {};
  Object.keys(o).forEach(function (k) { c[k] = k === 'logo' && o[k] ? '[logo]' : o[k]; });
  return JSON.stringify(c).slice(0, CELL_SAFE_LIMIT);
}

/* ───────────────────────── Helpers ───────────────────────── */

function getSeq_() { return Number(PropertiesService.getScriptProperties().getProperty('SEQ') || 0); }
function setSeq_(n) { PropertiesService.getScriptProperties().setProperty('SEQ', String(n)); }

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw apiError_('busy', 'The ledger is busy. The app will retry automatically.');
  try { return fn(); } finally { lock.releaseLock(); }
}

function hash_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function makePairCode_() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const raw = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[parseInt(raw.substr(i * 4, 4), 16) % alphabet.length];
  return code.slice(0, 4) + '-' + code.slice(4);
}

function normalizeCode_(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function apiError_(code, message) { const e = new Error(message); e.apiCode = code; return e; }

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
