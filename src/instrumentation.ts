/**
 * Next.js instrumentation entry point.
 *
 * Runs once per server boot (and per edge worker boot for edge runtime).
 * Wire Sentry / OpenTelemetry / PostHog Node SDK / etc. here.
 *
 * Currently a no-op so the file is safe to ship without any of the above
 * configured. To enable, install the SDK and replace the body.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Example (Sentry):
    //   const Sentry = await import("@sentry/nextjs");
    //   Sentry.init({ dsn: process.env.SENTRY_DSN });
    // Example (OpenTelemetry):
    //   const { NodeSDK } = await import("@opentelemetry/sdk-node");
    //   new NodeSDK({ ... }).start();
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    // Edge-compatible SDK initialization (subset of Node SDKs).
  }
}
