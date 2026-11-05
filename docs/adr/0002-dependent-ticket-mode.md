# ADR 0002 — Mode `--dependent` untuk tiket yang bergantung pada tiket lain

| | |
|---|---|
| **Status** | Diusulkan — belum dirilis |
| **Tanggal** | 5 November 2026 |
| **Pemilik** | Juan Valeriand (inisiatif pribadi, tim LOGis) |
| **Melengkapi** | [ADR 0001](0001-production-based-ticket-branching-and-pr-isolation.md) (tidak menggantikan; aturan default tetap) |

---

## 1. Konteks

ADR 0001 mewajibkan branch tiket berbasis `production`, dan PR ke `development` lewat branch integrasi `LOGIS-XXXX-dev`. Aturan itu mengandaikan setiap tiket berdiri sendiri di atas `production`.

Ada tiket yang tidak memenuhi andaian itu. Contoh nyata: **LOGIS-3945** di `SELOG_LOGIS_ServiceVehicle` bergantung pada **LOGIS-3931** dan **LOGIS-3944**, yang baru ada di `development`.

## 2. Masalah

Untuk tiket seperti ini, kedua jalan yang ada buntu:

- Branch berbasis `development`: validasi menolak karena membawa "commit milik development".
- Branch berbasis `production`: `cherry-pick` commit tiket konflik, karena kode yang diubah belum ada di `production`.

Akibatnya developer tidak bisa memakai logis-pr sama sekali, sehingga PR, Jira, dan Teams dikerjakan manual tanpa validasi apa pun.

## 3. Keputusan

Tambah flag `--dependent`. Mode ini **hanya** aktif lewat flag; tidak ada config, env, atau deteksi otomatis yang menyalakannya.

| Aspek | Default (ADR 0001) | `--dependent` |
|---|---|---|
| Basis branch tiket | `production` | `development` (`baseBranch`) |
| Rentang yang divalidasi | `origin/production..HEAD` | `origin/development..HEAD` |
| Syarat commit | bukan milik env/tiket lain | pesan memuat key tiket |
| Merge yang boleh | dari `origin/production` | dari `origin/development` |
| Head PR ke development | `LOGIS-XXXX-dev` | branch tiket |
| Branch tiket di-push | hanya bila ada PR darinya | selalu (PR memang darinya) |
| Bisa naik ke production | ya | tidak, sampai dependensinya rilis |

Yang tetap sama: commit bayangan, simulasi `merge-tree` (konflik → exit 2), konfirmasi daftar commit, verifikasi PR di GitHub (tidak cocok → exit 3), reviewer, Jira, dan Teams.

### Ditolak sebelum efek samping (exit 1)

- Branch berprefix hotfix.
- `-b` berisi `productionBranch` atau target selain `baseBranch`.
- `--push-ticket`, karena tidak relevan di mode ini.
- PR open dari `LOGIS-XXXX-dev` ke `baseBranch`, untuk menghindari dua PR ke `development`.
- `--depends-on` tanpa `--dependent`, berisi string kosong, key tidak valid, atau key tiket sendiri.

### Deteksi dependensi

1. Ambil file yang disentuh commit tiket di `origin/development..HEAD`, kecuali `documentation/**` (dari root repo) dan `*.md` di mana pun. File ini tidak menandakan ketergantungan kode. Tidak peka huruf besar/kecil.
2. Di `origin/production..origin/development`, kumpulkan key tiket dari:
   - pesan commit non-merge yang menyentuh file itu;
   - nama branch di `Merge pull request #N from …/<branch>`, bila diff bersih sisi PR menyentuh file itu.
3. Buang key tiket sendiri, urutkan unik secara numerik.

`git log -- <path>` memakai `--full-history`, karena penyederhanaan history bawaan bisa membuang commit di sisi merge. Merge PR diperiksa tersendiri karena biasanya TREESAME ke salah satu parent, sehingga tidak muncul di log berbasis path.

### Menimpa hasil deteksi

`--depends-on <keys>` (dipisah koma; `3931` dan `logis-3931` diterima) menggantikan hasil deteksi, dan deteksi tidak dijalankan. `--depends-on none` atau `-` berarti tanpa dependensi, untuk positif palsu. Nilai ini berlaku per run dan tidak disimpan: menjalankan ulang tanpa `--depends-on` kembali memakai hasil deteksi, termasuk untuk bagian depends-on di body PR.

### Catatan dependensi

