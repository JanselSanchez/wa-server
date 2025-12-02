// whatsapp/wa-server.js
require("dotenv").config({ path: ".env.local" });
require("dotenv").config();

// ⚠️ Ignorar errores de certificados (necesario para entornos de desarrollo/ciertos VPS)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const express = require("express");
const qrcode = require("qrcode-terminal");
const P = require("pino");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

// ---------------------------------------------------------------------
// CONFIGURACIÓN
// ---------------------------------------------------------------------

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 4001;

// Logger
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

// Supabase Admin
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Almacén de sesiones en memoria RAM
const sessions = new Map();

// ---------------------------------------------------------------------
// 1. GESTIÓN DE PLANTILLAS (La clave de tu SaaS)
// ---------------------------------------------------------------------

/**
 * Busca una plantilla activa en tu tabla 'message_templates'
 */
async function getTemplate(tenantId, eventKey) {
  try {
    const { data, error } = await supabase
      .from("message_templates")
      .select("body")
      .eq("tenant_id", tenantId)
      .eq("event", eventKey) // Ej: 'pricing_pitch', 'booking_confirmed'
      .eq("active", true)    // Solo si está activa
      .maybeSingle();

    if (error) {
      logger.error({ error, tenantId }, "Error consultando plantilla");
      return null;
    }
    return data?.body || null;
  } catch (err) {
    logger.error(err, "Crash en getTemplate");
    return null;
  }
}

/**
 * Rellena las variables {{customer_name}}, {{date}}, etc.
 */
function renderTemplate(body, variables = {}) {
  if (!body) return "";
  return body.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return variables[key] || "";
  });
}

// ---------------------------------------------------------------------
// 2. LÓGICA DE INTELIGENCIA HÍBRIDA (IA + Plantillas)
// ---------------------------------------------------------------------

