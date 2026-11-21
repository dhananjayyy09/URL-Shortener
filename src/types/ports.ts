export interface DatabasePort {
  ping(): Promise<boolean>
  close(): Promise<void>
}

export interface RedisPort {
  ping(): Promise<boolean>
  close(): Promise<void>
}
