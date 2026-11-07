# Run a Canopy watcher

Some Canopy alarms need people outside the contracts to say "this really happened": a confirmed exploit, a drain with a
matching report, a curator change. Those alarms fire only when **2 approved watchers** sign. Today Canopy runs all
three watchers itself. This page is for anyone who wants to run an independent one, so that confirmation doesn't
depend on one team.

If you only want to see who the watchers are and what they have signed, open the Watchers page on the website.

## What a watcher does

A watcher is a small program that reads public sources and signs a message when the evidence is real.

1. It reads a short list of public feeds, such as protocol status pages and security news with editors. The list is
   `FEED_URLS` in [deploy/services.env.example](deploy/services.env.example).
2. A language model labels each new post once: is it an exploit report, a depeg report, nothing? The label is only a
   label.
3. The detector next to it watches the listed vaults on chain (drains, share-price drops, owner or curator changes).
4. The watcher signs only when **both** are true in the same hour: a report that names the vault, and an on-chain
   signal for that vault. A label alone never signs. The code that decides this is `services/src/engine/decide.ts`.
5. The signature goes to Canopy's API. When a keeper holds 2 signatures from different approved watchers over the same
   evidence, it sends the transaction that fires the alarm.

### What a watcher cannot do

- **It cannot move funds.** Its key holds none, signs messages off chain and never sends a transaction, so it needs no
  gas. Nothing in the contracts lets a watcher pay anyone, change who gets paid, or touch a position.
- **One watcher cannot fire anything alone.** The AlarmBook needs signatures from 2 different active watchers over
  the same evidence and deadline. One watcher signing something false does nothing by itself.
- It cannot pause arming, change settings, add or remove watchers, or pick which alarms exist.

### What the worst case is

If 2 watcher keys are compromised, or 2 operators sign something false together, they can fire a quorum alarm that
should not fire. A fired alarm lets a keeper return a position to **its owner's own wallet**, so the harm is an early
exit, never a loss to a third party. That is why the list stays short and why removing a watcher is always possible
(see below). More watchers also means more keys that must stay safe, because any 2 can fire. We add them slowly.

## Hardware and cost

The watcher is light. It runs one loop a minute and calls a model only for new posts. What it needs is a place to
run reliably, not a large machine.

| Piece | Starting size | Notes |
| --- | --- | --- |
| One small Linux host or VM | 1 vCPU, 2 GB RAM, 10 GB disk | Runs Postgres and three processes from one image. This is our starting suggestion, not a measured minimum |
| Postgres | Any recent version | Your own database. It holds feed items, signals and the log of what you signed. Do not share it with anyone |
| A chain RPC endpoint | A keyed plan from any provider | The indexer and detector read Robinhood Chain (4663) all day. Public endpoints rate-limit, which can make you miss a signal |
| A model API key | Anthropic, or a compatible service | Only new posts are labelled, so use is small on a quiet day and rises when many posts arrive at once. Set a monthly spend limit with your provider |
| Accurate clock | NTP on | Watchers sign a deadline taken from a shared 10-minute window. A clock that is minutes off signs a different deadline from everyone else, and the signatures can't be combined |

Expect the cost of a small VM, a keyed RPC plan and a small model bill. We have not measured an exact monthly figure,
so check it against your own providers before you apply.

## Why it takes three processes

The watcher process reads feeds and signs. The facts it signs on come from two other processes of the same image,
which write to the same database:

| `ROLE` | What it adds | Why the watcher needs it |
| --- | --- | --- |
| `indexer` | Reads the AlarmBook (and the router) and records the registered alarms | The watcher only signs for alarm keys it has seen registered |
| `detector` | Reads the listed vaults every minute and records on-chain signals and vault names | A signature needs one on-chain signal, and vault names are how a report is matched to a vault |
| `watcher` | Reads feeds, labels posts, signs and posts to peers | The part that holds your key |

Only the `watcher` process holds a key. The other two hold none.

## Run one

You need Docker, a Postgres you can reach, and a clone of this repository. The image is the same one for every role.

### 1. Make a key

