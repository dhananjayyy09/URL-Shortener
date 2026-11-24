export interface DatabasePort {
  ping(): Promise<boolean>
  migrationsApplied(): Promise<boolean>
  close(): Promise<void>
}

export interface RedisPort {
  ping(): Promise<boolean>
  close(): Promise<void>
}

export interface Queryable {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>
}

export interface CacheStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
}

export interface RateLimitWindow {
  count: number
  ttlMs: number
}

export interface RateLimitStore {
  incrementWindow(key: string, windowMs: number): Promise<RateLimitWindow>
}
