# ADR 0003 — Mode `--no-baseline`: branch integrasi dari target, tanpa baseline production

| | |
|---|---|
| **Status** | Diusulkan — belum dirilis |
| **Tanggal** | 9 November 2026 |
| **Pemilik** | Juan Valeriand (inisiatif pribadi, tim LOGis) |
| **Melengkapi** | [ADR 0001](0001-production-based-ticket-branching-and-pr-isolation.md) (aturan default tetap), [ADR 0002](0002-dependent-ticket-mode.md) |

---

## 1. Konteks

ADR 0001 membuat `LOGIS-XXXX-dev` dari titik awal branch tiket di `production`, lalu commit tiket di-`cherry-pick -x` ke sana. Akibatnya PR `LOGIS-XXXX-dev → development` selalu membawa commit `production` yang belum ada di `development` sebagai **baseline**. Selama kedua branch sinkron, baseline kecil dan tidak bermasalah.

Contoh nyata: **LOGIS-3964** di `SELOG_LOGIS_ServiceOrder` (fix 1 file `shipment.repository.ts`). `production` saat itu punya 55 commit yang belum ada di `development`, termasuk `cae33714 Revert "Merge branch 'staging' …"`. Revert itu menghapus fitur batching dan `getUsersByIds` yang masih dipakai di `development`.

## 2. Masalah

- Simulasi `merge-tree` mendeteksi konflik di `order-confirmations/query.service.ts`, file yang tidak disentuh tiket. logis-pr berhenti dengan benar (exit 2).
- Saran yang ada ("selesaikan konflik di `-dev`") berbahaya untuk kasus ini. Menyelesaikan konflik sama dengan menerapkan revert ke `development`. Di file yang tidak konflik, revert itu masuk **tanpa terlihat**, sehingga PR satu file bisa menghapus fitur tim lain di `development`. `tsc` hanya menangkap sebagian, yaitu referensi yang rusak.
- `--dependent` (ADR 0002) tidak cocok, karena memindahkan basis **branch tiket** ke `development`. Fix ini harus tetap bisa naik ke `production` dari branch tiket yang sama.

