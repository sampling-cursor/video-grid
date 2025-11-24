import { Buffer } from 'buffer/'
import * as bip39 from 'bip39'
import * as nacl from 'tweetnacl'
import { hmac } from '@noble/hashes/hmac.js'
import { sha512 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'

if (typeof globalThis.Buffer === 'undefined') {
  ;(globalThis as any).Buffer = Buffer
}

const DOMAIN_LABEL = new TextEncoder().encode('necessitated/premises')
const ACCOUNT_INDEX = 0
const ADDRESS_INDEX = 0

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary)
}

const deriveHDSeed = (
  seed: Uint8Array,
  account: number,
  address: number,
): Uint8Array => {
  const indexBytes = new Uint8Array([account, address])
  const input = new Uint8Array([...seed, ...indexBytes])
  const digest = hmac(sha512, DOMAIN_LABEL, input)
  return digest.slice(0, 32)
}

const generateHDKeypair = (
  mnemonic: string,
  account: number,
  address: number,
): { path: string; publicKey: string } => {
  const masterSeed = bip39.mnemonicToSeedSync(mnemonic)
  const derivedSeed = deriveHDSeed(new Uint8Array(masterSeed), account, address)
  const keypair = nacl.sign.keyPair.fromSeed(derivedSeed)

  return {
    path: `m/${account}/${address}`,
    publicKey: bytesToBase64(keypair.publicKey),
  }
}

const generateMnemonic = (passphrase: string): string => {
  const hash = sha512(utf8ToBytes(passphrase))
  const entropy = hash.slice(0, 32)
  return bip39.entropyToMnemonic(bytesToHex(entropy))
}

export const deriveNamespacePublicKey = (
  namespace: string,
): { path: string; publicKey: string } => {
  const mnemonic = generateMnemonic(namespace)
  return generateHDKeypair(mnemonic, ACCOUNT_INDEX, ADDRESS_INDEX)
}
