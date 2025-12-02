// whatsapp/wa-server.js
// Servidor WA multi-tenant (una sesión Baileys por tenantId)

require("dotenv").config({ path: ".env.local" }); // primero .env.local
require("dotenv").config(); // luego .env

// ⚠️ Ignorar certificados self-signed (arregla SELF_SIGNED_CERT_IN_CHAIN)
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

// En Render usará PORT, en local puedes usar WA_SERVER_PORT
const PORT = process.env.PORT || process.env.WA_SERVER_PORT || 4001;

// Logger bonito
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

// Supabase admin (para marcar estado por tenant)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Cliente OpenAI (IA)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------------------------------------------------------------------
// Estado en memoria: una sesión por tenant
// ---------------------------------------------------------------------

/**
 * status:
 *  - "disconnected": sin sesión activa
 *  - "connecting": Baileys inicializando
 *  - "qrcode": QR listo para escanear
 *  - "connected": sesión ya vinculada
 *  - "error": fallo grave
 */
const sessions = new Map();
/**
 * SessionInfo:
 * {
 *   tenantId: string
 *   socket: WASocket
 *   status: "disconnected" | "connecting" | "qrcode" | "connected" | "error"
 *   lastQr?: string | null
 *   phone?: string | null
 *   lastConnectedAt?: string | null
 * }
 */

// ---------------------------------------------------------------------
// Helpers Supabase
// ---------------------------------------------------------------------

async function markTenantWaStatus(tenantId, { connected, phone }) {
  if (!tenantId) return;

  const update = {
    wa_connected: connected,
    wa_last_connected_at: new Date().toISOString(),
  };

  if (phone) {
    update.wa_phone = phone;
  }

  const { error } = await supabase
    .from("tenants")
    .update(update)
    .eq("id", tenantId);

  if (error) {
    logger.error({ error, tenantId }, "Error actualizando wa status del tenant");
  } else {
    logger.info(
      { tenantId, connected, phone: phone || undefined },
      "WA status de tenant actualizado"
    );
  }
}

// ---------------------------------------------------------------------
// Lógica IA (se reutiliza para todas las sesiones)
// ---------------------------------------------------------------------

async function buildAiReply(cleanText) {
  if (!cleanText) {
    return "";
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `
Eres el asistente comercial de *Creativa Dominicana*, especialista en automatizar WhatsApp para negocios (barberías, salones, tiendas, clínicas, dealers, etc.) en República Dominicana.

Estilo:
- Habla en español dominicano neutral, profesional pero cercano.
- Sé amable, cálido y directo, sin hablar mucho disparate.
- No uses tecnicismos raros; habla como un humano real.
- No parezcas un robot.

Objetivo:
- Entender qué tipo de negocio tiene la persona.
- Explicar de forma simple que instalamos un asistente para WhatsApp que responde 24/7, agenda citas, envía precios y no deja visto.
- Guiar a la persona a una decisión: activar el sistema o pedir un dato específico para completarlo.
- No hables de "demos" ni "reuniones largas". La idea es rápido y sencillo.

Precios (NO inventar otros):
- Plan Profesional: instalación 10,000 RD$ + 4,500 RD$ mensual.
- Plan Empresarial: instalación 15,000 RD$ + 7,000 RD$ mensual.

Reglas:
- Si la persona hace una pregunta muy rara, muy técnica o que no tengas clara, responde con calma y añade SIEMPRE al final:
  "Si quieres, te paso con un asistente humano para explicarte mejor."
- Si la persona muestra interés (pregunta cuánto, cómo se paga, cuándo se instala, dice que le interesa, etc.),
  pídele:
  1) Nombre del negocio
  2) Tipo de negocio (barbería, salón, tienda, clínica, etc.)
  3) Número de WhatsApp del negocio
  y dile que con eso se puede dejar listo el sistema.
- No des información falsa. Si no sabes algo, dilo de forma honesta y ofrece pasar con un asistente humano.
        `.trim(),
        },
        {
          role: "user",
          content: cleanText,
        },
      ],
      max_tokens: 250,
      temperature: 0.7,
    });

    return (
      completion.choices?.[0]?.message?.content?.trim() ||
      "Hola 👋, soy el asistente automático. Te ayudo a dejar tu WhatsApp atendido 24/7. Cuéntame qué tipo de negocio tienes."
    );
  } catch (iaErr) {
    logger.error({ iaErr }, "❌ Error generando respuesta IA");
    return "Hola 👋, soy el asistente automático. Ahora mismo tuve un error generando la respuesta, pero en breve un asistente humano te ayuda personalmente.";
  }
}

// ---------------------------------------------------------------------
// Crear / obtener sesión Baileys para un tenant
// ---------------------------------------------------------------------

