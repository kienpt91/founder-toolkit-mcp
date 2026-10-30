---
name: email-deliverability-check
description: Check a sending domain's SPF, DKIM, DMARC and MX DNS records and give the exact DNS records to fix. Use when mail goes to spam, before launching a sending domain, or when asked to set up or audit email authentication.
---

# Email deliverability check

Runs local DNS lookups and turns the findings into DNS record changes. Requires the `founder-toolkit-mcp` server (tool `email_auth_check`). Nothing is sent to a third-party service; the DNS queries go through this machine's resolver.

## Inputs

- `domain`: the domain used in the From address (ask if missing).
- The DKIM selector(s) in use. To find one, ask the user for the raw headers of a message they sent and read `s=` in the `DKIM-Signature` header. Without a selector the tool only probes common ones.
- Which services send mail for the domain (needed for SPF; ask, do not guess).

## Steps

1. Call `email_auth_check` with `{ "domain": "<domain>", "dkimSelectors": ["<selector>"] }`, omitting `dkimSelectors` if none is known yet.
2. Read `findings`. Each has `check` (spf, dmarc, dkim, mx), `severity` (fail, warn, info), `message` and `fix`. Work in this order: fails first, then warns.
3. Build exact records:
   - SPF: exactly one TXT record at the domain, `v=spf1 <ip4/ip6/include entries for every sender> -all`. Use the include values each sending service documents. Keep total DNS lookups at 10 or fewer (`spf.dnsLookups`). Start with `~all` if unsure and move to `-all` after the senders are confirmed.
   - DMARC: TXT at `_dmarc.<domain>`. Start with `v=DMARC1; p=none; rua=mailto:<mailbox the user controls>`, then move to `p=quarantine` and `p=reject` once the aggregate reports show only legitimate senders.
   - DKIM: publish the exact key the sending service gives (TXT, or CNAME if the service says so) at `<selector>._domainkey.<domain>`. Use 2048-bit keys; rotate any key reported shorter.
   - MX: add the mailbox provider's MX records, or a null MX if the domain must never receive mail.
4. After the user changes DNS, call `email_auth_check` again to confirm. Propagation can take time; a stale result is not a failed fix.

## Deliverable

```
Domain: <domain>   Overall: <PASS|WARN|FAIL>
SPF   <status>  <one line>
DMARC <status>  <one line>
DKIM  <status>  <selectors checked>
MX    <status>  <hosts>

DNS changes to make:
  TYPE  NAME                      VALUE
  TXT   <name>                    "<exact value>"
```

## Limits

- It reads published DNS only. It cannot prove that your sending service actually signs mail, that DKIM and SPF align with the From domain, or where mail lands (inbox vs spam). Confirm with a real test message and its headers.
- When no selector is given, "no DKIM found" does not mean DKIM is missing.
- DMARC is read at `_dmarc.<domain>` only; a subdomain may inherit its parent's policy, which is not looked up. Report destinations on other domains are not checked for authorization.
- SPF `mx` and `a` mechanisms are counted as one lookup each; the tool does not expand their DNS results.
- Reputation, content, and sending volume also affect deliverability and are outside this check. For the sender service the author runs, see [AISend](https://aisend.app) (optional; any sender works).
