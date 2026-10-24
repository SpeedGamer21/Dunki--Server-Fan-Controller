const FAN_COUNT = 4;
const POLL_MS = 5000;
const REQUEST_TIMEOUT_MS = 4000;
const MAX_LOG_LINES = 300;
const STORAGE_KEY = "fanApiBase";
const THEME_KEY = "fanTheme";  // also read by the inline script in index.html
const THEMES = ["redline", "amber", "nitro", "daylight", "typer"];
const GAUGE_MAX_C = 80;
const REDLINE_PCT = 85;
const SHIFT_LEDS = 10;
const VTEC_PCT = 70;  // VTEC lamp (Type R theme) lights above this PWM output
const CHART_FONT = "Rajdhani, system-ui, sans-serif";

const defaultCurve = [
  {temp:20,speed:0},{temp:28,speed:45},{temp:35,speed:55},
  {temp:50,speed:70},{temp:65,speed:85},{temp:80,speed:100}
];
const copyCurve = c => c.map(p => ({...p}));

const el = id => document.getElementById(id);

// localStorage can throw in private windows or when site data is blocked.
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
};

let apiBase = normalizeBase(storage.get(STORAGE_KEY) || "");
let state = null;
let online = null;          // null = not checked yet
let inFlight = false;
let pollTimer = null;
let curveDirty = false;     // local curve edits not yet saved
let settingsDirty = false;  // user is editing the warning threshold
let dragging = null;        // the curve point object being dragged

// ---------- Logging ----------
// level: "info" | "ok" | "warn" | "error"
function log(msg, level = "info") {
  const line = document.createElement("div");
  line.className = `log-line ${level}`;
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString();
  line.append(time, msg);
  const box = el("log");
  box.prepend(line);
  while (box.childElementCount > MAX_LOG_LINES) box.lastElementChild.remove();
}

