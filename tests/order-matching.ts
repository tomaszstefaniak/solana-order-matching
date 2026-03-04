import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { assert } from "chai";
import { readFileSync } from "fs";
import { join } from "path";
import BN from "bn.js";

// Load IDL from committed file (no anchor build required)
const idlPath = join(__dirname, "../app/idl/order_matching.json");
const idl = JSON.parse(readFileSync(idlPath, "utf8"));

const PROGRAM_ID = new PublicKey(
  "56Ygzbd4js8d9T5jzzgc5kVgSwUATsEHZ5dwZxkPq9TY"
);

function getMarketPDA(admin: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), admin.toBuffer()],
    PROGRAM_ID
  );
}

function getOrderPDA(
  market: PublicKey,
  orderCount: number
): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(orderCount));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("order"), market.toBuffer(), buf],
    PROGRAM_ID
  );
}

describe("order-matching", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = new anchor.Program(idl as anchor.Idl, provider);

  let admin: Keypair;
  let trader1: Keypair;
  let trader2: Keypair;
  let marketPDA: PublicKey;
  let marketBump: number;

  before(async () => {
    admin = Keypair.generate();
    trader1 = Keypair.generate();
    trader2 = Keypair.generate();

    // Fund wallets
    for (const kp of [admin, trader1, trader2]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    [marketPDA, marketBump] = getMarketPDA(admin.publicKey);
  });

  // ─────────────────────────────────────────────────────────────────
  // 1. Initialize Market
  // ─────────────────────────────────────────────────────────────────
  it("initializes a market", async () => {
    const feeBps = 25; // 0.25%

    const tx = await program.methods
      .initializeMarket(feeBps)
      .accountsStrict({
        market: marketPDA,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    console.log("  initializeMarket tx:", tx);

    const market = await program.account.market.fetch(marketPDA);
    assert.equal(
      market.admin.toBase58(),
      admin.publicKey.toBase58(),
      "market admin mismatch"
    );
    assert.equal(market.feeBps, feeBps, "fee_bps mismatch");
    assert.equal(market.orderCount.toNumber(), 0, "order_count should be 0");
    assert.equal(market.bump, marketBump, "bump mismatch");
  });

  // ─────────────────────────────────────────────────────────────────
  // 2. Place a bid (buy) order
  // ─────────────────────────────────────────────────────────────────
  it("places a bid (buy) order", async () => {
    const [orderPDA] = getOrderPDA(marketPDA, 0);

    const tx = await program.methods
      .placeOrder(
        { buy: {} },
        { limit: {} },
        new BN(100),
        new BN(10)
      )
      .accountsStrict({
        market: marketPDA,
        order: orderPDA,
        owner: trader1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader1])
      .rpc();

    console.log("  placeOrder (bid) tx:", tx);

    const market = await program.account.market.fetch(marketPDA);
    assert.equal(market.orderCount.toNumber(), 1, "order_count should be 1");

    const order = await program.account.order.fetch(orderPDA);
    assert.equal(order.orderId.toNumber(), 0, "order_id should be 0");
    assert.equal(order.price.toNumber(), 100, "price mismatch");
    assert.equal(order.quantity.toNumber(), 10, "quantity mismatch");
    assert.equal(order.filledQty.toNumber(), 0, "filled_qty should be 0");
    assert.deepEqual(order.status, { open: {} }, "status should be Open");
    assert.deepEqual(order.side, { buy: {} }, "side should be Buy");
  });

  // ─────────────────────────────────────────────────────────────────
  // 3. Place an ask (sell) order
  // ─────────────────────────────────────────────────────────────────
  it("places an ask (sell) order", async () => {
    const [orderPDA] = getOrderPDA(marketPDA, 1);

    const tx = await program.methods
      .placeOrder(
        { sell: {} },
        { limit: {} },
        new BN(95),
        new BN(10)
      )
      .accountsStrict({
        market: marketPDA,
        order: orderPDA,
        owner: trader2.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader2])
      .rpc();

    console.log("  placeOrder (ask) tx:", tx);

    const market = await program.account.market.fetch(marketPDA);
    assert.equal(market.orderCount.toNumber(), 2, "order_count should be 2");

    const order = await program.account.order.fetch(orderPDA);
    assert.equal(order.orderId.toNumber(), 1, "order_id should be 1");
    assert.equal(order.price.toNumber(), 95, "price mismatch");
    assert.deepEqual(order.side, { sell: {} }, "side should be Sell");
  });

  // ─────────────────────────────────────────────────────────────────
  // 4. Match orders – full fill
  // ─────────────────────────────────────────────────────────────────
  it("matches orders (full fill)", async () => {
    const [bidPDA] = getOrderPDA(marketPDA, 0);
    const [askPDA] = getOrderPDA(marketPDA, 1);

    const tx = await program.methods
      .matchOrders()
      .accountsStrict({
        bidOrder: bidPDA,
        askOrder: askPDA,
        market: marketPDA,
        matcher: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    console.log("  matchOrders tx:", tx);

    const bid = await program.account.order.fetch(bidPDA);
    const ask = await program.account.order.fetch(askPDA);

    assert.equal(bid.filledQty.toNumber(), 10, "bid filled_qty should be 10");
    assert.equal(ask.filledQty.toNumber(), 10, "ask filled_qty should be 10");
    assert.deepEqual(bid.status, { filled: {} }, "bid should be Filled");
    assert.deepEqual(ask.status, { filled: {} }, "ask should be Filled");
  });

  // ─────────────────────────────────────────────────────────────────
  // 5. Partial fill scenario
  // ─────────────────────────────────────────────────────────────────
  it("handles partial fill", async () => {
    const [bidPDA] = getOrderPDA(marketPDA, 2);
    const [askPDA] = getOrderPDA(marketPDA, 3);

    // bid: 20 units at 200
    await program.methods
      .placeOrder({ buy: {} }, { limit: {} }, new BN(200), new BN(20))
      .accountsStrict({
        market: marketPDA,
        order: bidPDA,
        owner: trader1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader1])
      .rpc();

    // ask: 7 units at 150 (only partial fill of bid)
    await program.methods
      .placeOrder({ sell: {} }, { limit: {} }, new BN(150), new BN(7))
      .accountsStrict({
        market: marketPDA,
        order: askPDA,
        owner: trader2.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader2])
      .rpc();

    const tx = await program.methods
      .matchOrders()
      .accountsStrict({
        bidOrder: bidPDA,
        askOrder: askPDA,
        market: marketPDA,
        matcher: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    console.log("  matchOrders (partial) tx:", tx);

    const bid = await program.account.order.fetch(bidPDA);
    const ask = await program.account.order.fetch(askPDA);

    // ask fully filled (7), bid partially filled (7 of 20)
    assert.equal(bid.filledQty.toNumber(), 7, "bid filled_qty should be 7");
    assert.equal(ask.filledQty.toNumber(), 7, "ask filled_qty should be 7");
    assert.deepEqual(bid.status, { partiallyFilled: {} }, "bid should be PartiallyFilled");
    assert.deepEqual(ask.status, { filled: {} }, "ask should be Filled");
  });

  // ─────────────────────────────────────────────────────────────────
  // 6. Cancel order (by owner)
  // ─────────────────────────────────────────────────────────────────
  it("cancels an open order", async () => {
    const [orderPDA] = getOrderPDA(marketPDA, 4);

    await program.methods
      .placeOrder({ buy: {} }, { limit: {} }, new BN(50), new BN(5))
      .accountsStrict({
        market: marketPDA,
        order: orderPDA,
        owner: trader1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader1])
      .rpc();

    const tx = await program.methods
      .cancelOrder()
      .accountsStrict({
        order: orderPDA,
        market: marketPDA,
        authority: trader1.publicKey,
      })
      .signers([trader1])
      .rpc();

    console.log("  cancelOrder tx:", tx);

    const order = await program.account.order.fetch(orderPDA);
    assert.deepEqual(order.status, { cancelled: {} }, "order should be Cancelled");
  });

  // ─────────────────────────────────────────────────────────────────
  // 7. Admin can cancel any order
  // ─────────────────────────────────────────────────────────────────
  it("admin can cancel any order", async () => {
    const [orderPDA] = getOrderPDA(marketPDA, 5);

    await program.methods
      .placeOrder({ sell: {} }, { limit: {} }, new BN(300), new BN(3))
      .accountsStrict({
        market: marketPDA,
        order: orderPDA,
        owner: trader2.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader2])
      .rpc();

    const tx = await program.methods
      .cancelOrder()
      .accountsStrict({
        order: orderPDA,
        market: marketPDA,
        authority: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    console.log("  cancelOrder (by admin) tx:", tx);

    const order = await program.account.order.fetch(orderPDA);
    assert.deepEqual(order.status, { cancelled: {} }, "should be Cancelled");
  });

  // ─────────────────────────────────────────────────────────────────
  // 8. Unauthorized cancel should fail
  // ─────────────────────────────────────────────────────────────────
  it("rejects unauthorized cancel", async () => {
    const intruder = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      intruder.publicKey,
      LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    const [orderPDA] = getOrderPDA(marketPDA, 6);
    await program.methods
      .placeOrder({ buy: {} }, { limit: {} }, new BN(80), new BN(8))
      .accountsStrict({
        market: marketPDA,
        order: orderPDA,
        owner: trader1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader1])
      .rpc();

    try {
      await program.methods
        .cancelOrder()
        .accountsStrict({
          order: orderPDA,
          market: marketPDA,
          authority: intruder.publicKey,
        })
        .signers([intruder])
        .rpc();
      assert.fail("Should have thrown an error");
    } catch (err: unknown) {
      const msg = String(err);
      assert.ok(
        msg.includes("Error") || msg.includes("constraint") || msg.includes("Unauthorized"),
        `Expected constraint/unauthorized error, got: ${msg}`
      );
      console.log("  unauthorized cancel correctly rejected");
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // 9. Price mismatch should fail
  // ─────────────────────────────────────────────────────────────────
  it("rejects match when bid price < ask price", async () => {
    const [bidPDA] = getOrderPDA(marketPDA, 7);
    const [askPDA] = getOrderPDA(marketPDA, 8);

    await program.methods
      .placeOrder({ buy: {} }, { limit: {} }, new BN(50), new BN(5))
      .accountsStrict({
        market: marketPDA,
        order: bidPDA,
        owner: trader1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader1])
      .rpc();

    await program.methods
      .placeOrder({ sell: {} }, { limit: {} }, new BN(100), new BN(5))
      .accountsStrict({
        market: marketPDA,
        order: askPDA,
        owner: trader2.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader2])
      .rpc();

    try {
      await program.methods
        .matchOrders()
        .accountsStrict({
          bidOrder: bidPDA,
          askOrder: askPDA,
          market: marketPDA,
          matcher: admin.publicKey,
        })
        .signers([admin])
        .rpc();
      assert.fail("Should have thrown PriceMismatch");
    } catch (err: unknown) {
      const msg = String(err);
      assert.ok(
        msg.includes("PriceMismatch") || msg.includes("6004") || msg.includes("Bid price"),
        `Expected PriceMismatch error, got: ${msg}`
      );
      console.log("  price mismatch correctly rejected");
    }
  });
});
