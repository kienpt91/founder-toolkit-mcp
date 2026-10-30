export type ErrorCode =
  | "invalid_input"
  | "rate_limited"
  | "http_error"
  | "timeout"
  | "network"
  | "invalid_response"
  | "dns";

/** Every failure that should be reported to the agent (instead of crashing the server) is one of these. */
export class ToolkitError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ToolkitError";
    this.code = code;
  }
}

export class RateLimitError extends ToolkitError {
  readonly service: string;
  readonly retryAfterSeconds?: number;
  readonly limit?: number;
  constructor(service: string, retryAfterSeconds?: number, limit?: number) {
    const wait =
      retryAfterSeconds !== undefined
        ? ` Retry after about ${retryAfterSeconds} seconds.`
        : " Wait a few minutes before retrying.";
    const quota = limit !== undefined ? ` (limit reported by the service: ${limit} requests per window)` : "";
    super(
      "rate_limited",
      `${service} rate limit reached${quota}.${wait} These free endpoints limit anonymous requests per IP address; do not retry in a loop, and tell the user the check is temporarily unavailable.`,
    );
    this.name = "RateLimitError";
    this.service = service;
    this.retryAfterSeconds = retryAfterSeconds;
    this.limit = limit;
  }
}

/** Message shown to the agent. Unexpected errors are not echoed (they may contain local paths); the server logs them to stderr. */
export function errorMessage(err: unknown): string {
  if (err instanceof ToolkitError) return err.message;
  return "Unexpected internal error. Details were written to the server's stderr.";
}
