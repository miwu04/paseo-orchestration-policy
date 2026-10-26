import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaseoApi, PaseoAgentHandle, PaseoAgentSendOptions, PaseoAgentTimelineHandle } from "@getpaseo/client";
import { transport } from "../server/transport.ts";

function partialSdk<T extends object>(implementation: Partial<T>): T { return implementation as T; }
type Page = Awaited<ReturnType<PaseoAgentTimelineHandle["refetch"]>>;
type Entry = Page["entries"][number];

function entry(text: string): Entry {
  return partialSdk<Entry>({ item: partialSdk<Entry["item"]>({ type: "assistant_message", text }) });
}

test("a recipient becoming busy uses steering instead of default interruption and retains sender identity", async () => {
  let interrupted = false;
  let received: { body: string; sender?: string; id?: string } | null = null;
  const client = partialSdk<PaseoApi>({ agents: partialSdk<PaseoApi["agents"]>({ ref: () => partialSdk<PaseoAgentHandle>({
    async send(body: string, options?: PaseoAgentSendOptions) {
      if (options?.activeTurnBehavior !== "steer") interrupted = true;
      received = { body, sender: options?.sourceAgentId, id: options?.messageId };
    },
  }) }) });
  await transport(client).send("parent", "Child completed", "stable-message", "child");
  assert.equal(interrupted, false);
  assert.deepEqual(received, { body: "Child completed", sender: "child", id: "stable-message" });
});

test("history paging returns complete chronological output and rejects a changing history epoch", async () => {
  const earlier = entry("earlier");
  const later = entry("later");
  const pages: Array<Pick<Page, "entries" | "hasOlder" | "startCursor">> = [
    { entries: [later], hasOlder: true, startCursor: { epoch: "one", seq: 10 } },
    { entries: [earlier], hasOlder: false, startCursor: { epoch: "one", seq: 1 } },
  ];
  const client = partialSdk<PaseoApi>({ agents: partialSdk<PaseoApi["agents"]>({ ref: () => partialSdk<PaseoAgentHandle>({
    timeline: partialSdk<PaseoAgentTimelineHandle>({ async refetch() { return partialSdk<Page>(pages.shift()!); } }),
  }) }) });
  const result = await transport(client).report("agent");
  assert.equal(result[0], earlier);
  assert.equal(result[1], later);
  pages.push(
    { entries: [later], hasOlder: true, startCursor: { epoch: "one", seq: 10 } },
    { entries: [entry("replacement")], hasOlder: false, startCursor: { epoch: "two", seq: 1 } },
  );
  await assert.rejects(transport(client).report("agent"), /分页位置变化/);
});
