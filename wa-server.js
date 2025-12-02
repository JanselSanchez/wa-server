// whatsapp/wa-server.js
require("dotenv").config({ path: ".env.local" }); // primero intenta leer .env.local
require("dotenv").config(); // luego .env normal, por si acaso

console.log("[WA] OPENAI_KEY cargada:", !!process.env.OPENAI_API_KEY);

const qrcode = require("qrcode-terminal");
const express = require("express");
const P = require("pino");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

// ⚠️ Solo para entorno corporativo / dev:
// ignora certificados self-signed (arregla SELF_SIGNED_CERT_IN_CHAIN)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const app = express();
const PORT = process.env.WA_SERVER_PORT || 4001;

let lastQr = null;
let sock;

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

// ---- Supabase admin (para marcar estado por tenant) ----
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DEFAULT_TENANT_ID = process.env.WA_DEFAULT_TENANT_ID || null;

// Helper para marcar estado WA del tenant
async function markTenantWaStatus({ connected, phone }) {
  if (!DEFAULT_TENANT_ID) {
    logger.warn(
      "WA_DEFAULT_TENANT_ID no definido; no se marca estado por tenant."
    );
    return;
  }

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
    .eq("id", DEFAULT_TENANT_ID);

  if (error) {
    logger.error({ error }, "Error actualizando wa status del tenant");
  } else {
    logger.info(
      {
        tenant: DEFAULT_TENANT_ID,
        connected,
        phone: phone || undefined,
      },
      "WA status de tenant actualizado"
    );
  }
}

// Cliente OpenAI (IA)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --------- Inicializar Baileys ---------
async function startWhatsApp() {
  // Import dinámico porque Baileys es ESM
  const baileys = await import("@whiskeysockets/baileys");
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } =
    baileys;

  const { state, saveCreds } = await useMultiFileAuthState("./whatsapp_auth");

  sock = makeWASocket({
    auth: state,
    // printQRInTerminal está deprecado, lo manejamos con connection.update
    logger,
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      lastQr = qr;
      logger.info("Nuevo QR generado. Escanéalo con WhatsApp.");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      lastQr = null;
      logger.info("✅ Conectado a WhatsApp.");

      // intentar inferir el número del JID de usuario
      let phone = null;
      try {
        const jid = sock?.user?.id || ""; // ej "18099490457:1@s.whatsapp.net"
        const raw = jid.split("@")[0].split(":")[0];
        if (raw) {
          phone = `whatsapp:+${raw}`;
        }
      } catch (e) {
        logger.warn({ e }, "No se pudo inferir el número desde el JID");
      }

      markTenantWaStatus({ connected: true, phone }).catch((err) =>
        logger.error({ err }, "Error marcando tenant como conectado")
      );
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;

      logger.warn(
        { reason: lastDisconnect?.error },
        "❌ Conexión cerrada. ¿Reconnect?"
      );

      // marcar desconectado en la DB
      markTenantWaStatus({ connected: false }).catch((err) =>
        logger.error({ err }, "Error marcando tenant como desconectado")
      );

      if (shouldReconnect) {
        startWhatsApp();
      } else {
        logger.error(
          "Sesión cerrada definitivamente. Borra la carpeta whatsapp_auth si quieres volver a vincular."
        );
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // --------- Mensajes entrantes ---------
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages && m.messages[0];
      if (!msg || !msg.message) return;

      const remoteJid = msg.key.remoteJid;
      const isFromMe = msg.key.fromMe;

      // ignorar estados, grupos y mensajes propios
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

      logger.info({ from: remoteJid, text: cleanText }, "📩 Mensaje recibido");

      if (!cleanText) {
        // nada útil que responder
        return;
      }

      // ---------- IA COMERCIAL (OpenAI) ----------
      let reply = "";

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

        reply =
          completion.choices?.[0]?.message?.content?.trim() ||
          "Hola 👋, soy el asistente automático. Te ayudo a dejar tu WhatsApp atendido 24/7. Cuéntame qué tipo de negocio tienes.";
      } catch (iaErr) {
        logger.error({ iaErr }, "❌ Error generando respuesta IA");
        reply =
          "Hola 👋, soy el asistente automático. Ahora mismo tuve un error generando la respuesta, pero en breve un asistente humano te ayuda personalmente.";
      }

      if (!reply) return;

      await sock.sendMessage(remoteJid, { text: reply });

      logger.info({ to: remoteJid, reply }, "📤 Respuesta enviada");
    } catch (err) {
      logger.error({ err }, "Error en messages.upsert");
    }
  });
}

// --------- API HTTP (para QR y estado) ---------
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "wa-server", connected: !!sock });
});

app.get("/qr", (_req, res) => {
  if (lastQr) {
    return res.json({ ok: true, qr: lastQr });
  }
  return res.json({
    ok: !lastQr && !!sock,
    qr: null,
    message: sock ? "Conectado, no hay QR pendiente" : "Inicializando...",
  });
});

// Iniciar servidor HTTP + WhatsApp
app.listen(PORT, () => {
  logger.info(`🚀 WA server escuchando en http://localhost:${PORT}`);
  startWhatsApp().catch((err) => {
    logger.error({ err }, "Error inicializando WhatsApp");
  });
});
