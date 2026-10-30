import type { DnsResolver, MxRecord } from "../src/emailauth.js";
import type { FetchLike } from "../src/http.js";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Fake fetch: records every call and answers with whatever `answer` returns. No network is ever touched. */
export function fakeFetch(answer: (call: RecordedCall) => Response | Promise<Response>): {
  fetch: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return answer(call);
  };
  return { fetch, calls };
}

export function dnsError(code: string): Error {
  return Object.assign(new Error(`query ${code}`), { code });
}

/** Fake resolver backed by plain maps. Missing names behave like NXDOMAIN-style ENODATA. */
export function fakeResolver(
  txt: Record<string, string[] | string[][] | Error>,
  mx: Record<string, MxRecord[] | Error> = {},
): { resolver: DnsResolver; queries: string[] } {
  const queries: string[] = [];
  const resolver: DnsResolver = {
    async resolveTxt(name) {
      queries.push(`TXT ${name}`);
      const hit = txt[name];
      if (hit === undefined) throw dnsError("ENODATA");
      if (hit instanceof Error) throw hit;
      return hit.map((r) => (Array.isArray(r) ? r : [r]));
    },
    async resolveMx(name) {
      queries.push(`MX ${name}`);
      const hit = mx[name];
      if (hit === undefined) throw dnsError("ENODATA");
      if (hit instanceof Error) throw hit;
      return hit;
    },
  };
  return { resolver, queries };
}
