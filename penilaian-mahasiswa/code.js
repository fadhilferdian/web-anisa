function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : 'load';
  
  if (action === 'ping') {
    return createJsonResponse({
      status: 'success',
      message: 'Koneksi ke Google Apps Script Backend Berhasil!'
    });
  }
  
  // Fast Path: Server-Side Cache Check (<50ms)
  try {
    var cache = CacheService.getScriptCache();
    var cachedData = cache.get('STUDENTS_CACHE_DATA');
    if (cachedData && action === 'load') {
      return createJsonResponse({
        status: 'success',
        message: 'Data berhasil dimuat dari Server-Side Cache (Fast)',
        data: JSON.parse(cachedData),
        cached: true
      });
    }
  } catch (cErr) {}

  // Load Data - Spreadsheet adalah Source of Truth Utama
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    
    // 1. Coba baca data langsung dari tab rekap mata kuliah
    var parsedStudents = parseCourseSheets(ss);
    
    if (parsedStudents && parsedStudents.length > 0) {
      updateServerCache(parsedStudents);
      return createJsonResponse({
        status: 'success',
        message: 'Data berhasil dimuat dari lembar Spreadsheet',
        data: parsedStudents
      });
    }
    
    // 2. Fallback: Coba baca dari tab DB_JSON jika tab rekap belum terisi
    var dbSheet = ss.getSheetByName('DB_JSON');
    if (dbSheet) {
      var jsonText = dbSheet.getRange('A1').getValue();
      if (jsonText) {
        var parsedData = JSON.parse(jsonText);
        updateServerCache(parsedData);
        return createJsonResponse({
          status: 'success',
          message: 'Data berhasil dimuat dari DB_JSON Spreadsheet',
          data: parsedData
        });
      }
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

// Helper untuk memperbarui Server-Side ScriptCache
function updateServerCache(studentsData) {
  try {
    var cache = CacheService.getScriptCache();
    var jsonStr = JSON.stringify(studentsData);
    if (jsonStr.length < 100000) { // Limit CacheService max chunk size
      cache.put('STUDENTS_CACHE_DATA', jsonStr, 21600); // Cache for 6 hours
    }
  } catch (e) {}
}

// Helper untuk membaca data dari tab rekap mata kuliah secara langsung
function parseCourseSheets(ss) {
  var courseMap = {
    'tafsir': { name: 'Rekap Tafsir Al-Qur\'an' },
    'sirah1': { name: 'Rekap Sirah Nabawiyah 1' },
    'sirah2': { name: 'Rekap Sirah Nabawiyah 2' },
    'sharaf': { name: 'Rekap Ilmu Sharaf' },
    'tauhid': { name: 'Rekap Ilmu Tauhid' }
  };

  var existingNotes = {};
  var dbSheet = ss.getSheetByName('DB_JSON');
  if (dbSheet) {
    try {
      var jsonText = dbSheet.getRange('A1').getValue();
      if (jsonText) {
        var oldList = JSON.parse(jsonText);
        if (Array.isArray(oldList)) {
          oldList.forEach(function(s) {
            if (s.nim && s.notes) {
              existingNotes[s.nim] = s.notes;
            }
          });
        }
      }
    } catch (e) {}
  }

  var studentMap = {};

  Object.keys(courseMap).forEach(function(courseId) {
    var config = courseMap[courseId];
    var sheet = ss.getSheetByName(config.name);
    if (!sheet) return;

    var lastRow = sheet.getLastRow();
    if (lastRow < 4) return;

    var values = sheet.getRange(4, 1, lastRow - 3, 20).getValues();

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
          notes: existingNotes[nim] || { tafsir: {}, sirah1: {}, sirah2: {}, sharaf: {}, tauhid: {} }
        };
      }

      var student = studentMap[key];
      if (student.courses.indexOf(courseId) === -1) {
        student.courses.push(courseId);
      }

      if (!student.stars[courseId]) student.stars[courseId] = {};
      for (var m = 1; m <= 16; m++) {
        var val = Number(row[2 + m]);
        if (!isNaN(val) && val > 0) {
          student.stars[courseId][m] = val;
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


// Handle HTTP POST (Simpan & Sync Data - Mendukung Bundled Mutation Batch & Full Sync)
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return createJsonResponse({ status: 'error', message: 'Payload tidak ditemukan.' });
    }
    
    var payload = JSON.parse(e.postData.contents);
    var studentsData = payload.students || payload;
    var processedMutationsCount = 0;
    
    if (payload.action === 'batch_mutation' && Array.isArray(payload.mutations)) {
      processedMutationsCount = payload.mutations.length;
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    
    // 1. Simpan JSON Utama ke Tab DB_JSON (Fast Storage)
    var dbSheet = ss.getSheetByName('DB_JSON');
    if (!dbSheet) {
      dbSheet = ss.insertSheet('DB_JSON');
      dbSheet.hideSheet(); // Sembunyikan tab database mentah agar rapi
    }
    dbSheet.getRange('A1').setValue(JSON.stringify(studentsData));
    
    // 2. Render Rapi ke Tab Masing-Masing Mata Kuliah (Human Readable Sheet)
    if (Array.isArray(studentsData)) {
      renderCourseSheets(ss, studentsData);
      updateServerCache(studentsData);
    }
    
    return createJsonResponse({
      status: 'success',
      message: 'Data berhasil disinkronkan ke Spreadsheet!',
      mutationsProcessed: processedMutationsCount,
      timestamp: new Date().toISOString()
    });
    
  } catch (err) {
    return createJsonResponse({
      status: 'error',
      message: 'Gagal menyimpan ke Spreadsheet: ' + err.toString()
    });
  }
}

// Helper untuk format JSON Response
function createJsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Helper untuk merender data mahasiswi ke tab terpisah sesuai mata kuliah
function renderCourseSheets(ss, students) {
  var courseMap = {
    'tafsir': { name: 'Rekap Tafsir Al-Qur\'an', label: 'Tafsir Al-Qur\'an (PAI III)' },
    'sirah1': { name: 'Rekap Sirah Nabawiyah 1', label: 'Sirah Nabawiyah 1 (KPI I)' },
    'sirah2': { name: 'Rekap Sirah Nabawiyah 2', label: 'Sirah Nabawiyah 2 (PBA I)' },
    'sharaf': { name: 'Rekap Ilmu Sharaf', label: 'Ilmu Sharaf (IL)' },
    'tauhid': { name: 'Rekap Ilmu Tauhid', label: 'Ilmu Tauhid (PAI VII)' }
  };
  
  Object.keys(courseMap).forEach(function(courseId) {
    var config = courseMap[courseId];
    var sheet = ss.getSheetByName(config.name);
    if (!sheet) {
      sheet = ss.insertSheet(config.name);
    } else {
      sheet.clearContents();
    }
    
    // Filter mahasiswi pada mata kuliah ini
    var courseStudents = students.filter(function(s) {
      return s.courses && s.courses.indexOf(courseId) !== -1;
    });
    
    // Set Title Header
    sheet.getRange('A1').setValue('REKAPITULASI BINTANG KEAKTIFAN - ' + config.label.toUpperCase());
    sheet.getRange('A1').setFontWeight('bold').setFontSize(12).setFontColor('#004a3f');
    
    // Header Table
    var headers = ['No', 'NIM', 'Nama Mahasiswi'];
    for (var m = 1; m <= 16; m++) {
      headers.push('P' + m);
    }
    headers.push('Total Bintang');
    
    var headerRow = [headers];
    sheet.getRange(3, 1, 1, headers.length).setValues(headerRow);
    sheet.getRange(3, 1, 1, headers.length)
      .setBackground('#00897b')
      .setFontColor('#ffffff')
      .setFontWeight('bold')
      .setHorizontalAlignment('center');
      
    // Rows Data
    if (courseStudents.length > 0) {
      var rows = [];
      courseStudents.forEach(function(s, idx) {
        var row = [(idx + 1), "'" + s.nim, s.name];
        var total = 0;
        for (var m = 1; m <= 16; m++) {
          var stars = (s.stars && s.stars[courseId] && s.stars[courseId][m]) ? s.stars[courseId][m] : 0;
          row.push(stars);
          total += stars;
        }
        row.push(total);
        rows.push(row);
      });
      
      sheet.getRange(4, 1, rows.length, headers.length).setValues(rows);
      
      // Styling Table Data
      sheet.getRange(4, 1, rows.length, 3).setHorizontalAlignment('left');
      sheet.getRange(4, 4, rows.length, 17).setHorizontalAlignment('center');
      
      // Total column styling
      sheet.getRange(4, headers.length, rows.length, 1)
        .setFontWeight('bold')
        .setBackground('#edfbf8')
        .setFontColor('#005f50');
    }
    
    // Auto-fit column widths
    sheet.setColumnWidth(1, 40);  // No
    sheet.setColumnWidth(2, 110); // NIM
    sheet.setColumnWidth(3, 220); // Nama
    for (var col = 4; col <= 19; col++) {
      sheet.setColumnWidth(col, 42); // Pertemuan
    }
    sheet.setColumnWidth(20, 100); // Total
  });
}
