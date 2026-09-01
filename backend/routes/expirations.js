const express = require('express');
const { queryOne, queryAll, queryRun } = require('../db/database');
const auth = require('../middleware/auth');
const router = express.Router();

router.use(auth);

function daysUntil(fechaVencimiento) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(fechaVencimiento);
  exp.setHours(0, 0, 0, 0);
  return Math.round((exp - today) / (1000 * 60 * 60 * 24));
}

// Mismo orden y umbrales que backend/services/notifications.js: el primero
// cuyo umbral ya "aplica" (dias <= umbral) es el que debe notificarse en el
// próximo chequeo, así que se deja en 0. Los umbrales más lejanos que ese ya
// no tienen sentido notificarlos (por eso se marcan como ya notificados de
// entrada), evitando además notificaciones en cascada los días siguientes.
const NOTIFICATION_THRESHOLDS = [
  { days: 0, field: 'notified_0' },
  { days: 5, field: 'notified_5' },
  { days: 15, field: 'notified_15' },
  { days: 30, field: 'notified_30' },
];

function notificationFlagsForDate(fecha) {
  const d = daysUntil(fecha);
  const flags = { notified_0: 0, notified_5: 0, notified_15: 0, notified_30: 0 };
  const applicableIndex = NOTIFICATION_THRESHOLDS.findIndex(t => d <= t.days);
  if (applicableIndex !== -1) {
    for (let i = applicableIndex + 1; i < NOTIFICATION_THRESHOLDS.length; i++) {
      flags[NOTIFICATION_THRESHOLDS[i].field] = 1;
    }
  }
  return flags;
}

async function verifyVehicleFamily(vehicleId, familyId) {
  return queryOne('SELECT id FROM vehicles WHERE id = ? AND family_id = ?', [vehicleId, familyId]);
}

async function verifyExpirationFamily(expirationId, familyId) {
  return queryOne(
    'SELECT e.id FROM expirations e JOIN vehicles v ON e.vehicle_id = v.id WHERE e.id = ? AND v.family_id = ?',
    [expirationId, familyId]
  );
}

router.get('/vehicles/:id/expirations', async (req, res) => {
  try {
    const vehicle = await verifyVehicleFamily(req.params.id, req.user.familyId);
    if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado' });

    const expirations = await queryAll(
      'SELECT * FROM expirations WHERE vehicle_id = ? ORDER BY fecha_vencimiento ASC',
      [req.params.id]
    );
    res.json(expirations);
  } catch (error) {
    console.error('Error al obtener vencimientos:', error);
    res.status(500).json({ error: 'Error al obtener vencimientos' });
  }
});

router.post('/vehicles/:id/expirations', async (req, res) => {
  try {
    const vehicleId = req.params.id;
    const { tipo, tipo_personalizado, fecha_vencimiento, observaciones } = req.body;

    if (!tipo || !fecha_vencimiento) {
      return res.status(400).json({ error: 'El tipo y la fecha de vencimiento son obligatorios' });
    }
    if (!['seguro', 'vtv', 'matafuegos', 'otro'].includes(tipo)) {
      return res.status(400).json({ error: 'Tipo de vencimiento no válido' });
    }
    if (tipo === 'otro' && !tipo_personalizado) {
      return res.status(400).json({ error: 'Cuando el tipo es "Otro", debe especificar el nombre' });
    }

    const vehicle = await verifyVehicleFamily(vehicleId, req.user.familyId);
    if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado' });

    const flags = notificationFlagsForDate(fecha_vencimiento);
    const { lastInsertRowid } = await queryRun(
      `INSERT INTO expirations
        (vehicle_id, tipo, tipo_personalizado, fecha_vencimiento, observaciones,
         estado, notified_30, notified_15, notified_5, notified_0)
       VALUES (?, ?, ?, ?, ?, 'vigente', ?, ?, ?, ?)`,
      [vehicleId, tipo, tipo_personalizado || null, fecha_vencimiento, observaciones || null,
       flags.notified_30, flags.notified_15, flags.notified_5, flags.notified_0]
    );
    const newExpiration = await queryOne('SELECT * FROM expirations WHERE id = ?', [lastInsertRowid]);
    res.status(201).json(newExpiration);
  } catch (error) {
    console.error('Error al crear vencimiento:', error);
    res.status(500).json({ error: 'Error al crear vencimiento' });
  }
});

