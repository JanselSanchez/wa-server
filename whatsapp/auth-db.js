const { proto, initAuthCreds, BufferJSON } = require("@whiskeysockets/baileys");

/**
 * Adaptador de Autenticación para Supabase
 * Convierte la lógica de archivos de Baileys a filas de SQL.
 */
async function useSupabaseAuthState(supabase, tenantId) {
  // 1. Intentamos leer las credenciales principales (creds.json)
  const { data: credsRow } = await supabase
    .from("wa_auth")
    .select("value")
    .eq("tenant_id", tenantId)
    .eq("key_id", "creds")
    .maybeSingle();

  const creds = credsRow?.value
    ? JSON.parse(credsRow.value, BufferJSON.reviver)
    : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        // GET: Baileys pide llaves específicas (ej: app-state-sync-key-xxxx)
        get: async (type, ids) => {
          const data = {};
          const keysToFetch = ids.map((id) => `${type}-${id}`);

          const { data: rows } = await supabase
            .from("wa_auth")
            .select("key_id, value")
            .eq("tenant_id", tenantId)
            .in("key_id", keysToFetch);

          if (rows) {
            rows.forEach((row) => {
              // Recuperamos el ID original quitando el prefijo "type-"
              const originalId = row.key_id.substring(type.length + 1);
              let value = JSON.parse(row.value, BufferJSON.reviver);
              
              // Parche para tipos específicos de protobuf
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[originalId] = value;
            });
          }
          return data;
        },
        // SET: Baileys nos da datos para guardar
        set: async (data) => {
          const rowsToUpsert = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const keyId = `${category}-${id}`;
              
              if (value) {
                rowsToUpsert.push({
                  tenant_id: tenantId,
                  key_id: keyId,
                  value: JSON.stringify(value, BufferJSON.replacer),
                });
              } else {
                // Si el valor es null/undefined, deberíamos borrarlo (opcional, aquí upsert lo ignora)
                await supabase
                  .from("wa_auth")
                  .delete()
                  .eq("tenant_id", tenantId)
                  .eq("key_id", keyId);
              }
            }
          }
          if (rowsToUpsert.length > 0) {
            const { error } = await supabase
              .from("wa_auth")
              .upsert(rowsToUpsert, { onConflict: "tenant_id,key_id" });
            if (error) console.error("[AuthDB] Error guardando keys:", error);
          }
        },
      },
    },
    // saveCreds: Baileys llama esto cuando cambian las credenciales principales
    saveCreds: async () => {
      const { error } = await supabase.from("wa_auth").upsert(
        {
          tenant_id: tenantId,
          key_id: "creds",
          value: JSON.stringify(creds, BufferJSON.replacer),
        },
        { onConflict: "tenant_id,key_id" }
      );
      if (error) console.error("[AuthDB] Error guardando creds:", error);
    },
  };
}

module.exports = { useSupabaseAuthState };
