// ACMind Importer — VJudge parser.
// Runs in page main world. Uses same-origin credentials for VJudge internal APIs.

import { defineParser } from "./base.js";

const VJUDGE_ORIGIN = "https://vjudge.net";
const PAGE_SIZE = 20;
const MAX_STATUS_PAGES = 200;

// Source-code fetching is the rate-limit-sensitive part: it hits one endpoint
// per submission. Throttle between calls and back off on 429/403 instead of
// silently dropping the code.
const SOURCE_FETCH_DELAY_MS = 300;
const MAX_SOURCE_RETRIES = 3;
const RETRY_BASE_MS = 500;

// Progress budget — parser caps at 90; content.js owns the final 90 -> 100
// so Nanobar only sees pct=100 once (at upload success) and never resets mid-flow.
//   problem statement fetch:        0  -> 10
//   listing submissions (per page): 10 -> 30
//   fetching source code (per item): 30 -> 90
const PCT_AFTER_PROBLEM = 10;
const PCT_AFTER_LISTING = 30;
const PCT_AFTER_SOURCES = 90;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Fetch helpers ----
async function fetchJSON(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    credentials: "include",
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/javascript, */*; q=0.01",
      ...(options.headers ?? {}),
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.json();
}

async function fetchText(url) {
  const resp = await fetch(url, {
    credentials: "include",
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      Accept: "text/html, */*",
    },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return resp.text();
}

