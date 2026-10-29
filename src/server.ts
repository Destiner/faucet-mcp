#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { formatUnits, parseUnits } from 'viem'
import { z } from 'zod'
import {
  ChainUnsupportedError,
  resolveChain,
  SUPPORTED_CHAIN_NAMES,
  type Target,
} from './chains'
import { getLimits } from './limits'
import { verifyOtp } from './otp'
import { loadPrunedState, recordSend, sumWindow } from './state'
import {
  getPool,
  normalizeToken,
  type ResolvedToken,
  resolveToken,
  SUPPORTED_TOKENS,
  type TokenSymbol,
  TokenUnsupportedError,
  TokenUnsupportedOnChainError,
} from './tokens'
import {
  getFunderAddress,
  getFunderBalance,
  isValidRecipient,
  preflight,
  RECIPIENT_FORMAT,
  sendToken,
  TxUnconfirmedError,
} from './wallet'

const sendInputSchema = z.object({
  amount: z
    .string()
    .describe('Decimal amount as a string, e.g. "0.5" or "0.0001". Not wei.'),
  token: z
    .string()
    .describe(
      'Token symbol. EVM: ETH, WETH, USDC, USDT. Solana: SOL, USDC (case-insensitive).',
    ),
  chain: z
    .string()
    .describe(
      'Chain name. Mainnets: ethereum, base, arbitrum, optimism, polygon, plasma, solana-mainnet. ' +
        'Testnets: sepolia, base-sepolia, arbitrum-sepolia, optimism-sepolia, plasma-testnet, solana-devnet.',
    ),
  recipient: z
    .string()
    .describe(
      'Recipient wallet: 0x address on EVM chains, base58 public key on Solana.',
    ),
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

function invalidInputIssues(error: z.ZodError) {
  return errorContent({
    code: 'INVALID_INPUT',
    issues: error.issues.map((i) => ({
      path: i.path.join('.'),
      problem: i.message,
    })),
  })
}

async function handleSend(input: z.infer<typeof sendInputSchema>) {
  // 1. Input validation
  const amountNum = Number(input.amount)
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return errorContent({
      code: 'INVALID_INPUT',
      field: 'amount',
      problem: 'must be a positive decimal string',
      hint: 'e.g. "0.5" for 0.5 USDC, "0.0001" for 0.0001 ETH',
    })
  }

  let target: Target
  try {
    target = resolveChain(input.chain)
  } catch (err) {
    if (err instanceof ChainUnsupportedError) return errorContent(err.toJson())
    throw err
  }
  const { chainClass } = target

  if (!isValidRecipient(target, input.recipient)) {
    return errorContent({
      code: 'INVALID_INPUT',
      field: 'recipient',
      chain: target.name,
      ...RECIPIENT_FORMAT[target.vm],
    })
  }

  let token: TokenSymbol
  let resolved: ResolvedToken
  try {
    token = normalizeToken(input.token)
    resolved = resolveToken(token, target)
  } catch (err) {
    if (
      err instanceof TokenUnsupportedError ||
      err instanceof TokenUnsupportedOnChainError
    )
      return errorContent(err.toJson())
    throw err
  }

  let amountRaw: bigint
  try {
    amountRaw = parseUnits(input.amount, resolved.decimals)
  } catch (err) {
    return errorContent({
      code: 'INVALID_INPUT',
      field: 'amount',
      problem: (err as Error).message,
      hint: 'Use a decimal amount with no more precision than the token supports',
    })
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

  // 3. Funds check
  let issue: Awaited<ReturnType<typeof preflight>>
  try {
    issue = await preflight(target, token, input.recipient, amountRaw)
  } catch (err) {
    return errorContent({
      code: 'RPC_ERROR',
      message: (err as Error).message,
      chain: target.name,
    })
  }
  if (issue?.kind === 'invalid_recipient') {
    return errorContent({
      code: 'INVALID_INPUT',
      field: 'recipient',
      problem: issue.problem,
      hint: issue.hint,
    })
  }
  if (issue?.kind === 'insufficient') {
    const funder = await getFunderAddress(target.vm)
    return errorContent({
      code: 'INSUFFICIENT_FUNDS',
      token: issue.token,
      chain: target.name,
      requested: input.amount,
      funder_balance: formatUnits(issue.balance, issue.decimals),
      funder_needs: formatUnits(issue.needed, issue.decimals),
      hint:
        issue.token === token
          ? `The faucet wallet is out of ${token}. Top up ${funder} on ${target.name}.`
          : `The faucet wallet needs more ${issue.token} for fees / account rent. Top up ${funder} on ${target.name}.`,
    })
  }

  // 4. Execute
  const record = (txHash: string) =>
    recordSend({
      ts: Date.now(),
      chainId: target.chainId,
      chainClass,
      token,
      pool,
      amount: amountNum,
      recipient: input.recipient,
      txHash,
    })
  let result: Awaited<ReturnType<typeof sendToken>>
  try {
    result = await sendToken(target, token, input.recipient, amountRaw)
  } catch (err) {
    if (err instanceof TxUnconfirmedError) {
      // Count it against the budget: it may still land.
      record(err.txHash)
      return errorContent({
        code: 'TX_UNCONFIRMED',
        message: err.message,
        txHash: err.txHash,
        blockExplorerUrl: err.blockExplorerUrl,
        chain: target.name,
        token,
        hint: 'Check the explorer link before retrying; resending may double-pay.',
      })
    }
    return errorContent({
      code: 'TX_FAILED',
      message: (err as Error).message,
      chain: target.name,
      token,
    })
  }

  // 5. Record
  record(result.txHash)

  return okContent({
    ok: true,
    txHash: result.txHash,
    blockExplorerUrl: result.blockExplorerUrl,
    chain: target.name,
    chainId: target.chainId,
    caip2: target.caip2,
    vm: target.vm,
    token,
    amount: input.amount,
    recipient: input.recipient,
    decimals: resolved.decimals,
    approval_used: needsApproval,
    ...(result.wrapTxHash ? { wrapTxHash: result.wrapTxHash } : {}),
    ...(result.ataCreated !== undefined
      ? { ataCreated: result.ataCreated }
      : {}),
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
  const funderAddresses = {
    evm: await getFunderAddress('evm'),
    solana: await getFunderAddress('svm'),
  }

  const chainNames = input.chain ? [input.chain] : SUPPORTED_CHAIN_NAMES
  const tokenNames = input.token ? [input.token] : SUPPORTED_TOKENS

  const pairs: { target: Target; token: TokenSymbol; info: ResolvedToken }[] =
    []
  for (const chainName of chainNames) {
    let target: Target
    try {
      target = resolveChain(chainName)
    } catch {
      continue
    }
    for (const tokenInput of tokenNames) {
      try {
        const token = normalizeToken(tokenInput)
        pairs.push({ target, token, info: resolveToken(token, target) })
      } catch {}
    }
  }

  const rows = await Promise.all(
    pairs.map(async ({ target, token, info }) => {
      const pool = getPool(token)
      const limits = getLimits(target.chainClass, pool)
      const usedInWindow = sumWindow(state, target.chainClass, pool)
      const hasFunder =
        (target.vm === 'evm' ? funderAddresses.evm : funderAddresses.solana) !==
        null
      let funderBalance: string | null = null
      if (hasFunder) {
        try {
          funderBalance = await getFunderBalance(target, token)
        } catch {
          funderBalance = null
        }
      }
      return {
        chain: target.name,
        chainId: target.chainId,
        caip2: target.caip2,
        vm: target.vm,
        chainClass: target.chainClass,
        token,
        pool,
        tokenAddress:
          info.kind === 'erc20'
            ? info.address
            : info.kind === 'spl'
              ? info.mint
              : 'native',
        decimals: info.decimals,
        funder_balance: funderBalance,
        soft_per_call: limits.perCall,
        soft_window_24h: limits.window24h,
        hard_per_call: limits.hardPerCall,
        hard_window_24h: limits.hardWindow24h,
        used_in_window_24h: usedInWindow,
        remaining_soft_window: Math.max(0, limits.window24h - usedInWindow),
        remaining_hard_window: Math.max(0, limits.hardWindow24h - usedInWindow),
      }
    }),
  )

  return okContent({
    funder_addresses: funderAddresses,
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
          'Send a small amount of ETH/WETH/USDC/USDT (EVM) or SOL/USDC (Solana) to a recipient from the faucet wallet. ' +
          'Caps apply per chain class (mainnet/testnet) and per pool (USDC+USDT share a stablecoin pool across EVM and Solana, ' +
          'ETH+WETH share a pool, SOL has its own). Amounts above the soft cap require a 6-digit TOTP code from the user. ' +
          'Hard caps (10x the soft caps) cannot be bypassed even with a code. ' +
          'Amounts are decimal strings (human units), not wei. ' +
          'WETH on chains whose native asset is ETH (ethereum/base/arbitrum/optimism + their sepolias) ' +
          "is wrapped just-in-time from the funder's ETH balance when the WETH balance is short; " +
          'in that case the response also includes `wrapTxHash` for the deposit() call. ' +
          "On Solana, `txHash` is the transaction signature; USDC sends create the recipient's associated " +
          'token account when missing (`ataCreated: true`), so pass the wallet address, not a token account.',
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
              description:
                'EVM: ETH, WETH, USDC, USDT. Solana: SOL, USDC (case-insensitive)',
              enum: [
                'ETH',
                'WETH',
                'USDC',
                'USDT',
                'SOL',
                'eth',
                'weth',
                'usdc',
                'usdt',
                'sol',
              ],
            },
            chain: {
              type: 'string',
              description:
                'Chain name (e.g. "base", "sepolia", "solana-devnet")',
              enum: SUPPORTED_CHAIN_NAMES,
            },
            recipient: {
              type: 'string',
              description:
                '0x address on EVM chains, base58 wallet address on Solana',
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
          '`funder_addresses` lists the EVM and Solana funder wallets. ' +
          'Use this to plan before calling send, so you do not trigger unnecessary denials. ' +
          '`funder_balance` is the literal on-chain balance of that token — for WETH on native-ETH chains ' +
          "a `send` can still succeed via JIT wrap as long as the funder's ETH covers the shortfall.",
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
              enum: SUPPORTED_TOKENS,
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
          return invalidInputIssues(parsed.error)
        }
        return await handleSend(parsed.data)
      }
      if (req.params.name === 'status') {
        const parsed = statusInputSchema.safeParse(req.params.arguments ?? {})
        if (!parsed.success) {
          return invalidInputIssues(parsed.error)
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

export { handleSend, handleStatus }

if (import.meta.main) {
  main().catch((err) => {
    console.error('faucet mcp failed to start:', err)
    process.exit(1)
  })
}
