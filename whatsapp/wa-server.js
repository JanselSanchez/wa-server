/**
 * wa-server.js — versión producción (lista para vender)
 *
 * ✅ Estado real: /sessions/:tenantId (memoria + DB fallback)
 * ✅ Connect: /sessions/:tenantId/connect
 * ✅ Send (n8n): POST /sessions/:tenantId/messages  (Bearer opcional)
 * ✅ Alias: POST /sessions/:tenantId/send-message
 * ✅ Persistencia auth por filesystem (Render Persistent Disk recomendado)
 * ✅ Respuestas consistentes: connected | qrcode_required | wa_not_connected
 */

require("dotenv").config({ path: ".env.local" });
require("dotenv").config();

const express = require("express");
const qrcode = require("qrcode-terminal");
const P = require("pino");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");
const fs = require("fs");
const axios = require("axios");

// Date-fns
const { startOfWeek, addDays, startOfDay } = require("date-fns");

// 👇 estado de conversación en Supabase
const convoState = require("./conversationState");

// ---------------------------------------------------------------------
// CONFIGURACIÓN GLOBAL
// ---------------------------------------------------------------------

// ⚠️ En producción NO deberías desactivar TLS.
// Si tienes un caso puntual (certs raros), habilítalo explícitamente.
if (String(process.env.ALLOW_INSECURE_TLS || "").trim() === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.warn(
    "[wa-server] ⚠️ ALLOW_INSECURE_TLS=1 → TLS verification desactivado (no recomendado)"
  );
}

const app = express();
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || process.env.WA_SERVER_PORT || 4001;

// 🔥 AJUSTE DE ZONA HORARIA (tu lógica actual)
const SERVER_OFFSET_HOURS = 4;

// Timezone configurable (fallback RD)
const TIMEZONE_LOCALE = process.env.TIMEZONE_LOCALE || "America/Santo_Domingo";

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

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// OpenAI (fallback)
const openaiApiKey =
  process.env.OPENAI_API_KEY ||
  process.env.OPENAI_KEY ||
  process.env.OPENAI_SECRET ||
  null;

if (!openaiApiKey) {
  console.warn(
    "[wa-server] ⚠️ No hay API key de OpenAI (OPENAI_API_KEY / OPENAI_KEY). El fallback IA no funcionará."
  );
}
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

/**
 * sessions: Map<tenantId, { tenantId, socket, status, qr, conversations: Map<phone, { history: [] }> }>
 */
const sessions = new Map();

// Persistencia auth state (IMPORTANTE para “no pedir QR cada restart”)
const WA_SESSIONS_ROOT =
  process.env.WA_SESSIONS_DIR || path.join(__dirname, ".wa-sessions");

// Crea root folder siempre
try {
  if (!fs.existsSync(WA_SESSIONS_ROOT)) fs.mkdirSync(WA_SESSIONS_ROOT, { recursive: true });
} catch (e) {
  console.error("[wa-server] No pude crear WA_SESSIONS_ROOT:", WA_SESSIONS_ROOT, e);
}

// ---------------------------------------------------------------------
// AUTH opcional (Bearer) — recomendado para producción
// ---------------------------------------------------------------------

