import { getInstallationToken } from "./github-app.js";
import logger from "../logger.js";

// Thin GitHub REST client over fetch (no @octokit). Only the calls the PR flow needs:
// read the repo tree + files, create a branch, commit one file, open a PR. Works against
// github.com and GitHub Enterprise via a configurable apiBase. Installation token is cached
// until ~1 min before expiry.

export interface GitHubClientConfig {
  apiUrl: string; // https://api.github.com or https://<ghe-host>/api/v3
  repo: string; // owner/repo
  // Auth: a PAT (used directly as the bearer) takes precedence; otherwise the GitHub App
  // flow (appId + installationId + privateKey → short-lived installation token).
  token?: string;
  appId?: string;
  installationId?: string;
  privateKey?: string;
}

export class GitHubClient {
  private cached?: { token: string; expEpoch: number };

  constructor(
    private readonly cfg: GitHubClientConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async token(): Promise<string> {
    if (this.cfg.token) return this.cfg.token; // PAT — used directly, no exchange
    const now = Math.floor(Date.now() / 1000);
    if (this.cached && this.cached.expEpoch - 60 > now) return this.cached.token;
    const { token, expiresAt } = await getInstallationToken(this.cfg.apiUrl, this.cfg.appId!, this.cfg.installationId!, this.cfg.privateKey!, this.fetchImpl);
    this.cached = { token, expEpoch: Math.floor(new Date(expiresAt).getTime() / 1000) };
    return token;
  }

  private async api(path: string, init: RequestInit = {}): Promise<unknown> {
    const method = init.method ?? "GET";
    const start = Date.now();
    const res = await this.fetchImpl(`${this.cfg.apiUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    // this flow mutates a Git repo but was entirely silent — when a PR half-completes
    // (branch created, commit failed) the log has to show which call got how far
    logger.debug(`[github] ${method} ${path} → ${res.status} (${Date.now() - start}ms)`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // rate-limit exhaustion looks like a plain 403; name it so it isn't read as authz
      const remaining = res.headers.get("x-ratelimit-remaining");
      const rate = remaining === "0" ? ` (rate limit exhausted, resets at ${res.headers.get("x-ratelimit-reset") ?? "?"})` : "";
      throw new Error(`GitHub ${method} ${path} failed: ${res.status}${rate} ${body.slice(0, 500)}`);
    }
    return res.status === 204 ? undefined : res.json();
  }

  // Recursive tree of a branch → YAML file paths (optionally scoped to a prefix).
  async listYamlFiles(branch: string, pathPrefix = ""): Promise<string[]> {
    const tree = (await this.api(`/repos/${this.cfg.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`)) as {
      tree: Array<{ path: string; type: string }>;
      truncated?: boolean;
    };
    // GitHub silently truncates a recursive tree past ~100k entries / 7MB. The missing
    // files then just don't exist as far as the resolver is concerned, so the agent
    // reports "value not found in the overlay" — a wrong answer with no error anywhere.
    if (tree.truncated) {
      throw new Error(
        `GitHub returned a TRUNCATED tree for ${this.cfg.repo}@${branch} — the file list is incomplete, so a "not found" ` +
        `result would be wrong. Narrow the search with GITOPS_PATH_PREFIX (currently "${pathPrefix || "(none)"}").`
      );
    }
    const files = tree.tree
      .filter((e) => e.type === "blob" && /\.ya?ml$/.test(e.path) && e.path.startsWith(pathPrefix))
      .map((e) => e.path);
    logger.debug(`[github] tree ${branch} prefix="${pathPrefix}" → ${files.length} yaml file(s) of ${tree.tree.length} entries`);
    return files;
  }

  async getFile(path: string, branch: string): Promise<{ content: string; sha: string }> {
    const f = (await this.api(`/repos/${this.cfg.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`)) as {
      content: string;
      encoding: string;
      sha: string;
    };
    const content = f.encoding === "base64" ? Buffer.from(f.content, "base64").toString("utf8") : f.content;
    return { content, sha: f.sha };
  }

  // Create `newBranch` pointing at the tip of `fromBranch`.
  async createBranch(newBranch: string, fromBranch: string): Promise<void> {
    const ref = (await this.api(`/repos/${this.cfg.repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`)) as { object: { sha: string } };
    await this.api(`/repos/${this.cfg.repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha: ref.object.sha }),
    });
  }

  // Commit new content for one file on a branch (contents API — no local clone).
  async putFile(path: string, content: string, sha: string, branch: string, message: string): Promise<void> {
    await this.api(`/repos/${this.cfg.repo}/contents/${encodeURI(path)}`, {
      method: "PUT",
      body: JSON.stringify({ message, content: Buffer.from(content, "utf8").toString("base64"), sha, branch }),
    });
  }

  // Open a PR, return its html_url.
  async openPr(title: string, head: string, base: string, body: string): Promise<string> {
    const pr = (await this.api(`/repos/${this.cfg.repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title, head, base, body }),
    })) as { html_url: string };
    return pr.html_url;
  }
}
