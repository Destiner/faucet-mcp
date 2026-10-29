import { chainRegistry } from '@rhinestone/shared-configs'
import type { Address as SolanaAddress } from '@solana/kit'
import type { Address } from 'viem'
import type { Target } from './chains'

type TokenSymbol = 'ETH' | 'WETH' | 'USDC' | 'USDT' | 'SOL'
type TokenPool = 'STABLE' | 'ETHWETH' | 'SOL'

const SUPPORTED_TOKENS: TokenSymbol[] = ['ETH', 'WETH', 'USDC', 'USDT', 'SOL']

const TOKENS_BY_VM: Record<Target['vm'], TokenSymbol[]> = {
  evm: ['ETH', 'WETH', 'USDC', 'USDT'],
  svm: ['SOL', 'USDC'],
}

function normalizeToken(input: string): TokenSymbol {
  const upper = input.trim().toUpperCase()
  if (upper === 'ETH') return 'ETH'
  if (upper === 'WETH') return 'WETH'
  if (upper === 'USDC') return 'USDC'
  if (upper === 'USDT' || upper === 'USDT0') return 'USDT'
  if (upper === 'SOL') return 'SOL'
  throw new TokenUnsupportedError(input)
}

function getPool(token: TokenSymbol): TokenPool {
  if (token === 'USDC' || token === 'USDT') return 'STABLE'
  if (token === 'SOL') return 'SOL'
  return 'ETHWETH'
}

type ResolvedToken =
  | { kind: 'native'; decimals: number }
  | { kind: 'erc20'; address: Address; decimals: number }
  | { kind: 'spl'; mint: SolanaAddress; decimals: number }

function resolveToken(token: TokenSymbol, target: Target): ResolvedToken {
  const entry = chainRegistry[target.chainId.toString()]
  if (!entry) {
    throw new Error(`No registry entry for chain ${target.chainId}`)
  }
  const available = TOKENS_BY_VM[target.vm]
  if (!available.includes(token)) {
    throw new TokenUnsupportedOnChainError(token, target, available)
  }

  if (token === 'ETH' || token === 'SOL') {
    return { kind: 'native', decimals: entry.nativeToken.decimals }
  }

  let symbolToFind: string
  if (token === 'WETH' || token === 'USDC') {
    symbolToFind = token
  } else {
    // BSC uses native USDT, all other chains use USDT0 (LayerZero OFT)
    symbolToFind = target.chainId === 56 ? 'USDT' : 'USDT0'
  }

  const found = entry.tokens.find((t) => t.symbol === symbolToFind)
  if (!found) {
    throw new TokenUnsupportedOnChainError(
      token,
      target,
      entry.tokens.map((t) => t.symbol),
    )
  }
  if (target.vm === 'svm') {
    return {
      kind: 'spl',
      mint: found.address as SolanaAddress,
      decimals: found.decimals,
    }
  }
  return {
    kind: 'erc20',
    address: found.address as Address,
    decimals: found.decimals,
  }
}

class TokenUnsupportedError extends Error {
  constructor(public readonly given: string) {
    super(`Unsupported token: ${given}`)
  }
  toJson() {
    return {
      code: 'UNSUPPORTED_TOKEN',
      given: this.given,
      supported: SUPPORTED_TOKENS,
    }
  }
}

class TokenUnsupportedOnChainError extends Error {
  constructor(
    public readonly token: TokenSymbol,
    public readonly target: Target,
    public readonly availableOnChain: string[],
  ) {
    super(`Token ${token} not available on ${target.name}`)
  }
  toJson() {
    return {
      code: 'UNSUPPORTED_TOKEN',
      given: this.token,
      chain: this.target.name,
      chainId: this.target.chainId,
      supported_on_chain: this.availableOnChain,
    }
  }
}

export type { ResolvedToken, TokenPool, TokenSymbol }
export {
  getPool,
  normalizeToken,
  resolveToken,
  SUPPORTED_TOKENS,
  TokenUnsupportedError,
  TokenUnsupportedOnChainError,
}
