/**
 * cswapAccounts — optional integration with the `cswap` (claude-swap) CLI,
 * which keeps several Claude subscription logins on one machine.
 *
 * `cswap run <account> --share-history` launches Claude with
 * `CLAUDE_CONFIG_DIR` pointing at a per-account profile whose `projects/`
 * (conversation transcripts) links back to `~/.claude`, or as plain `claude`
 * when the account is already the default login. T3 asks cswap to prepare
 * that profile and then runs Claude with the same `CLAUDE_CONFIG_DIR`, so
 * each account becomes an ordinary Claude provider instance. Nothing here
 * reads or copies credentials; cswap owns them.
 *
 * Without cswap there are no accounts, which leaves Claude exactly as it
 * was. A failed listing is reported as such so callers keep what they had.
 *
 * @module provider/cswapAccounts
 */
import {
  CSWAP_PROVIDER_INSTANCE_PREFIX,
  defaultInstanceIdForDriver,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  collectStreamAsString,
  isCommandMissingCause,
} from "@t3tools/provider-core/server/snapshotProbe";

const CSWAP_COMMAND = "cswap";
const CSWAP_TIMEOUT = Duration.seconds(20);
const CONFIG_DIR_MARKER = "T3_CSWAP_CONFIG_DIR=";
const PRINT_CONFIG_DIR_FLAG = "--t3-cswap-print-config-dir";

export const CswapAccount = Schema.Struct({
  number: Schema.Number,
  email: Schema.String,
  /** The alias the user gave the account in cswap, else its email. */
  label: Schema.String,
  /** The account Claude's default login (`~/.claude`) currently uses. */
  active: Schema.Boolean,
  /** Held out of cswap's automatic rotation. */
  disabled: Schema.Boolean,
  /** `ok` when cswap could read the account's usage. */
  usageStatus: Schema.String,
  fiveHourPercent: Schema.NullOr(Schema.Number),
  sevenDayPercent: Schema.NullOr(Schema.Number),
});
export type CswapAccount = typeof CswapAccount.Type;

const UsageWindowJson = Schema.Struct({ pct: Schema.optional(Schema.NullOr(Schema.Number)) });
const CswapListJson = Schema.Struct({
  accounts: Schema.Array(
    Schema.Struct({
      number: Schema.Number,
      email: Schema.String,
      alias: Schema.optional(Schema.String),
      active: Schema.optional(Schema.Boolean),
      disabled: Schema.optional(Schema.Boolean),
      usageStatus: Schema.optional(Schema.String),
      usage: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            fiveHour: Schema.optional(Schema.NullOr(UsageWindowJson)),
            sevenDay: Schema.optional(Schema.NullOr(UsageWindowJson)),
          }),
        ),
      ),
    }),
  ),
});
const decodeCswapList = Schema.decodeUnknownOption(Schema.fromJsonString(CswapListJson));

/** Accounts from `cswap list --json`, or null when the output is unreadable. */
export function parseCswapAccountList(stdout: string): ReadonlyArray<CswapAccount> | null {
  const decoded = decodeCswapList(stdout.trim());
  if (Option.isNone(decoded)) return null;
  return decoded.value.accounts
    .filter((account) => Number.isInteger(account.number) && account.number > 0)
    .map((account) => ({
      number: account.number,
      email: account.email,
      label: account.alias?.trim() || account.email,
      active: account.active === true,
      disabled: account.disabled === true,
      usageStatus: account.usageStatus ?? "unavailable",
      fiveHourPercent: account.usage?.fiveHour?.pct ?? null,
      sevenDayPercent: account.usage?.sevenDay?.pct ?? null,
    }));
}

export const cswapInstanceId = (accountNumber: number): ProviderInstanceId =>
  ProviderInstanceId.make(`${CSWAP_PROVIDER_INSTANCE_PREFIX}${accountNumber}`);

