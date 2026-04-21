import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

let cache = { cfg: null, ts: 0 };
const TTL = 60_000; // 1 min

const DAY_MAP = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export async function getAgentConfig() {
  if (cache.cfg && Date.now() - cache.ts < TTL) return cache.cfg;
  const { data, error } = await supabase
    .from("agent_configs")
    .select("*")
    .eq("workspace_id", process.env.WORKSPACE_ID)
    .maybeSingle();
  if (error) throw error;
  cache = { cfg: data, ts: Date.now() };
  return data;
}

/**
 * Decide se o agente deve responder agora.
 * Retorna { allowed: boolean, message?: string }
 */
export async function isWithinBusinessHours() {
  const cfg = await getAgentConfig();
  if (!cfg) return { allowed: true };

  const now = new Date();
  const today = DAY_MAP[now.getDay()];
  const activeDays = Array.isArray(cfg.active_days) ? cfg.active_days : [];

  if (!activeDays.includes(today)) {
    return { allowed: false, message: cfg.off_hours_message };
  }

  const [sH, sM] = (cfg.business_hours_start ?? "09:00:00").split(":").map(Number);
  const [eH, eM] = (cfg.business_hours_end ?? "18:00:00").split(":").map(Number);
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const minutesStart = sH * 60 + sM;
  const minutesEnd = eH * 60 + eM;

  if (minutesNow < minutesStart || minutesNow >= minutesEnd) {
    return { allowed: false, message: cfg.off_hours_message };
  }

  return { allowed: true };
}

export function invalidateCache() {
  cache = { cfg: null, ts: 0 };
}