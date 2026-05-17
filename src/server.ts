#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { Address } from 'viem'
import { isAddress, parseUnits } from 'viem'
import { z } from 'zod'
import {
  ChainUnsupportedError,
  getChainClass,
  resolveChain,
  SUPPORTED_CHAIN_NAMES,
} from './chains'
import { getLimits } from './limits'
import { verifyOtp } from './otp'
import {
  formatBalance,
  getFunderBalance,
  getFundingAccount,
  sendToken,
} from './send'
import { loadPrunedState, recordSend, sumWindow } from './state'
import {
  getPool,
  normalizeToken,
  resolveToken,
  SUPPORTED_TOKENS,
  TokenUnsupportedError,
  TokenUnsupportedOnChainError,
} from './tokens'

const sendInputSchema = z.object({
  amount: z
    .string()
    .describe('Decimal amount as a string, e.g. "0.5" or "0.0001". Not wei.'),
  token: z
    .string()
    .describe(
      'Token symbol. One of: ETH, WETH, USDC, USDT (case-insensitive).',
    ),
  chain: z
    .string()
    .describe(
      'Chain name. Mainnets: ethereum, base, arbitrum, optimism, polygon, plasma. ' +
        'Testnets: sepolia, base-sepolia, arbitrum-sepolia, optimism-sepolia, plasma-testnet.',
    ),
  recipient: z.string().describe('0x-prefixed recipient address.'),
  code: z
    .string()
    .optional()
    .describe(
      '6-digit TOTP code from Apple Passwords / 1Password. Required only when ' +
        'the requested amount exceeds the soft per-call or 24h limit.',
    ),
})

const statusInputSchema = z.object({
  chain: z
    .string()
    .optional()
    .describe(
      'Filter to a specific chain. If omitted, returns all supported chains.',
    ),
  token: z
    .string()
    .optional()
    .describe(
      'Filter to a specific token. If omitted, returns all supported tokens.',
    ),
})

function errorContent(payload: unknown) {
  return {
    isError: true,
    content: [
      { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
    ],
  }
}

function okContent(payload: unknown) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
    ],
  }
}

