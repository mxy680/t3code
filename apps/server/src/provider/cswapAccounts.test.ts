import { describe, expect, it } from "vite-plus/test";

import {
  chooseCswapFallbackAccount,
  cswapAccountNumberFromInstanceId,
  cswapInstanceId,
  cswapProviderInstances,
  parseCswapAccountList,
  routeUndiscoveredCswapInstance,
  parseCswapConfigDirOutput,
  type CswapAccount,
} from "./cswapAccounts.ts";

// Shape of `cswap list --json` (claude-swap 0.26), trimmed to the fields T3 reads plus a few it ignores.
const LIST_JSON = JSON.stringify({
  schemaVersion: 1,
  activeAccountNumber: 1,
  accounts: [
    {
      number: 1,
      email: "work@example.com",
      organizationName: "Work",
      active: true,
      usageStatus: "ok",
      usage: {
        fiveHour: { pct: 5.0, resetsAt: "2026-10-13T21:40:00+00:00" },
        sevenDay: { pct: 8.0, expectedPct: 52.7 },
        scoped: [{ pct: 0.0, name: "Fable" }],
      },
      usageAgeSeconds: 82.5,
    },
    {
      number: 3,
      email: "personal@example.com",
      alias: "personal",
      active: false,
      disabled: true,
      usageStatus: "token_expired",
      usage: null,
    },
  ],
  unclaimedCredentials: ["ignored"],
});

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

describe("parseCswapAccountList", () => {
  it("reads accounts, aliases, the default login, and usage", () => {
    expect(parseCswapAccountList(LIST_JSON)).toEqual([
      {
        number: 1,
        email: "work@example.com",
        label: "work@example.com",
        active: true,
        disabled: false,
        usageStatus: "ok",
        fiveHourPercent: 5,
        sevenDayPercent: 8,
      },
      {
        number: 3,
        email: "personal@example.com",
        label: "personal",
        active: false,
        disabled: true,
        usageStatus: "token_expired",
        fiveHourPercent: null,
        sevenDayPercent: null,
      },
    ]);
  });

  it("reports unreadable output instead of an empty account list", () => {
    expect(parseCswapAccountList("")).toBeNull();
    expect(parseCswapAccountList("not json")).toBeNull();
    expect(parseCswapAccountList(JSON.stringify({ error: { message: "boom" } }))).toBeNull();
    expect(parseCswapAccountList(JSON.stringify({ accounts: [] }))).toEqual([]);
  });
});

describe("parseCswapConfigDirOutput", () => {
  it("returns the profile directory cswap exported", () => {
    expect(
      parseCswapConfigDirOutput(
        "Launching Account-3 (personal@example.com) [session mode]\nT3_CSWAP_CONFIG_DIR=/home/u/.claude-swap-backup/sessions/3-personal\n",
      ),
    ).toBe("/home/u/.claude-swap-backup/sessions/3-personal");
  });

  it("returns null for the default login and undefined when the shim never ran", () => {
    expect(parseCswapConfigDirOutput("T3_CSWAP_CONFIG_DIR=\n")).toBeNull();
    expect(parseCswapConfigDirOutput("Error: unknown account\n")).toBeUndefined();
  });
});

describe("cswap instances", () => {
  it("round-trips account numbers through instance ids", () => {
    expect(cswapAccountNumberFromInstanceId(cswapInstanceId(3))).toBe(3);
    expect(cswapAccountNumberFromInstanceId("claudeAgent")).toBeNull();
    expect(cswapAccountNumberFromInstanceId("claude_cswap_x")).toBeNull();
  });

  it("builds one Claude instance per prepared account", () => {
    const accounts = parseCswapAccountList(LIST_JSON) ?? [];
    const instances = cswapProviderInstances(
      accounts,
      new Map([
        [1, null],
        [3, "/profiles/3"],
      ]),
    );
    expect(instances).toEqual({
      claude_cswap_1: {
        driver: "claudeAgent",
        displayName: "work@example.com",
        config: { homePath: "" },
      },
      claude_cswap_3: {
        driver: "claudeAgent",
        displayName: "personal",
        config: { homePath: "/profiles/3" },
      },
    });
    expect(cswapProviderInstances(accounts, new Map([[1, null]]))).not.toHaveProperty(
      "claude_cswap_3",
    );
  });

  it("leaves out the default login when the server inherited another CLAUDE_CONFIG_DIR", () => {
    const accounts = parseCswapAccountList(LIST_JSON) ?? [];
    const instances = cswapProviderInstances(
      accounts,
      new Map([
        [1, null],
        [3, "/profiles/3"],
      ]),
      "/somewhere/else",
    );
    expect(Object.keys(instances)).toEqual(["claude_cswap_3"]);
  });
});

describe("routeUndiscoveredCswapInstance", () => {
  const command = {
    type: "message.dispatch",
    modelSelection: { instanceId: cswapInstanceId(5), model: "claude-sonnet-4-5" },
  };

  it("sends work for an account the server does not run to the default Claude instance", () => {
    expect(routeUndiscoveredCswapInstance(command, () => false).modelSelection).toEqual({
      instanceId: "claudeAgent",
      model: "claude-sonnet-4-5",
    });
  });

  it("leaves running accounts, other providers, and commands without a selection alone", () => {
    expect(routeUndiscoveredCswapInstance(command, () => true)).toBe(command);
    const codex = { modelSelection: { instanceId: "codex", model: "gpt-5" } };
    expect(routeUndiscoveredCswapInstance(codex, () => false)).toBe(codex);
    const plain = { type: "run.interrupt" };
    expect(routeUndiscoveredCswapInstance(plain, () => false)).toBe(plain);
  });
});

describe("chooseCswapFallbackAccount", () => {
  it("picks the other account with the most headroom", () => {
    const accounts = [
      account({ number: 1, fiveHourPercent: 100 }),
      account({ number: 2, fiveHourPercent: 40, sevenDayPercent: 70 }),
      account({ number: 3, fiveHourPercent: 60, sevenDayPercent: 10 }),
    ];
    expect(chooseCswapFallbackAccount({ accounts, fromAccountNumber: 1 })?.number).toBe(3);
  });

  it("skips limited, disabled, unreadable, and recently left accounts", () => {
    const accounts = [
      account({ number: 1 }),
      account({ number: 2, sevenDayPercent: 100 }),
      account({ number: 3, disabled: true }),
      account({ number: 4, usageStatus: "token_expired" }),
      account({ number: 5 }),
    ];
    expect(chooseCswapFallbackAccount({ accounts, fromAccountNumber: 1 })?.number).toBe(5);
    expect(
      chooseCswapFallbackAccount({
        accounts,
        fromAccountNumber: 1,
        excludedAccountNumbers: new Set([5]),
      }),
    ).toBeNull();
  });
});
