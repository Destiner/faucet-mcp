import { chainRegistry, chains } from '@rhinestone/shared-configs'
import type { Chain } from 'viem'

const CHAIN_BY_ID: Record<number, Chain> = Object.fromEntries(
  (chains as readonly Chain[]).map((c) => [c.id, c]),
)

const SOLANA_MAINNET_ID = 792703809
const SOLANA_DEVNET_ID = 792703810

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
  'solana-mainnet': SOLANA_MAINNET_ID,
  solana: SOLANA_MAINNET_ID,
  sol: SOLANA_MAINNET_ID,
  sepolia: 11155111,
  'ethereum-sepolia': 11155111,
  'base-sepolia': 84532,
  'arbitrum-sepolia': 421614,
  'arb-sepolia': 421614,
  'optimism-sepolia': 11155420,
  'op-sepolia': 11155420,
  'plasma-testnet': 9746,
  'solana-devnet': SOLANA_DEVNET_ID,
  'sol-devnet': SOLANA_DEVNET_ID,
  devnet: SOLANA_DEVNET_ID,
}

const SUPPORTED_CHAIN_NAMES = [
  'ethereum',
  'base',
  'arbitrum',
  'optimism',
  'polygon',
  'plasma',
  'solana-mainnet',
  'sepolia',
  'base-sepolia',
  'arbitrum-sepolia',
  'optimism-sepolia',
  'plasma-testnet',
  'solana-devnet',
]

const CANONICAL_NAME: Record<number, string> = Object.fromEntries(
  SUPPORTED_CHAIN_NAMES.map((n) => [NAME_TO_ID[n], n]),
)

type ChainClass = 'mainnet' | 'testnet'
type SolanaCluster = 'mainnet' | 'devnet'

interface TargetBase {
  name: string
  chainId: number
  caip2: string
  chainClass: ChainClass
}

interface EvmTarget extends TargetBase {
  vm: 'evm'
  chain: Chain
}

interface SvmTarget extends TargetBase {
  vm: 'svm'
  cluster: SolanaCluster
}

type Target = EvmTarget | SvmTarget

function resolveChain(input: string): Target {
  const id = NAME_TO_ID[input.trim().toLowerCase()]
  if (!id) {
    throw new ChainUnsupportedError(input)
  }
  const entry = chainRegistry[id.toString()]
  if (!entry) {
    throw new Error(`Chain ${input} (id ${id}) not present in shared-configs`)
  }
  const base: TargetBase = {
    name: CANONICAL_NAME[id] ?? input,
    chainId: id,
    caip2: entry.caip2,
    chainClass: entry.network,
  }
  if (entry.vmType === 'svm') {
    return {
      ...base,
      vm: 'svm',
      cluster: id === SOLANA_DEVNET_ID ? 'devnet' : 'mainnet',
    }
  }
  const chain = CHAIN_BY_ID[id]
  if (!chain) {
    throw new Error(`Chain ${input} (id ${id}) has no viem chain definition`)
  }
  return { ...base, vm: 'evm', chain }
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

export type { ChainClass, EvmTarget, SolanaCluster, SvmTarget, Target }
export { ChainUnsupportedError, resolveChain, SUPPORTED_CHAIN_NAMES }
