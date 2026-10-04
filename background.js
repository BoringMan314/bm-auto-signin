const ALARM_NAME = "apk-tw-daily-signin";
const ALARM_INCOGNITO = "apk-tw-daily-signin-incognito";
const RETRY_ALARM = "apk-tw-retry-signin";
const RETRY_ALARM_INCOGNITO = "apk-tw-retry-signin-incognito";
const RETRY_COUNT_KEY = "signRetryCount";
const RETRY_COUNT_INCOGNITO_KEY = "signRetryCountIncognito";
const RETRY_MS = 5 * 60 * 1000;
const MAX_RETRIES = 10;
const TIMEOUT_ALARM = "apk-tw-signin-timeout";
const CATCHUP_ALARM = "apk-tw-catchup-check";
const CATCHUP_START_ALARM = "apk-tw-catchup-start";
const CATCHUP_RETRY_ALARM = "apk-tw-catchup-retry";
const CATCHUP_PERIOD_MIN = 20;
const CATCHUP_START_DELAY_MS = 8000;
const CATCHUP_WINDOW_WAIT_MS = 60000;
const CATCHUP_RETRY_MS = 2 * 60 * 1000;
const CLEAR_BADGE_ALARM = "apk-tw-clear-badge";
const SIGN_URL = "https://apk.tw/";
const DEFAULT_TIME = "00:01";
const SIGN_TIMEOUT_MS = 90000;
const KLPBBS_DRAW_TIMEOUT_MS = 15000;
const SITE_ORDER = ["baha", "apktw", "eyny", "genshin", "klpbbs", "littleskin"];
const SITES_INCOGNITO_KEY = "sitesIncognito";
const INCOGNITO_SETTINGS_KEY = "incognitoSettings";
const SITES = {
  baha: {
    url: "https://home.gamer.com.tw/homeindex.php",
    hostRe: /gamer\.com\.tw/i,
    nameKey: "siteBaha"
  },
  apktw: {
    url: "https://apk.tw/",
    hostRe: /apk\.tw/i,
    nameKey: "siteApkTw"
  },
  eyny: {
    url: "https://www.eyny.com/",
    hostRe: /eyny\.com/i,
    nameKey: "siteEyny"
  },
  genshin: {
    url: "https://act.hoyolab.com/ys/event/signin-sea-v3/index.html?act_id=e202102251931481",
    hostRe: /hoyolab\.com|hoyoverse\.com/i,
    nameKey: "siteGenshin"
  },
  klpbbs: {
    url: "https://klpbbs.com/",
    hostRe: /klpbbs\.com/i,
    nameKey: "siteKlpbbs"
  },
  littleskin: {
    url: "https://littleskin.cn/user",
    hostRe: /littleskin\.cn/i,
    nameKey: "siteLittleSkin"
  }
};

function isDefaultEnabled(id) {
  return id === "baha" || id === "apktw" || id === "eyny";
}

function emptySiteState(enabled = true) {
  return {
    enabled,
    lastSignDate: "",
    lastResult: "",
    lastResultAt: "",
    lastMessage: ""
  };
}

const DEFAULT_SETTINGS = {
  signTime: DEFAULT_TIME,
  enabled: true,
  lastSignDate: "",
  lastResult: "",
  lastResultAt: "",
  lastMessage: "",
  sites: {
    baha: emptySiteState(),
    apktw: emptySiteState(),
    eyny: emptySiteState(),
    genshin: emptySiteState(false),
    klpbbs: emptySiteState(false),
    littleskin: emptySiteState(false)
  }
};

const signingLocks = new Set();

function timeoutAlarmName(incognito) {
  return incognito ? `${TIMEOUT_ALARM}-incognito` : TIMEOUT_ALARM;
}

function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  await scheduleAlarm();
  await syncLoginBadge();
  await requestStartupCatchUp();
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarm();
  await syncLoginBadge();
  await requestStartupCatchUp();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (!changes.sites && !changes[INCOGNITO_SETTINGS_KEY] &&
      !changes[SITES_INCOGNITO_KEY] && !changes.enabled && !changes.lastResult) return;
  syncLoginBadge().catch(() => {});
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === RETRY_ALARM) {
    await startSignIn({ reason: "retry", incognito: false });
    return;
  }
  if (alarm.name === RETRY_ALARM_INCOGNITO) {
    await startSignIn({ reason: "retry", incognito: true });
    return;
  }
  if (alarm.name === ALARM_NAME) {
    await scheduleProfileAlarm(false, { reschedule: true });
    await startSignIn({ reason: "alarm", incognito: false });
    return;
  }
  if (alarm.name === ALARM_INCOGNITO) {
    await scheduleProfileAlarm(true, { reschedule: true });
    await startSignIn({ reason: "alarm", incognito: true });
    return;
  }
  if (alarm.name === TIMEOUT_ALARM || alarm.name === timeoutAlarmName(true)) {
    await timeoutSignIn(alarm.name === timeoutAlarmName(true));
    return;
  }
  if (alarm.name === CATCHUP_START_ALARM || alarm.name === CATCHUP_RETRY_ALARM) {
    await maybeCatchUp({ waitForWindow: true });
    return;
  }
  if (alarm.name === CATCHUP_ALARM) {
    await maybeCatchUp({ waitForWindow: false });
    return;
  }
  if (alarm.name === CLEAR_BADGE_ALARM) {
    await syncLoginBadge();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getSignStateForTab(tabId);
  if (state.signTabId !== tabId) return;
  await chrome.alarms.clear(timeoutAlarmName(state.incognito));
  await setSignState({ ...state, signTabId: null, active: false, clicked: true });
  if ((state.queue && state.queue.length) || signingLocks.has(Boolean(state.incognito))) {
    signingLocks.add(Boolean(state.incognito));
    await openNextSite(Boolean(state.incognito));
    return;
  }
  await finishSigningLock(Boolean(state.incognito));
});

chrome.tabs.onCreated.addListener(async (tab) => {
  const state = await getSignStateForTab(tab.openerTabId);
  if (!state.active || !state.signTabId) return;
  if (tab.id === state.signTabId) return;
  if (tab.openerTabId !== state.signTabId) return;
  try {
    await chrome.tabs.remove(tab.id);
  } catch (_) {
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status === "loading" || info.status === "complete" || info.url) {
    applyLoginBadgeToTab(tab).catch(() => {});
  }
  const url = info.url || (info.status === "complete" ? tab.url : "");
  if (!url) return;
  const state = await getSignStateForTab(tabId);
  if (!state.active || state.finishing || state.signTabId !== tabId) return;
  if (!isLoginUrl(url, state.siteId)) return;
  await onSignResult(
    { status: "login", message: loginMessage(state.siteId), site: state.siteId },
    tabId
  );
});

