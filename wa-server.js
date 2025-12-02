// whatsapp/wa-server.js
require("dotenv").config({ path: ".env.local" });
require("dotenv").config();

// ⚠️ Ignorar errores de certificados
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
// 1. CEREBRO DEL NEGOCIO (Contexto y Plantillas)
// ---------------------------------------------------------------------

/**
 * NUEVO: Obtiene la identidad del negocio desde la DB
 */
async function getTenantContext(tenantId) {
  try {
    const { data, error } = await supabase
      .from("tenants")
      .select("name, vertical, description") // Leemos las columnas nuevas
      .eq("id", tenantId)
      .maybeSingle();

    if (error || !data) {
      return { name: "el negocio", vertical: "general", description: "" };
    }
    return data;
  } catch (e) {
    logger.error(e, "Error obteniendo contexto del tenant");
    return { name: "el negocio", vertical: "general", description: "" };
  }
}

/**
 * Busca una plantilla activa en 'message_templates'
 */
async function getTemplate(tenantId, eventKey) {
  try {
    const { data, error } = await supabase
      .from("message_templates")
      .select("body")
      .eq("tenant_id", tenantId)
      .eq("event", eventKey)
      .eq("active", true)
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
 * Rellena variables {{variable}}
 */
function renderTemplate(body, variables = {}) {
  if (!body) return "";
  return body.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return variables[key] || "";
  });
}

// ---------------------------------------------------------------------
// 2. LÓGICA DE INTELIGENCIA HÍBRIDA (IA + Contexto + Plantillas)
// ---------------------------------------------------------------------

async function generateReply(text, tenantId) {
  const cleanText = text.trim();
  const lower = cleanText.toLowerCase();

  // --- REGLA 1: DETECTAR INTENCIÓN DE PRECIOS ---
  const priceKeywords = ["precio", "costo", "cuanto vale", "planes", "tarifa"];
  const isPriceQuestion = priceKeywords.some((kw) => lower.includes(kw));

  if (isPriceQuestion) {
    // Buscamos plantilla de precios
    const templateBody = await getTemplate(tenantId, "pricing_pitch");
    if (templateBody) {
      logger.info({ tenantId }, "🎯 Usando Plantilla de PRECIOS");
      return renderTemplate(templateBody, {});
    }
  }

  // --- REGLA 2: CHAT CONTEXTUAL CON OPENAI ---
  
  // 1. Averiguamos quién es el negocio
  const context = await getTenantContext(tenantId);
  
  // 2. Construimos el Prompt Dinámico
  const systemPrompt = `
    Eres el asistente virtual de "${context.name || 'un negocio'}".
    
    TIPO DE NEGOCIO: ${context.vertical || 'Comercio general'}.
    DESCRIPCIÓN: ${context.description || 'Ofrecemos servicios y productos de calidad.'}

    OBJETIVO:
    - Responder dudas basándote estrictamente en el tipo de negocio (${context.vertical}).
    - Si es barbería, habla de cortes. Si es clínica, habla de doctores.
    - Sé amable, breve y usa español latino.
    - Tu meta final es invitar a agendar una cita.
    - Si no sabes la respuesta, sugiere contactar a un humano.
  `.trim();

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: cleanText },
      ],
      max_tokens: 300,
    });
    return completion.choices?.[0]?.message?.content?.trim();
  } catch (err) {
    logger.error("Error OpenAI:", err);
    return null;
  }
}

// ---------------------------------------------------------------------
// 3. ACTUALIZAR ESTADO EN DB
// ---------------------------------------------------------------------

