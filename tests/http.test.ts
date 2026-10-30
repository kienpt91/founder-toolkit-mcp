import { describe, expect, it } from "vitest";
import { RateLimitError, ToolkitError } from "../src/errors.js";
import { requestJson } from "../src/http.js";
import { USER_AGENT } from "../src/version.js";
import { fakeFetch, jsonResponse } from "./helpers.js";

const base = { service: "Svc", url: "https://svc.test/api", timeoutMs: 1000 };

describe("requestJson", () => {
  it("sends GET with identifying headers and parses JSON", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const out = await requestJson({ ...base, fetch, method: "GET" });
    expect(out).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers["user-agent"]).toBe(USER_AGENT);
    expect(calls[0]?.headers["content-type"]).toBeUndefined();
    expect(calls[0]?.body).toBeUndefined();
  });

  it("sends POST JSON bodies with a content type", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: 1 }));
    await requestJson({ ...base, fetch, method: "POST", body: { domain: "example.com" } });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(calls[0]?.body).toEqual({ domain: "example.com" });
  });

  it("maps 429 to a RateLimitError with retry-after and limit", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: "Too many requests" }, 429, { "retry-after": "300", "x-ratelimit-limit": "3" }),
    );
    const err = await requestJson({ ...base, fetch, method: "GET" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    const rl = err as RateLimitError;
    expect(rl.code).toBe("rate_limited");
    expect(rl.retryAfterSeconds).toBe(300);
    expect(rl.limit).toBe(3);
    expect(rl.message).toContain("rate limit");
    expect(rl.message).toContain("300 seconds");
    expect(rl.message).toContain("do not retry in a loop");
  });

  it("handles 429 without a retry-after header", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({}, 429));
    const err = (await requestJson({ ...base, fetch, method: "GET" }).catch((e: unknown) => e)) as RateLimitError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterSeconds).toBeUndefined();
    expect(err.message).toContain("Wait a few minutes");
  });

  it("parses an HTTP-date retry-after", async () => {
    const future = new Date(Date.now() + 120_000).toUTCString();
    const { fetch } = fakeFetch(() => jsonResponse({}, 429, { "retry-after": future }));
    const err = (await requestJson({ ...base, fetch, method: "GET" }).catch((e: unknown) => e)) as RateLimitError;
    expect(err.retryAfterSeconds).toBeGreaterThan(100);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(120);
  });

  it("maps 5xx to a service-side http_error and includes the service message", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "Internal server error" }, 500));
    const err = (await requestJson({ ...base, fetch, method: "GET" }).catch((e: unknown) => e)) as ToolkitError;
    expect(err.code).toBe("http_error");
    expect(err.message).toContain("HTTP 500");
    expect(err.message).toContain("Internal server error");
    expect(err.message).toContain("service side");
  });

  it("maps 4xx to a rejection carrying the service's validation message", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: "Enter a valid public domain (e.g. example.com)" }, 400));
    const err = (await requestJson({ ...base, fetch, method: "POST", body: {} }).catch((e: unknown) => e)) as ToolkitError;
    expect(err.code).toBe("http_error");
    expect(err.message).toContain("HTTP 400");
    expect(err.message).toContain("Enter a valid public domain");
  });

  it("rejects a 200 response that is not JSON", async () => {
    const { fetch } = fakeFetch(() => new Response("<html>oops</html>", { status: 200 }));
    const err = (await requestJson({ ...base, fetch, method: "GET" }).catch((e: unknown) => e)) as ToolkitError;
    expect(err.code).toBe("invalid_response");
    expect(err.message).toContain("not JSON");
    expect(err.message).not.toContain("<html>");
  });

  it("does not leak an HTML 5xx body", async () => {
    const { fetch } = fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const err = (await requestJson({ ...base, fetch, method: "GET" }).catch((e: unknown) => e)) as ToolkitError;
    expect(err.code).toBe("http_error");
    expect(err.message).toContain("HTTP 502");
    expect(err.message).not.toContain("<html>");
  });

  it("aborts and reports a timeout when the service hangs", async () => {
    // Never settles on its own; only the abort signal can end it.
    const hanging = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const started = Date.now();
    const err = (await requestJson({ ...base, fetch: hanging, method: "GET", timeoutMs: 30 }).catch((e: unknown) => e)) as ToolkitError;
    expect(err.code).toBe("timeout");
    expect(err.message).toContain("did not answer");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("maps network failures", async () => {
    const failing = async () => {
      throw new TypeError("fetch failed");
    };
    const err = (await requestJson({ ...base, fetch: failing, method: "GET" }).catch((e: unknown) => e)) as ToolkitError;
    expect(err.code).toBe("network");
    expect(err.message).toContain("Could not reach Svc");
  });
});
