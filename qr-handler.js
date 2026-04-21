import qrcode from "qrcode";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function getOrCreateSession() {
  const { data: existing } = await supabase
    .from("whatsapp_sessions")
    .select("id")
    .eq("workspace_id", process.env.WORKSPACE_ID)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from("whatsapp_sessions")
    .insert({ workspace_id: process.env.WORKSPACE_ID, status: "disconnected" })
    .select("id")
    .single();
  if (error) throw error;
  return created.id;
}

/**
 * Atualiza Supabase com o QR (data URL PNG) e status connecting.
 */
export async function publishQr(qr) {
  const id = await getOrCreateSession();
  const dataUrl = await qrcode.toDataURL(qr, { width: 320, margin: 1, color: { dark: "#0A1628", light: "#FFFFFF" } });
  await supabase
    .from("whatsapp_sessions")
    .update({
      status: "connecting",
      qr_code_base64: dataUrl,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  console.log("[QR] published to Supabase");
}

export async function publishConnected(phoneNumber) {
  const id = await getOrCreateSession();
  await supabase
    .from("whatsapp_sessions")
    .update({
      status: "connected",
      qr_code_base64: null,
      phone_number: phoneNumber,
      connected_at: new Date().toISOString(),
      last_ping: new Date().toISOString(),
    })
    .eq("id", id);
  console.log("[CONN] connected as", phoneNumber);
}

export async function publishDisconnected() {
  const id = await getOrCreateSession();
  await supabase
    .from("whatsapp_sessions")
    .update({
      status: "disconnected",
      qr_code_base64: null,
      phone_number: null,
      connected_at: null,
    })
    .eq("id", id);
  console.log("[CONN] disconnected");
}

export async function ping() {
  const id = await getOrCreateSession();
  await supabase
    .from("whatsapp_sessions")
    .update({ last_ping: new Date().toISOString() })
    .eq("id", id);
}