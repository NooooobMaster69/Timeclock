/* ===============================
   360WPT TimeClock - Frontend JS
   Works for: login.html, register.html, index.html
   =============================== */

// ---------- 小工具 ----------
const $ = (sel) => document.querySelector(sel);

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
  if (btn) btn.addEventListener("click", handleLogin);

  ["#username", "#password"].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleLogin();
    });
  });

  // 兼容 inline onclick="login()"
  window.login = handleLogin;
}

// ---------- 注册页逻辑 ----------
async function register() {
  const username = $("#username")?.value.trim();
  const name     = $("#name")?.value.trim();
  const password = $("#password")?.value.trim();
  const groupEl  = $("#group");
  const rawGroup = groupEl ? groupEl.value : "non-therapist";

  // 规范成后端认识的两种：therapist / non-therapist
  const group =
    rawGroup === "therapist" || rawGroup === "Therapist"
      ? "therapist"
      : "non-therapist";

  if (!username || !password || !name) {
    toast("All fields are required.");
    return;
  }

  try {
    await api("/api/register", {
      method: "POST",
      json: { username, password, name, group }
    });
    toast("✅ Registration successful! Please login.");
    window.location.href = "login.html";
  } catch (e) {
    toast(e.message);
  }
}

function bindRegisterPage() {
  const btn = $("#registerBtn") || document.querySelector('button[onclick="register()"]');
  if (btn) btn.addEventListener("click", register);

  ["#username", "#name", "#password", "#group"].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") register();
    });
  });

  // 兼容 inline onclick="register()"
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

  // 非管理员：隐藏整个 Admin 区域
  if (role !== "admin") {
    adminZone.style.display = "none";
    return;
  }

  adminZone.style.display = "block";

  const select = document.getElementById("adminEmployeeSelect");
  if (!select || select.dataset.loaded === "1") return;

  try {
    const list = await api("/api/employees");
    // 保留第一个 "All employees"
    while (select.options.length > 1) {
      select.remove(1);
    }
    list.forEach((emp) => {
      const opt = document.createElement("option");
      opt.value = emp.employee;
      opt.textContent = emp.displayName || emp.employee;
      select.appendChild(opt);
    });
    select.dataset.loaded = "1";
  } catch (err) {
    console.error("Failed to load employees", err);
  }
}


async function loadStateAndButtons() {
  try {
    const s = await api("/api/state");
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
  const rec = await loadRecords();
  const sum = computeSummaryClient(rec);
  toast(
    `Pay Period: ${sum.periodStart} – ${sum.periodEnd}\n` +
    `Total Work Hours: ${sum.totalHours} hrs\n` +
    `Total Breaks: ${sum.totalBreaks} hrs`
  );
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
