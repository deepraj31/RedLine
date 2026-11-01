const crypto = require("crypto");
const express = require("express");
const { createClient } = require("@libsql/client");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const required = ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];
const missing = required.filter(name => !process.env[name]);
const app = express();
const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_LIFETIME = 15 * 60 * 1000;
const MAX_AUDIO_SIZE = 30 * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".oga", ".opus", ".m4a", ".m4b", ".aac", ".flac", ".aiff", ".aif", ".wma", ".alac", ".amr", ".3gp", ".3g2", ".mid", ".midi", ".caf", ".au", ".snd", ".ra", ".rm"]);

let db = null;
let r2 = null;
let schemaPromise;

function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function passwordHash(password, salt = crypto.randomBytes(16).toString("hex")) { return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`; }
function passwordsMatch(password, saved) {
  const [salt, expected] = String(saved || "").split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString("hex");
  return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map(item => {
    const at = item.indexOf("=");
    return at < 0 ? [] : [item.slice(0, at).trim(), decodeURIComponent(item.slice(at + 1))];
  }).filter(pair => pair.length));
}
function cleanText(value, max) { return String(value || "").trim().slice(0, max); }
function safeDownloadName(name) { return String(name || "audio").replace(/[\\/:*?"<>|\r\n]/g, "_"); }
function extension(name) { const match = /\.[^.]+$/.exec(String(name || "")); return match ? match[0].toLowerCase() : ""; }
function isAudio(file) {
  return AUDIO_EXTENSIONS.has(extension(file.name)) || String(file.type || "").startsWith("audio/") || ["application/ogg", "video/3gpp", "video/3gpp2"].includes(file.type);
}
function validUploadedAt(value) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return undefined;
  return `${value} 00:00:00`;
}
function serializeSong(song) {
  return { ...song, id: Number(song.id), uploader_id: Number(song.uploader_id), file_size: Number(song.file_size), total_listens: Number(song.total_listens), total_downloads: Number(song.total_downloads) };
}
function connectStorage() {
  if (missing.length) throw new Error(`Missing deployment variables: ${missing.join(", ")}`);
  if (!db) db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  if (!r2) r2 = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }
  });
}
async function initialize() {
  connectStorage();
  if (!schemaPromise) {
    schemaPromise = db.batch([
      "PRAGMA foreign_keys = ON",
      "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL COLLATE NOCASE UNIQUE, email TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
      "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS songs (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, artist TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Other', description TEXT NOT NULL DEFAULT '', original_name TEXT NOT NULL, storage_key TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, file_size INTEGER NOT NULL, total_listens INTEGER NOT NULL DEFAULT 0, total_downloads INTEGER NOT NULL DEFAULT 0, uploader_id INTEGER NOT NULL REFERENCES users(id), uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
      "CREATE TABLE IF NOT EXISTS upload_tokens (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, object_key TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL, mime_type TEXT NOT NULL, file_size INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
      "CREATE INDEX IF NOT EXISTS idx_songs_uploaded_at ON songs(uploaded_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_upload_tokens_expiry ON upload_tokens(expires_at)"
    ]).catch(error => { schemaPromise = undefined; throw error; });
  }
  return schemaPromise;
}
async function one(sql, args = []) { const result = await db.execute({ sql, args }); return result.rows[0] || null; }
async function many(sql, args = []) { const result = await db.execute({ sql, args }); return result.rows; }
async function run(sql, args = []) { return db.execute({ sql, args }); }

const songSelect = "SELECT songs.id, songs.title, songs.artist, songs.category, songs.description, songs.original_name, songs.mime_type, songs.file_size, songs.total_listens, songs.total_downloads, songs.uploaded_at, songs.uploader_id, users.username AS uploader FROM songs JOIN users ON users.id = songs.uploader_id";
async function currentUser(req) {
  const token = parseCookies(req).redline_session;
  if (!token) return null;
  return one("SELECT users.id, users.username, users.email FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?", [hash(token), Date.now()]);
}
function sessionCookie(token, age) {
  return `redline_session=${encodeURIComponent(token || "")}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age};${process.env.VERCEL ? " Secure;" : ""}`;
}
async function setSession(res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [hash(token), userId, Date.now() + ONE_WEEK]);
  res.setHeader("Set-Cookie", sessionCookie(token, ONE_WEEK / 1000));
}
async function requireUser(req, res, next) {
  try {
    req.user = await currentUser(req);
    if (!req.user) return res.status(401).json({ error: "Please log in to upload audio." });
    next();
  } catch (error) { next(error); }
}
async function consumeUploadToken(token, userId) {
  const row = await one("SELECT * FROM upload_tokens WHERE token = ? AND user_id = ? AND expires_at > ?", [token, userId, Date.now()]);
  if (!row) return null;
  await run("DELETE FROM upload_tokens WHERE token = ?", [token]);
  return row;
}
async function removeR2Object(key) {
  if (!key) return;
  try { await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key })); }
  catch (error) { console.error("Could not remove R2 object", error); }
}

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(async (req, res, next) => {
  try { await initialize(); next(); }
  catch (error) { console.error(error); res.status(503).json({ error: "Storage is not configured yet. Add the deployment environment variables and redeploy." }); }
});

app.get("/api/health", (_req, res) => res.json({ status: "ok", app: "REDLINE Audio Library", storage: "Turso + Cloudflare R2" }));
app.get("/api/me", async (req, res, next) => { try { res.json({ user: await currentUser(req) }); } catch (error) { next(error); } });

app.post("/api/signup", async (req, res, next) => {
  const username = cleanText(req.body.username, 40), email = cleanText(req.body.email, 120).toLowerCase(), password = String(req.body.password || "");
  if (!/^[a-zA-Z0-9_-]{3,40}$/.test(username)) return res.status(400).json({ error: "Use 3–40 letters, numbers, underscores, or hyphens for your username." });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  try {
    const result = await run("INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)", [username, email, passwordHash(password)]);
    const id = Number(result.lastInsertRowid);
    await setSession(res, id);
    res.status(201).json({ user: { id, username, email } });
  } catch (error) {
    if (/unique/i.test(String(error.message))) return res.status(409).json({ error: "That username or email is already registered." });
    next(error);
  }
});
app.post("/api/login", async (req, res, next) => {
  try {
    const identity = cleanText(req.body.identity, 120).toLowerCase();
    const user = await one("SELECT * FROM users WHERE lower(email) = ? OR lower(username) = ?", [identity, identity]);
    if (!user || !passwordsMatch(String(req.body.password || ""), user.password_hash)) return res.status(401).json({ error: "Incorrect email/username or password." });
    await setSession(res, Number(user.id));
    res.json({ user: { id: Number(user.id), username: user.username, email: user.email } });
  } catch (error) { next(error); }
});
async function clearSession(req, res) {
  const token = parseCookies(req).redline_session;
  if (token) await run("DELETE FROM sessions WHERE token_hash = ?", [hash(token)]);
  res.setHeader("Set-Cookie", sessionCookie("", 0));
}
app.post("/api/logout", async (req, res, next) => { try { await clearSession(req, res); res.status(204).end(); } catch (error) { next(error); } });
app.post("/logout", async (req, res, next) => { try { await clearSession(req, res); res.redirect(303, "/"); } catch (error) { next(error); } });

app.get("/api/songs", async (req, res, next) => {
  try {
    const q = cleanText(req.query.q, 100), category = cleanText(req.query.category, 50), clauses = [], args = [];
    if (q) { clauses.push("(songs.title LIKE ? OR songs.artist LIKE ? OR songs.category LIKE ? OR users.username LIKE ?)"); args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    if (category && category !== "All sounds") { clauses.push("songs.category = ?"); args.push(category); }
    const sql = `${songSelect}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY songs.uploaded_at DESC, songs.id DESC`;
    res.json({ songs: (await many(sql, args)).map(serializeSong) });
  } catch (error) { next(error); }
});

app.post("/api/uploads/sign", requireUser, async (req, res, next) => {
  try {
    const file = req.body || {};
    const name = cleanText(file.name, 180), type = cleanText(file.type, 120) || "application/octet-stream", size = Number(file.size);
    if (!name || !Number.isInteger(size) || size < 1 || size > MAX_AUDIO_SIZE || !isAudio({ name, type })) return res.status(400).json({ error: "Choose a supported audio file that is 30 MB or smaller." });
    const token = crypto.randomBytes(32).toString("base64url");
    const key = `audio/${req.user.id}/${Date.now()}-${crypto.randomBytes(12).toString("hex")}${extension(name)}`;
    await run("DELETE FROM upload_tokens WHERE expires_at <= ?", [Date.now()]);
    await run("INSERT INTO upload_tokens (token, user_id, object_key, original_name, mime_type, file_size, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [token, req.user.id, key, name, type, size, Date.now() + UPLOAD_LIFETIME]);
    const uploadUrl = await getSignedUrl(r2, new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, ContentType: type }), { expiresIn: UPLOAD_LIFETIME / 1000 });
    res.status(201).json({ upload_token: token, upload_url: uploadUrl });
  } catch (error) { next(error); }
});

app.post("/api/songs", requireUser, async (req, res, next) => {
  try {
    const token = await consumeUploadToken(cleanText(req.body.upload_token, 100), req.user.id);
    if (!token) return res.status(400).json({ error: "Your upload link expired. Choose the audio file again." });
    const title = cleanText(req.body.title, 120) || token.original_name.replace(/\.[^.]+$/, "");
    const artist = cleanText(req.body.artist, 100), category = cleanText(req.body.category, 50) || "Other", description = cleanText(req.body.description, 500);
    const result = await run("INSERT INTO songs (title, artist, category, description, original_name, storage_key, mime_type, file_size, uploader_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [title, artist, category, description, token.original_name, token.object_key, token.mime_type, token.file_size, req.user.id]);
    const song = await one(`${songSelect} WHERE songs.id = ?`, [result.lastInsertRowid]);
    res.status(201).json({ song: serializeSong(song) });
  } catch (error) { next(error); }
});

app.get("/api/profile/songs", requireUser, async (req, res, next) => {
  try { res.json({ songs: (await many(`${songSelect} WHERE songs.uploader_id = ? ORDER BY songs.uploaded_at DESC, songs.id DESC`, [req.user.id])).map(serializeSong) }); }
  catch (error) { next(error); }
});
app.patch("/api/songs/:id", requireUser, async (req, res, next) => {
  try {
    const id = Number(req.params.id), song = await one("SELECT * FROM songs WHERE id = ? AND uploader_id = ?", [id, req.user.id]);
    if (!song) return res.status(404).json({ error: "That audio file was not found in your profile." });
    const uploadedAt = validUploadedAt(req.body.uploaded_at);
    if (uploadedAt === undefined) return res.status(400).json({ error: "Choose a valid upload date." });
    const title = Object.hasOwn(req.body, "title") ? cleanText(req.body.title, 120) : song.title;
    if (!title) return res.status(400).json({ error: "Track title is required." });
    let replacement = null;
    if (req.body.upload_token) {
      replacement = await consumeUploadToken(cleanText(req.body.upload_token, 100), req.user.id);
      if (!replacement) return res.status(400).json({ error: "Your replacement upload link expired. Choose the file again." });
    }
    await run("UPDATE songs SET title = ?, artist = ?, category = ?, description = ?, uploaded_at = ?, original_name = ?, storage_key = ?, mime_type = ?, file_size = ? WHERE id = ?", [
      title,
      Object.hasOwn(req.body, "artist") ? cleanText(req.body.artist, 100) : song.artist,
      Object.hasOwn(req.body, "category") ? cleanText(req.body.category, 50) || "Other" : song.category,
      Object.hasOwn(req.body, "description") ? cleanText(req.body.description, 500) : song.description,
      uploadedAt || song.uploaded_at,
      replacement ? replacement.original_name : song.original_name,
      replacement ? replacement.object_key : song.storage_key,
      replacement ? replacement.mime_type : song.mime_type,
      replacement ? replacement.file_size : song.file_size,
      id
    ]);
    if (replacement) removeR2Object(song.storage_key);
    res.json({ song: serializeSong(await one(`${songSelect} WHERE songs.id = ?`, [id])) });
  } catch (error) { next(error); }
});
app.delete("/api/songs/:id", requireUser, async (req, res, next) => {
  try {
    const song = await one("SELECT * FROM songs WHERE id = ? AND uploader_id = ?", [Number(req.params.id), req.user.id]);
    if (!song) return res.status(404).json({ error: "That audio file was not found in your profile." });
    await run("DELETE FROM songs WHERE id = ?", [song.id]);
    removeR2Object(song.storage_key);
    res.status(204).end();
  } catch (error) { next(error); }
});
async function redirectToAudio(req, res, kind) {
  const song = await one("SELECT * FROM songs WHERE id = ?", [Number(req.params.id)]);
  if (!song) return res.status(404).json({ error: "Song not found." });
  if (kind === "download") await run("UPDATE songs SET total_downloads = total_downloads + 1 WHERE id = ?", [song.id]);
  const command = new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: song.storage_key, ResponseContentType: song.mime_type, ...(kind === "download" ? { ResponseContentDisposition: `attachment; filename="${safeDownloadName(song.original_name)}"` } : {}) });
  const url = await getSignedUrl(r2, command, { expiresIn: 60 * 30 });
  return res.redirect(302, url);
}
app.get("/api/songs/:id/stream", (req, res, next) => redirectToAudio(req, res, "stream").catch(next));
app.get("/api/songs/:id/download", (req, res, next) => redirectToAudio(req, res, "download").catch(next));
app.post("/api/songs/:id/listen", async (req, res, next) => {
  try {
    const song = await one("SELECT id FROM songs WHERE id = ?", [Number(req.params.id)]);
    if (!song) return res.status(404).json({ error: "Song not found." });
    await run("UPDATE songs SET total_listens = total_listens + 1 WHERE id = ?", [song.id]);
    res.status(204).end();
  } catch (error) { next(error); }
});
app.use((error, _req, res, _next) => { console.error(error); res.status(500).json({ error: "Something went wrong. Please try again." }); });

module.exports = app;
