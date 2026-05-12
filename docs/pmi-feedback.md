# PMBOK-Informed Governance Overlay for the piorx Agentic Coding Workflow Specification

## 1. Purpose

This artifact defines the governance, control, and delivery-management overlay for the piorx workflow specification. Its purpose is to strengthen the existing architecture with explicit decision rights, scope boundaries, risk controls, quality criteria, and change control so that the workflow can operate as a governed system rather than only as a technical orchestration model.

This overlay does not replace the engineering specification. It complements it. The engineering specification remains the source of truth for runtime architecture, stage implementation, schemas, and platform constraints. This overlay defines how that architecture is governed, approved, evaluated, and changed.

## 2. Objective

The objective of piorx is to convert user intent into either a validated analysis deliverable or a controlled code change through a staged, auditable, policy-constrained workflow. The system is intended to support software engineering work while preserving bounded autonomy, human accountability, and traceable decision-making.

The workflow must therefore satisfy two goals at the same time. It must be technically composable enough to support multiple workflow patterns and extensions, and it must remain operationally controlled enough to satisfy organizational expectations for safety, quality, and auditability.

## 3. Guiding Principles

The workflow is governed by the following principles.

The orchestrator remains source-blind unless explicitly authorized by platform policy. Coordination logic must not implicitly inherit code access simply because downstream workers require it.

All material workflow outputs are treated as controlled artifacts. Artifacts must be schema-validated, immutable after issuance, and linked through lineage sufficient to reconstruct how a result was produced.

Approval is explicit, not inferred. Any stage that materially changes risk posture, execution readiness, or delivery commitment must produce a reviewable artifact and a recorded gate outcome.

Least privilege applies to source access, tool use, execution authority, and override rights. Extensions may add behavior, but they may not silently weaken mandatory controls.

Workflow definitions are managed assets. Once workflows become declarative, they must be versioned, reviewed, approved, and traceable like other controlled system specifications.

Control rigor should be risk-based. Low-impact advisory workflows may require lighter governance than workflows that can execute code changes, affect protected repositories, or alter system behavior.

## 4. Scope

The governance overlay applies to all piorx workflows that produce analysis, recommendations, code change proposals, or executable changes against a software codebase. It applies to default workflows, advisor workflows, recursively promoted workflows, and extensions registered within the platform.

This overlay governs workflow design, execution authority, review gates, audit evidence, extension conformance, and workflow change management.

This overlay does not define repository-specific coding standards, CI/CD implementation details, or enterprise security policy in full. Those remain governed by the relevant engineering, platform, and enterprise policy authorities. However, any such external policy that affects workflow behavior must be referenceable from the workflow control record.

## 5. Intended Outcomes

A conforming workflow should produce outcomes that are understandable, reviewable, and governable. It should be possible to determine what the workflow attempted to do, what evidence it used, what decisions were made, who or what made those decisions, what exceptions occurred, and why the final result was permitted or blocked.

A conforming workflow should also support operational predictability. Reviewers should know what each stage is expected to produce. Operators should know what conditions trigger escalation. Extension authors should know which controls are fixed and which are configurable. Users should understand whether they are receiving advice, a proposed change, or an executed result.

## 6. Stakeholders and Roles

The **Requestor** is the person or system submitting the initial intent. The Requestor is responsible for providing sufficient business or technical context to initiate work and for reviewing outcomes when the workflow requires user confirmation.

The **Workflow Owner** is accountable for the design and fitness of a workflow definition. This role approves the intended use, control profile, and lifecycle of the workflow. The Workflow Owner is responsible for ensuring that the workflow’s design aligns with platform constraints and governance requirements.

The **Policy Authority** defines mandatory control requirements, such as approval obligations, prohibited actions, evidence retention rules, least-privilege expectations, and override constraints. This role may be fulfilled by a human governance body, an enterprise policy engine, or a combination of both.

The **Reviewer or Approver** evaluates artifacts at designated gates and records a disposition such as approved, rejected, conditionally approved, or escalated. This role is responsible for the decision at that gate and for any rationale required by policy.

The **Execution Authority** is the role permitted to authorize transition from a validated proposal to actual code execution or application of a change. This authority may be the same as the Reviewer in some contexts, but it must be explicitly assigned.

The **Extension Author** creates or modifies workflow definitions, stages, or advisors. This role may propose behavior but may not unilaterally weaken mandatory platform controls.

The **Operator or Maintainer** is responsible for runtime reliability, platform health, and operational support. This role is accountable for incident response, observability, and the integrity of workflow execution infrastructure.

## 7. Decision Rights

Decision rights must be explicit and non-overlapping where possible.

The Requestor may submit intent, clarify requirements, and accept or reject outputs where the workflow calls for requestor confirmation. The Requestor does not automatically have authority to waive policy controls.

The Reviewer may approve or reject stage outputs within the gate authority assigned to that stage. Reviewer authority does not imply authority to alter platform control policy.

