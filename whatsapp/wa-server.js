/**
 * whatsapp/wa-server.js (ACTUALIZADO)
 * ✅ FIX: disponibilidad y agendado 100% DB-driven (business_hours + bookings)
 * ✅ FIX: NO offset manual (SERVER_OFFSET_HOURS eliminado del cálculo)
 * ✅ FIX: timezone real (America/Santo_Domingo) aunque el server esté en UTC
 * ✅ FIX: create_booking valida business hours + colisiones + asigna barbero automático + turno + cupo diario
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

// Date-fns
const { addDays, startOfDay } = require("date-fns");

// 👇 estado de conversación en Supabase
const convoState = require("./conversationState");

// ---------------------------------------------------------------------
// CONFIGURACIÓN GLOBAL
// ---------------------------------------------------------------------

const app = express();
app.use(express.json());
const PORT = process.env.PORT || process.env.WA_SERVER_PORT || 4001;

// ⚠️ Ya NO se usa para ajustar horas (antes rompía todo).
// Lo dejamos por compatibilidad con tu config actual.
const SERVER_OFFSET_HOURS = 0;

// Timezone configurable (fallback RD)
const TIMEZONE_LOCALE = process.env.TIMEZONE_LOCALE || "America/Santo_Domingo";

// Turnos máximos por recurso por día
const MAX_TURNS_PER_RESOURCE_PER_DAY = Number(
  process.env.MAX_TURNS_PER_RESOURCE_PER_DAY || 10
);

// Duración default de cita
const DEFAULT_APPOINTMENT_MINUTES = Number(
  process.env.DEFAULT_APPOINTMENT_MINUTES || 60
);

// Step slots (min)
const SLOT_STEP_MINUTES = Number(process.env.SLOT_STEP_MINUTES || 30);

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
    "[wa-server] ⚠️ No hay API key de OpenAI configurada (OPENAI_API_KEY / OPENAI_KEY). " +
      "El fallback de IA no va a funcionar."
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

// =====================================================================
// 1. HELPERS: TZ ROBUSTO SIN LIBRERÍAS EXTRA
// =====================================================================

function pad2(n) {
  return n.toString().padStart(2, "0");
}

function toHHMM(t) {
  if (!t) return "";
  const parts = String(t).split(":");
  return `${pad2(Number(parts[0]))}:${pad2(Number(parts[1]))}`;
}

function hmsToParts(hms) {
  const [h, m] = String(hms).split(":").map(Number);
  return { h, m };
}

function getZonedParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = dtf.formatToParts(date);
  const pick = (type) => Number(parts.find((p) => p.type === type)?.value);

  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
  };
}

/**
 * Offset en minutos del timezone respecto a UTC en ese instante.
 * (localTimeAsUTC - actualUTC) / 60000
 */
function getTimeZoneOffsetMinutes(date, timeZone) {
  const p = getZonedParts(date, timeZone);
  const localAsUTC = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second
  );
  return (localAsUTC - date.getTime()) / 60000;
}

/**
 * Convierte un "local date-time" (componentes) en TZ a Date (UTC real).
 * Itera 2 veces por seguridad (DST). RD casi nunca cambia, pero lo dejamos robusto.
 */
function zonedDateTimeToUtc({ year, month, day, hour, minute, second }, timeZone) {
  const guessUTC = Date.UTC(year, month - 1, day, hour, minute, second || 0);
  const offset1 = getTimeZoneOffsetMinutes(new Date(guessUTC), timeZone);
  const utc1 = guessUTC - offset1 * 60000;

  const offset2 = getTimeZoneOffsetMinutes(new Date(utc1), timeZone);
  const utc2 = guessUTC - offset2 * 60000;

  return new Date(utc2);
}

/**
 * Parse flexible:
 * - "YYYY-MM-DD" => local midnight en TZ
 * - ISO datetime => Date normal
 */
function parseRequestedDate(input, timeZone) {
  const s = String(input || "").trim();
  if (!s) return new Date();

  // YYYY-MM-DD
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    return zonedDateTimeToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone);
  }

  // ISO / other
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;

  return new Date();
}

function formatSlotLabel(dateObj, timeZone) {
  // Ej: "jue, 18/12 10:30 AM"
  const parts = dateObj.toLocaleString("es-DO", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  return parts;
}

function startOfZonedDay(date, timeZone) {
  const p = getZonedParts(date, timeZone);
  return zonedDateTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0, second: 0 }, timeZone);
}

