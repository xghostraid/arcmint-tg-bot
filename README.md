# arcmint-tg-bot

Telegram trading bot for **Arc Mainnet** (Cove-style UX): create wallet → paste token → buy with USDC presets.

**Mainnet only.** Testnet (`5042002`) is refused at startup.

## Arc Mainnet (from RadarDEX / Rabby-compatible RPCs)

| Field | Value |
|--------|--------|
| Network | Arc Mainnet |
| Chain ID | **5042** (`0x13b2`) |
| RPC (primary) | `https://rpc.blockdaemon.mainnet.arc.io` |
| RPC (fallback) | `https://5042.rpc.thirdweb.com` |
| Explorer | https://arcscan.app |
| USDC | `0x3600000000000000000000000000000000000000` |

Add the same network in **Rabby → Add Custom Network**.

RadarDEX also exposes Uniswap V3 router/quoter used for swaps (see `.env.example`).

## Cove-like interface

- `/start` home + inline menu (Buy / Sell / Wallet / Positions / Settings)
- Paste `0x` token address → buy presets (`$5 $10 $25…`)
- Confirm → approve USDC → swap on Arc Mainnet
- Multi-wallet create / import / export (encrypted at rest)

## Setup

```bash
cd ~/arcmint-tg-bot
cp .env.example .env
# edit .env:
#   TELEGRAM_BOT_TOKEN=from @BotFather
#   WALLET_ENCRYPTION_KEY=$(openssl rand -hex 32)

npm install
npm run dev
```

Create a bot with [@BotFather](https://t.me/BotFather), paste the token, then message `/start`.

## Security

- Private keys are encrypted with AES-256-GCM in SQLite (`data/bot.sqlite`).
- This is a **custodial** bot model (like Cove). Use small funds; audit before production scale.
- Optional `TELEGRAM_ALLOWLIST` for your Telegram user id(s).

## Notes

- Gas on Arc is **native USDC** (18 decimals for gas accounting). ERC-20 USDC (6 decimals) is used for swaps.
- Quotes try Uniswap V3 fee tiers `100 / 500 / 3000 / 10000`.
- If a token only has a Radar V4 pool, quote may fail until V4 path is added.
- **arcmint.fun** launchpad factories on mainnet may differ from RadarDEX; bot currently swaps via RadarDEX V3 addresses on Arc Mainnet.
