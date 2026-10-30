import { createPublicKey } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { z } from "zod";
import type { Shaped } from "./seobolt.js";
import { clip } from "./text.js";
import { normalizeDomain } from "./validate.js";

export interface MxRecord {
  exchange: string;
  priority: number;
}

/** The two lookups this module needs; tests inject a fake. */
export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolveMx(name: string): Promise<MxRecord[]>;
}

export function createNodeResolver(timeoutMs = 4000): DnsResolver {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 2 });
  return {
    resolveTxt: (name) => resolver.resolveTxt(name),
    resolveMx: (name) => resolver.resolveMx(name),
  };
}

export type Severity = "fail" | "warn" | "info" | "pass";
export type Status = "pass" | "warn" | "fail" | "unknown";

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  fix?: string;
}

export const COMMON_DKIM_SELECTORS = ["default", "google", "selector1", "selector2", "k1", "s1", "s2", "mail", "dkim", "smtp"];
export const SPF_LOOKUP_LIMIT = 10;
const MAX_SPF_QUERIES = 25;

const SELECTOR = /^[A-Za-z0-9_]([A-Za-z0-9_-]{0,62})?(\.[A-Za-z0-9_-]{1,63})*$/;

export const emailAuthShape = {
  domain: z.string().min(1).max(2048).describe("Sending domain to check, e.g. example.com (a URL is reduced to its host)."),
  dkimSelectors: z
    .array(z.string().trim().regex(SELECTOR, "invalid DKIM selector").max(120))
    .max(10)
    .optional()
    .describe(
      "DKIM selectors to look up (the s= value in a DKIM-Signature header of a real message). If omitted, a short list of common selectors is probed, which cannot prove DKIM is absent.",
    ),
};

export const emailAuthSchema = z.object(emailAuthShape).transform((input, ctx) => {
  try {
    const selectors = input.dkimSelectors
      ? [...new Set(input.dkimSelectors.map((s) => s.toLowerCase()))]
      : undefined;
    return { domain: normalizeDomain(input.domain), dkimSelectors: selectors };
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["domain"],
      message: err instanceof Error ? err.message : "invalid domain",
    });
    return z.NEVER;
  }
});

// ---------------------------------------------------------------- DNS helpers

interface TxtLookup {
  records: string[];
  failed?: string;
}

const NO_DATA = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN", "ENOENT"]);

function errCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return "UNKNOWN";
}

async function lookupTxt(resolver: DnsResolver, name: string): Promise<TxtLookup> {
  try {
    const chunks = await resolver.resolveTxt(name);
    return { records: chunks.map((parts) => parts.join("")) };
  } catch (err) {
    const code = errCode(err);
    if (NO_DATA.has(code)) return { records: [] };
    return { records: [], failed: code };
  }
}

function worst(findings: Finding[]): Status {
  if (findings.some((f) => f.severity === "fail")) return "fail";
  if (findings.some((f) => f.severity === "warn")) return "warn";
  return "pass";
}

function lookupFailedFinding(name: string, code: string): Finding {
  return {
    severity: "warn",
    code: "dns-lookup-failed",
    message: `DNS lookup for ${name} failed (${code}); the result for this check is unknown, not "missing".`,
    fix: "Retry later or check the machine's DNS connectivity.",
  };
}

// ------------------------------------------------------------------------ SPF

type Qualifier = "+" | "-" | "~" | "?";

export interface SpfResult {
  status: Status;
  record?: string;
  allQualifier?: Qualifier | "redirect" | "none";
  dnsLookups?: number;
  findings: Finding[];
}

const SPF_PREFIX = /^v=spf1(\s|$)/i;
const SPF_MECHANISMS = new Set(["all", "include", "a", "mx", "ptr", "ip4", "ip6", "exists"]);

interface SpfTerm {
  qualifier: Qualifier;
  mechanism: string;
  value?: string;
  raw: string;
}

