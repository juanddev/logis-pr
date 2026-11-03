# ADR 0001 — Branch tiket berbasis production & isolasi isi PR

| | |
|---|---|
| **Status** | Diterima — berlaku mulai logis-pr 2.0.0 |
| **Tanggal** | 2 November 2026 |
| **Pemilik** | Juan Valeriand (inisiatif pribadi, tim LOGis) |
| **Menggantikan** | Alur v1.3.0 (PR langsung dari branch tiket ke development) |
| **Terkait** | [Audit 2026-11-02](../audit/2026-11-02-branch-isolation-audit.md) |

---

## 1. Konteks

Tim LOGis punya tiga branch environment: `production`, `staging`, dan `development`. Branch kerja (fitur & hotfix) dibuat dari `production`, lalu di-PR ke `development` (hotfix juga ke `production`). Karena `development` selalu berisi pekerjaan tiket lain yang belum rilis, branch kerja **tidak boleh** membawa history `development`; kalau terbawa, isi itu akan ikut ke `production` saat branch yang sama di-PR ke sana.

logis-pr v1.3.0 mengotomatiskan commit → push → PR → Jira → Teams. Pengamannya hanya membandingkan SHA branch kerja dengan `development ^production`, dan cek itu dijalankan **sebelum** commit.

## 2. Masalah

Audit (lihat dokumen terkait) mereproduksi PR tercemar dengan repo git sungguhan. Kasus terburuk (S3b): merge `development` yang sedang berjalan (`MERGE_HEAD`) diselesaikan oleh `git commit` milik logis-pr **setelah** cek asal branch lolos. Akibatnya PR hotfix ke `production` berisi 8 commit, 6 di antaranya milik development. Celah lain yang lolos: commit tiket lain, commit `staging`, merge commit internal, dan cherry-pick commit development (SHA baru). Selain itu tidak ada validasi isi PR, baik sebelum maupun sesudah PR dibuat.

Akar masalahnya ada dua:

1. Keamanan bergantung pada **asal branch**, bukan pada **isi PR yang akan dilihat GitHub**.
2. Penyesuaian khusus `development` (resolusi konflik) harus dilakukan di branch tiket itu sendiri, sehingga developer terdorong melakukan `git merge development` ke branch tiket.

## 3. Faktor keputusan

- PR tercemar ke `production` adalah risiko paling mahal: rilis fitur yang belum diuji.
- Fail-closed: lebih baik berhenti dan menjelaskan daripada membuat PR yang meragukan.
- Pekerjaan developer tidak boleh hilang: tidak ada `reset --hard`, `clean`, `stash`, force push, menimpa, atau menghapus branch.
- Kepemilikan commit tidak boleh hanya disimpulkan dari nama branch atau pesan commit.
- Perubahan sekecil mungkin: tetap satu perintah `logis-pr -m "…"`, format Teams tidak berubah.
- Berjalan identik di Windows dan macOS (git ≥ 2.38, tanpa shell).

## 4. Opsi yang dipertimbangkan

| Opsi | Ringkasan | Alasan ditolak / dipilih |
|---|---|---|
| A. Pertahankan v1.3.0 + perketat cek asal | PR tetap dari branch tiket | Konflik khusus development tetap harus diselesaikan di branch tiket → dorongan merge development tetap ada. |
| B. Branch tiket dari `development` untuk PR development | Mengikuti target | Menyalahi aturan tim; branch yang sama tidak bisa dibawa ke production. (Ini v1.4.0 yang dibatalkan.) |
| **C. Branch integrasi `LOGIS-XXXX-dev` dari production + cherry-pick commit tiket** | PR ke development dari branch terpisah | **Dipilih.** Branch tiket tetap murni production + commit tiket; penyesuaian development hanya hidup di `-dev`. |
| D. Rebase otomatis ke development | | Mengubah history & butuh force push; melanggar aturan keamanan. |

## 5. Keputusan