async function updateSessionDB(tenantId, updateData) {
  try {
    await supabase
      .from("whatsapp_sessions")
      .update(updateData)
      .eq("tenant_id", tenantId);
      
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
  const existing = sessions.get(tenantId);
  if (existing && existing.socket) return existing;

  logger.info({ tenantId }, "🔌 Iniciando Socket...");

  const { default: makeWASocket, DisconnectReason } = await import("@whiskeysockets/baileys");
  const { useSupabaseAuthState } = await import("./utils/supabaseAuthState.mjs");

  const { state, saveCreds } = await useSupabaseAuthState(supabase, tenantId);

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ["PymeBot", "Chrome", "1.0.0"],
    syncFullHistory: false,
    connectTimeoutMs: 60000,
  });

  const info = { tenantId, socket: sock, status: "connecting", qr: null };
  sessions.set(tenantId, info);

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      info.status = "qrcode";
      info.qr = qr;
      logger.info({ tenantId }, "✨ QR Generado");
      
      await updateSessionDB(tenantId, {
        qr_data: qr,
        status: "qrcode",
        last_seen_at: new Date().toISOString()
      });
      // Descomenta si quieres verlo en terminal local
      // qrcode.generate(qr, { small: true }); 
    }

    if (connection === "open") {
      info.status = "connected";
      info.qr = null;
      logger.info({ tenantId }, "✅ Conectado");

      let phone = sock?.user?.id ? sock.user.id.split(":")[0] : null;

      await updateSessionDB(tenantId, {
        status: "connected",
        qr_data: null,
        phone_number: phone,
        last_connected_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        last_error: null
      });
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      const errorMsg = lastDisconnect?.error?.message || "Desconexión desconocida";

      logger.warn({ tenantId, statusCode }, "❌ Conexión cerrada");

      if (shouldReconnect) {
        sessions.delete(tenantId);
        getOrCreateSession(tenantId);
      } else {
        sessions.delete(tenantId);
        await updateSessionDB(tenantId, {
          status: "disconnected",
          qr_data: null,
          auth_state: null,
          last_error: `Logout: ${errorMsg}`
        });
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages?.[0];
    if (!msg?.message || msg.key.fromMe) return;
    
    const remoteJid = msg.key.remoteJid;
    if (remoteJid.includes("@g.us")) return; 

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (!text) return;

    // Generar respuesta Híbrida
    const reply = await generateReply(text, tenantId);

    if (reply) {
      await sock.sendMessage(remoteJid, { text: reply });
      logger.info({ tenantId, to: remoteJid }, "📤 Respuesta enviada");
    }
  });

  return info;
}

// ---------------------------------------------------------------------
// 5. API ENDPOINTS
// ---------------------------------------------------------------------

app.get("/health", (req, res) => res.json({ ok: true, active_sessions: sessions.size }));

app.post("/sessions/:tenantId/connect", async (req, res) => {
  const { tenantId } = req.params;
  try {
    const info = await getOrCreateSession(tenantId);
    res.json({ ok: true, status: info.status, qr: info.qr });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/sessions/:tenantId", async (req, res) => {
  const { tenantId } = req.params;
  const mem = sessions.get(tenantId);
  if (mem) return res.json({ ok: true, status: mem.status, qr: mem.qr });

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

app.post("/sessions/:tenantId/send-template", async (req, res) => {
  const { tenantId } = req.params;
  const { event, phone, variables } = req.body; 

  if (!event || !phone) return res.status(400).json({ error: "Faltan datos" });

  let session = sessions.get(tenantId);
  if (!session || session.status !== 'connected') {
      try { session = await getOrCreateSession(tenantId); } catch(e){}
  }

  if (!session || session.status !== 'connected') {
      return res.status(400).json({ error: "Bot no conectado." });
  }

  const templateBody = await getTemplate(tenantId, event);
  if (!templateBody) {
      return res.status(404).json({ error: `Plantilla no encontrada: ${event}` });
  }

  const message = renderTemplate(templateBody, variables || {});
  const formattedPhone = phone.replace(/\D/g, "") + "@s.whatsapp.net";

  try {
    await session.socket.sendMessage(formattedPhone, { text: message });
    logger.info({ tenantId, event, phone }, "📨 Plantilla enviada");
    res.json({ ok: true, message });
  } catch (e) {
    logger.error({ e }, "Fallo enviando mensaje");
    res.status(500).json({ error: "Error de conexión con WhatsApp" });
  }
});

app.listen(PORT, () => {
  logger.info(`🚀 Bot Server Listo en puerto ${PORT}`);
});
