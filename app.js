/* Duo Checkbook v2.0 — offline-first checkbook that syncs to your Google Sheet.
 * Every save is written to this device first (IndexedDB) together with an
 * outbox entry, in one atomic step. The outbox is sent to the Apps Script
 * backend whenever the app is open and online, and an entry leaves the outbox
 * only after the Sheet confirms it.
 */
'use strict';

/* ───────────── Config ───────────── */
const CFG = window.DUO_CONFIG || { endpoints: {} };
const APP_VERSION = CFG.appVersion || '2.0.0';
const API_VERSION = 2;
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
};
const ENV = LS.get('duo-env') === 'test' ? 'test' : 'live';
const DB_NAME = 'duo-checkbook-' + ENV;
const WIDE_MQ = matchMedia('(min-width: ' + (Number(CFG.widePanelMinWidth) || 760) + 'px)');
const STORE = { tx: 'transactions', acct: 'accounts', cat: 'categories' };

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
const COLOR_CHOICES = ['#2563eb', '#0d9488', '#16a34a', '#7c3aed', '#e07835', '#db2777', '#334155'];

/* ───────────── Utilities ───────────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12));
const pad = n => String(n).padStart(2, '0');
const nowISO = () => new Date().toISOString();
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const fmtMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = c => fmtMoney.format((Number(c) || 0) / 100);
const centsToInput = c => (Number(c) / 100).toFixed(2);
function toCents(v) {
  const s = String(v ?? '').replace(/[$,\s]/g, '');
  if (!/^-?(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
}
function fmtDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return esc(iso);
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const opts = { month: 'short', day: 'numeric' };
  if (y !== new Date().getFullYear()) opts.year = 'numeric';
  return dt.toLocaleDateString('en-US', opts);
}
function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function safeImg(src) {
  const s = String(src || '');
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) return s;
  try { const u = new URL(s); return u.protocol === 'https:' ? u.href : ''; } catch (e) { return ''; }
}
const isHex = c => /^#[0-9a-fA-F]{6}$/.test(String(c || ''));
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const ICON = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="15" rx="3"/><path d="M3 9V6a3 3 0 0 1 3-3h12"/><path d="M16 13h5v5h-5a2.5 2.5 0 0 1 0-5Z"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18M8 16v-5M13 16V7M18 16v-9"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.3" fill="var(--surface)"/><circle cx="16" cy="17" r="2.3" fill="var(--surface)"/></svg>',
  bank: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-6 9 6M4 10h16M6 10v8m4-8v8m4-8v8m4-8v8M3 21h18M3 18h18"/></svg>',
  swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m17 3 4 4-4 4M21 7H8M7 21l-4-4 4-4M3 17h13"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  filter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18l-7 8v6l-4-2v-4Z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19.5 10 4 4 0 0 1 18 18Z"/></svg>'
};

/* ───────────── IndexedDB ───────────── */
let db;
function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('meta', { keyPath: 'k' });
      d.createObjectStore('accounts', { keyPath: 'id' });
      d.createObjectStore('categories', { keyPath: 'id' });
      d.createObjectStore('transactions', { keyPath: 'id' });
      d.createObjectStore('outbox', { keyPath: 'mutationId' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function idbAll(store) {
  return new Promise((resolve, reject) => {
    const q = db.transaction(store).objectStore(store).getAll();
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => reject(q.error);
  });
}
/** Atomic multi-store write. ops: {store, put} | {store, del} | {store, clear:true} */
function idbWrite(ops) {
  if (!ops.length) return Promise.resolve();
  const stores = [...new Set(ops.map(o => o.store))];
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, 'readwrite');
    ops.forEach(o => {
      const s = t.objectStore(o.store);
      if (o.clear) s.clear(); else if (o.del !== undefined) s.delete(o.del); else s.put(o.put);
    });
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Save was interrupted.'));
  });
}

/* ───────────── State ───────────── */
const S = { accounts: new Map(), categories: new Map(), tx: new Map(), outbox: [], meta: {} };
const MAP = { tx: S.tx, acct: S.accounts, cat: S.categories };
let lastN = 0;
const nextN = () => (lastN = Math.max(lastN + 1, Date.now()));

async function loadAll() {
  db = await openDB();
  const [meta, accts, cats, txs, outbox] = await Promise.all(['meta', 'accounts', 'categories', 'transactions', 'outbox'].map(idbAll));
  meta.forEach(m => { S.meta[m.k] = m.v; });
  accts.forEach(a => S.accounts.set(a.id, a));
  cats.forEach(c => S.categories.set(c.id, c));
  txs.forEach(t => S.tx.set(t.id, t));
  S.outbox = outbox.sort((a, b) => a.n - b.n);
  lastN = S.outbox.reduce((m, x) => Math.max(m, x.n), 0);
  if (!S.categories.size && !S.meta.lastSeq) {
    const now = nowISO();
    const ops = DEFAULT_CATEGORIES.map((c, i) => ({ store: 'categories', put: { id: c[0], name: c[1], kind: c[2], archived: false, sortOrder: i, version: 1, createdAt: now, updatedAt: now } }));
    await idbWrite(ops);
    ops.forEach(o => S.categories.set(o.put.id, o.put));
  }
}
function setMeta(k, v) {
  S.meta[k] = v;
  return idbWrite([{ store: 'meta', put: { k, v } }]).catch(() => {});
}

/** Save a record locally and queue it for the Sheet, atomically. */
async function commit(entity, rec) {
  rec = { ...rec, updatedAt: nowISO() };
  if (!rec.createdAt) rec.createdAt = rec.updatedAt;
  const prev = S.outbox.find(m => m.entity === entity && m.record.id === rec.id && !inFlight.has(m.mutationId));
  const known = MAP[entity].get(rec.id);
  const m = {
    mutationId: uid(), entity, record: rec,
    baseVersion: prev ? prev.baseVersion : (known && known.version) || 0,
    n: prev ? prev.n : nextN(), queuedAt: nowISO()
  };
  const ops = [{ store: STORE[entity], put: rec }, { store: 'outbox', put: m }];
  if (prev) ops.push({ store: 'outbox', del: prev.mutationId });
  await idbWrite(ops); // durable on this device before we say "Saved"
  MAP[entity].set(rec.id, rec);
  if (prev) S.outbox = S.outbox.filter(x => x !== prev);
  S.outbox.push(m);
  S.outbox.sort((a, b) => a.n - b.n);
  requestPersistence();
  scheduleSync(700);
  renderStatus();
  return rec;
}

let persistAsked = false;
function requestPersistence() {
  if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
  persistAsked = true;
  navigator.storage.persist().catch(() => {});
}

/* ───────────── Domain helpers ───────────── */
const activeAccounts = () => [...S.accounts.values()].filter(a => !a.archived).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name));
const liveTx = () => [...S.tx.values()].filter(t => !t.deletedAt);
const touches = (t, id) => t.accountId === id || t.toAccountId === id;
function effect(t, id) {
  if (t.deletedAt) return 0;
  if (t.type === 'income') return t.accountId === id ? t.amountCents : 0;
  if (t.type === 'expense') return t.accountId === id ? -t.amountCents : 0;
  if (t.accountId === id) return -t.amountCents;
  if (t.toAccountId === id) return t.amountCents;
  return 0;
}
const clearedFor = (t, id) => (t.type === 'transfer' && t.toAccountId === id ? !!t.toCleared : !!t.cleared);
function balance(id, clearedOnly = false) {
  const a = S.accounts.get(id);
  let b = (a && a.openingCents) || 0;
  for (const t of S.tx.values()) if (!t.deletedAt && touches(t, id) && (!clearedOnly || clearedFor(t, id))) b += effect(t, id);
  return b;
}
const byDateAsc = (a, b) => a.date.localeCompare(b.date) || String(a.createdAt).localeCompare(String(b.createdAt));
function runningBalances(id) {
  const a = S.accounts.get(id);
  let run = (a && a.openingCents) || 0;
  const map = new Map();
  liveTx().filter(t => touches(t, id)).sort(byDateAsc).forEach(t => { run += effect(t, id); map.set(t.id, run); });
  return map;
}
const pendingIds = () => new Set(S.outbox.filter(m => m.entity === 'tx').map(m => m.record.id));
const acctName = id => (S.accounts.get(id) || {}).name || 'Unknown account';
function txTitle(t, viewId) {
  if (t.type !== 'transfer') return t.payee;
  return t.accountId === viewId ? 'Transfer to ' + acctName(t.toAccountId) : 'Transfer from ' + acctName(t.accountId);
}
function categoriesFor(kind, include) {
  return [...S.categories.values()].filter(c => c.kind === kind && (!c.archived || c.name === include))
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name));
}
function payeeStats(kind) {
  const m = new Map();
  for (const t of S.tx.values()) {
    if (t.deletedAt || t.type !== kind || !t.payee) continue;
    const k = t.payee.toLocaleLowerCase();
    const v = m.get(k) || { name: t.payee, count: 0, last: '', category: '' };
    v.count++;
    const stamp = t.date + (t.updatedAt || '');
    if (stamp > v.last) { v.last = stamp; v.name = t.payee; v.category = t.category || v.category; }
    m.set(k, v);
  }
  return [...m.values()];
}

/* ───────────── Sync engine ───────────── */
const inFlight = new Set();
let syncing = false, syncAgain = false, syncTimer = null, backoff = 0;
let syncState = { state: 'idle', msg: '' };
const endpoint = () => String(S.meta.endpointOverride || (CFG.endpoints || {})[ENV] || '').trim();

function scheduleSync(ms = 0) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), ms);
}
function setSync(state, msg = '') { syncState = { state, msg }; renderStatus(); }

