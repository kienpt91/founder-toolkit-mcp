import { describe, expect, it } from "vitest";
import { normalizeDomain, normalizeUrl } from "../src/validate.js";

describe("normalizeDomain", () => {
  it.each([
    ["example.com", "example.com"],
    ["  Example.COM ", "example.com"],
    ["https://www.Example.com/path?q=1", "www.example.com"],
    ["example.com/some/page", "example.com"],
    ["http://sub.example.co.uk:8080/", "sub.example.co.uk"],
    ["example.com.", "example.com"],
  ])("accepts %s", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each(["", "   ", "localhost", "intranet", "192.168.0.1", "http://127.0.0.1/", "[::1]", "printer.local", "foo.internal", "ftp://example.com", "bad domain.com", "-bad.example.com"])(
    "rejects %j",
    (input) => {
      expect(() => normalizeDomain(input)).toThrowError();
    },
  );
});

describe("normalizeUrl", () => {
  it("keeps a full URL", () => {
    expect(normalizeUrl("https://example.com/page?x=1")).toBe("https://example.com/page?x=1");
  });

  it("promotes a bare domain to https", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com/");
  });

  it("rejects credentials, odd schemes, private hosts and huge input", () => {
    expect(() => normalizeUrl("https://user:pw@example.com/")).toThrowError(/credentials/);
    expect(() => normalizeUrl("file:///etc/passwd")).toThrowError(/http/);
    expect(() => normalizeUrl("http://localhost:3000/")).toThrowError(/private|reserved|public/);
    expect(() => normalizeUrl("http://10.0.0.1/")).toThrowError(/IP/);
    expect(() => normalizeUrl(`https://example.com/${"a".repeat(2100)}`)).toThrowError(/too long/);
  });
});
