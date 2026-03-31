# Prototype Synthesis System Master Spec

## 1. Purpose

This system generates final standalone HTML prototype artifacts for non-technical users from one of three input modalities:

1. screenshot
2. screenshot + prompt
3. well-known route + prompt

The output artifact must:
- look and feel like the target application with high visual fidelity
- preserve intended interaction structure and page semantics
- compile into a final standalone HTML artifact
- be safe for non-technical users to review and upload to JIRA
- avoid semantic drift caused by validation-driven simplification

This system must operate under a hostile implementation environment in which a downstream coding/generator layer is biased toward contract satisfaction and validation success over fidelity preservation.

---

## 2. Core Problem

The existing generator accepts:
- metadata
- raw HTML fragment

and returns either:
- final standalone HTML artifact
- error

The existing agent generates the raw HTML fragment from graph query results that include:
- vectors
- bounding boxes
- component contracts
- related component information

The failure mode is:

- the agent generates a structurally plausible fragment
- the downstream generator rejects it due to contract violations
- the agent simplifies or mutates semantics in order to satisfy validation
- fidelity drops in favor of passing validation
- the final artifact becomes contract-valid but semantically wrong

This system exists to prevent that behavior.

---

## 3. Non-Goals

This system does not aim to:
- let the generator freely redesign the page
- let validation redefine the intended page semantics
- let non-technical users maintain live graph infrastructure
- require non-technical users to install or run Neo4j
- mutate the canonical graph directly during normal prototype generation
- use freeform HTML generation as the primary reasoning surface

---

## 4. Architectural Principles

### 4.1 Semantic authority must not live in the generator

The generator may compile and package output, but it must not decide:
- page archetype
- composition motif
- layout family
- fidelity-critical substitutions
- major interaction model
- major presentation strategy

### 4.2 Validation must be demoted

Validation is required, but only as:
- prebuild contract checking
- builder input legality checking
- payload completeness checking
- minimal final artifact sanity checking

Validation must not be the system’s semantic judge.

### 4.3 Final artifact build is terminal

`build_standalone` emits the final artifact used by a non-technical user.

Therefore:
- all serious validation must happen before final artifact emission
- all bounded repair must happen before final artifact emission
- post-build work must be limited to minimal sanity checks only

### 4.4 The loop belongs before artifact emission

The iterative loop is:

`discovery -> synthesis <-> prebuild_validation <-> bounded_repair -> build_standalone`

Not:

`... -> build_standalone -> redesign -> rebuild`

### 4.5 Intent must be frozen before HTML packaging

The system must create a stable intermediate plan before final raw HTML fragment generation and before standalone artifact build.

### 4.6 Freedom must be typed

The system must allow controlled layout and presentation variation within approved layout grammars and recipe families, while forbidding unauthorized semantic changes.

---

## 5. High-Level Architecture

### 5.1 Pipeline

The required pipeline is:

1. `discovery_tool`
2. `synthesis_tool`
3. `prebuild_validator`
4. `bounded_repair`
5. `build_standalone`
6. optional `artifact_sanity_check`

### 5.2 Pipeline semantics

#### `discovery_tool`
Purpose:
- collect relevant evidence from the graph-backed knowledge pack

Returns:
- candidate page archetypes
- candidate composition motifs
- candidate components/modules
- vectors
- bounding boxes
- component contracts
- policy records
- relevant routes/targets
- examples/few-shots
- presentation clues
- ambiguity and confidence information

Constraints:
- descriptive only
- no semantic rewriting
- no final layout authorship
- no final artifact generation

#### `synthesis_tool`
Purpose:
- convert discovery results and user request into a builder-safe, locked intermediate payload

Responsibilities:
- normalize intent
- choose page archetype
- choose composition motif
- choose presentation recipe
- assign modules to regions/slots
- determine state requirements
- determine action surfaces
- classify fields as locked, substitutable, optional
- choose allowed lowerings and fallback order
- produce a builder-ready payload

This stage is the primary semantic authority.

#### `prebuild_validator`
Purpose:
- verify that the synthesis output can legally be consumed by the standalone builder

