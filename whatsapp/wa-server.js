/**
 * wa-server.js — VERSIÓN FINAL CORREGIDA (N8N + NUCLEAR FIX)
 *
 * ✅ CEREBRO: n8n (Prioridad) + OpenAI (Fallback).
 * ✅ CONEXIÓN: Nuclear (Borrado físico de sesión + Tiempos de espera).
 * ✅ COMPATIBILIDAD: Browser "Creativa Web" en Windows (Universal).
 */

require("dotenv").config({ path: ".env.local" });
require("dotenv").config();

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const express = require("express");
const qrcode = require("qrcode-terminal");
const P = require("pino");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");
const fs = require("fs");
const axios = require("axios");

// Importaciones de Date-fns
const { startOfWeek, addDays, startOfDay } = require("date-fns");

// 👇 estado de conversación en Supabase
const convoState = require("./conversationState");

// ---------------------------------------------------------------------
// CONFIGURACIÓN GLOBAL
// ---------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "20mb" }));
const PORT = process.env.PORT || process.env.WA_SERVER_PORT || 4001;

// 🔥 AJUSTE DE ZONA HORARIA (CRÍTICO)
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

// 👇 OpenAI con fallback y logs claros
const openaiApiKey =
  process.env.OPENAI_API_KEY ||
  process.env.OPENAI_KEY ||
  process.env.OPENAI_SECRET ||
  null;

if (!openaiApiKey) {
  console.warn(
    "[wa-server] ⚠️ No hay API key de OpenAI configurada (OPENAI_API_KEY / OPENAI_KEY). El fallback de IA no va a funcionar."
  );
}
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

/**
 * sessions: Map<tenantId, {
 * tenantId,
 * socket,
 * status,
 * qr,
 * conversations: Map<phone, { history: Array<{role, content}> }>
 * }>
 */
const sessions = new Map();

// Definimos la carpeta donde se guardarán las sesiones (Persistencia)
const WA_SESSIONS_ROOT =
  process.env.WA_SESSIONS_DIR || path.join(__dirname, ".wa-sessions");

// Crear la carpeta si no existe
try {
  if (!fs.existsSync(WA_SESSIONS_ROOT)) fs.mkdirSync(WA_SESSIONS_ROOT, { recursive: true });
} catch (e) {
  console.error("[wa-server] No pude crear WA_SESSIONS_ROOT:", WA_SESSIONS_ROOT, e);
}

// ---------------------------------------------------------------------
// HELPERS DE UTILIDAD (Sleep & Normalize)
// ---------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForConnected(tenantId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = sessions.get(tenantId);
    if (s?.status === "connected" && s?.socket) return s;
    await sleep(500);
  }
  return sessions.get(tenantId) || null;
}

// =====================================================================
// 1. LÓGICA DE SCHEDULING
// =====================================================================

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

/**
 * Calcula las ventanas abiertas basándose en Business Hours y ajustando la zona horaria.
 */
