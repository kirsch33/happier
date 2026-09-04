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
- On the RPi, run only one resource-heavy validation process at a time. Inspect
  load and available memory first, give typechecks and builds a sensible
  timeout, and stop a check that ceases making progress before starting another
  validation. Treat integration-test setup that builds packages as a build.
- The RPi session is also the operator's communication path. Never run a build,
  typecheck, or other memory-heavy job inside the live session runner's cgroup
  or as a foreground tool call. Launch it as a detached, bounded native service
  in the dedicated build slice, inspect it with short status/log reads, and
  return to a message boundary every 30–60 seconds. A progressing build is not
  permission to strand queued steering.
- Product runtime paths are binary-safe: do not directly spawn `node`, `npm`,
  `npx`, `pnpm`, `yarn`, or `bunx`.
- Keep compatibility, persistence, encryption, version-skew, and recovery
  behavior only where an actual supported contract requires it. A bounded
  rollback may recover a failed change; it does not justify a permanent legacy
  fallback.
- Prefer deletion and consolidation to speculative abstraction. Do not promote
  a possible consumer, generalized reuse, or imagined scale requirement into a
  product requirement.

## Great White Lab update runbook

This section is the single operator runbook for building and updating the
Great White Lab Happier installation. Do not create a second host note, helper
script, copied source tree, or remembered alternate procedure.

### Installed topology and invariants

- `/root/happier` on `rpi` is the only source checkout and build authority.
- The RPi runs `happier-daemon.default.service` as root. `debian-dev` runs the
  same user service as `akirsch` and also owns the `happier-server-dev.service`
  relay. Preserve those service accounts during an update.
- Happier is intentionally absent from `win-dev` and `akirsch-desktop` WSL.
  Do not reinstall it there as part of fleet convergence.
- The active server profile is `greatwhitelab`. Authentication, machine
  identities, relay data, session records, and the database must survive an
  update unchanged.
- Each development CLI install retains only `current` and `previous` under
  `.happier/cli-dev/versions`. Source, build output, extracted payloads, and
  server generations each have one owner and a bounded retained set.

Treat source commit, release artifact, installed CLI pointer, daemon process,
active session runner, relay process, and UI bundle as separate identities. A
new daemon does not make an existing session runner new, and a healthy relay
process does not prove it opened the incumbent database.

### Before changing anything

1. Read this file, `/root/AGENTS.md`, the touched package instructions, and the
   current release/runtime code. Confirm `/root/happier` is clean or identify
   every unrelated edit before touching it.
2. Fetch upstream and compare upstream changes, issues, and pull requests with
   every local patch. Reapply only behavior still required; prefer the upstream
   owner when it now solves the problem. Keep one coherent `dev` branch and
   one checkout.
3. Inventory both hosts: architecture, free bytes, load, available memory,
   installed `current` and `previous`, shim resolution, unit contents and user,
   daemon/relay PIDs and executable paths, relay database identity and backup,
   and every active or paused session with its runner executable path.
4. Tell the operator before stopping or respawning any other session. Paused
   in the UI is not proof that its process is quiescent. Interactive remote
   work uses the single batched `gwl-access` authority from `/root/AGENTS.md`;
   never replace it with direct SSH or an overnight prompt.
5. State the rollback source and the exact equality boundary: same accounts,
   machines, sessions, auth, relay URL, database, and operator routes; only the
   intended source/artifact/process versions change.

### Version and artifact rules

- Allocate one immutable version for all components built from a source commit.
  A private dev build must remain comparable by every shipped reader; use
  `X.Y.Z-dev.<monotonic-number>.<hex-commit>`. Do not insert a label such as
  `.gwl.` into the prerelease identifiers. Validate the candidate with the UI
  version comparator before building.
- Preview and dev share npm's `next` tag. Update checks must filter the returned
  version by the selected release channel. A dev CLI must not offer a preview
  build as an update. Fix the channel decision at its shared owner; do not hide
  the symptom by disabling update checks or dismissing the UI warning.
