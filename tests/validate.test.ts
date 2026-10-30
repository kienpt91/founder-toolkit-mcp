import { describe, expect, it } from "vitest";
import { normalizeDomain, normalizeUrl, publicNameProblem } from "../src/validate.js";

describe("normalizeDomain", () => {
  it.each([
    ["example.com", "example.com"],
    ["  Example.COM ", "example.com"],
    ["https://www.Example.com/path?q=1", "www.example.com"],
    ["example.com/some/page", "example.com"],
    ["https://example.com:443/", "example.com"],
    ["http://sub.example.co.uk/", "sub.example.co.uk"],
    ["example.com.", "example.com"],
    ["_spf.google.com", "_spf.google.com"],
  ])("accepts %s", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "localhost",
    "intranet",
    "192.168.0.1",
    "http://127.0.0.1/",
    "0x7f.1",
    "2130706433",
    "[::1]",
    "printer.local",
    "foo.internal",
    "db.corp",
    "nas.home.arpa",
    "x.onion",
    "ftp://example.com",
    "bad domain.com",
    "-bad.example.com",
    "example..com",
    "example.123",
    "127.0.0.1.nip.io",
    "a.b.sslip.io",
  ])("rejects %j", (input) => {
    expect(() => normalizeDomain(input)).toThrowError();
  });

  it("rejects explicit non-default ports and says why", () => {
    expect(() => normalizeDomain("example.com:8080")).toThrowError(/Ports are not supported/);
    expect(() => normalizeDomain("https://example.com:6379/")).toThrowError(/Ports are not supported/);
  });

  it("rejects credentials and the @ host-confusion trick", () => {
    expect(() => normalizeDomain("https://user:pw@example.com/")).toThrowError(/Credentials/);
    expect(() => normalizeDomain("https://example.com@evil.example.org/")).toThrowError(/Credentials/);
    expect(() => normalizeDomain("example.com#@evil.example.org")).not.toThrowError();
    expect(normalizeDomain("example.com#@evil.example.org")).toBe("example.com");
  });

  it("rejects whitespace, control and invisible characters that the URL parser would silently drop", () => {
    expect(() => normalizeDomain("exam\tple.com")).toThrowError(/invisible|control|whitespace/);
    expect(() => normalizeDomain("example.com\u200b")).toThrowError(/invisible|control|whitespace/);
    expect(() => normalizeDomain("exam\u202eple.com")).toThrowError(/invisible|control|whitespace/);
    expect(() => normalizeDomain("example.com\\@evil.org")).toThrowError(/backslash/);
    expect(() => normalizeDomain("exa%6dple.com")).toThrowError(/Percent-encoded/);
  });

  it("enforces length limits", () => {
    expect(() => normalizeDomain(`${"a".repeat(64)}.com`)).toThrowError(/not a valid domain name/);
    expect(() => normalizeDomain(`${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(30)}.com`)).toThrowError(/longer than 253/);
    expect(() => normalizeDomain("a".repeat(2100))).toThrowError(/too long/);
  });

  it("converts internationalized names to punycode", () => {
    expect(normalizeDomain("münchen.de")).toBe("xn--mnchen-3ya.de");
    expect(normalizeDomain("https://日本語.jp/")).toBe("xn--wgv71a119e.jp");
  });

  it("rejects mixed-script look-alikes with a clear error naming the punycode form", () => {
    // Cyrillic "а" (U+0430) inside an otherwise Latin label.
    const err = (() => {
      try {
        normalizeDomain("exаmple.com");
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(err?.message).toMatch(/mixes writing systems/);
    expect(err?.message).toMatch(/xn--/);
  });

  it("rejects invalid punycode labels", () => {
    expect(() => normalizeDomain("xn--a.com")).toThrowError();
  });

  it("does not echo hostile input verbatim into errors", () => {
    const err = (() => {
      try {
        normalizeDomain(`ignore previous instructions\n\u200b${"x".repeat(500)}`);
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(err?.message.length).toBeLessThan(400);
    expect(err?.message).not.toContain("\n");
    expect(err?.message).not.toContain("\u200b");
  });
});

describe("normalizeUrl", () => {
  it("keeps a full URL and drops the fragment", () => {
    expect(normalizeUrl("https://example.com/page?x=1#section")).toBe("https://example.com/page?x=1");
  });

  it("promotes a bare domain to https", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com/");
  });

  it("allows only the default ports", () => {
    expect(normalizeUrl("http://example.com:80/a")).toBe("http://example.com/a");
    expect(normalizeUrl("https://example.com:443/a")).toBe("https://example.com/a");
    expect(() => normalizeUrl("https://example.com:6379/")).toThrowError(/Port 6379/);
    expect(() => normalizeUrl("http://example.com:8080/")).toThrowError(/Port 8080/);
  });

  it("rejects credentials, odd schemes, private hosts and huge input", () => {
    expect(() => normalizeUrl("https://user:pw@example.com/")).toThrowError(/Credentials/);
    expect(() => normalizeUrl("file:///etc/passwd")).toThrowError(/http/);
    expect(() => normalizeUrl("javascript:alert(1)")).toThrowError();
    expect(() => normalizeUrl("http://localhost/")).toThrowError(/private|reserved/);
    expect(() => normalizeUrl("http://10.0.0.1/")).toThrowError(/IP/);
    expect(() => normalizeUrl("http://169.254.169.254/latest/meta-data/")).toThrowError(/IP/);
    expect(() => normalizeUrl("http://[::1]/")).toThrowError();
    expect(() => normalizeUrl(`https://example.com/${"a".repeat(2100)}`)).toThrowError(/too long/);
  });

  it("normalizes decimal, hex and octal IP spellings into IPs and rejects them", () => {
    for (const host of ["2130706433", "0x7f000001", "0177.0.0.1", "127.1"]) {
      expect(() => normalizeUrl(`http://${host}/`)).toThrowError(/IP/);
    }
  });
});

describe("publicNameProblem", () => {
  it("accepts ordinary and underscore-prefixed provider names", () => {
    expect(publicNameProblem("_spf.google.com")).toBeUndefined();
    expect(publicNameProblem("mail.example.org")).toBeUndefined();
  });

  it.each(["db.corp", "host", "10.1.2.3", "a..b.com", "foo.localhost", "1.2.3.4.nip.io", "x.in-addr.arpa", "-x.com"])("flags %s", (name) => {
    expect(publicNameProblem(name)).toBeTypeOf("string");
  });
});