function weeklyOpenWindows(weekStart, businessHours) {
  const windows = [];
  let currentDayCursor = new Date(weekStart);

  for (let i = 0; i < 7; i++) {
    const currentDow = currentDayCursor.getDay(); // 0=Dom, 1=Lun...

    const dayConfig = businessHours.find(
      (bh) => bh.dow === currentDow && bh.is_closed === false
    );

    if (dayConfig && dayConfig.open_time && dayConfig.close_time) {
      const { h: openH, m: openM } = hmsToParts(toHHMM(dayConfig.open_time));
      const { h: closeH, m: closeM } = hmsToParts(toHHMM(dayConfig.close_time));

      // 🔥 CORRECCIÓN UTC: Sumamos el offset a la hora de apertura/cierre
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

/**
 * Resta las citas ocupadas a las ventanas abiertas.
 */
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
// 2. HELPERS: CALENDARIO Y ARCHIVOS (.ICS)
// ---------------------------------------------------------------------

function createICSFile(
  title,
  description,
  location,
  startDate,
  durationMinutes = 60
) {
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

/**
 * ✅ ICS ROBUSTO (texto o base64)
 */
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
// 3. CEREBRO DEL NEGOCIO & CÁLCULO DE DISPONIBILIDAD
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
  } catch (e) {
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
// 4. INTENT_KEYWORDS ENGINE
// ---------------------------------------------------------------------

function normalizeForIntent(str = "") {
  return str
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Lee intent_keywords y devuelve un resumen JSON de las intenciones detectadas.
 */
async function buildIntentHints(tenantId, userText) {
  try {
    const normalizedUser = normalizeForIntent(userText);

    const { data, error } = await supabase
      .from("intent_keywords")
      .select("intent, frase, peso, es_error, locale, term, tenant_id")
      .or(`tenant_id.eq.${tenantId},tenant_id.is.null`);

    if (error || !data || data.length === 0) return "";

    const scores = {}; // intent -> { score, terms: Set<string> }

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
        if (!scores[intent]) {
          scores[intent] = { intent, score: 0, terms: new Set() };
        }
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
// 5. DEFINICIÓN DE TOOLS (CEREBRO UNIVERSAL)
// ---------------------------------------------------------------------

const tools = [
  {
    type: "function",
    function: {
      name: "check_availability",
      description:
        "Consulta disponibilidad. Úsalo para ver huecos libres para citas o reservas.",
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
      description:
        "Crea una Cita, Reserva de Mesa o Pedido Programado. NO pidas serviceId si el cliente no lo especifica.",
      parameters: {
        type: "object",
        properties: {
          customerName: { type: "string" },
          phone: { type: "string" },
          startsAtISO: { type: "string" },
          endsAtISO: { type: "string" },
          notes: {
            type: "string",
            description:
              "Motivo de la cita, cantidad de personas (si es restaurante) o detalles.",
          },
          serviceId: {
            type: "string",
            description:
              "Opcional. Solo si el cliente eligió un servicio específico del catálogo.",
          },
        },
        required: ["phone", "startsAtISO"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_catalog",
      description:
        "Consulta el menú, servicios o productos del negocio para dar precios y detalles.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "human_handoff",
      description:
        "Úsalo cuando el cliente pida hablar con una persona real o si no sabes la respuesta.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "reschedule_booking",
      description:
        "Reagenda una cita activa del cliente usando su teléfono y nueva fecha/hora.",
      parameters: {
        type: "object",
        properties: {
          customerPhone: { type: "string", description: "Teléfono del cliente (WhatsApp)." },
          newStartsAtISO: { type: "string", description: "Nueva fecha/hora inicio ISO 8601." },
          newEndsAtISO: { type: "string", description: "Nueva fecha/hora fin ISO. Opcional." },
        },
        required: ["customerPhone", "newStartsAtISO"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_booking",
      description:
        "Cancela la última cita activa de un cliente usando su teléfono.",
      parameters: {
        type: "object",
        properties: {
          customerPhone: { type: "string", description: "Teléfono del cliente (WhatsApp)." },
        },
        required: ["customerPhone"],
      },
    },
  },
];

// ---------------------------------------------------------------------
// 6. IA CON CEREBRO DINÁMICO (Lee la DB para saber qué ser)
// ---------------------------------------------------------------------

async function generateReply(text, tenantId, pushName, historyMessages = [], userPhone = null) {
  if (!openai) {
    logger.error("[generateReply] OpenAI no está configurado, no puedo generar respuesta IA.");
    return null;
  }

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
        "Eres el host de un restaurante. Tu objetivo es RESERVAR MESAS o TOMAR PEDIDOS. Cuando agendes, en 'notes' guarda la cantidad de personas.";
      break;
    case "clinica":
      typeContext =
        "Eres recepcionista médico. Tu objetivo es agendar CITAS. Sé formal y discreto. Pregunta brevemente el motivo y guárdalo en 'notes'.";
      break;
    case "barberia":
      typeContext =
        "Eres el asistente de una barbería. Agenda citas. Si no especifican barbero, agenda con cualquiera.";
      break;
    default:
      typeContext =
        "Eres un asistente general de negocios. Tu objetivo es AGENDAR citas o responder dudas.";
  }

  const systemPrompt = `
IDENTIDAD: Te llamas "${botName}".
TONO: ${botTone}.
ROL: ${typeContext}

INFORMACIÓN DEL NEGOCIO (Reglas de Oro):
"${customRules}"

DATOS ACTUALES:
- Fecha y Hora Local: ${currentDateStr}.
- Cliente: "${pushName}".
- Teléfono WhatsApp del cliente (úsalo SIEMPRE como "phone" / "customerPhone" en las herramientas): ${userPhone || "desconocido"}.
- INTENTOS DETECTADOS POR PALABRAS CLAVE (intent_keywords): ${intentHints || "ninguno claro"}.

INSTRUCCIONES:
1) Si el cliente propone una hora y hay hueco, agenda de inmediato.
2) Si preguntan precios/menú, usa get_catalog (no inventes).
3) Si falta serviceId, agenda con serviceId:null y mete detalle en notes.
4) Si piden humano/soporte, usa human_handoff.
5) Si check_availability devuelve slots, lista por label y pide número.
6) Si el cliente elige opción N, usa slot.isoStart para create_booking.
7) Si tú propusiste una hora y el cliente dice "sí", agenda ya.
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

    if (message.tool_calls) {
      messages.push(message);

      for (const toolCall of message.tool_calls) {
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments || "{}");
        let response;

        if (fnName === "check_availability") {
          const rawSlots = await getAvailableSlots(
            tenantId,
            null,
            new Date(args.requestedDate),
            7
          );

          const sortedSlots = (rawSlots || []).sort(
            (a, b) => a.start.getTime() - b.start.getTime()
          );

          if (sortedSlots.length > 0) {
            const slotObjects = sortedSlots.slice(0, 12).map((s, i) => {
              const timeStr = s.start.toLocaleString("es-DO", {
                timeZone: tz,
                hour: "2-digit",
                minute: "2-digit",
                hour12: true,
              });
              return {
                index: i + 1,
                label: `${i + 1}) ${timeStr}`,
                isoStart: s.start.toISOString(),
                isoEnd: s.end.toISOString(),
              };
            });

            const listText = slotObjects.map((s) => s.label).join("\n");

            response = JSON.stringify({
              message:
                "Aquí tienes los horarios disponibles (el cliente elegirá por número). Usa SIEMPRE 'index' + 'isoStart' para agendar.",
              slots: slotObjects,
              plain_list: listText,
            });
          } else {
            response = JSON.stringify({
              message:
                "No hay horarios disponibles para esa fecha. Dile al cliente que intente otro día.",
              slots: [],
            });
          }
        } else if (fnName === "get_catalog") {
          const { data: items } = await supabase
            .from("items")
            .select("name, price_cents, description, type")
            .eq("tenant_id", tenantId)
            .eq("is_active", true);

          if (items && items.length > 0) {
            const list = items
              .map((i) => {
                const price = (i.price_cents / 100).toFixed(0);
                return `- ${i.name} ($${price}): ${i.description || ""}`;
              })
              .join("\n");
            response = JSON.stringify({ catalog: list });
          } else {
            response = JSON.stringify({
              message:
                "El catálogo está vacío en el sistema. Responde basándote solo en custom_instructions o sugiere contactar al humano.",
            });
          }
        } else if (fnName === "create_booking") {
          const phoneArg = args.phone || userPhone;
          const startsISO = args.startsAtISO;

          if (!phoneArg || !startsISO) {
            response = JSON.stringify({
              success: false,
              error:
                "missing_phone_or_start: falta phone o startsAtISO para crear la cita.",
            });
          } else {
            const start = new Date(startsISO);
            const endISO =
              args.endsAtISO ||
              new Date(start.getTime() + 60 * 60000).toISOString();

            const { data: booking, error } = await supabase
              .from("bookings")
              .insert([
                {
                  tenant_id: tenantId,
                  resource_id: null,
                  service_id: args.serviceId || null,
                  customer_name: args.customerName || pushName,
                  customer_phone: phoneArg,
                  starts_at: startsISO,
                  ends_at: endISO,
                  status: "confirmed",
                  notes: args.notes || "Agendado por Bot",
                },
              ])
              .select("id")
              .single();

            if (!error) {
              response = JSON.stringify({
                success: true,
                bookingId: booking.id,
                message: "Reserva/Cita creada exitosamente en el sistema.",
              });
            } else {
              response = JSON.stringify({
                success: false,
                error:
                  "Error guardando en base de datos: " +
                  (error?.message || "desconocido"),
              });
            }
          }
        } else if (fnName === "human_handoff") {
          if (humanPhone) {
            const clean = humanPhone.replace(/\D/g, "");
            response = JSON.stringify({
              message: `Dile al cliente que puede escribir directamente a nuestro encargado aquí: https://wa.me/${clean}`,
            });
          } else {
            response = JSON.stringify({
              message:
                "No tengo un número de contacto directo configurado. Dile que deje su mensaje y lo contactaremos.",
            });
          }
        } else if (fnName === "reschedule_booking") {
          const phoneFilter = args.customerPhone || args.phone || userPhone || null;

          if (!phoneFilter) {
            response = JSON.stringify({
              success: false,
              error:
                "missing_phone: necesito el teléfono del cliente para reagendar.",
            });
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

            if (booking) {
              const newStart = args.newStartsAtISO;
              const newEnd =
                args.newEndsAtISO ||
                new Date(new Date(newStart).getTime() + 60 * 60000).toISOString();

              const { error } = await supabase
                .from("bookings")
                .update({ starts_at: newStart, ends_at: newEnd })
                .eq("id", booking.id);

              if (!error) {
                response = JSON.stringify({
                  success: true,
                  message: "Cita reagendada correctamente.",
                });
              } else {
                response = JSON.stringify({
                  success: false,
                  error: "Error actualizando la cita en base de datos.",
                });
              }
            } else {
              response = JSON.stringify({
                success: false,
                error:
                  "No encontré ninguna cita activa con ese número de teléfono.",
              });
            }
          }
        } else if (fnName === "cancel_booking") {
          const phoneFilter = args.customerPhone || args.phone || userPhone || null;

          if (!phoneFilter) {
            response = JSON.stringify({
              success: false,
              error:
                "missing_phone: necesito el teléfono del cliente para cancelar.",
            });
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

            if (booking) {
              const { error } = await supabase
                .from("bookings")
                .update({ status: "cancelled" })
                .eq("id", booking.id);

              if (!error) {
                response = JSON.stringify({
                  success: true,
                  message: "Cita cancelada correctamente.",
                });
              } else {
                response = JSON.stringify({
                  success: false,
                  error: "Error cancelando la cita.",
                });
              }
            } else {
              response = JSON.stringify({
                success: false,
                error: "No encontré ninguna cita activa para cancelar.",
              });
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
    }

    return message.content?.trim() || "";
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
// 8. HELPERS NUEVOS: customers + eventos de booking
// ---------------------------------------------------------------------

async function getOrCreateCustomer(tenantId, phoneNumber) {
  if (!tenantId || !phoneNumber) {
    throw new Error("[wa-server] tenantId y phoneNumber requeridos para customer.");
  }

  const { data, error } = await supabase
    .from("customers")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("phone_number", phoneNumber)
    .maybeSingle();

  if (error) {
    logger.error("[wa-server] Error al buscar customer:", error);
    throw error;
  }

  if (data) return data.id;

  const { data: created, error: insertError } = await supabase
    .from("customers")
    .insert({ tenant_id: tenantId, phone_number: phoneNumber })
    .select("id")
    .single();

  if (insertError) {
    logger.error("[wa-server] Error al crear customer:", insertError);
    throw insertError;
  }

  return created.id;
}

function buildBookingEventFromMessage(text, session) {
  const lower = (text || "").toLowerCase().trim();
  const currentFlow = session.current_flow;
  const step = session.step;

  if (lower === "cancelar" || lower === "olvídalo" || lower === "olvidalo") {
    return { type: "CANCEL_FLOW" };
  }

  if (!currentFlow) {
    // Por ahora: todo cae a booking (tu lógica)
    return { type: "START_BOOKING" };
  }

  if (currentFlow === "BOOKING") {
    if (step === "SELECT_SERVICE") {
      let serviceId = null;

      if (lower.includes("corte") && lower.includes("barba")) {
        serviceId = "service_corte_barba";
      } else if (lower.includes("corte")) {
        serviceId = "service_corte";
      } else if (lower.includes("barba")) {
        serviceId = "service_barba";
      }

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
// 9. AUTH STATE MONOLÍTICO
// ---------------------------------------------------------------------

async function useSupabaseAuthState(tenantId) {
  if (!tenantId) throw new Error("useSupabaseAuthState requiere tenantId");

  const { useMultiFileAuthState } = await import("@whiskeysockets/baileys");
  const sessionFolder = path.join(WA_SESSIONS_ROOT, String(tenantId));

  if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  return { state, saveCreds };
}

// ---------------------------------------------------------------------
// 10. CORE WHATSAPP (Baileys + integración n8n)
// ---------------------------------------------------------------------

async function getOrCreateSession(tenantId) {
  const existing = sessions.get(tenantId);
  if (existing && existing.socket) return existing;

  logger.info({ tenantId }, "🔌 Iniciando Socket...");

  const { default: makeWASocket, DisconnectReason } = await import("@whiskeysockets/baileys");
  const { state, saveCreds } = await useSupabaseAuthState(tenantId);

  // 🔥 CONFIGURACIÓN NUCLEAR: BROWSER "Creativa Web" (Universal) + TIMEOUTS
  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    // Browser universal para evitar bloqueos
    browser: ["Creativa Web", "Chrome", "10.0.0"],
    syncFullHistory: false,
    connectTimeoutMs: 60000, 
    keepAliveIntervalMs: 10000, 
    retryRequestDelayMs: 5000,
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

      qrcode.generate(qr, { small: true });
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
      });
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        sessions.delete(tenantId);
        logger.info({ tenantId }, "🔄 Conexión perdida, intentando reconectar automáticamente...");
        getOrCreateSession(tenantId);
      } else {
        sessions.delete(tenantId);
        await updateSessionDB(tenantId, { status: "disconnected", qr_data: null });
        logger.info({ tenantId }, "❌ Sesión cerrada permanentemente (Logout).");
      }
    }
  });

  sock.ev.on("creds.update", async () => { await saveCreds(); });

  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages?.[0];
      if (!msg) return;

      logger.info({ tenantId }, "[wa-server] 📩 messages.upsert recibido");

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

      if (!info.conversations) info.conversations = new Map();

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

      if (!botApiUrl) {
        logger.error("[wa-server] N8N_WEBHOOK_URL no está configurado.");
      } else {
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
          logger.info({ tenantId }, "[wa-server] Llamando a n8n (timeout 60s)");
          const response = await axios.post(botApiUrl, payload, { timeout: 60000 });

          // ✅ Normalización de respuesta (n8n / legacy)
          const d = response?.data || null;

          if (d) {
            // n8n simple
            if (typeof d.data === "string") replyText = d.data;

            // variantes comunes
            if (!replyText && typeof d.replyText === "string") replyText = d.replyText;
            if (!replyText && typeof d.message === "string") replyText = d.message;

            // legacy bot-suite
            if (!replyText && typeof d.reply === "string") replyText = d.reply;
            if (d.newState) newState = d.newState;
            if (d.icsData) icsData = d.icsData;
          }

          if (replyText) logger.info({ tenantId }, "[wa-server] ✅ Respuesta recibida desde n8n");
          else logger.warn({ tenantId, d }, "[wa-server] ⚠️ n8n respondió pero sin texto usable");
        } catch (err) {
          logger.error(
            "[wa-server] Error al llamar a n8n:",
            err?.response?.data || err.message
          );
        }
      }

      if (!replyText) {
        logger.info({ tenantId }, "[wa-server] Usando fallback de OpenAI");
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
          logger.error("[wa-server] Error al actualizar conversación:", err);
        }
      }

      await sock.sendMessage(remoteJid, { text: replyText });

      if (icsData) {
        const ok = await sendICS(sock, remoteJid, icsData, {
          fileName: "cita_confirmada.ics",
          caption: "📅 Toca aquí para guardar/actualizar tu cita en el calendario",
        });

        if (!ok) {
          logger.warn({ tenantId }, "⚠️ icsData llegó pero no era válido (texto/base64).");
        } else {
          logger.info({ tenantId }, "✅ ICS enviado correctamente.");
        }
      }

      history.push({ role: "user", content: text });
      history.push({ role: "assistant", content: replyText });

      const MAX_MESSAGES = 20;
      if (history.length > MAX_MESSAGES) history.splice(0, history.length - MAX_MESSAGES);

      convo.history = history;
      info.conversations.set(userPhone, convo);
    } catch (e) {
      logger.error("[wa-server] Error en messages.upsert:", e);
    }
  });

  return info;
}

