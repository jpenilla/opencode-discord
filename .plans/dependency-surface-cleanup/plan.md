# Dependency Surface Cleanup Plan

## Goal

Reduce callback-bag construction and function-type noise across the runtime without regressing the
layered architecture already established.

The target is not “more services everywhere.” The target is:

- fewer ad hoc `makeX({ fnA, fnB, fnC })` seams where those functions are already service
  boundaries elsewhere
- less repeated function-signature boilerplate in public and semi-public module APIs
- more direct use of real Effect dependencies at real ownership boundaries
- simpler local composition where a separate injected constructor is not buying anything

The current `App -> Channel -> Session -> Run` plan is treated as complete enough to preserve.
This plan is a cleanup/refinement pass on top of that result.

## Effect 4 Guidance

Based on btca guidance for `effect4`, this pass should **not** convert every functional
constructor into a service graph.

The intended rule is:

- use services/layers for real ownership boundaries
- keep pure composition helpers as plain functions when that is the simpler shape
- prefer eliminating unnecessary callback bags over replacing them with tiny service spam

This means the cleanup should be selective.

## Current Smell

The branch still has several modules with shapes like:

- `makeChannelSettingsRuntime({ ...callbacks })`
- `makeSessionRuntime({ ...callbacks })`
- `createEventHandler({ ...callbacks })`

Those are not all equally problematic.

Some are true implementation factories and are reasonable as plain constructors. Others are mostly
re-expressing already-established services as bags of callback types, which creates:

- noisy type signatures
- repeated “plumbing only” object literals
- weaker readability about which dependencies are real boundaries vs local implementation details

## Working Principles

### Promote Only Real Boundaries

If a module is a stable owner or exported capability boundary, prefer real service/layer
dependencies over anonymous callback bags.

Examples in scope:

- channel-facing settings mutation
- session-owned public bridge/facet assembly
- persistence boundaries that already exist conceptually

### Keep Pure Adapters Functional

If a module is just composing already-local behavior and has no independent lifecycle or boundary,
keep it functional.

Examples likely to stay functional:

- command dispatch wrappers
- event demux/router assembly if it remains local and obvious
- pure formatting/payload helpers

### Prefer Collapsing Over Abstracting

If a constructor exists only to forward callbacks once, collapse it into the owning layer rather
than introducing another service just to satisfy the type system.

This pass should bias toward deleting plumbing, not inventing it.

## Candidate Areas

### High Priority

1. `src/channels/channel-settings-runtime.ts`

Current issue:

- `makeChannelSettingsRuntime` mostly mirrors already-real dependencies:
  - channel settings persistence
  - session channel bridge

Likely cleanup:

- stop passing raw callback bags there
- either:
  - give it direct Effect dependencies as a real channel-layer service, or
  - collapse it into the owning channel layer if keeping it separate no longer buys clarity

Decision bias:

- settled: collapse it into the owning channel layer
- do not preserve it as a standalone service once the callback bag is removed

2. `src/sessions/session-runtime.ts`

Current issue:

- `makeSessionRuntime` takes a large callback object that is mostly assembling behavior already
  owned inside `SessionRuntimeLayer`

Likely cleanup:

- reduce the callback bag significantly
- keep the public session facets (`SessionChannelBridge`, `SessionRunAccess`) intact
- move assembly closer to the internal session owner so the callback bag is no longer the main API

Decision bias:

- settled: do not replace it with many tiny services
- delete `makeSessionRuntime` and assemble `SessionChannelBridge` / `SessionRunAccess`
  directly inside `SessionRuntimeLayer`
- prefer direct closure capture from the owning layer over a separate callback-bag constructor

### Medium Priority

3. `src/sessions/event-handler.ts`

Current issue:

- still accepts a broad dependency object, though it is now a pure demux

Likely cleanup:

- decide whether this remains a reasonable local composition point
- if it stays functional, tighten the dependency object to match the demux role only
- if it does not buy enough clarity, inline its assembly closer to the session layer

Decision bias:

- keep functional if the dependency shape stays small and honest

4. `src/opencode/service.ts`

Current issue:

- `makeOpencodeService` takes a large input bag, but this may be acceptable because it is the
  concrete implementation factory for a real owner

Likely cleanup:

- probably leave functional
- only revisit if the dependency bag is carrying avoidable top-level noise rather than actual
  implementation inputs

Decision bias:

- not a priority unless a later pass shows it is still misleading

## Non-Goals

- do not rebuild the runtime into a deeper service graph just because Effect 4 supports it
- do not undo the `App -> Channel -> Session -> Run` layering work
- do not merge boundaries that are now honest and useful
- do not preserve callback bags just because they are easy to test if they are otherwise pure
  plumbing noise

## Proposed Phases

### Phase 1: Inventory And Classification

1. Enumerate the remaining callback-heavy constructors/factories.
2. Classify each as one of:
   - real boundary service
   - local composition helper
   - redundant adapter that should be collapsed
3. Record the intended disposition before making broad edits.

### Phase 2: Clean Real Boundary Wiring

1. Replace callback bags that merely mirror real ownership boundaries with actual service/layer
   dependencies.
2. Prefer existing honest services/facets over creating new ones.
3. Keep public dependency surfaces smaller, not larger.
4. For the current pass, this specifically means:
   - collapse `ChannelSettingsRuntime` into `ChannelRuntime`
   - inline session bridge assembly into `SessionRuntimeLayer`

### Phase 3: Collapse Redundant Adapters

1. Inline or localize tiny `makeX({...})` wrappers that exist only to thread callbacks once.
2. Remove repeated function-signature aliases when a narrower local helper or direct closure is
   clearer.
3. Reduce noise in layer assembly code.

### Phase 4: Re-Audit Naming And Surface Area

1. Rename any remaining helpers whose names imply ownership they do not have.
2. Remove obsolete helper types introduced only to support the old callback-bag style.
3. Re-check whether any service still exists only as an adapter and should be collapsed.

## Verification Requirements

### Architecture Verification

1. No new broad umbrella service is introduced.
2. The `App -> Channel -> Session -> Run` boundaries remain intact.
3. Services exist only where there is a real ownership/capability boundary.
4. Pure adapters do not become service-shaped just for dependency injection aesthetics.
5. The number and size of callback-object constructor signatures is materially reduced.

### Behavioral Verification

1. `bun run check`
2. targeted tests for any refactored constructor/owner boundaries
3. read-only review for accidental over-abstraction or new sideways dependencies

## Review Questions During Implementation

1. Is this constructor a real boundary, or only a local composition helper?
2. Am I replacing callback spam with a cleaner dependency shape, or just moving the spam into
   service declarations?
3. Would inlining/localizing this assembly be simpler than inventing another service?
4. Is the resulting API smaller and more honest than what it replaced?

## Expected End State

- fewer callback-bag constructors
- smaller function-type surfaces
- clearer distinction between real services and local helpers
- no regression in the established layered architecture

## Open Questions

Both previously open questions are now settled for implementation:

1. `ChannelSettingsRuntime` should be collapsed into `ChannelRuntime`.
2. `makeSessionRuntime` should be removed, with session bridge assembly moving directly into
   `SessionRuntimeLayer`.
