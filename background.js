const ALARM_NAME = "apk-tw-daily-signin";
const ALARM_INCOGNITO = "apk-tw-daily-signin-incognito";
const TIMEOUT_ALARM = "apk-tw-signin-timeout";
const CLEAR_BADGE_ALARM = "apk-tw-clear-badge";
const SIGN_URL = "https://apk.tw/";
const DEFAULT_TIME = "00:01";
const SIGN_TIMEOUT_MS = 90000;
const SITE_ORDER = ["baha", "apktw", "genshin"];
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
  genshin: {
    url: "https://act.hoyolab.com/ys/event/signin-sea-v3/index.html?act_id=e202102251931481",
    hostRe: /hoyolab\.com|hoyoverse\.com/i,
    nameKey: "siteGenshin"
  }
};

function emptySiteState() {
  return {
    enabled: true,
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
    genshin: emptySiteState()
  }
};

let signingLock = false;
const pendingSignIns = [];

function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  await scheduleAlarm();
  await syncLoginBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarm();
  await syncLoginBadge();
  await maybeCatchUp();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await startSignIn({ reason: "alarm", incognito: false });
    await scheduleAlarm();
    return;
  }
  if (alarm.name === ALARM_INCOGNITO) {
    await startSignIn({ reason: "alarm", incognito: true });
    await scheduleAlarm();
    return;
  }
  if (alarm.name === TIMEOUT_ALARM) {
    await timeoutSignIn();
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
  const state = await getSignState();
  if (state.signTabId !== tabId) return;
  await chrome.alarms.clear(TIMEOUT_ALARM);
  await setSignState({ ...state, signTabId: null, active: false, clicked: true });
  if ((state.queue && state.queue.length) || signingLock) {
    signingLock = true;
    await openNextSite();
    return;
  }
  await finishSigningLock();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  const state = await getSignState();
  if (!state.active || !state.signTabId) return;
  if (tab.id === state.signTabId) return;
  if (tab.openerTabId !== state.signTabId) return;
  try {
    await chrome.tabs.remove(tab.id);
  } catch (_) {
    /* ignore */
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  const url = info.url || (info.status === "complete" ? tab.url : "");
  if (!url) return;
  const state = await getSignState();
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
    case "clickSignButton":
      return clickSignButton(sender.tab?.id);
    case "bahaInspect":
      return inspectBaha(sender.tab?.id);
    case "bahaSign":
      return clickBaha(sender.tab?.id);
    case "genshinApi":
      return genshinApi(sender.tab?.id, message.payload || {});
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
  if (current.sites === undefined) {
    patch.sites = mergeSites(current);
  }
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
      enabled: sites[id].enabled !== false,
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
        enabled: normal.sites[id].enabled !== false
      };
    }
    return { signTime: normal.signTime, sites };
  }

  const sites = mergeSites({ sites: (hasRaw ? raw.sites : legacy) || {} });
  if (!hasRaw && hasLegacy) {
    for (const id of SITE_ORDER) {
      sites[id].enabled = normal.sites[id].enabled !== false;
    }
  }
  if (hasRaw && legacy) {
    for (const id of SITE_ORDER) {
      if (!sites[id].lastResult && legacy[id]?.lastResult) {
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
    sites[id] = { ...emptySiteState(), ...(stored?.sites?.[id] || {}) };
    sites[id].enabled = sites[id].enabled !== false;
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

async function scheduleProfileAlarm(incognito) {
  const name = incognito ? ALARM_INCOGNITO : ALARM_NAME;
  const settings = await getSettings({ incognito });
  await chrome.alarms.clear(name);
  if (!SITE_ORDER.some((id) => settings.sites[id].enabled)) return null;
  const when = getNextAlarmTimestamp(settings.signTime);
  await chrome.alarms.create(name, { when });
  return when;
}

async function scheduleAlarm() {
  await scheduleProfileAlarm(false);
  await scheduleProfileAlarm(true);
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
  if (next.getTime() <= now.getTime() + 2000) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

async function getNextAlarmInfo({ incognito = false } = {}) {
  const alarm = await chrome.alarms.get(incognito ? ALARM_INCOGNITO : ALARM_NAME);
  return alarm?.scheduledTime || null;
}

function todayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function maybeCatchUpProfile(incognito) {
  const settings = await getSettings({ incognito });
  const due = SITE_ORDER.filter(
    (id) => settings.sites[id].enabled && settings.sites[id].lastSignDate !== todayKey()
  );
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
  if (now.getTime() >= scheduled.getTime()) {
    await startSignIn({ reason: "catch-up", incognito });
  }
}

async function maybeCatchUp() {
  await maybeCatchUpProfile(false);
  await maybeCatchUpProfile(true);
}

async function getSignState() {
  const { signState } = await chrome.storage.session.get("signState");
  return signState || { active: false, signTabId: null, clicked: false, ready: false };
}

async function setSignState(signState) {
  await chrome.storage.session.set({ signState });
}

async function isSignTab(tabId, site) {
  if (!tabId) return false;
  const state = await getSignState();
  if (!state.active || state.signTabId !== tabId) return false;
  if (site && state.siteId && site !== state.siteId) return false;
  return true;
}

async function isTabMarkedReady(tabId) {
  if (!tabId) return false;
  const state = await getSignState();
  return Boolean(state.active && state.signTabId === tabId && state.ready);
}

async function waitForTabComplete(tabId, hostRe) {
  const matchHost = (url) => hostRe.test(url || "");
  const markReady = async () => {
    const state = await getSignState();
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
  const state = await getSignState();
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

async function focusExistingSignTab() {
  const state = await getSignState();
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

async function finishSigningLock() {
  signingLock = false;
  const next = pendingSignIns.shift();
  if (next) await startSignIn(next);
}

async function startSignIn({
  reason = "manual",
  force = false,
  incognito = false,
  windowId = null
} = {}) {
  if (signingLock) {
    const state = await getSignState();
    if (Boolean(state.incognito) === Boolean(incognito)) {
      await focusExistingSignTab();
      return true;
    }
    if (!pendingSignIns.some((item) => Boolean(item.incognito) === Boolean(incognito))) {
      pendingSignIns.push({ reason, force, incognito, windowId });
    }
    return true;
  }
  signingLock = true;

  try {
    const settings = await getSettings({ incognito });
    let queue = SITE_ORDER.filter((id) => settings.sites[id].enabled);
    if (!force && reason !== "manual") {
      queue = queue.filter((id) => settings.sites[id].lastSignDate !== todayKey());
    }
    if (!queue.length) {
      await finishSigningLock();
      return false;
    }

    if (!windowId) {
      windowId = await getProfileWindowId(incognito);
      if (!windowId && reason !== "manual") {
        await finishSigningLock();
        return false;
      }
    }

    const existing = await getSignState();
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
          /* ignore */
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
    await openNextSite();
    return true;
  } catch (error) {
    await setSignState({
      active: false,
      signTabId: null,
      clicked: false,
      queue: [],
      incognito,
      windowId
    });
    await recordSiteResult(null, "error", t("msgOpenTabFailed", [String(error.message || error)]), false);
    if (!incognito) {
      await setActionTooltip("resultError", t("notifyOpenTabFailed"));
    }
    await syncLoginBadge();
    await notify("resultError", "notifyOpenTabFailed", "", { sticky: true });
    await finishSigningLock();
    throw error;
  }
}

async function openNextSite() {
  const state = await getSignState();
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
    await finishSigningLock();
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
    await recordSiteResult(siteId, "error", t("msgOpenTabFailed", [String(error.message || error)]), false);
    await setSignState({
      ...state,
      active: false,
      signTabId: null,
      clicked: true,
      queue: remaining,
      results: [...(state.results || []), { siteId, status: "error" }]
    });
    await openNextSite();
    return;
  }
  await setSignState({
    ...state,
    active: true,
    signTabId: tab.id,
    clicked: false,
    ready: false,
    finishing: false,
    siteId,
    queue: remaining,
    results: state.results || []
  });
  await chrome.alarms.clear(TIMEOUT_ALARM);
  await chrome.alarms.create(TIMEOUT_ALARM, {
    when: Date.now() + SIGN_TIMEOUT_MS
  });
  await waitForTabComplete(tab.id, site.hostRe);
}

async function timeoutSignIn() {
  const state = await getSignState();
  if (!state.active) return;
  const detected = await detectTabSignStatus(state.signTabId);
  const status = detected === "already" || detected === "success" || detected === "login" ? detected : "timeout";
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
    const state = await getSignState();
    if (isLoginUrl(tab.url || "", state.siteId)) return "login";
  } catch (_) {
    /* tab may already be gone */
  }
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: "flushStatus" });
    if (reply?.status === "already" || reply?.status === "success" || reply?.status === "login") {
      return reply.status;
    }
  } catch (_) {
    /* content script may not be listening */
  }
  const state = await getSignState();
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
  const state = await getSignState();
  if (state.finishing) return;
  if (tabId && state.signTabId && tabId !== state.signTabId) return;
  const siteId = payload.site || state.siteId || "apktw";
  const isManagedTab = tabId ? tabId === state.signTabId : Boolean(state.active);
  if (!state.active && status !== "success") return;
  await setSignState({ ...state, finishing: true });

  const siteLabel = t(SITES[siteId]?.nameKey || "siteApkTw");
  const markToday = status === "success";
  await recordSiteResult(siteId, status, message, markToday);
  await syncLoginBadge();

  if (status === "success") {
    await notify("resultSuccess", "notifySuccessBody", `${siteLabel}｜${message}`);
    if (isManagedTab) {
      await closeManagedTabs(state.signTabId);
    }
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
    await detachCurrentTab(state);
  }

  await chrome.alarms.clear(TIMEOUT_ALARM);
  const latest = await getSignState();
  const results = [...(latest.results || []), { siteId, status, message, tabId: tabId || null }];
  await setSignState({ ...latest, results, active: false, clicked: true });
  signingLock = true;
  await openNextSite();
}

async function showLoginHudOnTab(tabId) {
  if (!tabId) return;
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["overlay.css"]
    });
  } catch (_) {
    /* css may already be injected */
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
    /* tab may already be gone */
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
  const state = await getSignState();
  await setSignState({ ...state, active: false, signTabId: null, clicked: true });
  if (!tabId) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch (_) {
    /* already closed */
  }
}

