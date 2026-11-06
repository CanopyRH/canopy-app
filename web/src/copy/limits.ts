/**
 * Words and source lines for the limits page. It lives in copy/ so tools/banned-words.ts checks it.
 *
 * Every `line` below points into the contract source in contracts/src, and the `quote` is the text on that line.
 * web/test/limits.test.ts reads the source and fails if a line has moved, so a link can't point at the wrong place.
 */

export type ContractName = "router" | "alarmBook" | "timelock";

/** A line in a contract's source. `file` is the path Sourcify and Blockscout show for the verified build. */
export interface SourceRef {
  contract: ContractName;
  /** Path of the file in this repo, from the repo root. */
  repoFile: string;
  /** The name of the file, as the explorers list it. */
  file: string;
  line: number;
  quote: string;
}

const ROUTER = { contract: "router", repoFile: "contracts/src/ExitRouter.sol", file: "ExitRouter.sol" } as const;
const BOOK = { contract: "alarmBook", repoFile: "contracts/src/AlarmBook.sol", file: "AlarmBook.sol" } as const;

export interface Cannot {
  id: "recipient" | "block" | "upgrade" | "fee";
  title: string;
  why: string;
  refs: SourceRef[];
}

export const CANNOT: Cannot[] = [
  {
    id: "recipient",
    title: "Nobody can send an exit's money to anyone but its owner.",
    why: "An exit takes a position, an alarm and an amount. There is no field for who gets paid, and every payout goes to the position's owner.",
    refs: [{ ...ROUTER, line: 403, quote: "function exit(bytes32 posId, bytes32 alarmKey, uint256 amount)" }],
  },
  {
    id: "block",
    title: "Nobody can block an exit.",
    why: "Pausing only stops new arming. An exit checks no pause, and the owner can always run one. A vault that refuses withdrawals is outside Canopy's contracts, and can still hold an exit up.",
    refs: [
      { ...ROUTER, line: 325, quote: "if (armingPaused && block.timestamp < ADMIN_EXPIRY) revert ArmingIsPaused();" },
      { ...ROUTER, line: 554, quote: "if (msg.sender == p.owner) return false;" },
    ],
  },
  {
    id: "upgrade",
    title: "Nobody can upgrade the contracts.",
    why: "They have no upgrade path: no proxy, no delegatecall, no self-destruct. A fix means new contracts, and people choose whether to move to them.",
    refs: [{ ...ROUTER, line: 28, quote: "contract ExitRouter is ReentrancyGuard {" }],
  },
  {
    id: "fee",
    title: "Nobody can take a fee from an exit.",
    why: "The router has no fee setting and no treasury address. Each amount goes to the owner, or is booked as owed to the owner if they can't receive it. Canopy's plan is paid separately.",
    refs: [{ ...ROUTER, line: 701, quote: "function _pay(uint256 exitId, address owner, address token, uint256 amount, bool swapped) internal {" }],
  },
];

/** The admin's powers on the router, each with the line that sets it and the line that ends it. */
export const ADMIN_REFS = {
  adapters: { ...ROUTER, line: 503, quote: "function setAdapter(address adapter, bool allowed) external onlyAdmin {" },
  guardian: { ...ROUTER, line: 510, quote: "function setGuardian(address g) external onlyAdmin {" },
  pause: { ...ROUTER, line: 517, quote: "function setArmingPaused(bool paused) external {" },
  expiry: { ...ROUTER, line: 496, quote: "if (msg.sender != ADMIN || block.timestamp >= ADMIN_EXPIRY) revert NotAdmin();" },
} satisfies Record<string, SourceRef>;

export const WATCHER_REFS = {
  delay: { ...BOOK, line: 83, quote: "uint256 public constant WATCHER_DELAY = 2 days;" },
  term: { ...BOOK, line: 85, quote: "uint256 public constant MAX_WATCHER_TERM = 365 days;" },
  admin: { ...BOOK, line: 202, quote: "if (msg.sender != ADMIN) revert NotAdmin();" },
} satisfies Record<string, SourceRef>;

/** Where each fact is read from, for the "could not read" lines. */
export const FACT_NAMES = {
  expiry: "the admin expiry date",
  now: "the chain's clock",
  guardian: "the guardian",
  paused: "whether new arming is paused",
  admin: "the admin",
  delay: "the Timelock delay",
  proposer: "the proposer multisig",
  adapters: "the allowed adapters",
  watchers: "the approved watchers",
  watcherAdmin: "who keeps the watcher list",
} as const;

export const LIMITS_COPY = {
  eyebrow: "WHAT CANOPY CAN'T DO",
  title: "What Canopy can't do, read from the chain.",
  abstract: (chain: string) =>
    `Your browser reads everything on this page straight from ${chain}. Canopy's servers are not involved, so it works even if Canopy is down. A fact that can't be read is marked as unread, never guessed.`,
  noContracts: { title: "No contracts to read here", body: "This build has no contract addresses for this network, so there is nothing to show." },
  endsHeading: "What ends on the date",
  endsBody:
    "From that second on, the admin can no longer allow or turn off adapters or replace the guardian, and nobody can pause new arming. Exits, disarming and claims were never in the admin's reach.",
  endedBody:
    "The date has passed. The admin can no longer allow or turn off adapters or replace the guardian, and nobody can pause new arming. Exits, disarming and claims were never in the admin's reach.",
  staysHeading: "What does not end",
  staysBody:
    "The list of approved watchers stays with the Timelock, so a bad watcher can always be removed at once. A watcher can't fire an alarm alone: that takes two.",
  cannotHeading: "What nobody can do",
  cannotLead: "Each of these is a property of the code, not a promise. The line is in the source the explorers show for the deployed contract.",
  adminHeading: (ended: boolean) => (ended ? "What the admin could do, now ended" : "What the admin can still do until then"),
  adminLead:
    "The admin is a Timelock run by a multisig. These are its powers on the router, and no others. It can't move funds, change who is paid or touch an armed position.",
  watchersHeading: "Watchers",
  watchersLead:
    "Watchers are the approved signers for exploit alarms. Two must sign the same report before one fires.",
  watcherRule: "A new watcher waits 2 days before it can sign, and every approval ends within a year unless it is renewed.",
  watchersNone: "No watcher is approved right now.",
  finePrint:
    "This page shows what the chain says now. It is not advice, and it says nothing about any future change that is still allowed.",
  retry: "Read again",
  retrying: "Reading…",
  tweet: {
    button: "Post on X",
    days: (n: number) => `Canopy's admin powers end in ${n} ${n === 1 ? "day" : "days"}. After that nobody can change the exit contract. canopyrh.com/limits`,
    soon: "Canopy's admin powers end in less than a day. After that nobody can change the exit contract. canopyrh.com/limits",
    ended: "Canopy's admin powers have ended. Nobody can change the exit contract. canopyrh.com/limits",
  },
} as const;
