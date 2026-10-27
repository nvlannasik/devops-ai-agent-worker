// `node --import ./dist/src/tracing/preload.js dist/index.js` (Dockerfile CMD)
//
// Starts OpenTelemetry before the worker's own module graph loads. Two orderings matter, and both
// were measured (devops-sample-apps, 2026-10-27): the SDK started from index.ts instruments nothing,
// because an ESM entry's imports run before its body; and even started first, an ESM
// `import * as http` stays unpatched without OTel's import-in-the-middle hook. So: register the hook,
// THEN load the SDK and the instrumentations — dynamically, because a static import here would be
// evaluated before register() runs.
//
// The hook is registered through IITM's message channel, so it wraps ONLY the modules an
// instrumentation asks for. Registered bare it wraps every ESM module, and the agent's openai SDK did
// not survive that: its first traced rollout crashlooped (2026-10-27). Same rule here, so a
// dependency added later cannot repeat it. waitForAllMessagesAcknowledged() holds the app until the
// loader knows every module to wrap.
//
// With no OTEL_EXPORTER_OTLP_ENDPOINT nothing is registered or loaded: the service runs exactly as
// it did before tracing existed. Nothing here may throw into the service.
import { register } from "node:module";

const PROBES = new Set(["/health", "/healthz", "/ready", "/readyz", "/metrics"]);
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || null;

if (endpoint) {
  try {
    const { createAddHookMessageChannel } = await import("import-in-the-middle");
    const { registerOptions, waitForAllMessagesAcknowledged } = createAddHookMessageChannel();
    register("import-in-the-middle/hook.mjs", import.meta.url, registerOptions);
    const [{ startTracing }, { HttpInstrumentation }, { UndiciInstrumentation }, { WinstonInstrumentation }] = await Promise.all([
      import("./index.js"),
      import("@opentelemetry/instrumentation-http"),
      import("@opentelemetry/instrumentation-undici"),
      import("@opentelemetry/instrumentation-winston"),
    ]);
    startTracing({
      service: process.env.OTEL_SERVICE_NAME || "llm-worker",
      version: process.env.SERVICE_VERSION || "dev",
      environment: process.env.DEPLOYMENT_ENV || process.env.NODE_ENV || "dev",
      endpoint,
      instrumentations: [
        // No header capture is configured: credential headers never become attributes.
        new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => PROBES.has((req.url ?? "").split("?")[0] ?? "") }),
        // Covers global fetch AND the undici package the worker uses for the LLM and GitHub calls.
        new UndiciInstrumentation(),
        new WinstonInstrumentation(),
      ],
    });
    await waitForAllMessagesAcknowledged();
  } catch (err) {
    console.warn(`[tracing] disabled — the preload failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
