const express = require("express");
const path = require("path");
const fs = require("fs");
const session = require("express-session");
const bcrypt = require("bcrypt");
const ExcelJS = require("exceljs");

const app = express();
const PORT = 3000;
const IS_PROD = process.env.NODE_ENV === "production";

// ---- Security Config ----
const SESSION_SECRET = process.env.SESSION_SECRET || "DEV_INSECURE_CHANGE_ME";
if (!process.env.SESSION_SECRET) {
    if (IS_PROD) {
    throw new Error("SESSION_SECRET must be set in production.");
  }
  console.warn("⚠️ SESSION_SECRET is not set. Using a default dev secret.");
}

// Trust proxy when behind a load balancer (required for secure cookies)
app.set("trust proxy", 1);

// ---- Files ----
const USERS_FILE = path.join(__dirname, "users.json");
const RECORDS_FILE = path.join(__dirname, "records.json");
const MISSED_FILE = path.join(__dirname, "missed_punch.json");

// ---- Middleware ----
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));
app.disable("x-powered-by");

// Basic security headers (lightweight replacement for helmet)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("X-XSS-Protection", "0");
  next();
});

// Simple in-memory rate limiter
function createRateLimiter({ windowMs, max, keyFn, name }) {
  const hits = new Map(); // key -> { count, resetAt }
  const cleanupInterval = Math.max(30_000, Math.min(windowMs, 5 * 60_000));

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits.entries()) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, cleanupInterval).unref();

  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.ip;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= max) {
      res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({ message: `${name || "Rate limit"} exceeded. Try again later.` });
    }
    entry.count += 1;
    return next();
  };
}

const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  name: "Login",
  keyFn: (req) => `${req.ip}:${String(req.body?.username || "")}`.toLowerCase(),
});
const registerLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  name: "Register",
});
const writeLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: "Write",
});

app.use(
  session({
      name: "timeclock.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: IS_PROD,
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
        password: bcrypt.hashSync("1021", 10), 
        role: "admin",
        group: "admin"        // ✅ 新增：给 admin 一个特殊 group
      },
    ],
    null,
    2
  )
);

ensureFile(RECORDS_FILE, "[]");
ensureFile(MISSED_FILE, "[]");


// ---- Helpers ----
const readUsers = () => JSON.parse(fs.readFileSync(USERS_FILE));
const writeUsers = (u) => fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2));
const readRecords = () => JSON.parse(fs.readFileSync(RECORDS_FILE));
const writeRecords = (r) => fs.writeFileSync(RECORDS_FILE, JSON.stringify(r, null, 2));
const readMissed = () => JSON.parse(fs.readFileSync(MISSED_FILE));
const writeMissed = (m) => fs.writeFileSync(MISSED_FILE, JSON.stringify(m, null, 2));

const MAX_USERNAME_LEN = 48;
const MAX_NAME_LEN = 80;
const MAX_PASSWORD_LEN = 128;

function normalizeUsername(input) {
  return String(input || "").trim();
}

function normalizeName(input) {
  return String(input || "").trim();
}

function isValidUsername(username) {
  return (
    username.length >= 3 &&
    username.length <= MAX_USERNAME_LEN &&
    /^[a-zA-Z0-9._-]+$/.test(username)
  );
}

function isValidName(name) {
  return name.length >= 1 && name.length <= MAX_NAME_LEN;
}

function isValidPassword(password) {
  return password.length >= 8 && password.length <= MAX_PASSWORD_LEN;
}

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