function parseSpfTerms(record: string): { terms: SpfTerm[]; redirect?: string; unknown: string[] } {
  const terms: SpfTerm[] = [];
  const unknown: string[] = [];
  let redirect: string | undefined;
  for (const raw of record.trim().split(/\s+/).slice(1)) {
    const lower = raw.toLowerCase();
    if (lower.startsWith("redirect=")) {
      redirect = raw.slice("redirect=".length);
      continue;
    }
    if (lower.startsWith("exp=")) continue;
    const m = /^([+\-~?])?([a-z0-9]+)(?:[:=/](.*))?$/i.exec(raw);
    const mechanism = m?.[2]?.toLowerCase();
    if (!m || !mechanism || !SPF_MECHANISMS.has(mechanism)) {
      unknown.push(raw);
      continue;
    }
    // keep the original separator-less value for include/a/mx; ip4/ip6 values are not inspected.
    const colon = raw.indexOf(":");
    terms.push({
      qualifier: (m[1] as Qualifier | undefined) ?? "+",
      mechanism,
      value: colon >= 0 ? raw.slice(colon + 1) : undefined,
      raw,
    });
  }
  return { terms, redirect, unknown };
}

interface SpfContext {
  resolver: DnsResolver;
  lookups: number;
  queries: number;
  findings: Finding[];
  visited: Set<string>;
  budgetExhausted: boolean;
}

async function fetchSpfRecords(ctx: SpfContext, domain: string): Promise<{ records: string[]; failed?: string }> {
  ctx.queries++;
  const txt = await lookupTxt(ctx.resolver, domain);
  return { records: txt.records.filter((r) => SPF_PREFIX.test(r.trim())), failed: txt.failed };
}

/** Walks include/redirect chains counting DNS-lookup mechanisms; returns the effective `all` qualifier of a record. */
async function walkSpf(
  ctx: SpfContext,
  domain: string,
  record: string,
  depth: number,
): Promise<Qualifier | "redirect" | "none"> {
  const { terms, redirect, unknown } = parseSpfTerms(record);
  for (const u of unknown) {
    ctx.findings.push({
      severity: "warn",
      code: "spf-unknown-term",
      message: `SPF record for ${domain} contains an unrecognized term "${clip(u, 60)}"; receivers treat this as a permanent error.`,
      fix: "Remove or correct the term.",
    });
  }
  let allQualifier: Qualifier | "redirect" | "none" = "none";
  for (const t of terms) {
    if (t.mechanism === "all") {
      if (allQualifier === "none") allQualifier = t.qualifier;
      continue;
    }
    if (t.mechanism === "ptr") {
      ctx.findings.push({
        severity: "warn",
        code: "spf-ptr",
        message: `SPF for ${domain} uses the deprecated "ptr" mechanism (slow, unreliable, and counts toward the lookup limit).`,
        fix: "Replace ptr with explicit ip4/ip6/include entries.",
      });
    }
    if (["include", "a", "mx", "ptr", "exists"].includes(t.mechanism)) ctx.lookups++;
    if (t.mechanism === "include" && t.value) {
      const target = t.value.toLowerCase().replace(/\.$/, "");
      if (ctx.visited.has(target)) {
        ctx.findings.push({
          severity: "fail",
          code: "spf-include-loop",
          message: `SPF include of ${target} forms a loop; receivers treat this as a permanent error.`,
          fix: "Remove the circular include.",
        });
        continue;
      }
      if (ctx.lookups > SPF_LOOKUP_LIMIT || ctx.queries >= MAX_SPF_QUERIES || depth >= SPF_LOOKUP_LIMIT) {
        ctx.budgetExhausted = true;
        continue;
      }
      ctx.visited.add(target);
      const found = await fetchSpfRecords(ctx, target);
      if (found.failed) {
        ctx.findings.push(lookupFailedFinding(target, found.failed));
      } else if (found.records.length === 0) {
        ctx.findings.push({
          severity: "fail",
          code: "spf-include-missing",
          message: `include:${target} has no SPF record; receivers treat this as a permanent error and SPF fails for the whole domain.`,
          fix: `Remove include:${target} or fix the provider's domain name.`,
        });
      } else if (found.records[0] !== undefined) {
        await walkSpf(ctx, target, found.records[0], depth + 1);
      }
    }
  }
  if (allQualifier === "none" && redirect) {
    ctx.lookups++;
    const target = redirect.toLowerCase().replace(/\.$/, "");
    if (ctx.visited.has(target) || ctx.lookups > SPF_LOOKUP_LIMIT || ctx.queries >= MAX_SPF_QUERIES || depth >= SPF_LOOKUP_LIMIT) {
      ctx.budgetExhausted = true;
      return "redirect";
    }
    ctx.visited.add(target);
    const found = await fetchSpfRecords(ctx, target);
    if (found.failed) {
      ctx.findings.push(lookupFailedFinding(target, found.failed));
    } else if (found.records.length === 0) {
      ctx.findings.push({
        severity: "fail",
        code: "spf-redirect-missing",
        message: `redirect=${target} has no SPF record; receivers treat this as a permanent error.`,
        fix: `Fix or remove the redirect modifier.`,
      });
    } else if (found.records[0] !== undefined) {
      const inner = await walkSpf(ctx, target, found.records[0], depth + 1);
      return inner === "none" ? "redirect" : inner;
    }
    return "redirect";
  }
  return allQualifier;
}

