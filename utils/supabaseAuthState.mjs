import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys'

export const useSupabaseAuthState = async (supabase, tenantId) => {
    // 1. Buscar si ya existen datos guardados para este tenant
    const { data, error } = await supabase
        .from('whatsapp_sessions')
        .select('auth_state')
        .eq('tenant_id', tenantId)
        .single()

    let creds
    let keys = {}

    // 2. Si hay datos, los recuperamos y decodificamos
    if (data?.auth_state) {
        // Usamos BufferJSON.reviver para recuperar los Buffers correctamente
        const parsedState = JSON.parse(JSON.stringify(data.auth_state), BufferJSON.reviver)
        creds = parsedState.creds
        keys = parsedState.keys
    } else {
        // 3. Si no hay datos, inicializamos credenciales nuevas
        creds = initAuthCreds()
    }

    // 4. Función para guardar (se ejecuta cada vez que Baileys actualiza llaves)
    const saveState = async () => {
        // Convertimos Buffers a formato JSON-friendly antes de guardar
        const stateToSave = JSON.parse(JSON.stringify({ creds, keys }, BufferJSON.replacer))
        
        const { error } = await supabase
            .from('whatsapp_sessions')
            .update({ auth_state: stateToSave })
            .eq('tenant_id', tenantId)

        if (error) {
            console.error('[Supabase Auth] Error guardando sesión:', error)
        }
    }

    return {
        state: {
            creds,
            keys: {
                get: (type, ids) => {
                    const data = {}
                    ids.forEach((id) => {
                        let value = keys[type]?.[id]
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value)
                        }
                        data[id] = value
                    })
                    return data
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id]
                            if (!keys[category]) keys[category] = {}
                            keys[category][id] = value
                        }
                    }
                    // Guardamos en DB cada vez que hay cambios en las llaves
                    await saveState()
                }
            }
        },
        saveCreds: saveState
    }
}
