import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { cswapInstanceId, type CswapAccount } from "../provider/cswapAccounts.ts";
import { planClaudeAccountFallback } from "./ClaudeAccountFallbackWorker.ts";

const now = DateTime.makeUnsafe("2026-10-13T12:00:00.000Z");
const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");
const rootNodeId = NodeId.make("node-root-2");
const driver = ProviderDriverKind.make("claudeAgent");

const thread = {
  id: threadId,
  providerInstanceId: cswapInstanceId(1),
  modelSelection: {
    instanceId: cswapInstanceId(1),
    model: "claude-opus-4-1",
    options: [{ id: "effort", value: "high" }],
  },
  archivedAt: null,
  deletedAt: null,
};

const run = (overrides: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run => ({
  id: runId,
  threadId,
  ordinal: 2,
  providerInstanceId: cswapInstanceId(1),
  modelSelection: thread.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("message-1"),
  rootNodeId,
  activeAttemptId: null,
  status: "running",
  requestedAt: now,
  startedAt: now,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
  ...overrides,
});

const itemBase = {
  id: TurnItemId.make("item-1"),
  threadId,
  runId,
  nodeId: rootNodeId,
  providerThreadId: null,
  providerTurnId: null,
  parentItemId: null,
  ordinal: 4,
  title: "Usage limit",
  startedAt: now,
  completedAt: now,
  updatedAt: now,
};

const pausedNotice: OrchestrationV2TurnItem = {
  ...itemBase,
  type: "system_notice",
  status: "completed",
  message: "Claude usage limit reached. This turn is paused until the 5-hour limit resets in 2h.",
  nativeItemRef: { driver, nativeId: "usage-limit:turn-1:five_hour:1760000000", strength: "weak" },
};

const failedItem: OrchestrationV2TurnItem = {
  ...itemBase,
  type: "error",
  status: "failed",
  nativeItemRef: null,
  failure: {
    class: "usage_limit",
    message: "Claude usage limit reached.",
    code: "blocking_limit",
    retryable: null,
  },
};

const account = (
  overrides: Partial<CswapAccount> & Pick<CswapAccount, "number">,
): CswapAccount => ({
  email: `account${overrides.number}@example.com`,
  label: `account${overrides.number}@example.com`,
  active: false,
  disabled: false,
  usageStatus: "ok",
  fiveHourPercent: 10,
  sevenDayPercent: 10,
  ...overrides,
});

const accounts = [
  account({ number: 1, fiveHourPercent: 100, active: true }),
  account({ number: 3 }),
];
const availableInstanceIds = new Set([cswapInstanceId(1), cswapInstanceId(3)]);

const plan = (overrides: Partial<Parameters<typeof planClaudeAccountFallback>[0]> = {}) =>
  planClaudeAccountFallback({
    item: pausedNotice,
    thread,
    runs: [run({ id: RunId.make("run-0"), ordinal: 1, status: "completed" }), run()],
    fromAccountNumber: 1,
    accounts,
    availableInstanceIds,
    excludedAccountNumbers: new Set(),
    ...overrides,
  });

describe("planClaudeAccountFallback", () => {
  it("restarts a paused turn on another account and says so in the thread", () => {
    const result = plan();
    expect(result?.fromAccount.number).toBe(1);
    expect(result?.toAccount.number).toBe(3);
    expect(result?.command).toMatchObject({
      type: "message.dispatch",
      threadId,
      dispatchMode: { type: "restart_active", targetRunId: runId },
      modelSelection: { ...thread.modelSelection, instanceId: cswapInstanceId(3) },
      text: "account1@example.com reached its Claude usage limit, so this thread switched to account3@example.com. Continue where you left off.",
      createdBy: "user",
      creationSource: "server",
    });
    // Repeated notices for one attempt dispatch the same command, which the receipt store dedupes.
    expect(plan()?.command.commandId).toBe(result?.command.commandId);
  });

  it("continues a run that failed on the limit with a new run", () => {
    const result = plan({ item: failedItem, runs: [run({ status: "failed", completedAt: now })] });
    expect(result?.command).toMatchObject({ dispatchMode: { type: "start_immediately" } });
  });

  it("ignores a limit that no longer belongs to the thread's current attempt", () => {
    // The run already restarted onto a new root node.
    expect(plan({ runs: [run({ rootNodeId: NodeId.make("node-root-3") })] })).toBeNull();
    // A later run exists.
    expect(plan({ runs: [run(), run({ id: RunId.make("run-2"), ordinal: 3 })] })).toBeNull();
    // The paused run already ended, or the failed run is still going.
    expect(plan({ runs: [run({ status: "interrupted" })] })).toBeNull();
    expect(plan({ item: failedItem, runs: [run({ status: "running" })] })).toBeNull();
  });

  it("does nothing when no other account can take over", () => {
    expect(
      plan({ accounts: [accounts[0]!, account({ number: 3, sevenDayPercent: 100 })] }),
    ).toBeNull();
    expect(plan({ excludedAccountNumbers: new Set([3]) })).toBeNull();
    expect(plan({ availableInstanceIds: new Set([cswapInstanceId(1)]) })).toBeNull();
  });

  it("leaves threads off cswap accounts and archived threads alone", () => {
    expect(plan({ fromAccountNumber: null })).toBeNull();
    expect(plan({ thread: { ...thread, archivedAt: now } })).toBeNull();
    expect(
      plan({
        item: { ...pausedNotice, nativeItemRef: { driver, nativeId: "other", strength: "weak" } },
      }),
    ).toBeNull();
    expect(
      plan({
        item: { ...failedItem, failure: { ...failedItem.failure, class: "provider_error" } },
        runs: [run({ status: "failed" })],
      }),
    ).toBeNull();
  });

  it("moves a thread on the default Claude login using cswap's active account", () => {
    const result = plan({
      thread: {
        ...thread,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      },
      fromAccountNumber: 1,
    });
    expect(result?.toAccount.number).toBe(3);
  });
});
