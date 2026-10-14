const express = require("express");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === "production";
const BOARDS = ["CBSE", "ICSE", "State board", "IGCSE / other"];
const SESSION_MS = 7 * 24 * 3600 * 1000;
const DOUBTS_PER_DAY = +process.env.DOUBTS_PER_DAY || 20;
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, "questions.json"), "utf8"));

const db = new Database(process.env.DB_PATH || path.join(__dirname, "data.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student', board TEXT, grade INTEGER, plan TEXT NOT NULL DEFAULT 'free', active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS videos(id INTEGER PRIMARY KEY, board TEXT NOT NULL, grade INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, paid INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS usage(user_id INTEGER, day TEXT, n INTEGER, PRIMARY KEY(user_id, day));
`);
db.prepare("DELETE FROM sessions WHERE created < ?").run(Date.now() - SESSION_MS);

// First run: create the teacher/admin account from environment variables.
if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
  const u = process.env.ADMIN_USER, p = process.env.ADMIN_PASS;
  if (!u || !p || p.length < 8) {
    console.error("First run: set ADMIN_USER and ADMIN_PASS (8+ characters).");
    process.exit(1);
  }
  db.prepare("INSERT INTO users(username,name,hash,role) VALUES(?,?,?,'admin')").run(u.toLowerCase().trim(), "Teacher", bcrypt.hashSync(p, 10));
  console.log("Admin account created.");
}

const DUMMY = bcrypt.hashSync("not-a-real-password", 10);
const app = express();
app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:",
  });
  next();
});
app.use("/api", (req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
app.use(express.json({ limit: "20kb" }));
app.use("/api", (req, res, next) => {
  if (req.method !== "GET" && !req.is("application/json")) return res.status(415).json({ error: "JSON only" });
  next();
});
app.use(express.static(path.join(__dirname, "public")));

const publicUser = (u) => ({ username: u.username, name: u.name, role: u.role, board: u.board, grade: u.grade, plan: u.plan });
const cookieToken = (req) => { const m = (req.headers.cookie || "").match(/(?:^|; )sid=([a-f0-9]{64})/); return m && m[1]; };

function auth(req, res, next) {
  const t = cookieToken(req);
  if (t) {
    const r = db.prepare("SELECT u.*, s.created FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?").get(t);
    if (r && r.active && Date.now() - r.created < SESSION_MS) { req.user = r; req.token = t; return next(); }
  }
  res.status(401).json({ error: "Please log in" });
}
const adminOnly = (req, res, next) => (req.user.role === "admin" ? next() : res.status(403).json({ error: "Admins only" }));
const isPaid = (u) => u.role === "admin" || u.plan === "paid";
// Students are locked to their own board and class. Admin can preview any.
const scope = (req) => req.user.role === "admin"
  ? { board: BOARDS.includes(req.query.board) ? req.query.board : "CBSE", grade: +req.query.grade >= 5 && +req.query.grade <= 10 ? +req.query.grade : 9 }
  : { board: req.user.board, grade: req.user.grade };

// ---- Login / session ----
const tries = new Map();
app.post("/api/login", (req, res) => {
  const u = String(req.body.username || "").toLowerCase().trim(), p = String(req.body.password || "");
  const key = req.ip + "|" + u;
  const t = tries.get(key) || { n: 0, at: Date.now() };
  if (Date.now() - t.at > 15 * 60e3) { t.n = 0; t.at = Date.now(); }
  if (t.n >= 5) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
  const r = db.prepare("SELECT * FROM users WHERE username=?").get(u);
  const ok = bcrypt.compareSync(p, r ? r.hash : DUMMY) && r && r.active;
  if (!ok) { t.n++; tries.set(key, t); return res.status(401).json({ error: "Wrong username or password" }); }
  tries.delete(key);
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(token, r.id, Date.now());
  res.cookie("sid", token, { httpOnly: true, sameSite: "lax", secure: PROD, maxAge: SESSION_MS });
  res.json(publicUser(r));
});
app.post("/api/logout", auth, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE token=?").run(req.token);
  res.clearCookie("sid");
  res.json({ ok: true });
});
app.get("/api/me", auth, (req, res) => res.json(publicUser(req.user)));
app.post("/api/password", auth, (req, res) => {
  const b = req.body;
  if (!bcrypt.compareSync(String(b.current || ""), req.user.hash)) return res.status(400).json({ error: "Current password is wrong" });
  if (String(b.next || "").length < 6) return res.status(400).json({ error: "New password must be 6+ characters" });
  db.prepare("UPDATE users SET hash=? WHERE id=?").run(bcrypt.hashSync(String(b.next), 10), req.user.id);
  db.prepare("DELETE FROM sessions WHERE user_id=? AND token<>?").run(req.user.id, req.token);
  res.json({ ok: true });
});

// ---- Content (always filtered on the server) ----
app.get("/api/questions", auth, (req, res) => {
  const s = scope(req);
  res.json(QUESTIONS.filter((q) => q[0] === s.grade).map((q) => ({ topic: q[1], q: q[2], opts: q[3], ans: q[4], exp: q[5] })));
});
app.get("/api/videos", auth, (req, res) => {
  const s = scope(req), p = isPaid(req.user);
  const rows = db.prepare("SELECT id,title,url,paid FROM videos WHERE board=? AND grade=? ORDER BY id").all(s.board, s.grade);
  res.json(rows.map((v) => ({ id: v.id, title: v.title, paid: !!v.paid, url: v.paid && !p ? null : v.url })));
});
app.get("/api/live", auth, (req, res) => {
  if (!isPaid(req.user)) return res.json({ locked: true });
  const r = db.prepare("SELECT v FROM settings WHERE k='live'").get();
  res.json({ url: r ? r.v : "" });
});
app.post("/api/doubt", auth, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: "The doubt solver is not set up yet." });
  const q = String(req.body.question || "").trim().slice(0, 1500);
  if (!q) return res.status(400).json({ error: "Type your doubt first." });
  const s = scope(req), day = new Date().toISOString().slice(0, 10);
  const row = db.prepare("SELECT n FROM usage WHERE user_id=? AND day=?").get(req.user.id, day);
  if (row && row.n >= DOUBTS_PER_DAY) return res.status(429).json({ error: "Daily limit reached. Try again tomorrow." });
  db.prepare("INSERT INTO usage VALUES(?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET n=n+1").run(req.user.id, day);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
        max_tokens: 1000,
        system: `You are a friendly maths tutor for a Class ${s.grade} student studying under the ${s.board} board. Explain in simple language, step by step, using that board's methods and notation. Show the final answer clearly. End with one similar practice question (no answer). If the question is not about maths, politely say you can only help with maths. Use plain text only (no markdown symbols, no LaTeX).`,
        messages: [{ role: "user", content: q }],
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error && j.error.message);
    res.json({ answer: (j.content || []).map((c) => c.text || "").join("") });
  } catch (e) {
    console.error("doubt:", e.message);
    res.status(502).json({ error: "The helper could not answer right now. Please try again." });
  }
});

