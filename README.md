# Leadwork — Clay-style MVP

Early implementation of a private lead-enrichment table product. Owners bring their own provider accounts; the product will not sell credits or send outreach.

## Current milestone

WO-1 shared contracts: runtime schemas, typed values, previews/consent, fixtures, provider evidence and regression tests. **No production web application, API, worker, authentication or provider integration is implemented yet.**

Requirements and blueprint decisions remain pending project review. Hosting and real provider execution are gated; no cloud resources or paid requests have been created.

## Local verification

Requires Node 22.x and pnpm 9.15.0.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

- [Contract handoff](docs/contracts.md)
- [Provider evidence and release gates](docs/provider-evidence.md)
- [Interactive local-only mockup](https://factory.8090.ai/project/addc29be-86bc-4eae-80f4-2d23939ce8d0/knowledge-base/13e8478f-acd1-4a2f-9ed9-ed84f4595165)
- [Editable mockup source backup](https://factory.8090.ai/project/addc29be-86bc-4eae-80f4-2d23939ce8d0/knowledge-base/57bf9381-32a5-4280-9338-4bf2a697158a)

Next layers: environment/web/worker setup, database schema, feature APIs, secure connections/adapters, durable execution, client screens and end-to-end verification (WO-2 through WO-16).
