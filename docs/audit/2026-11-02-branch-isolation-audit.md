# Audit logis-pr v1.3.0 — Branch Isolation & PR Safety

Tanggal: 2 November 2026 · Versi diaudit: **v1.3.0** (commit `a94bc86` + `60bb180`). Perubahan v1.4.0 dibatalkan dan disimpan di branch `archive/v1.4.0-dibatalkan`, tidak ikut diaudit.

Status: **Phase 1 (Audit) & Phase 2 (Risk assessment) selesai. Belum ada kode yang diubah.**

---

## A. Cara kerja implementasi saat ini

Satu perintah `logis-pr -m "..."` dijalankan dari branch kerja developer. Tidak ada branch integrasi terpisah, tidak ada cherry-pick, dan tidak ada pemilihan commit. PR dibuat **langsung dari branch kerja**.

```text
logis-pr -m "…"                                   src/cli/index.ts  (commander)
    │
    ▼
Validasi dasar                                    src/cli/run.ts  runPr()
  git & gh terpasang, gh login, repo git,
  bukan detached HEAD, bukan di production/development
    │
    ▼
Remote & repo                                     git.remoteUrl('origin') → parseRemoteUrl()
  remote SELALU 'origin' (hard-coded)
    │
    ▼
Key tiket dari nama branch                        message/extractTicketKey()
    │
    ▼
Target PR                                         run.ts: -b > hotfix/ (pilih prod/dev) > development
    │
    ▼
git fetch origin production development           git.fetch()  ← mengubah refs/remotes/* (juga saat --dry-run)
    │
    ▼
Cek asal branch (SATU-SATUNYA cek provenance)     run.ts L264–282
  leaked = (HEAD ^origin/production) ∩ (origin/development ^origin/production)
  dicocokkan per SHA
    │
    ▼
Status working tree & rencana commit              git.status() → planCommit()
  (tidak memeriksa MERGE_HEAD / CHERRY_PICK_HEAD / rebase)
    │
    ▼
Cek konflik                                       git.snapshotCommit() + git.mergeCheck() (merge-tree)
  commit bayangan dengan SATU parent (HEAD)
    │
    ▼
git add --update / git add -- <file> ; git commit --file=-      ← commit "sungguhan"
    │                                              (bisa menjadi MERGE COMMIT bila MERGE_HEAD aktif)
    ▼
git push --set-upstream origin <branch>           tanpa --force ✔
    │
    ▼
gh pr list --head --base → pakai ulang / gh pr create          ← tidak ada validasi diff PR
    │
    ▼
Reviewer → Jira → Teams → clipboard
```

### Titik masuk commit/file asing

| # | Titik | Lokasi | Dicegah? |
|---|---|---|---|
| 1 | Branch dibuat dari development | run.ts cek asal branch | ✔ |
| 2 | `git merge development` sudah selesai | run.ts cek asal branch | ✔ |
| 3 | **Merge development SEDANG berjalan** (MERGE_HEAD), lalu `logis-pr -m` | `git commit` di `Git.commitStaged()` menyelesaikan merge | ✖ |
| 4 | Commit tiket lain (branch `LOGIS-3920`) di-merge / fast-forward ke branch | cek asal hanya membandingkan dengan development | ✖ |
| 5 | Branch dibuat dari **staging**, PR ke development | cek asal tidak mengenal staging | ✖ |
| 6 | Commit development di-**cherry-pick** (SHA berbeda) | cek asal hanya per SHA, bukan patch-id | ✖ |
| 7 | Merge commit di dalam branch | tidak ada deteksi merge commit | ✖ |
| 8 | PR yang sudah ada dipakai ulang | `findOpenPr()` hanya cocokkan head/base, tidak cek isi | ✖ |
| 9 | Isi PR di GitHub setelah dibuat | tidak ada `gh pr view` / perbandingan | ✖ |

---

## B. Hasil reproduksi (repo git sementara, build v1.3.0)

Remote berisi `production`, `staging` (1 commit), `development` (6 commit), dan `LOGIS-3920` (tiket lain). GitHub & Jira memakai tiruan.

