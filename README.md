# On-Chain Order Matching Engine

**Superteam Poland Bounty** — Solana/Anchor program implementing a central-limit order book (CLOB) entirely on-chain.

Program ID (devnet): `CpnJ2pRUqZxSLh45qiX58YyJBuhQ3voDKKy8RYibnJ4n`

---

## Overview

This project implements an on-chain order matching engine as a Solana program written with the Anchor framework. It demonstrates how the core state-machine logic of a traditional order book (place, cancel, match) can be expressed as program accounts and instructions on Solana, replacing centralised off-chain infrastructure with a transparent, permissionless, and composable on-chain alternative.

Key capabilities:
- **Initialize a market** — create a PDA-backed order book with a configurable fee rate
- **Place orders** — limit orders for both buy and sell sides (limit-only; market orders are rejected in this version)
- **Match orders** — permissionless matching when bid ≥ ask; partial and full fills
- **Cancel orders** — by the order owner or market admin
- **Events** — all state transitions emit `emit!()` events for indexing

---

## Web2 Architecture (Traditional Order Matching)

A traditional centralised exchange order book operates as follows:

| Layer | Technology | Role |
|---|---|---|
| Order Book | Redis Sorted Sets (`ZRANGEBYSCORE`) | Price-sorted bid/ask queues |
| Persistence | PostgreSQL | Canonical order state, fills, balances |
| Matching Engine | Single-process service | Consumes order queue, emits fills |
| Price Feeds | WebSocket streams | Real-time best bid/ask to clients |
| Settlement | Batch job / DB transaction | Debit seller, credit buyer |

**Flow**: REST/WS → Matching Engine process → Redis O(log n) insert → PostgreSQL write → WebSocket push.

**Advantages**: sub-millisecond latency, easy to scan order book state, atomic settlement.

**Disadvantages**: single point of failure, trust in operator, no composability, custodial funds, closed source matching logic.

---

## Solana Architecture (This Program)

On-chain replacement for the components above:

| Web2 Concept | Solana Replacement |
|---|---|
| Redis sorted set (bid queue) | Multiple `Order` PDAs owned by program |
| PostgreSQL row | `Account` data serialized by Anchor (Borsh) |
| Matching engine process | `match_orders` instruction |
| WebSocket push | `emit!()` events indexed by RPC / Geyser |
| Settlement | Token transfer (future; currently pure state machine) |

**PDA derivation**:
- Market: `[b"market", admin_pubkey]`
- Order: `[b"order", market_pubkey, order_id_le_bytes(8)]`

**Account ownership**: The program owns all Market and Order accounts; only the program code can modify them.

**Deterministic execution**: Every validator runs the same matching logic; the result is the same regardless of who calls `match_orders`.

**Events**: `MarketInitialized`, `OrderPlaced`, `OrderCancelled`, `MatchEvent` are emitted via `emit!()` and can be listened to by clients or indexed by Geyser plugins.

---

## Tradeoffs and Constraints

| Constraint | Detail |
|---|---|
| No on-chain order book scan | `match_orders` requires passing both order PDAs explicitly. Callers (bots, keepers) must find matches off-chain (e.g. via `getProgramAccounts`) and then submit the matching transaction. This avoids O(n) compute cost. |
| Compute Unit limit | Each transaction is bounded by ~1.4M CU per block, ~200k CU per typical instruction. Complex matching loops are not feasible in a single transaction. |
| Rent per order | Each `Order` account (~116 bytes) requires ~0.002 SOL rent-exempt deposit. High-frequency strategies must account for account creation cost. |
| No token transfer | This implementation is a **pure state machine**. It demonstrates the matching logic without actual SPL token transfers. A production system would add token vaults (SPL Token program) for escrowing funds. |
| Self-match check disabled | The `require!(bid.owner != ask.owner)` anti-wash-trading guard is commented out in this devnet build to enable single-wallet testing. It should be re-enabled for a production deployment where multiple traders participate. |
| Partial fill support | `match_orders` fills up to `min(bid_remaining, ask_remaining)`, updating both order statuses (`PartiallyFilled` or `Filled`). Multiple calls are needed to fully fill a large order against several smaller ones. |
| Anyone can match | `matcher` is any signer. Matching is permissionless — a keeper network (or any MEV bot) can submit matching transactions and collect protocol fees in a production version. |

