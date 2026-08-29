(() => {
  const POLL_MS = 400;
  const WAIT_MS = 25000;
  const CLOSE_PREVIEW_MS = 1500;
  const SITE = "genshin";
  const ACT_ID = "e202102251931481";

  let started = false;

  function t(key) {
    return chrome.i18n.getMessage(key) || key;
  }

  function lang() {
    return (chrome.i18n.getUILanguage() || "zh-TW").replace("_", "-").toLowerCase();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
  watchAppGuide();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "flushStatus") return;
    inspectCurrentStatus()
      .then(sendResponse)
      .catch(() => sendResponse({ ok: true, status: "pending" }));
    return true;
  });

  async function init() {
    try {
      const allowed = await waitForPermission();
      if (!allowed || started) return;
      started = true;
      await runSignIn();
    } catch (error) {
      if (!started) return;
      await report("error", error.message || String(error));
    }
  }

  function dismissAppGuide() {
    const closeBtn =
      document.querySelector('[class*="sign-guide_"][class*="guide-close"]') ||
      document.querySelector('[class*="__sign-guide_---guide-close"]');
    if (closeBtn) {
      closeBtn.click();
      return true;
    }
    const guide = document.querySelector(
      '[class*="__sign-guide_---guide---"], [class*="sign-guide_---guide---"]'
    );
    if (!guide) return false;
    const mask = guide.closest(".custom-mihoyo-common-mask, [class*='custom-mihoyo-common-mask']");
    (mask || guide).remove();
    return true;
  }

  function watchAppGuide() {
    dismissAppGuide();
    const observer = new MutationObserver(() => dismissAppGuide());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const timer = setInterval(dismissAppGuide, POLL_MS);
    setTimeout(() => {
      clearInterval(timer);
      observer.disconnect();
    }, WAIT_MS);
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
    const info = await waitFor(async () => {
      const data = await apiInfo();
      if (!data) return null;
      if (data.retcode === -100 || data.retcode === 10001) return data;
      if (data.data) return data;
      return null;
    }, WAIT_MS);

    if (!info) {
      await report("error", t("msgGenshinApi"));
      return;
    }
    if (info.retcode === -100 || info.retcode === 10001) {
      await report("login", t("msgNeedLoginGenshin"));
      return;
    }
    if (info.data?.is_sign || info.data?.signed) {
      await report("already", t("msgAlready"));
      return;
    }

    const claimed = await send({ type: "claimClick" });
    if (!claimed?.claimed) {
      const again = await apiInfo();
      if (again?.data?.is_sign || again?.data?.signed) {
        await report("already", t("msgAlready"));
        return;
      }
      await report("error", t("msgUnconfirmed"));
      return;
    }

    const signed = await apiSign();
    if (signed?.retcode === 0) {
      await report("success", t("msgSuccess"));
      return;
    }
    if (signed?.retcode === -5003) {
      await report("already", t("msgAlready"));
      return;
    }
    if (signed?.retcode === -100 || signed?.retcode === 10001) {
      await report("login", t("msgNeedLoginGenshin"));
      return;
    }

    const after = await apiInfo();
    if (after?.data?.is_sign) {
      await report("success", t("msgSuccess"));
      return;
    }
    await report("error", signed?.message || t("msgUnconfirmed"));
  }

  async function inspectCurrentStatus() {
    const info = await apiInfo();
    if (!info) return { ok: true, status: "pending" };
    if (info.retcode === -100 || info.retcode === 10001) {
      return { ok: true, status: "login", message: t("msgNeedLoginGenshin") };
    }
    if (info.data?.is_sign || info.data?.signed) {
      return { ok: true, status: "already", message: t("msgAlready") };
    }
    return { ok: true, status: "pending" };
  }

  async function apiInfo() {
    const reply = await send({
      type: "genshinApi",
      payload: { action: "info", lang: lang(), actId: ACT_ID }
    });
    return reply?.data || null;
  }

  async function apiSign() {
    const reply = await send({
      type: "genshinApi",
      payload: { action: "sign", lang: lang(), actId: ACT_ID }
    });
    return reply?.data || null;
  }

  async function waitFor(getter, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await getter();
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
      payload: { status, message, site: SITE }
    });
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