- Build through the repository release pipeline, for example
  `node scripts/pipeline/run.mjs release-build-cli-binaries --channel dev
  --version <version> --targets linux-arm64,linux-x64` and, when the relay
  changed, `release-build-server-binaries --channel dev --version <version>
  --targets linux-x64`. Do not assemble payload trees by hand.
- Before a broad build on the RPi, inspect load, available memory, swap, and
  disk. Run one heavy job at a time with a sensible timeout. Start with the
  narrowest relevant test; a CLI typecheck can consume several GiB and must be
  stopped if it ceases making progress. Never overlap a stalled typecheck,
  build, Git operation, or release gate with another heavy check.
- Keep daemon/control-plane processes in `happier-critical.slice`, interactive
  session runners in `happier-jobs.slice`, and builds/typechecks in the sibling
  `happier-build.slice`; verify the actual `/proc/<pid>/cgroup` placement before
  relying on it. The build slice must impose an explicit CPU quota, low CPU/IO
  weights, memory high/max limits, and a bounded swap limit. Start the build as
  a detached `systemd-run --user` service with `Slice=happier-build.slice`, a
  unique unit name, the repository working directory, and the outer timeout.
  Never place a build in the protected control-plane slice, leave it inside an
  interactive runner's scope, or run it unscoped. If isolation cannot be proven
  with a harmless transient command first, do not start the heavy job.
- The current CLI bundle takes about 18 minutes on the RPi while remaining
  CPU-active; pkgroll's 10-minute default is therefore too short on this host.
  For the one canonical versioned CLI build, set
  `HAPPIER_CLI_PKGROLL_TIMEOUT_MS=1200000` and inspect the detached unit, its
  cgroup, CPU, available memory, and saved output at least every 30–60 seconds
  using short reads. Do not attach a long-lived foreground poll, raise the
  bound, or retry merely because pkgroll is quiet. Once
  `apps/cli/dist/.build-manifest.json` records
  the intended version, the multi-target release command must reuse that dist;
  stop and diagnose if packaging starts another full CLI bundle.
- Verify artifact architecture, archive root, embedded version, and checksum
  before promotion. Cross-compiled x64 payloads are supported. `EACCES` under
  `runuser` previously came from inheriting `/root` as the working directory,
  not from cross-compilation; do not rebuild merely because an inaccessible
  cwd prevented execution.

### Promotion order

1. Build and test in `/root/happier`; bank and push the coherent source commit
   before treating its artifacts as an installed release.
2. Protect and identify the live relay database, then update the Debian relay
   with the product-owned `happier relay host install --mode user
   --channel dev --server-binary <path>` flow. Preserve the existing unit
   environment and bind address. Verify migrations, database inode/owner/mode,
   auth, machine list, sessions, HTTP health, WebSocket behavior, and real UI
   login before retiring the previous relay payload or rollback volume.