function computeState(records, now = new Date()) {
  let clockedIn = false;
  let inMeal = false;
  let inRest = false;

  // Map<ymd, Set<missingType>>
  const missedMap = new Map();

  const sorted = [...records].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  let lastYmd = null;

  function markMissed(ymd) {
    if (!ymd) return;
    const miss = new Set(missedMap.get(ymd) || []);
    if (inMeal) miss.add("MEAL_OUT");
    if (inRest) miss.add("REST_OUT");
    if (clockedIn) miss.add("CLOCK_OUT");
    if (miss.size > 0) missedMap.set(ymd, miss);

    // 跨天就软重置，避免第二天被卡住
    clockedIn = false;
    inMeal = false;
    inRest = false;
  }

  for (const r of sorted) {
    const ymd = localYMD(r.timestamp);

    if (lastYmd && ymd !== lastYmd) {
      // 从 lastYmd 跨到了新的一天：如果上一天没收口，就记 missed
      if (clockedIn || inMeal || inRest) markMissed(lastYmd);
    }
    lastYmd = ymd;

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

  // 关键：就算今天没有任何新记录，只要 now 已经是新的一天，也要把昨天 open 的状态记为 missed 并 reset
  const todayYmd = localYMD(now);
  if (lastYmd && todayYmd !== lastYmd && (clockedIn || inMeal || inRest)) {
    markMissed(lastYmd);
  }

  const missedDays = Array.from(missedMap.entries())
    .map(([date, set]) => ({ date, missing: Array.from(set).sort() }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { clockedIn, inMeal, inRest, missedDays };
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

function isValidYMD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}
function isValidHM(s) {
  if (!/^\d{2}:\d{2}$/.test(String(s || ""))) return false;
  const [hh, mm] = s.split(":").map(Number);
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
}
function ymdToParts(ymd) {
  const [Y, M, D] = ymd.split("-").map(Number);
  return { Y, M, D };
}
function hmToParts(hm) {
  const [h, m] = hm.split(":").map(Number);
  return { h, m };
}
function localDateTimeMs(ymd, hm) {
  const { Y, M, D } = ymdToParts(ymd);
  const { h, m } = hmToParts(hm);
  return new Date(Y, M - 1, D, h, m, 0, 0).getTime(); // 本地时区
}
function computeHoursFromMissed(mp) {
  // 必填：clockIn / clockOut
  const inMs = localDateTimeMs(mp.date, mp.clockIn);
  const outMs = localDateTimeMs(mp.date, mp.clockOut);
  let workMin = (outMs - inMs) / 60000;
  if (workMin < 0) workMin += 24 * 60; // 理论上你们不会跨夜，但加个兜底
  if (workMin <= 0 || workMin > 20 * 60) return null;

  let lunchMin = 0;
  if (mp.mealIn && mp.mealOut) {
    const mi = localDateTimeMs(mp.date, mp.mealIn);
    const mo = localDateTimeMs(mp.date, mp.mealOut);
    let m = (mo - mi) / 60000;
    if (m < 0) m += 24 * 60;
    if (m > 0 && m <= 6 * 60) lunchMin = m;
  }

  let restMin = 0;
  if (mp.restIn && mp.restOut) {
    const ri = localDateTimeMs(mp.date, mp.restIn);
    const ro = localDateTimeMs(mp.date, mp.restOut);
    let r = (ro - ri) / 60000;
    if (r < 0) r += 24 * 60;
    if (r > 0 && r <= 3 * 60) restMin = r;
  }

  const workH = +(workMin / 60).toFixed(2);
  const lunchH = +(lunchMin / 60).toFixed(2);
  const restH = +(restMin / 60).toFixed(2);
  const payableH = +(Math.max(0, workH - lunchH)).toFixed(2);

  return { workHours: workH, lunchHours: lunchH, restHours: restH, payableHours: payableH };
}

// ===== Apply approved missed punch into records.json (方案一) =====
const PUNCH_TYPES = ["CLOCK_IN","CLOCK_OUT","MEAL_IN","MEAL_OUT","REST_IN","REST_OUT"];

function applyMissedPunchToRecords(mp) {
  const hours = computeHoursFromMissed(mp);
  if (!hours) throw new Error("Invalid missed punch time range.");

  const events = [
    { type: "CLOCK_IN",  hm: mp.clockIn },
    { type: "CLOCK_OUT", hm: mp.clockOut },
  ];
  if (mp.mealIn && mp.mealOut) {
    events.push({ type: "MEAL_IN", hm: mp.mealIn });
    events.push({ type: "MEAL_OUT", hm: mp.mealOut });
  }
  if (mp.restIn && mp.restOut) {
    events.push({ type: "REST_IN", hm: mp.restIn });
    events.push({ type: "REST_OUT", hm: mp.restOut });
  }

  let records = readRecords();

  const isPunch = (t) => ["CLOCK_IN","CLOCK_OUT","MEAL_IN","MEAL_OUT","REST_IN","REST_OUT"].includes(t);
  const sameKey = (r) => r.employee === mp.employee && localYMD(r.timestamp) === mp.date && isPunch(r.type);

  // ✅ 1) 把将要被覆盖的旧记录先存下来（审计）
  const removed = records.filter(sameKey);

  // ✅ 2) 覆盖式写入：先删掉旧 punch，再写入新 punch
  records = records.filter(r => !sameKey(r));

  const inserted = [];
  const nowIso = new Date().toISOString();

  for (const e of events) {
    const ts = new Date(localDateTimeMs(mp.date, e.hm)).toISOString();
    const rec = {
      employee: mp.employee,
      type: e.type,
      timestamp: ts,
      // ✅ 追溯字段（不影响你现有计算逻辑）
      source: "MISSED_PUNCH",
      requestId: mp.id,
      createdAt: nowIso,
    };
    records.push(rec);
    inserted.push(rec);
  }

  records.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  writeRecords(records);

  return { removed, inserted, hours };
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
app.post("/api/register", registerLimiter, async (req, res) => {
  const { username, password, name, group } = req.body || {};
  const normalizedUsername = normalizeUsername(username);
  const normalizedName = normalizeName(name);

  if (!normalizedUsername || !password || !normalizedName) {
    return res.status(400).json({ message: "All fields required." });
  }
  if (!isValidUsername(normalizedUsername)) {
    return res.status(400).json({ message: "Username must be 3-48 chars, letters/numbers/._- only." });
  }
  if (!isValidName(normalizedName)) {
    return res.status(400).json({ message: "Name is too long." });
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({ message: "Password must be 8-128 characters." });
  }

  const users = readUsers();
  if (users.find((u) => u.username === normalizedUsername)) {
    return res.status(400).json({ message: "Username already exists." });
  }

  const hashed = await bcrypt.hash(password, 10);

  // ✅ 规范化 group：只认 therapist / non-therapist 两种
  const normalizedGroup =
    group === "Therapist" || group === "therapist"
      ? "therapist"
      : "non-therapist"; // 前端没传或乱传就当 non-therapist

  users.push({
    username: normalizedUsername,
    password: hashed,
    role: "employee",
    employee: normalizedUsername,   // 系统的唯一ID，用 username 充当
    name: normalizedName,           // 真实姓名
    group: normalizedGroup
  });

  writeUsers(users);
  res.json({ success: true });
});



// 登录
app.post("/api/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
    const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername || !password) {
    return res.status(400).json({ message: "Username and password required." });
  }
  if (!isValidUsername(normalizedUsername) || password.length > MAX_PASSWORD_LEN) {
    return res.status(400).json({ message: "Invalid credentials." });
  }
  const users = readUsers();
  const user = users.find((u) => u.username === normalizedUsername);
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

 const mine = u.role === "employee" ? all.filter(r => r.employee === u.employee) : [];
const state = computeState(mine, new Date());


  const users = readUsers();
  const me = users.find(x => x.username === u.username);
  const displayName = me?.name || "";
  const group = me?.group || "non-therapist";   // ✅ 没有就默认 non-therapist

  // 只给前端当前 pay period 内的 missedDays（避免提示太多历史）
const { periodStart, periodEnd } = getPayPeriodRange(new Date());
const startYmd = localYMD(periodStart);
const endYmd = localYMD(periodEnd);

const missedDaysInPeriod = (state.missedDays || []).filter(x => x.date >= startYmd && x.date <= endYmd);

  res.json({
  clockedIn: state.clockedIn,
inMeal: state.inMeal,
inRest: state.inRest,
missedDays: missedDaysInPeriod,

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
app.post("/api/record", requireLogin, writeLimiter, (req, res) => {
  const { type } = req.body || {};
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
  const state = computeState(mine, new Date());


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
  timestamp: new Date().toISOString(), // ✅ 一律用服务器时间
});
  writeRecords(all);
  res.json({ success: true });
});

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).json({ message: "Forbidden" });
  }
  next();
}

// 员工提交 Missed Punch Request
app.post("/api/missed_punch", requireLogin, writeLimiter, (req, res) => {
  const u = req.session.user;
  if (u.role !== "employee") return res.status(403).json({ message: "Forbidden" });

  const users = readUsers();
  const me = users.find(x => x.username === u.username);
  const group = me?.group || "non-therapist";

  const body = req.body || {};
  const mp = {
    employee: u.employee,
    date: String(body.date || "").trim(),
    clockIn: String(body.clockIn || "").trim(),
    clockOut: String(body.clockOut || "").trim(),
    mealIn: body.mealIn ? String(body.mealIn).trim() : "",
    mealOut: body.mealOut ? String(body.mealOut).trim() : "",
    restIn: body.restIn ? String(body.restIn).trim() : "",
    restOut: body.restOut ? String(body.restOut).trim() : "",
    note: body.note ? String(body.note).trim() : ""
  };

  // 基础校验
  if (!isValidYMD(mp.date)) return res.status(400).json({ message: "Invalid date (YYYY-MM-DD)" });
  if (!isValidHM(mp.clockIn) || !isValidHM(mp.clockOut)) {
    return res.status(400).json({ message: "clockIn/clockOut required (HH:MM)" });
  }

  // meal 成对
  const hasMealIn = !!mp.mealIn;
  const hasMealOut = !!mp.mealOut;
  if (hasMealIn !== hasMealOut) {
    return res.status(400).json({ message: "mealIn and mealOut must be both filled or both empty." });
  }
  if (hasMealIn && (!isValidHM(mp.mealIn) || !isValidHM(mp.mealOut))) {
    return res.status(400).json({ message: "Invalid meal time (HH:MM)" });
  }

  // rest 成对 + therapist 禁止
  const hasRestIn = !!mp.restIn;
  const hasRestOut = !!mp.restOut;
  if (hasRestIn !== hasRestOut) {
    return res.status(400).json({ message: "restIn and restOut must be both filled or both empty." });
  }
  if (hasRestIn && (!isValidHM(mp.restIn) || !isValidHM(mp.restOut))) {
    return res.status(400).json({ message: "Invalid rest time (HH:MM)" });
  }
  if (group === "therapist" && (hasRestIn || hasRestOut)) {
    return res.status(400).json({ message: "Rest break is disabled for therapists." });
  }

  // 计算一下是否合理（防止 out 早于 in 等）
  const hours = computeHoursFromMissed(mp);
  if (!hours) return res.status(400).json({ message: "Invalid time range in request." });

  const all = readMissed();

  // ✅ 防止同一天重复提交（只允许在 denied/cancelled 后重新提交）
  const sameDay = all
    .filter(x => x.employee === mp.employee && x.date === mp.date)
    .sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || ""));
  const latest = sameDay[0];
  const latestStatus = String(latest?.status || "").toLowerCase();

  if (latest && !["denied", "cancelled"].includes(latestStatus)) {
    return res.status(409).json({
      message: `A request for ${mp.date} already exists (status: ${latestStatus}).`
    });
  }


  const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  all.push({
    id,
    ...mp,
    status: "pending",
    submittedAt: new Date().toISOString(),
    reviewedAt: "",
    reviewedBy: "",
    decisionNote: ""
  });
  writeMissed(all);

  res.json({ success: true, id });
});