1. **Branch tiket** (`LOGIS-1234`, `feature/LOGIS-1234-…`, `hotfix/LOGIS-1234-…`) wajib berbasis `production` (`productionBranch`, default `production`; tidak pernah diganti diam-diam ke `main` dsb.).
2. **PR ke development** selalu dari **branch integrasi** `LOGIS-1234-dev` (`devBranchPattern`, default `{TICKET}-dev`). Branch ini dibuat dari **titik awal branch tiket di production** dan berisi `git cherry-pick -x` setiap commit tiket. Merge sinkronisasi `production` di branch tiket ikut diputar ulang beserta resolusinya.
3. **PR ke production** (hotfix atau `-b production`) tetap langsung dari branch tiket.
4. **Allowlist commit** = semua commit tiket yang lolos validasi; daftar ditampilkan dan dikonfirmasi `[y/N]` (default **Tidak**). `-y` dianggap persetujuan eksplisit.
5. **Isi PR divalidasi dua kali**: sebelum push (lokal, `base..head` & `base...head`) dan sesudah PR dibuat/dipakai ulang (`gh pr view`: head, base, OID ujung, daftar commit, jumlah file). Tidak cocok → exit 3, tanpa reviewer/Jira/Teams.
6. `--dry-run` boleh `git fetch` dan menyebutkannya dengan jelas. `--audit` sepenuhnya read-only (tanpa fetch; kesegaran dicek dengan `ls-remote`).
7. Remote bisa dikonfigurasi (`remote`, default `origin`); branch environment yang dianggap "asing" bisa dikonfigurasi (`envBranches`, default `staging, development`).

## 6. Alur kerja

```text
production ──┬── LOGIS-1234 (branch tiket) ─────────────PR (hotfix / -b production)──▶ production
             │        │ cherry-pick -x (otomatis oleh logis-pr)
             └── LOGIS-1234-dev ─────────────────────────PR────────────────────────────▶ development
                      (resolusi konflik khusus development dilakukan DI SINI, bukan di branch tiket)
```

Urutan `logis-pr -m "…"`:

1. Validasi lingkungan, operasi git yang belum selesai, branch, remote, config.
2. `git fetch <remote> production <target> [env…] [LOGIS-1234-dev]`.
3. **Commit bayangan** (index sementara) = isi branch tiket setelah commit; branch/index/file belum disentuh.
4. Analisis provenance commit bayangan → stop bila ada masalah.
5. Rencana & **simulasi** `-dev` di worktree sementara → validasi hasil cherry-pick → simulasi merge ke target → validasi isi PR → stop bila ada masalah atau konflik.
6. Konfirmasi allowlist.
7. Commit sungguhan → **validasi ulang pada commit nyata** → simulasi ulang.
8. Buat/fast-forward ref `-dev` (atomik, `update-ref new old`), push `-dev` (tanpa force). Branch tiket hanya di-push bila ada PR darinya (production/hotfix) atau diminta (`--push-ticket`, `pushTicketBranch: always`), supaya GitHub tidak menawarkan PR kedua dari branch tiket (sejak 2.1.0).
9. Buat atau pakai ulang PR (filter head **dan** base) → verifikasi PR di GitHub.
10. Reviewer, Jira, Teams (non-kritis, seperti sebelumnya).

## 7. Aturan validasi

**Branch tiket** (`analyzeTicket`), untuk setiap commit di `HEAD ^<remote>/production`:

| Cek | Dasar | Hasil |
|---|---|---|
| Commit milik environment | SHA ada di `<remote>/<env> ^<remote>/production` | STOP |
| Salinan commit environment | `git patch-id --stable` sama dengan commit environment; dikecualikan bila commit environment itu sendiri cherry-pick `-x` dari commit tiket ini (sudah di-merge lewat `-dev`) | STOP |
| Merge commit | parent tambahan bukan bagian dari production | STOP; bila dari production = *merge sinkronisasi* (diizinkan) |
| Commit branch tiket lain | `for-each-ref --contains` pada branch remote selain branch sendiri/env/production | STOP |
| Subject menyebut key tiket lain | pesan commit | Peringatan saja (bukan dasar keputusan) |

**Branch integrasi** (`classifyIntegration`), untuk setiap commit di `-dev ^production ^<base>`: harus cherry-pick commit tiket (trailer `-x` **atau** patch-id), atau merge yang hanya membawa isi base/production (resolusi konflik eksplisit). Lokal & remote bercabang → STOP.

**Isi PR** (`validatePrDiff`), seperti yang akan dihitung GitHub: setiap commit `base..head` harus commit tiket/cherry-pick-nya, *baseline* (commit production yang belum ada di base), atau merge sinkronisasi; setiap file di `base...head` harus berasal dari commit-commit tersebut.