// ---------------------------------------------------------------------
// 11. API ROUTES BÁSICAS
// ---------------------------------------------------------------------

app.get("/health", (req, res) =>
  res.json({ ok: true, active_sessions: sessions.size })
);

// Ruta para que el dashboard lea estado y QR
app.get("/sessions/:tenantId", async (req, res) => {
  const tenantId = req.params.tenantId;
  const info = sessions.get(tenantId);

  if (!info) {
    return res.json({
      ok: true,
      session: { id: tenantId, status: "disconnected", qr_data: null },
    });
  }

  return res.json({
    ok: true,
    session: {
      id: tenantId,
      status: info.status,
      qr_data: info.qr || null,
      phone_number: info.socket?.user?.id?.split(":")[0] || null,
    },
  });
});

// 🔥 CONNECT NUCLEAR MEJORADO (CON WAIT)
app.post("/sessions/:tenantId/connect", async (req, res) => {
  const tenantId = req.params.tenantId;

  try {
    // 1. Limpieza de DB (Resetear estado para evitar falsos positivos)
    await updateSessionDB(tenantId, { status: "disconnected", qr_data: null });

    // 2. Matar sesión vieja en Memoria
    const existing = sessions.get(tenantId);
    if (existing) {
      try {
        existing.socket.end(undefined);
        sessions.delete(tenantId);
      } catch (e) {
        console.error("Error cerrando socket viejo:", e);
      }
    }

    // 3. 🔥 BORRADO FÍSICO DE CARPETA + ESPERA (Nuclear Fix)
    const sessionFolder = path.join(WA_SESSIONS_ROOT, String(tenantId));
    if (fs.existsSync(sessionFolder)) {
      try {
        fs.rmSync(sessionFolder, { recursive: true, force: true });
        // 👇 ESTE ES EL SECRETO: Esperar que el disco termine de borrar
        await sleep(2000); 
        logger.info({ tenantId }, "🗑️ Carpeta de sesión eliminada.");
      } catch (err) {
        logger.error({ tenantId, err }, "No se pudo borrar la carpeta de sesión.");
      }
    }

    // 4. Crear nueva sesión fresca
    const info = await getOrCreateSession(tenantId);
    
    // Esperar un poco para dar tiempo al QR real
    await waitForConnected(tenantId, 3000);

    return res.json({ ok: true, status: info.status || "connecting" });
  } catch (e) {
    console.error("[/sessions/:tenantId/connect] Error:", e);
    return res.status(500).json({
      ok: false,
      error: e.message || "Error iniciando sesión de WhatsApp",
    });
  }
});