// ---------- Helpers ----------
function normalizeBase(raw) {
  let url = (raw || "").trim();
  if (!url) return "";
  // Without a scheme, fetch() would resolve "192.168.1.5" relative to the nginx host.
  if (!/^https?:\/\//i.test(url)) url = "http://" + url;
  return url.replace(/\/+$/, "");
}

function formatUptime(ms) {
  if (ms == null) return "--";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

// Returns [label, bars 0–4]
function rssiQuality(rssi) {
  if (rssi == null) return ["", 0];
  if (rssi >= -55) return ["Excellent", 4];
  if (rssi >= -67) return ["Good", 3];
  if (rssi >= -75) return ["Fair", 2];
  return ["Weak", 1];
}

// Point on the gauge arc (center 50,52, radius r) at fraction f of the sweep.
function gaugePoint(f, r) {
  const a = Math.PI * (1 - f);
  return [50 + r * Math.cos(a), 52 - r * Math.sin(a)];
}

// Same interpolation as speedFromCurve() in the firmware.
function speedAt(temp, curve) {
  const pts = curve.slice().sort((a, b) => a.temp - b.temp);
  if (temp <= pts[0].temp) return pts[0].speed;
  const last = pts[pts.length - 1];
  if (temp >= last.temp) return last.speed;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (temp >= a.temp && temp <= b.temp) {
      const span = b.temp - a.temp;
      if (span <= 0.01) return b.speed;
      return Math.round(a.speed + (temp - a.temp) / span * (b.speed - a.speed));
    }
  }
  return 0;
}

// ---------- API ----------
async function api(path, options = {}, base = apiBase) {
  if (!base) throw new Error("Set the ESP8266 API URL first");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(base + path, {
      ...options,
      signal: ctrl.signal,
      headers: {"Content-Type":"application/json", ...(options.headers || {})}
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ? `${res.status}: ${body.error}` : `${res.status} ${res.statusText}`);
    }
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    if (e instanceof TypeError) throw new Error("Network error (device unreachable, CORS, or mixed content)");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Server responses replace state, but must not clobber curves the user is editing.
function applyServerState(next) {
  if (state && (curveDirty || dragging)) {
    next.globalCurve = state.globalCurve;
    next.fanCurves = state.fanCurves;
  }
  state = next;
  render();
}

function setConnected(ok, detail) {
  document.body.classList.toggle("offline", !ok);
  el("connectionBadge").textContent = ok ? "Online" : "Offline";
  el("connectionBadge").className = ok ? "lamp ok" : "lamp bad";
  if (!ok) el("wifiState").textContent = "Unreachable";
  if (ok !== online) {
    if (ok) log(`Connected to ${apiBase}`, "ok");
    else log(`${online ? "Connection lost" : "Cannot reach device"}: ${detail}`, "error");
  }
  online = ok;
  el("statusText").textContent = ok ? `Connected to ${apiBase}` : `Connection failed: ${detail}`;
}

async function refresh() {
  if (inFlight || !apiBase) return;
  inFlight = true;
  try {
    applyServerState(await api("/api/status"));
    setConnected(true);
    el("lastUpdated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    setConnected(false, e.message);
  } finally {
    inFlight = false;
  }
}

async function postConfig(body, okMsg) {
  if (!state) { log("Not connected yet; nothing saved.", "warn"); return false; }
  try {
    const next = await api("/api/config", {method:"POST", body:JSON.stringify(body)});
    if ("globalCurve" in body || "fanCurves" in body) setCurveDirty(false);
    applyServerState(next);
    log(okMsg, "ok");
    return true;
  } catch (e) {
    log("Save failed: " + e.message, "error");
    return false;
  }
}

function saveCurves() {
  postConfig({
    useGlobalCurve: el("useGlobal").checked,
    globalCurve: state?.globalCurve,
    fanCurves: state?.fanCurves
  }, "Curves saved");
}

async function saveSettings() {
  const warningTempC = Number(el("warningTemp").value);
  if (el("warningTemp").value === "" || !Number.isFinite(warningTempC) || warningTempC < 0 || warningTempC > 100) {
    log("Warning threshold must be a number from 0 to 100 °C.", "warn");
    el("warningTemp").focus();
    return;
  }
  // The device never returns the stored webhook URL, so a blank field means "keep it".
  const body = {warningTempC};
  const url = el("webhookUrl").value.trim();
  if (url) {
    if (!/^http:\/\//i.test(url)) {
      log("Webhook must start with http:// (the ESP8266 firmware has no TLS client).", "warn");
      el("webhookUrl").focus();
      return;
    }
    body.webhookUrl = url;
  }
  settingsDirty = false;
  if (await postConfig(body, "Alert settings saved")) el("webhookUrl").value = "";
}

async function setFan(id, enabled, input) {
  input.disabled = true;
  try {
    applyServerState(await api("/api/fan", {method:"POST", body:JSON.stringify({id, enabled})}));
    log(`Fan ${id + 1} turned ${enabled ? "on" : "off"}`, "ok");
  } catch (e) {
    input.checked = !enabled;
    log("Fan command failed: " + e.message, "error");
  } finally {
    input.disabled = false;
  }
}

// ---------- Rendering ----------
const fanEls = [];

function fanGlyph() {
  return `<svg class="fan-svg" viewBox="-50 -50 100 100" aria-hidden="true"><use href="#fan-glyph" x="-50" y="-50" width="100" height="100"/></svg>`;
}

// ---------- Tachometer ----------
// Like a car tach: 0% sits at -135° (about 7 o'clock), 100% at +135° (about 5 o'clock).
const tachAngle = v => -135 + 270 * Math.max(0, Math.min(100, v)) / 100;

function polar(r, deg) {
  const a = deg * Math.PI / 180;
  return [(100 + r * Math.sin(a)).toFixed(2), (100 - r * Math.cos(a)).toFixed(2)];
}

function arcPath(r, from, to) {
  const [x1, y1] = polar(r, tachAngle(from)), [x2, y2] = polar(r, tachAngle(to));
  const large = (to - from) * 2.7 > 180 ? 1 : 0;
  return `M${x1} ${y1}A${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

function tachSvg(i) {
  let ticks = "", nums = "";
  for (let v = 0; v <= 100; v += 5) {
    const major = v % 10 === 0, red = v >= REDLINE_PCT ? "red" : "";
    const [x1, y1] = polar(83, tachAngle(v)), [x2, y2] = polar(major ? 71 : 77, tachAngle(v));
    ticks += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${major ? "major " : ""}${red}"/>`;
    if (major) {
      const [tx, ty] = polar(60, tachAngle(v));
      nums += `<text x="${tx}" y="${ty}" class="${red}">${v / 10}</text>`;
    }
  }
  // pathLength=100 on the progress arc lets JS set its fill as a plain percentage.
  return `<svg class="tach" viewBox="0 0 200 200" role="img" aria-label="Fan ${i + 1} PWM output gauge">
    <circle class="tach-face" cx="100" cy="100" r="92"/>
    <circle cx="100" cy="100" r="92" fill="url(#face-shade)"/>
    <circle class="tach-bezel" cx="100" cy="100" r="95"/>
    <path class="tach-redzone" d="${arcPath(79, REDLINE_PCT, 100)}"/>
    <path class="tach-progress" d="${arcPath(88, 0, 100)}" pathLength="100"/>
    <g class="tach-ticks">${ticks}</g>
    <g class="tach-nums">${nums}</g>
    <text class="tach-unit" x="100" y="74">×10 % PWM</text>
    <path class="tach-target" d="M100 19 95 9h10Z"/>
    <path class="tach-needle" d="M97 100 99.3 26h1.4L103 100l-1.5 16h-3Z"/>
    <circle class="tach-hub" cx="100" cy="100" r="9"/>
    <text class="tach-readout" x="100" y="166">--</text>
    <text class="tach-label" x="100" y="180">PWM OUT</text>
  </svg>`;
}

// Startup sweep like a car cluster: peg every needle, then settle on the live value.
let sweepDone = false;
function needleSweep() {
  // Double rAF so the cards' initial -135° is painted before the transition starts.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fanEls.forEach(e => { e.needle.style.rotate = `${tachAngle(100)}deg`; });
    setTimeout(() => {
      sweepDone = true;
      fanEls.forEach(e => { e.needle.style.rotate = `${tachAngle(e.pwmOut ?? 0)}deg`; });
    }, 800);
  }));
}

