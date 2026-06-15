Implement the first pass of a surface taxonomy / capability graph system.

Goal:
Build an extraction pipeline that reads the existing API structure and creates evidence-backed candidate capability nodes in the graph DB. This is not meant to fully solve enterprise semantics yet. The first milestone is to let APIs broadcast what they appear to support so future agents can reason from reusable capability metadata instead of rereading the repo every time.

Core idea:
Do not store API summaries as prose blobs. Store structured graph nodes and edges for:

* API endpoints
* capabilities
* business concepts
* identity fields
* surface needs / UI interaction patterns
* evidence
* confidence
* unresolved gaps

The graph should answer questions like:

* Which APIs can search pay statements by client and date window?
* Which APIs return processId or another drilldown identity?
* Which capabilities support tabular datasets?
* Which capabilities are client-scoped?
* Which APIs are only candidates because date semantics or identity semantics are unclear?

Initial graph model:

Nodes:

ApiEndpoint

* path
* method
* serviceName
* operationId
* summary
* sourceFile
* lastVerified
* confidence

Capability

* name
* kind
* domain
* description
* confidence
* status: candidate | verified | deprecated

BusinessConcept

* name
* domain
* aliases
* canonicalIdentityField, if known

IdentityField

* name
* identityKind
* domain
* description

SurfaceNeed

* name
* kind
* description

Evidence

* sourceType: openapi | controller | service | dto | component | route | test | manual
* sourceFile
* symbolName
* excerpt or reference
* confidenceContribution

Edges:

ApiEndpoint -[:PROVIDES]-> Capability
Capability -[:REQUIRES_INPUT]-> BusinessConcept
Capability -[:RETURNS]-> BusinessConcept
Capability -[:USES_IDENTITY]-> IdentityField
Capability -[:SATISFIES]-> SurfaceNeed
Capability -[:RELATED_TO]-> Capability
ApiEndpoint -[:HAS_EVIDENCE]-> Evidence
Capability -[:HAS_EVIDENCE]-> Evidence
BusinessConcept -[:HAS_ALIAS]-> BusinessConcept or Alias node if needed

Important rule:
Every semantic tag or edge must have evidence. Do not silently infer final truth from naming alone. If a capability looks plausible but is not proven, mark it as candidate and include unresolved gaps.

Example candidate capability:

Capability:

* name: payStatement.searchByClientDateWindow
* kind: dataset_search
* domain: payroll
* status: candidate
* confidence: 0.72

Tags / SurfaceNeeds:

* client_scoped_dataset
* date_windowed_dataset
* tabular_dataset
* drilldown_seed_candidate

Evidence:

* endpoint path suggests pay statement search
* request DTO has clientId
* request DTO has startDate/endDate or equivalent
* response DTO includes processId
* existing UI component consumes this API in a table, if discoverable

Unresolved gaps:

* Does date range mean pay date, statement date, process date, or created date?
* Is processId the correct drilldown identity?
* Are voided/reversed/reissued statements included?
* Is clientId the same concept as the selected UI client?

Initial implementation steps:

1. Create a capability extraction module.

   * It should scan API definitions, OpenAPI files, controller routes, DTOs, and service methods where available.
   * Prefer existing repo conventions over inventing a new parser if helper utilities already exist.
   * If multiple sources exist, merge evidence into one candidate capability rather than creating duplicates.

2. Define a small capability classification system.
   Start with these capability kinds:

   * entity_lookup
   * recent_entity_lookup
   * dataset_search
   * detail_lookup
   * process_detail_lookup
   * mutation
   * export
   * status_lookup

3. Define initial surface needs.
   Start with:

   * RecentEntitySelector
   * ClientScopedDataset
   * TimeWindowedDataset
   * TabularDataset
   * TabbedDatasetWorkspace
   * RowDrilldown
   * ProcessDrilldown
   * DetailPanel
   * PaginatedDataset
   * StatusFilteredDataset

4. Add tag inference, but keep it evidence-backed.
   Examples:

   * If input has clientId/clientCode/customerId and endpoint/service name supports it, candidate tag: client_scoped.
   * If input has startDate/endDate/fromDate/toDate/dateRange, candidate tag: date_windowed.
   * If output is an array/list/page/resultSet, candidate tag: tabular_dataset.
   * If output has processId/processRunId/batchId/correlationId, candidate tag: drilldown_seed_candidate.
   * If endpoint fetches by ID and returns one object, candidate tag: detail_lookup.

5. Add confidence scoring.
   Suggested starting rule:

   * Naming evidence only: low confidence
   * Request/response DTO evidence: medium confidence
   * Existing component usage: higher confidence
   * Existing tests proving behavior: high confidence
   * Manual verification: highest confidence

6. Persist to graph DB.
   Use the existing graph DB adapter if one exists.
   If no adapter exists yet, create a repository/interface layer so the extractor can output both:

   * graph DB writes
   * JSON fixture output for review/debugging

7. Add deduplication.
   Multiple endpoints/files may refer to the same capability.
   Use a stable capability key like:
   domain.kind.primaryConcept.qualifier

   Examples:

   * payroll.dataset_search.payStatement.byClientDateWindow
   * balance.dataset_search.managedBalance.byClientDateWindow
   * process.detail_lookup.process.byProcessId
   * client.recent_entity_lookup.client.byCurrentUser

8. Add a review output.
   The extractor should produce a human-readable report of:

   * created candidate capabilities
   * evidence per capability
   * inferred tags
   * unresolved semantic gaps
   * low-confidence edges
   * suspected duplicates

9. Add one query/demo function.
   Given a product request shape like:

   “recent clients dropdown + pay statement tab + managed balance tab + last two weeks + row drilldown by process id”

   The system should translate it into required surface needs:

   * RecentEntitySelector for Client
   * TimeWindowedDataset for PayStatement
   * TimeWindowedDataset for ManagedBalance
   * TabularDataset for both
   * RowDrilldown / ProcessDrilldown

   Then query the graph for candidate capabilities that satisfy those needs and report:

   * found capabilities
   * missing capabilities
   * uncertain capabilities
   * identity/date semantic risks

Acceptance criteria for first milestone:

* Running the extractor produces structured capability records, not prose summaries.
* Every Capability has evidence.
* Every SATISFIES edge has evidence and confidence.
* Ambiguous semantics are represented as gaps, not guessed as truth.
* The system can identify candidate APIs for client-scoped, date-windowed, tabular datasets.
* The system can flag processId/processRunId/batchId-style fields as possible drilldown identities.
* The output is useful to an implementation agent before it writes UI code.

Do not attempt to solve full enterprise ontology yet.
Start with API capability extraction and surface-need tagging.
The point is to amortize future token cost by creating reusable semantic metadata now.