async function handleSend(input: z.infer<typeof sendInputSchema>) {
  // 1. Input validation
  if (!isAddress(input.recipient)) {
    return errorContent({
      code: 'INVALID_INPUT',
      field: 'recipient',
      problem: 'not a valid 0x address',
      hint: 'pass a 20-byte hex address like 0xCb1f054bCfc93c6eFAC556020D3822E425D37404',
    })
  }
  const amountNum = Number(input.amount)
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return errorContent({
      code: 'INVALID_INPUT',
      field: 'amount',
      problem: 'must be a positive decimal string',
      hint: 'e.g. "0.5" for 0.5 USDC, "0.0001" for 0.0001 ETH',
    })
  }

  let chain: ReturnType<typeof resolveChain>
  try {
    chain = resolveChain(input.chain)
  } catch (err) {
    if (err instanceof ChainUnsupportedError) return errorContent(err.toJson())
    throw err
  }
  const chainClass = getChainClass(chain)

  let token: ReturnType<typeof normalizeToken>
  try {
    token = normalizeToken(input.token)
  } catch (err) {
    if (err instanceof TokenUnsupportedError) return errorContent(err.toJson())
    throw err
  }

  try {
    resolveToken(token, chain.id)
  } catch (err) {
    if (err instanceof TokenUnsupportedOnChainError)
      return errorContent(err.toJson())
    throw err
  }

  // 2. Limit checks
  const pool = getPool(token)
  const limits = getLimits(chainClass, pool)
  const state = loadPrunedState()
  const usedInWindow = sumWindow(state, chainClass, pool)

  // Hard caps — non-bypassable
  if (amountNum > limits.hardPerCall) {
    return errorContent({
      code: 'HARD_LIMIT_EXCEEDED',
      scope: 'per_call',
      requested: amountNum,
      hard_per_call: limits.hardPerCall,
      pool,
      chain_class: chainClass,
      message:
        'Requested amount exceeds the hard per-call cap. This cannot be bypassed ' +
        'even with a valid approval code. Request a smaller amount.',
    })
  }
  if (usedInWindow + amountNum > limits.hardWindow24h) {
    return errorContent({
      code: 'HARD_LIMIT_EXCEEDED',
      scope: 'window_24h',
      requested: amountNum,
      used_in_window: usedInWindow,
      hard_window_24h: limits.hardWindow24h,
      pool,
      chain_class: chainClass,
      message:
        'Requested amount would exceed the hard 24h cap for the ' +
        `${pool} pool on ${chainClass}. This cannot be bypassed even with a valid ` +
        'approval code. Wait or request less.',
    })
  }

  // Soft caps — bypassable with OTP
  const overSoftPerCall = amountNum > limits.perCall
  const overSoftWindow = usedInWindow + amountNum > limits.window24h
  const needsApproval = overSoftPerCall || overSoftWindow

  if (needsApproval) {
    if (!input.code) {
      return errorContent({
        code: 'NEEDS_APPROVAL',
        reason: overSoftPerCall ? 'per_call_over_soft' : 'window_over_soft',
        requested: amountNum,
        soft_per_call: limits.perCall,
        soft_window_24h: limits.window24h,
        used_in_window: usedInWindow,
        hard_per_call: limits.hardPerCall,
        hard_window_24h: limits.hardWindow24h,
        pool,
        chain_class: chainClass,
        hint:
          'Ask the user for a 6-digit TOTP code from their Apple Passwords / 1Password ' +
          'entry labelled "Rhinestone Faucet", then retry with the `code` parameter.',
      })
    }
    const otpResult = verifyOtp(input.code)
    if (!otpResult.ok) {
      return errorContent({
        code: 'APPROVAL_INVALID',
        reason: otpResult.reason,
        hint:
          otpResult.reason === 'replayed'
            ? 'This code has already been used. TOTP codes are single-use; ask the user for a fresh one.'
            : otpResult.reason === 'malformed'
              ? 'Code must be exactly 6 digits.'
              : otpResult.reason === 'missing_secret'
                ? 'Server is missing FAUCET_TOTP_SECRET. Tell the user to run `bun run setup`.'
                : 'The code is wrong or expired (TOTP codes last ~30s). Ask the user for a fresh one.',
      })
    }
  }

  // 3. Balance check
  let resolvedDecimals: number
  let amountRaw: bigint
  try {
    const r = resolveToken(token, chain.id)
    resolvedDecimals = r.decimals
    amountRaw = parseUnits(input.amount, r.decimals)
  } catch (err) {
    return errorContent({
      code: 'INVALID_INPUT',
      field: 'amount',
      problem: (err as Error).message,
      hint: 'Use a decimal amount with no more precision than the token supports',
    })
  }

  let balanceCheck: Awaited<ReturnType<typeof getFunderBalance>>
  try {
    balanceCheck = await getFunderBalance(chain, token, amountRaw)
  } catch (err) {
    return errorContent({
      code: 'RPC_ERROR',
      message: (err as Error).message,
      chain: chain.name,
    })
  }
  if (!balanceCheck.sufficient) {
    return errorContent({
      code: 'INSUFFICIENT_FUNDS',
      token,
      chain: chain.name,
      requested: input.amount,
      funder_balance: formatBalance(
        balanceCheck.balance,
        balanceCheck.decimals,
      ),
      hint:
        'The faucet wallet is out of this token. Top up the wallet ' +
        `(${getFundingAccount().address}) on ${chain.name}.`,
    })
  }

  // 4. Execute
  let result: Awaited<ReturnType<typeof sendToken>>
  try {
    result = await sendToken(
      chain,
      token,
      input.recipient as Address,
      input.amount,
    )
  } catch (err) {
    return errorContent({
      code: 'TX_FAILED',
      message: (err as Error).message,
      chain: chain.name,
      token,
    })
  }

  // 5. Record
  recordSend({
    ts: Date.now(),
    chainId: chain.id,
    chainClass,
    token,
    pool,
    amount: amountNum,
    recipient: input.recipient,
    txHash: result.txHash,
  })

  return okContent({
    ok: true,
    txHash: result.txHash,
    blockExplorerUrl: result.blockExplorerUrl,
    chain: chain.name,
    chainId: chain.id,
    token,
    amount: input.amount,
    recipient: input.recipient,
    decimals: resolvedDecimals,
    approval_used: needsApproval,
    ...(result.wrapTxHash ? { wrapTxHash: result.wrapTxHash } : {}),
    budget_after: {
      pool,
      chain_class: chainClass,
      used_in_window_24h: usedInWindow + amountNum,
      soft_window_24h: limits.window24h,
      hard_window_24h: limits.hardWindow24h,
    },
  })
}

