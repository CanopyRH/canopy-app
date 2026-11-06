"""Hand-written mutation campaign over ExitRouter.sol and AlarmBook.sol (third review of v2, extended for the V3 fixes).

Run it on a scratch COPY of contracts/ (it edits src/ in place and restores each file):
    cp -R contracts /some/scratch/dir && FORGE=/path/to/forge python3 -I mutants.py /some/scratch/dir/contracts
Each mutant is (file, name, exact old text, new text); the old text must occur exactly once. A mutant is KILLED when
`forge test` fails, SURVIVED when it passes. Results are in mutants.results.tsv: the review run (existing suite, then with the review tests) and the v2_fix run
(117 mutants after the V3 fixes: 102 killed, 2 equivalent, and the 13 the review also left alive).
"""
import subprocess, sys, json, os

ROOT = sys.argv[1]
FORGE = os.environ.get("FORGE", "forge")
ER, AB = "src/ExitRouter.sol", "src/AlarmBook.sol"

M = [
 # ---- ExitRouter
 (ER, "arm: pause ignores expiry", "if (armingPaused && block.timestamp < ADMIN_EXPIRY) revert ArmingIsPaused();", "if (armingPaused) revert ArmingIsPaused();"),
 (ER, "arm: adapter allowlist off", "if (!adapterAllowed[a.adapter]) revert NotSupported();", "if (false) revert NotSupported();"),
 (ER, "arm: harbour >=", "if (a.harbour > HARBOUR_STABLE) revert BadHarbour();", "if (a.harbour >= HARBOUR_STABLE) revert BadHarbour();"),
 (ER, "arm: slip cap >=", "if (a.maxSlipBps > MAX_SLIP_CAP_BPS) revert SlipTooHigh();", "if (a.maxSlipBps >= MAX_SLIP_CAP_BPS) revert SlipTooHigh();"),
 (ER, "arm: keys cap >=", "if (a.keys.length > MAX_KEYS) revert TooManyKeys();", "if (a.keys.length >= MAX_KEYS) revert TooManyKeys();"),
 (ER, "arm: armable check off", "if (!ALARMS.armable(a.keys[i])) revert AlarmNotClear(a.keys[i]);", "if (false) revert AlarmNotClear(a.keys[i]);"),
 (ER, "arm: NFT owner check off", "if (IERC721(asset).ownerOf(a.tokenId) != msg.sender) revert NotOwner();", "if (false) revert NotOwner();"),
 (ER, "arm: tokenId check off", "} else if (a.tokenId != 0) {", "} else if (false) {"),
 (ER, "arm: old keys not cleared", "keyArmed[posId][old[i]] = false;", ""),
 (ER, "arm: armedAt one second early", "armedAt: uint64(block.timestamp),", "armedAt: uint64(block.timestamp - 1),"),
 (ER, "arm: epoch 0", "epoch: epochOf[msg.sender],", "epoch: 0,"),
 (ER, "disarm: no owner check", "if (positions[posId].owner != msg.sender) revert NotOwner();\n        positions[posId].active = false;", "positions[posId].active = false;"),
 (ER, "disarm: stays active", "positions[posId].active = false;", "positions[posId].active = true;"),
 (ER, "disarmAll: no increment", "uint64 e = ++epochOf[msg.sender];", "uint64 e = epochOf[msg.sender];"),
 (ER, "claim: owed not zeroed", "owed[owner][token] = 0;\n", ""),
 (ER, "claim: totalOwed not reduced", "totalOwed[token] -= amt;\n", ""),
 (ER, "claim: zero allowed", "if (amt == 0) revert NothingOwed();", ""),
 (ER, "claim: ETH failure ignored", "if (!ok) revert NothingOwed();", ""),
 (ER, "isArmed: ignores epoch", "return p.active && p.epoch == epochOf[p.owner];", "return p.active;"),
 (ER, "quote: slip bound off", "slipBps > MAX_SLIP_CAP_BPS || ", ""),
 (ER, "quote: stable floor off", "if (pU * 10_000 < STABLE_FLOOR_BPS * 10 ** dU) return (false, 0);", ""),
 (ER, "quote: double slip", "minOut = (fair * (10_000 - slipBps)) / 10_000;", "minOut = (fair * (10_000 - 2 * slipBps)) / 10_000;"),
 (ER, "quote: ok always", "ok = minOut > 0;", "ok = true;"),
 (ER, "admin: no expiry", " || block.timestamp >= ADMIN_EXPIRY) revert NotAdmin();", ") revert NotAdmin();"),
 (ER, "pause: no expiry", "if (block.timestamp >= ADMIN_EXPIRY) revert NotGuardian();", ""),
 (ER, "pause: anyone", "if (msg.sender != guardian && msg.sender != ADMIN) revert NotGuardian();", ""),
 (ER, "legs: raw harbour allowed", "if (harbour != HARBOUR_STABLE) revert SwapsNeedStableHarbour();", ""),
 (ER, "legs: max >=", "if (swaps.length > MAX_SWAPS) revert TooManySwaps();", "if (swaps.length >= MAX_SWAPS) revert TooManySwaps();"),
 (ER, "legs: duplicates allowed", "if (swaps[j].token == l.token) revert DuplicateSwap(l.token);", ""),
 (ER, "legs: heartbeat +1", "l.heartbeat > MAX_FEED_HEARTBEAT) revert BadFeed();", "l.heartbeat > MAX_FEED_HEARTBEAT + 1) revert BadFeed();"),
 (ER, "legs: decimals >=", "if (l.tokenDecimals > MAX_TOKEN_DECIMALS) revert BadFeed();", "if (l.tokenDecimals >= MAX_TOKEN_DECIMALS) revert BadFeed();"),
 (ER, "legs: decimals not compared", "if (!okD || dec[0] != l.tokenDecimals) revert BadFeed();", "if (!okD) revert BadFeed();"),
 (ER, "legs: path alignment off", "if (path.length < 43 || (path.length - 20) % 23 != 0) revert BadRoute();", "if (path.length < 43) revert BadRoute();"),
 (ER, "legs: end not checked", "if (address(bytes20(path[path.length - 20:])) != STABLE) revert BadRoute();", ""),
 (ER, "legs: start not checked", "if (address(bytes20(path[0:20])) != l.token) revert BadRoute();", ""),
 (ER, "auth: epoch ignored", "if (!p.active || p.epoch != epochOf[p.owner]) revert NotArmed();", "if (!p.active) revert NotArmed();"),
 (ER, "auth: key not checked", "if (!keyArmed[posId][alarmKey]) revert NotAuthorized();", ""),
 (ER, "auth: ttl ignores arming", "sinceArmed < ALARM_TTL ? sinceArmed : ALARM_TTL", "ALARM_TTL"),
 (ER, "auth: ttl off by one", "sinceArmed < ALARM_TTL ? sinceArmed : ALARM_TTL", "sinceArmed + 1 < ALARM_TTL ? sinceArmed + 1 : ALARM_TTL"),
 (ER, "auth: owner treated as third party", "if (msg.sender == p.owner) return false;", "if (msg.sender == p.owner) return true;"),
 (ER, "unwind: stable not netted", "uint256 stableOut = _free(STABLE) - stableBefore;", "uint256 stableOut = _free(STABLE);"),
 (ER, "unwind: stable to caller", "_pay(exitId, p.owner, STABLE, stableOut, p.harbour == HARBOUR_STABLE);", "_pay(exitId, msg.sender, STABLE, stableOut, p.harbour == HARBOUR_STABLE);"),
 (ER, "unwind: stable only on stable harbour", "if (stableOut > 0) {", "if (stableOut > 0 && p.harbour == HARBOUR_STABLE) {"),
 (ER, "pull: ignores allowance", "uint256 amt = bal < al ? bal : al;", "uint256 amt = bal;"),
 (ER, "pull: amount above balance", "if (amount != 0 && amount < amt) amt = amount;", "if (amount != 0) amt = amount;"),
 (ER, "pull: zero allowed", "if (amt == 0) revert NothingToExit();", ""),
 (ER, "outputs: no leftover share", "if (extra == 1) list[outs.length] = p.asset;", ""),
 (ER, "free: ignores owed", "return bal > o ? bal - o : 0;", "return bal;"),
 (ER, "settle: no third-party cap", "uint16 slip = viaAlarm && p.maxSlipBps > THIRD_PARTY_SLIP_CAP_BPS ? THIRD_PARTY_SLIP_CAP_BPS : p.maxSlipBps;", "uint16 slip = p.maxSlipBps;"),
 (ER, "settle: stable not skipped", "if (t == STABLE) continue;", ""),
 (ER, "settle: shares not special", "if (!p.isNft && t == p.asset) {", "if (false) {"),
 (ER, "settle: shares to caller", "_pay(exitId, p.owner, t, d, false); // unredeemed", "_pay(exitId, msg.sender, t, d, false); // unredeemed"),
 (ER, "settle: proceeds to caller", "_pay(exitId, p.owner, t, d, false);\n                delivered = true;", "_pay(exitId, msg.sender, t, d, false);\n                delivered = true;"),
 (ER, "swap: first leg for any token", "if (legs[i].token == token) return _trySwap(token, amount, slipBps, legs[i]);", "return _trySwap(token, amount, slipBps, legs[i]);"),
 (ER, "swap: approval not reset", "token.tryApprove(SWAP_ROUTER, 0);", ""),
 (ER, "swap: no minimum", "amountOutMinimum: minOut", "amountOutMinimum: 0"),
 (ER, "swap: quote uncapped", "address(this).staticcall{gas: QUOTE_GAS}(", "address(this).staticcall("),
 (ER, "pay: totalOwed not booked", "            totalOwed[token] += amount;\n            emit Owed(owner, token, amount);", "            emit Owed(owner, token, amount);"),
 (ER, "price: future/zero updatedAt", "if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) return (false, 0, 0);", "if (answer <= 0) return (false, 0, 0);"),
 (ER, "price: staleness off", "if (block.timestamp - updatedAt > heartbeat) return (false, 0, 0);", ""),
 (ER, "price: decimals bound off", "if (!okD || dd[0] > 30) return (false, 0, 0);", "if (!okD) return (false, 0, 0);"),
 (ER, "price: feed read uncapped", "abi.encodeWithSelector(0xfeaf968c), FEED_READ_GAS, 5)", "abi.encodeWithSelector(0xfeaf968c), gasleft(), 5)"),
 # ---- AlarmBook
 (AB, "watcher: anyone sets", "if (msg.sender != ADMIN) revert NotAdmin();\n        if (until == 0)", "if (until == 0)"),
 (AB, "watcher: no term cap", "if (until <= block.timestamp || until > block.timestamp + MAX_WATCHER_TERM) revert BadWatcherTerm();", "if (until <= block.timestamp) revert BadWatcherTerm();"),
 (AB, "watcher: no delay", "uint64 since = isWatcher(w) ? watcherSince[w] : uint64(block.timestamp + WATCHER_DELAY);", "uint64 since = uint64(block.timestamp);"),
 (AB, "watcher: lapsed keeps old start", "uint64 since = isWatcher(w) ? watcherSince[w]", "uint64 since = watcherSince[w] != 0 ? watcherSince[w]"),
 (AB, "watcher: until inclusive", "block.timestamp < watcherUntil[w]", "block.timestamp <= watcherUntil[w]"),
 (AB, "register: re-register resets", "if (s.exists) return key;", ""),
 (AB, "register: zero share price ok", "if (!ok || px == 0) revert BadDetector();", "if (!ok) revert BadDetector();"),
 (AB, "register: drain snapAt unset", "s.snapAt = uint64(block.timestamp);\n        }\n        emit Registered", "}\n        emit Registered"),
 (AB, "check: confirm ignored", "return block.timestamp >= uint256(s.pendingAt) + DRAIN_CONFIRM;", "return true;"),
 (AB, "armable: live ignored", "if (!s.exists || _liveNow(s)) return false;\n        Detector memory d = _detectors[key];\n        if (d.kind == Kind.DRAIN && _pendingLive", "if (!s.exists) return false;\n        Detector memory d = _detectors[key];\n        if (d.kind == Kind.DRAIN && _pendingLive"),
 (AB, "armable: pending ignored", "if (d.kind == Kind.DRAIN && _pendingLive(s, d)) return false;", ""),
 (AB, "armable: unknown is clear", "return r == Reading.CLEAR;", "return r != Reading.TRIPPED;"),
 (AB, "poke: unreadable drain sights", "if (r != Reading.TRIPPED) return false; // clear", "if (r == Reading.CLEAR) return false; // clear"),
 (AB, "poke: no confirm delay", "if (block.timestamp < uint256(s.pendingAt) + DRAIN_CONFIRM) return false;", ""),
 (AB, "poke: pending kept after fire", "s.pendingAt = 0;\n        } else if", "} else if"),
 (AB, "poke: refire while live", "if (_liveNow(s)) return false;\n        Detector memory d = _detectors[key];\n        (Reading r,) = _reading(d, s);\n        if (d.kind == Kind.DRAIN) {", "Detector memory d = _detectors[key];\n        (Reading r,) = _reading(d, s);\n        if (d.kind == Kind.DRAIN) {"),
 (AB, "checkpoint: rolls while tripped", "if (r != Reading.CLEAR) return;", ""),
 (AB, "checkpoint: mark can fall", "if (v > s.baseline) {", "if (v != s.baseline) {"),
 (AB, "checkpoint: drain last sample", "if (v < s.baseline) s.baseline = v;", "s.baseline = v;"),
 (AB, "checkpoint: period = window", "if (block.timestamp < uint256(s.snapAt) + d.window / 2) {", "if (block.timestamp < uint256(s.snapAt) + d.window) {"),
 (AB, "checkpoint: zero sample", "if (v == 0) return;", ""),
 (AB, "rebase: any kind", "if (d.kind != Kind.SHARE_DROP && d.kind != Kind.ADDRESS_CHANGE && d.kind != Kind.DRAIN) revert NotRebasable();", ""),
 (AB, "rebase: stale episode ok", "if (!_episodeCurrent(s) || block.timestamp < uint256(s.episodeAt) + REBASE_AFTER) revert EpisodeTooShort();", "if (block.timestamp < uint256(s.episodeAt) + REBASE_AFTER) revert EpisodeTooShort();"),
 (AB, "rebase: clear ok", "if (r != Reading.TRIPPED) revert NotTripped();", ""),
 (AB, "rebase: episode kept", "s.episodeAt = 0;\n        emit Rebased", "emit Rebased"),
 (AB, "rebase: pending kept", "s.pendingAt = 0;\n        }\n        s.episodeAt = 0;", "}\n        s.episodeAt = 0;"),
 (AB, "quorum: deadline >=", "if (block.timestamp > deadline) revert Expired();", "if (block.timestamp >= deadline) revert Expired();"),
 (AB, "quorum: far deadline ok", "if (deadline > block.timestamp + MAX_ATTEST_LIFE) revert DeadlineTooFar();", ""),
 (AB, "quorum: refire while live", "if (_liveNow(s)) revert AlreadyLive();", ""),
 (AB, "quorum: threshold ignored", "if (signers.length < d.threshold || signers.length != sigs.length) revert BadSigners();", "if (signers.length != sigs.length) revert BadSigners();"),
 (AB, "quorum: duplicates ok", "if (w <= prev) revert BadSigners();", "if (w < prev) revert BadSigners();"),
 (AB, "quorum: non-watcher ok", "if (!isWatcher(w)) revert NotWatcher(w);", ""),
 (AB, "isLive: strict", "return s.firedAt != 0 && block.timestamp <= uint256(s.firedAt) + ttl;", "return s.firedAt != 0 && block.timestamp < uint256(s.firedAt) + ttl;"),
 (AB, "fire: episode always restarts", "if (!_episodeCurrent(s)) s.episodeAt = uint64(block.timestamp);", "s.episodeAt = uint64(block.timestamp);"),
 (AB, "episode: 1 day gap", "block.timestamp <= uint256(s.firedAt) + 2 * REFIRE_AFTER;", "block.timestamp <= uint256(s.firedAt) + REFIRE_AFTER;"),
 (AB, "liveNow: inclusive", "block.timestamp < uint256(s.firedAt) + REFIRE_AFTER;", "block.timestamp <= uint256(s.firedAt) + REFIRE_AFTER;"),
 (AB, "pending: 2x window", "block.timestamp <= uint256(s.pendingAt) + d.window;", "block.timestamp <= uint256(s.pendingAt) + 2 * d.window;"),
 (AB, "validate: short drain window", "if (k == Kind.DRAIN && d.window < MIN_DRAIN_WINDOW) revert BadDetector();", ""),
 (AB, "validate: quorum of 1", "if (d.threshold < 2 || d.threshold > MAX_QUORUM) revert BadDetector();", "if (d.threshold < 1 || d.threshold > MAX_QUORUM) revert BadDetector();"),
 (AB, "validate: short BOTH window", " || d.window < REFIRE_AFTER) revert BadDetector();", ") revert BadDetector();"),
 (AB, "reading: share drop <=", "px * 10_000 < s.baseline * (10_000 - d.threshold)", "px * 10_000 <= s.baseline * (10_000 - d.threshold)"),
 (AB, "reading: exhausted ignored", "if (exhausted) return (Reading.UNKNOWN, 0);", ""),
 (AB, "reading: drain reference never expires", "if (s.snap == 0 || s.prevSnap == 0 || block.timestamp - s.snapAt > d.window) return (Reading.CLEAR, ta);", "if (s.snap == 0 || s.prevSnap == 0) return (Reading.CLEAR, ta);"),
 (AB, "reading: drain ignores prevSnap", "uint256 ref = s.snap < s.prevSnap ? s.snap : s.prevSnap;", "uint256 ref = s.snap;"),
 (AB, "reading: drain needs no prevSnap", "if (s.snap == 0 || s.prevSnap == 0 ||", "if (s.snap == 0 ||"),
 (AB, "checkpoint: prevSnap not rolled", "s.prevSnap = s.snap;\n", ""),
 (AB, "rebase: prevSnap kept", "s.prevSnap = 0;\n", ""),
 (AB, "reading: price staleness off", " || block.timestamp - upd > d.window) return (Reading.UNKNOWN, 0);", ") return (Reading.UNKNOWN, 0);"),
 (AB, "read: no gas floor", "if (gasleft() < TARGET_READ_GAS + READ_GAS_OVERHEAD) revert NotEnoughGas();", ""),
 (AB, "read: overhead without 1/64", "READ_GAS_OVERHEAD = TARGET_READ_GAS / 63 + 10_000;", "READ_GAS_OVERHEAD = 10_000;"),
 (AB, "read: never exhausted", "exhausted = !succeeded && used >= TARGET_READ_GAS;", "exhausted = false;"),
 (AB, "read: decimals bound off", "if (!ok || w[0] > 36) return (false, 0);", "if (!ok) return (false, 0);"),
 (AB, "read: address bound off", "if (!ok || w[0] > type(uint160).max) return (false, 0);", "if (!ok) return (false, 0);"),
 (AB, "domain: version 1", 'keccak256("2"),', 'keccak256("1"),'),
 (AB, "ctor: 2-year watchers", "uint64 until = uint64(block.timestamp + MAX_WATCHER_TERM);", "uint64 until = uint64(block.timestamp + 2 * MAX_WATCHER_TERM);"),
]

def run():
    results = []
    for f, name, old, new in M:
        p = os.path.join(ROOT, f)
        src = open(p).read()
        n = src.count(old)
        if n != 1:
            results.append((f, name, f"SKIP(count={n})")); print(name, "SKIP", n, flush=True); continue
        open(p, "w").write(src.replace(old, new))
        try:
            r = subprocess.run([FORGE, "test"], cwd=ROOT, capture_output=True, text=True, timeout=600)
            out = r.stdout + r.stderr
            if "Compiler run failed" in out or "Error (" in out:
                status = "COMPILE_FAIL"
            elif r.returncode == 0:
                status = "SURVIVED"
            else:
                status = "KILLED"
        except subprocess.TimeoutExpired:
            status = "KILLED(timeout)"
        finally:
            open(p, "w").write(src)
        results.append((f, name, status)); print(f"{status:10} {f} :: {name}", flush=True)
    json.dump(results, open(os.path.join(ROOT, "mutants.json"), "w"), indent=1)

if __name__ == "__main__":
    run()