/** The cswap account an instance id was derived for, if it was. */
export function cswapAccountNumberFromInstanceId(instanceId: string): number | null {
  if (!instanceId.startsWith(CSWAP_PROVIDER_INSTANCE_PREFIX)) return null;
  const parsed = Number(instanceId.slice(CSWAP_PROVIDER_INSTANCE_PREFIX.length));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Send a command aimed at a cswap account this server does not run (removed
 * from cswap, or cswap gone) to the default Claude instance instead, so the
 * thread keeps working on Claude's default login.
 */
export function routeUndiscoveredCswapInstance<C extends object>(
  command: C,
  isRunning: (instanceId: ProviderInstanceId) => boolean,
): C {
  if (!("modelSelection" in command)) return command;
  const selection = command.modelSelection as ModelSelection | undefined;
  if (
    selection === undefined ||
    cswapAccountNumberFromInstanceId(selection.instanceId) === null ||
    isRunning(selection.instanceId)
  ) {
    return command;
  }
  return {
    ...command,
    modelSelection: {
      ...selection,
      instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent")),
    },
  };
}

/** Whether cswap reports headroom on every window it knows about. */
export function cswapAccountHasUsage(account: CswapAccount): boolean {
  if (account.disabled || account.usageStatus !== "ok") return false;
  return [account.fiveHourPercent, account.sevenDayPercent].every(
    (percent) => percent === null || percent < 100,
  );
}

/**
 * The account a limited thread should move to: enabled, with usage left,
 * not one it just left, and with the most headroom on its busiest window.
 */
export function chooseCswapFallbackAccount(input: {
  readonly accounts: ReadonlyArray<CswapAccount>;
  readonly fromAccountNumber: number;
  readonly excludedAccountNumbers?: ReadonlySet<number>;
}): CswapAccount | null {
  const busiest = (account: CswapAccount) =>
    Math.max(account.fiveHourPercent ?? 0, account.sevenDayPercent ?? 0);
  const candidates = input.accounts
    .filter(
      (account) =>
        account.number !== input.fromAccountNumber &&
        !input.excludedAccountNumbers?.has(account.number) &&
        cswapAccountHasUsage(account),
    )
    .toSorted((left, right) => busiest(left) - busiest(right) || left.number - right.number);
  return candidates[0] ?? null;
}

/**
 * One Claude provider instance per cswap account. `configDirs` maps an
 * account to its prepared profile; `null` means the default login.
 * Accounts whose profile could not be prepared are left out.
 *
 * The default login runs with no `CLAUDE_CONFIG_DIR`. When the server itself
 * inherited one, that account is left out: the inherited directory belongs
 * to another login, and exporting `~/.claude` explicitly would make Claude
 * look for a differently named keychain entry and report signed out.
 */
export function cswapProviderInstances(
  accounts: ReadonlyArray<CswapAccount>,
  configDirs: ReadonlyMap<number, string | null>,
  inheritedConfigDir?: string,
): Record<string, ProviderInstanceConfig> {
  const instances: Record<string, ProviderInstanceConfig> = {};
  const inheritsConfigDir = (inheritedConfigDir?.trim() ?? "").length > 0;
  for (const account of accounts) {
    const configDir = configDirs.get(account.number);
    if (configDir === undefined || (configDir === null && inheritsConfigDir)) continue;
    instances[cswapInstanceId(account.number)] = {
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: account.label,
      config: { homePath: configDir ?? "" },
    };
  }
  return instances;
}

/** `missing` means cswap is not installed; `failed` covers timeouts, errors, and unreadable output. */
export type CswapListing =
  | { readonly _tag: "ok"; readonly accounts: ReadonlyArray<CswapAccount> }
  | { readonly _tag: "missing" }
  | { readonly _tag: "failed" };

type CswapRun =
  | { readonly _tag: "ok"; readonly stdout: string }
  | { readonly _tag: "missing" }
  | { readonly _tag: "failed" };

const runCswap = (
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Effect.Effect<CswapRun, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(CSWAP_COMMAND, [...args], { env, stdin: "ignore", stderr: "ignore" }),
    );
    const [stdout, exitCode] = yield* Effect.all(
      [collectStreamAsString(child.stdout), child.exitCode],
      { concurrency: "unbounded" },
    );
    const result: CswapRun = Number(exitCode) === 0 ? { _tag: "ok", stdout } : { _tag: "failed" };
    return result;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(CSWAP_TIMEOUT),
    Effect.map(Option.getOrElse((): CswapRun => ({ _tag: "failed" }))),
    Effect.catch((cause) =>
      Effect.succeed<CswapRun>(
        isCommandMissingCause(cause) ? { _tag: "missing" } : { _tag: "failed" },
      ),
    ),
  );