function endOfZonedDay(date, timeZone) {
  const p = getZonedParts(date, timeZone);
  // 23:59:59
  return zonedDateTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 23, minute: 59, second: 59 }, timeZone);
}

// =====================================================================
// 2. LÓGICA DE SCHEDULING (DB-driven)
// =====================================================================

function dayOpenWindow(dayDate, businessHours, timeZone) {
  // dayDate es un instante (Date) — calculamos dow del día en TZ
  const z = getZonedParts(dayDate, timeZone);
  // Creamos un "Date" equivalente a ese mediodía UTC para que getDay sea estable no depende del server tz.
  // Mejor: derivar dow usando Intl weekday en TZ.
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(dayDate);
  // Map en-US: Sun, Mon, Tue...
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = map[weekday] ?? new Date(dayDate).getDay();

  const cfg = businessHours.find((bh) => bh.dow === dow && bh.is_closed === false);

  if (!cfg || !cfg.open_time || !cfg.close_time) return null;

  const { h: openH, m: openM } = hmsToParts(toHHMM(cfg.open_time));
  const { h: closeH, m: closeM } = hmsToParts(toHHMM(cfg.close_time));

  const start = zonedDateTimeToUtc(
    { year: z.year, month: z.month, day: z.day, hour: openH, minute: openM, second: 0 },
    timeZone
  );
  const end = zonedDateTimeToUtc(
    { year: z.year, month: z.month, day: z.day, hour: closeH, minute: closeM, second: 0 },
    timeZone
  );

  if (end <= start) return null;
  return { start, end };
}

function generateOfferableSlots(openWindow, bookings, stepMin = 30) {
  if (!openWindow) return [];
  const slots = [];

  let cursor = new Date(openWindow.start);
  const windowEnd = new Date(openWindow.end);

  while (cursor.getTime() < windowEnd.getTime()) {
    const slotEnd = new Date(cursor);
    slotEnd.setMinutes(slotEnd.getMinutes() + stepMin);

    if (slotEnd.getTime() > windowEnd.getTime()) break;

    const isBusy = (bookings || []).some((b) => {
      const busyStart = new Date(b.starts_at);
      const busyEnd = new Date(b.ends_at);
      return cursor.getTime() < busyEnd.getTime() && slotEnd.getTime() > busyStart.getTime();
    });

    if (!isBusy) {
      slots.push({ start: new Date(cursor), end: slotEnd });
    }

    cursor.setMinutes(cursor.getMinutes() + stepMin);
  }

  return slots;
}

async function getBusinessHours(tenantId) {
  const { data, error } = await supabase
    .from("business_hours")
    .select("dow, is_closed, open_time, close_time")
    .eq("tenant_id", tenantId);

  if (error) {
    logger.error(error, "[getBusinessHours] error");
    return [];
  }
  return data || [];
}

/**
 * Devuelve slots desde requestedDate hacia adelante (daysToLookAhead),
 * correctamente por día, respetando business_hours + bookings reales.
 */
async function getAvailableSlots(tenantId, resourceId, requestedDate, daysToLookAhead = 7) {
  if (!tenantId) return [];

  const tz = TIMEZONE_LOCALE;

  const base = requestedDate instanceof Date ? requestedDate : parseRequestedDate(requestedDate, tz);

  const rangeStart = base;
  const rangeEnd = addDays(base, daysToLookAhead);

  const hours = await getBusinessHours(tenantId);

  // Traemos bookings del rango completo 1 vez
  const startISO = rangeStart.toISOString();
  const endISO = rangeEnd.toISOString();

  let q = supabase
    .from("bookings")
    .select("starts_at, ends_at, resource_id, status")
    .eq("tenant_id", tenantId)
    .gte("starts_at", startISO)
    .lt("starts_at", endISO)
    .in("status", ["confirmed", "pending"]);

  if (resourceId) q = q.eq("resource_id", resourceId);

  const { data: bookings, error } = await q;
  if (error) {
    logger.error(error, "[getAvailableSlots] bookings query error");
  }

  const all = [];
  for (let i = 0; i < daysToLookAhead; i++) {
    const day = addDays(base, i);
    const win = dayOpenWindow(day, hours, tz);
    if (!win) continue;

    // bookings del día
    const dayStart = startOfZonedDay(day, tz).getTime();
    const dayEnd = endOfZonedDay(day, tz).getTime();

    const dayBookings = (bookings || []).filter((b) => {
      const bs = new Date(b.starts_at).getTime();
      return bs >= dayStart && bs <= dayEnd;
    });

    const slots = generateOfferableSlots(win, dayBookings, SLOT_STEP_MINUTES);
    all.push(...slots);
  }

  // Solo slots >= requestedDate
  return all.filter((s) => s.start.getTime() >= base.getTime());
}