function buildFans() {
  const fansBox = el("fans");
  const overview = el("fanOverview");
  for (let i = 0; i < FAN_COUNT; i++) {
    const card = document.createElement("article");
    card.className = "fan-card";
    card.style.setProperty("--i", i);
    card.innerHTML = `
      <div class="fan-head">
        ${fanGlyph()}
        <span class="fan-name">Fan ${i + 1}</span>
        <span class="lamp" data-f="lamp">Off</span>
      </div>
      ${tachSvg(i)}
      <div class="fan-foot">
        <dl class="fan-meta">
          <div><dt>Target</dt><dd data-f="target">--</dd></div>
          <div><dt>Curve</dt><dd data-f="curve">--</dd></div>
        </dl>
        <label class="ignition" title="Start / stop fan ${i + 1}">
          <input type="checkbox" class="switch-input" aria-label="Fan ${i + 1} power">
          <span class="ignition-btn" aria-hidden="true"><span>ENGINE</span><b>START</b><span>STOP</span></span>
        </label>
      </div>`;
    const toggle = card.querySelector("input");
    toggle.addEventListener("change", () => setFan(i, toggle.checked, toggle));
    fansBox.appendChild(card);

    const mini = document.createElement("div");
    mini.className = "mini-fan";
    mini.style.setProperty("--i", i + 4);
    mini.innerHTML = `${fanGlyph()}
      <div class="mini-body">
        <div class="mini-head"><strong>Fan ${i + 1}</strong><span class="mini-pct">--</span></div>
        <div class="shift" aria-hidden="true">${"<i></i>".repeat(SHIFT_LEDS)}</div>
      </div>`;
    overview.appendChild(mini);

    fanEls.push({
      card, mini, toggle,
      needle: card.querySelector(".tach-needle"),
      target: card.querySelector(".tach-target"),
      progress: card.querySelector(".tach-progress"),
      readout: card.querySelector(".tach-readout"),
      lamp: card.querySelector('[data-f="lamp"]'),
      targetText: card.querySelector('[data-f="target"]'),
      curve: card.querySelector('[data-f="curve"]'),
      miniPct: mini.querySelector(".mini-pct"),
      leds: [...mini.querySelectorAll(".shift i")],
      pwmOut: 0
    });

    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `Fan ${i + 1} curve`;
    el("fanSelect").appendChild(opt);
  }
}

