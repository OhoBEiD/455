import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactFlow, { Background, type Edge, type Node } from 'reactflow'
import 'reactflow/dist/style.css'
import {
  Copy,
  Play,
  RefreshCw,
  Shield,
  Shuffle,
  Zap,
  Download,
  LogIn,
  UserPlus,
  Sparkles,
  Sun,
  Moon,
  LogOut,
} from 'lucide-react'
import {
  bitsToHex,
  compareRoundsForAvalanche,
  des_decrypt,
  des_encrypt,
  DES_PRESETS,
  DES_TABLES,
  evaluateKeyStrength,
  generate_subkeys,
  hexToBits,
  randomHex64,
  type AvalancheRoundDiff,
  type DESResult,
  S_BOXES_DATA,
  S_BOX_LABELS,
} from './lib/des'
import { diagnoseDESSubmission, type DiagnosisResult } from './services/diagnostics'
import { api, hasApi, setAuthToken } from './services/backend'
import { Button } from './components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from './components/ui/card'
import { Input } from './components/ui/input'
import { Badge } from './components/ui/badge'
import { Progress } from './components/ui/progress'
import { cn } from './lib/utils'

type InputFormat = 'binary' | 'hex'
type KeyFormat = 'binary' | 'hex' | 'text'
type InputKind = 'binary' | 'hex' | 'text' | 'file'
type DesMode = 'ECB' | 'CBC' | 'CFB' | 'OFB' | 'CTR'

// Convert binary string to hex (pads to 64 bits for DES block width)
const binaryStringToHex = (binary: string): string => {
  if (!binary.length) return ''
  const paddedLength = Math.ceil(binary.length / 4) * 4
  const paddedBinary = binary.padEnd(paddedLength, '0')
  let hex = ''
  for (let i = 0; i < paddedBinary.length; i += 4) {
    const nibble = paddedBinary.slice(i, i + 4)
    hex += parseInt(nibble, 2).toString(16)
  }
  return hex
}

// Convert hex to binary string (4 bits per hex digit)
const hexToBinaryString = (hex: string): string => {
  return hex
    .split('')
    .map((char) => parseInt(char, 16).toString(2).padStart(4, '0'))
    .join('')
}

// Byte helpers for text/file support
const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

const hexToBytes = (hex: string): Uint8Array => {
  const sanitized = hex.trim()
  if (sanitized.length % 2 !== 0) throw new Error('Hex input must have an even length.')
  const bytes = new Uint8Array(sanitized.length / 2)
  for (let i = 0; i < sanitized.length; i += 2) {
    const byte = parseInt(sanitized.slice(i, i + 2), 16)
    if (Number.isNaN(byte)) throw new Error('Invalid hex input.')
    bytes[i / 2] = byte
  }
  return new Uint8Array(bytes)
}

const textToUtf8Bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const utf8BytesToText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

// PKCS#5/7 style padding to 8-byte DES blocks
const padTo8Bytes = (bytes: Uint8Array): Uint8Array => {
  const pad = 8 - (bytes.length % 8)
  const padValue = pad === 0 ? 8 : pad
  const padded = new Uint8Array(bytes.length + padValue)
  padded.set(bytes)
  padded.fill(padValue, bytes.length)
  return padded
}

const unpadPkcs = (bytes: Uint8Array): Uint8Array => {
  if (!bytes.length) return bytes
  const pad = bytes[bytes.length - 1]
  if (pad < 1 || pad > 8 || pad > bytes.length) return bytes
  for (let i = 0; i < pad; i += 1) {
    if (bytes[bytes.length - 1 - i] !== pad) return bytes
  }
  return bytes.slice(0, bytes.length - pad)
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  bytes.forEach((b) => {
    binary += String.fromCharCode(b)
  })
  return btoa(binary)
}

const base64ToBytes = (value: string): Uint8Array => {
  try {
    const binary = atob(value.trim())
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  } catch (error) {
    throw new Error('Invalid Base64 input.')
  }
}

const concatByteChunks = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  chunks.forEach((chunk) => {
    merged.set(chunk, offset)
    offset += chunk.length
  })
  return merged
}

const readFileAsBytes = (file: File): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })

const downloadBytesAsFile = (bytes: Uint8Array, filename: string) => {
  const blob = new Blob([new Uint8Array(bytes)])
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// Simple header: 2 bytes filename length + UTF-8 filename + data
const wrapFileEnvelope = (name: string, data: Uint8Array) => {
  const safeName = name || 'file'
  const nameBytes = textToUtf8Bytes(safeName)
  const header = new Uint8Array(2 + nameBytes.length + data.length)
  header[0] = (nameBytes.length >> 8) & 0xff
  header[1] = nameBytes.length & 0xff
  header.set(nameBytes, 2)
  header.set(data, 2 + nameBytes.length)
  return header
}

const unwrapFileEnvelope = (bytes: Uint8Array): { name: string; data: Uint8Array } => {
  if (bytes.length < 2) return { name: 'decrypted.bin', data: bytes }
  const nameLength = (bytes[0] << 8) | bytes[1]
  const nameStart = 2
  const nameEnd = Math.min(bytes.length, nameStart + nameLength)
  const name = utf8BytesToText(bytes.slice(nameStart, nameEnd)) || 'decrypted.bin'
  const data = bytes.slice(nameEnd)
  return { name, data }
}

// Convert a freeform text key into an 8-byte DES key (UTF-8, truncate/pad)
const textKeyToDesKeyBytes = (value: string): Uint8Array => {
  const encoder = new TextEncoder()
  let bytes = encoder.encode(value)
  if (bytes.length > 8) {
    bytes = bytes.slice(0, 8)
  } else if (bytes.length < 8) {
    const padded = new Uint8Array(8)
    padded.set(bytes)
    bytes = padded
  }
  return bytes
}

// Single-block DES helpers (reuse existing DES core)
const encryptBlock = (block: Uint8Array, keyHex: string): { bytes: Uint8Array; result: DESResult } => {
  const res = des_encrypt(bytesToHex(block), keyHex)
  return { bytes: hexToBytes(res.outputHex), result: res }
}

const decryptBlock = (block: Uint8Array, keyHex: string): { bytes: Uint8Array; result: DESResult } => {
  const res = des_decrypt(bytesToHex(block), keyHex)
  return { bytes: hexToBytes(res.outputHex), result: res }
}

// Encrypt bytes with selected mode; prefixes IV/nonce for non-ECB
const encryptBytesWithMode = (
  plaintext: Uint8Array,
  keyHex: string,
  mode: DesMode,
  customIv?: Uint8Array,
): { output: Uint8Array; firstBlockResult: DESResult } => {
  const blocks: Uint8Array[] = []
  let iv: Uint8Array | null = null
  let firstBlockResult: DESResult | null = null

  const getFirst = (res: DESResult) => {
    if (!firstBlockResult) firstBlockResult = res
  }

  if (mode === 'ECB') {
    for (let i = 0; i < plaintext.length; i += 8) {
      const block = plaintext.slice(i, i + 8)
      const { bytes, result } = encryptBlock(block, keyHex)
      getFirst(result)
      blocks.push(bytes)
    }
    if (!firstBlockResult) {
      throw new Error('No blocks were encrypted')
    }
    return { output: concatByteChunks(blocks), firstBlockResult }
  }

  iv = customIv ?? generateRandomBlock()

  if (mode === 'CBC') {
    let prev = iv
    for (let i = 0; i < plaintext.length; i += 8) {
      const block = plaintext.slice(i, i + 8)
      const xored = xorBlocks(block, prev)
      const { bytes, result } = encryptBlock(xored, keyHex)
      getFirst(result)
      blocks.push(bytes)
      prev = bytes
    }
  } else if (mode === 'CFB') {
    let feedback = iv
    for (let i = 0; i < plaintext.length; i += 8) {
      const { bytes: keystream, result } = encryptBlock(feedback, keyHex)
      getFirst(result)
      const cipherBlock = xorBlocks(plaintext.slice(i, i + 8), keystream)
      blocks.push(cipherBlock)
      feedback = cipherBlock
    }
  } else if (mode === 'OFB') {
    let ofb = iv
    for (let i = 0; i < plaintext.length; i += 8) {
      const { bytes: keystream, result } = encryptBlock(ofb, keyHex)
      getFirst(result)
      const cipherBlock = xorBlocks(plaintext.slice(i, i + 8), keystream)
      blocks.push(cipherBlock)
      ofb = keystream
    }
  } else if (mode === 'CTR') {
    let counter = iv
    for (let i = 0; i < plaintext.length; i += 8) {
      const { bytes: keystream, result } = encryptBlock(counter, keyHex)
      getFirst(result)
      const cipherBlock = xorBlocks(plaintext.slice(i, i + 8), keystream)
      blocks.push(cipherBlock)
      counter = incrementCounter(counter)
    }
  } else {
    throw new Error(`Unsupported encryption mode: ${mode}`)
  }

  if (!firstBlockResult) {
    throw new Error('No blocks were encrypted')
  }

  return { output: concatByteChunks([iv, concatByteChunks(blocks)]), firstBlockResult }
}

// Decrypt bytes with selected mode; expects IV/nonce prefix for non-ECB
const decryptBytesWithMode = (
  ciphertext: Uint8Array,
  keyHex: string,
  mode: DesMode,
): { output: Uint8Array; firstBlockResult: DESResult } => {
  const blocks: Uint8Array[] = []
  let firstBlockResult: DESResult | null = null

  const getFirst = (res: DESResult) => {
    if (!firstBlockResult) firstBlockResult = res
  }

  if (mode === 'ECB') {
    for (let i = 0; i < ciphertext.length; i += 8) {
      const block = ciphertext.slice(i, i + 8)
      const { bytes, result } = decryptBlock(block, keyHex)
      getFirst(result)
      blocks.push(bytes)
    }
    return { output: concatByteChunks(blocks), firstBlockResult: firstBlockResult! }
  }

  if (ciphertext.length < 16) {
    throw new Error('Ciphertext must include an 8-byte IV/nonce.')
  }

  const iv = new Uint8Array(ciphertext.slice(0, 8))
  const body = new Uint8Array(ciphertext.slice(8))

  if (mode === 'CBC') {
    let prev = iv
    for (let i = 0; i < body.length; i += 8) {
      const block = new Uint8Array(body.slice(i, i + 8))
      const { bytes: decrypted, result } = decryptBlock(block, keyHex)
      getFirst(result)
      const plainBlock = xorBlocks(decrypted, prev)
      blocks.push(plainBlock)
      prev = block
    }
  } else if (mode === 'CFB') {
    let feedback = iv
    for (let i = 0; i < body.length; i += 8) {
      const { bytes: keystream, result } = encryptBlock(feedback, keyHex)
      getFirst(result)
      const plainBlock = xorBlocks(new Uint8Array(body.slice(i, i + 8)), keystream)
      blocks.push(plainBlock)
      feedback = new Uint8Array(body.slice(i, i + 8))
    }
  } else if (mode === 'OFB') {
    let ofb: Uint8Array = iv
    for (let i = 0; i < body.length; i += 8) {
      const { bytes: keystream, result } = encryptBlock(ofb, keyHex)
      getFirst(result)
      const plainBlock = xorBlocks(new Uint8Array(body.slice(i, i + 8)), keystream)
      blocks.push(plainBlock)
      ofb = new Uint8Array(keystream)
    }
  } else if (mode === 'CTR') {
    let counter = iv
    for (let i = 0; i < body.length; i += 8) {
      const { bytes: keystream, result } = encryptBlock(counter, keyHex)
      getFirst(result)
      const plainBlock = xorBlocks(new Uint8Array(body.slice(i, i + 8)), keystream)
      blocks.push(plainBlock)
      counter = incrementCounter(counter)
    }
  }

  return { output: concatByteChunks(blocks), firstBlockResult: firstBlockResult! }
}

const FLOW_BLUEPRINT = [
  { id: 'plaintext', label: 'Plaintext' },
  { id: 'ip', label: 'Initial Permutation' },
  { id: 'rounds', label: '16 Rounds' },
  { id: 'fp', label: 'Final Permutation' },
  { id: 'ciphertext', label: 'Ciphertext' },
] as const

const letterForScore = (score: number) => {
  if (score >= 93) return 'A+'
  if (score >= 87) return 'A'
  if (score >= 83) return 'A-'
  if (score >= 79) return 'B+'
  if (score >= 75) return 'B'
  if (score >= 72) return 'B-'
  if (score >= 69) return 'C+'
  if (score >= 66) return 'C'
  if (score >= 63) return 'C-'
  if (score >= 61) return 'D+'
  if (score >= 60) return 'D'
  return 'F'
}
const FLOW_EDGES: Edge[] = [
  { id: 'plain-ip', source: 'plaintext', target: 'ip', animated: true },
  { id: 'ip-rounds', source: 'ip', target: 'rounds', animated: true },
  { id: 'rounds-fp', source: 'rounds', target: 'fp', animated: true },
  { id: 'fp-cipher', source: 'fp', target: 'ciphertext', animated: true },
]

// Split an array into evenly sized chunks (used for S-box parsing)
const chunkArray = <T,>(array: T[], size: number) => {
  const chunks: T[][] = []
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size))
  }
  return chunks
}

const chunkBinaryToRows = (binary: string, rowSize = 8): string[][] => {
  const rows: string[][] = []
  for (let i = 0; i < binary.length; i += rowSize) {
    const slice = binary.slice(i, i + rowSize).split('')
    if (slice.length) rows.push(slice)
  }
  return rows
}

const xorBlocks = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(8)
  for (let i = 0; i < 8; i += 1) out[i] = a[i] ^ b[i]
  return out
}

const incrementCounter = (counter: Uint8Array) => {
  const out = new Uint8Array(counter)
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = (out[i] + 1) & 0xff
    if (out[i] !== 0) break
  }
  return out
}

const generateRandomBlock = () => {
  const iv = new Uint8Array(8)
  crypto.getRandomValues(iv)
  return iv
}

// Deterministic mode helper for reference vectors (allows fixed IV)
const encryptBytesWithModeFixedIv = (
  plaintext: Uint8Array,
  keyHex: string,
  mode: DesMode,
  iv?: Uint8Array,
): Uint8Array => {
  const blocks: Uint8Array[] = []
  if (mode === 'ECB') {
    for (let i = 0; i < plaintext.length; i += 8) {
      const block = plaintext.slice(i, i + 8)
      const { bytes } = encryptBlock(block, keyHex)
      blocks.push(bytes)
    }
    return concatByteChunks(blocks)
  }
  if (!iv) throw new Error('IV/nonce required for non-ECB test vector.')
  if (iv.length !== 8) throw new Error('IV must be 8 bytes.')
  if (mode === 'CBC') {
    let prev = iv
    for (let i = 0; i < plaintext.length; i += 8) {
      const xored = xorBlocks(plaintext.slice(i, i + 8), prev)
      const { bytes } = encryptBlock(xored, keyHex)
      blocks.push(bytes)
      prev = bytes
    }
  } else if (mode === 'CFB') {
    let feedback = iv
    for (let i = 0; i < plaintext.length; i += 8) {
      const { bytes: keystream } = encryptBlock(feedback, keyHex)
      const cipherBlock = xorBlocks(plaintext.slice(i, i + 8), keystream)
      blocks.push(cipherBlock)
      feedback = cipherBlock
    }
  } else if (mode === 'OFB') {
    let ofb = iv
    for (let i = 0; i < plaintext.length; i += 8) {
      const { bytes: keystream } = encryptBlock(ofb, keyHex)
      const cipherBlock = xorBlocks(plaintext.slice(i, i + 8), keystream)
      blocks.push(cipherBlock)
      ofb = keystream
    }
  } else if (mode === 'CTR') {
    let counter = iv
    for (let i = 0; i < plaintext.length; i += 8) {
      const { bytes: keystream } = encryptBlock(counter, keyHex)
      const cipherBlock = xorBlocks(plaintext.slice(i, i + 8), keystream)
      blocks.push(cipherBlock)
      counter = incrementCounter(counter)
    }
  }
  return concatByteChunks([iv, concatByteChunks(blocks)])
}

