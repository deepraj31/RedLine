// Vercel's Express entry point. The hosted routes live in api/index.js;
// local SQLite development remains in scripts/local.cjs.
const express = require("express");
const app = express();
app.use(require("./api/index"));

module.exports = app;
