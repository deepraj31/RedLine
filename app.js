// Vercel's Express entry point. The hosted routes live in api/index.js;
// local SQLite development remains in scripts/local.cjs.
const express = require("express");
const app = express();

// Vercel routes the site root to this Express function. The browser app itself
// is a static asset in public/, which Vercel serves from its CDN.
app.get("/", (_req, res) => res.redirect(302, "/index.html"));
app.use(require("./api/index"));

module.exports = app;
