import { parseAbi } from "viem";

export { alarmBookAbi, routerAbi } from "./abi.generated";

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const vaultAbi = parseAbi([
  "function asset() view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
  "function owner() view returns (address)",
  "function curator() view returns (address)",
  "function paused() view returns (bool)",
]);

/** Morpho Vault V2 only. Reads revert on other vaults, which is how V1 is told apart. */
export const vaultV2Abi = parseAbi([
  "function liquidityAdapter() view returns (address)",
  "function adaptersLength() view returns (uint256)",
  "function adapters(uint256) view returns (address)",
  "function abdicated(bytes4) view returns (bool)",
  "function sendSharesGate() view returns (address)",
  "function receiveSharesGate() view returns (address)",
  "function receiveAssetsGate() view returns (address)",
  "function forceDeallocatePenalty(address) view returns (uint256)",
  "function forceDeallocate(address adapter, bytes data, uint256 assets, address onBehalf) returns (uint256)",
]);

export const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[])",
]);