chrome.tabs.onCreated.addListener((tab) => {
  applyLoginBadgeToTab(tab).catch(() => {});
});

chrome.windows.onCreated.addListener((win) => {
  if (win.type && win.type !== "normal") return;
  maybeCatchUpProfile(Boolean(win.incognito), { waitForWindow: false }).catch(() => {});
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "getSettings":
      await syncLoginBadge();
      return {
        ok: true,
        settings: await getSettings({ incognito: isIncognitoMessage(message, sender) }),
        nextAlarm: await getNextAlarmInfo({ incognito: isIncognitoMessage(message, sender) })
      };
    case "saveSettings":
      return saveSettings(message.payload || {}, {
        incognito: isIncognitoMessage(message, sender)
      });
    case "signNow": {
      const started = await startSignIn({
        reason: "manual",
        force: true,
        incognito: Boolean(message.incognito),
        windowId: message.windowId || null
      });
      return started ? { ok: true } : { ok: false, error: t("cannotStart") };
    }
    case "shouldAutoSign":
      return { ok: true, shouldSign: await isSignTab(sender.tab?.id, message.site) };
    case "isTabReady":
      return { ok: true, ready: await isTabMarkedReady(sender.tab?.id) };
    case "claimClick":
      return claimClick(sender.tab?.id);
    case "apk502Retry":
      return claimApk502Retry(sender.tab?.id);
    case "clickSignButton":
      return clickSignButton(sender.tab?.id);
    case "bahaInspect":
      return inspectBaha(sender.tab?.id);
    case "bahaSign":
      return clickBaha(sender.tab?.id);
    case "genshinApi":
      return genshinApi(sender.tab?.id, message.payload || {});
    case "klpbbsInspect":
      return inspectKlpbbs(sender.tab?.id);
    case "klpbbsSign":
      return clickKlpbbs(sender.tab?.id);
    case "eynyInspect":
      return inspectEyny(sender.tab?.id);
    case "eynyHook":
      return hookEyny(sender.tab?.id);
    case "klpbbsDrawThread":
      return drawKlpbbsThread(sender.tab?.id);
    case "littleskinInspect":
      return inspectLittleSkin(sender.tab?.id);
    case "littleskinSign":
      return clickLittleSkin(sender.tab?.id);
    case "signResult":
      await onSignResult(message.payload || {}, sender.tab?.id);
      return { ok: true };
    default:
      return { ok: false, error: t("unknownMessage") };
  }
}

async function ensureDefaults() {
  const current = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const patch = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (key === "sites") continue;
    if (current[key] === undefined) patch[key] = value;
  }
  const latest = await chrome.storage.local.get("sites");
  const sites = { ...(latest.sites || current.sites || {}) };
  let sitesChanged = current.sites === undefined;
  for (const id of SITE_ORDER) {
    if (sites[id] === undefined) {
      sites[id] = emptySiteState(isDefaultEnabled(id));
      sitesChanged = true;
    }
  }
  if (sitesChanged) patch.sites = sites;
  if (Object.keys(patch).length) {
    await chrome.storage.local.set(patch);
  }
}

function isIncognitoMessage(message, sender) {
  if (typeof message?.incognito === "boolean") return message.incognito;
  return Boolean(sender?.tab?.incognito);
}

function resultSnapshot(site) {
  return {
    lastSignDate: site?.lastSignDate || "",
    lastResult: site?.lastResult || "",
    lastResultAt: site?.lastResultAt || "",
    lastMessage: site?.lastMessage || ""
  };
}

function persistableSites(sites) {
  const scoped = {};
  for (const id of SITE_ORDER) {
    scoped[id] = {
      enabled: sites[id].enabled === true,
      ...resultSnapshot(sites[id])
    };
  }
  return scoped;
}

function readIncognitoFromStored(stored, normal) {
  const raw = stored[INCOGNITO_SETTINGS_KEY];
  const legacy = stored[SITES_INCOGNITO_KEY];
  const hasRaw = Boolean(raw && (raw.signTime || raw.sites));
  const hasLegacy = Boolean(legacy);

  if (!hasRaw && !hasLegacy) {
    const sites = {};
    for (const id of SITE_ORDER) {
      sites[id] = {
        ...emptySiteState(),
        enabled: normal.sites[id].enabled === true
      };
    }
    return { signTime: normal.signTime, sites };
  }

  const sites = mergeSites({ sites: (hasRaw ? raw.sites : legacy) || {} });
  if (!hasRaw && hasLegacy) {
    for (const id of SITE_ORDER) {
      sites[id].enabled = normal.sites[id].enabled === true;
    }
  }
  if (hasRaw && legacy) {
    for (const id of SITE_ORDER) {
      if (!Object.prototype.hasOwnProperty.call(raw.sites || {}, id) && legacy[id]?.lastResult) {
        Object.assign(sites[id], resultSnapshot(legacy[id]));
      }
    }
  }
  return {
    signTime: normalizeTime((hasRaw && raw.signTime) || normal.signTime),
    sites
  };
}

async function getSettings({ incognito = false } = {}) {
  const stored = await chrome.storage.local.get([
    ...Object.keys(DEFAULT_SETTINGS),
    "sites",
    SITES_INCOGNITO_KEY,
    INCOGNITO_SETTINGS_KEY
  ]);
  const normalSites = mergeSites(stored);
  const normal = {
    ...DEFAULT_SETTINGS,
    ...stored,
    signTime: normalizeTime(stored.signTime),
    sites: normalSites,
    enabled: SITE_ORDER.some((id) => normalSites[id].enabled)
  };
  if (!incognito) return normal;

  const incog = readIncognitoFromStored(stored, normal);
  return {
    ...DEFAULT_SETTINGS,
    signTime: incog.signTime,
    sites: incog.sites,
    enabled: SITE_ORDER.some((id) => incog.sites[id].enabled)
  };
}

function mergeSites(stored) {
  const sites = {};
  for (const id of SITE_ORDER) {
    const saved = stored?.sites?.[id];
    const defaults = emptySiteState(isDefaultEnabled(id));
    if (!saved || typeof saved !== "object") {
      sites[id] = defaults;
    } else {
      sites[id] = {
        ...defaults,
        ...saved,
        enabled: typeof saved.enabled === "boolean" ? saved.enabled : defaults.enabled
      };
    }
  }
  if (!stored?.sites && stored?.enabled === false) {
    for (const id of SITE_ORDER) sites[id].enabled = false;
  }
  if (!stored?.sites && stored?.lastResult) {
    sites.apktw.lastResult = stored.lastResult || "";
    sites.apktw.lastResultAt = stored.lastResultAt || "";
    sites.apktw.lastMessage = stored.lastMessage || "";
    sites.apktw.lastSignDate = stored.lastSignDate || "";
  }
  return sites;
}

