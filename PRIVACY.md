# Privacy & Data Policy — Ember Time

Ember Time is built with a **privacy-first architecture** designed specifically for software engineers. We believe your source code and proprietary logic should never leave your machine.

---

## 🔒 What Ember Collects (Activity Metadata Only)

Ember tracks **only productivity metadata**, specifically:
* **Event Type**: E.g., `fileEdited`, `fileCreated`, `fileSaved`.
* **File Metadata**: Relative file path (e.g., `src/index.ts`) and detected programming language (e.g., `TypeScript`).
* **Timestamp**: Time of the interaction.
* **Workspace / Project Name**: The folder name of the current workspace.
* **Git Context**: Current git branch name and origin remote URL (if permitted in your settings).
* **Environment**: VS Code version and operating system platform.

---

## 🚫 What Ember NEVER Collects

* **NO Source Code**: Your actual code, snippets, functions, or variable contents are never inspected, buffered, or transmitted.
* **NO Keystroke Contents**: Ember measures activity intervals, not what you type.
* **NO Git Commit Contents**: Diffs and commit messages are never accessed or sent.
* **NO Secrets or Credentials**: Files matching `.env`, credentials, SSH keys, certificates, or tokens are automatically blacklisted and excluded.

---

## 🛡️ Built-in Privacy Controls

### 1. Automatic Sensitive File Exclusion
Files matching any of the following patterns are automatically excluded from activity tracking:
* `.env`, `.env.*`
* `id_rsa`, `id_ed25519`, `*.pem`, `*.key`, `*.pfx`, `*.kdbx`
* Files containing `secret`, `credential`, `password`, or `token` in their name.

### 2. `.emberignore` Support
You can create an `.emberignore` file in your workspace root (syntax identical to `.gitignore`) to exclude entire directories or proprietary modules:
```gitignore
# Exclude proprietary client modules
client-nda/
confidential/
*.secret.ts
```

### 3. File Path Obfuscation
If you prefer not to transmit actual file names to the cloud, enable:
```json
{
  "ember.obfuscateFilenames": true
}
```
When enabled, file paths are masked to `[dir]/[file].<ext>`. Your programming language breakdown remains 100% accurate, but file names remain strictly private.

### 4. Ignored Projects
Exclude personal or sensitive repositories from tracking via your settings:
```json
{
  "ember.ignoreProjects": ["internal-secret-project", "personal-taxes"]
}
```

---

## 📡 Offline Buffer & Security

* **Encrypted Transport**: All communication with the Ember backend uses TLS/HTTPS (`https://...`).
* **Secure Token Storage**: Authentication tokens are stored inside the OS Keychain via VS Code's `SecretStorage` API.
* **Offline Resilience**: When you are offline, event metadata is buffered locally on your disk in encrypted user storage. It is flushed when a secure connection is re-established.
