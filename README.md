# aicontentdetectorfree.com

Static site for the free, in-browser AI content detector at
https://aicontentdetectorfree.com. Plain HTML/CSS/JS — no build step, no
backend. Cloudflare Pages auto-deploys from `main`.

## Preflight QA — run before every commit

```
npm run check        # = node tools/preflight.mjs
```

Dependency-free (Node built-ins only — nothing to install). It statically
verifies the promises the deployed site must keep:

- every inline `<script>` **parses** — a single stripped `||` once broke the
  entire detector for ~10 weeks with no visible error until someone clicked;
- the detector UI and wiring are intact (textarea, Detect button, sample
  loaders, word counter, every `onclick` handler defined, every
  `getElementById` target present);
- `ads.txt` is byte-exact; the AdSense loader appears exactly where approved
  (homepage + 3 education pages) with the unchanged publisher id, and no
  manual ad units exist;
- all internal links resolve, external links/script sources are allowlisted,
  and the sitemap and the filesystem agree in both directions;
- no analytics/tracking code, forms, email capture, or affiliate parameters —
  none are approved for this site;
- banned overclaiming phrases are absent (honest negated disclaimers like
  "No AI detector is 100% accurate" are allowed and required);
- nothing contradicts the verified privacy claim that text is analyzed
  locally and never uploaded.

**If the check fails, do not commit or deploy.** Fix the finding or, if a
check is wrong because the site legitimately changed, update the contract at
the top of `tools/preflight.mjs` in the same commit — deliberately, not by
deleting checks.

Bulk find/replace operations over HTML (the cause of the original breakage)
should never be committed without running this check first.
