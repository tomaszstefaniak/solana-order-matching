# On-Chain Order Matching Engine (Solana / Anchor) — limit-only CLOB prototype

**Superteam Poland Bounty submission** — an on-chain, Anchor-based prototype of a central-limit order book (CLOB):
place → cancel → match, with partial fills and deterministic execution.

**Program ID (devnet):** `CpnJ2pRUqZxSLh45qiX58YyJBuhQ3voDKKy8RYibnJ4n`

---

## What this is (in one paragraph)

This repo is a **minimal on-chain order matching state machine** on Solana.  
Orders live as program-owned accounts (PDAs). Anyone can call `match_orders` to match a crossing bid/ask pair (bid ≥ ask).  
This version is **limit-only** (market orders are rejected) and it does **not** move tokens yet — it focuses on correctness, constraints, and state transitions.

---

## Author

**Tomasz** — I build trading-adjacent systems in TradFi (SimCorp) and I also build on Solana / Web3 in general.

In TradFi, you rarely implement the exchange’s matching engine itself inside an asset manager’s platform — but you *do* build the surrounding critical plumbing:
- order lifecycle & validation (OMS-style state machine)
- routing / venue adapters (OMS Communication Server / message normalization)
- auditability (events, traceability, deterministic processing)
- operational safety (permissions, invariants, failure modes)

On Solana, the primitives change (accounts + instructions + signers), but the engineering mindset is the same:
**tight constraints, deterministic outcomes, and observable state changes.**

I’ve also built Solana DeFi apps (e.g. AMM-style swaps via Raydium SDK — a different model than an orderbook). This repo is intentionally closer to the **order lifecycle & matching** world.

---

## Features (what’s implemented)

- **Market initialization** — create a PDA-backed market with a configurable fee rate
- **Limit orders only** — buy/sell limit orders (`order_type == Limit`)
- **Permissionless matching** — anyone can match a crossing bid/ask pair (bid ≥ ask)
- **Partial + full fills** — updates `filled_qty` and `status`
- **Cancel orders** — by owner or market admin
- **Close terminal orders** — reclaim rent for `Filled` / `Cancelled` orders
- **Events** — all transitions emit `emit!()` events for indexing

---

## How a typical Web2 exchange looks (high-level)

A centralized exchange usually keeps an in-memory “book” structure and a single matching process:

| Component | Typical Web2 implementation | What it does |
|---|---|---|
| In-memory book | priority queues / sorted sets (often Redis or in-process) | keep bids/asks sorted by price |
| Persistence | database (Postgres, etc.) | canonical state, fills, balances |
| Matching engine | single optimized service | reads orders, produces fills |
| Market data | WebSockets | pushes top-of-book and trades |
| Settlement | internal ledger updates | debit/credit balances |

**Why this wins in Web2:** ultra-low latency, easy book scanning, strong control.  
**Why this is a trust problem:** custodial funds, operator control, closed logic, single point of failure.

---

## Solana architecture (what this repo does instead)

| Web2 concept | Solana replacement in this repo |
|---|---|
| in-memory sorted book | **many Order PDAs** owned by the program |
| database rows | **account data** (Anchor/Borsh) |
| matching service | `match_orders` instruction |
| websocket feed | `emit!()` events + indexers / RPC / Geyser |
| settlement | **future work** (token vaults + transfers) |

**Key design choice:** there is **no on-chain orderbook scan**.  
To keep compute bounded, `match_orders` expects you to pass the two orders explicitly.  
Bots/keepers can scan off-chain via `getProgramAccounts` and submit matches.

---

## PDAs & account model

**PDA derivation**
- Market: `[b"market", admin_pubkey]`
- Order: `[b"order", market_pubkey, order_id_le_bytes(8)]`

**Ownership**
- The program owns Market and Order accounts. Only the program can mutate them.

**Determinism**
- Every validator executes the same matching logic → same result, regardless of who calls `match_orders`.

---

## Tradeoffs (honest constraints)

- **No on-chain orderbook scan**  
  Matching requires passing both order PDAs. Off-chain search is required.
- **Compute limits**  
  No O(n) matching loops inside one transaction.