---

## Account Structure

### Market (`Market`)

| Field | Type | Size | Description |
|---|---|---|---|
| discriminator | `[u8; 8]` | 8 | Anchor account discriminator |
| admin | `Pubkey` | 32 | Market admin / fee recipient |
| fee_bps | `u16` | 2 | Fee in basis points (e.g. 25 = 0.25%) |
| order_count | `u64` | 8 | Total orders placed (monotonic counter) |
| bump | `u8` | 1 | PDA bump seed |
| **Total** | | **51 bytes** | |

### Order (`Order`)

| Field | Type | Size | Description |
|---|---|---|---|
| discriminator | `[u8; 8]` | 8 | Anchor account discriminator |
| market | `Pubkey` | 32 | Parent market PDA |
| owner | `Pubkey` | 32 | Order owner |
| order_id | `u64` | 8 | Unique monotonic order ID |
| side | `Side` (enum) | 1 | `Buy` = 0, `Sell` = 1 |
| order_type | `OrderType` (enum) | 1 | `Limit` = 0, `Market` = 1 |
| price | `u64` | 8 | Limit price in lamports |
| quantity | `u64` | 8 | Total order quantity |
| filled_qty | `u64` | 8 | Amount filled so far |
| status | `OrderStatus` (enum) | 1 | Open / Filled / Cancelled / PartiallyFilled |
| created_at | `i64` | 8 | Unix timestamp |
| bump | `u8` | 1 | PDA bump seed |
| **Total** | | **116 bytes** | |

---

## Instructions

### `initialize_market(fee_bps: u16)`

Creates a new market PDA for the signing admin.

| Account | Role |
|---|---|
| `market` | New Market PDA (init, writable) |
| `admin` | Payer + signer |
| `system_program` | For account creation |

**Events**: `MarketInitialized { market, admin, fee_bps }`

---

### `place_order(side, order_type, price, quantity)`

Places a new order on the market.

| Account | Role |
|---|---|
| `market` | Market PDA (writable — increments `order_count`) |
| `order` | New Order PDA (init, writable) |
| `owner` | Payer + signer |
| `system_program` | For account creation |

**Validation**: `quantity > 0`; `price > 0`; `order_type == Limit` (market orders are not supported in this version).

**Events**: `OrderPlaced { market, order_id, owner, side, price, quantity }`

---

### `cancel_order()`

Cancels an open or partially-filled order.

| Account | Role |
|---|---|
| `order` | Order PDA (writable) |
| `market` | Market PDA (read) |
| `authority` | Signer — must be order owner **or** market admin |

**Validation**: Order must be `Open` or `PartiallyFilled`.

**Events**: `OrderCancelled { order_id, owner }`

---

### `match_orders()`

Matches a bid order against an ask order.

| Account | Role |
|---|---|
| `bid_order` | Buy order PDA (writable) |
| `ask_order` | Sell order PDA (writable) |
| `market` | Market PDA (read) |
| `matcher` | Any signer (permissionless keeper) |

**Validation**: Both orders must be Open/PartiallyFilled; `bid.price >= ask.price`.

**Fill logic**: `fill_qty = min(bid_remaining, ask_remaining)`. Fill price = `ask.price` (maker pricing).

**Events**: `MatchEvent { bid_order_id, ask_order_id, price, quantity, timestamp }`

---

## Setup

### Prerequisites

- Rust 1.84+ (stable)
- Anchor CLI 0.30.1 (`cargo install --git https://github.com/coral-xyz/anchor avm --force`)
- Solana CLI 1.18+ (`sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`)
- Node.js 22+

