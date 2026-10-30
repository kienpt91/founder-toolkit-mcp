import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  analyzeDkim,
  analyzeDmarc,
  analyzeMx,
  analyzeSpf,
  emailAuthSchema,
  runEmailAuthCheck,
  shapeEmailAuth,
  SPF_LOOKUP_LIMIT,
} from "../src/emailauth.js";
import { dnsError, fakeResolver } from "./helpers.js";

function rsaKeyB64(bits: number): string {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);

describe("SPF", () => {
  it("passes a clean -all record and counts include lookups", async () => {
    const { resolver } = fakeResolver({
      "example.com": ["v=spf1 ip4:203.0.113.0/24 include:_spf.sender.test -all"],
      "_spf.sender.test": ["v=spf1 ip4:198.51.100.0/24 -all"],
    });
    const r = await analyzeSpf(resolver, "example.com");
    expect(r.status).toBe("pass");
    expect(r.allQualifier).toBe("-");
    expect(r.dnsLookups).toBe(1);
    expect(r.findings).toEqual([]);
  });

  it("reports a missing record with a fix", async () => {
    const { resolver } = fakeResolver({ "example.com": ["google-site-verification=abc"] });
    const r = await analyzeSpf(resolver, "example.com");
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["spf-missing"]);
    expect(r.findings[0]?.fix).toContain("-all");
  });

  it("fails on multiple SPF records", async () => {
    const { resolver } = fakeResolver({ "example.com": ["v=spf1 -all", "v=spf1 include:x.test -all"] });
    const r = await analyzeSpf(resolver, "example.com");
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["spf-multiple"]);
  });

  it("joins TXT strings that were split into chunks", async () => {
    const { resolver } = fakeResolver({ "example.com": [["v=spf1 ip4:203.0.", "113.5 -all"]] });
    const r = await analyzeSpf(resolver, "example.com");
    expect(r.record).toBe("v=spf1 ip4:203.0.113.5 -all");
    expect(r.status).toBe("pass");
  });

  it("flags +all and bare all as dangerous", async () => {
    for (const rec of ["v=spf1 +all", "v=spf1 all"]) {
      const { resolver } = fakeResolver({ "example.com": [rec] });
      const r = await analyzeSpf(resolver, "example.com");
      expect(r.status).toBe("fail");
      expect(codes(r)).toContain("spf-all-plus");
    }
  });

  it("treats ~all as info, ?all as a warning, and a missing all as a warning", async () => {
    const soft = await analyzeSpf(fakeResolver({ "example.com": ["v=spf1 ip4:1.2.3.4 ~all"] }).resolver, "example.com");
    expect(soft.status).toBe("pass");
    expect(codes(soft)).toEqual(["spf-all-softfail"]);
    const neutral = await analyzeSpf(fakeResolver({ "example.com": ["v=spf1 ip4:1.2.3.4 ?all"] }).resolver, "example.com");
    expect(neutral.status).toBe("warn");
    const none = await analyzeSpf(fakeResolver({ "example.com": ["v=spf1 ip4:1.2.3.4"] }).resolver, "example.com");
    expect(codes(none)).toEqual(["spf-all-missing"]);
  });

  it("fails when include lookups exceed 10", async () => {
    const includes = Array.from({ length: 11 }, (_, i) => `include:s${i}.test`);
    const txt: Record<string, string[]> = { "example.com": [`v=spf1 ${includes.join(" ")} -all`] };
    for (let i = 0; i < 11; i++) txt[`s${i}.test`] = ["v=spf1 ip4:192.0.2.1 -all"];
    const r = await analyzeSpf(fakeResolver(txt).resolver, "example.com");
    expect(r.status).toBe("fail");
    expect(codes(r)).toContain("spf-lookup-limit");
    expect(r.dnsLookups).toBeGreaterThan(SPF_LOOKUP_LIMIT);
  });

  it("counts nested includes toward the limit", async () => {
    const txt: Record<string, string[]> = {
      "example.com": ["v=spf1 include:a.test include:b.test -all"],
      "a.test": ["v=spf1 include:a1.test include:a2.test include:a3.test include:a4.test include:a5.test -all"],
      "b.test": ["v=spf1 include:b1.test include:b2.test include:b3.test include:b4.test include:b5.test -all"],
    };
    for (const n of ["a1", "a2", "a3", "a4", "a5", "b1", "b2", "b3", "b4", "b5"]) txt[`${n}.test`] = ["v=spf1 ip4:192.0.2.1 -all"];
    const r = await analyzeSpf(fakeResolver(txt).resolver, "example.com");
    expect(codes(r)).toContain("spf-lookup-limit");
  });

  it("accepts exactly 10 lookups but notes it is near the limit", async () => {
    const includes = Array.from({ length: 10 }, (_, i) => `include:s${i}.test`);
    const txt: Record<string, string[]> = { "example.com": [`v=spf1 ${includes.join(" ")} -all`] };
    for (let i = 0; i < 10; i++) txt[`s${i}.test`] = ["v=spf1 ip4:192.0.2.1 -all"];
    const r = await analyzeSpf(fakeResolver(txt).resolver, "example.com");
    expect(r.dnsLookups).toBe(10);
    expect(codes(r)).toEqual(["spf-lookup-near-limit"]);
    expect(r.status).toBe("pass");
  });

  it("fails an include that points at a domain with no SPF record", async () => {
    const { resolver } = fakeResolver({ "example.com": ["v=spf1 include:ghost.test -all"] });
    const r = await analyzeSpf(resolver, "example.com");
    expect(codes(r)).toContain("spf-include-missing");
    expect(r.status).toBe("fail");
  });

  it("detects include loops without recursing forever", async () => {
    const { resolver } = fakeResolver({
      "example.com": ["v=spf1 include:a.test -all"],
      "a.test": ["v=spf1 include:example.com -all"],
    });
    const r = await analyzeSpf(resolver, "example.com");
    expect(codes(r)).toContain("spf-include-loop");
  });

  it("follows redirect= and takes the effective all from the target", async () => {
    const { resolver } = fakeResolver({
      "example.com": ["v=spf1 redirect=_spf.sender.test"],
      "_spf.sender.test": ["v=spf1 ip4:192.0.2.1 -all"],
    });
    const r = await analyzeSpf(resolver, "example.com");
    expect(r.allQualifier).toBe("-");
    expect(r.dnsLookups).toBe(1);
    expect(r.status).toBe("pass");
  });

  it("warns about ptr and unknown terms", async () => {
    const { resolver } = fakeResolver({ "example.com": ["v=spf1 ptr bogus:thing -all"] });
    const r = await analyzeSpf(resolver, "example.com");
    expect(codes(r)).toEqual(expect.arrayContaining(["spf-ptr", "spf-unknown-term"]));
  });

  it("reports an unknown result (not 'missing') when DNS itself fails", async () => {
    const { resolver } = fakeResolver({ "example.com": dnsError("ESERVFAIL") });
    const r = await analyzeSpf(resolver, "example.com");
    expect(r.status).toBe("unknown");
    expect(codes(r)).toEqual(["dns-lookup-failed"]);
  });
});

