import { parseDocument } from "yaml";

// GitOps PR-flow resolver (DESIGN_gitops_pr_remediation.md §3). Given the owning HelmRelease
// + the change context from the MCP GitOps preview, locate the file in the Git repo and edit
// the value. IN-OVERLAY edits are line-based (targeted, minimal diff, comments preserved). If
// the value is ONLY in base (not overridden per-env), the value's PATH is learned from base
// and ADDED to the overlay's spec.values via the `yaml` Document API (setIn — creates the
// nested key cleanly), so a remediation isn't refused just because the value wasn't overridden
// in the overlay yet. Everything degrades to an honest refuse on ambiguity.
//
// ponytail: line-based for edits; `yaml` Document only for the base→overlay ADD path.
// set_resources nested leaves resolved via an indentation parent stack (limits.memory vs
// requests.memory); not container-scoped (refuses on ambiguity — fine for one resources block).

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
  // chart component (from the workload's app.kubernetes.io/component label) — used to pick the
  // right values sub-tree when a multi-component chart has several replicaCount/resources.
  component?: string;
}

// When several candidate paths match, keep only the one under the target component's sub-tree
// (its key appears in the path). No component, or the filter doesn't narrow to exactly one →
// return the originals unchanged (caller then refuses on ambiguity — never guesses).
function narrowByComponent<T extends { path: string[] }>(matches: T[], component?: string): T[] {
  if (matches.length <= 1 || !component) return matches;
  const filtered = matches.filter((m) => m.path.includes(component));
  return filtered.length === 1 ? filtered : matches;
}
export interface HelmReleaseRef {
  name: string;
  namespace: string;
}

export type ResolveResult =
  | { ok: true; path: string; valuesKey: string; before: string; after: string; newContent: string; diff: string; addedFromBase?: boolean }
  | { ok: false; reason: string; tryBase?: boolean }; // tryBase = value absent from overlay → the caller may retry with base files

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
  // set_resources is handled by resolveResourceEdit (nested, multi-line) — not here.
  return { error: "internal: set_resources must not reach searchSpecs" };
}

interface ResourceMatch {
  lineIdx: number;
  indent: string;
  quote: string;
  comment: string;
  path: string[];
}

// Find a leaf `<leafKey>: <from>` line whose enclosing block is `<parentKey>:` and that sits
// somewhere under a `resources:` block — via an indentation-tracked parent stack. This is how
// `limits.memory` is disambiguated from `requests.memory` (same leaf/value, different parent).
// `path` (ancestor keys) lets the caller further narrow by chart component.
function findResourceMatches(lines: string[], parentKey: string, leafKey: string, from: string): ResourceMatch[] {
  const out: ResourceMatch[] = [];
  const stack: Array<{ indent: number; key: string }> = []; // enclosing block headers
  const leafRe = new RegExp(`^(\\s*)${escapeRe(leafKey)}:\\s*(["']?)${escapeRe(from)}\\2\\s*(#.*)?$`);
  const headerRe = /^(\s*)([\w.\-/]+):\s*(#.*)?$/; // "key:" with nothing (or a comment) after

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();

    const leaf = line.match(leafRe);
    if (leaf) {
      const parent = stack[stack.length - 1];
      if (parent && parent.key === parentKey && stack.some((s) => s.key === "resources")) {
        out.push({ lineIdx: i, indent: leaf[1], quote: leaf[2], comment: leaf[3] ? ` ${leaf[3]}` : "", path: [...stack.map((s) => s.key), leafKey] });
      }
      continue;
    }
    const header = line.match(headerRe);
    if (header) stack.push({ indent, key: header[2] });
  }
  return out;
}

// set_resources: each change (`limits.memory`, `requests.cpu`, ...) → one nested leaf edit.
// All must resolve uniquely; multiple changes are applied to distinct lines.
function resolveResourceEdit(path: string, lines: string[], changes: GitOpsChange[], component?: string): ResolveResult {
  const newLines = [...lines];
  const applied: Array<{ lineIdx: number; before: string; after: string }> = [];
  for (const c of changes) {
    const [parentKey, leafKey, ...rest] = String(c.field).split(".");
    if (!parentKey || !leafKey || rest.length) return { ok: false, reason: `unexpected resource field \`${c.field}\` (expected <requests|limits>.<cpu|memory>)` };
    const matches = narrowByComponent(findResourceMatches(lines, parentKey, leafKey, String(c.from)), component);
    if (matches.length === 0) {
      return { ok: false, reason: `\`resources.${c.field}\` is not set in the overlay \`${path}\``, tryBase: true };
    }
    if (matches.length > 1) return { ok: false, reason: `ambiguous: ${matches.length} lines match \`resources.${c.field}\` in \`${path}\`${component ? ` even within component \`${component}\`` : ""} — refusing to guess` };
    const m = matches[0];
    if (applied.some((a) => a.lineIdx === m.lineIdx)) return { ok: false, reason: `two changes resolved to the same line in \`${path}\`` };
    const before = lines[m.lineIdx];
    const after = `${m.indent}${leafKey}: ${m.quote}${c.to}${m.quote}${m.comment}`;
    newLines[m.lineIdx] = after;
    applied.push({ lineIdx: m.lineIdx, before, after });
  }
  if (applied.length === 0) return { ok: false, reason: "no resource changes provided" };
  const sorted = [...applied].sort((a, b) => a.lineIdx - b.lineIdx);
  const diff = [`--- a/${path}`, `+++ b/${path}`, ...sorted.map((e) => `@@ line ${e.lineIdx + 1} @@\n-${e.before}\n+${e.after}`)].join("\n");
  return {
    ok: true,
    path,
    valuesKey: changes.map((c) => c.field).join(", "),
    before: applied[0].before.trim(),
    after: applied[0].after.trim(),
    newContent: newLines.join("\n"),
    diff,
  };
}

