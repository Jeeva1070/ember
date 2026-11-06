import type { CodeEvent } from './types'
import { Buffer } from 'node:buffer'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import * as os from 'node:os'
import process from 'node:process'

import tls from 'node:tls'
import osName from 'os-name'
import * as vscode from 'vscode'
import * as events from './events'
import { getDurationText } from './getDurationText'
import { isProjectIgnored, sanitizeRelativePath, shouldIgnoreFile } from './privacy'
import { EventQueue } from './queue'
import { getGitCurrentBranch, getGitOriginUrl } from './utils'

export class CodeTime {
  osName = osName()
  out: vscode.OutputChannel = vscode.window.createOutputChannel('Ember')
  private debounceTimer?: NodeJS.Timeout
  private secrets: vscode.SecretStorage
  private readonly platformArch = os.arch()
  private authRetryCount = 0
  private readonly maxAuthRetries = 3
  private queue!: EventQueue
  private latestDurationMinutes: number = 0
  private durationDateKey = getLocalDateKey()
  private durationRequestId = 0
  private storageDir: string = ''
  private lastTrackedEventKey = ''
  private lastTrackedEventTime = 0
  private readonly eventDedupeWindowMs = 2000

  private debounce<T extends (...args: any[]) => void>(func: T, wait: number) {
    return (...args: Parameters<T>) => {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = setTimeout(() => func.apply(this, args), wait)
    }
  }

  private debugLog(message: string) {
    if (process.env.EMBER_DEBUG === '1') {
      this.out.appendLine(message)
    }
  }

  public getConfig<T>(key: string, defaultValue: T): T {
    const emberCfg = vscode.workspace.getConfiguration('ember').get<T>(key)
    if (emberCfg !== undefined) {
      return emberCfg
    }
    const codetimeCfg = vscode.workspace.getConfiguration('codetime').get<T>(key)
    if (codetimeCfg !== undefined) {
      return codetimeCfg
    }
    return defaultValue
  }

  async setToken() {
    const token = await vscode.window.showInputBox({
      password: true,
      placeHolder: vscode.l10n.t('Ember: Input Your Token (from: codetime.dev)'),
    })

    if (token) {
      await this.setTokenDirectly(token.trim(), true)
    }
  }

  async setTokenDirectly(token: string, showNotification = false) {
    await this.secrets.store('ember.token', token)
    await this.secrets.store('codetime.token', token)
    this.token = token
    this.resetAuthRetryCount()
    this.getCurrentDuration(showNotification)
    if (showNotification) {
      vscode.window.showInformationMessage(vscode.l10n.t('Ember: Token updated successfully'))
    }
    // Flush any pending queue items
    this.queue?.flush()
  }