function render() {
  if (!state) return;
  const t = state.temperatureC;
  el("temp").textContent = t == null ? "-- °C" : `${Number(t).toFixed(1)} °C`;
  const hot = t != null && t >= state.warningTempC;
  el("temp").closest(".stat").classList.toggle("hot", hot);
  el("tempLamp").className = `lamp ${hot ? "bad blink" : ""}`;
  const frac = v => Math.max(0, Math.min(1, v / GAUGE_MAX_C));
  el("gaugeFill").style.strokeDasharray = `${t == null ? 0 : frac(t) * 100} 100`;
  const [x1, y1] = gaugePoint(frac(state.warningTempC ?? 60), 33);
  const [x2, y2] = gaugePoint(frac(state.warningTempC ?? 60), 47);
  Object.entries({x1, y1, x2, y2}).forEach(([k, v]) => el("gaugeTick").setAttribute(k, v.toFixed(1)));
  el("humidity").textContent = state.humidity == null ? "Humidity --%" : `Humidity ${Math.round(state.humidity)}%`;
  el("ip").textContent = state.ip || "--";
  el("uptime").textContent = `Uptime ${formatUptime(state.uptimeMs)}`;
  el("wifiState").textContent = state.wifiConnected === false ? "Disconnected" : "Connected";
  const [quality, bars] = rssiQuality(state.rssi);
  el("rssiBars").dataset.level = bars;
  el("rssi").textContent = `RSSI ${state.rssi ?? "--"} dBm${quality && " · " + quality}`;
  el("mode").textContent = state.controllerMode || "PWM → V";
  el("pwmFreq").textContent = `PWM ${state.pwmFrequencyHz ?? "--"} Hz`;

  // Don't overwrite fields while the user is typing in them.
  if (!settingsDirty && document.activeElement !== el("warningTemp")) {
    el("warningTemp").value = state.warningTempC ?? 60;
  }
  el("useGlobal").checked = !!state.useGlobalCurve;
  el("webhookUrl").placeholder = state.webhookUrlSet ? "Webhook configured (enter a URL to replace it)" : "http://example.local/webhook";
  el("clearWebhook").hidden = !state.webhookUrlSet;

  renderFans();
  drawCurve();
}

function renderFans() {
  let anyKick = false, vtec = false;
  (state.fans || []).forEach((f, i) => {
    const e = fanEls[i];
    if (!e) return;
    const on = !!f.enabled;
    const speed = Number(f.speed || 0);
    const pwmOut = Number(f.pwmOutput ?? speed);
    const spinning = on && pwmOut > 0;
    // 100% ≈ 0.3 s per turn, low speeds ≈ 1.8 s per turn
    const spin = spinning ? `${(1.8 - pwmOut / 100 * 1.5).toFixed(2)}s` : "";

    for (const node of [e.card, e.mini]) {
      node.classList.toggle("on", spinning);
      node.style.setProperty("--spin", spin);
    }
    const kick = on && pwmOut > speed;
    anyKick ||= kick;
    vtec ||= on && pwmOut > VTEC_PCT;

    e.pwmOut = pwmOut;
    if (sweepDone) e.needle.style.rotate = `${tachAngle(pwmOut)}deg`;
    e.target.style.rotate = `${tachAngle(speed)}deg`;
    e.progress.style.strokeDasharray = `${pwmOut} 100`;
    e.readout.textContent = `${pwmOut}%`;
    const [lampText, lampClass] = !on ? ["Off", ""] : kick ? ["Kick", "warn"] : spinning ? ["Run", "ok"] : ["Idle", ""];
    e.lamp.textContent = lampText;
    e.lamp.className = `lamp ${lampClass}`;
    e.targetText.textContent = `${speed}%`;
    e.curve.textContent = state.useGlobalCurve ? "Global" : `Fan ${i + 1}`;
    if (!e.toggle.disabled) e.toggle.checked = on;

    e.miniPct.textContent = on ? `${pwmOut}%` : "OFF";
    const lit = Math.ceil(pwmOut / (100 / SHIFT_LEDS));
    e.leds.forEach((led, n) => led.classList.toggle("lit", on && n < lit));
  });
  el("kickLamp").className = `lamp ${anyKick ? "warn" : ""}`;
  el("vtecLamp").className = `lamp vtec-only ${vtec ? "warn" : ""}`;
}

