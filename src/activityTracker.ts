import type * as vscode from 'vscode'

export type ActivityPeriod = 'week' | 'month' | 'year'

export interface CodingSession {
  startedAt: number
  lastActivityAt: number
  activeSeconds: number
  project: string
  languages: string[]
  eventCount: number
  dailyActiveSeconds: Record<string, number>
}

const SESSION_IDLE_MS = 15 * 60 * 1000
const MAX_ACTIVE_INTERVAL_MS = 2 * 60 * 1000
const STORAGE_KEY = 'ember.codingSessions'

export class ActivityTracker {
  private sessions: CodingSession[]
  private saveTimer?: NodeJS.Timeout
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly state: vscode.Memento,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.sessions = this.loadSessions()
  }

  recordActivity(timestamp: number, project: string, language: string): void {
    const lastSession = this.sessions.at(-1)
    const elapsed = lastSession ? timestamp - lastSession.lastActivityAt : -1

    if (lastSession && lastSession.project === project && elapsed >= 0 && elapsed <= SESSION_IDLE_MS) {
      const previousActivityAt = lastSession.lastActivityAt
      const activeInterval = Math.min(elapsed, MAX_ACTIVE_INTERVAL_MS)
      lastSession.lastActivityAt = timestamp
      lastSession.eventCount++
      if (language && !lastSession.languages.includes(language)) {
        lastSession.languages.push(language)
      }
      if (activeInterval > 0) {
        lastSession.activeSeconds += addDailyActivity(
          lastSession.dailyActiveSeconds,
          previousActivityAt,
          previousActivityAt + activeInterval,
        )
      }
    }
    else {
      this.sessions.push({
        startedAt: timestamp,
        lastActivityAt: timestamp,
        activeSeconds: 0,
        project,
        languages: language ? [language] : [],
        eventCount: 1,
        dailyActiveSeconds: {},
      })
    }

    this.scheduleSave()
  }

  getSessions(): CodingSession[] {
    return this.sessions.map(session => ({
      ...session,
      languages: [...session.languages],
      dailyActiveSeconds: { ...session.dailyActiveSeconds },
    }))
  }

  async flush(): Promise<void> {
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    await this.persist()
  }

  private loadSessions(): CodingSession[] {
    const stored = this.state.get<unknown>(STORAGE_KEY)
    if (!Array.isArray(stored)) {
      return []
    }

    return stored.filter(value => isCodingSession(value))
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.persist()
    }, 3000)
  }

  private persist(): Promise<void> {
    const snapshot = this.getSessions()
    this.saveQueue = this.saveQueue
      .then(() => this.state.update(STORAGE_KEY, snapshot))
      .catch((error: unknown) => {
        this.log(`[Activity] Could not save local coding sessions: ${error instanceof Error ? error.message : String(error)}`)
      })
    return this.saveQueue
  }
}

export function getPeriodRange(period: ActivityPeriod, date = new Date()): { start: Date, end: Date } {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  if (period === 'week') {
    const daysSinceMonday = (start.getDay() + 6) % 7
    start.setDate(start.getDate() - daysSinceMonday)
    return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7) }
  }
  if (period === 'month') {
    const monthStart = new Date(date.getFullYear(), date.getMonth(), 1)
    return { start: monthStart, end: new Date(date.getFullYear(), date.getMonth() + 1, 1) }
  }
  const yearStart = new Date(date.getFullYear(), 0, 1)
  return { start: yearStart, end: new Date(date.getFullYear() + 1, 0, 1) }
}

export function getDailyActivity(sessions: CodingSession[]): Record<string, number> {
  const daily: Record<string, number> = {}
  for (const session of sessions) {
    for (const [date, seconds] of Object.entries(session.dailyActiveSeconds)) {
      daily[date] = (daily[date] ?? 0) + seconds
    }
  }
  return daily
}

export function getLocalDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addDailyActivity(daily: Record<string, number>, startTime: number, endTime: number): number {
  let cursor = startTime
  let totalSeconds = 0
  while (cursor < endTime) {
    const current = new Date(cursor)
    const nextDay = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1).getTime()
    const intervalEnd = Math.min(endTime, nextDay)
    const dateKey = getLocalDateKey(current)
    const seconds = Math.floor((intervalEnd - cursor) / 1000)
    daily[dateKey] = (daily[dateKey] ?? 0) + seconds
    totalSeconds += seconds
    cursor = intervalEnd
  }
  return totalSeconds
}

function isCodingSession(value: unknown): value is CodingSession {
  if (!value || typeof value !== 'object') {
    return false
  }
  const session = value as Partial<CodingSession>
  return Number.isFinite(session.startedAt)
    && Number.isFinite(session.lastActivityAt)
    && Number.isFinite(session.activeSeconds)
    && typeof session.project === 'string'
    && Array.isArray(session.languages)
    && session.languages.every(language => typeof language === 'string')
    && Number.isInteger(session.eventCount)
    && !!session.dailyActiveSeconds
    && typeof session.dailyActiveSeconds === 'object'
    && Object.values(session.dailyActiveSeconds).every(seconds => Number.isFinite(seconds) && seconds >= 0)
}
