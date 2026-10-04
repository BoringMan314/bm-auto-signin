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
run(`setActionTooltip = syncLoginBadge = applyQueueBadge = notify = async () => {};`);
(async () => {
  for (const first of [true, false]) {
    for (const data of [local, session]) for (const key of Object.keys(data)) delete data[key];
    alarms.clear(); tabs.clear(); run('signingLocks.clear()');
    const sites = Object.fromEntries(['baha', 'apktw', 'eyny', 'genshin', 'klpbbs', 'littleskin'].map(id => [id, { enabled: id === 'baha' || id === 'apktw' }]));
    Object.assign(local, { sites, incognitoSettings: { signTime: '00:01', sites: structuredClone(sites) } });
    const alarm = chrome.alarms.onAlarm.listeners[0];
    const name = incognito => incognito ? 'apk-tw-daily-signin-incognito' : 'apk-tw-daily-signin';
    await Promise.all([alarm({ name: name(first) }), alarm({ name: name(!first) })]);
    assert.equal(tabs.size, 2, 'Both modes start before either finishes');
    const normalId = session.signState.signTabId, privateId = session.signStateIncognito.signTabId;
    assert.equal(tabs.get(normalId).windowId, 10);
    assert.equal(tabs.get(privateId).windowId, 20);
    assert.equal(session.signState.ready, true);
    assert.equal(session.signStateIncognito.ready, true);
    assert.ok(alarms.has('apk-tw-signin-timeout'));
    assert.ok(alarms.has('apk-tw-signin-timeout-incognito'));
    run('signingLocks.clear()');
    await run('Promise.all([startSignIn({incognito:false}), startSignIn({incognito:true})])');
    assert.equal(tabs.size, 2, 'Restart must not duplicate active runs');
    assert.equal((await run(`claimClick(${privateId})`)).claimed, true);
    assert.equal(session.signState.clicked, false);
    await run(`onSignResult({status:'success',site:'baha'}, ${privateId})`);
    assert.equal(session.signState.signTabId, normalId);
    assert.equal(session.signStateIncognito.siteId, 'apktw');
    assert.equal(local.incognitoSettings.sites.baha.lastResult, 'success');
    assert.notEqual(local.sites.baha.lastResult, 'success');
    const privateNext = session.signStateIncognito.signTabId;
    await chrome.tabs.remove(normalId);
    assert.equal(session.signState.siteId, 'apktw');
    assert.equal(session.signStateIncognito.signTabId, privateNext);
    run('detectTabSignStatus = async () => null');
    await alarm({ name: 'apk-tw-signin-timeout' });
    assert.equal(local.sites.apktw.lastResult, 'timeout');
    assert.equal(session.signStateIncognito.active, true);
    assert.ok(alarms.has('apk-tw-signin-timeout-incognito'));
    assert.ok(alarms.has('apk-tw-retry-signin'));
    await run(`onSignResult({status:'success',site:'apktw'}, ${privateNext})`);
    assert.equal(session.signStateIncognito.active, false);
    assert.equal(run('signingLocks.size'), 0);
    assert.equal(local.incognitoSettings.sites.apktw.lastResult, 'success');
  }
  console.log('Concurrent profile regression checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
