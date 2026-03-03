use anchor_lang::prelude::*;

declare_id!("EpgQjhxaSA5ee5xC8aTFgooUwED3jiSEnpytck4epUTw");

#[program]
pub mod order_matching {
    use super::*;

    pub fn initialize_market(ctx: Context<InitializeMarket>, fee_bps: u16) -> Result<()> {
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

    pub fn place_order(
        ctx: Context<PlaceOrder>,
        side: Side,
        order_type: OrderType,
        price: u64,
        quantity: u64,
    ) -> Result<()> {
        require!(quantity > 0, OrderMatchingError::InvalidQuantity);
        require!(
            price > 0 || order_type == OrderType::Market,
            OrderMatchingError::InvalidPrice
        );

        let market = &mut ctx.accounts.market;
        let order = &mut ctx.accounts.order;
        let order_id = market.order_count;
        market.order_count += 1;

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

    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        let order = &mut ctx.accounts.order;
        require!(
            order.status == OrderStatus::Open
                || order.status == OrderStatus::PartiallyFilled,
            OrderMatchingError::OrderNotOpen
        );
        order.status = OrderStatus::Cancelled;
        emit!(OrderCancelled {
            order_id: order.order_id
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

        let bid_remaining = bid.quantity - bid.filled_qty;
        let ask_remaining = ask.quantity - ask.filled_qty;
        let fill_qty = bid_remaining.min(ask_remaining);
        let fill_price = ask.price;

        bid.filled_qty += fill_qty;
        ask.filled_qty += fill_qty;

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
}

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    #[account(
        init,
        payer = admin,
        space = Market::LEN,
        seeds = [b"market", admin.key().as_ref()],
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
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = owner,
        space = Order::LEN,
        seeds = [b"order", market.key().as_ref(), &market.order_count.to_le_bytes()],
        bump
    )]
    pub order: Account<'info, Order>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(
        mut,
        constraint = order.owner == authority.key() || order.market == market.key() @ OrderMatchingError::Unauthorized
    )]
    pub order: Account<'info, Order>,
    pub market: Account<'info, Market>,
    #[account(
        constraint = authority.key() == order.owner || authority.key() == market.admin @ OrderMatchingError::Unauthorized
    )]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct MatchOrders<'info> {
    #[account(mut, constraint = bid_order.market == market.key())]
    pub bid_order: Account<'info, Order>,
    #[account(mut, constraint = ask_order.market == market.key())]
    pub ask_order: Account<'info, Order>,
    pub market: Account<'info, Market>,
    pub matcher: Signer<'info>,
}

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

#[event]
pub struct OrderCancelled {
    pub order_id: u64,
}

#[event]
pub struct MatchEvent {
    pub bid_order_id: u64,
    pub ask_order_id: u64,
    pub price: u64,
    pub quantity: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum OrderMatchingError {
    #[msg("Invalid price")]
    InvalidPrice,
    #[msg("Invalid quantity")]
    InvalidQuantity,
    #[msg("Order is not open")]
    OrderNotOpen,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Bid price must be >= ask price")]
    PriceMismatch,
    #[msg("Invalid order side")]
    InvalidSide,
}
