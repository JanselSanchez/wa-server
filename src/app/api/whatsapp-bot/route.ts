import { NextRequest, NextResponse } from "next/server";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { createClient } from "@supabase/supabase-js";

import {
  createBookingTool,
  getMyBookingsTool,
  cancelBookingTool,
  getServicesTool,
  checkAvailabilityTool,
  rescheduleBookingTool,
} from "@/utils/booking-tools";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface WhatsappBotRequestBody {
  tenantId: string;
  phoneNumber: string;
  text: string;
  customerName?: string;
}

export const maxDuration = 60;

// ------------------------------
// Helpers: toolResults parsing
// ------------------------------
function safeJsonParse(v: any) {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

type BookingMeta = {
  action: "created" | "rescheduled";
  bookingId: string;
  startsAtISO?: string | null;
  endsAtISO?: string | null;
};

function extractBookingMeta(toolResults: any): BookingMeta | null {
  if (!Array.isArray(toolResults)) return null;

  for (const tr of toolResults) {
    const t: any = tr;
    const toolName = t?.toolName || t?.name || t?.tool || null;
    if (toolName !== "createBooking" && toolName !== "rescheduleBooking") continue;

    const result = safeJsonParse(t?.result);
    const r0 = result?.result ?? result;
    const r1 = r0?.data ?? r0;

    const bookingId =
      r1?.bookingId || r1?.booking_id || r1?.id || r1?.booking?.id ||
      r0?.bookingId || r0?.booking_id || r0?.id || r0?.booking?.id ||
      null;

    const startsAtISO =
      r1?.startsAtISO || r1?.starts_at || r1?.booking?.starts_at ||
      r0?.startsAtISO || r0?.starts_at || r0?.booking?.starts_at ||
      null;

    const endsAtISO =
      r1?.endsAtISO || r1?.ends_at || r1?.booking?.ends_at ||
      r0?.endsAtISO || r0?.ends_at || r0?.booking?.ends_at ||
      null;

    if (bookingId) {
      return {
        action: toolName === "createBooking" ? "created" : "rescheduled",
        bookingId: String(bookingId),
        startsAtISO: startsAtISO ? String(startsAtISO) : null,
        endsAtISO: endsAtISO ? String(endsAtISO) : null,
      };
    }
  }

  return null;
}

function extractIcsData(toolResults: any): string | null {
  if (!Array.isArray(toolResults)) return null;

  for (const tr of toolResults) {
    const t: any = tr;
    const toolName = t?.toolName || t?.name || t?.tool || null;
    if (toolName !== "createBooking" && toolName !== "rescheduleBooking") continue;

    const result = safeJsonParse(t?.result);
    const r0 = result?.result ?? result;
    const r1 = r0?.data ?? r0;

    const ics =
      r1?.icsData ||
      r0?.icsData ||
      result?.icsData ||
      null;

    if (ics) return String(ics);
  }

  return null;
}

// ------------------------------
// Route
// ------------------------------
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as WhatsappBotRequestBody;
    const { tenantId, phoneNumber, text, customerName } = body;

    if (!tenantId || !phoneNumber || !text) {
      return NextResponse.json(
        { ok: false, message: "Faltan datos (tenantId, phoneNumber, text)." },
        { status: 400 }
      );
    }

    const { data: profile } = await supabase
      .from("business_profiles")
      .select("*")
      .eq("tenant_id", tenantId)
      .maybeSingle();

    const botName = profile?.bot_name || "Asistente Virtual";
    const botTone = profile?.bot_tone || "Amable y profesional";
    const customRules = profile?.custom_instructions || "Ayuda al cliente a agendar citas.";

    const now = new Date().toLocaleString("es-DO", {
      timeZone: "America/Santo_Domingo",
      dateStyle: "full",
      timeStyle: "short",
    });

    const { text: aiResponse, toolResults } = await generateText({
      model: openai("gpt-4o"),
      system: `
ROL: Eres "${botName}". Actúa con un tono ${botTone}.
CONTEXTO: Trabajas para el negocio con ID "${tenantId}".
FECHA Y HORA ACTUAL: ${now}.
CLIENTE: ${customerName || "Usuario"} (${phoneNumber}).

REGLAS DEL NEGOCIO:
"${customRules}"

IMPORTANTE (PARA USAR HERRAMIENTAS):
- SIEMPRE incluye tenantId="${tenantId}".
- Para herramientas que lo requieran, usa customerPhone="${phoneNumber}".
- Si agendar: usa createBooking con startsAtISO (ISO) y si no sabes serviceId envía null.
- Si usas createBooking o rescheduleBooking con éxito, responde confirmando y di:
  "Te he enviado el archivo de calendario."
      `.trim(),
      prompt: text,
      tools: {
        getServices: getServicesTool as any,
        checkAvailability: checkAvailabilityTool as any,
        createBooking: createBookingTool as any,
        rescheduleBooking: rescheduleBookingTool as any,
        getMyBookings: getMyBookingsTool as any,
        cancelBooking: cancelBookingTool as any,
      },
      // @ts-ignore
      maxSteps: 8,
    });

    const icsData = extractIcsData(toolResults);
    const bookingMeta = extractBookingMeta(toolResults);

    return NextResponse.json({
      ok: true,
      reply: aiResponse,
      icsData,
      bookingMeta,
    });
  } catch (error: any) {
    console.error("[/api/whatsapp-bot] Error crítico:", error);
    return NextResponse.json(
      { ok: false, message: "Error interno: " + (error?.message || "unknown") },
      { status: 500 }
    );
  }
}

export function GET() {
  return NextResponse.json(
    { ok: false, message: "Method not allowed. Use POST." },
    { status: 405 }
  );
}
