// GitOps PR-flow SQS contract (agent → worker). Separate request queue from the LLM path;
// replies go to the SHARED response queue routed by requestId (DESIGN_gitops_pr_remediation.md
// §6). `repo`/`branch` are NOT in the message — the worker owns them via config (single-repo
// blast radius).

export interface GitOpsChangeMsg {
  field: string;
  from: string | number;
  to: string | number;
}

export interface GitOpsRequest {
  requestId: string;
  op: "dry_run" | "open_pr";
  helmRelease: { name: string; namespace: string };
  action: "set_image" | "scale" | "set_resources";
  container?: string;
  // chart component (workload's app.kubernetes.io/component label) — disambiguates which
  // values sub-tree to edit when a multi-component chart repeats replicaCount/resources.
  component?: string;
  changes: GitOpsChangeMsg[];
  // repo subtree to search — the agent auto-detects it from the Flux Kustomization's
  // spec.path (per-environment overlay, e.g. "apps/dev/applications"). Falls back to the
  // worker's GITOPS_PATH_PREFIX when absent.
  pathPrefix?: string;
  incident?: { summary?: string; threadUrl?: string }; // for the PR title/body
}

// response.response payload (business result); transport/exception failures use the
// envelope's `error` instead (mirrors the LLM path → agent shows an error, no card).
export type GitOpsPayload =
  | { ok: true; op: "dry_run"; path: string; valuesKey: string; before: string; after: string; diff: string }
  | { ok: true; op: "open_pr"; path: string; prUrl: string }
  | { ok: false; reason: string };

export interface GitOpsResponse {
  requestId: string;
  response?: GitOpsPayload;
  error?: string;
}

// Parse + validate. null → poison message (drop, never retry). Mirrors parseSqsRequest.
export function parseGitOpsRequest(body: string): GitOpsRequest | null {
  let p: unknown;
  try {
    p = JSON.parse(body);
  } catch {
    return null;
  }
  if (!p || typeof p !== "object") return null;
  const r = p as Record<string, unknown>;
  if (typeof r.requestId !== "string" || !r.requestId) return null;
  if (r.op !== "dry_run" && r.op !== "open_pr") return null;
  const hr = r.helmRelease as { name?: unknown; namespace?: unknown } | undefined;
  if (!hr || typeof hr.name !== "string" || typeof hr.namespace !== "string") return null;
  if (r.action !== "set_image" && r.action !== "scale" && r.action !== "set_resources") return null;
  if (!Array.isArray(r.changes)) return null;
  return p as GitOpsRequest;
}