describe("DMARC", () => {
  it("fails when missing and suggests a monitoring record at _dmarc", async () => {
    const { resolver, queries } = fakeResolver({});
    const r = await analyzeDmarc(resolver, "example.com");
    expect(queries).toEqual(["TXT _dmarc.example.com"]);
    expect(r.status).toBe("fail");
    expect(r.findings[0]?.fix).toContain("v=DMARC1; p=none; rua=mailto:dmarc-reports@example.com");
  });

  it("passes p=reject with rua", async () => {
    const { resolver } = fakeResolver({ "_dmarc.example.com": ["v=DMARC1; p=reject; rua=mailto:d@example.com; pct=100"] });
    const r = await analyzeDmarc(resolver, "example.com");
    expect(r.status).toBe("pass");
    expect(r).toMatchObject({ policy: "reject", pct: 100, rua: ["mailto:d@example.com"] });
  });

  it("warns on p=none and a missing rua", async () => {
    const { resolver } = fakeResolver({ "_dmarc.example.com": ["v=DMARC1; p=none"] });
    const r = await analyzeDmarc(resolver, "example.com");
    expect(r.status).toBe("warn");
    expect(codes(r)).toEqual(["dmarc-monitor-only", "dmarc-no-rua"]);
  });

  it("warns when pct < 100 with an enforcing policy and when sp is weaker than p", async () => {
    const { resolver } = fakeResolver({ "_dmarc.example.com": ["v=DMARC1; p=reject; sp=none; pct=25; rua=mailto:d@example.com"] });
    const r = await analyzeDmarc(resolver, "example.com");
    expect(codes(r)).toEqual(["dmarc-partial-pct", "dmarc-weak-subdomain-policy"]);
    expect(r.subdomainPolicy).toBe("none");
  });

  it("fails invalid or absent policies and rejects multiple records", async () => {
    const bad = await analyzeDmarc(fakeResolver({ "_dmarc.example.com": ["v=DMARC1; p=block; rua=mailto:d@example.com"] }).resolver, "example.com");
    expect(codes(bad)).toContain("dmarc-bad-policy");
    const nop = await analyzeDmarc(fakeResolver({ "_dmarc.example.com": ["v=DMARC1; rua=mailto:d@example.com"] }).resolver, "example.com");
    expect(codes(nop)).toContain("dmarc-no-policy");
    const multi = await analyzeDmarc(
      fakeResolver({ "_dmarc.example.com": ["v=DMARC1; p=none", "v=DMARC1; p=reject"] }).resolver,
      "example.com",
    );
    expect(codes(multi)).toEqual(["dmarc-multiple"]);
  });

  it("flags non-mailto rua values and tolerates whitespace/case in tags", async () => {
    const { resolver } = fakeResolver({ "_dmarc.example.com": ["v=DMARC1 ; P=Quarantine ; rua=https://example.com/r"] });
    const r = await analyzeDmarc(resolver, "example.com");
    expect(r.policy).toBe("quarantine");
    expect(codes(r)).toContain("dmarc-bad-rua");
  });

  it("ignores unrelated TXT records at _dmarc", async () => {
    const { resolver } = fakeResolver({ "_dmarc.example.com": ["some other text"] });
    const r = await analyzeDmarc(resolver, "example.com");
    expect(codes(r)).toEqual(["dmarc-missing"]);
  });
});

