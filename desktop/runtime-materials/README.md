# Bun runtime material policy

`manifest.json` is the single checked-in authority for the bundled desktop Bun
runtime. It names every reviewed original (path, pinned source URL, SHA-256,
kind) plus the full pinned Bun source archive identity.

`init-runtime-input.ts` consumes only this file. It derives the mode from
`originals/assessment.json`: a `verified` assessment yields the `release`
descriptor that stable packaging requires, while an unreviewed one can only
yield `controlled-preview`, and asking for `release` with unreviewed material is
refused. There is no second table, no per-workflow configuration and no user
environment variable.

## What is pinned

- Bun 1.4.2 at commit `744846f844374847c902b5e7fd59b4342a51ef99`, executable
  `35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5`.
- Full source archive `25e09a8804535b8fbea1dad9f95af8402fc9133d28127d5594ff00df1549590e`
  (64,602,344 bytes) — declared as `kind: source`, downloaded by URL and digest
  into `.test-data/`, and never committed.
- Originals: upstream `LICENSE.md`, `scripts/build.ts`, the WebKit version pin
  and `sync-webkit-source.ts`, all fetched from the exact pinned commit.
- Statically linked LGPL components are recorded by exact source identity only:
  `oven-sh/WebKit` `2e2aa2290fac856d6f451ceacb58f7f5b44dd057` and
  `oven-sh/tinycc` `05f0fafaa3be31e31d7b4b5c17dc60f62c991171`.

## What "verified" means here

The declared original set and its pinned identities were reviewed. It does not
assert whole-binary licence coverage, and no rebuilt or relinked binary was
produced or is claimed. The upstream relink instructions are retained; prebuilt
object files are deliberately not fabricated.
