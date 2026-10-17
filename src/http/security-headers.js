// Headers sent with every response. Pages get a stricter, page-specific
// Content-Security-Policy from static.js, which replaces the API one below.
//
//   nosniff          browsers must not guess a content type (e.g. run JSON as script)
//   no-referrer      URLs (which contain endpoint IDs) are not leaked to other sites
//   DENY / none      no other site may show this app in a frame (clickjacking)
//   CSP for the API  a JSON response can never load or run anything
//   HSTS             only when served over HTTPS: browsers then refuse plain HTTP
function setSecurityHeaders(res, { https }) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");

  if (https) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000");
  }
}

export { setSecurityHeaders };
