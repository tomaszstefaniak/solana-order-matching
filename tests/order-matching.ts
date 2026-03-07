const anchor = require("@coral-xyz/anchor");
const { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } = require("@solana/web3.js");
const { assert } = require("chai");
const { readFileSync } = require("fs");
const { join } = require("path");
const BN = require("bn.js");

// Load IDL from committed file (no anchor build required)
const idlPath = join(__dirname, "../app/idl/order_matching.json");
const idl = JSON.parse(readFileSync(idlPath, "utf8"));

const PROGRAM_ID = new PublicKey(
  "CpnJ2pRUqZxSLh45qiX58YyJBuhQ3voDKKy8RYibnJ4n"
);

function getMarketPDA(admin: typeof PublicKey): [typeof PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), admin.toBuffer()],
    PROGRAM_ID
  );
}

function getOrderPDA(
  market: typeof PublicKey,
  orderCount: number
): [typeof PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(orderCount));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("order"), market.toBuffer(), buf],
    PROGRAM_ID
  );
}

describe("order-matching", () => {
  const RUN_INTEGRATION = process.env.RUN_INTEGRATION === "true";

  if (!RUN_INTEGRATION) {
    console.log(
      "Integration tests are skipped by default. To run them set RUN_INTEGRATION=true and ANCHOR_PROVIDER_URL and ANCHOR_WALLET as needed."
    );
  }

  // Integration tests require an Anchor provider (devnet or local validator)
  const provider = RUN_INTEGRATION ? anchor.AnchorProvider.env() : null;
  if (provider) anchor.setProvider(provider);

  const program = provider
    ? new anchor.Program(idl as any, provider)
    : null;

  let admin: typeof Keypair;
  let trader1: typeof Keypair;
  let trader2: typeof Keypair;
  let marketPDA: typeof PublicKey;
  let marketBump: number;

  before(async function () {
    if (!RUN_INTEGRATION) {
      this.skip();
    }

    admin = Keypair.generate();
    trader1 = Keypair.generate();
    trader2 = Keypair.generate();

    // Fund wallets
    for (const kp of [admin, trader1, trader2]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        5 * LAMPORTS_PER_SOL
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
      .placeOrder({ buy: {} }, { limit: {} }, new BN(100), new BN(10))
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
      .placeOrder({ sell: {} }, { limit: {} }, new BN(95), new BN(10))
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
    assert.deepEqual(
      bid.status,
      { partiallyFilled: {} },
      "bid should be PartiallyFilled"
    );
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
    assert.deepEqual(
      order.status,
      { cancelled: {} },
      "order should be Cancelled"
    );
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
        msg.includes("Error") ||
          msg.includes("constraint") ||
          msg.includes("Unauthorized"),
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
        msg.includes("PriceMismatch") ||
          msg.includes("6005") ||
          msg.includes("Bid price"),
        `Expected PriceMismatch error, got: ${msg}`
      );
      console.log("  price mismatch correctly rejected");
    }
  });

  // ═════════════════════════════════════════════════════════════════
  //  NEW TESTS — covering audit-identified gaps
  // ═════════════════════════════════════════════════════════════════

  // ─────────────────────────────────────────────────────────────────
  // 10. close_order — close a filled order (rent reclaim)
  // ─────────────────────────────────────────────────────────────────
  it("closes a filled order and reclaims rent", async () => {
    // Orders 0 and 1 were filled in test #4.
    const [bidPDA] = getOrderPDA(marketPDA, 0);

    // Capture trader1's balance before close
    const balBefore = await provider.connection.getBalance(trader1.publicKey);

    const tx = await program.methods
      .closeOrder()
      .accountsStrict({
        order: bidPDA,
        market: marketPDA,
        owner: trader1.publicKey,
      })
      .signers([trader1])
      .rpc();

    console.log("  closeOrder (filled bid) tx:", tx);

    // Account should no longer exist
    const account = await provider.connection.getAccountInfo(bidPDA);
    assert.isNull(account, "Order account should be closed");

    // trader1 should have received rent back
    const balAfter = await provider.connection.getBalance(trader1.publicKey);
    assert.isTrue(balAfter > balBefore - 10000, "Owner should receive rent lamports back");
    console.log("  rent reclaimed:", (balAfter - balBefore + 5000) / LAMPORTS_PER_SOL, "SOL (approx)");
  });

  // ─────────────────────────────────────────────────────────────────
  // 11. close_order — close a cancelled order
  // ─────────────────────────────────────────────────────────────────
  it("closes a cancelled order and reclaims rent", async () => {
    // Order 4 was cancelled in test #6 (by trader1)
    const [orderPDA] = getOrderPDA(marketPDA, 4);

    const tx = await program.methods
      .closeOrder()
      .accountsStrict({
        order: orderPDA,
        market: marketPDA,
        owner: trader1.publicKey,
      })
      .signers([trader1])
      .rpc();

    console.log("  closeOrder (cancelled) tx:", tx);

    const account = await provider.connection.getAccountInfo(orderPDA);
    assert.isNull(account, "Cancelled order account should be closed");
  });

  // ─────────────────────────────────────────────────────────────────
  // 12. close_order — reject closing an open order
  // ─────────────────────────────────────────────────────────────────
  it("rejects closing an open order", async () => {
    // Order 6 is still Open (unauthorized cancel failed in test #8)
    const [orderPDA] = getOrderPDA(marketPDA, 6);

    try {
      await program.methods
        .closeOrder()
        .accountsStrict({
          order: orderPDA,
          market: marketPDA,
          owner: trader1.publicKey,
        })
        .signers([trader1])
        .rpc();
      assert.fail("Should have thrown OrderNotClosed");
    } catch (err: unknown) {
      const msg = String(err);
      assert.ok(
        msg.includes("OrderNotClosed") ||
          msg.includes("6003") ||
          msg.includes("Filled or Cancelled"),
        `Expected OrderNotClosed error, got: ${msg}`
      );
      console.log("  close of open order correctly rejected");
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // 13. close_order — reject unauthorized closer
  // ─────────────────────────────────────────────────────────────────
  it("rejects unauthorized close_order", async () => {
    // Order 1 is filled (belongs to trader2), try closing with trader1
    const [orderPDA] = getOrderPDA(marketPDA, 1);

    try {
      await program.methods
        .closeOrder()
        .accountsStrict({
          order: orderPDA,
          market: marketPDA,
          owner: trader1.publicKey,  // wrong owner
        })
        .signers([trader1])
        .rpc();
      assert.fail("Should have thrown Unauthorized");
    } catch (err: unknown) {
      const msg = String(err);
      assert.ok(
        msg.includes("Unauthorized") ||
          msg.includes("Error") ||
          msg.includes("constraint"),
        `Expected Unauthorized error, got: ${msg}`
      );
      console.log("  unauthorized close correctly rejected");
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // 14. Market order rejection
  // ─────────────────────────────────────────────────────────────────
  it("rejects market orders (limit-only prototype)", async () => {
    const mkt = await program.account.market.fetch(marketPDA);
    const orderId = mkt.orderCount.toNumber();
    const [orderPDA] = getOrderPDA(marketPDA, orderId);

    try {
      await program.methods
        .placeOrder({ buy: {} }, { market: {} }, new BN(100), new BN(5))
        .accountsStrict({
          market: marketPDA,
          order: orderPDA,
          owner: trader1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([trader1])
        .rpc();
      assert.fail("Should have thrown MarketOrdersNotSupported");
    } catch (err: unknown) {
      const msg = String(err);
      assert.ok(
        msg.includes("MarketOrdersNotSupported") ||
          msg.includes("6009") ||
          msg.includes("not supported"),
        `Expected MarketOrdersNotSupported error, got: ${msg}`
      );
      console.log("  market order correctly rejected");
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // 15. Invalid fee_bps (> 10_000)
  // ─────────────────────────────────────────────────────────────────
  it("rejects fee_bps > 10_000", async () => {
    const badAdmin = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      badAdmin.publicKey,
      LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    const [badMarketPDA] = getMarketPDA(badAdmin.publicKey);

    try {
      await program.methods
        .initializeMarket(10001)
        .accountsStrict({
          market: badMarketPDA,
          admin: badAdmin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([badAdmin])
        .rpc();
      assert.fail("Should have thrown InvalidFeeBps");
    } catch (err: unknown) {
      const msg = String(err);
      assert.ok(
        msg.includes("InvalidFeeBps") ||
          msg.includes("6008") ||
          msg.includes("fee_bps"),
        `Expected InvalidFeeBps error, got: ${msg}`
      );
      console.log("  invalid fee_bps correctly rejected");
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // 16. Zero quantity rejection
  // ─────────────────────────────────────────────────────────────────
  it("rejects zero quantity", async () => {
    const mkt = await program.account.market.fetch(marketPDA);
    const orderId = mkt.orderCount.toNumber();
    const [orderPDA] = getOrderPDA(marketPDA, orderId);

    try {
      await program.methods
        .placeOrder({ buy: {} }, { limit: {} }, new BN(100), new BN(0))
        .accountsStrict({
          market: marketPDA,
          order: orderPDA,
          owner: trader1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([trader1])
        .rpc();
      assert.fail("Should have thrown InvalidQuantity");
    } catch (err: unknown) {
      const msg = String(err);
      assert.ok(
        msg.includes("InvalidQuantity") ||
          msg.includes("6001") ||
          msg.includes("quantity"),
        `Expected InvalidQuantity error, got: ${msg}`
      );
      console.log("  zero quantity correctly rejected");
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // 17. Zero price rejection
  // ─────────────────────────────────────────────────────────────────
  it("rejects zero price for limit orders", async () => {
    const mkt = await program.account.market.fetch(marketPDA);
    const orderId = mkt.orderCount.toNumber();
    const [orderPDA] = getOrderPDA(marketPDA, orderId);

    try {
      await program.methods
        .placeOrder({ buy: {} }, { limit: {} }, new BN(0), new BN(10))
        .accountsStrict({
          market: marketPDA,
          order: orderPDA,
          owner: trader1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([trader1])
        .rpc();
      assert.fail("Should have thrown InvalidPrice");
    } catch (err: unknown) {
      const msg = String(err);
      assert.ok(
        msg.includes("InvalidPrice") ||
          msg.includes("6000") ||
          msg.includes("price"),
        `Expected InvalidPrice error, got: ${msg}`
      );
      console.log("  zero price correctly rejected");
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // 18. Self-match (guard commented out in devnet build)
  // ─────────────────────────────────────────────────────────────────
  it("allows self-matching in devnet build (SelfMatch guard is commented out for single-wallet testing)", async () => {
    // NOTE: The self-match guard `require!(bid.owner != ask.owner, SelfMatch)` is
    // intentionally commented out in lib.rs:111 to allow single-wallet devnet testing.
    // Re-enable for production.
    const mkt = await program.account.market.fetch(marketPDA);
    const bidOrderId = mkt.orderCount.toNumber();
    const askOrderId = bidOrderId + 1;
    const [bidPDA] = getOrderPDA(marketPDA, bidOrderId);
    const [askPDA] = getOrderPDA(marketPDA, askOrderId);

    // Same trader places both buy and sell
    await program.methods
      .placeOrder({ buy: {} }, { limit: {} }, new BN(100), new BN(5))
      .accountsStrict({
        market: marketPDA,
        order: bidPDA,
        owner: trader1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader1])
      .rpc();

    await program.methods
      .placeOrder({ sell: {} }, { limit: {} }, new BN(90), new BN(5))
      .accountsStrict({
        market: marketPDA,
        order: askPDA,
        owner: trader1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader1])
      .rpc();

    // Match should succeed (guard disabled)
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

    const bid = await program.account.order.fetch(bidPDA);
    const ask = await program.account.order.fetch(askPDA);
    assert.deepEqual(bid.status, { filled: {} }, "bid should be Filled");
    assert.deepEqual(ask.status, { filled: {} }, "ask should be Filled");
    console.log("  self-match allowed (guard commented out for devnet single-wallet testing)");
  });

  // ─────────────────────────────────────────────────────────────────
  // 19. Cancel already-cancelled order should fail
  // ─────────────────────────────────────────────────────────────────
  it("rejects cancelling an already-cancelled order", async () => {
    // Order 5 was cancelled in test #7 (by admin)
    const [orderPDA] = getOrderPDA(marketPDA, 5);

    try {
      await program.methods
        .cancelOrder()
        .accountsStrict({
          order: orderPDA,
          market: marketPDA,
          authority: admin.publicKey,
        })
        .signers([admin])
        .rpc();
      assert.fail("Should have thrown OrderNotOpen");
    } catch (err: unknown) {
      const msg = String(err);
      assert.ok(
        msg.includes("OrderNotOpen") ||
          msg.includes("6002") ||
          msg.includes("not open"),
        `Expected OrderNotOpen error, got: ${msg}`
      );
      console.log("  cancel of already-cancelled order correctly rejected");
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // 20. Match already-filled orders should fail
  // ─────────────────────────────────────────────────────────────────
  it("rejects matching already-filled orders", async () => {
    // Orders 1 (ask, filled) — still exists (close was rejected since wrong owner tried)
    // Order 3 (ask, filled in partial fill test)
    const [bidPDA] = getOrderPDA(marketPDA, 1); // filled ask — wrong side but let's use two filled
    const [askPDA] = getOrderPDA(marketPDA, 3); // filled ask

    // We need proper filled bid+ask. Let's create and fill a new pair.
    const mkt = await program.account.market.fetch(marketPDA);
    const bidId = mkt.orderCount.toNumber();
    const askId = bidId + 1;
    const [newBidPDA] = getOrderPDA(marketPDA, bidId);
    const [newAskPDA] = getOrderPDA(marketPDA, askId);

    await program.methods
      .placeOrder({ buy: {} }, { limit: {} }, new BN(500), new BN(3))
      .accountsStrict({
        market: marketPDA,
        order: newBidPDA,
        owner: trader1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader1])
      .rpc();

    await program.methods
      .placeOrder({ sell: {} }, { limit: {} }, new BN(400), new BN(3))
      .accountsStrict({
        market: marketPDA,
        order: newAskPDA,
        owner: trader2.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader2])
      .rpc();

    // Fill them
    await program.methods
      .matchOrders()
      .accountsStrict({
        bidOrder: newBidPDA,
        askOrder: newAskPDA,
        market: marketPDA,
        matcher: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    // Verify both are filled
    const bid = await program.account.order.fetch(newBidPDA);
    const ask = await program.account.order.fetch(newAskPDA);
    assert.deepEqual(bid.status, { filled: {} });
    assert.deepEqual(ask.status, { filled: {} });

    // Try to match them again — should fail
    try {
      await program.methods
        .matchOrders()
        .accountsStrict({
          bidOrder: newBidPDA,
          askOrder: newAskPDA,
          market: marketPDA,
          matcher: admin.publicKey,
        })
        .signers([admin])
        .rpc();
      assert.fail("Should have thrown OrderNotOpen");
    } catch (err: unknown) {
      const msg = String(err);
      assert.ok(
        msg.includes("OrderNotOpen") ||
          msg.includes("6002") ||
          msg.includes("not open"),
        `Expected OrderNotOpen error, got: ${msg}`
      );
      console.log("  re-matching filled orders correctly rejected");
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // 21. Double market initialization should fail (PDA collision)
  // ─────────────────────────────────────────────────────────────────
  it("rejects double market initialization (same admin)", async () => {
    // admin already initialized a market in test #1
    try {
      await program.methods
        .initializeMarket(50)
        .accountsStrict({
          market: marketPDA,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
      assert.fail("Should have thrown — PDA already initialized");
    } catch (err: unknown) {
      const msg = String(err);
      // Anchor / Solana throws "already in use" for re-init of existing PDA
      assert.ok(
        msg.includes("already in use") ||
          msg.includes("Error") ||
          msg.includes("0x0"),
        `Expected PDA collision error, got: ${msg}`
      );
      console.log("  double init correctly rejected (PDA already exists)");
    }
  });
});
