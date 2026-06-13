// ACMind Importer — Content script.
// - Injects scraper-bridge.js into page main world
// - Mounts a Nanobar progress bar on the page when an import is running
// - Exposes "describe page" and "start import" commands to the background

import Nanobar from "nanobar";

import {
  MSG_SOURCE_BRIDGE,
  MSG_SOURCE_CONTENT,
  BRIDGE_READY,
  BRIDGE_SCRAPE_REQUEST,
  BRIDGE_SCRAPE_PROGRESS,
  BRIDGE_SCRAPE_DATA,
  BRIDGE_SCRAPE_ERROR,
  BRIDGE_DESCRIBE_PAGE_REQUEST,
  BRIDGE_DESCRIBE_PAGE_RESPONSE,
  CMD_START_IMPORT,
  BG_IMPORT,
  BG_DESCRIBE_PAGE,
  SCRAPER_READY_TIMEOUT_MS,
} from "./protocol.js";

// ---- Inject scraper into page main world ----
const script = document.createElement("script");
script.src = chrome.runtime.getURL("scraper-bridge.js");
script.onload = () => script.remove();
(document.head ?? document.documentElement).appendChild(script);

let scraperReady = false;
let onScraperReady;
const scraperReadyPromise = new Promise((resolve) => { onScraperReady = resolve; });

function postToPage(payload) {
  window.postMessage({ source: MSG_SOURCE_CONTENT, ...payload }, "*");
}

async function waitForScraper() {
  if (scraperReady) return true;
  return Promise.race([
    scraperReadyPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), SCRAPER_READY_TIMEOUT_MS)),
  ]);
}

// ---- Progress bar UI ----
//
// A single 3px Nanobar line at the very top of the page. One colour, no states.
// On failure the bar simply vanishes and a single alert tells the user.

const BAR_STYLE = `
  #acmind-bar { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647; pointer-events: none; }
  #acmind-bar .nanobar { background: transparent; }
  #acmind-bar .bar { height: 3px; background: #3498db; transition: width .25s ease, opacity .4s; }
  #acmind-bar.fading .bar { opacity: 0; }
  #acmind-toasts { position: fixed; top: 12px; right: 12px; z-index: 2147483647;
    display: flex; flex-direction: column; gap: 8px; max-width: 360px; }
  .acmind-toast { pointer-events: auto; cursor: pointer; font: 13px/1.5 -apple-system, system-ui, sans-serif;
    color: #fff; background: #334155; border-radius: 8px; padding: 10px 12px;
    box-shadow: 0 4px 12px rgba(0,0,0,.18); white-space: pre-wrap;
    opacity: 0; transform: translateY(-6px); transition: opacity .2s, transform .2s; }
  .acmind-toast.show { opacity: 1; transform: translateY(0); }
  .acmind-toast.ok { background: #16a34a; }
  .acmind-toast.warn { background: #b45309; }
  .acmind-toast.error { background: #dc2626; }
`;

let barEl = null;
let nanobar = null;
let fadeTimer = null;

function ensureStyle() {
  if (document.getElementById("acmind-bar-style")) return;
  const style = document.createElement("style");
  style.id = "acmind-bar-style";
  style.textContent = BAR_STYLE;
  (document.head ?? document.documentElement).appendChild(style);
}

function ensureBar() {
  if (barEl) return;
  ensureStyle();
  barEl = document.createElement("div");
  barEl.id = "acmind-bar";
  document.body.appendChild(barEl);
  nanobar = new Nanobar({ target: barEl });
}

// Non-blocking toast (replaces alert for non-fatal summaries). Click to dismiss.
function showToast(message, kind = "ok", durationMs = kind === "ok" ? 4000 : 9000) {
  ensureStyle();
  let host = document.getElementById("acmind-toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "acmind-toasts";
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = `acmind-toast ${kind}`;
  el.textContent = message;
  const remove = () => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 220);
  };
  el.addEventListener("click", remove);
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(remove, durationMs);
}

function setBarProgress(pct) {
  ensureBar();
  const clamped = Math.max(lastPct, Math.max(0, Math.min(100, pct)));
  lastPct = clamped;
  nanobar.go(clamped);
}

function dismissBar(delay = 0) {
  clearTimeout(fadeTimer);
  if (!barEl) return;
  const el = barEl;
  fadeTimer = setTimeout(() => {
    el.classList.add("fading");
    setTimeout(() => {
      el.remove();
      if (barEl === el) { barEl = null; nanobar = null; }
    }, 420);
  }, delay);
}

