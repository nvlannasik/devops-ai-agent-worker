import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGitOpsEdit, deriveBasePrefix, tagOf, type RepoFile, type ChangeSpec } from "./resolve.js";

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
  assert.match(r.ok ? "" : r.reason, /not set in the overlay/);
});

test("refuses when multiple lines match the current value (ambiguous)", () => {
  const files = [release("      replicaCount: 2\n    proxy:\n      replicaCount: 2")];
  const r = resolveGitOpsEdit(files, HR, { action: "scale", changes: [{ field: "replicas", from: 2, to: 4 }] });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /2 lines .* match/);
});

test("set_resources edits the right nested leaf (limits.memory, not requests.memory)", () => {
  const files = [release("      resources:\n        requests:\n          memory: 256Mi\n          cpu: 250m\n        limits:\n          memory: 512Mi\n          cpu: 500m")];
  const r = resolveGitOpsEdit(files, HR, {
    action: "set_resources",
    container: "controller",
    changes: [{ field: "limits.memory", from: "512Mi", to: "1Gi" }],
  });
  assert.ok(r.ok);
  assert.ok(r.ok && r.newContent.includes("memory: 1Gi") && r.newContent.includes("memory: 256Mi")); // limits changed, requests untouched
  assert.ok(r.ok && r.diff.includes("-          memory: 512Mi") && r.diff.includes("+          memory: 1Gi"));
});

test("set_resources applies multiple changes and reports them", () => {
  const files = [release("      resources:\n        requests:\n          cpu: 250m\n        limits:\n          memory: 512Mi")];
  const r = resolveGitOpsEdit(files, HR, {
    action: "set_resources",
    changes: [
      { field: "requests.cpu", from: "250m", to: "500m" },
      { field: "limits.memory", from: "512Mi", to: "1Gi" },
    ],
  });
  assert.ok(r.ok);
  assert.ok(r.ok && r.newContent.includes("cpu: 500m") && r.newContent.includes("memory: 1Gi"));
  assert.equal(r.ok && r.valuesKey, "requests.cpu, limits.memory");
});

test("set_resources refuses when the value isn't set inline", () => {
  const files = [release("      service:\n        type: LoadBalancer")]; // no resources block
  const r = resolveGitOpsEdit(files, HR, { action: "set_resources", changes: [{ field: "limits.memory", from: "512Mi", to: "1Gi" }] });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /not set in the overlay/);
});

// ---- cluster/GitOps drift ----
// Someone changes an image tag straight in the cluster. The incident context then carries the
// DRIFTED value as `from`, so the value-matching search misses and the old code answered
// "the value is not set in the overlay" — which is false and unactionable.

const overlayWithTag: RepoFile = {
  path: "apps/dev/applications/api/release.yaml",
  content: `kind: HelmRelease
metadata:
  name: api
  namespace: flux-system
spec:
  values:
    image:
      repository: registry.local/api
      tag: v1.4.0`,
};

test("image tag changed in-cluster is reported as drift, not as 'not set in the overlay'", () => {
  const r = resolveGitOpsEdit([overlayWithTag], { name: "api", namespace: "flux-system" }, {
    action: "set_image",
    changes: [{ field: "image", from: "registry.local/api:v9.9.9", to: "registry.local/api:v1.4.0" }],
  });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.drift, "expected a drift verdict");
  assert.equal(!r.ok && r.drift!.gitValue, "v1.4.0");
  assert.equal(!r.ok && r.drift!.clusterValue, "v9.9.9");
  assert.ok(!r.ok && /source of truth/.test(r.reason));
  // must NOT ask for a base lookup — the key is right here, it just disagrees
  assert.ok(!r.ok && !r.tryBase);
});

