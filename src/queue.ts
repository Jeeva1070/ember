import type { CodeEvent, QueueStats } from './types'
import * as fs from 'node:fs'
import path from 'node:path'

export type SendHandler = (events: CodeEvent[]) => Promise<void>
export type LogHandler = (message: string) => void

export class EventQueue {
  private queue: CodeEvent[] = []
  private storageFilePath: string = ''
  private timer?: NodeJS.Timeout
  private sendHandler: SendHandler
  private log: LogHandler
  private isFlushing = false
  private lastSyncTime: number | null = null
  private failedAttempts = 0
  private maxBufferSize = 2000
  private batchSize = 25
  private intervalMs = 30_000
  private nextRetryTime = 0

  constructor(
    storageDir: string,
    sendHandler: SendHandler,
    log: LogHandler = () => {},
    intervalMs: number = 30_000,
  ) {
    this.sendHandler = sendHandler
    this.log = log
    this.intervalMs = intervalMs

    if (storageDir) {
      try {
        if (!fs.existsSync(storageDir)) {
          fs.mkdirSync(storageDir, { recursive: true })
        }
        this.storageFilePath = path.join(storageDir, 'ember-events-queue.json')
        this.loadFromDisk()
      }
      catch (error: any) {
        this.log(`[Queue] Failed to initialize storage dir: ${error.message}`)
      }
    }

    this.startTimer()
  }

  public enqueue(event: CodeEvent) {
    if (this.queue.length >= this.maxBufferSize) {
      // Discard oldest event to keep buffer bounded
      this.queue.shift()
    }
    this.queue.push(event)

    // If buffer reaches batch threshold, trigger early flush
    if (this.queue.length >= this.batchSize && Date.now() >= this.nextRetryTime) {
      this.flush()
    }
  }

  public async flush(): Promise<void> {
    if (this.isFlushing || this.queue.length === 0) {
      return
    }

    if (Date.now() < this.nextRetryTime) {
      return
    }

    this.isFlushing = true
    const batch = this.queue.slice(0, this.batchSize)

    try {
      await this.sendHandler(batch)
      // On success, dequeue the sent events
      this.queue.splice(0, batch.length)
      this.lastSyncTime = Date.now()
      this.failedAttempts = 0
      this.nextRetryTime = 0
      this.saveToDisk()
    }
    catch (error: any) {
      this.failedAttempts++
      // Exponential backoff: 10s, 20s, 40s... max 5 mins
      const backoffSec = Math.min(300, 10 * 2 ** (this.failedAttempts - 1))
      this.nextRetryTime = Date.now() + backoffSec * 1000
      this.log(`[Queue] Flush failed (${error.message || 'network error'}). Queued: ${this.queue.length}. Retrying in ${backoffSec}s.`)
      this.saveToDisk()
    }
    finally {
      this.isFlushing = false
    }
  }

  private startTimer() {
    this.stopTimer()
    this.timer = setInterval(() => {
      this.flush()
    }, this.intervalMs)
  }

  public stopTimer() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private loadFromDisk() {
    if (!this.storageFilePath || !fs.existsSync(this.storageFilePath)) {
      return
    }
    try {
      const data = fs.readFileSync(this.storageFilePath, 'utf8')
      const parsed: CodeEvent[] = JSON.parse(data)
      if (Array.isArray(parsed) && parsed.length > 0) {
        this.queue = [...parsed.slice(-this.maxBufferSize), ...this.queue]
        this.log(`[Queue] Restored ${parsed.length} pending events from previous session.`)
      }
    }
    catch (error: any) {
      this.log(`[Queue] Could not read queue file: ${error.message}`)
    }
  }

  public saveToDisk() {
    if (!this.storageFilePath) {
      return
    }
    try {
      if (this.queue.length === 0) {
        if (fs.existsSync(this.storageFilePath)) {
          fs.unlinkSync(this.storageFilePath)
        }
        return
      }
      fs.writeFileSync(this.storageFilePath, JSON.stringify(this.queue), 'utf8')
    }
    catch (error: any) {
      this.log(`[Queue] Could not save queue to disk: ${error.message}`)
    }
  }

  public getStats(): QueueStats {
    return {
      queuedCount: this.queue.length,
      lastSyncTime: this.lastSyncTime,
      isOnline: this.failedAttempts === 0,
      failedAttempts: this.failedAttempts,
    }
  }

  public dispose() {
    this.stopTimer()
    this.saveToDisk()
  }
}
