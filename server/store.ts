import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

export class CoordinatorLock {
  readonly path: string;
  readonly owner = randomUUID();
  constructor(root: string) { this.path = join(root, "coordinator.lock"); }
  acquire(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    try { mkdirSync(this.path, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const record = readJson<{ pid: number }>(join(this.path, "owner.json"));
      if (!record) throw new Error("编排状态锁缺少所有者；需要人工检查，不能抢占");
      throw new Error(`状态目录仍登记进程 ${record.pid}；先核对旧进程和未完成操作，再由用户移走遗留的 coordinator.lock，不自动抢占`);
    }
    saveJson(join(this.path, "owner.json"), { owner: this.owner, pid: process.pid });
  }
  release(): void {
    if (readJson<{ owner: string }>(join(this.path, "owner.json"))?.owner === this.owner) rmSync(this.path, { recursive: true });
  }
}