function resetSignJudgment(site) {
  return {
    ...site,
    lastSignDate: "",
    lastResult: "",
    lastResultAt: "",
    lastMessage: ""
  };
}

async function saveSettings(payload, { incognito = false } = {}) {
  const signTime = normalizeTime(payload.signTime);
  const current = await getSettings({ incognito });
  const sites = mergeSites({ sites: current.sites });
  if (payload.sites) {
    for (const id of SITE_ORDER) {
      if (payload.sites[id] && typeof payload.sites[id].enabled === "boolean") {
        sites[id].enabled = payload.sites[id].enabled;
        if (!sites[id].enabled) sites[id] = resetSignJudgment(sites[id]);
      }
    }
  } else if (typeof payload.enabled === "boolean") {
    for (const id of SITE_ORDER) {
      sites[id].enabled = payload.enabled;
      if (!sites[id].enabled) sites[id] = resetSignJudgment(sites[id]);
    }
  }
  const enabled = SITE_ORDER.some((id) => sites[id].enabled);
  if (incognito) {
    await chrome.storage.local.set({
      [INCOGNITO_SETTINGS_KEY]: { signTime, sites: persistableSites(sites) }
    });
  } else {
    await chrome.storage.local.set({ signTime, enabled, sites });
  }
  await scheduleAlarm();
  if (!enabled) await clearRetry(incognito);
  await syncLoginBadge();
  return {
    ok: true,
    settings: await getSettings({ incognito }),
    nextAlarm: await getNextAlarmInfo({ incognito })
  };
}

function normalizeTime(value) {
  if (typeof value !== "string" || !value.trim()) return DEFAULT_TIME;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return DEFAULT_TIME;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return DEFAULT_TIME;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

async function scheduleProfileAlarm(incognito, { reschedule = false } = {}) {
  const name = incognito ? ALARM_INCOGNITO : ALARM_NAME;
  const settings = await getSettings({ incognito });
  if (!SITE_ORDER.some((id) => settings.sites[id].enabled)) {
    await chrome.alarms.clear(name);
    return null;
  }
  const existing = await chrome.alarms.get(name);
  if (existing && !reschedule) {
    const date = new Date(existing.scheduledTime);
    const [hour, minute] = settings.signTime.split(":").map(Number);
    if (date.getHours() === hour && date.getMinutes() === minute) {
      return existing.scheduledTime;
    }
  }
  const when = getNextAlarmTimestamp(settings.signTime);
  await chrome.alarms.create(name, { when });
  return when;
}

async function scheduleAlarm() {
  await scheduleProfileAlarm(false);
  await scheduleProfileAlarm(true);
  await scheduleCatchUpAlarms();
}

function getNextAlarmTimestamp(signTime) {
  const [hour, minute] = normalizeTime(signTime).split(":").map(Number);
  const now = new Date();
  const next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hour,
    minute,
    0,
    0
  );
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

async function getNextAlarmInfo({ incognito = false } = {}) {
  const daily = await chrome.alarms.get(incognito ? ALARM_INCOGNITO : ALARM_NAME);
  const retry = await chrome.alarms.get(retryAlarmName(incognito));
  const times = [daily?.scheduledTime, retry?.scheduledTime].filter(Boolean);
  if (!times.length) return null;
  return Math.min(...times);
}

function todayKey(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function retryAlarmName(incognito) {
  return incognito ? RETRY_ALARM_INCOGNITO : RETRY_ALARM;
}

function retryCountKey(incognito) {
  return incognito ? RETRY_COUNT_INCOGNITO_KEY : RETRY_COUNT_KEY;
}

function isRetryableStatus(status) {
  return status === "timeout" || status === "error";
}

function isRetryableSite(site) {
  if (!site?.enabled) return false;
  if (site.lastSignDate === todayKey()) return false;
  return isRetryableStatus(site.lastResult);
}

function isLoginFailure(message) {
  return /尚未登入|未登入|没有登录|尚未登录|not logged|not signed in|please log in|ログインしていません|未ログイン/i.test(
    String(message || "")
  );
}

async function clearRetry(incognito) {
  await chrome.storage.local.set({ [retryCountKey(incognito)]: 0 });
  await chrome.alarms.clear(retryAlarmName(incognito));
}

async function writeRetryMessage(incognito, message) {
  const settings = await getSettings({ incognito });
  const sites = mergeSites({ sites: settings.sites });
  const now = new Date().toISOString();
  const ids = SITE_ORDER.filter((id) => isRetryableSite(sites[id]));
  if (!ids.length) return;
  for (const id of ids) {
    const site = sites[id];
    sites[id] = {
      ...site,
      lastResult: site.lastResult === "timeout" ? "timeout" : "error",
      lastResultAt: now,
      lastMessage: message
    };
  }
  if (incognito) {
    await chrome.storage.local.set({
      [INCOGNITO_SETTINGS_KEY]: {
        signTime: settings.signTime,
        sites: persistableSites(sites)
      }
    });
    return;
  }
  await chrome.storage.local.set({ sites: persistableSites(sites) });
}

async function hasRetryableSite(incognito) {
  const settings = await getSettings({ incognito });
  return SITE_ORDER.some((id) => isRetryableSite(settings.sites[id]));
}

async function scheduleRetry(errorMessage, incognito) {
  if (!(await hasRetryableSite(incognito))) {
    await clearRetry(incognito);
    return;
  }
  const key = retryCountKey(incognito);
  const stored = await chrome.storage.local.get(key);
  const count = Number(stored[key] || 0);
  if (count >= MAX_RETRIES) {
    await clearRetry(incognito);
    await writeRetryMessage(incognito, t("retryGaveUp", [errorMessage]));
    return;
  }
  const next = count + 1;
  await chrome.storage.local.set({ [key]: next });
  await chrome.alarms.create(retryAlarmName(incognito), { when: Date.now() + RETRY_MS });
  await writeRetryMessage(
    incognito,
    t("retryScheduled", [errorMessage, String(next), String(MAX_RETRIES)])
  );
}

async function maybeRetryAfterRun(state) {
  const incognito = Boolean(state.incognito);
  const retryable = (state.results || []).filter((item) => isRetryableStatus(item.status));
  if (retryable.length && (await hasRetryableSite(incognito))) {
    const message =
      retryable.map((item) => item.message).filter(Boolean).join("；") || t("msgFailed");
    await scheduleRetry(message, incognito);
    return;
  }
  await clearRetry(incognito);
}

async function maybeCatchUpProfile(incognito, { waitForWindow = false } = {}) {
  const retryAlarm = await chrome.alarms.get(retryAlarmName(incognito));
  if (retryAlarm) return;
  const settings = await getSettings({ incognito });
  const due = SITE_ORDER.filter((id) => isCatchUpDueSite(settings.sites[id]));
  if (!due.length) return;

  const [hour, minute] = settings.signTime.split(":").map(Number);
  const now = new Date();
  const scheduled = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hour,
    minute,
    0,
    0
  );
  if (now.getTime() < scheduled.getTime()) return;

  let windowId = await getProfileWindowId(incognito);
  if (!windowId && waitForWindow && !incognito) {
    windowId = await waitForProfileWindow(false, CATCHUP_WINDOW_WAIT_MS);
  }
  if (!windowId) {
    if (!incognito) await scheduleCatchUpRetry();
    return;
  }

  await startSignIn({ reason: "catch-up", incognito, windowId });
}

async function maybeCatchUp({ waitForWindow = false } = {}) {
  await maybeCatchUpProfile(false, { waitForWindow });
  await maybeCatchUpProfile(true, { waitForWindow: false });
}

function isCatchUpDueSite(site) {
  if (!site?.enabled) return false;
  if (site.lastSignDate === todayKey()) return false;
  if (site.lastResult === "login" || site.lastResult === "captcha") {
    const resultDate = new Date(site.lastResultAt);
    if (todayKey(resultDate) === todayKey()) return false;
  }
  return true;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProfileWindow(incognito, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const windowId = await getProfileWindowId(incognito);
    if (windowId) return windowId;
    await delay(1000);
  }
  return null;
}

async function scheduleCatchUpAlarms() {
  await chrome.alarms.create(CATCHUP_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: CATCHUP_PERIOD_MIN
  });
}

