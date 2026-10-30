import { RateLimitError, ToolkitError } from "./errors.js";
import { cleanText, isRecord } from "./text.js";
import { USER_AGENT } from "./version.js";

/** Minimal fetch signature so tests can inject a fake. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface RequestOptions {
  /** Human name used in error messages, e.g. "SEOBolt". */
  service: string;
  fetch: FetchLike;
  url: string;
  method: "GET" | "POST";
  body?: unknown;
  timeoutMs: number;
  /** Defaults to MAX_RESPONSE_BYTES. */
  maxBytes?: number;
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

/** The service's own error text, cleaned and quoted so it reads as data, never as part of our message. */
function quotedServiceError(parsed: unknown): string | undefined {
  if (isRecord(parsed) && typeof parsed.error === "string") {
    const text = cleanText(parsed.error, 200);
    if (text.length > 0) return JSON.stringify(text);
  }
  return undefined;
}

/** Reads at most `maxBytes` of the body; throws as soon as the limit is exceeded, without buffering the rest. */
async function readCapped(service: string, response: Response, maxBytes: number): Promise<string> {
  const tooBig = () =>
    new ToolkitError("invalid_response", `${service} sent a response larger than ${Math.round(maxBytes / 1024)} KiB; refusing to read it.`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooBig();
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Performs one JSON request with a hard timeout and size cap, and maps every failure to a ToolkitError. */
export async function requestJson(opts: RequestOptions): Promise<unknown> {
  const { service, fetch, url, method, body, timeoutMs } = opts;
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = { accept: "application/json", "user-agent": USER_AGENT };
  // These are fixed-host JSON APIs: a redirect is never expected, and following one would re-send the request elsewhere.
  const init: RequestInit = { method, headers, signal: controller.signal, redirect: "manual" };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response: Response;
  let text: string;
  try {
    response = await fetch(url, init);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new ToolkitError(
        "http_error",
        `${service} answered with a redirect (HTTP ${response.status}); redirects are not followed. The endpoint may have moved.`,
      );
    }
    text = await readCapped(service, response, maxBytes);
  } catch (err) {
    if (err instanceof ToolkitError) throw err;
    if (controller.signal.aborted) {
      throw new ToolkitError(
        "timeout",
        `${service} did not answer within ${Math.round(timeoutMs / 1000)} seconds. The service may be busy; try again later.`,
      );
    }
    const reason = err instanceof Error ? cleanText(err.message, 120) : "unknown error";
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
    const detail = isJson ? quotedServiceError(parsed) : undefined;
    throw new ToolkitError(
      "http_error",
      `${service} returned HTTP ${response.status}${detail ? ` (service message: ${detail})` : ""}. This is a problem on the service side; try again later.`,
    );
  }
  if (response.status >= 400) {
    const detail = isJson ? quotedServiceError(parsed) : undefined;
    throw new ToolkitError(
      "http_error",
      `${service} rejected the request (HTTP ${response.status})${detail ? `; service message: ${detail}` : ""}.`,
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
