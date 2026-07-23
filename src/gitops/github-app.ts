import { createSign } from "node:crypto";

// GitHub App authentication, hand-rolled with node:crypto (no @octokit dependency — see
// DESIGN_gitops_pr_remediation.md §6). Two steps: sign a short-lived RS256 JWT with the
// app's private key, then exchange it for an installation access token (≤1h) used as the
// bearer for repo/PR calls. Works against github.com and GitHub Enterprise (configurable
// apiBase, e.g. https://<host>/api/v3).

const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

// Build the app JWT. iss = appId, exp ≤ 10 min (GitHub's ceiling); iat backdated 60s to
// tolerate clock skew. Signed RS256 over base64url(header).base64url(payload).
export function buildAppJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${b64url(signature)}`;
}

export interface InstallationToken {
  token: string;
  expiresAt: string; // ISO8601 from GitHub
}

// Exchange the app JWT for an installation access token. fetchImpl is injectable for tests.
export async function getInstallationToken(
  apiBase: string,
  appId: string,
  installationId: string,
  privateKeyPem: string,
  fetchImpl: typeof fetch = fetch
): Promise<InstallationToken> {
  const jwt = buildAppJwt(appId, privateKeyPem);
  const res = await fetchImpl(`${apiBase}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub App token exchange failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { token: string; expires_at: string };
  return { token: body.token, expiresAt: body.expires_at };
}