/**
 * Valida que un slot esté dentro del horario del negocio ese día.
 */
async function validateWithinBusinessHours(tenantId, startDate, endDate) {
  const tz = TIMEZONE_LOCALE;
  const hours = await getBusinessHours(tenantId);
  const win = dayOpenWindow(startDate, hours, tz);
  if (!win) return { ok: false, reason: "closed_day" };

  if (startDate.getTime() < win.start.getTime() || endDate.getTime() > win.end.getTime()) {
    return { ok: false, reason: "outside_business_hours" };
  }
  return { ok: true };
}

/**
 * Asigna el recurso (barbero) automáticamente:
 * - debe estar activo
 * - no debe estar ocupado en ese slot
 * - no debe superar MAX_TURNS_PER_RESOURCE_PER_DAY
 * - elige el de menor carga (menos bookings ese día)
 */
async function chooseResourceForSlot(tenantId, startDate, endDate) {
  const tz = TIMEZONE_LOCALE;

  const { data: resources, error: rErr } = await supabase
    .from("resources")
    .select("id, name, is_active")
    .eq("tenant_id", tenantId)
    .eq("is_active", true);

  if (rErr) {
    logger.error(rErr, "[chooseResourceForSlot] resources query error");
    return { ok: false, reason: "resources_query_error" };
  }

  const active = (resources || []).filter((r) => r.is_active);
  if (active.length === 0) {
    return { ok: false, reason: "no_active_resources" };
  }

  // bookings del día para todos los recursos
  const dayStart = startOfZonedDay(startDate, tz).toISOString();
  const dayEnd = endOfZonedDay(startDate, tz).toISOString();

  const { data: dayBookings, error: bErr } = await supabase
    .from("bookings")
    .select("id, resource_id, starts_at, ends_at, status")
    .eq("tenant_id", tenantId)
    .gte("starts_at", dayStart)
    .lte("starts_at", dayEnd)
    .in("status", ["confirmed", "pending"]);

  if (bErr) {
    logger.error(bErr, "[chooseResourceForSlot] bookings query error");
    return { ok: false, reason: "bookings_query_error" };
  }

  // Pre-cálculos por recurso
  const byResource = new Map();
  for (const r of active) byResource.set(r.id, []);

  for (const b of dayBookings || []) {
    if (b.resource_id && byResource.has(b.resource_id)) {
      byResource.get(b.resource_id).push(b);
    }
  }

  const candidates = [];
  for (const r of active) {
    const list = byResource.get(r.id) || [];
    const count = list.length;

    if (count >= MAX_TURNS_PER_RESOURCE_PER_DAY) continue;

    const busy = list.some((b) => {
      const bs = new Date(b.starts_at).getTime();
      const be = new Date(b.ends_at).getTime();
      return startDate.getTime() < be && endDate.getTime() > bs;
    });

    if (!busy) {
      candidates.push({
        id: r.id,
        name: r.name || "Barbero",
        count,
      });
    }
  }

  if (candidates.length === 0) {
    return { ok: false, reason: "no_resource_available" };
  }

  // menor carga
  candidates.sort((a, b) => a.count - b.count);

  const chosen = candidates[0];
  return {
    ok: true,
    resourceId: chosen.id,
    resourceName: chosen.name,
    turno: chosen.count + 1,
  };
}

// =====================================================================
// 3. HELPERS: CALENDARIO Y ARCHIVOS (.ICS)
// =====================================================================

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

  return Buffer.from(icsData);
}

// =====================================================================
// 4. CONTEXTO / TEMPLATES
// =====================================================================

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

// =====================================================================
// 5. INTENT_KEYWORDS ENGINE
// =====================================================================

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
      ) {
        continue;
      }

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

// =====================================================================
// 6. DEFINICIÓN DE TOOLS (OpenAI)
// =====================================================================

const tools = [
  {
    type: "function",
    function: {
      name: "check_availability",
      description:
        "Consulta disponibilidad. Úsalo para ver huecos libres para citas o reservas.",
      parameters: {
        type: "object",
        properties: {
          requestedDate: { type: "string", description: "Fecha ISO base." },
        },
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
          customerPhone: {
            type: "string",
            description: "Teléfono del cliente (WhatsApp).",
          },
          newStartsAtISO: {
            type: "string",
            description: "Nueva fecha/hora inicio en formato ISO 8601.",
          },
          newEndsAtISO: {
            type: "string",
            description:
              "Nueva fecha/hora fin en formato ISO 8601. Opcional; si no se envía se asume 1 hora.",
          },
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
          customerPhone: {
            type: "string",
            description: "Teléfono del cliente (WhatsApp).",
          },
        },
        required: ["customerPhone"],
      },
    },
  },
];

