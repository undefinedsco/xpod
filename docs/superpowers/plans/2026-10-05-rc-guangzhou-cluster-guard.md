# Guangzhou cluster guard for RC acceptance

The user requires K8s acceptance on GZ and forbids automatic SG fallback because of cost. GitHub rc currently still uses the SG namespace. The existing GZ kubeconfig fails CA verification, so new remote deployment must wait for trusted configuration.

Add one local, network-free target validation entry point using the selected kubectl context. Validate the Guangzhou API address and agreement between the context namespace and deployment namespace. Print fixed diagnostics without kubeconfig or authentication material. Add no dependencies or deployment configuration keys.

Wire the guard before publication prerequisites and before cluster operations in deployment setup. After setup fails, failure diagnostics and automatic RC scaling must not contact an unverified cluster. Preserve existing RC gates and concurrent changes.

Write behavioral regression tests first and prove RED, then implement and prove GREEN. Run the entry point as a real subprocess with fake kubectl: allow GZ; reject SG, mismatched namespace, missing context, invalid config and command failure; do not leak inputs. Verify workflow ordering and failure conditions, then related release tests, type checks and full integration.

Do not migrate production, modify GitHub environment credentials, or delete SG production/RC resources. Remote acceptance resumes after trusted GZ configuration is restored. These checks cannot replace full integration, real candidate acceptance, formal desktop update or real model Chat verification.

## Implementation evidence

OpenCode Go A implemented the bounded guard, workflow wiring and regressions; no 429 occurred and no Sol fallback was used. The guard compares the exact canonical Guangzhou endpoint instead of adding URL normalization. Failed configuration setup prevents remote diagnostics and RC scaling.

The original candidate/promotion baseline passed 107 tests. Test-first RED reproduced 22 failures; subsequent candidate, promotion and target suites passed 128 tests. Source and test type checks passed. Explicit lint using already installed Node/TypeScript lint rules passed; the repository has no root ESLint configuration, so the default invocation was not treated as a successful check.

The actual local GZ config passes offline target selection. A fresh read-only readyz request still fails with unknown_certificate_authority. No SG fallback, remote mutation or new deployment was attempted. GitHub rc and co namespace variables still point to ns-1yl0rye9; this change prevents new RC deployment there but does not migrate existing environments. The pre-existing separate Guangzhou test workflow uses GZ_KUBE_CONFIG_DATA; its latest observed run failed before deployment, so it does not prove current cluster access.

Full integration was subsequently started using isolated native PostgreSQL 18.4 with pgvector 0.8.6, Redis 5.0.5 and VersityGW 1.8.0 through the existing external-infrastructure adapter. All three readiness probes passed. The actual `bun run test:integration` process was stopped during its lite stage when host free capacity fell below the 1 GiB guard; the full stage did not start. This is an incomplete gate, not a passing full integration result. All owned processes, process groups and listening ports were cleaned, and the run checked 2,990 frozen files without drift. These native versions differ from the default Compose versions, and the result is not a deployed candidate acceptance.

Storage recovery preserved log contents using transparent compression. An attempted full archive of the stopped, task-owned disposable Lima VM was itself stopped by the capacity guard. Only recreation configuration and existing test identities were backed up and verified; the recreatable guest disk cache was then removed. The disk contents are not backed up. Other VMs, worktrees, production resources and the installed Xpod account were outside the cleanup scope.

Trusted GZ access remains unavailable locally. A read-only probe mode in the existing registered candidate workflow is being prepared to check the `cn` environment configuration without publishing, deploying or inspecting production. It has not yet been dispatched or established current cluster trust. Do not commit or publish this pending tree as fully accepted.

## Read-only probe implementation status

OpenCode Go A added the candidate workflow `gz_probe_only` mode and the standalone safe-report inspector. Regression-first tests reproduced 13 failures with 96 existing passes; the subsequent combined inspector, guard, candidate and promotion suites passed 141 tests in four files. Explicit CJS/test lint, test type checking, script syntax and diff checks passed. A real invocation using the current local GZ configuration failed closed with category `tls`, generated a 0600 safe report, and performed no deployment or SG fallback.

The probe remains under review: require a v-prefixed version of at most 64 total characters; verify auth command status as well as output; explicitly scope the deployment read; sanitize invalid namespace values; reject a missing RUNNER_TEMP; restrict the secret environment to the setup step; and set explicit kubectl request timeouts. Subsequent bounded A review attempts returned no output and were stopped without observing 429 or switching models. Passing current regression tests does not discharge these review findings. The workflow has not been committed, dispatched or remotely accepted. Existing source-freeze metadata predates these changes and must be refreshed after review before any new integration run.

## Recovery and cleanup plan

The user supplied `/Users/ganlu/develop/undefineds/config`. Its `kubeconfig.cn.yaml` now passes a real trusted GZ readyz request; the seven fixture/RC create-permission checks and service inventory reads succeed. The co file is SG and is not selected. The additional uncommitted CI probe mode is no longer needed to recover configuration. Remove only this task's unfinished `gz_probe_only` input, job, concurrency suffix, gating additions, inspector and associated tests, while preserving the earlier GZ target guard and every original candidate/release gate. The existing 141-test regression baseline passed before this cleanup. Verify the retained candidate, promotion and target suites, type checking and static checks afterward; preserve historical receipts. This deletion removes the unresolved inspector review surface rather than declaring it accepted.

Recovery cleanup verification: retained target, candidate and promotion suites pass 128 tests in three files; test type checking and explicit test lint pass. The temporary CI probe and its inspector tests were removed as planned. Current local GZ TLS/readyz and all seven permission checks pass with the user-supplied CN configuration. This resolves the prior TLS blocker; GitHub rc/co configuration has not been migrated. Transparent compression of 75 inactive task-owned files preserved their hashes and reclaimed 323,084,288 bytes. Complete integration is now being attempted using isolated GZ PostgreSQL/pgvector, Redis and S3 fixtures with 2 GiB start and 1 GiB runtime disk guards. No passing full result is claimed yet.

## Complete GZ integration result

Run `xd-ui-1005-1cc1e4` completed the actual standard `bun run test:integration` command successfully using isolated GZ fixtures: PostgreSQL 16.15, pgvector 0.8.7, Redis 7 and VersityGW S3. Lite: 162 passed, 16 existing skips (32 passed files, four skipped); full: 62 passed in all seven files, with all four Xpod runtimes. Source freeze checked 3,378 paths with no drift or added inventory. Process groups and port forwards exited, all seven owned resources were cleaned by exact owner/run/UID, and a fresh GZ inventory verified zero remaining resources. Owned runtime and forwarded ports were closed.

This result resolves local full integration and the stale GZ CA blocker. It does not prove a deployed normal candidate, formal desktop auto-update, or real model Chat. GitHub RC configuration and RC public domains still require GZ alignment before the next normal candidate.
