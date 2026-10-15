export type UpstreamSource = 'jupiter'
export class TokenUpstreamCounter {
  private readonly counts = new Map<string, number>()
  private timer: NodeJS.Timeout | undefined
  increment(source: UpstreamSource, status: string | number): void {
    const key = `${source},${status}`
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1)
  }
  snapshot(): Record<string, number> { return Object.fromEntries(this.counts) }
  start(logger: (line: string) => void = console.info): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      const summary = Object.entries(this.snapshot()).map(([key, value]) => {
        const [source, status] = key.split(',')
        return `token_upstream_calls_total{source=\"${source}\",status=\"${status}\"} ${value}`
      }).join(' ')
      logger(`[api] ${summary || 'token_upstream_calls_total no calls'}`)
    }, 60_000)
    this.timer.unref?.()
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }
}