export async function analyzeSpf(resolver: DnsResolver, domain: string): Promise<SpfResult> {
  const ctx: SpfContext = { resolver, lookups: 0, queries: 1, findings: [], visited: new Set([domain]), budgetExhausted: false };
  const txt = await lookupTxt(resolver, domain);
  if (txt.failed) return { status: "unknown", findings: [lookupFailedFinding(domain, txt.failed)] };
  const records = txt.records.filter((r) => SPF_PREFIX.test(r.trim()));
  if (records.length === 0) {
    return {
      status: "fail",
      findings: [
        {
          severity: "fail",
          code: "spf-missing",
          message: `No SPF record (TXT starting with "v=spf1") found at ${domain}.`,
          fix: `Publish one TXT record at ${domain} listing every service that sends mail for you, ending in -all (or ~all while testing), e.g. "v=spf1 include:<your-sender>.example ~all". Replace the include with the exact value your sending provider documents.`,
        },
      ],
    };
  }
  if (records.length > 1) {
    return {
      status: "fail",
      record: records.join(" || "),
      findings: [
        {
          severity: "fail",
          code: "spf-multiple",
          message: `${records.length} SPF records found at ${domain}; a domain must publish exactly one, and receivers treat several as a permanent error.`,
          fix: "Merge all mechanisms into a single v=spf1 record and delete the others.",
        },
      ],
    };
  }
  const record = records[0] as string;
  const all = await walkSpf(ctx, domain, record, 0);
  const findings = ctx.findings;
  if (ctx.budgetExhausted || ctx.lookups > SPF_LOOKUP_LIMIT) {
    findings.push({
      severity: "fail",
      code: "spf-lookup-limit",
      message: `SPF needs more than ${SPF_LOOKUP_LIMIT} DNS lookups (counted at least ${ctx.lookups}); receivers return a permanent error and SPF stops authenticating.`,
      fix: "Remove unused includes, replace a/mx/include entries with ip4/ip6 ranges, or move some senders to a subdomain with its own SPF record.",
    });
  } else if (ctx.lookups >= 8) {
    findings.push({
      severity: "info",
      code: "spf-lookup-near-limit",
      message: `SPF uses ${ctx.lookups} of ${SPF_LOOKUP_LIMIT} allowed DNS lookups; adding another include may break it.`,
    });
  }
  switch (all) {
    case "+":
      findings.push({
        severity: "fail",
        code: "spf-all-plus",
        message: `SPF ends in +all (or a bare "all"), which authorizes every server on the internet to send as ${domain}.`,
        fix: "Replace with -all (or ~all while testing).",
      });
      break;
    case "?":
      findings.push({
        severity: "warn",
        code: "spf-all-neutral",
        message: "SPF ends in ?all (neutral): it makes no statement about unlisted senders.",
        fix: "Use ~all while testing, then -all.",
      });
      break;
    case "~":
      findings.push({
        severity: "info",
        code: "spf-all-softfail",
        message: "SPF ends in ~all (softfail): unlisted senders are marked suspicious but usually still delivered.",
        fix: "Move to -all once every legitimate sender is listed and DMARC reports are clean.",
      });
      break;
    case "-":
      break;
    case "redirect":
      break;
    default:
      findings.push({
        severity: "warn",
        code: "spf-all-missing",
        message: "SPF has no all mechanism and no redirect, so unlisted senders get the default neutral result.",
        fix: "End the record with -all (or ~all while testing).",
      });
  }
  return { status: worst(findings), record: clip(record, 600), allQualifier: all, dnsLookups: ctx.lookups, findings };
}

