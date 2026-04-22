import { createClient } from "@supabase/supabase-js";
import { isWithinBusinessHours } from "./scheduler.js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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
 * @param {{ phone: string, text: string }} input
 * @param {(text: string) => Promise<void>} sendReply
 */
export async function handleIncomingMessage({ phone, text }, sendReply) {
  console.log(`[MSG] ← ${phone}: ${text}`);

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