Responsibilities:
- check payload completeness
- check metadata legality
- check raw HTML fragment legality
- check selected motifs against policy
- check builder contract compatibility
- check required wrappers/adapters
- detect forbidden substitutions
- detect representability failures before final build

This validator must not redefine page semantics.

#### `bounded_repair`
Purpose:
- repair only payload/build-contract-level issues without changing locked semantics

Allowed:
- wrapper insertion
- adapter insertion
- legal lowering selection
- metadata repair
- fragment legality repair
- legal equivalence-class substitutions
- representation-level fixes

Forbidden:
- changing page archetype
- changing primary composition motif
- changing locked interaction model
- deleting locked state requirements
- simplifying layout to pass validation unless explicitly allowed by policy
- silently degrading fidelity

#### `build_standalone`
Purpose:
- emit the final standalone HTML prototype artifact

Input:
- validated builder payload

Output:
- final standalone HTML artifact used by non-technical users

This is terminal artifact emission, not a design iteration phase.

#### `artifact_sanity_check` (optional)
Purpose:
- detect catastrophic packaging or artifact corruption only

Allowed checks:
- artifact exists
- root/bootstrap structure present
- no fatal malformed output
- no catastrophic builder failure

Forbidden:
- semantic redesign
- layout redesign
- structural resynthesis

---

## 6. Canonical Knowledge Model

### 6.1 Canonical graph

The source of truth is a canonical graph or graph-like knowledge substrate containing:

- components
- subcomponents
- component APIs
- slots
- event surfaces
- wrappers/adapters
- routes
- usage examples
- few-shot references
- AST fragments
- HTML fragments
- composition motifs
- policies
- equivalence classes
- incompatibility relationships
- presentation clues
- observed usage patterns

This graph is maintained by technical users.

### 6.2 Non-technical packaging constraint

Non-technical users must not be required to:
- install Neo4j
- run live graph infrastructure
- maintain graph synchronization
- contribute directly to the canonical graph

### 6.3 Export model

The canonical graph must be exportable as versioned JSONL-based knowledge packs.

These packs are consumed by the runtime system.

### 6.4 Working model

The runtime does not operate directly on the full canonical graph.

It operates on:
- a scoped view or slice of the graph
- plus local ephemeral overlays
- plus session-level deltas

This is effectively a graph-backed DSL over a projected view of the canonical graph.

---

## 7. JSONL Knowledge Pack Requirements

### 7.1 Packaging requirements

The knowledge pack must:
- be portable
- require no database installation
- be versioned
- support refresh by replacement
- tolerate drift for non-technical users
- be rebuildable by technical users
- support local query and retrieval

### 7.2 Required record families

The knowledge pack should include separate JSONL record streams for:

#### Components
Each record should include:
- stable id
- name
- import/path identity
- public API
- observed usage API
- variants
- slots
- event surfaces
- wrapper/adapter requirements
- examples
- policy refs
- equivalence refs
- embedding refs if used

#### Compositions / motifs
Each record should include:
- composition id
- participating components
- layout pattern
- action surfaces
- state pattern
- route/page contexts
- presentation clues
- scaffold-safe lowerings

#### Routes / page archetypes
Each record should include:
- route id
- page archetype
- shell family
- modules
- role variants
- state packs
- linked motifs
- known targets/transitions

#### Policies
Each record should include:
- policy id
- scope
- condition
- allow/forbid semantics
- fallback order
- degradation class

#### Examples / few-shots
Each record should include:
- example id
- source reference
- relevant components
- context
- snippet metadata
- behavior notes

### 7.3 Indexing requirements

Because JSONL is not a graph database, the exported pack must include precomputed lookup and adjacency information where needed.

Examples:
- related component ids
- allowed target ids
- composition membership
- route membership
- equivalence-class membership
- policy references

---

## 8. Intermediate Representation / DSL

### 8.1 Purpose

The system must use a stable intermediate payload between discovery and final artifact build.

This payload is the system’s planning DSL / IR.

It is:
- more structured than freeform HTML
- more editable than raw graph edges
- less implementation-specific than final builder output

