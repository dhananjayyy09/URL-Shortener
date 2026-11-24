export function redactErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Unknown error";
  }

  return error.message.replace(/:\/\/([^/\s]+)@/g, "://[redacted]@");
}
