import {
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  http,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet, sepolia } from 'viem/chains'
import type { EvmTarget } from './chains'
import { resolveToken, type TokenSymbol } from './tokens'

// Minimal WETH9 ABI — only the methods we call ourselves. `transfer` already
// comes from the standard erc20Abi via `resolveToken`'s ERC20 branch.
const WETH_DEPOSIT_ABI = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
] as const

function chainHasNativeEth(chain: Chain): boolean {
  return chain.nativeCurrency.symbol === 'ETH'
}

function getFundingAccount() {
  const key = process.env.FUNDING_PRIVATE_KEY as Hex | undefined
  if (!key) {
    throw new Error('FUNDING_PRIVATE_KEY is not set')
  }
  return privateKeyToAccount(key)
}

function getTransport(chain: Chain) {
  const override = process.env[`RPC_URL_${chain.id}`]
  if (override) return http(override)
  if (chain.id === sepolia.id) {
    return http('https://ethereum-sepolia-rpc.publicnode.com')
  }
  if (chain.id === mainnet.id) {
    return http('https://ethereum-rpc.publicnode.com')
  }
  return http()
}

function getClients(chain: Chain) {
  const account = getFundingAccount()
  const publicClient = createPublicClient({
    chain,
    transport: getTransport(chain),
  })
  const walletClient = createWalletClient({
    account,
    chain,
    transport: getTransport(chain),
  })
  return { account, publicClient, walletClient }
}

interface BalanceCheck {
  balance: bigint
  decimals: number
  sufficient: boolean
}

async function getFunderBalance(
  target: EvmTarget,
  token: TokenSymbol,
  amount: bigint,
): Promise<BalanceCheck> {
  const { chain } = target
  const { account, publicClient } = getClients(chain)
  const resolved = resolveToken(token, target)
  if (resolved.kind === 'spl') throw new Error('SPL token on EVM chain')

  if (resolved.kind === 'native') {
    const balance = await publicClient.getBalance({ address: account.address })
    return {
      balance,
      decimals: resolved.decimals,
      sufficient: balance >= amount,
    }
  }

  const balance = await publicClient.readContract({
    address: resolved.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })

  // WETH on a native-ETH chain is JIT-wrapped on send, so a WETH shortfall is
  // covered by the ETH balance. Report the literal WETH balance regardless
  // (consistent with `status`) but factor ETH into sufficiency.
  if (token === 'WETH' && chainHasNativeEth(chain) && balance < amount) {
    const ethBalance = await publicClient.getBalance({
      address: account.address,
    })
    return {
      balance,
      decimals: resolved.decimals,
      sufficient: balance + ethBalance >= amount,
    }
  }

  return { balance, decimals: resolved.decimals, sufficient: balance >= amount }
}

interface SendResult {
  txHash: string
  blockExplorerUrl?: string
  wrapTxHash?: string
  ataCreated?: boolean
}

async function sendToken(
  target: EvmTarget,
  token: TokenSymbol,
  recipient: Address,
  amountRaw: bigint,
): Promise<SendResult> {
  const { chain } = target
  const resolved = resolveToken(token, target)
  if (resolved.kind === 'spl') throw new Error('SPL token on EVM chain')
  const { account, publicClient, walletClient } = getClients(chain)

  let wrapTxHash: Hex | undefined
  if (
    token === 'WETH' &&
    resolved.kind === 'erc20' &&
    chainHasNativeEth(chain)
  ) {
    const wethBalance = await publicClient.readContract({
      address: resolved.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    })
    if (wethBalance < amountRaw) {
      const shortfall = amountRaw - wethBalance
      wrapTxHash = await walletClient.sendTransaction({
        to: resolved.address,
        value: shortfall,
        data: encodeFunctionData({
          abi: WETH_DEPOSIT_ABI,
          functionName: 'deposit',
        }),
      })
      await publicClient.waitForTransactionReceipt({ hash: wrapTxHash })
    }
  }

  let txHash: Hex
  if (resolved.kind === 'native') {
    txHash = await walletClient.sendTransaction({
      to: recipient,
      value: amountRaw,
    })
  } else {
    txHash = await walletClient.sendTransaction({
      to: resolved.address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [recipient, amountRaw],
      }),
    })
  }
  await publicClient.waitForTransactionReceipt({ hash: txHash })
  const explorer = chain.blockExplorers?.default?.url
  return {
    txHash,
    blockExplorerUrl: explorer ? `${explorer}/tx/${txHash}` : undefined,
    wrapTxHash,
  }
}

export type { BalanceCheck, SendResult }
export { getFunderBalance, getFundingAccount, sendToken }
