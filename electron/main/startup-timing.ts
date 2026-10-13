// Opt-in diagnostics only. Uptime includes module evaluation, unlike a timer
// initialized at the bottom of an expensive static import graph.
export function traceStartup(stage: string): void {
  if (process.env.SMALLEST_STARTUP_TRACE === '1') {
    console.info(`[startup-timing] ${stage} ${Math.round(process.uptime() * 1000)}ms`)
  }
}
