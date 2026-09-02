import {
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  type Hex,
  http,
  parseUnits,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet, sepolia } from 'viem/chains'
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
  chain: Chain,
  token: TokenSymbol,
  amount: bigint,
): Promise<BalanceCheck> {
  const { account, publicClient } = getClients(chain)
  const resolved = resolveToken(token, chain.id)

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

async function getRecipientBalance(
  chain: Chain,
  token: TokenSymbol,
  recipient: Address,
): Promise<{ balance: bigint; decimals: number }> {
  const { publicClient } = getClients(chain)
  const resolved = resolveToken(token, chain.id)
  if (resolved.kind === 'native') {
    const balance = await publicClient.getBalance({ address: recipient })
    return { balance, decimals: resolved.decimals }
  }
  const balance = await publicClient.readContract({
    address: resolved.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [recipient],
  })
  return { balance, decimals: resolved.decimals }
}

interface SendResult {
  txHash: Hex
  blockExplorerUrl?: string
  amountRaw: bigint
  decimals: number
  wrapTxHash?: Hex
}

class PostWrapTransferError extends Error {
  constructor(
    public readonly wrapTxHash: Hex,
    cause: unknown,
  ) {
    super(
      `WETH wrap ${wrapTxHash} succeeded, but the transfer failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    this.name = 'PostWrapTransferError'
  }
}

async function retryEstimateGas(
  estimate: () => Promise<bigint>,
  attempts = 10,
  delayMs = 500,
): Promise<bigint> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await estimate()
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
  }
  throw lastError
}

async function sendToken(
  chain: Chain,
  token: TokenSymbol,
  recipient: Address,
  humanAmount: string,
): Promise<SendResult> {
  const resolved = resolveToken(token, chain.id)
  const amountRaw = parseUnits(humanAmount, resolved.decimals)
  const { account, publicClient, walletClient } = getClients(chain)

  let wrapTxHash: Hex | undefined
  let postWrapNonce: number | undefined
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
      const wrapNonce = await publicClient.getTransactionCount({
        address: account.address,
        blockTag: 'pending',
      })
      wrapTxHash = await walletClient.sendTransaction({
        to: resolved.address,
        value: shortfall,
        nonce: wrapNonce,
        data: encodeFunctionData({
          abi: WETH_DEPOSIT_ABI,
          functionName: 'deposit',
        }),
      })
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: wrapTxHash,
      })
      if (receipt.status !== 'success') {
        throw new Error(`WETH wrap ${wrapTxHash} reverted`)
      }
      postWrapNonce = wrapNonce + 1
    }
  }

  let txHash: Hex
  if (resolved.kind === 'native') {
    txHash = await walletClient.sendTransaction({
      to: recipient,
      value: amountRaw,
    })
  } else {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [recipient, amountRaw],
    })
    try {
      // Public RPCs may expose the wrap receipt before every backend serves its state.
      // Estimate until one sees the balance, then avoid a second stale estimation.
      const gas = wrapTxHash
        ? await retryEstimateGas(() =>
            publicClient.estimateGas({
              account,
              to: resolved.address,
              data,
            }),
          )
        : undefined
      txHash = await walletClient.sendTransaction({
        to: resolved.address,
        data,
        ...(gas ? { gas } : {}),
        ...(postWrapNonce === undefined ? {} : { nonce: postWrapNonce }),
      })
    } catch (error) {
      if (wrapTxHash) {
        throw new PostWrapTransferError(wrapTxHash, error)
      }
      throw error
    }
  }
  await publicClient.waitForTransactionReceipt({ hash: txHash })
  const explorer = chain.blockExplorers?.default?.url
  return {
    txHash,
    blockExplorerUrl: explorer ? `${explorer}/tx/${txHash}` : undefined,
    amountRaw,
    decimals: resolved.decimals,
    wrapTxHash,
  }
}

function formatBalance(balance: bigint, decimals: number): string {
  return formatUnits(balance, decimals)
}

export type { BalanceCheck, SendResult }
export {
  formatBalance,
  getFunderBalance,
  getFundingAccount,
  getRecipientBalance,
  PostWrapTransferError,
  retryEstimateGas,
  sendToken,
}
