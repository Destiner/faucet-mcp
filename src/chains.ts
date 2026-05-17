import { chains } from '@rhinestone/shared-configs'
import type { Chain } from 'viem'

const CHAIN_BY_ID: Record<number, Chain> = Object.fromEntries(
  (chains as readonly Chain[]).map((c) => [c.id, c]),
)

const NAME_TO_ID: Record<string, number> = {
  ethereum: 1,
  mainnet: 1,
  eth: 1,
  base: 8453,
  arbitrum: 42161,
  arb: 42161,
  optimism: 10,
  op: 10,
  polygon: 137,
  matic: 137,
  plasma: 9745,
  sepolia: 11155111,
  'ethereum-sepolia': 11155111,
  'base-sepolia': 84532,
  'arbitrum-sepolia': 421614,
  'arb-sepolia': 421614,
  'optimism-sepolia': 11155420,
  'op-sepolia': 11155420,
  'plasma-testnet': 9746,
}

const SUPPORTED_CHAIN_NAMES = [
  'ethereum',
  'base',
  'arbitrum',
  'optimism',
  'polygon',
  'plasma',
  'sepolia',
  'base-sepolia',
  'arbitrum-sepolia',
  'optimism-sepolia',
  'plasma-testnet',
]

type ChainClass = 'mainnet' | 'testnet'

function resolveChain(input: string): Chain {
  const lowered = input.trim().toLowerCase()
  const id = NAME_TO_ID[lowered]
  if (!id) {
    throw new ChainUnsupportedError(input)
  }
  const chain = CHAIN_BY_ID[id]
  if (!chain) {
    throw new Error(`Chain ${input} (id ${id}) not present in shared-configs`)
  }
  return chain
}

function getChainClass(chain: Chain): ChainClass {
  return chain.testnet ? 'testnet' : 'mainnet'
}

class ChainUnsupportedError extends Error {
  constructor(public readonly given: string) {
    super(`Unsupported chain: ${given}`)
  }
  toJson() {
    return {
      code: 'UNSUPPORTED_CHAIN',
      given: this.given,
      supported: SUPPORTED_CHAIN_NAMES,
    }
  }
}

export type { ChainClass }
export {
  ChainUnsupportedError,
  getChainClass,
  resolveChain,
  SUPPORTED_CHAIN_NAMES,
}