const BIT_LABELS = Array.from({ length: 16 }, (_, idx) => idx.toString(16).toUpperCase())

type TabId =
  | 'overview'
  | 'encrypt'
  | 'decrypt'
  | 'round'
  | 'ffunction'
  | 'schedule'
  | 'avalanche'
  | 'matrix'
  | 'theory'
  | 'grading'
  | 'tests'

const TAB_LABELS: Record<TabId, string> = {
  overview: 'Overview',
  encrypt: 'Encryption Flow',
  decrypt: 'Decryption Flow',
  round: 'Round Explorer',
  ffunction: 'F-Function & S-Boxes',
  schedule: 'Key Schedule',
  avalanche: 'Avalanche Effect',
  matrix: 'Matrix View',
  theory: 'Theory & Security',
  grading: 'Error Detection',
  tests: 'Test Vectors',
}

// Prebuilt ReactFlow nodes for the overview diagram
const FLOW_BLUEPRINT_NODES: Node[] = FLOW_BLUEPRINT.map((node, index) => ({
  id: node.id,
  position: { x: index * 230, y: 0 },
  data: { label: node.label },
  draggable: false,
  selectable: false,
  style: {
    padding: 16,
    borderRadius: 20,
    border: '1px solid rgba(148,163,184,0.3)',
    background: 'rgba(17,24,39,0.7)',
    color: '#E2E8F0',
    fontSize: 14,
    fontWeight: 600,
    textAlign: 'center',
    minWidth: 200,
  },
}))

type GradeRow = {
  studentId: string
  name: string
  examId: string
  version: string
  q1: number
  q2: number
  q3: number
  total: number
  diagnosis?: string
  letter_grade?: string
}

type RosterRow = {
  studentId: string
  name: string
  examId: string
  version: string
  versionLabel?: string
}

// Main App component: manages inputs, runs DES, and renders teaching views
function App() {
  // Inputs and formats
  const [plaintext, setPlaintext] = useState<string>('')
  const [plaintextFormat, setPlaintextFormat] = useState<InputFormat>('hex')
  const [keyValue, setKeyValue] = useState<string>('')
  const [keyFormat, setKeyFormat] = useState<KeyFormat>('hex')
  // Visualization and results
  const [currentRoundIndex, setCurrentRoundIndex] = useState(0)
  const [currentResult, setCurrentResult] = useState<DESResult | null>(null)
  const [lastEncryptResult, setLastEncryptResult] = useState<DESResult | null>(null)
  const [lastDecryptResult, setLastDecryptResult] = useState<DESResult | null>(null)
  const [executionTime, setExecutionTime] = useState<number | null>(null)
  const [, setError] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [selectedSBox, setSelectedSBox] = useState(0)
  const [avalancheDiffs, setAvalancheDiffs] = useState<AvalancheRoundDiff[] | null>(null)
  const [mutatedResult, setMutatedResult] = useState<DESResult | null>(null)
  const [mutatedInput, setMutatedInput] = useState<string | null>(null)
  const [avalancheBase, setAvalancheBase] = useState<DESResult | null>(null)
  const [mutatedBitIndex, setMutatedBitIndex] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<TabId>('overview')
  const [inputKind, setInputKind] = useState<InputKind>('hex')
  const [activeMode, setActiveMode] = useState<'encrypt' | 'decrypt'>('encrypt')
  const [flowStep, setFlowStep] = useState(0)
  const [decryptFlowStep, setDecryptFlowStep] = useState(0)
  const [outputFormat, setOutputFormat] = useState<'hex' | 'binary'>('hex')
  const [lastKeyHex, setLastKeyHex] = useState<string | null>(null)
  const [studentId] = useState('')
  const [studentName] = useState('')
  const [examId] = useState('Exam-1')
  const [versionLabel] = useState('A')
  const [studentAnswerHex, setStudentAnswerHex] = useState('')
  const [diagnosisResult, setDiagnosisResult] = useState<DiagnosisResult | null>(null)
  const [gradebookRows, setGradebookRows] = useState<GradeRow[]>([])
  const [roster, setRoster] = useState<RosterRow[]>([])
  const [gradingError, setGradingError] = useState<string | null>(null)
  const [, setShowGradeModal] = useState(false)
  const [selectedMode, setSelectedMode] = useState<'encrypt' | 'decrypt'>('encrypt')
  const [, setPendingGrade] = useState<GradeRow | null>(null)
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authName, setAuthName] = useState('')
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin')
  const [authToken, setAuthTokenState] = useState<string | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [, setIntroLoader] = useState(false)
  const [textInput, setTextInput] = useState('')
  const [textCipherHex, setTextCipherHex] = useState('')
  const [textCipherBase64, setTextCipherBase64] = useState('')
  const [textCipherInput, setTextCipherInput] = useState('')
  const [textCipherEncoding, setTextCipherEncoding] = useState<'hex' | 'base64'>('hex')
  const [textPlainOutput, setTextPlainOutput] = useState('')
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null)
  const [fileName, setFileName] = useState('')
  const [fileCipherBytes, setFileCipherBytes] = useState<Uint8Array | null>(null)
  const [filePlainBytes, setFilePlainBytes] = useState<Uint8Array | null>(null)
  const [fileOutputName, setFileOutputName] = useState('')
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light'
    return (localStorage.getItem('des_theme') as 'light' | 'dark') ?? 'light'
  })
  const [desMode, setDesMode] = useState<DesMode>('ECB')
  const [lastCipherHex, setLastCipherHex] = useState<string>('')
  const [lastIvHex, setLastIvHex] = useState<string | null>(null)
  const [ivInput, setIvInput] = useState<string>('')
  const STORAGE_KEYS = useMemo(
    () => ({
      roster: 'deslab_roster',
      gradebook: 'deslab_gradebook',
      token: 'deslab_token',
      inputs: 'deslab_inputs',
    }),
    [],
  )

  // Load persisted roster/grades once
  useEffect(() => {
    const loadLocal = () => {
      try {
        const savedRoster = localStorage.getItem(STORAGE_KEYS.roster)
        if (savedRoster) setRoster(JSON.parse(savedRoster))
        const savedGrades = localStorage.getItem(STORAGE_KEYS.gradebook)
        if (savedGrades) setGradebookRows(JSON.parse(savedGrades))
      } catch (storageError) {
        console.warn('Unable to load saved data', storageError)
      }
    }
    const savedToken = localStorage.getItem(STORAGE_KEYS.token)
    if (savedToken) {
      setAuthTokenState(savedToken)
      setAuthToken(savedToken)
    }
      try {
        const savedInputs = localStorage.getItem(STORAGE_KEYS.inputs)
        if (savedInputs) {
          const parsed = JSON.parse(savedInputs)
          if (parsed.plaintext) setPlaintext(parsed.plaintext)
          if (parsed.inputKind) setInputKind(parsed.inputKind)
          if (parsed.textInput) setTextInput(parsed.textInput)
          if (parsed.keyValue) setKeyValue(parsed.keyValue)
          if (parsed.plaintextFormat) setPlaintextFormat(parsed.plaintextFormat)
          if (parsed.keyFormat) setKeyFormat(parsed.keyFormat as KeyFormat)
          if (parsed.theme) setTheme(parsed.theme as 'light' | 'dark')
          if (parsed.desMode) setDesMode(parsed.desMode as DesMode)
          if (parsed.ivInput !== undefined) setIvInput(parsed.ivInput)
        }
      } catch (storageError) {
        console.warn('Unable to load saved inputs', storageError)
      }
    if (!hasApi || !savedToken) {
      loadLocal()
      return
    }
    const fetchRemote = async () => {
      try {
        const [remoteRoster, remoteGrades] = await Promise.all([api.listRoster(), api.listGrades()])
        setRoster(
          remoteRoster.map((r) => ({
            studentId: r.studentId ?? (r as any).student_id,
            name: r.name,
            examId: r.examId ?? (r as any).exam_id,
            version: (r as any).version_label,
          })),
        )
        setGradebookRows(
          remoteGrades.map((g) => ({
            studentId: g.studentId ?? (g as any).student_id,
            name: g.name,
            examId: g.examId ?? (g as any).exam_id,
            version: g.versionLabel ?? (g as any).version_label,
            q1: g.q1 ?? (g as any).q_scores?.q1 ?? 0,
            q2: g.q2 ?? (g as any).q_scores?.q2 ?? 0,
            q3: g.q3 ?? (g as any).q_scores?.q3 ?? 0,
            total: Number(g.total ?? (g as any).total ?? 0),
            diagnosis: g.diagnosis ?? (g as any).diagnosis,
            letter_grade: g.letter_grade ?? (g as any).letter_grade,
          })),
        )
      } catch (error) {
        console.warn('API load failed; falling back to local', error)
        loadLocal()
      }
    }
    fetchRemote()
  }, [STORAGE_KEYS])

  // Persist roster/grades
  useEffect(() => {
    if (hasApi && authToken) return
    try {
      localStorage.setItem(STORAGE_KEYS.roster, JSON.stringify(roster))
      localStorage.setItem(STORAGE_KEYS.gradebook, JSON.stringify(gradebookRows))
      localStorage.setItem(
        STORAGE_KEYS.inputs,
        JSON.stringify({
          plaintext,
          keyValue,
          plaintextFormat,
          keyFormat,
          inputKind,
          textInput,
          theme,
          desMode,
          ivInput,
        }),
      )
    } catch (storageError) {
      console.warn('Unable to save data', storageError)
    }
  }, [
    STORAGE_KEYS,
    roster,
    gradebookRows,
    authToken,
    plaintext,
    keyValue,
    plaintextFormat,
    keyFormat,
    inputKind,
    textInput,
    theme,
    desMode,
    ivInput,
  ])

  // Validate and normalize plaintext based on the chosen format
  const plainValidation = useMemo(() => {
    if (plaintextFormat === 'binary') {
      const sanitized = plaintext.replace(/[^01]/g, '')
      const validLength = sanitized.length > 0 && sanitized.length % 64 === 0
      const hex = binaryStringToHex(sanitized)
      return {
        display: sanitized,
        binary: sanitized,
        hex,
        remaining: 64 - (sanitized.length % 64 || 64),
        valid: validLength,
        helper: validLength
          ? 'Ready (multiples of 64 bits supported)'
          : 'Enter binary in multiples of 64 bits (block size)',
      }
    }
    const sanitized = plaintext.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
    const validLength = sanitized.length > 0 && sanitized.length % 16 === 0
    return {
      display: sanitized,
      binary: hexToBinaryString(sanitized),
      hex: sanitized,
      remaining: 16 - (sanitized.length % 16 || 16),
      valid: validLength,
      helper: validLength
        ? 'Ready (multiples of 16 hex chars supported)'
        : 'Requires hex in multiples of 16 characters (64-bit blocks)',
    }
  }, [plaintext, plaintextFormat])

  const keyValidation = useMemo(() => {
    // Validate and normalize key based on the chosen format
    if (keyFormat === 'binary') {
      const sanitized = keyValue.replace(/[^01]/g, '').slice(0, 64)
      const hex = binaryStringToHex(sanitized)
      return {
        display: sanitized,
        binary: sanitized.padEnd(64, '0'),
        hex,
        valid: sanitized.length === 64,
        helper: sanitized.length === 64 ? 'Key ready' : 'Enter exactly 64 binary digits (0/1)',
      }
    }
    if (keyFormat === 'text') {
      const text = keyValue
      const derivedBytes = textKeyToDesKeyBytes(text)
      const derivedHex = bytesToHex(derivedBytes)
      return {
        display: text,
        binary: hexToBinaryString(derivedHex),
        hex: derivedHex,
        valid: text.trim().length > 0,
        helper: text.trim().length > 0 ? 'Derived from text (UTF-8 padded/truncated to 8 bytes)' : 'Please enter a key.',
      }
    }
    const sanitized = keyValue.replace(/[^0-9a-fA-F]/g, '').slice(0, 16).toLowerCase()
    return {
      display: sanitized,
      binary: hexToBinaryString(sanitized.padEnd(16, '0')),
      hex: sanitized.padEnd(16, '0'),
      valid: sanitized.length === 16,
      helper: sanitized.length === 16 ? 'Key ready' : 'Requires 16 hex characters with parity bits',
    }
  }, [keyValue, keyFormat])

  const effectiveKey = useMemo(() => {
    if (!keyValidation.valid) return null
    const { parityDroppedKey } = generate_subkeys(keyValidation.hex)
    return parityDroppedKey
  }, [keyValidation])

  const keyStrength = useMemo(
    () => (keyValidation.valid ? evaluateKeyStrength(keyValidation.hex) : { label: 'Weak', score: 0 }),
    [keyValidation.hex, keyValidation.valid],
  )

  const currentRound = useMemo(
    () => currentResult?.rounds[currentRoundIndex] ?? null,
    [currentResult, currentRoundIndex],
  )

  const flowStage = useMemo(() => {
    if (!currentResult) return 'plaintext'
    if (currentRoundIndex < 16) return 'rounds'
    return 'ciphertext'
  }, [currentResult, currentRoundIndex])

  // Highlight the current flow stage in the overview diagram
  const nodes: Node[] = useMemo(
    () =>
      FLOW_BLUEPRINT_NODES.map((node) => ({
        ...node,
        style: {
          ...node.style,
          border: flowStage === node.id ? '2px solid #3B82F6' : node.style?.border,
          boxShadow: flowStage === node.id ? '0 0 12px rgba(59,130,246,0.4)' : 'none',
        },
      })),
    [flowStage],
  )

  const ciphertextBinary = currentResult ? hexToBinaryString(currentResult.outputHex) : ''

  // Sanitize plaintext input
  const handlePlaintextChange = (value: string) => {
    if (plaintextFormat === 'binary') setPlaintext(value.replace(/[^01]/g, '').slice(0, 64))
    else setPlaintext(value.replace(/[^0-9a-fA-F]/g, '').slice(0, 16).toLowerCase())
  }

  // Sanitize key input
  const handleKeyChange = (value: string) => {
    if (keyFormat === 'binary') {
      setKeyValue(value.replace(/[^01]/g, '').slice(0, 64))
    } else if (keyFormat === 'hex') {
      setKeyValue(value.replace(/[^0-9a-fA-F]/g, '').slice(0, 16).toLowerCase())
    } else {
      setKeyValue(value)
    }
  }

  const handleFileSelection = async (file: File | null) => {
    if (!file) {
      setFileBytes(null)
      setFileName('')
      return
    }
    try {
      const bytes = await readFileAsBytes(file)
      setFileBytes(bytes)
      setFileName(file.name)
      setFileCipherBytes(null)
      setFilePlainBytes(null)
      setFileOutputName('')
      setError(null)
    } catch {
      setError('Could not read the selected file.')
    }
  }

  const runTextProcess = useCallback(
    async (mode: 'encrypt' | 'decrypt') => {
      if (!keyValidation.valid) {
        setError(keyFormat === 'text' ? 'Please enter a key.' : 'Key must be 64 bits (16 hex chars or 64 binary digits).')
        return
      }
      if (mode === 'encrypt' && !textInput.trim()) {
        setError('Enter text to encrypt.')
        return
      }
      if (mode === 'decrypt' && !textCipherInput.trim()) {
        setError('Paste ciphertext in hex or Base64 to decrypt.')
        return
      }
      setIsProcessing(true)
      setError(null)
      const start = performance.now()
      try {
        const keyHex = keyValidation.hex
        if (mode === 'encrypt') {
          const padded = padTo8Bytes(textToUtf8Bytes(textInput))
          const customIvBytes = ivInput.trim() !== '' && /^[0-9a-fA-F]{16}$/.test(ivInput) ? hexToBytes(ivInput) : undefined
          const { firstBlockResult, output } = encryptBytesWithMode(padded, keyHex, desMode, customIvBytes)
          const cipherHex = bytesToHex(output)
          const cipherB64 = bytesToBase64(output)
          setTextCipherHex(cipherHex)
          setTextCipherBase64(cipherB64)
          setTextCipherInput(cipherHex)
          setTextPlainOutput('')
          setCurrentResult(firstBlockResult)
          setLastEncryptResult(firstBlockResult)
          setActiveMode('encrypt')
          setActiveTab('encrypt')
          setFlowStep(0)
        } else {
          const sourceBytes =
            textCipherEncoding === 'hex'
              ? hexToBytes(textCipherInput.trim())
              : base64ToBytes(textCipherInput.trim())
          if (sourceBytes.length % 8 !== 0) throw new Error('Ciphertext length must be a multiple of 8 bytes.')
          const { firstBlockResult, output } = decryptBytesWithMode(sourceBytes, keyHex, desMode)
          const unpadded = unpadPkcs(output)
          setTextCipherHex(bytesToHex(sourceBytes))
          setTextCipherBase64(bytesToBase64(sourceBytes))
          setTextPlainOutput(utf8BytesToText(unpadded))
          setCurrentResult(firstBlockResult)
          setLastDecryptResult(firstBlockResult)
          setActiveMode('decrypt')
          setActiveTab('decrypt')
          setDecryptFlowStep(0)
        }
        setExecutionTime(performance.now() - start)
        setAvalancheDiffs(null)
        setMutatedResult(null)
        setMutatedInput(null)
        setMutatedBitIndex(null)
        setLastKeyHex(keyValidation.hex)
      } catch (processError) {
        setError((processError as Error).message)
      } finally {
        setIsProcessing(false)
      }
    },
    [keyFormat, keyValidation, textInput, textCipherInput, textCipherEncoding, desMode],
  )

  const runFileProcess = useCallback(
    async (mode: 'encrypt' | 'decrypt') => {
      if (!keyValidation.valid) {
        setError(keyFormat === 'text' ? 'Please enter a key.' : 'Key must be 64 bits (16 hex chars or 64 binary digits).')
        return
      }
      const targetBytes = mode === 'encrypt' ? fileBytes : fileBytes ?? fileCipherBytes
      if (!targetBytes) {
        setError('Select a file first.')
        return
      }
      setIsProcessing(true)
      setError(null)
      const start = performance.now()
      try {
        const keyHex = keyValidation.hex
        if (mode === 'encrypt') {
          const payload = wrapFileEnvelope(fileName || 'file', targetBytes)
          const padded = padTo8Bytes(payload)
          const customIvBytes = ivInput.trim() !== '' && /^[0-9a-fA-F]{16}$/.test(ivInput) ? hexToBytes(ivInput) : undefined
          const { firstBlockResult, output } = encryptBytesWithMode(padded, keyHex, desMode, customIvBytes)
          setFileCipherBytes(output)
          setFilePlainBytes(null)
          setFileOutputName(`${fileName || 'file'}.des`)
          setCurrentResult(firstBlockResult)
          setLastEncryptResult(firstBlockResult)
          setActiveMode('encrypt')
          setActiveTab('encrypt')
          setFlowStep(0)
        } else {
          if (targetBytes.length % 8 !== 0) throw new Error('Encrypted file length must be a multiple of 8 bytes.')
          const { firstBlockResult, output } = decryptBytesWithMode(targetBytes, keyHex, desMode)
          const { name, data } = unwrapFileEnvelope(unpadPkcs(output))
          setFilePlainBytes(data)
          setFileCipherBytes(null)
          setFileOutputName(name || 'decrypted.bin')
          setCurrentResult(firstBlockResult)
          setLastDecryptResult(firstBlockResult)
          setActiveMode('decrypt')
          setActiveTab('decrypt')
          setDecryptFlowStep(0)
        }
        setExecutionTime(performance.now() - start)
        setAvalancheDiffs(null)
        setMutatedResult(null)
        setMutatedInput(null)
        setMutatedBitIndex(null)
        setLastKeyHex(keyValidation.hex)
      } catch (processError) {
        setError((processError as Error).message)
      } finally {
        setIsProcessing(false)
      }
    },
    [fileBytes, fileCipherBytes, fileName, keyFormat, keyValidation, desMode],
  )

  // Run DES encrypt/decrypt and refresh all dependent state
  const runProcess = useCallback(
    async (mode: 'encrypt' | 'decrypt', overrides?: { plaintextHex?: string; keyHex?: string }) => {
      if (inputKind === 'text') {
        await runTextProcess(mode)
        return
      }
      if (inputKind === 'file') {
        await runFileProcess(mode)
        return
      }
      if (!keyValidation.valid && !overrides?.keyHex) {
        setError(keyFormat === 'text' ? 'Please enter a key.' : 'Key must be 64 bits (16 hex chars or 64 binary digits).')
        return
      }
      if (!plainValidation.valid && !overrides?.plaintextHex) {
        setError('Provide data in multiples of 64 bits (16 hex chars) for this mode.')
        return
      }
      setIsProcessing(true)
      setError(null)
      try {
        const plainHex = overrides?.plaintextHex ?? plainValidation.hex
        const keyHex = overrides?.keyHex ?? keyValidation.hex
        const start = performance.now()
        const inputBytes = hexToBytes(plainHex)
        if (mode === 'encrypt') {
          const padded = padTo8Bytes(inputBytes)
          // Use custom IV if provided and valid, otherwise let encryptBytesWithMode generate a random one
          const customIvBytes = ivInput.trim() !== '' && /^[0-9a-fA-F]{16}$/.test(ivInput) ? hexToBytes(ivInput) : undefined
          const { firstBlockResult, output } = encryptBytesWithMode(padded, keyHex, desMode, customIvBytes)
          setCurrentResult(firstBlockResult)
          setExecutionTime(performance.now() - start)
          setCurrentRoundIndex(0)
          setAvalancheDiffs(null)
          setMutatedResult(null)
          setMutatedInput(null)
          setMutatedBitIndex(null)
          setLastKeyHex(keyHex)
          setLastEncryptResult(firstBlockResult)
          setActiveMode('encrypt')
          setActiveTab('encrypt')
          setFlowStep(0)
          if (inputKind === 'binary' || inputKind === 'hex') {
            const outHex = bytesToHex(output)
            setLastCipherHex(outHex)
            setLastIvHex(desMode === 'ECB' ? null : outHex.slice(0, 16))
          }
        } else {
          // Auto-pad to 8 bytes for consistency with encryption
          const padded = padTo8Bytes(inputBytes)
          const { firstBlockResult, output } = decryptBytesWithMode(padded, keyHex, desMode)
          setCurrentResult(firstBlockResult)
          setExecutionTime(performance.now() - start)
          setCurrentRoundIndex(0)
          setAvalancheDiffs(null)
          setMutatedResult(null)
          setMutatedInput(null)
          setMutatedBitIndex(null)
          setLastKeyHex(keyHex)
          setLastDecryptResult(firstBlockResult)
          setActiveMode('decrypt')
          setActiveTab('decrypt')
          setDecryptFlowStep(0)
          if (inputKind === 'binary' || inputKind === 'hex') {
            const cipherHex = bytesToHex(inputBytes)
            setLastCipherHex(cipherHex)
            setLastIvHex(desMode === 'ECB' ? null : cipherHex.slice(0, 16))
            setPlaintext(bytesToHex(unpadPkcs(output)))
          }
        }
      } catch (processError) {
        setError((processError as Error).message)
      } finally {
        setIsProcessing(false)
      }
    },
    [inputKind, keyValidation, plainValidation, runFileProcess, runTextProcess, keyFormat, desMode],
  )

  const handleAvalancheTest = async () => {
    if (!keyValidation.valid || !plainValidation.valid) {
      setError('Provide valid plaintext and key before running the avalanche demo.')
      return
    }
    const basePlain = plainValidation.hex.slice(0, 16)
    if (basePlain.length < 16) {
      setError('Avalanche requires at least one full 64-bit block.')
      return
    }
    const keyHex = keyValidation.hex
    const baseResult = des_encrypt(basePlain, keyHex)
    const baseBits = hexToBits(basePlain, 64)
    const bitIndex = Math.floor(Math.random() * 64)
    const mutatedBits = [...baseBits]
    mutatedBits[bitIndex] = mutatedBits[bitIndex] === 0 ? 1 : 0
    const mutatedHex = bitsToHex(mutatedBits)
    const mutated = des_encrypt(mutatedHex, keyHex)
    const diffs = compareRoundsForAvalanche(baseResult.rounds, mutated.rounds)
    setAvalancheDiffs(diffs)
    setMutatedResult(mutated)
    setMutatedInput(mutatedHex)
    setAvalancheBase(baseResult)
    setMutatedBitIndex(bitIndex)
    setCurrentResult(baseResult)
    setCurrentRoundIndex(0)
  }

  // Count differing bits between avalanche base and mutated outputs
  const ciphertextDiff = useMemo(() => {
    if (!avalancheBase || !mutatedResult) return null
    const baseBits = hexToBits(avalancheBase.outputHex, 64)
    const mutatedBits = hexToBits(mutatedResult.outputHex, 64)
    let diff = 0
    baseBits.forEach((bit, idx) => {
      if (bit !== mutatedBits[idx]) diff += 1
    })
    return diff
  }, [avalancheBase, mutatedResult])

  const canEncrypt = useMemo(() => {
    if (!keyValidation.valid) return false
    if (inputKind === 'text') return Boolean(textInput.trim())
    if (inputKind === 'file') return Boolean(fileBytes)
    return plainValidation.valid
  }, [fileBytes, inputKind, keyValidation.valid, plainValidation.valid, textInput])

  const canDecrypt = useMemo(() => {
    if (!keyValidation.valid) return false
    if (inputKind === 'text') return Boolean(textCipherInput.trim())
    if (inputKind === 'file') return Boolean(fileBytes || fileCipherBytes)
    return plainValidation.valid
  }, [fileBytes, fileCipherBytes, inputKind, keyValidation.valid, plainValidation.valid, textCipherInput])