async function requestStartupCatchUp() {
  await chrome.alarms.create(CATCHUP_START_ALARM, {
    when: Date.now() + CATCHUP_START_DELAY_MS
  });
}

async function scheduleCatchUpRetry() {
  const existing = await chrome.alarms.get(CATCHUP_RETRY_ALARM);
  if (existing) return;
  await chrome.alarms.create(CATCHUP_RETRY_ALARM, {
    when: Date.now() + CATCHUP_RETRY_MS
  });
}

async function getSignState(incognito = false) {
  const key = incognito ? "signStateIncognito" : "signState";
  const stored = await chrome.storage.session.get(key);
  const state = stored[key];
  return state && Boolean(state.incognito) === incognito
    ? state
    : { active: false, signTabId: null, clicked: false, ready: false, incognito };
}

async function setSignState(signState) {
  const key = signState.incognito ? "signStateIncognito" : "signState";
  await chrome.storage.session.set({ [key]: signState });
}

async function getSignStateForTab(tabId) {
  const states = await Promise.all([getSignState(false), getSignState(true)]);
  return states.find((state) => tabId != null && state.signTabId === tabId)
    || { active: false, signTabId: null };
}

async function isSignTab(tabId, site) {
  if (!tabId) return false;
  const state = await getSignStateForTab(tabId);
  if (!state.active || state.finishing || state.signTabId !== tabId) return false;
  if (site && state.siteId && site !== state.siteId) return false;
  return true;
}

async function isTabMarkedReady(tabId) {
  if (!tabId) return false;
  const state = await getSignStateForTab(tabId);
  return Boolean(state.active && state.signTabId === tabId && state.ready);
}

async function waitForTabComplete(tabId, hostRe) {
  const matchHost = (url) => hostRe.test(url || "");
  const markReady = async () => {
    const state = await getSignStateForTab(tabId);
    if (state.signTabId !== tabId || !state.active) return;
    await setSignState({ ...state, ready: true });
  };

  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && matchHost(tab.url || "")) {
      await markReady();
      return true;
    }
  } catch (_) {
    return false;
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = async (ok) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      if (ok) await markReady();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 30000);
    const onUpdated = (id, info, tab) => {
      if (id !== tabId) return;
      if (info.status === "complete" && matchHost(tab.url || "")) {
        finish(true);
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function claimClick(tabId) {
  const state = await getSignStateForTab(tabId);
  if (!state.active || state.signTabId !== tabId || state.clicked) {
    return { ok: true, claimed: false };
  }
  await setSignState({ ...state, clicked: true });
  return { ok: true, claimed: true };
}

async function clickSignButton(tabId) {
  if (!tabId) return { ok: false };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const el =
          document.getElementById("my_amupper") ||
          document.querySelector('#um a[onclick*="dsu_amupper:pper"]') ||
          document.querySelector('#um img[src*="dk.gif"]')?.closest("a");
        if (!el) return { ok: false, reason: "missing" };
        const onclick = el.getAttribute("onclick") || "";
        const parsed = onclick.match(
          /ajaxget\s*\(\s*(['"])(.*?)\1\s*,\s*(['"])(.*?)\3\s*,\s*(['"])(.*?)\5\s*,\s*(['"])(.*?)\7/i
        );
        if (parsed && typeof window.ajaxget === "function") {
          window.ajaxget(parsed[2], parsed[4], parsed[6], parsed[8], "", () => {
            if (typeof window.toneplayer === "function") window.toneplayer(0);
          });
          return { ok: true, via: "ajaxget" };
        }
        if (typeof el.onclick === "function") {
          el.onclick();
          return { ok: true, via: "onclick" };
        }
        return { ok: false, reason: "no-ajaxget" };
      }
    });
    return results?.[0]?.result || { ok: false };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function claimApk502Retry(tabId) {
  const state = await getSignStateForTab(tabId);
  if (!tabId || !state.active || state.finishing || state.siteId !== "apktw" || state.signTabId !== tabId) {
    return { retry: false, inactive: true };
  }
  const count = Number(state.apk502Retries || 0);
  if (count >= 3) return { retry: false };
  await setSignState({ ...state, apk502Retries: count + 1 });
  await chrome.alarms.create(timeoutAlarmName(state.incognito), {
    when: Date.now() + SIGN_TIMEOUT_MS
  });
  return { retry: true, attempt: count + 1 };
}

async function inspectBaha(tabId) {
  if (!tabId) return { status: "pending" };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async () => {
        if (/user\.gamer\.com\.tw\/login\.php/i.test(location.href)) return { status: "login" };
        if (!document.cookie.includes("BAHAID=")) return { status: "login" };
        if (typeof window.Signin?.checkSigninStatus !== "function") return { status: "pending" };
        try {
          const info = await window.Signin.checkSigninStatus();
          if (info?.data?.signin === 1) return { status: "already" };
          return { status: "need" };
        } catch (_) {
          return { status: "pending" };
        }
      }
    });
    return results?.[0]?.result || { status: "pending" };
  } catch (_) {
    return { status: "pending" };
  }
}

