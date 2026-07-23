import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGitOpsEdit, tagOf, type RepoFile, type ChangeSpec } from "./resolve.js";

const HR = { name: "ingress-nginx", namespace: "nginx-ingress" };

// a typical Flux HelmRelease with inline spec.values
const release = (extra: string): RepoFile => ({
  path: "apps/base/systems/ingress-nginx/release.yaml",
  content: `apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: ingress-nginx
  namespace: nginx-ingress
spec:
  chart:
    spec:
      chart: ingress-nginx
  values:
    controller:
${extra}`,
});

const imageChange = (from: string, to: string): ChangeSpec => ({ action: "set_image", container: "controller", changes: [{ field: "image", from, to }] });

test("tagOf extracts the tag and strips a digest; null when no tag", () => {
  assert.equal(tagOf("registry.k8s.io/ingress-nginx/controller:v1.15.1"), "v1.15.1");
  assert.equal(tagOf("repo/app:v2@sha256:abc123"), "v2");
  assert.equal(tagOf("nginx:latest"), "latest");
  assert.equal(tagOf("nginx"), null);
});

test("set_image resolves a `tag:` line and edits only it", () => {
  const files = [release("      image:\n        tag: v1.15.1")];
  const r = resolveGitOpsEdit(files, HR, imageChange("registry.k8s.io/ingress-nginx/controller:v1.15.1", "registry.k8s.io/ingress-nginx/controller:latest"));
  assert.ok(r.ok);
  assert.equal(r.ok && r.valuesKey, "tag");
  assert.equal(r.ok && r.after.trim(), "tag: latest");
  assert.ok(r.ok && r.newContent.includes("tag: latest") && !r.newContent.includes("tag: v1.15.1"));
  assert.ok(r.ok && r.diff.includes("-        tag: v1.15.1") && r.diff.includes("+        tag: latest"));
});

test("set_image resolves a combined `image:` ref line, preserving a trailing comment", () => {
  const files = [release("      image: registry.k8s.io/ingress-nginx/controller:v1.15.1  # pinned")];
  const r = resolveGitOpsEdit(files, HR, imageChange("registry.k8s.io/ingress-nginx/controller:v1.15.1", "registry.k8s.io/ingress-nginx/controller:latest"));
  assert.ok(r.ok);
  assert.equal(r.ok && r.valuesKey, "image");
  assert.ok(r.ok && r.after.includes("# pinned"));
});

test("scale resolves replicaCount", () => {
  const files = [release("      replicaCount: 1")];
  const r = resolveGitOpsEdit(files, HR, { action: "scale", changes: [{ field: "replicas", from: 1, to: 3 }] });
  assert.ok(r.ok);
  assert.equal(r.ok && r.valuesKey, "replicaCount");
  assert.equal(r.ok && r.after.trim(), "replicaCount: 3");
});

test("refuses when the HelmRelease file is missing", () => {
  const other: RepoFile = { path: "x.yaml", content: "kind: ConfigMap\nmetadata:\n  name: other" };
  const r = resolveGitOpsEdit([other], HR, imageChange("repo/a:1", "repo/a:2"));
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /no HelmRelease file/);
});

test("refuses when two files define the same HelmRelease name (ambiguous)", () => {
  const files = [release("      replicaCount: 1"), { ...release("      replicaCount: 1"), path: "apps/dev/ingress/release.yaml" }];
  const r = resolveGitOpsEdit(files, HR, { action: "scale", changes: [{ field: "replicas", from: 1, to: 2 }] });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /ambiguous: 2 files/);
});

test("refuses when the value is not set inline (overlay / chart default)", () => {
  const files = [release("      service:\n        type: LoadBalancer")]; // no tag/replicaCount
  const r = resolveGitOpsEdit(files, HR, imageChange("repo/a:1.0", "repo/a:2.0"));
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /not set inline/);
});

test("refuses when multiple lines match the current value (ambiguous)", () => {
  const files = [release("      replicaCount: 2\n    proxy:\n      replicaCount: 2")];
  const r = resolveGitOpsEdit(files, HR, { action: "scale", changes: [{ field: "replicas", from: 2, to: 4 }] });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /2 lines .* match/);
});

test("refuses set_resources (not supported by the PR flow yet)", () => {
  const files = [release("      resources:\n        limits:\n          memory: 512Mi")];
  const r = resolveGitOpsEdit(files, HR, { action: "set_resources", container: "controller", changes: [{ field: "limits.memory", from: "512Mi", to: "1Gi" }] });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /set_resources is not supported/);
});