async function api(action, payload = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let resp;
  try {
    resp = await fetch(endpoint(), {
      method: 'POST', redirect: 'follow', cache: 'no-store', signal: ctrl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, apiVersion: API_VERSION, deviceId: S.meta.deviceId, token: S.meta.token, ...payload })
    });
  } catch (e) {
    const err = new Error('Could not reach your Google Sheet.'); err.network = true; throw err;
  } finally { clearTimeout(timer); }
  let data;
  try { data = await resp.json(); } catch (e) {
    const err = new Error('The Sheet sent an unexpected reply. Check that the web app is deployed with access set to “Anyone”.');
    err.network = !resp.ok; throw err;
  }
  if (!data || !data.ok) { const err = new Error((data && data.message) || 'Sync failed.'); err.code = data && data.error; throw err; }
  return data;
}

async function syncNow(opts = {}) {
  if (syncing) { syncAgain = true; return; }
  if (!endpoint()) return setSync('local');
  if (!S.meta.token) return setSync('unpaired');
  if (navigator.onLine === false) return setSync('offline');
  syncing = true;
  setSync('syncing');
  try {
    let guard = 0;
    while (S.outbox.length && guard++ < 200) {
      const batch = S.outbox.slice(0, 50);
      batch.forEach(m => inFlight.add(m.mutationId));
      let res;
      try {
        res = await api('push', { mutations: batch.map(m => ({ mutationId: m.mutationId, entity: m.entity, record: m.record, baseVersion: m.baseVersion })) });
      } finally { batch.forEach(m => inFlight.delete(m.mutationId)); }
      const removed = await applyPushResults(batch, res.results || []);
      if (!removed) throw new Error('The Sheet did not confirm the changes. Will retry.');
    }
    await pull(!!opts.full || !S.meta.lastSeq);
    backoff = 0;
    await setMeta('lastSyncAt', nowISO());
    setSync(S.outbox.length ? 'pending' : 'synced');
  } catch (e) {
    if (e.code === 'unauthorized') {
      await setMeta('token', ''); await setMeta('deviceId', '');
      setSync('unpaired', e.message);
    } else if (e.code === 'upgrade_required') {
      showBanner('A newer version of the app is required.', true);
      setSync('error', e.message);
    } else {
      setSync(navigator.onLine === false || e.network ? 'offline' : 'error', e.message);
      backoff = Math.min(backoff ? backoff * 2 : 5000, 120000);
      scheduleSync(backoff);
    }
  } finally {
    syncing = false;
    rerenderData();
    if (syncAgain) { syncAgain = false; scheduleSync(300); }
  }
}

async function applyPushResults(batch, results) {
  const byId = new Map(results.map(r => [r.mutationId, r]));
  const ops = [], notices = [], failed = (S.meta.failed || []).slice();
  const done = [];
  for (const m of batch) {
    const r = byId.get(m.mutationId);
    if (!r) continue;
    done.push(m);
    ops.push({ store: 'outbox', del: m.mutationId });
    if (r.status === 'rejected') failed.push({ ...m, error: r.error || 'Rejected', failedAt: nowISO() });
    if (r.record) {
      const stillPending = S.outbox.some(x => x !== m && x.entity === m.entity && x.record.id === r.record.id);
      if (!stillPending) ops.push({ store: STORE[m.entity], put: r.record });
    }
    const shown = r.record || m.record;
    const what = m.entity === 'tx' ? (shown.payee || 'a transfer') : (shown.name || 'an item');
    if (r.status === 'conflict_lost') notices.push('A newer edit from another device was kept for ' + what + '.');
    if (r.status === 'conflict_won') notices.push('Your edit to ' + what + ' replaced an older change from another device.');
  }
  if (failed.length !== (S.meta.failed || []).length) ops.push({ store: 'meta', put: { k: 'failed', v: failed } });
  await idbWrite(ops);
  S.meta.failed = failed;
  const doneIds = new Set(done.map(m => m.mutationId));
  S.outbox = S.outbox.filter(m => !doneIds.has(m.mutationId));
  ops.forEach(o => { if (o.put && o.store !== 'outbox' && o.store !== 'meta') MAP[Object.keys(STORE).find(k => STORE[k] === o.store)].set(o.put.id, o.put); });
  if (notices.length) toast(notices.join(' '));
  if (results.some(r => r.status === 'rejected')) toast('A change could not be saved to the Sheet. See Settings → Sync.');
  return done.length;
}

async function pull(full) {
  const res = await api('pull', { since: full ? 0 : (S.meta.lastSeq || 0) });
  const pending = new Set(S.outbox.map(m => m.entity + '|' + m.record.id));
  const ops = [];
  const groups = [['acct', res.accounts || []], ['cat', res.categories || []], ['tx', res.transactions || []]];
  if (res.full) {
    for (const [ent, rows] of groups) {
      ops.push({ store: STORE[ent], clear: true });
      const server = new Set(rows.map(r => r.id));
      for (const [id, rec] of MAP[ent]) if (pending.has(ent + '|' + id) && !server.has(id)) ops.push({ store: STORE[ent], put: rec });
    }
  }
  for (const [ent, rows] of groups) for (const r of rows) {
    if (pending.has(ent + '|' + r.id)) { if (res.full) ops.push({ store: STORE[ent], put: MAP[ent].get(r.id) }); continue; }
    ops.push({ store: STORE[ent], put: r });
  }
  ops.push({ store: 'meta', put: { k: 'lastSeq', v: res.serverSeq } });
  await idbWrite(ops);
  if (res.full) {
    for (const [ent] of groups) for (const id of [...MAP[ent].keys()]) if (!pending.has(ent + '|' + id)) MAP[ent].delete(id);
  }
  for (const [ent, rows] of groups) for (const r of rows) if (!pending.has(ent + '|' + r.id)) MAP[ent].set(r.id, r);
  S.meta.lastSeq = res.serverSeq;
}

async function pairDevice(code, name) {
  if (!endpoint()) throw new Error('Add your Apps Script web app address first.');
  const prevToken = S.meta.token;
  S.meta.token = ''; S.meta.deviceId = '';
  try {
    const res = await api('pair', { code, deviceName: name, userAgent: navigator.userAgent.slice(0, 200) });
    await setMeta('deviceId', res.deviceId);
    await setMeta('token', res.token);
    await setMeta('deviceName', name);
    await setMeta('lastSeq', 0);
  } catch (e) {
    S.meta.token = prevToken; throw e;
  }
  await syncNow({ full: true });
}

/* ───────────── UI state ───────────── */
let view = { name: 'home' };
let draft = null;       // transaction entry draft
let acctDraft = null;   // account editor draft
let sheetKind = null;   // 'entry' | 'account' | null
let filt = freshFilters();
let recon = null;
let reportState = { year: String(new Date().getFullYear()), account: 'all' };
const root = () => $('#app');

function freshFilters() { return { q: '', type: 'all', min: '', max: '', hideCleared: false, open: false, limit: 150 }; }
function go(v) {
  if (v.name !== 'account' || v.id !== view.id) { filt = freshFilters(); if (!(sheetKind === 'entry' && draft && draft.dirty)) draft = null; }
  view = v;
  render();
  window.scrollTo(0, 0);
}

/* ───────────── Rendering ───────────── */
function render() {
  const r = root();
  if (view.name === 'account' && !S.accounts.get(view.id)) view = { name: 'home' };
  const html = ({
    home: homeHTML, account: accountHTML, settings: settingsHTML, reports: reportsHTML,
    reconcile: reconcileHTML, deleted: deletedHTML, categories: categoriesHTML, archived: archivedHTML
  }[view.name] || homeHTML)();
  r.innerHTML = html;
  r.dataset.view = view.name;
  if (view.name === 'account') {
    renderLedger();
    if (WIDE_MQ.matches) { if (!draft) draft = newDraft('expense'); mountEntry($('#entryPanel')); }
  }
  if (view.name === 'reconcile') updateRecon();
  renderStatus();
}
function rerenderData() {
  if (view.name === 'account') {
    const a = S.accounts.get(view.id);
    if (!a) return render();
    const head = $('#acctHead');
    if (head) head.outerHTML = acctHeadHTML(a);
    renderLedger();
  } else if (['home', 'deleted', 'categories', 'archived', 'reports'].includes(view.name)) {
    const typing = document.activeElement && root().contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if (!typing) render();
  } else if (view.name === 'settings') {
    const s = $('#syncSection');
    if (s && !s.contains(document.activeElement)) s.innerHTML = syncSectionInner();
  }
  renderStatus();
}

function statusText() {
  const n = S.outbox.length;
  const w = n ? n + ' waiting to sync' : '';
  switch (syncState.state) {
    case 'local': return { cls: 'warn', t: 'Saved on this device · Sheet not connected' };
    case 'unpaired': return { cls: 'warn', t: 'Not paired' + (n ? ' · ' + w : '') };
    case 'offline': return { cls: 'warn', t: 'Offline · saved on this device' + (n ? ' · ' + w : '') };
    case 'syncing': return { cls: 'busy', t: 'Syncing…' };
    case 'error': return { cls: 'err', t: 'Sync problem · will retry' + (n ? ' · ' + w : '') };
    case 'pending': return { cls: 'warn', t: w };
    case 'synced': return n ? { cls: 'warn', t: w } : { cls: 'ok', t: '✓ Synced ' + (S.meta.lastSyncAt ? fmtTime(S.meta.lastSyncAt) : '') };
    default: return n ? { cls: 'warn', t: w } : { cls: 'ok', t: S.meta.token ? 'Ready' : 'Not paired' };
  }
}
function renderStatus() {
  const s = statusText();
  $$('.status').forEach(el => {
    el.className = 'status ' + s.cls;
    el.innerHTML = ICON.cloud + '<span>' + esc(s.t) + '</span>';
    el.title = syncState.msg || s.t;
  });
}
const statusPill = () => '<button class="status" data-act="goSync" aria-label="Sync status"></button>';

function logoImg(src, cls) { const s = safeImg(src); return s ? `<img class="${cls}" src="${esc(s)}" alt="">` : ''; }

