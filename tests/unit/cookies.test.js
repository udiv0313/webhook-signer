import test from "node:test";
import assert from "node:assert/strict";
import { parseCookies, serializeCookie } from "../../src/http/cookies.js";

test("parseCookies: missing or empty header → no cookies", () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(""), {});
});

test("parseCookies: several cookies, with or without spaces", () => {
  assert.deepEqual(parseCookies("a=1; ws=abc;b=2"), { a: "1", ws: "abc", b: "2" });
  assert.deepEqual(parseCookies("  ws = abc  "), { ws: "abc" });
});

test("parseCookies: values may contain '=' (only the first one separates)", () => {
  assert.deepEqual(parseCookies("ws=a=b=="), { ws: "a=b==" });
});

test("parseCookies: malformed pairs are skipped", () => {
  assert.deepEqual(parseCookies("novalue; =nameless; ;ws=abc"), { ws: "abc" });
});

test("parseCookies: the first of duplicate names wins", () => {
  assert.deepEqual(parseCookies("ws=first; ws=second"), { ws: "first" });
});

test("parseCookies: names like __proto__ are ordinary keys", () => {
  const cookies = parseCookies("__proto__=x; ws=abc");

  assert.equal(cookies.ws, "abc");
  assert.equal(Object.getPrototypeOf(cookies), Object.prototype);
});

test("serializeCookie: HttpOnly, SameSite=Lax, Path=/, Max-Age; Secure only when asked", () => {
  assert.equal(serializeCookie("ws", "abc", { maxAge: 60 }), "ws=abc; Path=/; Max-Age=60; HttpOnly; SameSite=Lax");
  assert.equal(
    serializeCookie("ws", "abc", { maxAge: 60, secure: true }),
    "ws=abc; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure",
  );
});