// Fetch one submission's source code.
// Returns { code } on success, or { reason: "private" | "failed" } otherwise.
// Retries transient / rate-limit responses with backoff so a burst of 429s
// doesn't silently lose code (the old version swallowed every error).
async function fetchSourceCode(runId) {
  let lastStatus = 0; // 0 = network error; otherwise the last HTTP status seen
  for (let attempt = 0; attempt < MAX_SOURCE_RETRIES; attempt++) {
    let resp;
    try {
      resp = await fetch(`${VJUDGE_ORIGIN}/solution/data/${runId}?inPage=true`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json, text/javascript, */*; q=0.01",
        },
        body: "shareCode=",
      });
    } catch {
      // Network error — back off and retry.
      lastStatus = 0;
      await sleep(RETRY_BASE_MS * (attempt + 1));
      continue;
    }
    lastStatus = resp.status;

    // Rate limited / transient server error: back off harder and retry.
    if (resp.status === 429 || resp.status === 403 || resp.status >= 500) {
      await sleep(RETRY_BASE_MS * (attempt + 1) * 2);
      continue;
    }
    if (!resp.ok) return { reason: "failed" };

    let data;
    try {
      data = await resp.json();
    } catch {
      return { reason: "failed" };
    }
    if (typeof data.code === "string" && data.code.length > 0) {
      return { code: data.code };
    }
    // 200 but no code body: the solution isn't shared / not authored by us.
    return { reason: "private" };
  }
  // Exhausted retries. A persistent 403 most likely means the solution isn't
  // accessible to us (not shared / not ours) rather than a transient failure;
  // anything else (429 / 5xx / network) is treated as a retryable failure.
  return { reason: lastStatus === 403 ? "private" : "failed" };
}

// ---- HTML utilities ----
const HTML_ENTITIES = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};
const decodeEntities = (s) => s.replace(/&(?:lt|gt|amp|quot|#39|nbsp);/g, (m) => HTML_ENTITIES[m]);

function extractPageJson(html, marker) {
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) return null;
  const textareaStart = html.lastIndexOf("<textarea", markerIdx);
  if (textareaStart === -1) return null;
  const openEnd = html.indexOf(">", textareaStart) + 1;
  const closeStart = html.indexOf("</textarea>", openEnd);
  if (closeStart === -1) return null;
  try {
    return JSON.parse(decodeEntities(html.substring(openEnd, closeStart).trim()));
  } catch {
    return null;
  }
}

function extractTitle(html, sourceId) {
  const m = html.match(/<title>([^<]*)<\/title>/);
  if (!m) return sourceId;
  let t = decodeEntities(m[1]).trim();
  // VJudge renders "<title> - <OJ> <probNum> - Virtual Judge". Strip the brand
  // suffix, then the trailing " - <OJ> <probNum>" segment (note: the page uses
  // a space between OJ and number, while sourceId joins them with "-").
  t = t.replace(/\s*-\s*Virtual\s+Judge\s*$/i, "");
  const [oj, ...rest] = sourceId.split("-");
  const tail = `${oj} ${rest.join("-")}`.trim(); // e.g. "CSG 1430"
  if (tail && t.toLowerCase().endsWith(` - ${tail}`.toLowerCase())) {
    t = t.slice(0, t.length - ` - ${tail}`.length);
  }
  return t.trim() || sourceId;
}

function tablesToMarkdown(html) {
  const allRows = [];
  let headerRow = null;

  for (const tableMatch of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    for (const trMatch of tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [];
      for (const tdMatch of trMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
        const text = decodeEntities(
          tdMatch[1]
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]+>/g, ""),
        )
          .trim()
          .replace(/\n/g, "<br>");
        cells.push(text);
      }
      if (cells.length === 0) continue;

      if (headerRow !== null) {
        const isDup = cells.length === headerRow.length &&
          cells.every((c, i) => c === headerRow[i]);
        if (isDup) continue;
      }
      if (headerRow === null) headerRow = cells;
      allRows.push(cells);
    }
  }

  if (allRows.length === 0) return "";

  const colCount = allRows[0].length;
  const sep = `| ${Array(colCount).fill(":---:").join(" | ")} |`;
  const lines = [];
  allRows.forEach((row, i) => {
    while (row.length < colCount) row.push("");
    lines.push(`| ${row.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`);
    if (i === 0) lines.push(sep);
  });
  return `\n${lines.join("\n")}\n`;
}

function stripHtml(html) {
  if (!html) return "";
  return decodeEntities(
    html
      .replace(/CDN_BASE_URL\//g, "https://cdn.vjudge.net.cn/")
      // MathJax source lives in <script type="math/tex">. Preserve it as KaTeX
      // ($ / $$) delimiters before any tag stripping eats the wrapper, so the
      // frontend (remark-math + rehype-katex) can render it.
      .replace(
        /<script[^>]*math\/tex;?\s*mode=display[^>]*>([\s\S]*?)<\/script>/gi,
        (_, m) => `\n$$${m.trim()}$$\n`,
      )
      .replace(
        /<script[^>]*math\/tex[^>]*>([\s\S]*?)<\/script>/gi,
        (_, m) => `$${m.trim()}$`,
      )
      // Drop any remaining script/style outright (content and all). Otherwise the
      // generic tag strip below would leak their bodies into the statement text.
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, "![]($1)")
      .replace(/(<table[^>]*>[\s\S]*?<\/table>)+/gi, tablesToMarkdown)
      .replace(/<pre[^>]*>/gi, "\n```text\n")
      .replace(/<\/pre>/gi, "\n```\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(div|p|h[1-6]|li|section|ul|ol)>/gi, "\n")
      .replace(/<[^>]+>/gi, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---- Page info ----
// Identify the *logged-in* user. Only trust signals that reflect the current
// session — never a random /user/ link (could be a problem author / discussion
// poster) nor the globally-latest submitter.
function extractUsernameFromPage() {
  // Explicit: visiting /status?un=foo means the user is looking at foo.
  const urlParams = new URLSearchParams(window.location.search);
  const un = urlParams.get("un");
  if (un) return un;

  // Page's own user context, embedded as `"un":"..."` in inline JSON/scripts.
  for (const s of document.querySelectorAll("script")) {
    const m = (s.textContent ?? "").match(/"un"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
  }

  // Navbar account area only (not any /user/ link on the page).
  const userEl = document.querySelector(
    '[data-username], #user-menu a[href^="/user/"], .navbar a[href^="/user/"]',
  );
  if (userEl) {
    const href = userEl.getAttribute("href") ?? "";
    const m = href.match(/\/user\/([^/?]+)/);
    if (m) return m[1];
    const ds = userEl.getAttribute("data-username");
    if (ds) return ds.trim();
  }
  return null;
}

const extractSourceProblemId = () => {
  const m = window.location.pathname.match(/\/problem\/([^/?]+)/);
  return m ? decodeURIComponent(m[1]) : null;
};

async function fetchCurrentUsername() {
  const fromPage = extractUsernameFromPage();
  if (fromPage) return fromPage;

  // Fallback: the /status page sets `var username = "..."` only when logged in.
  // (We deliberately do NOT fall back to /status/data?un= — that returns the
  // globally latest submitter, which is almost never the current user.)
  try {
    const html = await fetchText(`${VJUDGE_ORIGIN}/status`);
    const m1 = html.match(/var\s+username\s*=\s*"([^"]+)"/);
    if (m1) return m1[1];
  } catch {}

  return null;
}

function parseSubmission(item) {
  const oj = item.oj ?? item.OJ ?? "";
  const probNum = item.probNum ?? item.prob_num ?? "";
  return {
    runId: item.runId ?? item.run_id,
    oj,
    probNum,
    status: item.status ?? "",
    language: item.language ?? "",
    runtime: item.runtime ?? null,
    memory: item.memory ?? null,
    time: item.time ?? 0,
    sourceProblemId: `${oj}-${probNum}`,
  };
}

function buildStatusUrl({ draw, start, un, ojId = "All", probNum = "" }) {
  const params = new URLSearchParams({
    draw: String(draw),
    start: String(start),
    length: String(PAGE_SIZE),
    un,
    OJId: ojId,
    probNum,
    res: "all",
    language: "",
    onlyFollowee: "false",
    orderBy: "run_id",
  });
  return `${VJUDGE_ORIGIN}/status/data?${params}`;
}

async function scrapeProblemMetadata(progress, baseRange = [0, PCT_AFTER_PROBLEM]) {
  const sourceProblemId = extractSourceProblemId();
  if (!sourceProblemId) throw new Error("无法从 URL 中提取问题 ID");

  const [pctStart, pctEnd] = baseRange;
  progress({ message: `获取题目 ${sourceProblemId}`, pct: pctStart });

  const html = await fetchText(`${VJUDGE_ORIGIN}/problem/${sourceProblemId}`);
  const data = extractPageJson(html, "dataJson");
  const title = extractTitle(html, sourceProblemId);
  const [oj, ...rest] = sourceProblemId.split("-");
  const probNum = rest.join("-");

  let statement = null;
  const sectionsToMarkdown = (sections) =>
    sections
      .map((sec) => {
        const head = sec.title ? `## ${sec.title}\n\n` : "";
        return head + stripHtml(sec.value?.content ?? "");
      })
      .join("\n\n");

  progress({ message: "获取题面描述", pct: Math.floor((pctStart + pctEnd) / 2) });

  if (data?.descBriefs?.[0]) {
    const desc = data.descBriefs[0];
    try {
      const descHtml = await fetchText(
        `${VJUDGE_ORIGIN}/problem/description/${desc.key}?${desc.version}`,
      );
      const descData = extractPageJson(descHtml, "data-json-container");
      if (descData?.sections) statement = sectionsToMarkdown(descData.sections);
    } catch {
      const altPath = html.match(/\/problem\/description\/\d+/);
      if (altPath) {
        try {
          const altHtml = await fetchText(`${VJUDGE_ORIGIN}${altPath[0]}`);
          const altData = extractPageJson(altHtml, "data-json-container");
          if (altData?.sections) statement = sectionsToMarkdown(altData.sections);
        } catch {}
      }
    }
  }

  progress({ pct: pctEnd });

  return {
    type: "problem-page",
    sourceProblemId,
    oj: data?.oj ?? oj,
    probNum: data?.prob ?? probNum,
    title,
    url: `${VJUDGE_ORIGIN}/problem/${sourceProblemId}`,
    statement,
    statementMissing: !statement,
    tags: data?.oj ? [data.oj] : [oj],
  };
}

async function listSubmissions({ username, ojId, probNum, progress, range }) {
  const [pctStart, pctEnd] = range;
  const items = [];

  // The /status/data OJId param is unreliable across VJudge versions (it may
  // return the full feed instead of an OJ-filtered one). So we re-filter here,
  // but normalized (case/whitespace) so formatting drift between the problem
  // page and the status feed doesn't silently drop every submission.
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  const wantOj = norm(ojId);
  const wantProb = norm(probNum);

  for (let page = 0; page < MAX_STATUS_PAGES; page++) {
    // Heuristic: assume <=3 pages on average; let the bar creep towards pctEnd
    // without committing to a hard total.
    const pct = pctStart + Math.min(pctEnd - pctStart, (pctEnd - pctStart) * (1 - 1 / (page + 1.5)));
    progress({ message: `列出提交（第 ${page + 1} 页）`, pct });

    const resp = await fetchJSON(buildStatusUrl({
      draw: page + 1,
      start: page * PAGE_SIZE,
      un: username,
      ojId,
      probNum,
    }));
    if (!Array.isArray(resp.data) || resp.data.length === 0) break;

    const parsed = resp.data.map(parseSubmission)
      .filter((it) => norm(it.oj) === wantOj && norm(it.probNum) === wantProb);
    items.push(...parsed);

    if (resp.data.length < PAGE_SIZE) break;
    await sleep(300);
  }

  progress({ pct: pctEnd });
  return items;
}

async function attachSourceCode(
  submissions,
  progress,
  warnings,
  range = [PCT_AFTER_LISTING, PCT_AFTER_SOURCES],
) {
  const [pctStart, pctEnd] = range;
  if (submissions.length === 0) {
    progress({ pct: pctEnd });
    return { withCode: 0, private: 0, failed: 0 };
  }

  let withCode = 0;
  let privateCount = 0;
  let failed = 0;

  for (let i = 0; i < submissions.length; i++) {
    const pct = pctStart + ((pctEnd - pctStart) * i) / submissions.length;
    progress({ message: `获取代码 ${i + 1}/${submissions.length}`, pct });

    const res = await fetchSourceCode(submissions[i].runId);
    if (res.code != null) {
      submissions[i].code = res.code;
      withCode++;
    } else if (res.reason === "private") {
      privateCount++;
    } else {
      failed++;
    }

    // Throttle between solution fetches to avoid tripping VJudge rate limits.
    if (i < submissions.length - 1) await sleep(SOURCE_FETCH_DELAY_MS);
  }

  if (privateCount > 0) {
    warnings.push(`${privateCount} 条提交源码不可见（私有或非本人提交）`);
  }
  if (failed > 0) {
    warnings.push(`${failed} 条提交源码抓取失败（网络或限流），可稍后重试`);
  }

  progress({ pct: pctEnd });
  return { withCode, private: privateCount, failed };
}

async function scrapeProblemFull({ progress }) {
  const warnings = [];

  const problem = await scrapeProblemMetadata(progress);
  if (problem.statementMissing) {
    warnings.push("未能解析到题面内容（VJudge 页面结构可能已变化）");
  }

  const username = await fetchCurrentUsername();
  if (!username) throw new Error("无法确定您的 VJudge 用户名，请确认已登录 VJudge");

  const submissions = await listSubmissions({
    username,
    ojId: problem.oj,
    probNum: problem.probNum,
    progress,
    range: [PCT_AFTER_PROBLEM, PCT_AFTER_LISTING],
  });
  if (submissions.length === 0) {
    warnings.push(`未找到 ${username} 在本题的提交记录`);
  }

  const sourceStats = await attachSourceCode(submissions, progress, warnings);

  return {
    type: "problem-full",
    problem,
    submissions,
    warnings,
    stats: { submissions: submissions.length, ...sourceStats },
  };
}

export default defineParser({
  name: "vjudge",
  displayName: "VJudge",
  matches: (url) => /^https?:\/\/vjudge\.net\//.test(url),
  detectPageType: (url) => {
    if (/\/problem\//.test(url)) return "problem";
    if (/\/solution\//.test(url)) return "solution";
    if (/\/status/.test(url)) return "status";
    return "other";
  },
  pickMode: (pageType) => (pageType === "problem" ? "problem-full" : null),
  modes: {
    "problem-full": {
      label: "题目 + 全部提交",
      scrape: scrapeProblemFull,
    },
  },
});
