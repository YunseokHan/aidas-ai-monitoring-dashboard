"use strict";

// =====================================================================
// Static GitHub Pages build of the AIDAS monitoring dashboard.
// Instead of hitting a live backend (/api/*), it reads ONE static
// snapshot file (./data/dashboard.json) that the central server
// publishes periodically (see publish.py). All rendering below is
// identical to the live dashboard.
// =====================================================================

// ---- helpers --------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function fmt(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}
const fmtFull = (n) => (n || 0).toLocaleString();
function ago(ms) {
  if (!ms) return "—";
  const s = (Date.now() - ms) / 1000;
  if (s < 0) return "방금";
  if (s < 60) return Math.floor(s) + "초 전";
  if (s < 3600) return Math.floor(s / 60) + "분 전";
  if (s < 86400) return Math.floor(s / 3600) + "시간 전";
  return Math.floor(s / 86400) + "일 전";
}
function dt(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("ko-KR", { hour12: false });
}
function dur(a, b) {
  if (!a || !b) return "—";
  let s = Math.max(0, (b - a) / 1000);
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  return (h ? h + "시간 " : "") + m + "분";
}
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function pctClass(pct) {
  if (pct >= 90) return "crit";
  if (pct >= 70) return "warn";
  return "";
}

// ---- static data source ---------------------------------------------------
// The whole dashboard is driven by one JSON snapshot. api() is a thin shim so
// the rest of the code reads exactly like the live version did.
const DATA_URL = "./data/dashboard.json";
let BUNDLE = null;

async function loadBundle() {
  const res = await fetch(DATA_URL + "?t=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error("dashboard.json -> " + res.status);
  BUNDLE = await res.json();
  return BUNDLE;
}

async function api(path) {
  if (!BUNDLE) await loadBundle();
  if (path === "/api/summary") return BUNDLE.summary || {};
  if (path === "/api/sessions") return { sessions: BUNDLE.sessions || [] };
  if (path === "/api/alerts") return { alerts: BUNDLE.alerts || [] };
  if (path === "/api/config") return BUNDLE.config || {};
  if (path.indexOf("/api/usage/timeseries") === 0) {
    const w = (path.split("window=")[1] || "1d").split("&")[0];
    return (BUNDLE.timeseries && BUNDLE.timeseries[w]) || { window: w, bucket: 60, series: {} };
  }
  throw new Error("no static data for " + path);
}

// ---- tooltip (cursor-following; works on masked donuts & inside scroll areas) ----
let _tipEl = null;
function _ensureTip() {
  if (!_tipEl) { _tipEl = document.createElement("div"); _tipEl.className = "tip"; document.body.appendChild(_tipEl); }
  return _tipEl;
}
function _moveTip(e) {
  const t = _tipEl; if (!t) return;
  let x = e.clientX + 14, y = e.clientY + 16;
  const r = t.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 12;
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 12;
  t.style.left = x + "px"; t.style.top = y + "px";
}
function setupTooltip() {
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest("[data-tip]");
    if (!el) return;
    const t = _ensureTip();
    t.textContent = el.getAttribute("data-tip");
    t.style.display = "block";
    _moveTip(e);
  });
  document.addEventListener("mousemove", (e) => {
    if (_tipEl && _tipEl.style.display === "block") _moveTip(e);
  });
  document.addEventListener("mouseout", (e) => {
    if (e.target.closest("[data-tip]") && _tipEl) _tipEl.style.display = "none";
  });
}

// ---- state ----------------------------------------------------------------
const state = {
  tab: "overview",
  metric: "total",
  summary: null,
  sessions: [],
  timer: null,
  chart: null,
};

// ---- tabs -----------------------------------------------------------------
function switchTab(name) {
  state.tab = name;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.toggle("hidden", p.id !== "tab-" + name));
  render();
}

