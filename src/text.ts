/**
 * Text helpers. Everything that comes from a third party (audited sites, DNS records, ShowMRR listings,
 * remote error bodies) is treated as hostile: it is stripped of invisible/control characters, length-capped and
 * stripped of anything that could imitate this server's own delimiters before it reaches an agent.
 */

export interface Shaped {
  summary: string;
  data: Record<string, unknown>;
}

/** Shortens long strings so tool output stays small; the marker makes truncation visible. */
export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}… [truncated]`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Control characters, format characters (zero-width, bidi overrides, tag characters, BOM, soft hyphen),
// private-use code points, lone surrogates and variation selectors, plus a few fillers that render as blank.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Variation_Selector}\u115F\u1160\u3164\uFFA0\u2800]/gu;
const LINE_BREAKS = /[\t\n\r\u000B\u000C\u0085\u2028\u2029]+/g;
// A run of three or more angle brackets could imitate the output delimiters; space them out.
const DELIMITER_LIKE = /[<>]{3,}/g;

function neutralize(value: string): string {
  return value.replace(DELIMITER_LIKE, (m) => m.split("").join(" "));
}

/** Single-line text: control/invisible characters removed, whitespace collapsed, capped at `max`. */
export function cleanText(value: string, max: number): string {
  const flat = value.replace(LINE_BREAKS, " ").replace(INVISIBLE, "").replace(/ {2,}/g, " ").trim();
  return clip(neutralize(flat), max);
}

/** Multi-line text (robots.txt, code templates): keeps newlines and tabs, removes everything else invisible. */
export function cleanBlock(value: string, max: number): string {
  const normalized = value.replace(/\r\n?/g, "\n").replace(INVISIBLE, (ch) => (ch === "\n" || ch === "\t" ? ch : ""));
  return clip(neutralize(normalized.replace(/\n{3,}/g, "\n\n").trim()), max);
}

const DEFAULT_STRING_MAX = 1000;
/** Keys whose string values legitimately span several lines, with their caps. */
const BLOCK_KEYS: Record<string, number> = { robotsTxt: 4000, text: 1500, howToFix: 800, fix: 600 };
const MAX_ARRAY = 100;
const MAX_KEYS = 60;
const MAX_DEPTH = 8;
const FORBIDDEN_KEY = /^(__proto__|constructor|prototype)$/;

/** Rebuilds a JSON-like value with every string cleaned and every collection bounded. */
export function cleanDeep(value: unknown, key?: string, depth = 0): unknown {
  if (typeof value === "string") {
    const blockMax = key !== undefined ? BLOCK_KEYS[key] : undefined;
    return blockMax !== undefined ? cleanBlock(value, blockMax) : cleanText(value, DEFAULT_STRING_MAX);
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (depth >= MAX_DEPTH) return "[nested data omitted]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => cleanDeep(v, key, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, MAX_KEYS)) {
      if (FORBIDDEN_KEY.test(k) || v === undefined) continue;
      const cleanKey = cleanText(k, 80);
      if (cleanKey.length === 0) continue;
      out[cleanKey] = cleanDeep(v, k, depth + 1);
    }
    return out;
  }
  return undefined;
}

const SUMMARY_MAX = 700;

/** The only way shapers build their result: sanitizes the summary line and the whole data tree. */
export function shaped(summary: string, data: Record<string, unknown>): Shaped {
  return { summary: cleanText(summary, SUMMARY_MAX), data: cleanDeep(data) as Record<string, unknown> };
}

/** Accepts only http(s) URLs; anything else (javascript:, data:, relative text) becomes undefined. */
export function httpUrlOrUndefined(value: unknown, max = 300): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return cleanText(url.toString(), max);
  } catch {
    return undefined;
  }
}
