# ADR 0001: Sistem Sinkronisasi Andal antara Matriks Pertemuan dan Google Spreadsheet

- **Status**: Accepted
- **Tanggal**: 2026-09-09
- **Penulis**: Antigravity Pair Programmer & Pengembang Web Anisa
- **Konteks**: Web Portal Penilaian Mahasiswi (`penilaian-mahasiswa`)

---

## 1. Konteks & Masalah (Context & Problem Statement)

Saat pengajar menggunakan **Tampilan Matriks Pertemuan (Matrix View)**, terjadi gejala aneh pada sinkronisasi dengan Google Spreadsheet:
1. **Bintang Hilang Setelah Diklik Cepat (Click-Burst Disappearance)**: Ketika dosen mengklik beberapa sel secara beruntun (misal P1, P2, P3), mutasi in-flight pertama yang selesai menghapus seluruh antrean (`outboxQueue = []`), menimpa UI dengan snapshot server terdahulu, dan melenyapkan mutasi yang baru saja diklik.
2. **Bintang Tidak Bisa Dihapus / Diturunkan ke Nol**: Nilai bintang yang sudah bernilai $\ge 1$ tidak bisa diturunkan menjadi 0 lewat klik kanan di matriks karena logika merge mengabaikan angka 0 (`val > 0`).
3. **Konflik Antara Auto-Pull dan Penyimpanan (Dirty Reads & Race Conditions)**: Polling berkala (setiap 10 detik / tab focus) bentrok dengan operasi simpan. Karena Google Apps Script (GAS) tidak menggunakan locking, pembacaan lembar kerja terjadi saat lembar sedang di-`clearContents()`, menghasilkan dataset kosong atau terpotong.
4. **Eksekusi Lambat & Sering Timeout**: Fungsi `renderCourseSheets` menulis ulang dan memformat seluruh 5 lembar mata kuliah (termasuk 100+ panggilan `setColumnWidth`) setiap kali ada 1 bintang berubah, memicu penundaan 15–30 detik dan timeout HTTP.

---

## 2. Pemicu Keputusan (Decision Drivers)

1. **Integritas Data Mutlak (Zero Data Loss)**: Tidak ada perubahan klik pengajar yang boleh hilang karena bentrokan jaringan atau server latency.
2. **Respon Cepat (Sub-second UI Feedback)**: Pengajar harus dapat menandai bintang berurutan dengan cepat di matriks tanpa terhambat loading server.
3. **Toleransi Jaringan & Concurrency**: Menangani koneksi lambat, intermiten, atau multi-tab tanpa merusak konsistensi data.
4. **Kompatibilitas Format Spreadsheet**: Format tabel manusiawi di Spreadsheet harus tetap rapi dan terbaca jelas oleh dosen/staf tanpa merusak parsing otomatis.

---

## 3. Keputusan yang Diterapkan (Decision)

Menerapkan arsitektur **ACK-Based Outbox Queue + Mutex LockService + In-Place Batch Sheet Writes**:
1. **Frontend ACK Queue**: Mengirimkan daftar `mutationIds` dan hanya menghapus mutasi yang dikonfirmasi dalam `acknowledgedIds`.
2. **Optimistic State Replay**: Menggabungkan data server yang baru datang dengan mutasi yang masih tersisa di antrean lokal (`reconcileServerData`).
3. **Debounce Buffer**: Menahan pengiriman mutasi cepat selama 600ms untuk mengelompokkan klik beruntun dalam 1 batch request.
4. **GAS Mutex Lock**: Membungkus `doGet` dan `doPost` dengan `LockService.getScriptLock()` untuk mencegah dirty read.
5. **In-Place Targeted Sheet Updates**: Hanya menimpa range data mahasiswi tanpa menghapus header dan tanpa memanggil `setColumnWidth` berulang.
6. **Zero-Star Support**: Memperbaiki `safeMergeStudents` agar menerima `val >= 0`.
