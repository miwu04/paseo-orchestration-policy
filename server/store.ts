import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const pending = `${path}.${randomUUID()}.pending`;
  try {
    writeFileSync(pending, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(pending, path);
  } finally { rmSync(pending, { force: true }); }
}

type LockRecord = { owner: string; pid: number };
function readRecord(directory: string): LockRecord | null {
  let value: { owner?: unknown; pid?: unknown } | null;
  try { value = readJson(join(directory, "owner.json")); }
  catch { return null; }
  if (!value || typeof value.owner !== "string" || !value.owner) return null;
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return null;
  return { owner: value.owner, pid: value.pid };
}
// "unknown" keeps recovery fail-closed: EPERM and unexpected errors never mean the owner is gone.
function processAlive(pid: number): boolean | "unknown" {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : "unknown"; }
}

export class CoordinatorLock {
  readonly path: string;
  readonly owner = randomUUID();
  private readonly recordPath: string;
  private readonly recoveryPath: string;
  constructor(root: string) {
    this.path = join(root, "coordinator.lock");
    this.recordPath = join(this.path, "owner.json");
    this.recoveryPath = `${this.path}.recovering`;
  }
  private writeRecord(pid: number): void { saveJson(this.recordPath, { owner: this.owner, pid }); }
  private tryCreate(): boolean {
    try { mkdirSync(this.path, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    this.writeRecord(process.pid);
    return true;
  }
  private reclaim(stale: LockRecord): void {
    try { mkdirSync(this.recoveryPath, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      this.clearAbandonedRecovery();
      try { mkdirSync(this.recoveryPath, { mode: 0o700 }); }
      catch { throw new Error(`另一个恢复操作正在使用 ${this.recoveryPath}；不能同时回收，先核对状态目录`); }
    }
    try {
      saveJson(join(this.recoveryPath, "owner.json"), { owner: this.owner, pid: process.pid, target: stale.owner });
      const current = readRecord(this.path);
      if (!current || current.owner !== stale.owner || current.pid !== stale.pid || processAlive(current.pid) !== false) throw new Error("锁记录在核对后发生变化；保留原状态，不回收");
      rmSync(this.path, { recursive: true });
      if (!this.tryCreate()) throw new Error("回收过程中锁被其他进程取得；保留其记录并停止");
    } finally {
      if (readRecord(this.recoveryPath)?.owner === this.owner) rmSync(this.recoveryPath, { recursive: true });
    }
  }
  private clearAbandonedRecovery(): void {
    if (!existsSync(this.recoveryPath)) return;
    const record = readRecord(this.recoveryPath);
    if (!record) throw new Error(`遗留的回收标记 ${this.recoveryPath} 缺少可识别的记录；需要人工检查，不能抢占`);
    const alive = processAlive(record.pid);
    if (alive !== false) throw new Error(alive ? `回收标记仍登记活动进程 ${record.pid}；不能抢占` : `无法确认回收进程 ${record.pid} 已退出；需要人工检查`);
    rmSync(this.recoveryPath, { recursive: true });
  }
  acquire(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (this.tryCreate()) return;
    const record = readRecord(this.path);
    if (!record) throw new Error(`状态锁 ${this.path} 缺少可识别的所有者记录；需要人工检查，不能抢占`);
    const alive = processAlive(record.pid);
    if (alive !== false) throw new Error(alive ? `状态目录仍登记活动进程 ${record.pid}；不能抢占` : `无法确认进程 ${record.pid} 是否已退出；需要人工检查，不能抢占`);
    this.reclaim(record);
  }
  release(): void {
    if (readRecord(this.path)?.owner === this.owner) rmSync(this.path, { recursive: true });
  }
}