app.post("/sessions/:tenantId/disconnect", async (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (s?.socket) await s.socket.logout().catch(() => {});
  sessions.delete(req.params.tenantId);
  await updateSessionDB(req.params.tenantId, { status: "disconnected", qr_data: null });
  res.json({ ok: true });
});

/**
 * ✅ ENDPOINT: Enviar mensaje simple (para n8n HTTP Request)
 * - FIX: estaba abajo de app.listen en tu archivo → lo moví aquí
 * - Extra: intenta restaurar sesión si no está cargada
 */
app.post("/sessions/:tenantId/send-message", async (req, res) => {
  const { tenantId } = req.params;
  const { phone, message } = req.body || {};

  if (!phone || !message) {
    return res.status(400).json({ ok: false, error: "missing_fields", detail: "Requiere phone y message" });
  }

  let session = sessions.get(tenantId);

  // Si no existe o no está conectada, intenta levantarla
  if (!session || session.status !== "connected") {
    try {
      session = await getOrCreateSession(tenantId);
    } catch (e) {
      // ignore
    }
  }

  session = sessions.get(tenantId);
  if (!session || session.status !== "connected") {
    return res.status(400).json({ ok: false, error: "wa_not_connected" });
  }

  const jid = String(phone).replace(/\D/g, "") + "@s.whatsapp.net";

  try {
    await session.socket.sendMessage(jid, { text: String(message) });
    logger.info({ tenantId, phone }, "✅ send-message enviado");
    return res.json({ ok: true });
  } catch (e) {
    logger.error(e, "Error en send-message");
    return res.status(500).json({ ok: false, error: "send_failed", detail: e.message });
  }
});

