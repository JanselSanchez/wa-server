/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { tool } from "ai";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseKey) throw new Error("Faltan credenciales Supabase");
const supabase = createClient(supabaseUrl, supabaseKey);

// --- HELPERS (PRODUCCIÓN) ---

function normalizePhone(raw: string) {
  return String(raw || "").replace(/[^\d]/g, "");
}

function toISODateOnly(d: Date) {
  // YYYY-MM-DD en hora local (server). Para comparar strings.
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function safeToNumber(v: any, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function escapeICS(text: string) {
  // RFC5545 basic escaping
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

// --- HELPER: GENERADOR DE ICS ---
function generateICSContent(
  id: string,
  title: string,
  description: string,
  startISO: string,
  endISO: string
) {
  const formatDateICS = (d: Date) =>
    d
      .toISOString()
      .replace(/[-:]/g, "")
      .split(".")[0] + "Z";

  const now = new Date();
  const start = new Date(startISO);
  const end = new Date(endISO);

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//PymeBot//Agenda//ES",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeICS(id)}@pymebot.app`,
    `DTSTAMP:${formatDateICS(now)}`,
    `DTSTART:${formatDateICS(start)}`,
    `DTEND:${formatDateICS(end)}`,
    `SUMMARY:${escapeICS(title)}`,
    `DESCRIPTION:${escapeICS(description)}`,
    "STATUS:CONFIRMED",
    "BEGIN:VALARM",
    "TRIGGER:-PT30M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeICS("Recordatorio")}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

// --- TOOLS ---

// 1. DISPONIBILIDAD
export const checkAvailabilityTool = tool({
  description: "Consulta horarios disponibles.",
  parameters: z.object({
    tenantId: z.string(),
    requestedDate: z.string().describe("Fecha YYYY-MM-DD"),
  }),
  execute: async (input: any) => {
    const tenantId = String(input?.tenantId || "").trim();
    const requestedDate = String(input?.requestedDate || "").trim();

    try {
      if (!tenantId || !requestedDate) {
        return { available: false, message: "Faltan datos (tenantId, requestedDate)." };
      }

      // Parse robusto de YYYY-MM-DD evitando timezone raros
      const parts = requestedDate.split("-");
      if (parts.length !== 3) return { available: false, message: "requestedDate inválida. Usa YYYY-MM-DD." };

      const y = safeToNumber(parts[0], 0);
      const m = safeToNumber(parts[1], 0);
      const d = safeToNumber(parts[2], 0);
      if (!y || !m || !d) return { available: false, message: "requestedDate inválida. Usa YYYY-MM-DD." };

      const date = new Date(y, m - 1, d, 12, 0, 0, 0); // noon para evitar DST edge
      const dayOfWeek = date.getDay();

      const { data: hours, error: hoursErr } = await supabase
        .from("business_hours")
        .select("open_time, close_time, is_closed")
        .eq("tenant_id", tenantId)
        .eq("dow", dayOfWeek)
        .maybeSingle();

      if (hoursErr) {
        return { available: false, message: "Error leyendo business_hours: " + hoursErr.message };
      }

      if (!hours || hours.is_closed) return { available: false, message: "Cerrado ese día." };

      // Ventana del día
      const startOfDay = new Date(y, m - 1, d, 0, 0, 0, 0);
      const endOfDay = new Date(y, m - 1, d, 23, 59, 59, 999);

      const { data: bookings, error: bookingsErr } = await supabase
        .from("bookings")
        .select("starts_at, ends_at")
        .eq("tenant_id", tenantId)
        .in("status", ["confirmed", "pending"])
        .gte("starts_at", startOfDay.toISOString())
        .lte("ends_at", endOfDay.toISOString());

      if (bookingsErr) {
        return { available: false, message: "Error leyendo bookings: " + bookingsErr.message };
      }

      const slots: any[] = [];
      const [openH, openM] = String(hours.open_time).split(":").map((n: string) => safeToNumber(n, 0));
      const [closeH, closeM] = String(hours.close_time).split(":").map((n: string) => safeToNumber(n, 0));

      let cursor = new Date(y, m - 1, d, openH, openM, 0, 0);
      const closeTime = new Date(y, m - 1, d, closeH, closeM, 0, 0);

      // Sanidad
      if (!(cursor < closeTime)) return { available: false, message: "Horario inválido en business_hours." };

      // Slots: 30 min step, 60 min duration
      while (cursor < closeTime) {
        const slotEnd = new Date(cursor.getTime() + 60 * 60000);

        const isBusy = (bookings || []).some((b: any) => {
          const bStart = new Date(b.starts_at);
          const bEnd = new Date(b.ends_at);
          return cursor < bEnd && slotEnd > bStart;
        });

        if (!isBusy) {
          slots.push({
            label: cursor.toLocaleTimeString("es-DO", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: true,
            }),
            iso: cursor.toISOString(),
          });
        }

        cursor.setMinutes(cursor.getMinutes() + 30);
      }

      return { available: true, slots: slots.slice(0, 15) };
    } catch (e: any) {
      return { available: false, message: "Error verificando: " + (e?.message || "unknown") };
    }
  },
} as any);

// 2. BUSCAR SERVICIOS
export const getServicesTool = tool({
  description: "Busca servicios y precios.",
  parameters: z.object({
    tenantId: z.string(),
  }),
  execute: async (input: any) => {
    const tenantId = String(input?.tenantId || "").trim();
    try {
      if (!tenantId) return { services: [] };

      const { data, error } = await supabase
        .from("items")
        .select("id, name, price_cents")
        .eq("tenant_id", tenantId)
        .eq("is_active", true)
        .order("name", { ascending: true })
        .limit(10);

      if (error) return { services: [], error: error.message };

      const services =
        data?.map((i: any) => ({
          id: i.id,
          name: i.name,
          price: safeToNumber(i.price_cents, 0) / 100,
        })) || [];

      return { services };
    } catch (e: any) {
      return { services: [], error: e?.message || "unknown" };
    }
  },
} as any);

// 3. AGENDAR (CON ICS)
export const createBookingTool = tool({
  description: "Crea una nueva cita.",
  parameters: z.object({
    tenantId: z.string(),
    customerPhone: z.string(),
    customerName: z.string().optional(),
    serviceId: z.string().optional().nullable(),
    startsAtISO: z.string().describe("Fecha inicio ISO 8601"),
    endsAtISO: z.string().optional(),
    notes: z.string().optional(),
  }),
  execute: async (input: any) => {
    const tenantId = String(input?.tenantId || "").trim();
    const customerPhone = normalizePhone(input?.customerPhone);
    const customerName = String(input?.customerName || "").trim();
    const serviceId = input?.serviceId ? String(input.serviceId) : null;
    const startsAtISO = String(input?.startsAtISO || "").trim();
    const endsAtISO = input?.endsAtISO ? String(input.endsAtISO).trim() : "";
    const notes = String(input?.notes || "").trim();

    if (!tenantId || !customerPhone || !startsAtISO) {
      return { success: false, message: "Faltan datos (tenantId, customerPhone, startsAtISO).", icsData: "" };
    }

    const start = new Date(startsAtISO);
    if (Number.isNaN(start.getTime())) {
      return { success: false, message: "startsAtISO inválido.", icsData: "" };
    }

    const end = endsAtISO ? new Date(endsAtISO) : new Date(start.getTime() + 60 * 60000);
    if (Number.isNaN(end.getTime())) {
      return { success: false, message: "endsAtISO inválido.", icsData: "" };
    }

    // Asegurar mínimo 15 min y máximo 4h
    const durMin = clamp(Math.round((end.getTime() - start.getTime()) / 60000), 15, 240);
    const safeEnd = new Date(start.getTime() + durMin * 60000);

    try {
      // Evitar doble booking exacto (mismo phone + mismo starts_at)
      const { data: existing } = await supabase
        .from("bookings")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("customer_phone", customerPhone)
        .eq("starts_at", start.toISOString())
        .maybeSingle();

      if (existing?.id) {
        const ics = generateICSContent(
          existing.id,
          "Cita Confirmada",
          `Reserva en ${tenantId}`,
          start.toISOString(),
          safeEnd.toISOString()
        );
        return { success: true, message: "✅ Ya existía una cita a esa hora. Te la confirmo.", icsData: ics, bookingId: existing.id };
      }

      const { data, error } = await supabase
        .from("bookings")
        .insert({
          tenant_id: tenantId,
          service_id: serviceId || null,
          customer_phone: customerPhone,
          customer_name: customerName || "Cliente",
          starts_at: start.toISOString(),
          ends_at: safeEnd.toISOString(),
          status: "confirmed",
          notes: notes || "Agendado por IA",
        })
        .select("id, starts_at, ends_at")
        .single();

      if (error) throw error;

      const ics = generateICSContent(
        data.id,
        "Cita Confirmada",
        `Reserva en ${tenantId}`,
        data.starts_at,
        data.ends_at
      );

      return { success: true, message: "✅ Cita confirmada.", icsData: ics, bookingId: data.id };
    } catch (e: any) {
      return { success: false, message: "Error al guardar: " + (e?.message || "unknown"), icsData: "" };
    }
  },
} as any);

// 4. REAGENDAR (CON ICS)
export const rescheduleBookingTool = tool({
  description: "Reagenda una cita existente.",
  parameters: z.object({
    tenantId: z.string(),
    customerPhone: z.string(),
    newStartsAtISO: z.string().describe("Nueva fecha inicio ISO 8601"),
  }),
  execute: async (input: any) => {
    const tenantId = String(input?.tenantId || "").trim();
    const customerPhone = normalizePhone(input?.customerPhone);
    const newStartsAtISO = String(input?.newStartsAtISO || "").trim();

    if (!tenantId || !customerPhone || !newStartsAtISO) {
      return { success: false, message: "Faltan datos (tenantId, customerPhone, newStartsAtISO).", icsData: "" };
    }

    const start = new Date(newStartsAtISO);
    if (Number.isNaN(start.getTime())) {
      return { success: false, message: "newStartsAtISO inválido.", icsData: "" };
    }

    const end = new Date(start.getTime() + 60 * 60000);

    try {
      const { data: booking, error: bErr } = await supabase
        .from("bookings")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("customer_phone", customerPhone)
        .in("status", ["confirmed", "pending"])
        .order("starts_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (bErr) throw bErr;
      if (!booking) return { success: false, message: "No encontré cita para reagendar.", icsData: "" };

      const { error } = await supabase
        .from("bookings")
        .update({
          starts_at: start.toISOString(),
          ends_at: end.toISOString(),
          status: "confirmed",
        })
        .eq("id", booking.id);

      if (error) throw error;

      const ics = generateICSContent(
        booking.id,
        "Cita Reagendada",
        "Tu cita ha sido movida.",
        start.toISOString(),
        end.toISOString()
      );

      return { success: true, message: "✅ Cita reagendada.", icsData: ics, bookingId: booking.id };
    } catch (e: any) {
      return { success: false, message: "Error al reagendar: " + (e?.message || "unknown"), icsData: "" };
    }
  },
} as any);

// 5. MIS CITAS
export const getMyBookingsTool = tool({
  description: "Busca citas futuras.",
  parameters: z.object({
    tenantId: z.string(),
    customerPhone: z.string(),
  }),
  execute: async (input: any) => {
    const tenantId = String(input?.tenantId || "").trim();
    const customerPhone = normalizePhone(input?.customerPhone);

    if (!tenantId || !customerPhone) return { found: false, bookings: [] };

    const { data, error } = await supabase
      .from("bookings")
      .select("id, starts_at, ends_at, status")
      .eq("tenant_id", tenantId)
      .eq("customer_phone", customerPhone)
      .in("status", ["confirmed", "pending"])
      .gt("starts_at", new Date().toISOString())
      .order("starts_at", { ascending: true })
      .limit(10);

    if (error) return { found: false, bookings: [], error: error.message };

    return { found: !!data?.length, bookings: data || [] };
  },
} as any);

// 6. CANCELAR
export const cancelBookingTool = tool({
  description: "Cancela cita.",
  parameters: z.object({
    tenantId: z.string(),
    customerPhone: z.string(),
  }),
  execute: async (input: any) => {
    const tenantId = String(input?.tenantId || "").trim();
    const customerPhone = normalizePhone(input?.customerPhone);

    if (!tenantId || !customerPhone) return { success: false, message: "Faltan datos (tenantId, customerPhone)." };

    try {
      const { data, error } = await supabase
        .from("bookings")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("customer_phone", customerPhone)
        .in("status", ["confirmed", "pending"])
        .order("starts_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      if (!data) return { success: false, message: "No tienes citas activas." };

      const { error: uErr } = await supabase.from("bookings").update({ status: "cancelled" }).eq("id", data.id);
      if (uErr) throw uErr;

      return { success: true, message: "Cita cancelada." };
    } catch (e: any) {
      return { success: false, message: "Error cancelando: " + (e?.message || "unknown") };
    }
  },
} as any);
