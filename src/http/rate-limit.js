// In-memory rate limiting with fixed windows: each (bucket, key) pair may be
// used `limit` times per window of `windowSeconds`; then requests are refused
// until the window ends.
//
// In memory means: counts reset on restart, and several server processes
// would each count separately. Fine for one process; a shared store (e.g.
// Redis) would be needed to scale out.

function createRateLimiter({ now }) {
  const windows = new Map(); // "bucket:key" → { count, endsAt }

  return {
    // Count one request. Returns { allowed: true } or
    // { allowed: false, retryAfterSeconds } once the limit is used up.
    hit(bucket, key, { limit, windowSeconds }) {
      const currentTime = now();
      const id = `${bucket}:${key}`;
      let window = windows.get(id);

      if (!window || window.endsAt <= currentTime) {
        window = { count: 0, endsAt: currentTime + windowSeconds };
        windows.set(id, window);
      }

      if (window.count >= limit) {
        return { allowed: false, retryAfterSeconds: window.endsAt - currentTime };
      }

      window.count += 1;

      return { allowed: true };
    },

    // Forget windows that have ended, so memory does not grow with every new
    // IP address seen.
    prune() {
      const currentTime = now();

      for (const [id, window] of windows) {
        if (window.endsAt <= currentTime) {
          windows.delete(id);
        }
      }
    },

    get size() {
      return windows.size;
    },
  };
}

// The client's IP address. Behind a reverse proxy every request comes from the
// proxy, so with trustProxy the address the proxy appended to X-Forwarded-For
// (the last entry) is used instead. Only enable trustProxy behind exactly one
// proxy that sets this header: otherwise clients can put any value there.
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];

    if (typeof forwarded === "string" && forwarded.trim() !== "") {
      return forwarded.split(",").at(-1).trim();
    }
  }

  return req.socket.remoteAddress ?? "unknown";
}

export { clientIp, createRateLimiter };