/**
 * ENDPOINT: Envía plantilla + archivo ICS
 */
app.post("/sessions/:tenantId/send-template", async (req, res) => {
  const { tenantId } = req.params;
  const { event, phone, variables } = req.body;

  if (!event || !phone) return res.status(400).json({ error: "Faltan datos" });

  let session = sessions.get(tenantId);
  if (!session || session.status !== "connected") {
    try {
      session = await getOrCreateSession(tenantId);
    } catch (e) {}
  }

  session = sessions.get(tenantId);
  if (!session || session.status !== "connected") {
    return res.status(400).json({ error: "Bot no conectado." });
  }

  const templateBody = await getTemplate(tenantId, event);
  if (!templateBody) return res.status(404).json({ error: `Plantilla no encontrada: ${event}` });

  const message = renderTemplate(templateBody, variables || {});
  const jid = phone.replace(/\D/g, "") + "@s.whatsapp.net";

  try {
    await session.socket.sendMessage(jid, { text: message });

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

        logger.info({ tenantId, event, phone }, "✅ Plantilla + ICS enviados correctamente");
      }
    }

    logger.info({ tenantId, event, phone }, "📨 Plantilla enviada");
    res.json({ ok: true, message });
  } catch (e) {
    logger.error(e, "Fallo enviando mensaje");
    res.status(500).json({ error: "Error envío" });
  }
});

