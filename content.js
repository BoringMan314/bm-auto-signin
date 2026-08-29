(() => {
  const WAIT_MS = 25000;
  const POLL_MS = 400;
  const RESULT_WAIT_MS = 12000;
  const CLOSE_PREVIEW_MS = 1500;
  const PAGE_READY_MS = 30000;
  const STABLE_POLLS = 4;

  const SUCCESS_RE = /簽到成功|签到成功|恭喜你|恭喜您|本次簽到獲得|本次签到获得|已成功簽到|打卡成功|獎勵已發放/;
  const ALREADY_RE = /\[已簽\]|已經簽到|已经签到|今日已簽|今天已經簽|您今天已經|已簽到過|今日簽到完畢|今天已经签/;
  const LOGIN_RE = /請先登錄|請先登入|您需要登錄|您需要登入|尚未登錄|尚未登入/;
  const FAIL_RE = /簽到失敗|签到失败|非法操作|驗證碼錯誤|验证码错误|請重新嘗試/;
  const CAPTCHA_RE = /驗證碼|验证码|請輸入驗證|安全提問/;

  let started = false;
  let latestNotice = "";

  function t(key) {
    return chrome.i18n.getMessage(key) || key;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "flushStatus") return;
    sendResponse(inspectCurrentStatus());
    return true;
  });

  async function init() {
    try {
      document.cookie = "adblock_forbit=1; path=/";
      const allowed = await waitForPermission();
      if (!allowed || started) return;
      started = true;
      observeNotices();
      await runSignIn();
    } catch (error) {
      if (!started) return;
      await report("error", error.message || String(error));
    }
  }

  async function waitForPermission() {
    for (let i = 0; i < 40; i += 1) {
      let reply = null;
      try {
        reply = await send({ type: "shouldAutoSign", site: "apktw" });
      } catch (_) {
        reply = null;
      }
      if (reply?.shouldSign) return true;
      if (i >= 12 && reply && !reply.shouldSign) return false;
      await delay(250);
    }
    return false;
  }

  function observeNotices() {
    const root = document.body;
    if (!root) return;
    const observer = new MutationObserver(() => {
      latestNotice = getNoticeText();
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "onclick", "href", "class", "style"]
    });
  }

  async function runSignIn() {
    await waitUntilPageOpened();

    if (pageShowsAlreadySigned()) {
      await report("already", t("msgAlready"));
      return;
    }

    if (/action=login/i.test(location.href) || !isLoggedIn()) {
      await report("login", t("msgNeedLogin"));
      return;
    }

    const found = await waitFor(
      () => pageShowsAlreadySigned() || getSignButton(),
      WAIT_MS
    );
    if (pageShowsAlreadySigned()) {
      await report("already", t("msgAlready"));
      return;
    }
    if (!found) {
      await report("error", t("msgNoButton"));
      return;
    }

    const button = getSignButton();
    if (button && looksAlreadySigned(button)) {
      await report("already", t("msgAlready"));
      return;
    }
    if (!canClickSign(button)) {
      await report("error", t("msgNoButton"));
      return;
    }

    const claimed = await send({ type: "claimClick" });
    if (!claimed?.claimed) {
      const result = await watchResult();
      await report(result.status, result.message);
      return;
    }

    await triggerSign(button);
    const result = await watchResult();
    await report(result.status, result.message);
  }

  function isLoggedIn() {
    if (getSignButton() || getSignedBadge()) return true;
    if (document.querySelector('#um a[href*="action=logout"]')) return true;
    if (document.querySelector('a[href*="member.php"][href*="action=logout"]')) return true;
    return false;
  }

  function isLoggedOutChrome() {
    if (isLoggedIn()) return false;
    return Boolean(
      document.querySelector("a.logb[href*='action=login']") ||
      document.querySelector(".topMenu a[href*='action=login']")
    );
  }

  function getSignedBadge() {
    return document.getElementById("ppered");
  }

  function getSignButton() {
    const byId = document.getElementById("my_amupper");
    if (byId && byId.id !== "ppered") return byId;
    const inBar = document.querySelector('#um a[onclick*="dsu_amupper:pper"]');
    if (inBar && inBar.id !== "ppered") return inBar;
    const dk = document.querySelector('#um img[src*="dk.gif"]');
    return dk?.closest("a") || null;
  }

  function signImgSrc(el) {
    if (!el) return "";
    const img = el.tagName === "IMG" ? el : el.querySelector("img");
    return img?.currentSrc || img?.src || img?.getAttribute("src") || "";
  }

  function canClickSign(button) {
    if (!button || button.id === "ppered") return false;
    const onclick = button.getAttribute("onclick") || "";
    if (/ajaxget/i.test(onclick) && /dsu_amupper:pper/i.test(onclick)) return true;
    return /dk\.gif/i.test(signImgSrc(button));
  }

  function looksAlreadySigned(button) {
    if (getSignedBadge()) return true;
    if (!button) return false;
    if (button.id === "ppered") return true;
    const src = signImgSrc(button);
    if (/dk\.gif/i.test(src)) return false;
    return /wb\.gif/i.test(src);
  }

  function pageShowsAlreadySigned() {
    if (getSignedBadge()) return true;
    const menu = document.getElementById("ppered_menu");
    if (menu && /累計簽到|您上次簽到時間/.test(menu.innerText || "")) return true;
    const src = signImgSrc(document.getElementById("my_amupper") || document.querySelector("#um a[onclick*='dsu_amupper']"));
    return /wb\.gif/i.test(src);
  }

  function inspectCurrentStatus() {
    if (pageShowsAlreadySigned()) {
      return { ok: true, status: "already", message: t("msgAlready") };
    }
    if (!isLoggedIn()) {
      return { ok: true, status: "login", message: t("msgNeedLogin") };
    }
    const snapshot = inspectResult();
    if (snapshot) return { ok: true, ...snapshot };
    return { ok: true, status: "pending" };
  }

  function buttonSignature(el) {
    if (!el) return "";
    const img = el.tagName === "IMG" ? el : el.querySelector("img");
    return [
      el.outerHTML || "",
      el.getAttribute("onclick") || "",
      el.getAttribute("href") || "",
      img?.getAttribute("src") || ""
    ].join("|");
  }

  async function triggerSign(el) {
    try {
      el.scrollIntoView({ block: "center", inline: "center" });
    } catch (_) {
      /* ignore */
    }
    const reply = await send({ type: "clickSignButton" });
    if (reply?.ok) return;
  }

  async function watchResult() {
    const deadline = Date.now() + RESULT_WAIT_MS;
    let submitClicked = false;
    while (Date.now() < deadline) {
      const snapshot = inspectResult();
      if (snapshot) return snapshot;

      const extraSubmit = findPopupSubmit();
      if (extraSubmit && !hasCaptcha() && !submitClicked) {
        submitClicked = true;
        extraSubmit.click();
      }

      if (pageShowsAlreadySigned() && !hasFailure()) {
        return { status: "success", message: t("msgSuccess") };
      }

      const current = getSignButton();
      if (current && looksAlreadySigned(current) && !hasFailure()) {
        return { status: "success", message: t("msgSuccess") };
      }

      await delay(POLL_MS);
    }

    if (pageShowsAlreadySigned() && !hasFailure()) {
      return { status: "success", message: t("msgSuccess") };
    }

    if (hasCaptcha()) {
      return { status: "captcha", message: t("msgNeedCaptcha") };
    }

    const text = `${latestNotice}\n${getNoticeText()}`;
    if (ALREADY_RE.test(text)) {
      return { status: "already", message: trimResult(text, ALREADY_RE) || t("msgAlready") };
    }
    if (SUCCESS_RE.test(text)) {
      return { status: "success", message: trimResult(text, SUCCESS_RE) || t("msgSuccess") };
    }

    if (getSignButton() && looksAlreadySigned(getSignButton()) && !hasFailure()) {
      return { status: "success", message: t("msgSuccess") };
    }

    return { status: "error", message: t("msgUnconfirmed") };
  }

  function inspectResult() {
    const text = `${latestNotice}\n${getNoticeText()}`;
    if (FAIL_RE.test(text)) {
      return { status: "error", message: trimResult(text, FAIL_RE) || t("msgFailed") };
    }
    if (document.querySelector(".alert_error")) {
      const errorText = document.querySelector(".alert_error")?.innerText || t("msgFailed");
      return { status: "error", message: errorText.trim() };
    }
    if (pageShowsAlreadySigned()) {
      return { status: "success", message: t("msgSuccess") };
    }
    if (ALREADY_RE.test(text)) {
      return { status: "already", message: trimResult(text, ALREADY_RE) || t("msgAlready") };
    }
    if (SUCCESS_RE.test(text)) {
      return { status: "success", message: trimResult(text, SUCCESS_RE) || t("msgSuccess") };
    }
    if (hasCaptcha()) {
      return { status: "captcha", message: t("msgNeedCaptchaInTab") };
    }
    if (LOGIN_RE.test(text)) {
      return { status: "login", message: t("msgLogin") };
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return el.getClientRects().length > 0;
  }

  function hasCaptcha() {
    const nodes = document.querySelectorAll(
      "#seccodeverify, input[name='seccodeverify'], #secqaa, .g-recaptcha, iframe[src*='captcha']"
    );
    for (const el of nodes) {
      if (isVisible(el)) return true;
    }
    const notice = getNoticeText();
    return CAPTCHA_RE.test(notice) && /簽到|签到|amupper|pper/i.test(notice);
  }

  function hasFailure() {
    const text = `${latestNotice}\n${getNoticeText()}`;
    return FAIL_RE.test(text) || Boolean(document.querySelector(".alert_error"));
  }

  function getNoticeNodes() {
    return document.querySelectorAll(
      "#ntcwin, #messagetext, .alert_right, .alert_error, .alert_info, [id^='fwin_content'], [id^='fwin_dialog']"
    );
  }

  function getNoticeText() {
    return Array.from(getNoticeNodes())
      .map((node) => node.innerText || "")
      .join("\n");
  }

  function getPopup() {
    return (
      document.querySelector("[id^='fwin_']") ||
      document.querySelector("#ntcwin") ||
      document.querySelector("#messagetext") ||
      document.querySelector(".fwinmask")
    );
  }

  function findPopupSubmit() {
    const popup = getPopup();
    if (!popup) return null;
    const haystack = `${popup.id || ""} ${popup.innerText || ""}`;
    if (!/dsu_amupper|簽到中|請選擇心情/i.test(haystack)) return null;
    const buttons = popup.querySelectorAll("button, input[type='submit']");
    for (const button of buttons) {
      const text = `${button.value || ""} ${button.textContent || ""}`.replace(/\s+/g, "");
      if (/簽到|签到|確定|确定|提交|確認|确认/.test(text)) return button;
    }
    return popup.querySelector("form button, form input[type='submit']");
  }

  function trimResult(text, regex) {
    const line = text
      .split(/\n+/)
      .map((item) => item.trim())
      .find((item) => regex.test(item) && item.length < 80);
    return line || "";
  }

  async function waitUntilPageOpened() {
    if (/action=login/i.test(location.href)) return;
    await waitForDocumentComplete();
    await waitFor(
      () => pageShowsAlreadySigned() || isLoggedIn() || isLoggedOutChrome(),
      PAGE_READY_MS
    );
    if (pageShowsAlreadySigned() || isLoggedOutChrome()) return;
    await waitUntilSignAreaStable();
  }

  function isPageChromeReady() {
    return Boolean(
      document.querySelector('a[href*="action=logout"]') ||
      document.querySelector('a[href*="action=login"]') ||
      document.getElementById("um") ||
      document.getElementById("toptb") ||
      document.getElementById("hd") ||
      document.getElementById("nv") ||
      getSignButton() ||
      getSignedBadge()
    );
  }

  async function waitForDocumentComplete() {
    if (document.readyState === "complete") return;
    await new Promise((resolve) => {
      window.addEventListener("load", resolve, { once: true });
      setTimeout(resolve, 15000);
    });
  }

  async function waitUntilSignAreaStable() {
    let last = null;
    let hits = 0;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const button = getSignButton();
      const sig = button ? buttonSignature(button) : getSignedBadge() ? "signed" : `chrome:${isPageChromeReady()}`;
      if (sig === last) {
        hits += 1;
        if (hits >= STABLE_POLLS) return;
      } else {
        hits = 0;
        last = sig;
      }
      await delay(POLL_MS);
    }
  }

  async function waitFor(getter, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = getter();
      if (value) return value;
      await delay(POLL_MS);
    }
    return getter();
  }

  async function send(payload) {
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch (_) {
      return null;
    }
  }

  async function report(status, message) {
    if (status === "login") {
      globalThis.bmShowLoginHud?.();
    }
    if (status === "success" || status === "already") {
      await delay(CLOSE_PREVIEW_MS);
    }
    return chrome.runtime.sendMessage({
      type: "signResult",
      payload: { status, message, site: "apktw" }
    });
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
