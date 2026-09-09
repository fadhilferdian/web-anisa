/**
 * ============================================================================
 * GOOGLE APPS SCRIPT BACKEND - PORTAL KEAKTIFAN MAHASISWI (ULTRA FAST & ROBUST)
 * ============================================================================
 * Prinsip:
 * 1. SPREADSHEET ADALAH SINGLE SOURCE OF TRUTH:
 *    Data tersimpan konsisten di lembar Spreadsheet dan DB_JSON.
 * 2. FAST READ & WRITE:
 *    doGet membaca dari DB_JSON secara instan (<200ms) tanpa operasi tulis.
 *    Jika parameter force_sheets=true dikirimkan, backend membaca langsung dari lembar sheet.
 *    doPost hanya memperbarui lembar sheet yang dimutasi tanpa perulangan resize kolom.
 * 3. ANTI-DATA LOSS & CONCURRENCY CONTROL (MUTEX):
 *    Menggunakan LockService untuk mencegah tabrakan eksekusi antara GET dan POST.
 * 4. GRANULAR ACKNOWLEDGMENT (ACK):
 *    Mengembalikan ID mutasi yang berhasil diolah agar frontend hanya menghapus mutasi terkonfirmasi.
 * 5. TOLERAN NILAI BINTANG (TERMASUK NOL):
 *    Mendukung angka biasa (0, 1, 2, 3), emoji bintang (⭐, ★), centang (✓, v), checkbox (TRUE).
 * 6. CHUNKED STORAGE:
 *    Tab DB_JSON disimpan per baris sehingga terhindar dari batas 50.000 karakter per sel.
 */

// Konfigurasi Standar Mata Kuliah
var COURSE_CONFIG = {
  'tafsir': { name: 'Rekap Tafsir Al-Qur\'an', label: 'Tafsir Al-Qur\'an (PAI III)' },
  'sirah1': { name: 'Rekap Sirah Nabawiyah 1', label: 'Sirah Nabawiyah 1 (KPI I)' },
  'sirah2': { name: 'Rekap Sirah Nabawiyah 2', label: 'Sirah Nabawiyah 2 (PBA I)' },
  'sharaf': { name: 'Rekap Ilmu Sharaf', label: 'Ilmu Sharaf (IL)' },
  'tauhid': { name: 'Rekap Ilmu Tauhid', label: 'Ilmu Tauhid (PAI VII)' }
};

/**
 * Handle HTTP GET (Memuat data langsung dari Spreadsheet / DB_JSON)
 */
function doGet(e) {
  try { CacheService.getScriptCache().removeAll(['MAHASISWI_ALL_DATA_CACHE']); } catch(err) {}

  var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : 'load';
  
  if (action === 'ping') {
    return createJsonResponse({
      status: 'success',
      message: 'Koneksi ke Google Apps Script Backend Berhasil!',
      timestamp: new Date().toISOString()
    });
  }

  var lock = LockService.getScriptLock();
  var hasLock = false;
  try {
    hasLock = lock.waitLock(10000);
  } catch (lockErr) {}
  
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var forceSheets = (e && e.parameter && (e.parameter.force_sheets === 'true' || e.parameter.force === 'true'));
    
    // 1. FAST PATH: Jika bukan force_sheets, baca dari DB_JSON (super cepat, ~150ms)
    if (!forceSheets) {
      var dbData = readDbJson(ss);
      if (dbData && Array.isArray(dbData) && dbData.length > 0) {
        return createJsonResponse({
          status: 'success',
          message: 'Data berhasil dimuat dari DB_JSON Spreadsheet (Fast Path)',
          data: dbData,
          total: dbData.length,
          source: 'db_json'
        });
      }
    }
    
    // 2. FALLBACK / FORCE PATH: Baca langsung dari lembar sheet per mata kuliah
    var parsedStudents = parseAllCourseSheets(ss);
    if (parsedStudents && Array.isArray(parsedStudents) && parsedStudents.length > 0) {
      enrichWithDbNotes(ss, parsedStudents);
      writeDbJson(ss, parsedStudents);
      return createJsonResponse({
        status: 'success',
        message: 'Data berhasil dimuat langsung dari lembar Spreadsheet (Single Source of Truth)',
        data: parsedStudents,
        total: parsedStudents.length,
        source: 'sheets'
      });
    }
    
    // 3. Fallback jika sheet kosong tapi DB_JSON mungkin ada
    var dbDataFallback = readDbJson(ss);
    if (dbDataFallback && Array.isArray(dbDataFallback) && dbDataFallback.length > 0) {
      return createJsonResponse({
        status: 'success',
        message: 'Data berhasil dimuat dari DB_JSON Spreadsheet',
        data: dbDataFallback,
        total: dbDataFallback.length,
        source: 'db_json'
      });
    }
    
    return createJsonResponse({
      status: 'empty',
      message: 'Belum ada data tersimpan di Spreadsheet.',
      data: null
    });
  } catch (err) {
    return createJsonResponse({
      status: 'error',
      message: 'Gagal membaca data dari Spreadsheet: ' + err.toString()
    });
  } finally {
    if (hasLock) {
      try { lock.releaseLock(); } catch(err) {}
    }
  }
}