function requireAuth(req, res, next) {
  const expected = String(process.env.WA_API_TOKEN || "").trim();
  if (!expected) return next(); // si no hay token, no bloquea

  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// ---------------------------------------------------------------------
// HELPERS: Normalización teléfono → WhatsApp JID
// ---------------------------------------------------------------------

function normalizePhoneDigits(input) {
  return String(input || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[()-]/g, "")
    .replace(/^\+/, "")
    .replace(/[^\d]/g, "");
}

function toWhatsAppJid(phoneOrJid) {
  const raw = String(phoneOrJid || "").trim();
  if (!raw) throw new Error("missing_phone");

  if (raw.includes("@s.whatsapp.net")) return raw;
  if (raw.includes("@c.us")) return raw.replace("@c.us", "@s.whatsapp.net");

  const digits = normalizePhoneDigits(raw);
  if (!digits) throw new Error("invalid_phone");

  return `${digits}@s.whatsapp.net`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForConnected(tenantId, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = sessions.get(tenantId);
    if (s?.status === "connected" && s?.socket) return s;
    await sleep(350);
  }
  return sessions.get(tenantId) || null;
}

// ---------------------------------------------------------------------
// 1. LÓGICA DE SCHEDULING
// ---------------------------------------------------------------------

function hmsToParts(hms) {
  const [h, m] = hms.split(":").map(Number);
  return { h, m };
}

function pad2(n) {
  return n.toString().padStart(2, "0");
}

function toHHMM(t) {
  if (!t) return "";
  const parts = t.split(":");
  return `${pad2(Number(parts[0]))}:${pad2(Number(parts[1]))}`;
}

function weeklyOpenWindows(weekStart, businessHours) {
  const windows = [];
  let currentDayCursor = new Date(weekStart);

  for (let i = 0; i < 7; i++) {
    const currentDow = currentDayCursor.getDay();

    const dayConfig = businessHours.find(
      (bh) => bh.dow === currentDow && bh.is_closed === false
    );

    if (dayConfig && dayConfig.open_time && dayConfig.close_time) {
      const { h: openH, m: openM } = hmsToParts(toHHMM(dayConfig.open_time));
      const { h: closeH, m: closeM } = hmsToParts(toHHMM(dayConfig.close_time));

      const start = new Date(currentDayCursor);
      start.setHours(openH + SERVER_OFFSET_HOURS, openM, 0, 0);

      const end = new Date(currentDayCursor);
      end.setHours(closeH + SERVER_OFFSET_HOURS, closeM, 0, 0);

      if (end > start) windows.push({ start, end });
    }

    currentDayCursor.setDate(currentDayCursor.getDate() + 1);
  }
  return windows;
}

function generateOfferableSlots(openWindows, bookings, stepMin = 30) {
  const slots = [];
  for (const window of openWindows) {
    let cursor = new Date(window.start);
    const windowEnd = new Date(window.end);

    while (cursor.getTime() < windowEnd.getTime()) {
      const slotEnd = new Date(cursor);
      slotEnd.setMinutes(slotEnd.getMinutes() + stepMin);

      if (slotEnd.getTime() > windowEnd.getTime()) break;

      const isBusy = (bookings || []).some((booking) => {
        const busyStart = new Date(booking.starts_at);
        const busyEnd = new Date(booking.ends_at);
        return (
          cursor.getTime() < busyEnd.getTime() &&
          slotEnd.getTime() > busyStart.getTime()
        );
      });

      if (!isBusy) slots.push({ start: new Date(cursor), end: slotEnd });

      cursor.setMinutes(cursor.getMinutes() + stepMin);
    }
  }
  return slots;
}

// ---------------------------------------------------------------------
// 2. HELPERS: ICS
// ---------------------------------------------------------------------

function createICSFile(title, description, location, startDate, durationMinutes = 60) {
  const formatTime = (date) =>
    date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

  const start = new Date(startDate);
  const end = new Date(start.getTime() + durationMinutes * 60000);
  const now = new Date();

  const icsData = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//PymeBot//Agendador//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${now.getTime()}@pymebot.com`,
    `DTSTAMP:${formatTime(now)}`,
    `DTSTART:${formatTime(start)}`,
    `DTEND:${formatTime(end)}`,
    `SUMMARY:${title}`,
    `DESCRIPTION:${description}`,
    `LOCATION:${location}`,
    "STATUS:CONFIRMED",
    "BEGIN:VALARM",
    "TRIGGER:-PT30M",
    "ACTION:DISPLAY",
    "DESCRIPTION:Recordatorio de Cita",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  return Buffer.from(icsData, "utf8");
}

function looksLikeICS(str) {
  if (!str || typeof str !== "string") return false;
  return str.includes("BEGIN:VCALENDAR") && str.includes("END:VCALENDAR");
}

function looksLikeBase64(str) {
  if (!str || typeof str !== "string") return false;
  const s = str.trim();
  if (s.length < 40) return false;
  if (s.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/=]+$/.test(s);
}

function icsToBuffer(icsData) {
  if (!icsData) return null;

  if (typeof icsData !== "string") {
    try {
      icsData = String(icsData);
    } catch {
      return null;
    }
  }

  const raw = icsData.trim();

  if (looksLikeICS(raw)) {
    const normalized = raw.replace(/\r?\n/g, "\r\n");
    return Buffer.from(normalized, "utf8");
  }

  if (looksLikeBase64(raw)) {
    const buf = Buffer.from(raw, "base64");
    const preview = buf.toString("utf8", 0, Math.min(buf.length, 300));
    if (!looksLikeICS(preview)) return null;
    return buf;
  }

  return null;
}

async function sendICS(sock, remoteJid, icsData, opts = {}) {
  const buf = icsToBuffer(icsData);
  if (!buf) return false;

  await sock.sendMessage(remoteJid, {
    document: buf,
    mimetype: "text/calendar; charset=utf-8",
    fileName: opts.fileName || "cita_confirmada.ics",
    caption: opts.caption || "📅 Toca aquí para guardar en tu calendario",
  });

  return true;
}

// ---------------------------------------------------------------------
// 3. DB HELPERS
// ---------------------------------------------------------------------

async function getTenantContext(tenantId) {
  try {
    const { data } = await supabase
      .from("tenants")
      .select("name, vertical, description")
      .eq("id", tenantId)
      .maybeSingle();

    if (!data) return { name: "el negocio", vertical: "general", description: "" };
    return data;
  } catch {
    return { name: "el negocio", vertical: "general", description: "" };
  }
}

async function getTemplate(tenantId, eventKey) {
  const { data } = await supabase
    .from("message_templates")
    .select("body")
    .eq("tenant_id", tenantId)
    .eq("event", eventKey)
    .eq("active", true)
    .maybeSingle();

  return data?.body || null;
}

function renderTemplate(body, variables = {}) {
  if (!body) return "";
  return body.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || "");
}