describe("DKIM", () => {
  it("reads a 2048-bit RSA key as healthy", async () => {
    const { resolver, queries } = fakeResolver({ "s1._domainkey.example.com": [`v=DKIM1; k=rsa; p=${rsaKeyB64(2048)}`] });
    const r = await analyzeDkim(resolver, "example.com", ["s1"]);
    expect(queries).toEqual(["TXT s1._domainkey.example.com"]);
    expect(r.status).toBe("pass");
    expect(r.selectors[0]).toMatchObject({ selector: "s1", state: "ok", keyType: "rsa", keyBits: 2048 });
  });

  it("warns on a 1024-bit key and fails on a 512-bit key", async () => {
    const short = await analyzeDkim(fakeResolver({ "a._domainkey.example.com": [`v=DKIM1; p=${rsaKeyB64(1024)}`] }).resolver, "example.com", ["a"]);
    expect(codes(short)).toEqual(["dkim-short-key"]);
    expect(short.status).toBe("warn");
    const weak = await analyzeDkim(fakeResolver({ "a._domainkey.example.com": [`v=DKIM1; p=${rsaKeyB64(512)}`] }).resolver, "example.com", ["a"]);
    expect(codes(weak)).toEqual(["dkim-weak-key"]);
    expect(weak.status).toBe("fail");
  });

  it("treats an empty p= as a revoked key", async () => {
    const { resolver } = fakeResolver({ "old._domainkey.example.com": ["v=DKIM1; k=rsa; p="] });
    const r = await analyzeDkim(resolver, "example.com", ["old"]);
    expect(r.selectors[0]?.state).toBe("revoked");
    expect(codes(r)).toEqual(["dkim-revoked"]);
  });

  it("fails a truncated key and notes testing mode", async () => {
    const full = rsaKeyB64(2048);
    const { resolver } = fakeResolver({ "x._domainkey.example.com": [`v=DKIM1; t=y; p=${full.slice(0, 80)}`] });
    const r = await analyzeDkim(resolver, "example.com", ["x"]);
    expect(r.selectors[0]?.state).toBe("invalid");
    expect(r.selectors[0]?.testing).toBe(true);
    expect(codes(r)).toEqual(expect.arrayContaining(["dkim-testing", "dkim-invalid-key"]));
  });

  it("joins chunked key strings and accepts an ed25519 key", async () => {
    const full = rsaKeyB64(2048);
    const half = Math.floor(full.length / 2);
    const chunked = fakeResolver({ "c._domainkey.example.com": [[`v=DKIM1; p=${full.slice(0, half)}`, full.slice(half)]] });
    expect((await analyzeDkim(chunked.resolver, "example.com", ["c"])).selectors[0]?.keyBits).toBe(2048);
    const { publicKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
    const ed = fakeResolver({ "e._domainkey.example.com": [`v=DKIM1; k=ed25519; p=${raw}`] });
    const r = await analyzeDkim(ed.resolver, "example.com", ["e"]);
    expect(r.selectors[0]).toMatchObject({ state: "ok", keyType: "ed25519", keyBits: 256 });
  });

  it("fails a requested selector that does not exist", async () => {
    const { resolver } = fakeResolver({});
    const r = await analyzeDkim(resolver, "example.com", ["nope"]);
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["dkim-missing"]);
  });

  it("probes common selectors when none are given and says absence is not proof", async () => {
    const { resolver, queries } = fakeResolver({});
    const r = await analyzeDkim(resolver, "example.com");
    expect(r.mode).toBe("probed-common-selectors");
    expect(queries).toContain("TXT google._domainkey.example.com");
    expect(queries).toContain("TXT selector1._domainkey.example.com");
    expect(r.status).toBe("warn");
    expect(r.findings[0]?.message).toContain("does not prove DKIM is missing");
  });

  it("does not fail a domain whose probed selectors are all revoked (wildcard no-DKIM declaration)", async () => {
    const wildcard = Object.fromEntries(
      ["default", "google", "selector1", "selector2", "k1", "s1", "s2", "mail", "dkim", "smtp"].map((s) => [`${s}._domainkey.example.com`, ["v=DKIM1; p="]]),
    );
    const r = await analyzeDkim(fakeResolver(wildcard).resolver, "example.com");
    expect(r.status).toBe("warn");
    expect(codes(r)).toContain("dkim-none-found");
    expect(r.findings.some((f) => f.severity === "fail")).toBe(false);
    expect(r.selectors.every((s) => s.state === "revoked")).toBe(true);
  });

  it("reports only the probed selectors that exist", async () => {
    const { resolver } = fakeResolver({ "google._domainkey.example.com": [`v=DKIM1; k=rsa; p=${rsaKeyB64(2048)}`] });
    const r = await analyzeDkim(resolver, "example.com");
    expect(r.selectors.map((s) => s.selector)).toEqual(["google"]);
    expect(r.status).toBe("pass");
  });
});

