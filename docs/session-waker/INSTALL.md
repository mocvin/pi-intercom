# Waking persisted sessions — install, roll out, roll back

## Prerequisites
- This fork checked out and installed (`npm ci`). Prefer a separate deploy checkout (for example a `git worktree` of a tag) over the development working copy.
- PI WEB, if you use the built-in `pi-web-sessiond` provider.

## Verify (isolated)
```sh
scripts/test-isolated.sh     # full suite without touching a live broker
scripts/e2e/run.sh           # isolated PI WEB daemon + broker: the whole wake flow (23 checks)
scripts/e2e/run.sh busy      # sessions that are already open: streaming, compaction, open form, missing command
```
Do not run `npm test` directly from inside a Pi session: `PI_CODING_AGENT_DIR` would point the tests at the live broker.

## Install
1. In `~/.pi/agent/settings.json`, replace `npm:pi-intercom` with the path of this fork. The two cannot be installed together (same tools).
2. Restart **only the intercom broker**. It is a detached process that keeps running its old code while it answers health checks:
   ```sh
   node_modules/.bin/tsx scripts/ops/restart-broker.ts /abs/path/to/this/fork   # add --check to print the resolved paths only
   ```
   It holds the broker spawn lock during the swap, so a reconnecting session cannot start a broker from its own (older) package in the gap. Sessions are not interrupted and reconnect on their own; the broker's in-memory state (held mailbox messages, pending asks) is lost. Do **not** restart the PI WEB session daemon.
3. `/reload` the sessions that should send wakes. Reopened sessions load the new code anyway.
4. Enable it in `~/.pi/agent/intercom/config.json`:
   ```json
   { "wake": { "enabled": true, "allowCwds": ["/abs/project/dir"], "confirm": "always", "sessiondSocket": "/home/<user>/.pi-web/sessiond.sock" } }
   ```
   A daemon started with its default socket does not export `PI_WEB_SESSIOND_SOCKET` to its sessions, so set `sessiondSocket` explicitly; without it the provider answers `unavailable`.
5. Optional: in a session that should wake others without a dialog (for example a coordinator), run `/wake-trust on` and confirm. Revoke with `/wake-trust off` or `/wake-trust revoke <id>`.
6. Check: `/intercom-wake-status`, and `node_modules/.bin/tsx scripts/ops/probe-broker.ts` (features and roster size). For a first real wake of a session you choose: `node_modules/.bin/tsx scripts/ops/verify-wake.ts <piSessionId> <abs cwd>` (the script itself is the confirmation).

## Roll back
1. `wake.enabled: false` turns the feature off; the fork then behaves like upstream.
2. To remove the fork: restore `npm:pi-intercom` in `settings.json`, restart only the broker with `scripts/ops/restart-broker.ts <path of the installed pi-intercom package>`, then `/reload`.
3. Held messages expire after 24 hours or can be cancelled with `intercom({ action: "cancel", messageId })`.
4. Woken sessions are ordinary sessions; rolling back does not change their files.

## Uninstall
Roll back, then delete `wake-audit.jsonl`, `wake-trust.json` and the `wake` section of `intercom/config.json` if you want. There is no other persistent state.

## Diagnose
- `/intercom-wake-status`: settings, broker support for `wake-v1`, recent attempts.
- `wake-audit.jsonl`: one line per step (`attempting` is the reservation, then the outcome) with `outcome`, `code`, `messageId`, `target`, `daemon`, `durationMs`; never the text.
- Blocking codes: `wake_disabled`, `broker_unsupported`, `cwd_not_allowed`, `possible_secret`, `confirmation_unavailable`, `not_found`, `ambiguous`, `archived`, `self_target`, `duplicate`, `rate_limited_target`, `rate_limited_global`, `provider_unavailable`, `provider_unsupported`, `audit_unavailable`.
- `uncertain` / `accepted_unconfirmed`: the message is still held; do not resend it.
