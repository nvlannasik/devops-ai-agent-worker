import "dotenv/config";
import { readFileSync } from "node:fs";

// GitHub App private key: inline PEM (GITHUB_APP_PRIVATE_KEY) or a mounted file
// (GITHUB_APP_PRIVATE_KEY_FILE, e.g. a K8s secret). Read once at startup.
function readGithubPrivateKey(): string {
  const file = process.env.GITHUB_APP_PRIVATE_KEY_FILE;
  if (file) return readFileSync(file, "utf8");
  return process.env.GITHUB_APP_PRIVATE_KEY ?? "";
}

export const config = {
  sqs: {
    region: process.env.AWS_REGION ?? "ap-southeast-1",
    requestQueueName: process.env.SQS_REQUEST_QUEUE_NAME ?? "llm-request.fifo",
    responseQueueName: process.env.SQS_RESPONSE_QUEUE_NAME ?? "llm-response.fifo",
    requestDlqName: process.env.SQS_REQUEST_DLQ_NAME ?? "llm-request-dlq.fifo",
    pollWaitSeconds: parseInt(process.env.SQS_POLL_WAIT_SECONDS ?? "10"),
    maxMessages: parseInt(process.env.SQS_MAX_MESSAGES ?? "5"),
    // max messages processed concurrently — the poll loop keeps pulling new work up
    // to this cap so one slow LLM call can't block pickup of other requests
    maxConcurrency: parseInt(process.env.SQS_MAX_CONCURRENCY ?? "10"),
    visibilityTimeoutSeconds: parseInt(process.env.SQS_VISIBILITY_TIMEOUT_SECONDS ?? "300"),
    // after this many receives without a successful delete, SQS moves the message to the DLQ itself
    maxReceiveCount: parseInt(process.env.SQS_MAX_RECEIVE_COUNT ?? "3"),
  },
  llm: {
    // Wire format of the backend, NOT the model vendor: "openai" = /v1/chat/completions
    // (vLLM, Ollama, SGLang, most gateways), "anthropic" = /v1/messages. Default keeps every
    // existing deployment on the path it already used. Validated at boot by assertApiFormat().
    apiFormat: (process.env.LLM_API_FORMAT ?? "openai") as "openai" | "anthropic",
    baseUrl: process.env.LLM_BASE_URL!,
    // sent as `Authorization: Bearer` (openai) or `x-api-key` (anthropic)
    apiKey: process.env.LLM_API_KEY ?? "none",
    // Optional SOCKS proxy for the LLM API only (e.g. socks5://127.0.0.1:1080). Node's
    // fetch/undici has no SOCKS support and ignores ALL_PROXY, so a tunnel that curl reaches
    // via SOCKS is invisible to the worker without this. Unset = direct connection (no code
    // path change) — remove the env once the host is whitelisted. Scoped to the LLM client,
    // NOT global, so the GitOps GitHub calls aren't forced through it.
    socksProxy: process.env.LLM_SOCKS_PROXY ?? "",
    model: process.env.LLM_MODEL!,
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS ?? "8096"),
    useMaxCompletionTokens: process.env.LLM_USE_MAX_COMPLETION_TOKENS === "true",
    // optional: forwarded as reasoning_effort ("low" | "medium" | "high") for reasoning
    // models — caps hidden thinking tokens so they can't eat the whole output budget.
    // Leave unset if the backend doesn't accept the param.
    reasoningEffort: process.env.LLM_REASONING_EFFORT as "low" | "medium" | "high" | undefined,
    temperature: process.env.LLM_TEMPERATURE ? parseFloat(process.env.LLM_TEMPERATURE) : undefined,
    topP: process.env.LLM_TOP_P ? parseFloat(process.env.LLM_TOP_P) : undefined,
    seed: process.env.LLM_SEED ? parseInt(process.env.LLM_SEED) : undefined,
  },
  // GitOps PR-flow (DESIGN_gitops_pr_remediation.md). The worker is the private-network
  // bridge; GitHub Enterprise is reachable only from here. `enabled` gates the second SQS
  // handler (Step 3) — off unless a GitHub App + repo are configured.
  gitops: {
    // enabled by EITHER a PAT (simple, initial-phase) OR a GitHub App, plus a repo.
    enabled: !!((process.env.GITHUB_TOKEN || process.env.GITHUB_APP_ID) && process.env.GITOPS_REPO),
    apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com", // GHE: https://<host>/api/v3
    // PAT — used directly as the bearer when set; takes precedence over the App flow.
    token: process.env.GITHUB_TOKEN ?? "",
    // GitHub App flow (used when no PAT): appId + installationId + private key → installation token.
    appId: process.env.GITHUB_APP_ID ?? "",
    installationId: process.env.GITHUB_APP_INSTALLATION_ID ?? "",
    privateKey: readGithubPrivateKey(),
    repo: process.env.GITOPS_REPO ?? "", // owner/repo — the ONLY repo the handler may touch
    branch: process.env.GITOPS_BRANCH ?? "main",
    pathPrefix: process.env.GITOPS_PATH_PREFIX ?? "", // optional search-scope subtree
    requestQueueName: process.env.SQS_GITOPS_REQUEST_QUEUE_NAME ?? "gitops-request.fifo",
  },
};