async function getAvailableSlots(tenantId, resourceId, startDate, daysToLookAhead = 7) {
  if (!tenantId) return [];

  const weekStart = startOfWeek(startDate, { weekStartsOn: 1 });
  const weekEnd = addDays(weekStart, daysToLookAhead);

  const { data: hours } = await supabase
    .from("business_hours")
    .select("dow, is_closed, open_time, close_time")
    .eq("tenant_id", tenantId)
    .eq("is_closed", false)
    .order("dow", { ascending: true });

  let bookingsQuery = supabase
    .from("bookings")
    .select("starts_at, ends_at, resource_id, status")
    .eq("tenant_id", tenantId)
    .gte("starts_at", startOfDay(startDate).toISOString())
    .lt("ends_at", addDays(weekEnd, 1).toISOString())
    .in("status", ["confirmed", "pending"]);

  if (resourceId) bookingsQuery = bookingsQuery.eq("resource_id", resourceId);

  const { data: bookings } = await bookingsQuery;

  const openWindows = weeklyOpenWindows(weekStart, hours || []);
  const offerableSlots = generateOfferableSlots(openWindows, bookings || [], 30);

  return offerableSlots.filter((slot) => slot.start >= startDate);
}

// ---------------------------------------------------------------------
// 4. INTENT_KEYWORDS ENGINE (tu lógica intacta)
// ---------------------------------------------------------------------