### 8.2 Mandatory property

The IR schema must be fixed ahead of time.

The generator must not invent or mutate the schema dynamically.

### 8.3 Required content domains

The IR must encode at least:

#### Structural intent
- modality
- artifact type
- page archetype
- shell/layout family
- regions
- modules/components
- action surfaces
- transitions/targets
- required state pack

#### Presentation intent
- layout recipe
- density profile
- spacing/grouping profile
- surface hierarchy
- content width strategy
- responsive strategy
- action hierarchy/emphasis
- rail/split behavior
- approved variant selections

#### Control and policy
- locked fields
- substitutable fields
- optional fields
- allowed lowerings
- fallback order
- degradation budget
- unresolved ambiguity markers
- diagnostics/confidence

### 8.4 Design intent protection

Locked fields must not be changed by downstream repair or compilation phases.

---

## 9. Layout and Presentation System

### 9.1 Structural correctness is insufficient

The system must not assume that correct structure implies correct visual fidelity.

The planning/synthesis layer must explicitly choose presentation behavior.

### 9.2 Layout generation strategy

The system must generate layouts using:
- approved layout grammars
- known recipe families
- bounded parameters
- optional slots
- approved variants

Not by freeform HTML styling alone.

### 9.3 Recipe requirements

Each layout/presentation recipe should define:

- required slots
- optional slots
- legal parameter bands
- action placement rules
- width and ratio rules
- density modes
- grouping rules
- responsive collapse rules
- policy constraints

### 9.4 Typed freedom

The system must permit freedom in:
- recipe selection within allowed families
- parameterization within approved bands
- optional module usage
- approved visual variants
- presentation tuning within bounds

The system must forbid freedom in:
- changing locked archetypes
- replacing primary module types
- inventing new layout families outside the ontology
- moving locked actions across semantic zones
- flattening the page to satisfy validation

### 9.5 Presentation authority

The synthesis layer must choose or derive:
- recipe id
- parameterization
- approved variants

The builder must express that plan, not reinvent it.

---

## 10. Three Supported Modalities

### 10.1 Screenshot
Discovery requirements:
- detect shell/layout clues
- detect visible regions
- infer candidate component classes
- derive bounding boxes
- capture ambiguity/confidence
- avoid inventing hidden state without support

### 10.2 Screenshot + prompt
Discovery requirements:
- everything required for screenshot mode
- extract requested deltas
- infer target modifications
- infer role/state adjustments
- preserve visual anchor from screenshot

### 10.3 Well-known route + prompt
Discovery requirements:
- route match
- route family lookup
- relevant role/state variants
- linked motifs and policies
- requested modifications

### 10.4 Common normalization requirement

All three modalities must normalize into the same IR schema before builder payload generation.

---

## 11. Selector / Controlled Decision Layer

### 11.1 Need for selector

Because the downstream environment overvalues validation success, the system must use a controlled decision layer for high-impact structural choices.

### 11.2 What selector controls

The selector or planning policy must govern:
- page archetype
- shell/layout family
- primary composition motif
- primary data view
- action model
- state pack family
- allowed fallback class
- lowering strategy

### 11.3 What selector does not need to control

The selector should not micromanage low-risk details such as:
- every small spacing token
- minor icon choices
- copy wording
- non-critical decorative elements

### 11.4 Selector placement

Selector logic belongs inside or directly before `synthesis_tool`.

### 11.5 Decision shape

Options must correspond to real ontology elements, not vague style adjectives.

---

## 12. Mutation and Overlay Model

### 12.1 Canonical graph stability

Normal prototype generation must not directly mutate canonical source-of-truth records.

### 12.2 Allowed runtime mutation layer

The runtime may apply:
- session overlays
- local view mutations
- proposed deltas
- page-instance patches

These mutations apply to the scoped view / page instance, not the canonical graph itself.

### 12.3 Mental model

The system consists of:
- canonical graph
- scoped working view
- planning DSL / IR
- local overlay mutations
- final artifact emission

---

## 13. Fidelity Protection Rules

### 13.1 Primary requirement

