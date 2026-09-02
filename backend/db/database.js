const { createClient } = require('@libsql/client');
const path = require('path');
const crypto = require('crypto');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || `file:${path.join(__dirname, 'garage.db')}`,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function queryOne(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows[0] || null;
}

async function queryAll(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows;
}

async function queryRun(sql, args = []) {
  const result = await db.execute({ sql, args });
  return {
    lastInsertRowid: Number(result.lastInsertRowid),
    rowsAffected: result.rowsAffected,
  };
}

async function inicializarBaseDeDatos() {
  await db.execute(`CREATE TABLE IF NOT EXISTS families (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    family_id INTEGER NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'member')) DEFAULT 'member',
    created_at TEXT NOT NULL,
    FOREIGN KEY (family_id) REFERENCES families (id) ON DELETE CASCADE
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS vehicles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    marca TEXT NOT NULL,
    modelo TEXT NOT NULL,
    patente TEXT NOT NULL,
    año INTEGER NOT NULL,
    foto_url TEXT,
    family_id INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (family_id) REFERENCES families (id) ON DELETE CASCADE
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS expirations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id INTEGER NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('seguro', 'vtv', 'matafuegos', 'otro')),
    tipo_personalizado TEXT,
    fecha_vencimiento TEXT NOT NULL,
    observaciones TEXT,
    estado TEXT NOT NULL DEFAULT 'vigente',
    notified_30 INTEGER NOT NULL DEFAULT 0,
    notified_15 INTEGER NOT NULL DEFAULT 0,
    notified_5 INTEGER NOT NULL DEFAULT 0,
    notified_0 INTEGER NOT NULL DEFAULT 0,
    last_daily_reminder_date TEXT,
    FOREIGN KEY (vehicle_id) REFERENCES vehicles (id) ON DELETE CASCADE
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS repairs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id INTEGER NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('cambio_bateria', 'cambio_aceite', 'cambio_ruedas', 'aire_acondicionado', 'otro')),
    tipo_personalizado TEXT,
    descripcion TEXT NOT NULL,
    fecha TEXT NOT NULL,
    costo REAL,
    kilometraje INTEGER,
    FOREIGN KEY (vehicle_id) REFERENCES vehicles (id) ON DELETE CASCADE
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id INTEGER NOT NULL,
    family_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    FOREIGN KEY (vehicle_id) REFERENCES vehicles (id) ON DELETE CASCADE,
    FOREIGN KEY (family_id) REFERENCES families (id) ON DELETE CASCADE
  )`);

  await migrateColumn('vehicles', 'family_id', 'INTEGER DEFAULT 1');
  await migrateVehiclesPatenteIndex();
  await ensureDefaultFamily();
  await db.execute('UPDATE vehicles SET family_id = 1 WHERE family_id IS NULL');
  await migrateColumn('expirations', 'tipo_personalizado', 'TEXT');
  await migrateColumn('expirations', 'estado', "TEXT NOT NULL DEFAULT 'vigente'");
  await migrateColumn('expirations', 'notified_30', 'INTEGER NOT NULL DEFAULT 0');
  await migrateColumn('expirations', 'notified_15', 'INTEGER NOT NULL DEFAULT 0');
  await migrateColumn('expirations', 'notified_5', 'INTEGER NOT NULL DEFAULT 0');
  await migrateColumn('expirations', 'notified_0', 'INTEGER NOT NULL DEFAULT 0');
  await migrateColumn('expirations', 'last_daily_reminder_date', 'TEXT');
  await migrateColumn('repairs', 'tipo_personalizado', 'TEXT');
  await migrateExpirationsFK();
  await migrateRepairsFK();
  await initNotificationFlags();
  await ensureTestUser();

  console.log('Base de datos inicializada correctamente');
}

async function migrateVehiclesPatenteIndex() {
  try {
    const indexes = await queryAll("PRAGMA index_list('vehicles')");
    const hasGlobalPatenteIndex = indexes.some((index) => {
      if (!index.unique) return false;
      return false; // placeholder — real check below
    });
    // Buscar índice único de columna única sobre 'patente'
    let needsMigration = false;
    for (const index of indexes) {
      if (!index.unique) continue;
      const info = await queryAll(`PRAGMA index_info(${index.name})`);
      if (info.length === 1 && info[0].name === 'patente') {
        needsMigration = true;
        break;
      }
    }
    if (!needsMigration) return;

    console.log('Migrando índice único de patente en vehicles a nivel familia');
    await db.execute('ALTER TABLE vehicles RENAME TO vehicles_old');
    await db.execute(`CREATE TABLE vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      marca TEXT NOT NULL,
      modelo TEXT NOT NULL,
      patente TEXT NOT NULL,
      año INTEGER NOT NULL,
      foto_url TEXT,
      family_id INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (family_id) REFERENCES families (id) ON DELETE CASCADE
    )`);
    await db.execute(`INSERT INTO vehicles (id, marca, modelo, patente, año, foto_url, family_id)
      SELECT id, marca, modelo, patente, año, foto_url, family_id FROM vehicles_old`);
    await db.execute('DROP TABLE vehicles_old');
    await db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicles_family_patente ON vehicles(family_id, patente)');
  } catch (e) {
    console.error('Error en migrateVehiclesPatenteIndex:', e.message);
  }
}