function homeHTML() {
  const accts = activeAccounts();
  const archived = S.accounts.size - accts.length;
  const total = accts.reduce((s, a) => s + balance(a.id), 0);
  const appLogo = safeImg(S.meta.appLogo);
  const installHint = isIOS() && !isStandalone()
    ? '<p class="hint">Tip: in Safari tap Share → <b>Add to Home Screen</b>. The installed app keeps your data safest.</p>' : '';
  return `<section class="page home">
    <header class="topbar">
      <div class="brand">${appLogo ? `<img class="brand-logo" src="${esc(appLogo)}" alt="">` : ''}<h1>Accounts</h1></div>
      <div class="actions">
        <button class="iconbtn" data-act="theme" aria-label="Toggle dark mode">${document.documentElement.dataset.theme === 'dark' ? ICON.sun : ICON.moon}</button>
        <button class="iconbtn" data-act="newAccount" aria-label="Add account">${ICON.plus}</button>
      </div>
    </header>
    <div class="statusrow">${statusPill()}</div>
    <div class="total"><span>Total balance</span><strong>${money(total)}</strong></div>
    <div class="cards">${accts.map(a => `
      <button class="card" style="--card:${isHex(a.color) ? a.color : '#2563eb'}" data-act="openAccount" data-id="${esc(a.id)}">
        <span class="card-logo">${logoImg(a.logo, 'bank-logo') || `<span class="bank-icon">${ICON.bank}</span>`}</span>
        <span class="card-main"><span class="card-name">${esc(a.name)}</span><small>${esc(a.kind)}</small></span>
        <span class="card-bal">${money(balance(a.id))}</span>
      </button>`).join('') || `<div class="empty"><p>No accounts yet.</p><button class="primary" data-act="newAccount">Add your first account</button></div>`}
    </div>
    ${archived ? `<button class="linkbtn center" data-act="go" data-view="archived">Archived accounts (${archived})</button>` : ''}
    ${installHint}
    ${navHTML('home')}
  </section>`;
}
function navHTML(active) {
  const b = (v, icon, label) => `<button class="nav ${active === v ? 'active' : ''}" data-act="go" data-view="${v}">${icon}<span>${label}</span></button>`;
  return `<nav class="bottomnav">${b('home', ICON.wallet, 'Accounts')}${b('reports', ICON.chart, 'Reports')}${b('settings', ICON.sliders, 'Settings')}</nav>`;
}
function backBar(title, extra = '') {
  return `<header class="topbar"><button class="iconbtn" data-act="back" aria-label="Back">${ICON.back}</button><h1 class="title">${esc(title)}</h1><div class="actions">${extra}</div></header>`;
}

function acctHeadHTML(a) {
  const cleared = balance(a.id, true), bal = balance(a.id);
  return `<div class="accthead" id="acctHead" style="--accent:${isHex(a.color) ? a.color : '#2563eb'}">
    <div class="accthead-top">
      <button class="iconbtn light" data-act="back" aria-label="Back to accounts">${ICON.back}</button>
      <span class="accthead-name">${logoImg(a.logo, 'head-logo')}${esc(a.name)}</span>
      <button class="iconbtn light" data-act="editAccount" data-id="${esc(a.id)}" aria-label="Edit account">${ICON.edit}</button>
    </div>
    <div class="bigbal"><small>Balance</small><strong>${money(bal)}</strong>
      ${bal !== cleared ? `<span class="subbal">Bank shows ${money(cleared)} · ${money(Math.abs(bal - cleared))} not cleared yet</span>` : ''}
    </div>
    <div class="statusrow light">${statusPill()}</div>
  </div>`;
}
function accountHTML() {
  const a = S.accounts.get(view.id);
  const wide = WIDE_MQ.matches;
  return `<section class="page account ${wide ? 'wide' : ''}">
    <div class="pane left">
      ${acctHeadHTML(a)}
      ${wide ? '<div class="entrypanel" id="entryPanel"></div>' : `
      <div class="quick">
        <button class="q spend" data-act="newEntry" data-mode="expense">${ICON.minus}Spending</button>
        <button class="q income" data-act="newEntry" data-mode="income">${ICON.plus}Income</button>
        <button class="q transfer" data-act="newEntry" data-mode="transfer" ${activeAccounts().length < 2 ? 'disabled title="Add a second account to transfer"' : ''}>${ICON.swap}Transfer</button>
      </div>`}
    </div>
    <div class="pane right">
      <div class="ledgerhead"><h2>Transactions</h2><span class="muted" id="txCount"></span></div>
      <div class="searchrow">
        <input class="search" type="search" placeholder="Search, $25, $20-$100, #1042" data-filter="q" value="${esc(filt.q)}" aria-label="Search transactions">
        <button class="filterbtn ${filt.open ? 'on' : ''}" data-act="toggleFilters" aria-label="Filters">${ICON.filter}<span>Filter</span></button>
      </div>
      <div class="filters ${filt.open ? '' : 'hidden'}" id="filters">
        <div class="chips">${[['all', 'All'], ['expense', 'Spending'], ['income', 'Income'], ['transfer', 'Transfers']].map(([v, l]) => `<button class="chip ${filt.type === v ? 'on' : ''}" data-act="filterType" data-type="${v}">${l}</button>`).join('')}</div>
        <div class="minmax">
          <label>Min $<input type="text" inputmode="decimal" data-filter="min" value="${esc(filt.min)}" placeholder="0.00"></label>
          <label>Max $<input type="text" inputmode="decimal" data-filter="max" value="${esc(filt.max)}" placeholder="Any"></label>
          <button class="secondary" data-act="clearFilters">Clear</button>
        </div>
      </div>
      <div id="ledger" class="ledger"></div>
      <div class="tools">
        <button class="secondary" data-act="reconcile">Reconcile</button>
        <button class="secondary" data-act="toggleCleared" id="clearedBtn">${filt.hideCleared ? 'Show cleared' : 'Hide cleared'}</button>
        <button class="secondary" data-act="go" data-view="reports">Reports</button>
      </div>
    </div>
  </section>`;
}

function searchSpec(input) {
  let q = String(input || '').trim().toLowerCase();
  const out = { q, min: null, max: null, exact: null, check: null };
  const num = '\\$?\\s*([\\d,]+(?:\\.\\d{1,2})?)';
  let m;
  if ((m = q.match(new RegExp('^' + num + '\\s*(?:-|–|to)\\s*' + num + '$')))) { out.min = toCents(m[1]); out.max = toCents(m[2]); out.q = ''; }
  else if ((m = q.match(new RegExp('^(?:over|above|more than|>=|>)\\s*' + num + '$')))) { out.min = toCents(m[1]); out.q = ''; }
  else if ((m = q.match(new RegExp('^(?:under|below|less than|<=|<)\\s*' + num + '$')))) { out.max = toCents(m[1]); out.q = ''; }
  else if ((m = q.match(/^\$\s*([\d,]+(?:\.\d{1,2})?)$/))) { out.exact = toCents(m[1]); out.q = ''; }
  else if ((m = q.match(/^#\s*(\S+)$/))) { out.check = m[1]; out.q = ''; }
  return out;
}
function ledgerRows() {
  const id = view.id;
  const spec = searchSpec(filt.q);
  const min = filt.min !== '' && !isNaN(toCents(filt.min)) ? toCents(filt.min) : spec.min;
  const max = filt.max !== '' && !isNaN(toCents(filt.max)) ? toCents(filt.max) : spec.max;
  return liveTx().filter(t => touches(t, id))
    .filter(t => !filt.hideCleared || !clearedFor(t, id))
    .filter(t => filt.type === 'all' || t.type === filt.type)
    .filter(t => (min === null || t.amountCents >= min) && (max === null || t.amountCents <= max))
    .filter(t => spec.exact === null || t.amountCents === spec.exact)
    .filter(t => spec.check === null || String(t.checkNumber || '').toLowerCase() === spec.check)
    .filter(t => !spec.q || [txTitle(t, id), t.note, t.category, t.checkNumber, t.date, fmtDate(t.date), centsToInput(t.amountCents)].join(' ').toLowerCase().includes(spec.q))
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt)));
}
function renderLedger() {
  const node = $('#ledger');
  if (!node) return;
  const id = view.id;
  const rows = ledgerRows();
  const run = runningBalances(id);
  const pend = pendingIds();
  const shown = rows.slice(0, filt.limit);
  $('#txCount').textContent = rows.length + (rows.length === 1 ? ' entry' : ' entries');
  const editingId = draft && draft.id;
  node.innerHTML = shown.map(t => {
    const amt = effect(t, id);
    const icon = t.type === 'transfer' ? ICON.swap : esc((t.category || t.payee || '?').trim().charAt(0).toUpperCase());
    const sub = [fmtDate(t.date), t.category && esc(t.category), t.checkNumber && '#' + esc(t.checkNumber), clearedFor(t, id) ? 'Cleared' : 'Outstanding'].filter(Boolean).join(' · ');
    return `<div class="tx ${editingId === t.id ? 'editing' : ''}" data-id="${esc(t.id)}">
      <button class="tx-del" data-act="deleteTx" data-id="${esc(t.id)}" aria-label="Delete">${ICON.trash}</button>
      <div class="tx-body" data-act="editTx" data-id="${esc(t.id)}" role="button" tabindex="0">
        <span class="tx-icon ${t.type}">${icon}</span>
        <span class="tx-main"><strong>${esc(txTitle(t, id))}</strong><small>${sub}${pend.has(t.id) ? ' · <span class="pend" title="Waiting to sync">⏳</span>' : ''}${t.receiptUrl ? ` · <a href="${esc(safeImg(t.receiptUrl) || t.receiptUrl)}" target="_blank" rel="noopener" data-act="noop">Receipt</a>` : ''}</small></span>
        <span class="tx-right"><strong class="${amt > 0 ? 'pos' : 'neg'}">${amt > 0 ? '+' : '−'}${money(Math.abs(amt))}</strong><small>${money(run.get(t.id))}</small></span>
        <button class="tx-del-desk" data-act="deleteTx" data-id="${esc(t.id)}" aria-label="Delete transaction">${ICON.trash}</button>
      </div>
    </div>`;
  }).join('') + (rows.length > shown.length ? `<button class="linkbtn center" data-act="more">Show more (${rows.length - shown.length})</button>` : '')
    || `<div class="empty">${liveTx().some(t => touches(t, id)) ? 'No matching transactions.' : 'No transactions yet. Tap Spending or Income to add one.'}</div>`;
  const btn = $('#clearedBtn'); if (btn) btn.textContent = filt.hideCleared ? 'Show cleared' : 'Hide cleared';
}