/**
 * Handle HTTP POST (Penyimpanan Aman, Cepat & Terkendali Tanpa Menghapus Data Lama)
 */
function doPost(e) {
  try { CacheService.getScriptCache().removeAll(['MAHASISWI_ALL_DATA_CACHE']); } catch(err) {}

  var lock = LockService.getScriptLock();
  var hasLock = false;
  try {
    hasLock = lock.waitLock(15000);
  } catch (lockErr) {
    return createJsonResponse({ 
      status: 'error', 
      message: 'Server Google Apps Script sedang sibuk memproses antrean lain. Silakan coba kembali sesaat lagi.' 
    });
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return createJsonResponse({ status: 'error', message: 'Payload tidak ditemukan.' });
    }
    
    var payload = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    
    // Muat data yang saat ini ada di Spreadsheet sebagai basis authoritative
    // Coba baca DB_JSON terlebih dahulu (sangat cepat ~100-200ms)
    var existingStudents = readDbJson(ss);
    if (!existingStudents || !Array.isArray(existingStudents) || existingStudents.length === 0) {
      existingStudents = parseAllCourseSheets(ss);
      if (!existingStudents || existingStudents.length === 0) {
        existingStudents = [];
      } else {
        enrichWithDbNotes(ss, existingStudents);
      }
    }
    
    var processedMutationsCount = 0;
    var acknowledgedIds = [];
    var finalStudents = [];
    var affectedCourseIds = {};

    // Filter out student yang terdaftar di deletedStudentIds jika ada
    if (Array.isArray(payload.deletedStudentIds) && payload.deletedStudentIds.length > 0) {
      existingStudents = existingStudents.filter(function(s) {
        return payload.deletedStudentIds.indexOf(s.id) === -1 && 
               payload.deletedStudentIds.indexOf(s.nim) === -1;
      });
      // Penghapusan mahasiswa berpotensi mempengaruhi seluruh sheet kelas
      Object.keys(COURSE_CONFIG).forEach(function(cId) { affectedCourseIds[cId] = true; });
    }

    // Jika mutasi bertahap dikirimkan dari Outbox Queue
    if (payload.action === 'batch_mutation' && Array.isArray(payload.mutations) && payload.mutations.length > 0) {
      payload.mutations.forEach(function(m) {
        if (m && m.id) acknowledgedIds.push(m.id);
        if (m && m.payload && m.payload.courseId) {
          affectedCourseIds[m.payload.courseId] = true;
        } else {
          // Mutasi umum (ADD/EDIT/DELETE) mempengaruhi semua kelas
          Object.keys(COURSE_CONFIG).forEach(function(cId) { affectedCourseIds[cId] = true; });
        }
      });
      // Pastikan data mahasiswi dari client digabungkan jika ada yang belum tercatat di existingStudents
      if (Array.isArray(payload.students) && payload.students.length > 0) {
        if (existingStudents.length === 0) {
          existingStudents = payload.students;
        } else {
          payload.students.forEach(function(cSt) {
            var targetNim = cSt.nim ? String(cSt.nim).replace(/^'/, '').trim().toLowerCase() : '';
            var exists = existingStudents.some(function(eSt) {
              var eNim = eSt.nim ? String(eSt.nim).replace(/^'/, '').trim().toLowerCase() : '';
              return (targetNim && eNim === targetNim) || eSt.id === cSt.id || (cSt.name && eSt.name && eSt.name.trim().toLowerCase() === cSt.name.trim().toLowerCase());
            });
            if (!exists) {
              existingStudents.push(cSt);
            }
          });
        }
      }
      finalStudents = applyMutations(existingStudents, payload.mutations);
      processedMutationsCount = payload.mutations.length;
    } 
    // Jika sinkronisasi penuh dikirimkan
    else if (payload.students && Array.isArray(payload.students)) {
      Object.keys(COURSE_CONFIG).forEach(function(cId) { affectedCourseIds[cId] = true; });
      if (existingStudents.length === 0) {
        finalStudents = payload.students;
      } else {
        finalStudents = safeMergeStudents(existingStudents, payload.students);
      }
      if (Array.isArray(payload.mutationIds)) {
        acknowledgedIds = payload.mutationIds;
      }
    } else {
      finalStudents = existingStudents;
    }
    
    // Simpan snapshot aman ke DB_JSON
    writeDbJson(ss, finalStudents);
    
    // Render kembali lembar rekap rapi HANYA untuk kelas yang terkena mutasi (Fast in-place rendering)
    renderCourseSheets(ss, finalStudents, affectedCourseIds);

    // Paksa Google Spreadsheet untuk langsung menerapkan dan menampilkan data di sel tanpa jeda
    SpreadsheetApp.flush();
    
    return createJsonResponse({
      status: 'success',
      message: 'Data berhasil disinkronkan ke Spreadsheet tanpa menghapus riwayat!',
      mutationsProcessed: processedMutationsCount,
      acknowledgedIds: acknowledgedIds,
      totalStudents: finalStudents.length,
      data: finalStudents,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return createJsonResponse({
      status: 'error',
      message: 'Gagal menyimpan ke Spreadsheet: ' + err.toString()
    });
  } finally {
    if (hasLock) {
      try { lock.releaseLock(); } catch(err) {}
    }
  }
}

/**
 * Membaca data langsung dari seluruh lembar mata kuliah di Spreadsheet
 */
function parseAllCourseSheets(ss) {
  var studentMap = {};

  Object.keys(COURSE_CONFIG).forEach(function(courseId) {
    var sheet = findSheetForCourse(ss, courseId);
    if (!sheet) return;
    parseSingleCourseSheet(sheet, courseId, studentMap);
  });

  var resultList = [];
  Object.keys(studentMap).forEach(function(k) {
    resultList.push(studentMap[k]);
  });

  return resultList;
}

/**
 * Mencari sheet berdasarkan ID mata kuliah dengan toleransi nama
 */
function findSheetForCourse(ss, courseId) {
  var sheets = ss.getSheets();
  
  // 1. Cek nama persis dari konfigurasi
  var defaultName = COURSE_CONFIG[courseId] ? COURSE_CONFIG[courseId].name : '';
  if (defaultName) {
    var exactSheet = ss.getSheetByName(defaultName);
    if (exactSheet) return exactSheet;
  }
  
  // 2. Cek variasi kata kunci toleran
  var keywords = {
    'tafsir': ['tafsir'],
    'sirah1': ['sirah 1', 'sirah1', 'sirah nabawiyah 1', 'kpi'],
    'sirah2': ['sirah 2', 'sirah2', 'sirah nabawiyah 2', 'pba'],
    'sharaf': ['sharaf', 'shorof', 'sarf', 'ilmu sharaf', 'il'],
    'tauhid': ['tauhid', 'tawhid', 'ilmu tauhid', 'pai vii', 'pai 7']
  };

  var targetKeywords = keywords[courseId] || [courseId];

  for (var i = 0; i < sheets.length; i++) {
    var name = sheets[i].getName().toLowerCase();
    for (var k = 0; k < targetKeywords.length; k++) {
      if (name.indexOf(targetKeywords[k]) !== -1) {
        return sheets[i];
      }
    }
  }
  return null;
}

/**
 * Parser serbaguna untuk membaca nilai bintang di sel (angka, emoji bintang, centang, boolean)
 */
function parseStarValue(cell) {
  if (cell === null || cell === undefined || cell === '') return 0;
  if (typeof cell === 'number') return Math.max(0, Math.floor(cell));
  if (typeof cell === 'boolean') return cell ? 1 : 0;
  
  var str = String(cell).trim();
  if (!str || str === '-') return 0;
  
  // Jika angka biasa (misal: "1", "3", "5", "0")
  var num = Number(str);
  if (!isNaN(num)) return Math.max(0, Math.floor(num));
  
  // Jika berisi emoji bintang: ⭐ (U+2B50), 🌟, ★ (U+2605)
  var starMatches = str.match(/[\u2B50\u2605\u2728\uD83C\uDF1F]/g);
  if (starMatches && starMatches.length > 0) {
    return starMatches.length;
  }
  
  // Jika centang atau huruf hadhir: ✓, ✔, V, v, H, h, X, x
  if (/^[vV✓✔xXhH]$/.test(str)) {
    return 1;
  }
  
  return 0;
}

/**
 * Membaca satu lembar sheet mata kuliah secara cerdas dan toleran header
 */
function parseSingleCourseSheet(sheet, courseId, studentMap) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 2) return;

  var data = sheet.getRange(1, 1, lastRow, lastCol).getValues();

  var headerRowIdx = -1;
  var nimColIdx = -1;
  var nameColIdx = -1;
  var meetingColMap = {};

  // Cari baris header yang memuat 'NIM' dan 'Nama Mahasiswi'
  for (var r = 0; r < Math.min(data.length, 10); r++) {
    var row = data[r];
    var foundNim = -1;
    var foundName = -1;
    for (var c = 0; c < row.length; c++) {
      var cellVal = String(row[c] || '').trim().toLowerCase();
      if (cellVal === 'nim' || cellVal.indexOf('nim') !== -1) {
        foundNim = c;
      } else if (cellVal.indexOf('nama') !== -1) {
        foundName = c;
      }
    }
    // Hanya anggap baris header jika terdapat kolom NIM atau Nama yang sah
    if (foundNim !== -1 && foundName !== -1) {
      headerRowIdx = r;
      nimColIdx = foundNim;
      nameColIdx = foundName;
      break;
    } else if (foundName !== -1 && headerRowIdx === -1 && r > 0) {
      headerRowIdx = r;
      nameColIdx = foundName;
      nimColIdx = (foundNim !== -1) ? foundNim : 1;
    }
  }

  // Fallback posisi standar jika header tidak ditemukan
  if (headerRowIdx === -1) {
    headerRowIdx = (lastRow >= 4) ? 2 : 0;
    nimColIdx = 1;
    nameColIdx = 2;
  }

  // Deteksi kolom P1 s.d P16 pada baris header (toleran spasi dan 'Pertemuan')
  var headerRow = data[headerRowIdx];
  for (var c = 0; c < headerRow.length; c++) {
    var colText = String(headerRow[c] || '').trim().toUpperCase();
    var match = colText.match(/^P\s*(\d+)$/) || colText.match(/^PERTEMUAN\s*(\d+)$/);
    if (match) {
      var mNum = parseInt(match[1], 10);
      if (mNum >= 1 && mNum <= 16) {
        meetingColMap[mNum] = c;
      }
    }
  }

  // Jika kolom P1..P16 tidak ada di header teks, gunakan kolom setelah nama
  if (Object.keys(meetingColMap).length === 0) {
    var startCol = (nameColIdx !== -1 ? nameColIdx + 1 : 3);
    for (var m = 1; m <= 16; m++) {
      var targetC = startCol + (m - 1);
      if (targetC < lastCol) {
        meetingColMap[m] = targetC;
      }
    }
  }

  // Baca tiap baris mahasiswi
  for (var r = headerRowIdx + 1; r < data.length; r++) {
    var row = data[r];
    var rawNim = (nimColIdx !== -1 && row[nimColIdx] !== undefined) ? String(row[nimColIdx]).trim() : '';
    var nim = rawNim.replace(/^'/, '').trim();
    var name = (nameColIdx !== -1 && row[nameColIdx] !== undefined) ? String(row[nameColIdx]).trim() : '';

    if (!name && !nim) continue;
    if (name.toLowerCase() === 'nama mahasiswi' || nim.toLowerCase() === 'nim') continue;
    if (name.toLowerCase().indexOf('total') !== -1 || name.toLowerCase().indexOf('rekapitulasi') !== -1) continue;

    var key = (nim ? nim.toLowerCase() : '') || name.toLowerCase();
    if (!studentMap[key]) {
      studentMap[key] = {
        id: 'MHS-' + (nim ? nim : name.replace(/\s+/g, '_')),
        nim: nim,
        name: name,
        courses: [],
        stars: { tafsir: {}, sirah1: {}, sirah2: {}, sharaf: {}, tauhid: {} },
        notes: { tafsir: {}, sirah1: {}, sirah2: {}, sharaf: {}, tauhid: {} }
      };
    }

    var student = studentMap[key];
    if (name) student.name = name;
    if (nim) student.nim = nim;
    if (student.courses.indexOf(courseId) === -1) {
      student.courses.push(courseId);
    }
    if (!student.stars[courseId]) student.stars[courseId] = {};

    for (var m = 1; m <= 16; m++) {
      var cIdx = meetingColMap[m];
      if (cIdx !== undefined && cIdx < row.length) {
        var starVal = parseStarValue(row[cIdx]);
        student.stars[courseId][m] = starVal;
      }
    }
  }
}

/**
 * Memperkaya hasil parse dengan catatan dari DB_JSON
 */
function enrichWithDbNotes(ss, parsedStudents) {
  try {
    var dbData = readDbJson(ss);
    if (!dbData || !Array.isArray(dbData)) return;
    var noteMap = {};
    dbData.forEach(function(s) {
      var key = (s.nim ? String(s.nim).replace(/^'/, '').trim().toLowerCase() : '') || (s.name ? s.name.trim().toLowerCase() : '');
      if (key && s.notes) noteMap[key] = s.notes;
    });
    parsedStudents.forEach(function(s) {
      var key = (s.nim ? String(s.nim).replace(/^'/, '').trim().toLowerCase() : '') || (s.name ? s.name.trim().toLowerCase() : '');
      if (key && noteMap[key]) {
        s.notes = noteMap[key];
      }
    });
  } catch(e) {}
}

/**
 * Memproses mutasi bertahap terhadap dataset server
 */
function applyMutations(students, mutations) {
  var list = students.slice(0);

  function findStudentIndex(id, nim, name) {
    // 1. Prioritaskan pencocokan NIM yang dinormalisasi
    if (nim) {
      var targetNim = String(nim).replace(/^'/, '').trim().toLowerCase();
      if (targetNim) {
        for (var i = 0; i < list.length; i++) {
          var sNim = String(list[i].nim || '').replace(/^'/, '').trim().toLowerCase();
          if (sNim && sNim === targetNim) return i;
        }
      }
    }
    // 2. Pencocokan ID
    if (id) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) return i;
      }
    }
    // 3. Pencocokan Nama
    if (name) {
      var targetName = String(name).trim().toLowerCase();
      if (targetName) {
        for (var i = 0; i < list.length; i++) {
          if (String(list[i].name || '').trim().toLowerCase() === targetName) return i;
        }
      }
    }
    return -1;
  }

  mutations.forEach(function(mut) {
    if (!mut || !mut.type) return;
    var p = mut.payload || {};

    switch (mut.type) {
      case 'ADD_STUDENT':
        if (p.student && p.student.name) {
          var existingIdx = findStudentIndex(p.student.id, p.student.nim, p.student.name);
          if (existingIdx === -1) {
            list.push(p.student);
          } else {
            var s = list[existingIdx];
            if (Array.isArray(p.student.courses)) {
              p.student.courses.forEach(function(c) {
                if (s.courses.indexOf(c) === -1) s.courses.push(c);
              });
            }
          }
        }
        break;

      case 'UPDATE_STARS':
        var idx = findStudentIndex(p.studentId, p.nim, p.name);
        if (idx !== -1) {
          var student = list[idx];
          if (!student.stars) student.stars = {};
          if (!student.stars[p.courseId]) student.stars[p.courseId] = {};
          student.stars[p.courseId][p.meeting] = Math.max(0, Number(p.count) || 0);
        }
        break;

      case 'UPDATE_NOTE':
        var nIdx = findStudentIndex(p.studentId, p.nim, p.name);
        if (nIdx !== -1) {
          var nStudent = list[nIdx];
          if (!nStudent.notes) nStudent.notes = {};
          if (!nStudent.notes[p.courseId]) nStudent.notes[p.courseId] = {};
          nStudent.notes[p.courseId][p.meeting] = String(p.text || '');
        }
        break;

      case 'BULK_STARS':
        var cId = p.courseId;
        var m = p.meeting;
        list.forEach(function(s) {
          if (s.courses && s.courses.indexOf(cId) !== -1) {
            if (!s.stars) s.stars = {};
            if (!s.stars[cId]) s.stars[cId] = {};
            var cur = Number(s.stars[cId][m]) || 0;
            s.stars[cId][m] = cur + 1;
          }
        });
        break;

      case 'EDIT_STUDENT':
        var eIdx = findStudentIndex(p.studentId, p.nim, p.name);
        if (eIdx !== -1) {
          list[eIdx].name = String(p.name || '').trim();
          list[eIdx].nim = String(p.nim || '').trim();
          if (Array.isArray(p.courses)) list[eIdx].courses = p.courses;
        }
        break;

      case 'DELETE_STUDENT':
        var dIdx = findStudentIndex(p.studentId, p.nim, p.name);
        if (dIdx === -1 && p.name) {
          var targetName = String(p.name).trim().toLowerCase();
          for (var i = 0; i < list.length; i++) {
            if (String(list[i].name).trim().toLowerCase() === targetName) {
              dIdx = i;
              break;
            }
          }
        }
        if (dIdx !== -1) {
          list.splice(dIdx, 1);
        }
        break;

      case 'RESET_DATA':
        break;
    }
  });

  return list;
}

/**
 * Safe Merge: Menggabungkan data incoming tanpa merusak data lama, dengan dukungan nilai 0
 */
function safeMergeStudents(serverList, incomingList) {
  var serverMap = {};
  serverList.forEach(function(s) {
    var key = (s.nim ? String(s.nim).replace(/^'/, '').trim().toLowerCase() : '') || s.id || s.name.toLowerCase();
    serverMap[key] = s;
  });

  incomingList.forEach(function(inS) {
    var key = (inS.nim ? String(inS.nim).replace(/^'/, '').trim().toLowerCase() : '') || inS.id || (inS.name ? inS.name.toLowerCase() : '');
    if (!serverMap[key]) {
      serverList.push(inS);
      serverMap[key] = inS;
    } else {
      var srvS = serverMap[key];
      if (inS.name) srvS.name = inS.name;
      if (inS.nim) srvS.nim = inS.nim;
      if (Array.isArray(inS.courses)) {
        inS.courses.forEach(function(c) {
          if (srvS.courses.indexOf(c) === -1) srvS.courses.push(c);
        });
      }
      if (inS.stars) {
        if (!srvS.stars) srvS.stars = {};
        Object.keys(inS.stars).forEach(function(cId) {
          if (!srvS.stars[cId]) srvS.stars[cId] = {};
          var cStars = inS.stars[cId];
          Object.keys(cStars).forEach(function(m) {
            var val = Number(cStars[m]);
            // FIX: Nilai 0 sekarang diterima sebagai pembaruan sah
            if (!isNaN(val) && val >= 0) {
              srvS.stars[cId][m] = Math.floor(val);
            }
          });
        });
      }
      if (inS.notes) {
        if (!srvS.notes) srvS.notes = {};
        Object.keys(inS.notes).forEach(function(cId) {
          if (!srvS.notes[cId]) srvS.notes[cId] = {};
          var cNotes = inS.notes[cId];
          Object.keys(cNotes).forEach(function(m) {
            if (cNotes[m] !== undefined) srvS.notes[cId][m] = cNotes[m];
          });
        });
      }
    }
  });

  return serverList;
}

/**
 * Membaca JSON utuh dari tab DB_JSON secara chunked
 */
function readDbJson(ss) {
  var dbSheet = ss.getSheetByName('DB_JSON');
  if (!dbSheet) return null;
  
  var lastRow = dbSheet.getLastRow();
  if (lastRow < 1) return null;
  
  var values = dbSheet.getRange(1, 1, lastRow, 1).getValues();
  var jsonStr = '';
  for (var i = 0; i < values.length; i++) {
    jsonStr += String(values[i][0] || '');
  }
  
  if (!jsonStr || jsonStr.trim() === '') return null;
  
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

/**
 * Menyimpan JSON ke tab DB_JSON secara chunked per baris (bebas batas 50k karakter)
 */
function writeDbJson(ss, data) {
  var dbSheet = ss.getSheetByName('DB_JSON');
  if (!dbSheet) {
    dbSheet = ss.insertSheet('DB_JSON');
    try { dbSheet.hideSheet(); } catch(e) {}
  }
  
  dbSheet.clearContents();
  
  var jsonStr = JSON.stringify(data);
  var chunkSize = 30000;
  var rows = [];
  
  for (var i = 0; i < jsonStr.length; i += chunkSize) {
    rows.push([jsonStr.substring(i, i + chunkSize)]);
  }
  
  if (rows.length > 0) {
    dbSheet.getRange(1, 1, rows.length, 1).setValues(rows);
  }
}

/**
 * Merender lembar rekap rapi per mata kuliah (Super Cepat & Efisien)
 */
function renderCourseSheets(ss, students, targetCourseIds) {
  if (!Array.isArray(students)) return;

  var courseList = Object.keys(COURSE_CONFIG);
  if (targetCourseIds && Object.keys(targetCourseIds).length > 0) {
    courseList = courseList.filter(function(cId) { return !!targetCourseIds[cId]; });
  }

  courseList.forEach(function(courseId) {
    var config = COURSE_CONFIG[courseId];
    var sheet = findSheetForCourse(ss, courseId);
    var isNewSheet = false;
    
    if (!sheet) {
      sheet = ss.insertSheet(config.name);
      isNewSheet = true;
    }
    
    var courseStudents = students.filter(function(s) {
      return s.courses && s.courses.indexOf(courseId) !== -1;
    });

    var headers = ['No', 'NIM', 'Nama Mahasiswi'];
    for (var m = 1; m <= 16; m++) {
      headers.push('P' + m);
    }
    headers.push('Total Bintang');
    
    var lastRow = sheet.getLastRow();
    
    // Format Header dan Kolom HANYA sekali saat sheet baru atau header belum ada
    if (isNewSheet || lastRow < 3) {
      sheet.getRange('A1').setValue('REKAPITULASI BINTANG KEAKTIFAN - ' + config.label.toUpperCase());
      sheet.getRange('A1').setFontWeight('bold').setFontSize(12).setFontColor('#004a3f');
      
      sheet.getRange(3, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(3, 1, 1, headers.length)
        .setBackground('#00897b')
        .setFontColor('#ffffff')
        .setFontWeight('bold')
        .setHorizontalAlignment('center');
        
      sheet.setColumnWidth(1, 40);
      sheet.setColumnWidth(2, 110);
      sheet.setColumnWidth(3, 230);
      for (var col = 4; col <= 19; col++) {
        sheet.setColumnWidth(col, 42);
      }
      sheet.setColumnWidth(20, 105);
    }
    
    var prevDataLastRow = sheet.getLastRow();
    
    if (courseStudents.length > 0) {
      var rows = [];
      courseStudents.forEach(function(s, idx) {
        var row = [(idx + 1), "'" + s.nim, s.name];
        var total = 0;
        for (var m = 1; m <= 16; m++) {
          var stars = (s.stars && s.stars[courseId] && s.stars[courseId][m] !== undefined) ? Number(s.stars[courseId][m]) : 0;
          row.push(stars);
          total += stars;
        }
        row.push(total);
        rows.push(row);
      });
      
      // Tulis seluruh baris nilai dalam 1 panggilan API (Ultra Cepat)
      sheet.getRange(4, 1, rows.length, headers.length).setValues(rows);
      
      // Jika sheet baru dibuat, berikan style dasar pada data
      if (isNewSheet || prevDataLastRow < 4) {
        sheet.getRange(4, 1, rows.length, 3).setHorizontalAlignment('left');
        sheet.getRange(4, 4, rows.length, 17).setHorizontalAlignment('center');
        sheet.getRange(4, headers.length, rows.length, 1)
          .setFontWeight('bold')
          .setBackground('#edfbf8')
          .setFontColor('#005f50');
      }
      
      // Bersihkan baris lama yang berlebih jika ada mahasiswa yang dihapus/pindah
      if (prevDataLastRow > 3 + rows.length) {
        sheet.getRange(4 + rows.length, 1, prevDataLastRow - (3 + rows.length), headers.length).clearContent();
      }
    } else {
      // Jika tidak ada mahasiswa sama sekali di sheet ini
      if (prevDataLastRow >= 4) {
        sheet.getRange(4, 1, prevDataLastRow - 3, headers.length).clearContent();
      }
    }
  });
}

/**
 * Format JSON Response untuk Output Web App
 */
function createJsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
