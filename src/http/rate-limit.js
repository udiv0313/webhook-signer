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

// The client's IP address. Behind reverse proxies every request comes from a
// proxy, so the client address is taken from X-Forwarded-For instead.
//
// trustProxy is how many proxies sit in front of the server (true means 1).
// Each proxy appends the address it received the request from, so with N
// proxies the client is the Nth entry from the end. Entries before that were
// sent by the client itself and could be anything, so they are never used.
//   Fly.io, nginx, Caddy: 1        Render (Cloudflare + Render proxy): 2
function clientIp(req, trustProxy) {
  const hops = trustProxy === true ? 1 : Number(trustProxy) || 0;
  const forwarded = req.headers["x-forwarded-for"];

  if (hops > 0 && typeof forwarded === "string") {
    const entries = forwarded.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");

    // Fewer entries than proxies means the header did not come through the
    // expected proxies; fall back to the connection rather than trust it.
    if (entries.length >= hops) {
      return entries[entries.length - hops];
    }
  }

  return req.socket.remoteAddress ?? "unknown";
}

export { clientIp, createRateLimiter };
