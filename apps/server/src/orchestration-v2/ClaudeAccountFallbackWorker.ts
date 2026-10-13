/**
 * Moves a Claude thread to another cswap account when its account reaches a
 * usage limit, so the work continues instead of waiting for the reset.
 *
 * Claude reports a reached limit either by pausing the turn (a `usage-limit:`
 * system notice) or by failing it with a `usage_limit` error, checked again
 * when the run itself fails because the two commit separately. Either one on
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
  type RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  chooseCswapFallbackAccount,
  cswapAccountNumberFromInstanceId,
  cswapInstanceId,
  type CswapAccount,
} from "../provider/cswapAccounts.ts";
import * as CswapDiscovery from "../provider/CswapDiscovery.ts";
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

/**
 * The usage-limit error a failed run ended with, on its current attempt.
 * The run can fail after its error item was recorded, so a run failure is
 * checked against the items it already has.
 */
export function usageLimitItemForFailedRun(
  run: OrchestrationV2Run,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2TurnItem | null {
  if (run.status !== "failed" || run.rootNodeId === null) return null;
  return (
    turnItems.findLast(
      (item) =>
        item.runId === run.id &&
        item.nodeId === run.rootNodeId &&
        claudeUsageLimitTrigger(item) === "failed",
    ) ?? null
  );
}

/**
 * Accounts a thread recently left. An account enters only after the move
 * away from it was dispatched, so a failed dispatch never keeps it out.
 */
export class LeftAccounts {
  private readonly leftAt = new Map<number, number>();

  excluded(nowMs: number): ReadonlySet<number> {
    for (const [account, at] of this.leftAt) {
      if (nowMs - at > LEFT_ACCOUNT_COOLDOWN_MS) this.leftAt.delete(account);
    }
    return new Set(this.leftAt.keys());
  }

  /** Dispatch the move, then remember the account it left. */
  dispatch<E, R>(
    plan: ClaudeAccountFallbackPlan,
    nowMs: number,
    dispatch: (command: OrchestrationV2Command) => Effect.Effect<unknown, E, R>,
  ): Effect.Effect<void, E, R> {
    return dispatch(plan.command).pipe(
      Effect.tap(() => Effect.sync(() => this.leftAt.set(plan.fromAccount.number, nowMs))),
      Effect.asVoid,
    );
  }
}

const make = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const discovery = yield* CswapDiscovery.CswapDiscovery;
  const leftAccounts = new LeftAccounts();

  const handle = Effect.fn("ClaudeAccountFallbackWorker.handle")(function* (
    threadId: OrchestrationV2AppThread["id"],
    trigger: { readonly item: OrchestrationV2TurnItem } | { readonly runId: RunId },
  ) {
    const instances = yield* registry.listInstances;
    const cswapInstances = instances.filter(
      (instance) => cswapAccountNumberFromInstanceId(instance.instanceId) !== null,
    );
    if (cswapInstances.length === 0) return;
    const projection = yield* projections.getThreadProjection(threadId);
    const item =
      "item" in trigger
        ? trigger.item
        : (() => {
            const run = projection.runs.find((candidate) => candidate.id === trigger.runId);
            return run === undefined ? null : usageLimitItemForFailedRun(run, projection.turnItems);
          })();
    if (item === null) return;
    const current = instances.find(
      (instance) => instance.instanceId === projection.thread.providerInstanceId,
    );
    if (current === undefined) return;
    // The list cswap discovery keeps current, with usage readings at most a minute old.
    const accounts = yield* discovery.accounts;
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
      excludedAccountNumbers: leftAccounts.excluded(nowMs),
    });
    if (plan === null) return;
    yield* Effect.logInfo("orchestration-v2.claude-account-fallback", {
      threadId,
      fromAccount: plan.fromAccount.number,
      toAccount: plan.toAccount.number,
    });
    yield* leftAccounts.dispatch(plan, nowMs, threads.dispatch);
  });

  const handleSafely = (
    threadId: OrchestrationV2AppThread["id"],
    trigger: Parameters<typeof handle>[1],
  ) =>
    handle(threadId, trigger).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestration-v2.claude-account-fallback.failed", { threadId, cause }),
      ),
    );

  const afterSequence = yield* eventSink.latestSequence();
  // A failed run is checked as well as its error item, since either can commit first.
  yield* Stream.merge(
    eventSink.stream({ afterSequence, eventType: "turn-item.updated" }),
    eventSink.stream({ afterSequence, eventType: "run.updated" }),
  ).pipe(
    Stream.runForEach(({ event }) => {
      if (event.type === "turn-item.updated" && claudeUsageLimitTrigger(event.payload) !== null) {
        return handleSafely(event.threadId, { item: event.payload });
      }
      if (event.type === "run.updated" && event.payload.status === "failed") {
        return handleSafely(event.threadId, { runId: event.payload.id });
      }
      return Effect.void;
    }),
    Effect.catchCause((cause) =>
      Effect.logWarning("orchestration-v2.claude-account-fallback.stopped", { cause }),
    ),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(make);
