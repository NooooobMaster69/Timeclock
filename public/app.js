/* ===============================
   360WPT TimeClock - Frontend JS
   Works for: login.html, register.html, index.html
   =============================== */

// ---------- 小工具 ----------
const $ = (sel) => document.querySelector(sel);
let _missedPresetMap = new Map(); // date -> preset

async function api(path, { method = "GET", json, headers } = {}) {
  const opts = { method, headers: headers || {} };
  if (json) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(json);
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const msg = data?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

let _toastTimer = null;
let _userRole = "";
let _userGroup = "";
let _empNameMap = new Map(); // employeeId -> displayName
let _lastState = null; // ✅ 缓存 /api/state，给 missed punch 判断用

function toast(msg) {
  const el = document.getElementById("toast");
  // 如果没找到容器，就退回 alert（防止某个页面忘记加 toast div）
  if (!el) {
    alert(msg);
    return;
  }

  // 设置内容
  el.textContent = msg;

  // 显示：加上 show 类
  el.classList.add("show");

  // 如果之前有计时器，先清掉
  if (_toastTimer) {
    clearTimeout(_toastTimer);
  }

  // 2.5 秒后自动隐藏
  _toastTimer = setTimeout(() => {
    el.classList.remove("show");
  }, 2500);
}


// ---------- 登录页逻辑 ----------
async function handleLogin() {
  const username = $("#username")?.value.trim();
  const password = $("#password")?.value.trim();
  if (!username || !password) return toast("Please enter username & password.");

  try {
    await api("/api/login", { method: "POST", json: { username, password } });
    window.location.href = "index.html";
  } catch (err) {
    toast("Login failed: " + err.message);
  }
}

function bindLoginPage() {
  const btn = $("#loginBtn") || document.querySelector('button[onclick="login()"]');

  if (btn) {
    btn.removeAttribute("onclick"); // 防止 inline onclick + addEventListener 双触发
    btn.addEventListener("click", handleLogin);
  }

  ["#username", "#password"].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleLogin();
    });
  });

  // 兼容：如果页面上还有旧 inline 调用
  window.login = handleLogin;
}


// ---------- 注册页逻辑 ----------
async function register() {
  const username = $("#username")?.value.trim();
  const name     = $("#name")?.value.trim();
  const password = $("#password")?.value.trim();
  const groupEl  = $("#group");
  const hourlyRate = $("#hourlyRate")?.value;
  const overtimeRate = $("#overtimeRate")?.value;
  const rawGroup = groupEl ? groupEl.value : "non-therapist";

  // 规范成后端认识的两种：therapist / non-therapist
  const group =
    rawGroup === "therapist" || rawGroup === "Therapist"
      ? "therapist"
      : "non-therapist";

 if (!username || !password || !name || hourlyRate === "" || hourlyRate == null) {
    toast("All fields are required.");
    return;
  }

  try {
    await api("/api/register", {
      method: "POST",
      json: { username, password, name, group, hourlyRate, overtimeRate }
    });
    toast("✅ Registration successful! Please login.");
    window.location.href = "login.html";
  } catch (e) {
    toast(e.message);
  }
}

function bindRegisterPage() {
  const btn = $("#registerBtn") || document.querySelector('button[onclick="register()"]');

  if (btn) {
    btn.removeAttribute("onclick"); // 防止双触发
    btn.addEventListener("click", register);
  }

["#username", "#name", "#password", "#group", "#hourlyRate", "#overtimeRate"].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") register();
    });
  });

  window.register = register;
}


// 顶部欢迎栏的小时钟
function startHelloClock() {
  const el = document.getElementById("hello-date");
  if (!el) return;

  function tick() {
    el.textContent = new Date().toLocaleString();
  }

  // 先立刻更新一次
  tick();

  // 为了避免重复创建定时器，先清掉旧的
  if (window._helloClockTimer) {
    clearInterval(window._helloClockTimer);
  }
  // 每秒更新一次
  window._helloClockTimer = setInterval(tick, 1000);
}


// ---------- 打卡主页逻辑（index.html） ----------

// 发薪周期（前端计算）：每月 1–15，16–月底
function getPayPeriodRange(date = new Date()) {
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();

  let periodStart, periodEnd;

  if (d <= 15) {
    periodStart = new Date(y, m, 1);
    periodEnd   = new Date(y, m, 15);
  } else {
    periodStart = new Date(y, m, 16);
    periodEnd   = new Date(y, m + 1, 0); // 当月最后一天
  }

  periodStart.setHours(0, 0, 0, 0);
  periodEnd.setHours(0, 0, 0, 0);

  return { periodStart, periodEnd };
}


function formatLocal(dtStr) {
  try { return new Date(dtStr).toLocaleString(); } catch { return dtStr; }
}