// 查询 Missed Punch（员工只能看自己；管理员可看全部并筛选）
app.get("/api/missed_punch", requireLogin, (req, res) => {
  const u = req.session.user;
  const { status, employee, range = "all", start, end } = req.query || {};

  let list = readMissed();

  if (u.role === "employee") {
    list = list.filter(x => x.employee === u.employee);
  } else if (u.role === "admin") {
    if (employee) list = list.filter(x => x.employee === employee);
  } else {
    return res.status(403).json({ message: "Forbidden" });
  }

  if (status) list = list.filter(x => x.status === status);

  // range 过滤（all / current / custom）
  if (range === "current") {
    const { periodStart, periodEnd } = getPayPeriodRange(new Date());
    const s = localYMD(periodStart);
    const e = localYMD(periodEnd);
    list = list.filter(x => x.date >= s && x.date <= e);
  } else if (range === "custom" && start && end && isValidYMD(start) && isValidYMD(end)) {
    list = list.filter(x => x.date >= start && x.date <= end);
  }

  // 新到旧
  list.sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || ""));
  res.json(list);
});

// 员工撤销 Missed Punch（仅 pending 可撤销）
app.post("/api/missed_punch/:id/cancel", requireLogin, writeLimiter, (req, res) => {
  const u = req.session.user;
  if (u.role !== "employee") return res.status(403).json({ message: "Forbidden" });

  const all = readMissed();
  const idx = all.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ message: "Not found" });

  const item = all[idx];

  // 只能撤销自己的
  if (item.employee !== u.employee) return res.status(403).json({ message: "Forbidden" });

  // 只有 pending 能撤销
  if (String(item.status || "").toLowerCase() !== "pending") {
    return res.status(400).json({ message: "Only pending requests can be cancelled." });
  }

  item.status = "cancelled";
  item.cancelledAt = new Date().toISOString();
  item.cancelledBy = u.username;

  writeMissed(all);
  res.json({ success: true });
});


