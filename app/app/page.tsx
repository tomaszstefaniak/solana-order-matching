"use client";
import { useConnection, useWallet, useAnchorWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { AnchorProvider, Program, BN, web3 } from "@coral-xyz/anchor";
import { useState, useEffect, useCallback } from "react";
import idl from "../idl/order_matching.json";

const PROGRAM_ID = new web3.PublicKey("CpnJ2pRUqZxSLh45qiX58YyJBuhQ3voDKKy8RYibnJ4n");

type OrderStatus = "Open" | "Filled" | "Cancelled" | "PartiallyFilled";
type Side = "Buy" | "Sell";

interface MarketData {
  admin: string;
  feeBps: number;
  orderCount: number;
  address: string;
}

interface OrderData {
  address: string;
  orderId: number;
  owner: string;
  side: Side;
  orderType: string;
  price: number;
  quantity: number;
  filledQty: number;
  status: OrderStatus;
}

/**
 * Safely extract a base58 public key string from any PublicKey-like object.
 * Handles the case where _bn is undefined (e.g. Phantom wallet serialization).
 */
function safePubkeyBase58(pubkey: any): string {
  // 1. Try toJSON() — returns base58 string without relying on _bn in some implementations
  try { const j = pubkey.toJSON(); if (typeof j === 'string' && j.length > 0) return j; } catch { }
  // 2. Try toBase58() directly
  try { const b = pubkey.toBase58(); if (typeof b === 'string') return b; } catch { }
  // 3. Try toString()
  try { const s = pubkey.toString(); if (typeof s === 'string' && s.length > 20) return s; } catch { }
  // 4. Access _bn directly and convert
  try { if (pubkey._bn) return new web3.PublicKey(pubkey._bn.toArray()).toBase58(); } catch { }
  // 5. If it's already a string, just use it
  if (typeof pubkey === 'string') return pubkey;
  throw new Error('Unable to extract public key from wallet');
}

function getProgram(connection: web3.Connection, wallet: any) {
  const pubkeyStr = safePubkeyBase58(wallet.publicKey);
  const strictAnchorWallet = {
    signTransaction: wallet.signTransaction,
    signAllTransactions: wallet.signAllTransactions,
    publicKey: new web3.PublicKey(pubkeyStr),
  };
  const provider = new AnchorProvider(connection, strictAnchorWallet as any, { commitment: "confirmed" });
  return new Program(idl as any, provider);
}

function getMarketPDA(adminKey: web3.PublicKey): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("market"), adminKey.toBuffer()],
    PROGRAM_ID
  );
}

function getOrderPDA(marketKey: web3.PublicKey, orderId: number): [web3.PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(orderId));
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("order"), marketKey.toBuffer(), buf],
    PROGRAM_ID
  );
}