function normalizeForIntent(str = "") {
  return str
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

async function buildIntentHints(tenantId, userText) {
  try {
    const normalizedUser = normalizeForIntent(userText);

    const { data, error } = await supabase
      .from("intent_keywords")
      .select("intent, frase, peso, es_error, locale, term, tenant_id")
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`);

    if (error || !data || data.length === 0) return "";

    const scores = {};

    for (const row of data) {
      if (
        row.locale &&
        normalizeForIntent(row.locale) !== normalizeForIntent("es-DO") &&
        normalizeForIntent(row.locale) !== normalizeForIntent("es")
      ) continue;

      if (row.es_error) continue;

      const term = row.term || row.frase;
      if (!term) continue;

      const normTerm = normalizeForIntent(term);
      if (!normTerm) continue;

      if (normalizedUser.includes(normTerm)) {
        const intent = row.intent || "desconocido";
        if (!scores[intent]) scores[intent] = { intent, score: 0, terms: new Set() };
        const peso = typeof row.peso === "number" ? row.peso : 1;
        scores[intent].score += peso;
        scores[intent].terms.add(term);
      }
    }

    const intentsArr = Object.values(scores);
    if (intentsArr.length === 0) return "";

    intentsArr.sort((a, b) => b.score - a.score);
    const topIntents = intentsArr.slice(0, 3).map((i) => ({
      intent: i.intent,
      score: i.score,
      terms: Array.from(i.terms),
    }));

    return JSON.stringify({ engine: "intent_keywords", intents: topIntents });
  } catch (e) {
    console.error("[buildIntentHints] error:", e);
    return "";
  }
}

// ---------------------------------------------------------------------
// 5. TOOLS OpenAI (tu lógica intacta)
// ---------------------------------------------------------------------

const tools = [
  {
    type: "function",
    function: {
      name: "check_availability",
      description: "Consulta disponibilidad.",
      parameters: {
        type: "object",
        properties: { requestedDate: { type: "string", description: "Fecha ISO base." } },
        required: ["requestedDate"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_booking",
      description: "Crea una Cita/Reserva.",
      parameters: {
        type: "object",
        properties: {
          customerName: { type: "string" },
          phone: { type: "string" },
          startsAtISO: { type: "string" },
          endsAtISO: { type: "string" },
          notes: { type: "string" },
          serviceId: { type: "string" },
        },
        required: ["phone", "startsAtISO"],
      },
    },
  },
  { type: "function", function: { name: "get_catalog", description: "Consulta catálogo.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "human_handoff", description: "Escala a humano.", parameters: { type: "object", properties: {} } } },
  {
    type: "function",
    function: {
      name: "reschedule_booking",
      description: "Reagenda una cita.",
      parameters: {
        type: "object",
        properties: {
          customerPhone: { type: "string" },
          newStartsAtISO: { type: "string" },
          newEndsAtISO: { type: "string" },
        },
        required: ["customerPhone", "newStartsAtISO"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_booking",
      description: "Cancela cita.",
      parameters: {
        type: "object",
        properties: { customerPhone: { type: "string" } },
        required: ["customerPhone"],
      },
    },
  },
];

// ---------------------------------------------------------------------
// 6. IA (tu lógica intacta)
// ---------------------------------------------------------------------

async function generateReply(text, tenantId, pushName, historyMessages = [], userPhone = null) {
  if (!openai) return null;

  const { data: profile } = await supabase
    .from("business_profiles")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  const businessType = profile?.business_type || "general";
  const botName = profile?.bot_name || "Asistente Virtual";
  const botTone = profile?.bot_tone || "Amable y profesional";
  const customRules = profile?.custom_instructions || "Ayuda al cliente a agendar o comprar.";
  const humanPhone = profile?.human_handoff_phone || null;

  const now = new Date();
  const tz = TIMEZONE_LOCALE || "America/Santo_Domingo";
  const currentDateStr = now.toLocaleString("es-DO", {
    timeZone: tz,
    dateStyle: "full",
    timeStyle: "short",
  });

  const intentHints = await buildIntentHints(tenantId, text);

  let typeContext = "";
  switch (businessType) {
    case "restaurante":
      typeContext =
        "Eres el host de un restaurante. Objetivo: reservar mesas o tomar pedidos. Guarda cantidad de personas en notes.";
      break;
    case "clinica":
      typeContext =
        "Eres recepcionista médico. Objetivo: agendar citas. Formal y discreto. Guarda motivo en notes.";
      break;
    case "barberia":
      typeContext =
        "Eres el asistente de una barbería. Agenda citas. Si no especifican barbero, agenda con cualquiera.";
      break;
    default:
      typeContext =
        "Eres un asistente general de negocios. Objetivo: agendar o responder dudas.";
  }

  const systemPrompt = `
IDENTIDAD: Te llamas "${botName}".
TONO: ${botTone}.
ROL: ${typeContext}

REGLAS DEL NEGOCIO:
"${customRules}"

DATOS:
- Fecha/Hora: ${currentDateStr}
- Cliente: ${pushName}
- Teléfono cliente: ${userPhone || "desconocido"}
- INTENTS: ${intentHints || "ninguno claro"}

INSTRUCCIONES:
1) Si el cliente propone hora y hay hueco, agenda de inmediato.
2) Si preguntan precios/menú, usa get_catalog.
3) Si falta serviceId, agenda con serviceId:null y detalle en notes.
4) Si piden humano, usa human_handoff.
5) Si check_availability devuelve slots, lista y pide número.
`.trim();

  const messages = [
    { role: "system", content: systemPrompt },
    ...(Array.isArray(historyMessages) ? historyMessages : []),
    { role: "user", content: text },
  ];

  try {
    let completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      tools,
      tool_choice: "auto",
    });

    let message = completion.choices[0].message;

    if (!message.tool_calls) return message.content?.trim() || "";

    messages.push(message);

    for (const toolCall of message.tool_calls) {
      const fnName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments || "{}");
      let response = "{}";

      if (fnName === "check_availability") {
        const rawSlots = await getAvailableSlots(tenantId, null, new Date(args.requestedDate), 7);
        const sortedSlots = (rawSlots || []).sort((a, b) => a.start - b.start);

        if (sortedSlots.length > 0) {
          const slotObjects = sortedSlots.slice(0, 12).map((s, i) => ({
            index: i + 1,
            label: `${i + 1}) ${s.start.toLocaleString("es-DO", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: true })}`,
            isoStart: s.start.toISOString(),
            isoEnd: s.end.toISOString(),
          }));
          response = JSON.stringify({ message: "Horarios disponibles:", slots: slotObjects });
        } else {
          response = JSON.stringify({ message: "No hay horarios disponibles.", slots: [] });
        }
      }

      if (fnName === "get_catalog") {
        const { data: items } = await supabase
          .from("items")
          .select("name, price_cents, description")
          .eq("tenant_id", tenantId)
          .eq("is_active", true);

        if (items?.length) {
          const list = items
            .map((i) => `- ${i.name} ($${(i.price_cents / 100).toFixed(0)}): ${i.description || ""}`)
            .join("\n");
          response = JSON.stringify({ catalog: list });
        } else {
          response = JSON.stringify({ message: "Catálogo vacío." });
        }
      }

      if (fnName === "create_booking") {
        const phoneArg = args.phone || userPhone;
        const startsISO = args.startsAtISO;

        if (!phoneArg || !startsISO) {
          response = JSON.stringify({ success: false, error: "missing_phone_or_start" });
        } else {
          const start = new Date(startsISO);
          const endISO = args.endsAtISO || new Date(start.getTime() + 60 * 60000).toISOString();

          const { data: booking, error } = await supabase
            .from("bookings")
            .insert([{
              tenant_id: tenantId,
              resource_id: null,
              service_id: args.serviceId || null,
              customer_name: args.customerName || pushName,
              customer_phone: phoneArg,
              starts_at: startsISO,
              ends_at: endISO,
              status: "confirmed",
              notes: args.notes || "Agendado por Bot",
            }])
            .select("id")
            .single();

          response = !error
            ? JSON.stringify({ success: true, bookingId: booking.id })
            : JSON.stringify({ success: false, error: error.message || "db_error" });
        }
      }

      if (fnName === "human_handoff") {
        if (humanPhone) {
          const clean = humanPhone.replace(/\D/g, "");
          response = JSON.stringify({ message: `Escríbenos aquí: https://wa.me/${clean}` });
        } else {
          response = JSON.stringify({ message: "Déjame tu solicitud y te ayudamos." });
        }
      }

      if (fnName === "reschedule_booking") {
        const phoneFilter = args.customerPhone || userPhone || null;
        if (!phoneFilter) {
          response = JSON.stringify({ success: false, error: "missing_phone" });
        } else {
          const { data: booking } = await supabase
            .from("bookings")
            .select("id")
            .eq("tenant_id", tenantId)
            .eq("customer_phone", phoneFilter)
            .in("status", ["confirmed", "pending"])
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (!booking) response = JSON.stringify({ success: false, error: "no_active_booking_found" });
          else {
            const newStart = args.newStartsAtISO;
            const newEnd = args.newEndsAtISO || new Date(new Date(newStart).getTime() + 60 * 60000).toISOString();
            const { error } = await supabase.from("bookings").update({ starts_at: newStart, ends_at: newEnd }).eq("id", booking.id);
            response = !error ? JSON.stringify({ success: true }) : JSON.stringify({ success: false, error: "db_update_error" });
          }
        }
      }

      if (fnName === "cancel_booking") {
        const phoneFilter = args.customerPhone || userPhone || null;
        if (!phoneFilter) {
          response = JSON.stringify({ success: false, error: "missing_phone" });
        } else {
          const { data: booking } = await supabase
            .from("bookings")
            .select("id")
            .eq("tenant_id", tenantId)
            .eq("customer_phone", phoneFilter)
            .in("status", ["confirmed", "pending"])
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (!booking) response = JSON.stringify({ success: false, error: "no_active_booking_found" });
          else {
            const { error } = await supabase.from("bookings").update({ status: "cancelled" }).eq("id", booking.id);
            response = !error ? JSON.stringify({ success: true }) : JSON.stringify({ success: false, error: "db_update_error" });
          }
        }
      }

      messages.push({
        tool_call_id: toolCall.id,
        role: "tool",
        name: fnName,
        content: response,
      });
    }

    const finalReply = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
    });

    return finalReply.choices[0].message.content.trim();
  } catch (err) {
    logger.error("Error OpenAI:", err);
    return null;
  }
}