3. Extract each signed/checksummed CLI archive into a temporary directory and
   run that payload's `self __install-payload --component happier-cli
   --payload-root <root> --version <version> --channel publicdev`. Let the
   installer atomically advance `current`, retain `previous`, repair shims, and
   prune older generations. Do not copy the binary, edit the pointer, or pin a
   generated unit manually.
   Before promotion, compare every live session runner path with the two
   generations the installer will retain. Do not promote while it would prune
   files used by a live third-oldest runner; quiesce that session first.
4. On Debian, execute install and service commands as `akirsch` with
   `HOME=/home/akirsch`, `USER=akirsch`, `LOGNAME=akirsch`, the canonical
   Happier bin path, `XDG_RUNTIME_DIR=/run/user/1000`, the matching user-bus
   address, and an accessible working directory such as `/home/akirsch`. Use a
   transient `systemd-run --user --wait --pipe --collect` scope when entering
   through the root access gateway. Never invoke the user payload while the
   process cwd remains `/root`.
5. Restart each daemon through its existing generated service. Confirm the
   configured and running versions, actual executable path, service user,
   `currentInvocationMatches`, unit reload state, relay reachability, and
   machine registration. Do not infer success from `active (running)`.
6. Existing sessions keep the executable and MCP bridge with which they were
   spawned. Gracefully stop and resume-fresh every retained session after its
   host daemon is proven, with operator notice for other sessions. Confirm each
   new process path and advertised metadata version; a daemon restart alone is
   not fleet convergence.
7. Prove the real surfaces: send and receive in each retained session, open the
   session UI without a CLI warning, exercise a tiny read-only Happier-managed
   run, and check `happier status --json`. Both a UI “CLI Update Required”
   warning and `cli_self_update_available` are failed gates until explained and
   corrected at their source.

### Responsiveness and warning correctness

- Viewing a Session must not launch continuation-inspection RPCs. Hover, focus,
  or `onPressIn` is the earliest legitimate demand signal for the Agent picker.
- Advisory inspection RPCs need both admission control and a hard deadline. A
  reconnect or status refresh must not admit another copy of the same exact
  question while its predecessor is still running. A transport failure is
  indeterminate; it is not proof that the CLI needs an update.
- If daemon logs show `session.continuation.inspect` calls materially outnumber
  returns, stop heavy work, confirm its process group exited, inspect the saved
  log and static daemon state, and restart only the daemon if recovery requires
  it. Do not use repeated live-status polling against a backed-up daemon.
- Count compactions from the provider rollout, not from guessed UI meaning: one
  lifecycle can contain a started and completed record, while separate rollout
  timestamps are separate provider compactions. A compaction is not evidence
  that Happier retried or redelivered a Pending message. Check provider turn ids
  and Pending custody before making either claim.
- Do not repeatedly resume a provider thread that already compacted during a
  failed recovery attempt and then made no progress. Once its runner is absent,
  use the existing fail-closed `session resume-fresh` path when its exact
  preconditions hold: the same Happier session, one known Pending operator
  message, and a newly proven provider id. Never discard or merge operator
  messages to manufacture those preconditions, and never invent an automatic
  context-reset policy from the number of compaction rows.
- “CLI Update Required” is valid only for a parseable runner version proven
  older than the required version. Unknown or malformed metadata must not be
  relabeled as old. The warning must state the exact runner version and minimum;
  an installed daemon version never substitutes for the Session runner version.

### Debian relay and session safety

The relay update is a stateful production-boundary change. Before replacement,
record the unit, container/process identity, environment key names, database
path/inode/size/owner/mode, migration state, bind address, and a usable backup.
After replacement, compare all of them and exercise Authentik login plus an
incumbent session. Fresh/default/empty state is failure: restore the predecessor
instead of declaring the new process healthy.

Do not let relay work implicitly restart Debian agent sessions. CLI promotion
may advance the daemon while sessions remain on their old runners; coordinate
their later stop/resume explicitly. Keep the RPi root-owned daemon and Debian
`akirsch`-owned daemon as-is unless the operator separately authorizes an
account migration.

### Completion and cleanup

An update is complete only when source, artifacts, installed pointers, daemons,
relay, active session runners, advertised metadata, UI, and update diagnostics
agree on a valid channel/version; incumbent auth/data/session capabilities work;
and a fresh managed run succeeds.

Then remove temporary extraction trees, build staging, superseded artifacts,
duplicate clones, obsolete Bun/package caches created by the work, old payloads
beyond `current` plus `previous`, and any temporary rollback whose retirement
condition passed. Preserve engine-owned live relay data and the one required
known-good generation. Report retained byte/count limits and final free space.
Do not defer producer cleanup to generic trash expiry or another host sweep.

The `kirsch33/happier` fork's default branch intentionally contains no
`.github/workflows` files unless the operator deliberately restores one.
GitHub's workflow API may still label deleted historical registrations
`active`; verify the default-branch tree and absence of newer runs instead of
mistaking that label for a runnable workflow. Replay the workflow-deletion
commit after upstream integration if the merge restores those files. Local
Great White Lab builds are not GitHub release evidence. After any temporary CI
use, delete artifacts once their named consumer and rollback window end; do not
buy minutes or retain multi-gigabyte test matrices by default.

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
