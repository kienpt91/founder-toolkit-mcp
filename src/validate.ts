import { ToolkitError } from "./errors.js";
import { cleanText } from "./text.js";

const MAX_INPUT = 2048;
const MAX_HOST = 253;
const LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Names that only exist on private networks or are reserved; purely lexical, see SECURITY.md for the limits. */
const INTERNAL_SUFFIXES = [
  ".local",
  ".localhost",
  ".localdomain",
  ".localnet",
  ".internal",
  ".intranet",
  ".private",
  ".corp",
  ".lan",
  ".home",
  ".arpa",
  ".onion",
  ".invalid",
  ".test",
  ".example",
];
/** Public wildcard-DNS services that resolve embedded IPs, so a lexically public name can point at a private address. */
const WILDCARD_DNS_ZONES = ["nip.io", "sslip.io", "xip.io", "traefik.me", "localtest.me", "lvh.me", "vcap.me", "lacolhost.com"];
/** Characters that must never appear in a target: whitespace, control/format characters, backslashes. */
const FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}\s\\]/u;

const LETTER_SCRIPTS = [
  "Latin",
  "Cyrillic",
  "Greek",
  "Armenian",
  "Hebrew",
  "Arabic",
  "Devanagari",
  "Thai",
  "Georgian",
  "Han",
  "Hiragana",
  "Katakana",
  "Hangul",
] as const;
const CJK_SCRIPTS: readonly string[] = ["Han", "Hiragana", "Katakana", "Hangul"];

function invalid(message: string): never {
  throw new ToolkitError("invalid_input", message);
}

function shown(raw: string): string {
  return `"${cleanText(raw, 80)}"`;
}

/**
 * Returns why a lowercase ASCII hostname is not acceptable as a public DNS name, or undefined if it is acceptable.
 * Shared by user-supplied targets and by names read from remote DNS records (SPF include/redirect targets).
 */
export function publicNameProblem(host: string): string | undefined {
  if (host.length === 0) return "it is empty";
  if (host.length > MAX_HOST) return `it is longer than ${MAX_HOST} characters`;
  if (host.includes(":") || host.startsWith("[")) return "IP addresses are not supported";
  if (IPV4.test(host)) return "IP addresses are not supported";
  if (host === "localhost" || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return "it is a private or reserved name; only public domains are supported";
  }
  const labels = host.split(".");
  if (labels.length < 2) return "it is a single label, not a public domain (it needs a dot, e.g. example.com)";
  if (!labels.every((l) => LABEL.test(l))) return "it is not a valid domain name (empty or over-long label, or unsupported character)";
  const tld = labels[labels.length - 1] as string;
  if (!/[a-z]/.test(tld)) return "its top-level label has no letters, so it would be read as an IP address";
  if (WILDCARD_DNS_ZONES.some((z) => host === z || host.endsWith(`.${z}`))) {
    return "it belongs to a wildcard-DNS service that can point at private addresses";
  }
  return undefined;
}

// RFC 3492 punycode, implemented here so that validation does not depend on the Node/ICU build's IDNA handling.
const PC = { base: 36, tMin: 1, tMax: 26, skew: 38, damp: 700, initialBias: 72, initialN: 128 } as const;

function adapt(delta: number, numPoints: number, first: boolean): number {
  let d = first ? Math.floor(delta / PC.damp) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((PC.base - PC.tMin) * PC.tMax) >> 1) {
    d = Math.floor(d / (PC.base - PC.tMin));
    k += PC.base;
  }
  return k + Math.floor(((PC.base - PC.tMin + 1) * d) / (d + PC.skew));
}

function digitValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 22; // 0-9 -> 26-35
  if (c >= 97 && c <= 122) return c - 97; // a-z -> 0-25
  return -1;
}

function digitChar(d: number): string {
  return String.fromCharCode(d < 26 ? d + 97 : d + 22);
}

/** Decodes the part of an `xn--` label after the prefix; undefined when it is not valid punycode. */
function punycodeDecode(input: string): number[] | undefined {
  const delim = input.lastIndexOf("-");
  const out: number[] = [];
  for (let i = 0; i < Math.max(delim, 0); i++) {
    const c = input.charCodeAt(i);
    if (c >= 128) return undefined;
    out.push(c);
  }
  let n: number = PC.initialN;
  let bias: number = PC.initialBias;
  let i = 0;
  for (let idx = delim > 0 ? delim + 1 : 0; idx < input.length; ) {
    const oldi = i;
    let w = 1;
    for (let k = PC.base; ; k += PC.base) {
      if (idx >= input.length) return undefined;
      const digit = digitValue(input.charCodeAt(idx++));
      if (digit < 0 || digit > Math.floor((0x7fffffff - i) / w)) return undefined;
      i += digit * w;
      const t = k <= bias ? PC.tMin : k >= bias + PC.tMax ? PC.tMax : k - bias;
      if (digit < t) break;
      const mult = PC.base - t;
      if (w > Math.floor(0x7fffffff / mult)) return undefined;
      w *= mult;
    }
    const len = out.length + 1;
    bias = adapt(i - oldi, len, oldi === 0);
    if (Math.floor(i / len) > 0x7fffffff - n) return undefined;
    n += Math.floor(i / len);
    i %= len;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return undefined;
    out.splice(i++, 0, n);
  }
  return out;
}

