const SITE_ORDER = ["baha", "apktw", "eyny", "genshin", "klpbbs", "littleskin"];
const signTimeEl = document.getElementById("signTime");
const nextAlarmEl = document.getElementById("nextAlarm");
const toastEl = document.getElementById("toast");
const TOAST_DURATION_MS = 3000;
let toastTimer = null;
const EXT_NAME = `[B.M] ${t("extNameSuffix")}`;

const RESULT_KEYS = {
  pending: "resultPending",
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
document.getElementById("signMakeup").addEventListener("click", signMakeup);
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
    document.getElementById(`enabled-${id}`).checked = site.enabled === true;
    const resultEl = document.getElementById(`result-${id}`);
    renderLastResult(resultEl, site);
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
  if (!silent) showToast(t("saved"));
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

async function signMakeup() {
  const button = document.getElementById("signMakeup");
  if (button.disabled) return;
  button.disabled = true;
  showToast(t("signingNow"));
  try {
    await saveSettings({ silent: true });
    const reply = await chrome.runtime.sendMessage({
      type: "signMakeup",
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

function renderLastResult(element, settings) {
  element.replaceChildren();
  element.classList.remove("is-error");
  if (!settings?.lastResult) {
    element.textContent = t("noRecord");
    element.classList.add("is-error");
    return;
  }
  const isPending = settings.lastResult === "pending";
  const previousSuccess = isPending && settings.lastSuccessAt;
  const dueButUnsigned =
    settings.lastResult === "success" &&
    settings.lastSignDate !== todayKey() &&
    isPastSignTime();
  const showUnsignedAfterSuccess = Boolean(previousSuccess || dueButUnsigned);
  const key = RESULT_KEYS[settings.lastResult];
  const label = showUnsignedAfterSuccess
    ? t("resultSuccess")
    : isPending
      ? t("resultNotSignedToday")
      : key
        ? t(key)
        : settings.lastResult;
  const time = showUnsignedAfterSuccess
    ? formatClock(previousSuccess ? settings.lastSuccessAt : settings.lastResultAt)
    : !isPending && settings.lastResultAt
      ? formatClock(settings.lastResultAt)
      : "";
  const status = document.createElement("span");
  status.className = "site-result-status";
  status.classList.toggle(
    "is-error",
    (isPending && !previousSuccess) || ["captcha", "timeout", "error"].includes(settings.lastResult)
  );
  status.classList.toggle(
    "is-warning",
    settings.lastResult === "login" || showUnsignedAfterSuccess
  );
  status.textContent = `${label}${time ? `（${time}）` : ""}`;
  element.append(status);

  const detail = showUnsignedAfterSuccess
    ? t("resultNotSignedToday")
    : isPending
      ? ""
      : settings.lastResult === "login"
        ? t("popupLoginDetail")
        : settings.lastMessage || "";
  if (!detail) return;

  const separator = document.createElement("span");
  separator.className = "site-result-separator";
  separator.textContent = "｜";
  element.append(separator);

  const detailText = document.createElement("span");
  detailText.className = "site-result-detail";
  detailText.textContent = detail;
  detailText.classList.toggle(
    "is-error",
    showUnsignedAfterSuccess || ["captcha", "timeout", "error"].includes(settings.lastResult)
  );
  detailText.classList.toggle("is-warning", settings.lastResult === "login");
  element.append(detailText);
}

function formatClock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function isPastSignTime() {
  const [hour, minute] = (signTimeEl.value || "00:01").split(":").map(Number);
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() >= hour * 60 + minute;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function showToast(text, isError = false) {
  toastEl.hidden = false;
  toastEl.textContent = text;
  toastEl.classList.toggle("error", Boolean(isError));
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
    toastTimer = null;
  }, TOAST_DURATION_MS);
}