// ---- overview -------------------------------------------------------------
function renderTotals(s) {
  const m = state.metric;
  const row = $("#totalsRow");
  const cards = [];
  cards.push(`<div class="totalcard"><div class="label">라이브 세션</div>
    <div class="value">${s.live_session_count}</div>
    <div class="small">프로세스 실행 중</div></div>`);
  for (const w of s.windows) {
    const t = s.totals[w] || {};
    cards.push(`<div class="totalcard"><div class="label">전체 합계 · ${w} · ${m}</div>
      <div class="value">${fmt(t[m])}</div>
      <div class="small">${fmtFull(t[m])} 토큰 · 메시지 ${fmtFull(t.messages)}</div></div>`);
  }
  row.innerHTML = cards.join("");
}

const RL_LABEL = {
  five_hour: "5시간", seven_day: "주간 (전체)",
  seven_day_opus: "주간 (Opus)", seven_day_sonnet: "주간 (Sonnet)",
};
function shortReset(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("ko-KR",
      { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch (e) { return ""; }
}
// nodes (sender --host) this account has been seen on; live ones marked
function nodesHTML(a) {
  const hosts = a.hosts || [];
  const live = new Set(a.live_hosts || []);
  if (!hosts.length) return '<span class="hint">아직 없음</span>';
  return hosts.map((h) =>
    `<span class="chip ${live.has(h) ? "nodelive" : ""}">${esc(h)}${live.has(h) ? " ●" : ""}</span>`).join(" ");
}

// gauge for a REAL utilization threshold (value & limit are percentages 0-100)
function gaugeHTML(th) {
  const label = RL_LABEL[th.window] || th.window;
  if (!th.available || th.value == null) {
    return `<div class="gauge"><div class="gauge-top">
        <span class="w">${label} <span class="hint">한도 ${th.limit}%</span></span>
        <span class="v hint">데이터 없음</span></div>
      <div class="bar"><span style="width:0%"></span></div></div>`;
  }
  const val = th.value;
  const cls = val >= th.limit ? "crit" : (val >= th.limit * 0.75 ? "warn" : "");
  const reset = th.resets_at ? `리셋 ${shortReset(th.resets_at)}` : "";
  return `<div class="gauge">
    <div class="gauge-top"><span class="w">${label} <span class="hint">경고 ${th.limit}%</span></span>
      <span class="v">${val.toFixed(0)}%</span></div>
    <div class="bar"><span class="${cls}" style="width:${Math.min(100, val)}%"></span>
      <i class="limitmark" style="left:${Math.min(100, th.limit)}%"></i></div>
    <div class="meta"><span>${val.toFixed(1)}% 사용</span><span>${reset}</span></div>
  </div>`;
}

function renderAccounts(s) {
  const m = state.metric;
  const box = $("#accounts");
  if (!s.accounts.length) {
    box.innerHTML = `<div class="empty">아직 수집된 계정 데이터가 없습니다.</div>`;
    return;
  }
  box.innerHTML = s.accounts.map((a) => {
    const breach = a.thresholds.some((t) => t.breached);
    const hasRL = a.rate_limits && (a.rate_limits.five_hour || a.rate_limits.seven_day);
    const gauges = a.thresholds.length
      ? a.thresholds.map(gaugeHTML).join("")
      : `<div class="nolimit">설정된 한도 임계치가 없습니다.</div>`;
    const src = !hasRL ? "실제 사용량 데이터 없음 (아직 수집 전이거나 미사용)"
      : (a.rate_limits.source === "claude_oauth"
          ? `실제 한도 · Anthropic usage API · ${ago(a.usage_updated_at)}`
          : `실제 한도 · Codex rollout 기준 · ${ago(a.usage_updated_at)}`);
    const tok = s.windows.map((w) =>
      `<span class="tokchip">${w} ${fmt(a.windows[w][m])}</span>`).join("");
    return `<div class="card ${breach ? "breach" : ""}">
      <div class="acct-head">
        <span class="email">${esc(a.email)}</span>
        ${breach ? '<span class="tag" style="color:var(--red)">한도 임박</span>' : ""}
      </div>
      <div class="chips">
        <span class="chip prov ${esc(a.provider || "claude")}">${esc(a.provider || "claude")}</span>
        ${a.rate_limit_tier ? `<span class="chip">${esc(a.rate_limit_tier)}</span>` : ""}
        ${a.org_type ? `<span class="chip max">${esc(a.org_type)}</span>` : ""}
      </div>
      <div class="nodes">노드: ${nodesHTML(a)}</div>
      <div class="usagehead">실제 사용 한도</div>
      <div>${gauges}</div>
      <div class="src">${src}</div>
      <div class="tokrow">참고 토큰량 (${m}): ${tok} · 누적 ${fmt(a.lifetime[m])}</div>
    </div>`;
  }).join("");
}

function renderBanner(s) {
  const breaches = [];
  for (const a of s.accounts)
    for (const t of a.thresholds)
      if (t.breached) breaches.push(`${a.email} · ${RL_LABEL[t.window] || t.window} ${(t.value || 0).toFixed(0)}% ≥ ${t.limit}%`);
  const b = $("#breachBanner");
  if (breaches.length) {
    b.classList.remove("hidden");
    b.textContent = "⚠ 한도 초과: " + breaches.join("  |  ");
  } else b.classList.add("hidden");
}

// ---- live + sessions ------------------------------------------------------
// small pie showing what % of the real 5h/weekly limit this session used
function donut(pct, label) {
  if (pct == null)
    return `<span class="donut none" data-tip="${label} 한도: 데이터 없음"></span>`;
  const c = pct >= 60 ? "var(--red)" : (pct >= 40 ? "var(--yellow)" : "var(--green)");
  const p = Math.max(0, Math.min(100, pct));
  return `<span class="donut" style="--p:${p};--c:${c}" `
    + `data-tip="${label} 한도의 ${pct.toFixed(2)}% 를 이 세션이 사용 (추정)"></span>`;
}

function sessionRows(list) {
  if (!list.length) return `<div class="empty">표시할 세션이 없습니다.</div>`;
  const m = state.metric;
  const rows = list.map((x) => {
    const dotCls = x.live ? (x.status === "busy" ? "live" : "idle") : "ended";
    const statusTag = x.live
      ? `<span class="tag ${x.status === "busy" ? "busy" : "idle"}">${x.status || "live"}</span>`
      : `<span class="tag">ended</span>`;
    const sid = x.session_id ? x.session_id.slice(0, 8) : "—";
    const dir = x.cwd || "—";
    return `<tr>
      <td><span class="dot ${dotCls}"></span>${statusTag}</td>
      <td class="sesscell" data-tip="${esc(x.cwd || "")}\n세션 ${esc(x.session_id || "")}">
        <div class="dir">${esc(dir)}</div>
        <div class="sid">${esc(sid)}</div>
      </td>
      <td><span class="tag prov ${esc(x.provider || "claude")}">${esc(x.provider || "claude")}</span> ${esc(x.account_email || "—")}</td>
      <td>${esc(x.host || "—")}</td>
      <td class="num tokcell">${fmt(x.metrics[m])}<span class="donuts">${donut(x.share_5h, "5시간")}${donut(x.share_7d, "주간")}</span></td>
      <td class="num">${fmtFull(x.messages)}</td>
      <td>${(x.models || []).map((md) => `<span class="tag">${esc(md)}</span>`).join(" ") || "—"}</td>
      <td>${ago(x.updated_at || x.last_ts)}</td>
      <td>${dur(x.started_at || x.first_ts, x.updated_at || x.last_ts)}</td>
    </tr>`;
  }).join("");
  return `<table><thead><tr>
    <th>상태</th><th>세션 · 디렉토리</th><th>계정</th><th>호스트</th>
    <th class="num">${m}</th><th class="num">메시지</th><th>모델</th><th>최근활동</th><th>지속</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

function renderLive() {
  const live = state.sessions.filter((s) => s.live);
  $("#liveSessions").innerHTML = sessionRows(live);
}
function renderSessions() {
  const q = ($("#sessionFilter").value || "").toLowerCase();
  const list = state.sessions.filter((s) =>
    !q || [s.project, s.session_id, s.account_email, s.cwd, s.host]
      .some((v) => (v || "").toLowerCase().includes(q)));
  $("#sessionsTable").innerHTML = sessionRows(list);
}

// ---- charts ---------------------------------------------------------------
async function renderCharts() {
  const w = $("#chartWindow").value;
  const data = await api(`/api/usage/timeseries?window=${w}`);
  const m = state.metric;
  const accounts = Object.keys(data.series);
  const buckets = new Set();
  accounts.forEach((a) => data.series[a].forEach((p) => buckets.add(p.t)));
  const labels = Array.from(buckets).sort((a, b) => a - b);
  const palette = ["#4493f8", "#3fb950", "#d2a8ff", "#d29922", "#f85149", "#39c5cf"];
  const datasets = accounts.map((a, i) => {
    const map = {};
    data.series[a].forEach((p) => (map[p.t] = p[m]));
    return {
      label: a,
      data: labels.map((t) => map[t] || 0),
      borderColor: palette[i % palette.length],
      backgroundColor: palette[i % palette.length] + "33",
      fill: true, tension: 0.25, pointRadius: 0, borderWidth: 2,
    };
  });
  const ctx = $("#usageChart");
  if (state.chart) state.chart.destroy();
  state.chart = new Chart(ctx, {
    type: "line",
    data: { labels: labels.map((t) => new Date(t).toLocaleString("ko-KR", { hour12: false })), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#e6edf3" } },
        title: { display: true, text: `${m} 사용량 · 호스트별 (버킷 ${Math.round(data.bucket / 60)}분)`, color: "#8b949e" },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmtFull(c.raw)}` } },
      },
      scales: {
        x: { ticks: { color: "#8b949e", maxTicksLimit: 12 }, grid: { color: "#2a3140" } },
        y: { ticks: { color: "#8b949e", callback: (v) => fmt(v) }, grid: { color: "#2a3140" }, beginAtZero: true },
      },
    },
  });
}

