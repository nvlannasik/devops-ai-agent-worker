// `node --import ./dist/src/tracing/preload.js dist/index.js` (Dockerfile CMD)
//
// Starts OpenTelemetry before the worker's own module graph loads. Two orderings matter, and both
// were measured (devops-sample-apps, 2026-10-27): the SDK started from index.ts instruments nothing,
// because an ESM entry's imports run before its body; and even started first, an ESM
// `import * as http` stays unpatched without OTel's import-in-the-middle hook. So: register the hook
// before the app's first import — everything here is dynamic, because a static import would be
// evaluated before this body runs.
//
// The hook is IITM's synchronous one (`module.registerHooks()`, in-thread). `module.register()` is
// deprecated (DEP0205) and printed a warning on every boot. Node 26 is required, so the sync loader
// is always supported; on an older Node register() throws and tracing is disabled below.
//
// It wraps ONLY the modules an instrumentation asks for: `include` is built from each
// instrumentation's own module list. Without `include` IITM wraps every ESM module, and the agent's
// openai SDK did not survive that: its first traced rollout crashlooped (2026-10-27). The async hook
// learned the names over a message channel; the sync one does not, so the list must be passed —
// never drop it. Same rule here, so a dependency added later cannot repeat it.
//
// With no OTEL_EXPORTER_OTLP_ENDPOINT nothing is registered or loaded: the service runs exactly as
// it did before tracing existed. Nothing here may throw into the service.
const PROBES = new Set(["/health", "/healthz", "/ready", "/readyz", "/metrics"]);
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || null;

if (endpoint) {
  try {
    const [{ register }, { startTracing }, { HttpInstrumentation }, { UndiciInstrumentation }, { WinstonInstrumentation }] = await Promise.all([
      import("import-in-the-middle/register-hooks.mjs"),
      import("./index.js"),
      import("@opentelemetry/instrumentation-http"),
      import("@opentelemetry/instrumentation-undici"),
      import("@opentelemetry/instrumentation-winston"),
    ]);
    const instrumentations = [
      // No header capture is configured: credential headers never become attributes.
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => PROBES.has((req.url ?? "").split("?")[0] ?? "") }),
      // Covers global fetch AND the undici package the worker uses for the LLM and GitHub calls.
      new UndiciInstrumentation(),
      new WinstonInstrumentation(),
    ];
    register({ include: [...new Set(instrumentations.flatMap((i) => i.getModuleDefinitions().map((d) => d.name)))] });
    startTracing({
      service: process.env.OTEL_SERVICE_NAME || "llm-worker",
      version: process.env.SERVICE_VERSION || "dev",
      environment: process.env.DEPLOYMENT_ENV || process.env.NODE_ENV || "dev",
      endpoint,
      instrumentations,
    });
  } catch (err) {
    console.warn(`[tracing] disabled — the preload failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
