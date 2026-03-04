use anchor_lang::prelude::*;

declare_id!("56Ygzbd4js8d9T5jzzgc5kVgSwUATsEHZ5dwZxkPq9TY");

// Seed constants — avoids typo drift across structs
pub const MARKET_SEED: &[u8] = b"market";
pub const ORDER_SEED: &[u8] = b"order";

#[program]
pub mod order_matching {
    use super::*;

    // FIX 4: validate fee_bps <= 10_000
    pub fn initialize_market(ctx: Context<InitializeMarket>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= 10_000, OrderMatchingError::InvalidFeeBps);

        let market = &mut ctx.accounts.market;
        market.admin = ctx.accounts.admin.key();
        market.fee_bps = fee_bps;
        market.order_count = 0;
        market.bump = ctx.bumps.market;
        emit!(MarketInitialized {
            market: market.key(),
            admin: market.admin,
            fee_bps,
        });
        Ok(())
    }

    // FIX 2 (Option B): Reject Market orders — Limit-only prototype
    // Keeps matching logic simple and correct; documented in README
    pub fn place_order(
        ctx: Context<PlaceOrder>,
        side: Side,
        order_type: OrderType,
        price: u64,
        quantity: u64,
    ) -> Result<()> {
        require!(quantity > 0, OrderMatchingError::InvalidQuantity);
        require!(order_type == OrderType::Limit, OrderMatchingError::MarketOrdersNotSupported);
        require!(price > 0, OrderMatchingError::InvalidPrice);

        let market = &mut ctx.accounts.market;
        let order = &mut ctx.accounts.order;
        let order_id = market.order_count;

        // FIX 5: checked arithmetic on order_count
        market.order_count = market
            .order_count
            .checked_add(1)
            .ok_or(OrderMatchingError::Overflow)?;

        order.market = market.key();
        order.owner = ctx.accounts.owner.key();
        order.order_id = order_id;
        order.side = side.clone();
        order.order_type = order_type;
        order.price = price;
        order.quantity = quantity;
        order.filled_qty = 0;
        order.status = OrderStatus::Open;
        order.created_at = Clock::get()?.unix_timestamp;
        order.bump = ctx.bumps.order;

        emit!(OrderPlaced {
            market: market.key(),
            order_id,
            owner: order.owner,
            side,
            price,
            quantity,
        });
        Ok(())
    }

    // FIX 1: cancel_order — market binding always enforced; authority checked separately
    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        let order = &mut ctx.accounts.order;
        require!(
            order.status == OrderStatus::Open || order.status == OrderStatus::PartiallyFilled,
            OrderMatchingError::OrderNotOpen
        );
        order.status = OrderStatus::Cancelled;
        emit!(OrderCancelled {
            order_id: order.order_id,
            owner: order.owner,
        });
        Ok(())
    }

    pub fn match_orders(ctx: Context<MatchOrders>) -> Result<()> {
        let bid = &mut ctx.accounts.bid_order;
        let ask = &mut ctx.accounts.ask_order;

        require!(
            bid.status == OrderStatus::Open || bid.status == OrderStatus::PartiallyFilled,
            OrderMatchingError::OrderNotOpen
        );
        require!(
            ask.status == OrderStatus::Open || ask.status == OrderStatus::PartiallyFilled,
            OrderMatchingError::OrderNotOpen
        );
        require!(bid.side == Side::Buy, OrderMatchingError::InvalidSide);
        require!(ask.side == Side::Sell, OrderMatchingError::InvalidSide);
        require!(bid.price >= ask.price, OrderMatchingError::PriceMismatch);

        // FIX 5: enforce invariants before arithmetic
        require!(bid.filled_qty <= bid.quantity, OrderMatchingError::Overflow);
        require!(ask.filled_qty <= ask.quantity, OrderMatchingError::Overflow);

        let bid_remaining = bid
            .quantity
            .checked_sub(bid.filled_qty)
            .ok_or(OrderMatchingError::Overflow)?;
        let ask_remaining = ask
            .quantity
            .checked_sub(ask.filled_qty)
            .ok_or(OrderMatchingError::Overflow)?;
        let fill_qty = bid_remaining.min(ask_remaining);

        // FIX 5: guard against zero-fill (e.g. already fully filled)
        require!(fill_qty > 0, OrderMatchingError::ZeroFill);

        let fill_price = ask.price;

        bid.filled_qty = bid
            .filled_qty
            .checked_add(fill_qty)
            .ok_or(OrderMatchingError::Overflow)?;
        ask.filled_qty = ask
            .filled_qty
            .checked_add(fill_qty)
            .ok_or(OrderMatchingError::Overflow)?;

        bid.status = if bid.filled_qty == bid.quantity {
            OrderStatus::Filled
        } else {
            OrderStatus::PartiallyFilled
        };
        ask.status = if ask.filled_qty == ask.quantity {
            OrderStatus::Filled
        } else {
            OrderStatus::PartiallyFilled
        };

        emit!(MatchEvent {
            bid_order_id: bid.order_id,
            ask_order_id: ask.order_id,
            price: fill_price,
            quantity: fill_qty,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    // FIX 7: close_order — reclaim rent when order is terminal
    pub fn close_order(_ctx: Context<CloseOrder>) -> Result<()> {
        // Anchor's `close` constraint handles lamport transfer and account zeroing.
        // Validation (status + authority) is done in the account constraints below.
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account structs
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    #[account(
        init,
        payer = admin,
        space = Market::LEN,
        seeds = [MARKET_SEED, admin.key().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(side: Side, order_type: OrderType, price: u64, quantity: u64)]
pub struct PlaceOrder<'info> {
    // FIX 3: verify market PDA via seeds
    #[account(
        mut,
        seeds = [MARKET_SEED, market.admin.as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = owner,
        space = Order::LEN,
        seeds = [ORDER_SEED, market.key().as_ref(), &market.order_count.to_le_bytes()],
        bump
    )]
    pub order: Account<'info, Order>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// FIX 1 + FIX 3: market binding always enforced; authority constraint separated
#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(
        mut,
        seeds = [ORDER_SEED, market.key().as_ref(), &order.order_id.to_le_bytes()],
        bump = order.bump,
        // market binding is always required
        constraint = order.market == market.key() @ OrderMatchingError::MarketMismatch,
    )]
    pub order: Account<'info, Order>,
    #[account(
        seeds = [MARKET_SEED, market.admin.as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    // FIX 1: authority check is independent of market binding
    #[account(
        constraint = (
            authority.key() == order.owner ||
            authority.key() == market.admin
        ) @ OrderMatchingError::Unauthorized
    )]
    pub authority: Signer<'info>,
}