// 管理员审批/拒绝
app.post("/api/missed_punch/:id/review", requireLogin, requireAdmin, writeLimiter, (req, res) => {
  const { id } = req.params;
  const { action, note } = req.body || {};
  if (action !== "approve" && action !== "deny") {
    return res.status(400).json({ message: "action must be approve or deny" });
  }

  const all = readMissed();
  const idx = all.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ message: "Not found" });

  // ✅ 防止重复审批
  if (all[idx].status && all[idx].status !== "pending") {
    return res.status(400).json({ message: "This request was already reviewed." });
  }

  // ✅ approve 才落地 records，并写审计信息
  if (action === "approve") {
    try {
      const audit = applyMissedPunchToRecords(all[idx]);
      all[idx].applied = {
        appliedAt: new Date().toISOString(),
        appliedBy: req.session.user.username,
        hours: audit.hours,
        removedRecords: audit.removed,
        insertedRecords: audit.inserted
      };
    } catch (e) {
      return res.status(400).json({ message: e.message || "Failed to apply records." });
    }
  }

  all[idx].status = action === "approve" ? "approved" : "denied";
  all[idx].reviewedAt = new Date().toISOString();
  all[idx].reviewedBy = req.session.user.username;
  all[idx].decisionNote = note ? String(note).trim() : "";

  writeMissed(all);
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

  // 先按 records 算每日汇总
