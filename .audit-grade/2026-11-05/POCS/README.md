# Canopy (canopy-app) audit PoCs

Commit audited: 71c1fa0bd997bfa4504494789b99172123c295c2. Everything here runs on local mocks or a local
Postgres. Nothing touches a live system.

## Contracts (Foundry)

Copy the files into `contracts/test/`, then run them:

    cd contracts && forge test --match-contract 'AdminSwapConfigPoC|RefireGapPoC|ClaimOwedCheck' -vv

| File | Finding | Expected on the audited commit |
| --- | --- | --- |
| AdminSwapConfig.t.sol | M-1 | Both pass. The exploit test shows an owner's $20,000 of TOK paid out as $10; the control shows the honest-feed case delivering the raw token |
| RefireGap.t.sol | L-1 | Passes. The keeper exit reverts `AlarmNotLive` at T+1h and works only at T+24h |
| ClaimOwed.t.sol | coverage gap | Both pass. These are suggested regression tests for `claimOwed`, which the repo doesn't test |

## Services (Bun)

Copy the files into `services/test/`, then run them:

    cd services && TEST_DATABASE_URL=postgres://... bun test test/poc-*.test.ts

| File | Finding | Expected on the audited commit |
| --- | --- | --- |
| poc-keeper-hang.test.ts | H-1 | Passes. It proves `drainExits` is still looping after 3 s and the victim's exit was never sent; the control finishes |
| poc-backend.test.ts | M-2 (PoC-1), L-2 (PoC-2) | Passes. The alert handler blocks in proportion to followers; an attacker-registered QUORUM key gets an accepted attestation |
| poc-rpc-log.test.ts | L-3 | Passes. A keyed RPC URL appears in the error message |
| poc-sigvariant.test.ts | control | Passes. 64-byte compact signatures are rejected by `/watcher/attest` |

After a fix, the PoC assertions should flip. Turn each one into a regression test that expects the safe behaviour.

## Added by the independent check (H-2)

| File | Finding | Expected on the audited commit |
| --- | --- | --- |
| contracts/IndepGasBurner.t.sol | H-2 | Passes with `--gas-limit 50000000`. A burner first or in the middle leaves 0 calls succeeding at the top level; a burner last is harmless |
| services/indep-poke-burner.e2e.ts | H-2 | Needs a local anvil. The real `pokeTripped` pokes 0 of 120 honest keys when burners are present; the control pokes all 120 |
