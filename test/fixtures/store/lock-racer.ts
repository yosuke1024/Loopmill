// A10 fixture: one process that opens the given db, waits until a synchronised start time, then
// calls `acquireLock` once and prints the outcome. `test/store/lock-race.test.ts` spawns two of
// these (via `node`, type-stripped directly) against the same db file and the same start time so
// their `acquireLock` calls land as close to simultaneously as two OS processes can manage, then
// asserts exactly one printed "acquired" and the other printed the holder it lost to.
//
// argv: [dbPath, loopId, runId, startAtEpochMs, nowRfc3339, leaseUntilRfc3339]

import { openStore } from "../../../src/store/sqlite.ts";

const [dbPath, loopId, runId, startAtEpochMsStr, now, leaseUntil] = process.argv.slice(2);

if (!dbPath || !loopId || !runId || !startAtEpochMsStr || !now || !leaseUntil) {
  console.error("usage: lock-racer.ts <dbPath> <loopId> <runId> <startAtEpochMs> <now> <leaseUntil>");
  process.exit(2);
}

const startAtEpochMs = Number(startAtEpochMsStr);

// Busy-wait (not setTimeout — this is a race, not a schedule) until the synchronised start time
// so both processes' acquireLock calls are as close together as possible.
while (Date.now() < startAtEpochMs) {
  // spin
}

const store = openStore(dbPath, { host: "racer-host", pid: process.pid });
const result = store.acquireLock({ loopId, runId, ownerPid: process.pid, host: "racer-host", now, leaseUntil });
store.close();

if (result.acquired) {
  console.log("acquired");
} else {
  console.log(`holder:${JSON.stringify(result.holder)}`);
}