The system must maximize fidelity within legal builder constraints.

It must not maximize validation success at the expense of locked intent.

### 13.2 Required distinction

The system must distinguish:
- semantic correctness
- representational legality
- final packaging sanity

### 13.3 Locked intent rules

Locked items may not be altered by:
- generator
- validator
- repair logic
- builder fallback behavior

unless an explicit degradation event is raised and the system fails honestly.

### 13.4 Allowed degradation behavior

If a locked requirement cannot be represented legally:
- the system must surface an explicit unresolved conflict
- the system must not silently downgrade the page

### 13.5 Fidelity-critical examples

Examples of likely locked items:
- page archetype
- primary data view
- inspector presence/placement
- major action surface
- major interaction model
- required states

---

## 14. Boundaries of Each Stage

### 14.1 `discovery_tool`
Allowed:
- evidence gathering
- retrieval
- scoring
- projection of the canonical graph

Forbidden:
- final semantic decisions
- HTML generation
- design degradation

### 14.2 `synthesis_tool`
Allowed:
- semantic decisions
- layout recipe selection
- parameterization
- field locking
- builder payload preparation
- internal iterative reasoning

Forbidden:
- final standalone artifact emission
- dynamic schema invention
- silent fidelity downgrade to satisfy downstream systems

### 14.3 `prebuild_validator`
Allowed:
- contract checks
- payload shape checks
- representability checks
- policy checks

Forbidden:
- redesign
- semantic reinterpretation
- ranking new page families

### 14.4 `bounded_repair`
Allowed:
- allowed lowerings
- adapters/wrappers
- legal metadata fixes
- legal fragment fixes

Forbidden:
- semantic flattening
- archetype changes
- locked interaction changes
- silent module removal

### 14.5 `build_standalone`
Allowed:
- final artifact packaging

Forbidden:
- semantic redesign
- open-ended repair loops

---

## 15. Existing Generator Integration Requirements

### 15.1 Existing generator preservation

The current generator may remain in place if it:
- accepts metadata and raw HTML fragment
- returns final standalone HTML or error

### 15.2 Required new insertion point

A synthesis stage must be inserted before final raw HTML fragment generation.

### 15.3 Required separation

The raw HTML fragment must no longer be the only representation of intent.

Intent must first exist as a stable planned payload.

### 15.4 Repair strategy

Generator errors must not trigger unconstrained fragment rewriting.

They must be mapped back into:
- plan-level representability issues
- metadata legality issues
- raw fragment legality issues
- allowed lowering requirements

and repaired within the locked plan boundaries.

---

## 16. Sub-Agent vs Tool Decision

### 16.1 Preferred implementation form

The synthesis stage should be implemented first as a tool with a strict contract.

### 16.2 Rationale

A tool provides:
- fixed IO schema
- testability
- repeatability
- easier debugging
- easier logging
- easier versioning
- less drift

### 16.3 Optional future evolution

Internally, the synthesis stage may later use agent-like iterative reasoning, but its public contract must remain strict and schema-bound.

---

## 17. Deliverable Semantics

### 17.1 Final deliverable

The final deliverable is a standalone HTML prototype artifact.

### 17.2 End-user workflow

The non-technical user:
- views the artifact
- uses it as prototype output
- uploads it to JIRA

### 17.3 Consequence

Because the standalone HTML is the final artifact, all meaningful correction must occur before artifact emission.

---

## 18. Minimal Required Loop

The internal iterative loop is:

1. synthesize candidate builder payload
2. run prebuild validation
3. run bounded repair against payload/plan
4. repeat until:
   - builder-safe payload exists, or
   - unresolved locked conflict is raised

Then, and only then:

5. build standalone artifact

---

## 19. Failure Semantics

### 19.1 Honest failure requirement

If the system cannot produce a builder-safe payload without violating locked intent, it must fail honestly.

### 19.2 Forbidden failure mode

The system must not:
- silently simplify
- silently flatten
- silently substitute across semantic classes
- silently remove fidelity-critical modules

### 19.3 Required diagnostic output on failure

