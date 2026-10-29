import * as fs from 'node:fs'
import path from 'node:path'

// Cache for .emberignore patterns per workspace
const emberIgnoreCache = new Map<string, { mtime: number, patterns: string[] }>()

// Suffixes and patterns indicating sensitive files
const SENSITIVE_PATTERNS = [
  /^\.env(\..+)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|pkcs12|pfx|p12|kdbx)$/i,
  /(secret|credential|password|token)s?(\.ya?ml|\.json|\.txt|\.conf)?$/i,
]

export function isSensitiveFile(fileName: string): boolean {
  const base = path.basename(fileName)
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(base))
}

export function loadEmberIgnorePatterns(workspaceRoot: string): string[] {
  const ignoreFile = path.join(workspaceRoot, '.emberignore')
  try {
    if (!fs.existsSync(ignoreFile)) {
      return []
    }
    const stat = fs.statSync(ignoreFile)
    const cached = emberIgnoreCache.get(workspaceRoot)
    if (cached && cached.mtime === stat.mtimeMs) {
      return cached.patterns
    }
    const content = fs.readFileSync(ignoreFile, 'utf8')
    const patterns = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'))
    emberIgnoreCache.set(workspaceRoot, { mtime: stat.mtimeMs, patterns })
    return patterns
  }
  catch {
    return []
  }
}

export function matchesPattern(relativeFilePath: string, pattern: string): boolean {
  const normalizedPath = relativeFilePath.replaceAll('\\', '/')
  const cleanPattern = pattern.replaceAll('\\', '/').replace(/^\/+/, '')

  if (cleanPattern.endsWith('/')) {
    const dirPattern = cleanPattern.slice(0, -1)
    return normalizedPath === dirPattern || normalizedPath.startsWith(`${dirPattern}/`)
  }

  if (cleanPattern.includes('*')) {
    const regexPattern = cleanPattern.replaceAll('.', '\.').replaceAll('*', '.*')
    const regex = new RegExp(`^${regexPattern}$`, 'i')
    return regex.test(normalizedPath) || regex.test(path.basename(normalizedPath))
  }

  return normalizedPath === cleanPattern || path.basename(normalizedPath) === cleanPattern
}

export function shouldIgnoreFile(relativeFilePath: string, workspaceRoot?: string): boolean {
  const normalized = relativeFilePath.replaceAll('\\', '/')

  // Always ignore internal git data and node_modules internals
  if (normalized.startsWith('.git/') || normalized === '.git') {
    return true
  }

  if (workspaceRoot) {
    const patterns = loadEmberIgnorePatterns(workspaceRoot)
    for (const pattern of patterns) {
      if (matchesPattern(relativeFilePath, pattern)) {
        return true
      }
    }
  }

  return false
}

export function isProjectIgnored(projectName: string, ignoredProjects: string[]): boolean {
  if (!projectName || !ignoredProjects || ignoredProjects.length === 0) {
    return false
  }
  return ignoredProjects.some(pattern => matchesPattern(projectName, pattern))
}

export function sanitizeRelativePath(relativeFilePath: string, obfuscate: boolean): string {
  // If it's a sensitive file, always mask it
  if (isSensitiveFile(relativeFilePath)) {
    const ext = path.extname(relativeFilePath)
    return `[sensitive-file]${ext}`
  }

  if (!obfuscate) {
    return relativeFilePath
  }

  // Obfuscate path but preserve extension for language stats
  const ext = path.extname(relativeFilePath)
  const segments = relativeFilePath.replaceAll('\\', '/').split('/')
  const maskedSegments = segments.map((_seg: string, idx: number) => {
    if (idx === segments.length - 1) {
      return `[file]${ext}`
    }
    return `[dir]`
  })
  return maskedSegments.join('/')
}