// ---------------------------------------------------------------------- DMARC

export interface DmarcResult {
  status: Status;
  record?: string;
  policy?: string;
  subdomainPolicy?: string;
  pct?: number;
  rua?: string[];
  findings: Finding[];
}

const DMARC_PREFIX = /^\s*v\s*=\s*DMARC1\s*(;|$)/i;
const POLICY_RANK: Record<string, number> = { none: 0, quarantine: 1, reject: 2 };

function parseTags(record: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const part of record.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (key && !tags.has(key)) tags.set(key, value);
  }
  return tags;
}

export async function analyzeDmarc(resolver: DnsResolver, domain: string): Promise<DmarcResult> {
  const name = `_dmarc.${domain}`;
  const txt = await lookupTxt(resolver, name);
  if (txt.failed) return { status: "unknown", findings: [lookupFailedFinding(name, txt.failed)] };
  const records = txt.records.filter((r) => DMARC_PREFIX.test(r));
  if (records.length === 0) {
    return {
      status: "fail",
      findings: [
        {
          severity: "fail",
          code: "dmarc-missing",
          message: `No DMARC record found at ${name}. Without it receivers have no policy for mail that fails SPF/DKIM alignment, and major mailbox providers expect one from bulk senders.`,
          fix: `Publish a TXT record at ${name} with value "v=DMARC1; p=none; rua=mailto:dmarc-reports@${domain}" as a monitoring start (use a mailbox you control), then tighten p to quarantine and reject once reports show only legitimate senders.`,
        },
      ],
    };
  }
  if (records.length > 1) {
    return {
      status: "fail",
      record: records.join(" || "),
      findings: [
        {
          severity: "fail",
          code: "dmarc-multiple",
          message: `${records.length} DMARC records found at ${name}; receivers ignore DMARC when there is more than one.`,
          fix: "Keep exactly one v=DMARC1 record.",
        },
      ],
    };
  }
  const record = records[0] as string;
  const tags = parseTags(record);
  const findings: Finding[] = [];
  const policy = tags.get("p")?.toLowerCase();
  const sp = tags.get("sp")?.toLowerCase();
  const rua = tags.get("rua")?.split(",").map((s) => s.trim()).filter(Boolean);
  let pct: number | undefined;

  if (policy === undefined || policy === "") {
    findings.push({
      severity: "fail",
      code: "dmarc-no-policy",
      message: "DMARC record has no p= tag; the record is invalid.",
      fix: "Add p=none, p=quarantine or p=reject.",
    });
  } else if (!(policy in POLICY_RANK)) {
    findings.push({
      severity: "fail",
      code: "dmarc-bad-policy",
      message: `DMARC p=${clip(policy, 30)} is not valid (expected none, quarantine or reject).`,
      fix: "Use one of none, quarantine, reject.",
    });
  } else if (policy === "none") {
    findings.push({
      severity: "warn",
      code: "dmarc-monitor-only",
      message: "DMARC p=none is monitoring only: spoofed mail is still delivered.",
      fix: "After reviewing aggregate reports, move to p=quarantine and then p=reject.",
    });
  } else if (policy === "quarantine") {
    findings.push({
      severity: "info",
      code: "dmarc-quarantine",
      message: "DMARC p=quarantine sends failing mail to spam; p=reject is the strongest setting.",
    });
  }

  const pctRaw = tags.get("pct");
  if (pctRaw !== undefined) {
    const n = Number(pctRaw);
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      findings.push({ severity: "warn", code: "dmarc-bad-pct", message: `DMARC pct=${clip(pctRaw, 20)} is not an integer from 0 to 100.`, fix: "Use pct=100 or remove the tag." });
    } else {
      pct = n;
      if (n < 100 && policy && policy !== "none") {
        findings.push({
          severity: "warn",
          code: "dmarc-partial-pct",
          message: `DMARC pct=${n}: the ${policy} policy applies to only ${n}% of failing mail.`,
          fix: "Raise pct to 100 once reports are clean.",
        });
      }
    }
  }
  if (!rua || rua.length === 0) {
    findings.push({
      severity: "warn",
      code: "dmarc-no-rua",
      message: "DMARC has no rua= tag, so you receive no aggregate reports and cannot see who sends as your domain.",
      fix: `Add rua=mailto:dmarc-reports@${domain} (a mailbox or report-processing address you control).`,
    });
  } else if (rua.some((u) => !/^mailto:[^\s@]+@[^\s@]+/i.test(u))) {
    findings.push({
      severity: "warn",
      code: "dmarc-bad-rua",
      message: "DMARC rua= contains an entry that is not a mailto: address.",
      fix: "Use rua=mailto:address@domain.",
    });
  }
  if (sp !== undefined && policy !== undefined && sp in POLICY_RANK && policy in POLICY_RANK) {
    if ((POLICY_RANK[sp] ?? 0) < (POLICY_RANK[policy] ?? 0)) {
      findings.push({
        severity: "warn",
        code: "dmarc-weak-subdomain-policy",
        message: `Subdomain policy sp=${sp} is weaker than p=${policy}, so attackers can spoof subdomains.`,
        fix: "Remove sp or set it at least as strict as p.",
      });
    }
  } else if (sp !== undefined && !(sp in POLICY_RANK)) {
    findings.push({ severity: "warn", code: "dmarc-bad-sp", message: `DMARC sp=${clip(sp, 30)} is not valid.`, fix: "Use none, quarantine or reject." });
  }

  return {
    status: worst(findings),
    record: clip(record, 600),
    policy,
    subdomainPolicy: sp,
    pct,
    rua,
    findings,
  };
}

