// Local-only development server. Vercel uses api/[...path].js instead.
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "public");
const uploadDir = path.join(__dirname, "uploads");
const db = new DatabaseSync(path.join(__dirname, "redline.sqlite"));
const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".wav", ".ogg", ".oga", ".opus", ".m4a", ".m4b", ".aac", ".flac",
  ".aiff", ".aif", ".wma", ".alac", ".amr", ".3gp", ".3g2", ".mid", ".midi",
  ".caf", ".au", ".snd", ".ra", ".rm"
]);

fs.mkdirSync(uploadDir, { recursive: true });
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, email TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS songs (id INTEGER PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Other', description TEXT NOT NULL DEFAULT '', original_name TEXT NOT NULL, stored_name TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, file_size INTEGER NOT NULL, total_listens INTEGER NOT NULL DEFAULT 0, total_downloads INTEGER NOT NULL DEFAULT 0, uploader_id INTEGER NOT NULL REFERENCES users(id), uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX IF NOT EXISTS idx_songs_uploaded_at ON songs(uploaded_at DESC);
`);

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(express.static(publicDir, { setHeaders: res => res.setHeader("Cache-Control", "no-store") }));

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function passwordHash(password, salt = crypto.randomBytes(16).toString("hex")) { return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`; }
function passwordsMatch(password, saved) {
  const [salt, expected] = String(saved).split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString("hex");
  return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
function parseCookies(req) { return Object.fromEntries((req.headers.cookie || "").split(";").map(item => { const at = item.indexOf("="); return at < 0 ? [] : [item.slice(0, at).trim(), decodeURIComponent(item.slice(at + 1))]; }).filter(pair => pair.length)); }
function setSession(res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(hash(token), userId, Date.now() + ONE_WEEK);
  res.setHeader("Set-Cookie", `redline_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ONE_WEEK / 1000}`);
}
function currentUser(req) {
  const token = parseCookies(req).redline_session;
  if (!token) return null;
  return db.prepare("SELECT users.id, users.username, users.email FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?").get(hash(token), Date.now()) || null;
}
function requireUser(req, res, next) { req.user = currentUser(req); return req.user ? next() : res.status(401).json({ error: "Please log in to upload audio." }); }
const cleanText = (value, max) => String(value || "").trim().slice(0, max);
const safeDownloadName = name => name.replace(/[\\/:*?"<>|\r\n]/g, "_");

const storage = multer.diskStorage({
  destination: (_req, _file, done) => done(null, uploadDir),
  filename: (_req, file, done) => done(null, `${Date.now()}-${crypto.randomBytes(10).toString("hex")}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, done) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const isAudio = String(file.mimetype || "").startsWith("audio/") || ["application/ogg", "video/3gpp", "video/3gpp2"].includes(file.mimetype);
    done(null, isAudio || AUDIO_EXTENSIONS.has(extension));
  }
});
const songFields = song => ({ ...song, file_size: Number(song.file_size), total_listens: Number(song.total_listens), total_downloads: Number(song.total_downloads) });
const songSelect = "SELECT songs.id, songs.title, songs.artist, songs.category, songs.description, songs.original_name, songs.mime_type, songs.file_size, songs.total_listens, songs.total_downloads, songs.uploaded_at, songs.uploader_id, users.username AS uploader FROM songs JOIN users ON users.id = songs.uploader_id";

app.get("/api/health", (_req, res) => res.json({ status: "ok", app: "REDLINE Audio Library" }));
app.get("/api/me", (req, res) => res.json({ user: currentUser(req) }));
app.post("/api/signup", (req, res, next) => {
  const username = cleanText(req.body.username, 40), email = cleanText(req.body.email, 120).toLowerCase(), password = String(req.body.password || "");
  if (!/^[a-zA-Z0-9_-]{3,40}$/.test(username)) return res.status(400).json({ error: "Use 3–40 letters, numbers, underscores, or hyphens for your username." });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  try { const result = db.prepare("INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)").run(username, email, passwordHash(password)); setSession(res, Number(result.lastInsertRowid)); res.status(201).json({ user: { id: Number(result.lastInsertRowid), username, email } }); }
  catch (error) { if (String(error.message).includes("UNIQUE")) return res.status(409).json({ error: "That username or email is already registered." }); next(error); }
});
app.post("/api/login", (req, res) => {
  const identity = cleanText(req.body.identity, 120).toLowerCase();
  const user = db.prepare("SELECT * FROM users WHERE lower(email) = ? OR lower(username) = ?").get(identity, identity);
  if (!user || !passwordsMatch(String(req.body.password || ""), user.password_hash)) return res.status(401).json({ error: "Incorrect email/username or password." });
  setSession(res, user.id); res.json({ user: { id: user.id, username: user.username, email: user.email } });
});
function clearSession(req, res) {
  const token = parseCookies(req).redline_session;
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash(token));
  res.setHeader("Set-Cookie", "redline_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}
app.post("/api/logout", (req, res) => { clearSession(req, res); res.status(204).end(); });
app.post("/logout", (req, res) => { clearSession(req, res); res.redirect(303, "/"); });
app.get("/api/songs", (req, res) => {
  const q = cleanText(req.query.q, 100), category = cleanText(req.query.category, 50), clauses = [], params = [];
  if (q) { clauses.push("(songs.title LIKE ? OR songs.artist LIKE ? OR songs.category LIKE ? OR users.username LIKE ?)"); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  if (category && category !== "All sounds") { clauses.push("songs.category = ?"); params.push(category); }
  const sql = `${songSelect}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY songs.uploaded_at DESC, songs.id DESC`;
  res.json({ songs: db.prepare(sql).all(...params).map(songFields) });
});
app.post("/api/songs", requireUser, (req, res) => upload.single("audio")(req, res, error => {
  if (error) return res.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "Audio files must be 30 MB or smaller." : "Choose a supported audio file that is 30 MB or smaller." });
  if (!req.file) return res.status(400).json({ error: "Choose an audio file to upload." });
  const title = cleanText(req.body.title, 120) || path.basename(req.file.originalname, path.extname(req.file.originalname));
  const artist = cleanText(req.body.artist, 100), category = cleanText(req.body.category, 50) || "Other", description = cleanText(req.body.description, 500);
  const result = db.prepare("INSERT INTO songs (title, artist, category, description, original_name, stored_name, mime_type, file_size, uploader_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(title, artist, category, description, req.file.originalname, req.file.filename, req.file.mimetype || "application/octet-stream", req.file.size, req.user.id);
  const song = db.prepare(`${songSelect} WHERE songs.id = ?`).get(result.lastInsertRowid);
  res.status(201).json({ song: songFields(song) });
}));
function validUploadedAt(value) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return undefined;
  return `${value} 00:00:00`;
}
function removeStoredFile(name) {
  if (!name) return;
  const filePath = path.join(uploadDir, path.basename(name));
  fs.unlink(filePath, () => {});
}
app.get("/api/profile/songs", requireUser, (req, res) => {
  const songs = db.prepare(`${songSelect} WHERE songs.uploader_id = ? ORDER BY songs.uploaded_at DESC, songs.id DESC`).all(req.user.id).map(songFields);
  res.json({ songs });
});
app.patch("/api/songs/:id", requireUser, (req, res) => upload.single("audio")(req, res, error => {
  if (error) return res.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "Audio files must be 30 MB or smaller." : "Choose a supported replacement audio file." });
  const song = db.prepare("SELECT * FROM songs WHERE id = ? AND uploader_id = ?").get(Number(req.params.id), req.user.id);
  if (!song) { if (req.file) removeStoredFile(req.file.filename); return res.status(404).json({ error: "That audio file was not found in your profile." }); }
  const uploadedAt = validUploadedAt(req.body.uploaded_at);
  if (uploadedAt === undefined) { if (req.file) removeStoredFile(req.file.filename); return res.status(400).json({ error: "Choose a valid upload date." }); }
  const title = Object.hasOwn(req.body, "title") ? cleanText(req.body.title, 120) : song.title;
  if (!title) { if (req.file) removeStoredFile(req.file.filename); return res.status(400).json({ error: "Track title is required." }); }
  const artist = Object.hasOwn(req.body, "artist") ? cleanText(req.body.artist, 100) : song.artist;
  const category = Object.hasOwn(req.body, "category") ? cleanText(req.body.category, 50) || "Other" : song.category;
  const description = Object.hasOwn(req.body, "description") ? cleanText(req.body.description, 500) : song.description;
  const replacement = req.file;
  db.prepare("UPDATE songs SET title = ?, artist = ?, category = ?, description = ?, uploaded_at = ?, original_name = ?, stored_name = ?, mime_type = ?, file_size = ? WHERE id = ?").run(
    title, artist, category, description, uploadedAt || song.uploaded_at,
    replacement ? replacement.originalname : song.original_name,
    replacement ? replacement.filename : song.stored_name,
    replacement ? (replacement.mimetype || "application/octet-stream") : song.mime_type,
    replacement ? replacement.size : song.file_size,
    song.id
  );
  if (replacement) removeStoredFile(song.stored_name);
  res.json({ song: songFields(db.prepare(`${songSelect} WHERE songs.id = ?`).get(song.id)) });
}));
app.delete("/api/songs/:id", requireUser, (req, res) => {
  const song = db.prepare("SELECT * FROM songs WHERE id = ? AND uploader_id = ?").get(Number(req.params.id), req.user.id);
  if (!song) return res.status(404).json({ error: "That audio file was not found in your profile." });
  db.prepare("DELETE FROM songs WHERE id = ?").run(song.id);
  removeStoredFile(song.stored_name);
  res.status(204).end();
});
function sendSong(req, res, kind) {
  const song = db.prepare("SELECT * FROM songs WHERE id = ?").get(Number(req.params.id));
  if (!song) return res.status(404).json({ error: "Song not found." });
  const filePath = path.join(uploadDir, song.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Audio file is unavailable." });
  if (kind === "download") {
    db.prepare("UPDATE songs SET total_downloads = total_downloads + 1 WHERE id = ?").run(song.id);
    res.type(song.mime_type); res.attachment(safeDownloadName(song.original_name));
    return fs.createReadStream(filePath).on("error", () => res.destroy()).pipe(res);
  }
  const size = fs.statSync(filePath).size;
  const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  res.setHeader("Accept-Ranges", "bytes");
  res.type(song.mime_type);
  if (!match) { res.setHeader("Content-Length", size); return fs.createReadStream(filePath).on("error", () => res.destroy()).pipe(res); }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || end < start) return res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
  res.status(206).set({ "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
  fs.createReadStream(filePath, { start, end }).on("error", () => res.destroy()).pipe(res);
}
app.post("/api/songs/:id/listen", (req, res) => {
  const song = db.prepare("SELECT id FROM songs WHERE id = ?").get(Number(req.params.id));
  if (!song) return res.status(404).json({ error: "Song not found." });
  db.prepare("UPDATE songs SET total_listens = total_listens + 1 WHERE id = ?").run(song.id);
  res.status(204).end();
});
app.get("/api/songs/:id/stream", (req, res) => sendSong(req, res, "stream"));
app.get("/api/songs/:id/download", (req, res) => sendSong(req, res, "download"));
app.use((error, _req, res, _next) => { console.error(error); res.status(500).json({ error: "Something went wrong. Please try again." }); });
app.get("*", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
app.listen(PORT, () => console.log(`REDLINE Audio Library is running at http://localhost:${PORT}`));
