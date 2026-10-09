// Office login: one shared office password (OFFICE_PASSWORD), signed session cookie.
const crypto = require("crypto");

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const COOKIE = "jd_session";
const MAX_AGE = 30 * 24 * 3600; // 30 days

function b64(s) { return Buffer.from(s).toString("base64url"); }
function sign(payload) {
  const body = b64(JSON.stringify(payload));
  return body + "." + crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
}
function verify(token) {
  if (!token || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const want = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach(p => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function passwordOk(given) {
  const want = process.env.OFFICE_PASSWORD || "";
  if (!want) return false;
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}
function setSession(res, secure) {
  const v = sign({ u: "office", exp: Date.now() + MAX_AGE * 1000 });
  res.setHeader("Set-Cookie", `${COOKIE}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? "; Secure" : ""}`);
}
function clearSession(res) { res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); }
function isOffice(req) { return !!verify(cookies(req)[COOKIE]); }
function requireOffice(req, res, next) {
  if (isOffice(req)) return next();
  if (req.originalUrl.startsWith("/api/")) return res.status(401).json({ error: "Please log in again", code: "unauth" });
  res.redirect("/login");
}

// simple login throttle: 10 attempts / 15 min per IP
const attempts = new Map();
function throttled(ip) {
  const now = Date.now(), list = (attempts.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  list.push(now); attempts.set(ip, list);
  return list.length > 10;
}

module.exports = { passwordOk, setSession, clearSession, isOffice, requireOffice, throttled };