  private statusBar: vscode.StatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
  )

  public disposable!: vscode.Disposable
  state: vscode.Memento
  token: string = ''
  inter!: NodeJS.Timeout

  constructor(state: vscode.Memento, secrets: vscode.SecretStorage, storageDir: string = '') {
    this.state = state
    this.secrets = secrets
    this.storageDir = storageDir

    const heartbeatSec = this.getConfig<number>('heartbeatInterval', 30)

    this.queue = new EventQueue(
      storageDir,
      async (batch: CodeEvent[]) => {
        if (this.token === '') {
          throw new Error('No authentication token available')
        }
        for (const event of batch) {
          await this.apiRequest('POST', '/v3/users/event-log', event)
        }
      },
      msg => this.debugLog(msg),
      heartbeatSec * 1000,
    )

    this.initSetToken().then(() => {
      this.init()
    })
  }

  private getProxyUrl(): string {
    return (
      this.getConfig<string>('proxy', '')
      || process.env.HTTPS_PROXY || process.env.HTTP_PROXY
      || process.env.https_proxy || process.env.http_proxy
      || ''
    )
  }

  private apiRequest(method: string, path: string, body?: any): Promise<{ body: string, statusCode: number }> {
    const serverUrl = this.getConfig<string>('serverEntrypoint', 'https://tvbiqpxhlxnpinhspvnn.supabase.co/functions/v1/ember')
    const base = serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`
    const url = new URL(path.replace(/^\//, ''), base)
    const payload = body ? JSON.stringify(body) : undefined
    const proxy = this.getProxyUrl()
    const isHttpsTarget = url.protocol === 'https:'
    const targetPort = Number(url.port) || (isHttpsTarget ? 443 : 80)

    const baseHeaders: Record<string, string> = {
      'User-Agent': 'Ember Client/VSCode',
      'Authorization': `Bearer ${this.token}`,
    }
    if (payload) {
      baseHeaders['Content-Type'] = 'application/json'
      baseHeaders['Content-Length'] = Buffer.byteLength(payload).toString()
    }

    return new Promise((resolve, reject) => {
      const startTime = Date.now()
      this.debugLog(`[Req] ${method} ${path} proxy=${proxy ? this.redactUrlForLogging(proxy) : 'none'}`)

      const finish = (parsed: { statusCode: number, body: string }) => {
        this.debugLog(`[Req] ${parsed.statusCode} after ${Date.now() - startTime}ms`)
        if (parsed.statusCode >= 400) {
          const message = parsed.statusCode === 401 ? 'Unauthorized' : `HTTP ${parsed.statusCode}`
          const err = new Error(message) as Error & { response: { statusCode: number, body: string } }
          err.response = { statusCode: parsed.statusCode, body: parsed.body }
          reject(err)
          return
        }
        resolve(parsed)
      }

      // No proxy: use Node's http(s) client directly
      if (!proxy) {
        const lib = isHttpsTarget ? https : http
        const req = lib.request({
          method,
          hostname: url.hostname,
          port: targetPort,
          path: url.pathname + url.search,
          timeout: 30_000,
          headers: baseHeaders,
        }, (res: http.IncomingMessage) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            finish({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            })
          })
        })
        req.on('error', (e: any) => {
          this.debugLog(`[Req] error after ${Date.now() - startTime}ms: ${e.message}`)
          reject(e)
        })
        req.on('timeout', () => req.destroy(new Error('request timeout')))
        if (payload) {
          req.write(payload)
        }
        req.end()
        return
      }

      // With proxy: open TCP/TLS to proxy, then CONNECT (HTTPS target) or absolute-form (HTTP target)
      let proxyUrlParsed: URL
      try {
        proxyUrlParsed = new URL(proxy)
      }
      catch {
        const error = new Error(`Invalid proxy URL: "${this.redactUrlForLogging(proxy)}". Expected format: http://host:port or https://host:port.`)
        this.debugLog(`[Req] invalid proxy configuration: ${error.message}`)
        reject(error)
        return
      }
      if (proxyUrlParsed.protocol !== 'http:' && proxyUrlParsed.protocol !== 'https:') {
        const error = new Error(`Unsupported proxy protocol: ${proxyUrlParsed.protocol}. Only http: and https: proxies are supported.`)
        this.debugLog(`[Req] invalid proxy configuration: ${error.message}`)
        reject(error)
        return
      }
      const isHttpsProxy = proxyUrlParsed.protocol === 'https:'
      const proxyPort = Number(proxyUrlParsed.port) || (isHttpsProxy ? 443 : 80)
      const proxyHost = proxyUrlParsed.hostname
      const targetAuthority = url.hostname.includes(':') ? `[${url.hostname}]:${targetPort}` : `${url.hostname}:${targetPort}`

      const proxyAuthHeader = proxyUrlParsed.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxyUrlParsed.username)}:${decodeURIComponent(proxyUrlParsed.password)}`).toString('base64')}`
        : ''

      this.debugLog(`[Req] connecting to proxy ${proxyHost}:${proxyPort} (${proxyUrlParsed.protocol})`)

      const writeRequestAndRead = (socket: net.Socket | tls.TLSSocket, requestLine: string, extraHeaders: string[] = []) => {
        const lines = [
          requestLine,
          `Host: ${url.host}`,
          ...Object.entries(baseHeaders).map(([k, v]) => `${k}: ${v}`),
          ...extraHeaders,
          'Connection: close',
          '',
          payload || '',
        ]
        socket.write(lines.join('\r\n'))

        const requestTimeout = setTimeout(() => {
          socket.destroy(new Error('request timeout'))
        }, 30_000)

        const chunks: Buffer[] = []
        socket.on('data', (chunk: Buffer) => chunks.push(chunk))
        socket.on('end', () => {
          clearTimeout(requestTimeout)
          socket.destroy()
          try {
            finish(parseHttpResponse(Buffer.concat(chunks)))
          }
          catch (error: any) {
            this.debugLog(`[Req] parse error: ${error.message}`)
            reject(error)
          }
        })
        socket.on('error', (e: any) => {
          clearTimeout(requestTimeout)
          this.debugLog(`[Req] socket error: ${e.message}`)
          reject(e)
        })
      }

      const onProxyReady = (proxySocket: net.Socket | tls.TLSSocket) => {
        if (!isHttpsTarget) {
          this.debugLog(`[Req] proxy connected, sending HTTP request (absolute form)`)
          proxySocket.setTimeout(0)
          writeRequestAndRead(
            proxySocket,
            `${method} ${url.toString()} HTTP/1.1`,
            proxyAuthHeader ? [proxyAuthHeader] : [],
          )
          return
        }

        this.debugLog(`[Req] proxy connected, sending CONNECT`)
        const connectLines = [
          `CONNECT ${targetAuthority} HTTP/1.1`,
          `Host: ${targetAuthority}`,
          ...(proxyAuthHeader ? [proxyAuthHeader] : []),
          'Proxy-Connection: keep-alive',
          '',
          '',
        ]
        proxySocket.write(connectLines.join('\r\n'))

        let connectBuf = Buffer.alloc(0)
        const onConnectData = (chunk: Buffer) => {
          connectBuf = Buffer.concat([connectBuf, chunk])
          const idx = connectBuf.indexOf('\r\n\r\n')
          if (idx === -1) {
            return
          }
          proxySocket.removeListener('data', onConnectData)
          const headerStr = connectBuf.slice(0, idx).toString('utf8')
          const statusLine = headerStr.split('\r\n')[0]
          this.debugLog(`[Req] proxy response: ${statusLine}`)
          const m = statusLine.match(/^HTTP\/\d\.\d (\d{3})/)
          if (!m || m[1] !== '200') {
            proxySocket.destroy()
            reject(new Error(`Proxy CONNECT failed: ${statusLine}`))
            return
          }
          proxySocket.setTimeout(0)
          const residue = connectBuf.slice(idx + 4)
          if (residue.length > 0) {
            proxySocket.unshift(residue)
          }
          const tlsSocket = tls.connect({ socket: proxySocket, servername: url.hostname }, () => {
            this.debugLog(`[Req] TLS handshake done, sending HTTP request`)
            writeRequestAndRead(tlsSocket, `${method} ${url.pathname + url.search} HTTP/1.1`)
          })
          tlsSocket.on('error', (e: any) => {
            this.debugLog(`[Req] TLS error: ${e.message}`)
            reject(e)
          })
        }
        proxySocket.on('data', onConnectData)
      }

      const proxySocket: net.Socket | tls.TLSSocket = isHttpsProxy
        ? tls.connect({ host: proxyHost, port: proxyPort, servername: proxyHost }, () => onProxyReady(proxySocket))
        : net.connect(proxyPort, proxyHost, () => onProxyReady(proxySocket))
      proxySocket.setTimeout(10_000, () => {
        proxySocket.destroy()
        reject(new Error('Proxy connection timeout'))
      })
      proxySocket.on('error', (e: any) => {
        this.debugLog(`[Req] proxy socket error: ${e.code || ''} ${e.message}`)
        reject(e)
      })
    })
  }

  async initSetToken() {
    const emberToken = await this.secrets.get('ember.token')
    const secretToken = emberToken || await this.secrets.get('codetime.token')
    const envToken = process.env.EMBER_TOKEN || process.env.CODETIME_TOKEN

    if (secretToken) {
      this.token = secretToken
      // Ensure both keys are populated for compatibility
      await this.secrets.store('ember.token', secretToken)
    }
    else if (envToken) {
      this.token = envToken
      await this.secrets.store('ember.token', envToken)
      await this.secrets.store('codetime.token', envToken)
    }
    else {
      const stateToken = this.state.get<string>('token')
      if (stateToken) {
        this.token = stateToken
        await this.secrets.store('ember.token', stateToken)
        await this.secrets.store('codetime.token', stateToken)
        this.state.update('token', undefined)
      }
    }

    if (this.token === '') {
      await this.setToken()
    }
  }

  private redactUrlForLogging(url?: string): string {
    if (!url) {
      return '(none)'
    }

    try {
      const parsed = new URL(url)
      parsed.username = ''
      parsed.password = ''
      parsed.pathname = ''
      parsed.search = ''
      parsed.hash = ''
      return `${parsed.protocol}//${parsed.host}`
    }
    catch {
      return '(configured)'
    }
  }

  private init(): void {
    this.debugLog(`[Init] proxy=${this.redactUrlForLogging(this.getProxyUrl())}`)
    this.debugLog(`[Init] serverEntrypoint=${this.getConfig<string>('serverEntrypoint', '')}`)
    this.debugLog(`[Init] token=${this.token ? `***${this.token.slice(-4)}` : '(empty)'}`)

    this.statusBar.text = `$(clock) ${vscode.l10n.t('Ember: Initializing...')}`
    this.statusBar.command = 'ember.status'
    this.statusBar.show()
    this.setupEventListeners()
    this.getCurrentDuration()
    this.inter = setInterval(() => {
      this.getCurrentDuration()
    }, 20 * 1000)
  }

  private setupEventListeners(): void {
    const events: vscode.Disposable[] = []
    vscode.workspace.onDidChangeTextDocument(this.onEdit, this, events)
    vscode.window.onDidChangeActiveTextEditor(this.onEditor, this, events)
    vscode.window.onDidChangeTextEditorSelection(this.onChangeTextEditorSelection, this, events)
    vscode.window.onDidChangeTextEditorVisibleRanges(this.debounce(this.onChangeTextEditorVisibleRanges, 300), this, events)
    vscode.window.onDidChangeWindowState(this.onFocus, this, events)
    vscode.workspace.onDidSaveTextDocument(this.onSave, this, events)
    vscode.workspace.onDidCreateFiles(this.onCreate, this, events)
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ember') || e.affectsConfiguration('codetime')) {
        this.getCurrentDuration()
      }
    })
    this.disposable = vscode.Disposable.from(...events)
  }

  private onEdit(e: vscode.TextDocumentChangeEvent) {
    let eventName = events.FILE_EDITED
    if (e.document.uri.scheme === 'output') {
      return
    }

    if (e.contentChanges.length === 1 && /\r\n|\n|\r/.test(e.contentChanges[0].text)) {
      eventName = events.FILE_ADDED_LINE
      this.onChange(eventName)
    }
    else {
      this.onChange(eventName)
    }
  }

  private onEditor(_e: vscode.TextEditor | undefined) {
    this.onChange(events.ACTIVATE_FILE_CHANGED)
  }

  private onChangeTextEditorSelection(e: vscode.TextEditorSelectionChangeEvent) {
    if (e.textEditor.document.uri.scheme === 'output') {
      return
    }

    if (Math.random() > 0.8) {
      this.onChange(events.CHANGE_EDITOR_SELECTION)
    }
  }

  private onChangeTextEditorVisibleRanges(_e: vscode.TextEditorVisibleRangesChangeEvent): void {
    if (_e.textEditor.document.uri.scheme === 'output') {
      return
    }

    this.onChange(events.CHANGE_EDITOR_VISIBLE_RANGES)
  }

  private onFocus(_e: vscode.WindowState) {
    this.onChange(events.EDITOR_CHANGED)
  }

  private onCreate() {
    this.onChange(events.FILE_CREATED)
  }

  private onSave(_e: vscode.TextDocument) {
    this.onChange(events.FILE_SAVED)
  }

  private getOperationType(eventName = 'unknown'): 'read' | 'write' {
    switch (eventName) {
      case events.FILE_CREATED:
      case events.FILE_EDITED:
      case events.FILE_ADDED_LINE:
      case events.FILE_REMOVED:
      case events.FILE_SAVED: {
        return 'write'
      }
      default: {
        return 'read'
      }
    }
  }

  private onChange(eventName = 'unknown') {
    const editor = vscode.window.activeTextEditor
    const workspaceName = vscode.workspace.name
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]
    if (workspaceRoot && editor) {
      const doc = editor.document
      if (doc && doc.uri.scheme !== 'output') {
        const lang = doc.languageId
        const absoluteFilePath = doc.fileName
        let relativeFilePath = vscode.workspace.asRelativePath(absoluteFilePath)
        if (relativeFilePath === absoluteFilePath) {
          relativeFilePath = '[other workspace]'
        }

        // Privacy filters: check ignored projects and files
        const ignoredProjects = this.getConfig<string[]>('ignoreProjects', [])
        if (workspaceName && isProjectIgnored(workspaceName, ignoredProjects)) {
          return
        }

        if (shouldIgnoreFile(relativeFilePath, workspaceRoot.uri.fsPath)) {
          return
        }

        // Apply path obfuscation if enabled or if sensitive file
        const obfuscate = this.getConfig<boolean>('obfuscateFilenames', false)
        const sanitizedRelativePath = sanitizeRelativePath(relativeFilePath, obfuscate)

        if (sanitizedRelativePath) {
          const now = Date.now()
          const eventKey = `${workspaceName}:${sanitizedRelativePath}:${eventName}`
          if (eventKey === this.lastTrackedEventKey && now - this.lastTrackedEventTime < this.eventDedupeWindowMs) {
            return
          }
          this.lastTrackedEventKey = eventKey
          this.lastTrackedEventTime = now

          const origin = getGitOriginUrl()
          const branch = getGitCurrentBranch()
          const data: CodeEvent = {
            project: workspaceName,
            language: lang,
            relativeFile: sanitizedRelativePath,
            absoluteFile: obfuscate ? undefined : absoluteFilePath,
            editor: vscode.env.appName,
            platform: this.osName,
            eventTime: now,
            eventType: eventName,
            platformArch: this.platformArch,
            gitOrigin: origin,
            gitBranch: branch,
            operationType: this.getOperationType(eventName),
          }

          this.debugLog(JSON.stringify(data))

          if (this.token === '') {
            this.statusBar.text = `$(clock) ${vscode.l10n.t('Ember: Without Token')}`
            this.statusBar.tooltip = vscode.l10n.t('Enter Token')
            this.statusBar.command = 'ember.getToken'
            return
          }

          // Enqueue event to resilient offline buffer
          this.queue.enqueue(data)
        }
      }
    }
  }

  private handleAuthError() {
    this.authRetryCount++

    if (this.authRetryCount <= this.maxAuthRetries) {
      this.debugLog(`Authentication failed, retrying (${this.authRetryCount}/${this.maxAuthRetries})...`)
      this.statusBar.text = `$(clock) ${vscode.l10n.t('Ember: Auth Failed')}`
      this.statusBar.tooltip = vscode.l10n.t('Ember: Authentication retry, please wait...')
      this.statusBar.command = 'ember.getToken'
    }
    else {
      this.debugLog('Max authentication retries exceeded, token invalid')
      this.handleTokenInvalid()
    }
  }

  private handleTokenInvalid() {
    this.authRetryCount = 0
    this.statusBar.text = `$(clock) ${vscode.l10n.t('Ember: Token Invalid')}`
    this.statusBar.tooltip = vscode.l10n.t('Enter Token')
    this.statusBar.command = 'ember.getToken'
  }

  private resetAuthRetryCount() {
    this.authRetryCount = 0
  }

  private updateStatusBarTooltip(durationText: string, currentMode: string) {
    const stats = this.queue.getStats()
    const tooltip = new vscode.MarkdownString('', true)
    tooltip.isTrusted = true
    tooltip.supportHtml = true

    tooltip.appendMarkdown(`### **Ember Time**\n\n`)
    tooltip.appendMarkdown(`* **${currentMode}**: \`${durationText}\`\n`)

    const activeProject = vscode.workspace.name || 'No Workspace'
    tooltip.appendMarkdown(`* **Workspace**: \`${activeProject}\`\n`)

    if (stats.queuedCount > 0) {
      tooltip.appendMarkdown(`* **Sync**: 🟡 Offline (\`${stats.queuedCount}\` events pending sync)\n\n`)
    }
    else {
      tooltip.appendMarkdown(`* **Sync**: 🟢 Connected & Synced\n\n`)
    }

    tooltip.appendMarkdown(`---\n\n`)
    tooltip.appendMarkdown(`[📊 Dashboard](command:ember.toDashboard) &nbsp;|&nbsp; [ℹ️ Status Info](command:ember.status)`)

    this.statusBar.tooltip = tooltip
  }

  private getCurrentDuration(showSuccess = false) {
    const key = 'Today'
    const dateKey = getLocalDateKey()
    if (dateKey !== this.durationDateKey) {
      this.durationDateKey = dateKey
      this.latestDurationMinutes = 0
      void getDurationText(0, vscode.env.language).then((formatted) => {
        if (this.durationDateKey === getLocalDateKey() && this.latestDurationMinutes === 0) {
          this.statusBar.text = `$(watch) ${formatted}`
          this.updateStatusBarTooltip(formatted, key)
        }
      })
    }

    if (this.token === '') {
      this.statusBar.text = `$(clock) ${vscode.l10n.t('Ember: Without Token')}`
      this.statusBar.tooltip = vscode.l10n.t('Enter Token')
      this.statusBar.command = 'ember.getToken'
      return
    }

    let currentLanguage = this.getConfig<any>('displayLanguage', { title: 'Auto' }).title
    if (currentLanguage === 'Auto' || !currentLanguage) {
      currentLanguage = vscode.env.language
    }

    this.statusBar.command = 'ember.status'
    const minutes = getMinutesSinceLocalMidnight()
    const requestId = ++this.durationRequestId
    this.apiRequest('GET', `/v3/users/self/minutes?minutes=${minutes}`).then(async (res: any) => {
      if (requestId !== this.durationRequestId || dateKey !== getLocalDateKey()) {
        return
      }
      const data = JSON.parse(res.body)
      const { minutes } = data
      this.latestDurationMinutes = minutes
      this.debugLog(`Current duration: ${minutes} minutes`)
      const formatted = await getDurationText(minutes, currentLanguage)
      if (requestId !== this.durationRequestId || dateKey !== getLocalDateKey()) {
        return
      }
      this.statusBar.text = `$(watch) ${formatted}`
      this.updateStatusBarTooltip(formatted, key)
      this.resetAuthRetryCount()
      if (showSuccess) {
        vscode.window.showInformationMessage(vscode.l10n.t('Ember: Token validation succeeded'))
      }
    }).catch((error: any) => {
      if (requestId !== this.durationRequestId || dateKey !== getLocalDateKey()) {
        return
      }
      if (error.response?.statusCode === 401) {
        this.handleAuthError()
      }
      else {
        this.debugLog(`[Duration] Network error: ${error.message || error}`)
        this.statusBar.text = `$(clock) ${vscode.l10n.t('Ember: Network Error')}`
        this.statusBar.tooltip = vscode.l10n.t('Ember: Network connection failed')
        this.statusBar.command = 'ember.status'
      }
    })
  }

  public async showStatusInfo() {
    const stats = this.queue.getStats()
    const mode = 'Today'
    const lang = vscode.env.language
    const duration = await getDurationText(this.latestDurationMinutes, lang)
    const tokenDisplay = this.token ? `Active (***${this.token.slice(-4)})` : 'Not Configured'

    const syncStatusText = stats.queuedCount > 0
      ? `🟡 ${stats.queuedCount} events buffered offline (retrying)`
      : `🟢 Synced with server`

    const items: vscode.QuickPickItem[] = [
      {
        label: `$(watch) Duration: ${duration} (${mode})`,
        description: `Current tracked code time`,
      },
      {
        label: `$(cloud) Sync Status: ${syncStatusText}`,
        description: stats.lastSyncTime ? `Last sync: ${new Date(stats.lastSyncTime).toLocaleTimeString()}` : 'No sync yet',
      },
      {
        label: `$(key) Auth Token: ${tokenDisplay}`,
        description: 'Click to update or re-enter your Ember token',
      },
      {
        label: `$(dashboard) Open Dashboard`,
        description: 'View graphs, languages, and project statistics',
      },
      {
        label: `$(sync) Force Sync Pending Events Now`,
        description: `Trigger immediate queue flush`,
      },
    ]

    const selected = await vscode.window.showQuickPick(items, {
      title: 'Ember Time - Status & Options',
      placeHolder: 'Select an action or view current status',
    })

    if (!selected) {
      return
    }

    if (selected.label.includes('Open Dashboard')) {
      vscode.commands.executeCommand('ember.toDashboard')
    }
    else if (selected.label.includes('Auth Token')) {
      this.setToken()
    }
    else if (selected.label.includes('Force Sync Pending Events')) {
      await this.queue.flush()
      vscode.window.showInformationMessage(`Ember: Force sync completed. Queued items: ${this.queue.getStats().queuedCount}`)
    }
  }

  public dispose() {
    this.statusBar.dispose()
    this.disposable?.dispose()
    this.queue?.dispose()
    clearInterval(this.inter)
  }
}

