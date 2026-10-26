import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CoordinatorLock, readJson, saveJson } from "../server/store.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.test-work/store");
after(() => rmSync(root, { recursive: true, force: true }));

function workspace(t: { after: (fn: () => void) => void }): string {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "run-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid);
  await new Promise<void>(finish => child.once("exit", () => finish()));
  return pid;
}
function writeOwner(directory: string, record: unknown): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "owner.json"), typeof record === "string" ? record : JSON.stringify(record));
}
function leaveLock(directory: string, record: unknown): void {
  writeOwner(join(directory, "coordinator.lock"), record);
}
function lockOwner(directory: string): { owner: string; pid: number } {
  return readJson<{ owner: string; pid: number }>(join(directory, "coordinator.lock", "owner.json"))!;
}

test("a lock left by an exited process is reclaimed while orchestration state is preserved", async t => {
  const directory = workspace(t);
  leaveLock(directory, { owner: "crashed coordinator", pid: await exitedPid() });
  saveJson(join(directory, "orchestration.json"), { schemaVersion: 1, tasks: {}, messages: {}, seen: ["kept"] });
  const lock = new CoordinatorLock(directory);
  lock.acquire();
  assert.deepEqual(lockOwner(directory), { owner: lock.owner, pid: process.pid });
  assert.deepEqual(readJson<{ seen: string[] }>(join(directory, "orchestration.json"))!.seen, ["kept"]);
  assert.equal(existsSync(join(directory, "coordinator.lock.recovering")), false);
  lock.release();
  assert.equal(existsSync(join(directory, "coordinator.lock")), false);
});

test("a live owner, a malformed record and an unreadable record all block a second coordinator", async t => {
  const directory = workspace(t);
  const first = new CoordinatorLock(directory);
  first.acquire();
  assert.throws(() => new CoordinatorLock(directory).acquire(), /活动进程/);
  assert.equal(lockOwner(directory).owner, first.owner);
  first.release();
  for (const record of [{ owner: "stale", pid: 0 }, { pid: 42 }, "{\"owner\":", "not a record"]) {
    writeOwner(join(directory, "coordinator.lock"), record);
    assert.throws(() => new CoordinatorLock(directory).acquire(), /人工检查/);
  }
});

test("a recovery attempt never deletes a lock another coordinator already owns", async t => {
  const directory = workspace(t);
  leaveLock(directory, { owner: "crashed coordinator", pid: await exitedPid() });
  const winner = new CoordinatorLock(directory);
  winner.acquire();
  assert.throws(() => new CoordinatorLock(directory).acquire(), /活动进程/);
  assert.equal(lockOwner(directory).owner, winner.owner);
  assert.equal(existsSync(join(directory, "coordinator.lock.recovering")), false);
  winner.release();
  const next = new CoordinatorLock(directory);
  next.acquire();
  assert.equal(lockOwner(directory).owner, next.owner);
  next.release();
});

test("an abandoned recovery marker is cleared only after the process that wrote it exited", async t => {
  const directory = workspace(t);
  leaveLock(directory, { owner: "crashed coordinator", pid: await exitedPid() });
  const marker = join(directory, "coordinator.lock.recovering");
  writeOwner(marker, { owner: "crashed recoverer", pid: process.pid });
  assert.throws(() => new CoordinatorLock(directory).acquire(), /活动进程/);
  assert.equal(lockOwner(directory).owner, "crashed coordinator");
  writeOwner(marker, { owner: "crashed recoverer", pid: await exitedPid() });
  const lock = new CoordinatorLock(directory);
  lock.acquire();
  assert.deepEqual(lockOwner(directory), { owner: lock.owner, pid: process.pid });
  assert.equal(existsSync(marker), false);
  lock.release();
});

test("an unreadable recovery marker keeps the state directory closed", async t => {
  const directory = workspace(t);
  leaveLock(directory, { owner: "crashed coordinator", pid: await exitedPid() });
  writeOwner(join(directory, "coordinator.lock.recovering"), "{\"owner\":");
  assert.throws(() => new CoordinatorLock(directory).acquire(), /人工检查/);
  assert.equal(lockOwner(directory).owner, "crashed coordinator");
});