// 用客户端从 /api/records 计算 Summary（可作为后端的兜底）
function computeSummaryClient(records) {
  const { periodStart, periodEnd } = getPayPeriodRange(new Date());
  const startMs = periodStart.getTime();
  const endMs = periodEnd.getTime() + 24 * 3600 * 1000 - 1;

  const rec = records
    .map(r => ({ ...r, t: new Date(r.timestamp).getTime() }))
    .filter(r => r.t >= startMs && r.t <= endMs)
    .sort((a, b) => a.t - b.t);

  let workMinutes = 0, mealMinutes = 0, restMinutes = 0;
  let ci = null, mi = null, ri = null;

  for (const r of rec) {
    switch (r.type) {
      case "CLOCK_IN":  ci = r.t; break;
      case "CLOCK_OUT":
        if (ci != null) { workMinutes += (r.t - ci) / 60000; ci = null; }
        break;
      case "MEAL_IN":   mi = r.t; break;
      case "MEAL_OUT":
        if (mi != null) { mealMinutes += (r.t - mi) / 60000; mi = null; }
        break;
      case "REST_IN":   ri = r.t; break;
      case "REST_OUT":
        if (ri != null) { restMinutes += (r.t - ri) / 60000; ri = null; }
        break;
    }
  }

  const totalBreaks = (mealMinutes + restMinutes) / 60;
  const totalHours  = (workMinutes - mealMinutes) / 60;  // ✅ 只扣 lunch，不扣 rest


  return {
    periodStart: periodStart.toDateString(),
    periodEnd: periodEnd.toDateString(),
    totalHours: Math.max(0, Number(totalHours.toFixed(2))),
    totalBreaks: Math.max(0, Number(totalBreaks.toFixed(2))),
  };
}

async function ensureLoggedIn() {
  try { await api("/api/state"); return true; }
  catch { window.location.href = "login.html"; return false; }
}


async function setupAdminZone(role) {
  const adminZone = document.getElementById("adminZone");
  if (!adminZone) return;

  if (role !== "admin") {
    adminZone.style.display = "none";
    return;
  }

  adminZone.style.display = "block";

  const select = document.getElementById("adminEmployeeSelect");
  if (!select) return;

  // 已加载过员工列表：只刷新 pending
  // ✅ 永远确保绑定 change（防止某些情况下没绑上）
if (!select.dataset.mpBound) {
  select.addEventListener("change", async () => {
    try {
      await loadAdminPendingMissedPunch();
    } catch (e) {
      console.error(e);
      toast("Failed to refresh pending list: " + (e?.message || e));
    }
  });
  select.dataset.mpBound = "1";
}


// 已加载过员工列表：只刷新 pending
if (select.dataset.loaded === "1") {
  await loadAdminPendingMissedPunch();
  return;
}


  try {
    const list = await api("/api/employees");
    _empNameMap = new Map(list.map(e => [e.employee, e.displayName || e.name || e.employee]));

    // 保留第一个 "All employees"
    while (select.options.length > 1) select.remove(1);

    list.forEach((emp) => {
      const opt = document.createElement("option");
      opt.value = emp.employee;
      opt.textContent = emp.displayName || emp.employee;
      select.appendChild(opt);
    });

    select.dataset.loaded = "1";

    // 绑定一次 change -> 刷新 pending
    if (!select.dataset.mpBound) {
      select.addEventListener("change", () => loadAdminPendingMissedPunch());
      select.dataset.mpBound = "1";
    }

  } catch (err) {
    console.error("Failed to load employees", err);
  }

  await loadAdminPendingMissedPunch();
}

