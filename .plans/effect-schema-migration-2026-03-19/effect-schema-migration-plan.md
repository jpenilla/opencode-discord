# Effect Schema Migration Plan

## Purpose

This document defines the staged migration from `valibot` and ad hoc JSON parsing in the tool bridge to Effect-native schema and JSON handling.

The plan is intended to be executable by either:

- an engineer working directly in the repo
- a coding agent making the migration with minimal additional product guidance

## Goals

Primary goals:

- eliminate the current `tsgo` JSON parsing warnings by replacing raw `JSON.parse` and `JSON.stringify` usage in warned bridge paths with Effect-native schema mechanisms
- replace current `valibot` usage with Effect Schema for consistency
- end with one validation stack in the migrated areas

Success means all of the following are true:

- no remaining `effect(preferSchemaOverJson)` warnings in the migrated scope
- no remaining `valibot` usage in the migrated scope
- bridge validation and JSON handling are expressed in Effect-native patterns

## Scope

Initial migration scope:

- all current `valibot` usage
- all currently warned JSON parsing or stringifying sites from `tsgo`

Concrete starting files:

- `src/tools/bridge/validation.ts`
- `src/tools/bridge/routes.ts`
- `src/tools/bridge/handlers/assets.ts`
- `src/tools/bridge/handlers/messages.ts`
- `src/tools/bridge/handlers/uploads.ts`
- `test/tools/bridge/validation.test.ts`
- any additional bridge tests that need adjustment once the migration is complete

Out of scope for the main migration:

- broad repo-wide schema rewrites outside the current `valibot` and warned sites
- hiding existing JSON-string tool responses behind generic abstractions just to silence warnings

The plan ends with a follow-up exploration step for other places where broader consistency work may be worth doing next.

## Locked Decisions

These decisions are already made and should not be reopened during implementation unless a hard blocker appears:

- Use Effect-native schema and JSON handling rather than keeping `valibot`.
- Prefer builtin Effect idioms and mechanisms over custom compatibility layers or attempts to reproduce `valibot` behavior exactly.
- Unknown object keys should be rejected as invalid in migrated request validation paths. This is intentional and should help the LLM use the tool more correctly.
- Validation should report all relevant issues at once where practical rather than forcing one-error-at-a-time retries.
- Exact validation wording does not need to match the current `valibot` output.
- Exact HTTP status codes do not need to remain unchanged, but the resulting behavior should be at least as sensible as the current behavior.
- Redesigning helper APIs around Effect-native patterns is allowed and preferred if it improves the end state.
- Avoid test churn until the end of the staged migration where practical.
- Leave the attachment-list JSON-string response alone unless there is an obviously clean and clear improvement. If that area changes later, prefer having the tool code own the stringification rather than introducing hidden json-string-in-json abstraction.

## Desired End State

By the end of the migration:

- bridge request and header payload schemas are defined with Effect Schema
- JSON text decoding in the bridge uses Effect Schema JSON transformations rather than direct `JSON.parse`
- any JSON text encoding in the migrated warning sites uses Effect-native schema encoding rather than direct `JSON.stringify`
- bridge validation flow is centered on Effect-native parse or decode results
- `valibot` is removed from the dependency graph if it no longer has any remaining usage

## Recommended Direction

The migration should bias toward a small number of explicit primitives:

- Effect Schema definitions for request and header payloads
- one Effect-native bridge validation path that converts schema failures into bridge response errors
- one Effect-native JSON text decode path for request bodies and encoded header payloads
- Effect-native JSON text encode only where it is directly replacing a warned site and remains locally clear

Avoid recreating `valibot` APIs in Effect form. The point is to converge on Effect-native code, not to preserve the previous helper style.

## Staged Plan

### Stage 1. Establish Effect-native bridge parsing primitives

Goals:

- introduce the Effect-native JSON text decode and validation path needed by the bridge
- clear the design for how multi-issue validation errors are surfaced
- keep `valibot` in place temporarily only where that reduces churn while the new path is established

Work:

- design the new bridge parsing flow around Effect Schema rather than `safeParse`
- replace direct JSON text parsing in:
  - `src/tools/bridge/validation.ts`
  - `src/tools/bridge/transport.ts`
- choose the Effect-native failure surface for collecting and formatting all issues
- keep the new implementation simple and idiomatic, even if helper names or signatures change

Guidance:

- reject unknown keys in migrated object payloads
- collect all validation issues
- do not spend time preserving exact legacy error wording
- do not update tests yet unless necessary to keep the repo in a runnable state

Expected result:

