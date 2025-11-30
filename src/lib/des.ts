/* eslint-disable @typescript-eslint/no-magic-numbers */
import { nanoid } from 'nanoid'

type Bits = number[]

export type BlockContext = 'ip' | 'fp' | 'round' | 'f'

export interface RoundInfo {
  round: number
  left: string
  right: string
  subKey: string
  expanded: string
  xorWithKey: string
  sBoxOutput: string
  pBoxOutput: string
  roundOutput: string
}

export interface KeyScheduleRound {
  round: number
  shifts: number
  c: string
  d: string
  subKey: string
}

export interface KeyScheduleInfo {
  parityDroppedKey: string
  rounds: KeyScheduleRound[]
}

export interface DESResult {
  id: string
  mode: 'encrypt' | 'decrypt'
  inputHex: string
  outputHex: string
  ipOutput: string
  fpOutput: string
  rounds: RoundInfo[]
  subKeys: string[]
  keySchedule: KeyScheduleInfo
}

export interface AvalancheRoundDiff {
  round: number
  differingBits: number
  percentage: number
}

const IP_TABLE = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38,
  30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59,
  51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31,
  23, 15, 7,
]

const FP_TABLE = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14,
  54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28,
  35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49,
  17, 57, 25,
]

const E_TABLE = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16,
  17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28,
  29, 30, 31, 32, 1,
]

const P_TABLE = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32,
  27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
]

const PC1_TABLE = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35,
  27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38,
  30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
]

const PC2_TABLE = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20,
  13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53,
  46, 42, 50, 36, 29, 32,
]

const SHIFT_SCHEDULE = [
  1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1,
] as const