// ===============================
// Missed Punch (Employee UI)
// ===============================
function toYMD(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function hm(dateObj) {
  const h = String(dateObj.getHours()).padStart(2, "0");
  const m = String(dateObj.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

// 检测：在 pay period 内，哪一天有 “未配对”的事件
function detectMissedDays(records, periodStart, periodEnd, isTherapist, opts = {}) {
  const startMs = periodStart.getTime();
  const endMs = periodEnd.getTime() + 24 * 3600 * 1000 - 1;

  const rec = (records || [])
    .map(r => ({ ...r, t: new Date(r.timestamp).getTime(), dt: new Date(r.timestamp) }))
    .filter(r => Number.isFinite(r.t) && r.t >= startMs && r.t <= endMs)
    .sort((a, b) => a.t - b.t);

  // 每天一个状态
  const dayMap = new Map(); // ymd -> { openClockIn, openMealIn, openRestIn, issues:Set, sampleTimes:{} }

  function ensureDay(ymd) {
    if (!dayMap.has(ymd)) {
      dayMap.set(ymd, {
        openClockIn: null,
        openMealIn: null,
        openRestIn: null,
        issues: new Set(),
        sampleTimes: {} // 用于预填 modal
      });
    }
    return dayMap.get(ymd);
  }

  for (const r of rec) {
    const ymd = toYMD(r.dt);
    const st = ensureDay(ymd);

    if (r.type === "CLOCK_IN") {
      if (st.openClockIn != null) {
        st.issues.add("Duplicate CLOCK_IN (missing CLOCK_OUT)");
      }
      st.openClockIn = r.dt;
      st.sampleTimes.clockIn = hm(r.dt);
    }

    if (r.type === "CLOCK_OUT") {
      if (st.openClockIn == null) {
        st.issues.add("CLOCK_OUT without CLOCK_IN");
      } else {
        st.sampleTimes.clockOut = hm(r.dt);
        st.openClockIn = null;
      }
    }

    if (r.type === "MEAL_IN") {
      st.openMealIn = r.dt;
      st.sampleTimes.mealIn = hm(r.dt);
    }

    if (r.type === "MEAL_OUT") {
      if (st.openMealIn == null) st.issues.add("Lunch end without lunch start");
      else {
        st.sampleTimes.mealOut = hm(r.dt);
        st.openMealIn = null;
      }
    }

    if (!isTherapist) {
      if (r.type === "REST_IN") {
        st.openRestIn = r.dt;
        st.sampleTimes.restIn = hm(r.dt);
      }

      if (r.type === "REST_OUT") {
        if (st.openRestIn == null) st.issues.add("Rest end without rest start");
        else {
          st.sampleTimes.restOut = hm(r.dt);
          st.openRestIn = null;
        }
      }
    }
  }

const missed = [];
const todayYMD = toYMD(new Date());
const forceToday = !!opts.forceTodayClose;

for (const [ymd, st] of dayMap.entries()) {
  const isPastDay = ymd < todayYMD;
  const treatAsClosedDay = isPastDay || (forceToday && ymd === todayYMD);

  if (treatAsClosedDay) {
    if (st.openClockIn != null) {
      st.issues.add(ymd === todayYMD ? "Missing CLOCK_OUT (auto reset)" : "Missing CLOCK_OUT");
    }
    if (st.openMealIn != null) st.issues.add("Missing lunch end");
    if (!isTherapist && st.openRestIn != null) st.issues.add("Missing rest end");
  }

  if (st.issues.size) {
    missed.push({
      date: ymd,
      issues: Array.from(st.issues),
      preset: st.sampleTimes
    });
  }
}



  // 排序（日期升序）
  missed.sort((a, b) => a.date.localeCompare(b.date));
  return missed;
}

function mpBadge(status) {
  const s = String(status || "").toLowerCase();
  if (!s) return "";
  return `<span class="badge ${esc(s)}">${esc(s.toUpperCase())}</span>`;
}

// 可选：员工撤销（需要后端支持 /api/missed_punch/:id/cancel）
async function cancelMissedPunch(id) {
  id = decodeURIComponent(id);
  if (!confirm("Cancel this missed punch request?")) return;
  try {
    await api(`/api/missed_punch/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    toast("✅ Request cancelled.");
    await refreshMyMissedPunchUI();
  } catch (e) {
    toast("❌ Cancel failed: " + (e.message || "Unknown error"));
  }
}
window.cancelMissedPunch = cancelMissedPunch;

async function refreshMyMissedPunchUI() {
  // 只对员工显示
  if (_userRole === "admin") return;

  const card = document.getElementById("missedPunchCard");
  const items = document.getElementById("missedPunchItems");
  const btn = document.getElementById("mpOpenBtn");
  const titleEl = document.getElementById("missedPunchTitle");
  const subEl   = document.getElementById("missedPunchSubtitle");
  const quickBtn = document.getElementById("mpQuickBtn"); // ✅ 常驻小按钮

  // ✅ 新增：请求状态区
  const reqSection = document.getElementById("mpReqSection");
  const reqTitle = document.getElementById("mpReqTitle");
  const reqItems = document.getElementById("mpReqItems");

  if (!card || !items || !btn) return;

  const isTherapist = _userGroup === "therapist";
  // ✅ 检测范围：上一 pay period + 当前 pay period（避免 15→16 或 月末→1 丢提示）
const now = new Date();
const { periodStart: curStart, periodEnd: curEnd } = getPayPeriodRange(now);

// 用“当前周期开始的前一天”去算上一周期
const prevAnchor = new Date(curStart);
prevAnchor.setDate(prevAnchor.getDate() - 1);
const { periodStart: prevStart } = getPayPeriodRange(prevAnchor);

// 合并窗口
const periodStart = prevStart;
const periodEnd   = curEnd;


  // 1) 拉 records（用于 detectMissedDays）
  let records = [];
  try {
    records = await api("/api/records");
  } catch (e) {
    card.style.display = "none";
 if (reqSection) reqSection.style.display = "none";
    return;
  }
// ✅ 如果服务器 state 显示 Off（被 reset），就允许把“今天的 open punch”也当异常提示
const forceTodayClose = !!(_lastState && !_lastState.clockedIn);

const missedDays = detectMissedDays(records, periodStart, periodEnd, isTherapist, {
  forceTodayClose
});


// 2) 拉该员工同一检测窗口(periodStart~periodEnd)的 requests
let myReq = [];
try {
  const params = new URLSearchParams();
  params.set("range", "custom");
  params.set("start", toYMD(periodStart));
  params.set("end", toYMD(periodEnd));
  params.set("_ts", String(Date.now()));

  myReq = await api(`/api/missed_punch?${params.toString()}`);
  if (!Array.isArray(myReq)) myReq = [];
} catch (e) {
  myReq = [];
}

// 同一天可能有多条（允许重提的话），取最新一条用于“那一天的状态”
const latestReqByDate = new Map();
for (const r of myReq) {
  if (!r?.date) continue;
  const prev = latestReqByDate.get(r.date);
  const t1 = new Date(prev?.submittedAt || 0).getTime();
  const t2 = new Date(r?.submittedAt || 0).getTime();
  if (!prev || t2 >= t1) latestReqByDate.set(r.date, r);
}

// ✅ unresolvedDays：仍然“需要员工Fix”的日期（没提交过 或 被拒/取消）
const unresolvedDays = missedDays.filter(d => {
  const rr = latestReqByDate.get(d.date);
  const st = String(rr?.status || "").toLowerCase();
  return !rr || ["denied", "cancelled"].includes(st);
});

const hasIssues = unresolvedDays.length > 0;
const hasReq = myReq.length > 0;

// ✅ 动态标题：approve/pending 后不再一直显示 ⚠️
if (titleEl && subEl) {
  if (hasIssues) {
    titleEl.textContent = "⚠️ Missed punches detected";
    subEl.textContent =
      "Please submit a Missed Punch Request. An admin will review before payroll/export counts these hours.";
  } else if (hasReq) {
    titleEl.textContent = "✅ Missed Punch reviewed / no issues detected";
    subEl.textContent =
      "No missed punches detected for this pay period. You can still submit a request anytime if your times look wrong.";
  } else {
    titleEl.textContent = "📝 Missed Punch Request";
    subEl.textContent =
      "Use this if you forgot to punch (meal/rest/in/out). An admin will review before payroll/export.";
  }
}


 card.style.display = "block"; // ✅ 员工端永远显示（入口永远在）

// ✅ 状态上色
card.classList.remove("warn","ok","neutral");
if (hasIssues) card.classList.add("warn");
else if (hasReq) card.classList.add("ok");
else card.classList.add("neutral");

  // 给 modal 预填用（沿用你原逻辑）
  _missedPresetMap = new Map(missedDays.map(d => [d.date, d.preset || {}]));

  // 默认打开 modal 的日期：优先挑“还没提交/被拒绝/已取消”的那天
 const defaultDay = unresolvedDays[0]?.date || missedDays[0]?.date || "";


  const today = toYMD(new Date());
  const openDay = defaultDay || today;

  btn.onclick = () => openMissedPunchModal(openDay);
  if (quickBtn) quickBtn.onclick = () => openMissedPunchModal(openDay);

  // 3) 渲染 missedDays 列表（合并状态）
    if (!hasIssues) {
    items.style.display = "none";
    items.innerHTML = "";
  } else {
    items.style.display = "flex";
    items.innerHTML = unresolvedDays.map(d => {
    const issueText = d.issues.join(" / ");
    const rr = latestReqByDate.get(d.date);
    const st = String(rr?.status || "").toLowerCase();

    // 有 pending/approved 时不再显示 Fix（避免重复提交）；denied/cancelled 允许再打开
    const canFix = !rr || ["denied", "cancelled"].includes(st);

    return `
      <div class="missed-item">
        <div class="missed-item-left">
          <div class="missed-date">
            ${esc(d.date)}
            ${rr ? mpBadge(st) : ""}
          </div>
          <div class="missed-detail">
            ${esc(issueText)}
            ${rr ? ` • Request: ${esc(st || "")}` : ""}
          </div>
        </div>
        ${
          canFix
            ? `<button class="purple btn-sm" type="button" onclick="openMissedPunchModal('${esc(d.date)}')">Fix</button>`
            : `<span style="font-size:12px; color:#7c2d12; font-weight:700;">Submitted</span>`
        }
      </div>
    `;
  }).join("");
  }
  // 4) 渲染“我的申请列表”（通知/状态栏）
  if (reqSection && reqItems) {
    if (!myReq.length) {
      reqSection.style.display = "none";
    } else {
      reqSection.style.display = "block";
      reqItems.style.display = "flex";

      const sorted = [...myReq]
  .sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || ""))
  .slice(0, 5);


      reqItems.innerHTML = sorted.map(r => {
        const st = String(r.status || "").toLowerCase();
        const note = r.decisionNote ? ` • Note: ${esc(r.decisionNote)}` : "";
        const reviewed = r.reviewedAt ? ` • Reviewed` : "";
        const canCancel = st === "pending";

        return `
          <div class="missed-item">
            <div class="missed-item-left">
              <div class="missed-date">
                ${esc(r.date || "")}
                ${mpBadge(st)}
              </div>
              <div class="missed-detail">
                ${esc(r.clockIn || "")}-${esc(r.clockOut || "")}
                ${reviewed}${note}
              </div>
            </div>
            ${
              canCancel
                ? `<button class="black btn-sm" type="button"
                     onclick="cancelMissedPunch('${encodeURIComponent(r.id)}')">Cancel</button>`
                : ""
            }
          </div>
        `;
      }).join("");

      // ✅ “通知感”：如果有新 reviewed 的，登录后 toast 一下
      try {
        const lastSeen = localStorage.getItem("mpLastSeenReviewedAt") || "";
        const reviewedList = sorted.filter(x => x.reviewedAt).map(x => x.reviewedAt).sort();
        const latest = reviewedList[reviewedList.length - 1] || "";
        if (latest && (!lastSeen || latest > lastSeen)) {
          const newly = sorted.filter(x => x.reviewedAt && x.reviewedAt > lastSeen);
          if (newly.length) {
            toast("📬 Missed Punch update:\n" + newly.map(x => `${x.date}: ${x.status}`).join("\n"));
          }
          localStorage.setItem("mpLastSeenReviewedAt", latest);
        }
      } catch (_) {}
    }
  }
}

function openMissedPunchModal(dateStr) {
  const overlay = document.getElementById("mpOverlay");
  if (!overlay) return;

  overlay.classList.add("show");

  const dateEl = document.getElementById("mpDate");
  if (dateEl && dateStr) dateEl.value = dateStr;

  const preset = (dateStr && _missedPresetMap.get(dateStr)) || {};

  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val || "";
  };

  // ✅ 如果有记录就预填，没有就空
  setVal("mpClockIn",  preset.clockIn);
  setVal("mpClockOut", preset.clockOut);
  setVal("mpMealIn",   preset.mealIn);
  setVal("mpMealOut",  preset.mealOut);

  // therapist 不用 rest
  if (_userGroup === "therapist") {
    setVal("mpRestIn", "");
    setVal("mpRestOut", "");
  } else {
    setVal("mpRestIn",  preset.restIn);
    setVal("mpRestOut", preset.restOut);
  }

  const err = document.getElementById("mpErrorBox");
  if (err) { err.style.display = "none"; err.textContent = ""; }
}

function closeMissedPunchModal(){
  const overlay = document.getElementById("mpOverlay");
  if (overlay) overlay.classList.remove("show");
}


async function submitMissedPunch(e) {
  e.preventDefault();

  const errBox = document.getElementById("mpErrorBox");
  const showErr = (m) => {
    if (!errBox) return toast(m);
    errBox.textContent = m;
    errBox.style.display = "block";
  };

  const v = (id) => document.getElementById(id)?.value?.trim() || "";

  const payload = {
    date: v("mpDate"),
    note: v("mpNote"),
    clockIn: v("mpClockIn"),
    clockOut: v("mpClockOut"),
    mealIn: v("mpMealIn"),
    mealOut: v("mpMealOut"),
    restIn: v("mpRestIn"),
    restOut: v("mpRestOut"),
  };

  if (!payload.date || !payload.clockIn || !payload.clockOut) {
    return showErr("Date / Clock In / Clock Out are required.");
  }

  // lunch/rest 必须成对
  const lunchOne = (!!payload.mealIn) ^ (!!payload.mealOut);
  if (lunchOne) return showErr("Lunch must be entered as start + end (both or blank).");

  const isTherapist = _userGroup === "therapist";
  if (isTherapist) {
    payload.restIn = "";
    payload.restOut = "";
  } else {
    const restOne = (!!payload.restIn) ^ (!!payload.restOut);
    if (restOne) return showErr("Rest must be entered as start + end (both or blank).");
  }

  try {
    // ✅ 这里是你后端需要支持的创建接口
    await api("/api/missed_punch", { method: "POST", json: payload });
    toast("✅ Missed Punch Request submitted.");
    closeMissedPunchModal();

    // 刷新一次 UI（如果你希望提交后仍显示 pending 也可以）
    await refreshMyMissedPunchUI();

  } catch (err) {
    showErr("Submit failed: " + (err.message || "Unknown error"));
  }
}

// 暴露给 HTML inline onclick
window.openMissedPunchModal = openMissedPunchModal;
window.closeMissedPunchModal = closeMissedPunchModal;
window.submitMissedPunch = submitMissedPunch;


function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  }[c]));
}

async function loadAdminPendingMissedPunch() {
  const panel = document.getElementById("adminMissedPunchPanel");
  const listEl = document.getElementById("adminMissedPunchList");
  if (!panel || !listEl) return;

  // admin 才显示
  if (_userRole !== "admin") {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "block";

  const sel = document.getElementById("adminEmployeeSelect");
  const emp = sel?.value || ""; // employeeId
  const empName = emp ? (_empNameMap.get(emp) || emp) : "All employees";

  // ✅ 先给一个“正在刷新”的视觉反馈
  listEl.innerHTML = `<div style="color:#64748b;">Loading pending requests for <b>${esc(empName)}</b>...</div>`;

  // ✅ 用 URLSearchParams + cache bust，避免缓存/代理导致看起来不刷新
  const params = new URLSearchParams();
  params.set("status", "pending");
  params.set("range", "all");
  if (emp) params.set("employee", emp);
  params.set("_ts", String(Date.now())); // cache bust

  const url = `/api/missed_punch?${params.toString()}`;

  let data = [];
  try {
    data = await api(url);
  } catch (e) {
    listEl.innerHTML = `<div style="color:#991b1b;">Failed to load pending requests for <b>${esc(empName)}</b>: ${esc(e.message)}</div>`;
    return;
  }

  if (!Array.isArray(data) || !data.length) {
    listEl.innerHTML = `<div style="color:#64748b;">No pending requests for <b>${esc(empName)}</b>.</div>`;
    return;
  }

  listEl.innerHTML = data.map(mp => {
    const name = _empNameMap.get(mp.employee) || mp.employee;
    const safeId = encodeURIComponent(mp.id);

    const mealLine = (mp.mealIn && mp.mealOut) ? `Lunch: ${esc(mp.mealIn)}–${esc(mp.mealOut)}` : `Lunch: —`;
    const restLine = (mp.restIn && mp.restOut) ? `Rest: ${esc(mp.restIn)}–${esc(mp.restOut)}` : `Rest: —`;
    const noteLine = mp.note ? `Note: ${esc(mp.note)}` : "";

    return `
      <div style="border:1px solid #e2e8f0; border-radius:14px; padding:12px; background:#fff;">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
          <div>
            <div style="font-weight:800; color:#0f172a;">
              ${esc(name)} <span style="color:#64748b; font-weight:600;">(${esc(mp.employee)})</span>
            </div>
            <div style="margin-top:2px; color:#334155; font-size:13px;">
              <b>${esc(mp.date)}</b> · In ${esc(mp.clockIn)} — Out ${esc(mp.clockOut)}
            </div>
            <div style="margin-top:6px; color:#475569; font-size:12px; line-height:1.35;">
              ${mealLine}<br/>
              ${restLine}
              ${noteLine ? `<br/>${noteLine}` : ``}
            </div>
          </div>

          <div style="display:flex; flex-direction:column; gap:8px; min-width:140px;">
            <button class="green btn-sm" type="button"
              onclick="adminReviewMissedPunch('${safeId}','approve')">Approve</button>
            <button class="red btn-sm" type="button"
              onclick="adminReviewMissedPunch('${safeId}','deny')">Deny</button>
          </div>
        </div>
      </div>
    `;
  }).join("");
}


async function adminReviewMissedPunch(id, action) {
  id = decodeURIComponent(id); // ✅ 还原
  const note = prompt("Decision note (optional):") || "";

  try {
    await api(`/api/missed_punch/${encodeURIComponent(id)}/review`, {
      method: "POST",
      json: { action, note }
    });
    toast(`✅ Updated: ${action}`);
    await loadAdminPendingMissedPunch();
  } catch (e) {
    toast("❌ Review failed: " + (e.message || "Unknown error"));
  }
}




async function loadStateAndButtons() {
  try {
    const s = await api("/api/state");
    _userRole = s.role;
    _lastState = s;
    _userGroup = s.group;
    const isAdmin = s.role === "admin";
    const isTherapist = s.group === "therapist";

    // --- 根据角色调整布局 ---
    const clockContainer = document.getElementById("clockContainer");
    const log = document.getElementById("log");
    const summaryTitle = document.getElementById("summaryTitle");
    const employeeSummaryButtons = document.getElementById("employeeSummaryButtons");
    const employeeCustomRange   = document.getElementById("employeeCustomRange");
    // --- 当前 pay period 状态条（只给员工看） ---
    const payBar   = document.getElementById("payPeriodBar");
    const payLabel = document.getElementById("payPeriodLabel");
    const payRange = document.getElementById("payPeriodRange");

    if (payBar && payLabel && payRange) {
      if (isAdmin) {
        // Admin 不需要这个条，直接隐藏
        payBar.style.display = "none";
      } else {
        const { periodStart, periodEnd } = getPayPeriodRange(new Date());

        const sameYear = periodStart.getFullYear() === periodEnd.getFullYear();
        const fmt = (d, extra) =>
          d.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            ...(extra || {}),
          });

        const rangeText = sameYear
          ? `${fmt(periodStart)} – ${fmt(periodEnd, { year: "numeric" })}`
          : `${fmt(periodStart, { year: "numeric" })} – ${fmt(periodEnd, { year: "numeric" })}`;

        payLabel.textContent = "Current pay period";
        payRange.textContent = rangeText;
        payBar.style.display = "flex";
      }
    }

    if (isAdmin) {
      if (clockContainer) clockContainer.style.display = "none";  // Admin 不显示打卡区
      if (log) log.style.display = "none";                        // Admin 不显示 Recent Records
      if (summaryTitle) summaryTitle.textContent = "👑 Admin Export";

      if (employeeSummaryButtons) employeeSummaryButtons.style.display = "none";
      if (employeeCustomRange)   employeeCustomRange.style.display   = "none";
    } else {
      if (clockContainer) clockContainer.style.display = "";
      if (log) log.style.display = "";
      if (summaryTitle) summaryTitle.textContent = "📊 Summary Zone";

      if (employeeSummaryButtons) employeeSummaryButtons.style.display = "";
      if (employeeCustomRange)   employeeCustomRange.style.display   = "";
    }
if (isAdmin) {
  const az = document.getElementById("adminZone");
  if (az) az.style.display = "block";
}

    // Admin 区块显示/隐藏 & 员工列表加载
    await setupAdminZone(s.role);

    // --- 顶部问候语 ---
    const hello = document.getElementById("hello");
    if (hello && s.displayName) {
      hello.textContent = `Hi, ${s.displayName}!`;
    }
    const helloDate = document.getElementById("hello-date");
    if (helloDate) {
      helloDate.textContent = new Date().toLocaleString();
    }

    // --- Rest 区块：Therapist 直接隐藏 ---
    const restBlock = document.querySelector(".rest-block");
    if (restBlock) {
      restBlock.style.display = isTherapist ? "none" : "";
    }

    // --- 状态条（修正 ID：statusText / statusDot） ---
    const statusText = document.getElementById("statusText");
    const statusDot  = document.getElementById("statusDot");

    if (statusText && statusDot) {
      let label = "Off";
      let color = "#9ca3af";

      if (s.clockedIn) {
        if (s.inMeal) {
          label = "On Lunch";
          color = "#f97316";
        } else if (s.inRest) {
          label = "On Rest";
          color = "#eab308";
        } else {
          label = "Working";
          color = "#22c55e";
        }
      }

      statusText.textContent = label;
      statusDot.style.backgroundColor = color;
    }



    // --- 按钮状态控制 ---
    const BTN = (t) => document.querySelector(`[onclick="clock('${t}')"]`);

    const btnClockIn  = BTN("CLOCK_IN");
    const btnClockOut = BTN("CLOCK_OUT");
    const btnMealIn   = BTN("MEAL_IN");
    const btnMealOut  = BTN("MEAL_OUT");
    const btnRestIn   = BTN("REST_IN");
    const btnRestOut  = BTN("REST_OUT");

    if (btnClockIn)  btnClockIn.disabled  = s.clockedIn;
    if (btnClockOut) btnClockOut.disabled = !s.clockedIn || s.inMeal || s.inRest;

    if (btnMealIn)  btnMealIn.disabled  = !s.clockedIn || s.inMeal || s.inRest;
    if (btnMealOut) btnMealOut.disabled = !s.inMeal;

    if (btnRestIn) {
      if (isTherapist) {
        btnRestIn.disabled = true;
      } else {
        btnRestIn.disabled = !s.clockedIn || s.inRest || s.inMeal;
      }
    }
    if (btnRestOut) {
      if (isTherapist) {
        btnRestOut.disabled = true;
      } else {
        btnRestOut.disabled = !s.inRest;
      }
    }
if (_userRole !== "admin") {
  await refreshMyMissedPunchUI();
}
  } catch (err) {
    // 如果 session 过期，回登录页
    window.location.href = "login.html";
  }
}


async function handleClock(type) {
  try {
    await api("/api/record", { method: "POST", json: { type, timestamp: new Date().toISOString() } });
    await loadRecords();
    await loadStateAndButtons();
  } catch (err) {
    toast(err.message || "Clock action failed.");
  }
}
const MAX_RECORDS_SHOWN = 50;  // 你可以改成 30 / 100 等

async function loadRecords() {
  try {
    const data = await api("/api/records");

    const log = document.getElementById("log");
    if (log) {
      const total = data.length;
      // 只拿最后 MAX_RECORDS_SHOWN 条
      const startIndex = Math.max(total - MAX_RECORDS_SHOWN, 0);
      const shown = data.slice(startIndex).reverse(); // 最新在上

      log.innerHTML = `
        <h3>Recent Records</h3>
        <div style="font-size:12px; color:#6b7280; margin-bottom:4px;">
          Showing ${shown.length} of ${total} records.
          ${total > shown.length ? "Use Excel export to see full history." : ""}
        </div>
        <ul style="list-style:none; padding-left:0; font-size:14px; margin:0;">
          ${shown
            .map(
              (r) => `<li style="padding:6px 0; border-bottom:1px solid #e5e7eb;">
                        <b>${r.type}</b> — ${formatLocal(r.timestamp)}
                      </li>`
            )
            .join("")}
        </ul>
      `;
    }
    return data;
  } catch (err) {
    return [];
  }
}

async function viewSummaryClient() {
  try {
    const sum = await api("/api/summary");
    toast(
      `Pay Period: ${sum.periodStart} – ${sum.periodEnd}\n` +
      `Total Work Hours: ${sum.totalHours} hrs\n` +
      `Regular: ${sum.regularHours} hrs | Overtime: ${sum.overtimeHours} hrs\n` +
      `Estimated Pay: $${sum.estimatedPay}`
    );
  } catch (e) {
    const rec = await loadRecords();
    const sum = computeSummaryClient(rec);
    toast(
      `Pay Period: ${sum.periodStart} – ${sum.periodEnd}\n` +
      `Total Work Hours: ${sum.totalHours} hrs\n` +
      `Total Breaks: ${sum.totalBreaks} hrs`
    );
  }
}
function exportCurrentMine() {
  // 导出当前双周周期（员工自己的）
  window.location.href = `/api/export?range=current`;
}

function exportAllMine() {
  // 导出该员工所有历史记录
  window.location.href = `/api/export`;
}

function exportMyCustom() {
  const start = document.getElementById("myRangeStart")?.value;
  const end   = document.getElementById("myRangeEnd")?.value;

  if (!start || !end) {
    return toast("Please choose both start and end dates.");
  }
  if (start > end) {
    return toast("Start date cannot be later than end date.");
  }

  const params = new URLSearchParams();
  params.set("range", "custom");
  params.set("start", start);
  params.set("end", end);

  window.location.href = `/api/export?${params.toString()}`;
}


function adminExportCurrent() {
  // 管理员导出“当前周期”的记录（可选指定某个员工）
  const sel = document.getElementById("adminEmployeeSelect");
  const params = new URLSearchParams();
  if (sel && sel.value) {
    params.set("employee", sel.value);
  }
  params.set("range", "current");
  window.location.href = `/api/export?${params.toString()}`;
}

function adminExportAll() {
  // 管理员导出所有周期的记录（可选指定某个员工）
  const sel = document.getElementById("adminEmployeeSelect");
  const params = new URLSearchParams();
  if (sel && sel.value) {
    params.set("employee", sel.value);
  }
  params.set("range", "all");
  const qs = params.toString();
  window.location.href = qs ? `/api/export?${qs}` : `/api/export`;
}

function adminExportCustom() {
  const sel   = document.getElementById("adminEmployeeSelect");
  const start = document.getElementById("adminRangeStart")?.value;
  const end   = document.getElementById("adminRangeEnd")?.value;

  if (!start || !end) {
    return toast("Please choose both start and end dates.");
  }
  if (start > end) {
    return toast("Start date cannot be later than end date.");
  }

  const params = new URLSearchParams();
  if (sel && sel.value) {
    params.set("employee", sel.value); // 可以指定某个人
  }
  params.set("range", "custom");
  params.set("start", start);
  params.set("end", end);

  window.location.href = `/api/export?${params.toString()}`;
}

async function logout() {
  try { await api("/api/logout", { method: "POST" }); }
  finally { window.location.href = "login.html"; }
}

// 页面初始化路由（**只有这一处 DOMContentLoaded**）
document.addEventListener("DOMContentLoaded", async () => {
  const path = (location.pathname || "").toLowerCase();

  if (path.endsWith("login.html")) {
    bindLoginPage();
    return;
  }

  if (path.endsWith("register.html")) {
    bindRegisterPage();
    return;
  }

  // 其它都认为是 index.html
  const ok = await ensureLoggedIn();
  if (!ok) return;

  // 绑定全局（兼容 inline）
  window.clock = handleClock;
  window.viewSummary = viewSummaryClient;

  // 员工导出按钮
  window.exportMyCurrent = exportCurrentMine;
  window.exportMyAll = exportAllMine;
  window.exportMyCustom = exportMyCustom;
window.adminReviewMissedPunch = adminReviewMissedPunch;

  // 兼容之前的 inline 调用
  window.exportCSV = exportCurrentMine;
  window.exportRecord = exportCurrentMine;

  // 管理员导出按钮
  window.adminExportCurrent = adminExportCurrent;
  window.adminExportAll = adminExportAll;
  window.adminExportCustom = adminExportCustom;
  // 兼容旧的 window.adminExport()
  window.adminExport = adminExportAll;

  window.logout = logout;

  // 第一次加载记录 & 状态
  await loadRecords();
  await loadStateAndButtons();

  // 欢迎栏的实时时钟
  startHelloClock();

  // 每 60 秒自动刷新一次状态（包括 rest 倒计时）
  setInterval(() => {
    loadStateAndButtons();
  }, 60 * 1000);
});
