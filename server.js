const express = require("express");
const path = require("path");
const fs = require("fs");
const session = require("express-session");
const bcrypt = require("bcrypt");
const ExcelJS = require("exceljs");

const app = express();
const PORT = 3000;

// ---- Files ----
const USERS_FILE = path.join(__dirname, "users.json");
const RECORDS_FILE = path.join(__dirname, "records.json");

// ---- Middleware ----
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: "360WPT_secret_key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      // secure: true, // 如果之后上 https 可以打开
      maxAge: 1000 * 60 * 60 * 8, // 8小时
    },
  })
);

// 静态资源
app.use(express.static(path.join(__dirname, "public")));

// ---- Ensure data files exist ----
function ensureFile(file, defaultContent) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, defaultContent);
}
ensureFile(
  USERS_FILE,
  JSON.stringify(
    [
      // 默认管理员：admin / 1025
      { 
        username: "admin", 
        password: bcrypt.hashSync("1025", 10), 
        role: "admin",
        group: "admin"        // ✅ 新增：给 admin 一个特殊 group
      },
    ],
    null,
    2
  )
);

ensureFile(RECORDS_FILE, "[]");


// ---- Helpers ----
const readUsers = () => JSON.parse(fs.readFileSync(USERS_FILE));
const writeUsers = (u) => fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2));
const readRecords = () => JSON.parse(fs.readFileSync(RECORDS_FILE));
const writeRecords = (r) => fs.writeFileSync(RECORDS_FILE, JSON.stringify(r, null, 2));

function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ message: "Not logged in" });
  next();
}

// 计算当前发薪周期：每月 1–15，16–月底
function getPayPeriodRange(date = new Date()) {
  const y = date.getFullYear();
  const m = date.getMonth(); // 0-11
  const d = date.getDate();

  let periodStart, periodEnd;

  if (d <= 15) {
    // 上半月：1 号到 15 号
    periodStart = new Date(y, m, 1);
    periodEnd   = new Date(y, m, 15);
  } else {
    // 下半月：16 号到当月最后一天
    periodStart = new Date(y, m, 16);
    // day=0 of next month = 当前月最后一天
    periodEnd   = new Date(y, m + 1, 0);
  }

  // 统一设为当天 00:00，本地时间
  periodStart.setHours(0, 0, 0, 0);
  periodEnd.setHours(0, 0, 0, 0);

  return { periodStart, periodEnd };
}


// 根据员工所有记录推导当前状态（更稳，不仅看最后一条）
function computeState(records) {
  let clockedIn = false;
  let inMeal = false;
  let inRest = false;

  for (const r of records.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))) {
    switch (r.type) {
      case "CLOCK_IN":
        if (!clockedIn && !inMeal && !inRest) clockedIn = true;
        break;
      case "CLOCK_OUT":
        if (clockedIn && !inMeal && !inRest) clockedIn = false;
        break;
      case "MEAL_IN":
        if (clockedIn && !inMeal && !inRest) inMeal = true;
        break;
      case "MEAL_OUT":
        if (inMeal) inMeal = false;
        break;
      case "REST_IN":
        if (clockedIn && !inRest && !inMeal) inRest = true;
        break;
      case "REST_OUT":
        if (inRest) inRest = false;
        break;
    }
  }
  return { clockedIn, inMeal, inRest };
}
function nameOf(employee) {
  const users = readUsers();
  const u = users.find(
    (x) => x.employee === employee || x.username === employee
  );
  return (u && (u.name || u.username)) || employee;
}

// 柔蓝表头 + 边框美化
function styleHeader(row) {
  row.font = { bold: true, color: { argb: "FF1E293B" } };
  row.alignment = { vertical: "middle", horizontal: "center" };
  row.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F1FF" } }; // 柔和浅蓝
    c.border = {
      top:    { style: "thin", color: { argb: "FFCBD5E1" } },
      bottom: { style: "thin", color: { argb: "FFCBD5E1" } },
      left:   { style: "thin", color: { argb: "FFCBD5E1" } },
      right:  { style: "thin", color: { argb: "FFCBD5E1" } },
    };
  });
}