// =====================================================================
// 7. IA CON CEREBRO DINÁMICO (Lee la DB para saber qué ser)
// =====================================================================

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

  const tz = TIMEZONE_LOCALE;
  const now = new Date();
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
        "Eres el asistente de una barbería. Agenda citas. Si no especifican barbero, agenda con cualquiera disponible.";
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
1) Agendar es prioridad: si hay hueco, agenda.
2) Catálogo/Precios: si preguntan precios/menú, usa get_catalog.
3) Si faltan datos: no te bloquees, usa notes.
4) Soporte humano: human_handoff.
5) check_availability devuelve slots con index/label/isoStart/isoEnd. Muestra label y pide número.
6) Si el cliente dice "la 3" o "opción 2", interpreta como slot index (NO catálogo).
7) Si el cliente confirma una hora propuesta, crea booking.
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

        // A) CONSULTAR DISPONIBILIDAD
        if (fnName === "check_availability") {
          const baseDate = parseRequestedDate(args.requestedDate, tz);

          const rawSlots = await getAvailableSlots(tenantId, null, baseDate, 7);
          const sortedSlots = (rawSlots || []).sort((a, b) => a.start - b.start);

          if (sortedSlots.length > 0) {
            const slotObjects = sortedSlots.slice(0, 12).map((s, i) => ({
              index: i + 1,
              label: `${i + 1}) ${formatSlotLabel(s.start, tz)}`,
              isoStart: s.start.toISOString(),
              isoEnd: s.end.toISOString(),
            }));

            response = JSON.stringify({
              message:
                "Horarios disponibles. El cliente elige por número. Para agendar usa isoStart/isoEnd del slot.",
              slots: slotObjects,
              plain_list: slotObjects.map((x) => x.label).join("\n"),
            });
          } else {
            response = JSON.stringify({
              message:
                "No hay horarios disponibles desde esa fecha. Pide otro día.",
              slots: [],
            });
          }
        }

        // B) CONSULTAR CATÁLOGO
        else if (fnName === "get_catalog") {
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
                "El catálogo está vacío. Responde con las reglas del negocio o sugiere soporte humano.",
            });
          }
        }

        // C) CREAR CITA / RESERVA (FIX REAL)
        else if (fnName === "create_booking") {
          const phoneArg = args.phone || userPhone;
          const startsISO = args.startsAtISO;

          if (!phoneArg || !startsISO) {
            response = JSON.stringify({
              success: false,
              error: "missing_phone_or_start",
            });
          } else {
            const start = new Date(startsISO);
            if (isNaN(start.getTime())) {
              response = JSON.stringify({ success: false, error: "invalid_startsAtISO" });
            } else {
              const end = args.endsAtISO
                ? new Date(args.endsAtISO)
                : new Date(start.getTime() + DEFAULT_APPOINTMENT_MINUTES * 60000);

              if (isNaN(end.getTime()) || end <= start) {
                response = JSON.stringify({ success: false, error: "invalid_endsAtISO" });
              } else {
                // 1) Validar horario negocio
                const within = await validateWithinBusinessHours(tenantId, start, end);
                if (!within.ok) {
                  response = JSON.stringify({
                    success: false,
                    error: within.reason,
                    message:
                      within.reason === "closed_day"
                        ? "El negocio está cerrado ese día."
                        : "Ese horario está fuera del horario laboral.",
                  });
                } else {
                  // 2) Asignar barbero automático
                  const chosen = await chooseResourceForSlot(tenantId, start, end);
                  if (!chosen.ok) {
                    response = JSON.stringify({
                      success: false,
                      error: chosen.reason,
                      message:
                        chosen.reason === "no_resource_available"
                          ? "No hay barberos disponibles en ese horario."
                          : "No pude asignar un barbero ahora mismo.",
                    });
                  } else {
                    // 3) Doble-check colisión con ese resource (por seguridad)
                    const { data: collision, error: cErr } = await supabase
                      .from("bookings")
                      .select("id")
                      .eq("tenant_id", tenantId)
                      .eq("resource_id", chosen.resourceId)
                      .lt("starts_at", end.toISOString())
                      .gt("ends_at", start.toISOString())
                      .in("status", ["confirmed", "pending"])
                      .maybeSingle();

                    if (cErr) logger.error(cErr, "[create_booking] collision check error");

                    if (collision) {
                      response = JSON.stringify({
                        success: false,
                        error: "slot_busy",
                        message: "Ese horario ya fue ocupado. Elige otro.",
                      });
                    } else {
                      // 4) Guardar booking REAL
                      const noteFinal = [
                        args.notes || "Agendado por Bot",
                        `Turno #${chosen.turno}`,
                        `Recurso: ${chosen.resourceName}`,
                      ]
                        .filter(Boolean)
                        .join(" | ");

                      const { data: booking, error } = await supabase
                        .from("bookings")
                        .insert([
                          {
                            tenant_id: tenantId,
                            resource_id: chosen.resourceId,
                            service_id: args.serviceId || null,
                            customer_name: args.customerName || pushName,
                            customer_phone: phoneArg,
                            starts_at: start.toISOString(),
                            ends_at: end.toISOString(),
                            status: "confirmed",
                            notes: noteFinal,
                          },
                        ])
                        .select("id, starts_at, ends_at, resource_id")
                        .single();

                      if (!error && booking) {
                        response = JSON.stringify({
                          success: true,
                          bookingId: booking.id,
                          turno: chosen.turno,
                          barbero: chosen.resourceName,
                          message: "Reserva/Cita creada exitosamente en el sistema.",
                        });
                      } else {
                        response = JSON.stringify({
                          success: false,
                          error: "db_insert_error",
                          detail: error?.message || "desconocido",
                        });
                      }
                    }
                  }
                }
              }
            }
          }
        }

        // D) PASAR A HUMANO
        else if (fnName === "human_handoff") {
          const { data: profile2 } = await supabase
            .from("business_profiles")
            .select("human_handoff_phone")
            .eq("tenant_id", tenantId)
            .maybeSingle();

          const humanPhone = profile2?.human_handoff_phone || null;

          if (humanPhone) {
            const clean = humanPhone.replace(/\D/g, "");
            response = JSON.stringify({
              message: `Puedes escribir directamente a nuestro encargado aquí: https://wa.me/${clean}`,
            });
          } else {
            response = JSON.stringify({
              message:
                "Ahora mismo no tengo un número de contacto directo configurado. Déjame tu mensaje y te contactamos.",
            });
          }
        }

        // E) REAGENDAR (mejorado: valida horario + colisión + reasigna barbero si hace falta)
        else if (fnName === "reschedule_booking") {
          const phoneFilter = args.customerPhone || args.phone || userPhone || null;

          if (!phoneFilter) {
            response = JSON.stringify({ success: false, error: "missing_phone" });
          } else {
            const { data: booking } = await supabase
              .from("bookings")
              .select("id, resource_id")
              .eq("tenant_id", tenantId)
              .eq("customer_phone", phoneFilter)
              .in("status", ["confirmed", "pending"])
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();

            if (!booking) {
              response = JSON.stringify({
                success: false,
                error: "no_active_booking",
                message: "No encontré ninguna cita activa con ese número.",
              });
            } else {
              const newStart = new Date(args.newStartsAtISO);
              const newEnd = args.newEndsAtISO
                ? new Date(args.newEndsAtISO)
                : new Date(newStart.getTime() + DEFAULT_APPOINTMENT_MINUTES * 60000);

              const within = await validateWithinBusinessHours(tenantId, newStart, newEnd);
              if (!within.ok) {
                response = JSON.stringify({
                  success: false,
                  error: within.reason,
                  message: "Ese horario no está dentro del horario laboral.",
                });
              } else {
                // si el recurso actual está ocupado, reasignamos
                let resourceId = booking.resource_id || null;
                let chosen = null;

                if (resourceId) {
                  const { data: collision } = await supabase
                    .from("bookings")
                    .select("id")
                    .eq("tenant_id", tenantId)
                    .eq("resource_id", resourceId)
                    .neq("id", booking.id)
                    .lt("starts_at", newEnd.toISOString())
                    .gt("ends_at", newStart.toISOString())
                    .in("status", ["confirmed", "pending"])
                    .maybeSingle();

                  if (collision) resourceId = null;
                }

                if (!resourceId) {
                  chosen = await chooseResourceForSlot(tenantId, newStart, newEnd);
                  if (!chosen.ok) {
                    response = JSON.stringify({
                      success: false,
                      error: chosen.reason,
                      message: "No hay barbero disponible para reagendar en ese horario.",
                    });
                    resourceId = null;
                  } else {
                    resourceId = chosen.resourceId;
                  }
                }

                if (resourceId) {
                  const { error } = await supabase
                    .from("bookings")
                    .update({
                      starts_at: newStart.toISOString(),
                      ends_at: newEnd.toISOString(),
                      resource_id: resourceId,
                      status: "confirmed",
                    })
                    .eq("id", booking.id);

                  if (!error) {
                    response = JSON.stringify({
                      success: true,
                      message: "Cita reagendada correctamente.",
                      resource_id: resourceId,
                    });
                  } else {
                    response = JSON.stringify({
                      success: false,
                      error: "db_update_error",
                      detail: error.message,
                    });
                  }
                }
              }
            }
          }
        }

        // F) CANCELAR (igual)
        else if (fnName === "cancel_booking") {
          const phoneFilter = args.customerPhone || args.phone || userPhone || null;

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
                  error: "db_update_error",
                  detail: error.message,
                });
              }
            } else {
              response = JSON.stringify({
                success: false,
                error: "no_active_booking",
                message: "No encontré ninguna cita activa para cancelar.",
              });
            }
          }
        }

        else {
          response = JSON.stringify({ ok: false, error: "unknown_tool" });
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

// =====================================================================
// 8. ACTUALIZAR ESTADO DB (whatsapp_sessions + tenants.wa_connected)
// =====================================================================

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
      const { error: insertError } = await supabase.from("whatsapp_sessions").insert([row]);
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

// =====================================================================
// 9. HELPERS NUEVOS: customers + eventos de booking
// =====================================================================

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
    if (
      lower.includes("cita") ||
      lower.includes("agendar") ||
      lower.includes("agenda") ||
      lower.includes("corte") ||
      lower.includes("barba")
    ) {
      return { type: "START_BOOKING" };
    }
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
      const tz = TIMEZONE_LOCALE;
      const now = new Date();
      const todayParts = getZonedParts(now, tz);
      let target = zonedDateTimeToUtc(
        { year: todayParts.year, month: todayParts.month, day: todayParts.day, hour: 0, minute: 0, second: 0 },
        tz
      );

      const isTomorrow = lower.includes("mañana") || lower.includes("manana");
      if (isTomorrow) target = addDays(target, 1);

      const ymd = getZonedParts(target, tz);
      const targetDate = `${ymd.year}-${pad2(ymd.month)}-${pad2(ymd.day)}`;

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

// =====================================================================
// 10. AUTH STATE MONOLÍTICO (Baileys)
// =====================================================================

async function useSupabaseAuthState(tenantId) {
  if (!tenantId) throw new Error("useSupabaseAuthState requiere tenantId");

  const { useMultiFileAuthState } = await import("@whiskeysockets/baileys");

  const sessionFolder = path.join(WA_SESSIONS_ROOT, String(tenantId));
  if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  return { state, saveCreds };
}

// =====================================================================
// 11. CORE WHATSAPP (Baileys + integración bot Next)
// =====================================================================

async function getOrCreateSession(tenantId) {
  const existing = sessions.get(tenantId);
  if (existing && existing.socket) return existing;

  logger.info({ tenantId }, "🔌 Iniciando Socket...");

  const { default: makeWASocket, DisconnectReason } = await import("@whiskeysockets/baileys");
  const { state, saveCreds } = await useSupabaseAuthState(tenantId);

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
        logger.info({ tenantId }, "🔄 Conexión perdida, reconectando...");
        getOrCreateSession(tenantId);
      } else {
        sessions.delete(tenantId);
        await updateSessionDB(tenantId, { status: "disconnected", qr_data: null });
        logger.info({ tenantId }, "❌ Sesión cerrada permanentemente (Logout).");
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages?.[0];
      if (!msg) return;

      logger.info({ tenantId, key: msg.key }, "[wa-server] 📩 messages.upsert recibido");

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

      // Memoria RAM para fallback OpenAI
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

      // URL del bot Next
      const botApiUrl = "https://bot-suite.onrender.com/api/whatsapp-bot";

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
          logger.info({ tenantId, url: botApiUrl }, "[wa-server] Llamando a /api/whatsapp-bot");
          const response = await axios.post(botApiUrl, payload, { timeout: 60000 });

          if (response.data && response.data.ok) {
            replyText = response.data.reply;
            newState = response.data.newState;
            icsData = response.data.icsData;
          } else {
            logger.error("[wa-server] Respuesta no OK de /api/whatsapp-bot:", response.data);
          }
        } catch (err) {
          logger.error(
            "[wa-server] Error al llamar a /api/whatsapp-bot:",
            err?.response?.data || err.message
          );
        }
      }

      // Fallback OpenAI tools
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

      // Update conversation_sessions
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

      // Send message
      await sock.sendMessage(remoteJid, { text: replyText });

      // Send ICS if present
      if (icsData) {
        const icsBuffer = Buffer.from(icsData);
        await sock.sendMessage(remoteJid, {
          document: icsBuffer,
          mimetype: "text/calendar",
          fileName: "cita_confirmada.ics",
          caption: "📅 Toca aquí para guardar en tu calendario",
        });
      }

      // Save history
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

