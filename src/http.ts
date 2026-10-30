import { RateLimitError, ToolkitError } from "./errors.js";
import { USER_AGENT } from "./version.js";

/** Minimal fetch signature so tests can inject a fake. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RequestOptions {
  /** Human name used in error messages, e.g. "SEOBolt". */
  service: string;
  fetch: FetchLike;
  url: string;
  method: "GET" | "POST";
  body?: unknown;
  timeoutMs: number;
}

function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - now) / 1000));
  return undefined;
}

function parseLimit(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function serviceErrorText(parsed: unknown): string | undefined {
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const e = (parsed as { error: unknown }).error;
    if (typeof e === "string" && e.length > 0) return e.slice(0, 300);
  }
  return undefined;
}

/** Performs one JSON request with a hard timeout and maps every failure to a ToolkitError. */
export async function requestJson(opts: RequestOptions): Promise<unknown> {
  const { service, fetch, url, method, body, timeoutMs } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = { accept: "application/json", "user-agent": USER_AGENT };
  const init: RequestInit = { method, headers, signal: controller.signal };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response: Response;
  let text: string;
  try {
    response = await fetch(url, init);
    text = await response.text();
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ToolkitError(
        "timeout",
        `${service} did not answer within ${Math.round(timeoutMs / 1000)} seconds. The service may be busy; try again later.`,
      );
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new ToolkitError("network", `Could not reach ${service}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  let parsed: unknown;
  let isJson = true;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    isJson = false;
  }

  if (response.status === 429) {
    throw new RateLimitError(
      service,
      parseRetryAfter(response.headers.get("retry-after")),
      parseLimit(response.headers.get("x-ratelimit-limit")),
    );
  }
  if (response.status >= 500) {
    const detail = isJson ? serviceErrorText(parsed) : undefined;
    throw new ToolkitError(
      "http_error",
      `${service} returned HTTP ${response.status}${detail ? ` (${detail})` : ""}. This is a problem on the service side; try again later.`,
    );
  }
  if (response.status >= 400) {
    const detail = isJson ? serviceErrorText(parsed) : undefined;
    throw new ToolkitError(
      "http_error",
      `${service} rejected the request (HTTP ${response.status})${detail ? `: ${detail}` : ""}.`,
    );
  }
  if (!isJson || parsed === undefined) {
    throw new ToolkitError(
      "invalid_response",
      `${service} returned a response that is not JSON (HTTP ${response.status}). The endpoint may have changed.`,
    );
  }
  return parsed;
}
