const SITE_ORDER = ["baha", "apktw", "genshin"];
const signTimeEl = document.getElementById("signTime");
const nextAlarmEl = document.getElementById("nextAlarm");
const toastEl = document.getElementById("toast");
let toastTimer = null;
const EXT_NAME = `[B.M] ${t("extNameSuffix")}`;

const RESULT_KEYS = {
  success: "resultSuccess",
  already: "resultSuccess",
  captcha: "resultCaptcha",
  login: "resultLogin",
  timeout: "resultTimeout",
  error: "resultError"
};

document.documentElement.lang = chrome.i18n.getUILanguage() || "zh-TW";
applyI18n();
document.getElementById("extTitle").textContent = EXT_NAME;
document.getElementById("extName").textContent = EXT_NAME;
document.getElementById("save").addEventListener("click", () => saveSettings());
document.getElementById("signNow").addEventListener("click", signNow);
SITE_ORDER.forEach((id) => {
  document.getElementById(`enabled-${id}`).addEventListener("change", () => saveSettings({ silent: true }));
});
init();

function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
}

function isIncognitoPopup() {
  return Boolean(chrome.extension.inIncognitoContext);
}

async function popupContext() {
  const ctx = { incognito: isIncognitoPopup() };
  try {
    const win = await chrome.windows.getCurrent();
    ctx.incognito = Boolean(win.incognito);
    ctx.windowId = win.id;
  } catch (_) {
    /* popup may not have a window id */
  }
  return ctx;
}

async function init() {
  const ctx = await popupContext();
  const reply = await chrome.runtime.sendMessage({
    type: "getSettings",
    ...ctx
  });
  if (!reply?.ok) {
    showToast(t("loadFailed"), true);
    return;
  }
  render(reply);
}

function render(reply) {
  const settings = reply.settings || {};
  const sites = settings.sites || {};
  signTimeEl.value = settings.signTime || "00:01";
  nextAlarmEl.textContent = formatNextAlarm(reply.nextAlarm, settings.enabled);
  SITE_ORDER.forEach((id) => {
    const site = sites[id] || {};
    document.getElementById(`enabled-${id}`).checked = site.enabled !== false;
    const resultEl = document.getElementById(`result-${id}`);
    resultEl.textContent = formatLastResult(site);
    resultEl.classList.toggle("is-login", site.lastResult === "login");
  });
}

function collectPayload() {
  const sites = {};
  SITE_ORDER.forEach((id) => {
    sites[id] = { enabled: document.getElementById(`enabled-${id}`).checked };
  });
  return {
    signTime: signTimeEl.value,
    sites
  };
}

async function saveSettings({ silent = false } = {}) {
  const reply = await chrome.runtime.sendMessage({
    type: "saveSettings",
    payload: collectPayload(),
    ...(await popupContext())
  });
  if (!reply?.ok) {
    showToast(reply?.error || t("saveFailed"), true);
    return;
  }
  render(reply);
  if (!silent) showToast(t("saved"), false, 3000);
}

async function signNow() {
  const button = document.getElementById("signNow");
  if (button.disabled) return;
  button.disabled = true;
  showToast(t("signingNow"));
  try {
    await saveSettings();
    const reply = await chrome.runtime.sendMessage({
      type: "signNow",
      ...(await popupContext())
    });
    if (!reply?.ok) {
      button.disabled = false;
      showToast(reply?.error || t("cannotStart"), true);
      return;
    }
    window.close();
  } catch (error) {
    button.disabled = false;
    showToast(error.message || t("cannotStart"), true);
  }
}

function formatNextAlarm(timestamp, enabled) {
  if (enabled === false) return t("disabled");
  if (!timestamp) return t("notScheduled");
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatLastResult(settings) {
  if (!settings?.lastResult) return t("noRecord");
  const key = RESULT_KEYS[settings.lastResult];
  const label = key ? t(key) : settings.lastResult;
  const time = settings.lastResultAt ? formatClock(settings.lastResultAt) : "";
  const detail =
    settings.lastResult === "login"
      ? t("popupLoginDetail")
      : settings.lastMessage || "";
  const message = detail ? `｜${detail}` : "";
  return `${label}${time ? `（${time}）` : ""}${message}`;
}

function formatClock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function showToast(text, isError = false, hideAfterMs = 0) {
  toastEl.hidden = false;
  toastEl.textContent = text;
  toastEl.classList.toggle("error", Boolean(isError));
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  if (hideAfterMs > 0) {
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
      toastTimer = null;
    }, hideAfterMs);
  }
}