// ---------------------------------------------------------------------
// 7. ACTUALIZAR ESTADO DB (whatsapp_sessions + tenants.wa_connected)
// ---------------------------------------------------------------------

async function updateSessionDB(tenantId, updateData) {
  if (!tenantId) return;

  try {
    const { data: existing, error: selectError } = await supabase
      .from("whatsapp_sessions")
      .select("id")
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (selectError) {
      console.error("[updateSessionDB] Error select whatsapp_sessions:", selectError);
      return;
    }

    if (existing) {
      const { error: updateError } = await supabase
        .from("whatsapp_sessions")
        .update(updateData)
        .eq("tenant_id", tenantId);

      if (updateError) {
        console.error("[updateSessionDB] Error update whatsapp_sessions:", updateError);
      }
    } else {
      const row = { tenant_id: tenantId, ...updateData };
      const { error: insertError } = await supabase
        .from("whatsapp_sessions")
        .insert([row]);

      if (insertError) {
        console.error("[updateSessionDB] Error insert whatsapp_sessions:", insertError);
      }
    }

    if (updateData.status) {
      const isConnected = updateData.status === "connected";
      const { error: tenantError } = await supabase
        .from("tenants")
        .update({ wa_connected: isConnected })
        .eq("id", tenantId);

      if (tenantError) {
        console.error("[updateSessionDB] Error update tenants.wa_connected:", tenantError);
      }
    }
  } catch (e) {
    console.error("[updateSessionDB] Error inesperado:", e);
  }
}

// ---------------------------------------------------------------------
// 8. customers + eventos booking (tu lógica intacta)
// ---------------------------------------------------------------------

async function getOrCreateCustomer(tenantId, phoneNumber) {
  const { data, error } = await supabase
    .from("customers")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("phone_number", phoneNumber)
    .maybeSingle();

  if (error) throw error;
  if (data) return data.id;

  const { data: created, error: insertError } = await supabase
    .from("customers")
    .insert({ tenant_id: tenantId, phone_number: phoneNumber })
    .select("id")
    .single();

  if (insertError) throw insertError;
  return created.id;
}

function buildBookingEventFromMessage(text, session) {
  const lower = (text || "").toLowerCase().trim();
  const currentFlow = session.current_flow;
  const step = session.step;

  if (lower === "cancelar" || lower === "olvídalo" || lower === "olvidalo") {
    return { type: "CANCEL_FLOW" };
  }

  if (!currentFlow) return { type: "START_BOOKING" };

  if (currentFlow === "BOOKING") {
    if (step === "SELECT_SERVICE") {
      let serviceId = null;
      if (lower.includes("corte") && lower.includes("barba")) serviceId = "service_corte_barba";
      else if (lower.includes("corte")) serviceId = "service_corte";
      else if (lower.includes("barba")) serviceId = "service_barba";
      return { type: "SERVICE_PROVIDED", serviceId };
    }

    if (step === "SELECT_DATE") {
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, "0");
      const dd = String(today.getDate()).padStart(2, "0");
      let targetDate = `${yyyy}-${mm}-${dd}`;

      const isTomorrow = lower.includes("mañana") || lower.includes("manana");
      if (isTomorrow) {
        const t2 = new Date(today.getTime() + 24 * 60 * 60 * 1000);
        const yyyy2 = t2.getFullYear();
        const mm2 = String(t2.getMonth() + 1).padStart(2, "0");
        const dd2 = String(t2.getDate()).padStart(2, "0");
        targetDate = `${yyyy2}-${mm2}-${dd2}`;
      }

      return { type: "DATE_PROVIDED", date: targetDate };
    }

    if (step === "SELECT_HOUR") {
      const num = parseInt(lower, 10);
      if (!isNaN(num)) return { type: "HOUR_PROVIDED", slotIndex: num };
      return { type: "HOUR_PROVIDED" };
    }
  }

  return { type: "START_BOOKING" };
}

// ---------------------------------------------------------------------
// 9. AUTH STATE (Baileys multi-file) — persistencia en WA_SESSIONS_ROOT
// ---------------------------------------------------------------------

async function useFileAuthState(tenantId) {
  const { useMultiFileAuthState } = await import("@whiskeysockets/baileys");
  const sessionFolder = path.join(WA_SESSIONS_ROOT, String(tenantId));

  if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  return { state, saveCreds };
}

// ---------------------------------------------------------------------
// 10. CORE WHATSAPP (Baileys + n8n)
// ---------------------------------------------------------------------