/* ───────────── Entry form ───────────── */
function otherAccount(id) { const a = activeAccounts().find(x => x.id !== id); return a ? a.id : ''; }
function newDraft(mode, id = null) {
  if (id) {
    const t = S.tx.get(id);
    return {
      id, mode: t.type, amount: centsToInput(t.amountCents), payee: t.payee || '', category: t.category || '', date: t.date,
      accountId: t.accountId, toAccountId: t.toAccountId || otherAccount(t.accountId), checkNumber: t.checkNumber || '',
      note: t.note || '', receiptUrl: t.receiptUrl || '', cleared: !!t.cleared, toCleared: !!t.toCleared, dirty: false
    };
  }
  const acc = (view.name === 'account' && S.accounts.get(view.id) && !S.accounts.get(view.id).archived) ? view.id : (activeAccounts()[0] || {}).id || '';
  return { id: null, mode, amount: '', payee: '', category: '', date: todayISO(), accountId: acc, toAccountId: otherAccount(acc), checkNumber: '', note: '', receiptUrl: '', cleared: false, toCleared: false, dirty: false };
}
function accountOptions(selected) {
  const list = activeAccounts();
  if (selected && !list.some(a => a.id === selected) && S.accounts.get(selected)) list.push(S.accounts.get(selected));
  return list.map(a => `<option value="${esc(a.id)}" ${a.id === selected ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
}
function entryFormHTML(d, inline) {
  const kind = d.mode === 'income' ? 'income' : 'expense';
  const title = d.id ? 'Edit entry' : ({ expense: 'New spending', income: 'New income', transfer: 'New transfer' })[d.mode];
  const cats = categoriesFor(kind, d.category);
  const canTransfer = activeAccounts().length >= 2 || d.mode === 'transfer';
  return `<form class="entry" data-form="entry" autocomplete="off" novalidate>
    ${inline ? `<div class="entry-title"><h3>${title}</h3>${d.id || d.dirty ? '<button type="button" class="linkbtn" data-act="resetEntry">New entry</button>' : ''}</div>` : ''}
    <div class="seg" role="tablist">
      ${[['expense', 'Spending'], ['income', 'Income'], ['transfer', 'Transfer']].map(([m, l]) => `<button type="button" role="tab" class="seg-btn ${d.mode === m ? 'on ' + m : ''}" data-act="mode" data-mode="${m}" ${m === 'transfer' && !canTransfer ? 'disabled' : ''}>${l}</button>`).join('')}
    </div>
    <label class="field amount"><span>Amount</span><input data-f="amount" type="text" inputmode="decimal" placeholder="0.00" value="${esc(d.amount)}" aria-label="Amount in dollars"></label>
    ${d.mode === 'transfer' ? `
      <div class="row2">
        <label class="field"><span>From</span><select data-f="accountId">${accountOptions(d.accountId)}</select></label>
        <label class="field"><span>To</span><select data-f="toAccountId">${accountOptions(d.toAccountId)}</select></label>
      </div>` : `
      <label class="field"><span>${d.mode === 'income' ? 'Income source' : 'Payee / store'}</span><input data-f="payee" type="text" autocapitalize="words" placeholder="${d.mode === 'income' ? 'Employer, person, refund…' : 'Store, site, or person'}" value="${esc(d.payee)}"></label>
      <div id="payeeTiles" class="tiles"></div>
      <div class="row2">
        <label class="field"><span>Category</span><select data-f="category"><option value="">None</option>${cats.map(c => `<option ${c.name === d.category ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Account</span><select data-f="accountId">${accountOptions(d.accountId)}</select></label>
      </div>`}
    <div class="row2">
      <label class="field"><span>Date</span><input data-f="date" type="date" value="${esc(d.date)}"></label>
      ${d.mode === 'expense' ? `<label class="field"><span>Check # <em>optional</em></span><input data-f="checkNumber" type="text" inputmode="numeric" value="${esc(d.checkNumber)}" placeholder="—"></label>` : '<span></span>'}
    </div>
    <label class="field"><span>Note <em>optional</em></span><textarea data-f="note" rows="2">${esc(d.note)}</textarea></label>
    <label class="field"><span>Receipt link <em>optional</em></span><input data-f="receiptUrl" type="url" inputmode="url" placeholder="https://…" value="${esc(d.receiptUrl)}"></label>
    <label class="check"><input type="checkbox" data-f="cleared" ${d.cleared ? 'checked' : ''}><span>${d.mode === 'transfer' ? 'Cleared at the “From” bank' : 'Cleared by the bank'}</span></label>
    ${d.mode === 'transfer' ? `<label class="check"><input type="checkbox" data-f="toCleared" ${d.toCleared ? 'checked' : ''}><span>Cleared at the “To” bank</span></label>` : ''}
    <button type="submit" class="primary">${d.id ? 'Save changes' : 'Save'}</button>
    ${d.id ? `<button type="button" class="danger" data-act="deleteTx" data-id="${esc(d.id)}">Delete entry</button>` : ''}
  </form>`;
}
function mountEntry(container) {
  if (!container || !draft) return;
  container.innerHTML = entryFormHTML(draft, container.id === 'entryPanel');
  renderTiles();
}
function renderTiles() {
  const node = $('#payeeTiles');
  if (!node || !draft || draft.mode === 'transfer') return;
  const q = draft.payee.trim().toLocaleLowerCase();
  const list = payeeStats(draft.mode)
    .filter(v => !q || v.name.toLocaleLowerCase().includes(q))
    .sort((a, b) => Number(b.name.toLocaleLowerCase().startsWith(q)) - Number(a.name.toLocaleLowerCase().startsWith(q)) || b.count - a.count || b.last.localeCompare(a.last))
    .filter(v => v.name.toLocaleLowerCase() !== q)
    .slice(0, 8);
  node.innerHTML = list.length
    ? `<p class="tiles-hint">${q ? 'Matching' : 'Frequent'} · tap to fill</p><div class="tiles-row">${list.map(v => `<button type="button" class="tile" data-act="pickPayee" data-name="${esc(v.name)}" data-cat="${esc(v.category)}">${esc(v.name)}</button>`).join('')}</div>`
    : '';
}
function openEntry(mode, id = null) {
  if (!activeAccounts().length && !id) { toast('Add an account first.'); return; }
  if (WIDE_MQ.matches && view.name === 'account') {
    if (draft && draft.dirty && !confirm('Discard the entry you were typing?')) return;
    draft = newDraft(mode, id);
    mountEntry($('#entryPanel'));
    renderLedger();
    const f = $('#entryPanel [data-f="amount"]'); if (f && !id) f.focus();
    return;
  }
  draft = newDraft(mode, id);
  showEntrySheet();
}
function showEntrySheet() {
  sheetKind = 'entry';
  $('#sheetHost').innerHTML = sheetShell(draft.id ? 'Edit entry' : ({ expense: 'New spending', income: 'New income', transfer: 'New transfer' })[draft.mode], '<div id="sheetBody"></div>');
  mountEntry($('#sheetBody'));
  bindSheetDrag();
}
async function saveEntry() {
  const d = draft;
  if (!d) return;
  const cents = toCents(d.amount);
  const errs = [];
  if (!(cents > 0)) errs.push('Enter an amount greater than $0.');
  if (d.mode !== 'transfer' && !d.payee.trim()) errs.push(d.mode === 'income' ? 'Enter where the income came from.' : 'Enter a payee.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) errs.push('Choose a date.');
  if (!S.accounts.get(d.accountId)) errs.push('Choose an account.');
  if (d.mode === 'transfer' && (!S.accounts.get(d.toAccountId) || d.toAccountId === d.accountId)) errs.push('Choose two different accounts.');
  if (d.receiptUrl.trim() && !/^https:\/\/\S+$/i.test(d.receiptUrl.trim())) errs.push('Receipt link must start with https://');
  if (errs.length) { toast(errs[0]); return; }
  const existing = d.id ? S.tx.get(d.id) : null;
  const rec = {
    ...(existing || {}), id: existing ? existing.id : uid(), type: d.mode, accountId: d.accountId,
    toAccountId: d.mode === 'transfer' ? d.toAccountId : '', amountCents: cents, date: d.date,
    payee: d.mode === 'transfer' ? '' : d.payee.trim(), category: d.mode === 'transfer' ? '' : d.category,
    checkNumber: d.mode === 'expense' ? d.checkNumber.trim() : '', note: d.note.trim(), receiptUrl: d.receiptUrl.trim(),
    cleared: !!d.cleared, toCleared: d.mode === 'transfer' && !!d.toCleared, deletedAt: (existing && existing.deletedAt) || '',
    version: (existing && existing.version) || 0
  };
  try { await commit('tx', rec); } catch (e) { alert('Could not save on this device: ' + e.message); return; }
  if (WIDE_MQ.matches && view.name === 'account') {
    draft = newDraft(d.mode === 'transfer' ? 'expense' : d.mode);
    if (view.id && S.accounts.get(view.id)) draft.accountId = view.id;
    mountEntry($('#entryPanel'));
  } else { draft = null; closeSheet(true); }
  rerenderData();
  toast(existing ? 'Changes saved' : 'Saved', existing ? null : { label: 'Undo', fn: () => removeTx(rec.id, true) });
}
async function removeTx(id, quiet = false) {
  const t = S.tx.get(id);
  if (!t) return;
  await commit('tx', { ...t, deletedAt: nowISO() });
  if (draft && draft.id === id) {
    if (WIDE_MQ.matches && view.name === 'account') { draft = newDraft('expense'); mountEntry($('#entryPanel')); }
    else { draft = null; closeSheet(true); }
  }
  rerenderData();
  if (!quiet) toast('Entry deleted', { label: 'Undo', fn: () => restoreTx(id) });
  else toast('Removed');
}
async function restoreTx(id) {
  const t = S.tx.get(id);
  if (!t) return;
  await commit('tx', { ...t, deletedAt: '' });
  rerenderData();
  toast('Restored');
}

/* ───────────── Sheets (bottom sheets) ───────────── */
function sheetShell(title, body) {
  return `<div class="sheetback" data-act="sheetBackdrop"><div class="sheet" id="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="sheet-grab"><div class="handle"></div>
      <div class="sheet-title"><button class="linkbtn" data-act="closeSheet">Cancel</button><h2>${esc(title)}</h2><button class="confirm" data-act="saveSheet" aria-label="Save">${ICON.check}</button></div>
    </div>${body}</div></div>`;
}
function closeSheet(force = false) {
  if (!force) {
    const dirty = (sheetKind === 'entry' && draft && draft.dirty) || (sheetKind === 'account' && acctDraft && acctDraft.dirty);
    if (dirty && !confirm('Discard your unsaved changes?')) { snapSheet(); return false; }
  }
  if (sheetKind === 'entry') draft = null;
  if (sheetKind === 'account') acctDraft = null;
  sheetKind = null;
  $('#sheetHost').innerHTML = '';
  if (view.name === 'account') renderLedger();
  return true;
}
function snapSheet() { const s = $('#sheet'); if (s) { s.style.transition = 'transform .2s'; s.style.transform = ''; } }
function bindSheetDrag() {
  const sheet = $('#sheet'), grab = $('.sheet-grab', sheet);
  let y0 = null, dy = 0;
  grab.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; dy = 0; sheet.style.transition = 'none'; }, { passive: true });
  grab.addEventListener('touchmove', e => {
    if (y0 === null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  grab.addEventListener('touchend', () => {
    if (y0 === null) return;
    y0 = null;
    if (dy > 110) { if (!closeSheet()) snapSheet(); } else snapSheet();
  });
}

/* ───────────── Account editor ───────────── */
function openAccountEditor(id = null) {
  const a = id ? S.accounts.get(id) : null;
  acctDraft = a ? { id: a.id, name: a.name, kind: a.kind, opening: centsToInput(a.openingCents || 0), openingDate: a.openingDate || '', color: isHex(a.color) ? a.color : '#2563eb', logo: a.logo || '', archived: !!a.archived, dirty: false }
    : { id: null, name: '', kind: 'Checking', opening: '', openingDate: todayISO(), color: COLOR_CHOICES[S.accounts.size % COLOR_CHOICES.length], logo: '', archived: false, dirty: false };
  sheetKind = 'account';
  $('#sheetHost').innerHTML = sheetShell(id ? 'Edit account' : 'New account', `<div id="acctBody">${acctFormHTML()}</div>`);
  bindSheetDrag();
}
function acctFormHTML() {
  const d = acctDraft;
  const logo = safeImg(d.logo);
  return `<form class="entry" data-form="account" autocomplete="off" novalidate>
    <label class="field"><span>Account name</span><input data-a="name" value="${esc(d.name)}" placeholder="e.g. Independent Bank Checking"></label>
    <div class="row2">
      <label class="field"><span>Type</span><select data-a="kind">${['Checking', 'Savings', 'Cash', 'Other'].map(k => `<option ${k === d.kind ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      <label class="field"><span>Starting date</span><input type="date" data-a="openingDate" value="${esc(d.openingDate)}"></label>
    </div>
    <label class="field"><span>Starting balance ($) — the bank's balance on the starting date</span><input data-a="opening" type="text" inputmode="decimal" value="${esc(d.opening)}" placeholder="0.00"></label>
    <div class="field"><span>Card color</span><div class="colors"><input type="color" data-a="color" value="${esc(d.color)}" aria-label="Custom color">${COLOR_CHOICES.map(c => `<button type="button" class="swatch ${c === d.color ? 'on' : ''}" style="background:${c}" data-act="pickColor" data-color="${c}" aria-label="Color ${c}"></button>`).join('')}</div></div>
    <div class="field"><span>Institution logo <em>optional</em></span>
      <div class="logo-row">
        <div class="logo-prev" style="--card:${esc(d.color)}">${logo ? `<img src="${esc(logo)}" alt="">` : ICON.bank}</div>
        <div class="logo-btns">
          <label class="secondary filebtn">Upload<input type="file" accept="image/png,image/jpeg,image/webp" data-act-change="acctLogoFile" hidden></label>
          <button type="button" class="secondary" data-act="pasteLogo">Paste</button>
          ${logo ? '<button type="button" class="secondary" data-act="removeLogo">Remove</button>' : ''}
        </div>
      </div>
      <div class="urlrow"><input type="url" inputmode="url" data-a="logoUrl" placeholder="or an https:// image link"><button type="button" class="secondary" data-act="useLogoUrl">Use link</button></div>
      <div class="pastezone" tabindex="0" data-paste="acct">Or tap here and paste an image</div>
      <p class="muted small">Logos are shrunk to a small icon and sync to your Sheet with the account.</p>
    </div>
    ${d.id ? `<label class="check"><input type="checkbox" data-a="archived" ${d.archived ? 'checked' : ''}><span>Archive this account (hide it; history is kept)</span></label>` : ''}
    <button type="submit" class="primary">${d.id ? 'Save account' : 'Add account'}</button>
  </form>`;
}
function refreshAcctForm() { const b = $('#acctBody'); if (b) b.innerHTML = acctFormHTML(); }
async function saveAccount() {
  const d = acctDraft;
  const opening = d.opening.trim() === '' ? 0 : toCents(d.opening);
  if (!d.name.trim()) return toast('Enter an account name.');
  if (isNaN(opening)) return toast('Enter the starting balance like 1250.00');
  const existing = d.id ? S.accounts.get(d.id) : null;
  const rec = {
    ...(existing || {}), id: existing ? existing.id : uid(), name: d.name.trim().slice(0, 60), kind: d.kind, openingCents: opening,
    openingDate: d.openingDate || '', color: isHex(d.color) ? d.color : '#2563eb', logo: d.logo || '', archived: !!d.archived,
    sortOrder: existing ? existing.sortOrder || 0 : Math.max(0, ...[...S.accounts.values()].map(a => (a.sortOrder || 0) + 1)),
    version: (existing && existing.version) || 0
  };
  await commit('acct', rec);
  acctDraft = null;
  closeSheet(true);
  if (rec.archived && view.name === 'account' && view.id === rec.id) go({ name: 'home' });
  else if (!existing) go({ name: 'account', id: rec.id });
  else render();
  toast(existing ? 'Account saved' : 'Account added');
}
async function setAcctLogoFromFile(file) {
  try { acctDraft.logo = await shrinkImage(file, 96, 45000); acctDraft.dirty = true; refreshAcctForm(); }
  catch (e) { toast(e.message); }
}
function shrinkImage(file, side, maxLen) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error('Choose a PNG, JPG, or WebP image.'));
    if (file.size > 10 * 1024 * 1024) return reject(new Error('Choose an image under 10 MB.'));
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      for (const s of [side, 72, 56]) {
        const c = document.createElement('canvas'); c.width = s; c.height = s;
        const k = Math.min(s / img.width, s / img.height), w = img.width * k, h = img.height * k;
        c.getContext('2d').drawImage(img, (s - w) / 2, (s - h) / 2, w, h);
        const data = c.toDataURL('image/png');
        if (data.length <= maxLen) return resolve(data);
      }
      reject(new Error('That image is too detailed to sync. Try a simpler logo.'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
    img.src = url;
  });
}

/* ───────────── Settings ───────────── */
function syncSectionInner() {
  const s = statusText();
  const paired = !!S.meta.token;
  const fromConfig = !!(CFG.endpoints || {})[ENV];
  const failed = S.meta.failed || [];
  return `
    <div class="statusline ${s.cls}">${esc(s.t)}</div>
    ${syncState.msg && syncState.state !== 'synced' ? `<p class="muted small">${esc(syncState.msg)}</p>` : ''}
    <p class="muted small">${S.outbox.length} change${S.outbox.length === 1 ? '' : 's'} waiting · Last synced: ${S.meta.lastSyncAt ? esc(fmtTime(S.meta.lastSyncAt)) : 'never'}</p>
    <label class="field"><span>Sheet web app address ${fromConfig && !S.meta.endpointOverride ? '<em>from config.js</em>' : ''}</span>
      <div class="urlrow"><input type="url" id="endpointInput" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(endpoint())}"><button class="secondary" data-act="saveEndpoint">Save</button></div></label>
    ${paired ? `
      <p>This device: <b>${esc(S.meta.deviceName || 'Paired device')}</b></p>
      <div class="btnrow"><button class="primary" data-act="syncNow">Sync now</button><button class="secondary" data-act="fullResync">Full resync</button></div>
      <button class="linkbtn" data-act="unpair">Unpair this device</button>` : `
      <div class="pairbox">
        <p><b>Pair this device</b> — in your Google Sheet choose <b>Checkbook → Pair New Device</b>, then enter the code.</p>
        <label class="field"><span>Device name</span><input id="deviceName" value="${esc(S.meta.deviceName || defaultDeviceName())}"></label>
        <label class="field"><span>Pairing code</span><input id="pairCode" autocapitalize="characters" placeholder="ABCD-2345" class="code"></label>
        <button class="primary" data-act="pair">Pair device</button>
      </div>`}
    ${failed.length ? `<div class="failed"><p><b>${failed.length} change${failed.length === 1 ? '' : 's'} the Sheet would not accept</b></p>${failed.map((f, i) => `
      <div class="failrow"><span>${esc(f.entity === 'tx' ? (f.record.payee || 'Transfer') + ' ' + money(f.record.amountCents) : f.record.name)}<small>${esc(f.error)}</small></span>
      <button class="secondary" data-act="retryFailed" data-i="${i}">Retry</button><button class="secondary" data-act="dismissFailed" data-i="${i}">Dismiss</button></div>`).join('')}</div>` : ''}
    <div class="envrow"><span>Environment: <b>${ENV === 'test' ? 'TEST' : 'Live'}</b></span><button class="secondary" data-act="switchEnv">Switch to ${ENV === 'test' ? 'Live' : 'TEST'}</button></div>`;
}
function defaultDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Windows/.test(ua)) return 'Windows computer';
  if (/Mac/.test(ua)) return 'Mac';
  return 'Device';
}
function screenInfo() {
  return `${window.innerWidth} × ${window.innerHeight} px · ${WIDE_MQ.matches ? 'Two-panel (unfolded) layout' : 'Single-panel (folded) layout'} · switch at ${Number(CFG.widePanelMinWidth) || 760}px`;
}
function settingsHTML() {
  const theme = LS.get('duo-theme') || 'system';
  const appLogo = safeImg(S.meta.appLogo);
  return `<section class="page settings">${backBar('Settings')}
    <div class="content">
      ${ENV === 'test' ? '<div class="testflag">TEST environment — separate data and Sheet</div>' : ''}
      <h3>Sync &amp; devices</h3>
      <div class="panel" id="syncSection">${syncSectionInner()}</div>

      <h3>Appearance</h3>
      <div class="panel">
        <div class="seg">${[['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<button class="seg-btn ${theme === v ? 'on' : ''}" data-act="setTheme" data-theme="${v}">${l}</button>`).join('')}</div>
        <div class="logo-row"><div class="logo-prev">${appLogo ? `<img src="${esc(appLogo)}" alt="">` : ICON.wallet}</div>
          <div><p class="small">App logo on the Accounts screen (this device only)</p>
          <label class="secondary filebtn">Upload<input type="file" accept="image/png,image/jpeg,image/webp" data-act-change="appLogoFile" hidden></label>
          ${appLogo ? '<button class="secondary" data-act="removeAppLogo">Remove</button>' : ''}</div></div>
        <p class="muted small">The Home Screen icon comes from the icon files in GitHub, not this setting.</p>
      </div>

      <h3>Institution branding</h3>
      <div class="panel">${[...S.accounts.values()].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)).map(a => `
        <div class="brandrow"><span class="logo-prev small" style="--card:${isHex(a.color) ? a.color : '#2563eb'}">${logoImg(a.logo, '') || ICON.bank}</span>
        <span class="grow"><b>${esc(a.name)}</b><small>${esc(a.kind)}${a.archived ? ' · archived' : ''}</small></span>
        <button class="secondary" data-act="editAccount" data-id="${esc(a.id)}">Edit</button></div>`).join('') || '<p class="muted">No accounts yet.</p>'}
      </div>

      <h3>Organize</h3>
      <div class="panel list">
        <button class="listbtn" data-act="go" data-view="categories">Categories<span>›</span></button>
        <button class="listbtn" data-act="go" data-view="archived">Archived accounts<span>›</span></button>
        <button class="listbtn" data-act="go" data-view="deleted">Recently deleted<span>›</span></button>
      </div>

      <h3>Data</h3>
      <div class="panel">
        <div class="btnrow"><button class="secondary" data-act="exportCSV">Export CSV</button><button class="secondary" data-act="exportJSON">Download backup (JSON)</button></div>
        <p class="muted small">Once paired, your Google Sheet is the official record and is backed up nightly to Drive.</p>
      </div>

      <h3>Screen</h3>
      <div class="panel"><p class="small" id="screenInfo">${screenInfo()}</p>
        <p class="muted small">Check this folded and unfolded. If the two-panel layout doesn't switch on when open, change <code>widePanelMinWidth</code> in config.js.</p></div>

      ${isIOS() && !isStandalone() ? '<div class="panel warnpanel"><b>Install for safety:</b> In Safari tap Share → Add to Home Screen. iOS can clear website data that isn\'t installed, so the installed app is safer for entries waiting to sync.</div>' : ''}
      <p class="muted small center">Duo Checkbook ${esc(APP_VERSION)} · ${ENV === 'test' ? 'TEST' : 'Live'}</p>
    </div>${navHTML('settings')}</section>`;
}
async function retryFailed(i) {
  const f = (S.meta.failed || [])[i];
  if (!f) return;
  const rec = MAP[f.entity].get(f.record.id) || f.record;
  await setMeta('failed', S.meta.failed.filter((_, j) => j !== i));
  await commit(f.entity, rec);
  syncNow();
}

/* ───────────── Categories / archived / deleted ───────────── */
function categoriesHTML() {
  const group = kind => [...S.categories.values()].filter(c => c.kind === kind).sort((a, b) => Number(a.archived) - Number(b.archived) || (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name))
    .map(c => `<div class="catrow ${c.archived ? 'archived' : ''}"><span>${esc(c.name)}</span><button class="secondary" data-act="toggleCat" data-id="${esc(c.id)}">${c.archived ? 'Restore' : 'Hide'}</button></div>`).join('');
  return `<section class="page">${backBar('Categories')}<div class="content">
    <div class="panel"><form class="addcat" data-form="category"><input id="catName" placeholder="New category name" maxlength="40"><select id="catKind"><option value="expense">Spending</option><option value="income">Income</option></select><button class="primary" type="submit">Add</button></form></div>
    <h3>Spending</h3><div class="panel">${group('expense') || '<p class="muted">None</p>'}</div>
    <h3>Income</h3><div class="panel">${group('income') || '<p class="muted">None</p>'}</div>
    <p class="muted small">Hidden categories stay on past entries but aren't offered for new ones.</p></div></section>`;
}
function archivedHTML() {
  const list = [...S.accounts.values()].filter(a => a.archived);
  return `<section class="page">${backBar('Archived accounts')}<div class="content"><div class="panel">${list.map(a => `
    <div class="brandrow"><span class="grow"><b>${esc(a.name)}</b><small>${esc(a.kind)} · ${money(balance(a.id))}</small></span>
    <button class="secondary" data-act="openAccount" data-id="${esc(a.id)}">View</button><button class="secondary" data-act="unarchive" data-id="${esc(a.id)}">Unarchive</button></div>`).join('') || '<p class="muted">No archived accounts.</p>'}</div></div></section>`;
}
function deletedHTML() {
  const list = [...S.tx.values()].filter(t => t.deletedAt).sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt))).slice(0, 200);
  return `<section class="page">${backBar('Recently deleted')}<div class="content"><div class="panel">${list.map(t => `
    <div class="brandrow"><span class="grow"><b>${esc(t.type === 'transfer' ? 'Transfer: ' + acctName(t.accountId) + ' → ' + acctName(t.toAccountId) : t.payee)}</b><small>${fmtDate(t.date)} · ${money(t.amountCents)} · ${esc(acctName(t.accountId))}</small></span>
    <button class="secondary" data-act="restoreTx" data-id="${esc(t.id)}">Restore</button></div>`).join('') || '<p class="muted">Nothing deleted.</p>'}</div>
    <p class="muted small">Deleted entries are never erased from your Sheet; they're marked deleted and can be restored here.</p></div></section>`;
}

