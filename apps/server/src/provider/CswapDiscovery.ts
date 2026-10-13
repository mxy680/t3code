/**
 * CswapDiscovery — the cswap accounts this server runs as Claude instances.
 *
 * Holds the last good account list and each account's prepared profile, so
 * provider hydration, terminals, installation checks, and the account
 * fallback worker all read one answer. A minute-by-minute refresh keeps it
 * current. A failed `cswap list` keeps the previous accounts; only a missing
 * cswap clears them. Profiles are prepared again, concurrently, when the
 * accounts or cswap's default login change, and until every account has
 * prepared. The last answer is cached in the state directory so cswap
 * threads have their instances right after a restart.
 *
 * @module provider/CswapDiscovery
 */
import type { ProviderInstanceConfig } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import {
  CswapAccount,
  cswapProviderInstances,
  listCswapAccounts,
  resolveCswapConfigDir,
  type CswapListing,
} from "./cswapAccounts.ts";

const REFRESH_INTERVAL = Duration.minutes(1);
const CACHE_FILE = "cswap-accounts.json";

export interface CswapDiscoveryState {
  readonly accounts: ReadonlyArray<CswapAccount>;
  readonly configDirs: ReadonlyMap<number, string | null>;
  /** The account set whose profiles all prepared; any other set is prepared again. */
  readonly settledKey: string | null;
}

export const emptyCswapDiscoveryState: CswapDiscoveryState = {
  accounts: [],
  configDirs: new Map(),
  settledKey: null,
};

const stableKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const accountsKey = (accounts: ReadonlyArray<CswapAccount>) =>
  stableKey(accounts.map(({ number, email, label, active }) => [number, email, label, active]));

/**
 * One refresh: list accounts, then prepare profiles when the account set
 * changed or an earlier attempt left one unprepared. A profile that fails to
 * prepare keeps its previous directory while it is still valid, and is tried
 * again on the next refresh.
 */
export const refreshCswapDiscoveryState = Effect.fn("refreshCswapDiscoveryState")(function* <
  R1,
  R2,
>(
  previous: CswapDiscoveryState,
  list: Effect.Effect<CswapListing, never, R1>,
  resolve: (accountNumber: number) => Effect.Effect<string | null | undefined, never, R2>,
) {
  const listing = yield* list;
  if (listing._tag === "failed") return previous;
  if (listing._tag === "missing") return emptyCswapDiscoveryState;
  const { accounts } = listing;
  const key = accountsKey(accounts);
  if (key === previous.settledKey) return { ...previous, accounts };
  const resolved = yield* Effect.forEach(
    accounts,
    (account) => resolve(account.number).pipe(Effect.map((dir) => [account.number, dir] as const)),
    { concurrency: "unbounded" },
  );
  const configDirs = new Map<number, string | null>();
  for (const [accountNumber, dir] of resolved) {
    // An earlier directory only stands in while the account's role is unchanged:
    // after cswap moves the default login, the old answer points at another account.
    const wasActive = previous.accounts.find(
      (candidate) => candidate.number === accountNumber,
    )?.active;
    const isActive = accounts.find((candidate) => candidate.number === accountNumber)?.active;
    const configDir =
      dir !== undefined
        ? dir
        : wasActive === isActive
          ? previous.configDirs.get(accountNumber)
          : undefined;
    if (configDir !== undefined) configDirs.set(accountNumber, configDir);
  }
  const settled = resolved.every(([, dir]) => dir !== undefined);
  return { accounts, configDirs, settledKey: settled ? key : null } satisfies CswapDiscoveryState;
});

const CacheJson = Schema.fromJsonString(
  Schema.Struct({
    accounts: Schema.Array(CswapAccount),
    configDirs: Schema.Array(Schema.Tuple([Schema.Number, Schema.NullOr(Schema.String)])),
  }),
);
const decodeCache = Schema.decodeUnknownOption(CacheJson);
const encodeCache = Schema.encodeSync(CacheJson);

export class CswapDiscovery extends Context.Service<
  CswapDiscovery,
  {
    /** Claude instances for the discovered accounts, keyed by instance id. */
    readonly instances: Effect.Effect<Readonly<Record<string, ProviderInstanceConfig>>>;
    /** The last good account list, with cswap's usage readings. */
    readonly accounts: Effect.Effect<ReadonlyArray<CswapAccount>>;
    /** The current instances, then every change to them. */
    readonly instanceChanges: Stream.Stream<Readonly<Record<string, ProviderInstanceConfig>>>;
  }
>()("t3/provider/CswapDiscovery") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const inheritedConfigDir = (yield* HostProcess.Environment).CLAUDE_CONFIG_DIR;
  const cachePath = path.join(stateDir, CACHE_FILE);

  const cached = yield* fileSystem.readFileString(cachePath).pipe(
    Effect.map((text) => decodeCache(text)),
    Effect.orElseSucceed(() => Option.none()),
  );
  const initial: CswapDiscoveryState = Option.match(cached, {
    onNone: () => emptyCswapDiscoveryState,
    onSome: (cache) => ({
      accounts: cache.accounts,
      configDirs: new Map(cache.configDirs),
      settledKey: null,
    }),
  });
  const toInstances = (state: CswapDiscoveryState) =>
    cswapProviderInstances(state.accounts, state.configDirs, inheritedConfigDir);

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const state = yield* Ref.make(initial);
  const instances = yield* SubscriptionRef.make(toInstances(initial));

  const refresh = Effect.gen(function* () {
    const previous = yield* Ref.get(state);
    const next = yield* refreshCswapDiscoveryState(previous, listCswapAccounts(), (accountNumber) =>
      resolveCswapConfigDir(accountNumber),
    );
    yield* Ref.set(state, next);
    if (stableKey(toInstances(next)) === stableKey(toInstances(previous))) return;
    yield* SubscriptionRef.set(instances, toInstances(next));
    yield* fileSystem
      .writeFileString(
        cachePath,
        encodeCache({ accounts: next.accounts, configDirs: [...next.configDirs] }),
      )
      .pipe(Effect.ignore);
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
    Effect.catchCause((cause) => Effect.logWarning("cswap account discovery failed", cause)),
  );
  yield* refresh.pipe(Effect.repeat(Schedule.spaced(REFRESH_INTERVAL)), Effect.forkScoped);

  return CswapDiscovery.of({
    instances: SubscriptionRef.get(instances),
    accounts: Ref.get(state).pipe(Effect.map((current) => current.accounts)),
    instanceChanges: SubscriptionRef.changes(instances),
  });
});

export const layer = Layer.effect(CswapDiscovery, make);
