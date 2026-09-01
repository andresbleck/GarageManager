# GarageManager - Deploy Separado (Backend en Render + Frontend en Vercel)

## 🚀 Arquitectura de Deploy

```
┌─────────────────┐    API Calls    ┌─────────────────┐
│   Frontend      │ ──────────────► │    Backend      │
│   (Vercel)      │                │    (Render)     │
│                 │                │                 │
│ - React + Vite  │                │ - Express +     │
│ - Static Build  │                │   SQLite        │
│ - SPA           │                │ - REST API      │
└─────────────────┘                └─────────────────┘
```

## 📋 Paso 1: Deploy Backend en Render

### 1.1 Preparar Repositorio
```bash
# Asegúrate que el backend está en una rama separada o en la raíz
git add backend/
git commit -m "Backend listo para deploy en Render"
git push origin main
```

### 1.2 Configurar en Render
1. Ve a https://render.com
2. Crea una cuenta o inicia sesión
3. Click en "New +" → "Web Service"
4. **Connect Repository**: Conecta tu GitHub repo `garage-manager`
5. **Name**: `garage-manager-api`
6. **Root Directory**: `backend` (si el backend está en esa carpeta)
7. **Runtime**: `Node`
8. **Build Command**: `npm install`
9. **Start Command**: `npm start`

### 1.3 Variables de Entorno en Render
En Environment Variables:
- `NODE_ENV`: `production`
- `PORT`: `10000` (Render usa este puerto por defecto)

### 1.4 Esperar Deploy
Render construirá y deployará tu backend. La URL será algo como:
`https://garage-manager-api.onrender.com`

## ⏰ Recordatorios de vencimiento (cron externo)

El plan gratuito de Render duerme el servicio tras ~15 minutos sin tráfico, así que un cron interno (`node-cron`) nunca dispararía de forma confiable a la hora programada si nadie visita el sitio en ese momento. Por eso el chequeo de vencimientos se dispara desde un **cron externo por HTTP**, no desde el proceso del backend.

### Variables de Entorno adicionales en Render
- `CRON_SECRET`: un valor secreto elegido por vos (ej. generado con `openssl rand -hex 32`). Protege el endpoint de notificaciones para que no lo pueda disparar cualquiera.

### Configurar cron-job.org
1. Crear una cuenta gratuita en https://cron-job.org
2. Crear un nuevo cronjob:
   - **URL**: `https://garage-manager-1.onrender.com/api/test-notifications`
   - **Método**: `POST`
   - **Header**: `x-cron-secret: <el mismo valor de CRON_SECRET>`
   - **Horario**: todos los días a las `12:00 UTC` (≈ 09:00 en Argentina, UTC-3 todo el año, sin horario de verano)
3. Guardar. La petición diaria despierta el backend (si estaba dormido) y ejecuta `checkAndSendNotifications()`.

### Verificar
```bash
# Sin el header, debe devolver 401
curl -X POST https://garage-manager-1.onrender.com/api/test-notifications

# Con el header correcto, debe devolver 200 y ejecutar el chequeo
curl -X POST -H "x-cron-secret: <tu-secreto>" https://garage-manager-1.onrender.com/api/test-notifications
```
Revisar los logs de Render para confirmar que `checkAndSendNotifications()` corrió.

## 📋 Paso 2: Deploy Frontend en Vercel

### 2.1 Preparar Frontend
```bash
# El frontend ya está configurado para apuntar al backend de Render
git add frontend/
git commit -m "Frontend configurado para backend de Render"
git push origin main
```

### 2.2 Configurar en Vercel
1. Ve a https://vercel.com
2. Inicia sesión con GitHub
3. Click en "New Project"
4. **Import**: Selecciona tu repo `garage-manager`
5. **Framework Preset**: Vite
6. **Root Directory**: `frontend`
7. **Build Command**: `npm install && npm run build`
8. **Output Directory**: `dist`

### 2.3 Variables de Entorno en Vercel
En Settings → Environment Variables:
- `VITE_API_URL`: `https://garage-manager-api.onrender.com` (opcional)

### 2.4 Deploy
Click en "Deploy". Vercel construirá y deployará tu frontend.

## 🔧 Configuración Clave

### Backend (Render)
- **Port**: Usa `process.env.PORT || 10000`
- **CORS**: Acepta peticiones del frontend de Vercel
- **SQLite**: Se guardará en el filesystem de Render

### Frontend (Vercel)
- **API URL**: `https://garage-manager-api.onrender.com/api`
- **Build**: Static build en `frontend/dist`
- **Routing**: SPA routing manejado por React Router

## 🧪 Testing

### 1. Backend Testing
```bash
# Test local
cd backend && npm start

# Test en producción
curl https://garage-manager-api.onrender.com/api/vehicles
```

### 2. Frontend Testing
```bash
# Test local
cd frontend && npm run dev

# Test en producción
https://tu-proyecto.vercel.app
```

## 🚨 Solución de Problemas

### Backend no responde
- Verifica logs en Render Dashboard
- Asegúrate que el puerto sea `process.env.PORT`
- Revisa variables de entorno

### Frontend no conecta a backend
- Verifica la URL del backend en `frontend/src/api.js`
- Asegúrate que CORS esté configurado correctamente
- Revisa que el backend esté corriendo en Render

### Error de CORS
En backend, asegúrate que CORS permita tu dominio Vercel:
```javascript
app.use(cors({
  origin: ['https://tu-proyecto.vercel.app', 'http://localhost:5173']
}));
```

## 🔄 URLs Finales

**Backend**: `https://garage-manager-api.onrender.com`
**Frontend**: `https://tu-proyecto.vercel.app`

## 📱 Flujo Completo

1. **Usuario visita** frontend en Vercel
2. **Frontend hace** llamadas API al backend en Render
3. **Backend procesa** las peticiones y responde
4. **Frontend muestra** los resultados al usuario

## 🎯 Ventajas de esta Arquitectura

✅ **Escalabilidad separada**: Backend y frontend escalan independientemente
✅ **Despliegue independiente**: Puedes actualizar frontend sin afectar backend
✅ **Costos optimizados**: Solo pagas por lo que usas en cada servicio
✅ **Mejor rendimiento**: Frontend estático cacheado, backend optimizado
✅ **Control total**: Tienes acceso completo a logs y configuración de ambos

¡Listo! Tu GarageManager estará funcionando con backend en Render y frontend en Vercel.
