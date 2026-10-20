# GitOps PR-flow (optional)

Design: `devops-ai-agent/docs/DESIGN_gitops_pr_remediation.md`. Off unless set.

The worker doubles as the private-network bridge to **GitHub Enterprise** (reachable only
from here). When auth + a repo are configured, a second SQS handler serves five ops against
the GitOps repo for a Flux HelmRelease-managed workload:

- `dry_run` — preview the edit, no write;
- `open_pr` — branch, commit, open a PR;
- `history` — read-only: the commits that touched the HelmRelease's files, overlay + base, since a
  given time; feeds the agent's change timeline;
- `revert_pr` — restore the HelmRelease's files to a commit's parent; refuses unless every touched
  file still reads the same at HEAD as at that commit, i.e. a clean revert; never reads the
  `history` file memo, since it writes from what it reads;
- `locate` — read-only and batched (up to 50 targets): for each HelmRelease, the file, line and
  key holding its running image and replicas — the same search the PR flow edits with, read fresh.
  Ambiguity is a note, never a guess; drift is `drift: true` at the declared line. Feeds the
  agent's onboarding "where to change it".

The message shapes are a contract with the agent; the workspace `CLAUDE.md` spells them out.

## Auth

**A PAT (simple, recommended for the initial phase) OR a GitHub App.** A PAT
(`GITHUB_TOKEN`) is used directly and takes precedence; without it the App flow is used.
Enabled when either auth + `GITOPS_REPO` are set.

| Variable | Description | Default |
|----------|-------------|---------|
| `GITHUB_API_URL` | GitHub API base — GHE = `https://<host>/api/v3` | `https://api.github.com` |
| `GITHUB_TOKEN` | **PAT** (fine-grained → repo `contents:write`+`pull_requests:write`, else classic `repo`). Simplest; used directly | — |
| `GITHUB_APP_ID` | GitHub App id (alternative to a PAT) | — |
| `GITHUB_APP_INSTALLATION_ID` | App installation id on the GitOps repo | — |
| `GITHUB_APP_PRIVATE_KEY` | App private key (PEM, inline) | — |
| `GITHUB_APP_PRIVATE_KEY_FILE` | …or a path to the PEM (mounted secret) — takes precedence | — |
| `GITOPS_REPO` | `owner/repo` — the ONLY repo the handler may touch | — |
| `GITOPS_BRANCH` | Base branch for PRs | `main` |
| `GITOPS_PATH_PREFIX` | Optional search-scope subtree (e.g. `apps/`) | — |
| `SQS_GITOPS_REQUEST_QUEUE_NAME` | FIFO queue for GitOps requests | `gitops-request.fifo` |
