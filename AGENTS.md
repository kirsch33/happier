# Happier Engineering Authority

Happier is a cross-device companion for coding agents. Build warm, fast,
understandable product behavior with one canonical owner for each fact or
decision. A similar local workaround, duplicate state owner, or compatibility
path is a correctness bug unless a current released contract requires it.

## Scope and custody

- Follow direct operator steering, then the nearest package instruction file,
  then current code, tests, and primary evidence.
- Preserve unrelated dirty work. Never switch branches, reset, restore, clean,
  or discard another change in the primary checkout.
- Inspect the current owner, callers, readers, writers, tests, and same-concept
  paths before changing behavior. Fix, consolidate, or remove at that owner;
  do not add another decision-maker.
- Answer, review, investigate, and diagnose requests are read-only unless a
  change is requested. For an authorized change, complete the bounded local
  work and relevant safe validation without inventing new process artifacts.
- Treat actual invocation, current working directory, authentication binding,
  and effective execution metadata as evidence. Configuration, sandbox mode,
  and a claimed role constrain intent; they are not proof of isolation, custody,
  or completed work.

## Package instructions

Read the nearest instructions before changing a package:

| Area | Instructions |
|---|---|
| UI | `apps/ui/AGENTS.md` |
| CLI | `apps/cli/AGENTS.md` |
| Server | `apps/server/AGENTS.md` |
| Stack | `apps/stack/AGENTS.md` |
| Docs | `apps/docs/AGENTS.md` |

Use repository skills only when their trigger matches the task. Do not create a
plan file or a parallel execution framework unless the user explicitly asks for
one.

## Implementation and validation

- Production behavior changes use a focused RED → GREEN test at the real owner.
  Content-only or mechanical edits receive proportionate validation.
- Mock genuine system boundaries, not internal logic. Prefer a narrow test that
  could falsify the changed claim; report skipped or failed validation plainly.
- Product runtime paths are binary-safe: do not directly spawn `node`, `npm`,
  `npx`, `pnpm`, `yarn`, or `bunx`.
- Keep compatibility, persistence, encryption, version-skew, and recovery
  behavior only where an actual supported contract requires it. A bounded
  rollback may recover a failed change; it does not justify a permanent legacy
  fallback.
- Prefer deletion and consolidation to speculative abstraction. Do not promote
  a possible consumer, generalized reuse, or imagined scale requirement into a
  product requirement.

## TypeScript compiler ownership

Use repository/package typecheck and build scripts. `yarn tsc ...` is safe from
the repository root and TypeScript-owning workspaces because it uses the native
compiler runner. For an ad hoc check, use
`node scripts/workspaces/runTypeScriptCli.mjs ...`. Do not run bare `tsc`,
`npx tsc`, `node_modules/.bin/tsc`, or `typescript/bin/tsc`: the centrally
resolved native TypeScript 7 compiler is canonical, while the `typescript`
package remains TypeScript 5.9 for programmatic API compatibility.

## Documentation and reporting

- `docs/**` owns internal technical/product architecture. Published user and
  operator documentation belongs in `apps/docs/content/docs/**`.
- Update the canonical affected page with a behavior or contract change; do not
  create a similar-but-different explanation.
- Report the outcome first, then concrete evidence, skipped or failed checks,
  and residual risk. Distinguish observed facts, derived conclusions, and
  assumptions when that distinction affects the next action.