async function generateReply(text, tenantId) {
  const cleanText = text.trim();
  const lower = cleanText.toLowerCase();

  // --- REGLA 1: DETECTAR INTENCIÓN DE PRECIOS/PLANES ---
  // Si el cliente pregunta precios, intentamos usar TU plantilla primero.
  const priceKeywords = ["precio", "costo", "cuanto vale", "planes", "tarifa"];
  const isPriceQuestion = priceKeywords.some((kw) => lower.includes(kw));

  if (isPriceQuestion) {
    // Buscamos la plantilla con event = 'pricing_pitch' (como en tu captura)
    const templateBody = await getTemplate(tenantId, "pricing_pitch");
    
    if (templateBody) {
      logger.info({ tenantId }, "🎯 Usando Plantilla de PRECIOS (pricing_pitch)");
      // Renderizamos sin variables extra, o podrías pasar el nombre si lo tienes
      return renderTemplate(templateBody, {});
    }
    // Si no tienes plantilla de precios activa, caerá en la IA abajo.
  }

  // --- REGLA 2: CHAT GENERAL CON OPENAI ---
  // Si no es una plantilla, usamos GPT para responder amablemente
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Eres el asistente virtual de un negocio. 
          Tu objetivo es agendar citas y responder dudas básicas.
          Responde de forma corta, amable y profesional.
          Si te preguntan algo que no sabes, sugiere contactar a un humano.`,
        },
        { role: "user", content: cleanText },
      ],
      max_tokens: 250,
    });
    return completion.choices?.[0]?.message?.content?.trim();
  } catch (err) {
    logger.error("Error OpenAI:", err);
    return null;
  }
}

// ---------------------------------------------------------------------
// 3. ACTUALIZAR ESTADO EN DB (Tus tablas reales)
// ---------------------------------------------------------------------

async function updateSessionDB(tenantId, updateData) {
  try {
    // Actualizamos 'whatsapp_sessions' usando las columnas de tu captura
    await supabase
      .from("whatsapp_sessions")
      .update(updateData)
      .eq("tenant_id", tenantId);
      
    // Opcional: Si usas la tabla 'tenants' para mostrar "Conectado: Sí/No"
    if (updateData.status === 'connected') {
        await supabase.from("tenants").update({ wa_connected: true }).eq("id", tenantId);
    } else if (updateData.status === 'disconnected') {
        await supabase.from("tenants").update({ wa_connected: false }).eq("id", tenantId);
    }

  } catch (err) {
    logger.error({ err }, "Error actualizando DB");
  }
}

// ---------------------------------------------------------------------
// 4. CORE DE WHATSAPP (BAILEYS)
// ---------------------------------------------------------------------

async function getOrCreateSession(tenantId) {
  // Si ya existe en memoria y está OK, la devolvemos
  const existing = sessions.get(tenantId);
  if (existing && existing.socket) return existing;

  logger.info({ tenantId }, "🔌 Iniciando Socket...");

  // Imports dinámicos
  const { default: makeWASocket, DisconnectReason } = await import("@whiskeysockets/baileys");
  // ¡IMPORTANTE! Asegúrate que la ruta sea correcta a tu archivo .mjs
  const { useSupabaseAuthState } = await import("./utils/supabaseAuthState.mjs");

  // 1. Usar tu adaptador de Supabase (lee/escribe en 'auth_state')
  const { state, saveCreds } = await useSupabaseAuthState(supabase, tenantId);

  // 2. Crear Socket
  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ["PymeBot", "Chrome", "1.0.0"], // Nombre personalizado
    syncFullHistory: false,
    connectTimeoutMs: 60000,
  });

  const info = { tenantId, socket: sock, status: "connecting", qr: null };
  sessions.set(tenantId, info);

  // 3. Manejo de Eventos
  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;

    // -- QR GENERADO --
    if (qr) {
      info.status = "qrcode";
      info.qr = qr;
      logger.info({ tenantId }, "✨ QR Generado");
      
      // Guardar en DB para que tu Frontend lo muestre
      await updateSessionDB(tenantId, {
        qr_data: qr,
        status: "qrcode",
        last_seen_at: new Date().toISOString()
      });
      qrcode.generate(qr, { small: true });
    }

    // -- CONECTADO --
    if (connection === "open") {
      info.status = "connected";
      info.qr = null;
      logger.info({ tenantId }, "✅ Conectado");

      // Obtener número
      let phone = sock?.user?.id ? sock.user.id.split(":")[0] : null;

      await updateSessionDB(tenantId, {
        status: "connected",
        qr_data: null, // Limpiar QR
        phone_number: phone,
        last_connected_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        last_error: null
      });
    }

    // -- DESCONECTADO --
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      const errorMsg = lastDisconnect?.error?.message || "Desconexión desconocida";

      logger.warn({ tenantId, statusCode }, "❌ Conexión cerrada");

      if (shouldReconnect) {
        // Reintentar (Fix error 515)
        sessions.delete(tenantId);
        getOrCreateSession(tenantId);
      } else {
        // Logout real
        sessions.delete(tenantId);
        await updateSessionDB(tenantId, {
          status: "disconnected",
          qr_data: null,
          auth_state: null, // Borrar sesión
          last_error: `Logout: ${errorMsg}`
        });
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // 4. Escuchar Mensajes (IA + Plantilla Precios)
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0];
    if (!msg?.message || msg.key.fromMe) return;
    
    const remoteJid = msg.key.remoteJid;
    if (remoteJid.includes("@g.us")) return; // No grupos

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (!text) return;

    // Generar respuesta
    const reply = await generateReply(text, tenantId);

    if (reply) {
      await sock.sendMessage(remoteJid, { text: reply });
      logger.info({ tenantId, to: remoteJid }, "📤 Respuesta enviada");
    }
  });

  return info;
}

// ---------------------------------------------------------------------
// 5. API ENDPOINTS (Para tu Frontend Next.js)
// ---------------------------------------------------------------------

app.get("/health", (req, res) => res.json({ ok: true, active_sessions: sessions.size }));

// Iniciar sesión (Genera QR)
app.post("/sessions/:tenantId/connect", async (req, res) => {
  const { tenantId } = req.params;
  try {
    const info = await getOrCreateSession(tenantId);
    res.json({ ok: true, status: info.status, qr: info.qr });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Obtener estado actual
app.get("/sessions/:tenantId", async (req, res) => {
  const { tenantId } = req.params;
  
  // 1. Intentar memoria
  const mem = sessions.get(tenantId);
  if (mem) return res.json({ ok: true, status: mem.status, qr: mem.qr });

  // 2. Si no está en memoria, consultar DB
  const { data } = await supabase
    .from("whatsapp_sessions")
    .select("status, qr_data")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  res.json({ 
    ok: true, 
    status: data?.status || "disconnected", 
    qr: data?.qr_data || null 
  });
});

// Desconectar
app.post("/sessions/:tenantId/disconnect", async (req, res) => {
  const { tenantId } = req.params;
  const s = sessions.get(tenantId);
  if (s?.socket) await s.socket.logout().catch(() => {});
  
  sessions.delete(tenantId);
  await updateSessionDB(tenantId, { 
      status: "disconnected", 
      qr_data: null, 
      auth_state: null 
  });
  
  res.json({ ok: true });
});

/**
 * 🔥 ENDPOINT CRÍTICO: ENVIAR PLANTILLA (API TRIGGER)
 * Este es el que usarás cuando se cree una cita en tu sistema
 */
app.post("/sessions/:tenantId/send-template", async (req, res) => {
  const { tenantId } = req.params;
  const { event, phone, variables } = req.body; 
  // event ej: 'booking_confirmed'
  // phone ej: '1809...'
  // variables ej: { customer_name: 'Juan', date: '...' }

  if (!event || !phone) return res.status(400).json({ error: "Faltan datos" });

  // Verificar si hay sesión activa
  let session = sessions.get(tenantId);
  if (!session || session.status !== 'connected') {
      // Intento de reconexión rápida si está en DB
      try { session = await getOrCreateSession(tenantId); } catch(e){}
  }

  if (!session || session.status !== 'connected') {
      return res.status(400).json({ error: "Bot no conectado. Escanea el QR primero." });
  }

  // 1. Obtener plantilla de DB
  const templateBody = await getTemplate(tenantId, event);
  if (!templateBody) {
      return res.status(404).json({ error: `No existe plantilla activa para el evento: ${event}` });
  }

  // 2. Renderizar
  const message = renderTemplate(templateBody, variables || {});

  // 3. Formatear teléfono (Solo números + @s.whatsapp.net)
  const formattedPhone = phone.replace(/\D/g, "") + "@s.whatsapp.net";

  // 4. Enviar
  try {
      await session.socket.sendMessage(formattedPhone, { text: message });
      logger.info({ tenantId, event, phone }, "📨 Plantilla enviada exitosamente");
      res.json({ ok: true, message });
  } catch (e) {
      logger.error({ e }, "Fallo enviando mensaje");
      res.status(500).json({ error: "Error de conexión con WhatsApp" });
  }
});

// Arrancar
app.listen(PORT, () => {
  logger.info(`🚀 Bot Server Listo en puerto ${PORT}`);
});