test("replica count changed in-cluster is reported as drift", () => {
  const overlay: RepoFile = {
    path: "apps/dev/applications/api/release.yaml",
    content: `kind: HelmRelease
metadata:
  name: api
spec:
  values:
    replicaCount: 2`,
  };
  const r = resolveGitOpsEdit([overlay], { name: "api", namespace: "flux-system" }, {
    action: "scale",
    changes: [{ field: "replicas", from: 7, to: 4 }],
  });
  assert.ok(!r.ok && r.drift && r.drift.gitValue === "2" && r.drift.clusterValue === "7");
});

test("a genuinely absent key is still 'not set' + tryBase, not drift", () => {
  const r = resolveGitOpsEdit([overlayNoScale], HR2, { action: "scale", changes: [{ field: "replicas", from: 1, to: 3 }] });
  assert.ok(!r.ok && !r.drift && r.tryBase);
});

// ---- base → overlay ADD (value only in base) ----

const HR2 = { name: "headlamp", namespace: "flux-system" };
const overlayNoScale: RepoFile = {
  path: "apps/dev/systems/headlamp/release.yaml",
  content: `kind: HelmRelease
metadata:
  name: headlamp
  namespace: flux-system
spec:
  values:
    image:
      tag: v0.43.0`,
};
const baseWithScale: RepoFile = {
  path: "apps/base/systems/headlamp/release.yaml",
  content: `kind: HelmRelease
metadata:
  name: headlamp
  namespace: flux-system
spec:
  values:
    replicaCount: 1
    resources:
      limits:
        memory: 512Mi`,
};

test("deriveBasePrefix swaps the env segment for base", () => {
  assert.equal(deriveBasePrefix("apps/dev/systems"), "apps/base/systems");
  assert.equal(deriveBasePrefix("apps/prd/applications/"), "apps/base/applications");
  assert.equal(deriveBasePrefix("apps/base/systems"), undefined); // already base
  assert.equal(deriveBasePrefix("single"), undefined);
});

test("value absent from overlay signals tryBase (no base files given)", () => {
  const r = resolveGitOpsEdit([overlayNoScale], HR2, { action: "scale", changes: [{ field: "replicas", from: 1, to: 3 }] });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.tryBase);
});

test("scale not in overlay but in base → ADDS replicaCount to the overlay", () => {
  const r = resolveGitOpsEdit([overlayNoScale], HR2, { action: "scale", changes: [{ field: "replicas", from: 1, to: 3 }] }, [baseWithScale]);
  assert.ok(r.ok && r.addedFromBase);
  assert.ok(r.ok && /replicaCount: 3/.test(r.newContent));
  assert.ok(r.ok && r.newContent.includes("tag: v0.43.0")); // existing overlay value untouched
});

// An overlay that already sets the key to another value looks identical to "not set at all"
// to a value-matching search. It is caught as drift before base-add is ever reached — and
// must be, because setIn would otherwise REPLACE the operator's value while additiveDiff
// rendered it as a clean insertion.
test("overlay already sets the key to another value → drift, never a silent overwrite", () => {
  const overlayWithOtherScale: RepoFile = {
    path: "apps/dev/systems/headlamp/release.yaml",
    content: `kind: HelmRelease
metadata:
  name: headlamp
  namespace: flux-system
spec:
  values:
    replicaCount: 5`,
  };
  const r = resolveGitOpsEdit([overlayWithOtherScale], HR2, { action: "scale", changes: [{ field: "replicas", from: 1, to: 3 }] }, [baseWithScale]);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.drift && r.drift.gitValue === "5" && r.drift.clusterValue === "1");
  // the overlay's own value survives untouched — no newContent is produced at all
  assert.ok(!r.ok && !("newContent" in r));
});

test("resources not in overlay but in base → ADDS the nested path to the overlay", () => {
  const r = resolveGitOpsEdit([overlayNoScale], HR2, { action: "set_resources", changes: [{ field: "limits.memory", from: "512Mi", to: "1Gi" }] }, [baseWithScale]);
  assert.ok(r.ok && r.addedFromBase);
  assert.ok(r.ok && /resources:/.test(r.newContent) && /memory: 1Gi/.test(r.newContent));
});

