/**
 * ============================================================================
 * GOOGLE APPS SCRIPT BACKEND - PORTAL KEAKTIFAN MAHASISWI (ROBUST SYNC ENGINE)
 * ============================================================================
 * Fitur:
 * 1. Safe Chunked Storage: Mengatasi batas 50.000 karakter per sel di Spreadsheet.
 * 2. Incremental Mutation Processor: Menangani mutasi satu per satu tanpa menghapus data lama.
 * 3. Safe Merge: Data lama di Spreadsheet tidak akan terhapus jika client mengirim data kosong/stale.
 * 4. Human-Readable Sheets: Otomatis merender lembar rekap rapi per mata kuliah.
 */

// Konfigurasi Mata Kuliah & Lembar Sheet
var COURSE_CONFIG = {
  'tafsir': { name: 'Rekap Tafsir Al-Qur\'an', label: 'Tafsir Al-Qur\'an (PAI III)' },
  'sirah1': { name: 'Rekap Sirah Nabawiyah 1', label: 'Sirah Nabawiyah 1 (KPI I)' },
  'sirah2': { name: 'Rekap Sirah Nabawiyah 2', label: 'Sirah Nabawiyah 2 (PBA I)' },
  'sharaf': { name: 'Rekap Ilmu Sharaf', label: 'Ilmu Sharaf (IL)' },
  'tauhid': { name: 'Rekap Ilmu Tauhid', label: 'Ilmu Tauhid (PAI VII)' }
};

