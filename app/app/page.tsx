"use client";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { AnchorProvider, Program, BN, web3 } from "@coral-xyz/anchor";
import { useState, useEffect, useCallback } from "react";
import idl from "../idl/order_matching.json";

const PROGRAM_ID = new PublicKey("EpgQjhxaSA5ee5xC8aTFgooUwED3jiSEnpytck4epUTw");

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

function getProgram(connection: web3.Connection, wallet: any) {
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  return new Program(idl as any, provider);
}

function getMarketPDA(adminKey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), adminKey.toBuffer()],
    PROGRAM_ID
  );
}

function getOrderPDA(marketKey: PublicKey, orderId: number): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(orderId));
  return PublicKey.findProgramAddressSync(
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

  const log = (msg: string) => setStatus(msg);
  const addTx = (sig: string) => setTxLog((prev) => [sig, ...prev].slice(0, 5));

  const fetchMarket = useCallback(async () => {
    if (!wallet.publicKey) return;
    try {
      const program = getProgram(connection, wallet);
      const [marketPDA] = getMarketPDA(wallet.publicKey);
      const data = await (program.account as any).market.fetch(marketPDA);
      setMarket({
        admin: data.admin.toBase58(),
        feeBps: data.feeBps,
        orderCount: data.orderCount.toNumber(),
        address: marketPDA.toBase58(),
      });
    } catch {
      setMarket(null);
    }
  }, [connection, wallet]);

  const fetchOrders = useCallback(async () => {
    if (!wallet.publicKey || !market) return;
    try {
      const program = getProgram(connection, wallet);
      const all = await (program.account as any).order.all();
      const parsed: OrderData[] = all.map((a: any) => ({
        address: a.publicKey.toBase58(),
        orderId: a.account.orderId.toNumber(),
        owner: a.account.owner.toBase58(),
        side: a.account.side.buy !== undefined ? "Buy" : "Sell",
        orderType: a.account.orderType.limit !== undefined ? "Limit" : "Market",
        price: a.account.price.toNumber(),
        quantity: a.account.quantity.toNumber(),
        filledQty: a.account.filledQty.toNumber(),
        status: Object.keys(a.account.status)[0] as OrderStatus,
      }));
      setOrders(parsed.sort((a, b) => a.orderId - b.orderId));
    } catch (e) {
      console.error(e);
    }
  }, [connection, wallet, market]);

  useEffect(() => { fetchMarket(); }, [fetchMarket]);
  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  async function initMarket() {
    if (!wallet.publicKey || !wallet.signTransaction) return;
    setLoading(true);
    try {
      const program = getProgram(connection, wallet);
      const [marketPDA] = getMarketPDA(wallet.publicKey);
      const tx = await (program.methods as any)
        .initializeMarket(parseInt(feeBps))
        .accounts({ market: marketPDA, admin: wallet.publicKey, systemProgram: SystemProgram.programId })
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
    if (!wallet.publicKey || !market) return;
    setLoading(true);
    try {
      const program = getProgram(connection, wallet);
      const marketPDA = new PublicKey(market.address);
      const orderId = market.orderCount;
      const [orderPDA] = getOrderPDA(marketPDA, orderId);
      const sideArg = side === "Buy" ? { buy: {} } : { sell: {} };
      const tx = await (program.methods as any)
        .placeOrder(sideArg, { limit: {} }, new BN(price), new BN(quantity))
        .accounts({ market: marketPDA, order: orderPDA, owner: wallet.publicKey, systemProgram: SystemProgram.programId })
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
    if (!wallet.publicKey || !market) return;
    setLoading(true);
    try {
      const program = getProgram(connection, wallet);
      const marketPDA = new PublicKey(market.address);
      const tx = await (program.methods as any)
        .cancelOrder()
        .accounts({ order: new PublicKey(order.address), market: marketPDA, authority: wallet.publicKey })
        .rpc();
      addTx(tx);
      log(`Order #${order.orderId} cancelled ✓`);
      await fetchOrders();
    } catch (e: any) {
      log(`Error: ${e.message}`);
    }
    setLoading(false);
  }

  async function matchOrders() {
    if (!wallet.publicKey || !market) return;
    setLoading(true);
    try {
      const program = getProgram(connection, wallet);
      const marketPDA = new PublicKey(market.address);
      const [bidPDA] = getOrderPDA(marketPDA, parseInt(bidId));
      const [askPDA] = getOrderPDA(marketPDA, parseInt(askId));
      const tx = await (program.methods as any)
        .matchOrders()
        .accounts({ bidOrder: bidPDA, askOrder: askPDA, market: marketPDA, matcher: wallet.publicKey })
        .rpc();
      addTx(tx);
      log(`Matched bid #${bidId} with ask #${askId} ✓`);
      await fetchOrders();
      setBidId(""); setAskId("");
    } catch (e: any) {
      log(`Error: ${e.message}`);
    }
    setLoading(false);
  }

  return (
    <main className="max-w-5xl mx-auto px-4 py-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Order Matching Engine</h1>
          <span className="text-xs bg-purple-800 text-purple-200 px-2 py-0.5 rounded mt-1 inline-block">Devnet</span>
        </div>
        <div className="flex items-center gap-4">
          <a href="https://github.com/tomaszstefaniak/solana-order-matching" target="_blank" className="text-gray-400 hover:text-white text-sm">GitHub ↗</a>
          <WalletMultiButton style={{}} />
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
                <div className="text-gray-500">Fee</div><div className="text-gray-300">{market.feeBps} bps</div>
                <div className="text-gray-500">Orders placed</div><div className="text-gray-300">{market.orderCount}</div>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-gray-500">No market found for your wallet. Initialize one:</p>
                <div className="flex gap-2">
                  <input value={feeBps} onChange={e => setFeeBps(e.target.value)} placeholder="Fee bps" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm w-28 text-white" />
                  <button onClick={initMarket} disabled={loading} className="bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-sm px-4 py-1.5 rounded">
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
                  <input value={price} onChange={e => setPrice(e.target.value)} placeholder="Price (lamports)" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white flex-1 min-w-32" />
                  <input value={quantity} onChange={e => setQuantity(e.target.value)} placeholder="Quantity" className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white flex-1 min-w-32" />
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
                          <th className="pb-2 pr-3">#</th>
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
                            <td className="py-2 pr-3 text-gray-300">{o.price.toLocaleString()}</td>
                            <td className="py-2 pr-3 text-gray-300">{o.quantity}</td>
                            <td className="py-2 pr-3 text-gray-300">{o.filledQty}</td>
                            <td className={`py-2 pr-3 ${statusColor(o.status)}`}>{o.status}</td>
                            <td className="py-2">
                              {o.status === "Open" && o.owner === wallet.publicKey?.toBase58() && (
                                <button onClick={() => cancelOrder(o)} className="text-xs text-red-400 hover:text-red-300">Cancel</button>
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
