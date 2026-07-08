import { timingSafeEqual } from "node:crypto";

const TOKEN_HEADER = "x-dashboard-token";

export function dashboardAuthEnabled() {
  return Boolean(dashboardToken());
}

export function dashboardAuthHeaders() {
  const token = dashboardToken();
  return token ? { [TOKEN_HEADER]: token } : {};
}

export function warnIfDashboardUnauthenticated() {
  if (!dashboardAuthEnabled()) {
    console.warn("WARNING: DASHBOARD_TOKEN is not set. API routes are running without dashboard authentication.");
  }
}

export function authorizeDashboardRequest(request, response, url) {
  if (!url.pathname.startsWith("/api/") || url.pathname === "/api/health") return true;
  const expected = dashboardToken();
  if (!expected) return true;

  const provided = extractToken(request);
  if (safeEqual(provided, expected)) return true;

  response.writeHead(401, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-auth-required": "dashboard-token"
  });
  response.end(JSON.stringify({ error: "Dashboard token required" }));
  return false;
}

function dashboardToken() {
  return String(process.env.DASHBOARD_TOKEN || "").trim();
}

function extractToken(request) {
  const direct = String(request.headers?.[TOKEN_HEADER] || "").trim();
  if (direct) return direct;

  const authorization = String(request.headers?.authorization || "").trim();
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;

  const cookie = String(request.headers?.cookie || "");
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === "dashboard_token") return decodeURIComponent(rest.join("=") || "").trim();
  }
  return "";
}

function safeEqual(actual, expected) {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