describe("MX", () => {
  it("sorts hosts by priority", async () => {
    const { resolver } = fakeResolver({}, { "example.com": [{ exchange: "b.mail.test", priority: 20 }, { exchange: "a.mail.test", priority: 10 }] });
    const r = await analyzeMx(resolver, "example.com");
    expect(r.hosts.map((h) => h.exchange)).toEqual(["a.mail.test", "b.mail.test"]);
    expect(r.status).toBe("pass");
  });

  it("warns when there is no MX and recognizes a null MX", async () => {
    const none = await analyzeMx(fakeResolver({}, {}).resolver, "example.com");
    expect(none.status).toBe("warn");
    expect(codes(none)).toEqual(["mx-missing"]);
    const nul = await analyzeMx(fakeResolver({}, { "example.com": [{ exchange: "", priority: 0 }] }).resolver, "example.com");
    expect(codes(nul)).toEqual(["mx-null"]);
    expect(nul.status).toBe("pass");
  });

  it("reports unknown on resolver failure", async () => {
    const r = await analyzeMx(fakeResolver({}, { "example.com": dnsError("ETIMEOUT") }).resolver, "example.com");
    expect(r.status).toBe("unknown");
  });
});

describe("email_auth_check roll-up", () => {
  it("validates input and normalizes selectors", () => {
    expect(emailAuthSchema.parse({ domain: "https://Example.com/x", dkimSelectors: ["S1", "s1", "google"] })).toEqual({
      domain: "example.com",
      dkimSelectors: ["s1", "google"],
    });
    expect(emailAuthSchema.safeParse({ domain: "localhost" }).success).toBe(false);
    expect(emailAuthSchema.safeParse({ domain: "example.com", dkimSelectors: ["bad selector"] }).success).toBe(false);
    expect(emailAuthSchema.safeParse({ domain: "example.com", dkimSelectors: Array(11).fill("a") }).success).toBe(false);
  });

  it("combines all four checks into one report with a summary line", async () => {
    const { resolver } = fakeResolver(
      {
        "example.com": ["v=spf1 include:_spf.sender.test -all"],
        "_spf.sender.test": ["v=spf1 ip4:192.0.2.0/24 -all"],
        "_dmarc.example.com": ["v=DMARC1; p=none"],
        "s1._domainkey.example.com": [`v=DKIM1; p=${rsaKeyB64(2048)}`],
      },
      { "example.com": [{ exchange: "mx.mail.test", priority: 10 }] },
    );
    const report = await runEmailAuthCheck(resolver, { domain: "example.com", dkimSelectors: ["s1"] });
    expect(report.status).toBe("warn");
    expect(report.spf.status).toBe("pass");
    expect(report.dmarc.status).toBe("warn");
    expect(report.findings.map((f) => `${f.check}:${f.code}`)).toEqual(["dmarc:dmarc-monitor-only", "dmarc:dmarc-no-rua"]);
    const shaped = shapeEmailAuth(report);
    expect(shaped.summary).toBe(
      "Email auth for example.com: WARN - SPF pass, DMARC warn, DKIM pass (1 valid key), MX pass (1 host).",
    );
    expect(report.notes.join(" ")).toContain("subdomain");
  });

  it("is FAIL overall when SPF and DMARC are missing", async () => {
    const report = await runEmailAuthCheck(fakeResolver({}).resolver, { domain: "example.com", dkimSelectors: ["s1"] });
    expect(report.status).toBe("fail");
    expect(report.findings.some((f) => f.check === "spf" && f.code === "spf-missing")).toBe(true);
  });
});