// ---- alerts ---------------------------------------------------------------
async function renderAlerts() {
  const data = await api("/api/alerts");
  const s = state.summary;
  if (s) $("#notifierInfo").textContent =
    `활성 채널: ${(s.notifiers || []).join(", ")}` + (s.email_enabled ? "" : " · 이메일 비활성");
  const rows = data.alerts.map((a) => `<tr>
    <td>${dt(a.ts)}</td><td>${esc(a.account)}</td><td>${esc(RL_LABEL[a.window] || a.window)}</td>
    <td class="num">${a.value}%</td><td class="num">${a.limit_value}%</td>
    <td>${esc(a.name)}</td></tr>`).join("");
  $("#alertsTable").innerHTML = data.alerts.length
    ? `<table><thead><tr><th>시각</th><th>계정</th><th>윈도우</th>
        <th class="num">사용률</th><th class="num">경고선</th><th>이름</th></tr></thead>
       <tbody>${rows}</tbody></table>`
    : `<div class="empty">발생한 알림이 없습니다.</div>`;
}

// ---- settings (read-only) -------------------------------------------------
async function renderSettings() {
  const cfg = await api("/api/config");

  const tr = (cfg.tracking || {}).allowed_accounts || [];
  $("#trackingInfo").innerHTML = tr.length
    ? `<div class="kv"><span class="k">추적 계정</span> ${tr.map(esc).join(", ")}</div>
       <p class="hint">이 목록의 계정만 추적합니다. (빈 목록이면 전체) 변경은 중앙
       <code>config.json</code>의 <code>tracking.allowed_accounts</code>에서.</p>`
    : `<div class="kv">전체 계정 추적 중 (allowlist 비어 있음)</div>`;

  const ths = (cfg.alerts || {}).thresholds || [];
  const rows = ths.map((t) =>
    `<div class="kv"><span class="k">${RL_LABEL[t.window] || t.window}</span> `
    + `사용률 ${t.limit}% 도달 시 알림 · 쿨다운 ${t.cooldown_minutes != null ? t.cooldown_minutes : 30}분</div>`).join("");
  $("#alertInfo").innerHTML =
    (rows || '<div class="kv">설정된 알림이 없습니다.</div>')
    + `<p class="hint">알림은 <b>실제 사용률(%)</b> 기준입니다. 경고 수준(%)은 중앙
       <code>config.json</code>의 <code>alerts.thresholds[].limit</code>에서 변경.
       (알림 발송 자체는 중앙 서버에서 동작 — 이 페이지는 읽기 전용)</p>`;

  const e = cfg.email || {};
  $("#emailStatus").innerHTML = `
    <div class="kv"><span class="k">상태</span> ${e.enabled ? "✅ 활성" : "⛔ 비활성"}</div>
    <div class="kv"><span class="k">SMTP</span> ${esc(e.smtp_host)}:${esc(e.smtp_port)}</div>
    <div class="kv"><span class="k">발신/수신</span> ${esc(e.from)} → ${esc((e.to || []).join(", "))}</div>`;

  const c = cfg.collect || {};
  $("#collectInfo").innerHTML = `
    <div class="kv"><span class="k">수집 주기</span> ${esc(c.interval_seconds)}초</div>
    <div class="kv"><span class="k">Claude dirs</span> ${esc((c.config_dirs || []).join(", "))}</div>
    <div class="kv"><span class="k">Codex dirs</span> ${esc((c.codex_dirs || []).join(", ")) || "-"}</div>
    <div class="kv"><span class="k">NAS 수집</span> ${(cfg.nas || {}).enabled ? esc((cfg.nas || {}).dropdir) : "비활성"}</div>`;
}

