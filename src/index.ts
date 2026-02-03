import express, { Request, Response } from 'express'
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import * as QRCode from 'qrcode'
import qrcodeTerminal from 'qrcode-terminal'
import pino from 'pino'
import path from 'path'
import fs from 'fs'

const app = express()
app.use(express.json())

// Configuración
const PORT = process.env.PORT || 3001
const API_KEY = process.env.API_KEY || ''
const AUTH_FOLDER = process.env.AUTH_FOLDER || './auth_info'

// Estado del socket
let sock: WASocket | null = null
let qrCode: string | null = null
let isConnected = false
let phoneNumber: string | null = null

// Logger
const logger = pino({ level: 'warn' })

// Middleware de autenticación
function authenticate(req: Request, res: Response, next: () => void) {
  if (!API_KEY) {
    return next()
  }

  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  next()
}

// Inicializar conexión de WhatsApp
async function connectToWhatsApp() {
  // Crear carpeta de autenticación si no existe
  if (!fs.existsSync(AUTH_FOLDER)) {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true })
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger,
    browser: ['MediCitas', 'Chrome', '1.0.0'],
  })

  // Manejar actualizaciones de conexión
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      // Generar QR code para la web
      qrCode = await QRCode.toDataURL(qr)
      console.log('QR Code generado. Escanea con WhatsApp.')
      qrcodeTerminal.generate(qr, { small: true })
    }

    if (connection === 'close') {
      isConnected = false
      phoneNumber = null
      qrCode = null

      const shouldReconnect =
        (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut

      console.log(
        'Conexión cerrada debido a',
        lastDisconnect?.error,
        ', reconectando:',
        shouldReconnect
      )

      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000)
      }
    } else if (connection === 'open') {
      isConnected = true
      qrCode = null

      // Obtener número de teléfono conectado
      const user = sock?.user
      if (user) {
        phoneNumber = user.id.split(':')[0]
        console.log('Conectado como:', phoneNumber)
      }
    }
  })

  // Guardar credenciales
  sock.ev.on('creds.update', saveCreds)
}

// Rutas API

// Estado del servidor
app.get('/api/status', authenticate, (req: Request, res: Response) => {
  res.json({
    connected: isConnected,
    phone: phoneNumber,
    hasQR: !!qrCode,
  })
})

// Obtener QR code
app.get('/api/qr', authenticate, (req: Request, res: Response) => {
  if (isConnected) {
    return res.json({ connected: true, message: 'Ya está conectado' })
  }

  if (qrCode) {
    return res.json({ qr: qrCode })
  }

  res.json({ message: 'Esperando QR code...' })
})

// Página HTML con QR
app.get('/qr', (req: Request, res: Response) => {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhatsApp QR - MediCitas</title>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          margin: 0;
          background: #f5f5f5;
        }
        .container {
          background: white;
          padding: 40px;
          border-radius: 16px;
          box-shadow: 0 4px 20px rgba(0,0,0,0.1);
          text-align: center;
        }
        h1 { color: #25D366; margin-bottom: 10px; }
        p { color: #666; margin-bottom: 20px; }
        #qr { margin: 20px 0; }
        #qr img { max-width: 280px; }
        .status { padding: 10px 20px; border-radius: 8px; margin-top: 20px; }
        .connected { background: #d4edda; color: #155724; }
        .waiting { background: #fff3cd; color: #856404; }
        .error { background: #f8d7da; color: #721c24; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>WhatsApp QR</h1>
        <p>Escanea el código QR con WhatsApp</p>
        <div id="qr">Cargando...</div>
        <div id="status" class="status waiting">Esperando...</div>
      </div>
      <script>
        async function checkStatus() {
          try {
            const res = await fetch('/api/status');
            const data = await res.json();
            const statusEl = document.getElementById('status');
            const qrEl = document.getElementById('qr');

            if (data.connected) {
              statusEl.className = 'status connected';
              statusEl.textContent = 'Conectado: ' + data.phone;
              qrEl.innerHTML = '<p style="color: #25D366; font-size: 48px;">✓</p>';
            } else if (data.hasQR) {
              const qrRes = await fetch('/api/qr');
              const qrData = await qrRes.json();
              if (qrData.qr) {
                qrEl.innerHTML = '<img src="' + qrData.qr + '" alt="QR Code">';
                statusEl.className = 'status waiting';
                statusEl.textContent = 'Escanea el QR con WhatsApp';
              }
            } else {
              statusEl.className = 'status waiting';
              statusEl.textContent = 'Esperando QR...';
            }
          } catch (e) {
            document.getElementById('status').className = 'status error';
            document.getElementById('status').textContent = 'Error de conexión';
          }
        }

        checkStatus();
        setInterval(checkStatus, 3000);
      </script>
    </body>
    </html>
  `
  res.send(html)
})

// Enviar mensaje
app.post('/api/send-message', authenticate, async (req: Request, res: Response) => {
  try {
    const { phone, message } = req.body

    if (!phone || !message) {
      return res.status(400).json({ error: 'Se requiere phone y message' })
    }

    if (!isConnected || !sock) {
      return res.status(503).json({ error: 'WhatsApp no está conectado' })
    }

    // Formatear número (agregar @s.whatsapp.net)
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`

    // Verificar si el número existe en WhatsApp
    const [result] = await sock.onWhatsApp(phone)

    if (!result?.exists) {
      return res.status(404).json({ error: 'El número no está registrado en WhatsApp' })
    }

    // Enviar mensaje
    await sock.sendMessage(result.jid, { text: message })

    console.log(`Mensaje enviado a ${phone}`)
    res.json({ success: true, message: 'Mensaje enviado' })
  } catch (error) {
    console.error('Error enviando mensaje:', error)
    res.status(500).json({ error: 'Error al enviar mensaje' })
  }
})

// Desconectar
app.post('/api/logout', authenticate, async (req: Request, res: Response) => {
  try {
    if (sock) {
      await sock.logout()
      sock = null
      isConnected = false
      phoneNumber = null
      qrCode = null

      // Eliminar archivos de autenticación
      if (fs.existsSync(AUTH_FOLDER)) {
        fs.rmSync(AUTH_FOLDER, { recursive: true })
      }
    }

    res.json({ success: true, message: 'Sesión cerrada' })
  } catch (error) {
    console.error('Error al cerrar sesión:', error)
    res.status(500).json({ error: 'Error al cerrar sesión' })
  }
})

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', connected: isConnected })
})

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor WhatsApp corriendo en puerto ${PORT}`)
  console.log(`Visita http://localhost:${PORT}/qr para escanear el QR`)

  // Conectar a WhatsApp
  connectToWhatsApp()
})
