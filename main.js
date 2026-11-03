const { app, BrowserWindow, ipcMain } = require('electron');
let HID = null;
try {
  // اختياري: قد لا تكون node-hid مثبتة في كل بيئة
  HID = require('node-hid');
} catch (_) {
  HID = null;
}
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { dialog } = require('electron');
const net = require("net");
const https = require('https');
const http = require('http');
const os = require('os');
const { execSync } = require('child_process');
const crypto = require('crypto');
const CUSTOMER_PORT = 3000;
const VOICE_WS_PORT = 3001; // WebSocket port للمكالمات الصوتية
let mainWindow;

// ===================== نظام القفل lockall =====================
// مطابق لبروتوكول ps4lock.py:
//   1) TCP للبورت 9095 الخاص بالبلجن:  token:command  ->  OK locked / OK unlocked / locked / unlocked / ERR
//   2) عند الفشل (مفيش لعبة شغالة/الكونسول مقفول): FTP بورت 2121 الخاص بـ GoldHEN
//      لكتابة/قراءة ملف الحالة  /data/GoldHEN/lockall_state.txt  ("1" = مقفول، "0" = مفتوح)
const PS4LOCK_TCP_PORT = 9095;
const PS4LOCK_FTP_PORT = 2121;
const PS4LOCK_STATE_PATH = '/data/GoldHEN/lockall_state.txt';
const PS4LOCK_DEFAULT_TOKEN = 'changeme';
const PS4LOCK_TIMEOUT = 4000;
const PS4LOCK_STATUS_TIMEOUT = 2500;

// WebSocket server للمكالمات الصوتية
let voiceWSServer = null;
let voiceClients = {}; // { deviceId: { ws, role: 'customer'|'admin' } }

// إعداد مدة الفترة التجريبية (مثلاً 14 يوم)
const TRIAL_DAYS = 14;
// أيام فتح مجاني تلقائي قبل طلب كود التفعيل
const FREE_DAYS_BEFORE_CODE = 2;
// مهم: ملف بداية التجربة لازم يكون في AppData (قابل للكتابة) مش جوه البرنامج
// لأن الملف اللي جوه حزمة التطبيق للقراءة فقط وبيفضل بتاريخ البناء → نظام اليومين ما كانش بيعمل
const TRIAL_START_FILE = path.join(app.getPath('userData'), 'trial_start.txt');

// كود المالك (يفعّل البرنامج بدون توليد كود)
const MASTER_ACTIVATION_CODE = 'ziad';
const MASTER_ACTIVATION_DAYS = 365;
// تسامح مع فروق الساعة البسيطة (توقيت صيفي/تصحيح تلقائي) = 12 ساعة
const TAMPER_TOLERANCE_MS = 12 * 60 * 60 * 1000;

// التعديل هنا: حفظ ملف التفعيل في مجلد AppData الخاص بالمستخدم
const ACTIVATION_INFO_FILE = path.join(app.getPath('userData'), 'activation_info.txt');

// --- حماية من التلاعب في التاريخ بدون إنترنت ---
const TRIAL_RUNS_FILE = path.join(app.getPath('userData'), 'trial_runs.txt');


// دالة لتخزين تاريخ التشغيل (بنحتفظ بآخر 500 تشغيل بس)
function logTrialRun(now) {
  let runs = [];
  if (fs.existsSync(TRIAL_RUNS_FILE)) {
    try {
      runs = fs.readFileSync(TRIAL_RUNS_FILE, 'utf-8').split('\n').map(Number).filter(Boolean);
    } catch (e) { runs = []; }
  }
  runs.push(now);
  if (runs.length > 500) runs = runs.slice(-500);
  try {
    fs.writeFileSync(TRIAL_RUNS_FILE, runs.join('\n'), { encoding: 'utf-8' });
  } catch (e) {
    console.error('فشل حفظ سجل التشغيل:', e.message);
  }
}

// دالة للتحقق من التلاعب
function isDateTampered(now) {
  if (!fs.existsSync(TRIAL_RUNS_FILE)) return false;
  try {
    const runs = fs.readFileSync(TRIAL_RUNS_FILE, 'utf-8').split('\n').map(Number).filter(Boolean);
    if (!runs.length) return false;
    // بنسمح بفروق بسيطة (توقيت صيفي/تصحيح تلقائي للساعة) ومش بنحجب بسببها
    return now < Math.max(...runs) - TAMPER_TOLERANCE_MS;
  } catch (e) { return false; }
}

// إصلاح سجل التشغيل لو الساعة كانت مظبوطة غلط (بيمسح التواريخ المستقبلية)
function healTrialRuns(realNow) {
  try {
    if (!fs.existsSync(TRIAL_RUNS_FILE)) return;
    const runs = fs.readFileSync(TRIAL_RUNS_FILE, 'utf-8').split('\n').map(Number).filter(Boolean);
    const fixed = runs.filter(r => r <= realNow + TAMPER_TOLERANCE_MS);
    fs.writeFileSync(TRIAL_RUNS_FILE, fixed.join('\n'), { encoding: 'utf-8' });
  } catch (e) { /* تجاهل */ }
}
// --- نهاية الحماية ---

function getTrialInfo() {
  let start = null;
  if (fs.existsSync(TRIAL_START_FILE)) {
    try {
      const parsed = parseInt(fs.readFileSync(TRIAL_START_FILE, 'utf-8'));
      if (Number.isFinite(parsed) && parsed > 0) start = parsed;
    } catch (e) { start = null; }
  }
  if (!start) {
    start = Date.now();
    try {
      fs.writeFileSync(TRIAL_START_FILE, String(start));
    } catch (e) {
      // حتى لو فشل الحفظ، منرجعش خطأ — البرنامج يكمل بالتاريخ الحالي
      console.error('فشل حفظ تاريخ بداية التجربة:', e.message);
    }
  }
  return start;
}

function getOnlineDate(timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        resolve(null); // استخدم تاريخ الجهاز
      }
    }, timeoutMs);
    https.get('https://worldtimeapi.org/api/timezone/Etc/UTC', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (finished) return;
        clearTimeout(timer);
        try {
          const json = JSON.parse(data);
          if (json && json.unixtime) {
            finished = true;
            resolve(json.unixtime * 1000);
          } else {
            finished = true;
            resolve(null);
          }
        } catch (e) {
          finished = true;
          resolve(null);
        }
      });
    }).on('error', () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}

async function isTrialExpiredOnline() {
  const start = getTrialInfo();
  let now = await getOnlineDate();
  if (!now) now = Date.now(); // fallback
  const diffDays = Math.floor((now - start) / (1000 * 60 * 60 * 24));
  return diffDays >= TRIAL_DAYS;
}

// الوقت الموثوق: وقت الإنترنت لو متاح، وإلا وقت الجهاز
async function getTrustedNow() {
  const online = await getOnlineDate();
  return online || Date.now();
}

// تهيئة قاعدة البيانات
// const dbPath = path.join(__dirname, 'ps.db'); // السطر القديم - سيتم استبداله

// --- تحديد مسار قاعدة البيانات والتعامل مع التشغيل الأول ---
const userDataPath = app.getPath('userData');
const dbPath = path.join(userDataPath, 'ps.db');
const oldDbPath = path.join(__dirname, 'ps.db');
const FIRST_RUN_MARKER = path.join(userDataPath, 'first_run_done');

// على التشغيل الأول: لا تنسخ قاعدة البيانات القديمة، ابدأ بقاعدة فارغة
const isFirstRun = !fs.existsSync(FIRST_RUN_MARKER);
if (!fs.existsSync(dbPath)) {
  if (!isFirstRun && fs.existsSync(oldDbPath)) {
    try {
      fs.copyFileSync(oldDbPath, dbPath);
    } catch (e) {
      console.error('فشل نسخ قاعدة البيانات:', e);
    }
  }
}
// --- نهاية التعديل ---

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    dialog.showErrorBox('خطأ في قاعدة البيانات', 'فشل فتح قاعدة البيانات: ' + err.message);
    app.quit();
  }
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS trial_info (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    start INTEGER,
    last_checked INTEGER,
    activation_code TEXT,
    trial_days INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ip TEXT,
    price REAL,
    price_single REAL,
    price_double REAL,
    image TEXT
  )`);
  // ترقية الجدول إذا كان موجودًا بدون price_single أو price_double أو image
  db.get("PRAGMA table_info(devices)", (err, row) => {
    db.all("PRAGMA table_info(devices)", (err, columns) => {
      const hasPrice = columns.some(col => col.name === 'price');
      if (!hasPrice) {
        db.run('ALTER TABLE devices ADD COLUMN price REAL');
      }
      const hasIp = columns.some(col => col.name === 'ip');
      if (!hasIp) {
        db.run('ALTER TABLE devices ADD COLUMN ip TEXT');
      }
      const hasSingle = columns.some(col => col.name === 'price_single');
      if (!hasSingle) {
        db.run('ALTER TABLE devices ADD COLUMN price_single REAL');
      }
      const hasDouble = columns.some(col => col.name === 'price_double');
      if (!hasDouble) {
        db.run('ALTER TABLE devices ADD COLUMN price_double REAL');
      }
      const hasImage = columns.some(col => col.name === 'image');
      if (!hasImage) {
        db.run('ALTER TABLE devices ADD COLUMN image TEXT');
      }
      const hasAllowFreeOpen = columns.some(col => col.name === 'allow_free_open');
      if (!hasAllowFreeOpen) {
        db.run('ALTER TABLE devices ADD COLUMN allow_free_open INTEGER DEFAULT 0');
      }
      const hasToken = columns.some(col => col.name === 'token');
      if (!hasToken) {
        db.run('ALTER TABLE devices ADD COLUMN token TEXT');
      }
    });
  });
  // جدول الجلسات
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    start_time INTEGER,
    end_time INTEGER,
    scheduled_end_time INTEGER, -- وقت الانتهاء المحدد مسبقاً
    type TEXT, -- timed/open
    duration INTEGER, -- بالثواني (للمؤقت)
    total REAL,
    is_active INTEGER DEFAULT 1,
    mode TEXT -- single/double
  )`);
  
  // جدول لتسجيل محاولات التلاعب في الوقت
  db.run(`CREATE TABLE IF NOT EXISTS security_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER,
    device_id TEXT,
    event_type TEXT,
    details TEXT
  )`);
  // ترقية الجدول إذا كان موجودًا بدون mode
  db.get("PRAGMA table_info(sessions)", (err, row) => {
    db.all("PRAGMA table_info(sessions)", (err, columns) => {
      const hasMode = columns.some(col => col.name === 'mode');
      if (!hasMode) {
        db.run('ALTER TABLE sessions ADD COLUMN mode TEXT');
      }
      const hasScheduledEndTime = columns.some(col => col.name === 'scheduled_end_time');
      if (!hasScheduledEndTime) {
        db.run('ALTER TABLE sessions ADD COLUMN scheduled_end_time INTEGER');
      }
      const hasClientId = columns.some(col => col.name === 'client_id');
      if (!hasClientId) {
        db.run('ALTER TABLE sessions ADD COLUMN client_id INTEGER');
      }
      const hasDiscountAmount = columns.some(col => col.name === 'discount_amount');
      if (!hasDiscountAmount) {
        db.run('ALTER TABLE sessions ADD COLUMN discount_amount REAL DEFAULT 0');
      }
      const hasDiscountReason = columns.some(col => col.name === 'discount_reason');
      if (!hasDiscountReason) {
        db.run('ALTER TABLE sessions ADD COLUMN discount_reason TEXT');
      }
      const hasPaidAmount = columns.some(col => col.name === 'paid_amount');
      if (!hasPaidAmount) {
        db.run('ALTER TABLE sessions ADD COLUMN paid_amount REAL DEFAULT 0');
      }
      const hasBookingId = columns.some(col => col.name === 'booking_id');
      if (!hasBookingId) {
        db.run('ALTER TABLE sessions ADD COLUMN booking_id INTEGER');
      }
      const hasBookedDuration = columns.some(col => col.name === 'booked_duration');
      if (!hasBookedDuration) {
        db.run('ALTER TABLE sessions ADD COLUMN booked_duration INTEGER');
      }
    });
  });
  // جدول المنتجات
  db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    category TEXT
  )`);
  // ترقية جدول المنتجات لإضافة عمود الكمية إذا لم يكن موجوداً
  db.get("PRAGMA table_info(products)", (err, row) => {
    db.all("PRAGMA table_info(products)", (err, columns) => {
      const hasQuantity = columns.some(col => col.name === 'quantity');
      if (!hasQuantity) {
        db.run('ALTER TABLE products ADD COLUMN quantity INTEGER DEFAULT 0');
      }
      // إضافة عمود image إذا لم يكن موجوداً
      const hasImage = columns.some(col => col.name === 'image');
      if (!hasImage) {
        db.run('ALTER TABLE products ADD COLUMN image TEXT');
      }
    });
  });
  // جدول المكونات (المواد الخام)
  db.run(`CREATE TABLE IF NOT EXISTS components (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    unit TEXT NOT NULL,
    description TEXT
  )`);
  
  // جدول مخزون المكونات
  db.run(`CREATE TABLE IF NOT EXISTS component_inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    component_id INTEGER,
    quantity REAL NOT NULL DEFAULT 0,
    min_quantity REAL DEFAULT 0,
    last_updated INTEGER,
    FOREIGN KEY(component_id) REFERENCES components(id),
    UNIQUE(component_id)
  )`);
  
  // جدول مكونات المنتجات
  db.run(`CREATE TABLE IF NOT EXISTS product_components (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    component_id INTEGER,
    quantity_required REAL NOT NULL,
    FOREIGN KEY(product_id) REFERENCES products(id),
    FOREIGN KEY(component_id) REFERENCES components(id)
  )`);

  // جدول العملاء
  db.run(`CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    address TEXT,
    notes TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')*1000)
  )`);
  db.run(`ALTER TABLE clients ADD COLUMN phone TEXT`, () => {});
  db.run(`ALTER TABLE clients ADD COLUMN email TEXT`, () => {});
  db.run(`ALTER TABLE clients ADD COLUMN address TEXT`, () => {});
  db.run(`ALTER TABLE clients ADD COLUMN notes TEXT`, () => {});
  db.run(`ALTER TABLE clients ADD COLUMN is_favorite INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE clients ADD COLUMN balance REAL DEFAULT 0`, () => {});
  // جدول الأمانة (ودائع العملاء لدى الكاشير)
  db.run(`CREATE TABLE IF NOT EXISTS trust_deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER,
    client_name TEXT NOT NULL,
    phone TEXT,
    amount REAL NOT NULL,
    date INTEGER NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')*1000)
  )`);
  // إضافة عمود client_id إلى جدول المديونيات إذا لم يكن موجوداً
  db.all("PRAGMA table_info(debts)", (err, columns) => {
    if (!err && columns && !columns.some(col => col.name === 'client_id')) {
      db.run('ALTER TABLE debts ADD COLUMN client_id INTEGER REFERENCES clients(id)');
    }
  });

  // جدول المديونيات
  db.run(`CREATE TABLE IF NOT EXISTS debts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_name TEXT NOT NULL,
    amount REAL NOT NULL,
    date INTEGER NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')*1000)
  )`);
  db.run(`ALTER TABLE debts ADD COLUMN status TEXT DEFAULT 'unpaid'`, () => {});
  db.run(`ALTER TABLE debts ADD COLUMN created_shift_id INTEGER`, () => {});
  db.run(`ALTER TABLE debts ADD COLUMN paid_shift_id INTEGER`, () => {});
  db.run(`ALTER TABLE debts ADD COLUMN paid_at INTEGER`, () => {});

  // ترحيل أسماء العملاء من debts إلى clients وربط client_id
  db.all("SELECT DISTINCT TRIM(client_name) AS client_name FROM debts WHERE client_name IS NOT NULL AND client_name != '' AND (client_id IS NULL OR client_id = '')", (err, rows) => {
    if (!err && rows && rows.length > 0) {
      const names = [...new Set(rows.map(r => r.client_name))];
      if (names.length > 0) {
        const vals = names.map(() => '(?)').join(',');
        db.run(`INSERT OR IGNORE INTO clients (name) VALUES ${vals}`, names, (err2) => {
          if (!err2) {
            db.run(`UPDATE debts SET client_id = (SELECT id FROM clients WHERE clients.name = TRIM(debts.client_name)) WHERE client_id IS NULL AND client_name IS NOT NULL AND client_name != ''`, (err3) => {
              if (err3) console.error('❌ فشل تحديث client_id:', err3);
              else console.log('✅ تم ترحيل أسماء العملاء من debts إلى clients وربط client_id');
            });
          } else {
            console.error('❌ فشل إدراج العملاء:', err2);
          }
        });
      }
    }
  });

  // إعدادات تيليجرام
  db.run(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
  
  // جدول شاتات تيليجرام (دعم متعدد الشاتات)
  db.run(`CREATE TABLE IF NOT EXISTS telegram_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT UNIQUE NOT NULL,
    added_at INTEGER DEFAULT (strftime('%s','now')*1000)
  )`);
  
  // جدول المنتجات المرتبطة بجلسة
  db.run(`CREATE TABLE IF NOT EXISTS session_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER,
    product_id INTEGER,
    quantity INTEGER DEFAULT 1,
    price REAL,
    total REAL,
    FOREIGN KEY(session_id) REFERENCES sessions(id),
    FOREIGN KEY(product_id) REFERENCES products(id)
  )`);
  // جدول مبيعات المنتجات المنفصلة
  db.run(`CREATE TABLE IF NOT EXISTS standalone_sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    quantity INTEGER,
    price REAL,
    total REAL,
    date INTEGER,
    FOREIGN KEY(product_id) REFERENCES products(id)
  )`);
  
  // جدول طلبات العملاء
  db.run(`CREATE TABLE IF NOT EXISTS customer_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    total REAL NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at INTEGER DEFAULT (strftime('%s','now')*1000),
    updated_at INTEGER DEFAULT (strftime('%s','now')*1000)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS customer_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    price REAL NOT NULL,
    note TEXT,
    FOREIGN KEY(order_id) REFERENCES customer_orders(id),
    FOREIGN KEY(product_id) REFERENCES products(id)
  )`);
  
  // جدول رسائل الشات بين العملاء ولوحة التحكم
  db.run(`CREATE TABLE IF NOT EXISTS customer_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    sender TEXT NOT NULL, -- 'customer' or 'admin'
    message TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')*1000),
    read_at INTEGER
  )`);
  // ترقية جدول عناصر الطلب لإضافة note إذا لم يكن موجوداً
  db.all("PRAGMA table_info(customer_order_items)", (err, columns) => {
    if (!err && columns) {
      const hasNote = columns.some(col => col.name === 'note');
      if (!hasNote) {
        db.run('ALTER TABLE customer_order_items ADD COLUMN note TEXT');
      }
    }
  });
  // ترقية جدول الطلبات لإضافة device_id إذا لم يكن موجوداً
  db.all("PRAGMA table_info(customer_orders)", (err, columns) => {
    if (!err && columns) {
      const hasDeviceId = columns.some(col => col.name === 'device_id');
      if (!hasDeviceId) {
        db.run('ALTER TABLE customer_orders ADD COLUMN device_id TEXT');
      }
      // إزالة customer_name إذا كان موجوداً (نحذف البيانات أولاً ثم نحذف العمود)
      const hasCustomerName = columns.some(col => col.name === 'customer_name');
      if (hasCustomerName) {
        // SQLite لا يدعم DROP COLUMN مباشرة، لذا سنستخدم طريقة بديلة
        // سنتجاهل العمود في INSERT statements
      }
    }
  });
  
  // جدول المصروفات
  db.run(`CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    amount REAL NOT NULL,
    category TEXT,
    description TEXT,
    date INTEGER,
    created_by TEXT,
    payment_method TEXT, -- نقدي/بطاقة/تحويل بنكي
    frequency TEXT -- يومي/شهري
  )`);

  // إضافة عمود frequency إذا لم يكن موجوداً
  db.run(`ALTER TABLE expenses ADD COLUMN frequency TEXT`, (err) => {
    // تجاهل الخطأ إذا كان العمود موجود بالفعل
  });
  
  // إضافة عمود shift_id إذا لم يكن موجوداً
  db.run(`ALTER TABLE expenses ADD COLUMN shift_id INTEGER`, (err) => {
    // تجاهل الخطأ إذا كان العمود موجود بالفعل
  });
  // جدول الصيانة
  db.run(`CREATE TABLE IF NOT EXISTS maintenance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    type TEXT, -- صيانة وقائية/صيانة إصلاحية/صيانة طارئة
    status TEXT DEFAULT 'pending', -- pending/in_progress/completed/cancelled
    priority TEXT DEFAULT 'medium', -- low/medium/high/urgent
    reported_date INTEGER,
    scheduled_date INTEGER,
    completed_date INTEGER,
    cost REAL,
    technician TEXT,
    notes TEXT,
    created_by TEXT,
    updated_by TEXT
  )`);
  // جدول الأذرع (Controllers)
  db.run(`CREATE TABLE IF NOT EXISTS controllers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    mac TEXT UNIQUE
  )`);
  // إضافة عمود controller_id إلى جدول الصيانة إذا لم يكن موجوداً
  db.all("PRAGMA table_info(maintenance)", (err, columns) => {
    if (!err && columns && !columns.some(col => col.name === 'controller_id')) {
      db.run('ALTER TABLE maintenance ADD COLUMN controller_id INTEGER');
    }
  });
  // جدول المستخدمين
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL,
    permissions TEXT
  )`);
  
  // إضافة جدول الصلاحيات المفصلة
  db.run(`CREATE TABLE IF NOT EXISTS user_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    page TEXT NOT NULL,
    can_view INTEGER DEFAULT 0,
    can_add INTEGER DEFAULT 0,
    can_edit INTEGER DEFAULT 0,
    can_delete INTEGER DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  
  // إضافة مستخدم admin افتراضي إذا لم يوجد أي مستخدم
  db.get('SELECT COUNT(*) as cnt FROM users', (err, row) => {
    if (!err && row && row.cnt === 0) {
      db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', ['admin', 'admin', 'admin'], function(err) {
        if (!err) {
          const adminId = this.lastID;
          // إضافة جميع الصلاحيات للمدير
          const pages = ['dashboard', 'devices', 'sessions', 'products', 'invoices', 'expenses', 'debts', 'clients', 'bookings', 'maintenance', 'users', 'employees', 'offers', 'backup', 'settings', 'tournaments', 'shifts', 'kids-area', 'hotspot'];
          pages.forEach(page => {
            db.run('INSERT INTO user_permissions (user_id, page, can_view, can_add, can_edit, can_delete) VALUES (?, ?, 1, 1, 1, 1)', [adminId, page]);
          });
        }
      });
    }
  });
  // جدول تعديلات الجلسة (تمديد وقت، تغيير نوع/نمط)
  db.run(`CREATE TABLE IF NOT EXISTS session_modifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER,
    type TEXT, -- extra_time/change_type/change_mode
    value TEXT, -- تفاصيل التعديل (مثلاً: دقائق مضافة)
    price REAL, -- سعر التعديل (يُحسب لاحقاً)
    created_at INTEGER,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  )`);
  // جدول الدورات
  db.run(`CREATE TABLE IF NOT EXISTS tournaments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    data TEXT NOT NULL, -- JSON للشجرة والنتائج
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )`);

  // جدول أهداف الموظفين
  db.run(`CREATE TABLE IF NOT EXISTS employee_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    target_amount REAL NOT NULL DEFAULT 0,
    bonus_amount REAL DEFAULT 0,
    daily_wage REAL DEFAULT 0,
    period TEXT NOT NULL DEFAULT 'daily',
    created_at INTEGER DEFAULT (strftime('%s','now')*1000),
    updated_at INTEGER DEFAULT (strftime('%s','now')*1000),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, period)
  )`);
  // ترقية جدول الأهداف – إضافة الأعمدة الجديدة
  db.all("PRAGMA table_info(employee_targets)", (err, columns) => {
    if (!err && columns) {
      if (!columns.some(col => col.name === 'bonus_amount')) {
        db.run('ALTER TABLE employee_targets ADD COLUMN bonus_amount REAL DEFAULT 0');
      }
      if (!columns.some(col => col.name === 'daily_wage')) {
        db.run('ALTER TABLE employee_targets ADD COLUMN daily_wage REAL DEFAULT 0');
      }
    }
  });

  // جدول صرف اليومية للموظفين
  db.run(`CREATE TABLE IF NOT EXISTS employee_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    payment_date TEXT NOT NULL,
    target_amount REAL DEFAULT 0,
    bonus_amount REAL DEFAULT 0,
    total_amount REAL DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now')*1000),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // جدول العروض
  db.run(`CREATE TABLE IF NOT EXISTS offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL DEFAULT 'hours_bonus',
    condition_value REAL NOT NULL DEFAULT 0,
    reward_value REAL NOT NULL DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (strftime('%s','now')*1000)
  )`);

  // جدول إعدادات المحل
  db.run(`CREATE TABLE IF NOT EXISTS shop_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    shop_name TEXT DEFAULT 'PS Game Center',
    shop_logo TEXT,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  )`);

  // جدول الحجوزات
  db.run(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER,
    client_name TEXT,
    device_id TEXT,
    device_name TEXT,
    date INTEGER,
    start_time TEXT,
    end_time TEXT,
    duration REAL DEFAULT 0,
    price REAL,
    status TEXT DEFAULT 'pending',
    notes TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')*1000),
    FOREIGN KEY(client_id) REFERENCES clients(id)
  )`);

  // جدول لاعبي الدورات
  db.run(`CREATE TABLE IF NOT EXISTS tournament_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER,
    name TEXT NOT NULL,
    FOREIGN KEY(tournament_id) REFERENCES tournaments(id)
  )`);

  // جدول مباريات الدورات
  db.run(`CREATE TABLE IF NOT EXISTS tournament_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER,
    round INTEGER,
    player1_id INTEGER,
    player2_id INTEGER,
    winner_id INTEGER,
    score TEXT,
    match_time INTEGER,
    FOREIGN KEY(tournament_id) REFERENCES tournaments(id),
    FOREIGN KEY(player1_id) REFERENCES tournament_players(id),
    FOREIGN KEY(player2_id) REFERENCES tournament_players(id),
    FOREIGN KEY(winner_id) REFERENCES tournament_players(id)
  )`);

  // جدول الشيفتات
  db.run(`CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_time INTEGER NOT NULL,
    end_time INTEGER,
    user_id INTEGER,
    employee_name TEXT DEFAULT 'مستخدم',
    type TEXT DEFAULT 'normal',
    opening_cash REAL DEFAULT 0,
    closing_cash REAL DEFAULT 0,
    total_sales REAL DEFAULT 0,
    total_expenses REAL DEFAULT 0,
    notes TEXT,
    status TEXT DEFAULT 'active',
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`, (err) => {
    if (err) {
      console.error('خطأ في إنشاء جدول الشيفتات:', err);
    } else {
      console.log('تم إنشاء جدول الشيفتات بنجاح');
      
      // التحقق من وجود جميع الأعمدة المطلوبة وإضافتها إذا لم تكن موجودة
      db.all("PRAGMA table_info(shifts)", (err, columns) => {
        if (err) {
          console.error('خطأ في فحص أعمدة جدول الشيفتات:', err);
          return;
        }
        
        console.log('الأعمدة الموجودة في جدول الشيفتات:', columns.map(c => c.name));
        
        // قائمة الأعمدة المطلوبة
        const requiredColumns = [
          { name: 'user_id', type: 'INTEGER', default: null },
          { name: 'employee_name', type: 'TEXT', default: 'مستخدم' },
          { name: 'type', type: 'TEXT', default: 'normal' },
          { name: 'opening_cash', type: 'REAL', default: 0 },
          { name: 'closing_cash', type: 'REAL', default: 0 },
          { name: 'total_sales', type: 'REAL', default: 0 },
          { name: 'total_expenses', type: 'REAL', default: 0 },
          { name: 'notes', type: 'TEXT', default: null },
          { name: 'status', type: 'TEXT', default: 'active' },
          { name: 'created_at', type: 'INTEGER', default: '(strftime("%s","now"))' }
        ];
        
        let addedColumns = 0;
        const totalColumns = requiredColumns.length;
        
        requiredColumns.forEach(column => {
          const hasColumn = columns.some(col => col.name === column.name);
          if (!hasColumn) {
            console.log(`إضافة عمود ${column.name} إلى جدول الشيفتات...`);
            let alterQuery = `ALTER TABLE shifts ADD COLUMN ${column.name} ${column.type}`;
            if (column.default !== null) {
              alterQuery += ` DEFAULT ${column.default}`;
            }
            
            db.run(alterQuery, (err) => {
              if (err) {
                console.error(`خطأ في إضافة عمود ${column.name}:`, err);
              } else {
                console.log(`تم إضافة عمود ${column.name} بنجاح`);
              }
              addedColumns++;
              if (addedColumns === totalColumns) {
                console.log('تم فحص جميع الأعمدة المطلوبة');
              }
            });
          } else {
            console.log(`عمود ${column.name} موجود بالفعل`);
            addedColumns++;
            if (addedColumns === totalColumns) {
              console.log('تم فحص جميع الأعمدة المطلوبة');
            }
          }
        });
      });
    }
  });

  // إضافة إعدادات افتراضية للمحل
  db.get('SELECT COUNT(*) as cnt FROM shop_settings', (err, row) => {
    if (!err && row && row.cnt === 0) {
      db.run('INSERT INTO shop_settings (shop_name) VALUES (?)', ['PS Game Center']);
    }
  });
  // منتج داخلي لتسجيل مبيعات Kids Area في المبيعات المنفصلة (الشيفتات والتقارير)
  db.get(`SELECT id FROM products WHERE category = '__internal_kids_area__' LIMIT 1`, (err, row) => {
    if (err) return;
    if (!row) {
      db.run(
        `INSERT INTO products (name, price, category, quantity) VALUES ('Kids Area', 0, '__internal_kids_area__', 999999)`,
        (e) => {
          if (e) console.error('تهيئة منتج Kids Area:', e);
          else console.log('تم تهيئة منتج Kids Area الداخلي للتقارير');
        }
      );
    }
  });
  // عند تهيئة قاعدة البيانات أضف عمود trial_days إذا لم يكن موجوداً
  db.get("PRAGMA table_info(trial_info)", (err, row) => {
    db.all("PRAGMA table_info(trial_info)", (err, columns) => {
      const hasTrialDays = columns.some(col => col.name === 'trial_days');
      if (!hasTrialDays) {
        db.run('ALTER TABLE trial_info ADD COLUMN trial_days INTEGER');
      }
    });
  });
  // وضع علامة اكتمال التشغيل الأول بعد إنشاء الجداول
  try {
    if (isFirstRun && !fs.existsSync(FIRST_RUN_MARKER)) {
      fs.writeFileSync(FIRST_RUN_MARKER, String(Date.now()), { encoding: 'utf-8' });
    }
  } catch (e) { /* تجاهل */ }
  
  // تهيئة جدول الشيفتات
  setTimeout(() => {
    initializeShiftsTable();
  }, 1000); // تأخير قصير للتأكد من اكتمال إنشاء الجداول الأخرى
});

// دوال الفترة التجريبية في قاعدة البيانات
function getTrialDbInfo(cb) {
  db.get('SELECT * FROM trial_info WHERE id = 1', (err, row) => {
    cb(err, row);
  });
}
function setTrialDbInfo(start, last_checked, trial_days, cb) {
  // مهم: INSERT OR REPLACE كان بيمسح عمود activation_code — بنستخدم INSERT + UPDATE
  db.run('INSERT OR IGNORE INTO trial_info (id) VALUES (1)', () => {
    db.run('UPDATE trial_info SET start = ?, last_checked = ?, trial_days = ? WHERE id = 1',
      [start, last_checked, trial_days], cb);
  });
}

function setTrialActivationCode(code, cb) {
  // نفس الملاحظة: ما نمسحش start/last_checked/trial_days
  db.run('INSERT OR IGNORE INTO trial_info (id) VALUES (1)', () => {
    db.run('UPDATE trial_info SET activation_code = ? WHERE id = 1', [code], cb);
  });
}
function getTrialActivationCode(cb) {
  db.get('SELECT activation_code FROM trial_info WHERE id = 1', (err, row) => {
    cb(err, row ? row.activation_code : null);
  });
}

// يقرأ ملف التفعيل، ويرجع null لو مش موجود أو ناقص/تالف (بدل ما يعتبره انتهى)
function readActivationFile() {
  try {
    if (!fs.existsSync(ACTIVATION_INFO_FILE)) return null;
    const content = fs.readFileSync(ACTIVATION_INFO_FILE, 'utf-8');
    const lines = content.split(/\r?\n/);
    let start = null, trial_days = null, code = null;
    for (const line of lines) {
      if (line.startsWith('Start Date:')) start = parseInt(line.split(':')[1].trim());
      if (line.startsWith('Trial Days:')) trial_days = parseInt(line.split(':')[1].trim());
      if (line.startsWith('Activation Code:')) code = line.split(':').slice(1).join(':').trim();
    }
    if (!start || !Number.isFinite(start) || !trial_days || trial_days <= 0 || !code) return null;
    return { start, trial_days, code };
  } catch (e) {
    return null;
  }
}

// الحالات: false = شغال | 'need_activation' = محتاج كود | true = منتهي
async function isTrialExpiredDb() {
  const now = await getTrustedNow();

  // 1) ملف التفعيل الخارجي له الأولوية لو كامل
  const act = readActivationFile();
  if (act) {
    if (now < act.start - TAMPER_TOLERANCE_MS) return true;
    const diffDays = Math.floor((now - act.start) / (1000 * 60 * 60 * 24));
    return diffDays >= act.trial_days;
  }

  // 2) قاعدة البيانات
  const row = await new Promise((resolve) => getTrialDbInfo((err, r) => resolve(err ? null : r)));
  const hasActivation = !!(row && row.activation_code && row.start && row.trial_days);

  if (!hasActivation) {
    // أول FREE_DAYS_BEFORE_CODE يوم: يفتح بدون كود، بعدها يطلب التفعيل
    const freeStart = getTrialInfo();
    const freeDiffDays = Math.floor((now - freeStart) / (1000 * 60 * 60 * 24));
    if (freeDiffDays < FREE_DAYS_BEFORE_CODE) return false;
    return 'need_activation';
  }

  // منع التلاعب: الساعة رجعت لورا بفرق كبير
  if (now < row.start - TAMPER_TOLERANCE_MS) return true;
  if (row.last_checked && now < row.last_checked - TAMPER_TOLERANCE_MS) return true;

  const trialDays = row.trial_days;
  const diffDays = Math.floor((now - row.start) / (1000 * 60 * 60 * 24));
  const expired = diffDays >= trialDays;
  await new Promise((resolve) => setTrialDbInfo(row.start, now, trialDays, resolve));
  return expired;
}

// دالة لإضافة جهاز
function addDevice(device, cb) {
  db.run('INSERT INTO devices (id, name, ip, price, price_single, price_double, image, allow_free_open) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [device.id, device.name, device.ip, device.price, device.price_single, device.price_double, device.image || null, device.allow_free_open ? 1 : 0], cb);
}

// دالة لتحديث جهاز
function updateDevice(device, cb) {
  db.run('UPDATE devices SET name = ?, ip = ?, price = ?, price_single = ?, price_double = ?, image = ?, allow_free_open = ? WHERE id = ?',
    [device.name, device.ip, device.price, device.price_single, device.price_double, device.image || null, device.allow_free_open ? 1 : 0, device.id], cb);
}

// دالة لجلب كل الأجهزة
function getDevices(cb) {
  db.all('SELECT * FROM devices', cb);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: require('path').join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  mainWindow.loadFile('index.html');
}

// ===================== دوال القفل/الفتح عبر lockall =====================

// أمر TCP مباشر للبلجن على الـ PS4 (يعمل فقط عندما تكون لعبة GoldHEN شغالة)
function ps4lockTcpCommand(ip, token, command, timeout = PS4LOCK_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: ip, port: PS4LOCK_TCP_PORT, timeout });
    let reply = '';
    let settled = false;
    const finish = (err, res) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) {}
      if (err) reject(err); else resolve(res);
    };
    sock.on('connect', () => {
      const payload = `${token}:${command}\n`;
      if (Buffer.byteLength(payload) > 128) {
        finish(new Error('أمر طويل جداً (حد البلجن 128 بايت)'));
        return;
      }
      sock.write(payload);
    });
    sock.on('data', chunk => {
      reply += chunk.toString('utf8');
      if (reply.includes('\n')) {
        const text = reply.trim();
        if (text === 'ERR') finish(new Error('رفض البلجن الأمر (تحقق من التوكن)'));
        else finish(null, text);
      }
    });
    sock.on('close', () => {
      if (!settled) {
        const text = reply.trim();
        if (text === 'ERR') finish(new Error('رفض البلجن الأمر (تحقق من التوكن)'));
        else finish(null, text || 'OK');
      }
    });
    sock.on('timeout', () => finish(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    sock.on('error', err => finish(err));
  });
}

// عميل FTP سلبي مصغّر (PASV + USER/PASS + STOR/RETR) - بدون مكتبات خارجية
function ps4lockFtp(ip, { stor, retr }, timeout = PS4LOCK_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const control = net.createConnection({ host: ip, port: PS4LOCK_FTP_PORT, timeout });
    control.setEncoding('utf8');
    let buf = '';
    const waiters = [];
    let dataSock = null;
    const dataChunks = [];
    let settled = false;
    let dataClosed = false;
    let reply226 = false;

    const finish = (err, res) => {
      if (settled) return;
      settled = true;
      try { control.destroy(); } catch (_) {}
      try { if (dataSock) dataSock.destroy(); } catch (_) {}
      if (err) reject(err); else resolve(res);
    };
    const maybeDone = () => {
      if (stor !== undefined) return; // STOR selesai via 226 below
      if (dataClosed && reply226) finish(null, Buffer.concat(dataChunks));
    };
    const pump = () => {
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!line) continue;
        const isFinal = line.length >= 4 && line[3] === ' ';
        if (!isFinal) continue;
        const code = parseInt(line.slice(0, 3), 10);
        const w = waiters.shift();
        if (w) w.resolve({ code, line });
      }
    };
    control.on('data', d => { buf += d.toString('utf8'); pump(); });
    control.on('error', err => finish(err));
    control.on('close', () => finish(new Error('اتصال FTP انقطع')));
    const nextReply = () => new Promise((res) => waiters.push({ resolve: res }));

    (async () => {
      let r = await nextReply(); // greeting 220
      if (r.code !== 220) throw new Error('FTP greeting: ' + r.line);
      control.write('USER anonymous\r\n');
      r = await nextReply();
      if (r.code === 331) {
        control.write('PASS anonymous\r\n');
        r = await nextReply();
      }
      if (r.code !== 230) throw new Error('FTP login: ' + r.line);
      control.write('PASV\r\n');
      r = await nextReply();
      if (r.code !== 227) throw new Error('FTP PASV: ' + r.line);
      const m = r.line.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
      if (!m) throw new Error('PASV reply غير صالح');
      const dataIp = `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
      const dataPort = (parseInt(m[5], 10) << 8) + parseInt(m[6], 10);

      await new Promise((res, rej) => {
        dataSock = net.createConnection({ host: dataIp, port: dataPort, timeout });
        dataSock.on('connect', res);
        dataSock.on('error', rej);
        dataSock.on('timeout', () => rej(new Error('timeout data connection')));
      });
      dataSock.on('data', d => dataChunks.push(d));
      dataSock.on('close', () => { dataClosed = true; maybeDone(); });

      if (stor !== undefined) {
        control.write(`STOR ${PS4LOCK_STATE_PATH}\r\n`);
        r = await nextReply();
        if (r.code !== 150 && r.code !== 125) throw new Error('STOR: ' + r.line);
        dataSock.write(stor);
        dataSock.end();
        r = await nextReply(); // 226
        if (r.code !== 226 && r.code !== 250) throw new Error('STOR complete: ' + r.line);
        finish(null, stor);
      } else {
        control.write(`RETR ${PS4LOCK_STATE_PATH}\r\n`);
        r = await nextReply();
        if (r.code !== 150 && r.code !== 125) throw new Error('RETR: ' + r.line);
        nextReply().then(rr => {
          if (rr.code !== 226 && rr.code !== 250) {
            finish(new Error('RETR complete: ' + rr.line));
            return;
          }
          reply226 = true;
          maybeDone();
        });
      }
    })().catch(err => finish(err));
  });
}

