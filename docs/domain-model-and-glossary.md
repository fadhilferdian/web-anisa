# Domain Model & Glossary: Portal Keaktifan Mahasiswi Sync Engine

Dokumen ini mendefinisikan bahasa bersama (*Ubiquitous Language*), model domain, entitas, siklus hidup mutasi, dan struktur data untuk sistem sinkronisasi keaktifan mahasiswi antara Web App Portal dan Google Spreadsheet.

---

## 1. Glossary (Ubiquitous Language)

| Istilah | Definisi |
| :--- | :--- |
| **Portal Keaktifan** | Aplikasi web interaktif berbasis Vue 3 yang digunakan dosen untuk merekap nilai keaktifan, bintang, dan presensi mahasiswi. |
| **Spreadsheet Authority** | Lembar kerja Google Spreadsheet yang berfungsi sebagai *Single Source of Truth* (SSOT) jangka panjang dan tempat arsip nilai resmi. |
| **Matriks Pertemuan (Matrix View)** | Tampilan tabel 16 pertemuan (P1 - P16) di mana setiap baris adalah mahasiswi dan setiap kolom adalah pertemuan untuk pengisian bintang secara cepat. |
| **Bintang Keaktifan (Star Rating)** | Nilai partisipasi mahasiswi per pertemuan per mata kuliah. Nilai berupa bilangan bulat non-negatif ($\ge 0$). Nilai 0 berarti tidak ada bintang. |
| **Mutasi (Mutation)** | Objek diskrit yang merepresentasikan satu perubahan atomik (misal: ubah bintang, tambah catatan, tambah/edit/hapus mahasiswi) yang memiliki ID unik dan timestamp. |
| **Outbox Queue** | Antrean FIFO lokal di browser (*localStorage*) yang menampung mutasi sebelum berhasil diterima dan diakui (*ACK*) oleh backend. |
| **Mutation ACK (Acknowledgment)** | Mekanisme di mana backend mengirimkan daftar ID mutasi yang telah berhasil diproses, sehingga frontend hanya menghapus mutasi yang sudah terkonfirmasi. |
| **Optimistic UI with Re-application** | Pola UI di mana perubahan langsung ditampilkan ke layar pengguna secara instan, dan jika data ditarik dari server, mutasi lokal yang masih pending diaplikasikan kembali (*replayed*) di atas snapshot server. |
| **Script Lock (LockService)** | Mekanisme mutex di Google Apps Script untuk mencegah dua eksekusi concurrent (`doGet` dan `doPost`) saling merusak data lembar kerja (*race condition*). |
| **Chunked DB_JSON** | Tab tersembunyi di Spreadsheet yang menyimpan JSON serial lengkap dari seluruh entitas untuk mempercepat pembacaan dan pemulihan darurat tanpa batas sel 50.000 karakter. |
| **In-Place Cell Update** | Pembaruan sel Spreadsheet langsung pada koordinat baris dan kolom yang spesifik tanpa melakukan `clearContents()` pada seluruh lembar kerja. |

---

## 2. Domain Model

```mermaid
classDiagram
    class Student {
        +String id
        +String nim
        +String name
        +List~String~ courses
        +Map~CourseId, Map~MeetingNumber, Int~~ stars
        +Map~CourseId, Map~MeetingNumber, String~~ notes
        +Int version
        +Timestamp updatedAt
    }

    class Course {
        +String id
        +String name
        +String label
        +String sheetName
    }

    class MeetingCell {
        +Int meetingNumber
        +Int starsCount
        +String note
    }

    class Mutation {
        +String mutationId
        +String type
        +Object payload
        +Timestamp clientTimestamp
        +String status
    }

    class OutboxQueue {
        +List~Mutation~ pendingMutations
        +enqueue(mutation)
        +acknowledge(mutationIds)
        +getInFlight()
    }

    class SyncSnapshot {
        +List~Student~ students
        +List~String~ deletedStudentIds
        +Timestamp serverTimestamp
        +String revisionHash
    }

    Student "1" *-- "*" Course : enrolled in
    Student "1" *-- "16" MeetingCell : has evaluations
    OutboxQueue "1" *-- "*" Mutation : buffers
    SyncSnapshot "1" *-- "*" Student : contains authoritative state
```

---

## 3. Lifecycle Mutasi & Sinkronisasi

```mermaid
sequenceDiagram
    autonumber
    participant UI as Vue UI (Matrix View)
    participant Outbox as Local Outbox Queue
    participant GAS as GAS Backend
    participant Lock as LockService Mutex
    participant Sheet as Google Spreadsheet

    UI->>UI: Guru klik sel P3 (Bintang 2 -> 3)
    UI->>Outbox: Enqueue Mutation(M1) & Simpan Cache Lokal
    UI->>UI: Optimistic render: Sel P3 langsung bernilai 3
    Note over Outbox: Debounce window 600ms (tampung klik beruntun M1, M2...)
    Outbox->>GAS: POST /exec { action: 'batch_mutation', mutationIds: [M1, M2], mutations: [...] }
    GAS->>Lock: waitLock(15000ms)
    Note over Lock: Mencegah collision dengan auto-pull atau user lain
    GAS->>Sheet: Baca baris / sel target (In-place)
    GAS->>Sheet: Tulis nilai bintang baru ke sel spesifik (In-place)
    GAS->>Sheet: Perbarui DB_JSON terkompresi
    GAS->>Lock: releaseLock()
    GAS-->>Outbox: Response { status: 'success', acknowledgedIds: [M1, M2], data: [...] }
    Outbox->>Outbox: Remove only ackIds from Outbox
    Outbox->>UI: Reconcile: Gabungkan server data dengan sisa pending mutasi (jika ada)
```
