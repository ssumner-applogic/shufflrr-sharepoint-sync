/** A deferred request is not a provider switch or a successful response. */
export class ProviderBackoffError extends Error {
  constructor(public readonly provider: string, public readonly retryAt: Date) {
    super(`${provider} requests are temporarily deferred.`);
    this.name = "ProviderBackoffError";
  }
}

export function retryDelay(value: string | null, attempt: number, now = Date.now()): number {
  if (value !== null && value.trim() !== "") {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

export function requestSpacing(value: string | undefined): number {
  const spacing = value === undefined ? 250 : Number(value);
  if (!Number.isSafeInteger(spacing) || spacing < 50 || spacing > 60_000) {
    throw new Error("Provider request spacing must be an integer between 50 and 60000 milliseconds.");
  }
  return spacing;
}

/** One gate per provider per process, shared by all authenticated clients. */
export class ProviderGate {
  private nextStart = 0;
  private cooldownUntil = 0;
  private tail = Promise.resolve();

  constructor(
    private readonly provider: string,
    private readonly spacingMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  ) {}

  private async start(send: () => Promise<Response>): Promise<{ pending: Promise<Response> }> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      for (;;) {
        const until = Math.max(this.nextStart, this.cooldownUntil);
        const delay = until - this.now();
        // Recheck after sleeping: an in-flight request may have extended the shared cooldown.
        if (delay > 30_000) throw new ProviderBackoffError(this.provider, new Date(until));
        if (delay <= 0) break;
        await this.sleep(delay);
      }
      this.nextStart = this.now() + this.spacingMs;
      // Invoke before releasing the gate, so concurrent callers cannot share the same start slot.
      return { pending: send() };
    } finally {
      release();
    }
  }

  async request(send: () => Promise<Response>, method = "GET", retryRejectedWrites = true): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const { pending } = await this.start(send);
      const response = await pending;
      const throttled = response.status === 429;
      const transient = [502, 503, 504].includes(response.status);
      if (!throttled && !transient) return response;
      const wait = retryDelay(response.headers.get("retry-after"), attempt, this.now());
      this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + wait);
      // Only retry mutations after an explicit 429 rejection, never an ambiguous 5xx.
      if ((method !== "GET" && (!throttled || !retryRejectedWrites)) || attempt >= 2 || wait > 30_000) {
        await response.body?.cancel();
        throw new ProviderBackoffError(this.provider, new Date(this.cooldownUntil));
      }
      await response.body?.cancel();
    }
  }
}