// تفسير ردود lockall
function ps4lockParseReply(reply) {
  if (!reply) return null;
  if (/unlocked/i.test(reply)) return false;
  if (/locked/i.test(reply)) return true;
  return null;
}

// الأمر الكامل: TCP أولاً ثم FTP fallback (نفس منطق ps4lock.py)
async function ps4lockRawCommand(ip, token, command, timeout) {
  try {
    const reply = await ps4lockTcpCommand(ip, token, command, timeout);
    return { ok: true, via: 'tcp', reply, locked: ps4lockParseReply(reply) };
  } catch (err) {
    // ERR صريح من البلجن = التوكن غلط، مفيش داعي نجرب FTP
    if (err && /رفض البلجن/.test(err.message || '')) throw err;
  }
  // ---- FTP fallback: الدايم متاح من الشاشة الرئيسية ----
  if (command === 'lock') {
    await ps4lockFtp(ip, { stor: '1\n' }, timeout);
    return { ok: true, via: 'ftp', reply: 'OK locked (via FTP)', locked: true };
  }
  if (command === 'unlock') {
    await ps4lockFtp(ip, { stor: '0\n' }, timeout);
    return { ok: true, via: 'ftp', reply: 'OK unlocked (via FTP)', locked: false };
  }
  // status
  try {
    const data = await ps4lockFtp(ip, { retr: true }, timeout);
    const locked = data.length > 0 && data[0] === 0x31; // '1'
    return { ok: true, via: 'ftp', reply: locked ? 'locked' : 'unlocked', locked };
  } catch (err) {
    // ملف الحالة غير موجود بعد (550) = غير مقفول
    if (err && /550|RETR:/.test(err.message || '')) {
      return { ok: true, via: 'ftp', reply: 'unlocked', locked: false };
    }
    throw err;
  }
}

// جلب التوكن للجهاز: توكن الجهاز إن وجد، وإلا التوكن العام من الإعدادات
function getPs4lockTokenForDevice(device, cb) {
  if (device && device.token) return cb(null, device.token);
  getSetting('ps4lock_token', (err, val) => cb(null, (val && val.trim()) || PS4LOCK_DEFAULT_TOKEN));
}

// تطبيق lock/unlock/status على جهاز بالـ id بتاعه
function applyPs4Lock(deviceId, command, cb) {
  db.get('SELECT id, name, ip, token FROM devices WHERE id = ?', [deviceId], (err, device) => {
    if (err) return cb(err);
    if (!device || !device.ip) return cb(new Error('الجهاز غير موجود أو بدون IP'));
    getPs4lockTokenForDevice(device, (err2, token) => {
      if (err2) return cb(err2);
      ps4lockRawCommand(device.ip, token, command)
        .then(res => cb(null, res))
        .catch(e => cb(e));
    });
  });
}

// نسخة Promise للاستخدام داخل الـ IPC handlers
function ps4lockApplyAsync(deviceId, command) {
  return new Promise(resolve => {
    applyPs4Lock(deviceId, command, (err, res) => {
      if (err) {
        console.error(`[ps4lock] ${command} → ${deviceId} فشل:`, err.message);
        resolve({ ok: false, error: err.message });
      } else {
        resolve({ ok: true, via: res.via, reply: res.reply, locked: res.locked });
      }
    });
  });
}

// تنفيذ الأمر ثم التحقق من تغيّر الحالة فعلياً على الـ PS4 (لمنع مشاكل المزامنة)
// لا يُعتبر الأمر ناجحاً إلا إذا أكد الـ PS4 الحالة المطلوبة (مقفول/مفتوح)
async function ps4lockApplyVerified(deviceId, command) {
  const expected = command === 'lock' ? true : command === 'unlock' ? false : null;
  const res = await ps4lockApplyAsync(deviceId, command);
  if (!res.ok) return { ok: false, error: res.error || 'الـ PS4 لم يستجب' };
  if (expected === null) return { ok: true, ...res };
  const attempts = 3;
  let lastState = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 400));
    const st = await ps4lockApplyAsync(deviceId, 'status');
    if (st.ok) {
      lastState = st.locked;
      if (st.locked === expected) {
        return { ok: true, via: res.via, reply: res.reply, locked: expected };
      }
    }
  }
  const stateLabel = lastState === true ? 'مقفول' : lastState === false ? 'مفتوح' : 'غير معروف';
  return {
    ok: false,
    via: res.via,
    reply: res.reply,
    error: `تم إرسال الأمر لكن تأكدنا من الحالة فوجدناها "${stateLabel}" بدلاً من "${expected ? 'مقفول' : 'مفتوح'}"`
  };
}


app.whenReady().then(async () => {

  // --- حماية من التلاعب في التاريخ ---
  initTelegramBot();

  // إنشاء خادم HTTP لصفحة العميل - يجب أن يبدأ دائماً قبل أي شيء
  startCustomerServer();
  
  // إنشاء WebSocket server للمكالمات الصوتية
  startVoiceWebSocketServer();
  
  const now = Date.now();
  if (isDateTampered(now)) {
    // بنحاول نصحح السجل من وقت الإنترنت بدل حجب البرنامج نهائياً
    const onlineNow = await getOnlineDate();
    if (onlineNow && onlineNow >= now - TAMPER_TOLERANCE_MS) {
      healTrialRuns(onlineNow);
      logTrialRun(onlineNow);
    } else {
      dialog.showErrorBox('خطأ في التاريخ', 'تم اكتشاف تلاعب في تاريخ الجهاز. يرجى تصحيح التاريخ وإعادة تشغيل البرنامج.');
      app.exit(0);
      return;
    }
  } else {
    logTrialRun(now);
  }
  // --- نهاية الحماية ---

  let win = null;
  try {
    win = new BrowserWindow({
      show: true,
      width: 1200,
      height: 800,
      webPreferences: {
        preload: require('path').join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true
      }
    });
    
    // طلب الإذن للميكروفون عند الحاجة
    win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission === 'media') {
        callback(true); // السماح بالوصول للميكروفون تلقائياً
      } else {
        callback(false);
      }
    });
    win.loadFile('index.html');
    await win.webContents.executeJavaScript('window.showTrialWaitModal && window.showTrialWaitModal();');
  } catch (e) { }
  const trialStatus = await isTrialExpiredDb();
  if (trialStatus === 'need_activation') {
    // لا يوجد تفعيل ساري (فترة اليومين المجانية انتهت أو مفيش كود) → نافذة التفعيل
    if (win) {
      await win.webContents.executeJavaScript('window.hideTrialWaitModal && window.hideTrialWaitModal();');
      await win.webContents.executeJavaScript(
        `window.showTrialActivationModal && window.showTrialActivationModal('انتهت الفترة المجانية. يرجى إدخال كود التفعيل للاستمرار.');`
      );
    }
    return;
  }
  if (trialStatus === true) {
    // الفترة انتهت → نعرض نافذة التفعيل (مش بنقفل البرنامج) عشان يقدر يجدّد بكود جديد
    if (win) {
      await win.webContents.executeJavaScript('window.hideTrialWaitModal && window.hideTrialWaitModal();');
      await win.webContents.executeJavaScript(
        `window.showTrialActivationModal && window.showTrialActivationModal('انتهت فترة التفعيل الحالية. يرجى إدخال كود تفعيل جديد للاستمرار.');`
      );
    } else {
      dialog.showErrorBox('انتهت الفترة التجريبية', 'انتهت الفترة التجريبية. يرجى التواصل مع الدعم.');
      app.exit(0);
    }
    return;
  }
  if (win) {
    await win.webContents.executeJavaScript('window.hideTrialWaitModal && window.hideTrialWaitModal();');
    win.close();
  }
  
  createWindow();
  // start telegram bot listener for /start to capture chat_id

});

// خادم HTTP لصفحة طلب العملاء
function startCustomerServer() {
  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // خدمة صفحة HTML
    if (pathname === '/' || pathname === '/customer-order.html') {
      try {
        const htmlPath = path.join(__dirname, 'customer-order.html');
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        res.writeHead(500);
        res.end('خطأ في تحميل الصفحة');
      }
      return;
    }

    // خدمة الصور
    if (pathname.startsWith('/products/')) {
      try {
        const fileName = pathname.replace('/products/', '');
        const imagePath = path.join(__dirname, 'products', fileName);
        if (fs.existsSync(imagePath)) {
          const image = fs.readFileSync(imagePath);
          const ext = path.extname(pathname).toLowerCase();
          const contentType = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : 'image/*';
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(image);
        } else {
          // إرجاع صورة افتراضية إذا لم توجد الصورة
          const defaultImagePath = path.join(__dirname, 'default-device.png');
          if (fs.existsSync(defaultImagePath)) {
            const image = fs.readFileSync(defaultImagePath);
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(image);
          } else {
            res.writeHead(404);
            res.end('الصورة غير موجودة');
          }
        }
      } catch (err) {
        console.error('Error serving product image:', err);
        res.writeHead(500);
        res.end('خطأ في تحميل الصورة');
      }
      return;
    }
    
    // خدمة الصورة الافتراضية
    if (pathname === '/default-device.png') {
      try {
        const defaultImagePath = path.join(__dirname, 'default-device.png');
        if (fs.existsSync(defaultImagePath)) {
          const image = fs.readFileSync(defaultImagePath);
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(image);
        } else {
          res.writeHead(404);
          res.end('الصورة الافتراضية غير موجودة');
        }
      } catch (err) {
        res.writeHead(500);
        res.end('خطأ في تحميل الصورة الافتراضية');
      }
      return;
    }

    // API: جلب المنتجات
    if (pathname === '/api/products' && req.method === 'GET') {
      getProducts((err, products) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'خطأ في جلب المنتجات' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(products));
      });
      return;
    }

    // API: التحقق من حالة الجهاز (هل لديه جلسة نشطة)
    if (pathname === '/api/device-status' && req.method === 'GET') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const deviceId = url.searchParams.get('device_id');
      
      if (!deviceId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'معرف الجهاز مطلوب', active: false }));
        return;
      }
      
      getActiveSession(deviceId, (err, session) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'خطأ في التحقق من حالة الجهاز', active: false }));
          return;
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active: !!session, session: session || null }));
      });
      return;
    }
    
    // API: إرسال رسالة من العميل
    if (pathname === '/api/messages' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data.device_id || !data.message) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'معرف الجهاز والرسالة مطلوبان' }));
            return;
          }
          
          addCustomerMessage(data.device_id, 'customer', data.message, (err, messageId) => {
            if (err) {
              console.error('Error adding message:', err);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'خطأ في إرسال الرسالة' }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, messageId }));
          });
        } catch (err) {
          console.error('Error parsing message JSON:', err);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'بيانات غير صحيحة' }));
        }
      });
      return;
    }
    
    // API: جلب الرسائل لجهاز معين
    if (pathname === '/api/messages' && req.method === 'GET') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const deviceId = url.searchParams.get('device_id');
      
      if (!deviceId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'معرف الجهاز مطلوب' }));
        return;
      }
      
      getCustomerMessages(deviceId, (err, messages) => {
        if (err) {
          console.error('Error fetching messages:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'خطأ في جلب الرسائل' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(messages || []));
      });
      return;
    }

    // API: إرسال طلب
    if (pathname === '/api/orders' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          const order = JSON.parse(body);
          console.log('Received order:', JSON.stringify(order, null, 2));
          
          // التحقق من صحة البيانات
          if (!order.items || !Array.isArray(order.items) || order.items.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'الطلب يجب أن يحتوي على منتجات' }));
            return;
          }
          
          if (!order.total || isNaN(order.total) || order.total <= 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'المجموع غير صحيح' }));
            return;
          }
          
          addCustomerOrder(order, (err, orderId) => {
            if (err) {
              console.error('Error adding customer order:', err);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'خطأ في إرسال الطلب: ' + err.message }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, orderId }));
          });
        } catch (err) {
          console.error('Error parsing order:', err);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'بيانات غير صحيحة: ' + err.message }));
        }
      });
      return;
    }

    // 404
    res.writeHead(404);
    res.end('الصفحة غير موجودة');
  });

  server.listen(CUSTOMER_PORT, '0.0.0.0', () => {
    console.log(`خادم طلبات العملاء يعمل على المنفذ ${CUSTOMER_PORT} (جميع واجهات الشبكة)`);
  });
}

// دالة إضافة طلب عميل
function addCustomerOrder(order, cb) {
  const { device_id, items, total } = order;
  
  // التحقق من صحة البيانات
  if (!items || !Array.isArray(items) || items.length === 0) {
    return cb(new Error('الطلب يجب أن يحتوي على منتجات'));
  }
  
  if (!total || isNaN(total) || total <= 0) {
    return cb(new Error('المجموع غير صحيح'));
  }
  
  // التحقق من وجود device_id
  if (!device_id) {
    return cb(new Error('معرف الجهاز مطلوب'));
  }
  
  // التحقق من وجود جلسة نشطة للجهاز
  getActiveSession(device_id, (err, session) => {
    if (err) {
      console.error('Error checking active session:', err);
      return cb(new Error('خطأ في التحقق من حالة الجهاز'));
    }
    
    if (!session) {
      return cb(new Error('الجهاز غير نشط حالياً. يرجى تفعيل الجلسة أولاً'));
    }
    
    // إذا كانت هناك جلسة نشطة، قم بإضافة الطلب
    db.run(
    'INSERT INTO customer_orders (device_id, total, status) VALUES (?, ?, ?)',
    [device_id, total, 'pending'],
    function(err) {
      if (err) {
        console.error('Error inserting customer order:', err);
        return cb(err);
      }
      const orderId = this.lastID;
      
      // إضافة عناصر الطلب
      const stmt = db.prepare('INSERT INTO customer_order_items (order_id, product_id, product_name, quantity, price, note) VALUES (?, ?, ?, ?, ?, ?)');
      let completed = 0;
      let hasError = false;
      let errorMessage = null;
      
      if (items.length === 0) {
        stmt.finalize();
        return cb(null, orderId);
      }
      
      items.forEach((item, index) => {
        // التحقق من صحة بيانات العنصر
        if (!item.product_id || !item.product_name || !item.quantity || !item.price) {
          if (!hasError) {
            hasError = true;
            errorMessage = new Error(`بيانات المنتج ${index + 1} غير صحيحة`);
            stmt.finalize();
            return cb(errorMessage);
          }
          return;
        }
        
        stmt.run([orderId, item.product_id, item.product_name, item.quantity, item.price, item.note || null], (err) => {
          if (err && !hasError) {
            hasError = true;
            errorMessage = err;
            stmt.finalize();
            console.error('Error inserting order item:', err);
            return cb(err);
          }
          if (hasError) return; // تجاهل باقي العناصر في حالة الخطأ
          
          completed++;
          if (completed === items.length) {
            stmt.finalize();
            cb(null, orderId);
          }
        });
      });
    }
    );
  });
}

// دالة جلب جميع طلبات العملاء
function getCustomerOrders(cb) {
  db.all(`
    SELECT co.*, 
           d.name as device_name
    FROM customer_orders co
    LEFT JOIN devices d ON co.device_id = d.id
    ORDER BY co.created_at DESC
  `, (err, orders) => {
    if (err) return cb(err);
    
    // جلب عناصر كل طلب
    let completed = 0;
    const ordersWithItems = [];
    
    if (orders.length === 0) {
      return cb(null, []);
    }
    
    orders.forEach((order, index) => {
      db.all(
        'SELECT * FROM customer_order_items WHERE order_id = ?',
        [order.id],
        (err, items) => {
          if (err) return cb(err);
          ordersWithItems[index] = { ...order, items };
          completed++;
          if (completed === orders.length) {
            cb(null, ordersWithItems);
          }
        }
      );
    });
  });
}

// دالة تحديث حالة الطلب
function updateCustomerOrderStatus(orderId, status, cb) {
  // إذا تم إكمال الطلب، أضف المنتجات إلى الجلسة النشطة
  if (status === 'completed') {
    // جلب بيانات الطلب
    db.get('SELECT * FROM customer_orders WHERE id = ?', [orderId], (err, order) => {
      if (err) {
        console.error('Error fetching order:', err);
        return cb(err);
      }
      
      if (!order) {
        return cb(new Error('الطلب غير موجود'));
      }
      
      // جلب الجلسة النشطة للجهاز
      getActiveSession(order.device_id, (err, session) => {
        if (err) {
          console.error('Error getting active session:', err);
          return cb(err);
        }
        
        if (!session) {
          console.warn('No active session found for device:', order.device_id);
          // تحديث حالة الطلب فقط بدون إضافة المنتجات
          db.run(
            'UPDATE customer_orders SET status = ?, updated_at = ? WHERE id = ?',
            [status, Date.now(), orderId],
            cb
          );
          return;
        }
        
        // جلب عناصر الطلب
        db.all('SELECT * FROM customer_order_items WHERE order_id = ?', [orderId], (err, items) => {
          if (err) {
            console.error('Error fetching order items:', err);
            return cb(err);
          }
          
          // إضافة كل منتج إلى الجلسة
          let completed = 0;
          let hasError = false;
          
          if (items.length === 0) {
            // لا توجد منتجات، فقط حدث حالة الطلب
            db.run(
              'UPDATE customer_orders SET status = ?, updated_at = ? WHERE id = ?',
              [status, Date.now(), orderId],
              cb
            );
            return;
          }
          
          items.forEach((item) => {
            if (hasError) return;
            
            addProductToSession({
              session_id: session.id,
              product_id: item.product_id,
              quantity: item.quantity,
              price: item.price
            }, (err) => {
              if (err && !hasError) {
                hasError = true;
                console.error('Error adding product to session:', err);
                return cb(err);
              }
              
              completed++;
              if (completed === items.length && !hasError) {
                // تحديث حالة الطلب بعد إضافة جميع المنتجات
                db.run(
                  'UPDATE customer_orders SET status = ?, updated_at = ? WHERE id = ?',
                  [status, Date.now(), orderId],
                  cb
                );
              }
            });
          });
        });
      });
    });
  } else {
    // إذا لم يكن إكمال الطلب، فقط حدث الحالة
    db.run(
      'UPDATE customer_orders SET status = ?, updated_at = ? WHERE id = ?',
      [status, Date.now(), orderId],
      cb
    );
  }
}

// دوال رسائل الشات
function addCustomerMessage(device_id, sender, message, cb) {
  db.run(
    'INSERT INTO customer_messages (device_id, sender, message) VALUES (?, ?, ?)',
    [device_id, sender, message],
    function(err) {
      if (err) return cb(err);
      cb(null, this.lastID);
    }
  );
}

function getCustomerMessages(device_id, cb) {
  db.all(
    'SELECT * FROM customer_messages WHERE device_id = ? ORDER BY created_at ASC',
    [device_id],
    cb
  );
}

function getAllCustomerMessages(cb) {
  db.all(
    `SELECT cm.*, d.name as device_name 
     FROM customer_messages cm 
     LEFT JOIN devices d ON cm.device_id = d.id 
     ORDER BY cm.created_at DESC`,
    cb
  );
}

// الحصول على آخر جهاز أرسل رسالة
function getLastMessageDevice(cb) {
  db.get(
    `SELECT DISTINCT cm.device_id, d.name as device_name, MAX(cm.created_at) as last_message_time
     FROM customer_messages cm
     LEFT JOIN devices d ON cm.device_id = d.id
     WHERE cm.sender = 'customer'
     GROUP BY cm.device_id
     ORDER BY last_message_time DESC
     LIMIT 1`,
    cb
  );
}

function markMessagesAsRead(device_id, cb) {
  db.run(
    'UPDATE customer_messages SET read_at = ? WHERE device_id = ? AND sender = ? AND read_at IS NULL',
    [Date.now(), device_id, 'customer'],
    cb
  );
}

// حذف رسائل جهاز معين
function deleteCustomerMessages(device_id, cb) {
  db.run(
    'DELETE FROM customer_messages WHERE device_id = ?',
    [device_id],
    cb
  );
}

// الحصول على جميع IP addresses المحلية
function getAllLocalIPAddresses() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({
          address: iface.address,
          interface: name
        });
      }
    }
  }
  if (ips.length === 0) {
    ips.push({ address: 'localhost', interface: 'localhost' });
  }
  return ips;
}

// الحصول على IP address المحلي (للتوافق مع الكود القديم)
function getLocalIPAddress() {
  const ips = getAllLocalIPAddresses();
  return ips.length > 0 ? ips[0].address : 'localhost';
}