/**
 * Handle HTTP GET (Ping & Memuat Data ke Frontend)
 */
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : 'load';
  
  if (action === 'ping') {
    return createJsonResponse({
      status: 'success',
      message: 'Koneksi ke Google Apps Script Backend Berhasil!',
      timestamp: new Date().toISOString()
    });
  }
  
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    
    // 1. Coba baca dari tab DB_JSON (Format JSON utuh tersimpan dalam chunk baris)
    var dbData = readDbJson(ss);
    if (dbData && Array.isArray(dbData) && dbData.length > 0) {
      return createJsonResponse({
        status: 'success',
        message: 'Data berhasil dimuat dari DB_JSON Spreadsheet',
        data: dbData,
        source: 'db_json'
      });
    }
    
    // 2. Fallback: Parse langsung dari lembar mata kuliah jika DB_JSON belum tersedia
    var parsedStudents = parseCourseSheets(ss);
    if (parsedStudents && Array.isArray(parsedStudents) && parsedStudents.length > 0) {
      // Simpan ke DB_JSON agar panggilan berikutnya lebih cepat & persisten
      writeDbJson(ss, parsedStudents);
      return createJsonResponse({
        status: 'success',
        message: 'Data berhasil dimuat dari lembar mata kuliah Spreadsheet',
        data: parsedStudents,
        source: 'sheets'
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
  }
}

/**
 * Handle HTTP POST (Penyimpanan & Sinkronisasi Bertahap Tanpa Hapus Data)
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return createJsonResponse({ status: 'error', message: 'Payload tidak ditemukan.' });
    }
    
    var payload = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    
    // 1. Muat data yang sudah ada di Spreadsheet sebagai basis authoritative
    var existingStudents = readDbJson(ss) || parseCourseSheets(ss) || [];
    var processedMutationsCount = 0;
    var finalStudents = [];

    // 2. Jika mutasi bertahap (Batch Mutations) dikirim dari Outbox Queue
    if (payload.action === 'batch_mutation' && Array.isArray(payload.mutations) && payload.mutations.length > 0) {
      finalStudents = applyMutations(existingStudents, payload.mutations);
      processedMutationsCount = payload.mutations.length;
    } 
    // 3. Jika pengiriman data penuh (Full Sync / Fallback)
    else if (payload.students && Array.isArray(payload.students)) {
      if (existingStudents.length === 0) {
        finalStudents = payload.students;
      } else {
        // Lakukan penggabungan aman (Safe Merge) agar bintang di spreadsheet tidak terhapus
        finalStudents = safeMergeStudents(existingStudents, payload.students);
      }
    } else {
      finalStudents = existingStudents;
    }
    
    // 4. Simpan hasil mutasi/penggabungan ke DB_JSON dengan chunked storage (aman dari limit 50k)
    writeDbJson(ss, finalStudents);
    
    // 5. Render tampilan tabel visual di masing-masing sheet mata kuliah
    renderCourseSheets(ss, finalStudents);
    
    return createJsonResponse({
      status: 'success',
      message: 'Data berhasil disinkronkan ke Spreadsheet tanpa menghapus riwayat!',
      mutationsProcessed: processedMutationsCount,
      totalStudents: finalStudents.length,
      data: finalStudents,
      timestamp: new Date().toISOString()
    });
    
  } catch (err) {
    return createJsonResponse({
      status: 'error',
      message: 'Gagal menyimpan ke Spreadsheet: ' + err.toString()
    });
  }
}

/**
 * Memproses daftar mutasi secara bertahap terhadap dataset server
 */
function applyMutations(students, mutations) {
  var list = students.slice(0);

  function findStudentIndex(id, nim) {
    for (var i = 0; i < list.length; i++) {
      if (id && list[i].id === id) return i;
      if (nim && String(list[i].nim).trim() === String(nim).trim()) return i;
    }
    return -1;
  }

  mutations.forEach(function(mut) {
    if (!mut || !mut.type) return;
    var p = mut.payload || {};

    switch (mut.type) {
      case 'ADD_STUDENT':
        if (p.student && p.student.name) {
          var existingIdx = findStudentIndex(p.student.id, p.student.nim);
          if (existingIdx === -1) {
            list.unshift(p.student);
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
        var idx = findStudentIndex(p.studentId, null);
        if (idx !== -1) {
          var student = list[idx];
          if (!student.stars) student.stars = {};
          if (!student.stars[p.courseId]) student.stars[p.courseId] = {};
          student.stars[p.courseId][p.meeting] = Math.max(0, Number(p.count) || 0);
        }
        break;

      case 'UPDATE_NOTE':
        var nIdx = findStudentIndex(p.studentId, null);
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
        var eIdx = findStudentIndex(p.studentId, null);
        if (eIdx !== -1) {
          list[eIdx].name = String(p.name || '').trim();
          list[eIdx].nim = String(p.nim || '').trim();
          if (Array.isArray(p.courses)) list[eIdx].courses = p.courses;
        }
        break;

      case 'DELETE_STUDENT':
        var dIdx = findStudentIndex(p.studentId, null);
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
 * Safe Merge: Menggabungkan data incoming tanpa menghapus bintang yang sudah ada di server
 */
function safeMergeStudents(serverList, incomingList) {
  var serverMap = {};
  serverList.forEach(function(s) {
    var key = s.id || s.nim;
    serverMap[key] = s;
  });

  incomingList.forEach(function(inS) {
    var key = inS.id || inS.nim;
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
            if (!isNaN(val) && val > 0) {
              srvS.stars[cId][m] = val;
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
            if (cNotes[m]) srvS.notes[cId][m] = cNotes[m];
          });
        });
      }
    }
  });

  return serverList;
}

/**
 * Membaca JSON utuh dari tab DB_JSON yang terbagi per baris (Chunked)
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
 * Menyimpan JSON ke tab DB_JSON secara chunked per baris (maks 30.000 karakter per baris)
 * Hal ini 100% mencegah error limit 50.000 karakter per sel di Google Spreadsheet!
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
 * Helper untuk membaca data dari tab rekap mata kuliah jika DB_JSON belum ada
 */
function parseCourseSheets(ss) {
  var studentMap = {};

  Object.keys(COURSE_CONFIG).forEach(function(courseId) {
    var config = COURSE_CONFIG[courseId];
    var sheet = ss.getSheetByName(config.name);
    if (!sheet) return;

    var lastRow = sheet.getLastRow();
    if (lastRow < 4) return;

    var lastCol = sheet.getLastColumn();
    var colsToFetch = Math.min(Math.max(lastCol, 3), 20);
    var values = sheet.getRange(4, 1, lastRow - 3, colsToFetch).getValues();

    values.forEach(function(row) {
      var rawNim = String(row[1] || '').trim();
      var nim = rawNim.replace(/^'/, '');
      var name = String(row[2] || '').trim();

      if (!nim && !name) return;

      var key = nim || name;
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
      if (student.courses.indexOf(courseId) === -1) {
        student.courses.push(courseId);
      }

      if (!student.stars[courseId]) student.stars[courseId] = {};
      for (var m = 1; m <= 16; m++) {
        var colIdx = 2 + m;
        if (colIdx < colsToFetch) {
          var val = Number(row[colIdx]);
          if (!isNaN(val) && val > 0) {
            student.stars[courseId][m] = val;
          }
        }
      }
    });
  });

  var resultList = [];
  Object.keys(studentMap).forEach(function(k) {
    resultList.push(studentMap[k]);
  });

  return resultList;
}

/**
 * Merender lembar rekap rapi per mata kuliah (Human Readable)
 */
function renderCourseSheets(ss, students) {
  if (!Array.isArray(students)) return;

  Object.keys(COURSE_CONFIG).forEach(function(courseId) {
    var config = COURSE_CONFIG[courseId];
    var sheet = ss.getSheetByName(config.name);
    if (!sheet) {
      sheet = ss.insertSheet(config.name);
    } else {
      sheet.clearContents();
    }
    
    var courseStudents = students.filter(function(s) {
      return s.courses && s.courses.indexOf(courseId) !== -1;
    });
    
    sheet.getRange('A1').setValue('REKAPITULASI BINTANG KEAKTIFAN - ' + config.label.toUpperCase());
    sheet.getRange('A1').setFontWeight('bold').setFontSize(12).setFontColor('#004a3f');
    
    var headers = ['No', 'NIM', 'Nama Mahasiswi'];
    for (var m = 1; m <= 16; m++) {
      headers.push('P' + m);
    }
    headers.push('Total Bintang');
    
    sheet.getRange(3, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(3, 1, 1, headers.length)
      .setBackground('#00897b')
      .setFontColor('#ffffff')
      .setFontWeight('bold')
      .setHorizontalAlignment('center');
      
    if (courseStudents.length > 0) {
      var rows = [];
      courseStudents.forEach(function(s, idx) {
        var row = [(idx + 1), "'" + s.nim, s.name];
        var total = 0;
        for (var m = 1; m <= 16; m++) {
          var stars = (s.stars && s.stars[courseId] && s.stars[courseId][m]) ? Number(s.stars[courseId][m]) : 0;
          row.push(stars);
          total += stars;
        }
        row.push(total);
        rows.push(row);
      });
      
      sheet.getRange(4, 1, rows.length, headers.length).setValues(rows);
      sheet.getRange(4, 1, rows.length, 3).setHorizontalAlignment('left');
      sheet.getRange(4, 4, rows.length, 17).setHorizontalAlignment('center');
      
      sheet.getRange(4, headers.length, rows.length, 1)
        .setFontWeight('bold')
        .setBackground('#edfbf8')
        .setFontColor('#005f50');
    }
    
    sheet.setColumnWidth(1, 40);
    sheet.setColumnWidth(2, 110);
    sheet.setColumnWidth(3, 230);
    for (var col = 4; col <= 19; col++) {
      sheet.setColumnWidth(col, 42);
    }
    sheet.setColumnWidth(20, 105);
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
