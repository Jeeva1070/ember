export interface CodeEvent {
  project?: string
  language: string
  relativeFile: string
  absoluteFile?: string
  editor: string
  platform: string
  eventTime: number
  eventType: string
  platformArch: string
  gitOrigin?: string
  gitBranch?: string
  operationType: 'read' | 'write'
}

export interface QueueStats {
  queuedCount: number
  lastSyncTime: number | null
  isOnline: boolean
  failedAttempts: number
}
