# logis-pr

CLI lintas platform (Windows 10/11 & macOS) untuk workflow review PR tim **LOGis**. Satu perintah:

```text
logis-pr -m "pesan commit"
```

menjalankan berurutan:

1. **Commit & push** — `git add --all` + commit dengan prefix `LOGIS-XXXX: ` otomatis (bila belum ada), lalu `git push --set-upstream origin <branch>`. Working tree bersih → langsung push.
2. **Pull Request** via `gh` ke base branch (`development` secara default). PR open untuk branch ini sudah ada → dipakai ulang, tidak diduplikasi. Judul PR = pesan commit terakhir (ber-prefix tiket).
3. **Jira → Code Review** via REST API v3 (GET transitions → pilih transisi yang status tujuan/namanya cocok, case-insensitive → POST). Sudah di Code Review → dilewati. Transisi tidak tersedia → warning + daftar transisi, proses tetap lanjut.
4. **Teams** — preview pesan, konfirmasi `[Y/n]`, lalu kirim ke grup chat **Oknum LOGis** dengan format persis:

```text
Task: Review PR LOGIS-3938
Desc: [Backend] Enhance Bulk Last Route Location Response for Shipment and Driver Enrichment in [ServiceOrder]

PR: https://github.com/developerserasiautoraya/SELOG_LOGIS_ServiceOrder/pull/1886
Tiket: https://serasiautoraya.atlassian.net/browse/LOGIS-3938
```

Di akhir, link PR dicetak (stdout) dan disalin ke clipboard.

