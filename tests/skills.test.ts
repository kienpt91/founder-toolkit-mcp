import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { emailAuthSchema } from "../src/emailauth.js";
import { SEO_SLUGS, seoCheckSchema } from "../src/seobolt.js";
import { searchShape, startupShape } from "../src/showmrr.js";
import { createServer } from "../src/server.js";
import { fakeResolver } from "./helpers.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(root, "skills");
const EXPECTED = ["ai-search-readiness", "email-deliverability-check", "launch-seo-check", "verify-revenue-claim"];

const skillNames = readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

function load(name: string): { path: string; raw: string; frontmatter: Record<string, string>; body: string } {
  const path = join(skillsDir, name, "SKILL.md");
  const raw = readFileSync(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`${name}: missing frontmatter`);
  const frontmatter: Record<string, string> = {};
  for (const line of (match[1] as string).split("\n")) {
    const m = /^([a-z-]+):\s*(.+)$/.exec(line);
    if (!m) throw new Error(`${name}: unparsable frontmatter line "${line}"`);
    frontmatter[m[1] as string] = (m[2] as string).trim();
  }
  return { path, raw, frontmatter, body: match[2] as string };
}

let toolNames: string[] = [];

beforeAll(async () => {
  const server = createServer({ resolver: fakeResolver({}).resolver });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "skills-test", version: "0.0.0" });
  await client.connect(a);
  toolNames = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
});

describe("skills", () => {
  it("ships exactly the four documented skills", () => {
    expect(skillNames).toEqual(EXPECTED);
  });

  it.each(EXPECTED)("%s has valid frontmatter", (name) => {
    const { frontmatter } = load(name);
    expect(Object.keys(frontmatter).sort()).toEqual(["description", "name"]);
    expect(frontmatter.name).toBe(name);
    expect(frontmatter.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect((frontmatter.description ?? "").length).toBeGreaterThan(60);
    expect((frontmatter.description ?? "").length).toBeLessThanOrEqual(400);
    expect(frontmatter.description).toMatch(/\bUse when\b/);
  });

  it.each(EXPECTED)("%s references only tools the server exposes, and at least one", (name) => {
    const { body } = load(name);
    const mentioned = new Set(body.match(/\b(?:seo|mrr|email)_[a-z_]+\b/g) ?? []);
    expect(mentioned.size).toBeGreaterThan(0);
    for (const tool of mentioned) expect(toolNames, `${name} mentions unknown tool ${tool}`).toContain(tool);
  });

  it.each(EXPECTED)("%s has no dead relative links", (name) => {
    const { path, body } = load(name);
    const links = [...body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1] as string);
    for (const link of links) {
      if (/^(https?:|mailto:|#)/.test(link)) continue;
      const target = resolve(dirname(path), link.split("#")[0] as string);
      expect(existsSync(target), `${name}: dead link ${link}`).toBe(true);
    }
  });

  it.each(EXPECTED)("%s states its limits and a deliverable", (name) => {
    const { body } = load(name);
    expect(body).toMatch(/^## Limits$/m);
    expect(body).toMatch(/^## Deliverable$/m);
    expect(body).toMatch(/^## Steps$/m);
  });

  it("uses only valid checker slugs in its example calls", () => {
    const used = new Set<string>();
    for (const name of EXPECTED) {
      for (const m of load(name).body.matchAll(/"tool":\s*"([^"]+)"/g)) used.add(m[1] as string);
    }
    expect(used.size).toBeGreaterThan(5);
    for (const slug of used) expect(SEO_SLUGS as readonly string[]).toContain(slug);
  });

  it("example tool arguments in the skills pass the real input schemas", () => {
    const searchSchema = z.object(searchShape);
    const startupSchema = z.object(startupShape);
    let validated = 0;
    for (const name of EXPECTED) {
      for (const m of load(name).body.matchAll(/`(\{ [^`]*\})`/g)) {
        const filled = (m[1] as string)
          .replace(/<slug>/g, "ghost")
          .replace(/<bot name>/g, "Googlebot")
          .replace(/<selector>/g, "s1")
          .replace(/<company name>/g, "Acme")
          .replace(/<[^>]*>/g, "example.com");
        const args = JSON.parse(filled) as Record<string, unknown>;
        const result =
          "tool" in args
            ? seoCheckSchema.safeParse(args)
            : "idOrSlug" in args
              ? startupSchema.safeParse(args)
              : "query" in args
                ? searchSchema.safeParse(args)
                : emailAuthSchema.safeParse(args);
        expect(result.success, `${name}: ${m[1]}`).toBe(true);
        validated++;
      }
    }
    expect(validated).toBeGreaterThan(10);
  });

  it("revenue skill keeps the verified-versus-unverified rule", () => {
    const { body } = load("verify-revenue-claim");
    expect(body).toContain("NOT verified");
    expect(body).toMatch(/never upgrade/i);
  });
});
