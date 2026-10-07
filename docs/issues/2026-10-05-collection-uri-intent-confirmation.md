# Collection confirmation compared two valid URI representations as strings

## Actual RED and existing contracts

The isolated desktop on 2026-10-04 UTC created a fresh DeepSeek credential through its mounted collection. The write reached the real Gateway and the following ORM read returned the new row. Confirmation nevertheless raised `PodCollectionError(write_conflict)`: the sole differing readable field was `provider`. The intent contained `deepseek.ttl`; the server returned the same registered Local Pod's complete `settings/providers/deepseek.ttl` IRI. The other fifteen intent fields agreed. No other writer or changed secret was observed. The private original row pair is retained with the desktop fixture.

`@undefineds.co/models` declares the provider relationship as a URI and maps it to the credential table's linked provider column. `drizzle-solid@0.3.25` already resolves it using the registered `aiProvider` table and its bound Pod; this is not an ORM capability gap. Collection `projectionCovers` previously compared raw JSON values. The new regression exercises the actual model table, bound database and confirmation function; before the adapter repair its positive case failed and its foreign/fragment/readable-field negative cases passed.

## Repair boundary

Only the shared collection adapter normalizes mapped URI fields for confirmation and hashing. It reuses public `database.getDialect().getUriResolver().resolveLink`, with table registries sourced from public `database.getSchema`. The ORM owns linked table selection, resource layout and Pod resolution. No WebID-derived root, Cloud/Local compatibility algorithm, provider branch, fragment stripping or overwritten server row is introduced. Read rows and submitted writes retain their original representations.

Missing resolver capability keeps exact comparison; an unresolved registered relationship fails instead of guessing. Absolute foreign IRIs remain unchanged and cannot match the current Pod's relative intent. URI arrays follow the same resolver; ordinary strings, readable-field mismatches, secrets excluded by their descriptor, and genuine conflicts retain their prior rules. The same normalization is used for read and write hashes, so a confirmed absolute relation cannot invalidate a later unchanged relative update.

## Verification scope

The original desktop failure and regression RED are preserved. Targeted positive/negative regressions, a new real desktop creation and final complete/packaged acceptance are required separately; this issue does not claim that an unchanged production version has passed those checks.
