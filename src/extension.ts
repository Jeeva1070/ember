import * as fs from 'node:fs/promises'
import path from 'node:path'
import * as vscode from 'vscode'
import { CodeTime } from './codetime'

// Localization cache
let localizationBundle: Record<string, string> = {}
let currentLanguage: string = ''

/**
 * Load localization bundle
 */
async function loadLocalizationResources(context: vscode.ExtensionContext, language: string) {
  const l10nFile = context.asAbsolutePath(path.join('l10n', `bundle.l10n.${language}.json`))
  const nlsFile = context.asAbsolutePath(`package.nls.${language}.json`)
  let loaded = false
  try {
    const l10nContent = await fs.readFile(l10nFile, 'utf8')
    localizationBundle = JSON.parse(l10nContent)
    loaded = true
  }
  catch {}
  if (!loaded) {
    try {
      const nlsContent = await fs.readFile(nlsFile, 'utf8')
      localizationBundle = JSON.parse(nlsContent)
      loaded = true
    }
    catch {}
  }
  if (!loaded) {
    localizationBundle = {}
  }
  currentLanguage = language
}

export function getLocalizedString(key: string): string {
  return localizationBundle[key] || key
}

let codetime: CodeTime

export async function activate(context: vscode.ExtensionContext) {
  // Read displayLanguage config with fallback
  const config = vscode.workspace.getConfiguration('ember')
  const fallbackConfig = vscode.workspace.getConfiguration('codetime')
  const displayLanguage = config.get('displayLanguage') || fallbackConfig.get('displayLanguage', { title: 'Auto' })
  let language = (displayLanguage as any)?.title === 'Auto' ? (vscode.env.language ?? '') : (displayLanguage as any)?.title || ''
  language = language.toLowerCase()
  await loadLocalizationResources(context, language)

  const storageDir = context.globalStorageUri ? context.globalStorageUri.fsPath : context.extensionUri.fsPath
  codetime = new CodeTime(context.globalState, context.secrets, storageDir)

  // Register all commands and handlers
  context.subscriptions.push(
    // Primary Ember commands
    vscode.commands.registerCommand('ember.getToken', () => {
      codetime.setToken()
    }),
    vscode.commands.registerCommand('ember.codeTimeInStatusBar', () => {
      codetime.codeTimeInStatBar()
    }),
    vscode.commands.registerCommand('ember.status', () => {
      codetime.showStatusInfo()
    }),
    vscode.commands.registerCommand('ember.toDashboard', () => {
      const url = `ember://dashboard`
      vscode.env.openExternal(vscode.Uri.parse(url)).then(
        (success) => {
          if (!success) {
            // Fallback to web entrypoint if custom protocol handler is not installed
            const webEntrypoint = codetime.getConfig<string>('serverEntrypoint', 'https://tvbiqpxhlxnpinhspvnn.supabase.co')
            vscode.env.openExternal(vscode.Uri.parse(webEntrypoint))
          }
        },
        () => {
          const webEntrypoint = codetime.getConfig<string>('serverEntrypoint', 'https://tvbiqpxhlxnpinhspvnn.supabase.co')
          vscode.env.openExternal(vscode.Uri.parse(webEntrypoint))
        },
      )
    }),

    // Backward-compatibility aliases for codetime.*
    vscode.commands.registerCommand('codetime.getToken', () => {
      vscode.commands.executeCommand('ember.getToken')
    }),
    vscode.commands.registerCommand('codetime.codeTimeInStatusBar', () => {
      vscode.commands.executeCommand('ember.codeTimeInStatusBar')
    }),
    vscode.commands.registerCommand('codetime.toDashboard', () => {
      vscode.commands.executeCommand('ember.toDashboard')
    }),

    // OAuth / Browser login UriHandler (supports vscode://jeevavarshan.ember-tracker/auth?token=...)
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        const query = new URLSearchParams(uri.query)
        const token = query.get('token')
        if (token) {
          codetime.setTokenDirectly(token, true)
          vscode.window.showInformationMessage('Ember: Successfully connected! Time tracking is now active.')
        }
        else if (uri.path === '/status') {
          codetime.showStatusInfo()
        }
      },
    }),

    // Configuration change listener
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('ember.displayLanguage') || e.affectsConfiguration('codetime.displayLanguage')) {
        const newConfig = vscode.workspace.getConfiguration('ember')
        const newDisplayLanguage = newConfig.get<any>('displayLanguage') || vscode.workspace.getConfiguration('codetime').get<any>('displayLanguage', { title: 'Auto' })
        const title = newDisplayLanguage?.title || 'Auto'
        const newLang = title === 'Auto' ? vscode.env.language : title
        if (newLang !== currentLanguage) {
          await loadLocalizationResources(context, newLang.toLowerCase())
        }
      }
    }),
  )
}

export function deactivate() {
  if (codetime) {
    codetime.dispose()
  }
}
