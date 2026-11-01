// Vercel's Express entry point. Keep this direct import: Vercel uses it to
// detect an Express deployment. The configured app lives in api/index.js;
// local SQLite development remains in scripts/local.cjs.
const express = require("express");
void express;
module.exports = require("./api/index");