async function getOrCreateSession(tenantId) {
  const existing = sessions.get(tenantId);
  if (existing && existing.socket) return existing;

  logger.info({ tenantId }, "🔌 Iniciando Socket...");

  const { default: makeWASocket, DisconnectReason } = await import("@whiskeysockets/baileys");
  const { state, saveCreds } = await useFileAuthState(tenantId);

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ["PymeBot", "Chrome", "1.0.0"],
    syncFullHistory: false,
    connectTimeoutMs: 60000,
  });

  const info = {
    tenantId,
    socket: sock,
    status: "connecting",
    qr: null,
    conversations: new Map(),
  };
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
        last_seen_at: new Date().toISOString(),
      });

      // (solo para debug en logs)
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      info.status = "connected";
      info.qr = null;

      const phone = sock?.user?.id ? sock.user.id.split(":")[0] : null;
      logger.info({ tenantId, phone }, "✅ Conectado");

      await updateSessionDB(tenantId, {
        status: "connected",
        qr_data: null,
        phone_number: phone,
        last_connected_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      });
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;

      logger.warn({ tenantId, code, shouldReconnect }, "⚠️ connection.close");

      if (shouldReconnect) {
        sessions.delete(tenantId);
        await updateSessionDB(tenantId, {
          status: "connecting",
          last_seen_at: new Date().toISOString(),
        });
        // reconecta
        getOrCreateSession(tenantId).catch(() => {});
      } else {
        sessions.delete(tenantId);
        await updateSessionDB(tenantId, { status: "disconnected", qr_data: null });
        logger.info({ tenantId }, "❌ Logout detectado: requiere QR.");
      }
    }
  });

  // IMPORTANTE: guardar credenciales actualizadas
  sock.ev.on("creds.update", async () => {
    try {
      await saveCreds();
      await updateSessionDB(tenantId, { last_seen_at: new Date().toISOString() });
    } catch (e) {
      logger.error(e, "[creds.update] saveCreds failed");
    }
  });

  // Mensajes entrantes
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages?.[0];
      if (!msg) return;
      if (!msg?.message || msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.includes("@g.us")) return;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text;

      if (!text) return;

      const pushName = msg.pushName || "Cliente";
      const userPhone = remoteJid.split("@")[0];

      let convo = info.conversations.get(userPhone);
      if (!convo) {
        convo = { history: [] };
        info.conversations.set(userPhone, convo);
      }
      const history = convo.history || [];

      const convoSession = await convoState.getOrCreateSession(tenantId, userPhone);
      const customerId = await getOrCreateCustomer(tenantId, userPhone);
      const event = buildBookingEventFromMessage(text, convoSession);

      const botApiUrl = process.env.N8N_WEBHOOK_URL;

      let replyText = null;
      let newState = null;
      let icsData = null;

      if (botApiUrl) {
        const payload = {
          tenantId,
          customerId,
          phoneNumber: userPhone,
          text,
          customerName: pushName,
          state: {
            current_flow: convoSession.current_flow,
            step: convoSession.step,
            payload: convoSession.payload || {},
          },
          event,
        };

        try {
          const response = await axios.post(botApiUrl, payload, { timeout: 60000 });
          const d = response?.data || null;

          if (d) {
            if (typeof d.data === "string") replyText = d.data;
            if (!replyText && typeof d.replyText === "string") replyText = d.replyText;
            if (!replyText && typeof d.message === "string") replyText = d.message;
            if (!replyText && typeof d.reply === "string") replyText = d.reply;

            if (d.newState) newState = d.newState;
            if (d.icsData) icsData = d.icsData;
          }
        } catch (err) {
          logger.error("[wa-server] Error n8n:", err?.response?.data || err.message);
        }
      } else {
        logger.error("[wa-server] N8N_WEBHOOK_URL no está configurado.");
      }

      if (!replyText) {
        const fallback = await generateReply(text, tenantId, pushName, history, userPhone);
        replyText =
          fallback ||
          "Ahora mismo no puedo gestionar bien tu solicitud. Inténtalo de nuevo en unos minutos, por favor. 🙏";

        newState = {
          current_flow: convoSession.current_flow,
          step: convoSession.step,
          payload: convoSession.payload || {},
        };
      }

      if (newState) {
        try {
          await convoState.updateSession(convoSession.id, {
            current_flow: newState.current_flow,
            step: newState.step,
            payload: newState.payload,
          });
        } catch (err) {
          logger.error("[wa-server] Error actualizando conversación:", err);
        }
      }

      await sock.sendMessage(remoteJid, { text: replyText });

      if (icsData) {
        const ok = await sendICS(sock, remoteJid, icsData, {
          fileName: "cita_confirmada.ics",
          caption: "📅 Toca aquí para guardar/actualizar tu cita en el calendario",
        });
        if (!ok) logger.warn({ tenantId }, "⚠️ icsData inválido (texto/base64).");
      }

      history.push({ role: "user", content: text });
      history.push({ role: "assistant", content: replyText });

      const MAX_MESSAGES = 20;
      if (history.length > MAX_MESSAGES) history.splice(0, history.length - MAX_MESSAGES);

      convo.history = history;
      info.conversations.set(userPhone, convo);

      // heartbeat DB (evita “sesión fantasma”)
      updateSessionDB(tenantId, { last_seen_at: new Date().toISOString() }).catch(() => {});
    } catch (e) {
      logger.error("[wa-server] Error en messages.upsert:", e);
    }
  });

  return info;
}

