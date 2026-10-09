# Pod settings body

`PodBody` renders the same model settings, search/index, app authorization and data management content in any React host. It has no router, rail, Solid session, account session or server dependency. The host passes `PodBodyProps` and handles authenticated operations; Xpod's adapter is `ui/src/pages/pod/PodPage.tsx`.

Hosts must include `packages/pod-settings/src` in their Tailwind content sources (or ship the generated styles). The host supplies the single page title and list navigation. Model source and eligible model lists are host inputs, never inferred from provider names by the body.

The Xpod adapter currently uses the existing AI configuration, lifecycle, background credential and Pod settings APIs. Platform embedding catalogue metadata, free-quota catalogue links, additional authorized applications, per-application metering, fast-chat defaults, speech/image/video/decision defaults and data import/export/migration are not supplied by those APIs and remain explicitly unavailable. It does not fabricate applications, usage, jobs or progress. Existing configured embedding values remain readable even when the available catalogue cannot resolve them.

Embedding is editable only from search/index settings. Changing it requires the explicit “更换并重建索引” action; the host saves the assignment then schedules a supported vector rebuild. If scheduling fails after saving, retry schedules the rebuild without rewriting the model assignment. Missing background access exposes a direct grant action.

Cloud model eligibility is projected by `/api/ai/config` from the assignment validation policy; local runtimes retain all discovered embedding models. This is eligibility only, not evidence that platform credentials exist. Capability URI conversion uses the models package vocabulary. Document-only models remain without a probe because the existing readiness endpoint only has chat and embedding probes.