/** cswap's account list. On Windows, where cswap profiles are unsupported, cswap counts as missing. */
export const listCswapAccounts = Effect.fn("listCswapAccounts")(function* () {
  // `cswap run` profiles share history through symlinks, which cswap only supports on POSIX.
  if ((yield* HostProcess.Platform) === "win32") return { _tag: "missing" } as CswapListing;
  const env = yield* HostProcess.Environment;
  const result = yield* runCswap(["list", "--json"], env);
  if (result._tag !== "ok") return result as CswapListing;
  const accounts = parseCswapAccountList(result.stdout);
  const listing: CswapListing = accounts === null ? { _tag: "failed" } : { _tag: "ok", accounts };
  return listing;
});

/**
 * Prepare an account's profile the way `cswap run --share-history` does and
 * return its `CLAUDE_CONFIG_DIR`: `null` for the default login, `undefined`
 * when cswap could not prepare it.
 *
 * cswap ends a launch by exec'ing `claude` from PATH. A throwaway `claude`
 * shim placed first on PATH reports the directory cswap chose instead of
 * starting a session, and forwards every other call (cswap's own login
 * checks) to the real Claude.
 */
export const resolveCswapConfigDir = Effect.fn("resolveCswapConfigDir")(function* (
  accountNumber: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = yield* HostProcess.Environment;
  if ((yield* HostProcess.Platform) === "win32") return undefined;
  return yield* Effect.gen(function* () {
    const shimDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-cswap-" });
    const shim = path.join(shimDir, "claude");
    yield* fileSystem.writeFileString(
      shim,
      [
        "#!/bin/sh",
        `if [ "$1" = "${PRINT_CONFIG_DIR_FLAG}" ]; then`,
        `  printf '${CONFIG_DIR_MARKER}%s\\n' "\${CLAUDE_CONFIG_DIR-}"`,
        "  exit 0",
        "fi",
        'PATH="$T3_CSWAP_ORIGINAL_PATH" exec claude "$@"',
        "",
      ].join("\n"),
    );
    yield* fileSystem.chmod(shim, 0o700);
    const originalPath = env.PATH ?? "";
    // An inherited CLAUDE_CONFIG_DIR would stop cswap from recognising the default login.
    const { CLAUDE_CONFIG_DIR: _inherited, ...baseEnv } = env;
    const result = yield* runCswap(
      ["run", String(accountNumber), "--share-history", "--", PRINT_CONFIG_DIR_FLAG],
      {
        ...baseEnv,
        // POSIX only, like the rest of this integration.
        PATH: `${shimDir}:${originalPath}`,
        T3_CSWAP_ORIGINAL_PATH: originalPath,
      },
    );
    return result._tag === "ok" ? parseCswapConfigDirOutput(result.stdout) : undefined;
  }).pipe(
    Effect.scoped,
    Effect.orElseSucceed(() => undefined),
  );
});

/** Read the shim's report from cswap's output, which may carry cswap's own notices too. */
export function parseCswapConfigDirOutput(stdout: string): string | null | undefined {
  const line = stdout
    .split(/\r?\n/)
    .findLast((candidate) => candidate.startsWith(CONFIG_DIR_MARKER));
  if (line === undefined) return undefined;
  const configDir = line.slice(CONFIG_DIR_MARKER.length).trim();
  return configDir.length === 0 ? null : configDir;
}
