const sgMail = require('@sendgrid/mail');
const { queryAll, queryRun } = require('../db/database');

// A partir de esta cantidad de días (inclusive, y también ya vencido) se
// manda un recordatorio TODOS los días hasta que el usuario regularice el
// vencimiento. Antes de eso, solo hay un aviso único a los 30 días.
const DAILY_REMINDER_WINDOW_DAYS = 15;
const EARLY_WARNING_DAYS = 30;

const TIPO_LABELS = {
  seguro: 'Seguro',
  vtv: 'VTV',
  matafuegos: 'Matafuegos',
  otro: 'Otro',
};

// "Hoy" en la zona horaria de Argentina (sin horario de verano, UTC-3 fijo),
// no en UTC — si se calculara con UTC, entre las 21:00 y 23:59 hora
// argentina ya sería "el día siguiente" para el servidor, haciendo que un
// chequeo corrido de noche marque como "ya notificado hoy" un día que en
// Argentina todavía no llegó.
function todayInArgentina() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
}

function daysUntil(fechaVencimiento) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(fechaVencimiento);
  exp.setHours(0, 0, 0, 0);
  return Math.round((exp - today) / (1000 * 60 * 60 * 24));
}

async function sendReminderEmail(to, displayName, { tipoLabel, vehiculo, fechaVencimiento, days }) {
  const dateStr = new Date(fechaVencimiento + 'T12:00:00').toLocaleDateString('es-AR', {
    day: '2-digit', month: 'long', year: 'numeric',
  });

  let urgencyColor, urgencyText, subjectPrefix;
  if (days < 0) {
    urgencyColor = '#dc2626';
    urgencyText = `venció el ${dateStr} (hace ${Math.abs(days)} día${Math.abs(days) !== 1 ? 's' : ''})`;
    subjectPrefix = '⚠️ VENCIDO';
  } else if (days === 0) {
    urgencyColor = '#dc2626';
    urgencyText = `vence HOY (${dateStr})`;
    subjectPrefix = '🚨 VENCE HOY';
  } else {
    urgencyColor = days <= 5 ? '#dc2626' : '#d97706';
    urgencyText = `vence el ${dateStr} (en ${days} día${days !== 1 ? 's' : ''})`;
    subjectPrefix = `🔔 Vence en ${days} días`;
  }

  const subject = `${subjectPrefix}: ${tipoLabel} — ${vehiculo}`;

  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#1e3a5f,#1d4ed8);padding:24px 28px">
        <h1 style="color:#fff;margin:0;font-size:20px;font-weight:600">GarageManager</h1>
        <p style="color:#93c5fd;margin:4px 0 0;font-size:13px">Recordatorio de vencimiento</p>
      </div>
      <div style="padding:28px">
        <p style="color:#334155;margin:0 0 16px">Hola <strong>${displayName}</strong>,</p>
        <p style="color:#334155;margin:0 0 20px">
          Te avisamos que el <strong>${tipoLabel}</strong> del vehículo
          <strong>${vehiculo}</strong>
          <span style="color:${urgencyColor};font-weight:600"> ${urgencyText}</span>.
        </p>
        <a href="https://garage-manager-five.vercel.app"
           style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px">
          Ir a GarageManager
        </a>
        <p style="color:#94a3b8;font-size:12px;margin:24px 0 0">
          Recibís este email porque tenés una cuenta en GarageManager.
        </p>
      </div>
    </div>
  `;

  await sgMail.send({
    from: { email: process.env.SENDGRID_FROM, name: 'GarageManager' },
    to,
    subject,
    html,
  });
  console.log(`[Notificaciones] Email enviado a ${to}: ${subject}`);
}

async function checkAndSendNotifications() {
  if (!process.env.SENDGRID_API_KEY || !process.env.SENDGRID_FROM) {
    console.log('[Notificaciones] SENDGRID_API_KEY o SENDGRID_FROM no configurados, omitiendo');
    return;
  }

  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  try {
    const rows = await queryAll(`
      SELECT
        e.id, e.tipo, e.tipo_personalizado, e.fecha_vencimiento,
        e.notified_30, e.last_daily_reminder_date,
        v.marca, v.modelo, v.patente,
        u.email, u.display_name
      FROM expirations e
      JOIN vehicles v ON e.vehicle_id = v.id
      JOIN users u ON u.family_id = v.family_id
      WHERE e.estado = 'vigente'
        AND u.role = 'admin'
    `);

    console.log(`[Notificaciones] Vencimientos vigentes encontrados: ${rows.length}`);

    const todayStr = todayInArgentina(); // 'YYYY-MM-DD'

    for (const row of rows) {
      const days = daysUntil(row.fecha_vencimiento);
      const tipoLabel = row.tipo === 'otro'
        ? (row.tipo_personalizado || 'Otro')
        : TIPO_LABELS[row.tipo];
      const vehiculo = `${row.marca} ${row.modelo} (${row.patente})`;

      console.log(`[Notificaciones] ${tipoLabel} — ${vehiculo}: ${days}d | notified_30=${row.notified_30} last_daily=${row.last_daily_reminder_date}`);

      if (days <= DAILY_REMINDER_WINDOW_DAYS) {
        // Zona de recordatorio diario: todos los días hasta que se regularice
        // (o se cargue una fecha nueva que lo saque de esta ventana), como
        // máximo una vez por día por si el chequeo corre más de una vez.
        if (row.last_daily_reminder_date === todayStr) continue;
        try {
          await sendReminderEmail(row.email, row.display_name, {
            tipoLabel, vehiculo, fechaVencimiento: row.fecha_vencimiento, days,
          });
          await queryRun('UPDATE expirations SET last_daily_reminder_date = ? WHERE id = ?', [todayStr, row.id]);
        } catch (emailErr) {
          console.error(`[Notificaciones] Error enviando a ${row.email}:`, emailErr.message);
        }
        continue;
      }

      // Todavía no entró en la ventana de recordatorio diario: aviso único a los 30 días.
      if (days <= EARLY_WARNING_DAYS && !row.notified_30) {
        try {
          await sendReminderEmail(row.email, row.display_name, {
            tipoLabel, vehiculo, fechaVencimiento: row.fecha_vencimiento, days,
          });
          await queryRun('UPDATE expirations SET notified_30 = 1 WHERE id = ?', [row.id]);
        } catch (emailErr) {
          console.error(`[Notificaciones] Error enviando a ${row.email}:`, emailErr.message);
        }
      }
    }
  } catch (err) {
    console.error('[Notificaciones] Error en checkAndSendNotifications:', err);
  }
}

module.exports = { checkAndSendNotifications };