async function clickBaha(tabId) {
  if (!tabId) return { ok: false };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        if (typeof window.Signin?.mobile === "function") {
          window.Signin.mobile();
          return { ok: true, via: "mobile" };
        }
        if (typeof window.Signin?.signinWork === "function") {
          window.Signin.signinWork();
          return { ok: true, via: "signinWork" };
        }
        const btn = document.querySelector(
          "#signin-btn, .topbar_signin, a[data-gtm*='signin'], button[onclick*='Signin']"
        );
        if (btn) {
          btn.click();
          return { ok: true, via: "click" };
        }
        return { ok: false, reason: "no-signin" };
      }
    });
    return results?.[0]?.result || { ok: false };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function klpbbsSignAction(click = false) {
  const logout = document.querySelector("a[href*='member.php'][href*='action=logout'], a.logout[href*='action=logout']");
  if (!logout) {
    const login = document.querySelector("a[href*='action=login'], form[action*='action=login']");
    return { status: login ? "login" : "pending", ok: false };
  }

  const card = document.getElementById("klp-signcard");
  let button;
  if (card) {
    if (card.classList.contains("done") || /今日已[签簽]到/.test(card.textContent || "")) {
      return { status: "already", ok: false };
    }
    button = card.querySelector("[data-klp-sign]");
    if (!button || button.classList.contains("dis") || !button._klp) {
      return { status: "pending", ok: false };
    }
  } else {
    button = document.getElementById("JD_sign");
    if (!button) return { status: "pending", ok: false };
    const text = (button.textContent || "").replace(/\s+/g, "");
    if (button.classList.contains("visted") || /已[签簽]到/.test(text)) {
      return { status: "already", ok: false };
    }
  }
  if (click) button.click();
  return { status: "need", ok: true };
}

async function inspectKlpbbs(tabId) {
  if (!tabId) return { status: "pending" };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: klpbbsSignAction
    });
    return results?.[0]?.result || { status: "pending" };
  } catch (_) {
    return { status: "pending" };
  }
}

async function clickKlpbbs(tabId) {
  if (!tabId) return { ok: false };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: klpbbsSignAction,
      args: [true]
    });
    return results?.[0]?.result || { ok: false };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}


async function hookEyny(tabId) {
  if (!tabId) return { ok: false };
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        if (window.__bmEynyHooked) return;
        window.__bmEynyHooked = true;
        window.__bmEynyNotice = window.__bmEynyNotice || "";
        const note = (msg) => {
          const text = String(msg || "").replace(/\s+/g, " ").trim();
          if (
            text &&
            text.length <= 240 &&
            /已簽到|已签到|簽到成功|签到成功|今日已簽|今天已簽|積分\s*\+|积分\s*\+/.test(text)
          ) {
            window.__bmEynyNotice = text;
          }
        };
        const wrapFn = (fn) => {
          if (typeof fn !== "function" || fn.__bmHooked) return fn;
          const wrapped = function () {
            for (const arg of arguments) {
              if (typeof arg === "string") note(arg);
            }
            return fn.apply(this, arguments);
          };
          wrapped.__bmHooked = true;
          return wrapped;
        };
        const trap = (name) => {
          let current = wrapFn(window[name]);
          try {
            Object.defineProperty(window, name, {
              configurable: true,
              get() {
                return current;
              },
              set(fn) {
                current = wrapFn(fn);
              }
            });
          } catch (_) {
            if (current) window[name] = current;
          }
        };
        trap("showDialog");
        trap("showPrompt");
      }
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function inspectEyny(tabId) {
  if (!tabId) return { status: "pending" };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const textOf = (el) => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
        const pageText = textOf(document.body);
        if (
          /瀏覽器安全檢查|verify your browser/i.test(pageText) &&
          !document.querySelector("#toptb, #nv, #um, #ct")
        ) {
          return { status: "pending", reason: "security" };
        }
        if (!document.querySelector("#toptb, #nv, #um, #ct, .bm, #wp")) {
          return { status: "pending", reason: "loading" };
        }
        const logout = document.querySelector("#toptb a[href*='action=logout'], #um a[href*='action=logout']");
        const account = document.querySelector(
          "#toptb .vwmy a[href*='space-uid-'], #toptb .vwmy a[href*='mod=space'][href*='uid='], #um .vwmy a[href*='space-uid-'], #um .vwmy a[href*='mod=space'][href*='uid=']"
        );
        if (!logout || !textOf(account)) {
          if (logout || account) return { status: "pending", reason: "auth" };
          if (
            /member\.php\?[^#]*action=login/i.test(location.href) ||
            /您需要先登錄|您需要先登入|您尚未登錄|您尚未登入|需要登錄後才能|需要登入後才能|請先登錄|請先登入|抱歉，您需要登錄/.test(
              pageText
            ) ||
            document.querySelector("#toptb a[href*='action=login'], #um a[href*='action=login']")
          ) {
            return { status: "login" };
          }
          return { status: "pending", reason: "auth" };
        }
        const noticeRe =
          /已簽到|已签到|簽到成功|签到成功|今日已簽|今天已簽|今日已領|積分\s*\+|积分\s*\+|獲得\s*\d+\s*積分|获得\s*\d+\s*积分/;
        const nodes = document.querySelectorAll(
          "#ntcwin, #messagetext, #creditnotice, .alert_right, .alert_info, [id^='fwin_'], #append_parent > div"
        );
        let notice = String(window.__bmEynyNotice || "");
        for (const node of nodes) {
          const text = textOf(node);
          if (text && text.length <= 240 && noticeRe.test(text)) {
            notice = text;
            break;
          }
        }
        if (notice && noticeRe.test(notice)) {
          return { status: "already", notice };
        }
        return { status: "ready" };
      }
    });
    return results?.[0]?.result || { status: "pending" };
  } catch (_) {
    return { status: "pending" };
  }
}