// ----------------------------------------------------------------------- DKIM

export interface DkimSelectorResult {
  selector: string;
  name: string;
  state: "ok" | "revoked" | "missing" | "invalid" | "lookup_failed";
  keyType?: string;
  keyBits?: number;
  testing?: boolean;
  findings: Finding[];
}

export interface DkimResult {
  status: Status;
  mode: "selectors-given" | "probed-common-selectors";
  selectors: DkimSelectorResult[];
  findings: Finding[];
}

function inspectKey(keyType: string, b64: string): { bits?: number; error?: string } {
  const der = Buffer.from(b64.replace(/\s+/g, ""), "base64");
  if (der.length === 0) return { error: "p= is not valid base64" };
  if (keyType === "ed25519") {
    return der.length === 32 ? { bits: 256 } : { error: `ed25519 key must be 32 bytes, found ${der.length}` };
  }
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "rsa") return { error: `key is ${key.asymmetricKeyType}, not rsa` };
    return { bits: key.asymmetricKeyDetails?.modulusLength };
  } catch {
    return { error: "p= is not a complete RSA public key (it may be truncated or split incorrectly)" };
  }
}

async function checkSelector(resolver: DnsResolver, domain: string, selector: string): Promise<DkimSelectorResult> {
  const name = `${selector}._domainkey.${domain}`;
  const base = { selector, name };
  const txt = await lookupTxt(resolver, name);
  if (txt.failed) {
    return { ...base, state: "lookup_failed", findings: [lookupFailedFinding(name, txt.failed)] };
  }
  const candidates = txt.records.filter((r) => /(^|;)\s*p\s*=/i.test(r));
  if (candidates.length === 0) {
    return {
      ...base,
      state: "missing",
      findings: [
        {
          severity: "fail",
          code: "dkim-missing",
          message: `No DKIM key published at ${name}.`,
          fix: `Publish the TXT (or CNAME) record your sending provider gives you at ${name}.`,
        },
      ],
    };
  }
  const tags = parseTags(candidates[0] as string);
  const findings: Finding[] = [];
  const keyType = (tags.get("k") ?? "rsa").toLowerCase();
  const version = tags.get("v");
  if (version !== undefined && version.toUpperCase() !== "DKIM1") {
    findings.push({ severity: "warn", code: "dkim-bad-version", message: `${name} has v=${clip(version, 20)}; expected DKIM1.`, fix: "Use v=DKIM1 or omit the tag." });
  }
  const testing = (tags.get("t") ?? "").split(":").map((s) => s.trim().toLowerCase()).includes("y");
  if (testing) {
    findings.push({ severity: "warn", code: "dkim-testing", message: `${name} is in testing mode (t=y); receivers may ignore failures.`, fix: "Remove t=y when you are done testing." });
  }
  const p = tags.get("p") ?? "";
  if (p.trim() === "") {
    findings.push({
      severity: "fail",
      code: "dkim-revoked",
      message: `${name} has an empty p= tag: this key has been revoked and signatures using it fail.`,
      fix: "Publish a new key under a fresh selector and sign with that selector.",
    });
    return { ...base, state: "revoked", keyType, testing, findings };
  }
  const inspected = inspectKey(keyType, p);
  if (inspected.error) {
    findings.push({ severity: "fail", code: "dkim-invalid-key", message: `${name}: ${inspected.error}.`, fix: "Re-copy the full public key from your sending provider; long keys must be split into 255-character strings inside one TXT record." });
    return { ...base, state: "invalid", keyType, testing, findings };
  }
  const bits = inspected.bits;
  if (keyType !== "ed25519" && bits !== undefined) {
    if (bits < 1024) {
      findings.push({ severity: "fail", code: "dkim-weak-key", message: `${name} uses a ${bits}-bit RSA key, which is considered breakable.`, fix: "Rotate to a 2048-bit key." });
    } else if (bits < 2048) {
      findings.push({ severity: "warn", code: "dkim-short-key", message: `${name} uses a ${bits}-bit RSA key; 2048 bits is the current recommendation.`, fix: "Rotate to a 2048-bit key under a new selector." });
    }
  }
  return { ...base, state: "ok", keyType, keyBits: bits, testing, findings };
}

