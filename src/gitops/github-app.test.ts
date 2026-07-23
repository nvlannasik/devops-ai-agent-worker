import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { buildAppJwt } from "./github-app.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

test("buildAppJwt produces a verifiable RS256 JWT with the expected claims", () => {
  const now = 1_700_000_000;
  const jwt = buildAppJwt("123456", privateKey.export({ type: "pkcs1", format: "pem" }).toString(), now);

  const [header, payload, signature] = jwt.split(".");
  assert.equal(jwt.split(".").length, 3);

  // header
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });

  // claims: iss = appId, iat backdated 60s, exp ≤ 10 min out
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(claims.iss, "123456");
  assert.equal(claims.iat, now - 60);
  assert.ok(claims.exp - claims.iat <= 600 && claims.exp > claims.iat);

  // the signature actually verifies against the public key
  const ok = verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"));
  assert.equal(ok, true);
});

test("a tampered payload fails verification", () => {
  const jwt = buildAppJwt("123456", privateKey.export({ type: "pkcs1", format: "pem" }).toString());
  const [header, , signature] = jwt.split(".");
  const forged = Buffer.from(JSON.stringify({ iss: "999", iat: 1, exp: 600 })).toString("base64url");
  const ok = verify("RSA-SHA256", Buffer.from(`${header}.${forged}`), publicKey, Buffer.from(signature, "base64url"));
  assert.equal(ok, false);
});
