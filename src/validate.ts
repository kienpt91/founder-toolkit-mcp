import { ToolkitError } from "./errors.js";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const RESERVED_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home.arpa", ".invalid", ".test", ".example"];
const LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;

function invalid(message: string): never {
  throw new ToolkitError("invalid_input", message);
}

function tryUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Accepts "example.com", "https://www.example.com/path" or "example.com/path" and
 * returns a lowercase public hostname. Rejects IPs, localhost, single labels and reserved suffixes.
 */
export function normalizeDomain(input: string): string {
  const raw = input.trim();
  if (raw.length === 0) invalid("Enter a domain such as example.com.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = tryUrl(withScheme);
  if (!url || !url.hostname) invalid(`"${raw}" is not a valid domain.`);
  if (url.protocol !== "http:" && url.protocol !== "https:") invalid("Only http(s) targets are supported.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.includes(":") || host.startsWith("[")) invalid("IP addresses are not supported; use a public domain name.");
  if (IPV4.test(host)) invalid("IP addresses are not supported; use a public domain name.");
  const labels = host.split(".");
  if (labels.length < 2) invalid(`"${host}" is not a public domain (it needs a dot, e.g. example.com).`);
  if (host === "localhost" || RESERVED_SUFFIXES.some((s) => host.endsWith(s))) {
    invalid(`"${host}" is a private or reserved name; only public domains are supported.`);
  }
  if (host.length > 253 || !labels.every((l) => LABEL.test(l))) invalid(`"${host}" is not a valid domain name.`);
  return host;
}

/**
 * Accepts a full http(s) URL, or a bare domain/path which is promoted to https://.
 * Rejects credentials, IPs and private names. Returns the normalized URL string.
 */
export function normalizeUrl(input: string): string {
  const raw = input.trim();
  if (raw.length === 0) invalid("Enter a page URL such as https://example.com/page.");
  if (raw.length > 2048) invalid("URL is too long (max 2048 characters).");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = tryUrl(withScheme);
  if (!url) invalid(`"${raw}" is not a valid URL.`);
  if (url.protocol !== "http:" && url.protocol !== "https:") invalid("Only http and https URLs are supported.");
  if (url.username || url.password) invalid("URLs with embedded credentials are not supported.");
  normalizeDomain(url.hostname); // reuse the public-host rules
  return url.toString();
}
