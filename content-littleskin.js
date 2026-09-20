(() => {
  const SITE = "littleskin";
  const POLL_MS = 400;
  const WAIT_MS = 25000;
  const RESULT_WAIT_MS = 25000;
  const CAPTCHA_HOLD_MS = 2500;
  const CLOSE_PREVIEW_MS = 1500;
  let started = false;

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
    inspect().then(sendResponse).catch(() => sendResponse({ ok: true, status: "pending" }));
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
      await report("error", t("msgLittleSkinNoButton"));
      return;
    }
    if (initial.status === "login") {
      await report("login", t("msgNeedLoginLittleSkin"));
      return;
    }
    if (initial.status === "already") {
      await report("already", t("msgAlready"));
      return;
    }

    const claimed = await send({ type: "claimClick" });
    if (!claimed?.claimed) {
      const later = await watchResult();
      await report(later.status, later.message);
      return;
    }
    const clicked = await send({ type: "littleskinSign" });
    if (!clicked?.ok) {
      await report("error", t("msgLittleSkinNoButton"));
      return;
    }
    const result = await watchResult();
    await report(result.status, result.message);
  }

  async function inspect() {
    const reply = await send({ type: "littleskinInspect" });
    if (!reply?.status) return { ok: true, status: "pending" };
    if (reply.status === "login") return { ok: true, status: "login" };
    if (reply.status === "captcha") return { ok: true, status: "captcha" };
    if (reply.status === "already") return { ok: true, status: "already" };
    if (reply.status === "need") return { ok: true, status: "need" };
    return { ok: true, status: "pending" };
  }

  async function watchResult() {
    const deadline = Date.now() + RESULT_WAIT_MS;
    let captchaSince = 0;
    while (Date.now() < deadline) {
      const state = await inspect();
      if (state.status === "already") return { status: "success", message: t("msgSuccess") };
      if (state.status === "login") return { status: "login", message: t("msgNeedLoginLittleSkin") };
      if (state.status === "captcha") {
        if (!captchaSince) captchaSince = Date.now();
        if (Date.now() - captchaSince >= CAPTCHA_HOLD_MS) {
          return { status: "captcha", message: t("msgLittleSkinCaptcha") };
        }
      } else {
        captchaSince = 0;
      }
      await delay(POLL_MS);
    }
    return { status: "error", message: t("msgUnconfirmed") };
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

  async function report(status, message) {
    if (status === "login") globalThis.bmShowLoginHud?.();
    if (status === "success" || status === "already") await delay(CLOSE_PREVIEW_MS);
    return chrome.runtime.sendMessage({
      type: "signResult",
      payload: { status, message, site: SITE }
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