// استقبال أوامر من الواجهة
ipcMain.handle('add-device', async (event, device) => {
  return new Promise((resolve, reject) => {
    addDevice(device, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('update-device', async (event, device) => {
  return new Promise((resolve, reject) => {
    updateDevice(device, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('get-devices', async () => {
  return new Promise((resolve, reject) => {
    getDevices((err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});

// دالة لبدء جلسة مجانية
function startFreeSession({ device_id }, cb) {
  // التحقق من صحة رقم الجهاز أولاً
  validateDeviceId(device_id, (err, device) => {
    if (err) {
      logInvalidDeviceAttempt(device_id, 'invalid_device_free_start', {
        device_id,
        error: err.message
      });
      return cb(err);
    }
    
    // منع بدء جلسة إذا كانت هناك جلسة نشطة لنفس الجهاز
    db.get('SELECT id FROM sessions WHERE device_id = ? AND is_active = 1', [device_id], (err, active) => {
      if (err) return cb(err);
      if (active) return cb(new Error('يوجد جلسة مفتوحة لهذا الجهاز'));

      // منع بدء جلسة مجانية إذا لم يكن هناك شيفت نشط
      db.get('SELECT id FROM shifts WHERE status = ?', ['active'], (err2, activeShift) => {
        if (err2) return cb(err2);
        if (!activeShift) return cb(new Error('لا يمكن بدء جلسة بدون شيفت نشط. يرجى فتح شيفت أولاً'));

        const start_time = Date.now();
        const duration = 60; // دقيقة واحدة = 60 ثانية
        const end_time = start_time + (duration * 1000);
        
        // التحقق من صحة الوقت للجلسة المجانية
        const timeValidation = validateTimeIntegrity(start_time, end_time, duration, 'timed');
        if (!timeValidation.valid) {
          logTimeManipulationAttempt(device_id, 'invalid_free_session_start', {
            start_time,
            end_time,
            duration,
            error: timeValidation.error
          });
          return cb(new Error(timeValidation.error));
        }

        db.run(
          'INSERT INTO sessions (device_id, start_time, type, duration, is_active, mode, scheduled_end_time, total) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
          [device_id, start_time, 'timed', duration, 'single', end_time, 0],
          cb
        );
      });
    });
  });
}

function startFreeOpenSession({ device_id }, cb) {
  validateDeviceId(device_id, (err, device) => {
    if (err) {
      logInvalidDeviceAttempt(device_id, 'invalid_device_free_open_start', { device_id, error: err.message });
      return cb(err);
    }
    db.get('SELECT id FROM sessions WHERE device_id = ? AND is_active = 1', [device_id], (err, active) => {
      if (err) return cb(err);
      if (active) return cb(new Error('يوجد جلسة مفتوحة لهذا الجهاز'));
      db.get('SELECT id FROM shifts WHERE status = ?', ['active'], (err2, activeShift) => {
        if (err2) return cb(err2);
        if (!activeShift) return cb(new Error('لا يمكن بدء جلسة بدون شيفت نشط. يرجى فتح شيفت أولاً'));
        const start_time = Date.now();
        db.run(
          'INSERT INTO sessions (device_id, start_time, type, duration, is_active, mode, total) VALUES (?, ?, ?, ?, 1, ?, ?)',
          [device_id, start_time, 'open', null, 'single', 0],
          cb
        );
      });
    });
  });
}

ipcMain.handle('start-free-session', async (event, data) => {
  const lock = await ps4lockApplyVerified(data.device_id, 'unlock');
  if (!lock.ok) {
    return { success: false, error: 'تعذر فتح القفل على الـ PS4 ومفيش جلسة اتفتحت: ' + (lock.error || 'الجهاز لم يستجب') };
  }
  return new Promise((resolve, reject) => {
    startFreeSession(data, async err => {
      if (err) {
        await ps4lockApplyAsync(data.device_id, 'lock');
        resolve({ success: false, error: err.message });
      } else resolve({ success: true, lock });
    });
  });
});
ipcMain.handle('start-free-open-session', async (event, data) => {
  const lock = await ps4lockApplyVerified(data.device_id, 'unlock');
  if (!lock.ok) {
    return { success: false, error: 'تعذر فتح القفل على الـ PS4 ومفيش جلسة اتفتحت: ' + (lock.error || 'الجهاز لم يستجب') };
  }
  return new Promise((resolve, reject) => {
    startFreeOpenSession(data, async err => {
      if (err) {
        await ps4lockApplyAsync(data.device_id, 'lock');
        resolve({ success: false, error: err.message });
      } else resolve({ success: true, lock });
    });
  });
});

// إضافة جلسة جديدة
function startSession({ device_id, type, duration, mode, end_time, client_id, booking_id, booked_duration }, cb) {
  // التحقق من صحة رقم الجهاز أولاً
  validateDeviceId(device_id, (err, device) => {
    if (err) {
      logInvalidDeviceAttempt(device_id, 'invalid_device_start', {
        device_id,
        type,
        duration,
        mode,
        error: err.message
      });
      return cb(err);
    }
    
    // منع بدء جلسة إذا كانت هناك جلسة نشطة لنفس الجهاز
    db.get('SELECT id FROM sessions WHERE device_id = ? AND is_active = 1', [device_id], (err, active) => {
      if (err) return cb(err);
      if (active) return cb(new Error('يوجد جلسة مفتوحة لهذا الجهاز'));

      // منع بدء جلسة إذا لم يكن هناك شيفت نشط
      db.get('SELECT id FROM shifts WHERE status = ?', ['active'], (err2, activeShift) => {
        if (err2) return cb(err2);
        if (!activeShift) return cb(new Error('لا يمكن بدء جلسة بدون شيفت نشط. يرجى فتح شيفت أولاً'));

        const start_time = Date.now();
            
        // التحقق من صحة الوقت
        const timeValidation = validateTimeIntegrity(start_time, end_time, duration, type);
        if (!timeValidation.valid) {
          logTimeManipulationAttempt(device_id, 'invalid_session_start', {
            start_time,
            end_time,
            duration,
            type,
            error: timeValidation.error
          });
          return cb(new Error(timeValidation.error));
        }
        
        // التحقق من صحة وقت النهاية إذا كان محدد
        if (end_time) {
          const timeToEnd = end_time - start_time;
          const maxSessionTime = 24 * 60 * 60 * 1000; // 24 ساعة
          if (timeToEnd > maxSessionTime) {
            logTimeManipulationAttempt(device_id, 'excessive_session_duration', {
              start_time,
              end_time,
              duration: timeToEnd,
              type
            });
            return cb(new Error('مدة الجلسة طويلة جداً - الحد الأقصى 24 ساعة'));
          }
        }

        db.run(
          'INSERT INTO sessions (device_id, start_time, type, duration, is_active, mode, scheduled_end_time, client_id, booking_id, booked_duration) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)',
          [device_id, start_time, type, duration || null, mode, end_time || null, client_id || null, booking_id || null, booked_duration || null],
          cb
        );
      });
    });
  });
}
// إنهاء جلسة نشطة لجهاز
function endSession(device_id, cb) {
  // التحقق من صحة رقم الجهاز أولاً
  validateDeviceId(device_id, (err, device) => {
    if (err) {
      logInvalidDeviceAttempt(device_id, 'invalid_device_end', {
        device_id,
        error: err.message
      });
      return cb(err);
    }
    
  const end_time = Date.now();
    
  // جلب الجلسة النشطة
  db.get('SELECT * FROM sessions WHERE device_id = ? AND is_active = 1', [device_id], (err, session) => {
    if (err || !session) return cb(err || new Error('لا توجد جلسة نشطة'));
      
      // التحقق من أن الجلسة تنتمي للجهاز الصحيح
      if (session.device_id !== device_id) {
        logInvalidDeviceAttempt(device_id, 'device_session_mismatch', {
          requested_device: device_id,
          session_device: session.device_id,
          session_id: session.id
        });
        return cb(new Error('الجلسة لا تنتمي لهذا الجهاز'));
      }
      
      // التحقق من صحة وقت إنهاء الجلسة
      const timeValidation = validateTimeIntegrity(session.start_time, end_time, session.duration, session.type);
      if (!timeValidation.valid) {
        logTimeManipulationAttempt(device_id, 'invalid_session_end', {
          start_time: session.start_time,
          end_time,
          duration: session.duration,
          type: session.type,
          error: timeValidation.error
        });
        return cb(new Error(timeValidation.error));
      }
      
      // التحقق من أن وقت النهاية منطقي مقارنة بوقت البداية
      const sessionDuration = end_time - session.start_time;
      const maxReasonableDuration = 25 * 60 * 60 * 1000; // 25 ساعة (أكثر من الحد الأقصى المسموح)
      
      if (sessionDuration > maxReasonableDuration) {
        logTimeManipulationAttempt(device_id, 'excessive_session_duration_at_end', {
          start_time: session.start_time,
          end_time,
          duration: sessionDuration,
          type: session.type
        });
        return cb(new Error('مدة الجلسة طويلة جداً - قد يكون هناك تلاعب في الوقت'));
      }
      
      // التحقق من أن وقت النهاية ليس في الماضي البعيد
      const minEndTime = session.start_time;
      if (end_time < minEndTime) {
        logTimeManipulationAttempt(device_id, 'end_time_before_start', {
          start_time: session.start_time,
          end_time,
          type: session.type
        });
        return cb(new Error('وقت إنهاء الجلسة قبل وقت البداية - تلاعب واضح'));
      }
      
    // جلب التمديدات
    getSessionModifications(session.id, (err2, mods) => {
      if (err2) return cb(err2);
      const extraMods = mods.filter(m => m.type === 'extra_time');
      let totalDuration = session.duration || 0;
      for (const m of extraMods) {
        totalDuration += parseInt(m.value);
      }
      // الوقت الفعلي
      let actualDuration = Math.floor((end_time - session.start_time) / 1000); // بالثواني
      let usedDuration = 0;
      if (session.booked_duration && session.type === 'timed') {
        // الجلسة من حجز (وقت محدد): الفاتورة حسب مدة الحجز الأصلية بغض النظر عن الوقت الفعلي
        usedDuration = session.booked_duration;
      } else if (session.type === 'timed') {
        // إذا كان هناك وقت انتهاء محدد مسبقاً، استخدمه لحساب المدة
        if (session.scheduled_end_time) {
          const scheduledEnd = session.scheduled_end_time;
          const actualEnd = Math.min(end_time, scheduledEnd);
          usedDuration = Math.floor((actualEnd - session.start_time) / 1000);
        } else {
          // نستخدم الأقل بين الوقت الفعلي والوقت الكلي
          usedDuration = Math.min(actualDuration, totalDuration);
        }
      } else {
        // وقت مفتوح: استخدم الوقت الفعلي فقط
        usedDuration = actualDuration;
      }
      // جلب سعر الجهاز حسب نوع الجلسة
      db.get('SELECT price_single, price_double, price FROM devices WHERE id = ?', [device_id], (err3, device) => {
        if (err3 || !device) return cb(err3 || new Error('الجهاز غير موجود'));
        
        // للجلسات المجانية (total = 0) استخدم القيمة المحفوظة في قاعدة البيانات
        let total = 0;
        if (session.total !== 0) {
          // للجلسات المدفوعة، احسب السعر حسب فترات تغيير النمط
          const priceSingle = Number(device.price_single);
          const priceDouble = Number(device.price_double);
          const priceFallback = Number(device.price);
          const getPricePerHourByMode = (mode) => {
            if (mode === 'double') {
              if (priceDouble > 0) return priceDouble;
              if (priceFallback > 0) return priceFallback;
              return 0;
            }
            if (priceSingle > 0) return priceSingle;
            if (priceFallback > 0) return priceFallback;
            return 0;
          };

          // حدود الجلسة الفعلية المحاسَب عنها
          const startMs = session.start_time;
          const endMs = startMs + (usedDuration * 1000);

          // فترات النمط من تعديلات change_mode (نفس منطق الواجهة)
          const modeMods = mods
            .filter(m => m.type === 'change_mode')
            .sort((a, b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0));
          const segments = [];
          let currentStart = startMs;
          let currentMode = (session.mode || 'single');
          if (modeMods.length > 0) {
            const firstParts = String(modeMods[0].value || '').split('->');
            const fromVal = (firstParts[0] || '').trim().toLowerCase();
            if (fromVal === 'single' || fromVal === 'double') currentMode = fromVal;
          }
          for (const m of modeMods) {
            const changeAt = Number(m.created_at || 0);
            if (changeAt && changeAt > currentStart && changeAt < endMs) {
              segments.push({ from: currentStart, to: changeAt, mode: currentMode });
              const parts = String(m.value || '').split('->');
              const toVal = (parts[1] || '').trim().toLowerCase();
              if (toVal === 'single' || toVal === 'double') currentMode = toVal;
              currentStart = changeAt;
            }
          }
          if (endMs > currentStart) segments.push({ from: currentStart, to: endMs, mode: currentMode });
          if (segments.length === 0) segments.push({ from: startMs, to: endMs, mode: currentMode });

          let billedMinutes = 0;
          for (const seg of segments) {
            const segSec = Math.max(0, Math.floor((seg.to - seg.from) / 1000));
            const pricePerHour = getPricePerHourByMode(seg.mode);
            const pricePerMinute = pricePerHour / 60;
            const minutes = Math.ceil(segSec / 60); // تقريب لأعلى دقيقة لكل فترة
            billedMinutes += minutes;
            total += minutes * pricePerMinute;
          }
        }

        // تقريب الإجمالي لأقرب رقم يقبل القسمة على 5 للاحتساب في التقارير
        const totalRounded = total === 0 ? 0 : Math.round(total / 5) * 5;

        db.run('UPDATE sessions SET end_time = ?, is_active = 0, total = ? WHERE id = ?', [end_time, totalRounded, session.id], function (updateErr) {
          if (updateErr) return cb(updateErr);
          
          // حذف رسائل المحادثة تلقائياً عند إنهاء الجلسة
          deleteCustomerMessages(device_id, (err2) => {
            if (err2) {
              console.error('Error deleting customer messages after session end:', err2);
              // لا نوقف العملية إذا فشل حذف الرسائل
            }
          });
          
          cb(null, { duration: usedDuration, total: totalRounded, minutes: Math.ceil(usedDuration / 60), pricePerMinute: totalRounded > 0 ? (totalRounded / Math.ceil(usedDuration / 60)) : 0 });
        });
        });
      });
    });
  });
}
// دالة حذف جلسة
function deleteSession(sessionId, cb) {
  // حذف الجلسة وجميع البيانات المرتبطة بها
  db.serialize(() => {
    // حذف المنتجات المرتبطة بالجلسة
    db.run('DELETE FROM session_products WHERE session_id = ?', [sessionId], (err) => {
      if (err) return cb(err);
      
      // حذف تعديلات الجلسة
      db.run('DELETE FROM session_modifications WHERE session_id = ?', [sessionId], (err) => {
        if (err) return cb(err);
        
        // حذف الجلسة نفسها
        db.run('DELETE FROM sessions WHERE id = ?', [sessionId], (err) => {
          if (err) return cb(err);
          cb(null);
        });
      });
    });
  });
}

ipcMain.handle('delete-session', async (event, sessionId) => {
  return new Promise((resolve) => {
    deleteSession(sessionId, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

// دالة تعديل جلسة
function updateSession(sessionId, updates, cb) {
  // التحقق من صحة التحديثات أولاً
  validateSessionUpdate(sessionId, updates, (err, isValid) => {
    if (err) return cb(err);
    if (!isValid) return cb(new Error('تحديث غير صحيح'));
    
  const fields = [];
  const values = [];
  
  if (updates.device_id !== undefined) {
    fields.push('device_id = ?');
    values.push(updates.device_id);
  }
  if (updates.start_time !== undefined) {
    fields.push('start_time = ?');
    values.push(updates.start_time);
  }
  if (updates.end_time !== undefined) {
    fields.push('end_time = ?');
    values.push(updates.end_time);
  }
  if (updates.type !== undefined) {
    fields.push('type = ?');
    values.push(updates.type);
  }
  if (updates.duration !== undefined) {
    fields.push('duration = ?');
    values.push(updates.duration);
  }
  if (updates.total !== undefined) {
    fields.push('total = ?');
    values.push(updates.total);
  }
  if (updates.mode !== undefined) {
    fields.push('mode = ?');
    values.push(updates.mode);
  }
  if (updates.scheduled_end_time !== undefined) {
    fields.push('scheduled_end_time = ?');
    values.push(updates.scheduled_end_time);
  }
  if (updates.discount_amount !== undefined) {
    fields.push('discount_amount = ?');
    values.push(updates.discount_amount);
  }
  if (updates.discount_reason !== undefined) {
    fields.push('discount_reason = ?');
    values.push(updates.discount_reason);
  }
  if (updates.client_id !== undefined) {
    fields.push('client_id = ?');
    values.push(updates.client_id);
  }
  if (updates.paid_amount !== undefined) {
    fields.push('paid_amount = ?');
    values.push(updates.paid_amount);
  }
  if (updates.booking_id !== undefined) {
    fields.push('booking_id = ?');
    values.push(updates.booking_id);
  }
  
  if (fields.length === 0) return cb(new Error('لا توجد حقول للتحديث'));
  
  values.push(sessionId);
  const query = `UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`;
  
  db.run(query, values, cb);
  });
}

ipcMain.handle('update-session', async (event, { sessionId, updates }) => {
  return new Promise((resolve) => {
    updateSession(sessionId, updates, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

// جلب الجلسة النشطة لجهاز
function getActiveSession(device_id, cb) {
  // التحقق من صحة رقم الجهاز أولاً
  validateDeviceId(device_id, (err, device) => {
    if (err) {
      logInvalidDeviceAttempt(device_id, 'invalid_device_get_active', {
        device_id,
        error: err.message
      });
      return cb(err);
    }
    
  db.get('SELECT s.*, c.name as client_name FROM sessions s LEFT JOIN clients c ON s.client_id = c.id WHERE s.device_id = ? AND s.is_active = 1', [device_id], cb);
  });
}

// إنشاء WebSocket Server للمكالمات الصوتية
function startVoiceWebSocketServer() {
  voiceWSServer = new WebSocket.Server({ port: VOICE_WS_PORT });
  
  voiceWSServer.on('connection', (ws, req) => {
    console.log('✅ Voice WebSocket client connected');
    
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        handleVoiceMessage(ws, data);
      } catch (err) {
        console.error('Error parsing voice message:', err);
      }
    });
    
    ws.on('close', () => {
      // إزالة العميل من القائمة
      for (const deviceId in voiceClients) {
        if (voiceClients[deviceId].customer && voiceClients[deviceId].customer.ws === ws) {
          delete voiceClients[deviceId].customer;
          if (!voiceClients[deviceId].admin) {
            delete voiceClients[deviceId];
          }
          // إرسال إشعار للطرف الآخر
          if (voiceClients[deviceId] && voiceClients[deviceId].admin) {
            voiceClients[deviceId].admin.ws.send(JSON.stringify({ type: 'call-ended' }));
          }
          break;
        } else if (voiceClients[deviceId].admin && voiceClients[deviceId].admin.ws === ws) {
          delete voiceClients[deviceId].admin;
          if (!voiceClients[deviceId].customer) {
            delete voiceClients[deviceId];
          }
          // إرسال إشعار للطرف الآخر
          if (voiceClients[deviceId] && voiceClients[deviceId].customer) {
            voiceClients[deviceId].customer.ws.send(JSON.stringify({ type: 'call-ended' }));
          }
          break;
        }
      }
      console.log('❌ Voice WebSocket client disconnected');
    });
    
    ws.on('error', (err) => {
      console.error('Voice WebSocket error:', err);
    });
  });
  
  console.log(`✅ Voice WebSocket Server started on port ${VOICE_WS_PORT}`);
}

// معالجة رسائل المكالمات
function handleVoiceMessage(ws, data) {
  const { type, deviceId, role, targetDeviceId, offer, answer, candidate } = data;
  
  if (type === 'register') {
    // تسجيل العميل
    if (!voiceClients[deviceId]) {
      voiceClients[deviceId] = {};
    }
    voiceClients[deviceId][role] = { ws, deviceId };
    console.log(`Registered ${role} for device ${deviceId}`);
    
    // إرسال تأكيد التسجيل
    ws.send(JSON.stringify({ type: 'registered', deviceId, role }));
    return;
  }
  
  if (type === 'call-request') {
    // طلب مكالمة من العميل للإدارة
    const targetClient = voiceClients[deviceId];
    if (targetClient && targetClient.admin) {
      // إرسال طلب المكالمة للإدارة
      targetClient.admin.ws.send(JSON.stringify({
        type: 'incoming-call',
        deviceId: deviceId,
        fromDevice: deviceId
      }));
    } else {
      // لا يوجد إدارة متصلة
      if (targetClient && targetClient.customer) {
        targetClient.customer.ws.send(JSON.stringify({ type: 'call-rejected', reason: 'no-admin' }));
      }
    }
    return;
  }
  
  if (type === 'call-accept' || type === 'call-reject') {
    // قبول أو رفض المكالمة
    const targetClient = voiceClients[targetDeviceId || deviceId];
    if (targetClient && targetClient.customer) {
      targetClient.customer.ws.send(JSON.stringify({
        type: type === 'call-accept' ? 'call-accepted' : 'call-rejected',
        deviceId: targetDeviceId || deviceId
      }));
    }
    return;
  }
  
  if (type === 'offer') {
    // إرسال offer للطرف الآخر
    const targetClient = voiceClients[targetDeviceId || deviceId];
    if (targetClient) {
      const targetRole = role === 'customer' ? 'admin' : 'customer';
      if (targetClient[targetRole]) {
        targetClient[targetRole].ws.send(JSON.stringify({
          type: 'offer',
          offer,
          deviceId: targetDeviceId || deviceId,
          fromDevice: deviceId
        }));
      }
    }
    return;
  }
  
  if (type === 'answer') {
    // إرسال answer للطرف الآخر
    const targetClient = voiceClients[targetDeviceId || deviceId];
    if (targetClient) {
      const targetRole = role === 'customer' ? 'admin' : 'customer';
      if (targetClient[targetRole]) {
        targetClient[targetRole].ws.send(JSON.stringify({
          type: 'answer',
          answer,
          deviceId: targetDeviceId || deviceId,
          fromDevice: deviceId
        }));
      }
    }
    return;
  }
  
  if (type === 'ice-candidate') {
    // إرسال ICE candidate للطرف الآخر
    const targetClient = voiceClients[targetDeviceId || deviceId];
    if (targetClient) {
      const targetRole = role === 'customer' ? 'admin' : 'customer';
      if (targetClient[targetRole]) {
        targetClient[targetRole].ws.send(JSON.stringify({
          type: 'ice-candidate',
          candidate,
          deviceId: targetDeviceId || deviceId,
          fromDevice: deviceId
        }));
      }
    }
    return;
  }
  
  if (type === 'call-ended') {
    // إنهاء المكالمة
    const targetClient = voiceClients[targetDeviceId || deviceId];
    if (targetClient) {
      const targetRole = role === 'customer' ? 'admin' : 'customer';
      if (targetClient[targetRole]) {
        targetClient[targetRole].ws.send(JSON.stringify({ type: 'call-ended', deviceId: targetDeviceId || deviceId }));
      }
    }
    return;
  }
}

// أوامر IPC للجلسات
ipcMain.handle('start-session', async (event, data) => {
  // نفتح القفل على الـ PS4 ونتأكد من تغيّر الملف أولاً — الجلسة ما تبدأش غير لما الجهاز يرد
  const lock = await ps4lockApplyVerified(data.device_id, 'unlock');
  if (!lock.ok) {
    return { success: false, error: 'تعذر فتح القفل على الـ PS4 ومفيش جلسة اتفتحت: ' + (lock.error || 'الجهاز لم يستجب') };
  }
  return new Promise((resolve, reject) => {
    startSession(data, async err => {
      if (err) {
        // رول-باك: الجلسة لم تُنشأ، نرجّع القفل على الجهاز
        await ps4lockApplyAsync(data.device_id, 'lock');
        resolve({ success: false, error: err.message });
      } else {
        db.get('SELECT name FROM devices WHERE id = ?', [data.device_id], (e, dev) => {
          const devName = dev?.name || data.device_id;
          const modeLabel = data.mode === 'double' ? 'الجهاز double' : 'الجهاز single';
          const typeLabel = data.type === 'timed' ? `محدد (${data.duration ? formatDuration(Math.round(data.duration / 60)) : '?'})` : 'مفتوح';
          const now = new Date();
          const timeStr = now.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
          const dateStr = now.toLocaleDateString('ar-EG');
          const timeLine = `\nالوقت: ${timeStr}\nالتاريخ: ${dateStr}`;
          if (data.client_id) {
            db.get('SELECT name FROM clients WHERE id = ?', [data.client_id], (ec, client) => {
              const clientLine = client ? `\nالعميل: ${client.name}` : '';
              notifyTelegram(`🎮 <b>بداية جلسة</b>\nالجهاز: ${devName}\nالنمط: ${modeLabel}\nالنوع: ${typeLabel}${timeLine}${clientLine}`);
              resolve({ success: true, lock });
            });
          } else {
            notifyTelegram(`🎮 <b>بداية جلسة</b>\nالجهاز: ${devName}\nالنمط: ${modeLabel}\nالنوع: ${typeLabel}${timeLine}`);
            resolve({ success: true, lock });
          }
        });
      }
    });
  });
});
ipcMain.handle('end-session', async (event, device_id) => {
  const active = await new Promise(resolve => {
    getActiveSession(device_id, (err, session) => resolve(err ? null : session));
  });
  if (!active) {
    return { success: false, error: 'لا توجد جلسة نشطة على هذا الجهاز' };
  }
  // نقفل الـ PS4 ونتأكد من تغيّر الملف أولاً — الجلسة ما تتقفلش غير لما الجهاز يرد
  const lock = await ps4lockApplyVerified(device_id, 'lock');
  if (!lock.ok) {
    return { success: false, error: 'تعذر قفل الـ PS4 ومفيش جلسة اتقفلت: ' + (lock.error || 'الجهاز لم يستجب') };
  }
  return new Promise((resolve, reject) => {
    endSession(device_id, async (err, data) => {
      if (err) {
        // رول-باك: الجلسة لم تُنهَ، نرجّع فتح القفل على الجهاز
        await ps4lockApplyAsync(device_id, 'unlock');
        resolve({ success: false, error: err.message });
      } else {
        db.get(`SELECT s.id as session_id, s.start_time, s.end_time, d.name as device_name, c.name as client_name
                FROM sessions s
                LEFT JOIN devices d ON s.device_id = d.id
                LEFT JOIN clients c ON s.client_id = c.id
                WHERE s.device_id = ? AND s.is_active = 0
                ORDER BY s.end_time DESC LIMIT 1`, [device_id], (e, row) => {
          const devName = row?.device_name || device_id;
          const clientLine = row?.client_name ? `\nالعميل: ${row.client_name}` : '';
          const sessionId = row?.session_id;
          let timeLine = '';
          if (row?.start_time && row?.end_time) {
            const startDate = new Date(row.start_time);
            const endDate = new Date(row.end_time);
            const startTimeStr = startDate.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
            const endTimeStr = endDate.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
            const dateStr = startDate.toLocaleDateString('ar-EG');
            timeLine = `\nوقت البداية: ${startTimeStr}\nوقت النهاية: ${endTimeStr}\nالتاريخ: ${dateStr}`;
          }
          if (sessionId) {
            db.all(`SELECT sp.quantity, sp.total, p.name as product_name
                    FROM session_products sp
                    LEFT JOIN products p ON sp.product_id = p.id
                    WHERE sp.session_id = ?`, [sessionId], (ep, products) => {
              let productsLine = '';
              if (products && products.length > 0) {
                const productsTotal = products.reduce((s, p) => s + (p.total || 0), 0);
                productsLine = '\n\n📦 <b>المنتجات:</b>';
                products.forEach(p => {
                  productsLine += `\n• ${p.product_name || 'منتج'} × ${p.quantity} = ${p.total} ج.م`;
                });
                productsLine += `\nإجمالي المنتجات: ${productsTotal} ج.م`;
              }
              notifyTelegram(`🛑 <b>نهاية جلسة</b>\nالجهاز: ${devName}${timeLine}\nالمدة: ${formatDuration(data.minutes)}\nالإجمالي: ${data.total || 0} ج.م${clientLine}${productsLine}`);
              resolve({ success: true, lock, ...data });
            });
          } else {
            notifyTelegram(`🛑 <b>نهاية جلسة</b>\nالجهاز: ${devName}${timeLine}\nالمدة: ${formatDuration(data.minutes)}\nالإجمالي: ${data.total || 0} ج.م${clientLine}`);
            resolve({ success: true, lock, ...data });
          }
        });
      }
    });
  });
});
ipcMain.handle('get-active-session', async (event, device_id) => {
  return new Promise((resolve, reject) => {
    getActiveSession(device_id, (err, session) => {
      if (err || !session) resolve(null);
      else resolve(session);
    });
  });
});
ipcMain.handle('get-active-session1', async (event, device_id) => {
  return new Promise((resolve, reject) => {
    getActiveSession(device_id, (err, session) => {
      if (err || !session) resolve([null,device_id]);
      else resolve([session,device_id]);
    });
  });
});

// جلب كل الجلسات مع بيانات الجهاز
function getAllSessions(cb) {
  db.all(`SELECT s.*, d.name as device_name, c.name as client_name FROM sessions s LEFT JOIN devices d ON s.device_id = d.id LEFT JOIN clients c ON s.client_id = c.id ORDER BY s.start_time DESC`, cb);
}

function getSessionsPage(limit, offset, cb) {
  db.all(`SELECT s.*, d.name as device_name, c.name as client_name FROM sessions s LEFT JOIN devices d ON s.device_id = d.id LEFT JOIN clients c ON s.client_id = c.id ORDER BY s.start_time DESC LIMIT ? OFFSET ?`, [limit, offset], cb);
}

function getSessionsCount(cb) {
  db.get('SELECT COUNT(*) as total FROM sessions', cb);
}

function getSessionProductsBatch(sessionIds, cb) {
  if (!sessionIds || sessionIds.length === 0) return cb(null, []);
  const placeholders = sessionIds.map(() => '?').join(',');
  db.all(`SELECT sp.*, p.name FROM session_products sp LEFT JOIN products p ON sp.product_id = p.id WHERE sp.session_id IN (${placeholders})`, sessionIds, cb);
}

ipcMain.handle('get-all-sessions', async () => {
  return new Promise((resolve, reject) => {
    getAllSessions((err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});

ipcMain.handle('get-sessions-page', async (event, { limit, offset }) => {
  return new Promise((resolve, reject) => {
    getSessionsPage(limit, offset, (err, rows) => {
      if (err) resolve({ success: false, error: err.message, data: [] });
      else resolve({ success: true, data: rows });
    });
  });
});

ipcMain.handle('get-sessions-count', async () => {
  return new Promise((resolve, reject) => {
    getSessionsCount((err, row) => {
      if (err) resolve({ success: false, total: 0 });
      else resolve({ success: true, total: row.total });
    });
  });
});

ipcMain.handle('get-session-products-batch', async (event, sessionIds) => {
  return new Promise((resolve, reject) => {
    getSessionProductsBatch(sessionIds, (err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});

ipcMain.handle('get-filtered-sessions', async (event, { startDate, endDate, deviceId, page = 1, limit = 20 }) => {
  return new Promise((resolve) => {
    const now = Date.now();
    const defaultStart = now - 30 * 86400000;
    let sql = `SELECT s.*, d.name as device_name FROM sessions s LEFT JOIN devices d ON s.device_id = d.id WHERE s.is_active = 0`;
    let countSql = `SELECT COUNT(*) as total FROM sessions s WHERE s.is_active = 0`;
    const params = [], countParams = [];
    const s = startDate || defaultStart;
    const e = endDate || now;
    sql += ` AND s.start_time >= ? AND s.start_time <= ?`;
    params.push(s, e);
    countSql += ` AND s.start_time >= ? AND s.start_time <= ?`;
    countParams.push(s, e);
    if (deviceId) {
      sql += ` AND s.device_id = ?`;
      params.push(deviceId);
      countSql += ` AND s.device_id = ?`;
      countParams.push(deviceId);
    }
    sql += ` ORDER BY s.start_time DESC LIMIT ? OFFSET ?`;
    params.push(limit, (page - 1) * limit);
    db.all(countSql, countParams, (err, countRows) => {
      const total = (!err && countRows) ? countRows[0].total : 0;
      db.all(sql, params, (err, rows) => {
        if (err) resolve({ success: false, error: err.message, data: [], total: 0, page, limit });
        else resolve({ success: true, data: rows || [], total, page, limit });
      });
    });
  });
});

ipcMain.handle('get-filtered-standalone-sales', async (event, { startDate, endDate, category, page = 1, limit = 20 }) => {
  return new Promise((resolve) => {
    const now = Date.now();
    const defaultStart = now - 30 * 86400000;
    let sql = `SELECT ss.*, p.name as product_name, p.category as product_category FROM standalone_sales ss LEFT JOIN products p ON ss.product_id = p.id WHERE 1=1`;
    let countSql = `SELECT COUNT(*) as total FROM standalone_sales ss WHERE 1=1`;
    const params = [], countParams = [];
    const s = startDate || defaultStart;
    const e = endDate || now;
    sql += ` AND ss.date >= ? AND ss.date <= ?`;
    params.push(s, e);
    countSql += ` AND ss.date >= ? AND ss.date <= ?`;
    countParams.push(s, e);
    if (category) {
      sql += ` AND p.category = ?`;
      params.push(category);
      countSql += ` AND ss.product_id IN (SELECT id FROM products WHERE category = ?)`;
      countParams.push(category);
    }
    sql += ` ORDER BY ss.date DESC LIMIT ? OFFSET ?`;
    params.push(limit, (page - 1) * limit);
    db.all(countSql, countParams, (err, countRows) => {
      const total = (!err && countRows) ? countRows[0].total : 0;
      db.all(sql, params, (err, rows) => {
        if (err) resolve({ success: false, error: err.message, data: [], total: 0, page, limit });
        else resolve({ success: true, data: rows || [], total, page, limit });
      });
    });
  });
});

ipcMain.handle('get-invoices-summary', async () => {
  return new Promise((resolve) => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const todayEnd = todayStart + 86400000 - 1;
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).getTime();

    let completed = 0, total = 4;
    const results = {};

    function check() {
      completed++;
      if (completed < total) return;

      const spBySession = {};
      for (const p of results.sp) {
        spBySession[p.session_id] = (spBySession[p.session_id] || 0) + (p.total || 0);
      }

      let sessionsToday = 0, sessionsMonth = 0;
      let spToday = 0, spMonth = 0;
      let sessionsCountToday = 0, sessionsCountMonth = 0;
      for (const s of results.sessions) {
        if (s.start_time >= todayStart && s.start_time <= todayEnd) {
          sessionsToday += s.total || 0;
          spToday += spBySession[s.id] || 0;
          sessionsCountToday++;
        }
        if (s.start_time >= monthStart && s.start_time <= monthEnd) {
          sessionsMonth += s.total || 0;
          spMonth += spBySession[s.id] || 0;
          sessionsCountMonth++;
        }
      }

      let standaloneToday = 0, standaloneMonth = 0;
      let standaloneCountToday = 0, standaloneCountMonth = 0;
      for (const s of results.sales) {
        if (s.date >= todayStart && s.date <= todayEnd) {
          standaloneToday += s.total || 0;
          standaloneCountToday++;
        }
        if (s.date >= monthStart && s.date <= monthEnd) {
          standaloneMonth += s.total || 0;
          standaloneCountMonth++;
        }
      }

      let expensesToday = 0, expensesMonth = 0;
      for (const e of results.expenses) {
        if (e.date >= todayStart && e.date <= todayEnd) expensesToday += e.amount || 0;
        if (e.date >= monthStart && e.date <= monthEnd) expensesMonth += e.amount || 0;
      }

      resolve({
        success: true,
        data: {
          today: {
            revenue: sessionsToday + spToday + standaloneToday,
            sessionsSales: sessionsToday,
            sessionsProductsSales: spToday,
            standaloneSales: standaloneToday,
            expenses: expensesToday,
            netProfit: sessionsToday + spToday + standaloneToday - expensesToday,
            sessionsCount: sessionsCountToday,
            standaloneCount: standaloneCountToday
          },
          month: {
            revenue: sessionsMonth + spMonth + standaloneMonth,
            sessionsSales: sessionsMonth,
            sessionsProductsSales: spMonth,
            standaloneSales: standaloneMonth,
            expenses: expensesMonth,
            netProfit: sessionsMonth + spMonth + standaloneMonth - expensesMonth,
            sessionsCount: sessionsCountMonth,
            standaloneCount: standaloneCountMonth
          }
        }
      });
    }

    db.all(`SELECT s.id, s.total, s.start_time FROM sessions s WHERE s.is_active = 0 AND s.start_time >= ? AND s.start_time <= ?`, [monthStart, monthEnd], (err, sessions) => {
      if (err) return resolve({ success: false, error: err.message });
      results.sessions = sessions || [];
      check();
    });
    db.all(`SELECT ss.total, ss.date FROM standalone_sales ss WHERE ss.date >= ? AND ss.date <= ?`, [monthStart, monthEnd], (err, sales) => {
      if (err) return resolve({ success: false, error: err.message });
      results.sales = sales || [];
      check();
    });
    db.all(`SELECT e.amount, e.date FROM expenses e WHERE e.date >= ? AND e.date <= ?`, [monthStart, monthEnd], (err, expenses) => {
      if (err) return resolve({ success: false, error: err.message });
      results.expenses = expenses || [];
      check();
    });
    db.all(`SELECT sp.total, sp.session_id FROM session_products sp INNER JOIN sessions s ON sp.session_id = s.id WHERE s.start_time >= ? AND s.start_time <= ? AND s.is_active = 0`, [monthStart, monthEnd], (err, sp) => {
      if (err) return resolve({ success: false, error: err.message });
      results.sp = sp || [];
      check();
    });
  });
});

ipcMain.handle('get-report-summary', async (event, { date, month }) => {
  return new Promise((resolve) => {
    let startTime, endTime;
    if (date) {
      startTime = new Date(date + 'T00:00:00').getTime();
      endTime = new Date(date + 'T23:59:59').getTime();
    } else if (month) {
      const [year, mon] = month.split('-');
      startTime = new Date(year, mon - 1, 1).getTime();
      endTime = new Date(year, mon, 0, 23, 59, 59, 999).getTime();
    } else {
      return resolve({ success: true, data: { total: 0, sessionsTotal: 0, salesTotal: 0, sessionsCount: 0, salesCount: 0 } });
    }

    let completed = 0, total = 2, sessionsTotal = 0, salesTotal = 0, sessionsCount = 0, salesCount = 0;

    db.all(`SELECT s.id, s.total, s.start_time FROM sessions s WHERE s.is_active = 0 AND s.start_time >= ? AND s.start_time <= ?`, [startTime, endTime], (err, sessions) => {
      if (!err && sessions) {
        sessionsCount = sessions.length;
        const ids = sessions.map(s => s.id);
        if (ids.length > 0) {
          const placeholders = ids.map(() => '?').join(',');
          db.all(`SELECT session_id, COALESCE(SUM(total), 0) as total FROM session_products WHERE session_id IN (${placeholders}) GROUP BY session_id`, ids, (err2, spRows) => {
            if (!err2 && spRows) {
              const spMap = {};
              for (const r of spRows) spMap[r.session_id] = r.total || 0;
              for (const s of sessions) sessionsTotal += (s.total || 0) + (spMap[s.id] || 0);
            }
            completed++;
            if (completed === total) resolve({ success: true, data: { total: sessionsTotal + salesTotal, sessionsTotal, salesTotal, sessionsCount, salesCount } });
          });
        } else {
          completed++;
          if (completed === total) resolve({ success: true, data: { total: sessionsTotal + salesTotal, sessionsTotal, salesTotal, sessionsCount, salesCount } });
        }
      } else {
        completed++;
        if (completed === total) resolve({ success: true, data: { total: sessionsTotal + salesTotal, sessionsTotal, salesTotal, sessionsCount, salesCount } });
      }
    });

    db.all(`SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as cnt FROM standalone_sales WHERE date >= ? AND date <= ?`, [startTime, endTime], (err, row) => {
      if (!err && row) {
        salesTotal = row[0]?.total || 0;
        salesCount = row[0]?.cnt || 0;
      }
      completed++;
    });
  });
});

// دوال المنتجات
function addProduct(product, cb) {
  db.run('INSERT INTO products (name, price, category, quantity, image) VALUES (?, ?, ?, ?, ?)', [product.name, product.price, product.category || null, product.quantity || 0, product.image || null], cb);
}
function updateProduct(product, cb) {
  db.run('UPDATE products SET name = ?, price = ?, category = ?, quantity = ?, image = ? WHERE id = ?', [product.name, product.price, product.category || null, product.quantity || 0, product.image || null, product.id], cb);
}
function getProducts(cb) {
  db.all('SELECT * FROM products ORDER BY id DESC', cb);
}
function deleteProduct(productId, cb) {
  db.run('DELETE FROM products WHERE id = ?', [productId], cb);
}

// دوال المكونات
function addComponent(component, cb) {
  db.run('INSERT INTO components (name, unit, description) VALUES (?, ?, ?)', 
    [component.name, component.unit, component.description || null], cb);
}

function updateComponent(component, cb) {
  db.run('UPDATE components SET name = ?, unit = ?, description = ? WHERE id = ?', 
    [component.name, component.unit, component.description || null, component.id], cb);
}

function getComponents(cb) {
  db.all(`
    SELECT c.*, 
           COALESCE(ci.quantity, 0) as inventory_quantity, 
           COALESCE(ci.min_quantity, 0) as min_quantity 
    FROM components c 
    LEFT JOIN (
      SELECT component_id, quantity, min_quantity,
             ROW_NUMBER() OVER (PARTITION BY component_id ORDER BY last_updated DESC) as rn
      FROM component_inventory
    ) ci ON c.id = ci.component_id AND ci.rn = 1
    ORDER BY c.id DESC
  `, cb);
}

function deleteComponent(componentId, cb) {
  db.run('DELETE FROM components WHERE id = ?', [componentId], cb);
}

// دوال مخزون المكونات
function updateComponentInventory(componentId, quantity, minQuantity, cb) {
  db.run('INSERT OR REPLACE INTO component_inventory (component_id, quantity, min_quantity, last_updated) VALUES (?, ?, ?, ?)', 
    [componentId, quantity, minQuantity || 0, Date.now()], cb);
}

function getComponentInventory(componentId, cb) {
  db.get('SELECT * FROM component_inventory WHERE component_id = ?', [componentId], cb);
}

// دوال مكونات المنتجات
function addProductComponent(productId, componentId, quantityRequired, cb) {
  db.run('INSERT INTO product_components (product_id, component_id, quantity_required) VALUES (?, ?, ?)', 
    [productId, componentId, quantityRequired], cb);
}

function updateProductComponent(id, quantityRequired, cb) {
  db.run('UPDATE product_components SET quantity_required = ? WHERE id = ?', [quantityRequired, id], cb);
}

function getProductComponents(productId, cb) {
  db.all(`SELECT pc.*, c.name as component_name, c.unit, ci.quantity as available_quantity 
           FROM product_components pc 
           LEFT JOIN components c ON pc.component_id = c.id 
           LEFT JOIN component_inventory ci ON c.id = ci.component_id 
           WHERE pc.product_id = ?`, [productId], cb);
}

function deleteProductComponent(id, cb) {
  db.run('DELETE FROM product_components WHERE id = ?', [id], cb);
}

// دالة للتحقق من توفر المكونات المطلوبة لمنتج
function checkProductComponentsAvailability(productId, quantity, cb) {
  db.all(`SELECT pc.quantity_required * ? as total_required, ci.quantity as available, c.name as component_name
           FROM product_components pc 
           LEFT JOIN components c ON pc.component_id = c.id 
           LEFT JOIN component_inventory ci ON c.id = ci.component_id 
           WHERE pc.product_id = ?`, [quantity, productId], (err, rows) => {
    if (err) return cb(err);
    
    const unavailable = rows.filter(row => (row.available || 0) < row.total_required);
    cb(null, {
      available: unavailable.length === 0,
      unavailable: unavailable
    });
  });
}

// دالة لتنظيف السجلات المكررة في جدول component_inventory
function cleanupDuplicateComponentInventory(cb) {
  db.run(`
    DELETE FROM component_inventory 
    WHERE id NOT IN (
      SELECT MIN(id) 
      FROM component_inventory 
      GROUP BY component_id
    )
  `, (err) => {
    if (err) return cb(err);
    
    // إضافة الفهرس الفريد إذا لم يكن موجوداً
    db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_component_inventory_unique 
      ON component_inventory(component_id)
    `, cb);
  });
}

// دالة للتحقق من صحة رقم الجهاز
function validateDeviceId(deviceId, cb) {
  if (!deviceId || typeof deviceId !== 'string' || deviceId.trim() === '') {
    return cb(new Error('رقم الجهاز غير صحيح أو فارغ'));
  }
  
  // التحقق من أن الجهاز موجود في قاعدة البيانات
  db.get('SELECT id, name FROM devices WHERE id = ?', [deviceId.trim()], (err, device) => {
    if (err) return cb(err);
    if (!device) {
      return cb(new Error('الجهاز غير موجود في النظام'));
    }
    cb(null, device);
  });
}

// دالة لتسجيل محاولات استخدام أجهزة غير صحيحة
function logInvalidDeviceAttempt(deviceId, attemptType, details) {
  const logData = {
    timestamp: Date.now(),
    deviceId,
    attemptType,
    details,
    userAgent: 'system'
  };
  
  console.warn('محاولة استخدام جهاز غير صحيح:', logData);
  
  // تسجيل في قاعدة البيانات
  db.run('INSERT INTO security_logs (timestamp, device_id, event_type, details) VALUES (?, ?, ?, ?)', 
    [logData.timestamp, deviceId || 'unknown', attemptType, JSON.stringify(details)], (err) => {
    if (err) console.error('خطأ في تسجيل محاولة استخدام جهاز غير صحيح:', err);
  });
}

// دالة للتحقق من صحة التواريخ والأوقات
function validateTimeIntegrity(startTime, endTime, duration, type) {
  const now = Date.now();
  const maxFutureTime = now + (24 * 60 * 60 * 1000); // 24 ساعة في المستقبل
  const minPastTime = now - (7 * 24 * 60 * 60 * 1000); // أسبوع في الماضي
  
  // التحقق من وقت البداية
  if (startTime < minPastTime) {
    return { valid: false, error: 'وقت البداية قديم جداً - قد يكون هناك تلاعب' };
  }
  
  if (startTime > maxFutureTime) {
    return { valid: false, error: 'وقت البداية في المستقبل البعيد - قد يكون هناك تلاعب' };
  }
  
  // التحقق من وقت النهاية إذا كان محدد
  if (endTime) {
    if (endTime < startTime) {
      return { valid: false, error: 'وقت النهاية قبل وقت البداية - تلاعب واضح' };
    }
    
    if (endTime > maxFutureTime) {
      return { valid: false, error: 'وقت النهاية في المستقبل البعيد - قد يكون هناك تلاعب' };
    }
    
    // التحقق من المدة المعقولة (أقل من 24 ساعة)
    const sessionDuration = endTime - startTime;
    const maxDuration = 24 * 60 * 60 * 1000; // 24 ساعة
    if (sessionDuration > maxDuration) {
      return { valid: false, error: 'مدة الجلسة طويلة جداً - قد يكون هناك تلاعب' };
    }
  }
  
  // التحقق من المدة إذا كانت محدد
  if (duration && type === 'timed') {
    const maxDurationSeconds = 24 * 60 * 60; // 24 ساعة بالثواني
    if (duration > maxDurationSeconds) {
      return { valid: false, error: 'مدة الجلسة طويلة جداً - قد يكون هناك تلاعب' };
    }
    
    if (duration < 0) {
      return { valid: false, error: 'مدة الجلسة سالبة - تلاعب واضح' };
    }
  }
  
  return { valid: true };
}

// دالة لتسجيل محاولات التلاعب
function logTimeManipulationAttempt(deviceId, attemptType, details) {
  const logData = {
    timestamp: Date.now(),
    deviceId,
    attemptType,
    details,
    userAgent: 'system'
  };
  
  console.warn('محاولة تلاعب في الوقت:', logData);
  
  // يمكن إضافة تسجيل في قاعدة البيانات هنا
  db.run('INSERT INTO security_logs (timestamp, device_id, event_type, details) VALUES (?, ?, ?, ?)', 
    [logData.timestamp, deviceId, attemptType, JSON.stringify(details)], (err) => {
    if (err) console.error('خطأ في تسجيل محاولة التلاعب:', err);
  });
}

// دالة للتحقق من صحة تحديث الجلسة
function validateSessionUpdate(sessionId, updates, cb) {
  db.get('SELECT * FROM sessions WHERE id = ?', [sessionId], (err, session) => {
    if (err) return cb(err);
    if (!session) return cb(new Error('الجلسة غير موجودة'));
    
    // التحقق من تحديثات رقم الجهاز
    if (updates.device_id !== undefined) {
      validateDeviceId(updates.device_id, (err, device) => {
        if (err) {
          logInvalidDeviceAttempt(updates.device_id, 'invalid_device_update', {
            sessionId,
            old_device_id: session.device_id,
            new_device_id: updates.device_id,
            error: err.message
          });
          return cb(err);
        }
        
        // متابعة التحقق من الوقت
        validateTimeUpdates(sessionId, session, updates, cb);
      });
    } else {
      // التحقق من تحديثات الوقت فقط
      validateTimeUpdates(sessionId, session, updates, cb);
    }
  });
}

// دالة مساعدة للتحقق من تحديثات الوقت
function validateTimeUpdates(sessionId, session, updates, cb) {
  // التحقق من تحديثات الوقت
  if (updates.start_time || updates.end_time || updates.scheduled_end_time) {
    const startTime = updates.start_time || session.start_time;
    const endTime = updates.end_time || session.end_time;
    const scheduledEndTime = updates.scheduled_end_time || session.scheduled_end_time;
    
    const timeValidation = validateTimeIntegrity(startTime, endTime, session.duration, session.type);
    if (!timeValidation.valid) {
      logTimeManipulationAttempt(session.device_id, 'invalid_session_update', {
        sessionId,
        updates,
        error: timeValidation.error
      });
      return cb(new Error(timeValidation.error));
    }
    
    // التحقق من أن التحديثات منطقية
    if (endTime && startTime && endTime < startTime) {
      logTimeManipulationAttempt(session.device_id, 'end_before_start_update', {
        sessionId,
        startTime,
        endTime
      });
      return cb(new Error('وقت النهاية لا يمكن أن يكون قبل وقت البداية'));
    }
  }
  
  cb(null, true);
}
function deductProductComponents(productId, quantity, cb) {
  db.all('SELECT component_id, quantity_required FROM product_components WHERE product_id = ?', [productId], (err, components) => {
    if (err) return cb(err);
    
    let completed = 0;
    const total = components.length;
    if (total === 0) return cb(null);
    
    components.forEach(comp => {
      const deductAmount = comp.quantity_required * quantity;
      db.run('UPDATE component_inventory SET quantity = quantity - ?, last_updated = ? WHERE component_id = ?', 
        [deductAmount, Date.now(), comp.component_id], (err) => {
        completed++;
        if (completed === total) cb(err);
      });
    });
  });
}

// دالة لإرجاع المكونات للمخزون عند الحذف أو تقليل الكمية
function restoreProductComponents(productId, quantity, cb) {
  db.all('SELECT component_id, quantity_required FROM product_components WHERE product_id = ?', [productId], (err, components) => {
    if (err) return cb(err);
    
    let completed = 0;
    const total = components.length;
    if (total === 0) return cb(null);
    
    components.forEach(comp => {
      const restoreAmount = comp.quantity_required * quantity;
      db.run('UPDATE component_inventory SET quantity = quantity + ?, last_updated = ? WHERE component_id = ?', 
        [restoreAmount, Date.now(), comp.component_id], (err) => {
        completed++;
        if (completed === total) cb(err);
      });
    });
  });
}

// أوامر IPC للمنتجات
ipcMain.handle('add-product', async (event, product) => {
  return new Promise((resolve, reject) => {
    addProduct(product, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});
ipcMain.handle('get-products', async () => {
  return new Promise((resolve, reject) => {
    getProducts((err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});
ipcMain.handle('update-product', async (event, product) => {
  return new Promise((resolve, reject) => {
    updateProduct(product, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});
ipcMain.handle('delete-product', async (event, productId) => {
  return new Promise((resolve, reject) => {
    deleteProduct(productId, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

// IPC handlers لطلبات العملاء
ipcMain.handle('get-customer-orders', async () => {
  return new Promise((resolve, reject) => {
    getCustomerOrders((err, orders) => {
      if (err) resolve([]);
      else resolve(orders);
    });
  });
});

ipcMain.handle('update-customer-order-status', async (event, { orderId, status }) => {
  return new Promise((resolve, reject) => {
    updateCustomerOrderStatus(orderId, status, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

// IPC handlers للشات
ipcMain.handle('get-customer-messages', async (event, device_id) => {
  return new Promise((resolve) => {
    getCustomerMessages(device_id, (err, messages) => {
      if (err) resolve({ success: false, error: err.message, data: [] });
      else resolve({ success: true, data: messages || [] });
    });
  });
});

ipcMain.handle('get-all-customer-messages', async (event) => {
  return new Promise((resolve) => {
    getAllCustomerMessages((err, messages) => {
      if (err) resolve({ success: false, error: err.message, data: [] });
      else resolve({ success: true, data: messages || [] });
    });
  });
});

ipcMain.handle('get-last-message-device', async (event) => {
  return new Promise((resolve) => {
    getLastMessageDevice((err, device) => {
      if (err) resolve({ success: false, error: err.message, data: null });
      else resolve({ success: true, data: device || null });
    });
  });
});

ipcMain.handle('send-admin-message', async (event, { device_id, message }) => {
  return new Promise((resolve) => {
    addCustomerMessage(device_id, 'admin', message, (err, messageId) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, messageId });
    });
  });
});

ipcMain.handle('mark-messages-as-read', async (event, device_id) => {
  return new Promise((resolve) => {
    markMessagesAsRead(device_id, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('delete-customer-messages', async (event, device_id) => {
  return new Promise((resolve) => {
    deleteCustomerMessages(device_id, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

// أوامر IPC للمكونات
ipcMain.handle('add-component', async (event, component) => {
  return new Promise((resolve, reject) => {
    addComponent(component, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('get-components', async () => {
  return new Promise((resolve, reject) => {
    getComponents((err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});

ipcMain.handle('update-component', async (event, component) => {
  return new Promise((resolve, reject) => {
    updateComponent(component, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('delete-component', async (event, componentId) => {
  return new Promise((resolve, reject) => {
    deleteComponent(componentId, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

// أوامر IPC لمخزون المكونات
ipcMain.handle('update-component-inventory', async (event, { componentId, quantity, minQuantity }) => {
  return new Promise((resolve, reject) => {
    updateComponentInventory(componentId, quantity, minQuantity, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('get-component-inventory', async (event, componentId) => {
  return new Promise((resolve, reject) => {
    getComponentInventory(componentId, (err, row) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, data: row });
    });
  });
});

// أوامر IPC لمكونات المنتجات
ipcMain.handle('add-product-component', async (event, { productId, componentId, quantityRequired }) => {
  return new Promise((resolve, reject) => {
    addProductComponent(productId, componentId, quantityRequired, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('get-product-components', async (event, productId) => {
  return new Promise((resolve, reject) => {
    getProductComponents(productId, (err, rows) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, data: rows });
    });
  });
});

ipcMain.handle('update-product-component', async (event, { id, quantityRequired }) => {
  return new Promise((resolve, reject) => {
    updateProductComponent(id, quantityRequired, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('delete-product-component', async (event, id) => {
  return new Promise((resolve, reject) => {
    deleteProductComponent(id, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('check-product-components-availability', async (event, { productId, quantity }) => {
  return new Promise((resolve, reject) => {
    checkProductComponentsAvailability(productId, quantity, (err, result) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, data: result });
    });
  });
});

// تنظيف السجلات المكررة في component_inventory
ipcMain.handle('cleanup-duplicate-component-inventory', async () => {
  return new Promise((resolve, reject) => {
    cleanupDuplicateComponentInventory((err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

// دوال session_products
function addProductToSession({ session_id, product_id, quantity, price }, cb) {
  // التحقق من توفر المكونات أولاً
  checkProductComponentsAvailability(product_id, quantity, (err, availability) => {
    if (err) return cb(err);
    
    if (!availability.available) {
      const unavailableComponents = availability.unavailable.map(comp => 
        `${comp.component_name}: متوفر ${comp.available || 0}، مطلوب ${comp.total_required}`
      ).join(', ');
      return cb(new Error(`لا يمكن البيع - المكونات غير متوفرة: ${unavailableComponents}`));
    }
    
    const total = price * quantity;
    db.run('INSERT INTO session_products (session_id, product_id, quantity, price, total) VALUES (?, ?, ?, ?, ?)', [session_id, product_id, quantity, price, total], function (err) {
      if (err) return cb(err);
      
      // خصم المكونات من المخزون
      deductProductComponents(product_id, quantity, (err2) => {
        if (err2) return cb(err2);
        
        // خصم الكمية من المنتج (إذا كان له مخزون)
        db.run('UPDATE products SET quantity = quantity - ? WHERE id = ?', [quantity, product_id], function (err3) {
          if (err3) return cb(err3);
          cb();
        });
      });
    });
  });
}

// === Telegram helpers ===
function getSetting(key, cb) {
  db.get('SELECT value FROM app_settings WHERE key = ?', [key], (err, row) => {
    if (err) return cb(err);
    cb(null, row ? row.value : null);
  });
}
function setSetting(key, value, cb) {
  db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [key, value], cb);
}
// دوال إدارة شاتات تيليجرام
function addTelegramChat(chatId, cb) {
  db.run('INSERT OR IGNORE INTO telegram_chats (chat_id) VALUES (?)', [String(chatId)], cb);
}
function removeTelegramChat(chatId, cb) {
  db.run('DELETE FROM telegram_chats WHERE chat_id = ?', [String(chatId)], cb);
}
function getAllTelegramChats(cb) {
  db.all('SELECT chat_id FROM telegram_chats ORDER BY added_at DESC', cb);
}

let cachedTelegram = { token: null, bot: null };
function sendTelegramMessage(token, chatIds, text, cb) {
  try {
    // تحويل chatIds إلى مصفوفة إذا كانت نص واحد
    const chatIdsArray = Array.isArray(chatIds) ? chatIds : (chatIds ? [chatIds] : []);
    
    if (chatIdsArray.length === 0) {
      console.log('⚠️ لا توجد شاتات للإرسال إليها');
      return cb && cb(new Error('لا توجد شاتات للإرسال إليها'));
    }
    
    console.log('📤 محاولة إرسال رسالة تيليجرام إلى', chatIdsArray.length, 'شات');
    const TelegramBot = require('node-telegram-bot-api');
    const sendBot = new TelegramBot(token, { polling: false });
    
    let completed = 0;
    let errors = [];
    
    chatIdsArray.forEach((chatId) => {
      const chatIdNum = typeof chatId === 'string' ? parseInt(chatId) : chatId;
      sendBot.sendMessage(chatIdNum, text, { parse_mode: 'HTML' })
        .then(() => {
          console.log('✅ تم إرسال الرسالة إلى:', chatId);
          completed++;
          if (completed === chatIdsArray.length) {
            if (errors.length > 0) {
              console.log('⚠️ تم الإرسال مع بعض الأخطاء:', errors.length);
            }
            if (cb) cb(errors.length > 0 ? errors[0] : null);
          }
        })
        .catch((e) => {
          console.error('❌ خطأ في إرسال الرسالة إلى', chatId, ':', e.message);
          errors.push(e);
          completed++;
          if (completed === chatIdsArray.length) {
            if (cb) cb(errors.length === chatIdsArray.length ? errors[0] : null);
          }
        });
    });
  } catch (e) {
    console.error('❌ خطأ في تهيئة البوت:', e.message);
    if (cb) cb(e);
  }
}

function formatDuration(minutes) {
  if (!minutes || minutes === '?') return '?';
  minutes = Math.round(minutes);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins} دقيقة`;
  if (mins === 0) return hours === 1 ? `1 ساعة` : `${hours} ساعة`;
  return `${hours} ساعة ${mins} دقيقة`;
}

function notifyTelegram(text) {
  getSetting('telegram_bot_token', (e1, token) => {
    if (e1 || !token) return;
    getAllTelegramChats((e2, chats) => {
      if (e2 || !chats || chats.length === 0) return;
      sendTelegramMessage(token, chats.map(c => c.chat_id), text, () => {});
    });
  });
}

function initTelegramBot() {
  console.log("initTelegramBot");
  try {
    getSetting('telegram_bot_token', (e, token) => {
      if (e) {
        console.log('⚠️ خطأ في جلب توكن تيليجرام:', e.message);
        return;
      }
      if (!token) {
        console.log('ℹ️ لا يوجد توكن تيليجرام محفوظ');
        return;
      }
      console.log('🤖 تهيئة بوت تيليجرام...');
      const TelegramBot = require('node-telegram-bot-api');
      if (!cachedTelegram.bot || cachedTelegram.token !== token) {
        try {
          console.log(token);
          
          cachedTelegram.bot = new TelegramBot(token, { polling: true });
          cachedTelegram.token = token;
          console.log('✅ تم تهيئة البوت بنجاح');
        } catch (botErr) {
          console.error('❌ خطأ في تهيئة البوت:', botErr.message);
          return;
        }
      }
      const bot = cachedTelegram.bot;
      bot.onText(/\/start/, (msg) => {
        console.log('📨 تم استلام /start من:', msg);
        const chatId = String(msg.chat.id);
        console.log('📨 تم استلام /start من:', chatId);
        addTelegramChat(chatId, (err) => {
          if (err) {
            console.error('❌ خطأ في حفظ chat_id:', err.message);
            bot.sendMessage(msg.chat.id, 'حدث خطأ أثناء الربط.').catch(()=>{});
          } else {
            console.log('✅ تم إضافة chat_id:', chatId);
            bot.sendMessage(msg.chat.id, '✅ تم ربط هذه المحادثة لاستلام تقارير الشيفت.').catch(()=>{});
          }
        });
      });
      bot.onText(/\/shift/, async (msg) => {
        try {
          const chatId = String(msg.chat.id);
          console.log('📊 تم استلام طلب عرض إحصائيات الشيفت من:', chatId);
          
          // Get the current active shift
          db.get("SELECT id, start_time FROM shifts WHERE end_time IS NULL ORDER BY start_time DESC LIMIT 1", async (err, shift) => {
            if (err) {
              console.error('❌ خطأ في جلب بيانات الشيفت:', err.message);
              return bot.sendMessage(chatId, '❌ حدث خطأ أثناء جلب بيانات الشيفت').catch(() => {});
            }
            
            if (!shift) {
              return bot.sendMessage(chatId, '⚠️ لا يوجد شيفت نشط حالياً').catch(() => {});
            }
            
            // Get detailed shift statistics
            getShiftDetailedStats(shift.id, (err, stats) => {
              if (err) {
                console.error('❌ خطأ في جلب إحصائيات الشيفت:', err.message);
                return bot.sendMessage(chatId, '❌ حدث خطأ أثناء جلب إحصائيات الشيفت').catch(() => {});
              }
              
              // Format the shift start time
              const startTime = new Date(shift.start_time * 1000).toLocaleString('ar-EG');
              
              // Prepare the message
              let message = `📊 *إحصائيات الشيفت الحالي*\n`;
              message += `⏱️ بدأ في: ${startTime}\n\n`;
              
              // Add sessions summary
              message += `*الجلسات*\n`;
              message += `🔹 عدد الجلسات: ${stats.sessions?.totals?.total_sessions || 0}\n`;
              message += `💰 إجمالي الإيرادات: ${stats.sessions?.totals?.total_revenue || 0} ج.م\n\n`;
              
              // Add products summary
              message += `*المنتجات المباعة*\n`;
              message += `🛒 عدد المنتجات: ${stats.products?.totals?.total_quantity || 0}\n`;
              message += `💰 إجمالي المبيعات: ${stats.products?.totals?.total_revenue || 0} ج.م\n\n`;
              
              // Add expenses summary
              message += `*المصروفات*\n`;
              message += `💸 إجمالي المصروفات: ${stats.expenses?.total_expenses || 0} ج.م\n\n`;
              
              // Add employee wages
              const wagesTotal = (stats.employee_wages || []).reduce((s, w) => s + (w.total_amount || 0), 0);
              if (wagesTotal > 0) {
                message += `*صرف اليومية*\n`;
                message += `👤 إجمالي صرف اليومية: ${wagesTotal} ج.م\n\n`;
              }
              
              // Add net total
              const totalRevenue = (stats.sessions?.totals?.total_revenue || 0) + (stats.products?.totals?.total_revenue || 0);
              const netTotal = totalRevenue - (stats.expenses?.total_expenses || 0) - wagesTotal;
              message += `🏦 *صافي الإيرادات*: ${netTotal} ج.م`;
              
              // Send the message with Markdown formatting
              bot.sendMessage(chatId, message, { parse_mode: 'Markdown' }).catch(err => {
                console.error('❌ خطأ في إرسال الرسالة:', err.message);
                // Try sending without Markdown if it fails
                bot.sendMessage(chatId, message.replace(/[\*_`]/g, '')).catch(console.error);
              });
            });
          });
        } catch (error) {
          console.error('❌ خطأ غير متوقع في معالجة أمر /shift:', error.message);
          bot.sendMessage(msg.chat.id, '❌ حدث خطأ غير متوقع').catch(console.error);
        }
      })
      // معالجة الأخطاء
      bot.on('polling_error', (error) => {
        console.error('❌ خطأ في polling تيليجرام:', error.message);
      });
    });
  } catch (e) {
    console.error('❌ خطأ في initTelegramBot:', e.message);
  }
}

// دوال العملاء
function addClient(client, cb) {
  if (!client.name || typeof client.name !== 'string') {
    return cb(new Error('اسم العميل مطلوب'));
  }
  db.run(
    'INSERT INTO clients (name, phone, email, address, notes, is_favorite) VALUES (?, ?, ?, ?, ?, ?)',
    [client.name.trim(), client.phone || null, client.email || null, client.address || null, client.notes || null, client.is_favorite ? 1 : 0],
    function(err) {
      if (err) return cb(err);
      cb(null, this.lastID);
    }
  );
}

function getClients(cb) {
  db.all('SELECT * FROM clients ORDER BY name ASC', cb);
}

function updateClient(client, cb) {
  if (!client.id) return cb(new Error('رقم العميل غير صالح'));
  if (!client.name || typeof client.name !== 'string') return cb(new Error('اسم العميل مطلوب'));
  db.run(
    'UPDATE clients SET name = ?, phone = ?, email = ?, address = ?, notes = ?, is_favorite = ? WHERE id = ?',
    [client.name.trim(), client.phone || null, client.email || null, client.address || null, client.notes || null, client.is_favorite ? 1 : 0, client.id],
    cb
  );
}

function deleteClient(id, cb) {
  if (!id) return cb(new Error('رقم العميل غير صالح'));
  db.run('DELETE FROM clients WHERE id = ?', [id], cb);
}

ipcMain.handle('clients-add', async (event, client) => {
  return new Promise((resolve) => {
    addClient(client, (err, id) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, id });
    });
  });
});

ipcMain.handle('clients-get-all', async () => {
  return new Promise((resolve) => {
    getClients((err, rows) => {
      if (err) resolve({ success: false, error: err.message, data: [] });
      else resolve({ success: true, data: rows });
    });
  });
});

ipcMain.handle('clients-update', async (event, client) => {
  return new Promise((resolve) => {
    updateClient(client, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('clients-delete', async (event, id) => {
  return new Promise((resolve) => {
    deleteClient(id, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

// رصيد العملاء
ipcMain.handle('clients-add-balance', async (event, { client_id, amount }) => {
  return new Promise((resolve) => {
    if (!client_id || amount === undefined) return resolve({ success: false, error: 'بيانات غير صالحة' });
    db.run('UPDATE clients SET balance = COALESCE(balance, 0) + ? WHERE id = ?', [amount, client_id], function(err) {
      if (err) return resolve({ success: false, error: err.message });
      db.get('SELECT name, COALESCE(balance, 0) as balance FROM clients WHERE id = ?', [client_id], (e, c) => {
        if (c) notifyTelegram(`💰 <b>إضافة رصيد</b>\nالعميل: ${c.name}\nالمبلغ: ${amount} ج.م\nالرصيد الحالي: ${c.balance} ج.م`);
        resolve({ success: true });
      });
    });
  });
});
ipcMain.handle('clients-deduct-balance', async (event, { client_id, amount }) => {
  return new Promise((resolve) => {
    if (!client_id || amount === undefined) return resolve({ success: false, error: 'بيانات غير صالحة' });
    db.run('UPDATE clients SET balance = COALESCE(balance, 0) - ? WHERE id = ? AND COALESCE(balance, 0) >= ?', [amount, client_id, amount], function(err) {
      if (err) return resolve({ success: false, error: err.message });
      if (this.changes === 0) return resolve({ success: false, error: 'الرصيد غير كافٍ' });
      db.get('SELECT name, COALESCE(balance, 0) as balance FROM clients WHERE id = ?', [client_id], (e, c) => {
        if (c) notifyTelegram(`🔻 <b>خصم من الرصيد</b>\nالعميل: ${c.name}\nالمبلغ: ${amount} ج.م\nالرصيد الحالي: ${c.balance} ج.م`);
        resolve({ success: true });
      });
    });
  });
});
ipcMain.handle('clients-get-balance', async (event, client_id) => {
  return new Promise((resolve) => {
    if (!client_id) return resolve({ success: false, error: 'رقم العميل مطلوب' });
    db.get('SELECT COALESCE(balance, 0) as balance FROM clients WHERE id = ?', [client_id], (err, row) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, balance: row?.balance || 0 });
    });
  });
});

// دوال الحجوزات
function checkBookingOverlap(device_id, date, start_time, end_time, excludeId, cb) {
  if (!device_id || !date || !start_time || !end_time) return cb(null, false);
  const query = `SELECT id FROM bookings WHERE device_id = ? AND date = ? AND status IN ('pending','confirmed') AND start_time < ? AND end_time > ? ${excludeId ? 'AND id != ?' : ''}`;
  const params = excludeId ? [device_id, date, end_time, start_time, excludeId] : [device_id, date, end_time, start_time];
  db.get(query, params, (err, row) => {
    if (err) return cb(err);
    cb(null, !!row);
  });
}
function addBooking(booking, cb) {
  const { client_id, client_name, device_id, device_name, date, start_time, end_time, duration, price, status, notes } = booking;
  checkBookingOverlap(device_id, date, start_time, end_time, null, (err, overlap) => {
    if (err) return cb(err);
    if (overlap) return cb(new Error('يوجد حجز آخر متداخل مع هذا الوقت على نفس الجهاز'));
    db.run('INSERT INTO bookings (client_id, client_name, device_id, device_name, date, start_time, end_time, duration, price, status, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [client_id, client_name || null, device_id || null, device_name || null, date || null, start_time || null, end_time || null, duration || 0, price || 0, status || 'pending', notes || null, Date.now()], cb);
  });
}
function getBookings(cb) {
  db.all('SELECT b.*, c.phone as client_phone FROM bookings b LEFT JOIN clients c ON b.client_id = c.id ORDER BY b.created_at DESC', cb);
}
function updateBooking(booking, cb) {
  const { id, client_id, client_name, device_id, device_name, date, start_time, end_time, duration, price, status, notes } = booking;
  checkBookingOverlap(device_id, date, start_time, end_time, id, (err, overlap) => {
    if (err) return cb(err);
    if (overlap) return cb(new Error('يوجد حجز آخر متداخل مع هذا الوقت على نفس الجهاز'));
    db.run('UPDATE bookings SET client_id=?, client_name=?, device_id=?, device_name=?, date=?, start_time=?, end_time=?, duration=?, price=?, status=?, notes=? WHERE id=?',
      [client_id, client_name || null, device_id || null, device_name || null, date || null, start_time || null, end_time || null, duration || 0, price || 0, status || 'pending', notes || null, id], cb);
  });
}
function deleteBooking(id, cb) {
  db.run('DELETE FROM bookings WHERE id=?', [id], cb);
}

ipcMain.handle('bookings-add', async (event, booking) => {
  return new Promise((resolve) => {
    addBooking(booking, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else {
        const b = booking;
        const dateStr = b.date ? new Date(Number(b.date)).toLocaleDateString('ar-EG') : '?';
        notifyTelegram(`📅 <b>حجز جديد</b>\nالعميل: ${b.client_name || 'بدون'}\nالجهاز: ${b.device_name || 'بدون'}\nالتاريخ: ${dateStr}\nمن: ${b.start_time || '?'}\nإلى: ${b.end_time || '?'}\nالسعر: ${b.price || 0} ج.م`);
        resolve({ success: true });
      }
    });
  });
});
ipcMain.handle('bookings-get-all', async () => {
  return new Promise((resolve) => {
    getBookings((err, rows) => {
      if (err) resolve({ success: false, error: err.message, data: [] });
      else resolve({ success: true, data: rows });
    });
  });
});
ipcMain.handle('bookings-get-upcoming', async () => {
  return new Promise((resolve) => {
    const now = Date.now();
    const in5 = now + 5 * 60 * 1000;
    const today = new Date().toISOString().split('T')[0];
    const todayStart = new Date(today + 'T00:00:00').getTime();
    const todayEnd = new Date(today + 'T23:59:59').getTime();
    const query = `SELECT b.*, c.phone as client_phone FROM bookings b LEFT JOIN clients c ON b.client_id = c.id WHERE b.date >= ? AND b.date <= ? AND b.status IN ('pending','confirmed') AND b.start_time IS NOT NULL ORDER BY b.date ASC, b.start_time ASC`;
    db.all(query, [todayStart, todayEnd], (err, rows) => {
      if (err) { resolve({ success: false, error: err.message, data: [] }); return; }
      const upcoming = [];
      for (const b of (rows || [])) {
        const bookingDateTime = new Date(b.date);
        const parts = (b.start_time || '').split(':');
        if (parts.length >= 2) {
          bookingDateTime.setHours(parseInt(parts[0]), parseInt(parts[1]), 0, 0);
        }
        const diff = bookingDateTime.getTime() - now;
        if (diff > 0 && diff <= 5 * 60 * 1000) {
          upcoming.push({ ...b, _diffMs: diff });
        }
      }
      resolve({ success: true, data: upcoming });
    });
  });
});
ipcMain.handle('bookings-update', async (event, booking) => {
  return new Promise((resolve) => {
    db.get('SELECT status FROM bookings WHERE id = ?', [booking.id], (e, old) => {
      const oldStatus = old?.status || '';
      updateBooking(booking, (err) => {
        if (err) resolve({ success: false, error: err.message });
        else {
          const b = booking;
          const statusLabel = { pending: 'قيد الانتظار', confirmed: 'مؤكد', completed: 'مكتمل', cancelled: 'ملغي' };
          if (b.status !== oldStatus) {
            const dateStr = b.date ? new Date(Number(b.date)).toLocaleDateString('ar-EG') : '?';
            if (b.status === 'confirmed') {
              notifyTelegram(`✅ <b>تأكيد حجز</b>\nالعميل: ${b.client_name || 'بدون'}\nالجهاز: ${b.device_name || 'بدون'}\nالتاريخ: ${dateStr}\nمن: ${b.start_time || '?'}\nإلى: ${b.end_time || '?'}\nالسعر: ${b.price || 0} ج.م`);
            } else if (b.status === 'completed') {
              notifyTelegram(`🏁 <b>إنهاء حجز</b>\nالعميل: ${b.client_name || 'بدون'}\nالجهاز: ${b.device_name || 'بدون'}\nالتاريخ: ${dateStr}\nمن: ${b.start_time || '?'}\nإلى: ${b.end_time || '?'}\nالسعر: ${b.price || 0} ج.م`);
            } else if (b.status === 'cancelled') {
              notifyTelegram(`❌ <b>إلغاء حجز</b>\nالعميل: ${b.client_name || 'بدون'}\nالجهاز: ${b.device_name || 'بدون'}\nالتاريخ: ${dateStr}\nمن: ${b.start_time || '?'}\nإلى: ${b.end_time || '?'}\nالسعر: ${b.price || 0} ج.م`);
            }
          }
          resolve({ success: true });
        }
      });
    });
  });
});
ipcMain.handle('bookings-delete', async (event, id) => {
  return new Promise((resolve) => {
    deleteBooking(id, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

// دوال المديونيات
function addDebt({ client_id, client_name, amount, date }, cb) {
  const debtDate = date || Date.now();
  const numericAmount = Number(amount);
  if (isNaN(numericAmount) || numericAmount <= 0) {
    return cb(new Error('المبلغ غير صالح'));
  }

  // إذا كان client_id موجود، نجيب الاسم من جدول العملاء
  if (client_id) {
    db.get('SELECT name FROM clients WHERE id = ?', [client_id], (err, client) => {
      if (err) return cb(err);
      if (!client) return cb(new Error('العميل غير موجود'));
      insertDebt(client.name, numericAmount, debtDate, client_id, cb);
    });
  } else if (client_name && typeof client_name === 'string') {
    insertDebt(client_name.trim(), numericAmount, debtDate, null, cb);
  } else {
    return cb(new Error('اسم العميل مطلوب'));
  }
}

function insertDebt(clientName, amount, date, clientId, cb) {
  db.get('SELECT id FROM shifts WHERE status = ?', ['active'], (err, activeShift) => {
    if (err) return cb(err);
    if (!activeShift) return cb(new Error('لا يوجد شيفت نشط لإضافة المديونية'));

    db.run(
      'INSERT INTO debts (client_id, client_name, amount, date, status, created_shift_id) VALUES (?, ?, ?, ?, ?, ?)',
      [clientId, clientName, amount, date, 'unpaid', activeShift.id],
      cb
    );
  });
}
function getDebts(cb) {
  db.all('SELECT * FROM debts ORDER BY status ASC, date DESC, id DESC', cb);
}
function updateDebt({ id, client_id, client_name, amount, date }, cb) {
  if (!id) return cb(new Error('رقم المديونية غير صالح'));
  const numericAmount = Number(amount);
  if (isNaN(numericAmount) || numericAmount <= 0) return cb(new Error('المبلغ غير صالح'));

  db.get('SELECT status FROM debts WHERE id = ?', [id], (err, debt) => {
    if (err) return cb(err);
    if (!debt) return cb(new Error('المديونية غير موجودة'));
    if (debt.status === 'paid') {
      return cb(new Error('لا يمكن تعديل مديونية تم تسديدها'));
    }

    const update = (name, cId) => {
      db.run(
        'UPDATE debts SET client_id = ?, client_name = ?, amount = ?, date = ? WHERE id = ?',
        [cId, name, numericAmount, date || Date.now(), id],
        cb
      );
    };

    if (client_id) {
      db.get('SELECT name FROM clients WHERE id = ?', [client_id], (err2, client) => {
        if (err2) return cb(err2);
        if (!client) return cb(new Error('العميل غير موجود'));
        update(client.name, client_id);
      });
    } else if (client_name && typeof client_name === 'string') {
      update(client_name.trim(), null);
    } else {
      return cb(new Error('اسم العميل مطلوب'));
    }
  });
}
function deleteDebt(id, cb) {
  if (!id) return cb(new Error('رقم المديونية غير صالح'));
  db.get('SELECT status FROM debts WHERE id = ?', [id], (err, debt) => {
    if (err) return cb(err);
    if (!debt) return cb(new Error('المديونية غير موجودة'));
    if (debt.status === 'paid') {
      return cb(new Error('لا يمكن حذف مديونية تم تسديدها'));
    }
    db.run('DELETE FROM debts WHERE id = ?', [id], cb);
  });
}
function markDebtAsPaid(id, cb) {
  if (!id) return cb(new Error('رقم المديونية غير صالح'));
  db.get('SELECT * FROM debts WHERE id = ?', [id], (err, debt) => {
    if (err) return cb(err);
    if (!debt) return cb(new Error('المديونية غير موجودة'));
    if (debt.status === 'paid') return cb(new Error('تم تسديد هذه المديونية مسبقاً'));

    db.get('SELECT id FROM shifts WHERE status = ?', ['active'], (err2, activeShift) => {
      if (err2) return cb(err2);
      if (!activeShift) return cb(new Error('لا يوجد شيفت نشط لتسجيل السداد'));

      const paidAt = Date.now();
      db.run(
        'UPDATE debts SET status = ?, paid_at = ?, paid_shift_id = ? WHERE id = ?',
        ['paid', paidAt, activeShift.id, id],
        cb
      );
    });
  });
}

// أوامر IPC للمديونيات
ipcMain.handle('debts-add', async (event, debt) => {
  return new Promise((resolve) => {
    addDebt(debt, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else {
        if (debt.client_id) {
          db.get('SELECT name FROM clients WHERE id = ?', [debt.client_id], (ec, client) => {
            notifyTelegram(`💸 <b>دين جديد</b>\nالعميل: ${client?.name || debt.client_name || 'بدون'}\nالمبلغ: ${debt.amount || 0} ج.م`);
            resolve({ success: true });
          });
        } else {
          notifyTelegram(`💸 <b>دين جديد</b>\nالعميل: ${debt.client_name || 'بدون'}\nالمبلغ: ${debt.amount || 0} ج.م`);
          resolve({ success: true });
        }
      }
    });
  });
});
ipcMain.handle('debts-get-all', async () => {
  return new Promise((resolve) => {
    getDebts((err, rows) => {
      if (err) resolve({ success: false, error: err.message, data: [] });
      else resolve({ success: true, data: rows });
    });
  });
});
ipcMain.handle('debts-update', async (event, debt) => {
  return new Promise((resolve) => {
    updateDebt(debt, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});
ipcMain.handle('debts-delete', async (event, id) => {
  return new Promise((resolve) => {
    deleteDebt(id, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});
ipcMain.handle('debts-mark-paid', async (event, id) => {
  return new Promise((resolve) => {
    db.get('SELECT client_name, amount FROM debts WHERE id = ?', [id], (e, debt) => {
      markDebtAsPaid(id, (err) => {
        if (err) resolve({ success: false, error: err.message });
        else {
          notifyTelegram(`✅ <b>سداد دين</b>\nالعميل: ${debt?.client_name || 'بدون'}\nالمبلغ: ${debt?.amount || 0} ج.م`);
          resolve({ success: true });
        }
      });
    });
  });
});
ipcMain.handle('debts-pay-partial', async (event, { debt_id, amount }) => {
  return new Promise((resolve) => {
    if (!debt_id || !amount || amount <= 0) {
      return resolve({ success: false, error: 'بيانات غير صالحة' });
    }
    db.get('SELECT * FROM debts WHERE id = ?', [debt_id], (err, debt) => {
      if (err) return resolve({ success: false, error: err.message });
      if (!debt) return resolve({ success: false, error: 'المديونية غير موجودة' });
      if (debt.status === 'paid') return resolve({ success: false, error: 'تم تسديد هذه المديونية مسبقاً' });

      const payAmount = Math.min(amount, debt.amount);

      if (payAmount >= debt.amount) {
        db.get('SELECT id FROM shifts WHERE status = ?', ['active'], (err2, activeShift) => {
          if (err2) return resolve({ success: false, error: err2.message });
          if (!activeShift) return resolve({ success: false, error: 'لا يوجد شيفت نشط لتسجيل السداد' });
          db.run('UPDATE debts SET status = ?, paid_at = ?, paid_shift_id = ? WHERE id = ?',
            ['paid', Date.now(), activeShift.id, debt_id], (err3) => {
              if (err3) return resolve({ success: false, error: err3.message });
              notifyTelegram(`✅ <b>سداد دين</b>\nالعميل: ${debt.client_name || 'بدون'}\nالمبلغ: ${payAmount} ج.م (سداد كامل)`);
              resolve({ success: true });
            });
        });
      } else {
        const remaining = debt.amount - payAmount;
        db.run('UPDATE debts SET amount = ? WHERE id = ?', [remaining, debt_id], (err3) => {
          if (err3) return resolve({ success: false, error: err3.message });
          notifyTelegram(`🔄 <b>سداد جزئي للدين</b>\nالعميل: ${debt.client_name || 'بدون'}\nالمدفوع: ${payAmount} ج.م\nالمتبقي: ${remaining} ج.م`);
          resolve({ success: true });
        });
      }
    });
  });
});

// الأمانة (ودائع العملاء)
function addTrustDeposit({ client_id, client_name, phone, amount, date }, cb) {
  const depositDate = date || Date.now();
  const numericAmount = Number(amount);
  if (isNaN(numericAmount) || numericAmount <= 0) {
    return cb(new Error('المبلغ غير صالح'));
  }

  if (client_id) {
    db.get('SELECT name, phone FROM clients WHERE id = ?', [client_id], (err, client) => {
      if (err) return cb(err);
      if (!client) return cb(new Error('العميل غير موجود'));
      db.run(
        'INSERT INTO trust_deposits (client_id, client_name, phone, amount, date) VALUES (?, ?, ?, ?, ?)',
        [client_id, client.name, client.phone || phone || null, numericAmount, depositDate],
        cb
      );
    });
  } else if (client_name && typeof client_name === 'string' && client_name.trim()) {
    db.run(
      'INSERT INTO trust_deposits (client_id, client_name, phone, amount, date) VALUES (?, ?, ?, ?, ?)',
      [null, client_name.trim(), phone || null, numericAmount, depositDate],
      cb
    );
  } else {
    return cb(new Error('اسم العميل مطلوب'));
  }
}

function getTrustDeposits(cb) {
  db.all('SELECT * FROM trust_deposits ORDER BY date DESC, id DESC', cb);
}

function deleteTrustDeposit(id, cb) {
  db.run('DELETE FROM trust_deposits WHERE id = ?', [id], cb);
}

ipcMain.handle('trust-add', async (event, data) => {
  return new Promise((resolve) => {
    addTrustDeposit(data, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else {
        const clientName = data.client_id ? null : (data.client_name || 'بدون');
        if (data.client_id) {
          db.get('SELECT name FROM clients WHERE id = ?', [data.client_id], (ec, client) => {
            notifyTelegram(`🔒 <b>أمانة جديدة</b>\nالعميل: ${client?.name || 'بدون'}\nرقم الهاتف: ${data.phone || '-'}\nالمبلغ: ${data.amount || 0} ج.م`);
            resolve({ success: true });
          });
        } else {
          notifyTelegram(`🔒 <b>أمانة جديدة</b>\nالعميل: ${clientName}\nرقم الهاتف: ${data.phone || '-'}\nالمبلغ: ${data.amount || 0} ج.م`);
          resolve({ success: true });
        }
      }
    });
  });
});
ipcMain.handle('trust-get-all', async () => {
  return new Promise((resolve) => {
    getTrustDeposits((err, rows) => {
      if (err) resolve({ success: false, error: err.message, data: [] });
      else resolve({ success: true, data: rows });
    });
  });
});
ipcMain.handle('trust-delete', async (event, id) => {
  return new Promise((resolve) => {
    deleteTrustDeposit(id, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});
function getSessionProducts(session_id, cb) {
  db.all('SELECT sp.*, p.name FROM session_products sp LEFT JOIN products p ON sp.product_id = p.id WHERE sp.session_id = ?', [session_id], cb);
}

// أوامر IPC لمبيعات المنتجات المرتبطة بجلسة
ipcMain.handle('add-product-to-session', async (event, data) => {
  return new Promise((resolve, reject) => {
    addProductToSession(data, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});
ipcMain.handle('get-session-products', async (event, session_id) => {
  return new Promise((resolve, reject) => {
    getSessionProducts(session_id, (err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});

// تحديث كمية منتج في الجلسة
function updateSessionProductQty(sessionProductId, qty, cb) {
  db.get('SELECT product_id, quantity, price FROM session_products WHERE id = ?', [sessionProductId], (err, row) => {
    if (err || !row) return cb(err || new Error('المنتج غير موجود'));
    
    const { product_id, quantity: oldQuantity, price } = row;
    const quantityDifference = qty - oldQuantity;
    const total = price * qty;
    
    // تحديث الكمية في الجلسة
    db.run('UPDATE session_products SET quantity = ?, total = ? WHERE id = ?', [qty, total, sessionProductId], (err) => {
      if (err) return cb(err);
      
      if (quantityDifference !== 0) {
        if (quantityDifference > 0) {
          // زيادة الكمية - خصم من المخزون
          restoreProductComponents(product_id, quantityDifference, (err2) => {
            if (err2) return cb(err2);
            
            db.run('UPDATE products SET quantity = quantity - ? WHERE id = ?', [quantityDifference, product_id], (err3) => {
              if (err3) return cb(err3);
              cb();
            });
          });
        } else {
          // تقليل الكمية - إرجاع للمخزون
          const restoreAmount = Math.abs(quantityDifference);
          restoreProductComponents(product_id, restoreAmount, (err2) => {
            if (err2) return cb(err2);
            
            db.run('UPDATE products SET quantity = quantity + ? WHERE id = ?', [restoreAmount, product_id], (err3) => {
              if (err3) return cb(err3);
              cb();
            });
          });
        }
      } else {
        cb();
      }
    });
  });
}
// حذف منتج من الجلسة
function deleteSessionProduct(sessionProductId, cb) {
  // جلب بيانات المنتج قبل الحذف لإرجاع الكمية والمكونات
  db.get('SELECT product_id, quantity FROM session_products WHERE id = ?', [sessionProductId], (err, row) => {
    if (err) return cb(err);
    if (!row) return cb(new Error('المنتج غير موجود'));
    
    const { product_id, quantity } = row;
    
    // حذف المنتج من الجلسة
    db.run('DELETE FROM session_products WHERE id = ?', [sessionProductId], (err) => {
      if (err) return cb(err);
      
      // إرجاع المكونات للمخزون
      restoreProductComponents(product_id, quantity, (err2) => {
        if (err2) return cb(err2);
        
        // إرجاع الكمية للمنتج
        db.run('UPDATE products SET quantity = quantity + ? WHERE id = ?', [quantity, product_id], (err3) => {
          if (err3) return cb(err3);
          cb();
        });
      });
    });
  });
}
// أوامر IPC
ipcMain.handle('update-session-product-qty', async (event, { sessionProductId, qty }) => {
  return new Promise((resolve, reject) => {
    updateSessionProductQty(sessionProductId, qty, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});
ipcMain.handle('delete-session-product', async (event, sessionProductId) => {
  return new Promise((resolve, reject) => {
    deleteSessionProduct(sessionProductId, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

// دوال المبيعات المنفصلة
function addStandaloneSale({ product_id, quantity, price }, cb) {
  // التحقق من توفر المكونات أولاً
  checkProductComponentsAvailability(product_id, quantity, (err, availability) => {
    if (err) return cb(err);
    
    if (!availability.available) {
      const unavailableComponents = availability.unavailable.map(comp => 
        `${comp.component_name}: متوفر ${comp.available || 0}، مطلوب ${comp.total_required}`
      ).join(', ');
      return cb(new Error(`لا يمكن البيع - المكونات غير متوفرة: ${unavailableComponents}`));
    }
    
    const total = price * quantity;
    const date = Date.now();
    db.run('INSERT INTO standalone_sales (product_id, quantity, price, total, date) VALUES (?, ?, ?, ?, ?)', [product_id, quantity, price, total, date], function (err) {
      if (err) return cb(err);
      
      // خصم المكونات من المخزون
      deductProductComponents(product_id, quantity, (err2) => {
        if (err2) return cb(err2);
        
        // خصم الكمية من المنتج (إذا كان له مخزون)
        db.run('UPDATE products SET quantity = quantity - ? WHERE id = ?', [quantity, product_id], function (err3) {
          if (err3) return cb(err3);
          cb();
        });
      });
    });
  });
}
function getStandaloneSales(cb) {
  db.all('SELECT s.*, p.name FROM standalone_sales s LEFT JOIN products p ON s.product_id = p.id ORDER BY s.date DESC', cb);
}

function updateStandaloneSale(saleId, updates, cb) {
  const { quantity, total } = updates;
  
  // جلب المبيعة الحالية
  db.get('SELECT * FROM standalone_sales WHERE id = ?', [saleId], (err, sale) => {
    if (err) return cb(err);
    if (!sale) return cb(new Error('المبيعة غير موجودة'));
    
    // تحديث المبيعة
    db.run('UPDATE standalone_sales SET quantity = ?, total = ? WHERE id = ?', 
      [quantity, total, saleId], function(err) {
        if (err) return cb(err);
        
        // تحديث كمية المنتج
        const quantityDifference = quantity - sale.quantity;
        db.run('UPDATE products SET quantity = quantity + ? WHERE id = ?', 
          [quantityDifference, sale.product_id], function(err2) {
            if (err2) return cb(err2);
            cb(null);
          });
      });
  });
}

function deleteStandaloneSale(saleId, cb) {
  // جلب المبيعة الحالية
  db.get('SELECT * FROM standalone_sales WHERE id = ?', [saleId], (err, sale) => {
    if (err) return cb(err);
    if (!sale) return cb(new Error('المبيعة غير موجودة'));
    
    // إرجاع الكمية للمنتج
    db.run('UPDATE products SET quantity = quantity + ? WHERE id = ?', 
      [sale.quantity, sale.product_id], function(err2) {
        if (err2) return cb(err2);
        
        // حذف المبيعة
        db.run('DELETE FROM standalone_sales WHERE id = ?', [saleId], function(err3) {
          if (err3) return cb(err3);
          cb(null);
        });
      });
  });
}

// دوال المصروفات
function addExpense(expense, cb) {
  db.run('INSERT INTO expenses (title, amount, frequency, date, created_by, shift_id) VALUES (?, ?, ?, ?, ?, ?)',
    [expense.title, expense.amount, expense.frequency, expense.date || Date.now(), expense.created_by || null, expense.shift_id || null], cb);
}

function updateExpense(expense, cb) {
  db.run('UPDATE expenses SET title = ?, amount = ?, frequency = ?, date = ?, shift_id = ? WHERE id = ?',
    [expense.title, expense.amount, expense.frequency, expense.date, expense.shift_id || null, expense.id], cb);
}

function deleteExpense(expenseId, cb) {
  db.run('DELETE FROM expenses WHERE id = ?', [expenseId], cb);
}

function getExpenses(cb) {
  db.all('SELECT * FROM expenses ORDER BY date DESC', cb);
}

function getExpensesByDateRange(startDate, endDate, cb) {
  db.all('SELECT * FROM expenses WHERE date >= ? AND date <= ? ORDER BY date DESC', [startDate, endDate], cb);
}

function getExpensesByCategory(category, cb) {
  db.all('SELECT * FROM expenses WHERE category = ? ORDER BY date DESC', [category], cb);
}

function getExpensesByShift(shift_id, cb) {
  db.all('SELECT * FROM expenses WHERE shift_id = ? ORDER BY date DESC', [shift_id], cb);
}

// دالة لحساب إحصائيات المنتجات في الشيفت
function getShiftProductsStats(shift_id, cb) {
  console.log('📦 حساب إحصائيات المنتجات للشيفت:', shift_id);
  
  // جلب بيانات الشيفت أولاً
  db.get('SELECT * FROM shifts WHERE id = ?', [shift_id], (err, shift) => {
    if (err) {
      console.error('❌ خطأ في جلب بيانات الشيفت:', err);
      return cb(err);
    }
    
    if (!shift) {
      return cb(new Error('الشيفت غير موجود'));
    }
    
    // جلب المنتجات المباعة في الجلسات خلال الشيفت
    db.all(`SELECT sp.*, p.name as product_name, p.price as product_price 
            FROM session_products sp
            LEFT JOIN products p ON sp.product_id = p.id
            LEFT JOIN sessions s ON sp.session_id = s.id
            WHERE s.start_time >= ? AND s.start_time <= ? AND s.is_active = 0`,
            [shift.start_time, shift.end_time || Date.now()], (err, sessionProducts) => {
      if (err) {
        console.error('❌ خطأ في جلب منتجات الجلسات:', err);
        return cb(err);
      }
      
      // جلب المبيعات المنفردة للمنتجات خلال الشيفت
      db.all(`SELECT ss.*, p.name as product_name, p.price as product_price 
              FROM standalone_sales ss
              LEFT JOIN products p ON ss.product_id = p.id
              WHERE ss.date >= ? AND ss.date <= ?`,
              [shift.start_time, shift.end_time || Date.now()], (err, standaloneProducts) => {
        if (err) {
          console.error('❌ خطأ في جلب المبيعات المنفردة:', err);
          return cb(err);
        }
        
        // حساب إحصائيات المنتجات في الجلسات
        const sessionProductsStats = {};
        let totalSessionProductsRevenue = 0;
        let totalSessionProductsQuantity = 0;
        
        sessionProducts.forEach(item => {
          const productName = item.product_name || 'منتج غير محدد';
          if (!sessionProductsStats[productName]) {
            sessionProductsStats[productName] = {
              name: productName,
              quantity: 0,
              revenue: 0,
              sessions_count: 0
            };
          }
          sessionProductsStats[productName].quantity += item.quantity || 0;
          sessionProductsStats[productName].revenue += item.total || 0;
          sessionProductsStats[productName].sessions_count += 1;
          totalSessionProductsRevenue += item.total || 0;
          totalSessionProductsQuantity += item.quantity || 0;
        });
        
        // حساب إحصائيات المبيعات المنفردة
        const standaloneProductsStats = {};
        let totalStandaloneRevenue = 0;
        let totalStandaloneQuantity = 0;
        
        standaloneProducts.forEach(item => {
          const productName = item.product_name || 'منتج غير محدد';
          if (!standaloneProductsStats[productName]) {
            standaloneProductsStats[productName] = {
              name: productName,
              quantity: 0,
              revenue: 0,
              sales_count: 0
            };
          }
          standaloneProductsStats[productName].quantity += item.quantity || 0;
          standaloneProductsStats[productName].revenue += item.total || 0;
          standaloneProductsStats[productName].sales_count += 1;
          totalStandaloneRevenue += item.total || 0;
          totalStandaloneQuantity += item.quantity || 0;
        });
        
        // دمج الإحصائيات
        const allProductsStats = {};
        
        // إضافة منتجات الجلسات
        Object.values(sessionProductsStats).forEach(product => {
          allProductsStats[product.name] = {
            ...product,
            type: 'session',
            standalone_quantity: 0,
            standalone_revenue: 0,
            standalone_sales_count: 0
          };
        });
        
        // إضافة أو تحديث منتجات المبيعات المنفردة
        Object.values(standaloneProductsStats).forEach(product => {
          if (allProductsStats[product.name]) {
            allProductsStats[product.name].standalone_quantity = product.quantity;
            allProductsStats[product.name].standalone_revenue = product.revenue;
            allProductsStats[product.name].standalone_sales_count = product.sales_count;
            allProductsStats[product.name].type = 'both';
          } else {
            allProductsStats[product.name] = {
              ...product,
              type: 'standalone',
              quantity: 0,
              revenue: 0,
              sessions_count: 0
            };
          }
        });
        
        const result = {
          shift_id: shift_id,
          shift_start: shift.start_time,
          shift_end: shift.end_time,
          session_products: sessionProductsStats,
          standalone_products: standaloneProductsStats,
          all_products: allProductsStats,
          totals: {
            session_products_revenue: totalSessionProductsRevenue,
            session_products_quantity: totalSessionProductsQuantity,
            standalone_revenue: totalStandaloneRevenue,
            standalone_quantity: totalStandaloneQuantity,
            total_revenue: totalSessionProductsRevenue + totalStandaloneRevenue,
            total_quantity: totalSessionProductsQuantity + totalStandaloneQuantity,
            unique_products: Object.keys(allProductsStats).length
          }
        };
        
        console.log('✅ تم حساب إحصائيات المنتجات:', result.totals);
        cb(null, result);
      });
    });
  });
}

// دالة لحساب إحصائيات الجلسات في الشيفت
function getShiftSessionsStats(shift_id, cb) {
  console.log('🎮 حساب إحصائيات الجلسات للشيفت:', shift_id);
  
  // جلب بيانات الشيفت أولاً
  db.get('SELECT * FROM shifts WHERE id = ?', [shift_id], (err, shift) => {
    if (err) {
      console.error('❌ خطأ في جلب بيانات الشيفت:', err);
      return cb(err);
    }
    
    if (!shift) {
      return cb(new Error('الشيفت غير موجود'));
    }
    
    // جلب الجلسات في الشيفت (تُحسب للشيفت الذي أنهى الجلسة)
    db.all(`SELECT s.*, d.name as device_name 
            FROM sessions s
            LEFT JOIN devices d ON s.device_id = d.id
            WHERE s.end_time >= ? AND s.end_time <= ? AND s.is_active = 0`,
            [shift.start_time, shift.end_time || Date.now()], (err, sessions) => {
      if (err) {
        console.error('❌ خطأ في جلب الجلسات:', err);
        return cb(err);
      }
      
      // حساب إحصائيات الجلسات
      let totalRevenue = 0;
      let totalDuration = 0;
      let totalSessions = sessions.length;
      let activeSessions = 0;
      let completedSessions = 0;
      
      const deviceStats = {};
      const modeStats = { single: 0, double: 0 };
      const typeStats = { timed: 0, open: 0 };
      
      sessions.forEach(session => {
        const discountedTotal = Math.max(0, (session.total || 0) - (session.discount_amount || 0));
        totalRevenue += discountedTotal;
        totalDuration += session.end_time ? (session.end_time - session.start_time) : 0;
        
        if (session.is_active) activeSessions++;
        else completedSessions++;
        
        // إحصائيات الأجهزة
        const deviceName = session.device_name || 'جهاز غير محدد';
        if (!deviceStats[deviceName]) {
          deviceStats[deviceName] = {
            name: deviceName,
            sessions_count: 0,
            revenue: 0,
            duration: 0
          };
        }
        deviceStats[deviceName].sessions_count += 1;
        deviceStats[deviceName].revenue += discountedTotal;
        deviceStats[deviceName].duration += session.end_time ? (session.end_time - session.start_time) : 0;
        
        // إحصائيات النمط
        if (session.mode === 'single') modeStats.single++;
        else if (session.mode === 'double') modeStats.double++;
        
        // إحصائيات النوع
        if (session.type === 'timed') typeStats.timed++;
        else if (session.type === 'open') typeStats.open++;
      });
      
      db.get(`SELECT COALESCE(SUM(amount),0) as trust_total, COUNT(*) as trust_count
              FROM trust_deposits WHERE date >= ? AND date <= ?`,
        [shift.start_time, shift.end_time || Date.now()], (err, trustResult) => {
        if (err) {
          console.error('❌ خطأ في حساب الأمانات:', err);
          return cb(err);
        }
        const trustDepositsTotal = Number(trustResult?.trust_total) || 0;
        const trustDepositsCount = Number(trustResult?.trust_count) || 0;

        // حساب المتوسطات
        const averageSessionDuration = totalSessions > 0 ? totalDuration / totalSessions : 0;
        const averageSessionRevenue = totalSessions > 0 ? totalRevenue / totalSessions : 0;
        const averageHourlyRevenue = totalDuration > 0 ? (totalRevenue / (totalDuration / (1000 * 60 * 60))) : 0;
        
        const result = {
          shift_id: shift_id,
          shift_start: shift.start_time,
          shift_end: shift.end_time,
          totals: {
            total_sessions: totalSessions,
            active_sessions: activeSessions,
            completed_sessions: completedSessions,
            total_revenue: totalRevenue,
            total_duration_ms: totalDuration,
            total_duration_hours: totalDuration / (1000 * 60 * 60),
            average_session_duration_ms: averageSessionDuration,
            average_session_duration_hours: averageSessionDuration / (1000 * 60 * 60),
            average_session_revenue: averageSessionRevenue,
            average_hourly_revenue: averageHourlyRevenue,
            trust_deposits_total: trustDepositsTotal,
            trust_deposits_count: trustDepositsCount
          },
          device_stats: deviceStats,
          mode_stats: modeStats,
          type_stats: typeStats,
          sessions: sessions
        };
        
        console.log('✅ تم حساب إحصائيات الجلسات:', result.totals);
        cb(null, result);
      });
    });
  });
}

// دالة لحساب إحصائيات البيع السريع في الشيفت
function getShiftStandaloneSalesStats(shift_id, cb) {
  console.log('⚡ حساب إحصائيات البيع السريع للشيفت:', shift_id);
  
  // جلب بيانات الشيفت أولاً
  db.get('SELECT * FROM shifts WHERE id = ?', [shift_id], (err, shift) => {
    if (err) {
      console.error('❌ خطأ في جلب بيانات الشيفت:', err);
      return cb(err);
    }
    
    if (!shift) {
      return cb(new Error('الشيفت غير موجود'));
    }
    
    // جلب المبيعات المنفردة في الشيفت
    db.all(`SELECT ss.*, p.name as product_name, p.price as product_price, p.category as product_category 
            FROM standalone_sales ss
            LEFT JOIN products p ON ss.product_id = p.id
            WHERE ss.date >= ? AND ss.date <= ?`,
            [shift.start_time, shift.end_time || Date.now()], (err, standaloneSales) => {
      if (err) {
        console.error('❌ خطأ في جلب المبيعات المنفردة:', err);
        return cb(err);
      }
      
      // حساب إحصائيات المبيعات المنفردة
      let totalRevenue = 0;
      let totalQuantity = 0;
      let totalSales = standaloneSales.length;
      
      const productStats = {};
      const hourlyStats = {};
      
      standaloneSales.forEach(sale => {
        totalRevenue += sale.total || 0;
        totalQuantity += sale.quantity || 0;
        
        // إحصائيات المنتجات
        const productName = sale.product_name || 'منتج غير محدد';
        if (!productStats[productName]) {
          productStats[productName] = {
            name: productName,
            sales_count: 0,
            quantity: 0,
            revenue: 0,
            average_price: 0
          };
        }
        productStats[productName].sales_count += 1;
        productStats[productName].quantity += sale.quantity || 0;
        productStats[productName].revenue += sale.total || 0;
        
        // إحصائيات الساعة
        const saleHour = new Date(sale.date).getHours();
        if (!hourlyStats[saleHour]) {
          hourlyStats[saleHour] = {
            hour: saleHour,
            sales_count: 0,
            revenue: 0,
            quantity: 0
          };
        }
        hourlyStats[saleHour].sales_count += 1;
        hourlyStats[saleHour].revenue += sale.total || 0;
        hourlyStats[saleHour].quantity += sale.quantity || 0;
      });
      
      // حساب متوسطات المنتجات
      Object.values(productStats).forEach(product => {
        product.average_price = product.quantity > 0 ? product.revenue / product.quantity : 0;
      });
      
      // حساب المتوسطات العامة
      const averageSaleValue = totalSales > 0 ? totalRevenue / totalSales : 0;
      const averageQuantityPerSale = totalSales > 0 ? totalQuantity / totalSales : 0;
      
      // ترتيب المنتجات حسب الإيرادات
      const topProducts = Object.values(productStats)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10);
      
      // ترتيب الساعات حسب الإيرادات
      const topHours = Object.values(hourlyStats)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5);
      
      const result = {
        shift_id: shift_id,
        shift_start: shift.start_time,
        shift_end: shift.end_time,
        totals: {
          total_sales: totalSales,
          total_revenue: totalRevenue,
          total_quantity: totalQuantity,
          average_sale_value: averageSaleValue,
          average_quantity_per_sale: averageQuantityPerSale,
          unique_products: Object.keys(productStats).length
        },
        product_stats: productStats,
        hourly_stats: hourlyStats,
        top_products: topProducts,
        top_hours: topHours,
        sales: standaloneSales
      };
      
      console.log('✅ تم حساب إحصائيات البيع السريع:', result.totals);
      cb(null, result);
    });
  });
}

// دالة شاملة لجلب جميع الإحصائيات التفصيلية للشيفت
function getShiftDetailedStats(shift_id, cb) {
  console.log('📊 حساب جميع الإحصائيات التفصيلية للشيفت:', shift_id);
  
  // جلب بيانات الشيفت أولاً
  db.get('SELECT * FROM shifts WHERE id = ?', [shift_id], (err, shift) => {
    if (err) {
      console.error('❌ خطأ في جلب بيانات الشيفت:', err);
      return cb(err);
    }
    
    if (!shift) {
      return cb(new Error('الشيفت غير موجود'));
    }
    
    // جلب جميع الإحصائيات بالتوازي
    let completed = 0;
    const total = 5;
    const results = {};
    
    function checkComplete() {
      completed++;
      if (completed === total) {
        // دمج جميع النتائج
        const employeeWagesTotal = results.wages?.reduce((s, w) => s + (w.total_amount || 0), 0) || 0;
        const detailedStats = {
          shift_id: shift_id,
          shift: shift,
          products_stats: results.products || null,
          sessions_stats: results.sessions || null,
          standalone_sales_stats: results.standalone || null,
          expenses_stats: results.expenses || null,
          employee_wages: results.wages || [],
          summary: {
            total_revenue: (results.sessions?.totals?.total_revenue || 0) + (results.products?.totals?.total_revenue || 0) + (results.sessions?.totals?.trust_deposits_total || 0),
            trust_deposits_total: results.sessions?.totals?.trust_deposits_total || 0,
            trust_deposits_count: results.sessions?.totals?.trust_deposits_count || 0,
            total_expenses: (results.expenses?.total_expenses || 0) + employeeWagesTotal,
            employee_wages_total: employeeWagesTotal,
            net_profit: ((results.sessions?.totals?.total_revenue || 0) + (results.products?.totals?.total_revenue || 0) + (results.sessions?.totals?.trust_deposits_total || 0)) - ((results.expenses?.total_expenses || 0) + employeeWagesTotal),
            total_sessions: results.sessions?.totals?.total_sessions || 0,
            total_standalone_sales: results.standalone?.totals?.total_sales || 0,
            total_products_sold: (results.products?.totals?.total_quantity || 0),
            unique_products: results.products?.totals?.unique_products || 0,
            shift_duration_hours: shift.end_time ? ((shift.end_time - shift.start_time) / (1000 * 60 * 60)) : null
          }
        };
        
        console.log('✅ تم حساب جميع الإحصائيات التفصيلية:', detailedStats.summary);
        cb(null, detailedStats);
      }
    }
    
    // جلب إحصائيات المنتجات
    getShiftProductsStats(shift_id, (err, productsStats) => {
      if (err) console.error('❌ خطأ في إحصائيات المنتجات:', err);
      results.products = productsStats;
      checkComplete();
    });
    
    // جلب إحصائيات الجلسات
    getShiftSessionsStats(shift_id, (err, sessionsStats) => {
      if (err) console.error('❌ خطأ في إحصائيات الجلسات:', err);
      results.sessions = sessionsStats;
      checkComplete();
    });
    
    // جلب إحصائيات البيع السريع
    getShiftStandaloneSalesStats(shift_id, (err, standaloneStats) => {
      if (err) console.error('❌ خطأ في إحصائيات البيع السريع:', err);
      results.standalone = standaloneStats;
      checkComplete();
    });
    
    // جلب إحصائيات المصروفات
    getShiftExpenses(shift_id, (err, expensesStats) => {
      if (err) console.error('❌ خطأ في إحصائيات المصروفات:', err);
      results.expenses = expensesStats;
      checkComplete();
    });
    
    // جلب صرف اليومية للموظفين في تاريخ الشيفت
    getShiftEmployeeWages(shift_id, (err, wages) => {
      if (err) console.error('❌ خطأ في جلب صرف اليومية:', err);
      results.wages = wages || [];
      checkComplete();
    });
  });
}

function getShiftEmployeeWages(shift_id, cb) {
  db.get('SELECT start_time, end_time FROM shifts WHERE id = ?', [shift_id], (err, shift) => {
    if (err || !shift) return cb(err || new Error('الشيفت غير موجود'));
    const startDate = new Date(shift.start_time);
    const endDate = new Date(shift.end_time || Date.now());
    const fmt = d => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    const startStr = fmt(startDate);
    const endStr = fmt(endDate);
    db.all(`SELECT ep.*, u.username FROM employee_payments ep LEFT JOIN users u ON ep.user_id = u.id WHERE ep.payment_date >= ? AND ep.payment_date <= ? ORDER BY ep.created_at`,
      [startStr, endStr], cb);
  });
}

function getExpenseCategories(cb) {
  db.all('SELECT DISTINCT category FROM expenses WHERE category IS NOT NULL AND category != ""', cb);
}

function getTotalExpenses(startDate = null, endDate = null, cb) {
  let query = 'SELECT SUM(amount) as total FROM expenses';
  let params = [];

  if (startDate && endDate) {
    query += ' WHERE date >= ? AND date <= ?';
    params = [startDate, endDate];
  }

  db.get(query, params, cb);
}

function getTotalExpensesByFrequency(frequency, startDate = null, endDate = null, cb) {
  let query = 'SELECT SUM(amount) as total FROM expenses WHERE frequency = ?';
  let params = [frequency];

  if (startDate && endDate) {
    query += ' AND date >= ? AND date <= ?';
    params.push(startDate, endDate);
  }

  db.get(query, params, cb);
}

// دالة لحساب المصروفات في شيفت محدد
function getShiftExpenses(shift_id, cb) {
  console.log('💰 حساب المصروفات للشيفت:', shift_id);
  
  // جلب بيانات الشيفت أولاً
  db.get('SELECT * FROM shifts WHERE id = ?', [shift_id], (err, shift) => {
    if (err) {
      console.error('❌ خطأ في جلب بيانات الشيفت:', err);
      return cb(err);
    }
    
    if (!shift) {
      return cb(new Error('الشيفت غير موجود'));
    }
    
    // جلب المصروفات المرتبطة بالشيفت مباشرة
    db.all(`SELECT * FROM expenses 
            WHERE shift_id = ? 
            ORDER BY date DESC`, 
            [shift_id], (err, expenses) => {
      if (err) {
        console.error('❌ خطأ في جلب المصروفات:', err);
        return cb(err);
      }
      
      // حساب إجمالي المصروفات
      const totalExpenses = expenses.reduce((sum, expense) => sum + (expense.amount || 0), 0);
      
      // حساب المصروفات حسب الفئة
      const expensesByCategory = {};
      expenses.forEach(expense => {
        const category = expense.category || 'غير محدد';
        if (!expensesByCategory[category]) {
          expensesByCategory[category] = {
            total: 0,
            count: 0,
            items: []
          };
        }
        expensesByCategory[category].total += expense.amount || 0;
        expensesByCategory[category].count += 1;
        expensesByCategory[category].items.push(expense);
      });
      
      // حساب المصروفات حسب التكرار
      const expensesByFrequency = {};
      expenses.forEach(expense => {
        const frequency = expense.frequency || 'غير محدد';
        if (!expensesByFrequency[frequency]) {
          expensesByFrequency[frequency] = {
            total: 0,
            count: 0
          };
        }
        expensesByFrequency[frequency].total += expense.amount || 0;
        expensesByFrequency[frequency].count += 1;
      });
      
      const result = {
        shift_id: shift_id,
        shift_start: shift.start_time,
        shift_end: shift.end_time,
        total_expenses: totalExpenses,
        expenses_count: expenses.length,
        expenses: expenses,
        expenses_by_category: expensesByCategory,
        expenses_by_frequency: expensesByFrequency,
        shift_duration_hours: shift.end_time ? 
          ((shift.end_time - shift.start_time) / (1000 * 60 * 60)) : null
      };
      
      console.log('✅ تم حساب مصروفات الشيفت:', {
        shift_id,
        total_expenses: totalExpenses,
        expenses_count: expenses.length
      });
      
      cb(null, result);
    });
  });
}

// دالة لحساب المصروفات لجميع الشيفتات
function getAllShiftsExpenses(cb) {
  console.log('📊 حساب المصروفات لجميع الشيفتات...');
  
  // جلب جميع الشيفتات
  db.all('SELECT * FROM shifts ORDER BY start_time DESC', (err, shifts) => {
    if (err) {
      console.error('❌ خطأ في جلب الشيفتات:', err);
      return cb(err);
    }
    
    let totalExpenses = 0;
    let totalShifts = shifts.length;
    let shiftsWithExpenses = 0;
    const shiftsExpenses = [];
    
    // معالجة كل شيفت
    let processedShifts = 0;
    
    if (shifts.length === 0) {
      return cb(null, {
        total_shifts: 0,
        total_expenses: 0,
        shifts_with_expenses: 0,
        shifts_expenses: []
      });
    }
    
    shifts.forEach((shift, index) => {
      // جلب المصروفات المرتبطة بالشيفت مباشرة
      db.all(`SELECT * FROM expenses 
              WHERE shift_id = ?`, 
              [shift.id], (err, expenses) => {
        if (err) {
          console.error(`❌ خطأ في جلب مصروفات الشيفت ${shift.id}:`, err);
          processedShifts++;
          if (processedShifts === shifts.length) {
            cb(null, {
              total_shifts: totalShifts,
              total_expenses: totalExpenses,
              shifts_with_expenses: shiftsWithExpenses,
              shifts_expenses: shiftsExpenses
            });
          }
          return;
        }
        
        const shiftTotalExpenses = expenses.reduce((sum, expense) => sum + (expense.amount || 0), 0);
        
        if (shiftTotalExpenses > 0) {
          shiftsWithExpenses++;
        }
        
        totalExpenses += shiftTotalExpenses;
        
        shiftsExpenses.push({
          shift_id: shift.id,
          shift_start: shift.start_time,
          shift_end: shift.end_time,
          total_expenses: shiftTotalExpenses,
          expenses_count: expenses.length,
          expenses: expenses
        });
        
        processedShifts++;
        
        if (processedShifts === shifts.length) {
          console.log('✅ تم حساب مصروفات جميع الشيفتات:', {
            total_shifts: totalShifts,
            total_expenses: totalExpenses,
            shifts_with_expenses: shiftsWithExpenses
          });
          
          cb(null, {
            total_shifts: totalShifts,
            total_expenses: totalExpenses,
            shifts_with_expenses: shiftsWithExpenses,
            shifts_expenses: shiftsExpenses
          });
        }
      });
    });
  });
}

// دالة لحساب إحصائيات المصروفات
function getExpensesStatistics(startDate = null, endDate = null, cb) {
  console.log('📈 حساب إحصائيات المصروفات...');
  
  let query = 'SELECT * FROM expenses';
  let params = [];
  
  if (startDate && endDate) {
    query += ' WHERE date >= ? AND date <= ?';
    params = [startDate, endDate];
  }
  
  query += ' ORDER BY date DESC';
  
  db.all(query, params, (err, expenses) => {
    if (err) {
      console.error('❌ خطأ في جلب المصروفات:', err);
      return cb(err);
    }
    
    const totalExpenses = expenses.reduce((sum, expense) => sum + (expense.amount || 0), 0);
    
    // حساب المصروفات حسب الفئة
    const expensesByCategory = {};
    expenses.forEach(expense => {
      const category = expense.category || 'غير محدد';
      if (!expensesByCategory[category]) {
        expensesByCategory[category] = {
          total: 0,
          count: 0,
          percentage: 0
        };
      }
      expensesByCategory[category].total += expense.amount || 0;
      expensesByCategory[category].count += 1;
    });
    
    // حساب النسب المئوية
    Object.keys(expensesByCategory).forEach(category => {
      expensesByCategory[category].percentage = totalExpenses > 0 ? 
        ((expensesByCategory[category].total / totalExpenses) * 100).toFixed(2) : 0;
    });
    
    // حساب المصروفات حسب التكرار
    const expensesByFrequency = {};
    expenses.forEach(expense => {
      const frequency = expense.frequency || 'غير محدد';
      if (!expensesByFrequency[frequency]) {
        expensesByFrequency[frequency] = {
          total: 0,
          count: 0,
          percentage: 0
        };
      }
      expensesByFrequency[frequency].total += expense.amount || 0;
      expensesByFrequency[frequency].count += 1;
    });
    
    // حساب النسب المئوية للتكرار
    Object.keys(expensesByFrequency).forEach(frequency => {
      expensesByFrequency[frequency].percentage = totalExpenses > 0 ? 
        ((expensesByFrequency[frequency].total / totalExpenses) * 100).toFixed(2) : 0;
    });
    
    // حساب متوسط المصروفات
    const averageExpense = expenses.length > 0 ? totalExpenses / expenses.length : 0;
    
    // حساب أكبر وأصغر مصروف
    const maxExpense = expenses.length > 0 ? Math.max(...expenses.map(e => e.amount || 0)) : 0;
    const minExpense = expenses.length > 0 ? Math.min(...expenses.map(e => e.amount || 0)) : 0;
    
    const statistics = {
      total_expenses: totalExpenses,
      total_count: expenses.length,
      average_expense: averageExpense,
      max_expense: maxExpense,
      min_expense: minExpense,
      expenses_by_category: expensesByCategory,
      expenses_by_frequency: expensesByFrequency,
      date_range: {
        start: startDate,
        end: endDate
      }
    };
    
    console.log('✅ تم حساب إحصائيات المصروفات:', {
      total_expenses: totalExpenses,
      total_count: expenses.length,
      categories_count: Object.keys(expensesByCategory).length
    });
    
    cb(null, statistics);
  });
}

// دوال الصيانة
function addMaintenance(maintenance, cb) {
  db.run('INSERT INTO maintenance (device_id, controller_id, title, description, reported_date, cost, technician, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [maintenance.device_id || null, maintenance.controller_id || null, maintenance.title, maintenance.description || null, maintenance.reported_date || Date.now(), maintenance.cost || null, maintenance.technician || null, maintenance.created_by || null], cb);
}

function updateMaintenance(maintenance, cb) {
  db.run('UPDATE maintenance SET device_id = ?, controller_id = ?, title = ?, description = ?, reported_date = ?, cost = ?, technician = ?, updated_by = ? WHERE id = ?',
    [maintenance.device_id || null, maintenance.controller_id || null, maintenance.title, maintenance.description || null, maintenance.reported_date, maintenance.cost || null, maintenance.technician || null, maintenance.updated_by || null, maintenance.id], cb);
}

function deleteMaintenance(maintenanceId, cb) {
  db.run('DELETE FROM maintenance WHERE id = ?', [maintenanceId], cb);
}

function getMaintenance(cb) {
  db.all('SELECT m.*, d.name as device_name, c.name as controller_name, c.mac as controller_mac FROM maintenance m LEFT JOIN devices d ON m.device_id = d.id LEFT JOIN controllers c ON m.controller_id = c.id ORDER BY m.reported_date DESC', cb);
}

function getMaintenanceByStatus(status, cb) {
  db.all('SELECT m.*, d.name as device_name FROM maintenance m LEFT JOIN devices d ON m.device_id = d.id WHERE m.status = ? ORDER BY m.reported_date DESC', [status], cb);
}

function getMaintenanceByDevice(deviceId, cb) {
  db.all('SELECT m.*, d.name as device_name, c.name as controller_name, c.mac as controller_mac FROM maintenance m LEFT JOIN devices d ON m.device_id = d.id LEFT JOIN controllers c ON m.controller_id = c.id WHERE m.device_id = ? ORDER BY m.reported_date DESC', [deviceId], cb);
}

function getMaintenanceByDateRange(startDate, endDate, cb) {
  db.all('SELECT m.*, d.name as device_name, c.name as controller_name, c.mac as controller_mac FROM maintenance m LEFT JOIN devices d ON m.device_id = d.id LEFT JOIN controllers c ON m.controller_id = c.id WHERE m.reported_date BETWEEN ? AND ? ORDER BY m.reported_date DESC', [startDate, endDate], cb);
}

function getMaintenanceStats(cb) {
  db.all('SELECT status, COUNT(*) as count FROM maintenance GROUP BY status', cb);
}

function getMaintenanceByType(type, cb) {
  db.all('SELECT m.*, d.name as device_name FROM maintenance m LEFT JOIN devices d ON m.device_id = d.id WHERE m.type = ? ORDER BY m.reported_date DESC', [type], cb);
}

// أوامر IPC للمبيعات المنفصلة
ipcMain.handle('add-standalone-sale', async (event, data) => {
  return new Promise((resolve, reject) => {
    addStandaloneSale(data, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});
ipcMain.handle('get-standalone-sales', async () => {
  return new Promise((resolve, reject) => {
    getStandaloneSales((err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});

ipcMain.handle('update-standalone-sale', async (event, { saleId, updates }) => {
  return new Promise((resolve) => {
    updateStandaloneSale(saleId, updates, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('delete-standalone-sale', async (event, saleId) => {
  return new Promise((resolve) => {
    deleteStandaloneSale(saleId, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

function getInternalKidsAreaProductId(cb) {
  db.get(`SELECT id FROM products WHERE category = '__internal_kids_area__' LIMIT 1`, (err, row) => {
    if (err) return cb(err);
    if (!row) return cb(new Error('منتج Kids Area الداخلي غير موجود — أعد تشغيل التطبيق'));
    cb(null, row.id);
  });
}

// تسجيل إيراد Kids Area كمبيعة منفصلة (يظهر في الشيفت النشط والتقارير)
ipcMain.handle('record-kids-area-sale', async (event, { unitPrice }) => {
  return new Promise((resolve) => {
    const price = Number(unitPrice);
    if (isNaN(price) || price < 0) return resolve({ success: false, error: 'سعر غير صالح' });
    getInternalKidsAreaProductId((err, productId) => {
      if (err) return resolve({ success: false, error: err.message });
      addStandaloneSale({ product_id: productId, quantity: 1, price: price }, (err2) => {
        if (err2) return resolve({ success: false, error: err2.message });
        resolve({ success: true });
      });
    });
  });
});

// أوامر IPC للمصروفات
ipcMain.handle('add-expense', async (event, expense) => {
  return new Promise((resolve, reject) => {
    addExpense(expense, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('update-expense', async (event, expense) => {
  return new Promise((resolve, reject) => {
    updateExpense(expense, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('delete-expense', async (event, expenseId) => {
  return new Promise((resolve, reject) => {
    deleteExpense(expenseId, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('get-expenses', async () => {
  return new Promise((resolve, reject) => {
    getExpenses((err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});

ipcMain.handle('get-expenses-by-date-range', async (event, { startDate, endDate }) => {
  return new Promise((resolve, reject) => {
    getExpensesByDateRange(startDate, endDate, (err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});

ipcMain.handle('get-expenses-by-category', async (event, category) => {
  return new Promise((resolve, reject) => {
    getExpensesByCategory(category, (err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});

ipcMain.handle('get-expenses-by-shift', async (event, shift_id) => {
  return new Promise((resolve, reject) => {
    getExpensesByShift(shift_id, (err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});

ipcMain.handle('get-expense-categories', async () => {
  return new Promise((resolve, reject) => {
    getExpenseCategories((err, rows) => {
      if (err) resolve([]);
      else resolve(rows.map(row => row.category));
    });
  });
});

ipcMain.handle('get-total-expenses', async (event, { startDate, endDate }) => {
  return new Promise((resolve, reject) => {
    getTotalExpenses(startDate, endDate, (err, result) => {
      if (err) resolve({ total: 0 });
      else resolve({ total: result.total || 0 });
    });
  });
});

ipcMain.handle('get-total-expenses-by-frequency', async (event, { frequency, startDate, endDate }) => {
  return new Promise((resolve, reject) => {
    getTotalExpensesByFrequency(frequency, startDate, endDate, (err, result) => {
      if (err) resolve({ total: 0 });
      else resolve({ total: result.total || 0 });
    });
  });
});

// أوامر IPC الجديدة لحساب المصروفات في الشيفتات
ipcMain.handle('get-shift-expenses', async (event, shift_id) => {
  return new Promise((resolve, reject) => {
    getShiftExpenses(shift_id, (err, result) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, data: result });
    });
  });
});

ipcMain.handle('get-all-shifts-expenses', async () => {
  return new Promise((resolve, reject) => {
    getAllShiftsExpenses((err, result) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, data: result });
    });
  });
});

ipcMain.handle('get-expenses-statistics', async (event, { startDate, endDate }) => {
  return new Promise((resolve, reject) => {
    getExpensesStatistics(startDate, endDate, (err, result) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, data: result });
    });
  });
});

// أوامر IPC للصيانة
ipcMain.handle('add-maintenance', async (event, maintenance) => {
  return new Promise((resolve, reject) => {
    addMaintenance(maintenance, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('update-maintenance', async (event, maintenance) => {
  return new Promise((resolve, reject) => {
    updateMaintenance(maintenance, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('delete-maintenance', async (event, maintenanceId) => {
  return new Promise((resolve, reject) => {
    deleteMaintenance(maintenanceId, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('get-maintenance', async () => {
  return new Promise((resolve, reject) => {
    getMaintenance((err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});

// جلب MAC لذراع PS4/PS5 عبر HID
ipcMain.handle('get-controller-mac', async () => {
  try {
    if (!HID) return null;
    const devices = HID.devices();
    console.log('🔍 البحث عن أجهزة PS4/PS5...');
    
    // Sony vendor id
    const SONY_VID = 0x054c;
    const candidates = devices.filter(d => {
      const vidOk = typeof d.vendorId === 'number' && d.vendorId === SONY_VID;
      const name = (d.product || '').toLowerCase();
      const isPs = name.includes('wireless controller') || 
                   name.includes('dualsense') || 
                   name.includes('dualshock') || 
                   name.includes('controller') ||
                   name.includes('playstation') ||
                   name.includes('ps4') ||
                   name.includes('ps5');
      console.log(`📱 جهاز: ${d.product} (VID: ${d.vendorId}) - ${vidOk || isPs ? '✅' : '❌'}`);
      return vidOk || isPs;
    });
    
    console.log(`🎮 وجد ${candidates.length} جهاز مرشح`);
    
    for (const dev of candidates) {
      console.log(`🔍 فحص جهاز: ${dev.product}`);
      
      // بعض التعريفات تعرض الماك كسيريال
      if (dev.serialNumber) {
        const sn = String(dev.serialNumber).trim();
        console.log(`📋 Serial Number: ${sn}`);
        
        // طابق 6 بايت بصيغة MAC
        const macMatch = sn.match(/([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}/);
        if (macMatch) {
          const mac = macMatch[0].toUpperCase().replace(/-/g, ':');
          console.log(`✅ MAC من Serial: ${mac}`);
          return mac;
        }
        
        // أحياناً يأتي بدون فواصل
        if (/^[0-9A-Fa-f]{12}$/.test(sn)) {
          const mac = sn.toUpperCase().match(/.{1,2}/g).join(':');
          console.log(`✅ MAC من Serial (بدون فواصل): ${mac}`);
          return mac;
        }
      }
      
      // محاولة قراءة تقارير الميزات الشائعة
      try {
        const handle = new HID.HID(dev.path);
        console.log(`🔌 فتح الجهاز: ${dev.path}`);
        
        // محاولات شائعة: 0x12 و 0x81 مع أطوال مختلفة
        const tryReports = [
          { id: 0x12, len: 16 },
          { id: 0x12, len: 64 },
          { id: 0x81, len: 7 },
          { id: 0x81, len: 64 },
          { id: 0x02, len: 64 }, // PS5 DualSense
          { id: 0x05, len: 64 }, // PS5 DualSense
          { id: 0x09, len: 64 }, // PS5 DualSense
          { id: 0x20, len: 64 }, // PS5 DualSense
          { id: 0x21, len: 64 }, // PS5 DualSense
          { id: 0x22, len: 64 }, // PS5 DualSense
          { id: 0x23, len: 64 }, // PS5 DualSense
          { id: 0x24, len: 64 }, // PS5 DualSense
          { id: 0x25, len: 64 }, // PS5 DualSense
          { id: 0x26, len: 64 }, // PS5 DualSense
          { id: 0x27, len: 64 }, // PS5 DualSense
          { id: 0x28, len: 64 }, // PS5 DualSense
          { id: 0x29, len: 64 }, // PS5 DualSense
          { id: 0x2a, len: 64 }, // PS5 DualSense
          { id: 0x2b, len: 64 }, // PS5 DualSense
          { id: 0x2c, len: 64 }, // PS5 DualSense
          { id: 0x2d, len: 64 }, // PS5 DualSense
          { id: 0x2e, len: 64 }, // PS5 DualSense
          { id: 0x2f, len: 64 }, // PS5 DualSense
          { id: 0x30, len: 64 }, // PS5 DualSense
          { id: 0x31, len: 64 }, // PS5 DualSense
          { id: 0x32, len: 64 }, // PS5 DualSense
          { id: 0x33, len: 64 }, // PS5 DualSense
          { id: 0x34, len: 64 }, // PS5 DualSense
          { id: 0x35, len: 64 }, // PS5 DualSense
          { id: 0x36, len: 64 }, // PS5 DualSense
          { id: 0x37, len: 64 }, // PS5 DualSense
          { id: 0x38, len: 64 }, // PS5 DualSense
          { id: 0x39, len: 64 }, // PS5 DualSense
          { id: 0x3a, len: 64 }, // PS5 DualSense
          { id: 0x3b, len: 64 }, // PS5 DualSense
          { id: 0x3c, len: 64 }, // PS5 DualSense
          { id: 0x3d, len: 64 }, // PS5 DualSense
          { id: 0x3e, len: 64 }, // PS5 DualSense
          { id: 0x3f, len: 64 }, // PS5 DualSense
          { id: 0x40, len: 64 }, // PS5 DualSense
          { id: 0x41, len: 64 }, // PS5 DualSense
          { id: 0x42, len: 64 }, // PS5 DualSense
          { id: 0x43, len: 64 }, // PS5 DualSense
          { id: 0x44, len: 64 }, // PS5 DualSense
          { id: 0x45, len: 64 }, // PS5 DualSense
          { id: 0x46, len: 64 }, // PS5 DualSense
          { id: 0x47, len: 64 }, // PS5 DualSense
          { id: 0x48, len: 64 }, // PS5 DualSense
          { id: 0x49, len: 64 }, // PS5 DualSense
          { id: 0x4a, len: 64 }, // PS5 DualSense
          { id: 0x4b, len: 64 }, // PS5 DualSense
          { id: 0x4c, len: 64 }, // PS5 DualSense
          { id: 0x4d, len: 64 }, // PS5 DualSense
          { id: 0x4e, len: 64 }, // PS5 DualSense
          { id: 0x4f, len: 64 }, // PS5 DualSense
          { id: 0x50, len: 64 }, // PS5 DualSense
          { id: 0x51, len: 64 }, // PS5 DualSense
          { id: 0x52, len: 64 }, // PS5 DualSense
          { id: 0x53, len: 64 }, // PS5 DualSense
          { id: 0x54, len: 64 }, // PS5 DualSense
          { id: 0x55, len: 64 }, // PS5 DualSense
          { id: 0x56, len: 64 }, // PS5 DualSense
          { id: 0x57, len: 64 }, // PS5 DualSense
          { id: 0x58, len: 64 }, // PS5 DualSense
          { id: 0x59, len: 64 }, // PS5 DualSense
          { id: 0x5a, len: 64 }, // PS5 DualSense
          { id: 0x5b, len: 64 }, // PS5 DualSense
          { id: 0x5c, len: 64 }, // PS5 DualSense
          { id: 0x5d, len: 64 }, // PS5 DualSense
          { id: 0x5e, len: 64 }, // PS5 DualSense
          { id: 0x5f, len: 64 }, // PS5 DualSense
          { id: 0x60, len: 64 }, // PS5 DualSense
          { id: 0x61, len: 64 }, // PS5 DualSense
          { id: 0x62, len: 64 }, // PS5 DualSense
          { id: 0x63, len: 64 }, // PS5 DualSense
          { id: 0x64, len: 64 }, // PS5 DualSense
          { id: 0x65, len: 64 }, // PS5 DualSense
          { id: 0x66, len: 64 }, // PS5 DualSense
          { id: 0x67, len: 64 }, // PS5 DualSense
          { id: 0x68, len: 64 }, // PS5 DualSense
          { id: 0x69, len: 64 }, // PS5 DualSense
          { id: 0x6a, len: 64 }, // PS5 DualSense
          { id: 0x6b, len: 64 }, // PS5 DualSense
          { id: 0x6c, len: 64 }, // PS5 DualSense
          { id: 0x6d, len: 64 }, // PS5 DualSense
          { id: 0x6e, len: 64 }, // PS5 DualSense
          { id: 0x6f, len: 64 }, // PS5 DualSense
          { id: 0x70, len: 64 }, // PS5 DualSense
          { id: 0x71, len: 64 }, // PS5 DualSense
          { id: 0x72, len: 64 }, // PS5 DualSense
          { id: 0x73, len: 64 }, // PS5 DualSense
          { id: 0x74, len: 64 }, // PS5 DualSense
          { id: 0x75, len: 64 }, // PS5 DualSense
          { id: 0x76, len: 64 }, // PS5 DualSense
          { id: 0x77, len: 64 }, // PS5 DualSense
          { id: 0x78, len: 64 }, // PS5 DualSense
          { id: 0x79, len: 64 }, // PS5 DualSense
          { id: 0x7a, len: 64 }, // PS5 DualSense
          { id: 0x7b, len: 64 }, // PS5 DualSense
          { id: 0x7c, len: 64 }, // PS5 DualSense
          { id: 0x7d, len: 64 }, // PS5 DualSense
          { id: 0x7e, len: 64 }, // PS5 DualSense
          { id: 0x7f, len: 64 }, // PS5 DualSense
          { id: 0x80, len: 64 }, // PS5 DualSense
          { id: 0x82, len: 64 }, // PS5 DualSense
          { id: 0x83, len: 64 }, // PS5 DualSense
          { id: 0x84, len: 64 }, // PS5 DualSense
          { id: 0x85, len: 64 }, // PS5 DualSense
          { id: 0x86, len: 64 }, // PS5 DualSense
          { id: 0x87, len: 64 }, // PS5 DualSense
          { id: 0x88, len: 64 }, // PS5 DualSense
          { id: 0x89, len: 64 }, // PS5 DualSense
          { id: 0x8a, len: 64 }, // PS5 DualSense
          { id: 0x8b, len: 64 }, // PS5 DualSense
          { id: 0x8c, len: 64 }, // PS5 DualSense
          { id: 0x8d, len: 64 }, // PS5 DualSense
          { id: 0x8e, len: 64 }, // PS5 DualSense
          { id: 0x8f, len: 64 }, // PS5 DualSense
          { id: 0x90, len: 64 }, // PS5 DualSense
          { id: 0x91, len: 64 }, // PS5 DualSense
          { id: 0x92, len: 64 }, // PS5 DualSense
          { id: 0x93, len: 64 }, // PS5 DualSense
          { id: 0x94, len: 64 }, // PS5 DualSense
          { id: 0x95, len: 64 }, // PS5 DualSense
          { id: 0x96, len: 64 }, // PS5 DualSense
          { id: 0x97, len: 64 }, // PS5 DualSense
          { id: 0x98, len: 64 }, // PS5 DualSense
          { id: 0x99, len: 64 }, // PS5 DualSense
          { id: 0x9a, len: 64 }, // PS5 DualSense
          { id: 0x9b, len: 64 }, // PS5 DualSense
          { id: 0x9c, len: 64 }, // PS5 DualSense
          { id: 0x9d, len: 64 }, // PS5 DualSense
          { id: 0x9e, len: 64 }, // PS5 DualSense
          { id: 0x9f, len: 64 }, // PS5 DualSense
          { id: 0xa0, len: 64 }, // PS5 DualSense
          { id: 0xa1, len: 64 }, // PS5 DualSense
          { id: 0xa2, len: 64 }, // PS5 DualSense
          { id: 0xa3, len: 64 }, // PS5 DualSense
          { id: 0xa4, len: 64 }, // PS5 DualSense
          { id: 0xa5, len: 64 }, // PS5 DualSense
          { id: 0xa6, len: 64 }, // PS5 DualSense
          { id: 0xa7, len: 64 }, // PS5 DualSense
          { id: 0xa8, len: 64 }, // PS5 DualSense
          { id: 0xa9, len: 64 }, // PS5 DualSense
          { id: 0xaa, len: 64 }, // PS5 DualSense
          { id: 0xab, len: 64 }, // PS5 DualSense
          { id: 0xac, len: 64 }, // PS5 DualSense
          { id: 0xad, len: 64 }, // PS5 DualSense
          { id: 0xae, len: 64 }, // PS5 DualSense
          { id: 0xaf, len: 64 }, // PS5 DualSense
          { id: 0xb0, len: 64 }, // PS5 DualSense
          { id: 0xb1, len: 64 }, // PS5 DualSense
          { id: 0xb2, len: 64 }, // PS5 DualSense
          { id: 0xb3, len: 64 }, // PS5 DualSense
          { id: 0xb4, len: 64 }, // PS5 DualSense
          { id: 0xb5, len: 64 }, // PS5 DualSense
          { id: 0xb6, len: 64 }, // PS5 DualSense
          { id: 0xb7, len: 64 }, // PS5 DualSense
          { id: 0xb8, len: 64 }, // PS5 DualSense
          { id: 0xb9, len: 64 }, // PS5 DualSense
          { id: 0xba, len: 64 }, // PS5 DualSense
          { id: 0xbb, len: 64 }, // PS5 DualSense
          { id: 0xbc, len: 64 }, // PS5 DualSense
          { id: 0xbd, len: 64 }, // PS5 DualSense
          { id: 0xbe, len: 64 }, // PS5 DualSense
          { id: 0xbf, len: 64 }, // PS5 DualSense
          { id: 0xc0, len: 64 }, // PS5 DualSense
          { id: 0xc1, len: 64 }, // PS5 DualSense
          { id: 0xc2, len: 64 }, // PS5 DualSense
          { id: 0xc3, len: 64 }, // PS5 DualSense
          { id: 0xc4, len: 64 }, // PS5 DualSense
          { id: 0xc5, len: 64 }, // PS5 DualSense
          { id: 0xc6, len: 64 }, // PS5 DualSense
          { id: 0xc7, len: 64 }, // PS5 DualSense
          { id: 0xc8, len: 64 }, // PS5 DualSense
          { id: 0xc9, len: 64 }, // PS5 DualSense
          { id: 0xca, len: 64 }, // PS5 DualSense
          { id: 0xcb, len: 64 }, // PS5 DualSense
          { id: 0xcc, len: 64 }, // PS5 DualSense
          { id: 0xcd, len: 64 }, // PS5 DualSense
          { id: 0xce, len: 64 }, // PS5 DualSense
          { id: 0xcf, len: 64 }, // PS5 DualSense
          { id: 0xd0, len: 64 }, // PS5 DualSense
          { id: 0xd1, len: 64 }, // PS5 DualSense
          { id: 0xd2, len: 64 }, // PS5 DualSense
          { id: 0xd3, len: 64 }, // PS5 DualSense
          { id: 0xd4, len: 64 }, // PS5 DualSense
          { id: 0xd5, len: 64 }, // PS5 DualSense
          { id: 0xd6, len: 64 }, // PS5 DualSense
          { id: 0xd7, len: 64 }, // PS5 DualSense
          { id: 0xd8, len: 64 }, // PS5 DualSense
          { id: 0xd9, len: 64 }, // PS5 DualSense
          { id: 0xda, len: 64 }, // PS5 DualSense
          { id: 0xdb, len: 64 }, // PS5 DualSense
          { id: 0xdc, len: 64 }, // PS5 DualSense
          { id: 0xdd, len: 64 }, // PS5 DualSense
          { id: 0xde, len: 64 }, // PS5 DualSense
          { id: 0xdf, len: 64 }, // PS5 DualSense
          { id: 0xe0, len: 64 }, // PS5 DualSense
          { id: 0xe1, len: 64 }, // PS5 DualSense
          { id: 0xe2, len: 64 }, // PS5 DualSense
          { id: 0xe3, len: 64 }, // PS5 DualSense
          { id: 0xe4, len: 64 }, // PS5 DualSense
          { id: 0xe5, len: 64 }, // PS5 DualSense
          { id: 0xe6, len: 64 }, // PS5 DualSense
          { id: 0xe7, len: 64 }, // PS5 DualSense
          { id: 0xe8, len: 64 }, // PS5 DualSense
          { id: 0xe9, len: 64 }, // PS5 DualSense
          { id: 0xea, len: 64 }, // PS5 DualSense
          { id: 0xeb, len: 64 }, // PS5 DualSense
          { id: 0xec, len: 64 }, // PS5 DualSense
          { id: 0xed, len: 64 }, // PS5 DualSense
          { id: 0xee, len: 64 }, // PS5 DualSense
          { id: 0xef, len: 64 }, // PS5 DualSense
          { id: 0xf0, len: 64 }, // PS5 DualSense
          { id: 0xf1, len: 64 }, // PS5 DualSense
          { id: 0xf2, len: 64 }, // PS5 DualSense
          { id: 0xf3, len: 64 }, // PS5 DualSense
          { id: 0xf4, len: 64 }, // PS5 DualSense
          { id: 0xf5, len: 64 }, // PS5 DualSense
          { id: 0xf6, len: 64 }, // PS5 DualSense
          { id: 0xf7, len: 64 }, // PS5 DualSense
          { id: 0xf8, len: 64 }, // PS5 DualSense
          { id: 0xf9, len: 64 }, // PS5 DualSense
          { id: 0xfa, len: 64 }, // PS5 DualSense
          { id: 0xfb, len: 64 }, // PS5 DualSense
          { id: 0xfc, len: 64 }, // PS5 DualSense
          { id: 0xfd, len: 64 }, // PS5 DualSense
          { id: 0xfe, len: 64 }, // PS5 DualSense
          { id: 0xff, len: 64 }  // PS5 DualSense
        ];
        
        for (const t of tryReports) {
          try {
            console.log(`📊 محاولة تقرير: ID=0x${t.id.toString(16)}, Len=${t.len}`);
            const data = handle.getFeatureReport(t.id, t.len);
            console.log(`📈 بيانات التقرير:`, Array.from(data.slice(0, Math.min(32, data.length))));
            
            // ابحث عن 6 بايت تبدو مثل MAC
            for (let i = 0; i + 6 <= data.length; i++) {
              const slice = Array.from(data.slice(i, i + 6));
              if (slice.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) {
                const candidate = slice.map(b => b.toString(16).padStart(2, '0')).join(':').toUpperCase();
                console.log(`🔍 مرشح MAC في الموضع ${i}: ${candidate}`);
                
                // استبعد 00:00:00:00:00:00 و FF:FF:FF:FF:FF:FF
                const hexString = slice.map(b => b.toString(16).padStart(2,'0')).join('');
                if (!/^(00){6}$/.test(hexString) && !/^(ff){6}$/i.test(hexString)) {
                  console.log(`✅ MAC صالح: ${candidate}`);
                  try { handle.close(); } catch(_) {}
                  return candidate;
                }
              }
            }
          } catch (e) { 
            console.log(`❌ فشل تقرير ID=0x${t.id.toString(16)}: ${e.message}`);
          }
        }
        
        try { handle.close(); } catch(_) {}
      } catch (e) { 
        console.log(`❌ لا يمكن فتح الجهاز: ${e.message}`);
      }
    }
    
    console.log('❌ لم يتم العثور على MAC address');
    return null;
  } catch (e) {
    console.log('❌ خطأ في البحث عن MAC:', e.message);
    return null;
  }
});

// أوامر الأذرع
function addController(controller, cb) {
  db.run('INSERT INTO controllers (name, mac) VALUES (?, ?)', [controller.name, controller.mac || null], cb);
}
function updateController(controller, cb) {
  db.run('UPDATE controllers SET name = ?, mac = ? WHERE id = ?', [controller.name, controller.mac || null, controller.id], cb);
}
function deleteController(id, cb) {
  db.run('DELETE FROM controllers WHERE id = ?', [id], cb);
}
function getControllers(cb) {
  db.all('SELECT * FROM controllers ORDER BY id DESC', cb);
}

ipcMain.handle('add-controller', async (event, data) => new Promise(resolve => {
  addController(data, err => {
    if (err) resolve({ success: false, error: err.message });
    else resolve({ success: true });
  });
}));
ipcMain.handle('update-controller', async (event, data) => new Promise(resolve => {
  updateController(data, err => {
    if (err) resolve({ success: false, error: err.message });
    else resolve({ success: true });
  });
}));
ipcMain.handle('delete-controller', async (event, id) => new Promise(resolve => {
  deleteController(id, err => {
    if (err) resolve({ success: false, error: err.message });
    else resolve({ success: true });
  });
}));
ipcMain.handle('get-controllers', async () => new Promise(resolve => {
  getControllers((err, rows) => {
    if (err) resolve([]);
    else resolve(rows);
  });
}));

ipcMain.handle('get-maintenance-by-status', async (event, status) => {
  return new Promise((resolve, reject) => {
    getMaintenanceByStatus(status, (err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});

ipcMain.handle('get-maintenance-by-device', async (event, deviceId) => {
  return new Promise((resolve, reject) => {
    getMaintenanceByDevice(deviceId, (err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});

ipcMain.handle('get-maintenance-by-date-range', async (event, { startDate, endDate }) => {
  return new Promise((resolve, reject) => {
    getMaintenanceByDateRange(startDate, endDate, (err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});

ipcMain.handle('get-maintenance-stats', async () => {
  return new Promise((resolve, reject) => {
    getMaintenanceStats((err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});

ipcMain.handle('get-maintenance-by-type', async (event, type) => {
  return new Promise((resolve, reject) => {
    getMaintenanceByType(type, (err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});

// دالة لإصلاح صلاحيات المستخدمين الحاليين
function fixUserPermissions(cb) {
  db.all('SELECT * FROM users', (err, users) => {
    if (err) return cb(err);
    
    let completed = 0;
    const total = users.length;
    
    if (total === 0) return cb();
    
    users.forEach(user => {
      // التحقق من وجود صلاحيات للمستخدم
      db.get('SELECT COUNT(*) as cnt FROM user_permissions WHERE user_id = ?', [user.id], (err, row) => {
        if (err) {
          completed++;
          if (completed === total) cb();
          return;
        }
        
        // قوائم الصفحات حسب الدور (تشمل debts)
        const adminPages = ['dashboard', 'devices', 'sessions', 'products', 'invoices', 'expenses', 'debts', 'clients', 'bookings', 'maintenance', 'users', 'employees', 'offers', 'backup', 'settings', 'tournaments', 'shifts', 'kids-area', 'hotspot'];
        const cashierPages = ['dashboard', 'devices', 'sessions', 'products', 'invoices', 'debts', 'clients', 'bookings', 'shifts', 'kids-area', 'hotspot'];
        const supervisorPages = ['dashboard', 'devices', 'sessions', 'products', 'invoices', 'expenses', 'debts', 'clients', 'bookings', 'maintenance', 'employees', 'offers', 'shifts', 'kids-area', 'hotspot'];

        const targetPages = user.role === 'admin' ? adminPages : (user.role === 'cashier' ? cashierPages : supervisorPages);

        if (row.cnt === 0) {
          // إضافة صلاحيات افتراضية حسب الدور
          targetPages.forEach(page => {
            // أذونات افتراضية حسب الدور
            if (user.role === 'admin') {
              db.run('INSERT INTO user_permissions (user_id, page, can_view, can_add, can_edit, can_delete) VALUES (?, ?, 1, 1, 1, 1)', [user.id, page]);
            } else if (user.role === 'cashier') {
              db.run('INSERT INTO user_permissions (user_id, page, can_view, can_add, can_edit, can_delete) VALUES (?, ?, 1, 1, 0, 0)', [user.id, page]);
            } else {
              db.run('INSERT INTO user_permissions (user_id, page, can_view, can_add, can_edit, can_delete) VALUES (?, ?, 1, 1, 1, 0)', [user.id, page]);
            }
          });
        } else {
          // أكمل أي صفحات مفقودة (مثل debts) بدون حذف القائم
          targetPages.forEach(page => {
            db.get('SELECT 1 FROM user_permissions WHERE user_id = ? AND page = ?', [user.id, page], (err2, exists) => {
              if (err2) return; // تخطى عند الخطأ
              if (!exists) {
                if (user.role === 'admin') {
                  db.run('INSERT INTO user_permissions (user_id, page, can_view, can_add, can_edit, can_delete) VALUES (?, ?, 1, 1, 1, 1)', [user.id, page]);
                } else if (user.role === 'cashier') {
                  db.run('INSERT INTO user_permissions (user_id, page, can_view, can_add, can_edit, can_delete) VALUES (?, ?, 1, 1, 0, 0)', [user.id, page]);
                } else {
                  db.run('INSERT INTO user_permissions (user_id, page, can_view, can_add, can_edit, can_delete) VALUES (?, ?, 1, 1, 1, 0)', [user.id, page]);
                }
              }
            });
          });
        }
        
        completed++;
        if (completed === total) cb();
      });
    });
  });
}

// دوال إدارة الصلاحيات
function getUserPermissions(userId, cb) {
  db.all('SELECT * FROM user_permissions WHERE user_id = ?', [userId], cb);
}

function setUserPermissions(userId, permissions, cb) {
  // حذف الصلاحيات القديمة
  db.run('DELETE FROM user_permissions WHERE user_id = ?', [userId], (err) => {
    if (err) return cb(err);
    
    // إضافة الصلاحيات الجديدة
    let completed = 0;
    const total = permissions.length;
    if (total === 0) return cb();
    
    permissions.forEach(perm => {
      db.run('INSERT INTO user_permissions (user_id, page, can_view, can_add, can_edit, can_delete) VALUES (?, ?, ?, ?, ?, ?)', 
        [userId, perm.page, perm.can_view ? 1 : 0, perm.can_add ? 1 : 0, perm.can_edit ? 1 : 0, perm.can_delete ? 1 : 0], 
        (err) => {
          completed++;
          if (completed === total) cb(err);
        });
    });
  });
}

function checkUserPermission(userId, page, action, cb) {
  db.get('SELECT * FROM user_permissions WHERE user_id = ? AND page = ?', [userId, page], (err, row) => {
    if (err) return cb(err);
    if (!row) return cb(null, false);
    
    let hasPermission = false;
    switch(action) {
      case 'view': hasPermission = row.can_view === 1; break;
      case 'add': hasPermission = row.can_add === 1; break;
      case 'edit': hasPermission = row.can_edit === 1; break;
      case 'delete': hasPermission = row.can_delete === 1; break;
    }
    cb(null, hasPermission);
  });
}

// دوال المستخدمين
function addUser(user, cb) {
  db.run('INSERT INTO users (username, password, role, permissions) VALUES (?, ?, ?, ?)', [user.username, user.password, user.role, user.permissions || null], function(err) {
    if (err) return cb(err);
    
    const userId = this.lastID;
    
    // إضافة صلاحيات افتراضية حسب الدور
    if (user.role === 'admin') {
      // المدير له جميع الصلاحيات
      const pages = ['dashboard', 'devices', 'sessions', 'products', 'invoices', 'expenses', 'debts', 'clients', 'bookings', 'maintenance', 'users', 'employees', 'offers', 'backup', 'settings', 'tournaments', 'shifts', 'kids-area', 'hotspot'];
      pages.forEach(page => {
        db.run('INSERT INTO user_permissions (user_id, page, can_view, can_add, can_edit, can_delete) VALUES (?, ?, 1, 1, 1, 1)', [userId, page]);
      });
    } else if (user.role === 'cashier') {
      // المحاسب له صلاحيات محدودة
      const cashierPages = ['dashboard', 'devices', 'sessions', 'products', 'invoices', 'debts', 'clients', 'bookings', 'shifts', 'kids-area', 'hotspot'];
      cashierPages.forEach(page => {
        db.run('INSERT INTO user_permissions (user_id, page, can_view, can_add, can_edit, can_delete) VALUES (?, ?, 1, 1, 0, 0)', [userId, page]);
      });
    } else if (user.role === 'supervisor') {
      // المشرف له صلاحيات متوسطة
      const supervisorPages = ['dashboard', 'devices', 'sessions', 'products', 'invoices', 'expenses', 'debts', 'clients', 'bookings', 'maintenance', 'employees', 'offers', 'shifts', 'kids-area', 'hotspot'];
      supervisorPages.forEach(page => {
        db.run('INSERT INTO user_permissions (user_id, page, can_view, can_add, can_edit, can_delete) VALUES (?, ?, 1, 1, 1, 0)', [userId, page]);
      });
    }
    
    cb(null);
  });
}
function updateUser(user, cb) {
  if (user.password) {
    db.run('UPDATE users SET username = ?, password = ?, role = ?, permissions = ? WHERE id = ?', [user.username, user.password, user.role, user.permissions || null, user.id], cb);
  } else {
    db.run('UPDATE users SET username = ?, role = ?, permissions = ? WHERE id = ?', [user.username, user.role, user.permissions || null, user.id], cb);
  }
}
function deleteUser(userId, cb) {
  db.run('DELETE FROM users WHERE id = ?', [userId], cb);
}
function getUsers(cb) {
  db.all('SELECT id, username, role, permissions FROM users', cb);
}
function checkLogin(username, password, cb) {
  db.get('SELECT id, username, role, permissions FROM users WHERE username = ? AND password = ?', [username, password], cb);
}
ipcMain.handle('get-user-permissions', async (event, userId) => {
  return new Promise((resolve) => {
    getUserPermissions(userId, (err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});

ipcMain.handle('set-user-permissions', async (event, { userId, permissions }) => {
  return new Promise((resolve) => {
    setUserPermissions(userId, permissions, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('check-user-permission', async (event, { userId, page, action }) => {
  return new Promise((resolve) => {
    checkUserPermission(userId, page, action, (err, hasPermission) => {
      if (err) resolve(false);
      else resolve(hasPermission);
    });
  });
});

ipcMain.handle('get-all-pages', async () => {
  return [
    { id: 'dashboard', name: 'لوحة التحكم', icon: 'dashboard.png' },
    { id: 'devices', name: 'الأجهزة', icon: 'videogame.png' },
    { id: 'sessions', name: 'الجلسات', icon: 'timer.png' },
    { id: 'products', name: 'المنتجات', icon: 'local_mall.png' },
    { id: 'invoices', name: 'الفواتير', icon: 'receipt_long.png' },
    { id: 'expenses', name: 'المصروفات', icon: 'account.png' },
    { id: 'debts', name: 'المديونيات', icon: 'receipt_long.png' },
    { id: 'clients', name: 'العملاء', icon: 'receipt_long.png' },
    { id: 'bookings', name: 'الحجوزات', icon: 'hourglass_empty.png' },
    { id: 'maintenance', name: 'الصيانة', icon: 'build.png' },
    { id: 'users', name: 'المستخدمين', icon: 'group.png' },
    { id: 'backup', name: 'النسخ الاحتياطي', icon: 'backup.png' },
    { id: 'settings', name: 'الإعدادات', icon: 'settings.png' },
    { id: 'tournaments', name: 'الدورات', icon: 'trophy.png' },
    { id: 'employees', name: 'الموظفين', icon: 'group.png' },
    { id: 'offers', name: 'العروض', icon: 'star.png' },
    { id: 'shifts', name: 'الشيفتات', icon: 'swap_horiz.png' },
    { id: 'kids-area', name: 'منطقة الأطفال', icon: 'child.png' },
    { id: 'hotspot', name: 'الهوتسبوت', icon: 'wifi.png' }
  ];
});

ipcMain.handle('fix-user-permissions', async (event) => {
  return new Promise((resolve) => {
    fixUserPermissions((err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

// أوامر IPC للمستخدمين
ipcMain.handle('add-user', async (event, user) => {
  return new Promise((resolve) => {
    addUser(user, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});
ipcMain.handle('update-user', async (event, user) => {
  return new Promise((resolve) => {
    updateUser(user, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});
ipcMain.handle('delete-user', async (event, userId) => {
  return new Promise((resolve) => {
    deleteUser(userId, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});
ipcMain.handle('get-users', async () => {
  return new Promise((resolve) => {
    getUsers((err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});

// --- أهداف الموظفين ---
ipcMain.handle('set-employee-target', async (event, { user_id, target_amount, period, bonus_amount, daily_wage }) => {
  return new Promise((resolve) => {
    db.run(`INSERT INTO employee_targets (user_id, target_amount, bonus_amount, daily_wage, period, updated_at) VALUES (?, ?, ?, ?, ?, strftime('%s','now')*1000)
      ON CONFLICT(user_id, period) DO UPDATE SET target_amount = excluded.target_amount, bonus_amount = excluded.bonus_amount, daily_wage = excluded.daily_wage, updated_at = strftime('%s','now')*1000`,
      [user_id, target_amount, bonus_amount || 0, daily_wage || 0, period], (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('get-employee-targets', async () => {
  return new Promise((resolve) => {
    db.all(`SELECT et.*, u.username FROM employee_targets et LEFT JOIN users u ON et.user_id = u.id`, [], (err, rows) => {
      if (err) resolve([]);
      else resolve(rows || []);
    });
  });
});

ipcMain.handle('get-employee-stats', async (event, { user_id, period }) => {
  return new Promise((resolve) => {
    let startTime;
    if (period === 'daily') {
      const d = new Date();
      startTime = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    } else {
      startTime = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
    }

    let standaloneTotal = 0, spTotal = 0;
    let done = 0;
    function check() { done++; if (done === 2) resolve({ success: true, data: { total: standaloneTotal + spTotal, standaloneTotal, spTotal } }); }

    // مبيعات سريعة (منتجات منفصلة)
    db.all(`SELECT COALESCE(SUM(total), 0) as t FROM standalone_sales WHERE date >= ?`,
      [startTime], (err, row) => {
        if (!err && row) standaloneTotal = row[0]?.t || 0;
        check();
      });

    // منتجات تمت إضافتها للجلسات المنتهية
    db.all(`SELECT COALESCE(SUM(sp.total), 0) as t
            FROM session_products sp
            INNER JOIN sessions s ON sp.session_id = s.id
            WHERE s.end_time >= ? AND s.is_active = 0`,
      [startTime], (err, row) => {
        if (!err && row) spTotal = row[0]?.t || 0;
        check();
      });
  });
});
// --- صرف اليومية للموظفين ---
ipcMain.handle('get-employee-payments', async (event, { date }) => {
  return new Promise((resolve) => {
    db.all(`SELECT ep.*, u.username FROM employee_payments ep LEFT JOIN users u ON ep.user_id = u.id WHERE ep.payment_date = ? ORDER BY ep.created_at DESC`,
      [date], (err, rows) => {
      if (err) resolve([]);
      else resolve(rows || []);
    });
  });
});

ipcMain.handle('create-employee-payment', async (event, { user_id, payment_date, target_amount, bonus_amount, total_amount }) => {
  return new Promise((resolve) => {
    db.run(`INSERT INTO employee_payments (user_id, payment_date, target_amount, bonus_amount, total_amount) VALUES (?, ?, ?, ?, ?)`,
      [user_id, payment_date, target_amount, bonus_amount, total_amount], (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

// --- العروض (Offers) ---
ipcMain.handle('get-offers', async () => {
  return new Promise((resolve) => {
    db.all('SELECT * FROM offers ORDER BY created_at DESC', [], (err, rows) => {
      if (err) resolve([]);
      else resolve(rows || []);
    });
  });
});

ipcMain.handle('create-offer', async (event, { name, description, type, condition_value, reward_value }) => {
  return new Promise((resolve) => {
    db.run('INSERT INTO offers (name, description, type, condition_value, reward_value) VALUES (?, ?, ?, ?, ?)',
      [name, description, type, condition_value, reward_value], function (err) {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, id: this.lastID });
    });
  });
});

ipcMain.handle('update-offer', async (event, { id, name, description, type, condition_value, reward_value }) => {
  return new Promise((resolve) => {
    db.run('UPDATE offers SET name = ?, description = ?, type = ?, condition_value = ?, reward_value = ? WHERE id = ?',
      [name, description, type, condition_value, reward_value, id], (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('toggle-offer', async (event, { id, is_active }) => {
  return new Promise((resolve) => {
    db.run('UPDATE offers SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, id], (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('delete-offer', async (event, id) => {
  return new Promise((resolve) => {
    db.run('DELETE FROM offers WHERE id = ?', [id], (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('check-login', async (event, { username, password }) => {
  return new Promise((resolve) => {
    checkLogin(username, password, (err, user) => {
      if (err || !user) resolve(null);
      else {
        resolve(user);
        console.log(user);
        getSetting('telegram_bot_token', (e1, token) => {
          
          if (e1) {
            console.log('⚠️ خطأ في جلب التوكن:', e1.message);
            return resolve({ success: true, ...result });
          }
          if (!token) {
            console.log('⚠️ لا يوجد توكن تيليجرام محفوظ');
            return resolve({ success: true, ...result });
          }
          console.log('✅ تم العثور على التوكن');
          getAllTelegramChats((e2, chats) => {
            console.log(chats);
            if (e2) {
              console.log('⚠️ خطأ في جلب قائمة الشاتات:', e2.message);
              return resolve({ success: true, ...result });
            }
            if (!chats || chats.length === 0) {
              console.log('⚠️ لا توجد شاتات محفوظة. يرجى إرسال /start للبوت أولاً');
              return resolve({ success: true, ...result });
            }
            const chatIds = chats.map(c => c.chat_id);
            console.log('✅ تم العثور على', chatIds.length, 'شات ');
            chatIds.forEach(chatId => {
              sendTelegramMessage(token, chatId, `تم تسجيل الدخول ب ${user.username}`, (err) => {
                if (err) {
                  console.log('⚠️ خطأ في إرسال الرسالة:', err.message);
                } else {
                  console.log('✅ تم إرسال الرسالة بنجاح');
                }
              });
            });


            
          });
        });
      }
    });
  });
});

ipcMain.handle('backup-database', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'حفظ نسخة احتياطية',
    defaultPath: `ps-backup-${new Date().toISOString().slice(0, 10)}.db`,
    filters: [{ name: 'SQLite DB', extensions: ['db'] }]
  });
  if (canceled || !filePath) return { success: false, error: 'تم الإلغاء' };
  try {
    fs.copyFileSync(dbPath, filePath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('restore-database', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'استعادة نسخة احتياطية',
    filters: [{ name: 'SQLite DB', extensions: ['db'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths || !filePaths[0]) return { success: false, error: 'تم الإلغاء' };
  // تحذير قبل الاستبدال
  const confirm = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['استعادة', 'إلغاء'],
    defaultId: 1,
    title: 'تأكيد الاستعادة',
    message: 'سيتم استبدال قاعدة البيانات الحالية بالنسخة المختارة. هل أنت متأكد؟'
  });
  if (confirm.response !== 0) return { success: false, error: 'تم الإلغاء' };
  try {
    fs.copyFileSync(filePaths[0], dbPath);
    // إعادة تشغيل التطبيق بعد الاستعادة
    app.relaunch();
    app.exit(0);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// دالة نقل الجلسة من جهاز لجهاز
function transferSession({ from, to }, cb) {
  // تحقق أن هناك جلسة نشطة على الجهاز القديم ولا يوجد جلسة نشطة على الجديد
  db.get('SELECT * FROM sessions WHERE device_id = ? AND is_active = 1', [from], (err, session) => {
    if (err || !session) return cb(err || new Error('لا توجد جلسة نشطة على الجهاز الحالي'));
    db.get('SELECT * FROM sessions WHERE device_id = ? AND is_active = 1', [to], (err2, session2) => {
      if (err2) return cb(err2);
      if (session2) return cb(new Error('الجهاز الجديد عليه جلسة نشطة بالفعل'));
      // نفذ النقل
      db.run('UPDATE sessions SET device_id = ? WHERE id = ?', [to, session.id], function (updateErr) {
        if (updateErr) return cb(updateErr);
        cb(null, { success: true });
      });
    });
  });
}

ipcMain.handle('transfer-session', async (event, data) => {
  // نفتح القفل على الجهاز الجديد أولاً ونتأكد منه
  const unlock = await ps4lockApplyVerified(data.to, 'unlock');
  if (!unlock.ok) {
    return { success: false, error: 'تعذر فتح القفل على الجهاز الجديد والنقل لم يتم: ' + (unlock.error || 'الجهاز لم يستجب') };
  }
  // نقفل الجهاز القديم ونتأكد منه قبل نقل الجلسة
  const lockFrom = await ps4lockApplyVerified(data.from, 'lock');
  if (!lockFrom.ok) {
    // رول-باك: نرجّع الجهاز الجديد مقفول تاني لأن النقل لم يكتمل
    await ps4lockApplyAsync(data.to, 'lock');
    return { success: false, error: 'تعذر قفل الجهاز القديم والنقل لم يتم: ' + (lockFrom.error || 'الجهاز لم يستجب') };
  }
  return new Promise((resolve, reject) => {
    transferSession(data, async (err, result) => {
      if (err) {
        // رول-باك: نرجّع حالة الجهازين زي ما كانت
        await ps4lockApplyAsync(data.from, 'unlock');
        await ps4lockApplyAsync(data.to, 'lock');
        resolve({ success: false, error: err.message });
      } else {
        resolve({ success: true, lock: lockFrom, unlock });
      }
    });
  });
});

// ===================== IPC: إعدادات وفحص نظام lockall =====================
let ps4lockStatusCache = { at: 0, data: null };

// فحص حالة كل الأجهزة (أونلاين + مقفول/مفتوح) عبر TCP ثم FTP fallback
ipcMain.handle('ps4lock-status-all', async () => {
  const now = Date.now();
  if (ps4lockStatusCache.data && now - ps4lockStatusCache.at < 8000) {
    return ps4lockStatusCache.data;
  }
  const devices = await new Promise((res, rej) => getDevices((e, rows) => e ? rej(e) : res(rows || [])));
  const out = {};
  await Promise.all(devices.map(async d => {
    if (!d.ip) { out[d.id] = { online: false, locked: null }; return; }
    try {
      const token = await new Promise((res2, rej2) => getPs4lockTokenForDevice(d, (e, t) => e ? rej2(e) : res2(t)));
      const r = await ps4lockRawCommand(d.ip, token, 'status', PS4LOCK_STATUS_TIMEOUT);
      out[d.id] = { online: true, locked: r.locked !== undefined ? r.locked : ps4lockParseReply(r.reply) };
    } catch (e) {
      out[d.id] = { online: false, locked: null };
    }
  }));
  ps4lockStatusCache = { at: Date.now(), data: out };
  return out;
});

// اختبار الاتصال بجهاز واحد
ipcMain.handle('ps4lock-test-device', async (event, deviceId) => {
  return new Promise(resolve => {
    applyPs4Lock(deviceId, 'status', (err, res) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({
        success: true,
        via: res.via,
        reply: res.reply,
        locked: res.locked !== undefined ? res.locked : ps4lockParseReply(res.reply)
      });
    });
  });
});

// قفل/فتح يدوي لجهاز (اختياري - لأزرار التحكم اليدوي)
ipcMain.handle('ps4lock-command', async (event, { deviceId, command }) => {
  if (!['lock', 'unlock', 'status'].includes(command)) {
    return { success: false, error: 'أمر غير صالح' };
  }
  return new Promise(resolve => {
    applyPs4Lock(deviceId, command, (err, res) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, via: res.via, reply: res.reply, locked: res.locked });
    });
  });
});

// إعدادات lockall (التوكن العام)
ipcMain.handle('get-ps4lock-settings', async () => {
  return new Promise(resolve => {
    getSetting('ps4lock_token', (e, token) => {
      resolve({ token: token || PS4LOCK_DEFAULT_TOKEN });
    });
  });
});
ipcMain.handle('set-ps4lock-settings', async (event, settings) => {
  return new Promise(resolve => {
    const token = String((settings && settings.token) || '').trim() || PS4LOCK_DEFAULT_TOKEN;
    setSetting('ps4lock_token', token, (e) => {
      resolve({ success: !e, error: e ? e.message : null });
    });
  });
});

// دالة إضافة تعديل جلسة
function addSessionModification({ session_id, type, value, price }, cb) {
  db.run('INSERT INTO session_modifications (session_id, type, value, price, created_at) VALUES (?, ?, ?, ?, ?)', [session_id, type, value, price, Date.now()], cb);
}
// دالة إضافة وقت إضافي لجلسة
function addExtraTimeToSession({ device_id, hours, minutes }, cb) {
  // جلب الجلسة النشطة
  db.get('SELECT * FROM sessions WHERE device_id = ? AND is_active = 1', [device_id], (err, session) => {
    if (err || !session) return cb(err || new Error('لا توجد جلسة نشطة'));
    if (session.type !== 'timed') return cb(new Error('الجلسة ليست مؤقتة'));
    const extraSeconds = (parseInt(hours) || 0) * 3600 + (parseInt(minutes) || 0) * 60;
    if (extraSeconds <= 0) return cb(new Error('يجب إضافة وقت أكبر من صفر'));

    // إذا كان هناك وقت انتهاء محدد مسبقاً، أضف الوقت إليه
    if (session.scheduled_end_time) {
      const newEndTime = session.scheduled_end_time + (extraSeconds * 1000);
      db.run('UPDATE sessions SET scheduled_end_time = ? WHERE id = ?', [newEndTime, session.id], function (updateErr) {
        if (updateErr) return cb(updateErr);
        // سجل التعديل
        addSessionModification({ session_id: session.id, type: 'extra_time', value: extraSeconds.toString(), price: null }, cb);
      });
    } else {
      // الطريقة القديمة: لتجنب الازدواجية في الحساب، قم بتحديث مدة الجلسة فقط بدون تسجيل تعديل إضافي
      const newDuration = (session.duration || 0) + extraSeconds;
      db.run('UPDATE sessions SET duration = ? WHERE id = ?', [newDuration, session.id], function (updateErr) {
        if (updateErr) return cb(updateErr);
        cb();
      });
    }
  });
}

ipcMain.handle('add-extra-time-to-session', async (event, data) => {
  return new Promise((resolve, reject) => {
    addExtraTimeToSession(data, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

// دالة جلب تعديلات الجلسة
function getSessionModifications(session_id, cb) {
  db.all('SELECT * FROM session_modifications WHERE session_id = ? ORDER BY created_at ASC', [session_id], cb);
}

ipcMain.handle('get-session-modifications', async (event, session_id) => {
  return new Promise((resolve, reject) => {
    getSessionModifications(session_id, (err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});

// دالة تغيير نوع الجلسة أو النمط
function updateSessionTypeOrMode({ device_id, newType, newMode, duration }, cb) {
  db.get('SELECT * FROM sessions WHERE device_id = ? AND is_active = 1', [device_id], (err, session) => {
    if (err || !session) return cb(err || new Error('لا توجد جلسة نشطة'));
    const updates = [];
    const mods = [];
    if (newType && newType !== session.type) {
      updates.push({ field: 'type', value: newType });
      mods.push({ session_id: session.id, type: 'change_type', value: `${session.type}->${newType}`, price: null });
      // إذا تم التحويل إلى مؤقتة وتم إرسال مدة جديدة
      if (newType === 'timed' && duration && duration > 0) {
        updates.push({ field: 'duration', value: duration });
        // إذا كان هناك وقت انتهاء محدد مسبقاً، احسبه من المدة الجديدة
        if (session.scheduled_end_time) {
          const newEndTime = session.start_time + (duration * 1000);
          updates.push({ field: 'scheduled_end_time', value: newEndTime });
        }
      }
    }
    if (newMode && newMode !== session.mode) {
      updates.push({ field: 'mode', value: newMode });
      mods.push({ session_id: session.id, type: 'change_mode', value: `${session.mode}->${newMode}`, price: null });
    }
    if (updates.length === 0) return cb(null, { success: true }); // لا يوجد تغيير
    // نفذ التحديث
    const setStr = updates.map(u => `${u.field} = ?`).join(', ');
    const values = updates.map(u => u.value);
    values.push(session.id);
    db.run(`UPDATE sessions SET ${setStr} WHERE id = ?`, values, function (updateErr) {
      if (updateErr) return cb(updateErr);
      // سجل التعديلات
      let done = 0;
      if (mods.length === 0) return cb(null, { success: true });
      mods.forEach(m => {
        addSessionModification(m, (err2) => {
          done++;
          if (done === mods.length) cb(null, { success: true });
        });
      });
    });
  });
}

ipcMain.handle('update-session-type-or-mode', async (event, data) => {
  return new Promise((resolve, reject) => {
    updateSessionTypeOrMode(data, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

// دالة حذف جهاز
function deleteDevice(deviceId, cb) {
  // تحقق من وجود جلسات مرتبطة
  db.get('SELECT COUNT(*) as cnt FROM sessions WHERE device_id = ?', [deviceId], (err, row) => {
    if (err) return cb(err);
    if (row && row.cnt > 0) {
      return cb(new Error('لا يمكن حذف الجهاز لأنه مرتبط بجلسات سابقة.'));
    }
    db.run('DELETE FROM devices WHERE id = ?', [deviceId], cb);
  });
}

ipcMain.handle('delete-device', async (event, deviceId) => {
  return new Promise((resolve, reject) => {
    deleteDevice(deviceId, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

// حفظ صورة الجهاز فعليًا في مجلد devices/
ipcMain.handle('save-device-image', async (event, filePath) => {
  try {
    const devicesDir = path.join(__dirname, 'devices');
    if (!fs.existsSync(devicesDir)) fs.mkdirSync(devicesDir);
    const ext = path.extname(filePath);
    const newFileName = 'dev_' + Date.now() + ext;
    const destPath = path.join(devicesDir, newFileName);
    fs.copyFileSync(filePath, destPath);
    return newFileName;
  } catch (err) {
    return null;
  }
});

ipcMain.handle('save-product-image', async (event, filePath) => {
  try {
    const productsDir = path.join(__dirname, 'products');
    if (!fs.existsSync(productsDir)) fs.mkdirSync(productsDir);
    const ext = path.extname(filePath);
    const newFileName = 'prod_' + Date.now() + ext;
    const destPath = path.join(productsDir, newFileName);
    fs.copyFileSync(filePath, destPath);
    return newFileName;
  } catch (err) {
    console.error('Error saving product image:', err);
    return null;
  }
});

// الحصول على رابط صفحة العميل
ipcMain.handle('get-customer-url', async () => {
  const ip = getLocalIPAddress();
  return `http://${ip}:${CUSTOMER_PORT}`;
});

// الحصول على جميع روابط صفحة العميل
ipcMain.handle('get-all-customer-urls', async () => {
  const ips = getAllLocalIPAddresses();
  return ips.map(ip => ({
    url: `http://${ip.address}:${CUSTOMER_PORT}`,
    interface: ip.interface,
    address: ip.address
  }));
});

// --- دوال الدورات ---
function saveTournament({ id, name, data }, cb) {
  if (id) {
    db.run('UPDATE tournaments SET name = ?, data = ? WHERE id = ?', [name, data, id], function (err) {
      if (err) return cb(err);
      cb(null, { id });
    });
  } else {
    db.run('INSERT INTO tournaments (name, data, created_at) VALUES (?, ?, ?)', [name, data, Date.now()], function (err) {
      if (err) return cb(err);
      cb(null, { id: this.lastID });
    });
  }
}
function getAllTournaments(cb) {
  db.all('SELECT * FROM tournaments ORDER BY created_at DESC', cb);
}
function getTournamentById(id, cb) {
  db.get('SELECT * FROM tournaments WHERE id = ?', [id], cb);
}
function deleteTournament(id, cb) {
  db.run('DELETE FROM tournaments WHERE id = ?', [id], cb);
}

// --- أوامر IPC للدورات ---
ipcMain.handle('save-tournament', async (event, data) => {
  return new Promise((resolve) => {
    saveTournament(data, (err, result) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, ...result });
    });
  });
});
ipcMain.handle('get-all-tournaments', async () => {
  return new Promise((resolve) => {
    getAllTournaments((err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});
ipcMain.handle('get-tournament-by-id', async (event, id) => {
  return new Promise((resolve) => {
    getTournamentById(id, (err, row) => {
      if (err || !row) resolve(null);
      else resolve(row);
    });
  });
});
ipcMain.handle('delete-tournament', async (event, id) => {
  return new Promise((resolve) => {
    deleteTournament(id, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

// --- دوال لاعبي الدورات ---
function addTournamentPlayer({ tournament_id, name }, cb) {
  db.run('INSERT INTO tournament_players (tournament_id, name) VALUES (?, ?)', [tournament_id, name], cb);
}
function getTournamentPlayers(tournament_id, cb) {
  db.all('SELECT * FROM tournament_players WHERE tournament_id = ?', [tournament_id], cb);
}
function deleteTournamentPlayer(player_id, cb) {
  db.run('DELETE FROM tournament_players WHERE id = ?', [player_id], cb);
}

// --- دوال مباريات الدورات ---
function addTournamentMatch({ tournament_id, round, player1_id, player2_id, match_time }, cb) {
  db.run('INSERT INTO tournament_matches (tournament_id, round, player1_id, player2_id, match_time) VALUES (?, ?, ?, ?, ?)', [tournament_id, round, player1_id, player2_id, match_time || null], cb);
}
function updateTournamentMatchResult({ match_id, winner_id, score }, cb) {
  db.run('UPDATE tournament_matches SET winner_id = ?, score = ? WHERE id = ?', [winner_id, score, match_id], cb);
}
function getTournamentMatches(tournament_id, cb) {
  db.all('SELECT * FROM tournament_matches WHERE tournament_id = ? ORDER BY round ASC, id ASC', [tournament_id], cb);
}
function deleteTournamentMatch(match_id, cb) {
  db.run('DELETE FROM tournament_matches WHERE id = ?', [match_id], cb);
}

// --- أوامر IPC للاعبين والمباريات ---
ipcMain.handle('add-tournament-player', async (event, data) => {
  return new Promise((resolve) => {
    addTournamentPlayer(data, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});
ipcMain.handle('get-tournament-players', async (event, tournament_id) => {
  return new Promise((resolve) => {
    getTournamentPlayers(tournament_id, (err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});
ipcMain.handle('delete-tournament-player', async (event, player_id) => {
  return new Promise((resolve) => {
    deleteTournamentPlayer(player_id, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});
ipcMain.handle('add-tournament-match', async (event, data) => {
  return new Promise((resolve) => {
    addTournamentMatch(data, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});
ipcMain.handle('update-tournament-match-result', async (event, data) => {
  return new Promise((resolve) => {
    updateTournamentMatchResult(data, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});
ipcMain.handle('get-tournament-matches', async (event, tournament_id) => {
  return new Promise((resolve) => {
    getTournamentMatches(tournament_id, (err, rows) => {
      if (err) resolve([]);
      else resolve(rows);
    });
  });
});
ipcMain.handle('delete-tournament-match', async (event, match_id) => {
  return new Promise((resolve) => {
    deleteTournamentMatch(match_id, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

function getHardwareSerial() {
  try {
    if (process.platform === 'win32') {
      const output = execSync('wmic diskdrive get SerialNumber').toString();
      const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
      // استبعد العنوان وخذ أول سيريال حقيقي
      const serials = lines.slice(1).filter(s => s && s !== 'SerialNumber');
      return serials[0] || 'UNKNOWN';
    } else if (process.platform === 'linux') {
      const output = execSync('cat /sys/class/dmi/id/product_uuid').toString().trim();
      return output;
    } else if (process.platform === 'darwin') {
      const output = execSync('ioreg -l | grep IOPlatformSerialNumber').toString();
      const match = output.match(/"IOPlatformSerialNumber" = "(.*?)"/);
      return match ? match[1] : 'UNKNOWN';
    }
  } catch (e) { return 'UNKNOWN'; }
}

function normalizeSerial6(serial) {
  return (String(serial || '').replace(/[^A-Za-z0-9]/g, '').slice(-6) || '000000').toUpperCase();
}

// PS-XXXXXX-DAYS
function generateActivationCode(serial, days = 30) {
  return 'PS-' + normalizeSerial6(serial) + '-' + days;
}

function getActivationRequestCode() {
  const serial = getHardwareSerial();
  // استخدم hash(serial + ثابت) ليكون الكود فريدًا
  const hash = crypto.createHash('sha256').update(serial + 'PS_ACTIVATION').digest('hex');
  // خذ أول 16 رمز فقط للسهولة
  return hash.slice(0, 16).toUpperCase();
}

function saveActivationInfoToFile(code, days, start) {
  const content = `Activation Code: ${code}\nTrial Days: ${days}\nStart Date: ${start}\n`;
  try {
    fs.writeFileSync(ACTIVATION_INFO_FILE, content, { encoding: 'utf-8' });
  } catch (e) {
    console.error('فشل حفظ ملف التفعيل:', e.message);
  }
}

// يقرأ كود التفعيل ويرجع عدد الأيام أو 0 لو الكود غير صالح
function parseActivationCode(code) {
  const clean = String(code || '').trim();
  if (!clean) return 0;
  if (clean.toLowerCase() === MASTER_ACTIVATION_CODE) return MASTER_ACTIVATION_DAYS;

  const requestCode = getActivationRequestCode();
  const serial6 = normalizeSerial6(getHardwareSerial());

  // الصيغة 1: PS-XXXXXX-DAYS (سيريال الجهاز)
  const m1 = clean.match(/^PS-([A-Za-z0-9]{6})-(\d{1,3})$/i);
  if (m1) {
    const days = parseInt(m1[2], 10);
    if (!(days > 0 && days <= 999)) return 0;
    return m1[1].toUpperCase() === serial6 ? days : 0;
  }

  // الصيغة 2: <كود الطلب>-DAYS (نفس الكود اللي بيظهر في نافذة التفعيل)
  const m2 = clean.match(/^([A-Fa-f0-9]{16})-(\d{1,3})$/);
  if (m2) {
    const days = parseInt(m2[2], 10);
    if (!(days > 0 && days <= 999)) return 0;
    return m2[1].toUpperCase() === requestCode ? days : 0;
  }

  return 0;
}

ipcMain.handle('activate-trial', async (event, rawCode) => {
  const code = String(rawCode || '').trim();
  const reply = (ok) => {
    try { event.sender.send('trial-activated', ok); } catch (e) { }
    return ok;
  };

  const days = parseActivationCode(code);
  if (!days) return reply(false);

  const now = await getTrustedNow();
  await new Promise((resolve) => setTrialDbInfo(now, now, days, resolve));
  await new Promise((resolve) => setTrialActivationCode(code, resolve));
  saveActivationInfoToFile(code, days, now);
  return reply(true);
});

// أرسل serial للواجهة لعرضه للمستخدم
ipcMain.handle('get-hardware-serial', async () => {
  return getHardwareSerial();
});

ipcMain.handle('get-activation-request-code', async () => {
  return getActivationRequestCode();
});

// دوال إعدادات المحل
function getShopSettings(cb) {
  db.get('SELECT * FROM shop_settings WHERE id = 1', cb);
}

function updateShopSettings({ shop_name, shop_logo }, cb) {
  db.run('UPDATE shop_settings SET shop_name = ?, shop_logo = ?, updated_at = ? WHERE id = 1', 
    [shop_name, shop_logo, Date.now()], cb);
}

// أوامر IPC لإعدادات المحل
ipcMain.handle('get-shop-settings', async () => {
  return new Promise((resolve) => {
    getShopSettings((err, row) => {
      if (err || !row) resolve({ shop_name: 'PS Game Center', shop_logo: null });
      else resolve(row);
    });
  });
});

ipcMain.handle('update-shop-settings', async (event, data) => {
  return new Promise((resolve) => {
    updateShopSettings(data, err => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

// --- دوال إدارة الشيفتات ---
function startShift({ user_id, opening_cash }, cb) {
  console.log('🚀 بدء شيفت جديد:', { user_id, opening_cash });
  
  // التحقق من صحة البيانات
  if (!user_id || user_id <= 0) {
    return cb(new Error('معرف المستخدم غير صحيح'));
  }
  
  if (opening_cash < 0) {
    return cb(new Error('النقد الافتتاحي لا يمكن أن يكون سالباً'));
  }
  
  // تحقق من وجود جدول الشيفتات أولاً
  checkShiftsTable((err, tableExists) => {
    if (err) {
      console.error('❌ خطأ في فحص جدول الشيفتات:', err);
      return cb(err);
    }
    
    if (!tableExists) {
      console.log('🔧 جدول الشيفتات غير موجود، محاولة إنشاؤه...');
      return fixShiftsTable((err) => {
        if (err) {
          console.error('❌ فشل في إنشاء جدول الشيفتات:', err);
          return cb(err);
        }
        // إعادة المحاولة بعد إنشاء الجدول
        startShift({ user_id, opening_cash }, cb);
      });
    }
    
    // تحقق من وجود المستخدم
    db.get('SELECT id FROM users WHERE id = ?', [user_id], (err, user) => {
      if (err) {
        console.error('❌ خطأ في فحص المستخدم:', err);
        return cb(err);
      }
      if (!user) {
        return cb(new Error('المستخدم غير موجود'));
      }
      
      // تحقق من وجود شيفت نشط
      db.get('SELECT * FROM shifts WHERE status = ?', ['active'], (err, activeShift) => {
        if (err) {
          console.error('❌ خطأ في فحص الشيفت النشط:', err);
          // إذا كان الخطأ بسبب عدم وجود عمود، حاول إصلاح الجدول
          if (err.message.includes('no such column:') || err.message.includes('NOT NULL constraint failed')) {
            console.log('🔧 مشكلة في بنية الجدول، محاولة الإصلاح...');
            
            // إصلاح سريع لمشكلة type
            fixShiftsTypeIssue((err) => {
              if (err) {
                console.error('❌ فشل في إصلاح مشكلة type:', err);
                return fixShiftsTable((err) => {
                  if (err) {
                    return cb(err);
                  }
                  // إعادة المحاولة بعد الإصلاح
                  startShift({ user_id, opening_cash }, cb);
                });
              }
              // إعادة المحاولة بعد إصلاح type
              startShift({ user_id, opening_cash }, cb);
            });
            return;
          }
          return cb(err);
        }
        if (activeShift) {
          console.log('⚠️ يوجد شيفت نشط بالفعل:', activeShift);
          return cb(new Error('يوجد شيفت نشط بالفعل. يجب إنهاؤه أولاً'));
        }
        
        const start_time = Date.now();
        console.log('💾 إدراج شيفت جديد:', { start_time, user_id, opening_cash });
        
        // جلب اسم المستخدم
        db.get('SELECT username FROM users WHERE id = ?', [user_id], (err, user) => {
          if (err) {
            console.error('❌ خطأ في جلب اسم المستخدم:', err);
            return cb(err);
          }
          
          const employeeName = user ? user.username : 'مستخدم';
          
          db.run('INSERT INTO shifts (start_time, user_id, employee_name, type, opening_cash, status) VALUES (?, ?, ?, ?, ?, ?)', 
            [start_time, user_id, employeeName, 'normal', opening_cash || 0, 'active'], function(err) {
            if (err) {
              console.error('❌ خطأ في إدراج الشيفت:', err);
              return cb(err);
            }
            console.log('✅ تم إنشاء الشيفت بنجاح:', this.lastID);
            cb(null, { id: this.lastID, start_time });
          });
        });
      });
    });
  });
}

function endShift({ shift_id, closing_cash, notes }, cb) {
  console.log('🛑 إنهاء الشيفت:', { shift_id, closing_cash, notes });
  
  // التحقق من صحة البيانات
  if (!shift_id || shift_id <= 0) {
    return cb(new Error('معرف الشيفت غير صحيح'));
  }
  
  if (closing_cash < 0) {
    return cb(new Error('النقد الإنهائي لا يمكن أن يكون سالباً'));
  }
  
  const end_time = Date.now();
  
  // حساب إجمالي المبيعات والمصروفات للشيفت
  db.get('SELECT * FROM shifts WHERE id = ? AND status = ?', [shift_id, 'active'], (err, shift) => {
    if (err) {
      console.error('❌ خطأ في جلب الشيفت:', err);
      return cb(err);
    }
    
    if (!shift) {
      console.log('⚠️ الشيفت غير موجود أو غير نشط');
      return cb(new Error('الشيفت غير موجود أو غير نشط'));
    }
    
    console.log('📊 حساب المبيعات والمصروفات للشيفت:', shift_id);
    
        // حساب المبيعات من الجلسات (تُحسب للشيفت الذي أنهى الجلسة)
        db.get(`SELECT SUM(total) as total_sales, SUM(discount_amount) as total_discount FROM sessions 
                WHERE end_time >= ? AND end_time <= ? AND is_active = 0`, 
                [shift.start_time, end_time], (err, salesResult) => {
      if (err) {
        console.error('❌ خطأ في حساب مبيعات الجلسات:', err);
        return cb(err);
      }
      
      const sessionsTotalSales = Math.max(0, (salesResult?.total_sales || 0) - (salesResult?.total_discount || 0));
      
        // حساب المبيعات من المنتجات المنفصلة
        db.get(`SELECT SUM(total) as standalone_sales FROM standalone_sales 
                WHERE date >= ? AND date <= ?`, 
                [shift.start_time, end_time], (err, standaloneResult) => {
          if (err) {
            console.error('❌ خطأ في حساب مبيعات المنتجات:', err);
            return cb(err);
          }

          // حساب مبيعات منتجات الجلسات
          db.get(`SELECT SUM(sp.total) as session_products_sales
                  FROM session_products sp
                  JOIN sessions s ON sp.session_id = s.id
                  WHERE s.end_time >= ? AND s.end_time <= ? AND s.is_active = 0`,
                  [shift.start_time, end_time], (err, sessionProductsResult) => {
            if (err) {
              console.error('❌ خطأ في حساب مبيعات منتجات الجلسات:', err);
              return cb(err);
            }
        
        // حساب المصروفات المرتبطة بالشيفت
        db.get(`SELECT SUM(amount) as total_expenses FROM expenses 
                WHERE shift_id = ?`, 
                [shift_id], (err, expensesResult) => {
          if (err) {
            console.error('❌ خطأ في حساب المصروفات:', err);
            return cb(err);
          }
          
          const fmtD = d => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
          const shiftStartStr = fmtD(new Date(shift.start_time));
          const shiftEndStr = fmtD(new Date(end_time));

          db.get(`SELECT COALESCE(SUM(amount),0) as trust_total, COUNT(*) as trust_count
                  FROM trust_deposits WHERE date >= ? AND date <= ?`,
            [shift.start_time, end_time], (err, trustResult) => {
            if (err) {
              console.error('❌ خطأ في حساب الأمانات:', err);
              return cb(err);
            }
            const trustDepositsTotal = Number(trustResult?.trust_total) || 0;
            const trustDepositsCount = Number(trustResult?.trust_count) || 0;

          db.get(`SELECT COALESCE(SUM(total_amount),0) as total_wages, COUNT(*) as wages_count 
                  FROM employee_payments WHERE payment_date >= ? AND payment_date <= ?`,
            [shiftStartStr, shiftEndStr], (err, wagesResult) => {
            const totalWages = wagesResult?.total_wages || 0;
            const wagesCount = wagesResult?.wages_count || 0;

            const totalSales = sessionsTotalSales + (standaloneResult?.standalone_sales || 0) + (sessionProductsResult?.session_products_sales || 0) + trustDepositsTotal;
            const totalExpenses = (expensesResult?.total_expenses || 0) + totalWages;
            
            console.log('💰 إجمالي المبيعات:', totalSales);
            console.log('💸 إجمالي المصروفات (شامل صرف اليومية):', totalExpenses);
            
            db.run(`UPDATE shifts SET end_time = ?, closing_cash = ?, total_sales = ?, 
                    total_expenses = ?, notes = ?, status = ? WHERE id = ?`,
              [end_time, closing_cash || 0, totalSales, totalExpenses, notes || null, 'completed', shift_id],
              function(err) {
                if (err) {
                  console.error('❌ خطأ في تحديث الشيفت:', err);
                  return cb(err);
                }
                
                const duration = Math.floor((end_time - shift.start_time) / (1000 * 60 * 60));
                console.log('✅ تم إنهاء الشيفت بنجاح:', { 
                  id: shift_id, 
                  duration: duration + ' ساعة',
                  total_sales: totalSales,
                  total_expenses: totalExpenses
                });
                
                cb(null, { 
                  id: shift_id, 
                  end_time, 
                  total_sales: totalSales, 
                  sessions_total: sessionsTotalSales,
                  total_expenses: totalExpenses,
                  duration: duration,
                  employee_wages_total: totalWages,
                  employee_wages_count: wagesCount,
                  trust_deposits_total: trustDepositsTotal,
                  trust_deposits_count: trustDepositsCount
                });
              });
            });
            });
        });
      });
    });
    });
  });
}

function getActiveShift(cb) {
  console.log('🔍 البحث عن الشيفت النشط...');
  db.get(`SELECT s.*, u.username FROM shifts s 
          LEFT JOIN users u ON s.user_id = u.id 
          WHERE s.status = ?`, ['active'], (err, row) => {
    if (err) {
      console.error('خطأ في البحث عن الشيفت النشط:', err);
      // إذا كان الخطأ بسبب عدم وجود عمود، حاول إصلاح الجدول
      if (err.message.includes('no such column:') || err.message.includes('NOT NULL constraint failed')) {
        console.log('🔧 مشكلة في بنية الجدول، محاولة الإصلاح...');
        
        // إصلاح سريع لمشكلة type
        fixShiftsTypeIssue((err) => {
          if (err) {
            console.error('❌ فشل في إصلاح مشكلة type:', err);
            return fixShiftsTable((err) => {
              if (err) {
                return cb(err);
              }
              // إعادة المحاولة بعد الإصلاح
              getActiveShift(cb);
            });
          }
          // إعادة المحاولة بعد إصلاح type
          getActiveShift(cb);
        });
        return;
      }
      return cb(err);
    }
    console.log('نتيجة البحث عن الشيفت النشط:', row);
    cb(null, row);
  });
}

function getAllShifts(cb) {
  console.log('📋 جلب جميع الشيفتات...');
  db.all(`SELECT s.*, u.username FROM shifts s 
          LEFT JOIN users u ON s.user_id = u.id 
          ORDER BY s.start_time DESC`, (err, rows) => {
    if (err) {
      console.error('❌ خطأ في جلب الشيفتات:', err);
      return cb(err);
    }
    console.log(`✅ تم جلب ${rows.length} شيفت`);
    cb(null, rows);
  });
}

function getShiftDetails(shift_id, cb) {
  db.get(`SELECT s.*, u.username FROM shifts s 
          LEFT JOIN users u ON s.user_id = u.id 
          WHERE s.id = ?`, [shift_id], (err, shift) => {
    if (err) return cb(err);
    if (!shift) return cb(new Error('الشيفت غير موجود'));
    
    // جلب الجلسات في الشيفت (تُحسب للشيفت الذي أنهى الجلسة)
    db.all(`SELECT se.*, d.name as device_name FROM sessions se 
            LEFT JOIN devices d ON se.device_id = d.id 
            WHERE se.end_time >= ? AND se.end_time <= ? AND se.is_active = 0`,
      [shift.start_time, shift.end_time || Date.now()], (err, sessions) => {
        if (err) return cb(err);
        
        // جلب المبيعات المنفصلة في الشيفت
        db.all(`SELECT ss.*, p.name as product_name, p.category as product_category FROM standalone_sales ss 
                LEFT JOIN products p ON ss.product_id = p.id 
                WHERE ss.date >= ? AND ss.date <= ?`,
          [shift.start_time, shift.end_time || Date.now()], (err, standaloneSales) => {
            if (err) return cb(err);
            
            // جلب المصروفات المرتبطة بالشيفت مباشرة
            db.all(`SELECT * FROM expenses WHERE shift_id = ? ORDER BY date DESC`,
              [shift_id], (err, expenses) => {
                if (err) return cb(err);
                
                db.all(`
                  SELECT d.*, 
                         cs.employee_name AS created_shift_employee,
                         ps.employee_name AS paid_shift_employee
                  FROM debts d
                  LEFT JOIN shifts cs ON d.created_shift_id = cs.id
                  LEFT JOIN shifts ps ON d.paid_shift_id = ps.id
                  WHERE d.created_shift_id = ? OR d.paid_shift_id = ?
                  ORDER BY d.date DESC, d.id DESC
                `, [shift_id, shift_id], (err, debtsRows) => {
                  if (err) return cb(err);

                  const summary = {
                    createdTotal: 0,
                    createdCount: 0,
                    collectedTotal: 0,
                    collectedCount: 0,
                    outstandingTotal: 0,
                    outstandingCount: 0
                  };

                  debtsRows.forEach((debt) => {
                    const amount = Number(debt.amount) || 0;
                    if (debt.created_shift_id === shift_id) {
                      summary.createdTotal += amount;
                      summary.createdCount += 1;
                      if (debt.status !== 'paid') {
                        summary.outstandingTotal += amount;
                        summary.outstandingCount += 1;
                      }
                    }
                    if (debt.status === 'paid' && debt.paid_shift_id === shift_id) {
                      summary.collectedTotal += amount;
                      summary.collectedCount += 1;
                    }
                  });
                
                  // جلب صرف اليومية للموظفين في تاريخ الشيفت
                  const fmtD = d => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
                  const sDate = new Date(shift.start_time);
                  const eDate = new Date(shift.end_time || Date.now());
                  const startStr = fmtD(sDate);
                  const endStr = fmtD(eDate);
                  db.all(`SELECT ep.*, u.username FROM employee_payments ep LEFT JOIN users u ON ep.user_id = u.id WHERE ep.payment_date >= ? AND ep.payment_date <= ? ORDER BY ep.created_at`,
                    [startStr, endStr], (err, wages) => {
                      const wagesTotal = (wages || []).reduce((s, w) => s + (w.total_amount || 0), 0);
                      db.all(`SELECT * FROM trust_deposits WHERE date >= ? AND date <= ? ORDER BY date DESC, id DESC`,
                        [shift.start_time, shift.end_time || Date.now()], (err, trustRows) => {
                          const trustTotal = (trustRows || []).reduce((s, t) => s + (Number(t.amount) || 0), 0);
                          cb(null, {
                            shift,
                            sessions: sessions || [],
                            standaloneSales: standaloneSales || [],
                            expenses: expenses || [],
                            debts: {
                              list: debtsRows || [],
                              summary
                            },
                            employee_wages: wages || [],
                            employee_wages_total: wagesTotal,
                            trust_deposits: trustRows || [],
                            trust_deposits_total: trustTotal
                          });
                        });
                    });
                });
              });
          });
      });
  });
}

// --- أوامر IPC للشيفتات ---
ipcMain.handle('start-shift', async (event, data) => {
  return new Promise((resolve) => {
    startShift(data, (err, result) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, ...result });
    });
  });
});

ipcMain.handle('end-shift', async (event, data) => {
  return new Promise((resolve) => {
    endShift(data, (err, result) => {
      console.log(result);
      
      
      if (err) return resolve({ success: false, error: err.message });
      console.log('✅ تم إنهاء الشيفت، التحقق من إعدادات تيليجرام...');
      // بعد إنهاء الشيفت، أرسل ملخص عبر تيليجرام إذا كانت الإعدادات متوفرة
      getSetting('telegram_bot_token', (e1, token) => {
        if (e1) {
          console.log('⚠️ خطأ في جلب التوكن:', e1.message);
          return resolve({ success: true, ...result });
        }
        if (!token) {
          console.log('⚠️ لا يوجد توكن تيليجرام محفوظ');
          return resolve({ success: true, ...result });
        }
        console.log('✅ تم العثور على التوكن');
        getAllTelegramChats((e2, chats) => {
          if (e2) {
            console.log('⚠️ خطأ في جلب قائمة الشاتات:', e2.message);
            return resolve({ success: true, ...result });
          }
          if (!chats || chats.length === 0) {
            console.log('⚠️ لا توجد شاتات محفوظة. يرجى إرسال /start للبوت أولاً');
            return resolve({ success: true, ...result });
          }
          const chatIds = chats.map(c => c.chat_id);
          console.log('✅ تم العثور على', chatIds.length, 'شات للإرسال');
          // جلب تفاصيل الشيفت لرسالة أوضح
          getShiftDetails(result.id, (e3, details) => {
            // صياغة الرسالة
            const totalSales = (result.total_sales || 0);
            const totalExpenses = (result.total_expenses || 0);
            const wagesTotal = result.employee_wages_total || 0;
            const totalDiscount = (!e3 && details) ? (details.sessions || []).reduce((s, x) => s + (Number(x.discount_amount) || 0), 0) : 0;
            const sessionsTotal = Number(result.sessions_total) || ((!e3 && details) ? (details.sessions || []).reduce((s, x) => s + (Math.max(0, (Number(x.total) || 0) - (Number(x.discount_amount) || 0))), 0) : 0);
            const openingCash = details?.shift?.opening_cash || 0;
            const net = openingCash + totalSales - totalExpenses;
            let text = `<b>انتهاء الشيفت #${result.id}</b>\n`;
            text += `المدة: ${result.duration || 0} ساعة\n`;

            text += `المستخدم: ${result.user_id || 'مستخدم غير معروف'}\n`;
            text += `النقد الافتتاحي: ${openingCash} جنيه\n`;
            text += `إجمالي الجلسات: ${sessionsTotal.toFixed ? sessionsTotal.toFixed(2) : sessionsTotal} جنيه\n`;
            if (totalDiscount > 0) {
              text += `خصومات الجلسات: -${totalDiscount.toFixed ? totalDiscount.toFixed(2) : totalDiscount} جنيه\n`;
            }
            if (result.trust_deposits_total > 0) {
              text += `الأمانات: ${result.trust_deposits_total.toFixed ? result.trust_deposits_total.toFixed(2) : result.trust_deposits_total} جنيه (${result.trust_deposits_count || 0})\n`;
            }
            text += `إجمالي المصروفات: ${totalExpenses.toFixed ? totalExpenses.toFixed(2) : totalExpenses} جنيه\n`;
            if (wagesTotal > 0) {
              text += `صرف اليومية: ${wagesTotal.toFixed ? wagesTotal.toFixed(2) : wagesTotal} جنيه\n`;
            }
            text += `النقد الإنهائي: ${result.closing_cash || 0} جنيه\n`;
            text += `الصافي: ${net.toFixed ? net.toFixed(2) : net} جنيه`;
            if (!e3 && details) {
              const sessionsCount = (details.sessions || []).length;
              const prodSales = (details.standaloneSales || []).reduce((s, x) => s + (x.total || 0), 0);
              text += `\nعدد الجلسات المنتهية: ${sessionsCount}`;
              text += `\nمبيعات المنتجات: ${prodSales.toFixed ? prodSales.toFixed(2) : prodSales} جنيه`;
            }
            console.log('📝 نص الرسالة:', text);
            sendTelegramMessage(token, chatIds, text, (sendErr) => {
              if (sendErr) {
                console.error('❌ فشل إرسال الرسالة لبعض الشاتات:', sendErr);
              } else {
                console.log('✅ تم إرسال الرسالة إلى جميع الشاتات بنجاح');
              }
              return resolve({ success: true, ...result });
            });
          });
        });  
      });
    });
  });
});

ipcMain.handle('get-active-shift', async () => {
  return new Promise((resolve) => {
    getActiveShift((err, shift) => {
      if (err || !shift) resolve(null);
      else resolve(shift);
    });
  });
});

ipcMain.handle('get-all-shifts', async () => {
  return new Promise((resolve) => {
    getAllShifts((err, shifts) => {
      if (err) resolve([]);
      else resolve(shifts);
    });
  });
});

ipcMain.handle('get-shifts-page', async (event, { page = 1, limit = 20 }) => {
  return new Promise((resolve) => {
    db.get('SELECT COUNT(*) as total FROM shifts', [], (err, row) => {
      const total = (!err && row) ? row.total : 0;
      const offset = (page - 1) * limit;
      db.all(`SELECT s.*, u.username FROM shifts s 
              LEFT JOIN users u ON s.user_id = u.id 
              ORDER BY s.start_time DESC LIMIT ? OFFSET ?`, [limit, offset], (err, shifts) => {
        if (err) resolve({ success: false, data: [], total: 0, page, limit });
        else resolve({ success: true, data: shifts || [], total, page, limit });
      });
    });
  });
});

// IPC لإعدادات تيليجرام
ipcMain.handle('set-telegram-settings', async (event, { botToken, chatId }) => {
  return new Promise((resolve) => {
    setSetting('telegram_bot_token', botToken || '', (e1) => {
      if (e1) return resolve({ success: false, error: e1.message });
      // إذا تم إدخال chat_id يدوياً، أضفه للقائمة
      if (chatId && chatId.trim()) {
        addTelegramChat(chatId.trim(), (e2) => {
          if (e2) return resolve({ success: false, error: e2.message });
          resolve({ success: true });
        });
      } else {
        resolve({ success: true });
      }
    });
  });
});
ipcMain.handle('get-telegram-settings', async () => {
  return new Promise((resolve) => {
    getSetting('telegram_bot_token', (e1, token) => {
      if (e1) return resolve({ success: false, error: e1.message });
      getAllTelegramChats((e2, chats) => {
        if (e2) return resolve({ success: false, error: e2.message });
        const chatIds = chats ? chats.map(c => c.chat_id) : [];
        resolve({ success: true, data: { botToken: token || '', chatIds: chatIds } });
      });
    });
  });
});

// IPC لإدارة الشاتات
ipcMain.handle('add-telegram-chat', async (event, chatId) => {
  return new Promise((resolve) => {
    addTelegramChat(chatId, (err) => {
      if (err) return resolve({ success: false, error: err.message });
      resolve({ success: true });
    });
  });
});
ipcMain.handle('remove-telegram-chat', async (event, chatId) => {
  return new Promise((resolve) => {
    removeTelegramChat(chatId, (err) => {
      if (err) return resolve({ success: false, error: err.message });
      resolve({ success: true });
    });
  });
});
ipcMain.handle('get-all-telegram-chats', async () => {
  return new Promise((resolve) => {
    getAllTelegramChats((err, chats) => {
      if (err) return resolve({ success: false, error: err.message, data: [] });
      resolve({ success: true, data: chats || [] });
    });
  });
});

// اختبار إرسال رسالة
ipcMain.handle('test-telegram-send', async () => {
  return new Promise((resolve) => {
    getSetting('telegram_bot_token', (e1, token) => {
      if (e1 || !token) return resolve({ success: false, error: 'لا يوجد توكن محفوظ' });
      getAllTelegramChats((e2, chats) => {
        if (e2) return resolve({ success: false, error: e2.message });
        if (!chats || chats.length === 0) return resolve({ success: false, error: 'لا توجد شاتات محفوظة. أرسل /start للبوت أولاً' });
        const chatIds = chats.map(c => c.chat_id);
        const testMsg = '🧪 هذه رسالة اختبار من نظام إدارة الشيفتات';
        sendTelegramMessage(token, chatIds, testMsg, (err) => {
          if (err) return resolve({ success: false, error: err.message });
          resolve({ success: true, message: `تم إرسال الرسالة إلى ${chatIds.length} شات بنجاح` });
        });
      });
    });
  });
});

ipcMain.handle('get-shift-details', async (event, shift_id) => {
  return new Promise((resolve) => {
    getShiftDetails(shift_id, (err, details) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, ...details });
    });
  });
});

// أوامر IPC للإحصائيات التفصيلية للشيفتات
ipcMain.handle('get-shift-products-stats', async (event, shift_id) => {
  return new Promise((resolve) => {
    getShiftProductsStats(shift_id, (err, stats) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, data: stats });
    });
  });
});

ipcMain.handle('get-shift-sessions-stats', async (event, shift_id) => {
  return new Promise((resolve) => {
    getShiftSessionsStats(shift_id, (err, stats) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, data: stats });
    });
  });
});

ipcMain.handle('get-shift-standalone-sales-stats', async (event, shift_id) => {
  return new Promise((resolve) => {
    getShiftStandaloneSalesStats(shift_id, (err, stats) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, data: stats });
    });
  });
});

ipcMain.handle('get-shift-detailed-stats', async (event, shift_id) => {
  return new Promise((resolve) => {
    getShiftDetailedStats(shift_id, (err, stats) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, data: stats });
    });
  });
});

// دالة للتحقق من وجود جدول الشيفتات
function checkShiftsTable(cb) {
  console.log('فحص وجود جدول الشيفتات...');
  db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='shifts'", (err, row) => {
    if (err) {
      console.error('خطأ في فحص جدول الشيفتات:', err);
      return cb(err);
    }
    console.log('نتيجة فحص جدول الشيفتات:', !!row);
    cb(null, !!row);
  });
}

// دالة لإصلاح جدول الشيفتات إذا كان ناقصاً
function fixShiftsTable(cb) {
  console.log('محاولة إصلاح جدول الشيفتات...');
  
  // إنشاء الجدول مرة أخرى
  db.run(`CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_time INTEGER NOT NULL,
    end_time INTEGER,
    user_id INTEGER,
    employee_name TEXT DEFAULT 'مستخدم',
    type TEXT DEFAULT 'normal',
    opening_cash REAL DEFAULT 0,
    closing_cash REAL DEFAULT 0,
    total_sales REAL DEFAULT 0,
    total_expenses REAL DEFAULT 0,
    notes TEXT,
    status TEXT DEFAULT 'active',
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`, (err) => {
    if (err) {
      console.error('خطأ في إصلاح جدول الشيفتات:', err);
      return cb(err);
    }
    
    console.log('تم إنشاء/إصلاح جدول الشيفتات بنجاح');
    
    // فحص وإضافة الأعمدة الناقصة
    db.all("PRAGMA table_info(shifts)", (err, columns) => {
      if (err) {
        console.error('خطأ في فحص أعمدة جدول الشيفتات:', err);
        return cb(err);
      }
      
      console.log('الأعمدة الموجودة في جدول الشيفتات:', columns.map(c => c.name));
      
      // قائمة الأعمدة المطلوبة
      const requiredColumns = [
        { name: 'user_id', type: 'INTEGER', default: null },
        { name: 'opening_cash', type: 'REAL', default: 0 },
        { name: 'closing_cash', type: 'REAL', default: 0 },
        { name: 'total_sales', type: 'REAL', default: 0 },
        { name: 'total_expenses', type: 'REAL', default: 0 },
        { name: 'notes', type: 'TEXT', default: null },
        { name: 'status', type: 'TEXT', default: 'active' },
        { name: 'created_at', type: 'INTEGER', default: '(strftime("%s","now"))' }
      ];
      
      let addedColumns = 0;
      let hasErrors = false;
      const totalColumns = requiredColumns.length;
      
      if (totalColumns === 0) {
        return cb(null);
      }
      
      requiredColumns.forEach(column => {
        const hasColumn = columns.some(col => col.name === column.name);
        if (!hasColumn) {
          console.log(`إضافة عمود ${column.name} إلى جدول الشيفتات...`);
          let alterQuery = `ALTER TABLE shifts ADD COLUMN ${column.name} ${column.type}`;
          if (column.default !== null) {
            alterQuery += ` DEFAULT ${column.default}`;
          }
          
          db.run(alterQuery, (err) => {
            if (err) {
              console.error(`خطأ في إضافة عمود ${column.name}:`, err);
              hasErrors = true;
            } else {
              console.log(`تم إضافة عمود ${column.name} بنجاح`);
            }
            addedColumns++;
            if (addedColumns === totalColumns) {
              if (hasErrors) {
                console.log('تم إصلاح جدول الشيفتات مع بعض الأخطاء');
              } else {
                console.log('تم إصلاح جدول الشيفتات بنجاح');
              }
              cb(null);
            }
          });
        } else {
          console.log(`عمود ${column.name} موجود بالفعل`);
          addedColumns++;
          if (addedColumns === totalColumns) {
            console.log('تم إصلاح جدول الشيفتات بنجاح');
            cb(null);
          }
        }
      });
    });
  });
}

ipcMain.handle('update-shift-opening-cash', async (event, { shift_id, opening_cash }) => {
  return new Promise((resolve) => {
    db.run('UPDATE shifts SET opening_cash = ? WHERE id = ?', [opening_cash, shift_id], function(err) {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('fix-shifts-table', async () => {
  return new Promise((resolve) => {
    fixShiftsTable((err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('fix-all-shifts-issues', async () => {
  return new Promise((resolve) => {
    fixAllShiftsIssues((err, result) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, ...result });
    });
  });
});

// دالة إنشاء نسخة احتياطية من الشيفتات
function backupShiftsData(cb) {
  console.log('💾 إنشاء نسخة احتياطية من بيانات الشيفتات...');
  
  const backupData = {
    timestamp: Date.now(),
    shifts: [],
    sessions: [],
    standalone_sales: [],
    expenses: []
  };
  
  // نسخ بيانات الشيفتات
  db.all('SELECT * FROM shifts ORDER BY start_time DESC', (err, shifts) => {
    if (err) {
      console.error('❌ خطأ في نسخ بيانات الشيفتات:', err);
      return cb(err);
    }
    
    backupData.shifts = shifts;
    console.log(`✅ تم نسخ ${shifts.length} شيفت`);
    
    // نسخ بيانات الجلسات
    db.all('SELECT * FROM sessions ORDER BY start_time DESC', (err, sessions) => {
      if (err) {
        console.error('❌ خطأ في نسخ بيانات الجلسات:', err);
        return cb(err);
      }
      
      backupData.sessions = sessions;
      console.log(`✅ تم نسخ ${sessions.length} جلسة`);
      
      // نسخ بيانات المبيعات المنفصلة
      db.all('SELECT * FROM standalone_sales ORDER BY date DESC', (err, sales) => {
        if (err) {
          console.error('❌ خطأ في نسخ بيانات المبيعات:', err);
          return cb(err);
        }
        
        backupData.standalone_sales = sales;
        console.log(`✅ تم نسخ ${sales.length} مبيعة منفصلة`);
        
        // نسخ بيانات المصروفات
        db.all('SELECT * FROM expenses ORDER BY date DESC', (err, expenses) => {
          if (err) {
            console.error('❌ خطأ في نسخ بيانات المصروفات:', err);
            return cb(err);
          }
          
          backupData.expenses = expenses;
          console.log(`✅ تم نسخ ${expenses.length} مصروف`);
          
          console.log('🎉 تم إنشاء النسخة الاحتياطية بنجاح');
          cb(null, backupData);
        });
      });
    });
  });
}

ipcMain.handle('backup-shifts-data', async () => {
  return new Promise((resolve) => {
    backupShiftsData((err, data) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, data });
    });
  });
});

// دالة سريعة لإصلاح مشكلة type
function fixShiftsTypeIssue(cb) {
  console.log('🔧 إصلاح مشكلة عمود type في الشيفتات...');
  
  // إضافة عمود type إذا لم يكن موجوداً
  db.run('ALTER TABLE shifts ADD COLUMN type TEXT DEFAULT "normal"', (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('❌ خطأ في إضافة عمود type:', err);
      return cb(err);
    }
    
    if (err && err.message.includes('duplicate column name')) {
      console.log('✅ عمود type موجود بالفعل');
    } else {
      console.log('✅ تم إضافة عمود type');
    }
    
    // تحديث الشيفتات التي لا تحتوي على type
    db.run('UPDATE shifts SET type = "normal" WHERE type IS NULL', (err) => {
      if (err) {
        console.error('❌ خطأ في تحديث الشيفتات:', err);
        return cb(err);
      }
      
      console.log('✅ تم إصلاح جميع الشيفتات');
      cb(null);
    });
  });
}

ipcMain.handle('fix-shifts-type-issue', async () => {
  return new Promise((resolve) => {
    fixShiftsTypeIssue((err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

// دالة لحساب الإحصائيات المالية للشيفتات
function getShiftsFinancialStats(cb) {
  console.log('📊 حساب الإحصائيات المالية للشيفتات...');
  
  // جلب جميع الشيفتات
  db.all('SELECT * FROM shifts', (err, shifts) => {
    if (err) {
      console.error('❌ خطأ في جلب الشيفتات:', err);
      return cb(err);
    }
    
    console.log(`📈 تم جلب ${shifts.length} شيفت`);
    
    // حساب الإحصائيات
    let totalSales = 0;
    let totalExpenses = 0;
    let totalShifts = shifts.length;
    let activeShifts = 0;
    let completedShifts = 0;
    let totalDuration = 0;
    let totalOpeningCash = 0;
    let totalClosingCash = 0;
    
    shifts.forEach(shift => {
      // المبيعات والمصروفات
      totalSales += shift.total_sales || 0;
      totalExpenses += shift.total_expenses || 0;
      totalOpeningCash += shift.opening_cash || 0;
      totalClosingCash += shift.closing_cash || 0;
      
      // عدد الشيفتات
      if (shift.status === 'active') {
        activeShifts++;
      } else if (shift.status === 'completed') {
        completedShifts++;
      }
      
      // حساب المدة
      if (shift.end_time && shift.start_time) {
        const duration = (shift.end_time - shift.start_time) / (1000 * 60 * 60); // بالساعات
        totalDuration += duration;
      }
    });
    
    // حساب صافي الربح
    const netProfit = totalSales - totalExpenses;
    
    // حساب متوسط الشيفت
    const averageShift = totalShifts > 0 ? totalSales / totalShifts : 0;
    
    // حساب متوسط المدة
    const averageDuration = completedShifts > 0 ? totalDuration / completedShifts : 0;
    
    const stats = {
      totalSales: totalSales,
      totalExpenses: totalExpenses,
      netProfit: netProfit,
      averageShift: averageShift,
      totalShifts: totalShifts,
      activeShifts: activeShifts,
      completedShifts: completedShifts,
      totalDuration: totalDuration,
      averageDuration: averageDuration,
      totalOpeningCash: totalOpeningCash,
      totalClosingCash: totalClosingCash,
      profitMargin: totalSales > 0 ? (netProfit / totalSales) * 100 : 0
    };
    
    console.log('✅ تم حساب الإحصائيات:', stats);
    cb(null, stats);
  });
}

ipcMain.handle('get-shifts-financial-stats', async () => {
  return new Promise((resolve) => {
    getShiftsFinancialStats((err, stats) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, stats });
    });
  });
});

// دالة لحساب إحصائيات الشيفت النشط
function getActiveShiftStats(cb) {
  console.log('📊 حساب إحصائيات الشيفت النشط...');
  
  db.get('SELECT * FROM shifts WHERE status = ?', ['active'], (err, activeShift) => {
    if (err) {
      console.error('❌ خطأ في جلب الشيفت النشط:', err);
      return cb(err);
    }
    
    if (!activeShift) {
      console.log('⚠️ لا يوجد شيفت نشط');
      return cb(null, null);
    }
    
    const shiftStartTime = activeShift.start_time;
    const currentTime = Date.now();
    const fmtD = d => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    const shiftStartDate = fmtD(new Date(shiftStartTime));
    const shiftEndDate = fmtD(new Date(currentTime));

    db.get(`SELECT SUM(total) as total_sessions_sales, SUM(discount_amount) as total_discount FROM sessions 
            WHERE end_time >= ? AND end_time <= ? AND is_active = 0`, 
            [shiftStartTime, currentTime], (err, sessionsResult) => {
      if (err) {
        console.error('❌ خطأ في حساب مبيعات الجلسات:', err);
        return cb(err);
      }
      
      const sessionsSales = Math.max(0, (sessionsResult?.total_sessions_sales || 0) - (sessionsResult?.total_discount || 0));
      
      db.get(`SELECT SUM(sp.total) as total_session_products_sales, 
                     SUM(sp.quantity) as total_session_products_qty
              FROM session_products sp
              JOIN sessions s ON sp.session_id = s.id
              WHERE s.end_time >= ? AND s.end_time <= ? AND s.is_active = 0`,
              [shiftStartTime, currentTime], (err, sessionProductsResult) => {
        if (err) {
          console.error('❌ خطأ في حساب مبيعات منتجات الجلسات:', err);
          return cb(err);
        }
        const sessionsProductsSales = sessionProductsResult?.total_session_products_sales || 0;
        const sessionsProductsQty = sessionProductsResult?.total_session_products_qty || 0;

        db.get(`SELECT SUM(total) as total_standalone_sales FROM standalone_sales 
                WHERE date >= ? AND date <= ?`, 
                [shiftStartTime, currentTime], (err, standaloneResult) => {
          if (err) {
            console.error('❌ خطأ في حساب المبيعات المنفردة:', err);
            return cb(err);
          }
          const standaloneSales = standaloneResult?.total_standalone_sales || 0;

          db.get(`SELECT SUM(amount) as total_expenses, COUNT(*) as expenses_count FROM expenses 
                  WHERE shift_id = ?`, 
                  [activeShift.id], (err, expensesResult) => {
            if (err) {
              console.error('❌ خطأ في حساب المصروفات:', err);
              return cb(err);
            }
            const totalExpenses = expensesResult?.total_expenses || 0;
            const expensesCount = expensesResult?.expenses_count || 0;

            db.get(`SELECT COUNT(*) as sessions_count FROM sessions 
                    WHERE end_time >= ? AND end_time <= ? AND is_active = 0`, 
                    [shiftStartTime, currentTime], (err, sessionsCountResult) => {
              if (err) {
                console.error('❌ خطأ في حساب عدد الجلسات:', err);
                return cb(err);
              }
              const sessionsCount = sessionsCountResult?.sessions_count || 0;

              db.get(`SELECT COUNT(*) as standalone_count FROM standalone_sales 
                      WHERE date >= ? AND date <= ?`, 
                      [shiftStartTime, currentTime], (err, standaloneCountResult) => {
                if (err) {
                  console.error('❌ خطأ في حساب عدد المبيعات المنفصلة:', err);
                  return cb(err);
                }

                const standaloneCount = standaloneCountResult?.standalone_count || 0;

                db.get(`SELECT COALESCE(SUM(ss.total),0) as k_total, COUNT(*) as k_cnt
                  FROM standalone_sales ss
                  INNER JOIN products p ON ss.product_id = p.id AND p.category = '__internal_kids_area__'
                  WHERE ss.date >= ? AND ss.date <= ?`, [shiftStartTime, currentTime], (err, kidsRes) => {
                  if (err) {
                    console.error('❌ خطأ في حساب مبيعات Kids Area:', err);
                    return cb(err);
                  }
                  const kidsAreaSales = Number(kidsRes?.k_total) || 0;
                  const kidsAreaCount = Number(kidsRes?.k_cnt) || 0;
                  const standaloneSalesExcludingKids = Math.max(0, (standaloneSales || 0) - kidsAreaSales);
                  const standaloneCountExcludingKids = Math.max(0, standaloneCount - kidsAreaCount);

                const durationMs = currentTime - shiftStartTime;
                const durationHours = durationMs / (1000 * 60 * 60);

                db.get(`SELECT COALESCE(SUM(amount),0) as trust_total, COUNT(*) as trust_count
                        FROM trust_deposits WHERE date >= ? AND date <= ?`,
                        [shiftStartTime, currentTime], (err, trustResult) => {
                  if (err) {
                    console.error('❌ خطأ في حساب الأمانات:', err);
                    return cb(err);
                  }
                  const trustDepositsTotal = Number(trustResult?.trust_total) || 0;
                  const trustDepositsCount = Number(trustResult?.trust_count) || 0;

                const grossSales = (sessionsSales || 0) + (sessionsProductsSales || 0) + (standaloneSales || 0) + trustDepositsTotal;

                db.get(`
                  SELECT 
                    COALESCE(SUM(amount),0) as created_amount,
                    COUNT(*) as created_count,
                    COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END),0) as created_paid_amount,
                    COALESCE(SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END),0) as created_paid_count
                  FROM debts
                  WHERE created_shift_id = ?
                `, [activeShift.id], (err, createdStats) => {
                    if (err) {
                      console.error('❌ خطأ في حساب المديونيات المُنشأة:', err);
                      return cb(err);
                    }

                    const createdAmount = createdStats?.created_amount || 0;
                    const createdCount = createdStats?.created_count || 0;
                    const createdPaidAmount = createdStats?.created_paid_amount || 0;
                    const createdPaidCount = createdStats?.created_paid_count || 0;
                    const outstandingAmount = Math.max(0, createdAmount - createdPaidAmount);
                    const outstandingCount = Math.max(0, createdCount - createdPaidCount);

                    db.get(`SELECT COALESCE(SUM(amount),0) as collected_amount, COUNT(*) as collected_count
                            FROM debts WHERE status = 'paid' AND paid_shift_id = ?`,
                      [activeShift.id], (err, paidDebtsResult) => {
                        if (err) {
                          console.error('❌ خطأ في حساب المديونيات المسددة:', err);
                          return cb(err);
                        }

                        const collectedAmount = paidDebtsResult?.collected_amount || 0;
                        const collectedCount = paidDebtsResult?.collected_count || 0;

                        db.get(`SELECT COALESCE(SUM(total_amount),0) as total_wages, COUNT(*) as wages_count FROM employee_payments WHERE payment_date >= ? AND payment_date <= ?`,
                          [shiftStartDate, shiftEndDate], (err, wagesResult) => {
                            const totalWages = wagesResult?.total_wages || 0;
                            const wagesCount = wagesResult?.wages_count || 0;

                        const netProfit = grossSales - (totalExpenses || 0) - totalWages;
                        const expectedCash = (activeShift.opening_cash || 0) + grossSales;

                        const stats = {
                          shiftId: activeShift.id,
                          totalSales: grossSales,
                          grossSales: grossSales,
                          sessionsSales: sessionsSales,
                          sessionsProductsSales: sessionsProductsSales,
                          sessionsProductsQty: sessionsProductsQty,
                          standaloneSales: standaloneSales,
                          kidsAreaSales: kidsAreaSales,
                          kidsAreaCount: kidsAreaCount,
                          standaloneSalesExcludingKids: standaloneSalesExcludingKids,
                          standaloneCountExcludingKids: standaloneCountExcludingKids,
                          totalExpenses: totalExpenses + totalWages,
                          netProfit: netProfit,
                          expectedCash: expectedCash,
                          sessionsCount: sessionsCount,
                          standaloneCount: standaloneCount,
                          expensesCount: expensesCount,
                          durationHours: durationHours,
                          openingCash: activeShift.opening_cash || 0,
                          debtCreatedAmount: createdAmount,
                          debtCreatedCount: createdCount,
                          debtOutstandingAmount: outstandingAmount,
                          debtOutstandingCount: outstandingCount,
                          debtCollectedAmount: collectedAmount,
                          debtCollectedCount: collectedCount,
                          employeeWagesTotal: totalWages,
                          employeeWagesCount: wagesCount,
                          trustDepositsTotal: trustDepositsTotal,
                          trustDepositsCount: trustDepositsCount
                        };

                          console.log('✅ تم حساب إحصائيات الشيفت النشط:', stats);
                          cb(null, stats);
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}


ipcMain.handle('get-active-shift-stats', async () => {
  return new Promise((resolve) => {
    getActiveShiftStats((err, stats) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, stats });
    });
  });
});

// دالة شاملة لفحص وإصلاح جميع مشاكل الشيفتات
function fixAllShiftsIssues(cb) {
  console.log('🔧 بدء فحص وإصلاح جميع مشاكل الشيفتات...');
  
  let issuesFound = [];
  let issuesFixed = [];
  
  // 1. فحص وجود الجدول
  checkShiftsTable((err, tableExists) => {
    if (err) {
      console.error('خطأ في فحص جدول الشيفتات:', err);
      return cb(err);
    }
    
    if (!tableExists) {
      console.log('❌ جدول الشيفتات غير موجود');
      issuesFound.push('جدول الشيفتات غير موجود');
      
      fixShiftsTable((err) => {
        if (err) {
          console.error('فشل في إنشاء جدول الشيفتات:', err);
          return cb(err);
        }
        console.log('✅ تم إنشاء جدول الشيفتات');
        issuesFixed.push('تم إنشاء جدول الشيفتات');
        continueFix();
      });
    } else {
      console.log('✅ جدول الشيفتات موجود');
      continueFix();
    }
  });
  
  function continueFix() {
    // 2. فحص الأعمدة
    db.all("PRAGMA table_info(shifts)", (err, columns) => {
      if (err) {
        console.error('خطأ في فحص أعمدة جدول الشيفتات:', err);
        return cb(err);
      }
      
      console.log('📋 الأعمدة الموجودة:', columns.map(c => c.name));
      
      const requiredColumns = [
        { name: 'user_id', type: 'INTEGER', default: null },
        { name: 'opening_cash', type: 'REAL', default: 0 },
        { name: 'closing_cash', type: 'REAL', default: 0 },
        { name: 'total_sales', type: 'REAL', default: 0 },
        { name: 'total_expenses', type: 'REAL', default: 0 },
        { name: 'notes', type: 'TEXT', default: null },
        { name: 'status', type: 'TEXT', default: 'active' },
        { name: 'created_at', type: 'INTEGER', default: '(strftime("%s","now"))' }
      ];
      
      const missingColumns = requiredColumns.filter(col => !columns.some(c => c.name === col.name));
      
      if (missingColumns.length > 0) {
        console.log('❌ أعمدة ناقصة:', missingColumns.map(c => c.name));
        issuesFound.push(`أعمدة ناقصة: ${missingColumns.map(c => c.name).join(', ')}`);
        
        let addedCount = 0;
        missingColumns.forEach(column => {
          console.log(`🔧 إضافة عمود ${column.name}...`);
          let alterQuery = `ALTER TABLE shifts ADD COLUMN ${column.name} ${column.type}`;
          if (column.default !== null) {
            alterQuery += ` DEFAULT ${column.default}`;
          }
          
          db.run(alterQuery, (err) => {
            if (err) {
              console.error(`❌ خطأ في إضافة عمود ${column.name}:`, err);
            } else {
              console.log(`✅ تم إضافة عمود ${column.name}`);
              issuesFixed.push(`تم إضافة عمود ${column.name}`);
            }
            addedCount++;
            if (addedCount === missingColumns.length) {
              checkDataIntegrity();
            }
          });
        });
      } else {
        console.log('✅ جميع الأعمدة موجودة');
        checkDataIntegrity();
      }
    });
  }
  
  function checkDataIntegrity() {
    // 3. فحص سلامة البيانات
    console.log('🔍 فحص سلامة البيانات...');
    
    // فحص الشيفتات النشطة المتعددة
    db.all('SELECT * FROM shifts WHERE status = ?', ['active'], (err, activeShifts) => {
      if (err) {
        console.error('خطأ في فحص الشيفتات النشطة:', err);
        return cb(err);
      }
      
      if (activeShifts.length > 1) {
        console.log('❌ يوجد أكثر من شيفت نشط:', activeShifts.length);
        issuesFound.push(`يوجد ${activeShifts.length} شيفتات نشطة`);
        
        // إنهاء جميع الشيفتات عدا الأخير
        const shiftsToEnd = activeShifts.slice(0, -1);
        let endedCount = 0;
        
        shiftsToEnd.forEach(shift => {
          const endTime = Date.now();
          db.run('UPDATE shifts SET status = ?, end_time = ? WHERE id = ?', 
            ['completed', endTime, shift.id], (err) => {
            if (err) {
              console.error(`❌ خطأ في إنهاء الشيفت ${shift.id}:`, err);
            } else {
              console.log(`✅ تم إنهاء الشيفت ${shift.id}`);
              issuesFixed.push(`تم إنهاء الشيفت ${shift.id}`);
            }
            endedCount++;
            if (endedCount === shiftsToEnd.length) {
              checkOrphanedData();
            }
          });
        });
      } else {
        console.log('✅ عدد الشيفتات النشطة صحيح');
        checkOrphanedData();
      }
    });
  }
  
  function checkOrphanedData() {
    // 4. فحص البيانات المفقودة
    console.log('🔍 فحص البيانات المفقودة...');
    
    // فحص الشيفتات بدون user_id أو employee_name أو type
    db.all('SELECT * FROM shifts WHERE user_id IS NULL OR employee_name IS NULL OR type IS NULL', (err, orphanedShifts) => {
      if (err) {
        console.error('خطأ في فحص الشيفتات المفقودة:', err);
        return cb(err);
      }
      
      if (orphanedShifts.length > 0) {
        console.log('❌ شيفتات تحتاج إصلاح:', orphanedShifts.length);
        issuesFound.push(`${orphanedShifts.length} شيفت يحتاج إصلاح`);
        
        // إصلاح الشيفتات
        let fixedCount = 0;
        orphanedShifts.forEach(shift => {
          const updates = [];
          const values = [];
          
          if (!shift.user_id) {
            updates.push('user_id = ?');
            values.push(1);
          }
          
          if (!shift.employee_name) {
            updates.push('employee_name = ?');
            values.push('مستخدم');
          }
          
          if (!shift.type) {
            updates.push('type = ?');
            values.push('normal');
          }
          
          if (updates.length > 0) {
            values.push(shift.id);
            const query = `UPDATE shifts SET ${updates.join(', ')} WHERE id = ?`;
            
            db.run(query, values, (err) => {
              if (err) {
                console.error(`❌ خطأ في إصلاح الشيفت ${shift.id}:`, err);
              } else {
                console.log(`✅ تم إصلاح الشيفت ${shift.id}`);
                issuesFixed.push(`تم إصلاح الشيفت ${shift.id}`);
              }
              fixedCount++;
              if (fixedCount === orphanedShifts.length) {
                finalizeFix();
              }
            });
          } else {
            fixedCount++;
            if (fixedCount === orphanedShifts.length) {
              finalizeFix();
            }
          }
        });
      } else {
        console.log('✅ جميع الشيفتات سليمة');
        finalizeFix();
      }
    });
  }
  
  function finalizeFix() {
    // 5. إنشاء فهارس لتحسين الأداء
    console.log('🔧 إنشاء فهارس لتحسين الأداء...');
    
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(status)',
      'CREATE INDEX IF NOT EXISTS idx_shifts_user_id ON shifts(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_shifts_start_time ON shifts(start_time)',
      'CREATE INDEX IF NOT EXISTS idx_sessions_active_start ON sessions(is_active, start_time)',
      'CREATE INDEX IF NOT EXISTS idx_standalone_sales_date ON standalone_sales(date)',
      'CREATE INDEX IF NOT EXISTS idx_session_products_session ON session_products(session_id)',
      'CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date)'
    ];
    
    let indexCount = 0;
    indexes.forEach(indexQuery => {
      db.run(indexQuery, (err) => {
        if (err) {
          console.error('❌ خطأ في إنشاء فهرس:', err);
        } else {
          console.log('✅ تم إنشاء فهرس');
        }
        indexCount++;
        if (indexCount === indexes.length) {
          completeFix();
        }
      });
    });
  }
  
  function completeFix() {
    console.log('🎉 تم الانتهاء من فحص وإصلاح الشيفتات');
    console.log('📊 المشاكل المكتشفة:', issuesFound.length);
    console.log('🔧 المشاكل المُصلحة:', issuesFixed.length);
    
    if (issuesFound.length > 0) {
      console.log('❌ المشاكل المكتشفة:', issuesFound);
    }
    if (issuesFixed.length > 0) {
      console.log('✅ المشاكل المُصلحة:', issuesFixed);
    }
    
    cb(null, {
      issuesFound: issuesFound.length,
      issuesFixed: issuesFixed.length,
      details: {
        found: issuesFound,
        fixed: issuesFixed
      }
    });
  }
}

// فحص وإصلاح جدول الشيفتات عند بدء التطبيق
function initializeShiftsTable() {
  console.log('🚀 تهيئة نظام الشيفتات...');
  fixAllShiftsIssues((err, result) => {
    if (err) {
      console.error('❌ فشل في تهيئة نظام الشيفتات:', err);
    } else {
      console.log('✅ تم تهيئة نظام الشيفتات بنجاح');
      if (result.issuesFixed > 0) {
        console.log(`🔧 تم إصلاح ${result.issuesFixed} مشكلة`);
      }
    }
  });
}

// ========== MikroTik Hotspot Management ==========

const HOTSPOT_SETTINGS_FILE = path.join(app.getPath('userData'), 'hotspot_settings.json');

// تحميل إعدادات Hotspot
function loadHotspotSettings(cb) {
  if (!fs.existsSync(HOTSPOT_SETTINGS_FILE)) {
    return cb(null, { ip: '', username: '', password: '' });
  }
  try {
    const data = fs.readFileSync(HOTSPOT_SETTINGS_FILE, 'utf8');
    cb(null, JSON.parse(data));
  } catch (err) {
    cb(err);
  }
}

// حفظ إعدادات Hotspot
function saveHotspotSettings(settings, cb) {
  try {
    fs.writeFileSync(HOTSPOT_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
    cb(null);
  } catch (err) {
    cb(err);
  }
}

// دالة للتفاعل مع MikroTik RouterOS API
function mikrotikAPIRequest(settings, command, params = {}, cb) {
  const { ip, username, password } = settings;
  
  if (!ip || !username || !password) {
    return cb(new Error('إعدادات الاتصال غير مكتملة'));
  }
  
  // استخدام RouterOS API Protocol عبر HTTP
  const url = `http://${ip}/rest`;
  const auth = Buffer.from(`${username}:${password}`).toString('base64');
  
  const options = {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    },
    timeout: 5000
  };
  
  // بناء URL مع الأمر والمعاملات
  let requestUrl = `${url}/${command}`;
  const queryParams = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
  if (queryParams) {
    requestUrl += '?' + queryParams;
  }
  
  const req = http.request(requestUrl, options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      if (res.statusCode === 200 || res.statusCode === 201) {
        try {
          const result = data ? JSON.parse(data) : [];
          cb(null, result);
        } catch (err) {
          cb(null, []);
        }
      } else if (res.statusCode === 401) {
        cb(new Error('فشل المصادقة. تحقق من اسم المستخدم وكلمة المرور'));
      } else {
        cb(new Error(`خطأ في الاتصال: ${res.statusCode}`));
      }
    });
  });
  
  req.on('error', (err) => {
    cb(new Error(`فشل الاتصال: ${err.message}`));
  });
  
  req.on('timeout', () => {
    req.destroy();
    cb(new Error('انتهت مهلة الاتصال'));
  });
  
  req.end();
}

// اختبار الاتصال
function testHotspotConnection(settings, cb) {
  mikrotikAPIRequest(settings, 'system/identity', {}, (err, result) => {
    if (err) return cb(err);
    cb(null, result);
  });
}

// جلب قائمة المستخدمين
function getHotspotUsers(settings, cb) {
  mikrotikAPIRequest(settings, 'ip/hotspot/user', {}, (err, result) => {
    if (err) return cb(err);
    cb(null, result);
  });
}

// إضافة مستخدم جديد
function addHotspotUser(settings, userData, cb) {
  mikrotikAPIRequest(settings, 'ip/hotspot/user', userData, (err, result) => {
    if (err) return cb(err);
    cb(null, result);
  });
}

// حذف مستخدم
function deleteHotspotUser(settings, userId, cb) {
  mikrotikAPIRequest(settings, `ip/hotspot/user/${userId}`, {}, (err, result) => {
    if (err) return cb(err);
    cb(null, result);
  });
}

// تفعيل/تعطيل مستخدم
function toggleHotspotUser(settings, userId, disabled, cb) {
  mikrotikAPIRequest(settings, `ip/hotspot/user/${userId}`, { disabled: disabled ? 'true' : 'false' }, (err, result) => {
    if (err) return cb(err);
    cb(null, result);
  });
}

// جلب قائمة الملفات الشخصية
function getHotspotProfiles(settings, cb) {
  mikrotikAPIRequest(settings, 'ip/hotspot/user/profile', {}, (err, result) => {
    if (err) return cb(err);
    cb(null, result);
  });
}

// IPC Handlers
ipcMain.handle('hotspot-get-settings', async () => {
  return new Promise((resolve) => {
    loadHotspotSettings((err, settings) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, data: settings });
    });
  });
});

ipcMain.handle('hotspot-save-settings', async (event, settings) => {
  return new Promise((resolve) => {
    saveHotspotSettings(settings, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true });
    });
  });
});

ipcMain.handle('hotspot-test-connection', async (event, settings) => {
  return new Promise((resolve) => {
    testHotspotConnection(settings, (err, result) => {
      if (err) resolve({ success: false, error: err.message });
      else resolve({ success: true, data: result });
    });
  });
});

ipcMain.handle('hotspot-get-users', async () => {
  return new Promise((resolve) => {
    loadHotspotSettings((err, settings) => {
      if (err) return resolve({ success: false, error: err.message });
      getHotspotUsers(settings, (err2, users) => {
        if (err2) resolve({ success: false, error: err2.message });
        else resolve({ success: true, data: users });
      });
    });
  });
});

ipcMain.handle('hotspot-add-user', async (event, userData) => {
  return new Promise((resolve) => {
    loadHotspotSettings((err, settings) => {
      if (err) return resolve({ success: false, error: err.message });
      addHotspotUser(settings, userData, (err2, result) => {
        if (err2) resolve({ success: false, error: err2.message });
        else resolve({ success: true, data: result });
      });
    });
  });
});

ipcMain.handle('hotspot-delete-user', async (event, userId) => {
  return new Promise((resolve) => {
    loadHotspotSettings((err, settings) => {
      if (err) return resolve({ success: false, error: err.message });
      deleteHotspotUser(settings, userId, (err2, result) => {
        if (err2) resolve({ success: false, error: err2.message });
        else resolve({ success: true, data: result });
      });
    });
  });
});

ipcMain.handle('hotspot-toggle-user', async (event, { userId, disabled }) => {
  return new Promise((resolve) => {
    loadHotspotSettings((err, settings) => {
      if (err) return resolve({ success: false, error: err.message });
      toggleHotspotUser(settings, userId, disabled, (err2, result) => {
        if (err2) resolve({ success: false, error: err2.message });
        else resolve({ success: true, data: result });
      });
    });
  });
});

ipcMain.handle('hotspot-get-profiles', async () => {
  return new Promise((resolve) => {
    loadHotspotSettings((err, settings) => {
      if (err) return resolve({ success: false, error: err.message });
      getHotspotProfiles(settings, (err2, profiles) => {
        if (err2) resolve({ success: false, error: err2.message });
        else resolve({ success: true, data: profiles });
      });
    });
  });
}); 