Akibatnya developer keluar dari logis-pr dan membuat PR manual (`LOGIS-3964-development` dari `development` + cherry-pick), tanpa validasi, Jira, maupun Teams. Pola manual yang sama sudah dipakai di LOGIS-3937 (#1891).

## 3. Keputusan

Tambah flag `--no-baseline`. Mode ini **hanya** aktif lewat flag, sama seperti `--dependent`.

| Aspek | Default (ADR 0001) | `--no-baseline` |
|---|---|---|
| Basis branch tiket | `production` | `production` (tidak berubah) |
| Validasi branch tiket | `origin/production..HEAD` | sama |
| Basis `LOGIS-XXXX-dev` baru | titik awal branch tiket di `production` | ujung `origin/<target>` |
| Isi `<target>..LOGIS-XXXX-dev` | cherry-pick tiket + baseline + merge sinkronisasi | **hanya** cherry-pick commit tiket (+ merge dari target) |
| Merge sinkronisasi production di branch tiket | diputar ulang di `-dev` | tidak diputar ulang |
| Commit `production` di `-dev` / di PR | diizinkan (baseline) | ditolak (`integration-baseline`, `pr-baseline`) |
| Merge dari `production` di `-dev` | diizinkan | ditolak |
| PR ke `production` (hotfix, `-b production`) | dari branch tiket | sama, tidak terpengaruh |

Konflik cherry-pick di atas target adalah konflik **milik tiket sendiri** (file tiket berbeda antara production dan target). logis-pr berhenti (exit 2) dengan langkah manual:

```text
git switch -c LOGIS-XXXX-dev origin/development
git cherry-pick -x <sha…>   → selesaikan konflik → git add → git cherry-pick --continue
git switch LOGIS-XXXX
logis-pr --no-baseline
```

Trailer `-x` membuat hasil cherry-pick yang diselesaikan manual tetap dikenali sebagai commit tiket.

Jalur default yang berhenti karena konflik, dengan `production` yang punya commit belum ada di target, sekarang menyarankan `--no-baseline` sebagai ganti menyelesaikan konflik baseline di PR tiket.

## 4. Alternatif yang ditolak

| Alternatif | Alasan ditolak |
|---|---|
| Jadikan default | Mengubah keputusan tim di ADR 0001: baseline production yang ikut lewat PR tiket ikut menyinkronkan `development`. Mode ini dipakai saat sinkronisasi itu justru berbahaya. |
| Deteksi otomatis (konflik baseline → pindah mode) | Sama seperti ADR 0002: perpindahan mode diam-diam menyembunyikan bahwa `production` dan `development` tidak sinkron. Developer dan lead harus tahu. |
| Selesaikan konflik di `-dev` dengan mengambil versi target (`git checkout origin/development -- <path>`) | Merge commit tetap mencatat 55 commit production sebagai "sudah di-merge" ke `development` tanpa isinya. Sinkronisasi berikutnya akan melewatkan perubahan production yang sah. |
| Config permanen | Kebutuhannya situasional (selama `production` dan `development` tidak sinkron). Bisa ditambahkan nanti bila ternyata sering dipakai. |

## 5. Konsekuensi

**Positif**
- PR ke `development` berisi persis commit tiket. Review lebih kecil, dan tidak ada revert/baseline yang masuk diam-diam.
- Alur penuh (validasi, PR, verifikasi GitHub, reviewer, Jira, Teams) tetap dipakai.
- Branch tiket tetap berbasis `production`, jadi fix bisa dinaikkan ke `production` dari branch yang sama.

**Negatif / biaya**
- PR tiket tidak lagi ikut membawa commit `production` ke `development`. Sinkronisasi `production → development` menjadi tugas lead yang terpisah dan harus benar-benar dilakukan.
- Isi tiket di `development` bisa berbeda dari di `production` bila cherry-pick perlu diselesaikan manual. Ini memang sifat kedua branch yang tidak sinkron.

## 6. Pengaman

- Flag eksplisit, tanpa config atau env.
- `--no-baseline` + `--dependent` ditolak sebelum efek samping.
- `-dev` lama yang dibuat dari `production` ditolak (commit baseline terdeteksi), tanpa menimpa maupun menghapus branch. Saran: ganti nama branch lama.
- Hasil cherry-pick divalidasi ulang sebelum ref diperbarui. Isi PR divalidasi lagi tanpa toleransi baseline, lalu diverifikasi di GitHub (exit 3 bila beda).
- Push tanpa force; `-dev` hanya maju fast-forward.

## 7. Sisa risiko

- `-dev` yang dibuat `--no-baseline` lalu dijalankan **tanpa** flag tetap diterima (isinya hanya cherry-pick tiket di atas target). Commit tiket baru di-cherry-pick ke atasnya, jadi biasanya tetap tanpa baseline. Pengecualian: bila branch tiket punya merge sinkronisasi `production`, mode default memutar ulang merge itu di `-dev`, sehingga baseline ikut masuk. Jalankan ulang dengan `--no-baseline` yang sama untuk tiket yang sudah memakai mode ini.
- `--audit` tanpa `--no-baseline` menilai `-dev` seperti itu tetap AMAN, tetapi perkiraan isi PR saat `-dev` belum dibuat memakai aturan default.

## 8. Verifikasi

`npm run lint` dan `npm run build`. Skenario yang perlu dicek manual (atau ditambahkan ke `test/run.test.ts` kemudian): konflik baseline di jalur default beserta saran `--no-baseline`, PR hanya berisi file tiket, idempotensi dan fast-forward, penolakan `-dev` lama dari production, konflik cherry-pick milik tiket beserta penyelesaian manual, penolakan `--dependent`, `--dry-run`, dan `--audit`.