// 普通单元格样式
function styleBody(row) {
  row.eachCell(c => {
    c.alignment = { vertical: "middle", horizontal: "center" };
    c.border = {
      top: { style: "thin", color: { argb: "FFE2E8F0" } },
      bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
      left: { style: "thin", color: { argb: "FFE2E8F0" } },
      right: { style: "thin", color: { argb: "FFE2E8F0" } },
    };
  });
}



function styleSectionTitle(row){
  row.font = { bold: true, size: 12, color: { argb: "FF1E3A8A" } };
}
function styleTableRow(row){
  row.eachCell(c => {
    c.border = {
      top:    { style:"thin", color:{ argb:"FFE5E7EB" } },
      bottom: { style:"thin", color:{ argb:"FFE5E7EB" } },
    };
  });
}


// ---- Date helpers for daily summary ----
function pad(n) { return String(n).padStart(2, "0"); }
function localYMD(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localHM(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 把记录按 “employee + 本地日期(yyyy-mm-dd)” 分组，并计算每日汇总 */
function buildDailySummary(rows) {
  // rows: [{ employee, type, timestamp }]
  const grouped = new Map(); // key = `${employee}__${ymd}` -> array of records
  for (const r of rows) {
    const key = `${r.employee}__${localYMD(r.timestamp)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  }

  const summaries = [];
  for (const [key, list] of grouped.entries()) {
    const [employee, ymd] = key.split("__");
    const sorted = list
      .map(r => ({ ...r, t: new Date(r.timestamp).getTime() }))
      .sort((a, b) => a.t - b.t);

    let workMin = 0, lunchMin = 0, restMin = 0;
    let ci = null, mi = null, ri = null;
    let firstIn = null, lastOut = null;
    const events = [];

    for (const r of sorted) {
      events.push(`${localHM(r.t)} ${r.type}`);
      switch (r.type) {
        case "CLOCK_IN":
          ci = r.t;
          if (!firstIn) firstIn = r.t;
          break;
        case "CLOCK_OUT":
          if (ci != null) {
            workMin += (r.t - ci) / 60000;
            lastOut = r.t;
            ci = null;
          }
          break;
        case "MEAL_IN":
          mi = r.t;
          break;
        case "MEAL_OUT":
          if (mi != null) {
            lunchMin += (r.t - mi) / 60000;
            mi = null;
          }
          break;
        case "REST_IN":
          ri = r.t;
          break;
        case "REST_OUT":
          if (ri != null) {
            restMin += (r.t - ri) / 60000;
            ri = null;
          }
          break;
      }
    }

    const workH = +(workMin / 60).toFixed(2);
    const lunchH = +(lunchMin / 60).toFixed(2);
    const restH = +(restMin / 60).toFixed(2);
    const payableH = +(Math.max(0, workH - lunchH)).toFixed(2); // 不扣 rest

    summaries.push({
      employee,
      date: ymd,
      firstIn: firstIn ? localHM(firstIn) : "",
      lastOut: lastOut ? localHM(lastOut) : "",
      events: events.join(" | "),
      workHours: workH,
      lunchHours: lunchH,
      restHours: restH,
      payableHours: payableH,
    });
  }

  // 排序：employee -> date
  summaries.sort((a, b) => {
    if (a.employee === b.employee) return a.date.localeCompare(b.date);
    return (a.employee || "").localeCompare(b.employee || "");
  });

  return summaries;
}

// ---- one-time upgrade: ensure admin has a display name ----
(function ensureAdminHasName() {
  const users = readUsers();
  const admin = users.find(u => u.username === "admin");
  if (admin && !admin.name) {
    admin.name = "360WPT Admin";   // 你也可以改成 "Administrator"
    writeUsers(users);
  }
})();

// ---- Routes ----

// 根路径：按是否登录返回页面
// 注册（创建普通员工账号）：username + password + name(真实姓名)
// 内部 employee 唯一ID默认用 username 存（便于兼容现有逻辑）
app.post("/api/register", async (req, res) => {
  const { username, password, name, group } = req.body || {};
  if (!username || !password || !name) {
    return res.status(400).json({ message: "All fields required." });
  }

  const users = readUsers();
  if (users.find((u) => u.username === username)) {
    return res.status(400).json({ message: "Username already exists." });
  }

  const hashed = await bcrypt.hash(password, 10);

  // ✅ 规范化 group：只认 therapist / non-therapist 两种
  const normalizedGroup =
    group === "Therapist" || group === "therapist"
      ? "therapist"
      : "non-therapist"; // 前端没传或乱传就当 non-therapist

  users.push({
    username,
    password: hashed,
    role: "employee",
    employee: username,   // 系统的唯一ID，用 username 充当
    name,                 // 真实姓名
    group: normalizedGroup
  });

  writeUsers(users);
  res.json({ success: true });
});



// 登录
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  const users = readUsers();
  const user = users.find((u) => u.username === username);
  if (!user) return res.status(401).json({ message: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ message: "Invalid credentials" });

  req.session.user = {
    username: user.username,
    role: user.role,
    employee: user.employee || null,
  };
  res.json({ success: true, role: user.role });
});

// 登出
app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/api/state", requireLogin, (req, res) => {
  const all = readRecords();
  const u = req.session.user;

  const mine = u.role === "employee"
    ? all.filter(r => r.employee === u.employee)
    : all;

  const state = computeState(u.role === "employee" ? mine : []);

  const users = readUsers();
  const me = users.find(x => x.username === u.username);
  const displayName = me?.name || "";
  const group = me?.group || "non-therapist";   // ✅ 没有就默认 non-therapist

  res.json({
    ...state,
    role: u.role,
    employee: u.employee,
    username: u.username,
    displayName,
    group                       // ✅ 前端之后可以用这个隐藏按钮
  });
});


// 管理员获取员工列表（用于导出时选择员工）
app.get("/api/employees", requireLogin, (req, res) => {
  const u = req.session.user;
  if (u.role !== "admin") {
    return res.status(403).json({ message: "Forbidden" });
  }
  const users = readUsers();
  const employees = users
    .filter((x) => x.role === "employee")
    .map((x) => ({
      employee: x.employee || x.username,
      username: x.username,
      name: x.name || "",
      displayName: x.name || x.username,
    }))
    .sort((a, b) => (a.displayName || "").localeCompare(b.displayName || ""));
  res.json(employees);
});



// 当前用户记录（员工只看自己；管理员默认看全部，也可通过 ?employee=E001 指定）
app.get("/api/records", requireLogin, (req, res) => {
  const u = req.session.user;
  const all = readRecords();

  if (u.role === "admin") {
    const { employee } = req.query || {};
    if (employee) return res.json(all.filter((r) => r.employee === employee));
    return res.json(all);
  }
  res.json(all.filter((r) => r.employee === u.employee));
});

// 记一条打卡记录（基于当前状态校验序列合法）
app.post("/api/record", requireLogin, (req, res) => {
  const { type, timestamp } = req.body || {};
  const u = req.session.user;

  if (u.role !== "employee" && u.role !== "admin") {
    return res.status(403).json({ message: "Forbidden" });
  }
  // 对于管理员：不允许代表别人打卡（如需可扩展）
  if (u.role === "admin" && !u.employee) {
    return res.status(400).json({ message: "Admin has no personal timesheet." });
  }

  const all = readRecords();
  const mine = all
    .filter((r) => r.employee === u.employee)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const state = computeState(mine);

  // ✅ 读出当前用户的 group（老用户没有 group 时默认 non-therapist）
  const users = readUsers();
  const me = users.find((x) => x.username === u.username);
  const group = me?.group || "non-therapist";

  let allowed = false;
  let errorMsg = "Invalid clock sequence";

  // ✅ 校验动作合法 + 加上 rest break 3.5 小时逻辑
  switch (type) {
    case "CLOCK_IN":
      allowed = !state.clockedIn && !state.inMeal && !state.inRest;
      break;

    case "CLOCK_OUT":
      allowed = state.clockedIn && !state.inMeal && !state.inRest;
      break;

    case "MEAL_IN":
      allowed = state.clockedIn && !state.inMeal && !state.inRest;
      break;

    case "MEAL_OUT":
      allowed = state.inMeal;
      break;
      
case "REST_IN":
  // ① 基础状态：要在上班中，且当前不在 rest / lunch
  allowed = state.clockedIn && !state.inRest && !state.inMeal;
  if (!allowed) break;

  // ② Therapist 完全禁止 rest break
  if (group === "therapist") {
    allowed = false;
    errorMsg = "Rest break is disabled for therapists.";
    break;
  }

  // ✅ non-therapist：不再等待 3.5 小时，直接允许
  break;

    case "REST_OUT":
      allowed = state.inRest;
      break;

    default:
      allowed = false;
      errorMsg = "Unknown record type";
      break;
  }

  if (!allowed) {
    return res
      .status(400)
      .json({ success: false, message: errorMsg });
  }

  all.push({
    employee: u.employee,
    type,
    timestamp: timestamp || new Date().toISOString(),
  });
  writeRecords(all);
  res.json({ success: true });
});


// 双周汇总（服务器版本，可被前端调用；前端已内置客户端计算作为备份）
app.get("/api/summary", requireLogin, (req, res) => {
  const u = req.session.user;
  const all = readRecords();
  const mine = all.filter((r) => r.employee === u.employee).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const { periodStart, periodEnd } = getPayPeriodRange(new Date());
  const start = periodStart.getTime();
  const end = periodEnd.getTime() + 24 * 3600 * 1000 - 1;

  const rec = mine
    .map((r) => ({ ...r, t: new Date(r.timestamp).getTime() }))
    .filter((r) => r.t >= start && r.t <= end);

  let workMin = 0, mealMin = 0, restMin = 0;
  let clockIn = null, mealIn = null, restIn = null;

  for (const r of rec) {
    if (r.type === "CLOCK_IN") {
      clockIn = r.t;
    } else if (r.type === "CLOCK_OUT") {
      if (clockIn != null) {
        workMin += (r.t - clockIn) / 60000;
        clockIn = null;
      }
    } else if (r.type === "MEAL_IN") {
      mealIn = r.t;
    } else if (r.type === "MEAL_OUT") {
      if (mealIn != null) {
        mealMin += (r.t - mealIn) / 60000;
        mealIn = null;
      }
    } else if (r.type === "REST_IN") {
      restIn = r.t;
    } else if (r.type === "REST_OUT") {
      if (restIn != null) {
        restMin += (r.t - restIn) / 60000;
        restIn = null;
      }
    }
  }

  const totalBreaks = (mealMin + restMin) / 60;
  const totalHours  = (workMin - mealMin) / 60;  // ✅ 同样只扣 lunch


  res.json({
    periodStart: periodStart.toDateString(),
    periodEnd: periodEnd.toDateString(),
    totalHours: Math.max(0, Number(totalHours.toFixed(2))),
    totalBreaks: Math.max(0, Number(totalBreaks.toFixed(2))),
  });
});

// 导出：员工导出自己的“每日汇总”；管理员导出“所有员工每日汇总”（并附原始记录工作表）
app.get("/api/export", requireLogin, async (req, res) => {
  const { employee, range = "all", start, end } = req.query || {};
  const u = req.session.user;
  const all = readRecords();


  // 范围：管理员=全部或指定 employee；员工=本人
  let dataset = [];
  if (u.role === "admin") {
    dataset = employee ? all.filter(r => r.employee === employee) : all;
  } else {
    dataset = all.filter(r => r.employee === u.employee);
  }

    // 时间范围过滤：current / custom / all
  let startMs = null;
  let endMs = null;

  if (range === "current") {
    // 用和 /api/summary 同一套“双周 pay period”逻辑
    const { periodStart, periodEnd } = getPayPeriodRange(new Date());
    startMs = periodStart.getTime();
    endMs = periodEnd.getTime() + 24 * 3600 * 1000 - 1;
  } else if (range === "custom" && start && end) {
    // 自定义日期：YYYY-MM-DD
    const startDate = new Date(start + "T00:00:00");
    const endDate   = new Date(end   + "T00:00:00");
    if (!isNaN(startDate) && !isNaN(endDate)) {
      startMs = startDate.getTime();
      endMs   = endDate.getTime() + 24 * 3600 * 1000 - 1;
    }
  }

  if (startMs != null && endMs != null) {
    dataset = dataset.filter((r) => {
      const t = new Date(r.timestamp).getTime();
      return t >= startMs && t <= endMs;
    });
  }


  // 日汇总
  const summary = buildDailySummary(dataset);

  // ===== Excel（Summary + Records）=====
  const wb = new ExcelJS.Workbook();

  // Summary
  const ws = wb.addWorksheet("Summary", { properties: { defaultRowHeight: 18 } });
  ws.columns = [
    { header: "Date",          key: "date",         width: 12 },
    { header: "First In",      key: "firstIn",      width: 10 },
    { header: "Last Out",      key: "lastOut",      width: 10 },
    { header: "Work Hours",    key: "workHours",    width: 12 },
    { header: "Lunch Hours",   key: "lunchHours",   width: 12 },
    { header: "Rest Hours",    key: "restHours",    width: 12 },
    { header: "Payable Hours", key: "payableHours", width: 14 },
  ];

  // 按员工分区
  const byEmp = new Map();
  summary.forEach(r => {
    if (!byEmp.has(r.employee)) byEmp.set(r.employee, []);
    byEmp.get(r.employee).push(r);
  });

  for (const emp of Array.from(byEmp.keys()).sort()) {
    const rows = byEmp.get(emp);
    const empName = nameOf(emp);

    // 区块标题（姓名 + 内部ID）
    const titleRowIdx = ws.lastRow ? ws.lastRow.number + 2 : 1;
    const titleRow = ws.getRow(titleRowIdx);
    titleRow.getCell(1).value = `Employee: ${empName} (${emp})`;
    styleSectionTitle(titleRow);
    titleRow.commit();
    ws.mergeCells(titleRowIdx, 1, titleRowIdx, 7);

    // 表头（只给已用 7 列上色）
    const headerRow = ws.addRow(ws.columns.map(c => c.header));
    styleHeader(headerRow);

    // 数据行 + 小计
    let sumWork = 0, sumLunch = 0, sumRest = 0, sumPay = 0;
    rows.forEach(r => {
      const dataRow = ws.addRow([
        r.date, r.firstIn, r.lastOut,
        r.workHours, r.lunchHours, r.restHours, r.payableHours
      ]);
      styleBody(dataRow);
      sumWork  += r.workHours;
      sumLunch += r.lunchHours;
      sumRest  += r.restHours;
      sumPay   += r.payableHours;
    });

    // 小计行：加粗、淡灰底、四边框
    const subtotal = ws.addRow([
      "", "", "Subtotal",
      +sumWork.toFixed(2),
      +sumLunch.toFixed(2),
      +sumRest.toFixed(2),
      +sumPay.toFixed(2)
    ]);
    subtotal.font = { bold: true, color: { argb: "FF0F172A" } };
    subtotal.eachCell(c => {
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
      c.border = {
        top:    { style: "thin", color: { argb: "FFCBD5E1" } },
        bottom: { style: "thin", color: { argb: "FFCBD5E1" } },
        left:   { style: "thin", color: { argb: "FFCBD5E1" } },
        right:  { style: "thin", color: { argb: "FFCBD5E1" } },
      };
    });

    // 分隔空白行
    const spacer = ws.addRow(["","","","","","",""]);
    spacer.height = 6;
  } // ← 别漏这个大括号（关闭 for 循环）

  // Records 明细（循环外）
  const ws2 = wb.addWorksheet("Records", { properties: { defaultRowHeight: 18 } });
  ws2.columns = [
    { header: "Name",        key: "name",      width: 18 },
    { header: "Employee ID", key: "employee",  width: 16 },
    { header: "Type",        key: "type",      width: 14 },
    { header: "Timestamp",   key: "timestamp", width: 26 },
    { header: "Local Date",  key: "date",      width: 12 },
    { header: "Local Time",  key: "time",      width: 10 },
  ];
  styleHeader(ws2.addRow(ws2.columns.map(c => c.header)));

  dataset
    .map(r => ({ ...r, t: new Date(r.timestamp).getTime() }))
    .sort((a,b) => a.employee === b.employee ? a.t - b.t
                  : (a.employee || "").localeCompare(b.employee || ""))
    .forEach(r => {
      const row = ws2.addRow([
        nameOf(r.employee),
        r.employee || "",
        r.type,
        r.timestamp,
        localYMD(r.timestamp),
        localHM(r.t),
      ]);
      styleBody(row);
    });

  // 下载响应
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${u.role === 'admin'
      ? 'All_Employees_Summary'
      : (nameOf(u.employee) || 'My') + '_Summary'
    }.xlsx"`
  );
  res.setHeader("Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  await wb.xlsx.write(res);
  res.end();
});


// ---- Start server ----
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ 360WPT TimeClock running at http://localhost:${PORT}`);
});
