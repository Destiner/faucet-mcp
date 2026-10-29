# Faucet

MCP server that lets a coding agent request small amounts of ETH/WETH/USDC/USDT (EVM) or SOL/USDC (Solana) from personal hot wallets, with safety rails so a misbehaving agent can't drain it.

## Motivation

Agent work on smart wallet flows constantly needs small dev funds: top up a fresh smart account, fund a session key, seed a test on a new chain. Public faucets are unreliable and rate-limited; topping up by hand is friction. This is a self-hosted faucet over MCP that the agent can call directly, behind tight per-call and 24h budgets so "i just spent all your money" is not a possible outcome.

Threat model is **agent stupidity, not malice or prompt injection** — if someone can get arbitrary code execution, the funding key in `.env` is the cheaper attack anyway. The caps exist to protect against the agent doing dumb things while you're not watching.

## Design

Two-layer caps, scoped by (chain class, token pool):

- **Soft caps** — enforced unconditionally; first line of defense.
- **Hard caps** (10× soft) — enforced unconditionally and **not bypassable**, even with a valid approval code.

When a request exceeds the soft cap but is under the hard cap, the call returns `NEEDS_APPROVAL`. The agent asks the user for a 6-digit TOTP code (stored in 1Password / Apple Passwords as a verification code). The agent retries with `code=...`; on valid code the transfer goes through. Codes are single-use within a 90s replay window.

### Pools

Limits are per pool, not per token:

- `STABLE`: USDC + USDT share one window, across EVM and Solana
- `ETHWETH`: ETH + WETH share one window
- `SOL`: SOL alone

So 0.5 USDC and 0.5 USDT in the same 24h count as 1.0 against the stable window.

### Caps

| Chain class | Pool   | Soft/call | Soft 24h | Hard/call | Hard 24h |
| ----------- | ------ | --------- | -------- | --------- | -------- |
| mainnet     | stable | 0.10      | 1.0      | 1.0       | 10.0     |
| mainnet     | eth    | 0.00002   | 0.0005   | 0.0002    | 0.005    |
| mainnet     | sol    | 0.002     | 0.02     | 0.02      | 0.2      |
| testnet     | stable | 2         | 20       | 20        | 200      |
| testnet     | eth    | 0.001     | 0.01     | 0.01      | 0.1      |
| testnet     | sol    | 0.1       | 1        | 1         | 10       |

Mainnet SOL caps stay above the ~0.00089 SOL rent-exempt minimum; below it a send to a fresh wallet can never land.

24h windows are rolling (not calendar-day), pruned on each read.

### Tools