// FIX 3: PDA seeds for market + order accounts in MatchOrders
#[derive(Accounts)]
pub struct MatchOrders<'info> {
    #[account(
        mut,
        seeds = [ORDER_SEED, market.key().as_ref(), &bid_order.order_id.to_le_bytes()],
        bump = bid_order.bump,
        constraint = bid_order.market == market.key() @ OrderMatchingError::MarketMismatch,
    )]
    pub bid_order: Account<'info, Order>,
    #[account(
        mut,
        seeds = [ORDER_SEED, market.key().as_ref(), &ask_order.order_id.to_le_bytes()],
        bump = ask_order.bump,
        constraint = ask_order.market == market.key() @ OrderMatchingError::MarketMismatch,
    )]
    pub ask_order: Account<'info, Order>,
    #[account(
        seeds = [MARKET_SEED, market.admin.as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    pub matcher: Signer<'info>,
}

// FIX 7: close instruction — reclaims rent to owner
#[derive(Accounts)]
pub struct CloseOrder<'info> {
    #[account(
        mut,
        seeds = [ORDER_SEED, market.key().as_ref(), &order.order_id.to_le_bytes()],
        bump = order.bump,
        constraint = order.market == market.key() @ OrderMatchingError::MarketMismatch,
        constraint = (
            order.status == OrderStatus::Filled ||
            order.status == OrderStatus::Cancelled
        ) @ OrderMatchingError::OrderNotClosed,
        constraint = owner.key() == order.owner @ OrderMatchingError::Unauthorized,
        close = owner
    )]
    pub order: Account<'info, Order>,
    #[account(
        seeds = [MARKET_SEED, market.admin.as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[account]
pub struct Market {
    pub admin: Pubkey,
    pub fee_bps: u16,
    pub order_count: u64,
    pub bump: u8,
}

impl Market {
    pub const LEN: usize = 8 + 32 + 2 + 8 + 1;
}

#[account]
pub struct Order {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub order_id: u64,
    pub side: Side,
    pub order_type: OrderType,
    pub price: u64,
    pub quantity: u64,
    pub filled_qty: u64,
    pub status: OrderStatus,
    pub created_at: i64,
    pub bump: u8,
}

impl Order {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 1 + 1 + 8 + 8 + 8 + 1 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum Side {
    Buy,
    Sell,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum OrderType {
    Limit,
    Market,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum OrderStatus {
    Open,
    Filled,
    Cancelled,
    PartiallyFilled,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct MarketInitialized {
    pub market: Pubkey,
    pub admin: Pubkey,
    pub fee_bps: u16,
}

#[event]
pub struct OrderPlaced {
    pub market: Pubkey,
    pub order_id: u64,
    pub owner: Pubkey,
    pub side: Side,
    pub price: u64,
    pub quantity: u64,
}

// FIX: richer event — include owner for easier indexing
#[event]
pub struct OrderCancelled {
    pub order_id: u64,
    pub owner: Pubkey,
}

#[event]
pub struct MatchEvent {
    pub bid_order_id: u64,
    pub ask_order_id: u64,
    pub price: u64,
    pub quantity: u64,
    pub timestamp: i64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum OrderMatchingError {
    #[msg("Invalid price — must be > 0 for limit orders")]
    InvalidPrice,
    #[msg("Invalid quantity — must be > 0")]
    InvalidQuantity,
    #[msg("Order is not open or partially filled")]
    OrderNotOpen,
    #[msg("Order must be Filled or Cancelled to close")]
    OrderNotClosed,
    #[msg("Unauthorized — caller is not the order owner or market admin")]
    Unauthorized,
    #[msg("Bid price must be >= ask price")]
    PriceMismatch,
    #[msg("Invalid order side for this operation")]
    InvalidSide,
    #[msg("Order does not belong to the provided market")]
    MarketMismatch,
    #[msg("fee_bps must be <= 10_000")]
    InvalidFeeBps,
    #[msg("Market orders are not supported in this version (limit-only prototype)")]
    MarketOrdersNotSupported,
    #[msg("Arithmetic overflow or underflow")]
    Overflow,
    #[msg("Fill quantity is zero — orders may already be fully filled")]
    ZeroFill,
}
