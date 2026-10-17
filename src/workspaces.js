import crypto from "node:crypto";
import { parseCookies, serializeCookie } from "./http/cookies.js";
import { generateId } from "./lib/ids.js";

// Anonymous workspaces: each browser gets its own isolated set of endpoints and
// events, without signing up.
//
// The browser holds a random token in an HttpOnly cookie. The database stores
// only sha256(token), so someone who reads the database cannot use it to act
// as a workspace.

const COOKIE_NAME = "ws";

// 32 random bytes as base64url = 43 characters.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// sha256 hex of a cookie token: the only form in which tokens are stored.
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Resolves and creates workspaces from the request cookie.
 * Returns { find(req), create(res) }; see each method below.
 */
function createWorkspaceSessions({ store, now, ttlSeconds, cookieSecure }) {
  return {
    // The workspace this request belongs to, or null. A missing, malformed,
    // unknown or expired cookie all mean "no workspace".
    find(req) {
      const token = parseCookies(req.headers.cookie)[COOKIE_NAME];

      if (token === undefined || !TOKEN_PATTERN.test(token)) {
        return null;
      }

      return store.findWorkspaceByTokenHash(hashToken(token), now());
    },

    // Create a workspace and tell the browser about it with a Set-Cookie header.
    // Lifetime is absolute: it is never extended.
    create(res) {
      const token = crypto.randomBytes(32).toString("base64url");
      const createdAt = now();
      const workspace = { id: generateId("ws"), expiresAt: createdAt + ttlSeconds };

      store.insertWorkspace({ id: workspace.id, tokenHash: hashToken(token), createdAt, expiresAt: workspace.expiresAt });
      res.setHeader("Set-Cookie", serializeCookie(COOKIE_NAME, token, { maxAge: ttlSeconds, secure: cookieSecure }));

      return workspace;
    },
  };
}

export { COOKIE_NAME, createWorkspaceSessions, hashToken };