**Pengaman eksekusi:** `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, rebase, atau bisect aktif → STOP tanpa abort otomatis. Cherry-pick dilakukan di `git worktree add --detach` sementara yang selalu dihapus di `finally`. Semua perintah memakai timeout (5 menit, kecuali yang butuh input pengguna).

## 8. Penanganan kegagalan & pemulihan

| Situasi | Perilaku | Pemulihan |
|---|---|---|
| Branch tiket membawa commit asing | Exit 1 sebelum commit; daftar commit ditampilkan | Buat branch baru dari production, cherry-pick commit sendiri, sinkron hanya dengan `origin/production` |
| Merge/cherry-pick sedang berjalan | Exit 1, tidak diselesaikan/di-abort | `git merge --abort` (atau selesaikan sendiri), lalu ulangi |
| Konflik ke target | Exit 2 sebelum commit | Untuk development: selesaikan di `LOGIS-1234-dev` (`git merge origin/development` di sana), bukan di branch tiket |
| Cherry-pick ke `-dev` yang sudah ada konflik | Exit 2, ref tidak berubah, worktree dihapus | `git switch LOGIS-1234-dev && git cherry-pick -x <sha>` |
| `-dev` berisi commit asing / bercabang | Exit 1, branch tidak disentuh | Periksa, lalu `git branch -m LOGIS-1234-dev LOGIS-1234-dev-old` dan jalankan lagi |
| Commit sudah dibuat tetapi validasi ulang gagal | Exit 1, tidak ada push | `git reset --soft HEAD~1` (perubahan tetap ada) |
| PR di GitHub tidak cocok | Exit 3, reviewer/Jira/Teams tidak jalan | Periksa tab Commits/Files, ubah ke draft/tutup manual, `logis-pr --audit` |
| PR lama langsung dari branch tiket ke development | Peringatan | Tutup PR lama secara manual |
| Branch production/remote tidak ada | Exit 1 | Set `productionBranch` / `remote` |

## 9. Konsekuensi

**Positif**
- PR ke development hanya berisi commit tiket (+ baseline production); terbukti dengan verifikasi GitHub setelah PR dibuat.
- Branch tiket tetap layak di-PR ke production kapan pun.
- Dijalankan ulang aman: cherry-pick tidak diulang (trailer `-x`/patch-id), PR/Jira/Teams tidak dobel.
- `--audit` memberi penilaian AMAN/TIDAK AMAN tanpa mengubah apa pun.

**Negatif / biaya**
- Ada branch tambahan per tiket (`LOGIS-1234-dev`) di remote; perlu dihapus setelah merge (bisa otomatis lewat setelan GitHub "Automatically delete head branches").
- PR development sekarang dari `-dev`; PR lama dari branch tiket harus ditutup manual.
- Waktu proses bertambah (worktree sementara, patch-id). Di repo besar beberapa detik.
- Butuh git ≥ 2.38 (`merge-tree --write-tree`).

## 10. Verifikasi

- `npm test`: test berbasis repo git sungguhan di folder temp (`test/gitfixture.ts`), tidak pernah menyentuh repo developer. Mencakup regresi PR tercemar (branch dari development/staging, merge development selesai & sedang berjalan, commit tiket lain, cherry-pick development, merge internal, `-dev` tercemar/bercabang, PR GitHub berbeda), sinkronisasi production, konflik, kegagalan di tengah, hotfix, `--dry-run`, dan `--audit`.
- E2E manual dengan `gh` tiruan yang menghitung isi PR dari repo bare.

## 11. Sisa risiko

- Commit tiket lain yang di-cherry-pick ke branch tiket (SHA baru) dan **tidak** ada di environment branch tidak bisa dibuktikan asing secara git. Yang ada hanya peringatan berdasarkan subject, ditambah konfirmasi allowlist.
- Validasi memakai data `fetch` saat dijalankan; push oleh orang lain di antara validasi dan push hanya terdeteksi oleh verifikasi pasca-PR.
- Verifikasi daftar commit di GitHub dibatasi 100 commit (batas `gh pr view`); di atas itu hanya head/base/OID/jumlah file yang dicek.
- Branch protection, CODEOWNERS, dan aturan merge di GitHub tetap menjadi pagar terakhir dan di luar kendali logis-pr.

## 12. Tindak lanjut

- Aktifkan "Automatically delete head branches" di repo LOGis agar `-dev` terhapus setelah merge.
- Pertimbangkan pengecekan CI sederhana di repo service: PR ke `production` ditolak bila berisi commit yang ada di `development ^production`.
- Bila pola `-dev` disepakati tim, dokumentasikan di panduan onboarding repo service.
