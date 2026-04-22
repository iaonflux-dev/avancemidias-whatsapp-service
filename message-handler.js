import { createClient } from "@supabase/supabase-js";
import { isWithinBusinessHours } from "./scheduler.js";
import { sock } from "./index.js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Cache leve da config do agente (10s)
let cfgCache = { data: null, ts: 0 };
async function getAgentConfig() {
  if (cfgCache.data && Date.now() - cfgCache.ts < 10_000) return cfgCache.data;
  const { data } = await supabase
    .from("agent_configs")
    .select("simulate_typing, message_debounce_enabled, message_debounce_seconds")
    .eq("workspace_id", process.env.WORKSPACE_ID)
    .maybeSingle();
  cfgCache = { data: data ?? {}, ts: Date.now() };
  return cfgCache.data;
}

// Debounce: agrupa mensagens em sequência por telefone
const pendingMessages = new Map(); // phone -> { timer, messages[], sendReply, remoteJid }

// Mapa para evitar processamento duplicado de mensagens (mesmo messageId)
const processingMessages = new Map(); // messageId -> timestamp

// Lock por telefone para evitar processamento paralelo de mensagens do mesmo lead
const processingLocks = new Map(); // phone -> boolean

/**
 * Garante que existe um lead para o número e retorna { lead, conversation }.
 */
async function getOrCreateLeadAndConversation(phone) {
  const workspaceId = process.env.WORKSPACE_ID;

  let { data: lead } = await supabase
    .from("leads")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("phone", phone)
    .maybeSingle();

  if (!lead) {
    const { data: created, error } = await supabase
      .from("leads")
      .insert({ workspace_id: workspaceId, phone, qualification_status: "pending", score: 0 })
      .select("*")
      .single();
    if (error) throw error;
    lead = created;
  }

  let { data: conv } = await supabase
    .from("conversations")
    .select("*")
    .eq("lead_id", lead.id)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .maybeSingle();

  if (!conv) {
    const { data: createdConv, error } = await supabase
      .from("conversations")
      .insert({
        workspace_id: workspaceId,
        lead_id: lead.id,
        messages: [],
        status: "active",
      })
      .select("*")
      .single();
    if (error) throw error;
    conv = createdConv;
  }

  return { lead, conv };
}

async function appendMessage(conv, role, content) {
  const messages = Array.isArray(conv.messages) ? [...conv.messages] : [];
  messages.push({ role, content, timestamp: new Date().toISOString() });
  const { data, error } = await supabase
    .from("conversations")
    .update({
      messages,
      last_activity: new Date().toISOString(),
      duration_seconds: Math.floor((Date.now() - new Date(conv.started_at).getTime()) / 1000),
    })
    .eq("id", conv.id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function callAgent(messages, leadPhone) {
  const res = await fetch(process.env.CHAT_AGENT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      workspace_id: process.env.WORKSPACE_ID,
      lead_phone: leadPhone,
      conversation_history: messages,
    }),
  });
  if (!res.ok) throw new Error(`chat-agent ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Processa uma mensagem recebida do WhatsApp e devolve a resposta do agente.
 * Faz debounce: agrupa mensagens em sequência rápida antes de chamar o agente.
 * @param {{ phone: string, text: string, remoteJid?: string, messageId?: string }} input
 * @param {(text: string) => Promise<void>} sendReply
 */
export async function handleIncomingMessage({ phone, text, remoteJid, messageId }, sendReply) {
  // Deduplicação: ignora se a mesma mensagem já foi processada recentemente
  if (messageId && processingMessages.has(messageId)) {
    console.log(`[MSG] Duplicata ignorada: ${messageId}`);
    return;
  }
  if (messageId) {
    processingMessages.set(messageId, Date.now());
    setTimeout(() => processingMessages.delete(messageId), 10_000);
  }

  console.log(`[MSG] ← ${phone}: ${text}`);

  const cfg = await getAgentConfig();
  const debounceEnabled = cfg.message_debounce_enabled ?? true;
  const debounceSeconds = Math.max(1, Math.min(10, cfg.message_debounce_seconds ?? 3));

  // Sem debounce: processa imediatamente
  if (!debounceEnabled) {
    await processMessage({ phone, text, remoteJid }, sendReply);
    return;
  }

  // Com debounce: agrupa mensagens em sequência
  const existing = pendingMessages.get(phone);
  if (existing) {
    clearTimeout(existing.timer);
    existing.messages.push(text);
    existing.sendReply = sendReply;
    existing.remoteJid = remoteJid;
  } else {
    pendingMessages.set(phone, { timer: null, messages: [text], sendReply, remoteJid });
  }

  const entry = pendingMessages.get(phone);
  entry.timer = setTimeout(async () => {
    const pending = pendingMessages.get(phone);
    if (!pending) return;
    pendingMessages.delete(phone);
    const fullText = pending.messages.join(" ");
    try {
      await processMessage({ phone, text: fullText, remoteJid: pending.remoteJid }, pending.sendReply);
    } catch (e) {
      console.error("[DEBOUNCE] processMessage error:", e);
    }
  }, debounceSeconds * 1000);
}

/**
 * Lógica original: processa uma mensagem (já agrupada se for o caso).
 */
async function processMessage({ phone, text, remoteJid }, sendReply) {
  // Aguarda lock se já houver processamento em andamento para esse telefone
  if (processingLocks.get(phone)) {
    console.log(`[MSG] Aguardando lock para ${phone}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  processingLocks.set(phone, true);
  try {
    await _doProcessMessage({ phone, text, remoteJid }, sendReply);
  } finally {
    processingLocks.set(phone, false);
  }
}

