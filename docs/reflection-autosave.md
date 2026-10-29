# Reflection saving

Reflection input updates React state and the existing version-3 local draft
immediately. Unsent edits are coalesced for 700 ms. Blur, visibility loss,
page hide and in-app navigation flush the latest pending value into the
existing serialized session save queue. Other progress saves remain immediate.

The queue continues to use exact acknowledged bytes as its CAS base. A local
edit advances the revision before any network request, so an old response
cannot clear a newer draft or mark it saved. Errors retain the draft and the
existing retry/conflict UI. Two conflicting versions require an explicit
choice; there is no silent overwrite or automatic conflict retry.

Acknowledged saves update the local session summary (identity, completion and
update time). They do not refresh the route library or intent options. The
library is still read on startup, route/session creation, opening the drawer
and explicit navigation where a fresh snapshot is needed. Concurrent stale
library reads are invalidated when a save acknowledgement updates the cache.

## Lifecycle limits

Page lifecycle events start a best-effort flush. Small session requests use
fetch keepalive; larger payloads use normal fetch. Browser termination,
offline access, storage eviction, private-mode restrictions and the aggregate
keepalive budget can still prevent the network request from completing.
`beforeunload` is not a durability guarantee. The synchronous local draft and
its remote CAS base are the recovery path. Keep this browser's cookies and
storage to recover guest progress; use Retry saving after an unsynced recovery.

## Repeatable checks

From the repository root, with dependencies installed and Node >=22.13:
The explicit type-stripping flag is needed on Node 22.16 and also works on
the current managed runtime (Node 24.22.1). Without it, older Node 22 releases
cannot directly load the `.ts` modules imported by these tests. The commands
below were executed on Node 24.22.1; Node 22.16 is not installed in that
environment and was not separately verified.

```sh
node --experimental-strip-types scripts/test-reflection-autosave.mjs
node --experimental-strip-types scripts/test-reflection-editor.mjs
node --experimental-strip-types scripts/test-route-library.mjs
node --experimental-strip-types scripts/test-public-release.mjs
node --experimental-strip-types scripts/test-acquired-walk.mjs
node node_modules/typescript/bin/tsc --noEmit
npm run build
```

`build` is the existing package.json script. The current project does not
define npm test scripts for the five checks above. The debounce script counts
15 executed assertions through its `eq` helper; the printed count is not a
count of test cases or source lines. No extra assertions are needed to make
that total match an earlier report.

The debounce tests use a deterministic clock. The public-release suite also
executes the shipped page's actual edit/draft/save functions against real
SQLite and the shipped Drizzle actions, including readback, failed transport,
retry, delayed acknowledgements and competing-tab CAS. They make no live
Qloo calls. The test harness extracts the page functions using the TypeScript
AST; it does not replace the save algorithm with a second implementation.

These tests establish deterministic client behavior and actual SQLite action
semantics. They do not by themselves establish deployed HTTP persistence,
browser lifecycle delivery, browser rendering or physical-device behavior.
Those require separate application/browser verification.
