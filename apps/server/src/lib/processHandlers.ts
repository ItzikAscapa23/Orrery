// Extracted so tests can exercise handlers without importing index.ts (which starts a server).

export function onUnhandledRejection(reason: unknown): void {
  console.error(
    JSON.stringify({
      event: 'unhandled_rejection',
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    }),
  );
  // Do NOT exit — an unhandled promise rejection does not corrupt process state.
  // Fire-and-forget appendEvent calls can reject on transient DB errors; the
  // process must survive to keep serving in-flight jobs.
}

export function onUncaughtException(err: Error, origin: string): void {
  console.error(
    JSON.stringify({
      event: 'uncaught_exception',
      error: err.message,
      stack: err.stack,
      origin,
    }),
  );
  // Keep alive — synchronous throws from event-emitter handlers land here.
  // The process state is typically still usable for async Prisma/BullMQ errors.
}