const daily = buildDailySummary(rec);
const dayMap = new Map(); // date -> {workHours,lunchHours,restHours,payableHours}
for (const d of daily) {
  dayMap.set(d.date, {
    workHours: d.workHours,
    lunchHours: d.lunchHours,
    restHours: d.restHours,
    payableHours: d.payableHours
  });
}

// 再用 approved missed punch 覆盖对应日期（只覆盖当前 pay period）
const approved = readMissed()
  .filter(x => x.employee === u.employee && x.status === "approved" && x.date >= localYMD(periodStart) && x.date <= localYMD(periodEnd));

for (const mp of approved) {
  const hours = computeHoursFromMissed(mp);
  if (!hours) continue;
  dayMap.set(mp.date, hours);
}

let totalHours = 0;
let totalBreaks = 0;
for (const v of dayMap.values()) {
  totalHours += v.payableHours;
  totalBreaks += (v.lunchHours + v.restHours);
}

res.json({
  periodStart: periodStart.toDateString(),
  periodEnd: periodEnd.toDateString(),
  totalHours: Math.max(0, Number(totalHours.toFixed(2))),
  totalBreaks: Math.max(0, Number(totalBreaks.toFixed(2))),
});
}); // ✅ <—— 这一行必须加，结束 /api/summary

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
// ===== 用 approved missed punch 覆盖 Summary 里的对应日期（同导出范围）=====
const approvedAll = readMissed().filter(x => x.status === "approved");

// 先把现有 summary 放进 Map，方便覆盖
const sumMap = new Map(); // key = emp__date
for (const row of summary) {
  sumMap.set(`${row.employee}__${row.date}`, row);
}

// 导出范围对应的 date 边界（如果是 all，就不限制）
let rangeStartYmd = null;
let rangeEndYmd = null;
if (startMs != null && endMs != null) {
  rangeStartYmd = localYMD(startMs);
  rangeEndYmd = localYMD(endMs);
}



const empSet = new Set(dataset.map(r => r.employee));