async function ensureDefaultFamily() {
  const family = await queryOne('SELECT id FROM families ORDER BY id LIMIT 1');
  if (!family) {
    await queryRun('INSERT INTO families (name, created_at) VALUES (?, ?)', ['Familia', new Date().toISOString()]);
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function daysUntil(fechaVencimiento) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(fechaVencimiento);
  exp.setHours(0, 0, 0, 0);
  return Math.round((exp - today) / (1000 * 60 * 60 * 24));
}

async function initNotificationFlags() {
  try {
    const rows = await queryAll(
      'SELECT id, fecha_vencimiento FROM expirations WHERE notified_30 = 0 AND notified_15 = 0 AND notified_5 = 0 AND notified_0 = 0'
    );
    for (const row of rows) {
      const d = daysUntil(row.fecha_vencimiento);
      // A partir de los 15 días (inclusive vencido) los recordatorios pasan a
      // ser diarios (ver backend/services/notifications.js), así que el aviso
      // único de 30 días ya no aplica si el registro ya está dentro de esa
      // ventana.
      await queryRun('UPDATE expirations SET notified_30 = ? WHERE id = ?', [d <= 15 ? 1 : 0, row.id]);
    }
  } catch (e) {
    console.error('Error en initNotificationFlags:', e.message);
  }
}

async function ensureTestUser() {
  const testEmail = 'admingarage@gmail.com';
  const existing = await queryOne('SELECT id FROM users WHERE email = ?', [testEmail]);
  if (existing) return;

  let family = await queryOne("SELECT id FROM families WHERE name = 'Demo'");
  if (!family) {
    const { lastInsertRowid } = await queryRun(
      'INSERT INTO families (name, created_at) VALUES (?, ?)',
      ['Demo', new Date().toISOString()]
    );
    family = { id: lastInsertRowid };
  }

  const passwordHash = hashPassword('GarageManager');
  await queryRun(
    'INSERT INTO users (family_id, email, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [family.id, testEmail, passwordHash, 'Admin Demo', 'admin', new Date().toISOString()]
  );
  console.log('Usuario de prueba creado: admingarage@gmail.com');
}

async function migrateExpirationsFK() {
  try {
    const schema = await queryOne("SELECT sql FROM sqlite_master WHERE type='table' AND name='expirations'");
    if (!schema || !schema.sql.includes('vehicles_old')) return;

    console.log('Migrando FK de expirations: apuntando a vehicles...');
    await db.execute('ALTER TABLE expirations RENAME TO expirations_old');
    await db.execute(`CREATE TABLE expirations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('seguro', 'vtv', 'matafuegos', 'otro')),
      tipo_personalizado TEXT,
      fecha_vencimiento TEXT NOT NULL,
      observaciones TEXT,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles (id) ON DELETE CASCADE
    )`);
    await db.execute(`INSERT INTO expirations (id, vehicle_id, tipo, tipo_personalizado, fecha_vencimiento, observaciones)
      SELECT id, vehicle_id, tipo, tipo_personalizado, fecha_vencimiento, observaciones FROM expirations_old`);
    await db.execute('DROP TABLE expirations_old');
    console.log('Migración expirations FK completada');
  } catch (e) {
    console.error('Error en migrateExpirationsFK:', e.message);
  }
}

async function migrateRepairsFK() {
  try {
    const schema = await queryOne("SELECT sql FROM sqlite_master WHERE type='table' AND name='repairs'");
    if (!schema || !schema.sql.includes('vehicles_old')) return;

    console.log('Migrando FK de repairs: apuntando a vehicles...');
    await db.execute('ALTER TABLE repairs RENAME TO repairs_old');
    await db.execute(`CREATE TABLE repairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('cambio_bateria', 'cambio_aceite', 'cambio_ruedas', 'aire_acondicionado', 'otro')),
      tipo_personalizado TEXT,
      descripcion TEXT NOT NULL,
      fecha TEXT NOT NULL,
      costo REAL,
      kilometraje INTEGER,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles (id) ON DELETE CASCADE
    )`);
    await db.execute(`INSERT INTO repairs (id, vehicle_id, tipo, tipo_personalizado, descripcion, fecha, costo, kilometraje)
      SELECT id, vehicle_id, tipo, tipo_personalizado, descripcion, fecha, costo, kilometraje FROM repairs_old`);
    await db.execute('DROP TABLE repairs_old');
    console.log('Migración repairs FK completada');
  } catch (e) {
    console.error('Error en migrateRepairsFK:', e.message);
  }
}

async function migrateColumn(table, column, type) {
  try {
    const columnInfo = await queryAll(`PRAGMA table_info(${table})`);
    const exists = columnInfo.some((col) => col.name === column);
    if (!exists) {
      console.log(`Migrando tabla ${table}: agregando columna ${column}`);
      await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  } catch (e) {
    console.error(`Error en migrateColumn(${table}, ${column}):`, e.message);
  }
}

module.exports = { db, inicializarBaseDeDatos, queryOne, queryAll, queryRun };