async function handleStatus(input: z.infer<typeof statusInputSchema>) {
  const state = loadPrunedState()
  const funderAddress = (() => {
    try {
      return getFundingAccount().address
    } catch {
      return null
    }
  })()

  const chainNames = input.chain ? [input.chain] : SUPPORTED_CHAIN_NAMES

  const tokenNames = input.token ? [input.token] : SUPPORTED_TOKENS

  const rows = []
  for (const chainName of chainNames) {
    let chain: ReturnType<typeof resolveChain>
    try {
      chain = resolveChain(chainName)
    } catch {
      continue
    }
    const chainClass = getChainClass(chain)
    for (const tokenInput of tokenNames) {
      let token: ReturnType<typeof normalizeToken>
      try {
        token = normalizeToken(tokenInput)
      } catch {
        continue
      }
      let tokenInfo: ReturnType<typeof resolveToken>
      try {
        tokenInfo = resolveToken(token, chain.id)
      } catch {
        continue
      }
      const pool = getPool(token)
      const limits = getLimits(chainClass, pool)
      const usedInWindow = sumWindow(state, chainClass, pool)

      let funderBalance: string | null = null
      if (funderAddress) {
        try {
          const bal = await getFunderBalance(chain, token, 0n)
          funderBalance = formatBalance(bal.balance, bal.decimals)
        } catch {
          funderBalance = null
        }
      }

      rows.push({
        chain: chain.name,
        chainId: chain.id,
        chainClass,
        token,
        pool,
        tokenAddress: tokenInfo.kind === 'erc20' ? tokenInfo.address : 'native',
        decimals: tokenInfo.decimals,
        funder_balance: funderBalance,
        soft_per_call: limits.perCall,
        soft_window_24h: limits.window24h,
        hard_per_call: limits.hardPerCall,
        hard_window_24h: limits.hardWindow24h,
        used_in_window_24h: usedInWindow,
        remaining_soft_window: Math.max(0, limits.window24h - usedInWindow),
        remaining_hard_window: Math.max(0, limits.hardWindow24h - usedInWindow),
      })
    }
  }

  return okContent({
    funder_address: funderAddress,
    rows,
  })
}

async function main() {
  const server = new Server(
    { name: 'rhinestone-faucet', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'send',
        description:
          'Send a small amount of ETH/WETH/USDC/USDT to a recipient address from the faucet wallet. ' +
          'Caps apply per chain class (mainnet/testnet) and per pool (USDC+USDT share a stablecoin pool, ' +
          'ETH+WETH share a pool). Amounts above the soft cap require a 6-digit TOTP code from the user. ' +
          'Hard caps (10x the soft caps) cannot be bypassed even with a code. ' +
          'Amounts are decimal strings (human units), not wei. ' +
          'WETH on chains whose native asset is ETH (ethereum/base/arbitrum/optimism + their sepolias) ' +
          'is wrapped just-in-time from the funder\'s ETH balance when the WETH balance is short; ' +
          'in that case the response also includes `wrapTxHash` for the deposit() call.',
        inputSchema: {
          type: 'object',
          properties: {
            amount: {
              type: 'string',
              description:
                'Decimal amount as a string, e.g. "0.5" for 0.5 USDC, "0.0001" for 0.0001 ETH. Not wei.',
            },
            token: {
              type: 'string',
              description: 'One of: ETH, WETH, USDC, USDT (case-insensitive)',
              enum: [
                'ETH',
                'WETH',
                'USDC',
                'USDT',
                'eth',
                'weth',
                'usdc',
                'usdt',
              ],
            },
            chain: {
              type: 'string',
              description: 'Chain name (e.g. "base", "sepolia", "ethereum")',
              enum: SUPPORTED_CHAIN_NAMES,
            },
            recipient: {
              type: 'string',
              description: '0x-prefixed recipient address',
            },
            code: {
              type: 'string',
              description:
                'Optional 6-digit TOTP from Apple Passwords / 1Password. Required when the request exceeds the soft cap.',
            },
          },
          required: ['amount', 'token', 'chain', 'recipient'],
        },
      },
      {
        name: 'status',
        description:
          'Return faucet wallet balances, configured caps, and remaining 24h budget per pool. ' +
          'Use this to plan before calling send, so you do not trigger unnecessary denials. ' +
          '`funder_balance` is the literal on-chain balance of that token — for WETH on native-ETH chains ' +
          'a `send` can still succeed via JIT wrap as long as the funder\'s ETH covers the shortfall.',
        inputSchema: {
          type: 'object',
          properties: {
            chain: {
              type: 'string',
              description: 'Optional chain filter.',
              enum: SUPPORTED_CHAIN_NAMES,
            },
            token: {
              type: 'string',
              description: 'Optional token filter.',
              enum: ['ETH', 'WETH', 'USDC', 'USDT'],
            },
          },
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      if (req.params.name === 'send') {
        const parsed = sendInputSchema.safeParse(req.params.arguments ?? {})
        if (!parsed.success) {
          return errorContent({
            code: 'INVALID_INPUT',
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              problem: i.message,
            })),
          })
        }
        return await handleSend(parsed.data)
      }
      if (req.params.name === 'status') {
        const parsed = statusInputSchema.safeParse(req.params.arguments ?? {})
        if (!parsed.success) {
          return errorContent({
            code: 'INVALID_INPUT',
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              problem: i.message,
            })),
          })
        }
        return await handleStatus(parsed.data)
      }
      return errorContent({
        code: 'UNKNOWN_TOOL',
        given: req.params.name,
        supported: ['send', 'status'],
      })
    } catch (err) {
      return errorContent({
        code: 'INTERNAL_ERROR',
        message: (err as Error).message,
      })
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('faucet mcp failed to start:', err)
  process.exit(1)
})