### Build

```bash
cd order-matching
anchor build --no-idl   # IDL codegen disabled (proc-macro2 version incompatibility on new Rust)
```

The compiled `.so` is at `target/deploy/order_matching.so`.

### Test (local validator)

```bash
anchor test --skip-build   # uses already-built .so
```

Expected output:

```
  order-matching
    ✔ initializes a market
    ✔ places a bid (buy) order
    ✔ places an ask (sell) order
    ✔ matches orders (full fill)
    ✔ handles partial fill
    ✔ cancels an open order
    ✔ admin can cancel any order
    ✔ rejects unauthorized cancel
    ✔ rejects match when bid price < ask price

  9 passing
```

### Deploy to devnet

```bash
solana config set --url devnet
solana airdrop 2
anchor deploy --provider.cluster devnet
```

---

## Devnet Deployment

Program ID: **`CpnJ2pRUqZxSLh45qiX58YyJBuhQ3voDKKy8RYibnJ4n`**

Explorer: https://explorer.solana.com/address/CpnJ2pRUqZxSLh45qiX58YyJBuhQ3voDKKy8RYibnJ4n?cluster=devnet

Deploy transaction: https://explorer.solana.com/tx/3UUTrJmB4fpyh8TgYiPqBwMkC12R1pY4xCL1PDQWYCByXYq6L17u3LTSD4eLY2rqSuUFtTAARiGn3e15LeRYcdHs?cluster=devnet

---

## Client CLI Usage

```bash
cd client
npm install
```

### Initialize a market

```bash
npx ts-node src/index.ts --cluster devnet init-market 25
# Creates a market with 0.25% fee
# Outputs: Market PDA address + transaction signature
```

### Place orders

```bash
# Place a buy limit order at price 1000, quantity 10
npx ts-node src/index.ts --cluster devnet place-order \
  --market <admin-pubkey> \
  --side buy \
  --type limit \
  --price 1000 \
  --quantity 10

# Place a sell limit order at price 900, quantity 5
npx ts-node src/index.ts --cluster devnet place-order \
  --market <admin-pubkey> \
  --side sell \
  --type limit \
  --price 900 \
  --quantity 5
```

### Match orders

```bash
npx ts-node src/index.ts --cluster devnet match-orders \
  --market <admin-pubkey> \
  --bid <bid-order-pda> \
  --ask <ask-order-pda>
```

### Cancel an order

```bash
npx ts-node src/index.ts --cluster devnet cancel-order \
  --market <admin-pubkey> \
  --order <order-pda>
```

### Inspect accounts

```bash
# Show order state
npx ts-node src/index.ts --cluster devnet show-order <order-pda>

# Show market state
npx ts-node src/index.ts --cluster devnet show-market <admin-pubkey>
```

---

## Design Notes

### Why PDAs for Orders?

Each order is stored in a deterministic PDA derived from `[b"order", market_pubkey, order_id_bytes]`. This means:
1. Any client can compute the address of any order without querying the chain
2. Order IDs serve as a canonical sequence — easy to iterate with `getProgramAccounts` off-chain
3. The program has signing authority over its own PDAs for future token-escrowing logic

### Keeper / Matching Bot Pattern

The `match_orders` instruction is intentionally permissionless. Any party can call it when a crossing bid/ask pair exists. This enables:
- **MEV bots** that scan the order book off-chain and submit matching transactions
- **On-chain keeper programs** triggered by price oracles
- **Protocol-owned keepers** that collect matching fees

Off-chain scanning: `getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: 8+32+32+8+1, bytes: bs58.encode([0]) } }] })` to find open orders.

### Future Work

- SPL Token escrow: lock tokens when placing orders; transfer on fill
- Native order book CPI: allow composable protocols to place orders
- Price-time priority: fill at best price; timestamp tiebreaker stored in `created_at`
- Fee collection: send `fee_bps * fill_value / 10000` lamports to market admin on each fill