// =====================================================================
// 12. API ROUTES BÁSICAS
// =====================================================================

app.get("/health", (req, res) => res.json({ ok: true, active_sessions: sessions.size }));

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

app.post("/sessions/:tenantId/connect", async (req, res) => {
  const tenantId = req.params.tenantId;

  try {
    const info = await getOrCreateSession(tenantId);
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

// =====================================================================
// 13. ENDPOINT: Enviar plantilla + archivo ICS
// =====================================================================

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
          mimetype: "text/calendar",
          fileName: "agendar_cita.ics",
          caption: "📅 Toca este archivo para agregar el recordatorio a tu calendario.",
        });
      }
    }

    res.json({ ok: true, message });
  } catch (e) {
    logger.error(e, "Fallo enviando mensaje");
    res.status(500).json({ error: "Error envío" });
  }
});

// =====================================================================
// 14. ENDPOINT: Enviar Media (document/image/audio) desde Next.js
// =====================================================================

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
      messagePayload = { image: mediaBuffer, caption: caption || "" };
    } else if (type === "audio") {
      messagePayload = { audio: mediaBuffer, mimetype: mimetype || "audio/mp4" };
    }

    await session.socket.sendMessage(jid, messagePayload);
    res.json({ ok: true });
  } catch (e) {
    logger.error(e, "Error enviando media");
    res.status(500).json({ error: "Error enviando archivo: " + e.message });
  }
});

