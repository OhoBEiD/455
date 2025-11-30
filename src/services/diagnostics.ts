import {
  DES_TABLES,
  bitsToHex,
  des_encrypt,
  final_permutation,
  feistel_round,
  hexToBits,
  initial_permutation,
} from '../lib/des'

type Bits = number[]

const normalizeBlockHex = (hex: string) =>
  hex
    .replace(/[^0-9a-f]/gi, '')
    .padEnd(16, '0')
    .slice(0, 16)
    .toLowerCase()

const permuteBits = (bits: Bits, table: number[]): Bits => table.map((index) => bits[index - 1])

const leftShift = (bits: Bits, shift: number): Bits => {
  const normalized = shift % bits.length
  return bits.slice(normalized).concat(bits.slice(0, normalized))
}

const generateSubkeysWithSchedule = (keyHex: string, shiftSchedule?: readonly number[]) => {
  const keyBits = hexToBits(normalizeBlockHex(keyHex), 64)
  const parityDropped = permuteBits(keyBits, DES_TABLES.PC1_TABLE)
  let c = parityDropped.slice(0, 28)
  let d = parityDropped.slice(28)
  const subKeys: string[] = []
  const schedule = shiftSchedule ?? DES_TABLES.SHIFT_SCHEDULE

  schedule.forEach((shift) => {
    c = leftShift(c, shift)
    d = leftShift(d, shift)
    const combined = [...c, ...d]
    const subKeyBits = permuteBits(combined, DES_TABLES.PC2_TABLE)
    subKeys.push(bitsToHex(subKeyBits))
  })

  return subKeys
}

interface VariantOptions {
  skipIP?: boolean
  skipFP?: boolean
  skipFinalSwap?: boolean
  swapAfterRound?: number[]
  roundLimit?: number
  keyOrder?: 'normal' | 'reversed'
  shiftSchedule?: readonly number[]
}

const runVariant = (inputHex: string, keyHex: string, options: VariantOptions): string => {
  const block = hexToBits(normalizeBlockHex(inputHex), 64)
  const ip = options.skipIP ? block : initial_permutation(block)

  const subKeys = generateSubkeysWithSchedule(keyHex, options.shiftSchedule)
  const sequence = options.keyOrder === 'reversed' ? [...subKeys].reverse() : subKeys
  const roundsToRun = Math.min(sequence.length, options.roundLimit ?? 16)

  let left = ip.slice(0, 32)
  let right = ip.slice(32)

  for (let i = 0; i < roundsToRun; i += 1) {
    const subKeyHex = sequence[i]
    const subKeyBits = hexToBits(subKeyHex, 48)
    const { left: nextLeft, right: nextRight } = feistel_round(left, right, subKeyBits)
    const swapHere = options.swapAfterRound?.includes(i + 1)
    left = swapHere ? nextRight : nextLeft
    right = swapHere ? nextLeft : nextRight
  }

  const preOutput = options.skipFinalSwap ? [...left, ...right] : [...right, ...left]
  const fp = options.skipFP ? preOutput : final_permutation(preOutput)
  return bitsToHex(fp)
}

export interface DiagnosisResult {
  matchedPattern: string | null
  message: string
  variantMatched?: string
  expectedOutput: string
  studentOutput: string
  score: number
  tags: string[]
}

interface DiagnoseInput {
  plaintextHex: string
  keyHex: string
  studentOutputHex: string
}

const patterns: { code: string; label: string; options: VariantOptions; description: string; credit: number }[] = [
  {
    code: 'skip-ip-fp',
    label: 'Skipped IP/FP',
    options: { skipIP: true, skipFP: true },
    description: 'Student output matches a run with no initial/final permutation.',
    credit: 0.6,
  },
  {
    code: 'skip-ip',
    label: 'Skipped IP',
    options: { skipIP: true },
    description: 'Initial Permutation (IP) was skipped but FP was still applied.',
    credit: 0.5,
  },
  {
    code: 'no-final-swap',
    label: 'Forgot final swap',
    options: { skipFinalSwap: true },
    description: 'Halves were not swapped before the final permutation.',
    credit: 0.6,
  },
  {
    code: 'swap-after-round-1',
    label: 'Swapped halves after R1',
    options: { swapAfterRound: [1] },
    description: 'Left/right halves inverted after round 1.',
    credit: 0.5,
  },
  {
    code: 'reversed-subkeys',
    label: 'K16→K1 order',
    options: { keyOrder: 'reversed' },
    description: 'Round keys applied in reverse order.',
    credit: 0.4,
  },
  {
    code: 'two-rounds-only',
    label: 'Stopped after 2 rounds',
    options: { roundLimit: 2 },
    description: 'Execution ended after round 2.',
    credit: 0.2,
  },
  {
    code: 'four-rounds-only',
    label: 'Stopped after 4 rounds',
    options: { roundLimit: 4 },
    description: 'Execution ended after round 4.',
    credit: 0.3,
  },
  {
    code: 'all-one-bit-shifts',
    label: 'Wrong shift schedule',
    options: { shiftSchedule: Array(16).fill(1) },
    description: 'Used 1-bit shifts for all key-schedule rounds.',
    credit: 0.3,
  },
]

export const diagnoseDESSubmission = (input: DiagnoseInput): DiagnosisResult => {
  const plaintextHex = normalizeBlockHex(input.plaintextHex)
  const keyHex = normalizeBlockHex(input.keyHex)
  const studentOutput = normalizeBlockHex(input.studentOutputHex)

  const expected = des_encrypt(plaintextHex, keyHex)
  const expectedOutput = expected.outputHex

  if (studentOutput === expectedOutput) {
    return {
      matchedPattern: 'correct',
      message: 'Answer matches expected ciphertext.',
      expectedOutput,
      studentOutput,
      score: 1,
      tags: ['correct'],
    }
  }

  for (const pattern of patterns) {
    const variantOutput = runVariant(plaintextHex, keyHex, pattern.options)
    if (variantOutput === studentOutput) {
      const credit = Math.min(1, Math.max(0, pattern.credit))
      return {
        matchedPattern: pattern.code,
        variantMatched: pattern.label,
        message: pattern.description,
        expectedOutput,
        studentOutput,
        score: credit, // award partial credit for a recognized pattern
        tags: ['incorrect', pattern.code],
      }
    }
  }

  return {
    matchedPattern: null,
    message: 'No known mistake pattern matched. Likely multiple or different errors.',
    expectedOutput,
    studentOutput,
    score: 0,
    tags: ['incorrect', 'unclassified'],
  }
}