The Execution Authority may authorize code execution only when all mandatory preconditions have been satisfied or a documented exception path has been invoked through approved governance.

The Workflow Owner may approve changes to workflow design within the scope of delegated governance. Changes that affect mandatory controls, source access rules, audit requirements, or approval thresholds must also be approved by the Policy Authority.

The Policy Authority may define which controls are mandatory, which are tailorable, and which exceptions require escalation beyond the workflow itself.

## 8. Operating Modes

piorx workflows should declare an operating mode because governance requirements depend on the mode of operation.

In **Advisory Mode**, the system may analyze context and provide recommendations, reports, or options, but it may not execute code changes. Outputs from this mode are informational unless separately approved for promotion into a stronger workflow.

In **Supervised Change Mode**, the system may prepare proposed changes, validation outputs, and execution-ready artifacts, but actual code execution requires explicit approval by the designated authority.

In **Constrained Autonomous Mode**, the system may execute changes within a pre-approved scope, bounded environment, and defined policy thresholds. This mode requires the strongest control conditions, the clearest audit evidence, and explicit predefinition of rollback, escalation, and stop conditions.

A workflow must not implicitly move from one operating mode to another. Promotion between modes must itself be a controlled event.

## 9. Workflow Governance Model

Each workflow definition must be treated as a controlled specification containing both orchestration semantics and governance semantics.

The orchestration semantics define stage sequence, dependencies, recursion rules, and artifact flow. The governance semantics define entry criteria, gate obligations, approval requirements, access policy references, failure disposition, and evidence requirements.

A workflow definition may be configurable, but mandatory platform controls must be externalized from extension-authored logic wherever possible. Workflow authors may select among approved policies; they may not redefine mandatory controls as optional.

Where there is conflict between workflow configuration and platform policy, platform policy prevails.

## 10. Stage Control Contract

Each stage must have a formal control contract. This contract should be defined in the workflow specification or in a referenced schema profile.

The contract must include the stage purpose and the business or operational reason the stage exists. It must define required inputs, permitted tools or capabilities, and any source-code access conditions. It must define mandatory validations and the exact type of output artifact expected.

Each stage must also define entry criteria and exit criteria. Entry criteria determine when the stage may begin. Exit criteria determine when the stage may be considered complete. Completion is not sufficient on its own; each stage must also define acceptance criteria that establish whether the output is fit for downstream consumption.

The contract must define failure handling behavior. This includes whether the stage may retry, whether it may emit a tentative result, whether it must halt, and what escalation path applies if the stage cannot satisfy its contract.

The contract must define audit metadata requirements, including the identity of the actor or component performing the stage, timestamps, input references, policy references, and any recorded rationale required for downstream review.

## 11. Quality and Acceptance Criteria

A workflow is only governable if quality expectations are explicit. Each material artifact must therefore have acceptance criteria appropriate to its role.

Analysis artifacts should be complete enough to support reviewer understanding of intent, assumptions, risks, and recommended action. A partial analysis that cannot justify downstream action must be labeled accordingly and must not be treated as execution-ready.

Proposed change artifacts should identify the intended modification, expected impact, affected scope, validation status, and known limitations. If the system cannot establish sufficient confidence or evidence, the artifact must reflect that uncertainty clearly rather than presenting a false sense of readiness.

Execution results should record what was attempted, what actually occurred, whether the result matched the approved scope, and what residual issues remain. If execution deviates materially from the approved proposal, the workflow must flag the deviation and trigger review according to policy.

Quality checks should be aligned with the risk and impact of the workflow. Higher-risk workflows should require stronger validation, stronger evidence, and stricter approval conditions.

## 12. Risk Management Framework

The workflow system must manage risk explicitly rather than only indirectly through architecture.

Each workflow definition should identify relevant risk categories, including incorrect analysis, unsafe code generation, incomplete repository understanding, policy bypass, secrets exposure, malformed artifacts, insufficient audit evidence, budget exhaustion, escalation failure, and rollback failure.

Each identified risk should have an owner, a trigger condition, a response strategy, and where applicable a tolerance threshold. Response strategies may include avoidance, mitigation, transfer, acceptance, or escalation. Residual risk must be visible when a workflow proceeds despite unresolved uncertainty.

Risk severity should influence control rigor. Workflows with high-impact code changes, sensitive repositories, or large uncertainty should require stronger evidence and more restrictive approvals than low-risk advisory workflows.

Exceptions and overrides are themselves risk events. Any override should record what risk was accepted, by whom, on what basis, and within what scope.

## 13. Escalation and Exception Handling

The workflow must define when it can proceed, when it must pause, and when it must escalate.

Escalation is required when the workflow encounters ambiguity that materially affects scope, safety, policy conformance, execution readiness, or audit completeness. Escalation is also required when a stage cannot satisfy required validations, when an extension attempts a prohibited action, or when an override would exceed delegated authority.

Exception handling must distinguish between technical failure and governance failure. A timeout, parser failure, or transient dependency issue is not the same as a missing approval, policy violation, or unbounded access request. The workflow should route those classes of failure differently.

