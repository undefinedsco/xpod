# Release Branch Candidate Promotion Design

## Context

Xpod currently treats every `v*` tag as a formal release. Fixing release or
production-image problems therefore consumed multiple formal patch versions
between `0.3.58` and `0.3.67`. A release candidate must be installable and
deployable for realistic acceptance, but candidate iteration must not update
the default npm channel or deploy production.

## Goals

- Make every commit on `release/<version>` produce a uniquely versioned RC.
- Publish the Xpod RC package under the `next` dist-tag.
- Publish a commit-addressed GHCR image and deploy it to the RC environment.
- Run product-level acceptance against the public RC endpoint.
- Permit a formal `v<version>` release only from an accepted commit on the
  corresponding release branch.
- Reuse the accepted container digest for the formal image and production
  deployment.
- Keep normal `main` and feature-branch CI free of package publication.

## Non-goals

- This design does not change AI Connection authorization.
- It does not create automatic semantic-version decisions.
- It does not make production deployment continuous from `main`.
- It does not allow RC failures to mutate or roll back npm `latest`.

## Branch and version contract

A release branch is named `release/<version>`, for example
`release/0.3.68`. The version component must be a stable SemVer without a
prerelease suffix.

Each push to that branch runs candidate publication. The candidate version is
derived by CI and is never committed to source files:

```text
<version>-rc.<github-run-number>
```

For example, a push to `release/0.3.68` from workflow run `30720000000`
publishes `0.3.68-rc.30720000000`. This guarantees npm version uniqueness even
when a commit is retried. A workflow retry appends the run attempt when needed:

```text
0.3.68-rc.30720000000.2
```

Release branches are protected from force-push. A formal tag
`v<version>` must point to a commit on `release/<version>` whose latest
candidate workflow completed successfully.

## Workflow architecture

### Continuous integration

Pushes and pull requests to ordinary branches run the existing build, lint,
typecheck, unit, integration, packaging, and consumer checks. They do not
publish packages or deploy an environment.

### Candidate workflow

Pushes to `release/**` run a dedicated candidate workflow:

1. Validate the branch name and derive the target stable version.
2. Run all pre-publication checks.
3. Materialize the derived RC version into Xpod's root package manifest only
   inside the workflow workspace.
4. Publish `@undefineds.co/xpod` with npm dist-tag `next` through the existing
   release packager. Independently versioned SDK workspace packages are not
   republished merely because Xpod enters RC; an SDK release remains an explicit
   versioned change in that package.
5. Build the Xpod container once and push immutable tags
   `sha-<full-commit>` and `<rc-version>`.
6. Record the resolved image digest as workflow output and an artifact.
7. Deploy that digest to the `rc` GitHub Environment and RC Kubernetes
   namespace.
8. Run public acceptance against `https://rc.id.undefineds.co`.
9. Record an acceptance artifact containing the source commit, target stable
   version, RC package version, container digest, test summary, and public
   endpoint results. It must contain no credentials or response secrets.

Candidate publication may create multiple `next` versions. It must never move
the npm `latest` dist-tag and must never update the production Deployment.

### Formal release workflow

Pushing `v<version>` runs the formal release workflow. Before publication it
must prove all of the following:

- the tag version is stable SemVer;
- the tagged commit belongs to `release/<version>`;
- a successful candidate workflow exists for that exact commit;
- the recorded candidate target version equals the tag version;
- the acceptance artifact names the same container digest;
- the formal npm version does not already exist.

The workflow then:

1. Checks out the exact accepted commit.
2. Applies the stable version to all publishable package manifests.
3. Builds and runs package consumer checks again.
4. Publishes the stable npm packages under `latest`.
5. Adds `<version>` and `latest` GHCR tags to the already accepted digest;
   it does not rebuild the container.
6. Deploys that digest to production.
7. Runs Kubernetes rollout checks followed by public service, OIDC, Dashboard,
   and authenticated-route acceptance.
8. Automatically rolls the Deployment back to its previous digest if the
   production health gate fails.

The GitHub Release is created only after npm publication and production
acceptance succeed. If npm publication succeeds but production fails, the npm
version remains published, the GitHub run fails, and production is rolled back;
the version is not reused.

## RC environment

The RC environment adds one Xpod instance while reusing the existing physical
infrastructure. It uses:

- GitHub Environment: `rc`
- public identity base: `https://rc.id.undefineds.co`
- isolated Kubernetes namespace and runtime Secret
- the existing PostgreSQL service with an isolated database or schema and
  database principal
- the existing Redis service with an isolated key prefix
- the existing object store with an isolated bucket or prefix
- the existing ingress, DNS, and certificate infrastructure
- production-equivalent PostgreSQL extensions, TLS, and OIDC callback behavior

The RC Xpod may scale to zero when no release branch is under acceptance. Its
domain, namespace, and logical data boundaries remain stable so OIDC issuer,
redirect URI, WebID, Pod URL, DNS, TLS, and ingress acceptance remains realistic.

The RC environment must not share user Pods, credentials, identity rows, or
Gateway Keys with production even though it reuses the physical services.
Infrastructure parity is required specifically so missing extensions, Secret
propagation, DNS, TLS, and ingress errors fail before formal release.

## Acceptance gates

Candidate acceptance includes:

- container startup and readiness;
- `GET /service/status` returns 200 with CSS and API healthy;
- Solid OIDC discovery returns 200 and valid endpoint URLs;
- Dashboard HTML loads in a real browser;
- anonymous access to protected settings is rejected;
- one authenticated Solid login and Pod read/write smoke test;
- AI Connection package installation from npm `next`;
- SDK consumption from Node and Bun;
- database capability checks, including every required PostgreSQL extension;
- verification that required Kubernetes Secret keys are present, reporting
  names only and never values.

The formal production gate repeats non-destructive public checks. Authenticated
mutation tests remain in RC so production acceptance does not create test users
or test Pod data.

## Failure and retry semantics

- A failed release-branch commit remains an immutable failed candidate.
- Fixes are normal commits on the same release branch and produce a new RC.
- Re-running a publication job uses a new prerelease version and never attempts
  to overwrite an npm version.
- Candidate deploy failure leaves production untouched.
- Formal validation failure occurs before npm publication.
- Production failure after publication triggers Deployment rollback and emits
  diagnostics; it does not create another formal version automatically.

## Repository lifecycle

After the formal version succeeds, the release branch is merged back to `main`
if necessary and deleted. The next release starts from current `main` with a new
`release/<version>` branch. Release workflow changes themselves must first be
validated on a release branch and must not be debugged with stable tags.

## Security

- Workflows print only Secret key names and presence checks.
- RC and production use separate GitHub Environments and Kubernetes Secrets.
- Workflow artifacts contain digests and redacted acceptance evidence only.
- Production promotion requires the immutable accepted commit and digest.
- No workflow accepts an arbitrary image tag as evidence of acceptance.

## Success criteria

The design is complete when one release branch can produce multiple RCs without
changing npm `latest`, an accepted commit can be promoted exactly once to a
formal version, production runs the accepted container digest, and a failed
candidate or production rollout cannot silently report success.
