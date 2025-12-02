// whatsapp/wa-server.js
// Servidor WA multi-tenant (Soporte DB Supabase + Fix Error 515)

require("dotenv").config({ path: ".env.local" });
require("dotenv").config();

// ⚠️ Ignorar certificados self-signed
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const express = require("express");
const qrcode = require("qrcode-terminal");
const P = require("pino");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

console.log("[WA] OPENAI_KEY cargada:", !!process.env.OPENAI_API_KEY);

// ---------------------------------------------------------------------
// Config básica
// ---------------------------------------------------------------------

const app = express();
app.use(express.json());

const PORT = process.env.PORT || process.env.WA_SERVER_PORT || 4001;

const logger = P({
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    },
  },
});

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------------------------------------------------------------------
// Estado en memoria
// ---------------------------------------------------------------------

const sessions = new Map();

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

async function markTenantWaStatus(tenantId, { connected, phone }) {
  if (!tenantId) return;
  const update = {
    wa_connected: connected,
    wa_last_connected_at: new Date().toISOString(),
  };
  if (phone) update.wa_phone = phone;

  // Si se desconecta, limpiamos el error para que se vea limpio
  if (connected) update.last_error = null;

  await supabase.from("tenants").update(update).eq("id", tenantId);
  
  // También actualizamos la tabla de sesiones para debug
  await supabase.from("whatsapp_sessions").update({ 
      status: connected ? 'connected' : 'disconnected',
      last_seen_at: new Date().toISOString()
  }).eq("tenant_id", tenantId);
}

// ---------------------------------------------------------------------
// Lógica IA
// ---------------------------------------------------------------------

async function buildAiReply(cleanText) {
  if (!cleanText) return "";
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // O gpt-3.5-turbo
      messages: [
        {
          role: "system",
          content: `Eres el asistente comercial de Creativa Dominicana... (Tu prompt aquí)...`,
        },
        { role: "user", content: cleanText },
      ],
      max_tokens: 250,
      temperature: 0.7,
    });
    return completion.choices?.[0]?.message?.content?.trim() || "Hola, cuéntame más.";
  } catch (iaErr) {
    logger.error({ iaErr }, "❌ Error IA");
    return null; // Si falla IA, mejor no responder nada o un mensaje genérico
  }
}

// ---------------------------------------------------------------------
// ⭐ CORE: Gestión de Sesión (Baileys + Supabase)
// ---------------------------------------------------------------------