const copyCiphertext = () => {
    if (inputKind === 'text') {
      const toCopy = textCipherBase64 || textCipherHex
      if (toCopy) navigator.clipboard?.writeText(toCopy)
      return
    }
    if (!latestResult) return
    navigator.clipboard?.writeText(latestResult.outputHex)
  }

  const useCiphertextAsInput = () => {
    if (inputKind !== 'binary' && inputKind !== 'hex') return
    const cipherHex = desMode === 'ECB' ? latestResult?.outputHex ?? '' : lastCipherHex
    if (!cipherHex) return
    setPlaintextFormat('hex')
    setPlaintext(cipherHex)
  }

  const downloadEncryptedFile = () => {
    if (!fileCipherBytes) return
    downloadBytesAsFile(fileCipherBytes, fileOutputName || `${fileName || 'file'}.des`)
  }

  const downloadDecryptedFile = () => {
    if (!filePlainBytes) return
    downloadBytesAsFile(filePlainBytes, fileOutputName || 'decrypted.bin')
  }

  const handleFileDownload = () => {
    if (fileCipherBytes) {
      downloadEncryptedFile()
      return
    }
    if (filePlainBytes) {
      downloadDecryptedFile()
    }
  }

  // Theme toggling
  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('theme-light', 'theme-dark')
    root.classList.add(theme === 'dark' ? 'theme-dark' : 'theme-light')
    localStorage.setItem('des_theme', theme)
  }, [theme])

  // Reference test vectors for modes
  const referenceVectors = useMemo(() => {
    const vectors: Array<{
      label: string
      mode: DesMode
      keyHex?: string
      keyText?: string
      inputHex?: string
      inputText?: string
      iv?: string
    }> = [
      { label: 'ECB-1: Basic test', mode: 'ECB' as DesMode, keyHex: '133457799bbcdff1', inputHex: '0123456789abcdef' },
      { label: 'ECB-2: All zeros', mode: 'ECB' as DesMode, keyHex: '0101010101010101', inputHex: '0000000000000000' },
      { label: 'ECB-3: All ones', mode: 'ECB' as DesMode, keyHex: 'fefefefefefefefe', inputHex: 'ffffffffffffffff' },
      { label: 'ECB-4: Alternating', mode: 'ECB' as DesMode, keyHex: 'aaaaaaaaaaaaaa55', inputHex: 'aaaaaaaaaaaaaaaa' },
      { label: 'ECB-5: NIST vector', mode: 'ECB' as DesMode, keyHex: '0e329232ea6d0d73', inputHex: 'fedcba9876543210' },
      { label: 'ECB-6: Reverse', mode: 'ECB' as DesMode, keyHex: '133457799bbcdff1', inputHex: 'fedcba9876543210' },
      { label: 'ECB-Text: key "password", input "HELLO DES!"', mode: 'ECB' as DesMode, keyText: 'password', inputText: 'HELLO DES!' },
      { label: 'CBC-1: Simple (IV=0001020304050607)', mode: 'CBC' as DesMode, keyHex: '0f1571c947d9e859', inputHex: '02468aceeca86420', iv: '0001020304050607' },
      { label: 'CBC-2: Zero IV (IV=0000000000000000)', mode: 'CBC' as DesMode, keyHex: '133457799bbcdff1', inputHex: '0123456789abcdef', iv: '0000000000000000' },
      { label: 'CBC-3: Text "HELLO123" (IV=1122334455667788)', mode: 'CBC' as DesMode, keyHex: '0e329232ea6d0d73', inputText: 'HELLO123', iv: '1122334455667788' },
      { label: 'CFB-1: Basic (IV=0123456789abcdef)', mode: 'CFB' as DesMode, keyHex: '0f1571c947d9e859', inputHex: 'fedcba9876543210', iv: '0123456789abcdef' },
      { label: 'CFB-2: Simple (IV=1111111111111111)', mode: 'CFB' as DesMode, keyHex: '133457799bbcdff1', inputHex: '0123456789abcdef', iv: '1111111111111111' },
      { label: 'OFB-1: Text "DES-LAB!" (IV=a1a2a3a4a5a6a7a8)', mode: 'OFB' as DesMode, keyHex: '133457799bbcdff1', inputText: 'DES-LAB!', iv: 'a1a2a3a4a5a6a7a8' },
      { label: 'OFB-2: Hex (IV=0f0f0f0f0f0f0f0f)', mode: 'OFB' as DesMode, keyHex: '0e329232ea6d0d73', inputHex: 'aaaaaaaaaaaaaaaa', iv: '0f0f0f0f0f0f0f0f' },
      { label: 'CTR-1: Text "CTR demo" (IV=0000000000000001)', mode: 'CTR' as DesMode, keyHex: '1b1a191817161514', inputText: 'CTR demo', iv: '0000000000000001' },
      { label: 'CTR-2: Ctr=0 (IV=0000000000000000)', mode: 'CTR' as DesMode, keyHex: '133457799bbcdff1', inputHex: '0123456789abcdef', iv: '0000000000000000' },
      { label: 'CTR-Text: key "des-key!", input "stream mode" (IV=0000000000000002)', mode: 'CTR' as DesMode, keyText: 'des-key!', inputText: 'stream mode', iv: '0000000000000002' },
    ]
    return vectors.map((v) => {
      const keyHex = v.keyHex ?? bytesToHex(textKeyToDesKeyBytes(v.keyText ?? ''))
      const ivBytes = v.iv ? hexToBytes(v.iv) : undefined
      const inputBytes = v.inputHex ? hexToBytes(v.inputHex) : padTo8Bytes(textToUtf8Bytes(v.inputText ?? ''))
      const cipher = encryptBytesWithModeFixedIv(inputBytes, keyHex, v.mode, ivBytes)
      return {
        ...v,
        keyHex,
        keyDisplay: v.keyText ? `${v.keyText} → ${keyHex}` : keyHex,
        inputDisplay: v.inputHex ?? v.inputText,
        expectedHex: bytesToHex(cipher),
        expectedBase64: bytesToBase64(cipher),
      }
    })
  }, [])

  const graderErrorCases = [
    {
      case: 'Encrypt Q1 - ECB Mode',
      plaintext: '0123456789abcdef',
      key: '133457799bbcdff1',
      mode: 'ECB',
      expected: '85e813540f0ab405',
      student: '85e813540f0aa405',
      note: 'Mismatch at nibble 11; likely wrong subkey application in middle rounds.',
    },
    {
      case: 'Encrypt Q2 - IP Error',
      plaintext: '0123456789abcdef',
      key: '133457799bbcdff1',
      mode: 'ECB',
      expected: '85e813540f0ab405',
      student: '2d9ddee626003682',
      note: 'Complete mismatch from start - Initial Permutation (IP) skipped but FP applied.',
    },
    {
      case: 'Encrypt Q3 - Round 4 Error',
      plaintext: 'fedcba9876543210',
      key: '0e329232ea6d0d73',
      mode: 'ECB',
      expected: 'ea825383039557e1',
      student: 'eb25c3f41cffb383',
      note: 'Execution stopped after ~4 rounds (round-limit error).',
    },
    {
      case: 'Encrypt Q4 - FP Error',
      plaintext: '0123456789abcdef',
      key: '133457799bbcdff1',
      mode: 'ECB',
      expected: '85e813540f0ab405',
      student: '58e8135404f0ba05',
      note: 'Bit swapping pattern detected - Final Permutation (FP) error.',
    },
    {
      case: 'Encrypt Q5 - Key Schedule Error',
      plaintext: '0123456789abcdef',
      key: '0e329232ea6d0d73',
      mode: 'ECB',
      expected: '31aa59feb64386a6',
      student: '1e35e8f3e9c1f826',
      note: 'Subkey generation error - affects multiple rounds consistently.',
    },
    {
      case: 'Decrypt Q1 - CBC Mode',
      ciphertext: 'aabb09182736ccdd',
      key: '0f1571c947d9e859',
      mode: 'CBC',
      iv: '0001020304050607',
      expected: '02468aceeca86420',
      student: '02468aceeca86400',
      note: 'Last byte wrong - verify IV XOR order and CBC decryption logic.',
    },
    {
      case: 'Decrypt Q2 - IP Error',
      ciphertext: '85e813540f0ab405',
      key: '133457799bbcdff1',
      mode: 'ECB',
      expected: '0123456789abcdef',
      student: '0321674598badcfe',
      note: 'Severe bit pattern error - Initial Permutation (IP) not applied correctly.',
    },
    {
      case: 'Decrypt Q3 - Round 4 Error',
      ciphertext: 'ea825383039557e1',
      key: '0e329232ea6d0d73',
      mode: 'ECB',
      expected: 'fedcba9876543210',
      student: 'fedcba9876541210',
      note: 'Round 4 calculation error - check F-function in decryption rounds.',
    },
    {
      case: 'Decrypt Q4 - Swap Error',
      ciphertext: '85e813540f0ab405',
      key: '133457799bbcdff1',
      mode: 'ECB',
      expected: '0123456789abcdef',
      student: '89abcdef01234567',
      note: 'L/R halves not swapped before Final Permutation - common decryption mistake.',
    },
    {
      case: 'Decrypt Q5 - Subkey Order',
      ciphertext: '31aa59feb64386a6',
      key: '0e329232ea6d0d73',
      mode: 'ECB',
      expected: '0123456789abcdef',
      student: 'f8c2a6d0e1345b79',
      note: 'Subkeys used in wrong order - decryption must reverse subkey sequence (K16→K1).',
    },
    {
      case: 'Text mode',
      expected: 'Hello DES!',
      student: 'Hella DES!',
      note: 'One-byte error after unpadding; check PKCS#7 removal.',
    },
  ]

  // Export the latest run as CSV (summary, rounds, key schedule)
  const exportResultAsPdf = (result: DESResult | null) => {
    if (!result) return
    const keyHex = lastKeyHex ?? keyValidation.hex
    const inputBinary = hexToBinaryString(result.inputHex)
    const outputBinary = hexToBinaryString(result.outputHex)
    const keyBinary = hexToBinaryString(keyHex)
    const ipBinary = hexToBinaryString(result.ipOutput)
    const fpBinary = hexToBinaryString(result.fpOutput)
    const chunkToRows = (binary: string) => {
      const rows: string[] = []
      for (let i = 0; i < binary.length; i += 8) {
        rows.push(binary.slice(i, i + 8).split('').join(' '))
      }
      return rows
    }
    const renderMatrix = (title: string, binary: string) => {
      const rows = chunkToRows(binary)
      return `
        <div class="section">
          <h3>${title}</h3>
          <table class="matrix">
            <tbody>
              ${rows.map((row) => `<tr>${row.split(' ').map((bit) => `<td>${bit}</td>`).join('')}</tr>`).join('')}
            </tbody>
          </table>
        </div>
      `
    }
    const popup = window.open('', '_blank', 'width=1100,height=1200')
    if (!popup) return
    popup.document.write(`
      <html>
        <head>
          <title>DES Run Export</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 16px; color: #0f172a; }
            h1 { margin-bottom: 4px; }
            h2 { margin: 12px 0 6px; }
            h3 { margin: 10px 0 6px; }
            .section { margin-bottom: 18px; }
            table { width: 100%; border-collapse: collapse; margin-top: 8px; }
            th, td { border: 1px solid #d6deeb; padding: 6px; font-family: 'SFMono-Regular', Menlo, monospace; font-size: 12px; }
            th { background: #eef3fb; text-align: left; }
            .matrix td { text-align: center; width: 12px; padding: 4px; }
            .meta { font-size: 13px; color: #334155; }
          </style>
        </head>
        <body>
          <h1>DES ${result.mode === 'decrypt' ? 'Decryption' : 'Encryption'} Report</h1>
          <div class="meta">Generated ${new Date().toLocaleString()}</div>
          <div class="section">
            <h2>Summary</h2>
            <table>
              <tbody>
                <tr><th>Mode</th><td>${result.mode}</td></tr>
                <tr><th>Input Hex</th><td>${result.inputHex}</td></tr>
                <tr><th>Input Binary</th><td>${inputBinary}</td></tr>
                <tr><th>Output Hex</th><td>${result.outputHex}</td></tr>
                <tr><th>Output Binary</th><td>${outputBinary}</td></tr>
                <tr><th>Key Hex</th><td>${keyHex}</td></tr>
                <tr><th>Key Binary</th><td>${keyBinary}</td></tr>
              </tbody>
            </table>
          </div>
          ${renderMatrix('Initial Permutation (IP) output', ipBinary)}
          ${renderMatrix('Final Permutation (FP) output', fpBinary)}
          <div class="section">
            <h2>Rounds (L/R, Subkey, Output)</h2>
            <table>
              <thead>
                <tr><th>#</th><th>L</th><th>R</th><th>Subkey</th><th>Round Output</th></tr>
              </thead>
              <tbody>
                ${result.rounds
                  .map(
                    (r) =>
                      `<tr><td>${r.round}</td><td>${r.left}</td><td>${r.right}</td><td>${r.subKey}</td><td>${r.roundOutput}</td></tr>`,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
          <div class="section">
            <h2>Key Schedule</h2>
            <table>
              <thead><tr><th>Round</th><th>Shifts</th><th>C</th><th>D</th><th>Subkey</th></tr></thead>
              <tbody>
                ${result.keySchedule.rounds
                  .map(
                    (k) =>
                      `<tr><td>${k.round}</td><td>${k.shifts}</td><td>${k.c}</td><td>${k.d}</td><td>${k.subKey}</td></tr>`,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
          <script>
            setTimeout(() => { window.print(); }, 300);
          </script>
        </body>
      </html>
    `)
    popup.document.close()
  }


  const sBoxHighlight = useMemo(() => {
    if (!currentRound) return null
    const xorBits = hexToBits(currentRound.xorWithKey, 48)
    const xorChunks = chunkArray(xorBits, 6)
    const sboxInput = xorChunks[selectedSBox]
    if (!sboxInput) return null
    const row = (sboxInput[0] << 1) | sboxInput[5]
    const column = (sboxInput[1] << 3) | (sboxInput[2] << 2) | (sboxInput[3] << 1) | sboxInput[4]
    const sBoxOutputs = chunkArray(hexToBits(currentRound.sBoxOutput, 32), 4)
    const outputSegment = sBoxOutputs[selectedSBox]
    return {
      row,
      column,
      inputBits: sboxInput.join(''),
      outputBits: outputSegment?.join('') ?? '',
    }
  }, [currentRound, selectedSBox])

  const roundProgress = ((currentRoundIndex + 1) / 16) * 100
  const currentEncryptResult = currentResult?.mode === 'encrypt' ? currentResult : lastEncryptResult
  const currentDecryptResult = currentResult?.mode === 'decrypt' ? currentResult : lastDecryptResult
  const latestResult = currentResult ?? lastEncryptResult ?? lastDecryptResult
  const inputLabel = activeMode === 'encrypt' ? 'Plaintext' : 'Ciphertext'
  const outputLabel = activeMode === 'encrypt' ? 'Ciphertext' : 'Plaintext'

  const deriveSwapHex = (result: DESResult | null) => {
    // Swap halves before FP to display R16||L16
    const lastRound = result?.rounds.at(-1)
    if (!lastRound) return null
    const left = lastRound.roundOutput.slice(0, 8)
    const right = lastRound.roundOutput.slice(8)
    return `${right}${left}`
  }

  const getFlowStepData = (result: DESResult | null, step: number) => {
    // Build per-step data for the flow slider (IP, rounds, swap, FP)
    if (!result) return null
    if (step <= 0) {
      return {
        title: 'Raw inputs',
        description: '64-bit plaintext and key before any permutation.',
        left: result.inputHex,
        right: '',
        key: result.keySchedule.parityDroppedKey,
        output: result.inputHex,
      }
    }
    if (step === 1) {
      return {
        title: 'Initial Permutation (IP)',
        description: 'Bits permuted according to the IP table.',
        left: result.ipOutput.slice(0, 8),
        right: result.ipOutput.slice(8),
        key: result.keySchedule.parityDroppedKey,
        output: result.ipOutput,
      }
    }
    if (step >= 2 && step <= 17) {
      const roundIndex = step - 2
      const round = result.rounds[roundIndex]
      if (!round) return null
      const nextLeft = round.roundOutput.slice(0, 8)
      const nextRight = round.roundOutput.slice(8)
      return {
        title: `Round ${round.round}`,
        description: `Feistel mix: Ri becomes Li-1 XOR F(Ri-1, K${round.round}).`,
        left: round.left,
        right: round.right,
        key: round.subKey,
        output: round.roundOutput,
        nextLeft,
        nextRight,
      }
    }
    if (step === 18) {
      const swapHex = deriveSwapHex(result)
      if (!swapHex) return null
      return {
        title: '32-bit Swap',
        description: 'Final swap of halves before FP (R16 || L16).',
        left: swapHex.slice(0, 8),
        right: swapHex.slice(8),
        key: '',
        output: swapHex,
      }
    }
    return {
      title: 'Final Permutation (FP)',
      description: 'Apply FP to produce the 64-bit ciphertext block.',
      left: result.fpOutput.slice(0, 8),
      right: result.fpOutput.slice(8),
      key: '',
      output: result.outputHex,
    }
  }

  const expectedQuizOutput = useMemo(() => {
    if (!plainValidation.valid || !keyValidation.valid) return null
    if (selectedMode === 'encrypt') return des_encrypt(plainValidation.hex, keyValidation.hex).outputHex
    return des_decrypt(plainValidation.hex, keyValidation.hex).outputHex
  }, [keyValidation.valid, keyValidation.hex, plainValidation.valid, plainValidation.hex, selectedMode])
  const teacherAllowed = !hasApi || Boolean(authToken)

  const handleAutoDiagnose = () => {
    if (!plainValidation.valid || !keyValidation.valid) {
      setGradingError('Provide a valid 64-bit plaintext and key before grading.')
      return
    }
    if (!studentAnswerHex.trim()) {
      setGradingError('Enter the student ciphertext (hex).')
      return
    }
    setGradingError(null)
    const basePlain = plainValidation.hex
    const baseKey = keyValidation.hex
    const diagnosis =
      selectedMode === 'encrypt'
        ? diagnoseDESSubmission({
            plaintextHex: basePlain,
            keyHex: baseKey,
            studentOutputHex: studentAnswerHex,
          })
        : diagnoseDESSubmission({
            plaintextHex: studentAnswerHex, // treat student answer as ciphertext input for decrypt grading
            keyHex: baseKey,
            studentOutputHex: basePlain,
          })
    setDiagnosisResult(diagnosis)
    const q1 = diagnosis.score
    const totalPercent = q1 * 100
    const letter = letterForScore(totalPercent)
    const row: GradeRow = {
      studentId: studentId || 'student',
      name: studentName || 'Unknown',
      examId,
      version: versionLabel,
      q1,
      q2: 0,
      q3: 0,
      total: totalPercent,
      diagnosis: `${diagnosis.message} (Score ${totalPercent}%)`,
      letter_grade: letter,
    }
    setPendingGrade(row)
    setShowGradeModal(true)
    if (hasApi && authToken) {
      api
        .saveRun({
          mode: selectedMode,
          inputHex: selectedMode === 'encrypt' ? plainValidation.hex : studentAnswerHex,
          keyHex: keyValidation.hex,
          outputHex: selectedMode === 'encrypt' ? studentAnswerHex : plainValidation.hex,
        })
        .catch((error) => console.warn('Run save failed', error))
    }
  }

  const loadTestVector = (vector: any) => {
    // Set the mode
    setDesMode(vector.mode)

    // Set the key
    setKeyFormat('hex')
    setKeyValue(vector.keyHex)

    // Set the plaintext/input
    if (vector.inputHex) {
      setInputKind('hex')
      setPlaintextFormat('hex')
      setPlaintext(vector.inputHex)
    } else if (vector.inputText) {
      setInputKind('text')
      setTextInput(vector.inputText)
    }

    // Set IV if present (for non-ECB modes)
    if (vector.iv) {
      setIvInput(vector.iv)
    } else {
      setIvInput('')
    }

    // Set active mode to encrypt
    setActiveMode('encrypt')

    // Optionally switch to the main tab
    setActiveTab('encrypt')
  }

  const loadGraderErrorCase = (errorCase: any) => {
    // Set the mode
    setDesMode(errorCase.mode as DesMode)

    // Set the key
    setKeyFormat('hex')
    setKeyValue(errorCase.key)

    // Determine if this is encrypt or decrypt based on which field is present
    if (errorCase.plaintext) {
      // Encrypt case
      setInputKind('hex')
      setPlaintextFormat('hex')
      setPlaintext(errorCase.plaintext)
      setActiveMode('encrypt')
    } else if (errorCase.ciphertext) {
      // Decrypt case
      setInputKind('hex')
      setPlaintextFormat('hex')
      setPlaintext(errorCase.ciphertext)
      setActiveMode('decrypt')
    }

    // Set IV if present (for non-ECB modes)
    if (errorCase.iv) {
      setIvInput(errorCase.iv)
    } else {
      setIvInput('')
    }

    // Switch to the main tab
    setActiveTab('encrypt')
  }

  const handleAuth = async () => {
    if (!hasApi) {
      setGradingError('API URL not configured; cannot authenticate.')
      return
    }
    const isSignup = authMode === 'signup'
    if (!authEmail.trim() || !authPassword.trim() || (isSignup && !authName.trim())) {
      setGradingError(
        isSignup
          ? 'Add your name, email, and password to create an account.'
          : 'Please enter your email and password.',
      )
      return
    }
    setAuthBusy(true)
    setGradingError(null)
    try {
      const email = authEmail.trim()
      const name = authName.trim() || email.split('@')[0]
      const res =
        isSignup ? await api.signup(name, email, authPassword) : await api.login(email, authPassword)
      setAuthTokenState(res.token)
      setAuthToken(res.token)
      localStorage.setItem(STORAGE_KEYS.token, res.token)
      setIntroLoader(true)
      setTimeout(() => setIntroLoader(false), 900)
    } catch (error) {
      setGradingError(isSignup ? 'Signup failed. Try a different email or password.' : 'Login failed. Check credentials.')
    } finally {
      setAuthBusy(false)
    }
  }

  const handleLogout = () => {
    setAuthTokenState(null)
    setAuthToken(null)
    localStorage.removeItem(STORAGE_KEYS.token)
  }

  if (hasApi && !authToken) {
    const isSignup = authMode === 'signup'
    const authDisabled =
      authBusy ||
      (isSignup
        ? !authName.trim() || !authEmail.trim() || !authPassword.trim()
        : !authEmail.trim() || !authPassword.trim())
    return (
      <div
        className={cn(
          'relative min-h-screen overflow-hidden',
          theme === 'dark' ? 'bg-slate-950 text-slate-50' : 'bg-[#f7f9fc] text-slate-900',
        )}
      >
        <div className="pointer-events-none absolute inset-0 opacity-90">
          <div
            className={cn(
              'absolute -left-24 top-0 h-80 w-80 rounded-full blur-3xl',
              theme === 'dark' ? 'bg-primary/20' : 'bg-primary/15',
            )}
          />
          <div
            className={cn(
              'absolute right-0 top-10 h-96 w-96 rounded-full blur-3xl',
              theme === 'dark' ? 'bg-secondary/20' : 'bg-secondary/15',
            )}
          />
          <div
            className={cn(
              'absolute inset-x-0 bottom-0 h-64',
              theme === 'dark'
                ? 'bg-gradient-to-t from-slate-950 via-slate-950/60 to-transparent'
                : 'bg-gradient-to-t from-white/70 via-white/40 to-transparent',
            )}
          />
        </div>

        <div className="relative mx-auto flex max-w-6xl flex-col gap-10 px-6 py-12 lg:flex-row lg:items-center">
          <div className="space-y-6 lg:w-7/12">
            <Badge
              variant="outline"
              className={cn(
                'text-xs',
                theme === 'dark' ? 'border-white/10 bg-white/5 text-white' : 'border-slate-300 bg-white text-slate-700',
              )}
            >
              DES Faculty Portal
            </Badge>
            <h1 className={cn('text-4xl font-semibold leading-tight sm:text-5xl', theme === 'dark' ? 'text-white' : 'text-slate-900')}>
              Secure access to the DES grading console
            </h1>
            <p className={cn('max-w-2xl text-sm leading-relaxed sm:text-base', theme === 'dark' ? 'text-slate-300' : 'text-slate-600')}>
              Manage rosters, benchmark avalanche effects, and export grades from a modern grading console built for the
              course.
            </p>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div
                className={cn(
                  'rounded-2xl border p-4 shadow-lg shadow-blue-500/10',
                  theme === 'dark' ? 'border-slate-800/80 bg-slate-900/70' : 'border-slate-200/80 bg-white/90 text-slate-800',
                )}
              >
                <div className={cn('flex items-center justify-between text-xs', theme === 'dark' ? 'text-slate-400' : 'text-slate-500')}>
                  <span className={cn('flex items-center gap-2', theme === 'dark' ? 'text-slate-200' : 'text-slate-800')}>
                    <Sparkles className={cn('h-4 w-4', theme === 'dark' ? 'text-secondary' : 'text-primary')} />
                    DES Lab Platform
                  </span>
                  <span
                    className={cn(
                      'rounded-full px-2 py-1 text-[10px] uppercase tracking-wide',
                      theme === 'dark' ? 'bg-secondary/20 text-secondary' : 'bg-secondary/15 text-secondary',
                    )}
                  >
                    Live
                  </span>
                </div>
                <p className={cn('mt-3 text-2xl font-semibold', theme === 'dark' ? 'text-white' : 'text-slate-900')}>Comprehensive learning</p>
                <p className={cn('text-xs', theme === 'dark' ? 'text-slate-400' : 'text-slate-600')}>
                  Interactive DES encryption, step-by-step visualization, and automated grading system.
                </p>
              </div>

               <div
                 className={cn(
                   'rounded-2xl border p-4 shadow-lg shadow-emerald-500/10',
                   theme === 'dark'
                     ? 'border-slate-800/80 bg-gradient-to-br from-slate-900/80 via-slate-900/70 to-slate-900/40'
                     : 'border-slate-200/80 bg-gradient-to-br from-white via-white to-white',
                 )}
               >
                 <div className={cn('flex items-center justify-between text-xs', theme === 'dark' ? 'text-slate-400' : 'text-slate-500')}>
                   <span className={cn('flex items-center gap-2', theme === 'dark' ? 'text-slate-200' : 'text-slate-800')}>
                     <Zap className={cn('h-4 w-4 text-primary')} />
                     DES lab experience
                   </span>
                   <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-primary">
                     <span className="h-2 w-2 rounded-full bg-primary animate-pulse" />
                     Live
                   </span>
                 </div>
                 <p className={cn('mt-3 text-2xl font-semibold', theme === 'dark' ? 'text-white' : 'text-slate-900')}>
                   Interactive visualizations
                 </p>
                 <p className={cn('text-xs', theme === 'dark' ? 'text-slate-400' : 'text-slate-600')}>
                   Explore rounds, key schedule, avalanche effect, and grading tools from a single modern dashboard.
                 </p>
               </div>
            </div>

            <div className={cn('flex flex-wrap items-center gap-3 text-xs sm:text-sm', theme === 'dark' ? 'text-slate-400' : 'text-slate-600')}>
              <div
                className={cn(
                  'flex items-center gap-2 rounded-full px-3 py-2',
                  theme === 'dark' ? 'bg-slate-900/60' : 'bg-white/80 border border-slate-200',
                )}
              >
                <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>Backend reachable & secure</span>
              </div>
              <div
                className={cn(
                  'flex items-center gap-2 rounded-full px-3 py-2',
                  theme === 'dark' ? 'bg-slate-900/60' : 'bg-white/80 border border-slate-200',
                )}
              >
                <Sparkles className="h-4 w-4 text-primary" />
                <span>Modern UI tuned for DES lab</span>
              </div>
            </div>
          </div>

          <div className="lg:w-5/12">
            <div
              className={cn(
                'rounded-3xl border p-6 shadow-2xl backdrop-blur',
                theme === 'dark'
                  ? 'border-slate-800/70 bg-slate-900/80 shadow-primary/20'
                  : 'border-slate-200 bg-white/95 shadow-primary/10 text-slate-900',
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className={cn('text-[11px] uppercase tracking-[0.3em]', theme === 'dark' ? 'text-slate-500' : 'text-slate-500')}>
                    Auth console
                  </p>
                  <p className={cn('text-lg font-semibold', theme === 'dark' ? 'text-white' : 'text-slate-900')}>
                    {isSignup ? 'Create secure credentials' : 'Welcome back'}
                  </p>
                  <p className={cn('text-xs', theme === 'dark' ? 'text-slate-400' : 'text-slate-600')}>
                    {isSignup ? 'Provision a secure teacher account with API-backed signup.' : 'Authenticate to unlock grading and roster tools.'}
                  </p>
                </div>
                <div
                  className={cn(
                    'flex items-center gap-1 rounded-full border p-1',
                    theme === 'dark' ? 'border-slate-800 bg-slate-950/70' : 'border-slate-200 bg-white',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setAuthMode('signin')
                      setGradingError(null)
                    }}
                    className={cn(
                      'flex items-center gap-2 rounded-full px-3 py-2 text-xs font-semibold transition',
                      !isSignup
                        ? theme === 'dark'
                          ? 'bg-primary/20 text-white shadow-glow shadow-primary/30'
                          : 'bg-primary/10 text-slate-900 shadow-primary/20'
                        : theme === 'dark'
                          ? 'text-slate-400 hover:text-white'
                          : 'text-slate-500 hover:text-slate-900',
                    )}
                  >
                    <LogIn className="h-4 w-4" />
                    Sign in
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAuthMode('signup')
                      setGradingError(null)
                    }}
                    className={cn(
                      'flex items-center gap-2 rounded-full px-3 py-2 text-xs font-semibold transition',
                      isSignup
                        ? theme === 'dark'
                          ? 'bg-secondary/20 text-white shadow-glow shadow-secondary/30'
                          : 'bg-secondary/10 text-slate-900 shadow-secondary/20'
                        : theme === 'dark'
                          ? 'text-slate-400 hover:text-white'
                          : 'text-slate-500 hover:text-slate-900',
                    )}
                  >
                    <UserPlus className="h-4 w-4" />
                    Sign up
                  </button>
                </div>
              </div>

              <div className="mt-6 space-y-4">
                {isSignup && (
                  <div className="space-y-2">
                    <div className={cn('flex items-center justify-between text-xs', theme === 'dark' ? 'text-slate-400' : 'text-slate-600')}>
                      <span>Full name</span>
                      <span className={cn(theme === 'dark' ? 'text-slate-500' : 'text-slate-500')}>Visible in roster sync</span>
                    </div>
                    <Input value={authName} onChange={(e) => setAuthName(e.target.value)} placeholder="Dr. Jane Smith" />
                  </div>
                )}
                <div className="space-y-2">
                  <div className={cn('flex items-center justify-between text-xs', theme === 'dark' ? 'text-slate-400' : 'text-slate-600')}>
                    <span>Email</span>
                    <span className={cn(theme === 'dark' ? 'text-slate-500' : 'text-slate-500')}>Use your faculty address</span>
                  </div>
                  <Input
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    placeholder="you@example.edu"
                    type="email"
                  />
                </div>
                <div className="space-y-2">
                  <div className={cn('flex items-center justify-between text-xs', theme === 'dark' ? 'text-slate-400' : 'text-slate-600')}>
                    <span>Password</span>
                    <span className={cn(theme === 'dark' ? 'text-slate-500' : 'text-slate-500')}>Min 8 characters</span>
                  </div>
                  <Input
                    type="password"
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    placeholder="********"
                  />
                </div>
              </div>

              {gradingError && (
                <div
                  className={cn(
                    'mt-4 rounded-xl border px-3 py-2 text-xs',
                    theme === 'dark'
                      ? 'border-red-500/30 bg-red-500/10 text-red-200'
                      : 'border-red-300 bg-red-50 text-red-700',
                  )}
                >
                  {gradingError}
                </div>
              )}

              <Button
                className={cn(
                  'mt-5 h-12 w-full bg-gradient-to-r from-primary via-primary to-secondary text-base font-semibold shadow-lg transition hover:translate-y-[-1px]',
                  theme === 'dark' ? 'shadow-primary/30 text-white' : 'shadow-primary/20 text-white',
                )}
                onClick={handleAuth}
                disabled={authDisabled}
              >
                {authBusy ? (isSignup ? 'Creating account...' : 'Signing in...') : isSignup ? 'Create account' : 'Sign in'}
              </Button>

              <div className="mt-4 flex items-center justify-between text-xs text-slate-400">
                <div className="flex items-center gap-2">
                  <div className="h-7 w-7 rounded-xl border border-slate-800 bg-slate-900/80 text-center text-[10px] font-semibold uppercase tracking-wide text-primary">
                    DES
                  </div>
                  <span>Encrypted API channel with token hand-off.</span>
                </div>
                <button
                  type="button"
                  className="text-xs font-semibold text-primary hover:text-secondary"
                  onClick={() => {
                    setAuthMode(isSignup ? 'signin' : 'signup')
                    setGradingError(null)
                  }}
                >
                  {isSignup ? 'Already have access? Sign in' : 'Need an account? Sign up'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('app-gradient min-h-screen', theme === 'dark' ? 'theme-dark bg-slate-950 text-slate-50' : 'theme-light bg-slate-50 text-slate-900')}>
      <header className="relative md:sticky md:top-0 z-30 border-b border-slate-800/60 bg-slate-900/70 px-3 py-3 md:px-4 md:py-4 backdrop-blur glass">
        <div className="mx-auto flex max-w-7xl flex-wrap items-start justify-between gap-3 md:items-center">
          <div className="space-y-1">
            <p className="text-[10px] md:text-xs uppercase tracking-[0.25em] text-slate-400">Interactive DES Lab</p>
            <h1 className="text-xl font-bold text-white md:text-2xl">Comprehensive DES Teaching Environment</h1>
            <p className="text-xs text-slate-400 md:text-sm">
              Feistel structure • IP/FP • S-boxes • Key schedule • Avalanche • Security notes
            </p>
            <p className="text-[10px] text-slate-500">Course: EECE 455 — Team: Haya Karanouh · Zeinab Harb · Maya Zeaiter · Omar Obeid</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-300 md:text-xs">
            <Button
              size="sm"
              variant="outline"
              className="flex items-center gap-1"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </Button>
            {authToken && (
              <Button
                size="sm"
                variant="outline"
                className="flex items-center gap-1"
                onClick={handleLogout}
              >
                <LogOut size={14} />
                Logout
              </Button>
            )}
            <Badge variant={activeMode === 'encrypt' ? 'default' : 'secondary'}>
              {activeMode === 'encrypt' ? 'Encrypt' : 'Decrypt'}
            </Badge>
            <Badge variant="secondary">Rounds: 16</Badge>
            <Badge variant="outline">Block: 64 bits</Badge>
            <Button
              size="sm"
              variant="outline"
              className="flex items-center gap-1"
              onClick={() => exportResultAsPdf(latestResult)}
              disabled={!latestResult}
              aria-label="Export latest DES run as PDF"
            >
              <Download size={14} /> Export PDF
            </Button>
          </div>
        </div>
      </header>

      {/* Main split layout: left mission control, right tabbed content */}
      <main className="mx-auto grid max-w-7xl gap-4 px-3 py-4 md:gap-6 md:px-4 md:py-6 lg:grid-cols-[360px_1fr]">
        <aside className="space-y-4 rounded-2xl border border-slate-800/80 bg-slate-900/70 p-3 shadow-sm shadow-black/30 glass card-hover md:p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Mission Control</h2>
            <Badge
              variant="outline"
              className={activeMode === 'encrypt' ? 'border-primary/50 text-primary' : 'border-secondary/50 text-secondary'}
            >
              {activeMode === 'encrypt' ? 'Encrypt' : 'Decrypt'}
            </Badge>
          </div>
          <p className="text-xs text-slate-400">Enter plaintext/key, pick format, load presets, and run DES.</p>

          <div className="flex flex-wrap gap-2">
            {(
              [
                { id: 'binary', label: 'Binary', hint: '64-bit blocks' },
                { id: 'hex', label: 'Hex', hint: '16 hex chars' },
                { id: 'text', label: 'Text', hint: 'UTF-8' },
                { id: 'file', label: 'File', hint: 'Binary' },
              ] satisfies { id: InputKind; label: string; hint: string }[]
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  setInputKind(option.id)
                  setPlaintextFormat(option.id === 'binary' ? 'binary' : 'hex')
                  setActiveMode('encrypt')
                  setError(null)
                }}
                className={cn(
                  'flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold transition',
                  inputKind === option.id
                    ? 'border-primary/60 bg-primary/15 text-primary'
                    : 'border-slate-700 bg-slate-900/60 text-slate-200 hover:border-primary/40',
                )}
              >
                <span>{option.label}</span>
                <span className="text-[10px] text-slate-400">{option.hint}</span>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-slate-300">DES mode:</span>
            <select
              className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-primary/60"
              value={desMode}
              onChange={(e) => setDesMode(e.target.value as DesMode)}
            >
              <option value="ECB">ECB (patterns visible)</option>
              <option value="CBC">CBC (chain blocks)</option>
              <option value="CFB">CFB (feedback keystream)</option>
              <option value="OFB">OFB (keystream)</option>
              <option value="CTR">CTR (counter)</option>
            </select>
            <span className="text-[10px] text-slate-500">Non-ECB prepends IV/nonce to output.</span>
          </div>

          <div className="flex items-center gap-2 rounded-xl border border-slate-800/70 bg-slate-950/60 p-3 text-sm">
            <span className="text-slate-300">Mode:</span>
            <Button
              size="sm"
              variant={activeMode === 'encrypt' ? 'default' : 'outline'}
              onClick={() => {
                setActiveMode('encrypt')
                setActiveTab('encrypt')
              }}
            >
              Encrypt
            </Button>
            <Button
              size="sm"
              variant={activeMode === 'decrypt' ? 'secondary' : 'outline'}
              onClick={() => {
                setActiveMode('decrypt')
                setActiveTab('decrypt')
              }}
            >
              Decrypt
            </Button>
          </div>

          {(inputKind === 'binary' || inputKind === 'hex') && (
            <div className="space-y-3 rounded-xl border border-slate-800/70 bg-slate-950/50 p-3">
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold">{inputLabel}</span>
              </div>
              <Input
                value={plainValidation.display}
                onChange={(event) => handlePlaintextChange(event.target.value)}
                placeholder={
                  plaintextFormat === 'binary'
                    ? activeMode === 'encrypt'
                      ? 'Binary plaintext (multiples of 64 bits)'
                      : 'Binary ciphertext (multiples of 64 bits with IV for some modes)'
                    : activeMode === 'encrypt'
                      ? 'Hex plaintext (multiples of 16 chars)'
                      : 'Hex ciphertext (IV+data in hex)'
                }
              />
              <div className="flex flex-wrap items-center justify-between text-xs text-slate-400">
                <span>{plainValidation.helper}</span>
                <span>
                  {plainValidation.display.length}
                  {plaintextFormat === 'binary' ? ' bits' : ' hex chars'}
                </span>
              </div>
              <div className="rounded-lg bg-slate-900/80 p-2 text-[12px] text-slate-300 overflow-auto">
                <p className="font-semibold text-slate-400">Hex</p>
                <p className="font-mono text-sm text-white">{plainValidation.hex}</p>
                <div className="mt-1 text-slate-400">
                  Binary:
                  <div className="mt-1 font-mono text-[10px] leading-4 break-all whitespace-pre-wrap">
                    {plainValidation.binary || '—'}
                  </div>
                </div>
              </div>
            </div>
          )}

          {inputKind === 'text' && (
            <div className="space-y-3 rounded-xl border border-slate-800/70 bg-slate-950/50 p-3">
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold">Text (UTF-8)</span>
                <Badge variant="outline">PKCS#7 padded</Badge>
              </div>
              <textarea
                value={textInput}
                onChange={(event) => setTextInput(event.target.value)}
                placeholder="Type or paste text to encrypt."
                className="min-h-[120px] w-full rounded-xl border border-slate-800 bg-slate-900/70 p-3 text-sm text-white placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
              />
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Will be UTF-8 encoded and padded to 8-byte DES blocks.</span>
                <span>{textInput.length} chars</span>
              </div>
              {activeMode === 'decrypt' && (
                <div className="space-y-2 rounded-lg border border-slate-800/70 bg-slate-900/60 p-3">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>Ciphertext input</span>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant={textCipherEncoding === 'hex' ? 'default' : 'outline'}
                        onClick={() => setTextCipherEncoding('hex')}
                      >
                        HEX
                      </Button>
                      <Button
                        size="sm"
                        variant={textCipherEncoding === 'base64' ? 'default' : 'outline'}
                        onClick={() => setTextCipherEncoding('base64')}
                      >
                        Base64
                      </Button>
                    </div>
                  </div>
                  <Input
                    value={textCipherInput}
                    onChange={(event) => setTextCipherInput(event.target.value)}
                    placeholder={textCipherEncoding === 'hex' ? 'Ciphertext in hex' : 'Ciphertext in Base64'}
                  />
                  <p className="text-[11px] text-slate-500">DES ECB for lab use only; expect PKCS#7 padding.</p>
                </div>
              )}
            </div>
          )}

          {inputKind === 'file' && (
            <div className="space-y-3 rounded-xl border border-slate-800/70 bg-slate-950/50 p-3">
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold">File (binary)</span>
                <Badge variant="outline">Client-side only</Badge>
              </div>
              <input
                type="file"
                className="w-full text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-primary/20 file:px-3 file:py-2 file:text-primary"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  void handleFileSelection(file ?? null)
                }}
              />
              <p className="text-xs text-slate-400">
                Files are read in-browser, padded to 8-byte blocks with PKCS#7, and encrypted block-by-block using DES
                (ECB for teaching).
              </p>
              {fileName && (
                <div className="rounded-lg border border-slate-800/70 bg-slate-900/70 p-3 text-xs text-slate-300">
                  <p className="font-semibold text-white">{fileName}</p>
                  <p>{fileBytes ? `${fileBytes.length} bytes` : 'Pending read'}</p>
                </div>
              )}
            </div>
          )}

          <div className="space-y-3 rounded-xl border border-slate-800/70 bg-slate-950/50 p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold">Key type</span>
              <div className="flex gap-2">
                {(
                  [
                    { id: 'binary', label: 'BIN' },
                    { id: 'hex', label: 'HEX' },
                    { id: 'text', label: 'TEXT' },
                  ] satisfies { id: KeyFormat; label: string }[]
                ).map((mode) => (
                  <Button
                    key={mode.id}
                    variant={keyFormat === mode.id ? 'secondary' : 'outline'}
                    size="sm"
                    onClick={() => {
                      setKeyFormat(mode.id)
                      setError(null)
                    }}
                  >
                    {mode.label}
                  </Button>
                ))}
              </div>
            </div>
            {keyFormat === 'text' ? (
              <Input
                value={keyValidation.display}
                onChange={(event) => handleKeyChange(event.target.value)}
                placeholder="Enter a text key (e.g., password)"
              />
            ) : (
              <Input
                value={keyValidation.display}
                onChange={(event) => handleKeyChange(event.target.value)}
                placeholder={keyFormat === 'binary' ? '64 binary digits' : '16 hex chars'}
              />
            )}
            <div className="flex flex-wrap items-center justify-between text-xs text-slate-400">
              <span>{keyValidation.helper}</span>
              <span>
                {keyValidation.display.length}
                {keyFormat === 'binary' ? '/64 bits' : keyFormat === 'hex' ? '/16 hex' : ' chars'}
              </span>
            </div>
            <div className="rounded-lg bg-slate-900/80 p-2 text-[12px] text-slate-300 space-y-2">
              <div>
                <p className="font-semibold text-slate-400">Derived key (hex)</p>
                <p className="font-mono text-sm text-white">{keyValidation.hex}</p>
              </div>
              <div>
                <p className="font-semibold text-slate-400">Parity-dropped key</p>
                <p className="font-mono text-sm text-white">{effectiveKey ?? '—'}</p>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <Badge variant={keyStrength.label === 'Weak' ? 'destructive' : 'secondary'}>
                  {keyStrength.label}
                </Badge>
                <span className="text-xs text-slate-400">Score: {keyStrength.score}</span>
              </div>
            </div>
          </div>

          {desMode !== 'ECB' && (
            <div className="space-y-3 rounded-xl border border-slate-800/70 bg-slate-950/50 p-3">
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold">IV / Nonce (Optional)</span>
                <span className="text-[10px] text-slate-400">16 hex chars (8 bytes)</span>
              </div>
              <Input
                value={ivInput}
                onChange={(event) => setIvInput(event.target.value)}
                placeholder="e.g., 0001020304050607 (leave empty for random)"
              />
              <div className="text-xs text-slate-400">
                {ivInput.trim() === '' ? (
                  <span>Empty - will use random IV for encryption</span>
                ) : ivInput.length === 16 && /^[0-9a-fA-F]{16}$/.test(ivInput) ? (
                  <span className="text-green-400">✓ Valid IV (16 hex chars)</span>
                ) : (
                  <span className="text-red-400">✗ Must be exactly 16 hex characters</span>
                )}
              </div>
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              onClick={() => runProcess(activeMode)}
              disabled={(!canEncrypt && activeMode === 'encrypt') || (!canDecrypt && activeMode === 'decrypt') || isProcessing}
            >
              {activeMode === 'encrypt' ? (
                <>
                  <Play size={16} /> Encrypt
                </>
              ) : (
                <>
                  <RefreshCw size={16} /> Decrypt
                </>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setPlaintext(DES_PRESETS.basic.plaintext)
                setKeyValue(DES_PRESETS.basic.key)
                setPlaintextFormat('hex')
                setInputKind('hex')
                setKeyFormat('hex')
                setTextInput('')
                setTextCipherInput('')
                setTextCipherHex('')
                setTextCipherBase64('')
                setTextPlainOutput('')
                setFileBytes(null)
                setFileCipherBytes(null)
                setFilePlainBytes(null)
                setFileName('')
                setFileOutputName('')
                setCurrentResult(null)
                setAvalancheDiffs(null)
                setMutatedResult(null)
              }}
            >
              Reset
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setKeyFormat('hex')
                setKeyValue(randomHex64())
              }}
            >
              <Shuffle size={16} /> Random key
            </Button>
          </div>
        </aside>

        {/* Right rail: tabbed teaching content */}
        <section className="space-y-4 pb-16 md:pb-0">
          {/* Tab dock - fixed at bottom on mobile, inline on desktop */}
          <div className="fixed bottom-0 left-0 right-0 z-20 bg-slate-900/95 border-t border-slate-800/60 p-2 backdrop-blur md:relative md:z-0 md:border-t-0 md:border-b md:border-slate-800/60 md:bg-transparent md:p-0 md:pb-2">
            <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide md:flex-wrap">
              {(Object.keys(TAB_LABELS) as TabId[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                    className={cn(
                      'shrink-0 rounded-full px-3 py-1.5 border text-[11px] md:text-xs transition whitespace-nowrap',
                      activeTab === id
                        ? 'border-primary/70 bg-primary/10 text-primary'
                        : theme === 'light'
                          ? 'border-slate-300 bg-white/80 text-slate-700 hover:border-primary/50'
                          : 'border-slate-700 bg-slate-800 text-slate-300 hover:border-primary/40',
                    )}
                  >
                    {TAB_LABELS[id]}
                  </button>
                ))}
            </div>
          </div>

          <Card className="glass card-hover">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="text-secondary" /> Results & Metrics
              </CardTitle>
              <CardDescription>View latest ciphertext, timing, and quick actions.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-slate-200 overflow-hidden">
              {inputKind === 'text' ? (
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3 space-y-3">
                  <div className="flex items-center justify-between text-xs uppercase tracking-wide text-slate-400">
                    <span>Ciphertext</span>
                    <span>Hex & Base64 views</span>
                  </div>
                  <div className="space-y-2">
                    <p className="text-[12px] text-slate-400">Hex</p>
                    <div className="rounded-lg border border-slate-800/70 bg-slate-900/70 p-2 font-mono text-xs text-white break-all">
                      {textCipherHex || currentResult?.outputHex || '—'}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex items-center gap-2"
                      onClick={() => navigator.clipboard?.writeText(textCipherHex || '')}
                      disabled={!textCipherHex}
                    >
                      <Copy size={14} /> Copy hex
                    </Button>
                  </div>
                  <div className="space-y-2">
                    <p className="text-[12px] text-slate-400">Base64</p>
                    <div className="rounded-lg border border-slate-800/70 bg-slate-900/70 p-2 font-mono text-xs text-white break-all">
                      {textCipherBase64 || '—'}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex items-center gap-2"
                      onClick={() => navigator.clipboard?.writeText(textCipherBase64 || '')}
                      disabled={!textCipherBase64}
                    >
                      <Copy size={14} /> Copy Base64
                    </Button>
                  </div>
                  <div className="space-y-2">
                    <p className="text-[12px] uppercase tracking-wide text-slate-400">Plaintext (UTF-8)</p>
                    <div className="rounded-lg border border-slate-800/70 bg-slate-900/70 p-2 text-sm text-white min-h-[60px]">
                      {textPlainOutput || (activeMode === 'encrypt' ? textInput : '—')}
                    </div>
                  </div>
                </div>
              ) : inputKind === 'file' ? (
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3 space-y-3">
                  <div className="flex items-center justify-between text-xs uppercase tracking-wide text-slate-400">
                    <span>File actions</span>
                    <span>{fileOutputName || fileName || 'No file selected'}</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleFileDownload}
                    disabled={!fileCipherBytes && !filePlainBytes}
                    className="w-full sm:w-auto"
                  >
                    <Download size={14} />{' '}
                    {fileCipherBytes
                      ? 'Download encrypted'
                      : filePlainBytes
                        ? 'Download decrypted'
                        : 'Download'}
                  </Button>
                  <p className="text-[11px] text-slate-500">
                    A simple header preserves the original filename before padding; downloads stay on this device.
                  </p>
                  {(fileCipherBytes || filePlainBytes) && (
                    <div className="rounded-lg border border-slate-800/70 bg-slate-900/70 p-3 text-xs text-slate-300">
                      <p className="font-semibold text-white">Preview (first 64 hex chars)</p>
                      <p className="font-mono break-all text-[11px] text-primary">
                        {bytesToHex((fileCipherBytes ?? filePlainBytes ?? new Uint8Array()).slice(0, 32))}
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs uppercase tracking-wide text-slate-400">Output Format</span>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant={outputFormat === 'hex' ? 'default' : 'outline'}
                        onClick={() => setOutputFormat('hex')}
                        className="h-6 px-2 text-xs"
                      >
                        HEX
                      </Button>
                      <Button
                        size="sm"
                        variant={outputFormat === 'binary' ? 'default' : 'outline'}
                        onClick={() => setOutputFormat('binary')}
                        className="h-6 px-2 text-xs"
                      >
                        BIN
                      </Button>
                    </div>
              </div>
              <p className="overflow-hidden">
                {activeMode === 'encrypt' ? 'Plaintext' : 'Ciphertext'} ({outputFormat}):{' '}
                <span className="font-mono text-white break-all whitespace-pre-wrap">
                  {outputFormat === 'hex'
                    ? currentResult?.inputHex ?? plainValidation.hex
                    : hexToBinaryString(currentResult?.inputHex ?? plainValidation.hex)}
                </span>
              </p>
              <p className="mt-2 overflow-hidden">
                {outputLabel}:{' '}
                <span className="font-mono text-primary break-all whitespace-pre-wrap">
                  {currentResult
                    ? outputFormat === 'hex'
                      ? currentResult.outputHex
                      : ciphertextBinary
                    : '—'}
                </span>
              </p>
              {desMode !== 'ECB' && (inputKind === 'binary' || inputKind === 'hex') && lastCipherHex && (
                <div className="mt-3 space-y-1 text-xs text-slate-300">
                  <p>
                    IV/Nonce (hex): <span className="font-mono text-white break-all">{lastIvHex ?? '—'}</span>
                  </p>
                  <p>
                    Ciphertext w/ IV (hex): <span className="font-mono text-white break-all">{lastCipherHex}</span>
                  </p>
                  <p className="text-slate-400">Include the IV prefix when decrypting non-ECB modes.</p>
                </div>
              )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={copyCiphertext} disabled={!currentResult}>
                      <Copy size={14} /> Copy
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={useCiphertextAsInput}
                      disabled={!currentResult && !lastCipherHex}
                    >
                      Use for decryption
                    </Button>
                  </div>
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-slate-800/60 bg-slate-900/60 p-3 text-center">
                  <p className="text-xs uppercase tracking-widest text-slate-500">Execution Time</p>
                  <p className="text-xl font-semibold text-white">
                    {executionTime ? `${executionTime.toFixed(2)}ms` : '—'}
                  </p>
                </div>
                <div className="rounded-2xl border border-slate-800/60 bg-slate-900/60 p-3 text-center">
                  <p className="text-xs uppercase tracking-widest text-slate-500">Rounds</p>
                  <p className="text-xl font-semibold text-white">{currentResult?.rounds.length ?? 0}</p>
                </div>
                <div className="rounded-2xl border border-slate-800/60 bg-slate-900/60 p-3 text-center">
                  <p className="text-xs uppercase tracking-widest text-slate-500">Mode</p>
                  <p className="text-xl font-semibold text-white">
                    {activeMode === 'decrypt' ? 'Decrypt' : 'Encrypt'}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {activeTab === 'overview' && (
            <div className="space-y-4">
              <Card className="glass card-hover">
                <CardHeader>
                  <CardTitle>DES Overview</CardTitle>
                  <CardDescription>High-level data path and key schedule.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="h-[220px] rounded-2xl border border-slate-800/70 bg-slate-950/60 p-4">
                  <ReactFlow nodes={nodes} edges={FLOW_EDGES} fitView nodesDraggable={false}>
                    <Background />
                  </ReactFlow>
                </div>
                <p className="text-sm text-slate-300">
                  DES encrypts 64-bit blocks with a 56-bit effective key across 16 Feistel rounds. IP/FP permute bits,
                  each round uses expansion, S-box substitution, and P permutation, then halves swap.
                </p>
              </CardContent>
            </Card>
          </div>
        )}

          {activeTab === 'encrypt' && (
            <Card className="glass card-hover">
              <CardHeader>
                <CardTitle>Encryption Flow</CardTitle>
                <CardDescription>Walk IP → 16 rounds → swap → FP.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-3 text-xs md:text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-400">Step</span>
                  <input
                    type="range"
                    min={0}
                    max={19}
                    value={flowStep}
                    onChange={(event) => setFlowStep(Number(event.target.value))}
                    className="w-full"
                  />
                  <span className="text-xs text-slate-300">{flowStep} / 19</span>
                </div>
                {(() => {
                  const data = getFlowStepData(currentEncryptResult, flowStep)
                  if (!data) return <p className="text-sm text-slate-400">Run encryption to populate this view.</p>
                  return (
                    <div className="grid gap-4 md:grid-cols-[1.1fr_1fr]">
                      <div className="space-y-2 rounded-2xl border border-slate-800/70 bg-slate-950/60 p-3 text-sm text-slate-200 overflow-auto">
                        <p className="text-xs uppercase tracking-wide text-primary">{data.title}</p>
                        <p className="text-slate-300">{data.description}</p>
                        <div className="grid grid-cols-2 gap-2 text-[13px] font-mono">
                          <div className="rounded border border-slate-800/70 bg-slate-900/60 p-2">L: {data.left ?? '—'}</div>
                          <div className="rounded border border-slate-800/70 bg-slate-900/60 p-2">R: {data.right ?? '—'}</div>
                          <div className="rounded border border-slate-800/70 bg-slate-900/60 p-2">K: {data.key || '—'}</div>
                          <div className="rounded border border-slate-800/70 bg-slate-900/60 p-2">Out: {data.output}</div>
                        </div>
                      </div>
                      <div className="rounded-2xl border border-slate-800/70 bg-slate-950/60 p-2 md:p-3 text-xs text-slate-200">
                        <p className="text-xs uppercase tracking-wide text-slate-400">Rounds</p>
                        <div className="mt-2 overflow-auto max-h-[300px] md:max-h-none">
                          <table className="w-full min-w-[320px] md:min-w-[480px] text-[10px] md:text-[12px]">
                            <thead className="text-slate-400 sticky top-0 bg-slate-950/90">
                              <tr>
                                <th className="px-1 md:px-2 py-1 text-left">R</th>
                                <th className="px-1 md:px-2 py-1 text-left">L</th>
                                <th className="px-1 md:px-2 py-1 text-left">R</th>
                                <th className="px-1 md:px-2 py-1 text-left hidden md:table-cell">K</th>
                                <th className="px-1 md:px-2 py-1 text-left">Out</th>
                              </tr>
                            </thead>
                            <tbody>
                              {currentEncryptResult?.rounds.map((round) => (
                                <tr
                                  key={round.round}
                                  className={cn(
                                    'border-t border-slate-800/60',
                                    flowStep - 1 === round.round ? 'bg-primary/10' : '',
                                  )}
                                >
                                  <td className="px-1 md:px-2 py-1">{round.round}</td>
                                  <td className="px-1 md:px-2 py-1 font-mono text-[9px] md:text-[11px]">{round.left}</td>
                                  <td className="px-1 md:px-2 py-1 font-mono text-[9px] md:text-[11px]">{round.right}</td>
                                  <td className="px-1 md:px-2 py-1 font-mono text-[9px] md:text-[11px] hidden md:table-cell">{round.subKey}</td>
                                  <td className="px-1 md:px-2 py-1 font-mono text-[9px] md:text-[11px]">{round.roundOutput}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  )
                })()}
              </CardContent>
            </Card>
          )}

          {activeTab === 'tests' && (
            <Card className="glass card-hover">
              <CardHeader>
                <CardTitle>Test Vectors</CardTitle>
                <CardDescription>Deterministic DES mode vectors and grader mismatch examples.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-sm text-slate-200">
                <div
                  className={cn(
                    'rounded-2xl border border-slate-800/70 p-3 overflow-x-auto',
                    theme === 'light' ? 'bg-white/80 text-slate-800' : 'bg-slate-900/50 text-slate-200',
                  )}
                >
                  <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">Reference vectors</p>
                  <table className="w-full border-collapse text-xs table-fixed">
                    <thead>
                      <tr className={cn('text-left', theme === 'light' ? 'text-slate-900' : 'text-slate-100')}>
                        <th className="border border-slate-800/70 px-2 py-2 w-[16%] break-words">Label</th>
                        <th className="border border-slate-800/70 px-2 py-2 w-[7%]">Mode</th>
                        <th className="border border-slate-800/70 px-2 py-2 w-[13%] break-all">Key</th>
                        <th className="border border-slate-800/70 px-2 py-2 w-[12%] break-all">IV/Nonce</th>
                        <th className="border border-slate-800/70 px-2 py-2 w-[12%] break-all">Input</th>
                        <th className="border border-slate-800/70 px-2 py-2 w-[14%] break-all">Expected (hex)</th>
                        <th className="border border-slate-800/70 px-2 py-2 w-[14%] break-all">Expected (Base64)</th>
                        <th className="border border-slate-800/70 px-2 py-2 w-[12%]">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {referenceVectors.map((v) => (
                        <tr
                          key={v.label}
                          className={cn(
                            'align-top',
                            theme === 'light' ? 'text-slate-800' : 'text-slate-100',
                          )}
                        >
                          <td className="border border-slate-800/70 px-2 py-2 break-words">{v.label}</td>
                          <td className="border border-slate-800/70 px-2 py-2">{v.mode}</td>
                          <td className="border border-slate-800/70 px-2 py-2 font-mono break-words whitespace-pre-wrap">{v.keyDisplay}</td>
                          <td className="border border-slate-800/70 px-2 py-2 font-mono break-words whitespace-pre-wrap">{v.iv ?? '—'}</td>
                          <td className="border border-slate-800/70 px-2 py-2 font-mono break-words whitespace-pre-wrap">{v.inputDisplay}</td>
                          <td className="border border-slate-800/70 px-2 py-2 font-mono break-words whitespace-pre-wrap">{v.expectedHex}</td>
                          <td className="border border-slate-800/70 px-2 py-2 font-mono break-words whitespace-pre-wrap">{v.expectedBase64}</td>
                          <td className="border border-slate-800/70 px-2 py-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => loadTestVector(v)}
                              className="text-[10px] px-2 py-1 h-auto"
                            >
                              Load Test
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div
                  className={cn(
                    'rounded-2xl border border-slate-800/70 p-3',
                    theme === 'light' ? 'bg-white/80 text-slate-800' : 'bg-slate-900/50 text-slate-200',
                  )}
                >
                  <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">Auto-grader error scenarios</p>
                  <div className="space-y-2">
                    {graderErrorCases.map((c) => (
                      <div
                        key={c.case}
                        className={cn(
                          'rounded-xl border border-slate-800/70 bg-slate-900/60 p-3 text-xs',
                          theme === 'light' ? 'text-slate-800' : 'text-slate-200',
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-white">{c.case}</span>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => loadGraderErrorCase(c)}
                            className="text-[10px] px-2 py-1 h-auto"
                          >
                            Load Test
                          </Button>
                        </div>
                        <p className="mt-1">
                          Expected: <span className="font-mono text-primary">{c.expected}</span>
                        </p>
                        <p>
                          Student: <span className="font-mono text-accent">{c.student}</span>
                        </p>
                        <p className="text-slate-400 mt-1">{c.note}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          {activeTab === 'decrypt' && (
            <Card className="glass card-hover">
              <CardHeader>
                <CardTitle>Decryption Flow</CardTitle>
                <CardDescription>Same Feistel rounds; subkeys reversed K16→K1.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-3 text-xs md:text-sm">
                  <span className="text-xs uppercase tracking-wide text-slate-400">Step</span>
                  <input
                    type="range"
                    min={0}
                    max={19}
                    value={decryptFlowStep}
                    onChange={(event) => setDecryptFlowStep(Number(event.target.value))}
                    className="w-full"
                  />
                  <span className="text-xs text-slate-300">{decryptFlowStep} / 19</span>
                </div>
                {(() => {
                  const data = getFlowStepData(currentDecryptResult, decryptFlowStep)
                  if (!data) return <p className="text-sm text-slate-400">Run decryption to populate this view.</p>
                  return (
                    <div className="space-y-2 rounded-2xl border border-slate-800/70 bg-slate-950/60 p-3 text-sm text-slate-200 overflow-auto">
                      <p className="text-xs uppercase tracking-wide text-secondary">{data.title}</p>
                      <p className="text-slate-300">{data.description}</p>
                      <div className="grid grid-cols-2 gap-2 text-[13px] font-mono">
                        <div className="rounded border border-slate-800/70 bg-slate-900/60 p-2">L: {data.left ?? '—'}</div>
                        <div className="rounded border border-slate-800/70 bg-slate-900/60 p-2">R: {data.right ?? '—'}</div>
                        <div className="rounded border border-slate-800/70 bg-slate-900/60 p-2">K: {data.key || '—'}</div>
                        <div className="rounded border border-slate-800/70 bg-slate-900/60 p-2">Out: {data.output}</div>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs font-mono text-slate-200">
                        <div className="rounded bg-slate-900/60 p-2">
                          <p className="text-[11px] text-slate-400">Encryption K1→K16</p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {currentEncryptResult?.subKeys.map((k, idx) => (
                              <Badge key={k} variant="outline" className="bg-slate-950/70">
                                K{idx + 1}: {k}
                              </Badge>
                            ))}
                          </div>
                        </div>
                        <div className="rounded bg-slate-900/60 p-2">
                          <p className="text-[11px] text-slate-400">Decryption K16→K1</p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {currentDecryptResult?.subKeys.map((k, idx) => (
                              <Badge key={k} variant="outline" className="bg-slate-950/70">
                                K{idx + 1}: {k}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })()}
              </CardContent>
            </Card>
          )}

          {activeTab === 'round' && (
            <Card className="glass card-hover">
              <CardHeader>
                <CardTitle>Round Explorer</CardTitle>
                <CardDescription>Inspect a single Feistel round.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-3">
                  <span className="text-xs uppercase tracking-wide text-slate-400">Round</span>
                  <input
                    type="range"
                    min={0}
                    max={15}
                    value={currentRoundIndex}
                    onChange={(event) => setCurrentRoundIndex(Number(event.target.value))}
                    className="w-full"
                  />
                  <span className="text-sm text-slate-300">{currentRoundIndex + 1}</span>
                </div>
                <Progress value={roundProgress} />
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-2xl border border-slate-800/70 bg-slate-950/60 p-3 text-sm text-slate-200 overflow-hidden">
                    <p className="text-xs uppercase tracking-wide text-primary">Round Structure</p>
                    <p className="text-slate-300">Li = Ri-1; Ri = Li-1 XOR F(Ri-1, Ki)</p>
                    <div className="mt-2 grid gap-2 text-[13px] font-mono">
                      <div className="rounded border border-slate-800/70 bg-slate-900/60 p-2">Li-1: {currentRound?.left ?? '—'}</div>
                      <div className="rounded border border-slate-800/70 bg-slate-900/60 p-2">Ri-1: {currentRound?.right ?? '—'}</div>
                      <div className="rounded border border-slate-800/70 bg-slate-900/60 p-2">Ki: {currentRound?.subKey ?? '—'}</div>
                      <div className="rounded border border-slate-800/70 bg-slate-900/60 p-2">Expanded R: {currentRound?.expanded ?? '—'}</div>
                      <div className="rounded border border-slate-800/70 bg-slate-900/60 p-2">XOR: {currentRound?.xorWithKey ?? '—'}</div>
                      <div className="rounded border border-slate-800/70 bg-slate-900/60 p-2">S-Box: {currentRound?.sBoxOutput ?? '—'}</div>
                      <div className="rounded border border-slate-800/70 bg-slate-900/60 p-2">P-Box: {currentRound?.pBoxOutput ?? '—'}</div>
                      <div className="rounded border border-slate-800/70 bg-slate-900/60 p-2">Block after round: {currentRound?.roundOutput ?? '—'}</div>
                    </div>
                  </div>
                  <div className="rounded-2xl border border-slate-800/70 bg-slate-950/60 p-3 text-sm text-slate-200 overflow-hidden">
                    <p className="text-xs uppercase tracking-wide text-slate-400">Notes</p>
                    <ul className="mt-2 space-y-1 text-slate-300">
                      <li>Ri-1 → Expansion E (32→48)</li>
                      <li>Result XOR Ki → 48 bits</li>
                      <li>Split into 8 groups → S1…S8</li>
                      <li>Concatenate 32-bit output → Permutation P</li>
                      <li>Li = Ri-1; Ri = Li-1 XOR P</li>
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === 'ffunction' && (
            <Card className="glass card-hover">
              <CardHeader>
                <CardTitle>F-Function & S-Boxes</CardTitle>
                <CardDescription>Inspect expansion, substitution, and permutation.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="rounded-xl border border-slate-800/70 bg-slate-950/60 p-3 text-sm text-slate-200 overflow-hidden">
                    <p className="text-xs uppercase tracking-wide text-slate-400">Inputs</p>
                    <p>Rin: {currentRound?.right ?? '—'}</p>
                    <p>Ki: {currentRound?.subKey ?? '—'}</p>
                    <p className="mt-2 text-xs text-slate-400">E-table size: {DES_TABLES.E_TABLE.length}</p>
                  </div>
                  <div className="rounded-xl border border-slate-800/70 bg-slate-950/60 p-3 text-sm text-slate-200 overflow-hidden">
                    <p className="text-xs uppercase tracking-wide text-slate-400">Outputs</p>
                    <p>XOR: {currentRound?.xorWithKey ?? '—'}</p>
                    <p>S-Box: {currentRound?.sBoxOutput ?? '—'}</p>
                    <p>Permutation P: {currentRound?.pBoxOutput ?? '—'}</p>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-800/70 bg-slate-900/60 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-400">S-Box Viewer</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {S_BOX_LABELS.map((label, index) => (
                      <Button
                        key={label}
                        size="sm"
                        variant={selectedSBox === index ? 'accent' : 'outline'}
                        onClick={() => setSelectedSBox(index)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                  <div className="mt-3 overflow-auto rounded-2xl border border-slate-800">
                    <table className="w-full min-w-[520px] text-xs text-slate-200">
                      <thead className="bg-slate-950/70 text-slate-400">
                        <tr>
                          <th className="px-2 py-1 text-left">Row/Col</th>
                          {BIT_LABELS.map((label) => (
                            <th key={label} className="px-2 py-1 text-center">
                              {label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {S_BOXES_DATA[selectedSBox].map((row, rowIndex) => (
                          <tr key={`row-${rowIndex}`} className="border-t border-slate-800/80 text-center">
                            <td className="px-2 py-1 text-left font-semibold text-slate-400">Row {rowIndex}</td>
                            {row.map((value, columnIndex) => (
                              <td
                                key={`cell-${rowIndex}-${columnIndex}`}
                                className={cn(
                                  'px-2 py-1',
                                  sBoxHighlight &&
                                    sBoxHighlight.row === rowIndex &&
                                    sBoxHighlight.column === columnIndex
                                    ? 'bg-accent/20 text-white'
                                    : theme === 'light'
                                      ? 'text-slate-700'
                                      : 'text-slate-300',
                                )}
                              >
                                {value}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {sBoxHighlight && (
                    <div className="mt-3 rounded-xl border border-slate-800/70 bg-slate-950/70 p-3 text-xs text-slate-200">
                      <p>
                        Input bits: <span className="font-mono">{sBoxHighlight.inputBits}</span>
                      </p>
                      <p>
                        Row {sBoxHighlight.row}, Col {sBoxHighlight.column} → Output:{' '}
                        <span className="font-mono">{sBoxHighlight.outputBits}</span>
                      </p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === 'schedule' && (
            <Card className="glass card-hover">
              <CardHeader>
                <CardTitle>Key Schedule Explorer</CardTitle>
                <CardDescription>PC-1, shifts, PC-2, and all 16 subkeys.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2 text-sm text-slate-200 overflow-hidden">
                  <div className="rounded-xl border border-slate-800/70 bg-slate-950/60 p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-400">Input Key (hex)</p>
                    <p className="font-mono text-white">{keyValidation.hex}</p>
                    <p className="mt-2 text-xs text-slate-400">Parity bits are every 8th bit; PC-1 drops them.</p>
                  </div>
                  <div className="rounded-xl border border-slate-800/70 bg-slate-950/60 p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-400">PC-1 Output</p>
                    <p className="font-mono text-white">{currentEncryptResult?.keySchedule.parityDroppedKey ?? '—'}</p>
                    <p className="mt-2 text-xs text-slate-400">C0 and D0 are 28 bits each; left shifts follow schedule.</p>
                  </div>
                </div>
                <div className="overflow-auto rounded-2xl border border-slate-800/80">
                  <table
                    className={cn(
                      'w-full min-w-[720px] text-xs',
                      theme === 'light' ? 'text-slate-800' : 'text-slate-200',
                    )}
                  >
                    <thead className={cn('bg-slate-950/70', theme === 'light' ? 'text-slate-700' : 'text-slate-400')}>
                      <tr>
                        <th className="px-3 py-2 text-left">Round</th>
                        <th className="px-3 py-2 text-left">Shifts</th>
                        <th className="px-3 py-2 text-left">Ci</th>
                        <th className="px-3 py-2 text-left">Di</th>
                        <th className="px-3 py-2 text-left">Subkey Ki</th>
                      </tr>
                    </thead>
                    <tbody>
                      {currentEncryptResult?.keySchedule.rounds.length ? (
                        currentEncryptResult.keySchedule.rounds.map((round) => (
                          <tr key={round.round} className="border-t border-slate-800/80">
                            <td className={cn('px-3 py-2', theme === 'light' ? 'text-slate-800' : 'text-slate-200')}>{round.round}</td>
                            <td className={cn('px-3 py-2', theme === 'light' ? 'text-slate-800' : 'text-slate-200')}>{round.shifts}</td>
                            <td className={cn('px-3 py-2 font-mono', theme === 'light' ? 'text-slate-800' : 'text-slate-200')}>{round.c}</td>
                            <td className={cn('px-3 py-2 font-mono', theme === 'light' ? 'text-slate-800' : 'text-slate-200')}>{round.d}</td>
                            <td className={cn('px-3 py-2 font-mono', theme === 'light' ? 'text-slate-800' : 'text-slate-200')}>{round.subKey}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={5} className="px-3 py-2 text-center text-slate-500">
                            Run DES to see the key schedule.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="rounded-2xl border border-slate-800/70 bg-slate-950/60 p-3 text-xs text-slate-300">
                  <p className="font-semibold text-slate-200">Notes</p>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    <li>Shift schedule: 1-bit shifts in rounds 1,2,9,16; 2-bit shifts elsewhere.</li>
                    <li>Key strength (heuristic): {keyStrength.label} (score {keyStrength.score}).</li>
                  </ul>
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === 'avalanche' && (
            <Card className="glass card-hover">
              <CardHeader>
                <CardTitle>Avalanche Effect</CardTitle>
                <CardDescription>Flip one plaintext bit and track per-round differences.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <Button onClick={handleAvalancheTest} variant="accent">
                    <Zap size={16} /> Flip 1 random bit
                  </Button>
                  <p className="text-xs text-slate-400">Shows diffusion across rounds.</p>
                </div>
                {mutatedInput && (
                  <div className="rounded-2xl border border-slate-800/70 bg-slate-900/60 p-4 text-xs text-slate-200">
                    <p>Bit index flipped: {mutatedBitIndex ?? '—'}</p>
                    <p>Base plaintext: {plainValidation.hex}</p>
                    <p>
                      Mutated plaintext: <span className="text-accent">{mutatedInput}</span>
                    </p>
                    <p>
                      Ciphertext Hamming distance:{' '}
                      <span className="font-semibold text-primary">{ciphertextDiff ?? 0}</span>/64
                    </p>
                  </div>
                )}
                {avalancheDiffs && (
                  <div className="space-y-3">
                    <div className="grid gap-2">
                      {avalancheDiffs.map((diff) => (
                        <div key={diff.round} className="flex items-center gap-3">
                          <div className="w-20 text-xs text-slate-300">Round {diff.round}</div>
                          <div className="h-2 flex-1 rounded-full bg-slate-800">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-primary via-accent to-secondary"
                              style={{ width: `${diff.percentage}%` }}
                            />
                          </div>
                          <div className="w-16 text-right text-xs text-slate-300">{diff.percentage}%</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {activeTab === 'matrix' && (
            <Card className="glass card-hover">
              <CardHeader>
                <CardTitle>Matrix View</CardTitle>
                <CardDescription>IP/FP and per-round outputs as 8x8 bit grids.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {!latestResult && <p className="text-sm text-slate-400">Run an encryption or decryption to see matrices.</p>}
                {latestResult && (
                  <div className="space-y-4">
                    {[
                      { label: 'Input (Plaintext/Ciphertext)', hex: latestResult.inputHex },
                      { label: 'Initial Permutation (IP)', hex: latestResult.ipOutput },
                      ...latestResult.rounds.map((r) => ({ label: `Round ${r.round} Output`, hex: r.roundOutput })),
                      { label: 'Final Permutation (FP)', hex: latestResult.fpOutput },
                      { label: 'Final Output', hex: latestResult.outputHex },
                    ].map((item) => {
                      const rows = chunkBinaryToRows(hexToBinaryString(item.hex))
                      return (
                        <div key={item.label} className="rounded-2xl border border-slate-800/70 bg-slate-900/40 p-3">
                          <div className="flex items-center justify-between text-sm">
                            <span className="font-semibold text-white">{item.label}</span>
                            <span className="text-xs text-slate-400">Hex: {item.hex}</span>
                          </div>
                          <div className="mt-2 overflow-auto">
                            <table className="min-w-[320px] border-collapse">
                              <tbody>
                                {rows.map((row, idx) => (
                                  <tr key={`${item.label}-r-${idx}`}>
                                    {row.map((bit, bitIdx) => (
                                      <td
                                        key={`${item.label}-r-${idx}-c-${bitIdx}`}
                                        className="border border-slate-800/70 px-2 py-1 text-center font-mono text-xs text-white"
                                      >
                                        {bit}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {activeTab === 'theory' && (
            <Card className="glass card-hover">
              <CardHeader>
                <CardTitle>Theory & Security</CardTitle>
                <CardDescription>Key takeaways and modern context.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-slate-200 overflow-hidden">
                <details className="rounded-lg border border-slate-800/70 bg-slate-950/60 p-3" open>
                  <summary className="cursor-pointer font-semibold">Block vs Stream Ciphers</summary>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-slate-300">
                    <li>Block: fixed-size blocks (DES 64-bit), Feistel/SPN structures.</li>
                    <li>Stream: processes one symbol/bit at a time with a keystream.</li>
                    <li>DES is a block cipher; diffusion visible in Avalanche tab.</li>
                  </ul>
                </details>
                <details className="rounded-lg border border-slate-800/70 bg-slate-950/60 p-3" open>
                  <summary className="cursor-pointer font-semibold">Feistel & S-P Networks</summary>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-slate-300">
                    <li>Feistel: split block, apply F to right half with subkey, XOR into left, swap.</li>
                    <li>S-P: substitution (S-boxes) + permutation (P-box) create confusion/diffusion.</li>
                    <li>DES implements S-P inside each Feistel round.</li>
                  </ul>
                </details>
                <details className="rounded-lg border border-slate-800/70 bg-slate-950/60 p-3" open>
                  <summary className="cursor-pointer font-semibold">Confusion & Diffusion</summary>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-slate-300">
                    <li>Confusion: non-linear S-boxes hide key/plain relationships.</li>
                    <li>Diffusion: permutations spread bit influence across output.</li>
                    <li>Observe diffusion in Avalanche and round outputs.</li>
                  </ul>
                </details>
                <details className="rounded-lg border border-slate-800/70 bg-slate-950/60 p-3" open>
                  <summary className="cursor-pointer font-semibold">DES Strength & Limitations</summary>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-slate-300">
                    <li>56-bit effective key: brute-force feasible today.</li>
                    <li>Classic attacks: differential and linear cryptanalysis (beyond this lab).</li>
                    <li>Modern practice: 3DES or AES; DES is for learning.</li>
                  </ul>
                </details>
                <details className="rounded-lg border border-slate-800/70 bg-slate-950/60 p-3">
                  <summary className="cursor-pointer font-semibold">Permutation Tables Reference</summary>
                  <div className="mt-3 space-y-4">
                    <div>
                      <p className="text-xs font-semibold text-slate-300 mb-2">Initial Permutation (IP) — 64 entries</p>
                      <div className="grid grid-cols-8 gap-1 text-[10px] text-slate-300">
                        {DES_TABLES.IP_TABLE.map((val, idx) => (
                          <div key={`ip-${idx}`} className="rounded border border-slate-700/60 bg-slate-900/60 px-1 py-1 text-center">
                            {val}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-slate-300 mb-2">Final Permutation (IP⁻¹ / FP) — 64 entries</p>
                      <div className="grid grid-cols-8 gap-1 text-[10px] text-slate-300">
                        {DES_TABLES.FP_TABLE.map((val, idx) => (
                          <div key={`fp-${idx}`} className="rounded border border-slate-700/60 bg-slate-900/60 px-1 py-1 text-center">
                            {val}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-slate-300 mb-2">Expansion (E) — 48 entries (32 → 48 bits)</p>
                      <div className="grid grid-cols-8 gap-1 text-[10px] text-slate-300">
                        {DES_TABLES.E_TABLE.map((val, idx) => (
                          <div key={`e-${idx}`} className="rounded border border-slate-700/60 bg-slate-900/60 px-1 py-1 text-center">
                            {val}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-slate-300 mb-2">Permutation (P) — 32 entries</p>
                      <div className="grid grid-cols-8 gap-1 text-[10px] text-slate-300">
                        {DES_TABLES.P_TABLE.map((val, idx) => (
                          <div key={`p-${idx}`} className="rounded border border-slate-700/60 bg-slate-900/60 px-1 py-1 text-center">
                            {val}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-slate-300 mb-2">Permuted Choice 1 (PC-1) — 56 entries (drops parity bits)</p>
                      <div className="grid grid-cols-8 gap-1 text-[10px] text-slate-300">
                        {DES_TABLES.PC1_TABLE.map((val, idx) => (
                          <div key={`pc1-${idx}`} className="rounded border border-slate-700/60 bg-slate-900/60 px-1 py-1 text-center">
                            {val}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-slate-300 mb-2">Permuted Choice 2 (PC-2) — 48 entries (56 → 48 bits)</p>
                      <div className="grid grid-cols-8 gap-1 text-[10px] text-slate-300">
                        {DES_TABLES.PC2_TABLE.map((val, idx) => (
                          <div key={`pc2-${idx}`} className="rounded border border-slate-700/60 bg-slate-900/60 px-1 py-1 text-center">
                            {val}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-slate-300 mb-2">Shift Schedule — 16 rounds</p>
                      <div className="grid grid-cols-8 gap-1 text-[10px] text-slate-300">
                        {DES_TABLES.SHIFT_SCHEDULE.map((val, idx) => (
                          <div key={`shift-${idx}`} className="rounded border border-slate-700/60 bg-slate-900/60 px-1 py-1 text-center">
                            R{idx + 1}: {val}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </details>
              </CardContent>
            </Card>
          )}

          {activeTab === 'grading' && teacherAllowed && (
            <div className="space-y-4">
              <Card className="glass card-hover">
                <CardHeader>
                  <CardTitle>Error Detector</CardTitle>
                  <CardDescription>Analyze DES implementations and diagnose common errors.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-slate-200">
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-2 text-xs">
                      <Button
                        size="sm"
                        variant={selectedMode === 'encrypt' ? 'default' : 'outline'}
                        onClick={() => setSelectedMode('encrypt')}
                      >
                        Encrypt
                      </Button>
                      <Button
                        size="sm"
                        variant={selectedMode === 'decrypt' ? 'default' : 'outline'}
                        onClick={() => setSelectedMode('decrypt')}
                      >
                        Decrypt
                      </Button>
                    </div>
                    <div className="rounded border border-slate-800 bg-slate-950/70 p-2 text-xs">
                      <p className="text-slate-400">
                        Expected {selectedMode === 'encrypt' ? 'ciphertext' : 'plaintext'} (current P/K):
                      </p>
                      <p className="font-mono text-white">{expectedQuizOutput ?? '—'}</p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs text-slate-400">
                      {selectedMode === 'encrypt' ? 'Ciphertext' : 'Plaintext'} to analyze (hex)
                    </p>
                    <Input
                      placeholder={
                        selectedMode === 'encrypt' ? 'Enter ciphertext hex' : 'Enter plaintext hex'
                      }
                      value={studentAnswerHex}
                      onChange={(event) => setStudentAnswerHex(event.target.value)}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="accent" onClick={handleAutoDiagnose}>
                      Analyze & diagnose
                    </Button>
                    {diagnosisResult && (
                      <Badge variant="secondary">
                        {diagnosisResult.matchedPattern === 'correct'
                          ? 'Correct'
                          : diagnosisResult.variantMatched ?? 'Unclassified error'}
                      </Badge>
                    )}
                    {gradingError && <span className="text-xs text-red-300">{gradingError}</span>}
                  </div>
                  {diagnosisResult && (
                    <div className="rounded-2xl border border-slate-800/70 bg-slate-950/70 p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-400">Diagnosis</p>
                      <p
                        className={cn(
                          'text-sm',
                          theme === 'light' ? 'text-slate-600' : 'text-slate-400',
                        )}
                      >
                        {diagnosisResult.message}
                      </p>
                      <div className="mt-2 grid gap-2 text-xs font-mono text-slate-200 md:grid-cols-2">
                        <div className="rounded border border-slate-800/60 bg-slate-900/60 p-2">
                          <p className="text-[11px] text-slate-400">Expected</p>
                          <p>{diagnosisResult.expectedOutput}</p>
                        </div>
                        <div className="rounded border border-slate-800/60 bg-slate-900/60 p-2">
                          <p className="text-[11px] text-slate-400">Student</p>
                          <p className="text-primary">{diagnosisResult.studentOutput}</p>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                        {diagnosisResult.tags.map((tag) => (
                          <Badge key={tag} variant="outline">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

export default App
