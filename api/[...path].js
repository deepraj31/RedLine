// Native Vercel catch-all route. It preserves the original /api/... request
// path for Express, unlike an internal rewrite to /api/index.
module.exports = require("./index");
