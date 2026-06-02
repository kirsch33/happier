# HSTACK QoL Backlog

Prioritized lifecycle and ergonomics backlog from the 2026-06-02 hstack-QoL round 1 audit. Task 2 items are intentionally not fixed here.

## P0

### 1. Stack archive can move the active development worktree

- Symptom: `hstack stack archive hstack-qol-probe-codex --json` archived the throwaway stack and also moved the current `local/hstack-qol` checkout into `workspace/archive/worktrees/...`, briefly removing the working directory from under the agent.
- Suspected root: `archiveStack` collects `HAPPIER_STACK_REPO_DIR` and archives any workspace worktree referenced by the stack after moving the stack dir, even when that worktree is the caller's current checkout or has uncommitted changes (`apps/stack/scripts/stack.mjs:1358`, `apps/stack/scripts/stack.mjs:1457`).
- Rough effort: Medium.
- Value: Prevents accidental worktree disappearance during cleanup of throwaway stacks and avoids a high-risk footgun for long-running agents.

### 2. Active-but-frozen sessions have no first-class "wake or repair" path

- Symptom: `happier resume <id>` rejects sessions that are still marked active, even when the runner is gone or live RPC is unavailable.
- Suspected root: resume hard-stops on `rowModel.active === true` (`apps/cli/src/cli/commands/resume.ts:167`) while attach/send/recovery paths separately handle stale active sessions.
- Rough effort: Medium.
- Value: Converts "active but inert" sessions from an operator-only recovery problem into an explicit safe workflow.

### 3. Daemon respawn is autonomy-critical but disabled by default and poorly surfaced

- Symptom: the first throwaway kill proof did not recover until `HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED=1` was set; the stopped session looked like a self-driving failure rather than a disabled safety knob.
- Suspected root: `startDaemon` parses `HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED` with default `false` (`apps/cli/src/daemon/startDaemon.ts:2573`) and stack status does not highlight that active autonomy recovery is off.
- Rough effort: Small to medium.
- Value: Makes fleet/autonomy expectations visible and prevents false confidence after restarts.

### 4. Stack archive stop did not kill a respawned session runner

- Symptom: after stopping the throwaway stack, port `33117` was clear but the respawned Codex runner remained orphaned under PID 1 until manually terminated.
- Suspected root: stop kills recorded daemon/server process groups but daemon-spawned child tracking can be lost when the daemon is killed first, especially after respawn (`apps/stack/scripts/utils/stack/stop.mjs`, `apps/cli/src/daemon/processSupervision/sessionRunnerRespawn.ts`).
- Rough effort: Medium.
- Value: Ensures "no persistent second server/session" teardown is reliable and stack-scoped cleanup does not leave background agents alive.

### 5. Stack-scoped CLI commands can fall back to the wrong relay context

- Symptom: early `stack auth/status` probing fell back to the live `127.0.0.1:3005` context when the throwaway stack was not fully pinned/running.
- Suspected root: stack-scoped `happier` env defaults are seeded only when no explicit selection/defaults exist (`apps/stack/scripts/happier_main.mjs:387`, `apps/stack/scripts/happier_main.mjs:405`), and several status/auth paths still tolerate global active-server defaults.
- Rough effort: Medium.
- Value: Protects live campaign relays from accidental read/write bleed-through during isolated stack work.

## P1

### 6. Native goal requires an active Codex app-server thread before it can be set

- Symptom: `session.goal.set` failed on a newly created Codex session until one bootstrap `session send` created an active thread.
- Suspected root: Codex app-server goal control throws when `activeThreadId` is missing (`apps/cli/src/backends/codex/appServer/runtime.ts:3285`), while `session create` does not expose a goal-on-create path.
- Rough effort: Medium.
- Value: Makes autonomous session launch a single operation and removes a brittle bootstrap turn.

### 7. `--activate-runtime` rejects partial server/daemon activation

- Symptom: `--activate-runtime` with only `--server` or `--daemon` is rejected, even when a current snapshot could safely reuse missing components.
- Suspected root: build target parsing requires web, server, and daemon whenever `--activate-runtime` is set (`apps/stack/scripts/build/build_targets.mjs:46`), while the runtime activation command itself supports component selection.
- Rough effort: Medium.
- Value: Reduces rebuild cost and operator friction after targeted CLI/server changes.