export async function analyzeDkim(resolver: DnsResolver, domain: string, selectors?: string[]): Promise<DkimResult> {
  const given = selectors !== undefined && selectors.length > 0;
  const toCheck = given ? selectors : COMMON_DKIM_SELECTORS;
  const results = await Promise.all(toCheck.map((s) => checkSelector(resolver, domain, s)));
  if (given) {
    const findings = results.flatMap((r) => r.findings);
    return { status: worst(findings), mode: "selectors-given", selectors: results, findings };
  }
  // A revoked (empty p=) key at a guessed selector is normal: domains that send no mail, and wildcard
  // "no DKIM" declarations, publish it. It is reported once, as info, and never turned into a failure when probing.
  const found = results.filter((r) => r.state !== "missing");
  const revoked = found.filter((r) => r.state === "revoked");
  const findings = found.filter((r) => r.state !== "revoked").flatMap((r) => r.findings);
  if (revoked.length > 0) {
    findings.push({
      severity: "info",
      code: "dkim-revoked",
      message: `Probed selector(s) ${revoked.map((r) => r.selector).join(", ")} publish an empty p= (revoked key). That is expected when the domain sends no mail or after a key rotation.`,
    });
  }
  if (!found.some((r) => r.state !== "revoked")) {
    findings.push({
      severity: "warn",
      code: "dkim-none-found",
      message: `None of the common selectors (${COMMON_DKIM_SELECTORS.join(", ")}) published a usable key. This does not prove DKIM is missing: selectors are provider-specific.`,
      fix: "Send a test message, read the s= value in its DKIM-Signature header, and re-run with dkimSelectors set to that value.",
    });
  }
  return {
    status: worst(findings),
    mode: "probed-common-selectors",
    selectors: found.map((r) => (r.state === "revoked" ? { ...r, findings: [] } : r)),
    findings,
  };
}