- the migration direction is real, not speculative
- the warned `JSON.parse` sites are either already converted or have a clear shared primitive ready for the schema rewrite

### Stage 2. Convert bridge schemas from `valibot` to Effect Schema

Goals:

- replace all current bridge `valibot` schemas with Effect Schema
- move route parsing and payload typing fully onto Effect-native code

Work:

- convert schema definitions in:
  - `src/tools/bridge/validation.ts`
  - `src/tools/bridge/handlers/assets.ts`
  - `src/tools/bridge/handlers/messages.ts`
  - `src/tools/bridge/handlers/uploads.ts`
  - `src/tools/bridge/routes.ts`
- update bridge route helpers so request parsing is centered on Effect Schema, not generic `valibot` schema plumbing
- remove now-obsolete `valibot`-specific formatting and helper logic

Guidance:

- prefer a cleaner Effect-native API over preserving the exact helper shapes from the `valibot` version
- keep the resulting flow locally explicit enough that a bridge route is still easy to read
- reject extra input keys instead of silently preserving or stripping them

Expected result:

- the bridge validation path is fully Effect-native
- there is no remaining `valibot` usage in production code

### Stage 3. Resolve warned JSON stringification site with a clear end state

Goals:

- eliminate the remaining `tsgo` warning around JSON stringification without obscuring behavior

Work:

- revisit the `JSON.stringify` site in `src/tools/bridge/handlers/messages.ts`
- choose the clearest of:
  - Effect-native JSON text encoding in place
  - a local restructuring that keeps the tool’s response shaping explicit and avoids hidden json-string-in-json behavior

Guidance:

- do not introduce abstraction whose main value is to hide the stringification
- if a structural change is cleaner than a direct encode replacement, prefer the structural change

Expected result:

- no remaining `effect(preferSchemaOverJson)` warnings in the initial scope

### Stage 4. Update tests and finish cleanup

Goals:

- absorb the intentional behavior and messaging changes into the test suite
- remove migration leftovers

Work:

- update bridge validation tests to assert the new Effect-native behavior rather than `valibot` wording
- update any route or handler tests affected by:
  - unknown-key rejection
  - changed validation messages
  - changed status-code choices where the new outcome is clearer
- remove obsolete helpers, imports, and types
- remove the `valibot` dependency if no uses remain

Guidance:

- accept test churn here instead of earlier
- prefer fewer, clearer assertions over carrying forward exact string snapshots that only reflected `valibot`

Expected result:

- repo tests describe the new intended behavior instead of the previous library’s error surface
- `valibot` is fully gone if the migration completed cleanly

### Stage 5. Follow-up consistency review

Goals:

- note other areas where the same Effect-native schema approach may be worth applying later

Work:

- inspect the rest of the repo for:
  - raw `JSON.parse` or `JSON.stringify` patterns that should move to Effect-native handling
  - validation paths that are still inconsistent with the new bridge direction
  - opportunities to adopt the same schema or JSON conventions more broadly
- record findings and recommendations without expanding the main migration scope by default

Expected result:

- a clear next-step list for broader consistency work
- the main migration remains bounded and finishable

## Implementation Priorities

When tradeoffs appear, prioritize in this order:

1. Effect-native end state
2. clear multi-issue validation feedback
3. simpler bridge design
4. minimal compatibility with old wording or helper shapes
5. minimized diff size

## Verification Strategy

Verification should happen at the end of each stage where it is useful, with the bulk of test expectation churn deferred until Stage 4.

Minimum verification before closing the migration:

- run `tsgo -p tsconfig.json`
- run the bridge-focused tests
- run any additional targeted tests touched by route or handler behavior changes
- confirm there are no remaining `valibot` imports or dependency usage in the migrated scope

## Risks And Watchouts

- Effect Schema defaults differ from the current `valibot` behavior, especially around excess properties. This change is intentional here, but it should be applied deliberately rather than accidentally.
- Error formatting can drift into unnecessary custom code if the implementation tries to imitate `valibot`. Avoid that.
- A too-generic “schema route” abstraction could make the bridge harder to read than it is now. Keep route parsing explicit enough to follow.
- Test updates should happen once the behavior has stabilized, not piecemeal throughout the migration.

## Completion Criteria

This plan is complete when:

- the initial migration scope no longer uses `valibot`
- the current `tsgo` JSON warnings in scope are gone
- bridge validation is Effect-native and reports all relevant issues together
- the test suite has been updated to reflect the new intended behavior
- follow-up consistency opportunities have been documented separately from the completed migration