// ---- render (uses already-loaded BUNDLE) ----------------------------------
async function render() {
  const s = await api("/api/summary");
  state.summary = s;
  state.metric = $("#metricSelect").value;
  $("#hostline").textContent = `중앙: ${s.host} · Claude/Codex 토큰 사용량 추적`;
  $("#liveBadge").textContent = s.live_session_count;
  renderBanner(s);

  if (state.tab === "overview") { renderTotals(s); renderAccounts(s); }
  if (state.tab === "live" || state.tab === "sessions") {
    const d = await api("/api/sessions");
    state.sessions = d.sessions;
    if (state.tab === "live") renderLive(); else renderSessions();
  }
  if (state.tab === "charts") await renderCharts();
  if (state.tab === "alerts") await renderAlerts();
  if (state.tab === "settings") await renderSettings();
}

// ---- refresh: reload the snapshot, then render ----------------------------
async function refresh() {
  try {
    await loadBundle();
    const gen = BUNDLE.generated_at;
    $("#updated").textContent = "데이터 기준 "
      + new Date(gen).toLocaleString("ko-KR", { hour12: false }) + ` (${ago(gen)})`;
    await render();
  } catch (e) {
    console.error(e);
    $("#updated").textContent = "데이터 로드 실패 (아직 publish 전?)";
  }
}

function setupAutoRefresh() {
  if (state.timer) clearInterval(state.timer);
  if ($("#autoRefresh").checked) state.timer = setInterval(refresh, 30000);
}

// ---- wire up --------------------------------------------------------------
window.addEventListener("DOMContentLoaded", () => {
  $$(".tab").forEach((t) => t.onclick = () => switchTab(t.dataset.tab));
  $("#refreshBtn").onclick = refresh;
  $("#metricSelect").onchange = () => { state.metric = $("#metricSelect").value; render(); };
  $("#autoRefresh").onchange = setupAutoRefresh;
  $("#chartWindow").onchange = renderCharts;
  $("#sessionFilter").oninput = renderSessions;
  setupTooltip();
  setupAutoRefresh();
  refresh();
});
