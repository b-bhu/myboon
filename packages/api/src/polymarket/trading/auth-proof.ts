import { utils } from 'ethers'

const AUTH_PROOF_MAX_AGE_MS = 5 * 60 * 1000

function predictProofMessage(address: string, timestamp: number): string {
  return [
    'myboon:predict:builder-auth',
    `address:${address.toLowerCase()}`,
    `timestamp:${timestamp}`,
  ].join('\n')
}

export function verifyPredictAuthProof(
  ownerAddress: string,
  timestamp: number | undefined,
  signature: string | undefined,
): boolean {
  if (!timestamp || !Number.isFinite(timestamp) || !signature) return false
  if (Math.abs(Date.now() - timestamp) > AUTH_PROOF_MAX_AGE_MS) return false
  try {
    const recovered = utils.verifyMessage(predictProofMessage(ownerAddress, timestamp), signature)
    return recovered.toLowerCase() === ownerAddress.toLowerCase()
  } catch {
    return false
  }
}