async function drawKlpbbsThread(tabId) {
  if (!tabId) return { ok: false };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const button = document.querySelector("a.sd_post[href*='freeaddon_randomthread']");
        if (!button) return { ok: false, reason: "missing" };
        button.click();
        return { ok: true };
      }
    });
    return results?.[0]?.result || { ok: false };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function waitForKlpbbsDraw(tabId) {
  const deadline = Date.now() + KLPBBS_DRAW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const url = tab.url || "";
      if (/^https:\/\/(?:www\.)?klpbbs\.com\/(?:thread-\d+-|forum\.php\?[^#]*mod=viewthread)/i.test(url)) {
        return { ok: true, url };
      }
    } catch (_) {
      return { ok: false, reason: "tab-closed" };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { ok: false, reason: "timeout" };
}

function littleSkinSignAction(click = false) {
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) > 0 &&
      el.getClientRects().length > 0
    );
  };
  const geetestState = () => {
    const panel = document.querySelector(".geetest_panel");
    if (!visible(panel)) return "none";
    const loading = panel.querySelector(".geetest_panel_loading");
    const success = panel.querySelector(".geetest_panel_success");
    const box = panel.querySelector(".geetest_panel_box");
    const text = panel.textContent || "";
    if (visible(success) || /通过验证|通過驗證/.test(text)) return "passed";
    if (visible(loading) || /智能验证|智能驗證|检测中|檢測中/.test(text)) return "checking";
    if (
      (box && /geetest_panelshowslide|geetest_panelshowclick/.test(box.className)) ||
      panel.querySelector(
        ".geetest_slider, .geetest_canvas_img, .geetest_item_wrap, .geetest_puzzle, .geetest_window"
      )
    ) {
      return "need";
    }
    return "checking";
  };
  if (!window.blessing?.user?.uid || !document.getElementById("logout-button")) {
    const login = /\/auth\/login(?:[/?#]|$)/.test(location.href) ||
      document.querySelector('a[href$="/auth/login"], form[action*="/auth/login"]');
    return { status: login ? "login" : "pending" };
  }
  if (geetestState() === "need") return { status: "captcha" };
  const button = document.querySelector("#usage-box .card-footer button");
  if (!button) return { status: "pending" };
  const text = (button.textContent || "").replace(/\s+/g, "");
  if (button.querySelector(".fa-spinner.fa-spin")) return { status: "pending" };
  if (button.disabled && /在\d+(?:時|小時|小时|分鐘|分钟|分|秒)[后後]可用|availablein/i.test(text)) {
    return { status: "already" };
  }
  if (/^(?:簽到|签到|signin)$/i.test(text) && !button.disabled) {
    if (click) button.click();
    return { status: "need", ok: true };
  }
  return { status: "pending" };
}

async function inspectLittleSkin(tabId) {
  if (!tabId) return { status: "pending" };
  try {
    await dismissLittleSkinDonation(tabId);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: littleSkinSignAction
    });
    return results?.[0]?.result || { status: "pending" };
  } catch (_) {
    return { status: "pending" };
  }
}

async function dismissLittleSkinDonation(tabId) {
  if (!tabId) return { ok: false };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const buttons = [...document.querySelectorAll("button, [role='button']")];
        const visible = (element) => {
          const style = getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length;
        };
        const find = (pattern) =>
          buttons.find((button) => pattern.test((button.textContent || "").replace(/\s+/g, "")) && visible(button));
        const button = find(/不再(?:顯示|显示)/) || find(/下次一定/);
        if (!button) return { ok: false, dismissed: false };
        button.click();
        return { ok: true, dismissed: true };
      }
    });
    return results?.[0]?.result || { ok: false };
  } catch (_) {
    return { ok: false };
  }
}

async function clickLittleSkin(tabId) {
  if (!tabId) return { ok: false };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: littleSkinSignAction,
      args: [true]
    });
    return results?.[0]?.result || { ok: false };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function genshinApi(tabId, { action, lang = "zh-tw", actId }) {
  if (!tabId) return { ok: false };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async (nextAction, nextLang, nextActId) => {
        const infoUrl = `https://sg-hk4e-api.hoyolab.com/event/sol/info?lang=${nextLang}&act_id=${nextActId}`;
        if (nextAction === "info") {
          const res = await fetch(infoUrl, { credentials: "include" });
          return res.json();
        }
        const res = await fetch("https://sg-hk4e-api.hoyolab.com/event/sol/sign", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ act_id: nextActId, lang: nextLang })
        });
        return res.json();
      },
      args: [action, lang, actId]
    });
    return { ok: true, data: results?.[0]?.result || null };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function focusExistingSignTab(incognito) {
  const state = await getSignState(incognito);
  if (state.signTabId) {
    await focusTab(state.signTabId);
    return true;
  }
  return false;
}

async function getProfileWindowId(incognito) {
  try {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const match = windows.filter((item) => Boolean(item.incognito) === Boolean(incognito));
    return (match.find((item) => item.focused) || match[0])?.id || null;
  } catch (_) {
    return null;
  }
}

async function finishSigningLock(incognito) {
  signingLocks.delete(incognito);
}

async function startSignIn({
  reason = "manual",
  force = false,
  incognito = false,
  windowId = null
} = {}) {
  incognito = Boolean(incognito);
  if (signingLocks.has(incognito)) {
    await focusExistingSignTab(incognito);
    return true;
  }
  signingLocks.add(incognito);

  try {
    const running = await getSignState(incognito);
    if (running.active && running.signTabId && await tabExists(running.signTabId)) {
      return true;
    }
    const settings = await getSettings({ incognito });
    let queue = SITE_ORDER.filter((id) => settings.sites[id].enabled);
    if (reason === "retry") {
      queue = queue.filter((id) => isRetryableSite(settings.sites[id]));
    } else if (reason === "catch-up" && !force) {
      queue = queue.filter((id) => isCatchUpDueSite(settings.sites[id]));
    } else if (!force && reason !== "manual") {
      queue = queue.filter((id) => settings.sites[id].lastSignDate !== todayKey());
    }
    if (!queue.length) {
      if (reason === "retry") await clearRetry(incognito);
      await finishSigningLock(incognito);
      return false;
    }

    if (!windowId) {
      windowId = await getProfileWindowId(incognito);
      if (!windowId && reason !== "manual") {
        if (reason === "retry") {
          await chrome.alarms.create(retryAlarmName(incognito), {
            when: Date.now() + RETRY_MS
          });
        }
        await finishSigningLock(incognito);
        return false;
      }
    }

    const existing = await getSignState(incognito);
    const leftoverId = existing.signTabId;
    if (leftoverId) {
      await setSignState({
        ...existing,
        active: false,
        signTabId: null,
        clicked: false,
        ready: false
      });
      if (await tabExists(leftoverId)) {
        try {
          await chrome.tabs.remove(leftoverId);
        } catch (_) {
        }
      }
    }

    if (!incognito) {
      await setActionTooltip(null);
    }
    await setSignState({
      active: false,
      signTabId: null,
      clicked: false,
      ready: false,
      queue,
      results: [],
      reason,
      incognito,
      windowId
    });
    await openNextSite(incognito);
    return true;
  } catch (error) {
    const message = t("msgOpenTabFailed", [String(error.message || error)]);
    await setSignState({
      active: false,
      signTabId: null,
      clicked: false,
      queue: [],
      incognito,
      windowId
    });
    await recordSiteResult(null, "error", message, false, incognito);
    if (isLoginFailure(error.message || error)) {
      await clearRetry(incognito);
    } else {
      await scheduleRetry(message, incognito);
    }
    if (!incognito) {
      await setActionTooltip("resultError", t("notifyOpenTabFailed"));
    }
    await syncLoginBadge();
    await notify("resultError", "notifyOpenTabFailed", "", { sticky: true });
    await finishSigningLock(incognito);
    if (reason === "manual") throw error;
    return false;
  }
}