const S_BOXES = [
  [
    [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7],
    [0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8],
    [4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0],
    [15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  ],
  [
    [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10],
    [3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5],
    [0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15],
    [13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  ],
  [
    [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8],
    [13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1],
    [13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7],
    [1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  ],
  [
    [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15],
    [13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9],
    [10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4],
    [3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  ],
  [
    [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9],
    [14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6],
    [4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14],
    [11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  ],
  [
    [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11],
    [10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8],
    [9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6],
    [4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  ],
  [
    [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1],
    [13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6],
    [1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2],
    [6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  ],
  [
    [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7],
    [1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2],
    [7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8],
    [2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
  ],
] as const

export const S_BOX_LABELS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']
export const S_BOXES_DATA = S_BOXES
export const DES_TABLES = {
  IP_TABLE,
  FP_TABLE,
  E_TABLE,
  P_TABLE,
  PC1_TABLE,
  PC2_TABLE,
  SHIFT_SCHEDULE,
}

const hexLookup = '0123456789abcdef'

const permute = (bits: Bits, table: number[]): Bits =>
  table.map((index) => bits[index - 1])

const leftShift = (bits: Bits, shift: number): Bits => {
  const normalized = shift % bits.length
  return bits.slice(normalized).concat(bits.slice(0, normalized))
}

const xorBits = (a: Bits, b: Bits): Bits => a.map((bit, idx) => (bit ^ b[idx]) & 1)

const chunkBits = (bits: Bits, size: number): Bits[] => {
  const chunks: Bits[] = []
  for (let i = 0; i < bits.length; i += size) {
    chunks.push(bits.slice(i, i + size))
  }
  return chunks
}

const toHexDigit = (bits: Bits): string => {
  const value = bits.reduce((acc, bit) => (acc << 1) | bit, 0)
  return hexLookup[value]
}

export const bitsToHex = (bits: Bits): string =>
  chunkBits(bits, 4)
    .map(toHexDigit)
    .join('')

export const hexToBits = (hex: string, size = hex.length * 4): Bits => {
  const padded = hex.toLowerCase().padStart(size / 4, '0')
  const bits: Bits = []
  for (const char of padded) {
    const value = parseInt(char, 16)
    bits.push((value >> 3) & 1, (value >> 2) & 1, (value >> 1) & 1, value & 1)
  }
  return bits.slice(bits.length - size)
}

export const asciiToHex = (value: string): string =>
  value
    .padEnd(8, ' ')
    .slice(0, 8)
    .split('')
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')

export const hexToAscii = (hex: string): string => {
  const chars: string[] = []
  for (let i = 0; i < hex.length; i += 2) {
    const value = parseInt(hex.slice(i, i + 2), 16)
    chars.push(String.fromCharCode(value))
  }
  return chars.join('').trimEnd()
}

export const initial_permutation = (block: Bits): Bits => permute(block, IP_TABLE)

export const final_permutation = (block: Bits): Bits => permute(block, FP_TABLE)

export const expansion_permutation = (bits: Bits): Bits => permute(bits, E_TABLE)

export const p_box_permutation = (bits: Bits): Bits => permute(bits, P_TABLE)

export const s_box_substitution = (bits: Bits): Bits => {
  const chunks = chunkBits(bits, 6)
  const output: Bits = []
  chunks.forEach((chunk, index) => {
    const row = (chunk[0] << 1) | chunk[5]
    const column = (chunk[1] << 3) | (chunk[2] << 2) | (chunk[3] << 1) | chunk[4]
    const sValue = S_BOXES[index][row][column]
    output.push((sValue >> 3) & 1, (sValue >> 2) & 1, (sValue >> 1) & 1, sValue & 1)
  })
  return output
}

export const f_function = (right: Bits, subKey: Bits) => {
  const expanded = expansion_permutation(right)
  const xorResult = xorBits(expanded, subKey)
  const sBoxResult = s_box_substitution(xorResult)
  const pBoxResult = p_box_permutation(sBoxResult)
  return {
    expanded,
    xorResult,
    sBoxResult,
    pBoxResult,
  }
}

export const feistel_round = (left: Bits, right: Bits, subKey: Bits) => {
  const { expanded, xorResult, sBoxResult, pBoxResult } = f_function(right, subKey)
  const newRight = xorBits(left, pBoxResult)
  return {
    left: right,
    right: newRight,
    expanded,
    xorResult,
    sBoxResult,
    pBoxResult,
  }
}

export const generate_subkeys = (keyHex: string): KeyScheduleInfo & { subKeys: string[] } => {
  const keyBits = hexToBits(keyHex.padEnd(16, '0').slice(0, 16), 64)
  const parityDropped = permute(keyBits, PC1_TABLE)
  let c = parityDropped.slice(0, 28)
  let d = parityDropped.slice(28)
  const rounds: KeyScheduleRound[] = []
  const subKeys: string[] = []

  SHIFT_SCHEDULE.forEach((shift, index) => {
    c = leftShift(c, shift)
    d = leftShift(d, shift)
    const combined = [...c, ...d]
    const subKeyBits = permute(combined, PC2_TABLE)
    const subKeyHex = bitsToHex(subKeyBits)
    rounds.push({
      round: index + 1,
      shifts: shift,
      c: bitsToHex(c),
      d: bitsToHex(d),
      subKey: subKeyHex,
    })
    subKeys.push(subKeyHex)
  })

  return {
    parityDroppedKey: bitsToHex(parityDropped),
    rounds,
    subKeys,
  }
}

const runCore = (inputHex: string, keyHex: string, mode: 'encrypt' | 'decrypt'): DESResult => {
  const block = hexToBits(inputHex, 64)
  const ip = initial_permutation(block)
  const { subKeys, ...keySchedule } = generate_subkeys(keyHex)
  let left = ip.slice(0, 32)
  let right = ip.slice(32)
  const sequence = mode === 'encrypt' ? subKeys : [...subKeys].reverse()
  const roundData: RoundInfo[] = []

  sequence.forEach((subKeyHex, index) => {
    const subKeyBits = hexToBits(subKeyHex, 48)
    const { left: nextLeft, right: nextRight, expanded, xorResult, sBoxResult, pBoxResult } =
      feistel_round(left, right, subKeyBits)
    roundData.push({
      round: index + 1,
      left: bitsToHex(left),
      right: bitsToHex(right),
      subKey: subKeyHex,
      expanded: bitsToHex(expanded),
      xorWithKey: bitsToHex(xorResult),
      sBoxOutput: bitsToHex(sBoxResult),
      pBoxOutput: bitsToHex(pBoxResult),
      roundOutput: bitsToHex([...nextLeft, ...nextRight]),
    })
    left = nextLeft
    right = nextRight
  })

  const preOutput = [...right, ...left]
  const fp = final_permutation(preOutput)
  return {
    id: nanoid(),
    mode,
    inputHex: inputHex.toLowerCase(),
    outputHex: bitsToHex(fp),
    ipOutput: bitsToHex(ip),
    fpOutput: bitsToHex(fp),
    rounds: roundData,
    subKeys: sequence,
    keySchedule,
  }
}

export const des_encrypt = (plaintextHex: string, keyHex: string): DESResult =>
  runCore(plaintextHex, keyHex, 'encrypt')

export const des_decrypt = (ciphertextHex: string, keyHex: string): DESResult =>
  runCore(ciphertextHex, keyHex, 'decrypt')

export const randomHex64 = () =>
  Array.from({ length: 16 }, () => hexLookup[Math.floor(Math.random() * 16)]).join('')

export const evaluateKeyStrength = (keyHex: string): { label: string; score: number } => {
  const uniqueChars = new Set(keyHex).size
  const repeatingPairs = /(..).*\1/i.test(keyHex) ? 1 : 0
  const score = Math.max(0, uniqueChars - repeatingPairs - (keyHex.match(/(0|f)/gi)?.length ?? 0))
  if (score >= 10) return { label: 'Strong', score }
  if (score >= 6) return { label: 'Moderate', score }
  return { label: 'Weak', score }
}

export const generateExecutionNarrative = (result: DESResult): string[] => {
  const messages = [
    'Applied Initial Permutation to diffuse the plaintext bits.',
    'Entering 16 Feistel rounds where subkeys expand confusion.',
  ]
  result.rounds.forEach((round) => {
    messages.push(
      `Round ${round.round}: Expanded Ri, XORed with K${round.round}, passed through S-boxes, and permuted.`,
    )
  })
  messages.push('Swapped halves, applied Final Permutation, and produced the 64-bit output block.')
  return messages
}

export const compareRoundsForAvalanche = (
  base: RoundInfo[],
  mutated: RoundInfo[],
): AvalancheRoundDiff[] => {
  const diffs: AvalancheRoundDiff[] = []
  for (let i = 0; i < 16; i += 1) {
    const baseRound = base[i]
    const mutatedRound = mutated[i]
    if (!baseRound || !mutatedRound) continue
    const baseBits = hexToBits(baseRound.roundOutput, 64)
    const mutatedBits = hexToBits(mutatedRound.roundOutput, 64)
    let diff = 0
    baseBits.forEach((bit, idx) => {
      if (bit !== mutatedBits[idx]) diff += 1
    })
    diffs.push({
      round: i + 1,
      differingBits: diff,
      percentage: Number(((diff / 64) * 100).toFixed(2)),
    })
  }
  return diffs
}

export const DES_PRESETS = {
  basic: {
    label: 'Basic Example',
    plaintext: '02468aceeca86420',
    key: '0f1571c947d9e859',
    description: 'Classic DES example provided in many lecture slides.',
  },
  weak: {
    label: 'Test Weak Keys',
    plaintext: 'ffffffffffffffff',
    key: '0101010101010101',
    description: 'Demonstrates weak key behavior with repeating patterns.',
  },
  avalanche: {
    label: 'Avalanche Test',
    plaintext: '0123456789abcdef',
    key: '133457799bbcdff1',
    description: 'Designed to showcase the avalanche effect when flipping bits.',
  },
} as const
