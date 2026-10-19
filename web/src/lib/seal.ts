import "server-only";
import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";

// Seals a broker key before it is stored: a fresh AES-256-GCM key encrypts the fields, and that key is
// wrapped with the platform's RSA public key. This server can lock but never unlock; only the sync worker,
// which holds the private key (predictor/platform_keys.py), can open it.
const PUBLIC = process.env.CONNECTIONS_PUBLIC_KEY ?? "";

export function sealingReady() {
  return PUBLIC.length > 100;
}

export function seal(fields: Record<string, string>): string {
  const pub = createPublicKey({ key: Buffer.from(PUBLIC, "base64"), format: "der", type: "spki" });
  const key = randomBytes(32), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(fields), "utf8"), c.final()]);
  const wrapped = publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  key.fill(0);
  return JSON.stringify({ v: 1, k: wrapped.toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") });
}