router.put('/expirations/:id', async (req, res) => {
  try {
    const expirationId = req.params.id;
    const { tipo, tipo_personalizado, fecha_vencimiento, observaciones } = req.body;

    if (!tipo || !fecha_vencimiento) {
      return res.status(400).json({ error: 'El tipo y la fecha de vencimiento son obligatorios' });
    }
    if (!['seguro', 'vtv', 'matafuegos', 'otro'].includes(tipo)) {
      return res.status(400).json({ error: 'Tipo de vencimiento no válido' });
    }
    if (tipo === 'otro' && !tipo_personalizado) {
      return res.status(400).json({ error: 'Cuando el tipo es "Otro", debe especificar el nombre' });
    }

    const existing = await verifyExpirationFamily(expirationId, req.user.familyId);
    if (!existing) return res.status(404).json({ error: 'Vencimiento no encontrado' });

    const flags = notificationFlagsForDate(fecha_vencimiento);
    const { rowsAffected } = await queryRun(
      `UPDATE expirations
       SET tipo = ?, tipo_personalizado = ?, fecha_vencimiento = ?, observaciones = ?,
           estado = 'vigente', notified_30 = ?, notified_15 = ?, notified_5 = ?, notified_0 = ?
       WHERE id = ?`,
      [tipo, tipo_personalizado || null, fecha_vencimiento, observaciones || null,
       flags.notified_30, flags.notified_15, flags.notified_5, flags.notified_0,
       expirationId]
    );
    if (rowsAffected === 0) return res.status(404).json({ error: 'Vencimiento no encontrado' });

    const updated = await queryOne('SELECT * FROM expirations WHERE id = ?', [expirationId]);
    res.json(updated);
  } catch (error) {
    console.error('Error al actualizar vencimiento:', error);
    res.status(500).json({ error: 'Error al actualizar vencimiento' });
  }
});

router.patch('/expirations/:id/regularizar', async (req, res) => {
  try {
    const existing = await verifyExpirationFamily(req.params.id, req.user.familyId);
    if (!existing) return res.status(404).json({ error: 'Vencimiento no encontrado' });

    await queryRun(
      "UPDATE expirations SET estado = 'regularizado' WHERE id = ?",
      [req.params.id]
    );
    const updated = await queryOne('SELECT * FROM expirations WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (error) {
    console.error('Error al regularizar vencimiento:', error);
    res.status(500).json({ error: 'Error al regularizar vencimiento' });
  }
});

router.patch('/expirations/:id/activar', async (req, res) => {
  try {
    const existing = await verifyExpirationFamily(req.params.id, req.user.familyId);
    if (!existing) return res.status(404).json({ error: 'Vencimiento no encontrado' });

    const exp = await queryOne('SELECT fecha_vencimiento FROM expirations WHERE id = ?', [req.params.id]);
    const flags = notificationFlagsForDate(exp.fecha_vencimiento);

    await queryRun(
      `UPDATE expirations
       SET estado = 'vigente', notified_30 = ?, notified_15 = ?, notified_5 = ?, notified_0 = ?
       WHERE id = ?`,
      [flags.notified_30, flags.notified_15, flags.notified_5, flags.notified_0, req.params.id]
    );
    const updated = await queryOne('SELECT * FROM expirations WHERE id = ?', [req.params.id]);
    res.json(updated);
  } catch (error) {
    console.error('Error al activar vencimiento:', error);
    res.status(500).json({ error: 'Error al activar vencimiento' });
  }
});

router.delete('/expirations/:id', async (req, res) => {
  try {
    const expirationId = req.params.id;
    const existing = await verifyExpirationFamily(expirationId, req.user.familyId);
    if (!existing) return res.status(404).json({ error: 'Vencimiento no encontrado' });

    const { rowsAffected } = await queryRun('DELETE FROM expirations WHERE id = ?', [expirationId]);
    if (rowsAffected === 0) return res.status(404).json({ error: 'Vencimiento no encontrado' });

    res.json({ message: 'Vencimiento eliminado correctamente' });
  } catch (error) {
    console.error('Error al eliminar vencimiento:', error);
    res.status(500).json({ error: 'Error al eliminar vencimiento' });
  }
});

module.exports = router;
