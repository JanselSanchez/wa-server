// whatsapp/logic.js
const OpenAI = require("openai");
const { format, utcToZonedTime } = require("date-fns-tz");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TIMEZONE_LOCALE = "America/Santo_Domingo";
const TIMEZONE_OFFSET_STR = "-04:00"; 

// --- 1. LÓGICA DE HORARIOS (MATEMÁTICA PURA DE LA V32) ---
async function getAvailableSlots(tenantId, supabase, targetDateInput) {
    try {
        const targetDate = targetDateInput ? new Date(targetDateInput) : new Date();
        const dateInRD = utcToZonedTime(targetDate, TIMEZONE_LOCALE);
        const dow = dateInRD.getDay();
        // Ajuste de fecha string
        const year = dateInRD.getFullYear();
        const month = String(dateInRD.getMonth() + 1).padStart(2, '0');
        const day = String(dateInRD.getDate()).padStart(2, '0');
        const dateString = `${year}-${month}-${day}`;

        // 1. Horario DB
        const { data: hours } = await supabase.from("business_hours")
            .select("open_time, close_time").eq("tenant_id", tenantId).eq("dow", dow).eq("is_closed", false).maybeSingle();
        
        if (!hours) return [];

        // 2. Citas DB
        const { data: bookings } = await supabase.from("bookings").select("starts_at, ends_at")
            .eq("tenant_id", tenantId)
            .gte("starts_at", `${dateString}T00:00:00${TIMEZONE_OFFSET_STR}`)
            .lte("starts_at", `${dateString}T23:59:59${TIMEZONE_OFFSET_STR}`)
            .neq("status", "cancelled");

        // 3. Generar Slots (Minutos)
        const [openH, openM] = hours.open_time.split(":").map(Number);
        const [closeH, closeM] = hours.close_time.split(":").map(Number);
        
        let current = (openH * 60) + openM;
        let end = (closeH * 60) + closeM;
        if (end <= 1080) end += 240; // Parche si cierra a las 18:00

        let slots = [];
        const now = new Date();

        while (current < end) {
            const h = Math.floor(current / 60);
            const m = current % 60;
            if (h >= 24) break;
            
            const hh = String(h).padStart(2, '0');
            const mm = String(m).padStart(2, '0');
            const iso = `${dateString}T${hh}:${mm}:00${TIMEZONE_OFFSET_STR}`;
            const dt = new Date(iso);

            if (dt > now) {
                const busy = bookings?.some(b => dt >= new Date(b.starts_at) && dt < new Date(b.ends_at));
                if (!busy) slots.push(iso);
            }
            current += 30;
        }
        return slots;
    } catch (e) { console.error("Error slots:", e); return []; }
}

// --- 2. CEREBRO IA ---
async function generateResponse(text, tenantId, supabase, userPhone, pushName, history) {
    const { data: profile } = await supabase.from("business_profiles").select("*").eq("tenant_id", tenantId).maybeSingle();
    
    // Prompt del sistema
    const systemPrompt = `ERES: ${profile?.bot_name || "Asistente"}. 
    SI EL USUARIO DICE UN NUMERO, ES UNA OPCIÓN DE LA LISTA ANTERIOR. 
    Tools: check_availability, create_booking, get_catalog.`;

    const messages = [
        { role: "system", content: systemPrompt },
        ...history.slice(-6),
        { role: "user", content: text }
    ];

    const tools = [
        { name: "check_availability", description: "Ver horarios.", parameters: { type: "object", properties: { requestedDate: { type: "string" } }, required: ["requestedDate"] } },
        { name: "create_booking", description: "Agendar.", parameters: { type: "object", properties: { startsAtISO: { type: "string" } }, required: ["startsAtISO"] } },
        { name: "get_catalog", description: "Ver precios.", parameters: { type: "object", properties: {}, required: [] } }
    ];

    try {
        const completion = await openai.chat.completions.create({ model: "gpt-4o-mini", messages, tools, tool_choice: "auto", temperature: 0 });
        const msg = completion.choices[0].message;

        if (msg.tool_calls) {
            for (const t of msg.tool_calls) {
                const args = JSON.parse(t.function.arguments || "{}");
                
                if (t.function.name === "check_availability") {
                    const slots = await getAvailableSlots(tenantId, supabase, args.requestedDate);
                    if (!slots.length) return { text: "No hay cupos disponibles." };
                    
                    let txt = `📅 *Horarios Disponibles:*\n`;
                    slots.slice(0, 50).forEach((s, i) => {
                        const time = new Date(s).toLocaleTimeString("es-DO", {hour:'2-digit', minute:'2-digit', hour12:true, timeZone: TIMEZONE_LOCALE});
                        txt += `${i+1}) ${time}\n`;
                    });
                    return { text: txt + "\nResponde con el número." };
                }

                if (t.function.name === "create_booking") {
                    // Validar ISO
                    let iso = args.startsAtISO;
                    if(!iso.includes("T")) iso = `${new Date().toISOString().split("T")[0]}T${iso}`;

                    const { error } = await supabase.from("bookings").insert([{
                        tenant_id: tenantId, customer_phone: userPhone, customer_name: pushName,
                        starts_at: iso, ends_at: new Date(new Date(iso).getTime()+3600000).toISOString(),
                        status: "confirmed"
                    }]);
                    return { text: error ? "Error al agendar." : "✅ Cita confirmada." };
                }

                if (t.function.name === "get_catalog") {
                    const { data } = await supabase.from("items").select("name, price_cents").eq("tenant_id", tenantId);
                    return { text: JSON.stringify(data) };
                }
            }
        }
        return { text: msg.content };
    } catch (e) {
        console.error("Error IA:", e);
        return { text: "Hubo un error procesando tu mensaje." };
    }
}

module.exports = { generateResponse };
