(() => {
  const HUD_ID = "bm-signin-hud";

  function showLoginHud(message) {
    const extName = `[B.M] ${chrome.i18n.getMessage("extNameSuffix") || ""}`.trim();
    const src = chrome.i18n.getMessage("pageLoginDialogSrc", [extName]);
    const text =
      message ||
      chrome.i18n.getMessage("popupLoginDetail") ||
      chrome.i18n.getMessage("pageLoginHint");
    const okLabel = chrome.i18n.getMessage("dialogOk");

    let hud = document.getElementById(HUD_ID);
    if (!hud) {
      hud = document.createElement("div");
      hud.id = HUD_ID;
      hud.setAttribute("role", "status");
      const srcEl = document.createElement("p");
      srcEl.className = "bm-signin-hud-src";
      const label = document.createElement("p");
      label.className = "bm-signin-hud-text";
      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "bm-signin-hud-ok";
      ok.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        hud.remove();
      });
      hud.append(srcEl, label, ok);
      (document.documentElement || document.body).appendChild(hud);
    }
    const srcEl = hud.querySelector(".bm-signin-hud-src");
    const label = hud.querySelector(".bm-signin-hud-text");
    const ok = hud.querySelector(".bm-signin-hud-ok");
    if (srcEl) srcEl.textContent = src;
    if (label) label.textContent = text;
    if (ok) ok.textContent = okLabel;
  }

  globalThis.bmShowLoginHud = showLoginHud;

  if (globalThis.bmShowLoginHudInstalled) return;
  globalThis.bmShowLoginHudInstalled = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "showLoginHud") return;
    showLoginHud(message.message);
    sendResponse({ ok: true });
  });
})();