- **Rent per order**  
  Each order account is rent-exempt (cost matters for HFT).
- **No token transfers yet**  
  This is a pure state machine prototype (escrow/settlement is roadmap).
- **Self-match guard**  
  Anti-wash-trading checks should be enabled for production.  
  (If you temporarily disable it for single-wallet testing, treat that as dev-only.)
- **Multiple fills require multiple matches**  
  Big order vs many small orders requires multiple `match_orders` calls.

---

## Accounts

### Market (`Market`)
- `admin: Pubkey`
- `fee_bps: u16` (basis points)
- `order_count: u64` (monotonic order id counter)
- `bump: u8`

### Order (`Order`)
- `market: Pubkey`
- `owner: Pubkey`
- `order_id: u64`
- `side: Buy | Sell`
- `order_type: Limit` (Market rejected in this version)
- `price: u64` (lamports)
- `quantity: u64`
- `filled_qty: u64`
- `status: Open | PartiallyFilled | Filled | Cancelled`
- `created_at: i64`
- `bump: u8`

---

## Instructions (API)

### `initialize_market(fee_bps: u16)`
Creates a market PDA for the signing admin.

### `place_order(side, order_type, price, quantity)`
Creates a new order PDA and increments market `order_count`.

Validation (this version):
- `quantity > 0`
- `price > 0`
- `order_type == Limit` (market orders rejected)

### `cancel_order()`
Cancels `Open` / `PartiallyFilled` orders.
- signer must be **order owner** or **market admin**

### `match_orders()`
Matches a **bid (buy)** order against an **ask (sell)** order.

Validation:
- both orders are `Open` / `PartiallyFilled`
- same market
- opposite sides
- `bid.price >= ask.price`

Fill logic:
- `fill_qty = min(bid_remaining, ask_remaining)`
- **Fill price** = price of the **resting (maker) order**  
  (maker is determined by lower `order_id`)

### `close_order()`
Closes `Filled` / `Cancelled` order and reclaims rent to the owner.

---

## Setup

### Prerequisites
- Rust 1.84+ (stable)
- Anchor CLI 0.30.1
- Solana CLI 1.18+ (Anza)
- Node.js 22+

### Build
```bash
anchor build --no-idl
```

> Why `--no-idl`?  
> In some Rust/Anchor toolchain combos, IDL generation may fail due to proc-macro dependency friction.  
> This repo commits IDL under `app/idl/` to keep client builds reproducible.

### Test (local validator)
```bash
anchor test --skip-build
```

---

## Devnet deployment

**Program ID:** `CpnJ2pRUqZxSLh45qiX58YyJBuhQ3voDKKy8RYibnJ4n`

Explorer (address):
https://explorer.solana.com/address/CpnJ2pRUqZxSLh45qiX58YyJBuhQ3voDKKy8RYibnJ4n?cluster=devnet

Deploy transaction:
https://explorer.solana.com/tx/3UUTrJmB4fpyh8TgYiPqBwMkC12R1pY4xCL1PDQWYCByXYq6L17u3LTSD4eLY2rqSuUFtTAARiGn3e15LeRYcdHs?cluster=devnet

---

## CLI usage

```bash
cd client
npm install
```

### Initialize market
```bash
npx ts-node src/index.ts --cluster devnet init-market 25
```

### Place orders
```bash
npx ts-node src/index.ts --cluster devnet place-order \
  --market <admin-pubkey> \
  --side buy \
  --price 1000 \
  --quantity 10

npx ts-node src/index.ts --cluster devnet place-order \
  --market <admin-pubkey> \
  --side sell \
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
npx ts-node src/index.ts --cluster devnet show-order <order-pda>
npx ts-node src/index.ts --cluster devnet show-market <admin-pubkey>
```

---

## Design notes

### Why PDAs for orders?
- deterministic addresses (clients can compute them)
- order ids become a clean sequence
- future-friendly for escrow logic

### Keeper / matching bot pattern
`match_orders` is permissionless on purpose.
A keeper can:
1) scan orders off-chain (RPC `getProgramAccounts`)
2) find crossing pairs
3) submit `match_orders`

---
