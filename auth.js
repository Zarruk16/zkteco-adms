const crypto = require("crypto");

const MANAGER_USERNAME = process.env.MANAGER_USERNAME || process.env.HR_USERNAME || "admin";
const MANAGER_PASSWORD = process.env.MANAGER_PASSWORD || process.env.HR_PASSWORD || "Admin@2026!";
const SESSION_SECRET = process.env.SESSION_SECRET || "attendance-manager-dev-secret-change-me";
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 1000 * 60 * 60 * 12; // 12h
const COOKIE_NAME = "organization_manager_session";

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}

function sign(payloadB64) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payloadB64).digest("base64url");
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function createSessionToken(username) {
  const payload = b64urlJson({
    u: username,
    exp: Date.now() + SESSION_TTL_MS,
  });
  return `${payload}.${sign(payload)}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (!json?.u || !json?.exp || Date.now() > Number(json.exp)) return null;
    return { username: String(json.u) };
  } catch {
    return null;
  }
}

function getSession(req) {
  const cookies = parseCookies(req);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

function setSessionCookie(res, token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
  );
}

function clearSessionCookie(res) {
  const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
  );
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function validateCredentials(username, password) {
  const userOk = timingSafeEqualString(username, MANAGER_USERNAME);
  const passOk = timingSafeEqualString(password, MANAGER_PASSWORD);
  return userOk && passOk;
}

function requireAuthApi(req, res, next) {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  req.user = session;
  next();
}

function requireAuthPage(req, res, next) {
  const session = getSession(req);
  if (!session) {
    res.redirect("/login");
    return;
  }
  req.user = session;
  next();
}

module.exports = {
  MANAGER_USERNAME,
  COOKIE_NAME,
  createSessionToken,
  getSession,
  setSessionCookie,
  clearSessionCookie,
  validateCredentials,
  requireAuthApi,
  requireAuthPage,
};