// ---- Bridge message routing ----
let activeRequestId = null;
let lastPct = 0;

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== MSG_SOURCE_BRIDGE) return;

  switch (msg.type) {
    case BRIDGE_READY:
      scraperReady = true;
      onScraperReady();
      return;
    case BRIDGE_DESCRIBE_PAGE_RESPONSE: {
      const cb = pendingDescribe.get(msg.requestId);
      if (cb) {
        pendingDescribe.delete(msg.requestId);
        cb(msg.description);
      }
      return;
    }
    case BRIDGE_SCRAPE_PROGRESS:
      if (msg.requestId !== activeRequestId) return;
      if (typeof msg.pct === "number") setBarProgress(msg.pct);
      return;
    case BRIDGE_SCRAPE_DATA: {
      if (msg.requestId !== activeRequestId) return;
      setBarProgress(95);
      const title = msg.payload?.problem?.title ?? null;
      chrome.runtime
        .sendMessage({ type: BG_IMPORT, payload: msg.payload })
        .then((resp) => finishImport({ ...resp, title }))
        .catch((err) =>
          finishImport({ success: false, error: err?.message ?? "后台通信失败", title }),
        );
      return;
    }
    case BRIDGE_SCRAPE_ERROR:
      if (msg.requestId !== activeRequestId) return;
      finishImport({ success: false, error: msg.message });
      return;
  }
});

function finishImport(resp) {
  activeRequestId = null;
  const title = resp?.title;

  if (!resp?.success) {
    dismissBar(0);
    const reason = resp?.error ?? "未知错误";
    // Consistent with the success toast; prefix the problem title when known.
    showToast(`${title ? `${title} ` : ""}导入失败：${reason}`, "error");
    return;
  }

  setBarProgress(100);
  dismissBar(1500);

  // Summarize what actually happened — the bar reaching 100% no longer hides
  // partial outcomes (0 submissions, missing source, server-side errors).
  const imported = resp.submissions_imported ?? 0;
  const skipped = resp.submissions_skipped ?? 0;
  const warnings = Array.isArray(resp.warnings) ? [...resp.warnings] : [];
  const serverErrors = Array.isArray(resp.errors) ? resp.errors : [];
  if (serverErrors.length > 0) {
    warnings.push(`${serverErrors.length} 条提交入库失败`);
  }

  const titlePart = title || "题目";
  let headline = `成功导入 ${titlePart} 和 ${imported} 条提交`;
  if (skipped > 0) headline += `（跳过 ${skipped} 条重复）`;

  if (warnings.length > 0) {
    showToast(`${headline}\n· ${warnings.join("\n· ")}`, "warn");
  } else {
    showToast(headline, "ok");
  }
}

// One alert per user click. Cleared at the start of each new import.
let alertedThisRun = false;
function notifyOnce(msg) {
  if (alertedThisRun) return;
  alertedThisRun = true;
  alert(`ACMind Importer: ${msg}`);
}

// ---- describePage ----
const pendingDescribe = new Map();

async function describePage() {
  const ready = await waitForScraper();
  if (!ready) return null;
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    pendingDescribe.set(requestId, resolve);
    postToPage({ type: BRIDGE_DESCRIBE_PAGE_REQUEST, requestId });
    setTimeout(() => {
      if (pendingDescribe.delete(requestId)) resolve(null);
    }, SCRAPER_READY_TIMEOUT_MS);
  });
}

// ---- Start import ----
async function startImport() {
  // Re-click while a run is in progress: silently ignore.
  if (activeRequestId) return { ok: false };

  // Fresh click resets the alert budget for this run.
  alertedThisRun = false;

  const ready = await waitForScraper();
  if (!ready) {
    notifyOnce("页面解析器未就绪");
    return { ok: false };
  }

  const description = await describePage();
  if (!description || !description.mode) {
    notifyOnce("当前页面不支持导入");
    return { ok: false };
  }

  activeRequestId = crypto.randomUUID();
  lastPct = 0;
  ensureBar();
  setBarProgress(2);

  postToPage({
    type: BRIDGE_SCRAPE_REQUEST,
    requestId: activeRequestId,
    mode: description.mode,
  });
  return { ok: true };
}

// ---- Background <-> content ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === BG_DESCRIBE_PAGE) {
    describePage().then(sendResponse);
    return true;
  }
  if (msg?.type === CMD_START_IMPORT) {
    startImport().then(sendResponse);
    return true;
  }
  return false;
});
