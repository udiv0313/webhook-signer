import fs from "node:fs";
import path from "node:path";

// Serves the built frontend (frontend/dist) from the same origin as the API,
// so production needs no second server and no CORS.
//
// All files are read into memory once, at startup. Requests are answered from
// that map only, so a crafted URL (../../etc/passwd) can never reach the disk.

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

// The page may only load its own scripts, styles and API. No inline scripts,
// no other origins, and it cannot be framed (clickjacking).
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);

    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

// Returns null when the folder has no index.html (frontend not built).
function loadStaticSite(rootDir) {
  if (!fs.existsSync(path.join(rootDir, "index.html"))) {
    return null;
  }

  const files = new Map(); // "/assets/index-abc.js" → { body, headers }

  for (const file of listFiles(rootDir)) {
    const urlPath = "/" + path.relative(rootDir, file).split(path.sep).join("/");
    const contentType = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    // Vite puts a content hash in every file name under /assets, so those can
    // be cached forever. Everything else (index.html) must be revalidated.
    const cacheControl = urlPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    const headers = { "Content-Type": contentType, "Cache-Control": cacheControl };

    if (contentType.startsWith("text/html")) {
      headers["Content-Security-Policy"] = PAGE_CSP;
    }

    files.set(urlPath, { body: fs.readFileSync(file), headers });
  }

  const index = files.get("/index.html");

  return {
    fileCount: files.size,

    // Answers GET/HEAD for a path. Paths without a file extension get
    // index.html, so the app opens on any page URL; a missing file with an
    // extension (e.g. an old /assets/... name) is a plain 404.
    serve(req, res, urlPath) {
      let file = urlPath === "/" ? index : files.get(urlPath);

      if (!file && path.extname(urlPath) === "") {
        file = index;
      }

      if (!file) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
        res.end(req.method === "HEAD" ? undefined : "Not found");
        return;
      }

      res.writeHead(200, { ...file.headers, "Content-Length": file.body.length });
      res.end(req.method === "HEAD" ? undefined : file.body);
    },
  };
}

export { PAGE_CSP, loadStaticSite };