async function _doProcessMessage({ phone, text, remoteJid }, sendReply) {
  console.log(`[MSG] ← ${phone}: ${text}`);

  // 0) Verifica se o WhatsApp está conectado no Supabase. Se foi desconectado
  //    pela UI, o agente para imediatamente de responder.
  const { data: session } = await supabase
    .from("whatsapp_sessions")
    .select("status")
    .eq("workspace_id", process.env.WORKSPACE_ID)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!session || session.status !== "connected") {
    console.log(`[MSG] Agente pausado — WhatsApp desconectado. Ignorando mensagem de ${phone}`);
    return;
  }

  // 1) horário de atendimento
  const window = await isWithinBusinessHours();
  if (!window.allowed) {
    await sendReply(window.message ?? "Olá! Nosso atendimento está fora do horário. Retornamos em breve!");
    return;
  }

  // 2) carrega/cria lead + conversa
  const { lead, conv } = await getOrCreateLeadAndConversation(phone);
  let updated = await appendMessage(conv, "user", text);

  // 3) chama agente
  let agent;
  try {
    agent = await callAgent(updated.messages, phone);
  } catch (e) {
    console.error("[AGENT] error:", e);
    await sendReply("Desculpe, tive um problema técnico. Pode repetir em instantes?");
    return;
  }

  // 4) salva resposta
  if (agent.reply) {
    // Simula digitação antes de enviar (se habilitado e remoteJid disponível)
    const cfg = await getAgentConfig();
    if ((cfg.simulate_typing ?? true) && remoteJid && sock) {
      try {
        await sock.sendPresenceUpdate("composing", remoteJid);
        const typingDelay = Math.min(1000 + agent.reply.length * 30, 5000);
        await new Promise((resolve) => setTimeout(resolve, typingDelay));
        await sock.sendPresenceUpdate("paused", remoteJid);
      } catch (e) {
        console.error("[TYPING] presence update error:", e);
      }
    }
    updated = await appendMessage(updated, "assistant", agent.reply);
    await sendReply(agent.reply);
  }

  // 5) atualiza lead com dados extraídos
  if (agent.extracted) {
    const e = agent.extracted;
    await supabase.from("leads").update({
      name: e.name || lead.name,
      company: e.company || lead.company,
      city: e.city || lead.city,
      segment: e.segment || lead.segment,
      company_size: e.size || lead.company_size,
      main_challenge: e.challenge || lead.main_challenge,
      currently_using_ads: typeof e.using_ads === "boolean" ? e.using_ads : lead.currently_using_ads,
      score: typeof e.score === "number" ? e.score : lead.score,
      qualification_status:
        agent.status === "qualified" || agent.status === "partial" || agent.status === "unqualified"
          ? agent.status
          : lead.qualification_status,
      qualification_reason: agent.qualification_reason ?? lead.qualification_reason,
    }).eq("id", lead.id);
  }

  // 6) marca conversa como finalizada se status terminal
  if (["qualified", "unqualified", "partial"].includes(agent.status) && agent.should_schedule !== true) {
    await supabase.from("conversations").update({ status: "finished" }).eq("id", updated.id);
  }
}