// ---- Admin ----
const validPlan = (b) => BOARDS.includes(b.board) && +b.grade >= 5 && +b.grade <= 10 && ["free", "paid"].includes(b.plan);
app.get("/api/admin/students", auth, adminOnly, (req, res) =>
  res.json(db.prepare("SELECT id,username,name,board,grade,plan,active FROM users WHERE role='student' ORDER BY name").all()));
app.post("/api/admin/students", auth, adminOnly, (req, res) => {
  const b = req.body, u = String(b.username || "").toLowerCase().trim(), n = String(b.name || "").trim().slice(0, 60), p = String(b.password || "");
  if (!/^[a-z0-9._-]{3,30}$/.test(u)) return res.status(400).json({ error: "Username: 3-30 letters, numbers, . _ -" });
  if (!n || p.length < 6) return res.status(400).json({ error: "Enter a name and a password of 6+ characters" });
  if (!validPlan(b)) return res.status(400).json({ error: "Choose a valid board, class and plan" });
  try {
    db.prepare("INSERT INTO users(username,name,hash,role,board,grade,plan) VALUES(?,?,?,'student',?,?,?)").run(u, n, bcrypt.hashSync(p, 10), b.board, +b.grade, b.plan);
    res.json({ ok: true });
  } catch (e) { res.status(409).json({ error: "That username is already taken" }); }
});
app.patch("/api/admin/students/:id", auth, adminOnly, (req, res) => {
  const id = +req.params.id, b = req.body;
  const u = db.prepare("SELECT * FROM users WHERE id=? AND role='student'").get(id);
  if (!u) return res.status(404).json({ error: "Student not found" });
  const m = { board: b.board ?? u.board, grade: +(b.grade ?? u.grade), plan: b.plan ?? u.plan };
  if (!validPlan(m)) return res.status(400).json({ error: "Invalid board, class or plan" });
  const active = b.active == null ? u.active : b.active ? 1 : 0;
  let hash = u.hash;
  if (b.password != null) {
    if (String(b.password).length < 6) return res.status(400).json({ error: "Password must be 6+ characters" });
    hash = bcrypt.hashSync(String(b.password), 10);
  }
  db.prepare("UPDATE users SET board=?,grade=?,plan=?,active=?,hash=? WHERE id=?").run(m.board, m.grade, m.plan, active, hash, id);
  if (!active || b.password != null) db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
  res.json({ ok: true });
});
app.delete("/api/admin/students/:id", auth, adminOnly, (req, res) => {
  const id = +req.params.id;
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
  db.prepare("DELETE FROM users WHERE id=? AND role='student'").run(id);
  res.json({ ok: true });
});
app.get("/api/admin/videos", auth, adminOnly, (req, res) =>
  res.json(db.prepare("SELECT id,board,grade,title,url,paid FROM videos ORDER BY board,grade,id").all()));
app.post("/api/admin/videos", auth, adminOnly, (req, res) => {
  const b = req.body, t = String(b.title || "").trim().slice(0, 120), u = String(b.url || "").trim();
  if (!t || !/^https:\/\//.test(u)) return res.status(400).json({ error: "Enter a title and a link starting with https://" });
  if (!BOARDS.includes(b.board) || !(+b.grade >= 5 && +b.grade <= 10)) return res.status(400).json({ error: "Choose a valid board and class" });
  db.prepare("INSERT INTO videos(board,grade,title,url,paid) VALUES(?,?,?,?,?)").run(b.board, +b.grade, t, u, b.paid ? 1 : 0);
  res.json({ ok: true });
});
app.delete("/api/admin/videos/:id", auth, adminOnly, (req, res) => {
  db.prepare("DELETE FROM videos WHERE id=?").run(+req.params.id);
  res.json({ ok: true });
});
app.get("/api/admin/live", auth, adminOnly, (req, res) => {
  const r = db.prepare("SELECT v FROM settings WHERE k='live'").get();
  res.json({ url: r ? r.v : "" });
});
app.put("/api/admin/live", auth, adminOnly, (req, res) => {
  const u = String(req.body.url || "").trim();
  if (!/^https:\/\//.test(u)) return res.status(400).json({ error: "Link must start with https://" });
  db.prepare("INSERT INTO settings VALUES('live',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(u);
  res.json({ ok: true });
});

app.use((err, req, res, next) => res.status(400).json({ error: "Bad request" }));
app.listen(PORT, () => console.log("Running on port " + PORT));
