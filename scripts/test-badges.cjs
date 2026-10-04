const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, removeListener() {} });
const session = {}, local = {}, alarms = new Map(), tabs = new Map();
const storage = data => ({ get: async () => structuredClone(data), set: async patch => Object.assign(data, structuredClone(patch)) });
let nextId = 1;
const chrome = {
  runtime: { onInstalled: event(), onStartup: event(), onMessage: event() },
  storage: { local: storage(local), session: storage(session), onChanged: event() },
  alarms: { onAlarm: event(), get: async name => alarms.get(name), clear: async name => alarms.delete(name), create: async (name, spec) => alarms.set(name, spec) },
  windows: { onCreated: event(), getAll: async () => [{ id: 10, incognito: false }, { id: 20, incognito: true }] },
  tabs: {
    onRemoved: event(), onCreated: event(), onUpdated: event(),
    create: async spec => { const tab = { ...spec, id: nextId++, status: 'complete' }; tabs.set(tab.id, tab); return tab; },
    get: async id => { if (!tabs.has(id)) throw Error('Missing tab'); return tabs.get(id); },
    update: async () => {},
    remove: async id => { tabs.delete(id); for (const fn of chrome.tabs.onRemoved.listeners) await fn(id); }
  },
  i18n: { getMessage: key => key }
};
const context = vm.createContext({ chrome, console, Date, setTimeout, clearTimeout });
const run = code => vm.runInContext(code, context);
run(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'));

const badges = new Map();
let blockedWrite = null;
chrome.action = {
  setBadgeText: async ({ tabId, text }) => {
    if (blockedWrite) { const wait = blockedWrite; blockedWrite = null; await wait; }
    badges.set(tabId ?? 'default', text);
  },
  setBadgeBackgroundColor: async () => {},
  setBadgeTextColor: async () => {}
};
chrome.tabs.query = async () => [...tabs.values()];
run('notify = setActionTooltip = async () => {}');
const settle = () => run('badgeUpdateQueue');
(async () => {
  const allSites = status => Object.fromEntries(
    ['baha', 'apktw', 'eyny', 'genshin', 'klpbbs', 'littleskin'].map(id =>
      [id, { enabled: id === 'baha', lastResult: id === 'baha' ? status : '' }])
  );
  for (const status of ['', 'success', 'already', 'login', 'captcha', 'timeout', 'error', 'unknown']) {
    context.settings = { sites: allSites(status) };
    assert.equal(run('siteNeedsAttention(settings)'), !['', 'success', 'already'].includes(status), status);
    context.settings.sites.baha.enabled = false;
    assert.equal(run('siteNeedsAttention(settings)'), false, 'Disabled sites never warn');
  }
  tabs.set(101, { id: 101, incognito: false });
  tabs.set(202, { id: 202, incognito: true });
  local.sites = allSites('login');
  local.incognitoSettings = { signTime: '00:01', sites: allSites('success') };
  await run('syncLoginBadge()');
  assert.equal(badges.get(101), '!');
  assert.equal(badges.get(202), '');
  assert.equal(badges.get('default'), '');
  run('signingLocks.add(false); signingLocks.add(true)');
  local.sites.baha.lastResult = 'success';
  local.incognitoSettings.sites.baha.lastResult = 'captcha';
  await chrome.storage.onChanged.listeners[0]({ sites: {}, incognitoSettings: {} }, 'local');
  await settle();
  assert.equal(badges.get(101), '');
  assert.equal(badges.get(202), '!');
  badges.set(202, '');
  await chrome.tabs.onUpdated.listeners[0](202, { status: 'loading' }, tabs.get(202));
  await settle();
  assert.equal(badges.get(202), '!');
  await chrome.tabs.onCreated.listeners[1]({ id: 303, incognito: false });
  await settle();
  assert.equal(badges.get(303), '');
  let release;
  blockedWrite = new Promise(resolve => { release = resolve; });
  const oldRefresh = run('syncLoginBadge()');
  await new Promise(resolve => setImmediate(resolve));
  local.incognitoSettings.sites.baha.lastResult = 'success';
  const newRefresh = run('syncLoginBadge()');
  release();
  await Promise.all([oldRefresh, newRefresh]);
  assert.equal(badges.get(202), '');
  assert.equal(local.badgeSticky, false);
  local.sitesIncognito = allSites('login');
  local.incognitoSettings.sites = allSites('');
  assert.equal((await run('getSettings({incognito:true})')).sites.baha.lastResult, '');
  delete local.incognitoSettings.sites.baha;
  assert.equal((await run('getSettings({incognito:true})')).sites.baha.lastResult, 'login');
  let hudCalls = 0;
  context.hud = () => { hudCalls++; };
  run('showLoginHudOnTab = async () => hud()');
  await run('applyQueueBadge([{status:"login",tabId:101}])');
  assert.equal(hudCalls, 0, 'Queue end must not reopen a dismissed login HUD');
  local.sites = allSites('');
  local.sites.baha.enabled = false;
  local.sites.klpbbs.enabled = true;
  const notices = [];
  context.captureNotice = (...args) => notices.push(args);
  run('notify = async (...args) => captureNotice(...args)');
  for (const draw of [
    'drawKlpbbsThread = async () => ({ok:false})',
    'drawKlpbbsThread = async () => ({ok:true}); waitForKlpbbsDraw = async () => ({ok:false})',
    'drawKlpbbsThread = async () => { throw Error("draw unavailable"); }'
  ]) {
    tabs.set(101, { id: 101, incognito: false });
    session.signState = { active: true, signTabId: 101, siteId: 'klpbbs', queue: [], incognito: false };
    run(draw);
    await run('onSignResult({status:"success",site:"klpbbs",drawKlpbbs:true},101)');
    assert.equal(local.sites.klpbbs.lastResult, 'success');
    assert.equal(local.sites.klpbbs.lastSignDate, run('todayKey()'));
    assert.equal(badges.get(101), '');
    assert.equal(tabs.has(101), false);
    assert.equal(notices.at(-1)[0], 'resultSuccess');
    assert.equal(alarms.has('apk-tw-retry-signin'), false, 'Do not repeat a completed daily sign-in');
  }
  local.incognitoSettings.sites = allSites('login');
  session.signState = { active: true, signTabId: 101, siteId: 'klpbbs', queue: [], incognito: false };
  await run('onSignResult({status:"already",site:"klpbbs"},101)');
  assert.equal(local.sites.klpbbs.lastResult, 'success');
  assert.equal(badges.get(202), '!');
  assert.equal((await run('loginFailureFlags()')).normal, false);
  console.log('Badge and attention regression checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
