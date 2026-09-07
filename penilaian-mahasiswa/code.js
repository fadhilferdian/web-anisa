/**
 * ============================================================================
 * GOOGLE APPS SCRIPT BACKEND - PORTAL KEAKTIFAN MAHASISWI (ROBUST SYNC ENGINE)
 * ============================================================================
 * Prinsip:
 * 1. SPREADSHEET ADALAH SINGLE SOURCE OF TRUTH:
 *    Data dibaca langsung dari lembar sheet masing-masing mata kuliah.
 * 2. TOLERAN NILAI BINTANG:
 *    Mendukung angka biasa (1, 2, 3), emoji bintang (⭐, ★), centang (✓, v), checkbox (TRUE).
 * 3. ANTI-DATA LOSS:
 *    Sinkronisasi tidak akan pernah menghapus bintang atau mahasiswi yang sudah ada.
 * 4. CHUNKED STORAGE:
 *    Tab DB_JSON disimpan per baris sehingga terhindar dari batas 50.000 karakter per sel.
 * 5. FLEKSIBEL NAMA SHEET & KOLOM:
 *    Mendeteksi otomatis header NIM, Nama, dan kolom P1-P16 pada sheet mata kuliah.
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
 * Handle HTTP GET (Memuat data langsung dari Spreadsheet sebagai Single Source of Truth)
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
    
    // 1. SPREADSHEET SEBAGAI SINGLE SOURCE OF TRUTH:
    // Baca langsung dari lembar sheet Spreadsheet yang ada!
    var parsedStudents = parseAllCourseSheets(ss);
    
    if (parsedStudents && Array.isArray(parsedStudents) && parsedStudents.length > 0) {
      // Perkaya dengan catatan lama jika ada di DB_JSON
      enrichWithDbNotes(ss, parsedStudents);
      // Simpan snapshot aman ke DB_JSON
      writeDbJson(ss, parsedStudents);
      return createJsonResponse({
        status: 'success',
        message: 'Data berhasil dimuat langsung dari lembar Spreadsheet (Single Source of Truth)',
        data: parsedStudents,
        total: parsedStudents.length,
        source: 'sheets'
      });
    }
    
    // 2. Fallback: Coba baca dari DB_JSON jika tab mata kuliah belum terisi
    var dbData = readDbJson(ss);
    if (dbData && Array.isArray(dbData) && dbData.length > 0) {
      return createJsonResponse({
        status: 'success',
        message: 'Data berhasil dimuat dari DB_JSON Spreadsheet',
        data: dbData,
        total: dbData.length,
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
  }
}

/**
 * Handle HTTP POST (Penyimpanan Aman & Terkendali Tanpa Menghapus Data Lama)
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return createJsonResponse({ status: 'error', message: 'Payload tidak ditemukan.' });
    }
    
    var payload = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    
    // Muat data yang saat ini ada di Spreadsheet sebagai basis authoritative
    var existingStudents = parseAllCourseSheets(ss);
    if (!existingStudents || existingStudents.length === 0) {
      existingStudents = readDbJson(ss) || [];
    }
    
    var processedMutationsCount = 0;
    var finalStudents = [];

    // Filter out student yang terdaftar di deletedStudentIds jika ada
    if (Array.isArray(payload.deletedStudentIds) && payload.deletedStudentIds.length > 0) {
      existingStudents = existingStudents.filter(function(s) {
        return payload.deletedStudentIds.indexOf(s.id) === -1 && 
               payload.deletedStudentIds.indexOf(s.nim) === -1;
      });
    }

    // Jika mutasi bertahap dikirimkan dari Outbox Queue
    if (payload.action === 'batch_mutation' && Array.isArray(payload.mutations) && payload.mutations.length > 0) {
      finalStudents = applyMutations(existingStudents, payload.mutations);
      processedMutationsCount = payload.mutations.length;
    } 
    // Jika sinkronisasi penuh dikirimkan
    else if (payload.students && Array.isArray(payload.students)) {
      if (existingStudents.length === 0) {
        finalStudents = payload.students;
      } else {
        // Safe Merge: Jangan pernah menimpa bintang yang sudah ada dengan 0
        finalStudents = safeMergeStudents(existingStudents, payload.students);
      }
    } else {
      finalStudents = existingStudents;
    }
    
    // Simpan ke DB_JSON
    writeDbJson(ss, finalStudents);
    
    // Render kembali lembar rekap rapi di masing-masing tab mata kuliah
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
 * Mencari sheet berdasarkan ID mata kuliah dengan fleksibilitas nama
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
  if (typeof cell === 'number') return Math.max(0, cell);
  if (typeof cell === 'boolean') return cell ? 1 : 0;
  
  var str = String(cell).trim();
  if (!str) return 0;
  
  // Jika angka biasa (misal: "1", "3", "5")
  var num = Number(str);
  if (!isNaN(num)) return Math.max(0, num);
  
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
 * Membaca satu lembar sheet mata kuliah secara cerdas
 */
function parseSingleCourseSheet(sheet, courseId, studentMap) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 2) return;

  var data = sheet.getRange(1, 1, lastRow, lastCol).getValues();

  // Cari baris header yang memuat 'NIM' atau 'Nama'
  var headerRowIdx = -1;
  var nimColIdx = -1;
  var nameColIdx = -1;
  var meetingColMap = {};

  for (var r = 0; r < Math.min(data.length, 10); r++) {
    var row = data[r];
    for (var c = 0; c < row.length; c++) {
      var cellVal = String(row[c] || '').trim().toLowerCase();
      if (cellVal === 'nim' || cellVal.indexOf('nim') !== -1) {
        nimColIdx = c;
        headerRowIdx = r;
      } else if (cellVal.indexOf('nama') !== -1) {
        nameColIdx = c;
        headerRowIdx = r;
      }
    }
    if (headerRowIdx !== -1) break;
  }

  // Fallback posisi standar jika header tidak ditemukan
  if (headerRowIdx === -1) {
    headerRowIdx = (lastRow >= 4) ? 2 : 0;
    nimColIdx = 1;
    nameColIdx = 2;
  } else {
    // Deteksi kolom P1 s.d P16 pada baris header
    var headerRow = data[headerRowIdx];
    for (var c = 0; c < headerRow.length; c++) {
      var colText = String(headerRow[c] || '').trim().toUpperCase();
      var match = colText.match(/^P(\d+)$/);
      if (match) {
        var mNum = parseInt(match[1], 10);
        if (mNum >= 1 && mNum <= 16) {
          meetingColMap[mNum] = c;
        }
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
    if (name.toLowerCase().indexOf('total') !== -1) continue;

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
    if (name) {
      student.name = name;
    }
    if (nim) {
      student.nim = nim;
    }
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
      if (s.nim && s.notes) noteMap[s.nim] = s.notes;
    });
    parsedStudents.forEach(function(s) {
      if (s.nim && noteMap[s.nim]) {
        s.notes = noteMap[s.nim];
      }
    });
  } catch(e) {}
}

/**
 * Memproses mutasi bertahap terhadap dataset server
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
        var dIdx = findStudentIndex(p.studentId, p.nim);
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
 * Merender lembar rekap rapi per mata kuliah (Human Readable)
 */
function renderCourseSheets(ss, students) {
  if (!Array.isArray(students)) return;

  Object.keys(COURSE_CONFIG).forEach(function(courseId) {
    var config = COURSE_CONFIG[courseId];
    var sheet = findSheetForCourse(ss, courseId);
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