function parseHttpResponse(buf: Buffer): { statusCode: number, body: string } {
  const headerEnd = buf.indexOf('\r\n\r\n')
  if (headerEnd === -1) {
    throw new Error('Incomplete HTTP response (no header terminator)')
  }
  const headerText = buf.slice(0, headerEnd).toString('utf8')
  const lines = headerText.split('\r\n')
  const statusLine = lines[0] || ''
  const m = statusLine.match(/^HTTP\/\d\.\d (\d{3})/)
  if (!m) {
    throw new Error(`Invalid status line: ${statusLine}`)
  }
  const statusCode = Number(m[1])
  const headers = new Map<string, string>()
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':')
    if (idx > 0) {
      headers.set(lines[i].slice(0, idx).trim().toLowerCase(), lines[i].slice(idx + 1).trim())
    }
  }
  const rawBody = buf.slice(headerEnd + 4)
  const isChunked = (headers.get('transfer-encoding') || '').toLowerCase().includes('chunked')
  const bodyBuf = isChunked ? decodeChunked(rawBody) : rawBody
  return { statusCode, body: bodyBuf.toString('utf8') }
}

function decodeChunked(buf: Buffer): Buffer {
  const out: Buffer[] = []
  let offset = 0
  while (offset < buf.length) {
    const sizeLineEnd = buf.indexOf('\r\n', offset)
    if (sizeLineEnd === -1) {
      break
    }
    const sizeHex = buf.slice(offset, sizeLineEnd).toString('utf8').split(';')[0].trim()
    const size = Number.parseInt(sizeHex, 16)
    if (Number.isNaN(size)) {
      throw new TypeError(`Invalid chunk size: ${sizeHex}`)
    }
    if (size === 0) {
      break
    }
    const dataStart = sizeLineEnd + 2
    out.push(buf.slice(dataStart, dataStart + size))
    offset = dataStart + size + 2
  }
  return Buffer.concat(out)
}

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getMinutesSinceLocalMidnight(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes()
}