// ---------------------------------------------------------------------
// 11. API ROUTES
// ---------------------------------------------------------------------

app.get("/health", (req, res) => res.json({ ok: true, active_sessions: sessions.size }));

/**
 * ✅ Estado REAL (memoria + DB fallback) — no miente al reiniciar Render
 */
app.get("/sessions/:tenantId", async (req, res) => {
  const tenantId = req.params.tenantId;

  // 1) memoria
  const info = sessions.get(tenantId);
  if (info) {
    return res.json({
      ok: true,
      session: {
        id: tenantId,
        status: info.status,
        qr_data: info.qr || null,
        phone_number: info.socket?.user?.id?.split(":")[0] || null,
        source: "memory",
      },
    });
  }

  // 2) DB fallback
  const { data, error } = await supabase
    .from("whatsapp_sessions")
    .select("tenant_id, status, qr_data, phone_number, last_seen_at, last_connected_at")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ ok: false, error: "db_error", detail: error.message });
  }

  if (!data) {
    return res.json({
      ok: true,
      session: { id: tenantId, status: "disconnected", qr_data: null, source: "none" },
    });
  }

  return res.json({
    ok: true,
    session: {
      id: data.tenant_id,
      status: data.status || "disconnected",
      qr_data: data.qr_data || null,
      phone_number: data.phone_number || null,
      last_seen_at: data.last_seen_at || null,
      last_connected_at: data.last_connected_at || null,
      source: "db",
    },
  });
});

app.post("/sessions/:tenantId/connect", async (req, res) => {
  const tenantId = req.params.tenantId;
  try {
    const info = await getOrCreateSession(tenantId);
    // espera un poco por si conecta rápido
    const s = await waitForConnected(tenantId, 2500);
    return res.json({
      ok: true,
      status: s?.status || info.status || "connecting",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "connect_failed" });
  }
});

app.post("/sessions/:tenantId/disconnect", async (req, res) => {
  const tenantId = req.params.tenantId;
  const s = sessions.get(tenantId);

  try {
    if (s?.socket) await s.socket.logout().catch(() => {});
  } finally {
    sessions.delete(tenantId);
    await updateSessionDB(tenantId, { status: "disconnected", qr_data: null });
  }

  res.json({ ok: true });
});

// ------------------- SEND API (vendible para n8n) ---------------------

async function sendTextForTenant({ tenantId, to, message, options }) {
  await getOrCreateSession(tenantId).catch(() => {});
  const session = await waitForConnected(tenantId, 12000);

  if (!session || !session.socket) {
    return { ok: false, error: "wa_not_connected" };
  }

  if (session.status === "qrcode") {
    return { ok: false, error: "qrcode_required" };
  }

  if (session.status !== "connected") {
    return { ok: false, error: "wa_not_connected" };
  }

  let jid;
  try {
    jid = toWhatsAppJid(to);
  } catch (e) {
    return { ok: false, error: e.message || "invalid_to" };
  }

  try {
    const result = await session.socket.sendMessage(jid, { text: String(message) }, options || {});
    return { ok: true, to: jid, messageId: result?.key?.id || null };
  } catch (e) {
    return { ok: false, error: "send_failed", detail: e.message };
  }
}

/**
 * ✅ Endpoint principal para N8N:
 * POST /sessions/:tenantId/messages
 * body: { "to": "...", "message": "...", "options": {...} }
 */
app.post("/sessions/:tenantId/messages", requireAuth, async (req, res) => {
  const { tenantId } = req.params;
  const { to, message, options } = req.body || {};

  if (!to || !message) {
    return res.status(400).json({ ok: false, error: "missing_fields", detail: "Requiere to y message" });
  }

  const out = await sendTextForTenant({ tenantId, to, message, options });

  if (out.ok) return res.json(out);
  if (out.error === "qrcode_required") return res.status(409).json(out);
  if (out.error === "wa_not_connected") return res.status(400).json(out);

  return res.status(500).json(out);
});

/**
 * ✅ Alias retro: POST /sessions/:tenantId/send-message
 * body: { phone, message }
 */
app.post("/sessions/:tenantId/send-message", requireAuth, async (req, res) => {
  const { tenantId } = req.params;
  const { phone, message } = req.body || {};

  if (!phone || !message) {
    return res.status(400).json({ ok: false, error: "missing_fields", detail: "Requiere phone y message" });
  }

  const out = await sendTextForTenant({ tenantId, to: phone, message });

  if (out.ok) return res.json(out);
  if (out.error === "qrcode_required") return res.status(409).json(out);
  if (out.error === "wa_not_connected") return res.status(400).json(out);

  return res.status(500).json(out);
});

// ------------------- Templates / Media (tu lógica intacta) ------------

