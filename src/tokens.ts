import { chainRegistry } from '@rhinestone/shared-configs'
import type { Address } from 'viem'

type TokenSymbol = 'ETH' | 'WETH' | 'USDC' | 'USDT'
type TokenPool = 'STABLE' | 'ETHWETH'

const SUPPORTED_TOKENS: TokenSymbol[] = ['ETH', 'WETH', 'USDC', 'USDT']

function normalizeToken(input: string): TokenSymbol {
  const upper = input.trim().toUpperCase()
  if (upper === 'ETH') return 'ETH'
  if (upper === 'WETH') return 'WETH'
  if (upper === 'USDC') return 'USDC'
  if (upper === 'USDT' || upper === 'USDT0') return 'USDT'
  throw new TokenUnsupportedError(input)
}

function getPool(token: TokenSymbol): TokenPool {
  if (token === 'USDC' || token === 'USDT') return 'STABLE'
  return 'ETHWETH'
}

type ResolvedToken =
  | { kind: 'native'; decimals: number }
  | { kind: 'erc20'; address: Address; decimals: number }

function resolveToken(token: TokenSymbol, chainId: number): ResolvedToken {
  const entry = chainRegistry[chainId.toString()]
  if (!entry) {
    throw new Error(`No registry entry for chain ${chainId}`)
  }

  if (token === 'ETH') {
    return { kind: 'native', decimals: entry.nativeToken.decimals }
  }

  let symbolToFind: string
  if (token === 'WETH') {
    symbolToFind = 'WETH'
  } else if (token === 'USDC') {
    symbolToFind = 'USDC'
  } else {
    // BSC uses native USDT, all other chains use USDT0 (LayerZero OFT)
    symbolToFind = chainId === 56 ? 'USDT' : 'USDT0'
  }

  const found = entry.tokens.find((t) => t.symbol === symbolToFind)
  if (!found) {
    throw new TokenUnsupportedOnChainError(
      token,
      chainId,
      entry.tokens.map((t) => t.symbol),
    )
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
    public readonly chainId: number,
    public readonly availableOnChain: string[],
  ) {
    super(`Token ${token} not available on chain ${chainId}`)
  }
  toJson() {
    return {
      code: 'UNSUPPORTED_TOKEN',
      given: this.token,
      chainId: this.chainId,
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
