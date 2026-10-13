import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { CswapAccount, CswapListing } from "./cswapAccounts.ts";
import { emptyCswapDiscoveryState, refreshCswapDiscoveryState } from "./CswapDiscovery.ts";

const account = (
  overrides: Partial<CswapAccount> & Pick<CswapAccount, "number">,
): CswapAccount => ({
  email: `account${overrides.number}@example.com`,
  label: `account${overrides.number}@example.com`,
  active: false,
  disabled: false,
  usageStatus: "ok",
  fiveHourPercent: 0,
  sevenDayPercent: 0,
  ...overrides,
});

const accounts = [account({ number: 1, active: true }), account({ number: 3 })];
const listed = (list: ReadonlyArray<CswapAccount>) =>
  Effect.succeed<CswapListing>({ _tag: "ok", accounts: list });

/** Resolves each account from `dirs`, counting calls; a missing entry fails to prepare. */
const resolver = (dirs: ReadonlyMap<number, string | null>) => {
  const calls: Array<number> = [];
  return {
    calls,
    resolve: (accountNumber: number) =>
      Effect.sync(() => {
        calls.push(accountNumber);
        return dirs.get(accountNumber);
      }),
  };
};

const allDirs = new Map<number, string | null>([
  [1, null],
  [3, "/profiles/3"],
]);

describe("refreshCswapDiscoveryState", () => {
  it.effect(
    "keeps the last accounts when cswap list fails, and clears them only when cswap is gone",
    () =>
      Effect.gen(function* () {
        const settled = yield* refreshCswapDiscoveryState(
          emptyCswapDiscoveryState,
          listed(accounts),
          resolver(allDirs).resolve,
        );
        expect(settled.configDirs).toEqual(allDirs);

        const afterFailure = yield* refreshCswapDiscoveryState(
          settled,
          Effect.succeed<CswapListing>({ _tag: "failed" }),
          resolver(allDirs).resolve,
        );
        expect(afterFailure).toBe(settled);

        const afterRemoval = yield* refreshCswapDiscoveryState(
          settled,
          Effect.succeed<CswapListing>({ _tag: "missing" }),
          resolver(allDirs).resolve,
        );
        expect(afterRemoval.accounts).toEqual([]);
        expect(afterRemoval.configDirs.size).toBe(0);
      }),
  );

  it.effect("prepares an account again until it succeeds, keeping the others", () =>
    Effect.gen(function* () {
      const flaky = resolver(new Map([[1, null]]));
      const partial = yield* refreshCswapDiscoveryState(
        emptyCswapDiscoveryState,
        listed(accounts),
        flaky.resolve,
      );
      expect(partial.configDirs).toEqual(new Map([[1, null]]));
      expect(partial.settledKey).toBeNull();

      const retry = resolver(allDirs);
      const settled = yield* refreshCswapDiscoveryState(partial, listed(accounts), retry.resolve);
      expect(retry.calls.toSorted()).toEqual([1, 3]);
      expect(settled.configDirs).toEqual(allDirs);
      expect(settled.settledKey).not.toBeNull();

      // Settled and unchanged: no profile is prepared, but usage readings refresh.
      const quiet = resolver(allDirs);
      const busier = [accounts[0]!, account({ number: 3, fiveHourPercent: 80 })];
      const next = yield* refreshCswapDiscoveryState(settled, listed(busier), quiet.resolve);
      expect(quiet.calls).toEqual([]);
      expect(next.accounts).toEqual(busier);
    }),
  );

  it.effect("keeps an earlier profile only while the account's role is unchanged", () =>
    Effect.gen(function* () {
      const settled = yield* refreshCswapDiscoveryState(
        emptyCswapDiscoveryState,
        listed(accounts),
        resolver(allDirs).resolve,
      );
      // An alias change forces preparation, which fails: both earlier answers still hold.
      const renamed = [accounts[0]!, account({ number: 3, label: "personal" })];
      const kept = yield* refreshCswapDiscoveryState(
        settled,
        listed(renamed),
        resolver(new Map()).resolve,
      );
      expect(kept.configDirs).toEqual(allDirs);
      expect(kept.settledKey).toBeNull();

      // The default login moved to account 3 and account 1 failed to prepare:
      // account 1's old "default login" answer now means account 3, so it is dropped.
      const switched = [account({ number: 1 }), account({ number: 3, active: true })];
      const next = yield* refreshCswapDiscoveryState(
        settled,
        listed(switched),
        resolver(new Map([[3, null]])).resolve,
      );
      expect(next.configDirs).toEqual(new Map([[3, null]]));
      expect(next.settledKey).toBeNull();
    }),
  );
});