Generate a **new** private key just for this. Any wallet tool will do. Keep the private key private, and keep the
public address: that is the only thing you send us. See [Key handling](#key-handling).

### 2. Build the image

```bash
docker build -t canopy-services services
```

### 3. Fill in two env files

Copy [deploy/watcher.env.example](deploy/watcher.env.example) to `watcher.env` and [deploy/services.env.example](deploy/services.env.example) to `chain.env`, then fill them in. Mount the reviewed approval file read-only into the signer container; its configured path must exist inside that container. The watcher process needs only these, and nothing else:

| Setting | What to put |
| --- | --- |
| `ROLE` | `watcher` |
| `DATABASE_URL` | Your Postgres, with TLS and a password |
| `CHAIN_ID` | `4663` |
| `ALARM_BOOK` | The v2 AlarmBook address from `deploy/out/4663/deployment.json` |
| `RPC_URL` | Your chain endpoint. At start the watcher reads the AlarmBook once to confirm it is the v2 contract, and refuses to start on a v1 address |
| `WATCHER_PRIVATE_KEY` | The key from step 1 |
| `ANTHROPIC_API_KEY` | Your model key. Add `ANTHROPIC_BASE_URL` and `CLASSIFIER_MODEL` if you use a compatible service |
| `WATCHERS` | The approved watcher addresses, yours included. Ask in your application for the current list |
| `WATCHER_PEERS` | API addresses to post your signatures to, with no trailing slash. The API in `web/src/mainnet.json` is one |
| `FEED_URLS` | The feed list from `deploy/services.env.example`. Use the same list as everyone else (see the note below) |
| `WATCHER_APPROVAL_FILE` | Protected local JSON of manually reviewed report hashes, sources, chains and exact vault addresses. Unset or empty approvals disable feed signing; see [the hardening runbook](docs/operational-hardening.md) |
| `WATCHER_REQUIRE_DIVERSITY` | Keep `true` for hosts submitting quorums; configure `WATCHER_PROFILE_FILE` with reviewed operator/model/source profiles |
| `CARD_VAULTS` | The vault list from `deploy/services.env.example` |

A watcher does **not** need Telegram settings, a public URL, a second RPC endpoint (`RPC_URL_BACKUP` follows
`RPC_URL`), or the router, adapter and plan-payment addresses. For `ROLE=watcher` the service leaves them out and fills
harmless placeholders for them. If a setting a
watcher does need is missing or badly formed, it stops at start and names the setting, instead of running and doing
nothing.

The `indexer` and `detector` processes have not been slimmed down. They take the full settings of
`deploy/services.env.example`: your RPC URLs, the router, adapter and plan-payment addresses from
`deploy/out/4663/deployment.json`, `START_BLOCK`, and a Telegram token and webhook secret. Use a throwaway token from
BotFather (Telegram's bot-making bot) and any random 16-character secret. Nobody follows a vault in your database, so they never send a message.

**Matching evidence is not independent verification.** Signatures combine when they bind the same alarm key and exact report hashes. Operators must independently review the source, chain and affected addresses before approving that evidence, using genuinely separate operators, model families and primary sources. Sharing an unverified feed/model pipeline across several keys is not independent confirmation. The local profile policy cannot prove the profile labels are true. The report approval tool and safe rollout steps are in [the operational hardening runbook](docs/operational-hardening.md).

### 4. Start the four containers

```bash
docker network create canopy-watcher
docker run -d --name watcher-db --network canopy-watcher -e POSTGRES_PASSWORD=choose-one -v watcher-db:/var/lib/postgresql/data postgres:18.6
docker run -d --name watcher-indexer  --network canopy-watcher --restart unless-stopped --env-file chain.env -e ROLE=indexer  canopy-services
docker run -d --name watcher-detector --network canopy-watcher --restart unless-stopped --env-file chain.env -e ROLE=detector canopy-services
docker run -d --name watcher-signer   --network canopy-watcher --restart unless-stopped --env-file watcher.env -v "$PWD/report-approvals.json:/run/canopy/report-approvals.json:ro" canopy-services
```

Use the same database in both env files (the example uses the host name `watcher-db` on the Docker network). The
indexer takes a while to read the chain from `START_BLOCK`, so a new watcher is not useful on the first day: let it
catch up.

### 5. Check it

- `docker logs watcher-signer` should show no repeated errors. A running watcher is quiet most of the time.
- The indexer's block (the `cursors` table in your database) should be within a few blocks of the chain's tip.
- Until you are approved, your signatures are refused by Canopy's API (HTTP 403). That is expected, and it is safe to
  run like this while you apply.
- Once you are approved, your address appears on the Watchers page. For the first 2 days it is marked as not counting
  yet, because the AlarmBook ignores a new watcher until then (see [how approval works](#how-approval-works)). It shows
  "never" until you sign something, which is normal: signatures only happen when an incident looks real.

## Key handling

- **One key, one purpose.** Make a fresh key for the watcher. Never use a wallet that holds funds, a key you use
  anywhere else, or one that is also a keeper or a Safe signer.
- **It needs no money.** A watcher signs messages and sends no transactions. Don't fund the address.
- **Keep it out of files.** Put it in your host's secret store or an environment variable the container reads at
  start. Don't put it in the image, in the repository, in a screenshot, in a chat or in an issue. The service scrubs
  URLs from its logs, but don't rely on logs to hide a key.
- **Nobody needs to see it.** The team will never ask for your private key. You send the **public address** only.
- **If it might be exposed, say so right away.** Stop the container, then tell us through
  [private reporting](SECURITY.md#reporting-a-problem). We will ask for the address to be removed, and you can apply
  again with a new key.
- **Replacing it is cheap.** Losing a key costs you one new application, not any money.

## Apply to be added

1. Run a watcher for a while and make sure it is steady (see [what we expect](#what-we-expect)).
2. Open the [watcher application](https://github.com/CanopyRH/canopy-app/issues/new?template=watcher-application.yml).
   It asks for your public watcher address, how to reach you, a short description of your setup, and how you decide
   when to sign. It does **not** ask for your name, your ID or any private detail, and you shouldn't give any.
3. A maintainer replies in the issue and may ask questions. We look at the setup, the signing policy, and whether your
   watcher is running and reading the same feeds.
4. If we agree, the admin Safe adds you: 2 of its 3 signers approve `setWatcher(yourAddress, until)` on the AlarmBook,
   through the Timelock, with `until` at most 365 days away. The change shows up as a `WatcherSet(watcher, since,
   until)` event on chain, as an alert to the operator chat, and on the Watchers page.
5. Our services accept signatures only from the addresses in their `WATCHERS` setting, so we add yours there too. Add
   the final list to your own `WATCHERS`.

There is no promised timeline and no payment for running a watcher. Approval is not a right. It is a decision by the
Safe signers.

## How approval works

The AlarmBook (version 2) approves a watcher with `setWatcher(address, uint64 until)`. Three rules follow from it:

- **A new watcher counts only 2 days after it is approved.** Its `since` is the approval time plus 2 days
  (`WATCHER_DELAY`). Signatures made before that are refused by the contract, so a bad approval can be caught before
  it matters.
- **Every approval ends.** `until` is at most 365 days after the call (`MAX_WATCHER_TERM`), and from `until` on the
  watcher's signatures no longer count. The admin extends an active watcher with another `setWatcher` call, and the new
  end applies at once. Plan to ask for an extension well before the date on the Watchers page ("Approval ends").
- **Signatures are bound to version 2 of the AlarmBook.** A watcher signs an EIP-712 message under the domain name
  `Canopy AlarmBook`, version `"2"`, your chain id and the AlarmBook's address. A signature made for the old (v1)
  AlarmBook is rejected. The code in `services/src/watcher/attest.ts` sets this up, so use the current code from
  `main` and point `ALARM_BOOK` at the v2 AlarmBook.

## How removal works

The AlarmBook admin (the Timelock, run by a 2-of-3 Safe) can remove any watcher at any time with
`setWatcher(address, 0)`. That power does not expire with the router admin's `ADMIN_EXPIRY`, so a bad watcher can
always be removed. From the moment the change is executed, that address's signatures no longer count on chain. An
approval that is simply left to run out ends on its own at `until`.

We may ask for removal when:

- the operator asks (stop your containers first, then ask in your issue; you can't remove yourself on chain);
- the key may be exposed;
- the watcher signed something with no real evidence behind it;
- it has been offline for long stretches without notice, or has stopped reading the agreed feeds;
- the operator can't be reached.

The step-by-step is in [INCIDENT.md](INCIDENT.md#stop-a-watcher). A removal is public: the `WatcherSet` event is on
chain and the address leaves the Watchers page. It is not a punishment, and a removed operator can apply again.

## What we expect

- **Stay up.** Keep all three processes running and restart them if they stop. We would rather have a watcher that is
  up nearly all the time than one that is perfect for a week. Because quiet is normal, the Watchers page can't show
  whether you are up. Watch it yourself (container health, the indexer's block, an alert if the signer stops logging)
  and tell us in your issue before planned downtime of more than a day.
- **Sign only on real evidence.** Run the code as it is. Don't edit `decide.ts` to sign sooner, don't lower thresholds,
  and never sign by hand because a post looks scary. If you have doubts about a source or a label, open an issue instead
  of changing your setup. A signature is a public statement that this happened.
- **Keep the key safe** (above), and tell us quickly if something is wrong.
- **Stay on the shared settings.** Same feeds, same vault list, an accurate clock, and the current code from `main`.
- **Be reachable** by the contact method you gave, so we can reach you during an incident.
- **No custody, no secrets.** Don't run other services on the watcher's host or database.

## Where to find things

| What | Where |
| --- | --- |
| Who is approved, when each last signed, and whether the signature matched a fired alarm | The Watchers page, or `GET /watchers` on the API |
| Roles and who holds which power | [SECURITY.md](SECURITY.md) |
| Stopping or removing a watcher | [INCIDENT.md](INCIDENT.md#stop-a-watcher) |
| Settings for every role | [deploy/services.env.example](deploy/services.env.example) |
| Settings for a watcher | [deploy/watcher.env.example](deploy/watcher.env.example) |
