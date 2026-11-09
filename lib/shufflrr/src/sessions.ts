export class AppConnectionError extends Error {
  constructor(readonly code: "ended" | "capacity") {
    super(code === "ended" ? "Your app session has ended. Please sign in again."
      : "The server has reached its connection limit. Please try again later.");
  }
}

type Connection = { close(): Promise<void> };
type Entry<T> = {
  promise: Promise<T>;
  client?: T;
  expiresAt: number;
  retired: boolean;
};

/** Disposable, bounded connection reuse, keyed by a verified app session, not a user ID. */
export class AppSessionConnections<T extends Connection> {
  private readonly entries = new Map<string, Entry<T>>();
  constructor(private readonly maxEntries = 256, private readonly now = Date.now) {}

  async get(key: string, create: () => Promise<{ client: T; expiresAt: number }>): Promise<T> {
    await this.sweep();
    const existing = this.entries.get(key);
    if (existing) return existing.promise;
    // Never evict another live user's connection to make room.
    if (this.entries.size >= this.maxEntries) throw new AppConnectionError("capacity");
    const entry: Entry<T> = { promise: undefined!, expiresAt: Infinity, retired: false };
    entry.promise = (async () => {
      try {
        const { client, expiresAt } = await create();
        if (entry.retired || !Number.isFinite(expiresAt) || expiresAt <= this.now()) {
          await client.close();
          throw new AppConnectionError("ended");
        }
        entry.client = client;
        entry.expiresAt = expiresAt;
        return client;
      } catch (error) {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      }
    })();
    this.entries.set(key, entry);
    return entry.promise;
  }

  async end(key: string, expectedClient?: T): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry || (expectedClient && entry.client !== expectedClient)) return;
    this.entries.delete(key);
    entry.retired = true;
    // Pending logins see retired=true on completion and discard their own cookies.
    await entry.client?.close();
  }

  async sweep(): Promise<void> {
    await Promise.all([...this.entries].filter(([, e]) => e.expiresAt <= this.now())
      .map(([key]) => this.end(key)));
  }

  async clear(): Promise<void> {
    await Promise.all([...this.entries.keys()].map(key => this.end(key)));
  }
}