// =====================================================================
// 15. API DE CONSULTA DE DISPONIBILIDAD (FIX TZ)
// =====================================================================

app.get("/api/v1/availability", async (req, res) => {
  const { tenantId, resourceId, date } = req.query;

  if (!tenantId || !date) {
    return res.status(400).json({ error: "Faltan tenantId y date" });
  }

  const requestedDate = parseRequestedDate(String(date), TIMEZONE_LOCALE);
  if (isNaN(requestedDate.getTime())) {
    return res.status(400).json({ error: "Formato de fecha inválido" });
  }

  const slots = await getAvailableSlots(
    String(tenantId),
    resourceId ? String(resourceId) : null,
    requestedDate,
    7
  );

  const sorted = (slots || []).sort((a, b) => a.start - b.start);
  const formattedSlots = sorted.map((s) => formatSlotLabel(s.start, TIMEZONE_LOCALE));

  res.json({
    ok: true,
    available_slots_count: sorted.length,
    available_slots: formattedSlots.slice(0, 40),
  });
});

// =====================================================================
// 16. API DE CREACIÓN DE CITA (FIX REAL: valida + asigna recurso)
// =====================================================================

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

  if (!tenantId || !phone || !startsAtISO) {
    return res.status(400).json({
      ok: false,
      error: "missing_fields",
      detail: "Requiere tenantId, phone, startsAtISO. endsAtISO opcional.",
    });
  }

  const start = new Date(startsAtISO);
  const end = endsAtISO
    ? new Date(endsAtISO)
    : new Date(start.getTime() + DEFAULT_APPOINTMENT_MINUTES * 60000);

  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
    return res.status(400).json({ ok: false, error: "invalid_dates" });
  }

  const within = await validateWithinBusinessHours(tenantId, start, end);
  if (!within.ok) {
    return res.status(400).json({
      ok: false,
      error: within.reason,
      message: within.reason === "closed_day" ? "Negocio cerrado ese día" : "Fuera de horario laboral",
    });
  }

  let finalResourceId = resourceId || null;
  let chosen = null;

  if (!finalResourceId) {
    chosen = await chooseResourceForSlot(tenantId, start, end);
    if (!chosen.ok) {
      return res.status(409).json({
        ok: false,
        error: chosen.reason,
        message: "No hay recurso disponible para ese horario.",
      });
    }
    finalResourceId = chosen.resourceId;
  }

  // colisión final
  const { data: collision } = await supabase
    .from("bookings")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("resource_id", finalResourceId)
    .lt("starts_at", end.toISOString())
    .gt("ends_at", start.toISOString())
    .in("status", ["confirmed", "pending"])
    .maybeSingle();

  if (collision) {
    return res.status(409).json({ ok: false, error: "slot_busy" });
  }

  const finalName = customerName || "Cliente Web";

  const noteFinal = [
    notes || "Agendado por API",
    chosen?.turno ? `Turno #${chosen.turno}` : null,
    chosen?.resourceName ? `Recurso: ${chosen.resourceName}` : null,
  ].filter(Boolean).join(" | ");

  const { data: booking, error } = await supabase
    .from("bookings")
    .insert([
      {
        tenant_id: tenantId,
        service_id: serviceId || null,
        resource_id: finalResourceId,
        customer_name: finalName,
        customer_phone: phone,
        starts_at: start.toISOString(),
        ends_at: end.toISOString(),
        status: "confirmed",
        notes: noteFinal || null,
      },
    ])
    .select("*")
    .maybeSingle();

  if (error) {
    logger.error(error, "Error creando booking");
    return res.status(500).json({ ok: false, error: "db_error" });
  }

  if (!booking) {
    return res.status(500).json({ ok: false, error: "no_booking_created" });
  }

  // Notificación + ICS
  try {
    const session = await getOrCreateSession(tenantId);
    if (session && session.status === "connected") {
      const context = await getTenantContext(tenantId);
      const jid = String(phone).replace(/\D/g, "") + "@s.whatsapp.net";

      const tz = TIMEZONE_LOCALE;
      const dateStr = start.toLocaleDateString("es-DO", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
      const timeStr = start.toLocaleTimeString("es-DO", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: true });

      const templateBody = await getTemplate(tenantId, "booking_confirmed");

      const vars = {
        date: dateStr,
        time: timeStr,
        business_name: context.name,
        customer_name: finalName,
        resource_name: chosen?.resourceName || booking.resource_name || "",
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
        start
      );

      await session.socket.sendMessage(jid, {
        document: icsBuffer,
        mimetype: "text/calendar",
        fileName: "cita_confirmada.ics",
        caption: "📅 Tu cita fue agendada. Toca este archivo para agregar el recordatorio a tu calendario.",
      });
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
      resource_id: booking.resource_id,
    },
  });
});

