type RosterRow = {
  studentId: string
  name: string
  examId: string
  versionLabel?: string
  version?: string
  email?: string
}

type GradeRow = {
  studentId: string
  name: string
  examId: string
  versionLabel?: string
  version?: string
  q1?: number
  q2?: number
  q3?: number
  q_scores?: Record<string, number>
  total: number
  diagnosis?: string
  letter_grade?: string
}

const apiUrl = import.meta.env.VITE_API_URL ?? ''
export const hasApi = true

const fetchJson = async <T>(path: string, options?: RequestInit): Promise<T> => {
  if (!apiUrl) throw new Error('API URL not configured')
  const res = await fetch(`${apiUrl}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    ...options,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || 'API request failed')
  }
  return (await res.json()) as T
}

export const api = {
  login: async (email: string, password: string) =>
    fetchJson<{ token: string; email: string }>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  signup: async (name: string, email: string, password: string) =>
    fetchJson<{ token: string; email: string }>('/api/signup', {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    }),
  listRoster: async (examId?: string): Promise<RosterRow[]> =>
    fetchJson<RosterRow[]>(`/api/roster${examId ? `?examId=${encodeURIComponent(examId)}` : ''}`),
  importRoster: async (rows: RosterRow[]): Promise<{ count: number; rows: RosterRow[] }> =>
    fetchJson(`/api/roster/bulk`, { method: 'POST', body: JSON.stringify({ rows }) }),
  listGrades: async (examId?: string): Promise<GradeRow[]> =>
    fetchJson<GradeRow[]>(`/api/grades${examId ? `?examId=${encodeURIComponent(examId)}` : ''}`),
  saveGrade: async (row: GradeRow): Promise<GradeRow> =>
    fetchJson<GradeRow>(`/api/grades`, { method: 'POST', body: JSON.stringify(row) }),
  saveRun: async (payload: { mode: string; inputHex: string; keyHex: string; outputHex: string }) =>
    fetchJson<{ ok: boolean }>(`/api/runs`, { method: 'POST', body: JSON.stringify(payload) }),
}
let authToken: string | null = null

export const setAuthToken = (token: string | null) => {
  authToken = token
}