// ===== 收集 Missed Punch 元信息（状态/备注等，忽略 cancelled）=====
const mpMetaMap = new Map(); // key = emp__date -> { status, reviewedBy, decisionNote }
for (const mp of readMissed()) {
  if (!empSet.has(mp.employee)) continue;
  if (rangeStartYmd && rangeEndYmd) {
    if (mp.date < rangeStartYmd || mp.date > rangeEndYmd) continue;
  }
  if (String(mp.status || "").toLowerCase() === "cancelled") continue;

  const key = `${mp.employee}__${mp.date}`;
  const prev = mpMetaMap.get(key);
  const prevTime = new Date(prev?.submittedAt || 0).getTime();
  const nextTime = new Date(mp.submittedAt || 0).getTime();

  if (!prev || nextTime >= prevTime) {
    mpMetaMap.set(key, {
      status: mp.status || "",
      reviewedBy: mp.reviewedBy || "",
      decisionNote: mp.decisionNote || "",
      submittedAt: mp.submittedAt || ""
    });
  }
}

for (const mp of approvedAll) {
  if (!empSet.has(mp.employee)) continue;

  if (rangeStartYmd && rangeEndYmd) {
    if (mp.date < rangeStartYmd || mp.date > rangeEndYmd) continue;
  }

  const hours = computeHoursFromMissed(mp);
  if (!hours) continue;

  const key = `${mp.employee}__${mp.date}`;
  const existing = sumMap.get(key);

  const newRow = {
    employee: mp.employee,
    date: mp.date,
    firstIn: mp.clockIn,
    lastOut: mp.clockOut,
    events: existing?.events ? (existing.events + " | ADJUSTED_BY_MISSED_PUNCH") : "ADJUSTED_BY_MISSED_PUNCH",
    ...hours
  };

  sumMap.set(key, newRow);
}

// 用覆盖后的 Map 生成 summary 数组
const summary2 = Array.from(sumMap.values())
  .map((row) => {
    const meta = mpMetaMap.get(`${row.employee}__${row.date}`) || {};
    return {
      ...row,
      mpStatus: meta.status || "",
      mpReviewedBy: meta.reviewedBy || "",
      mpDecisionNote: meta.decisionNote || ""
    };
  })
  .sort((a, b) => {
    if (a.employee === b.employee) return a.date.localeCompare(b.date);
    return (a.employee || "").localeCompare(b.employee || "");
  });

  // ===== Excel（Summary + Records）=====
  const wb = new ExcelJS.Workbook();

  // Summary
  const ws = wb.addWorksheet("Summary", { properties: { defaultRowHeight: 18 } });
  ws.columns = [
    { header: "Date",             key: "date",           width: 12 },
    { header: "First In",         key: "firstIn",        width: 10 },
    { header: "Last Out",         key: "lastOut",        width: 10 },
    { header: "Missed Status",    key: "mpStatus",       width: 14 },
    { header: "Reviewed By",      key: "mpReviewedBy",   width: 16 },
    { header: "Decision Note",    key: "mpDecisionNote", width: 22 },
    { header: "Work Hours",       key: "workHours",      width: 12 },
    { header: "Lunch Hours",      key: "lunchHours",     width: 12 },
    { header: "Rest Hours",       key: "restHours",      width: 12 },
    { header: "Payable Hours",    key: "payableHours",   width: 14 },
  ];

  // 按员工分区
  const byEmp = new Map();
summary2.forEach(r => {
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
    ws.mergeCells(titleRowIdx, 1, titleRowIdx, 10);

    // 表头（只给已用 7 列上色）
    const headerRow = ws.addRow(ws.columns.map(c => c.header));
    styleHeader(headerRow);

    // 数据行 + 小计
    let sumWork = 0, sumLunch = 0, sumRest = 0, sumPay = 0;
    rows.forEach(r => {
      const dataRow = ws.addRow([
        r.date,
        r.firstIn,
        r.lastOut,
        r.mpStatus || "",
        r.mpReviewedBy || "",
        r.mpDecisionNote || "",
        r.workHours,
        r.lunchHours,
        r.restHours,
        r.payableHours
      ]);
      styleBody(dataRow);
      sumWork  += r.workHours;
      sumLunch += r.lunchHours;
      sumRest  += r.restHours;
      sumPay   += r.payableHours;
    });

    // 小计行：加粗、淡灰底、四边框
    const subtotal = ws.addRow([
        "", "", "Subtotal", "", "", "",
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
    const spacer = ws.addRow(["","","","","","","","","",""]);
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
