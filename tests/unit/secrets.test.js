import test from "node:test";
import assert from "node:assert/strict";
import { createSecretBox, generateEndpointSecret, isEndpointSecret } from "../../src/core/secrets.js";

const ENDPOINT_ID = "ep_0123456789abcdef";

test("generated secrets are whsec_ + 43 base64url characters, and all different", () => {
  const secrets = new Set();

  for (let i = 0; i < 100; i++) {
    const secret = generateEndpointSecret();

    assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
    assert.ok(isEndpointSecret(secret));
    secrets.add(secret);
  }

  assert.equal(secrets.size, 100);
});

test("isEndpointSecret rejects anything else", () => {
  for (const value of [undefined, "", "whsec_", "whsec_short", `whsec_${"a".repeat(44)}`, `sk_${"a".repeat(43)}`, 42]) {
    assert.equal(isEndpointSecret(value), false, String(value));
  }
});

test("a sealed secret opens to the original, and does not contain it", () => {
  const box = createSecretBox("master");
  const secret = generateEndpointSecret();
  const sealed = box.seal(secret, ENDPOINT_ID);

  assert.match(sealed, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(!sealed.includes(secret.slice("whsec_".length)));
  assert.equal(box.open(sealed, ENDPOINT_ID), secret);
});

test("sealing the same secret twice gives different values (random IV)", () => {
  const box = createSecretBox("master");
  const secret = generateEndpointSecret();

  assert.notEqual(box.seal(secret, ENDPOINT_ID), box.seal(secret, ENDPOINT_ID));
});

test("a sealed secret does not open for another endpoint, another master secret, or after tampering", () => {
  const box = createSecretBox("master");
  const sealed = box.seal(generateEndpointSecret(), ENDPOINT_ID);
  const [version, iv, tag, ciphertext] = sealed.split(".");
  const flipped = (text) => (text[0] === "A" ? "B" : "A") + text.slice(1);

  assert.throws(() => box.open(sealed, "ep_fedcba9876543210"));
  assert.throws(() => createSecretBox("other-master").open(sealed, ENDPOINT_ID));
  assert.throws(() => box.open([version, iv, tag, flipped(ciphertext)].join("."), ENDPOINT_ID));
  assert.throws(() => box.open([version, iv, flipped(tag), ciphertext].join("."), ENDPOINT_ID));
  assert.throws(() => box.open("not-sealed", ENDPOINT_ID), /Unrecognized sealed secret format/);
});