interface LineMatch {
  lineIdx: number;
  key: string;
  indent: string;
  quote: string;
  to: string;
  comment: string;
  path: string[];
}

// Every line `<indent><key>: <value>[ # comment]` whose key ∈ a spec's keys and whose value
// == that spec's `from`, with its ancestor `path` (for component narrowing). Collected across
// the file; the caller refuses unless exactly one remains.
function findMatches(lines: string[], specs: SearchSpec[]): LineMatch[] {
  const out: LineMatch[] = [];
  const stack: Array<{ indent: number; key: string }> = [];
  const headerRe = /^(\s*)([\w.\-/]+):\s*(#.*)?$/;
  lines.forEach((line, lineIdx) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const indent = line.length - line.trimStart().length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (headerRe.test(line)) {
      stack.push({ indent, key: line.match(headerRe)![2] });
      return;
    }
    for (const spec of specs) {
      for (const key of spec.keys) {
        const m = line.match(new RegExp(`^(\\s*)${escapeRe(key)}:\\s*(["']?)${escapeRe(spec.from)}\\2\\s*(#.*)?$`));
        if (m) out.push({ lineIdx, key, indent: m[1], quote: m[2], to: spec.to, comment: m[3] ? ` ${m[3]}` : "", path: [...stack.map((s) => s.key), key] });
      }
    }
  });
  return out;
}

function unifiedDiff(path: string, lineIdx: number, before: string, after: string): string {
  return [`--- a/${path}`, `+++ b/${path}`, `@@ line ${lineIdx + 1} @@`, `-${before}`, `+${after}`].join("\n");
}

// The in-overlay edit for image/scale/set_resources. `tryBase: true` on its refusal means
// the value simply isn't in this file → the caller may retry against base.
function editInFile(path: string, lines: string[], spec: ChangeSpec): ResolveResult {
  if (spec.action === "set_resources") return resolveResourceEdit(path, lines, spec.changes, spec.component);

  const built = searchSpecs(spec);
  if ("error" in built) return { ok: false, reason: built.error };
  const matches = narrowByComponent(findMatches(lines, built.specs), spec.component);
  if (matches.length === 0) return { ok: false, reason: `the value is not set in the overlay \`${path}\``, tryBase: true };
  if (matches.length > 1) return { ok: false, reason: `ambiguous: ${matches.length} lines in \`${path}\` match the current value${spec.component ? ` even within component \`${spec.component}\`` : ""} — refusing to guess` };

  const m = matches[0];
  const before = lines[m.lineIdx];
  const after = `${m.indent}${m.key}: ${m.quote}${m.to}${m.quote}${m.comment}`;
  const newLines = [...lines];
  newLines[m.lineIdx] = after;
  return { ok: true, path, valuesKey: m.key, before, after, newContent: newLines.join("\n"), diff: unifiedDiff(path, m.lineIdx, before, after) };
}

// Locate the overlay HelmRelease file and edit the value. When the value isn't in the overlay
// and `baseFiles` are supplied, learn its path from base and ADD it to the overlay (§3.4).
export function resolveGitOpsEdit(files: RepoFile[], hr: HelmReleaseRef, spec: ChangeSpec, baseFiles?: RepoFile[]): ResolveResult {
  const hrFiles = files.filter((f) => isHelmReleaseFile(f.content, hr.name));
  if (hrFiles.length === 0) return { ok: false, reason: `no HelmRelease file for \`${hr.namespace}/${hr.name}\` found in the repo` };
  if (hrFiles.length > 1) {
    return { ok: false, reason: `ambiguous: ${hrFiles.length} files define a HelmRelease named \`${hr.name}\` (${hrFiles.map((f) => f.path).join(", ")})` };
  }
  const file = hrFiles[0];
  const inOverlay = editInFile(file.path, file.content.split("\n"), spec);
  if (inOverlay.ok || !inOverlay.tryBase || !baseFiles) return inOverlay;
  return addFromBase(file, baseFiles, hr, spec);
}

// ---- base → overlay ADD (value only in base) ----

interface KeyMatcher {
  leafKeys: string[];
  parentKey?: string;
  ancestorKey?: string;
}