async function getOrCreateSession(tenantId) {
  if (!tenantId) {
    throw new Error("tenantId requerido");
  }

  const existing = sessions.get(tenantId);
  if (existing && existing.socket) {
    return existing;
  }

  logger.info({ tenantId }, "[WA] Creando nueva sesión para tenant");

  // Import dinámico porque Baileys es ESM
  const baileys = await import("@whiskeysockets/baileys");
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } =
    baileys;

  const authPath = `./wa_auth/${tenantId}`;
  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
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

  // ---------- Eventos de conexión ----------
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    logger.info(
      {
        tenantId,
        connection,
        hasQr: !!qr,
      },
      "[WA][connection.update]"
    );

    if (qr) {
      info.status = "qrcode";
      info.lastQr = qr;

      // Solo para debug en consola del servidor
      logger.info({ tenantId }, "Nuevo QR generado. Escanéalo con WhatsApp.");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      info.status = "connected";
      info.lastQr = null;

      // Intentar inferir número de WhatsApp desde el JID
      let phone = null;
      try {
        const jid = sock?.user?.id || ""; // ej "18099490457:1@s.whatsapp.net"
        const raw = jid.split("@")[0].split(":")[0];
        if (raw) {
          phone = `whatsapp:+${raw}`;
        }
      } catch (e) {
        logger.warn({ e, tenantId }, "No se pudo inferir el número desde el JID");
      }

      info.phone = phone;
      info.lastConnectedAt = new Date().toISOString();

      markTenantWaStatus(tenantId, { connected: true, phone }).catch((err) =>
        logger.error({ err, tenantId }, "Error marcando tenant como conectado")
      );

      logger.info(
        { tenantId, phone },
        "✅ Sesión de WhatsApp conectada para tenant"
      );
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      info.status = "disconnected";

      logger.warn(
        { tenantId, statusCode, shouldReconnect },
        "❌ Conexión cerrada"
      );

      markTenantWaStatus(tenantId, { connected: false }).catch((err) =>
        logger.error(
          { err, tenantId },
          "Error marcando tenant como desconectado"
        )
      );

      if (!shouldReconnect) {
        sessions.delete(tenantId);
        logger.warn({ tenantId }, "Sesión cerrada definitivamente");
      } else {
        // Lo dejamos para que un nuevo getOrCreate cree otra sesión limpia
        sessions.delete(tenantId);
      }
    }
  });

  // Guardar credenciales
  sock.ev.on("creds.update", saveCreds);

  // ---------- Mensajes entrantes ----------
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages && m.messages[0];
      if (!msg || !msg.message) return;

      const remoteJid = msg.key.remoteJid;
      const isFromMe = msg.key.fromMe;

      if (!remoteJid) return;
      if (remoteJid.endsWith("@status")) return; // estados
      if (remoteJid.endsWith("@g.us")) return; // grupos
      if (isFromMe) return; // lo que envía el mismo bot

      const messageContent = msg.message;

      const text =
        messageContent.conversation ||
        messageContent?.extendedTextMessage?.text ||
        messageContent?.ephemeralMessage?.message?.conversation ||
        messageContent?.ephemeralMessage?.message?.extendedTextMessage?.text ||
        "";

      const cleanText = (text || "").trim();

      logger.info(
        { tenantId, from: remoteJid, text: cleanText },
        "📩 Mensaje recibido"
      );

      if (!cleanText) return;

      const reply = await buildAiReply(cleanText);
      if (!reply) return;

      await sock.sendMessage(remoteJid, { text: reply });

      logger.info(
        { tenantId, to: remoteJid, reply },
        "📤 Respuesta enviada por WA bot"
      );
    } catch (err) {
      logger.error({ err, tenantId }, "Error en messages.upsert");
    }
  });

  return info;
}

// ---------------------------------------------------------------------
// API HTTP (para que tu SaaS consuma)
// ---------------------------------------------------------------------

// Health check general
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "wa-server",
    sessions: Array.from(sessions.keys()),
  });
});

/**
 * Obtener estado + QR de un tenant:
 * GET /sessions/:tenantId
 */
app.get("/sessions/:tenantId", async (req, res) => {
  const { tenantId } = req.params;
  if (!tenantId) {
    return res.status(400).json({ ok: false, error: "tenantId requerido" });
  }

  const info = sessions.get(tenantId);

  if (!info) {
    // sin sesión en memoria → asumimos desconectado
    return res.json({
      ok: true,
      tenantId,
      status: "disconnected",
      qr: null,
      phone: null,
      lastConnectedAt: null,
    });
  }

  return res.json({
    ok: true,
    tenantId,
    status: info.status,
    qr: info.lastQr || null,
    phone: info.phone || null,
    lastConnectedAt: info.lastConnectedAt || null,
  });
});

/**
 * Iniciar conexión / forzar generación de QR:
 * POST /sessions/:tenantId/connect
 */
app.post("/sessions/:tenantId/connect", async (req, res) => {
  const { tenantId } = req.params;
  if (!tenantId) {
    return res.status(400).json({ ok: false, error: "tenantId requerido" });
  }

  try {
    const info = await getOrCreateSession(tenantId);
    return res.json({
      ok: true,
      tenantId,
      status: info.status,
      qr: info.lastQr || null,
      phone: info.phone || null,
      lastConnectedAt: info.lastConnectedAt || null,
    });
  } catch (err) {
    logger.error({ err, tenantId }, "Error en /connect");
    return res
      .status(500)
      .json({ ok: false, error: "Error iniciando sesión de WhatsApp" });
  }
});

/**
 * Desconectar sesión (logout):
 * POST /sessions/:tenantId/disconnect
 */
app.post("/sessions/:tenantId/disconnect", async (req, res) => {
  const { tenantId } = req.params;
  if (!tenantId) {
    return res.status(400).json({ ok: false, error: "tenantId requerido" });
  }

  const info = sessions.get(tenantId);
  if (!info || !info.socket) {
    return res.json({ ok: true, tenantId, status: "disconnected" });
  }

  try {
    await info.socket.logout().catch(() => {});
  } catch (e) {
    logger.warn({ e, tenantId }, "Error en logout (ignorado)");
  }

  sessions.delete(tenantId);
  await markTenantWaStatus(tenantId, { connected: false });

  return res.json({ ok: true, tenantId, status: "disconnected" });
});

// ---------------------------------------------------------------------
// Arrancar servidor
// ---------------------------------------------------------------------

app.listen(PORT, () => {
  logger.info(`🚀 WA server multi-tenant escuchando en http://0.0.0.0:${PORT}`);
});