function shortKey(key: string) {
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function statusColor(status: OrderStatus) {
  if (status === "Open") return "text-green-400";
  if (status === "Filled") return "text-blue-400";
  if (status === "Cancelled") return "text-red-400";
  return "text-yellow-400";
}

export default function Home() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const anchorWallet = useAnchorWallet();
  const [market, setMarket] = useState<MarketData | null>(null);
  const [orders, setOrders] = useState<OrderData[]>([]);
  const [feeBps, setFeeBps] = useState("25");
  const [side, setSide] = useState<Side>("Buy");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [bidId, setBidId] = useState("");
  const [askId, setAskId] = useState("");
  const [txLog, setTxLog] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);

  const log = (msg: string) => setStatus(msg);
  const addTx = (sig: string) => setTxLog((prev) => [sig, ...prev].slice(0, 5));

  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const fetchMarket = useCallback(async () => {
    if (!anchorWallet || !anchorWallet.publicKey) return;
    try {
      const program = getProgram(connection, anchorWallet);
      const userKey = new web3.PublicKey(safePubkeyBase58(anchorWallet.publicKey));
      const [marketPDA] = getMarketPDA(userKey);
      const data = await (program.account as any).market.fetch(marketPDA);
      console.log("fetchMarket: Data fetched successfully");
      setMarket({
        admin: data.admin.toBase58(),
        feeBps: data.feeBps,
        orderCount: (data.orderCount && typeof data.orderCount.toNumber === 'function') ? data.orderCount.toNumber() : 0,
        address: marketPDA.toBase58(),
      });
    } catch (e: any) {
      // "Account does not exist" is expected when no market has been created yet
      if (!e.message?.includes("Account does not exist")) {
        console.error("fetchMarket error:", e);
        log(`fetchMarket error: ${e.message}`);
      }
      setMarket(null);
    }
  }, [connection, anchorWallet]);

  const fetchOrders = useCallback(async () => {
    if (!anchorWallet || !anchorWallet.publicKey || !market) return;
    try {
      const program = getProgram(connection, anchorWallet);
      const all = await (program.account as any).order.all([
        {
          memcmp: {
            offset: 8,
            bytes: market.address,
          },
        },
      ]);
      console.log(`fetchOrders: ${all.length} orders fetched`);
      // Anchor returns enum variants as camelCase keys e.g. { open: {} }, { buy: {} }
      // Normalize to PascalCase to match our OrderStatus / Side types
      const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
      const parsed: OrderData[] = all.map((a: any) => ({
        address: a.publicKey.toBase58(),
        orderId: (a.account.orderId && typeof a.account.orderId.toNumber === 'function') ? a.account.orderId.toNumber() : 0,
        owner: a.account.owner.toBase58(),
        side: (a.account.side && typeof a.account.side === 'object' ? cap(Object.keys(a.account.side)[0]) : "Buy") as Side,
        orderType: a.account.orderType.limit !== undefined ? "Limit" : "Market",
        price: (a.account.price && typeof a.account.price.toNumber === 'function') ? a.account.price.toNumber() : 0,
        quantity: (a.account.quantity && typeof a.account.quantity.toNumber === 'function') ? a.account.quantity.toNumber() : 0,
        filledQty: (a.account.filledQty && typeof a.account.filledQty.toNumber === 'function') ? a.account.filledQty.toNumber() : 0,
        status: (a.account.status && typeof a.account.status === 'object' ? cap(Object.keys(a.account.status)[0]) : "Open") as OrderStatus,
      }));
      setOrders(parsed.sort((a, b) => a.orderId - b.orderId));
    } catch (e: any) {
      console.error("fetchOrders Error:", e);
      log(`fetchOrders Error: ${e.message}`);
    }
  }, [connection, anchorWallet, market]);

  const fetchBalance = useCallback(async () => {
    if (!anchorWallet || !anchorWallet.publicKey) return;
    try {
      const b = await connection.getBalance(anchorWallet.publicKey);
      setBalance(b / web3.LAMPORTS_PER_SOL);
    } catch (e) {
      console.error("fetchBalance error:", e);
    }
  }, [connection, anchorWallet]);

  useEffect(() => { fetchMarket(); }, [fetchMarket]);
  useEffect(() => { fetchOrders(); }, [fetchOrders]);
  useEffect(() => { fetchBalance(); }, [fetchBalance]);

  async function initMarket() {
    if (!anchorWallet || !anchorWallet.publicKey || !anchorWallet.signTransaction) return;
    setLoading(true);
    try {
      const program = getProgram(connection, anchorWallet);
      const userKey = new web3.PublicKey(safePubkeyBase58(anchorWallet.publicKey));
      const [marketPDA] = getMarketPDA(userKey);
      const tx = await (program.methods as any)
        .initializeMarket(parseInt(feeBps))
        .accounts({ market: marketPDA, admin: userKey, systemProgram: web3.SystemProgram.programId })
        .rpc();
      addTx(tx);
      log("Market initialized ✓");
      await fetchMarket();
    } catch (e: any) {
      log(`Error: ${e.message}`);
    }
    setLoading(false);
  }

  async function placeOrder() {
    if (!anchorWallet || !anchorWallet.publicKey || !market) return;
    setLoading(true);
    try {
      const program = getProgram(connection, anchorWallet);
      const userKey = new web3.PublicKey(safePubkeyBase58(anchorWallet.publicKey));
      const marketPDA = new web3.PublicKey(market.address);
      const orderId = market.orderCount;
      const [orderPDA] = getOrderPDA(marketPDA, orderId);
      const sideArg = side === "Buy" ? { buy: {} } : { sell: {} };
      const tx = await (program.methods as any)
        .placeOrder(sideArg, { limit: {} }, new BN(Math.round(parseFloat(price) * web3.LAMPORTS_PER_SOL)), new BN(quantity))
        .accounts({ market: marketPDA, order: orderPDA, owner: userKey, systemProgram: web3.SystemProgram.programId })
        .rpc();
      addTx(tx);
      log(`Order #${orderId} placed ✓`);
      await fetchMarket();
      await fetchOrders();
      setPrice(""); setQuantity("");
    } catch (e: any) {
      log(`Error: ${e.message}`);
    }
    setLoading(false);
  }

  async function cancelOrder(order: OrderData) {
    if (!anchorWallet || !anchorWallet.publicKey || !market) return;
    setLoading(true);
    try {
      const program = getProgram(connection, anchorWallet);
      const userKey = new web3.PublicKey(safePubkeyBase58(anchorWallet.publicKey));
      const marketPDA = new web3.PublicKey(market.address);
      const tx = await (program.methods as any)
        .cancelOrder()
        .accounts({ order: new web3.PublicKey(order.address), market: marketPDA, authority: userKey })
        .rpc();
      addTx(tx);
      log(`Order #${order.orderId} cancelled ✓`);
      await fetchOrders();
    } catch (e: any) {
      log(`Error: ${e.message}`);
    }
    setLoading(false);
  }

  async function closeOrder(order: OrderData) {
    if (!anchorWallet || !anchorWallet.publicKey || !market) return;
    setLoading(true);
    try {
      const program = getProgram(connection, anchorWallet);
      const userKey = new web3.PublicKey(safePubkeyBase58(anchorWallet.publicKey));
      const marketPDA = new web3.PublicKey(market.address);
      const tx = await (program.methods as any)
        .closeOrder()
        .accounts({ order: new web3.PublicKey(order.address), market: marketPDA, owner: userKey })
        .rpc();
      addTx(tx);
      log(`Order #${order.orderId} closed — rent reclaimed ✓`);
      await fetchOrders();
    } catch (e: any) {
      log(`Error: ${e.message}`);
    }
    setLoading(false);
  }

  async function matchOrders() {
    if (!anchorWallet || !anchorWallet.publicKey || !market) return;
    if (bidId === askId) { log("Error: Bid and Ask Order IDs must be different"); return; }
    const bidOrder = orders.find(o => o.orderId === parseInt(bidId));
    const askOrder = orders.find(o => o.orderId === parseInt(askId));
    if (bidOrder && bidOrder.side !== "Buy") { log(`Error: Order #${bidId} is a ${bidOrder.side} order — expected Buy for bid`); return; }
    if (askOrder && askOrder.side !== "Sell") { log(`Error: Order #${askId} is a ${askOrder.side} order — expected Sell for ask`); return; }
    if (bidOrder && askOrder && bidOrder.price < askOrder.price) { log(`Error: Bid price (${(bidOrder.price / web3.LAMPORTS_PER_SOL).toFixed(4)} SOL) must be ≥ Ask price (${(askOrder.price / web3.LAMPORTS_PER_SOL).toFixed(4)} SOL)`); return; }
    if (!bidOrder || !askOrder) { log("Error: Order IDs not found in current order book — try refreshing"); return; }
    setLoading(true);
    try {
      const program = getProgram(connection, anchorWallet);
      const userKey = new web3.PublicKey(safePubkeyBase58(anchorWallet.publicKey));
      const marketPDA = new web3.PublicKey(market.address);
      // Use existing on-chain addresses instead of re-deriving PDAs (avoids seed mismatch issues)
      const bidPDA = new web3.PublicKey(bidOrder.address);
      const askPDA = new web3.PublicKey(askOrder.address);
      const tx = await (program.methods as any)
        .matchOrders()
        .accounts({ bidOrder: bidPDA, askOrder: askPDA, market: marketPDA, matcher: userKey })
        .rpc();
      addTx(tx);
      log(`Matched bid #${bidId} with ask #${askId} ✓`);
      await fetchOrders();
      setBidId(""); setAskId("");
    } catch (e: any) {
      const programLogs = e.logs ? `\n${e.logs.filter((l: string) => l.includes("Error") || l.includes("failed")).join("\n")}` : "";
      log(`Error: ${e.message}${programLogs}`);
    }
    setLoading(false);
  }

  if (!mounted) {
    return (
      <main className="max-w-5xl mx-auto px-4 py-8 space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Order Matching Engine</h1>
            <span className="text-xs bg-purple-800 text-purple-200 px-2 py-0.5 rounded mt-1 inline-block">Devnet</span>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-5xl mx-auto px-4 py-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Order Matching Engine</h1>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs bg-purple-800 text-purple-200 px-2 py-0.5 rounded">Devnet</span>
            {balance !== null && (
              <span className="text-xs text-gray-400">Balance: {balance.toFixed(4)} SOL</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4">
          <a href="https://github.com/tomaszstefaniak/solana-order-matching" target="_blank" className="text-gray-400 hover:text-white text-sm">GitHub ↗</a>
          {mounted && <WalletMultiButton style={{}} />}
        </div>
      </div>

      {!wallet.connected && (
        <div className="bg-gray-800 rounded-xl p-6 text-center text-gray-400">
          Connect your Phantom or Solflare wallet to interact with the on-chain order book.
        </div>
      )}

      {wallet.connected && (
        <>
          {/* Status bar */}
          {status && (
            <div className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-gray-300">
              {status}
            </div>
          )}

          {/* Market panel */}
          <div className="bg-gray-900 rounded-xl p-5 space-y-4 border border-gray-800">
            <h2 className="font-semibold text-gray-200">Market</h2>
            {market ? (
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="text-gray-500">Address</div><div className="font-mono text-xs text-gray-300">{shortKey(market.address)}</div>
                <div className="text-gray-500">Admin</div><div className="font-mono text-xs text-gray-300">{shortKey(market.admin)}</div>
                <div className="text-gray-500">Fee</div><div className="text-gray-300">{(market.feeBps / 100).toFixed(2)}%</div>
                <div className="text-gray-500">Orders placed</div><div className="text-gray-300">{market.orderCount}</div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-gray-500">No market found for your wallet. Initialize one:</p>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-gray-400">Trading fee:</label>
                  <input value={feeBps} onChange={e => setFeeBps(e.target.value)} placeholder="e.g. 25" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm w-20 text-white text-right" />
                  <span className="text-sm text-gray-500">
                    {feeBps && !isNaN(Number(feeBps)) ? `${(Number(feeBps) / 100).toFixed(2)}%` : "—"}
                  </span>
                  <button onClick={initMarket} disabled={loading} className="bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-sm px-4 py-1.5 rounded ml-2">
                    Initialize Market
                  </button>
                </div>
              </div>
            )}
            {market && <button onClick={fetchMarket} className="text-xs text-gray-500 hover:text-gray-300">↻ Refresh</button>}
          </div>

          {market && (
            <>
              {/* Place order */}
              <div className="bg-gray-900 rounded-xl p-5 space-y-4 border border-gray-800">
                <h2 className="font-semibold text-gray-200">Place Order</h2>
                <div className="flex gap-2">
                  {(["Buy", "Sell"] as Side[]).map(s => (
                    <button key={s} onClick={() => setSide(s)}
                      className={`px-4 py-1.5 rounded text-sm font-medium ${side === s ? (s === "Buy" ? "bg-green-600 text-white" : "bg-red-600 text-white") : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}>
                      {s}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2 flex-wrap">
                  <input value={price} onChange={e => setPrice(e.target.value)} placeholder="Price (SOL)" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white flex-1 min-w-32" />
                  <input value={quantity} onChange={e => setQuantity(e.target.value)} placeholder="Quantity (units)" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white flex-1 min-w-32" />
                  <button onClick={placeOrder} disabled={loading || !price || !quantity}
                    className={`text-sm px-4 py-1.5 rounded text-white disabled:opacity-50 ${side === "Buy" ? "bg-green-600 hover:bg-green-500" : "bg-red-600 hover:bg-red-500"}`}>
                    Place {side}
                  </button>
                </div>
              </div>

              {/* Match orders */}
              <div className="bg-gray-900 rounded-xl p-5 space-y-4 border border-gray-800">
                <h2 className="font-semibold text-gray-200">Match Orders</h2>
                <div className="flex gap-2 flex-wrap">
                  <input value={bidId} onChange={e => setBidId(e.target.value)} placeholder="Bid Order ID" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white w-36" />
                  <input value={askId} onChange={e => setAskId(e.target.value)} placeholder="Ask Order ID" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white w-36" />
                  <button onClick={matchOrders} disabled={loading || !bidId || !askId}
                    className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm px-4 py-1.5 rounded">
                    Match
                  </button>
                </div>
              </div>

              {/* Orders table */}
              <div className="bg-gray-900 rounded-xl p-5 space-y-4 border border-gray-800">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-gray-200">Order Book</h2>
                  <button onClick={fetchOrders} className="text-xs text-gray-500 hover:text-gray-300">↻ Refresh</button>
                </div>
                {orders.length === 0 ? (
                  <p className="text-sm text-gray-600">No orders yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-gray-500 text-left border-b border-gray-800">
                          <th className="pb-2 pr-3">Order ID</th>
                          <th className="pb-2 pr-3">Owner</th>
                          <th className="pb-2 pr-3">Side</th>
                          <th className="pb-2 pr-3">Price</th>
                          <th className="pb-2 pr-3">Qty</th>
                          <th className="pb-2 pr-3">Filled</th>
                          <th className="pb-2 pr-3">Status</th>
                          <th className="pb-2"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {orders.map(o => (
                          <tr key={o.address} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                            <td className="py-2 pr-3 text-gray-400">{o.orderId}</td>
                            <td className="py-2 pr-3 font-mono text-xs text-gray-400">{shortKey(o.owner)}</td>
                            <td className={`py-2 pr-3 font-medium ${o.side === "Buy" ? "text-green-400" : "text-red-400"}`}>{o.side}</td>
                            <td className="py-2 pr-3 text-gray-300">{(o.price / web3.LAMPORTS_PER_SOL).toFixed(4)} SOL</td>
                            <td className="py-2 pr-3 text-gray-300">{o.quantity}</td>
                            <td className="py-2 pr-3 text-gray-300">{o.filledQty}</td>
                            <td className={`py-2 pr-3 ${statusColor(o.status)}`}>{o.status}</td>
                            <td className="py-2 space-x-1">
                              {(o.status === "Open" || o.status === "PartiallyFilled") && (() => { try { return o.owner === safePubkeyBase58(wallet.publicKey); } catch { return false; } })() && (
                                <button onClick={() => cancelOrder(o)} className="text-xs bg-red-900/40 hover:bg-red-800/60 text-red-400 hover:text-red-200 border border-red-800/50 px-2 py-0.5 rounded">Cancel</button>
                              )}
                              {(o.status === "Filled" || o.status === "Cancelled") && (() => { try { return o.owner === safePubkeyBase58(wallet.publicKey); } catch { return false; } })() && (
                                <button onClick={() => closeOrder(o)} className="text-xs bg-gray-800/60 hover:bg-gray-700/80 text-gray-400 hover:text-gray-200 border border-gray-700/50 px-2 py-0.5 rounded">Close</button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* TX log */}
              {txLog.length > 0 && (
                <div className="bg-gray-900 rounded-xl p-5 space-y-2 border border-gray-800">
                  <h2 className="font-semibold text-gray-200 text-sm">Recent Transactions</h2>
                  {txLog.map(sig => (
                    <a key={sig} href={`https://explorer.solana.com/tx/${sig}?cluster=devnet`} target="_blank"
                      className="block font-mono text-xs text-purple-400 hover:text-purple-300 truncate">
                      {sig}
                    </a>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}