test("value in neither overlay nor base → refuse (chart default)", () => {
  const emptyBase: RepoFile = { path: "apps/base/x/release.yaml", content: "kind: HelmRelease\nmetadata:\n  name: headlamp\nspec:\n  values: {}" };
  const r = resolveGitOpsEdit([overlayNoScale], HR2, { action: "scale", changes: [{ field: "replicas", from: 1, to: 3 }] }, [emptyBase]);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /neither the overlay nor base|isn't set in base/);
});

test("base-add REFUSES when the key is ambiguous in base — never guesses which to override", () => {
  const ambiguousBase: RepoFile = {
    path: "apps/base/systems/headlamp/release.yaml",
    content: `kind: HelmRelease
metadata:
  name: headlamp
spec:
  values:
    controller:
      replicaCount: 1
    proxy:
      replicaCount: 1`,
  };
  const r = resolveGitOpsEdit([overlayNoScale], HR2, { action: "scale", changes: [{ field: "replicas", from: 1, to: 3 }] }, [ambiguousBase]);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /refusing to guess/);
});

// ---- component-aware disambiguation (multi-component charts) ----

test("multi-component same value: the component label picks the right replicaCount (edit)", () => {
  const files = [release("      replicaCount: 1\n    proxy:\n      replicaCount: 1")]; // controller + proxy, both 1
  const amb = resolveGitOpsEdit(files, HR, { action: "scale", changes: [{ field: "replicas", from: 1, to: 3 }] });
  assert.equal(amb.ok, false); // no component → ambiguous
  assert.match(amb.ok ? "" : amb.reason, /refusing to guess/);

  const ctrl = resolveGitOpsEdit(files, HR, { action: "scale", changes: [{ field: "replicas", from: 1, to: 3 }], component: "controller" });
  assert.ok(ctrl.ok && ctrl.newContent.indexOf("replicaCount: 3") < ctrl.newContent.indexOf("proxy:")); // controller's (before proxy)

  const proxy = resolveGitOpsEdit(files, HR, { action: "scale", changes: [{ field: "replicas", from: 1, to: 3 }], component: "proxy" });
  assert.ok(proxy.ok && proxy.newContent.indexOf("replicaCount: 3") > proxy.newContent.indexOf("proxy:")); // proxy's (after)
});

test("multi-component base-add: component picks which sub-tree to override; unknown component still refuses", () => {
  const overlay: RepoFile = { path: "apps/dev/x/release.yaml", content: "kind: HelmRelease\nmetadata:\n  name: multi\nspec:\n  values:\n    image:\n      tag: v1" };
  const base: RepoFile = { path: "apps/base/x/release.yaml", content: "kind: HelmRelease\nmetadata:\n  name: multi\nspec:\n  values:\n    controller:\n      replicaCount: 1\n    worker:\n      replicaCount: 1" };
  const hr = { name: "multi", namespace: "x" };

  const amb = resolveGitOpsEdit([overlay], hr, { action: "scale", changes: [{ field: "replicas", from: 1, to: 2 }] }, [base]);
  assert.equal(amb.ok, false); // ambiguous in base, no component

  const worker = resolveGitOpsEdit([overlay], hr, { action: "scale", changes: [{ field: "replicas", from: 1, to: 2 }], component: "worker" }, [base]);
  assert.ok(worker.ok && worker.addedFromBase && /worker:/.test(worker.newContent) && /replicaCount: 2/.test(worker.newContent));

  const unknown = resolveGitOpsEdit([overlay], hr, { action: "scale", changes: [{ field: "replicas", from: 1, to: 2 }], component: "sidecar" }, [base]);
  assert.equal(unknown.ok, false); // component not in base → doesn't narrow → still refuses (never guesses)
});
