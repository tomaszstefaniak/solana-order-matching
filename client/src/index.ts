#!/usr/bin/env ts-node
/**
 * CLI client for the on-chain Order Matching Engine
 * Superteam Poland Bounty - Solana/Anchor Order Matching Engine
 */
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  clusterApiUrl,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { Command } from "commander";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Config ──────────────────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey(
  "56Ygzbd4js8d9T5jzzgc5kVgSwUATsEHZ5dwZxkPq9TY"
);

const IDL_PATH = join(__dirname, "../../app/idl/order_matching.json");

// ─── Helpers ─────────────────────────────────────────────────────────────────
function loadWallet(walletPath: string): Keypair {
  const raw = readFileSync(walletPath, "utf8");
  const secretKey = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secretKey);
}

function getProvider(cluster: string, walletPath: string): AnchorProvider {
  const endpoint =
    cluster === "devnet"
      ? clusterApiUrl("devnet")
      : cluster === "mainnet-beta"
      ? clusterApiUrl("mainnet-beta")
      : cluster === "localnet"
      ? "http://127.0.0.1:8899"
      : cluster; // allow raw URL

  const connection = new Connection(endpoint, "confirmed");
  const keypair = loadWallet(walletPath);
  const wallet = new Wallet(keypair);
  return new AnchorProvider(connection, wallet, { commitment: "confirmed" });
}

function getProgram(provider: AnchorProvider): any {
  const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
  return new Program(idl, provider) as any;
}

function getMarketPDA(admin: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), admin.toBuffer()],
    PROGRAM_ID
  );
}

function getOrderPDA(market: PublicKey, orderCount: number): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(orderCount));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("order"), market.toBuffer(), buf],
    PROGRAM_ID
  );
}

