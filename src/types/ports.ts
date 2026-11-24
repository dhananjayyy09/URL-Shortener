export interface DatabasePort {
  ping(): Promise<boolean>
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
