/**
 * Moves a Claude thread to another cswap account when its account reaches a
 * usage limit, so the work continues instead of waiting for the reset.
 *
 * Claude reports a reached limit either by pausing the turn (a `usage-limit:`
 * system notice) or by failing it with a `usage_limit` error. Either one on
 * the thread's current attempt restarts or continues the run on the account
 * with the most headroom, through the same `message.dispatch` a user's model
 * switch uses. cswap profiles share Claude's transcripts, so the other account
 * resumes the same session. The dispatched message says which account took
 * over, which is the note the thread shows.
 *
 * Only live events are watched: a limit reached before this server started
 * belongs to a turn that restart recovery has already ended.
 *
 * @module orchestration-v2/ClaudeAccountFallbackWorker
 */
import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  chooseCswapFallbackAccount,
  cswapAccountNumberFromInstanceId,
  cswapInstanceId,
  listCswapAccounts,
  type CswapAccount,
} from "../provider/cswapAccounts.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** An account a thread left stays out of fallback this long, so two limited accounts never ping-pong. */
const LEFT_ACCOUNT_COOLDOWN_MS = 30 * 60 * 1000;

type LimitTrigger = "paused" | "failed";

/** Whether a turn item reports that Claude's account reached a usage limit. */
export function claudeUsageLimitTrigger(item: OrchestrationV2TurnItem): LimitTrigger | null {
  if (
    item.type === "system_notice" &&
    item.nativeItemRef?.nativeId?.startsWith("usage-limit:") === true
  ) {
    return "paused";
  }
  if (item.type === "error" && item.status === "failed" && item.failure.class === "usage_limit") {
    return "failed";
  }
  return null;
}

export interface ClaudeAccountFallbackPlan {
  readonly command: OrchestrationV2Command;
  readonly fromAccount: CswapAccount;
  readonly toAccount: CswapAccount;
}

/**
 * The dispatch that moves a limited thread to another account, or null when
 * the limit no longer belongs to the thread's current attempt, the thread is
 * not on a cswap account, or no other account has usage left.
 */
export function planClaudeAccountFallback(input: {
  readonly item: OrchestrationV2TurnItem;
  readonly thread: Pick<
    OrchestrationV2AppThread,
    "id" | "providerInstanceId" | "modelSelection" | "archivedAt" | "deletedAt"
  >;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  /** The account the thread's instance runs on, when it is a cswap account. */
  readonly fromAccountNumber: number | null;
  readonly accounts: ReadonlyArray<CswapAccount>;
  /** Live cswap instances a thread can move to. */
  readonly availableInstanceIds: ReadonlySet<ProviderInstanceId>;
  readonly excludedAccountNumbers: ReadonlySet<number>;
}): ClaudeAccountFallbackPlan | null {
  const trigger = claudeUsageLimitTrigger(input.item);
  const { thread } = input;
  if (trigger === null || input.fromAccountNumber === null) return null;
  if (thread.archivedAt !== null || thread.deletedAt !== null) return null;
  const run = input.runs.find((candidate) => candidate.id === input.item.runId);
  const latestOrdinal = Math.max(...input.runs.map((candidate) => candidate.ordinal));
  if (run === undefined || run.ordinal !== latestOrdinal) return null;
  // A restart gives the run a new root node, so a notice from an attempt that
  // already moved never triggers a second move.
  if (run.rootNodeId === null || run.rootNodeId !== input.item.nodeId) return null;
  const runIsLive = run.status === "running" || run.status === "waiting";
  if (trigger === "paused" ? !runIsLive : run.status !== "failed") return null;

  const fromAccount = input.accounts.find((account) => account.number === input.fromAccountNumber);
  if (fromAccount === undefined) return null;
  const toAccount = chooseCswapFallbackAccount({
    accounts: input.accounts.filter((account) =>
      input.availableInstanceIds.has(cswapInstanceId(account.number)),
    ),
    fromAccountNumber: fromAccount.number,
    excludedAccountNumbers: input.excludedAccountNumbers,
  });
  if (toAccount === null) return null;

  const identity = `claude-account-fallback:${thread.id}:${run.id}:${run.rootNodeId}`;
  return {
    fromAccount,
    toAccount,
    command: {
      type: "message.dispatch",
      commandId: CommandId.make(identity),
      messageId: MessageId.make(identity),
      threadId: thread.id,
      text: `${fromAccount.label} reached its Claude usage limit, so this thread switched to ${toAccount.label}. Continue where you left off.`,
      attachments: [],
      modelSelection: { ...thread.modelSelection, instanceId: cswapInstanceId(toAccount.number) },
      dispatchMode:
        trigger === "paused"
          ? { type: "restart_active", targetRunId: run.id }
          : { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    },
  };
}

const make = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const leftAccounts = new Map<number, number>();

  const handle = Effect.fn("ClaudeAccountFallbackWorker.handle")(function* (
    threadId: OrchestrationV2AppThread["id"],
    item: OrchestrationV2TurnItem,
  ) {
    const instances = yield* registry.listInstances;
    const cswapInstances = instances.filter(
      (instance) => cswapAccountNumberFromInstanceId(instance.instanceId) !== null,
    );
    if (cswapInstances.length === 0) return;
    const projection = yield* projections.getThreadProjection(threadId);
    const current = instances.find(
      (instance) => instance.instanceId === projection.thread.providerInstanceId,
    );
    if (current === undefined) return;
    const accounts = yield* listCswapAccounts();
    // Any other instance sharing cswap's transcripts runs on Claude's default
    // login, which is cswap's active account.
    const sharesCswapHistory = cswapInstances.some(
      (instance) =>
        instance.continuationIdentity.continuationKey ===
        current.continuationIdentity.continuationKey,
    );
    const fromAccountNumber =
      cswapAccountNumberFromInstanceId(current.instanceId) ??
      (current.driverKind === "claudeAgent" && sharesCswapHistory
        ? (accounts.find((account) => account.active)?.number ?? null)
        : null);
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    for (const [account, leftAt] of leftAccounts) {
      if (nowMs - leftAt > LEFT_ACCOUNT_COOLDOWN_MS) leftAccounts.delete(account);
    }
    const plan = planClaudeAccountFallback({
      item,
      thread: projection.thread,
      runs: projection.runs,
      fromAccountNumber,
      accounts,
      availableInstanceIds: new Set(
        cswapInstances
          .filter((instance) => instance.enabled)
          .map((instance) => instance.instanceId),
      ),
      excludedAccountNumbers: new Set(leftAccounts.keys()),
    });
    if (plan === null) return;
    leftAccounts.set(plan.fromAccount.number, nowMs);
    yield* Effect.logInfo("orchestration-v2.claude-account-fallback", {
      threadId,
      fromAccount: plan.fromAccount.number,
      toAccount: plan.toAccount.number,
    });
    yield* threads.dispatch(plan.command);
  });

  const afterSequence = yield* eventSink.latestSequence();
  yield* eventSink.stream({ afterSequence, eventType: "turn-item.updated" }).pipe(
    Stream.runForEach((stored) =>
      stored.event.type === "turn-item.updated" &&
      claudeUsageLimitTrigger(stored.event.payload) !== null
        ? handle(stored.event.threadId, stored.event.payload).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.claude-account-fallback.failed", {
                threadId: stored.event.threadId,
                cause,
              }),
            ),
          )
        : Effect.void,
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("orchestration-v2.claude-account-fallback.stopped", { cause }),
    ),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(make);