// ---------------------------------------------------------------------
// ENDPOINT NUEVO: Enviar Archivos/Media (ICS, PDF, IMG) desde Next.js
// ---------------------------------------------------------------------
app.post("/sessions/:tenantId/send-media", async (req, res) => {
  const { tenantId } = req.params;
  const { phone, type, base64, fileName, mimetype, caption } = req.body;

  if (!phone || !base64 || !type) {
    return res.status(400).json({ error: "Faltan datos (phone, base64, type)" });
  }

  let session = sessions.get(tenantId);
  if (!session || session.status !== "connected") {
    try {
      session = await getOrCreateSession(tenantId);
    } catch (e) {}
  }

  session = sessions.get(tenantId);
  if (!session || session.status !== "connected") {
    return res.status(400).json({ error: "Bot no conectado." });
  }

  const jid = String(phone).replace(/\D/g, "") + "@s.whatsapp.net";

  try {
    const mediaBuffer = Buffer.from(base64, "base64");

    let messagePayload = {};

    if (type === "document") {
      messagePayload = {
        document: mediaBuffer,
        mimetype: mimetype || "application/octet-stream",
        fileName: fileName || "archivo.bin",
        caption: caption || "",
      };
    } else if (type === "image") {
      messagePayload = {
        image: mediaBuffer,
        caption: caption || "",
      };
    } else if (type === "audio") {
      messagePayload = {
        audio: mediaBuffer,
        mimetype: mimetype || "audio/mp4",
      };
    } else {
      return res.status(400).json({ error: "type inválido. Usa document|image|audio" });
    }

    await session.socket.sendMessage(jid, messagePayload);

    logger.info({ tenantId, phone, type }, "📎 Archivo enviado por API externa");
    res.json({ ok: true });
  } catch (e) {
    logger.error(e, "Error enviando media");
    res.status(500).json({ error: "Error enviando archivo: " + e.message });
  }
});

// ---------------------------------------------------------------------
// 12. API DE CONSULTA DE DISPONIBILIDAD
// ---------------------------------------------------------------------

