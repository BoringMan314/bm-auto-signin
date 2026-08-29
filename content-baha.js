(() => {
  const POLL_MS = 400;
  const WAIT_MS = 25000;
  const RESULT_WAIT_MS = 15000;
  const CLOSE_PREVIEW_MS = 1500;
  const SITE = "baha";

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
    send({ type: "bahaInspect" })
      .then((reply) => sendResponse(mapInspect(reply)))
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
    if (isBahaLoginPage()) {
      await report("login", t("msgNeedLoginBaha"));
      return;
    }

    const inspect = await waitFor(
      async () => {
        const reply = await send({ type: "bahaInspect" });
        if (!reply || reply.status === "pending") return null;
        return reply;
      },
      WAIT_MS
    );

    if (!inspect) {
      await report("error", t("msgBahaNoApi"));
      return;
    }
    if (inspect.status === "login") {
      await report("login", t("msgNeedLoginBaha"));
      return;
    }
    if (inspect.status === "already") {
      await report("already", t("msgAlready"));
      return;
    }

    const claimed = await send({ type: "claimClick" });
    if (!claimed?.claimed) {
      const later = await watchResult();
      await report(later.status, later.message);
      return;
    }

    const clicked = await send({ type: "bahaSign" });
    if (!clicked?.ok) {
      await report("error", t("msgBahaNoApi"));
      return;
    }
    const result = await watchResult();
    await report(result.status, result.message);
  }

  async function watchResult() {
    const deadline = Date.now() + RESULT_WAIT_MS;
    while (Date.now() < deadline) {
      const reply = await send({ type: "bahaInspect" });
      const mapped = mapInspect(reply);
      if (mapped.status === "already" || mapped.status === "success") {
        return { status: "success", message: t("msgSuccess") };
      }
      if (mapped.status === "login") {
        return { status: "login", message: t("msgNeedLoginBaha") };
      }
      await delay(POLL_MS);
    }
    const last = mapInspect(await send({ type: "bahaInspect" }));
    if (last.status === "already") return { status: "already", message: t("msgAlready") };
    return { status: "error", message: t("msgUnconfirmed") };
  }

  function isBahaLoginPage() {
    return /user\.gamer\.com\.tw\/login\.php/i.test(location.href);
  }

  function mapInspect(reply) {
    if (!reply?.status) return { ok: true, status: "pending" };
    if (reply.status === "login") return { ok: true, status: "login", message: t("msgNeedLoginBaha") };
    if (reply.status === "already") return { ok: true, status: "already", message: t("msgAlready") };
    if (reply.status === "need") return { ok: true, status: "pending" };
    return { ok: true, status: "pending" };
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