### 8. Typecheck/build lanes do not preflight memory or set required heap consistently

- Symptom: CLI test setup and typecheck can OOM without `NODE_OPTIONS=--max-old-space-size=4096`; the stack typecheck runner simply forwards `process.env` to package scripts.
- Suspected root: stack typecheck delegates to the package manager without a memory policy (`apps/stack/scripts/typecheck.mjs:135`) while only Expo has explicit heap handling.
- Rough effort: Small.
- Value: Avoids WSL OOM cascades and makes canonical lanes safer under concurrent campaign load.

### 9. `stack start --background` can report success before daemon/auth health is truly settled

- Symptom: a throwaway start returned a log path even when later daemon auth validation failed, requiring log spelunking and auth reseeding.
- Suspected root: background startup returns after launching the runner, while daemon auth gating and autostart retries happen later inside `run.mjs` (`apps/stack/scripts/run.mjs:525`).
- Rough effort: Medium.
- Value: Makes stack startup trustworthy and gives direct remediation when auth seed/copy is invalid.

### 10. Fresh source stack defaults can fail on missing UI build

- Symptom: the first throwaway source start needed `--no-ui`; otherwise startup tried to use UI artifacts that were not present.
- Suspected root: source start defaults include UI unless explicitly disabled, while server-only/CLI proof stacks are common and should not require a UI build.
- Rough effort: Small.
- Value: Faster, less surprising ephemeral proof stacks and lower memory pressure.

### 11. Auth copy/reseed ergonomics are fragile for server-light SQLite stacks

- Symptom: the throwaway stack needed forced offline `copy-from dev-auth` to seed usable account rows after an invalid-token failure.
- Suspected root: credential-file copy and database account seeding are related but separate paths; invalid existing credentials can block startup before auto-seed repairs the local DB.
- Rough effort: Medium.
- Value: Makes new isolated stacks reliably authenticated without operator trial and error.

## P2

### 12. Session action CLI input shape is easy to get wrong

- Symptom: `session actions execute <id> <action> '{json}' --json` returns generic `invalid_parameters`; the actual syntax requires `--input-json`.
- Suspected root: action execution validates the action payload but does not print field-level errors or accept a common positional JSON shorthand (`apps/cli/src/cli/commands/session/actions/execute.ts`).
- Rough effort: Small.
- Value: Saves repeated CLI retries during diagnostics and scripted operations.

### 13. Goal token-budget UX is hard to reason about

- Symptom: a small 6k budget was exhausted with `tokensUsed` far above budget after one simple filesystem action, marking the goal blocked.
- Suspected root: native app-server budget accounting is provider-level and not normalized to user expectations; CLI surfaces raw numbers without guidance.
- Rough effort: Small to medium.
- Value: Prevents accidental blocked goals and improves autonomy-budget planning.

### 14. `hstack stack stop` and `stack archive` need clearer dry-run/teardown summaries

- Symptom: stop reported stack server/daemon killed while a child runner remained; archive reported worktree movement only after doing it.
- Suspected root: summaries focus on stack-owned top-level processes and do not preflight or fail on current-worktree/archive hazards.
- Rough effort: Medium.
- Value: Gives operators a reliable "what will be touched" contract before cleanup commands mutate local state.

### 15. Stack build prerequisite probe can lose nvm Node PATH

- Symptom: seeded observation from the campaign: stack-build prerequisite probing can run under a login shell that drops the intended Node 22 path.
- Suspected root: environment scrubbing/bootstrap chooses stack-managed defaults in some paths but does not consistently preserve the operator's selected Node binary.
- Rough effort: Medium.
- Value: Reduces false build failures and avoids accidental older Node usage.

### 16. Post-rebuild stack-scoped `happier` can hit module-resolution drift

- Symptom: seeded observation: `hstack stack happier` hit a Zod `ERR_MODULE_NOT_FOUND` edge after rebuild.
- Suspected root: stack-scoped CLI execution can mix source TSX, generated dist, and dependency state; module resolution is sensitive to install/build timing.
- Rough effort: Medium.
- Value: Makes stack-scoped control commands reliable immediately after rebuilds.
