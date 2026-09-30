const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Local dates exercise the same timezone rules as the extension.
let now = new Date(2026, 8, 30, 10, 0, 1).getTime();
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const event = () => ({ addListener() {}, removeListener() {} });
let onAlarm;
const alarms = new Map();
const stored = { signTime: "10:00" };
const context = vm.createContext({
  Date: Clock, console, setTimeout, clearTimeout,
  chrome: {
    runtime: { onInstalled: event(), onStartup: event(), onMessage: event() },
    storage: { onChanged: event(), local: { get: async () => stored } },
    alarms: {
      onAlarm: { addListener(fn) { onAlarm = fn; } },
      get: async (name) => alarms.get(name),
      clear: async (name) => alarms.delete(name),
      create: async (name, spec) => alarms.set(name, { scheduledTime: spec.when, ...spec })
    },
    tabs: { onRemoved: event(), onCreated: event(), onUpdated: event() },
    windows: { onCreated: event() }
  }
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
const run = (code) => vm.runInContext(code, context);
const normal = "apk-tw-daily-signin";
const incognito = "apk-tw-daily-signin-incognito";

(async () => {
  for (const status of ["login", "captcha"]) {
    context.site = { enabled: true, lastResult: status,
      lastResultAt: new Date(2026, 8, 29, 23, 59).toISOString() };
    assert.equal(run("isCatchUpDueSite(site)"), true);
    context.site.lastResultAt = new Date(2026, 8, 30, 0, 1).toISOString();
    assert.equal(run("isCatchUpDueSite(site)"), false);
    context.site.lastResultAt = "";
    assert.equal(run("isCatchUpDueSite(site)"), true);
  }
  assert.equal(run("isCatchUpDueSite({enabled:false})"), false);
  assert.equal(run("isCatchUpDueSite({enabled:true,lastSignDate:todayKey()})"), false);

  now = new Date(2026, 8, 30, 9, 59, 59).getTime();
  assert.equal(run("getNextAlarmTimestamp('10:00')"), now + 1000);
  now += 1000;
  assert.equal(run("getNextAlarmTimestamp('10:00')"), new Date(2026, 9, 1, 10).getTime());

  alarms.set(normal, { scheduledTime: now });
  alarms.set(incognito, { scheduledTime: now });
  now += 1000;
  await run("scheduleAlarm()");
  assert.equal(alarms.get(normal).scheduledTime, now - 1000);
  assert.equal(alarms.get(incognito).scheduledTime, now - 1000);

  // Isolate dispatch from real tabs and keep the counterpart alarm pending.
  run("startSignIn = async () => true");
  await onAlarm({ name: normal });
  assert.equal(alarms.get(normal).scheduledTime, new Date(2026, 9, 1, 10).getTime());
  assert.equal(alarms.get(incognito).scheduledTime, now - 1000);
  await onAlarm({ name: incognito });
  assert.equal(alarms.get(incognito).scheduledTime, new Date(2026, 9, 1, 10).getTime());

  stored.signTime = "11:00";
  await run("scheduleProfileAlarm(false)");
  assert.equal(alarms.get(normal).scheduledTime, new Date(2026, 8, 30, 11).getTime());
  stored.sites = Object.fromEntries(run("SITE_ORDER").map(id => [id, { enabled: false }]));
  await run("scheduleProfileAlarm(false)");
  assert.equal(alarms.has(normal), false);
  console.log("Scheduling regression checks passed.");
})().catch(error => { console.error(error); process.exitCode = 1; });
