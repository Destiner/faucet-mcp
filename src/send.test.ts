import { describe, expect, test } from 'bun:test'
import { retryEstimateGas } from './send'

describe('retryEstimateGas', () => {
  test('retries stale RPC estimation until it succeeds', async () => {
    let calls = 0
    const gas = await retryEstimateGas(
      async () => {
        calls += 1
        if (calls < 3) throw new Error('execution reverted')
        return 52_000n
      },
      3,
      0,
    )

    expect(gas).toBe(52_000n)
    expect(calls).toBe(3)
  })

  test('throws the final estimation error after exhausting retries', async () => {
    let calls = 0
    const estimate = async () => {
      calls += 1
      throw new Error(`failure ${calls}`)
    }

    await expect(retryEstimateGas(estimate, 3, 0)).rejects.toThrow('failure 3')
    expect(calls).toBe(3)
  })
})