- `send(amount, token, chain, recipient, code?)` — execute a transfer. `amount` is a decimal string in human units (e.g. `"0.5"`), never wei. `recipient` is a 0x address on EVM and a base58 wallet (owner) address on Solana. `code` is required only when the request exceeds the soft cap. Responses carry `chainId` (registry id; Solana uses Rhinestone's pseudo-ids `792703809`/`792703810`), `caip2`, and `vm`. On Solana `txHash` is the transaction signature.
- `status(chain?, token?)` — `funder_addresses: { evm, solana }` plus, per chain/token, funder balance, configured caps, used budget, remaining window. Use this to plan before calling `send` to avoid unnecessary denials.

### Errors

`INVALID_INPUT`, `UNSUPPORTED_CHAIN`, `UNSUPPORTED_TOKEN`, `NEEDS_APPROVAL`, `APPROVAL_INVALID`, `HARD_LIMIT_EXCEEDED`, `INSUFFICIENT_FUNDS`, `RPC_ERROR`, `TX_FAILED`, `TX_UNCONFIRMED`, `INTERNAL_ERROR`. `TX_UNCONFIRMED` (Solana) means the tx was broadcast but confirmation polling failed; it carries `txHash`, counts against the budget, and must be checked on the explorer before retrying. Each carries a `hint` describing what to do.

### Supported

Chains: `ethereum`, `base`, `arbitrum`, `optimism`, `polygon`, `plasma`, `solana-mainnet` (aliases `solana`, `sol`), `sepolia`, `base-sepolia`, `arbitrum-sepolia`, `optimism-sepolia`, `plasma-testnet`, `solana-devnet` (aliases `sol-devnet`, `devnet`).

Tokens: EVM `ETH`, `WETH`, `USDC`, `USDT`; Solana `SOL`, `USDC` (no USDT). USDT maps to native USDT on BSC and to `USDT0` (LayerZero OFT) elsewhere — the agent passes `USDT` regardless.

Token addresses come from `@rhinestone/shared-configs` `chainRegistry`, not a local map.

## Setup

1. Install deps:

   ```bash
   bun install
   ```

2. Generate a TOTP secret:

   ```bash
   bun run setup
   ```

   Add the printed `FAUCET_TOTP_SECRET=...` to `.env`. Add the `otpauth://` URI (or scan the QR) into 1Password / Apple Passwords as a verification code entry. Confirm the loop works:

   ```bash
   bun run bin/verify.ts <6-digit-code>
   ```

3. Provide a funding key in `.env`:

   ```
   FUNDING_PRIVATE_KEY=0x...
   ```

   For Solana, `bun run solana-keygen` generates `SOLANA_FUNDING_PRIVATE_KEY` into `.env` and prints only the address. Solana chains are disabled (funder address `null`) without it.

   Fund the wallet with small dev amounts of the tokens you expect to send (testnet first).

4. Wire into Claude Code (`~/.claude.json` or project `.claude/settings.json`):

   ```json
   {
     "mcpServers": {
       "faucet": {
         "command": "bun",
         "args": ["run", "--cwd", "/absolute/path/to/faucet-mcp", "src/server.ts"]
       }
     }
   }
   ```

   `bun run --cwd <dir>` makes bun auto-load `.env` from the faucet directory regardless of where the agent is invoked.

State is persisted at `~/.faucet/state.json` (rolling 24h send log + OTP replay cache). Override with `FAUCET_STATE_FILE=`. RPCs can be overridden per chain with `RPC_URL_<chainId>=` (Solana: `RPC_URL_792703809` / `RPC_URL_792703810`; HTTP only — confirmation is polled, no websocket). Solana RPC calls retry on 429/5xx with backoff, since the public endpoints rate-limit hard; set a private RPC if sends are slow.

## Limitations (v0.1)

- **No file locking on state.json.** Concurrent MCP processes can race the rolling-window check. The hard caps (10× soft) bound the worst-case overage.
- **WETH JIT-wraps from ETH on native-ETH chains** (ethereum/base/arbitrum/optimism + sepolias). If the funder has insufficient WETH but enough ETH to cover the shortfall, `send` deposits the shortfall into WETH9 first, then transfers. The deposit tx hash is returned as `wrapTxHash` alongside the transfer's `txHash`. On chains where the native asset isn't ETH (polygon, plasma, bsc), WETH is treated as a regular ERC20 with no wrap. If a chain registry doesn't list WETH at all, `WETH` returns `UNSUPPORTED_TOKEN`; use `ETH` instead.
- **Partial-failure on JIT wrap**: if `deposit()` lands but `transfer()` fails, the funder is left holding the wrapped ETH as WETH (self-healing on the next call) and the agent gets `TX_FAILED`.
- **Gas comes out of ETH balance** and is not surfaced as a distinct error. An out-of-gas send shows up as `TX_FAILED`. JIT wrap doubles the gas cost (deposit + transfer); on mainnet Ethereum that's tens of cents per call worst case, negligible on L2s and testnets.
- **TOTP secret in `.env` plaintext.** Fine given the threat model (a process that can read `.env` can already read `FUNDING_PRIVATE_KEY`).
- **No audit log beyond 24h.** Older sends are pruned.
- **Solana USDC creates the recipient's associated token account** when missing (`ataCreated: true`); the funder pays ~0.002 SOL rent. Owner may be off-curve (PDA smart accounts work). Passing a token account as `recipient` is rejected.
- **Solana funder needs SOL for fees** even on USDC sends; a shortfall returns `INSUFFICIENT_FUNDS` with `token: "SOL"`. No priority fees are set, so mainnet sends may land slowly under congestion.
- **Recipient is required.** No default — the agent must always specify where funds go. This is intentional.

## Layout

```
src/
  server.ts    MCP stdio entrypoint
  wallet.ts    VM dispatch (recipient validation, balances, preflight, send)
  evm.ts       viem transfer logic (ETH native, ERC20 transfer, WETH JIT wrap)
  solana.ts    @solana/kit transfer logic (SOL, SPL with ATA creation)
  chains.ts    name → EVM/SVM target via chainRegistry
  tokens.ts    symbol → address/mint via chainRegistry (USDC/USDT/USDT0/WETH/ETH/SOL)
  limits.ts    soft + hard caps per (chain class, pool)
  state.ts    ~/.faucet/state.json io + rolling window math
  otp.ts       TOTP verify + single-use replay cache
bin/
  setup.ts     generate secret + otpauth URI + QR for 1P / Apple Passwords
  verify.ts    smoke-test a TOTP code against the secret
  solana-keygen.ts  generate SOLANA_FUNDING_PRIVATE_KEY into .env
```