On failure, the system should identify:
- unresolved locked fields
- violated builder contracts
- blocked lowerings
- nearest legal alternatives if they exist
- whether degradation would be required

---

## 20. Implementation Priorities for Attempt 6

### 20.1 Keep
- JSONL knowledge pack approach
- current standalone builder
- graph query tool
- metadata + raw HTML fragment builder input shape
- validation, demoted to prebuild contract checking

### 20.2 Add
- synthesis tool
- fixed IR / planning DSL
- prebuild validator
- bounded repair rules
- layout/presentation recipes
- locked/substitutable/optional field model

### 20.3 Remove or prohibit
- freeform generator semantic authority
- dynamic schema invention
- “fix until green” semantics after final artifact build
- validation-led semantic drift
- non-technical dependency on live graph infrastructure

---

## 21. One-Sentence System Definition

This system is a graph-backed prototype synthesis pipeline that projects a scoped view from a canonical codebase graph into a fixed UI planning DSL, iteratively synthesizes and validates a builder-safe payload, and then emits a final standalone HTML artifact without allowing validation pressure to rewrite locked design intent.

---

## 22. Runtime Workflow

### 22.1 End-to-end runtime flow

The runtime flow is:

1. user provides one of:
   - screenshot
   - screenshot + prompt
   - well-known route + prompt

2. `discovery_tool` retrieves the relevant scoped graph slice and evidence

3. `synthesis_tool` produces an initial candidate plan and candidate builder payload

4. `prebuild_validator` evaluates the candidate payload before final artifact emission

5. if validation fails, `bounded_repair` applies only legal repairs against the plan/payload

6. the repaired plan/payload is re-evaluated

7. this loop continues until either:
   - a builder-safe payload is produced, or
   - a locked conflict is identified and surfaced honestly

8. only after a builder-safe payload exists may `build_standalone` be called

9. `build_standalone` emits the final standalone HTML artifact

10. optional final artifact sanity check runs

### 22.2 Required runtime invariant

At no point before final artifact emission may downstream validation pressure silently change locked page semantics.

---

## 23. Internal Back-and-Forth Loop

### 23.1 Loop location

The only meaningful iterative loop is:

`discovery -> synthesis <-> prebuild_validation <-> bounded_repair -> build_standalone`

This loop must terminate before final artifact emission.

### 23.2 Loop contract

Each iteration must preserve:
- locked structural intent
- locked presentation intent
- locked interaction intent
- required state coverage

Each iteration may change only:
- payload legality
- metadata completeness
- wrapper/adapter selection
- approved lowerings
- representation details that do not alter locked meaning

### 23.3 Iteration states

Each synthesis cycle should have a state label:

- `candidate`
- `needs_contract_repair`
- `needs_lowering_repair`
- `blocked_on_locked_conflict`
- `builder_safe`

These states should be represented explicitly in runtime diagnostics.

---

## 24. Pre-Generator Remediation Model

### 24.1 Purpose

All remediation must happen before the final standalone builder is invoked.

The goal is to produce a payload that is already safe for final artifact emission.

### 24.2 Remediation classes

#### Class A: metadata repair
Examples:
- missing required metadata field
- invalid enum value
- malformed route target reference
- missing recipe parameter
- absent state declaration

Allowed action:
- fill or normalize metadata using approved defaults or discovered evidence

#### Class B: fragment legality repair
Examples:
- illegal wrapper arrangement
- unsupported slot nesting
- invalid fragment shape for builder contract
- disallowed container composition

Allowed action:
- re-emit fragment from the same plan using legal wrappers/adapters
- apply approved structural lowering
- insert required container/wrapper

#### Class C: lowering repair
Examples:
- chosen component requires scaffold adapter
- selected motif needs alternate legal expression
- responsive behavior must be lowered differently for builder compatibility

Allowed action:
- choose from approved lowering rules only

#### Class D: equivalence-class substitution
Examples:
- exact component variant not builder-safe
- exact ornamental treatment unsupported
- exact secondary visual treatment unavailable

Allowed action:
- substitute only within declared equivalence classes
- never substitute across semantic classes
- never alter locked page semantics