- **Body PR:** satu bagian di antara `<!-- logis-pr:depends-on:start -->` dan `<!-- logis-pr:depends-on:end -->`. Teks di luar penanda tidak disentuh, termasuk CRLF yang disimpan GitHub setelah body diedit di web. Isi sama → tidak ada request edit. Body dikirim via stdin lewat REST API.
- **Teams:** baris `Depends on: …` setelah baris `Tiket`. Kunci idempotensi state tidak berubah.
- **Dependensi tidak lagi terdeteksi:** penanda dipertahankan dengan isi "Tidak ada dependensi terdeteksi", supaya catatan lama tidak menyesatkan dan teks di sekitarnya tidak terganggu.
- **Penanda rusak** (tidak berpasangan atau ganda): body tidak disentuh, muncul warning. Di `--audit` menjadi TIDAK AMAN.

### Saran di jalur normal

Bila validasi normal berhenti karena commit `development`/`staging`, commit tiket disimulasikan `cherry-pick` ke `production` di worktree sementara. Konflik → saran `--dependent` beserta daftar dependensi. Bersih → saran lama. Exit code dan teks error utama tidak berubah. Saran ini tidak muncul untuk hotfix atau `-b` selain `development`, karena `--dependent` akan menolaknya.

### Audit

`logis-pr --audit --dependent` memakai aturan yang sama secara read-only: tanpa fetch dan tanpa objek baru di repo. Simulasi `merge-tree` menulis objeknya ke folder sementara (`GIT_OBJECT_DIRECTORY`) yang langsung dihapus, dengan objek repo terbaca lewat `GIT_ALTERNATE_OBJECT_DIRECTORIES`.

## 4. Alternatif yang ditolak

| Alternatif | Alasan ditolak |
|---|---|
| Branch tiket dari branch tiket dependensi (mis. dari `LOGIS-3944`) | Commit tiket dependensi ikut masuk PR, dan ikut tampil di review. PR juga bergantung pada urutan merge tiket lain. Di mode ini commit tersebut ditolak karena tidak memuat key tiket: dependensi harus sudah masuk `development`. |
| Otomatis tanpa flag (deteksi lalu langsung pindah mode) | Branch yang tidak sengaja dibuat dari `development` adalah penyebab utama PR tercemar (ADR 0001). Pindah mode diam-diam akan meloloskan kesalahan itu. Developer harus menyatakan niatnya secara eksplisit. |
| `--no-isolation` total (matikan validasi) | Menghilangkan semua pengaman, padahal yang dibutuhkan hanya basis yang berbeda. Commit tiket lain akan lolos tanpa terlihat. |

## 5. Konsekuensi

**Positif**
- Tiket bergantung bisa memakai alur penuh (validasi, PR, Jira, Teams), tidak lagi manual.
- Ketergantungan tertulis di PR dan Teams, sehingga terlihat oleh reviewer dan lead.
- Perilaku default tidak berubah.

**Negatif / biaya**
- Branch tiket berbasis `development` **tidak bisa** di-PR ke `production` apa adanya. Saat dependensi sudah rilis, commit tiket perlu diangkat ke branch baru berbasis `production`.
- Aturan isolasi ADR 0001 tidak berlaku di mode ini; pengamannya adalah cek key tiket, yang lebih lemah daripada bukti git.

## 6. Pengaman

- Flag eksplisit, tanpa config atau env.
- Setiap commit di `origin/development..HEAD` harus memuat key tiket, termasuk commit yang akan dibuat (`-m`).
- Merge hanya boleh dari `origin/development`.
- Satu PR ke `development` per tiket: PR `-dev` yang masih open ditolak.
- `--dependent` ditolak untuk target `production`.
- Push tanpa force, verifikasi PR di GitHub, konfirmasi daftar commit.
- Catatan "tidak bisa naik ke production" di body PR.

## 7. Sisa risiko

- **Cek key berbasis pesan commit.** Commit tiket lain yang pesannya diberi key tiket ini akan lolos. Subject yang menyebut key lain hanya menjadi peringatan.
- **Deteksi berbasis kesamaan file, bukan ketergantungan kode.** Bisa positif palsu (file umum seperti `package.json`) maupun negatif palsu (file baru memanggil fungsi yang hanya ada di `development`). Developer bisa mengoreksinya dengan `--depends-on`.
- **Commit yang sudah di-cherry-pick ke production** (mis. hotfix lewat `-dev`) punya SHA berbeda, sehingga tetap berada di `production..development` dan tetap tampil sebagai dependensi.
- **Saran di jalur normal hanya melihat konflik tekstual.** Ketergantungan semantik yang `cherry-pick`-nya bersih tetap mendapat saran lama.
- **Merge `git pull` branch sendiri ditolak** karena parent-nya bukan bagian dari `origin/development`. Ini sengaja ketat; rapikan dengan `git pull --rebase` sebelum push pertama, atau buat ulang branch.

## 8. Verifikasi

`npm test`, terutama `test/dependent.test.ts`: repo git sungguhan di folder temp, dengan `gh`, Jira, dan Teams tiruan. Mencakup validasi, penolakan, konflik, deteksi dependensi, body PR, Teams, saran jalur normal, `--dry-run`, dan `--audit --dependent`.
