# Ember Time — Developer Productivity & Code Tracking

<p align="center">
  <img src="images/logo.png" width="128" height="128" alt="Ember Time Logo" />
</p>

<p align="center">
  <strong>Automatic, privacy-first code time tracking and deep work analytics for software engineers.</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#privacy--security">Privacy</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#commands">Commands</a>
</p>

---

## ⚡ Features

* **⏱️ Precision Time Tracking**: Automatically tracks time spent across projects, languages, and git branches as you code.
* **🛡️ Privacy-First Architecture**: Only records activity metadata. Zero source code or keystroke contents are ever inspected or transmitted.
* **📶 Offline Resilient Queue**: Coding on an airplane or disconnected? Events are buffered safely to local encrypted storage and seamlessly synced when connectivity returns.
* **⚡ One-Click Sign In**: Sign in effortlessly via your browser with direct VS Code deep-linking (`vscode://`).
* **📊 Rich Status Bar & Insights**: View your daily or all-time stats directly in your editor status bar with interactive Markdown tooltips.
* **🌐 Multilingual Support**: Built-in support for 13+ languages (English, Urdu, Hindi, Japanese, Spanish, German, French, etc.).
* **🔒 Privacy Guard**: Automatic `.env` & secrets masking, `.emberignore` workspace exclusion, and file path obfuscation modes.

---

## 🚀 Quick Start

### Step 1: Install the Extension
Install **Ember Time** (`jeevavarshan.ember-tracker`) from the Visual Studio Code Marketplace or Open VSX.

### Step 2: Sign In / Authenticate
1. Press `Cmd + Shift + P` (or `Ctrl + Shift + P` on Windows/Linux).
2. Type **`Ember: Enter token`** and paste your API token, or click **"Sign in via Browser"** from your dashboard to connect in one click.

### Step 3: Code!
Your coding time will begin tracking immediately in the status bar at the bottom of your editor.

---

## 🎛️ Daily Status Bar

The status bar shows today's tracked coding time. It uses your local calendar day, refreshes periodically, and resets to zero when the date changes.

## 📈 Coding Activity Reports

Run **Ember: Coding activity report** from the Command Palette to view this week's daily totals, this month's daily totals, this year's monthly totals, or a recent session timeline. A coding session continues while activity in the same project is no more than 15 minutes apart. Active time is estimated from activity events, capped at two minutes per interval, so idle gaps are not counted.

Reports are stored locally until you sign in to Supabase activity sync. After sign-in, session data syncs to your Supabase account and reports load from the authenticated activity API.

### Enable Supabase activity sync

The repository includes an authenticated `coding-activity` Edge Function and migrations for session storage, row-level security, and idempotent upserts:

1. In Supabase Auth, enable email sign-in, configure production SMTP, and add `vscode://jeevavarshan.ember-tracker/auth` to the allowed redirect URLs.
2. Set `ember.supabaseAnonKey` in VS Code to the project's anon/public key. The service-role key must remain server-side and must never be added to extension settings.
3. From this repository, run `supabase login`, `supabase link --project-ref tvbiqpxhlxnpinhspvnn`, `supabase db push`, and `supabase functions deploy coding-activity`.
4. Run **Ember: Sign in to Supabase activity sync** and open the email link in VS Code. Activity reports will then sync to the signed-in account; without sign-in, reports remain local.

The Edge Function verifies the Supabase access token and assigns ownership from the verified user, not from client-supplied user IDs.

Supabase activity sync is separate from the existing Ember event API. If you also want the legacy server event log and daily status-bar total, keep configuring your Ember API token as before; setting `ember.supabaseAnonKey` suppresses the automatic legacy-token prompt but does not replace that API's token.

---

## 🔐 Privacy & Security

We believe your intellectual property must remain entirely yours:

* **No Code Uploaded**: We never read, buffer, or upload the contents of your files.
* **Automatic Secrets Filtering**: Files matching `.env`, SSH keys (`id_rsa`), certificates (`*.pem`, `*.key`), and credential files are automatically ignored.
* **`.emberignore`**: Add an `.emberignore` file to any workspace root to exclude specific files or directories.
* **Path Obfuscation**: Toggle `"ember.obfuscateFilenames": true` to mask file names while preserving language breakdown.

Read our complete [Privacy Policy](PRIVACY.md) for full architectural details.

---

## ⚙️ Configuration

Open your VS Code Settings (`Cmd + ,`) and search for `ember`:

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `ember.serverEntrypoint` | `string` | *(Ember Cloud)* | Backend reporting endpoint for synchronization. |
| `ember.supabaseUrl` | `string` | Ember Supabase project | Supabase project URL for authenticated activity reports. |
| `ember.supabaseAnonKey` | `string` | `""` | Supabase anon/public key used for sign-in and activity API requests. Never use a service-role key. |
| `ember.obfuscateFilenames` | `boolean` | `false` | Mask file names in activity logs for heightened privacy. |
| `ember.ignoreProjects` | `array` | `[]` | List of project names or glob patterns to exclude from tracking. |
| `ember.heartbeatInterval` | `number` | `30` | Interval in seconds to batch and sync events to the server. |
| `ember.proxy` | `string` | `""` | Custom HTTP/HTTPS proxy URL (e.g. `http://127.0.0.1:8080`). |
| `ember.displayLanguage.title` | `string` | `"Auto"` | Interface language (Auto, English, Urdu, Japanese, etc.). |

---

## ⌨️ Command Palette Shortcuts

| Command | Action |
| :--- | :--- |
| **`Ember: Enter token`** | Configure or update your user token. |
| **`Ember: Show Status & Sync Info`** | View sync status, queue depth, and quick actions. |
| **`Ember: Browse dashboard`** | Open your personal analytics dashboard. |
| **`Ember: Sign in to Supabase activity sync`** | Sign in with an email magic link to sync session reports across devices. |

---

## 📄 License

MIT © [Jeeva Varshan](https://github.com/Jeeva1070)