No exception path should silently convert a blocked workflow into a permitted workflow. Exception paths must remain visible and reviewable.

## 14. Audit and Traceability Requirements

All workflow runs must produce sufficient evidence to reconstruct what happened and why. The audit model should support operational review, governance review, and incident analysis.

At minimum, the workflow record should capture the initiating request, workflow version, operating mode, stage sequence, artifact lineage, approvals and rejections, override events, policy references, source-access events, execution actions, and final disposition.

Decision traceability must be preserved. It should be possible to determine which artifact supported a given approval, what rationale was recorded, and what policy basis was invoked.

Change traceability must also be preserved. If a workflow definition, gate rule, access profile, or schema changes, the version active at the time of execution must be reconstructable.

Audit evidence should be tamper-resistant to the extent required by platform and organizational policy.

## 15. Change Control for Workflow Definitions

Workflow definitions, stage schemas, gate rules, and access-policy mappings are controlled assets and must be subject to integrated change control.

Each controlled element should have a baseline version and change history. Proposed changes should include a reason for change, expected benefit, affected controls, backward compatibility implications, and any operational or policy impact.

Changes that alter only descriptive text or non-material metadata may follow a lightweight approval path. Changes that affect stage behavior, approval logic, access boundaries, artifact requirements, or escalation rules must undergo formal review and approval by the appropriate authorities.

Emergency changes may be permitted only under a defined emergency procedure and must be reviewed retrospectively.

No workflow change should be deployed without identifying the transition impact on active or in-flight workflow runs.

## 16. Extension Conformance Model

Extensions are allowed to increase capability but not to degrade baseline control integrity.

An extension must declare what stages, artifacts, workflows, or advisors it introduces or modifies. It must identify any requested source-access permissions, additional tool use, and policy dependencies.

Before an extension is approved for use, it must be evaluated for conformance with mandatory platform controls. This evaluation should confirm that the extension preserves required gates, audit obligations, least-privilege expectations, and escalation behavior.

Extensions should be assigned a control profile appropriate to their risk. Advisory extensions may require lighter scrutiny than extensions that influence execution readiness or modify code.

Recursive promotion and advisor delegation must be constrained so that an extension cannot create an unreviewed pathway to stronger authority than it was granted.

## 17. Metrics and Performance Management

The workflow should be managed as an operational system with measurable performance and control indicators.

Useful measures include cycle time by stage, approval latency, rejection rate, override rate, validation failure rate, execution success rate, rollback frequency, evidence completeness, and policy exception frequency. Additional quality measures may include post-change defect rate, escaped issue rate, and reviewer rework rate.

Metrics should be interpreted carefully. A lower approval time is not automatically better if it is achieved by weakening controls. A low rejection rate is not automatically better if reviewers are under-challenging weak artifacts.

Measures should support continuous improvement of both throughput and governance quality.

## 18. Lessons Learned and Continuous Improvement

The workflow system should accumulate learning from real usage. Patterns of repeated override, frequent validation failure, unclear artifacts, recurring escalation, and extension misuse should be reviewed periodically.

Lessons learned should feed back into workflow design, stage contract improvement, schema refinement, approval criteria, and training for users and reviewers.

Continuous improvement should not bypass change control. Improvement recommendations become proposed changes and should be evaluated through the defined governance process.

## 19. Recommended Minimum Control Baseline

Any workflow that can affect code or execution outcomes should, at minimum, include explicit operating mode declaration, stage-level entry and exit criteria, at least one reviewable decision gate before execution, immutable artifact lineage, source-access restriction by policy, recorded approval disposition, exception logging, and workflow version traceability.

Any workflow that can execute changes should additionally include rollback or recovery expectations, execution authority assignment, validation evidence requirements, and post-execution result recording.

## 20. Open Design Questions for Team Resolution

Several decisions should be resolved explicitly by the team before finalizing the specification.

The team should decide whether source-access policy is owned primarily by stage definition, runtime policy, or a layered combination of both. The answer affects extension safety and control enforceability.

The team should decide which overrides are permissible within workflow execution and which require external governance approval. This will determine how much autonomy the platform can safely support.

The team should decide whether tentative artifacts are allowed after failed validation and, if so, how they are labeled and prevented from being misused as approved deliverables.

The team should decide the minimum audit record required for regulated or high-scrutiny environments, since that requirement may materially affect schema design and storage behavior.

The team should decide the formal promotion rules between advisory, supervised, and constrained autonomous modes, because this transition is one of the highest-governance moments in the system.

## 21. Closing Position

The piorx architecture already establishes a credible controlled workflow foundation. This overlay strengthens that foundation by adding governance semantics: who decides, what evidence is required, what risk is tolerated, how change is managed, and how extensions remain safe.

With this overlay in place, the workflow specification can serve not only as an engineering design but as an operational contract between product, engineering, governance, and platform stakeholders.