#### Class E: blocked locked conflict
Examples:
- locked side inspector cannot be represented
- locked primary table view unsupported by legal lowerings
- locked interaction zone conflicts with builder contract
- locked action surface has no legal realization

Required action:
- stop iterative repair
- surface explicit unresolved conflict
- do not silently degrade

### 24.3 Forbidden remediation behavior

Remediation must never:
- change page archetype
- replace primary module type
- remove locked interaction zones
- delete required states
- flatten layout just to satisfy builder legality
- re-interpret the user request under validator pressure

---

## 25. Example Back-and-Forth

### 25.1 Example scenario

User request:
- screenshot + prompt
- prompt asks to add a new bulk action button that routes to an audit flow
- page visually resembles a dense review workbench with right inspector

### 25.2 Discovery output

`discovery_tool` returns:
- candidate page archetype: `review_workbench`
- candidate composition: `dense_table_with_right_inspector`
- action surface candidates:
  - `bulk_actions`
  - `toolbar_actions`
- route target candidate: `audit_workflow`
- presentation clue: `compressed_toolbar`, `dense_data_region`
- policy: bulk actions allowed, destructive actions restricted
- component contract: table supports multi-select and bulk actions

### 25.3 Initial synthesis output

`synthesis_tool` proposes:
- page archetype: `review_workbench`
- composition: `dense_table_with_right_inspector`
- presentation recipe: `workbench_split_dense`
- new action: `send_to_audit`
- attach zone: `bulk_actions`
- target: `audit_workflow`
- locked:
  - page archetype
  - primary table view
  - right inspector
  - bulk action zone
- substitutable:
  - secondary button variant
  - chip style

### 25.4 Prebuild validation failure

`prebuild_validator` returns:
- builder contract requires bulk actions to be wrapped in `SelectionActionRail`
- current payload emitted them directly under toolbar metadata
- result state: `needs_lowering_repair`

### 25.5 Bounded repair

`bounded_repair` applies:
- insert approved `SelectionActionRail` lowering
- preserve action zone semantics as bulk action
- do not move action into top toolbar
- re-emit payload

### 25.6 Second validation pass

`prebuild_validator` returns:
- payload legal
- metadata complete
- builder-safe

### 25.7 Final emission

`build_standalone` is called once with the validated payload

### 25.8 Key takeaway

The system repaired representation-level legality without altering locked page intent.

---

## 26. Required Diagnostics During the Loop

### 26.1 Each synthesis cycle should output diagnostics containing

- current plan id
- current state label
- locked fields summary
- substitutions applied
- lowerings applied
- remaining validation blockers
- whether any degradation risk exists
- whether the payload is builder-safe

### 26.2 Diagnostic requirement

Diagnostics must be machine-readable and storable.

They must be linked to the scoped page/session overlay, not directly committed into canonical graph truth by default.

---

## 27. Graph Representation of Workflow and Next Steps

### 27.1 Workflow graph requirement

The graph system must represent not only components/routes/policies, but also the runtime workflow entities needed for synthesis and remediation.

The canonical or exported graph must include node/edge support for:

#### Workflow nodes
- `WorkflowStage`
- `ValidationRule`
- `RepairRule`
- `LoweringRule`
- `DiagnosticState`
- `ConflictType`
- `ArtifactTarget`

#### Workflow edges
- `precedes`
- `requires`
- `blocks`
- `repaired_by`
- `lowered_by`
- `validates`
- `emits`
- `conflicts_with`

### 27.2 Minimum workflow graph facts

The graph should know facts such as:
- `synthesis_tool` precedes `prebuild_validator`
- `prebuild_validator` blocks `build_standalone` unless builder-safe
- `bounded_repair` may repair `metadata_mismatch`
- `bounded_repair` may repair `lowering_mismatch`
- `bounded_repair` may not repair `locked_archetype_change`
- `build_standalone` emits final artifact for `jira_uploadable_prototype`

### 27.3 Why workflow belongs in the graph

The workflow and remediation rules are part of system truth, not only prose documentation.

