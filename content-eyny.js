(() => {
  const SITE = "eyny";
  const POLL_MS = 250;
  const WAIT_MS = 40000;
  const TOAST_WAIT_MS = 8000;
  const CLOSE_PREVIEW_MS = 1500;
  const NOTICE_RE =
    /已簽到|已签到|簽到成功|签到成功|今日已簽|今天已簽|今日已領|積分\s*\+|积分\s*\+|獲得\s*\d+\s*積分|获得\s*\d+\s*积分/;
  let started = false;
  let capturedNotice = "";

  function t(key) {
    return chrome.i18n.getMessage(key) || key;
  }

  observeNotices();
  send({ type: "eynyHook" }).catch(() => {});

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "flushStatus") return;
    (async () => {
      try {
        sendResponse(await inspect());
      } catch (_) {
        sendResponse({ ok: true, status: "pending" });
      }
    })();
    return true;
  });

  async function init() {
    try {
      if (!(await waitForPermission()) || started) return;
      started = true;
      await runSignIn();
    } catch (error) {
      if (started) await report("error", error.message || String(error));
    }
  }

  async function waitForPermission() {
    for (let i = 0; i < 40; i += 1) {
      const reply = await send({ type: "shouldAutoSign", site: SITE });
      if (reply?.shouldSign) return true;
      if (i >= 12 && reply && !reply.shouldSign) return false;
      await delay(250);
    }
    return false;
  }

  async function runSignIn() {
    const initial = await waitFor(inspect, WAIT_MS);
    if (!initial || initial.status === "pending") {
      await report("error", t("msgEynyNoButton"));
      return;
    }
    if (initial.status === "login") {
      await report("login", t("msgNeedLoginEyny"));
      return;
    }
    if (initial.status === "already") {
      await report("already", t("msgAlready"));
      return;
    }

    const toasted = await waitFor(async () => {
      const state = await inspect();
      if (state.status === "already" || state.status === "login") return state;
      return { ok: true, status: "pending" };
    }, TOAST_WAIT_MS);

    if (toasted?.status === "login") {
      await report("login", t("msgNeedLoginEyny"));
      return;
    }
    if (toasted?.status === "already") {
      await report("already", t("msgAlready"));
      return;
    }
    await report("timeout", t("msgTimeoutKept"));
  }

  async function inspect() {
    const reply = await send({ type: "eynyInspect" });
    if (!reply?.status) return { ok: true, status: "pending" };
    if (reply.status === "login") return { ok: true, status: "login" };
    if (reply.status === "already" || reply.status === "ready") {
      return { ok: true, status: "already" };
    }
    return { ok: true, status: "pending" };
  }

  function observeNotices() {
    const scan = (root) => {
      if (!root) return;
      if (root.nodeType === Node.TEXT_NODE) {
        if (isNoticeNode(root.parentElement)) noteText(root.textContent || "");
        return;
      }
      if (root.nodeType !== Node.ELEMENT_NODE) return;
      if (isNoticeNode(root)) noteText(root.innerText || root.textContent || "");
      if (root.querySelectorAll) {
        root.querySelectorAll(
          "#ntcwin, #messagetext, #creditnotice, .alert_right, .alert_info, [id^='fwin_'], #append_parent > div"
        ).forEach((node) => noteText(node.innerText || node.textContent || ""));
      }
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.target) scan(record.target);
        for (const node of record.addedNodes || []) scan(node);
        for (const node of record.removedNodes || []) scan(node);
      }
    });
    const start = () => {
      scan(document.documentElement);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });
    };
    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  }

  function isNoticeNode(el) {
    if (!el?.matches) return false;
    if (el.matches("#ntcwin, #messagetext, #creditnotice, .alert_right, .alert_info, [id^='fwin_']")) {
      return true;
    }
    if (el.closest?.("#append_parent, #fwin_dialog, #ntcwin")) return true;
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 240 || !NOTICE_RE.test(text)) return false;
    try {
      const style = window.getComputedStyle(el);
      return style.position === "fixed" || style.position === "absolute";
    } catch (_) {
      return false;
    }
  }

  function noteText(text) {
    const compact = String(text || "").replace(/\s+/g, " ").trim();
    if (!compact || compact.length > 240) return;
    if (NOTICE_RE.test(compact)) capturedNotice = compact;
  }

  async function waitFor(getter, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await getter();
      if (value?.status !== "pending") return value;
      await delay(POLL_MS);
    }
    return getter();
  }

  async function report(status, message, extra = {}) {
    if (status === "login") globalThis.bmShowLoginHud?.();
    if (status === "success" || status === "already") await delay(CLOSE_PREVIEW_MS);
    return chrome.runtime.sendMessage({
      type: "signResult",
      payload: { status, message, site: SITE, ...extra }
    });
  }

  async function send(payload) {
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch (_) {
      return null;
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
