// ACMind Importer — Background.
// Receives scraped payloads from the content script and POSTs to ACMind API.
// Owns the toolbar icon: clicking it kicks off an import in the active tab.

import {
  BG_IMPORT,
  BG_CHECK_CONNECTION,
  BG_GET_TOKEN_STATUS,
  BG_DESCRIBE_PAGE,
  CMD_START_IMPORT,
} from "./protocol.js";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const CONNECTION_CACHE_MS = 5000;
const HEALTH_TIMEOUT_MS = 5000;
const IMPORT_TIMEOUT_MS = 30000;
const BROADCAST_INTERVAL_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Marks an error that retrying cannot fix (auth failure, 4xx). The retry loop
// rethrows it immediately instead of burning all attempts.
class FatalImportError extends Error {}

let acmindAvailable = false;
let lastCheck = 0;

async function getSettings() {
  const { apiUrl = "", token = "" } = await chrome.storage.local.get(["apiUrl", "token"]);
  return {
    apiUrl: apiUrl.replace(/\/+$/, ""),
    token,
  };
}

async function checkAcmindAvailable(force = false) {
  const now = Date.now();
  if (!force && now - lastCheck < CONNECTION_CACHE_MS) return acmindAvailable;
  lastCheck = now;

  const { apiUrl } = await getSettings();
  if (!apiUrl) {
    acmindAvailable = false;
    return false;
  }
  try {
    const resp = await fetch(`${apiUrl}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    acmindAvailable = resp.ok;
  } catch {
    acmindAvailable = false;
  }
  return acmindAvailable;
}

async function postToAcmind(endpoint, data, retries = MAX_RETRIES) {
  const { apiUrl, token } = await getSettings();
  if (!apiUrl) throw new Error("ACMind API URL 未配置（请在扩展设置中填写）");
  if (!token) throw new Error("JWT Token 未配置（请先访问 ACMind 完成登录）");

  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetch(`${apiUrl}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
      });
      if (resp.ok) {
        const result = await resp.json().catch(() => ({}));
        return { success: true, ...result };
      }
      // Auth / client errors won't be fixed by retrying — fail fast.
      if (resp.status === 401) {
        throw new FatalImportError("认证失败，JWT Token 可能已过期，请重新登录 ACMind");
      }
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
        const body = await resp.text().catch(() => "");
        throw new FatalImportError(`请求被拒绝（${resp.status}）：${body || "未知原因"}`);
      }
      // 429 (rate limited) / 5xx: transient, fall through to retry.
      lastError = new Error(`服务器错误: ${resp.status}`);
    } catch (err) {
      if (err instanceof FatalImportError) throw err;
      lastError = err; // network error / timeout — retryable
    }
    if (attempt < retries - 1) await sleep(RETRY_DELAY_MS * (attempt + 1));
  }
  throw lastError;
}

const importers = {
  "problem-full": async (payload) => {
    const data = {
      source_problem_id: payload.problem.sourceProblemId,
      oj: payload.problem.oj,
      prob_num: payload.problem.probNum,
      title: payload.problem.title,
      url: payload.problem.url,
      statement: payload.problem.statement,
      tags: payload.problem.tags,
      submissions: payload.submissions.map((sub) => ({
        oj: sub.oj,
        prob_num: sub.probNum,
        status: sub.status,
        language: sub.language,
        code: sub.code ?? null,
        run_id: sub.runId != null ? String(sub.runId) : null,
        runtime: sub.runtime != null ? String(sub.runtime) : null,
        memory: sub.memory != null ? String(sub.memory) : null,
        submit_time: sub.time ? String(sub.time) : null,
      })),
    };
    const resp = await postToAcmind("/api/v1/import/vjudge/problem-full", data);
    return {
      success: true,
      problem_id: resp.problem_id,
      submissions_imported: resp.submissions_imported,
      submissions_skipped: resp.submissions_skipped,
      errors: resp.errors,
      // Carry the scraper's own warnings/stats through to the page so the user
      // sees partial-success detail (missing source code, empty statement, …).
      warnings: payload.warnings ?? [],
      stats: payload.stats ?? null,
    };
  },
};

async function handleImport(payload) {
  const fn = importers[payload.type];
  if (!fn) throw new Error(`未知的导入类型: ${payload.type}`);
  return fn(payload);
}

// ---- Badge / icon state ----
//
// Three visual states on the toolbar icon:
//   green dot  — backend reachable AND parser matches current tab
//   gray dot   — backend reachable but no parser for this tab
//   red dot    — backend unreachable

async function updateBadgeFor(tabId) {
  let pageInfo = null;
  try {
    pageInfo = await chrome.tabs.sendMessage(tabId, { type: BG_DESCRIBE_PAGE });
  } catch {
    // Content script not injected (e.g., chrome:// page).
  }

  let color;
  let text;
  let title;
  if (!acmindAvailable) {
    color = "#f87171";
    text = "•";
    title = "ACMind 后端未连接";
  } else if (pageInfo?.mode) {
    color = "#4ade80";
    text = "•";
    title = `ACMind Importer — 点击导入 ${pageInfo.displayName} · ${pageInfo.modeLabel}`;
  } else {
    color = "#6b7280";
    text = "";
    title = "ACMind Importer — 此页面不支持导入";
  }

  await chrome.action.setBadgeBackgroundColor({ color, tabId });
  await chrome.action.setBadgeText({ text, tabId });
  await chrome.action.setTitle({ title, tabId });
}

async function updateAllBadges() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id != null) updateBadgeFor(tab.id).catch(() => {});
  }
}

// ---- Toolbar click -> start import in the active tab ----
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null) return;
  if (!acmindAvailable) await checkAcmindAvailable(true);
  if (!acmindAvailable) {
    await chrome.action.setTitle({ tabId: tab.id, title: "ACMind 后端未连接，请检查设置" });
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: CMD_START_IMPORT });
  } catch {
    // Content script not present on this page (e.g. chrome://). Nothing to do.
  }
});

// ---- Message handlers ----
const handlers = {
  [BG_IMPORT]: (msg) => handleImport(msg.payload),
  [BG_CHECK_CONNECTION]: async () => ({ available: await checkAcmindAvailable(true) }),
  [BG_GET_TOKEN_STATUS]: async () => {
    const { apiUrl, token } = await getSettings();
    return { hasToken: !!token, apiUrl };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = handlers[msg.type];
  if (!fn) return false;
  Promise.resolve(fn(msg))
    .then((result) => {
      sendResponse(result);
      if (msg.type === BG_CHECK_CONNECTION) updateAllBadges();
    })
    .catch((err) => sendResponse({ success: false, error: err?.message ?? String(err) }));
  return true;
});

// ---- Refresh badge when navigation / activation changes the relevant tab ----
chrome.tabs.onActivated.addListener(({ tabId }) => updateBadgeFor(tabId).catch(() => {}));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") updateBadgeFor(tabId).catch(() => {});
});

// ---- Periodic connection check ----
setInterval(async () => {
  const wasAvailable = acmindAvailable;
  await checkAcmindAvailable(true);
  if (wasAvailable !== acmindAvailable) updateAllBadges();
}, BROADCAST_INTERVAL_MS);

// Initial check on startup.
checkAcmindAvailable(true).then(() => updateAllBadges());

console.log("[ACMind] 后台脚本已启动");