// Full paths (from doc root) of leaf keys matching the matcher, via an indentation parent
// stack. Matches by KEY only (not value) — we want the schema path to replicate in the overlay.
function findKeyPaths(lines: string[], m: KeyMatcher): string[][] {
  const out: string[][] = [];
  const stack: Array<{ indent: number; key: string }> = [];
  const headerRe = /^(\s*)([\w.\-/]+):\s*(#.*)?$/;
  const leafRe = /^(\s*)([\w.\-/]+):\s+\S.*$/;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (headerRe.test(line)) {
      stack.push({ indent, key: line.match(headerRe)![2] });
      continue;
    }
    const leaf = line.match(leafRe);
    if (!leaf || !m.leafKeys.includes(leaf[2])) continue;
    const parent = stack[stack.length - 1];
    if (m.parentKey && (!parent || parent.key !== m.parentKey)) continue;
    if (m.ancestorKey && !stack.some((s) => s.key === m.ancestorKey)) continue;
    out.push([...stack.map((s) => s.key), leaf[2]]);
  }
  return out;
}

// Per-change {matcher, value to write, label}. Only scale + set_resources support base-add
// (image tags essentially always live in overlays).
function baseMatchers(spec: ChangeSpec): Array<{ matcher: KeyMatcher; to: string | number; label: string }> | { error: string } {
  if (spec.action === "scale") {
    const c = spec.changes[0];
    return [{ matcher: { leafKeys: ["replicaCount", "replicas"], ancestorKey: "values" }, to: Number(c.to), label: "replicaCount" }];
  }
  if (spec.action === "set_resources") {
    return spec.changes.map((c) => {
      const [parentKey, leafKey] = String(c.field).split(".");
      return { matcher: { leafKeys: [leafKey], parentKey, ancestorKey: "resources" }, to: String(c.to), label: `resources.${c.field}` };
    });
  }
  return { error: "not supported by base-add" };
}

// Purely-additive diff (setIn only inserts) — the lines present in `next` but not `prev`.
function additiveDiff(path: string, prev: string, next: string): string {
  const a = prev.split("\n");
  const b = next.split("\n");
  const added: string[] = [];
  let i = 0;
  for (const line of b) {
    if (i < a.length && a[i] === line) i++;
    else added.push(`+${line}`);
  }
  return [`--- a/${path}`, `+++ b/${path}`, `@@ added to spec.values @@`, ...added].join("\n");
}

function addFromBase(overlay: RepoFile, baseFiles: RepoFile[], hr: HelmReleaseRef, spec: ChangeSpec): ResolveResult {
  const matchers = baseMatchers(spec);
  if ("error" in matchers) return { ok: false, reason: `the value is not set in the overlay and can't be auto-added for this action — set it in the overlay values first` };

  const baseHr = baseFiles.filter((f) => isHelmReleaseFile(f.content, hr.name));
  if (baseHr.length === 0) return { ok: false, reason: `the value is set in neither the overlay nor base — it relies on a chart default; set it explicitly in the overlay values first` };
  if (baseHr.length > 1) return { ok: false, reason: `ambiguous: ${baseHr.length} base files define a HelmRelease named \`${hr.name}\`` };
  const baseLines = baseHr[0].content.split("\n");

  const doc = parseDocument(overlay.content);
  const added: string[] = [];
  for (const { matcher, to, label } of matchers) {
    // narrowByComponent operates on {path}; wrap the raw paths to reuse it
    const paths = narrowByComponent(findKeyPaths(baseLines, matcher).map((path) => ({ path })), spec.component).map((w) => w.path);
    if (paths.length === 0) return { ok: false, reason: `\`${label}\` isn't set in base either — it's a chart default; set it explicitly in the overlay` };
    if (paths.length > 1) return { ok: false, reason: `ambiguous: \`${label}\` appears ${paths.length}× in base${spec.component ? ` even within component \`${spec.component}\`` : ""} — refusing to guess where to override` };
    doc.setIn(paths[0], to);
    added.push(`${paths[0].slice(2).join(".")} = ${to}`); // strip spec.values for display
  }
  const newContent = doc.toString();
  return {
    ok: true,
    path: overlay.path,
    valuesKey: added.map((a) => a.split(" = ")[0]).join(", "),
    before: "(not in overlay — added from base)",
    after: added.join(", "),
    newContent,
    diff: additiveDiff(overlay.path, overlay.content, newContent),
    addedFromBase: true,
  };
}

// overlay prefix (apps/dev/systems) → base prefix (apps/base/systems): the env segment (2nd)
// becomes "base". Returns undefined when the shape doesn't fit (no auto-base then).
export function deriveBasePrefix(overlayPrefix: string, baseSegment = "base"): string | undefined {
  const parts = overlayPrefix.replace(/\/+$/, "").split("/");
  if (parts.length < 2 || parts[1] === baseSegment) return undefined;
  parts[1] = baseSegment;
  return parts.join("/");
}