app.get("/api/v1/availability", async (req, res) => {
  const { tenantId, resourceId, date } = req.query;

  if (!tenantId || !date) return res.status(400).json({ error: "Faltan tenantId y date" });

  const requestedDate = new Date(String(date));
  if (isNaN(requestedDate.getTime())) {
    return res.status(400).json({ error: "Formato de fecha inválido" });
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
// 13. API DE CREACIÓN DE CITA
// ---------------------------------------------------------------------

app.post("/api/v1/create-booking", async (req, res) => {
  const {
    tenantId,
    serviceId,
    resourceId,
    customerName,
    phone,
    startsAtISO,
    endsAtISO,
    notes,
    extraVariables,
  } = req.body || {};

  if (!tenantId || !phone || !startsAtISO || !endsAtISO) {
    return res.status(400).json({
      ok: false,
      error: "missing_fields",
      detail: "Requiere tenantId, phone, startsAtISO y endsAtISO. CustomerName es opcional.",
    });
  }

  const finalName = customerName || "Cliente Web";

  const { data: booking, error } = await supabase
    .from("bookings")
    .insert([
      {
        tenant_id: tenantId,
        service_id: serviceId || null,
        resource_id: resourceId || null,
        customer_name: finalName,
        customer_phone: phone,
        starts_at: startsAtISO,
        ends_at: endsAtISO,
        status: "confirmed",
        notes: notes || null,
      },
    ])
    .select("*")
    .maybeSingle();

  if (error) {
    logger.error(error, "Error creando booking");
    return res.status(500).json({ ok: false, error: "db_error" });
  }

  if (!booking) return res.status(500).json({ ok: false, error: "no_booking_created" });

  try {
    const session = await getOrCreateSession(tenantId);
    if (session && session.status === "connected") {
      const context = await getTenantContext(tenantId);

      const jid = String(phone).replace(/\D/g, "") + "@s.whatsapp.net";

      const startsDate = new Date(startsAtISO);
      const dateStr = startsDate.toISOString().slice(0, 10);
      const timeStr = startsDate.toTimeString().slice(0, 5);

      const templateBody = await getTemplate(tenantId, "booking_confirmed");

      const vars = {
        date: dateStr,
        time: timeStr,
        business_name: context.name,
        customer_name: finalName,
        resource_name: booking.resource_name || "",
        ...(extraVariables || {}),
      };

      if (templateBody) {
        const msg = renderTemplate(templateBody, vars);
        await session.socket.sendMessage(jid, { text: msg });
      }

      const icsBuffer = createICSFile(
        `Cita en ${context.name}`,
        `Tu cita está agendada para ${dateStr} a las ${timeStr}.`,
        "En el local",
        startsDate
      );

      await session.socket.sendMessage(jid, {
        document: icsBuffer,
        mimetype: "text/calendar; charset=utf-8",
        fileName: "cita_confirmada.ics",
        caption: "📅 Tu cita fue agendada. Toca este archivo para agregar el recordatorio a tu calendario.",
      });

      logger.info({ tenantId, bookingId: booking.id }, "✅ Booking creado y mensaje enviado");
    } else {
      logger.warn({ tenantId, bookingId: booking.id }, "Booking creado pero bot no conectado");
    }
  } catch (e) {
    logger.error(e, "Error enviando confirmación de creación de cita");
  }

  return res.json({
    ok: true,
    booking: {
      id: booking.id,
      starts_at: booking.starts_at,
      ends_at: booking.ends_at,
      status: booking.status,
    },
  });
});

// ---------------------------------------------------------------------
// 14. API DE REAGENDAMIENTO
// ---------------------------------------------------------------------

app.post("/api/v1/reschedule-booking", async (req, res) => {
  const { tenantId, bookingId, newStartsAtISO, newEndsAtISO, extraVariables } =
    req.body || {};

  if (!tenantId || !bookingId || !newStartsAtISO || !newEndsAtISO) {
    return res.status(400).json({
      ok: false,
      error: "missing_fields",
      detail: "Requiere tenantId, bookingId, newStartsAtISO y newEndsAtISO en el body.",
    });
  }

  const { data: updatedBooking, error } = await supabase
    .from("bookings")
    .update({
      starts_at: newStartsAtISO,
      ends_at: newEndsAtISO,
      status: "confirmed",
    })
    .eq("id", bookingId)
    .eq("tenant_id", tenantId)
    .select("*")
    .maybeSingle();

  if (error) {
    logger.error(error, "Error reagendando booking");
    return res.status(500).json({ ok: false, error: "db_error" });
  }

  if (!updatedBooking) {
    return res.status(404).json({ ok: false, error: "booking_not_found_or_not_owned" });
  }

  try {
    const session = await getOrCreateSession(tenantId);
    if (session && session.status === "connected") {
      const context = await getTenantContext(tenantId);

      const phone =
        updatedBooking.customer_phone ||
        updatedBooking.phone ||
        updatedBooking.client_phone ||
        null;

      if (phone) {
        const jid = String(phone).replace(/\D/g, "") + "@s.whatsapp.net";

        const startsDate = new Date(newStartsAtISO);
        const dateStr = startsDate.toISOString().slice(0, 10);
        const timeStr = startsDate.toTimeString().slice(0, 5);

        const templateBody = await getTemplate(tenantId, "booking_rescheduled");

        const vars = {
          date: dateStr,
          time: timeStr,
          business_name: context.name,
          customer_name: updatedBooking.customer_name || "",
          resource_name: updatedBooking.resource_name || "",
          ...(extraVariables || {}),
        };

        if (templateBody) {
          const msg = renderTemplate(templateBody, vars);
          await session.socket.sendMessage(jid, { text: msg });
        }

        const icsBuffer = createICSFile(
          `Cita reagendada en ${context.name}`,
          `Tu cita fue reagendada para ${dateStr} a las ${timeStr}.`,
          "En el local",
          startsDate
        );

        await session.socket.sendMessage(jid, {
          document: icsBuffer,
          mimetype: "text/calendar; charset=utf-8",
          fileName: "cita_reagendada.ics",
          caption: "📅 Tu cita fue reagendada. Toca este archivo para actualizar el recordatorio en tu calendario.",
        });

        logger.info({ tenantId, bookingId }, "✅ Booking reagendado y mensaje enviado");
      }
    }
  } catch (e) {
    logger.error(e, "Error enviando confirmación de reagendamiento");
  }

  return res.json({
    ok: true,
    booking: {
      id: updatedBooking.id,
      starts_at: updatedBooking.starts_at,
      ends_at: updatedBooking.ends_at,
      status: updatedBooking.status,
    },
  });
});

// ---------------------------------------------------------------------
// 15. API DE CANCELACIÓN
// ---------------------------------------------------------------------

app.post("/api/v1/cancel-booking", async (req, res) => {
  const { tenantId, bookingId, extraVariables } = req.body || {};

  if (!tenantId || !bookingId) {
    return res.status(400).json({
      ok: false,
      error: "missing_fields",
      detail: "Requiere tenantId y bookingId en el body.",
    });
  }

  const { data: cancelledBooking, error } = await supabase
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", bookingId)
    .eq("tenant_id", tenantId)
    .select("*")
    .maybeSingle();

  if (error) {
    logger.error(error, "Error cancelando booking");
    return res.status(500).json({ ok: false, error: "db_error" });
  }

  if (!cancelledBooking) {
    return res.status(404).json({ ok: false, error: "booking_not_found_or_not_owned" });
  }

  try {
    const session = await getOrCreateSession(tenantId);
    if (session && session.status === "connected") {
      const context = await getTenantContext(tenantId);

      const phone =
        cancelledBooking.customer_phone ||
        cancelledBooking.phone ||
        cancelledBooking.client_phone ||
        null;

      if (phone) {
        const jid = String(phone).replace(/\D/g, "") + "@s.whatsapp.net";

        const startsDate = new Date(cancelledBooking.starts_at);
        const dateStr = startsDate.toISOString().slice(0, 10);
        const timeStr = startsDate.toTimeString().slice(0, 5);

        const templateBody = await getTemplate(tenantId, "booking_cancelled");

        const vars = {
          date: dateStr,
          time: timeStr,
          business_name: context.name,
          customer_name: cancelledBooking.customer_name || "",
          resource_name: cancelledBooking.resource_name || "",
          ...(extraVariables || {}),
        };

        const msg = templateBody
          ? renderTemplate(templateBody, vars)
          : `Tu cita en ${context.name} para el ${dateStr} a las ${timeStr} ha sido cancelada exitosamente.`;

        await session.socket.sendMessage(jid, { text: msg });

        logger.info({ tenantId, bookingId }, "✅ Booking cancelado y mensaje enviado");
      }
    }
  } catch (e) {
    logger.error(e, "Error enviando confirmación de cancelación");
  }

  return res.json({
    ok: true,
    booking: { id: cancelledBooking.id, status: cancelledBooking.status },
  });
});

// ---------------------------------------------------------------------
// 16. AUTO-RECONEXIÓN (restoreSessions)
// ---------------------------------------------------------------------

async function restoreSessions() {
  try {
    logger.info("♻️ Restaurando sesiones de WhatsApp desde la base de datos...");

    const { data, error } = await supabase
      .from("whatsapp_sessions")
      .select("tenant_id, status")
      .in("status", ["connected", "qrcode", "connecting"]);

    if (error) {
      logger.error(error, "Error al cargar sesiones para restoreSessions");
      return;
    }

    if (!data || data.length === 0) {
      logger.info("No hay sesiones previas que restaurar.");
      return;
    }

    for (const row of data) {
      const tenantId = row.tenant_id;
      try {
        logger.info({ tenantId }, "🔄 Restaurando sesión previa...");
        await getOrCreateSession(tenantId);
        await updateSessionDB(tenantId, { last_seen_at: new Date().toISOString() });
      } catch (err) {
        logger.error({ tenantId, err }, "Error restaurando sesión de WhatsApp");
      }
    }
  } catch (e) {
    logger.error(e, "Fallo general en restoreSessions");
  }
}

// ---------------------------------------------------------------------
// 17. START SERVER
// ---------------------------------------------------------------------

app.listen(PORT, () => {
  logger.info(`🚀 WA server escuchando en puerto ${PORT}`);
  restoreSessions().catch((e) =>
    logger.error(e, "Error al intentar restaurar sesiones al inicio")
  );
});