function formatOrder(order: any): string {
  const side = order.side.buy !== undefined ? "BUY" : "SELL";
  const type = order.orderType.limit !== undefined ? "LIMIT" : "MARKET";
  const status = Object.keys(order.status)[0].toUpperCase();
  return [
    `Order #${order.orderId}`,
    `  Side     : ${side}`,
    `  Type     : ${type}`,
    `  Price    : ${order.price} lamports`,
    `  Quantity : ${order.quantity}`,
    `  Filled   : ${order.filledQty}`,
    `  Status   : ${status}`,
    `  Market   : ${order.market.toBase58()}`,
    `  Owner    : ${order.owner.toBase58()}`,
    `  Created  : ${new Date(order.createdAt.toNumber() * 1000).toISOString()}`,
  ].join("\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
const program = new Command();

program
  .name("order-matching")
  .description("CLI for the on-chain Order Matching Engine")
  .version("0.1.0")
  .option(
    "-c, --cluster <cluster>",
    "Solana cluster (devnet|localnet|<url>)",
    "devnet"
  )
  .option(
    "-w, --wallet <path>",
    "Path to wallet keypair JSON",
    join(homedir(), ".config/solana/id.json")
  );

// ─── init-market ─────────────────────────────────────────────────────────────
program
  .command("init-market")
  .description("Initialize a new order book market")
  .argument("<fee_bps>", "Fee in basis points (e.g. 25 = 0.25%)", parseInt)
  .action(async (feeBps: number) => {
    const opts = program.opts();
    const provider = getProvider(opts.cluster, opts.wallet);
    const prog = getProgram(provider);

    const admin = (provider.wallet as Wallet).payer;
    const [marketPDA] = getMarketPDA(admin.publicKey);

    console.log(`Initializing market...`);
    console.log(`  Admin    : ${admin.publicKey.toBase58()}`);
    console.log(`  MarketPDA: ${marketPDA.toBase58()}`);
    console.log(`  Fee      : ${feeBps} bps`);

    const tx = await prog.methods
      .initializeMarket(feeBps)
      .accountsStrict({
        market: marketPDA,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    console.log(`\nTransaction: ${tx}`);
    console.log(`Market initialized at: ${marketPDA.toBase58()}`);
    console.log(`Explorer: https://explorer.solana.com/tx/${tx}?cluster=${opts.cluster}`);
  });

// ─── place-order ─────────────────────────────────────────────────────────────
program
  .command("place-order")
  .description("Place a limit order (market orders are not supported)")
  .requiredOption("-m, --market <pubkey>", "Market admin public key (to derive market PDA)")
  .requiredOption("-s, --side <buy|sell>", "Order side")
  .requiredOption("-p, --price <number>", "Price in lamports", parseInt)
  .requiredOption("-q, --quantity <number>", "Quantity", parseInt)
  .action(async (options) => {
    const opts = program.opts();
    const provider = getProvider(opts.cluster, opts.wallet);
    const prog = getProgram(provider);

    const owner = (provider.wallet as Wallet).payer;
    const marketAdmin = new PublicKey(options.market);
    const [marketPDA] = getMarketPDA(marketAdmin);

    const marketAccount = await prog.account.market.fetch(marketPDA);
    const orderCount = (marketAccount.orderCount as BN).toNumber();
    const [orderPDA] = getOrderPDA(marketPDA, orderCount);

    const side = options.side === "buy" ? { buy: {} } : { sell: {} };
    const orderType = { limit: {} }; // only limit orders supported

    console.log(`Placing ${options.side.toUpperCase()} LIMIT order...`);
    console.log(`  Owner    : ${owner.publicKey.toBase58()}`);
    console.log(`  Market   : ${marketPDA.toBase58()}`);
    console.log(`  Order ID : ${orderCount}`);
    console.log(`  Price    : ${options.price} lamports`);
    console.log(`  Quantity : ${options.quantity}`);

    const tx = await prog.methods
      .placeOrder(side, orderType, new BN(options.price), new BN(options.quantity))
      .accountsStrict({
        market: marketPDA,
        order: orderPDA,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    console.log(`\nTransaction: ${tx}`);
    console.log(`Order #${orderCount} placed at: ${orderPDA.toBase58()}`);
    console.log(`Explorer: https://explorer.solana.com/tx/${tx}?cluster=${opts.cluster}`);
  });

// ─── cancel-order ────────────────────────────────────────────────────────────
program
  .command("cancel-order")
  .description("Cancel an open order")
  .requiredOption("-o, --order <pubkey>", "Order PDA public key")
  .requiredOption("-m, --market <pubkey>", "Market admin public key (to derive market PDA)")
  .action(async (options) => {
    const opts = program.opts();
    const provider = getProvider(opts.cluster, opts.wallet);
    const prog = getProgram(provider);

    const authority = (provider.wallet as Wallet).payer;
    const marketAdmin = new PublicKey(options.market);
    const [marketPDA] = getMarketPDA(marketAdmin);
    const orderPDA = new PublicKey(options.order);

    console.log(`Cancelling order ${orderPDA.toBase58()}...`);

    const tx = await prog.methods
      .cancelOrder()
      .accountsStrict({
        order: orderPDA,
        market: marketPDA,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();

    console.log(`\nTransaction: ${tx}`);
    console.log(`Order cancelled!`);
    console.log(`Explorer: https://explorer.solana.com/tx/${tx}?cluster=${opts.cluster}`);
  });

// ─── match-orders ─────────────────────────────────────────────────────────────
program
  .command("match-orders")
  .description("Match a bid order against an ask order")
  .requiredOption("-b, --bid <pubkey>", "Bid order PDA public key")
  .requiredOption("-a, --ask <pubkey>", "Ask order PDA public key")
  .requiredOption("-m, --market <pubkey>", "Market admin public key (to derive market PDA)")
  .action(async (options) => {
    const opts = program.opts();
    const provider = getProvider(opts.cluster, opts.wallet);
    const prog = getProgram(provider);

    const matcher = (provider.wallet as Wallet).payer;
    const marketAdmin = new PublicKey(options.market);
    const [marketPDA] = getMarketPDA(marketAdmin);
    const bidPDA = new PublicKey(options.bid);
    const askPDA = new PublicKey(options.ask);

    console.log(`Matching orders...`);
    console.log(`  Bid : ${bidPDA.toBase58()}`);
    console.log(`  Ask : ${askPDA.toBase58()}`);

    const tx = await prog.methods
      .matchOrders()
      .accountsStrict({
        bidOrder: bidPDA,
        askOrder: askPDA,
        market: marketPDA,
        matcher: matcher.publicKey,
      })
      .signers([matcher])
      .rpc();

    console.log(`\nTransaction: ${tx}`);
    console.log(`Orders matched!`);
    console.log(`Explorer: https://explorer.solana.com/tx/${tx}?cluster=${opts.cluster}`);
  });

// ─── show-order ──────────────────────────────────────────────────────────────
program
  .command("show-order")
  .description("Fetch and display an order account")
  .argument("<pubkey>", "Order PDA public key")
  .action(async (pubkey: string) => {
    const opts = program.opts();
    const provider = getProvider(opts.cluster, opts.wallet);
    const prog = getProgram(provider);

    const orderPDA = new PublicKey(pubkey);
    const order = await prog.account.order.fetch(orderPDA);

    console.log("\n" + formatOrder(order) + "\n");
  });

// ─── close-order ─────────────────────────────────────────────────────────────
program
  .command("close-order")
  .description("Close a filled or cancelled order and reclaim rent")
  .requiredOption("-o, --order <pubkey>", "Order PDA public key")
  .requiredOption("-m, --market <pubkey>", "Market admin public key (to derive market PDA)")
  .action(async (options) => {
    const opts = program.opts();
    const provider = getProvider(opts.cluster, opts.wallet);
    const prog = getProgram(provider);

    const owner = (provider.wallet as Wallet).payer;
    const marketAdmin = new PublicKey(options.market);
    const [marketPDA] = getMarketPDA(marketAdmin);
    const orderPDA = new PublicKey(options.order);

    console.log(`Closing order ${orderPDA.toBase58()}...`);
    console.log(`Rent will be returned to: ${owner.publicKey.toBase58()}`);

    const tx = await prog.methods
      .closeOrder()
      .accountsStrict({
        order: orderPDA,
        market: marketPDA,
        owner: owner.publicKey,
      })
      .signers([owner])
      .rpc();

    console.log(`\nTransaction: ${tx}`);
    console.log(`Order closed. Rent reclaimed!`);
    console.log(`Explorer: https://explorer.solana.com/tx/${tx}?cluster=${opts.cluster}`);
  });

// ─── show-market ─────────────────────────────────────────────────────────────
program
  .command("show-market")
  .description("Fetch and display a market account")
  .argument("<admin_pubkey>", "Market admin public key")
  .action(async (adminPubkey: string) => {
    const opts = program.opts();
    const provider = getProvider(opts.cluster, opts.wallet);
    const prog = getProgram(provider);

    const [marketPDA] = getMarketPDA(new PublicKey(adminPubkey));
    const market = await prog.account.market.fetch(marketPDA);

    console.log("\nMarket Account");
    console.log(`  PDA         : ${marketPDA.toBase58()}`);
    console.log(`  Admin       : ${market.admin.toBase58()}`);
    console.log(`  Fee (bps)   : ${market.feeBps}`);
    console.log(`  Order count : ${market.orderCount}\n`);
  });

program.parse(process.argv);
