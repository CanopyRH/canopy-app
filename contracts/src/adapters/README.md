# LP adapter status

UniswapV3Adapter is ported from the existing private branch and tested against the current v2 router,
including an RH manager fork. Activation still requires a deployed adapter and the existing admin/Safe
allowlist operation. The app defaults to no configured LP adapter.

UniswapV4Adapter is a separate hookless-only candidate. It uses official PositionManager decrease and
take-pair actions, returns the empty NFT, and supports native currency outputs through the router.
Hooked pools are explicitly refused. A blocked currency reverts the entire v4 settlement; unlike the v3
collect fallback, it does not deliver the other currency independently.

V4 is not in the live app/keeper: it needs a pinned manager deployment, event-based NFT discovery,
a v4-specific keeper simulation path and fork validation. The v3 keeper must not be pointed at a v4
manager. No new adapter is activated by source inclusion.

Both adapters use zero per-token liquidity-removal minima; price movement changes the output mix.
Optional stablecoin conversion is a separate router step with owner-reviewed feeds and paths.

V4 interface references checked 2026-11-06:
https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IPositionManager.sol
https://github.com/Uniswap/v4-periphery/blob/main/src/libraries/Actions.sol
https://github.com/Uniswap/v4-periphery/blob/main/src/PositionManager.sol
