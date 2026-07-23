// GitOps PR-flow resolver (DESIGN_gitops_pr_remediation.md §3). Given the owning
// HelmRelease + the change context from the MCP GitOps preview, locate the file in the Git
// repo and compute the one-scalar edit — WITHOUT a YAML dependency: a targeted line edit
// keeps the diff to a single line and preserves comments/formatting (a parse+reserialize
// would rewrite the whole file). Everything degrades to an honest refuse on ambiguity.
//
// ponytail: line-based, image+scale only. set_resources needs structured YAML navigation
// (nested resources.{requests,limits}.{cpu,memory}); revisit with the `yaml` Document API
// if/when resources PR-flow is needed.

export interface RepoFile {
  path: string;
  content: string;
}
export interface GitOpsChange {
  field: string;
  from: string | number;
  to: string | number;
}
export interface ChangeSpec {
  action: "set_image" | "scale" | "set_resources";
  container?: string;
  changes: GitOpsChange[];
}
export interface HelmReleaseRef {
  name: string;
  namespace: string;
}

export type ResolveResult =
  | { ok: true; path: string; valuesKey: string; before: string; after: string; newContent: string; diff: string }
  | { ok: false; reason: string };

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A HelmRelease's Git file: `kind: HelmRelease` + a metadata `name:` matching the release.
// Namespace is intentionally not matched line-based (it may be defaulted/omitted in the
// file); duplicate names collapse to a refuse below.
function isHelmReleaseFile(content: string, name: string): boolean {
  if (!/^\s*kind:\s*HelmRelease\s*$/m.test(content)) return false;
  return new RegExp(`^\\s*name:\\s*(["']?)${escapeRe(name)}\\1\\s*$`, "m").test(content);
}

// image tag = the part after the last ':' with any @digest stripped. null when the ref
// carries no tag (we then can't safely locate/rewrite it).
export function tagOf(ref: string): string | null {
  const noDigest = ref.split("@")[0];
  const idx = noDigest.lastIndexOf(":");
  if (idx === -1) return null;
  const tag = noDigest.slice(idx + 1);
  return tag.length > 0 ? tag : null;
}

interface SearchSpec {
  keys: string[]; // candidate value-key names for this action
  from: string;
  to: string;
}

// Build the (key, from→to) search specs for an action. null = this action can't be
// resolved line-based (with a human reason).
function searchSpecs(spec: ChangeSpec): { specs: SearchSpec[] } | { error: string } {
  if (spec.action === "set_image") {
    const c = spec.changes[0];
    if (!c) return { error: "no image change provided" };
    const fromRef = String(c.from);
    const toRef = String(c.to);
    const fromTag = tagOf(fromRef);
    const toTag = tagOf(toRef);
    const specs: SearchSpec[] = [{ keys: ["image"], from: fromRef, to: toRef }];
    if (fromTag && toTag) specs.push({ keys: ["tag"], from: fromTag, to: toTag });
    return { specs };
  }
  if (spec.action === "scale") {
    const c = spec.changes[0];
    if (!c) return { error: "no replica change provided" };
    return { specs: [{ keys: ["replicaCount", "replicas"], from: String(c.from), to: String(c.to) }] };
  }
  // set_resources: nested resources.{requests,limits}.{cpu,memory} — not line-resolvable safely yet.
  return { error: "set_resources is not supported by the GitOps PR flow yet (only image and scale)" };
}

interface LineMatch {
  lineIdx: number;
  key: string;
  indent: string;
  quote: string;
  to: string;
  comment: string;
}

// Every line `<indent><key>: <value>[ # comment]` whose key ∈ a spec's keys and whose
// value == that spec's `from`. Collected across the whole file; the caller refuses unless
// there's exactly one.
function findMatches(lines: string[], specs: SearchSpec[]): LineMatch[] {
  const out: LineMatch[] = [];
  lines.forEach((line, lineIdx) => {
    for (const spec of specs) {
      for (const key of spec.keys) {
        const m = line.match(new RegExp(`^(\\s*)${escapeRe(key)}:\\s*(["']?)${escapeRe(spec.from)}\\2\\s*(#.*)?$`));
        if (m) out.push({ lineIdx, key, indent: m[1], quote: m[2], to: spec.to, comment: m[3] ? ` ${m[3]}` : "" });
      }
    }
  });
  return out;
}

function unifiedDiff(path: string, lineIdx: number, before: string, after: string): string {
  return [`--- a/${path}`, `+++ b/${path}`, `@@ line ${lineIdx + 1} @@`, `-${before}`, `+${after}`].join("\n");
}

// Locate the HelmRelease file and compute the single-scalar edit, or refuse with a reason.
export function resolveGitOpsEdit(files: RepoFile[], hr: HelmReleaseRef, spec: ChangeSpec): ResolveResult {
  const hrFiles = files.filter((f) => isHelmReleaseFile(f.content, hr.name));
  if (hrFiles.length === 0) return { ok: false, reason: `no HelmRelease file for \`${hr.namespace}/${hr.name}\` found in the repo` };
  if (hrFiles.length > 1) {
    return { ok: false, reason: `ambiguous: ${hrFiles.length} files define a HelmRelease named \`${hr.name}\` (${hrFiles.map((f) => f.path).join(", ")})` };
  }
  const file = hrFiles[0];

  const built = searchSpecs(spec);
  if ("error" in built) return { ok: false, reason: built.error };

  const lines = file.content.split("\n");
  const matches = findMatches(lines, built.specs);
  if (matches.length === 0) {
    return {
      ok: false,
      reason: `the current value is not set inline in \`${file.path}\` — it may rely on a chart default or be set via an overlay patch (not supported yet); add the override to the HelmRelease values first`,
    };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `ambiguous: ${matches.length} lines in \`${file.path}\` match the current value — refusing to guess` };
  }

  const m = matches[0];
  const before = lines[m.lineIdx];
  const after = `${m.indent}${m.key}: ${m.quote}${m.to}${m.quote}${m.comment}`;
  const newLines = [...lines];
  newLines[m.lineIdx] = after;
  return {
    ok: true,
    path: file.path,
    valuesKey: m.key,
    before,
    after,
    newContent: newLines.join("\n"),
    diff: unifiedDiff(file.path, m.lineIdx, before, after),
  };
}
