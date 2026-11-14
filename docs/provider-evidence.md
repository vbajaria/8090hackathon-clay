# Provider capability evidence and release gates

WO-1 · reviewed 2026-11-14 · documentation-only investigation. No account credentials, authorization requests, enrichment calls, generation calls, paid smoke tests or cloud provisioning occurred.

The initial web-search synthesis mixed APIs and response structures. The facts below instead come from directly retrieved official pages. Documentation evidence is **not** live certification, account-plan access, or a guarantee of pricing. `candidateCapabilities` fixtures remain disabled for real requests.

## Verified documentation facts

| Candidate | Official source and observed contract | Remaining gates |
| --- | --- | --- |
| People Data Labs company enrichment | [Input parameters](https://docs.peopledatalabs.com/docs/input-parameters-company-enrichment-api): `website` accepts a company domain; example `google.com`. Key supplied via request header or `api_key`; example uses `X-Api-Key`. [Output response](https://docs.peopledatalabs.com/docs/output-response-company-enrichment-api): company profile fields are **not contained in a top-level `data` object**; example includes top-level `status`, `name`, `id`, `likelihood`. | Pin current company `website` field formatting/schema, exact no-match/error mappings, rate/timeout limits, consumption semantics and account-plan access. No guaranteed nonbillable account-validation mechanism established in the inspected pages. Do not guess 404 semantics. |
| Hunter Email Finder | [V2 documentation](https://hunter.io/api-documentation/v2), Email Finder: `domain` plus `full_name` or `first_name` + `last_name`; `api_key`. Standard envelope uses `data`/`meta`/`errors`. Finder returns email with provider `verification`; labels include `valid`, `accept_all`, `unknown`. No email found consumes no credit according to this section. `max_duration` 3–20 seconds, default 10; documented rate limit 15 requests/second and 500/minute. | Test actual success, no-match, authorization/quota/rate-limit and timeout bodies. Pin timeout and workspace concurrency below applicable account limits. Do not translate verification labels into a deliverability guarantee. |
| Hunter connection/usage | Same V2 source, Account Information: “This call is free.” Example `GET https://api.hunter.io/v2/account?api_key=…`. Account stats also explicitly says free/no credits. Finder response headers `X-Credits-Used` and `X-Credits-Unit` describe actual request consumption. Account quotas may share a credits pool; do not add overlapping quota counters. | Nonbillable authorization-check candidate is documented, **not executed**. Redact query-string keys. Record per-attempt headers separately from account-level quotas. Unknown monetary amount stays unknown even if credits are known. |
| Snov email discovery | [API documentation](https://snov.io/api), Find emails from name and domain: `POST /v2/emails-by-domain-by-name/start`, `rows` containing `first_name`, `last_name`, `domain`, up to 10 objects. Start returns `data.task_hash`; retrieve existing work with `GET /v2/emails-by-domain-by-name/result` and `task_hash`. OAuth example uses `/v1/oauth/access_token`, `grant_type=client_credentials`, `client_id`, `client_secret`; lookup examples use bearer token. | Full-name-only input is **not established** for this method. Require owner-mapped parts or owner-confirmed decomposition. Pin access restrictions, token/authorization behavior, rate/timeout limits, polling cost and post-cancel retrieval policy before activation. |
| Snov results/usage | Same method's result example: `status=completed`, `data[].result[].email` and `smtp_status`; statuses include `completed`, `in_progress`, `not_enough_credits`. Email verification labels include `valid` and `unknown`. Method heading states “1 credit for each email with a valid or unknown status.” | This statement does not prove polling is free, task creation is free, or per-attempt account deductions are exactly attributable. Completed-empty/no-match shape and error classifications still need validated fixtures. `not_enough_credits` is a failure, not waterfall no-result. Preserve labels rather than infer verification. |
| OpenAI text generation | [Responses create reference](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create/): SDK `responses.create`, input via `input`, output in `output` message content with `type=output_text`, token counts under `usage`. Reference includes `max_output_tokens`, `store`, and `tools`. **Not** Chat Completions `messages`/`choices[0]`. | Select/pin an owner-accessible text model, safe credential check, provider retention, rate/timeout/output bounds, refusal/incomplete/empty-output mapping and token-cost attribution. Disable SDK automatic retries. `tools=[]`, `store=false`; no background/tools/research/send behavior in the MVP adapter. |

## Common name compatibility

Hunter supports full-name and separate-name inputs. The inspected Snov method supports separate names. The common contract can use **owner-mapped given/family-name columns**, or an explicit owner-confirmed decomposition, with the same domain. A full-name-only table must not silently split names to activate Snov. The schemas distinguish both modes, and `supportsName` tests reject Snov/full-name compatibility.

Hunter + Snov is therefore a documented candidate pair for mapped-part inputs, **not a launch-certified pair**. If account access/polling/retention gates cannot be resolved, validate another real provider before substituting it. Tomba is a reserved candidate ID only; no Tomba capability is certified or enabled here.

## Evidence excerpts (official text, formatting collapsed)

- PDL input: “The company's website.” Example: `google.com`.
- PDL output: “Unlike our other APIs, the profile fields for the Company Enrichment API are NOT contained in a top-level data object.”
- Hunter name: “You must also provide a name — either first_name + last_name, or full_name”.
- Hunter authorization: “This API endpoint enables you to get information regarding your Hunter account at any time. This call is free.”
- Hunter consumption: “X-Credits-Used is the amount that the request used.”
- Snov input: “An array of objects that contain prospect details (first name, last name and domain). Each request can have up to 10 objects.”
- Snov retrieval: “task_hash — Unique request ID you received from the previous request.”

Retrieval SHA-256 fingerprints (HTML, not checked-in vendor payloads):

```
PDL input   6e3668b37e0f91aef0d4c606b9b73e0f010fc618ead7f2932129dd71776404f4
PDL output  96ee21d121d3002f1df9dcea086d9836a1f609120ba2cd714eb4265952f6d6f5
Hunter      86f0485c15b4a4c5b2f6bda6f7d613eb746c91367e683597dc94971d58fd3c93
Snov        72fb66d4898c091f8a8d613b7284844d418b86bf990467c018240b140407499a
OpenAI      d9a876a5e657523b42edb6c79074473f1a426c2dd81974c955aeaa9c96e584c9
```

## Real execution remains gated

For each adapter: recorded sanitized actual response fixtures; authorized account access; verified safe connection validation; exact no-match/error mappings; deadline/rate/concurrency policy; bounded async polls and charge semantics; revocation/cancellation behavior; usage observation interpretation; provider retention policy. Live billable verification requires explicit authorization and a disclosed bounded test budget.

No fixtures in this PR are advertised as live or vendor-recorded. The fixture polling allowance, request counts, amounts and names are synthetic protocol examples, not real vendor limits or prices. Usage observations are history, while attempt consumption is one authoritative projection per attribution/dimension; summing repeated cumulative observations is prohibited.