async function focusTab(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch (_) {
    /* ignore */
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

async function recordSiteResult(siteId, status, message, markToday) {
  const patch = {
    lastResult: status,
    lastResultAt: new Date().toISOString(),
    lastMessage: message
  };
  if (markToday) patch.lastSignDate = todayKey();
  const { incognito } = await getSignState();
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

async function applyQueueBadge(results, _incognito = false) {
  const list = results || [];
  for (const item of list) {
    if (item.status === "login" && item.tabId) {
      await showLoginHudOnTab(item.tabId);
    }
  }
  await syncLoginBadge();
}

function siteHasLoginFailure(settings) {
  return SITE_ORDER.some(
    (id) => settings.sites[id]?.enabled !== false && settings.sites[id]?.lastResult === "login"
  );
}

async function loginFailureFlags() {
  return {
    normal: siteHasLoginFailure(await getSettings()),
    incognito: siteHasLoginFailure(await getSettings({ incognito: true }))
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
    /* tab may already be gone */
  }
}

async function applyLoginBadgeToTab(tab) {
  if (tab?.id == null) return;
  const flags = await loginFailureFlags();
  await setTabLoginBadge(tab.id, tab.incognito ? flags.incognito : flags.normal);
}

async function syncLoginBadge() {
  const flags = await loginFailureFlags();
  try {
    await chrome.action.setBadgeText({ text: "" });
  } catch (_) {
    /* ignore */
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
    /* ignore */
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
