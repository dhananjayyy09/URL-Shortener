export interface WarnLogger {
  warn(obj: object, msg: string): void;
}

// Logs at most one warning per interval and reports how many were suppressed,
// so a dependency outage does not produce one log line per request.
export class ThrottledWarning {
  private lastLoggedAt = Number.NEGATIVE_INFINITY;
  private suppressed = 0;

  constructor(
    private readonly message: string,
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  log(log: WarnLogger, fields: object): void {
    const now = this.now();
    if (now - this.lastLoggedAt < this.intervalMs) {
      this.suppressed += 1;
      return;
    }

    log.warn({ ...fields, suppressedSinceLastLog: this.suppressed }, this.message);
    this.lastLoggedAt = now;
    this.suppressed = 0;
  }
}
