import { describe, expect, it } from 'vitest'
import {
  DES_PRESETS,
  bitsToHex,
  compareRoundsForAvalanche,
  des_decrypt,
  des_encrypt,
  hexToBits,
} from './des'

describe('DES core algorithm', () => {
  it('matches the classic NIST example', () => {
    const plaintext = '0123456789abcdef'
    const key = '133457799bbcdff1'

    const result = des_encrypt(plaintext, key)

    expect(result.outputHex).toBe('85e813540f0ab405')
  })

  it('reproduces the classroom sample vector', () => {
    const { plaintext, key } = DES_PRESETS.basic
    const result = des_encrypt(plaintext, key)

    expect(result.outputHex).toBe('da02ce3a89ecac3b')
    expect(des_decrypt(result.outputHex, key).outputHex).toBe(plaintext)
  })

  it('round-trips weak keys without corrupting data', () => {
    const weakKey = DES_PRESETS.weak.key
    const plaintext = DES_PRESETS.weak.plaintext

    const encrypted = des_encrypt(plaintext, weakKey)
    const decrypted = des_decrypt(encrypted.outputHex, weakKey)

    expect(decrypted.outputHex).toBe(plaintext)
  })

  it('generates sixteen unique subkeys after dropping parity bits', () => {
    const { keySchedule, subKeys } = des_encrypt(DES_PRESETS.basic.plaintext, DES_PRESETS.basic.key)

    expect(keySchedule.rounds).toHaveLength(16)
    expect(subKeys).toHaveLength(16)
    const parityDroppedBits = hexToBits(keySchedule.parityDroppedKey, 56)
    expect(bitsToHex(parityDroppedBits)).toHaveLength(14)
  })

  it('exhibits the avalanche effect when a single plaintext bit flips', () => {
    const plaintext = '0123456789abcdef'
    const key = '133457799bbcdff1'

    const base = des_encrypt(plaintext, key)
    const flipped = des_encrypt('0123456789abcdee', key)
    const diffs = compareRoundsForAvalanche(base.rounds, flipped.rounds)

    expect(diffs.length).toBeGreaterThan(0)
    expect(diffs.at(-1)?.differingBits ?? 0).toBeGreaterThan(0)
  })
})
