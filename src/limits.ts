import type { ChainClass } from './chains'
import type { TokenPool } from './tokens'

interface LimitConfig {
  perCall: number
  window24h: number
  hardPerCall: number
  hardWindow24h: number
}

// All amounts are in human/decimal units (e.g. 0.10 USDC, 0.00002 ETH).
// Hard caps are 10x the soft caps and cannot be bypassed even with a valid OTP.
const LIMITS: Record<ChainClass, Record<TokenPool, LimitConfig>> = {
  mainnet: {
    STABLE: {
      perCall: 0.1,
      window24h: 1,
      hardPerCall: 1,
      hardWindow24h: 10,
    },
    ETHWETH: {
      perCall: 0.00002,
      window24h: 0.0005,
      hardPerCall: 0.0002,
      hardWindow24h: 0.005,
    },
  },
  testnet: {
    STABLE: {
      perCall: 2,
      window24h: 20,
      hardPerCall: 20,
      hardWindow24h: 200,
    },
    ETHWETH: {
      perCall: 0.001,
      window24h: 0.01,
      hardPerCall: 0.01,
      hardWindow24h: 0.1,
    },
  },
}

function getLimits(chainClass: ChainClass, pool: TokenPool): LimitConfig {
  return LIMITS[chainClass][pool]
}

export type { LimitConfig }
export { getLimits, LIMITS }