| Skenario | Hasil v1.3.0 | Dampak nyata |
|---|---|---|
| S1 branch dari development | ✔ diblok | – |
| S2 production + `merge development` (selesai) | ✔ diblok | – |
| **S3 production + merge development sedang berjalan** | ✖ **lolos**, merge commit dibuat & di-push | branch kerja kini berisi seluruh development |
| **S3b sama, branch `hotfix/` → PR ke production** | ✖ **lolos** | **PR ke production: 8 commit, 6 commit di antaranya milik development (LOGIS-371…375, LOGIS-3799)**: persis skenario PR tercemar |
| S4 production + commit tiket LOGIS-3920 | ✖ lolos | PR berisi commit LOGIS-3920 |
| S5 branch dari staging, PR ke development | ✖ lolos, pesan bilang "berasal dari production" | PR berisi commit staging LOGIS-3800 |
| S6 merge commit internal | ✖ lolos | merge commit masuk PR |
| S7 cherry-pick commit development (SHA baru) | ✖ lolos | perubahan development masuk PR |
| S8 `--dry-run` | branch/index/file **tidak** berubah | tetapi `refs/remotes/origin/development` berubah (fetch) dan ada object baru (commit bayangan + hasil fetch) |

---

## C. Temuan & klasifikasi risiko

| ID | Level | Temuan | Bukti |
|---|---|---|---|
| F1 | **CRITICAL** | Merge/cherry-pick/revert yang sedang berjalan tidak dicek. `git commit` menyelesaikan merge sehingga seluruh history development masuk ke branch, **setelah** cek asal branch lolos. | `src/cli/run.ts` runPr(): cek asal (L264) sebelum `git.commitStaged()` (L395); `src/git/index.ts` `commitStaged()`. Reproduksi S3/S3b. |
| F2 | **CRITICAL** | Cek asal branch hanya dijalankan pada HEAD **sebelum** commit; tidak ada validasi ulang setelah commit dan sebelum push. | `src/cli/run.ts` urutan L264 → L395 → L410 (`git.push`). |
| F3 | **HIGH** | Commit dari branch tiket lain (tidak ada di production/development) tidak terdeteksi. | `leakedDevCommits()` di `src/git/flow.ts` hanya membandingkan dengan `development ^production`. Reproduksi S4. |
| F4 | **HIGH** | Commit `staging` tidak terdeteksi; pesan log salah ("berasal dari production"). | `src/cli/run.ts` L264–283 tidak mengenal staging. Reproduksi S5. |
| F5 | **HIGH** | Tidak ada validasi diff PR (daftar commit & file yang akan dibandingkan GitHub) sebelum membuat/memakai ulang PR, dan tidak ada pengecekan PR setelah dibuat. | `src/github/index.ts` `createPr()`/`findOpenPr()`; run.ts blok `[2/4]`. |
| F6 | **HIGH** | Merge commit di dalam branch tidak dideteksi. | Tidak ada pemanggilan `git rev-list --merges`. Reproduksi S6. |
| F7 | **HIGH** | Kontaminasi lewat cherry-pick (SHA berbeda, patch sama) tidak terdeteksi; tidak ada patch-id. | `leakedDevCommits()` membandingkan SHA. Reproduksi S7. |
| F8 | MEDIUM | `--dry-run` menjalankan `git fetch` (mengubah remote-tracking refs) dan `commit-tree` (object lepas). Branch, index, dan file kerja tidak berubah. | `src/cli/run.ts` `git.fetch()`; `src/git/index.ts` `snapshotCommit()`. Reproduksi S8. |
| F9 | MEDIUM | Fallback "PR already exists" mengambil PR tanpa filter base, bisa memakai PR ke base lain. | `src/github/index.ts` `createPr()` → `findOpenPr(input.repo, input.head)`. |
| F10 | MEDIUM | Remote selalu `origin`, tidak bisa dikonfigurasi; setup fork (origin = fork, upstream = org) akan membuat PR di fork. | `src/git/index.ts` default `remote = 'origin'`; `run.ts` L183. |
| F11 | MEDIUM | Tidak ada timeout pada perintah git/gh. | `src/utils/exec.ts` `runCommand()`. |
| F12 | LOW | Saran saat konflik hotfix menyarankan port ke branch dari development: berbeda dengan kebijakan baru (branch `-dev` dari production). | `src/cli/run.ts` L371–377. |
| F13 | LOW | Tidak ada ADR; README menyatakan "branch wajib dari production" padahal S3–S7 lolos. | `docs/` tidak punya `adr/`. |