// ------------------------------------------------------------------------- MX

export interface MxResult {
  status: Status;
  hosts: MxRecord[];
  findings: Finding[];
}

export async function analyzeMx(resolver: DnsResolver, domain: string): Promise<MxResult> {
  let records: MxRecord[];
  try {
    records = await resolver.resolveMx(domain);
  } catch (err) {
    const code = errCode(err);
    if (!NO_DATA.has(code)) return { status: "unknown", hosts: [], findings: [lookupFailedFinding(domain, code)] };
    records = [];
  }
  const hosts = [...records].sort((a, b) => a.priority - b.priority);
  if (hosts.length === 0) {
    return {
      status: "warn",
      hosts,
      findings: [
        {
          severity: "warn",
          code: "mx-missing",
          message: `No MX records at ${domain}: the domain cannot receive mail (bounces and replies to your From address are lost).`,
          fix: "Add MX records for your mailbox provider, or publish a null MX (priority 0, host \".\") if this domain should never receive mail.",
        },
      ],
    };
  }
  if (hosts.length === 1 && (hosts[0]?.exchange === "" || hosts[0]?.exchange === ".")) {
    return { status: "pass", hosts, findings: [{ severity: "info", code: "mx-null", message: `${domain} publishes a null MX: it declares that it accepts no mail.` }] };
  }
  return { status: "pass", hosts, findings: [] };
}

// -------------------------------------------------------------------- Roll-up

export interface EmailAuthReport {
  domain: string;
  status: Status;
  spf: SpfResult;
  dmarc: DmarcResult;
  dkim: DkimResult;
  mx: MxResult;
  findings: (Finding & { check: "spf" | "dmarc" | "dkim" | "mx" })[];
  notes: string[];
}

export async function runEmailAuthCheck(
  resolver: DnsResolver,
  input: { domain: string; dkimSelectors?: string[] | undefined },
): Promise<EmailAuthReport> {
  const [spf, dmarc, dkim, mx] = await Promise.all([
    analyzeSpf(resolver, input.domain),
    analyzeDmarc(resolver, input.domain),
    analyzeDkim(resolver, input.domain, input.dkimSelectors),
    analyzeMx(resolver, input.domain),
  ]);
  const tag = <T extends string>(check: T, fs: Finding[]) => fs.map((f) => ({ ...f, check }));
  const findings = [
    ...tag("spf" as const, spf.findings),
    ...tag("dmarc" as const, dmarc.findings),
    ...tag("dkim" as const, dkim.findings),
    ...tag("mx" as const, mx.findings),
  ].filter((f) => f.severity !== "pass");
  const statuses = [spf.status, dmarc.status, dkim.status, mx.status];
  const status: Status = statuses.includes("fail")
    ? "fail"
    : statuses.includes("warn")
      ? "warn"
      : statuses.includes("unknown")
        ? "unknown"
        : "pass";
  return {
    domain: input.domain,
    status,
    spf,
    dmarc,
    dkim,
    mx,
    findings,
    notes: [
      "Checks read public DNS from this machine's resolver; recent changes may not have propagated.",
      "DMARC is checked at _dmarc.<domain> only; a subdomain may inherit its organizational domain's policy, which is not looked up here.",
      "This verifies published records, not whether your sending service actually signs and aligns its mail. Confirm with a real test message.",
    ],
  };
}

export function shapeEmailAuth(report: EmailAuthReport): Shaped {
  const dkimFound = report.dkim.selectors.filter((s) => s.state === "ok").length;
  const part = (label: string, status: Status) => `${label} ${status}`;
  return {
    summary: `Email auth for ${report.domain}: ${report.status.toUpperCase()} - ${part("SPF", report.spf.status)}, ${part("DMARC", report.dmarc.status)}, ${part("DKIM", report.dkim.status)} (${dkimFound} valid key${dkimFound === 1 ? "" : "s"}), ${part("MX", report.mx.status)} (${report.mx.hosts.length} host${report.mx.hosts.length === 1 ? "" : "s"}).`,
    data: report as unknown as Record<string, unknown>,
  };
}