async function getOrCreateSession(tenantId) {
  if (!tenantId) throw new Error("tenantId requerido");

  // Si ya existe en memoria y está conectado/conectando, devolverla
  const existing = sessions.get(tenantId);
  if (existing && existing.socket) {
    return existing;
  }

  logger.info({ tenantId }, "[WA] Iniciando sesión para tenant...");

  // Importaciones dinámicas (Baileys es ESM)
  const baileys = await import("@whiskeysockets/baileys");
  const { default: makeWASocket, DisconnectReason } = baileys;
  
  // 👇 IMPORTANTE: Importamos tu adaptador de Supabase creado anteriormente
  // Nota: Si usas CommonJS (require), usamos import() dinámico para el adaptador también
  const { useSupabaseAuthState } = await import("./utils/supabaseAuthState.mjs");

  // 1. Usar adaptador de Supabase en lugar de carpetas locales
  const { state, saveCreds } = await useSupabaseAuthState(supabase, tenantId);

  const sock = makeWASocket({
    auth: state, // Estado cargado desde DB
    logger,
    printQRInTerminal: false,
    // Fix: Usar browser Ubuntu para evitar detecciones raras
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    // Fix: Aumentar timeout para evitar errores de stream lento
    connectTimeoutMs: 60000, 
    syncFullHistory: false, // Acelera el arranque
  });

  const info = {
    tenantId,
    socket: sock,
    status: "connecting",
    lastQr: null,
    phone: null,
    lastConnectedAt: null,
  };

  sessions.set(tenantId, info);

  // ---------- Eventos ----------

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    logger.info({ tenantId, connection, qr: !!qr }, "[WA] Connection Update");

    // QR Code
    if (qr) {
      info.status = "qrcode";
      info.lastQr = qr;
      // Guardar QR en DB para mostrarlo en el frontend si es necesario
      await supabase.from("whatsapp_sessions").update({ 
          qr_data: qr, 
          status: 'qrcode' 
      }).eq("tenant_id", tenantId);
      
      // Console debug
      qrcode.generate(qr, { small: true });
    }

    // Conectado
    if (connection === "open") {
      info.status = "connected";
      info.lastQr = null;
      
      // Inferir teléfono
      let phone = null;
      try {
        const jid = sock?.user?.id || ""; 
        const raw = jid.split("@")[0].split(":")[0];
        if (raw) phone = `whatsapp:+${raw}`;
      } catch (e) {}
      
      info.phone = phone;
      info.lastConnectedAt = new Date().toISOString();

      await markTenantWaStatus(tenantId, { connected: true, phone });
      
      logger.info({ tenantId }, "✅ CONECTADO EXITOSAMENTE");
    }

    // Desconectado / Error
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      logger.warn({ tenantId, statusCode, shouldReconnect }, "❌ Conexión cerrada");

      // Limpiar sesión de memoria
      sessions.delete(tenantId);
      
      if (shouldReconnect) {
        // 👇 FIX ERROR 515: Reconexión inmediata
        // Si no es un logout (ej. error de stream, internet, etc), reconectamos
        logger.info({ tenantId }, "🔄 Intentando reconexión automática...");
        getOrCreateSession(tenantId).catch(e => 
            logger.error({ tenantId, e }, "Error fatal en reconexión")
        );
      } else {
        // Logout real: Limpiar DB
        logger.warn({ tenantId }, "⛔ Sesión cerrada definitivamente (Logout)");
        await markTenantWaStatus(tenantId, { connected: false });
        
        // Opcional: Borrar credenciales de DB si el usuario cerró sesión desde el celular
        await supabase.from('whatsapp_sessions').update({ 
            auth_state: null, 
            status: 'disconnected' 
        }).eq('tenant_id', tenantId);
      }
    }
  });

  // Guardar credenciales en DB cada vez que cambien
  sock.ev.on("creds.update", saveCreds);

  // Mensajes
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages?.[0];
      if (!msg?.message || msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.includes("@g.us")) return;

      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
      const cleanText = text.trim();

      if (!cleanText) return;

      logger.info({ tenantId, from: remoteJid, text: cleanText }, "📩 Mensaje");

      const reply = await buildAiReply(cleanText);
      if (reply) {
        await sock.sendMessage(remoteJid, { text: reply });
      }
    } catch (err) {
      logger.error({ err }, "Error procesando mensaje");
    }
  });

  return info;
}

// ---------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------

app.get("/health", (req, res) => res.json({ ok: true, sessions: sessions.size }));

app.get("/sessions/:tenantId", (req, res) => {
  const { tenantId } = req.params;
  const info = sessions.get(tenantId);
  
  if (!info) {
    return res.json({ ok: true, status: "disconnected", tenantId });
  }
  
  res.json({
    ok: true,
    status: info.status,
    qr: info.lastQr,
    phone: info.phone
  });
});

app.post("/sessions/:tenantId/connect", async (req, res) => {
  const { tenantId } = req.params;
  try {
    const info = await getOrCreateSession(tenantId);
    res.json({ ok: true, status: info.status, qr: info.lastQr });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/sessions/:tenantId/disconnect", async (req, res) => {
    const { tenantId } = req.params;
    const info = sessions.get(tenantId);
    
    if (info?.socket) {
        try {
            await info.socket.logout(); // Esto disparará el evento 'close' con loggedOut
        } catch (e) {
            sessions.delete(tenantId);
        }
    }
    
    // Forzamos limpieza en DB por si acaso
    await supabase.from('whatsapp_sessions').update({ 
        auth_state: null, 
        status: 'disconnected',
        qr_data: null
    }).eq('tenant_id', tenantId);

    res.json({ ok: true, status: "disconnected" });
});

// ---------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------

app.listen(PORT, () => {
  logger.info(`🚀 Server multi-tenant DB on port ${PORT}`);
});