### Yang sudah benar (dipertahankan)

- Semua perintah git/gh lewat `cross-spawn` dengan array argumen, tanpa shell (`src/utils/exec.ts`).
- Tidak pernah `git add --all`, `reset --hard`, `clean`, `stash`, `push --force`, menghapus branch, atau berpindah branch.
- Push tanpa force; non-fast-forward gagal dengan aman.
- Cek konflik memakai commit bayangan (index sementara), tidak menyentuh index/file developer.
- Validasi key tiket sebelum dipakai (`normalizeTicketKey()`, `extractTicketKey()`).
- Branch production yang tidak ada → berhenti, tidak diganti diam-diam.
- Idempoten untuk PR (dipakai ulang per base), Jira, reviewer, dan Teams.
- 180 test lulus (`npm test`, v1.3.0).

---

## D. Perbedaan workflow dengan kebijakan yang diharapkan

| Aspek | Kebijakan di prompt | Implementasi v1.3.0 |
|---|---|---|
| Branch tiket | `LOGIS-3919` dari `prod` | branch apa pun yang mengandung key (mis. `feature/LOGIS-3919-x`) dari `production` |
| Branch untuk PR development | **`LOGIS-3919-dev`** dari `prod`, isinya cherry-pick commit tiket | **tidak ada**: branch tiket langsung di-PR ke development |
| Pemilihan commit | eksplisit (allowlist) | tidak ada: semua commit branch ikut |
| PR | head `LOGIS-3919-dev` → base `development` | head branch tiket → base development (hotfix: juga → production) |
| Nama branch produksi | `prod` | `production` (bisa dikonfigurasi) |

**Konsekuensi:** selama branch tiket bersih, isi PR v1.3.0 sama dengan hasil `-dev` (baseline production + commit tiket). Bedanya muncul saat development **konflik**: di v1.3.0 penyesuaian khusus development harus dilakukan di branch tiket itu sendiri. Akibatnya branch tiket ikut membawa penyesuaian development, dan kalau penyesuaian itu dilakukan dengan `merge development`, branch tiket tercemar (F1/S3b). Dengan `-dev`, penyesuaian khusus development hanya hidup di `LOGIS-3919-dev`, dan `LOGIS-3919` tetap bersih untuk production.

---

## E. Usulan hardening (belum dikerjakan)

**Wajib, berlaku di workflow mana pun:**
1. Tolak bila merge/cherry-pick/revert/rebase sedang berjalan (F1).
2. Validasi provenance pada commit **final** sebelum push: tidak ada merge commit (F6), tidak ada commit milik branch environment lain baik secara SHA maupun **patch-id** (F4, F7), dan tidak ada commit yang juga ada di branch remote tiket lain (F3).
3. Validasi diff PR sebelum push/PR: `git log base..head` dan `git diff --name-status base...head` harus persis = commit yang disetujui. Setelah PR dibuat/dipakai ulang: `gh pr view --json commits,baseRefName,headRefName` harus cocok (F5).
4. Fallback "already exists" wajib cocok base (F9).
5. Mode `--audit` (read-only, tanpa fetch); `--dry-run` menyebutkan mutasi yang dilakukan (fetch) secara jujur (F8).

**Tergantung keputusan Anda:** workflow branch integrasi `LOGIS-3919-dev` (cherry-pick commit terpilih dari prod), nama branch produksi, remote yang bisa dikonfigurasi, dan ADR.

---

## F. Keputusan yang dibutuhkan sebelum Phase 3

1. **Workflow `-dev`**: adopsi branch integrasi `LOGIS-{TIKET}-dev` (dibuat dari production, cherry-pick commit tiket, PR ke development), atau pertahankan PR langsung dari branch tiket (plus hardening 1–5)?
2. **Nama branch produksi** di repo LOGis: `production` atau `prod`?
3. **Pemilihan commit** untuk `-dev`: otomatis semua commit tiket yang lolos validasi (ditampilkan & dikonfirmasi), atau pilih manual satu per satu?
4. **Fetch saat `--dry-run`**: boleh (akurat, tetapi memperbarui remote-tracking refs) atau tidak sama sekali?
