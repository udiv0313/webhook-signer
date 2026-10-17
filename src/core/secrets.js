import crypto from "node:crypto";

// Endpoint signing secrets: generated randomly, shown to the user once, and
// stored only in encrypted ("sealed") form.
//
// A secret looks like  whsec_<43 base64url characters>  (32 random bytes).
// Senders use the whole string, prefix included, as the HMAC key.

const SECRET_PREFIX = "whsec_";
const SECRET_PATTERN = /^whsec_[A-Za-z0-9_-]{43}$/;

function generateEndpointSecret() {
  return SECRET_PREFIX + crypto.randomBytes(32).toString("base64url");
}

function isEndpointSecret(value) {
  return typeof value === "string" && SECRET_PATTERN.test(value);
}

/**
 * Encrypts and decrypts endpoint secrets for storage, with AES-256-GCM.
 *
 * The key is derived from the master secret (WEBHOOK_SECRET) with HKDF, so a
 * copy of the database alone does not reveal any endpoint secret. GCM also
 * detects tampering: a modified value fails to decrypt instead of producing a
 * wrong secret.
 *
 * The endpoint ID is bound in as "additional authenticated data", so a sealed
 * secret copied onto another endpoint's row does not decrypt there.
 *
 * Sealed format: v1.<iv>.<auth tag>.<ciphertext>, each part base64url.
 */
function createSecretBox(masterSecret) {
  const key = Buffer.from(crypto.hkdfSync("sha256", masterSecret, "", "webhook-signer:secret-encryption:v1", 32));

  return {
    seal(secret, endpointId) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(endpointId));

      const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      const parts = [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url"));

      return ["v1", ...parts].join(".");
    },

    // Throws if the value was tampered with, belongs to another endpoint, or
    // was sealed with a different master secret.
    open(sealed, endpointId) {
      const [version, iv, tag, ciphertext] = sealed.split(".");

      if (version !== "v1" || ciphertext === undefined) {
        throw new Error("Unrecognized sealed secret format");
      }

      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(endpointId));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));

      return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}

export { createSecretBox, generateEndpointSecret, isEndpointSecret };