/* ───────────── Reports ───────────── */
function reportsHTML() {
  const years = [...new Set([String(new Date().getFullYear()), ...liveTx().map(t => t.date.slice(0, 4))])].sort().reverse();
  if (!years.includes(reportState.year)) reportState.year = years[0];
  const y = reportState.year, acc = reportState.account;
  const inScope = t => t.type !== 'transfer' && t.date.startsWith(y) && (acc === 'all' || t.accountId === acc);
  const txs = liveTx().filter(inScope);
  const months = [];
  for (let m = 12; m >= 1; m--) {
    const key = y + '-' + pad(m);
    const mt = txs.filter(t => t.date.startsWith(key));
    if (!mt.length) continue;
    const inc = mt.filter(t => t.type === 'income').reduce((s, t) => s + t.amountCents, 0);
    const out = mt.filter(t => t.type === 'expense').reduce((s, t) => s + t.amountCents, 0);
    months.push({ label: new Date(Number(y), m - 1, 1).toLocaleString('en-US', { month: 'long' }), inc, out });
  }
  const totIn = months.reduce((s, m) => s + m.inc, 0), totOut = months.reduce((s, m) => s + m.out, 0);
  const cat = new Map();
  txs.filter(t => t.type === 'expense').forEach(t => cat.set(t.category || 'Uncategorized', (cat.get(t.category || 'Uncategorized') || 0) + t.amountCents));
  const cats = [...cat.entries()].sort((a, b) => b[1] - a[1]);
  const maxCat = cats.length ? cats[0][1] : 1;
  return `<section class="page reports">${backBar('Reports', '<button class="iconbtn" data-act="print" aria-label="Print or save PDF"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7"/></svg></button>')}
    <div class="content">
      <div class="row2 noprint">
        <label class="field"><span>Year</span><select data-report="year">${years.map(v => `<option ${v === y ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="field"><span>Account</span><select data-report="account"><option value="all">All accounts</option>${[...S.accounts.values()].map(a => `<option value="${esc(a.id)}" ${a.id === acc ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      </div>
      <div class="kpis"><div><small>Income</small><strong class="pos">${money(totIn)}</strong></div><div><small>Spending</small><strong class="neg">${money(totOut)}</strong></div><div><small>Net</small><strong>${money(totIn - totOut)}</strong></div></div>
      <h3>By month</h3>
      <div class="panel"><table class="rtable"><thead><tr><th>Month</th><th>Income</th><th>Spending</th><th>Net</th></tr></thead><tbody>
        ${months.map(m => `<tr><td>${m.label}</td><td class="pos">${money(m.inc)}</td><td class="neg">${money(m.out)}</td><td>${money(m.inc - m.out)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No activity this year.</td></tr>'}
      </tbody></table></div>
      <h3>Spending by category</h3>
      <div class="panel">${cats.map(([n, v]) => `<div class="catbar"><span>${esc(n)}</span><div class="bar"><i style="width:${Math.max(3, Math.round(v / maxCat * 100))}%"></i></div><b>${money(v)}</b></div>`).join('') || '<p class="muted">No spending this year.</p>'}</div>
      <p class="muted small">Transfers between your accounts are left out so they don't count as income or spending. Full monthly and annual summaries with opening/closing balances are on your Sheet's summary tabs.</p>
      <div class="btnrow noprint"><button class="secondary" data-act="print">Print / Save PDF</button><button class="secondary" data-act="exportCSV">Export CSV</button></div>
    </div>${navHTML('reports')}</section>`;
}

/* ───────────── Reconcile ───────────── */
function reconcileHTML() {
  const a = S.accounts.get(view.id);
  if (!recon || recon.id !== view.id) recon = { id: view.id, date: todayISO(), balance: '', checked: new Set() };
  return `<section class="page">${backBar('Reconcile ' + a.name)}<div class="content">
    <div class="panel">
      <p class="small">Enter your bank statement's ending date and balance, then check off each entry that appears on the statement.</p>
      <div class="row2">
        <label class="field"><span>Statement date</span><input type="date" data-rec="date" value="${esc(recon.date)}"></label>
        <label class="field"><span>Statement ending balance</span><input type="text" inputmode="decimal" data-rec="balance" value="${esc(recon.balance)}" placeholder="0.00"></label>
      </div>
    </div>
    <div class="reconsum" id="reconSum"></div>
    <div class="panel" id="reconList"></div>
    <button class="primary" data-act="finishRecon">Mark checked entries as cleared</button>
  </div></section>`;
}
function updateRecon() {
  const id = view.id;
  const list = liveTx().filter(t => touches(t, id) && !clearedFor(t, id) && t.date <= recon.date).sort(byDateAsc);
  [...recon.checked].forEach(x => { if (!list.some(t => t.id === x)) recon.checked.delete(x); });
  const after = balance(id, true) + list.filter(t => recon.checked.has(t.id)).reduce((s, t) => s + effect(t, id), 0);
  const target = toCents(recon.balance);
  const diff = isNaN(target) ? null : target - after;
  $('#reconSum').innerHTML = `<div><small>Cleared + checked</small><strong>${money(after)}</strong></div><div><small>Statement</small><strong>${isNaN(target) ? '—' : money(target)}</strong></div><div class="${diff === 0 ? 'okc' : 'warnc'}"><small>Difference</small><strong>${diff === null ? '—' : money(diff)}</strong></div>`;
  $('#reconList').innerHTML = list.map(t => `<label class="reconrow"><input type="checkbox" data-recon="${esc(t.id)}" ${recon.checked.has(t.id) ? 'checked' : ''}><span class="grow">${esc(txTitle(t, id))}<small>${fmtDate(t.date)}${t.checkNumber ? ' · #' + esc(t.checkNumber) : ''}</small></span><b class="${effect(t, id) > 0 ? 'pos' : 'neg'}">${money(effect(t, id))}</b></label>`).join('') || '<p class="muted">No outstanding entries up to this date.</p>';
}
async function finishRecon() {
  const id = view.id;
  if (!recon.checked.size) return toast('Check the entries that are on your statement first.');
  const target = toCents(recon.balance);
  const after = balance(id, true) + liveTx().filter(t => recon.checked.has(t.id)).reduce((s, t) => s + effect(t, id), 0);
  if (!isNaN(target) && target !== after && !confirm('The difference is ' + money(target - after) + '. Mark the checked entries as cleared anyway?')) return;
  for (const tid of recon.checked) {
    const t = S.tx.get(tid);
    if (!t) continue;
    const upd = t.type === 'transfer' && t.toAccountId === id ? { ...t, toCleared: true } : { ...t, cleared: true };
    await commit('tx', upd);
  }
  const n = recon.checked.size;
  recon = null;
  go({ name: 'account', id });
  toast(n + ' entr' + (n === 1 ? 'y' : 'ies') + ' marked cleared');
}

/* ───────────── Export ───────────── */
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function exportCSV() {
  const cell = v => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const cols = ['Date', 'Type', 'Account', 'To Account', 'Payee', 'Category', 'Check #', 'Amount', 'Cleared', 'To Cleared', 'Note', 'Receipt', 'ID'];
  const lines = [cols.join(',')];
  liveTx().sort(byDateAsc).forEach(t => lines.push([t.date, t.type, acctName(t.accountId), t.toAccountId ? acctName(t.toAccountId) : '', t.payee, t.category, t.checkNumber, centsToInput(t.amountCents), t.cleared ? 'yes' : 'no', t.type === 'transfer' ? (t.toCleared ? 'yes' : 'no') : '', t.note, t.receiptUrl, t.id].map(cell).join(',')));
  download('duo-checkbook-' + todayISO() + '.csv', lines.join('\r\n'), 'text/csv;charset=utf-8');
}
function exportJSON() {
  const data = { app: 'Duo Checkbook', version: APP_VERSION, exportedAt: nowISO(), accounts: [...S.accounts.values()], categories: [...S.categories.values()], transactions: [...S.tx.values()], waiting: S.outbox };
  download('duo-checkbook-backup-' + todayISO() + '.json', JSON.stringify(data, null, 2), 'application/json');
}

/* ───────────── Toast & banner ───────────── */
let toastTimer;
function toast(msg, action) {
  clearTimeout(toastTimer);
  const host = $('#toastHost');
  host.innerHTML = `<div class="toast"><span>${esc(msg)}</span>${action ? `<button data-act="toastAction">${esc(action.label)}</button>` : ''}</div>`;
  host._action = action ? action.fn : null;
  toastTimer = setTimeout(() => { host.innerHTML = ''; host._action = null; }, action ? 7000 : 3500);
}
let swReg = null;
function showBanner(msg, forceReload) {
  $('#banner').innerHTML = `<div class="updatebar"><span>${esc(msg)}</span><button data-act="applyUpdate" data-force="${forceReload ? 1 : 0}">Refresh</button></div>`;
}

/* ───────────── Theme ───────────── */
function applyTheme() {
  const t = LS.get('duo-theme') || 'system';
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const m = $('#themeColor'); if (m) m.content = dark ? '#0f1520' : '#f4f6fa';
}

/* ───────────── Event wiring ───────────── */
const ACT = {
  noop() {},
  go: el => go({ name: el.dataset.view }),
  back() {
    if (['reconcile'].includes(view.name)) return go({ name: 'account', id: view.id });
    if (['categories', 'archived', 'deleted'].includes(view.name)) return go({ name: 'settings' });
    if (view.name === 'account' && WIDE_MQ.matches && draft && draft.dirty && !confirm('Discard the entry you were typing?')) return;
    draft = null; go({ name: 'home' });
  },
  goSync: () => go({ name: 'settings' }),
  theme() { LS.set('duo-theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); applyTheme(); render(); },
  setTheme: el => { LS.set('duo-theme', el.dataset.theme); applyTheme(); render(); },
  openAccount: el => go({ name: 'account', id: el.dataset.id }),
  newAccount: () => openAccountEditor(),
  editAccount: el => openAccountEditor(el.dataset.id),
  newEntry: el => openEntry(el.dataset.mode),
  editTx(el) {
    const row = el.closest('.tx');
    if (row && row.classList.contains('revealed')) { row.classList.remove('revealed'); row.querySelector('.tx-body').style.transform = ''; return; }
    openEntry(null, el.dataset.id);
  },
  deleteTx: el => removeTx(el.dataset.id),
  restoreTx: el => restoreTx(el.dataset.id),
  mode(el) {
    if (!draft) return;
    draft.mode = el.dataset.mode;
    draft.dirty = true;
    if (draft.mode !== 'transfer' && draft.category && !categoriesFor(draft.mode).some(c => c.name === draft.category)) draft.category = '';
    if (draft.mode === 'transfer' && (!draft.toAccountId || draft.toAccountId === draft.accountId)) draft.toAccountId = otherAccount(draft.accountId);
    mountEntry(sheetKind === 'entry' ? $('#sheetBody') : $('#entryPanel'));
    if (sheetKind === 'entry') { const h = $('.sheet-title h2'); if (h) h.textContent = draft.id ? 'Edit entry' : ({ expense: 'New spending', income: 'New income', transfer: 'New transfer' })[draft.mode]; }
  },
  pickPayee(el) {
    draft.payee = el.dataset.name; draft.dirty = true;
    if (!draft.category && el.dataset.cat && categoriesFor(draft.mode).some(c => c.name === el.dataset.cat)) draft.category = el.dataset.cat;
    const form = el.closest('form');
    $('[data-f="payee"]', form).value = draft.payee;
    const sel = $('[data-f="category"]', form); if (sel) sel.value = draft.category;
    renderTiles();
    const amt = $('[data-f="amount"]', form); if (amt && !amt.value) amt.focus();
  },
  resetEntry() {
    if (draft && draft.dirty && !confirm('Discard the entry you were typing?')) return;
    draft = newDraft('expense'); mountEntry($('#entryPanel')); renderLedger();
  },
  closeSheet: () => closeSheet(),
  saveSheet() { if (sheetKind === 'entry') saveEntry(); else if (sheetKind === 'account') saveAccount(); },
  sheetBackdrop: (el, e) => { if (e.target === el) closeSheet(); },
  toggleFilters() { filt.open = !filt.open; $('#filters').classList.toggle('hidden', !filt.open); $('[data-act="toggleFilters"]').classList.toggle('on', filt.open); },
  filterType(el) { filt.type = el.dataset.type; $$('[data-act="filterType"]').forEach(b => b.classList.toggle('on', b === el)); renderLedger(); },
  clearFilters() { filt = { ...freshFilters(), open: true }; render(); },
  toggleCleared() { filt.hideCleared = !filt.hideCleared; renderLedger(); },
  more() { filt.limit += 150; renderLedger(); },
  reconcile: () => { recon = null; go({ name: 'reconcile', id: view.id }); },
  finishRecon: () => finishRecon(),
  pickColor(el) { acctDraft.color = el.dataset.color; acctDraft.dirty = true; refreshAcctForm(); },
  removeLogo() { acctDraft.logo = ''; acctDraft.dirty = true; refreshAcctForm(); },
  useLogoUrl() {
    const v = ($('[data-a="logoUrl"]') || {}).value || '';
    const s = safeImg(v.trim());
    if (!s || !s.startsWith('https://')) return toast('Enter an image link that starts with https://');
    acctDraft.logo = s; acctDraft.dirty = true; refreshAcctForm();
  },
  async pasteLogo() {
    if (!navigator.clipboard || !navigator.clipboard.read) return toast('Tap the paste area below, then paste.');
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find(t => /^image\/(png|jpeg|webp)$/.test(t));
        if (type) return setAcctLogoFromFile(new File([await item.getType(type)], 'logo', { type }));
      }
      toast('No image on the clipboard.');
    } catch (e) { toast('Clipboard not available. Use Upload or the paste area.'); }
  },
  async unarchive(el) { const a = S.accounts.get(el.dataset.id); await commit('acct', { ...a, archived: false }); render(); toast('Account restored'); },
  async toggleCat(el) { const c = S.categories.get(el.dataset.id); await commit('cat', { ...c, archived: !c.archived }); render(); },
  async saveEndpoint() {
    const v = $('#endpointInput').value.trim();
    if (v && !/^https:\/\/script\.google\.com\/(a\/macros\/[^/]+|macros)\/s\/[\w-]+\/exec$/.test(v)) return toast('That should look like https://script.google.com/macros/s/…/exec');
    await setMeta('endpointOverride', v === ((CFG.endpoints || {})[ENV] || '') ? '' : v);
    rerenderData(); toast('Address saved'); syncNow();
  },
  async pair() {
    const code = $('#pairCode').value.trim(), name = $('#deviceName').value.trim() || defaultDeviceName();
    if (!code) return toast('Enter the pairing code from your Sheet.');
    const btn = $('[data-act="pair"]'); btn.disabled = true; btn.textContent = 'Pairing…';
    try { await pairDevice(code, name); toast('Paired! Your Sheet is connected.'); render(); }
    catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Pair device'; }
  },
  syncNow: () => syncNow(),
  fullResync: () => syncNow({ full: true }),
  async unpair() {
    if (!confirm('Unpair this device? Entries stay on this device' + (S.outbox.length ? ' and the ' + S.outbox.length + ' waiting change(s) will sync after you pair again.' : '.'))) return;
    await setMeta('token', ''); await setMeta('deviceId', '');
    setSync('unpaired'); render();
  },
  retryFailed: el => retryFailed(Number(el.dataset.i)),
  async dismissFailed(el) { await setMeta('failed', (S.meta.failed || []).filter((_, j) => j !== Number(el.dataset.i))); rerenderData(); },
  switchEnv() {
    if (!confirm('Switch to the ' + (ENV === 'test' ? 'Live' : 'TEST') + ' environment? Each has its own data and Sheet.')) return;
    LS.set('duo-env', ENV === 'test' ? 'live' : 'test'); location.reload();
  },
  async removeAppLogo() { await setMeta('appLogo', ''); render(); },
  exportCSV, exportJSON,
  print: () => window.print(),
  toastAction() { const h = $('#toastHost'); const fn = h._action; h.innerHTML = ''; h._action = null; if (fn) fn(); },
  applyUpdate(el) {
    if (el.dataset.force !== '1' && swReg && swReg.waiting) swReg.waiting.postMessage({ type: 'SKIP_WAITING' });
    else location.reload();
  }
};

function wireEvents() {
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    if (el.closest('.tx') && suppressClick) { suppressClick = false; e.preventDefault(); return; }
    const fn = ACT[el.dataset.act];
    if (!fn) return;
    if (el.tagName === 'A' && el.dataset.act === 'noop') { e.stopPropagation(); return; }
    if (el.tagName === 'A') e.preventDefault();
    fn(el, e);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && sheetKind) closeSheet();
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.tx-body')) { e.preventDefault(); ACT.editTx(e.target); }
  });
  document.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target.dataset.form;
    if (f === 'entry') saveEntry();
    if (f === 'account') saveAccount();
    if (f === 'category') {
      const name = $('#catName').value.trim(), kind = $('#catKind').value;
      if (!name) return;
      if ([...S.categories.values()].some(c => c.kind === kind && c.name.toLowerCase() === name.toLowerCase())) return toast('That category already exists.');
      await commit('cat', { id: 'cat-' + uid(), name: name.slice(0, 40), kind, archived: false, sortOrder: 100 + S.categories.size, version: 0 });
      render(); toast('Category added');
    }
  });
  const onField = e => {
    const el = e.target;
    if (el.dataset.f && draft) {
      draft[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value;
      draft.dirty = true;
      if (el.dataset.f === 'payee') renderTiles();
      if (el.dataset.f === 'accountId' && draft.mode === 'transfer' && draft.toAccountId === draft.accountId) {
        draft.toAccountId = otherAccount(draft.accountId);
        const to = $('[data-f="toAccountId"]', el.closest('form')); if (to) to.value = draft.toAccountId;
      }
    } else if (el.dataset.a && acctDraft) {
      if (el.dataset.a === 'logoUrl') return;
      acctDraft[el.dataset.a] = el.type === 'checkbox' ? el.checked : el.value;
      acctDraft.dirty = true;
      if (el.dataset.a === 'color' && e.type === 'change') refreshAcctForm();
    } else if (el.dataset.filter) {
      filt[el.dataset.filter] = el.value; filt.limit = 150; renderLedger();
    } else if (el.dataset.rec && recon) {
      recon[el.dataset.rec] = el.value; updateRecon();
    } else if (el.dataset.recon && recon) {
      if (el.checked) recon.checked.add(el.dataset.recon); else recon.checked.delete(el.dataset.recon);
      updateRecon();
    } else if (el.dataset.report && e.type === 'change') {
      reportState[el.dataset.report] = el.value; render();
    }
  };
  document.addEventListener('input', onField);
  document.addEventListener('change', e => {
    onField(e);
    const el = e.target;
    if (el.dataset.actChange === 'acctLogoFile' && el.files[0]) setAcctLogoFromFile(el.files[0]);
    if (el.dataset.actChange === 'appLogoFile' && el.files[0]) {
      shrinkImage(el.files[0], 160, 200000).then(d => setMeta('appLogo', d)).then(() => { render(); toast('Logo saved on this device'); }).catch(err => toast(err.message));
    }
  });
  document.addEventListener('paste', e => {
    const zone = e.target.closest && e.target.closest('[data-paste="acct"]');
    if (!zone || !acctDraft) return;
    const item = [...(e.clipboardData && e.clipboardData.items || [])].find(i => /^image\/(png|jpeg|webp)$/.test(i.type));
    if (item) { e.preventDefault(); setAcctLogoFromFile(item.getAsFile()); }
  });
  bindSwipes();

  window.addEventListener('online', () => syncNow());
  window.addEventListener('offline', () => setSync('offline'));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
  window.addEventListener('pageshow', () => syncNow());
  setInterval(() => { if (document.visibilityState === 'visible' && S.meta.token) syncNow(); }, 60000);

  WIDE_MQ.addEventListener('change', onLayoutChange);
  window.addEventListener('resize', () => { const s = $('#screenInfo'); if (s) s.textContent = screenInfo(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if ((LS.get('duo-theme') || 'system') === 'system') { applyTheme(); render(); } });
}

/** Fold / unfold: keep whatever is being typed, move it between the sheet and the left panel. */
function onLayoutChange() {
  if (view.name !== 'account') { render(); return; }
  if (WIDE_MQ.matches) {
    if (sheetKind === 'entry') { sheetKind = null; $('#sheetHost').innerHTML = ''; }
    render();
  } else {
    const keep = draft && (draft.dirty || draft.id);
    render();
    if (keep) showEntrySheet(); else draft = null;
  }
}

/* Swipe left on a transaction to reveal Delete. */
let suppressClick = false;
function bindSwipes() {
  let row = null, body = null, x0 = 0, y0 = 0, dx = 0, mode = null, base = 0;
  document.addEventListener('touchstart', e => {
    if (e.target.closest('.tx-del')) { row = null; return; }
    const b = e.target.closest('.tx-body');
    $$('.tx.revealed').forEach(r => { if (!b || r !== b.parentElement) { r.classList.remove('revealed'); r.querySelector('.tx-body').style.transform = ''; } });
    if (!b) { row = null; return; }
    body = b; row = b.parentElement; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; mode = null;
    base = row.classList.contains('revealed') ? -88 : 0;
    body.style.transition = 'none';
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (!row) return;
    const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
    if (!mode) { if (Math.abs(mx) > 8 || Math.abs(my) > 8) mode = Math.abs(mx) > Math.abs(my) * 1.2 ? 'h' : 'v'; }
    if (mode !== 'h') return;
    dx = mx;
    body.style.transform = `translateX(${Math.min(0, Math.max(-120, base + dx))}px)`;
  }, { passive: true });
  document.addEventListener('touchend', () => {
    if (!row) return;
    body.style.transition = '';
    if (mode === 'h') {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 350);
      const open = base + dx < -44;
      row.classList.toggle('revealed', open);
      body.style.transform = open ? 'translateX(-88px)' : '';
    }
    row = null;
  });
}

/* ───────────── Service worker ───────────── */
function registerSW() {
  if (!('serviceWorker' in navigator) || !(location.protocol === 'https:' || location.hostname === 'localhost')) return;
  navigator.serviceWorker.register('./sw.js').then(reg => {
    swReg = reg;
    if (reg.waiting && navigator.serviceWorker.controller) showBanner('A new version of Duo Checkbook is ready.');
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (w) w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) showBanner('A new version of Duo Checkbook is ready.'); });
    });
    setInterval(() => reg.update().catch(() => {}), 30 * 60000);
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
}

/* ───────────── Boot ───────────── */
(async function boot() {
  applyTheme();
  try { await loadAll(); }
  catch (e) {
    root().innerHTML = `<div class="boot"><p><b>Storage is unavailable.</b></p><p>${esc(e.message || e)}</p><p>Private Browsing can block storage. Open the installed app or a normal Safari window.</p></div>`;
    return;
  }
  wireEvents();
  render();
  registerSW();
  setSync(!endpoint() ? 'local' : !S.meta.token ? 'unpaired' : 'idle');
  syncNow();
})();