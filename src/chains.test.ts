import { describe, expect, test } from 'bun:test'
import { resolveChain, SUPPORTED_CHAIN_NAMES } from './chains'
import { resolveToken, TokenUnsupportedOnChainError } from './tokens'
import { isValidRecipient } from './wallet'

describe('resolveChain', () => {
  test('every supported name resolves', () => {
    for (const name of SUPPORTED_CHAIN_NAMES) {
      expect(resolveChain(name).name).toBe(name)
    }
  })

  test('solana aliases map to canonical names', () => {
    for (const alias of ['solana', 'sol', 'Solana-Mainnet']) {
      const t = resolveChain(alias)
      expect(t).toMatchObject({
        vm: 'svm',
        name: 'solana-mainnet',
        chainClass: 'mainnet',
      })
    }
    for (const alias of ['devnet', 'sol-devnet']) {
      const t = resolveChain(alias)
      expect(t).toMatchObject({
        vm: 'svm',
        name: 'solana-devnet',
        chainClass: 'testnet',
        cluster: 'devnet',
      })
    }
  })
})

describe('resolveToken on solana', () => {
  const devnet = resolveChain('solana-devnet')

  test('USDC resolves to the devnet SPL mint', () => {
    expect(resolveToken('USDC', devnet)).toEqual({
      kind: 'spl',
      mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as never,
      decimals: 6,
    })
  })

  test('SOL is native with 9 decimals', () => {
    expect(resolveToken('SOL', devnet)).toEqual({ kind: 'native', decimals: 9 })
  })

  test('EVM-only tokens are rejected', () => {
    for (const t of ['ETH', 'WETH', 'USDT'] as const) {
      expect(() => resolveToken(t, devnet)).toThrow(
        TokenUnsupportedOnChainError,
      )
    }
  })

  test('SOL is rejected on EVM', () => {
    expect(() => resolveToken('SOL', resolveChain('base'))).toThrow(
      TokenUnsupportedOnChainError,
    )
  })
})

describe('isValidRecipient', () => {
  const evmAddr = '0xCb1f054bCfc93c6eFAC556020D3822E425D37404'
  const solAddr = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'

  test('checks format per vm', () => {
    expect(isValidRecipient(resolveChain('base'), evmAddr)).toBe(true)
    expect(isValidRecipient(resolveChain('base'), solAddr)).toBe(false)
    expect(isValidRecipient(resolveChain('devnet'), solAddr)).toBe(true)
    expect(isValidRecipient(resolveChain('devnet'), evmAddr)).toBe(false)
  })
})