async function openNextSite(incognito = false) {
  const state = await getSignState(incognito);
  const siteId = state.queue?.[0];
  if (!siteId) {
    await applyQueueBadge(state.results || [], state.incognito);
    await setSignState({
      ...state,
      active: false,
      signTabId: null,
      clicked: true,
      queue: [],
      results: state.results || []
    });
    await maybeRetryAfterRun(state);
    await finishSigningLock(incognito);
    return;
  }

  const site = SITES[siteId];
  const remaining = state.queue.slice(1);
  let tab;
  try {
    const createOptions = {
      url: site.url,
      active: true
    };
    if (state.windowId) createOptions.windowId = state.windowId;
    tab = await chrome.tabs.create(createOptions);
  } catch (error) {
    const message = t("msgOpenTabFailed", [String(error.message || error)]);
    await recordSiteResult(siteId, "error", message, false, incognito);
    const results = [...(state.results || []), { siteId, status: "error", message }];
    await setSignState({
      ...state,
      active: false,
      signTabId: null,
      clicked: true,
      queue: [],
      results
    });
    await applyQueueBadge(results, state.incognito);
    await scheduleRetry(message, Boolean(state.incognito));
    await finishSigningLock(incognito);
    return;
  }
  await setSignState({
    ...state,
    active: true,
    signTabId: tab.id,
    apk502Retries: 0,
    clicked: false,
    ready: false,
    finishing: false,
    siteId,
    queue: remaining,
    results: state.results || []
  });
  await chrome.alarms.clear(timeoutAlarmName(incognito));
  await chrome.alarms.create(timeoutAlarmName(incognito), {
    when: Date.now() + SIGN_TIMEOUT_MS
  });
  await waitForTabComplete(tab.id, site.hostRe);
}

async function timeoutSignIn(incognito = false) {
  const state = await getSignState(incognito);
  if (!state.active) return;
  const detected = await detectTabSignStatus(state.signTabId);
  const status =
    detected === "already" ||
    detected === "success" ||
    detected === "login" ||
    detected === "captcha"
      ? detected
      : "timeout";
  const message =
    status === "already"
      ? t("msgSuccess")
      : status === "login"
        ? loginMessage(state.siteId)
        : status === "success"
          ? t("msgSuccess")
          : t("msgTimeoutKept");
  await onSignResult({ status, message, site: state.siteId }, state.signTabId);
}

function loginMessage(siteId) {
  if (siteId === "baha") return t("msgNeedLoginBaha");
  if (siteId === "genshin") return t("msgNeedLoginGenshin");
  if (siteId === "klpbbs") return t("msgNeedLoginKlpbbs");
  if (siteId === "littleskin") return t("msgNeedLoginLittleSkin");
  if (siteId === "eyny") return t("msgNeedLoginEyny");
  return t("msgNeedLogin");
}

function isLoginUrl(url, siteId) {
  if (!url) return false;
  if ((!siteId || siteId === "baha") && /user\.gamer\.com\.tw\/login\.php/i.test(url)) {
    return true;
  }
  if ((!siteId || siteId === "apktw") && /apk\.tw/i.test(url) && /action=login/i.test(url)) {
    return true;
  }
  if ((!siteId || siteId === "eyny") && /eyny\.com/i.test(url) && /action=login/i.test(url)) {
    return true;
  }
  if ((!siteId || siteId === "klpbbs") && /klpbbs\.com/i.test(url) && /member\.php\?[^#]*mod=logging[^#]*action=login/i.test(url)) {
    return true;
  }
  if ((!siteId || siteId === "littleskin") && /littleskin\.cn/i.test(url) && /\/auth\/login/i.test(url)) {
    return true;
  }
  if (!siteId || siteId === "genshin") {
    if (/account\.hoyoverse\.com/i.test(url)) return true;
    if (/hoyolab\.com\/login/i.test(url)) return true;
    if (/hoyolab\.com\/account/i.test(url)) return true;
  }
  return false;
}

async function detectTabSignStatus(tabId) {
  if (!tabId) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    const state = await getSignStateForTab(tabId);
    if (isLoginUrl(tab.url || "", state.siteId)) return "login";
  } catch (_) {
  }
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: "flushStatus" });
    if (reply?.status === "already" || reply?.status === "success" || reply?.status === "login") {
      return reply.status;
    }
  } catch (_) {
  }
  const state = await getSignStateForTab(tabId);
  if (state.siteId === "baha") {
    const info = await inspectBaha(tabId);
    if (info.status === "already" || info.status === "login") return info.status;
    return null;
  }
  if (state.siteId === "genshin") {
    const info = await genshinApi(tabId, {
      action: "info",
      lang: "zh-tw",
      actId: "e202102251931481"
    });
    const data = info?.data;
    if (data?.retcode === -100 || data?.retcode === 10001) return "login";
    if (data?.data?.is_sign || data?.data?.signed) return "already";
    return null;
  }
  if (state.siteId === "klpbbs") {
    const info = await inspectKlpbbs(tabId);
    if (info.status === "already" || info.status === "login") return info.status;
    return null;
  }
  if (state.siteId === "eyny") {
    const info = await inspectEyny(tabId);
    if (info.status === "already" || info.status === "ready") return "already";
    if (info.status === "login") return "login";
    return null;
  }
  if (state.siteId === "littleskin") {
    const info = await inspectLittleSkin(tabId);
    if (info.status === "already" || info.status === "login" || info.status === "captcha") {
      return info.status;
    }
    return null;
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (document.getElementById("ppered")) return "already";
        const menu = document.getElementById("ppered_menu");
        if (menu && /累計簽到|您上次簽到時間/.test(menu.innerText || "")) return "already";
        const btn = document.getElementById("my_amupper");
        const img = btn?.querySelector?.("img");
        const src = img?.getAttribute("src") || "";
        if (/wb\.gif/i.test(src)) return "already";
        const loggedOut = document.querySelector("a.logb[href*='action=login'], .topMenu a[href*='action=login']");
        const loggedIn = document.querySelector("#um a[href*='action=logout'], a[href*='member.php'][href*='action=logout']");
        if (loggedOut && !loggedIn && !document.getElementById("um")) return "login";
        return null;
      }
    });
    return results?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

