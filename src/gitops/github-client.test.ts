import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubClient } from "./github-client.js";

test("a PAT is used directly as the bearer, skipping the App token exchange", async () => {
  const calls: { url: string; auth?: string }[] = [];
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    if (u.includes("/access_tokens")) throw new Error("App token exchange must NOT be called when a PAT is set");
    return { ok: true, status: 200, json: async () => ({ content: Buffer.from("hi").toString("base64"), encoding: "base64", sha: "s1" }) } as Response;
  };
  const client = new GitHubClient({ apiUrl: "https://ghe/api/v3", repo: "o/r", token: "ghp_test123" }, fakeFetch as typeof fetch);

  const f = await client.getFile("apps/x.yaml", "main");
  assert.equal(f.content, "hi");
  assert.equal(calls[0].auth, "Bearer ghp_test123");
  assert.ok(!calls.some((c) => c.url.includes("/access_tokens")));
});
