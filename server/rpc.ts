// JSON-RPC access to four chains and to Solana, through our own configured endpoints.
// Used for token checks, deposit confirmation, the pool's wallet and the payout tools, and the one
// question a page may ask of a chain (see parseProxyBody).
// RPC URLs can contain keys, so they are never logged or returned.

import { WALLET_CHAINS, type WalletChain } from "../shared/chains.ts";
import { readCappedText } from "./read.ts";

export interface RpcCall {
  method: string;
  params: unknown[];
}

export type RpcResult = { ok: true; result: unknown } | { ok: false; code: number; message: string; data?: string };

export interface Rpc {
  batch(chain: WalletChain, calls: RpcCall[]): Promise<RpcResult[]>;
  call(chain: WalletChain, method: string, params: unknown[]): Promise<RpcResult>;
  /** Reads from Solana, through the server's own endpoint: the pool's wallet, and the payout tools' checks. Never asked by a browser. */
  solana(calls: RpcCall[]): Promise<RpcResult[]>;
}

const MAX_RESPONSE_BYTES = 2_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toResult(entry: unknown): RpcResult {
  if (!isRecord(entry)) return { ok: false, code: -32603, message: "RPC error" };
  if (isRecord(entry.error)) {
    // The node's own error text is never passed on. The numeric code is, and any revert data.
    const { code, data } = entry.error;
    const numeric = typeof code === "number" && Number.isInteger(code) ? code : -32603;
    return {
      ok: false,
      code: numeric,
      message: numeric === 3 ? "execution reverted" : "RPC error",
      ...(typeof data === "string" && /^0x[0-9a-fA-F]{0,2048}$/.test(data) ? { data } : {}),
    };
  }
  if (!("result" in entry)) return { ok: false, code: -32603, message: "RPC error" };
  return { ok: true, result: entry.result };
}

export function createRpc(options: { urls: Readonly<Record<WalletChain | "sol", string>>; fetchImpl?: typeof fetch }): Rpc {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function batch(chain: WalletChain, calls: RpcCall[]): Promise<RpcResult[]> {
    if (!WALLET_CHAINS.includes(chain)) throw new Error("unsupported chain");
    return post(options.urls[chain], calls);
  }

  async function post(url: string, calls: RpcCall[]): Promise<RpcResult[]> {
    if (calls.length === 0) return [];
    const payload = calls.map((c, id) => ({ jsonrpc: "2.0", id, method: c.method, params: c.params }));
    const failed = (): RpcResult[] => calls.map(() => ({ ok: false, code: -32603, message: "RPC unavailable" }));
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload.length === 1 ? payload[0] : payload),
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return failed();
      const text = await readCappedText(res, MAX_RESPONSE_BYTES);
      const parsed: unknown = JSON.parse(text);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      const byId = new Map<number, unknown>();
      for (const entry of entries) if (isRecord(entry) && typeof entry.id === "number") byId.set(entry.id, entry);
      return calls.map((_, id) => toResult(byId.get(id)));
    } catch {
      return failed();
    }
  }

  return {
    batch,
    solana: (calls) => post(options.urls.sol, calls),
    async call(chain, method, params) {
      const [result] = await batch(chain, [{ method, params }]);
      return result ?? { ok: false, code: -32603, message: "RPC unavailable" };
    },
  };
}

// ---- The one read a browser may ask for ----

/**
 * The page asks a chain one question, through this server: is this address a contract? (A contract
 * where a wallet is expected is worth a warning beside an address field.) That is `eth_getCode` of
 * one 0x address at the latest block, and nothing else is passed on: no other method, no other
 * block, no batch. The server is not a way to a chain's node for anything else.
 */
export const PROXY_METHOD = "eth_getCode";

export interface ProxyRequest {
  id: string | number | null;
  call: RpcCall;
}

/** Checks a browser's JSON-RPC body against that one question. Returns null when it is anything else. */
export function parseProxyBody(body: unknown): ProxyRequest | null {
  if (!isRecord(body) || body.jsonrpc !== "2.0" || body.method !== PROXY_METHOD) return null;
  const id = body.id;
  if (!(id === null || id === undefined || typeof id === "number" || (typeof id === "string" && id.length <= 64))) return null;
  const params = body.params;
  if (!Array.isArray(params) || params.length !== 2) return null;
  const [address, block] = params as unknown[];
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address) || block !== "latest") return null;
  return { id: id ?? null, call: { method: PROXY_METHOD, params: [address, "latest"] } };
}

// ---- Small ABI helpers ----

export const SELECTOR_DECIMALS = "0x313ce567";
export const SELECTOR_TRANSFER = "0xa9059cbb";

/** Decodes `transfer(address,uint256)` call data. Null when the data is anything else. */
export function decodeErc20Transfer(input: unknown): { to: string; amount: bigint } | null {
  if (typeof input !== "string" || !/^0xa9059cbb[0-9a-fA-F]{128}$/.test(input)) return null;
  const toWord = input.slice(10, 74);
  if (!/^0{24}/.test(toWord)) return null;
  return { to: `0x${toWord.slice(24).toLowerCase()}`, amount: BigInt(`0x${input.slice(74, 138)}`) };
}

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Decodes an ERC-20 Transfer event from a receipt log. Null for any other log. */
export function decodeTransferLog(log: unknown): { token: string; from: string; to: string; amount: bigint } | null {
  if (!isRecord(log) || typeof log.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(log.address)) return null;
  const { topics, data } = log;
  if (!Array.isArray(topics) || topics.length !== 3 || topics[0] !== TRANSFER_TOPIC) return null;
  const [, from, to] = topics as unknown[];
  const word = /^0x0{24}[0-9a-fA-F]{40}$/;
  if (typeof from !== "string" || typeof to !== "string" || !word.test(from) || !word.test(to)) return null;
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(data)) return null;
  return { token: log.address.toLowerCase(), from: `0x${from.slice(26).toLowerCase()}`, to: `0x${to.slice(26).toLowerCase()}`, amount: BigInt(data) };
}

export function hexToBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) return null;
  return BigInt(value);
}