// ---------- Tabs ----------
const tabs = [...document.querySelectorAll(".tab")];
function activateTab(btn, focus) {
  for (const t of tabs) {
    const active = t === btn;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", String(active));
    t.tabIndex = active ? 0 : -1;
    el("tab-" + t.dataset.tab).hidden = !active;
  }
  if (focus) btn.focus();
  if (btn.dataset.tab === "curves") resizeCanvas();
}
tabs.forEach((btn, i) => {
  btn.addEventListener("click", () => activateTab(btn));
  btn.addEventListener("keydown", e => {
    const dir = {ArrowRight:1, ArrowLeft:-1}[e.key];
    if (!dir) return;
    e.preventDefault();
    activateTab(tabs[(i + dir + tabs.length) % tabs.length], true);
  });
});

// ---------- Curve editor ----------
const canvas = el("curve");
const ctx = canvas.getContext("2d");
const pad = {l:52, r:20, t:20, b:48};
let W = 0, H = 0;
// Live declaration: always reflects the current theme's custom properties.
const css = getComputedStyle(document.documentElement);
const color = name => css.getPropertyValue(name).trim();

function xForTemp(t) { return pad.l + t / 100 * (W - pad.l - pad.r); }
function yForSpeed(s) { return H - pad.b - s / 100 * (H - pad.t - pad.b); }
function tempForX(x) { return Math.max(0, Math.min(100, (x - pad.l) / (W - pad.l - pad.r) * 100)); }
function speedForY(y) { return Math.max(0, Math.min(100, (H - pad.b - y) / (H - pad.t - pad.b) * 100)); }

function selectedCurve() {
  if (!state) return defaultCurve;
  const v = el("fanSelect").value;
  return v === "global" ? state.globalCurve : state.fanCurves[Number(v)];
}

function setSelectedCurve(curve) {
  const v = el("fanSelect").value;
  if (v === "global") state.globalCurve = curve;
  else state.fanCurves[Number(v)] = curve;
}

function setCurveDirty(dirty) {
  curveDirty = dirty;
  el("dirtyNote").hidden = !dirty;
}

// Back the canvas with device pixels so it stays sharp on HiDPI screens.
function resizeCanvas() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;  // hidden tab
  const dpr = window.devicePixelRatio || 1;
  W = w; H = h;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawCurve();
}
new ResizeObserver(resizeCanvas).observe(canvas);