Encoding them in the graph allows:
- retrieval during synthesis
- enforcement during repair
- auditable reasoning about why a payload was blocked
- future maintainers to inspect allowed and forbidden transformations

---

## 28. Graph Representation of Next Steps

### 28.1 Next-step entities must be representable

The system should represent implementation next steps as graph-linked planning records so they can be queried, tracked, and related to architectural entities.

### 28.2 Required next-step node types

- `ImplementationTask`
- `Milestone`
- `Dependency`
- `OwnerType`
- `Status`
- `Artifact`
- `Schema`
- `ToolContract`

### 28.3 Required task fields

Each `ImplementationTask` should include:
- stable id
- title
- description
- status
- priority
- dependency ids
- linked architecture section ids
- linked tool ids
- linked artifact/schema ids
- linked policy ids if relevant
- success criteria

### 28.4 Initial next steps to encode

#### Task 1: define synthesis payload schema
- priority: highest
- links:
  - `synthesis_tool`
  - IR/DSL sections
  - locked/substitutable/optional policy
- success criteria:
  - fixed schema exists
  - includes structural, presentation, and control fields

#### Task 2: define prebuild validator contract
- priority: highest
- links:
  - `prebuild_validator`
  - builder contract rules
  - remediation classes
- success criteria:
  - validator can classify failures into supported repair classes

#### Task 3: define bounded repair policy matrix
- priority: highest
- links:
  - `bounded_repair`
  - remediation classes
  - locked conflict rules
- success criteria:
  - allowed vs forbidden repairs are machine-readable

#### Task 4: define layout/presentation recipe schema
- priority: high
- links:
  - presentation system
  - recipe families
  - layout grammar
- success criteria:
  - recipe model supports required slots, optional slots, and bounded parameters

#### Task 5: add workflow/rule nodes to knowledge pack export
- priority: high
- links:
  - workflow graph
  - policy export
  - JSONL packaging
- success criteria:
  - exported snapshot contains queryable workflow and repair rules

#### Task 6: implement synthesis tool with internal loop
- priority: high
- links:
  - discovery output
  - synthesis payload
  - prebuild validator
  - bounded repair
- success criteria:
  - tool returns builder-safe payload or explicit locked conflict

#### Task 7: isolate raw fragment emission behind plan-driven builder
- priority: medium-high
- links:
  - fragment generation path
  - builder payload
  - layout recipes
- success criteria:
  - raw fragment is emitted from plan, not freeform HTML reasoning

#### Task 8: integrate final standalone builder as terminal packaging step
- priority: medium-high
- links:
  - `build_standalone`
  - final artifact model
- success criteria:
  - no semantic redesign occurs after this step

#### Task 9: define minimal artifact sanity checks
- priority: medium
- links:
  - final artifact
  - terminal emission rules
- success criteria:
  - only catastrophic packaging failures are checked post-build

### 28.5 Task graph semantics

The task graph must permit:
- dependency traversal
- status tracking
- retrieval of “what must be true before X exists”
- linking implementation tasks back to architecture and policy entities

---

## 29. Required Pre-Build Gate

### 29.1 Gate definition

The system must have a single explicit gate before `build_standalone`:

`builder_safe_payload == true`

### 29.2 Gate conditions

A payload is builder-safe only if:
- required metadata is present
- raw fragment shape is legal
- lowerings are approved
- wrappers/adapters are satisfied
- locked semantics are preserved
- no unresolved locked conflict exists

### 29.3 Enforcement rule

`build_standalone` must not be callable unless the builder-safe gate is satisfied.

---

## 30. Recommended Implementation Workflow

### 30.1 Immediate implementation order

1. define synthesis payload schema
2. define prebuild validation outputs and error taxonomy
3. define bounded repair policy matrix
4. define recipe schema
5. encode workflow and next-step records into exported graph/JSONL model
6. implement synthesis tool internal loop
7. redirect raw fragment emission to plan-driven generation
8. keep final standalone build terminal

### 30.2 Attempt-6 discipline rule

During implementation, any proposed change must be checked against this question:

`Does this give semantic authority back to the generator or post-build validation path?`

If yes, reject the change.