app.post("/sessions/:tenantId/send-template", requireAuth, async (req, res) => {
  const { tenantId } = req.params;
  const { event, phone, variables } = req.body;

  if (!event || !phone) return res.status(400).json({ ok: false, error: "missing_fields" });

  await getOrCreateSession(tenantId).catch(() => {});
  const session = await waitForConnected(tenantId, 12000);

  if (!session || session.status === "qrcode") {
    return res.status(409).json({ ok: false, error: "qrcode_required" });
  }
  if (!session || session.status !== "connected") {
    return res.status(400).json({ ok: false, error: "wa_not_connected" });
  }

  const templateBody = await getTemplate(tenantId, event);
  if (!templateBody) return res.status(404).json({ ok: false, error: `template_not_found:${event}` });

  const text = renderTemplate(templateBody, variables || {});
  const jid = toWhatsAppJid(phone);

  try {
    await session.socket.sendMessage(jid, { text });

    if (event === "booking_confirmed" && variables?.date && variables?.time) {
      const context = await getTenantContext(tenantId);
      const dateStr = `${variables.date} ${variables.time}`;
      const appointmentDate = new Date(dateStr);

      if (!isNaN(appointmentDate.getTime())) {
        const icsBuffer = createICSFile(
          `Cita en ${context.name}`,
          `Servicio con ${variables.resource_name || "Nosotros"}.`,
          "En el local",
          appointmentDate
        );

        await session.socket.sendMessage(jid, {
          document: icsBuffer,
          mimetype: "text/calendar; charset=utf-8",
          fileName: "agendar_cita.ics",
          caption: "📅 Toca este archivo para agregar el recordatorio a tu calendario.",
        });
      }
    }

    res.json({ ok: true });
  } catch (e) {
    logger.error(e, "Fallo enviando plantilla");
    res.status(500).json({ ok: false, error: "send_failed", detail: e.message });
  }
});

app.post("/sessions/:tenantId/send-media", requireAuth, async (req, res) => {
  const { tenantId } = req.params;
  const { phone, type, base64, fileName, mimetype, caption } = req.body;

  if (!phone || !base64 || !type) {
    return res.status(400).json({ ok: false, error: "missing_fields" });
  }

  await getOrCreateSession(tenantId).catch(() => {});
  const session = await waitForConnected(tenantId, 12000);

  if (!session || session.status === "qrcode") {
    return res.status(409).json({ ok: false, error: "qrcode_required" });
  }
  if (!session || session.status !== "connected") {
    return res.status(400).json({ ok: false, error: "wa_not_connected" });
  }

  const jid = toWhatsAppJid(phone);

  try {
    const mediaBuffer = Buffer.from(base64, "base64");

    let payload = {};
    if (type === "document") {
      payload = {
        document: mediaBuffer,
        mimetype: mimetype || "application/octet-stream",
        fileName: fileName || "archivo.bin",
        caption: caption || "",
      };
    } else if (type === "image") {
      payload = { image: mediaBuffer, caption: caption || "" };
    } else if (type === "audio") {
      payload = { audio: mediaBuffer, mimetype: mimetype || "audio/mp4" };
    } else {
      return res.status(400).json({ ok: false, error: "invalid_type" });
    }

    await session.socket.sendMessage(jid, payload);
    res.json({ ok: true });
  } catch (e) {
    logger.error(e, "Error enviando media");
    res.status(500).json({ ok: false, error: "send_failed", detail: e.message });
  }
});

// ---------------------------------------------------------------------
// 12. Availability (tu lógica intacta)
// ---------------------------------------------------------------------

app.get("/api/v1/availability", async (req, res) => {
  const { tenantId, resourceId, date } = req.query;

  if (!tenantId || !date) return res.status(400).json({ ok: false, error: "missing_fields" });

  const requestedDate = new Date(String(date));
  if (isNaN(requestedDate.getTime())) {
    return res.status(400).json({ ok: false, error: "invalid_date" });
  }

  const slots = await getAvailableSlots(
    String(tenantId),
    resourceId ? String(resourceId) : null,
    requestedDate,
    7
  );

  const sorted = (slots || []).sort((a, b) => a.start.getTime() - b.start.getTime());

  const formattedSlots = sorted.map((s) =>
    `${s.start.toLocaleString("es-DO", {
      weekday: "short",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })}`
  );

  res.json({
    ok: true,
    available_slots_count: sorted.length,
    available_slots: formattedSlots.slice(0, 40),
  });
});

// ---------------------------------------------------------------------
// 13-15. Booking endpoints (TU CÓDIGO)
// ---------------------------------------------------------------------
// ✅ Aquí pega tus endpoints create-booking, reschedule-booking, cancel-booking EXACTOS.
// (Los tuyos estaban bien; el bug real era estado/sesión y endpoints n8n.)
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// 16. restoreSessions
// ---------------------------------------------------------------------

async function restoreSessions() {
  try {
    logger.info("♻️ Restaurando sesiones (DB)...");
    const { data, error } = await supabase
      .from("whatsapp_sessions")
      .select("tenant_id, status")
      .in("status", ["connected", "qrcode", "connecting"]);

    if (error) {
      logger.error(error, "restoreSessions: DB error");
      return;
    }
    if (!data?.length) return;

    for (const row of data) {
      const tenantId = row.tenant_id;
      try {
        await getOrCreateSession(tenantId);
        await updateSessionDB(tenantId, { last_seen_at: new Date().toISOString() });
      } catch (e) {
        logger.error({ tenantId, e }, "restoreSessions: failed");
      }
    }
  } catch (e) {
    logger.error(e, "restoreSessions: fatal");
  }
}

// ---------------------------------------------------------------------
// START
// ---------------------------------------------------------------------

app.listen(PORT, () => {
  logger.info(`🚀 WA server escuchando en puerto ${PORT}`);
  restoreSessions().catch((e) => logger.error(e, "Error restoreSessions"));
});