function drawCurve() {
  if (!W || !H) return;
  const accent = color("--accent"), muted = color("--muted"), text = color("--text");
  ctx.clearRect(0, 0, W, H);

  // Grid + tick labels
  const step = W < 520 ? 20 : 10;
  ctx.font = `13px ${CHART_FONT}`;
  ctx.fillStyle = muted;
  ctx.lineWidth = 1;
  for (let v = 0; v <= 100; v += step) {
    const x = xForTemp(v), y = yForSpeed(v);
    ctx.strokeStyle = v === 0 ? color("--axis") : color("--grid");
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText(String(v), x, H - pad.b + 8);
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(String(v), pad.l - 8, y);
  }

  // Axis titles
  ctx.font = `700 13px ${CHART_FONT}`;
  ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  ctx.fillText("Temperature (°C)", pad.l + (W - pad.l - pad.r) / 2, H - 4);
  ctx.save();
  ctx.translate(14, pad.t + (H - pad.t - pad.b) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = "middle";
  ctx.fillText("PWM command (%)", 0, 0);
  ctx.restore();

  const curve = selectedCurve().slice().sort((a, b) => a.temp - b.temp);
  if (!curve.length) return;

  // The firmware holds the first/last speed outside the curve, so extend flat to the edges.
  const path = [{temp:0, speed:curve[0].speed}, ...curve, {temp:100, speed:curve[curve.length - 1].speed}];

  const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
  grad.addColorStop(0, accent + "55");
  grad.addColorStop(1, accent + "00");
  ctx.beginPath();
  path.forEach((p, i) => i ? ctx.lineTo(xForTemp(p.temp), yForSpeed(p.speed)) : ctx.moveTo(xForTemp(p.temp), yForSpeed(p.speed)));
  ctx.lineTo(xForTemp(100), H - pad.b);
  ctx.lineTo(xForTemp(0), H - pad.b);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  path.forEach((p, i) => i ? ctx.lineTo(xForTemp(p.temp), yForSpeed(p.speed)) : ctx.moveTo(xForTemp(p.temp), yForSpeed(p.speed)));
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.stroke();

  // Current temperature marker
  const t = state?.temperatureC;
  if (t != null && t >= 0 && t <= 100) {
    const x = xForTemp(t), s = speedAt(t, curve), y = yForSpeed(s);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = color("--marker");
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color("--marker");
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.font = `700 13px ${CHART_FONT}`;
    ctx.textBaseline = "top";
    const label = `${Number(t).toFixed(1)} °C → ${s}%`;
    ctx.textAlign = x > W - 140 ? "right" : "left";
    ctx.fillText(label, x + (ctx.textAlign === "right" ? -8 : 8), pad.t + 4);
  }

  // Points
  for (const p of curve) {
    const x = xForTemp(p.temp), y = yForSpeed(p.speed);
    const active = p === dragging;
    ctx.beginPath();
    ctx.arc(x, y, active ? 9 : 7, 0, Math.PI * 2);
    ctx.fillStyle = active ? text : accent;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = color("--sunken");
    ctx.stroke();

    const label = `${Math.round(p.temp)}° · ${Math.round(p.speed)}%`;
    ctx.font = `700 12.5px ${CHART_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const ly = y - 14 < pad.t + 10 ? y + 28 : y - 14;
    const tw = ctx.measureText(label).width + 10;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = color("--sunken");
    ctx.fillRect(x - tw / 2, ly - 16, tw, 18);
    ctx.globalAlpha = 1;
    ctx.fillStyle = text;
    ctx.fillText(label, x, ly);
  }
}

function eventPos(e) {
  const r = canvas.getBoundingClientRect();
  return {x: e.clientX - r.left, y: e.clientY - r.top};
}

function nearestPoint(pos, curve) {
  let best = null, bestDist = Infinity;
  for (const pt of curve) {
    const d = Math.hypot(xForTemp(pt.temp) - pos.x, yForSpeed(pt.speed) - pos.y);
    if (d < bestDist) { bestDist = d; best = pt; }
  }
  return bestDist <= 22 ? best : null;
}

canvas.addEventListener("pointerdown", e => {
  if (!state) { log("Connect to the ESP8266 before editing curves."); return; }
  // Edit a private copy so polling/server responses can't swap objects mid-drag.
  const curve = copyCurve(selectedCurve());
  const pt = nearestPoint(eventPos(e), curve);
  if (!pt) return;
  setSelectedCurve(curve);
  dragging = pt;
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add("grabbing");
  e.preventDefault();
  drawCurve();
});

canvas.addEventListener("pointermove", e => {
  const pos = eventPos(e);
  if (!dragging) {
    canvas.classList.toggle("grab", !!(state && nearestPoint(pos, selectedCurve())));
    return;
  }
  dragging.temp = Math.round(tempForX(pos.x));
  dragging.speed = Math.round(speedForY(pos.y));
  // Sort in place: `dragging` keeps pointing at the same object even if it passes a neighbor.
  selectedCurve().sort((a, b) => a.temp - b.temp);
  setCurveDirty(true);
  drawCurve();
});

function endDrag() {
  if (!dragging) return;
  dragging = null;
  canvas.classList.remove("grabbing");
  drawCurve();
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

// ---------- Wiring ----------
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = apiBase ? setInterval(refresh, POLL_MS) : null;
}

function warnMixedContent(base) {
  if (location.protocol === "https:" && base.startsWith("http:")) {
    log("This page is served over HTTPS, so the browser will block requests to an http:// device (mixed content). Serve the UI over HTTP.", "warn");
  }
}

el("saveApi").addEventListener("click", () => {
  apiBase = normalizeBase(el("apiBase").value);
  el("apiBase").value = apiBase;
  storage.set(STORAGE_KEY, apiBase);
  log(apiBase ? `API URL saved: ${apiBase}` : "API URL cleared");
  warnMixedContent(apiBase);
  online = null;
  startPolling();
  refresh();
});

el("testApi").addEventListener("click", async () => {
  const base = normalizeBase(el("apiBase").value);
  if (!base) { el("statusText").textContent = "Enter a URL to test."; return; }
  el("statusText").textContent = `Testing ${base}…`;
  try {
    const s = await api("/api/status", {}, base);
    el("statusText").textContent = `OK: ${base} answered (device IP ${s.ip || "?"}).${base === apiBase ? "" : " Click Save to use it."}`;
  } catch (e) {
    el("statusText").textContent = `Test failed: ${e.message}`;
  }
});

el("refresh").addEventListener("click", async () => {
  if (!apiBase) { log("Set the ESP8266 API URL in Settings first.", "warn"); return; }
  el("refresh").classList.add("spinning");
  await refresh();
  el("refresh").classList.remove("spinning");
});
el("saveCurve").addEventListener("click", saveCurves);
el("saveSettings").addEventListener("click", saveSettings);
el("clearWebhook").addEventListener("click", () => postConfig({webhookUrl:""}, "Webhook removed"));
el("warningTemp").addEventListener("input", () => { settingsDirty = true; });
// Only send the flag; unsaved curve edits stay local until "Save curves".
el("useGlobal").addEventListener("change", () => postConfig({useGlobalCurve: el("useGlobal").checked}, "Curve mode saved"));
el("fanSelect").addEventListener("change", drawCurve);
el("resetCurve").addEventListener("click", () => {
  if (!state) return;
  setSelectedCurve(copyCurve(defaultCurve));
  setCurveDirty(true);
  drawCurve();
  log("Selected curve reset locally. Click Save curves to send it to the ESP8266.");
});
el("clearLogs").addEventListener("click", () => el("log").replaceChildren());

// ---------- Theme ----------
// choice "" = Auto: Redline in dark mode, Daylight in light mode.
// index.html applies the same logic before first paint.
const lightQuery = matchMedia("(prefers-color-scheme: light)");
function applyTheme(choice) {
  if (!THEMES.includes(choice)) choice = "";  // also drops names from older versions
  document.documentElement.dataset.theme = choice || (lightQuery.matches ? "daylight" : "redline");
  el("themeSelect").value = choice;
  document.querySelector('meta[name="theme-color"]').content = color("--theme-color");
  drawCurve();
}
el("themeSelect").addEventListener("change", e => {
  storage.set(THEME_KEY, e.target.value);
  applyTheme(e.target.value);
});
lightQuery.addEventListener("change", () => {
  if (!el("themeSelect").value) applyTheme("");
});

// Don't poll a hidden tab; catch up as soon as it's visible again.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { clearInterval(pollTimer); pollTimer = null; }
  else { refresh(); startPolling(); }
});

window.addEventListener("beforeunload", e => {
  if (curveDirty) { e.preventDefault(); e.returnValue = ""; }
});

applyTheme(storage.get(THEME_KEY) || "");
buildFans();
needleSweep();
// Redraw the chart once the web fonts arrive so its labels use them.
document.fonts?.ready.then(drawCurve);
el("apiBase").value = apiBase;
if (apiBase) {
  warnMixedContent(apiBase);
  refresh();
  startPolling();
} else {
  log("Set the ESP8266 API URL in Settings → Connection.");
  activateTab(tabs.find(t => t.dataset.tab === "settings"));
}