async function onSignResult(payload, tabId) {
  let status = payload.status || "unknown";
  let message = payload.message || "";
  if (status === "already") {
    status = "success";
    message = t("msgSuccess");
  }
  const state = await getSignStateForTab(tabId);
  if (!state.signTabId || state.finishing) return;
  if (tabId && state.signTabId && tabId !== state.signTabId) return;
  const siteId = payload.site || state.siteId || "apktw";
  const isManagedTab = tabId ? tabId === state.signTabId : Boolean(state.active);
  if (!state.active && status !== "success") return;
  await setSignState({ ...state, finishing: true });

  if (status === "success" && siteId === "klpbbs" && payload.drawKlpbbs) {
    try {
      const drawn = await drawKlpbbsThread(tabId || state.signTabId);
      if (drawn.ok) await waitForKlpbbsDraw(tabId || state.signTabId);
    } catch (_) {
    }
  }

  const siteLabel = t(SITES[siteId]?.nameKey || "siteApkTw");
  const markToday = status === "success";
  await recordSiteResult(siteId, status, message, markToday, Boolean(state.incognito));
  await syncLoginBadge();

  if (status === "success") {
    await notify("resultSuccess", "notifySuccessBody", `${siteLabel}｜${message}`);
    if (isManagedTab) await closeManagedTabs(state.signTabId);
  } else if (status === "captcha") {
    await notify("resultCaptcha", "notifyCaptchaBody", `${siteLabel}｜${message || t("msgCaptchaKept")}`, { sticky: true });
    await focusTab(tabId);
    await detachCurrentTab(state);
  } else if (status === "login") {
    await showLoginHudOnTab(tabId);
    await detachCurrentTab(state);
  } else if (status === "timeout") {
    await notify("resultTimeout", "notifyTimeoutBody", `${siteLabel}｜${message || t("msgTimeoutKept")}`, { sticky: true });
    await detachCurrentTab(state);
  } else {
    await notify("resultError", "notifyErrorBody", `${siteLabel}｜${message || t("msgFailed")}`, { sticky: true });
    if (payload.closeTab && isManagedTab) {
      await closeManagedTabs(state.signTabId);
    } else {
      await detachCurrentTab(state);
    }
  }

  await chrome.alarms.clear(timeoutAlarmName(state.incognito));
  const latest = await getSignState(Boolean(state.incognito));
  const results = [...(latest.results || []), { siteId, status, message, tabId: tabId || null }];
  await setSignState({ ...latest, results, active: false, clicked: true });
  signingLocks.add(Boolean(state.incognito));
  await openNextSite(Boolean(state.incognito));
}

async function showLoginHudOnTab(tabId) {
  if (!tabId) return;
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["overlay.css"]
    });
  } catch (_) {
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["overlay.js"]
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        globalThis.bmShowLoginHud?.();
      }
    });
  } catch (_) {
  }
}

async function detachCurrentTab(state) {
  await setSignState({
    ...state,
    active: false,
    signTabId: null,
    clicked: true
  });
}

async function closeManagedTabs(tabId) {
  const state = await getSignStateForTab(tabId);
  await setSignState({ ...state, active: false, signTabId: null, clicked: true });
  if (!tabId) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch (_) {
  }
}

async function focusTab(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch (_) {
  }
}

async function tabExists(tabId) {
  if (!tabId) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch (_) {
    return false;
  }
}

async function recordSiteResult(siteId, status, message, markToday, incognito = false) {
  const patch = {
    lastResult: status,
    lastResultAt: new Date().toISOString(),
    lastMessage: message
  };
  if (markToday) patch.lastSignDate = todayKey();
  if (incognito) {
    if (!siteId) return;
    const settings = await getSettings({ incognito: true });
    const sites = mergeSites({ sites: settings.sites });
    sites[siteId] = { ...sites[siteId], ...patch };
    await chrome.storage.local.set({
      [INCOGNITO_SETTINGS_KEY]: {
        signTime: settings.signTime,
        sites: persistableSites(sites)
      }
    });
    return;
  }
  if (!siteId) {
    await chrome.storage.local.set(patch);
    return;
  }
  const settings = await getSettings();
  const sites = mergeSites(settings);
  sites[siteId] = { ...sites[siteId], ...patch };
  await chrome.storage.local.set({ sites });
}

async function applyQueueBadge() {
  await syncLoginBadge();
}

function siteNeedsAttention(settings) {
  return SITE_ORDER.some(
    (id) =>
      settings.sites[id]?.enabled === true &&
      Boolean(settings.sites[id]?.lastResult) &&
      !["success", "already"].includes(settings.sites[id]?.lastResult)
  );
}

async function loginFailureFlags() {
  return {
    normal: siteNeedsAttention(await getSettings()),
    incognito: siteNeedsAttention(await getSettings({ incognito: true }))
  };
}

async function setTabLoginBadge(tabId, show) {
  try {
    if (show) {
      await chrome.action.setBadgeBackgroundColor({ color: "#dc2626", tabId });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ color: "#ffffff", tabId });
      }
      await chrome.action.setBadgeText({ text: "!", tabId });
      return;
    }
    await chrome.action.setBadgeText({ text: "", tabId });
  } catch (_) {
  }
}

let badgeUpdateQueue = Promise.resolve();

function enqueueBadgeUpdate(update) {
  const pending = badgeUpdateQueue.then(update);
  badgeUpdateQueue = pending.catch(() => {});
  return pending;
}

function applyLoginBadgeToTab(tab) {
  if (tab?.id == null) return Promise.resolve();
  return enqueueBadgeUpdate(async () => {
    const flags = await loginFailureFlags();
    await setTabLoginBadge(tab.id, tab.incognito ? flags.incognito : flags.normal);
  });
}

function syncLoginBadge() {
  return enqueueBadgeUpdate(refreshLoginBadges);
}

async function refreshLoginBadges() {
  const flags = await loginFailureFlags();
  try {
    await chrome.action.setBadgeText({ text: "" });
  } catch (_) {
  }
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (_) {
    return;
  }
  await Promise.all(
    tabs.map((tab) =>
      tab.id == null
        ? Promise.resolve()
        : setTabLoginBadge(tab.id, tab.incognito ? flags.incognito : flags.normal)
    )
  );
  await chrome.alarms.clear(CLEAR_BADGE_ALARM);
  await chrome.storage.local.set({
    badgeUntil: 0,
    badgeSticky: flags.normal || flags.incognito
  });
}

async function setActionTooltip(titleKey, message) {
  const base = `[B.M] ${t("extNameSuffix")}`;
  const text = titleKey ? `${base}｜${t(titleKey)}${message ? `\n${message}` : ""}` : base;
  try {
    await chrome.action.setTitle({ title: text });
  } catch (_) {
  }
}

async function notify(titleKey, bodyKey, fallbackMessage, { sticky = false } = {}) {
  try {
    await chrome.notifications.create(`apk-tw-signin-${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: `[B.M] ${t("extNameSuffix")}｜${t(titleKey)}`,
      message: fallbackMessage || t(bodyKey),
      priority: sticky ? 2 : 0,
      requireInteraction: sticky
    });
  } catch (error) {
    console.warn("[B.M] notification failed:", error);
  }
}