// =====================================================================
// 17. API DE REAGENDAMIENTO / CANCELACIÓN (se quedan igual que las tuyas)
// =====================================================================

app.post("/api/v1/reschedule-booking", async (req, res) => {
  const { tenantId, bookingId, newStartsAtISO, newEndsAtISO, extraVariables } = req.body || {};

  if (!tenantId || !bookingId || !newStartsAtISO) {
    return res.status(400).json({
      ok: false,
      error: "missing_fields",
      detail: "Requiere tenantId, bookingId, newStartsAtISO (newEndsAtISO opcional).",
    });
  }

  const newStart = new Date(newStartsAtISO);
  const newEnd = newEndsAtISO
    ? new Date(newEndsAtISO)
    : new Date(newStart.getTime() + DEFAULT_APPOINTMENT_MINUTES * 60000);

  const within = await validateWithinBusinessHours(tenantId, newStart, newEnd);
  if (!within.ok) {
    return res.status(400).json({
      ok: false,
      error: within.reason,
      message: "Ese horario no está dentro del horario laboral.",
    });
  }

  const { data: updatedBooking, error } = await supabase
    .from("bookings")
    .update({ starts_at: newStart.toISOString(), ends_at: newEnd.toISOString(), status: "confirmed" })
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

  // Notificación opcional (igual que tu lógica; la dejamos)
  res.json({
    ok: true,
    booking: {
      id: updatedBooking.id,
      starts_at: updatedBooking.starts_at,
      ends_at: updatedBooking.ends_at,
      status: updatedBooking.status,
    },
  });
});

app.post("/api/v1/cancel-booking", async (req, res) => {
  const { tenantId, bookingId } = req.body || {};

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

  res.json({ ok: true, booking: { id: cancelledBooking.id, status: cancelledBooking.status } });
});

// =====================================================================
// 18. AUTO-RECONEXIÓN (restoreSessions)
// =====================================================================

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

// =====================================================================
// 19. START SERVER
// =====================================================================

app.listen(PORT, () => {
  logger.info(`🚀 WA server escuchando en puerto ${PORT}`);
  restoreSessions().catch((e) => logger.error(e, "Error al restaurar sesiones al inicio"));
});