**Aman dijalankan ulang:** tidak ada PR ganda, tidak ada transisi ganda, dan pesan Teams untuk PR yang sama tidak dikirim dua kali (lihat [Idempotensi](#idempotensi)).

---

## Daftar isi

- [Prasyarat](#prasyarat)
- [Instalasi](#instalasi)
- [Konfigurasi](#konfigurasi)
- [Membuat Jira API token](#membuat-jira-api-token)
- [Setup Teams Workflows (grup chat Oknum LOGis)](#setup-teams-workflows-grup-chat-oknum-logis)
- [Fallback: Microsoft Graph API](#fallback-microsoft-graph-api)
- [Pemakaian](#pemakaian)
- [Idempotensi](#idempotensi)
- [Troubleshooting](#troubleshooting)
- [Pengembangan](#pengembangan)

---

## Prasyarat

| Tool | Versi | Catatan |
| --- | --- | --- |
| Node.js | ≥ 20 untuk menjalankan, ≥ 22.12 untuk build/test | Node 20 sudah EOL; disarankan Node 22 atau 24 LTS |
| git | apa saja yang modern | Windows: Git for Windows |
| GitHub CLI (`gh`) | ≥ 2.40 | harus sudah `gh auth login` |

Tidak butuh Bash, WSL, maupun Git Bash. Semua perintah eksternal dijalankan tanpa shell (array argumen), sehingga perilakunya identik di PowerShell, cmd, Windows Terminal, dan zsh.

## Instalasi

### Windows (PowerShell)

```powershell
winget install --id Git.Git
winget install --id GitHub.cli
winget install --id OpenJS.NodeJS.LTS
# TUTUP lalu buka lagi terminal agar PATH ter-refresh
gh auth login

cd C:\path\ke\logis-pr
npm install
npm run build
npm install -g .        # atau: npm link

logis-pr --version
logis-pr init
logis-pr doctor
```

npm membuat shim `logis-pr.cmd` dan `logis-pr.ps1` sehingga perintah bisa dipanggil dari PowerShell maupun cmd. Bila PowerShell menolak menjalankan `logis-pr.ps1` karena execution policy, jalankan sekali: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

### macOS (zsh)

```bash
brew install git gh node
gh auth login

cd ~/path/ke/logis-pr
npm install
npm run build
npm install -g .        # atau: npm link

logis-pr --version
logis-pr init
logis-pr doctor
```

### Update

```text
git pull
npm install
npm run build
```

Karena `npm install -g .` membuat symlink ke folder ini, build ulang langsung berlaku tanpa install ulang.

## Konfigurasi

Config disimpan di `~/.logis-pr.json` (Windows: `%USERPROFILE%\.logis-pr.json`). Cara termudah membuatnya: `logis-pr init` (wizard interaktif; secret diketik dengan masking dan tidak pernah ditampilkan ulang). File ditulis dengan permission `600` di macOS.

Contoh isi:

```json
{
  "jiraBaseUrl": "https://serasiautoraya.atlassian.net",
  "jiraEmail": "nama@serasiautoraya.co.id",
  "jiraApiToken": "ATATT3x...",
  "jiraReviewStatus": "Code Review",
  "jiraProjectKey": "LOGIS",
  "teamsMode": "workflow",
  "teamsWebhookUrl": "https://....logic.azure.com/workflows/.../invoke?...&sig=...",
  "graphTenantId": "",
  "graphClientId": "",
  "graphChatId": "",
  "baseBranch": "development",
  "repoPrefix": "SELOG_LOGIS_"
}
```

Setiap field bisa di-override dengan environment variable (berguna untuk CI atau mesin bersama):

| Field | Env var | Default |
| --- | --- | --- |
| `jiraBaseUrl` | `LOGIS_PR_JIRA_BASE_URL` | `https://serasiautoraya.atlassian.net` |
| `jiraEmail` | `LOGIS_PR_JIRA_EMAIL` | — |
| `jiraApiToken` | `LOGIS_PR_JIRA_API_TOKEN` | — |
| `jiraReviewStatus` | `LOGIS_PR_JIRA_REVIEW_STATUS` | `Code Review` |
| `jiraProjectKey` | `LOGIS_PR_JIRA_PROJECT_KEY` | `LOGIS` |
| `teamsMode` | `LOGIS_PR_TEAMS_MODE` | `workflow` (`graph` untuk fallback) |
| `teamsWebhookUrl` | `LOGIS_PR_TEAMS_WEBHOOK_URL` | — |
| `graphTenantId` | `LOGIS_PR_GRAPH_TENANT_ID` | — |
| `graphClientId` | `LOGIS_PR_GRAPH_CLIENT_ID` | — |
| `graphChatId` | `LOGIS_PR_GRAPH_CHAT_ID` | — |
| `baseBranch` | `LOGIS_PR_BASE_BRANCH` | `development` |
| `repoPrefix` | `LOGIS_PR_REPO_PREFIX` | `SELOG_LOGIS_` |

Env lain: `LOGIS_PR_CONFIG` (lokasi file config lain), `LOGIS_PR_ASCII=1` (paksa simbol ASCII), `LOGIS_PR_ASCII=0` (paksa Unicode), `LOGIS_PR_DEBUG=1` (tampilkan stack trace untuk error tak terduga).

Contoh set env sementara:

```powershell
# PowerShell
$env:LOGIS_PR_BASE_BRANCH = "staging"; logis-pr -m "hotfix"
```

```bash
# zsh
LOGIS_PR_BASE_BRANCH=staging logis-pr -m "hotfix"
```

> **Secret:** `jiraApiToken` dan `teamsWebhookUrl` (berisi tanda tangan `sig=`) adalah kredensial. Jangan commit file config. `logis-pr` tidak pernah mencetaknya; `doctor` hanya menampilkan versi tersamar.

## Membuat Jira API token

1. Login ke Atlassian lalu buka https://id.atlassian.com/manage-profile/security/api-tokens.
2. Klik **Create API token** (token klasik, **bukan** "Create API token with scopes" — token ber-scope harus dipanggil lewat gateway `api.atlassian.com`, bukan URL site).
3. Beri label, mis. `logis-pr`, pilih masa berlaku, lalu **Create**.
4. Salin token (hanya ditampilkan sekali) dan tempel saat `logis-pr init`.
5. `jiraEmail` = email akun Atlassian yang membuat token.

Token punya tanggal kedaluwarsa. Saat kedaluwarsa, Jira membalas 401 — buat token baru dan jalankan `logis-pr init` lagi.

## Setup Teams Workflows (grup chat Oknum LOGis)

Incoming Webhook (connector lama) **tidak bisa** mengirim ke group chat. Solusinya flow Power Automate / Teams Workflows yang menerima HTTP request lalu memposting pesan **atas nama Anda**.

1. Buka https://make.powerautomate.com (atau app **Workflows** di Teams → *Create* → *Create from blank*), pastikan environment = tenant kantor.
2. **+ Create → Instant cloud flow → Skip**, beri nama `logis-pr → Oknum LOGis`.
3. Tambahkan trigger **Microsoft Teams → "When a Teams webhook request is received"**.
   - **Who can trigger the flow?** → **Anyone**. (Opsi "Any user in my tenant"/"Specific users" mewajibkan token Entra ID yang tidak dikirim oleh `logis-pr`.)
   - *Request Body JSON Schema* boleh dikosongkan. Bila ingin dynamic content, tempel:
     ```json
     {
       "type": "object",
       "properties": {
         "text": { "type": "string" },
         "html": { "type": "string" },
         "ticket": { "type": "string" },
         "desc": { "type": "string" },
         "prUrl": { "type": "string" },
         "ticketUrl": { "type": "string" },
         "source": { "type": "string" }
       }
     }
     ```
4. **+ New step → Microsoft Teams → "Post message in a chat or channel"**:
   - **Post as:** `User`
   - **Post in:** `Group chat`
   - **Group chat:** pilih **Oknum LOGis** (Anda harus anggota grup tersebut)
   - **Message:** klik ikon *fx* / *Insert expression* (di designer baru ketik `/` → *Insert expression*), isi:
     ```text
     triggerBody()?['html']
     ```
     lalu **Add/OK**. Field Message adalah editor HTML, sehingga `<br>` menjadi baris baru dan `<a href>` menjadi link yang bisa diklik.
5. **Save**. Buka lagi trigger, salin **HTTP URL** (muncul setelah disimpan).
6. Jalankan `logis-pr init`, pilih *Teams Workflows*, tempel URL tersebut.
7. Uji: `logis-pr doctor --test-teams` → pesan uji muncul di grup Oknum LOGis atas nama Anda.

Payload yang dikirim `logis-pr` (Content-Type `application/json`):

```json
{
  "text": "Task: Review PR LOGIS-3938\nDesc: ...\n\nPR: https://...\nTiket: https://...",
  "html": "Task: Review PR LOGIS-3938<br>Desc: ...<br><br>PR: <a href=\"https://...\">https://...</a><br>Tiket: <a href=\"https://...\">https://...</a>",
  "ticket": "LOGIS-3938",
  "desc": "...",
  "prUrl": "https://...",
  "ticketUrl": "https://...",
  "source": "logis-pr"
}
```

Semua nilai di `html` sudah di-escape (`& < > " '`), dan `href` hanya menerima `http(s)`.

## Fallback: Microsoft Graph API

Gunakan bila tenant memblokir Workflows/Power Automate. Pesan dikirim langsung lewat `POST /chats/{chat-id}/messages` atas nama Anda (delegated, device code flow — tidak perlu client secret).

1. Buka https://entra.microsoft.com → **App registrations → New registration**: nama `logis-pr`, *Accounts in this organizational directory only*.
2. **Authentication → Advanced settings → Allow public client flows = Yes** → Save.
3. **API permissions → Add → Microsoft Graph → Delegated**: `ChatMessage.Send`, `Chat.ReadBasic` (plus `offline_access`). Bila tenant tidak mengizinkan user consent, minta admin klik *Grant admin consent*.
4. Salin **Directory (tenant) ID** dan **Application (client) ID**.
5. `logis-pr init` → pilih *Microsoft Graph API* → isi tenant & client ID.
6. `logis-pr graph-login` → buka URL yang ditampilkan, masukkan kode, login.
7. `logis-pr graph-chats -n "Oknum LOGis"` → salin ID chat (`19:...@thread.v2`) ke `graphChatId` (via `logis-pr init` atau env `LOGIS_PR_GRAPH_CHAT_ID`).
8. `logis-pr doctor` untuk verifikasi.

Token disimpan di `~/.logis-pr-graph-token.json` (permission 600) dan diperbarui otomatis dengan refresh token.

## Pemakaian

```text
logis-pr [opsi]
logis-pr init | doctor [--test-teams] | graph-login | graph-chats [-n nama]
```

| Opsi | Keterangan |
| --- | --- |
| `-m, --message <pesan>` | pesan commit; prefix `LOGIS-XXXX: ` ditambahkan bila belum ada |
| `-t, --ticket <key>` | override key tiket dari nama branch (`LOGIS-3938` atau `3938`) |
| `-b, --base <branch>` | base branch PR (default `baseBranch`) |
| `-d, --draft` | buat PR sebagai draft |
| `-y, --yes` | kirim ke Teams tanpa konfirmasi |
| `--no-jira` | jangan pindahkan status tiket (summary tetap dibaca bila kredensial ada) |
| `--no-teams` | jangan kirim pesan Teams |
| `--dry-run` | tampilkan semua yang AKAN dilakukan; tidak commit/push/PR/transisi/pesan |
| `-h, --help` / `-v, --version` | bantuan / versi |

Contoh:

```text
# Alur harian
logis-pr -m "tambah enrichment shipment & driver"

# Sudah commit manual, tinggal push + PR + Jira + Teams
logis-pr

# PR draft tanpa pengumuman
logis-pr -m "wip" -d --no-teams

# Branch tanpa key tiket, base staging, tanpa konfirmasi
logis-pr -t LOGIS-3938 -b staging -y

# Cek rencana dulu
logis-pr --dry-run -m "coba"
```

Contoh output `--dry-run`:

```text
Validasi
✔ git version 2.47.0.windows.1
✔ gh version 2.80.0
✔ gh sudah login
✔ Repo developerserasiautoraya/SELOG_LOGIS_ServiceOrder · branch feature/LOGIS-3938-bulk-last-route → development · tiket LOGIS-3938
✔ Jira LOGIS-3938: "[Backend] Enhance Bulk Last Route ..." [In Progress]

[1/4] Commit & push
ℹ [dry-run] Akan commit 1 file: "LOGIS-3938: coba"
ℹ [dry-run] Akan menjalankan: git push --set-upstream origin feature/LOGIS-3938-bulk-last-route

[2/4] Pull Request
ℹ [dry-run] Akan membuat PR feature/LOGIS-3938-bulk-last-route → development

[3/4] Jira → Code Review
ℹ [dry-run] Akan menjalankan transisi 'Ready for Review' (id 21).

[4/4] Teams → Oknum LOGis
Preview pesan: ...
ℹ [dry-run] Pesan tidak dikirim.
```

`--dry-run` tetap melakukan **pembacaan** (git status, `gh pr list`, GET Jira) agar rencana akurat, tetapi tidak ada request yang mengubah apa pun.

Log ditulis ke stderr; stdout hanya berisi link PR, sehingga bisa dipakai di skrip: `$pr = logis-pr -y` (PowerShell) atau `pr=$(logis-pr -y)` (zsh).

### Validasi di awal (gagal = exit code 1, tanpa efek samping)

git & gh terpasang · gh sudah login · berada di repo git · bukan detached HEAD · bukan di base branch · remote origin adalah repo GitHub · key tiket ditemukan · config lengkap · ada perubahan tetapi `-m` tidak diberikan · tiket bisa diakses di Jira.

### Aturan isi pesan

- `Desc` = summary tiket Jira; bila belum diakhiri ` in [<Service>]` (case-insensitive) maka suffix itu ditambahkan. `Service` = nama repo tanpa `SELOG_LOGIS_`.
- Baris kosong antara `Desc` dan `PR` selalu ada; link PR & tiket bisa diklik.

## Idempotensi

| Situasi saat dijalankan ulang | Perilaku |
| --- | --- |
| Working tree bersih | tidak commit; push tetap dijalankan (no-op bila sudah sinkron) |
| PR open untuk branch sudah ada | dipakai ulang, tidak membuat PR baru |
| `gh pr create` balapan ("already exists") | PR yang ada diambil |
| Tiket sudah di Code Review | tidak ada POST transisi |
| Pesan Teams untuk PR ini sudah pernah dikirim | dengan `-y`: tidak dikirim ulang · interaktif: ditanya "Kirim ULANG?" default **Tidak** |

Catatan pengiriman disimpan di `~/.logis-pr-state.json` (per mesin).

## Troubleshooting

**Jira 401 (`Jira menolak kredensial`)**
- Email salah (harus email akun Atlassian), token salah/kedaluwarsa/dicabut, atau memakai token "with scopes". Buat token klasik baru → `logis-pr init` → `logis-pr doctor`.
- Pastikan `jiraBaseUrl` = `https://serasiautoraya.atlassian.net` (tanpa `/jira` atau path lain).

**Jira 404 untuk tiket**
- Key salah (cek nama branch, atau pakai `-t LOGIS-1234`), atau akun tidak punya akses Browse ke project.

**Transisi ke Code Review tidak tersedia**
- Workflow Jira tidak mengizinkan perpindahan langsung dari status saat ini (mis. dari *To Do*). `logis-pr` menampilkan daftar transisi yang ada — pindahkan dulu ke status perantara (mis. *In Progress*) lalu jalankan ulang, atau sesuaikan `jiraReviewStatus` bila nama status di board berbeda.

**Flow Teams gagal**
- `401/403`: trigger tidak di-set **Anyone**, atau URL sudah di-regenerate. Salin ulang HTTP URL.
- `404`: flow dihapus/dimatikan atau URL berubah.
- `400`: *Request Body JSON Schema* di trigger tidak cocok — kosongkan atau gunakan schema di atas.
- `202` tapi pesan tidak muncul: buka **My flows → (flow) → Run history** untuk melihat error action. Penyebab umum: akun pemilik koneksi bukan anggota grup Oknum LOGis, atau koneksi Teams di flow kedaluwarsa (perbaiki di *Connections*).
- Tag HTML tampil mentah: expression dimasukkan sebagai teks biasa. Hapus, lalu sisipkan lagi lewat *Insert expression* (`triggerBody()?['html']`), atau buka *code view* `</>` di field Message.
- URL lama `*.webhook.office.com` ditolak oleh `logis-pr` karena itu Incoming Webhook (tidak bisa ke group chat).
- Workflows diblokir tenant → gunakan [fallback Graph](#fallback-microsoft-graph-api).

**`gh` tidak ditemukan di PATH (Windows)**
- Pasang: `winget install --id GitHub.cli`, lalu **tutup semua jendela terminal** (dan VS Code) dan buka lagi — PATH baru tidak masuk ke terminal yang sudah terbuka.
- Cek: `where.exe gh`. Biasanya ada di `C:\Program Files\GitHub CLI\gh.exe`. Bila tidak muncul, tambahkan folder tersebut ke *Environment Variables → Path* (User).
- Terpasang lewat Scoop: pastikan `%USERPROFILE%\scoop\shims` ada di PATH.
- Setelah itu: `gh auth login`, lalu `logis-pr doctor`.

**`gh` belum login / tidak punya akses repo**
- `gh auth login` lalu `gh auth status`. Untuk org `developerserasiautoraya` dengan SSO, otorisasi token di GitHub (*Settings → Applications*) bila diminta.

**Push gagal / minta kredensial**
- `logis-pr` meneruskan stdin ke `git push`, sehingga Git Credential Manager (Windows) atau keychain (macOS) tetap bisa meminta login. Pastikan `git push` manual berhasil sekali.

**Pre-commit hook gagal**
- Pesan dari hook (husky/lint-staged) ditampilkan; perbaiki lalu jalankan ulang. Tidak ada PR/Jira/Teams yang dijalankan bila commit gagal.

**Simbol tampil sebagai kotak/tanda tanya di Windows**
- Gunakan Windows Terminal, atau `$env:LOGIS_PR_ASCII = "1"` untuk simbol ASCII (`[OK] [!] [X]`). Fallback ASCII otomatis aktif di conhost lama.

**Clipboard gagal**
- Windows memakai `clip.exe` (fallback `Set-Clipboard`), macOS `pbcopy`. Link tetap tercetak di akhir untuk disalin manual.

**Error tak terduga**
- Jalankan ulang dengan `LOGIS_PR_DEBUG=1` untuk stack trace (PowerShell: `$env:LOGIS_PR_DEBUG = "1"`).

## Pengembangan

```text
npm install
npm run dev -- --dry-run -m "coba"   # jalankan dari source (tsx)
npm run lint                         # ESLint + tsc --noEmit
npm test                             # vitest (semua HTTP & git/gh di-mock)
npm run build                        # bundel satu file: dist/cli.js
```

Struktur:

```text
src/
  cli/       index.ts (commander), run.ts (orkestrasi), init.ts, doctor.ts, graph.ts, prompt.ts
  config/    index.ts (file + env), state.ts (catatan pesan Teams terkirim)
  git/       wrapper git (tanpa shell, pesan commit via stdin)
  github/    wrapper gh (body PR via stdin, deteksi PR yang sudah ada)
  jira/      REST API v3 + pemilihan transisi
  teams/     workflow.ts (Power Automate), graph.ts (device code + Graph)
  message/   formatter: key tiket, Desc, pesan text/html, escape
  utils/     exec (cross-spawn), http (fetch), term (simbol/ASCII), secret, clipboard
test/        unit test vitest
```

Semua dependensi (commander, picocolors, @inquirer/prompts, cross-spawn) dibundel ke `dist/cli.js`, sehingga runtime tidak butuh `node_modules`. Clipboard memakai utilitas bawaan OS (bukan clipboardy) karena biner fallback clipboardy tidak ikut saat dibundel.

CI (`.github/workflows/ci.yml`) menjalankan lint, build, test, dan smoke test instalasi global di `windows-latest` dan `macos-latest`, termasuk menjalankan bundel di Node 20.