function punycodeEncode(cps: number[]): string {
  let out = cps.filter((c) => c < 128).map((c) => String.fromCharCode(c)).join("");
  const b = out.length;
  let h = b;
  if (b > 0) out += "-";
  let n: number = PC.initialN;
  let delta = 0;
  let bias: number = PC.initialBias;
  while (h < cps.length) {
    const m = Math.min(...cps.filter((c) => c >= n));
    delta += (m - n) * (h + 1);
    n = m;
    for (const c of cps) {
      if (c < n) delta++;
      if (c === n) {
        let q = delta;
        for (let k = PC.base; ; k += PC.base) {
          const t = k <= bias ? PC.tMin : k >= bias + PC.tMax ? PC.tMax : k - bias;
          if (q < t) break;
          out += digitChar(t + ((q - t) % (PC.base - t)));
          q = Math.floor((q - t) / (PC.base - t));
        }
        out += digitChar(q);
        bias = adapt(delta, h + 1, h === b);
        delta = 0;
        h++;
      }
    }
    delta++;
    n++;
  }
  return out;
}

function mixedScriptProblem(asciiHost: string): string | undefined {
  const labels: string[] = [];
  let anyIdn = false;
  for (const label of asciiHost.split(".")) {
    if (!label.startsWith("xn--")) {
      labels.push(label);
      continue;
    }
    anyIdn = true;
    const body = label.slice(4);
    const cps = punycodeDecode(body);
    const bad = "its internationalized (xn--) label is not valid punycode";
    if (cps === undefined || cps.length === 0 || cps.every((c) => c < 128)) return bad;
    if (punycodeEncode(cps) !== body) return bad;
    const text = String.fromCodePoint(...cps);
    if (text !== text.normalize("NFC") || !/^[\p{L}\p{M}\p{N}-]+$/u.test(text)) return bad;
    labels.push(text);
  }
  if (!anyIdn) return undefined;
  for (const label of labels) {
    const present = LETTER_SCRIPTS.filter((s) => new RegExp(`\\p{Script=${s}}`, "u").test(label));
    if (present.filter((s) => !CJK_SCRIPTS.includes(s)).length > 1) {
      return `its label ${shown(label)} mixes writing systems, which is how look-alike (homograph) domains are built; punycode form: ${asciiHost}`;
    }
  }
  return undefined;
}

function parseTarget(input: string): URL {
  const raw = input.trim();
  if (raw.length === 0) invalid("Enter a domain such as example.com.");
  if (raw.length > MAX_INPUT) invalid(`Input is too long (max ${MAX_INPUT} characters).`);
  if (FORBIDDEN_CHARS.test(raw)) invalid(`${shown(raw)} contains whitespace, control or invisible characters, or a backslash.`);
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const withScheme = hasScheme ? raw : `https://${raw}`;
  const authority = withScheme.slice(withScheme.indexOf("//") + 2).split(/[/?#]/, 1)[0] as string;
  if (authority.includes("@")) invalid("Credentials (user@host) are not supported in targets.");
  if (authority.includes("%")) invalid("Percent-encoded characters are not supported in the host part of a target.");
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return invalid(`${shown(raw)} is not a valid domain or URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") invalid("Only http(s) targets are supported.");
  return url;
}

function checkedHost(url: URL, raw: string): string {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const problem = publicNameProblem(host) ?? mixedScriptProblem(host);
  if (problem) invalid(`${shown(raw)} was rejected: ${problem}.`);
  return host;
}

/**
 * Accepts "example.com", "https://www.example.com/path" or "example.com/path" and returns a lowercase ASCII
 * (punycode) public hostname. Explicit non-default ports, credentials, IPs, reserved names and mixed-script
 * look-alikes are rejected with a clear error.
 */
export function normalizeDomain(input: string): string {
  const url = parseTarget(input);
  if (url.port !== "") invalid("Ports are not supported for domain targets; pass just the domain name.");
  return checkedHost(url, input);
}

/**
 * Accepts a full http(s) URL, or a bare domain/path which is promoted to https://. Returns the normalized URL
 * without a fragment. Only the default ports (80, 443) are allowed, so the checker service is never pointed at
 * an arbitrary service on a public host.
 */
export function normalizeUrl(input: string): string {
  const url = parseTarget(input);
  if (url.port !== "" && url.port !== "80" && url.port !== "443") invalid(`Port ${url.port} is not supported; only 80 and 443 are allowed.`);
  checkedHost(url, input);
  url.hash = "";
  return url.toString();
}
