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

// ============================================================
// NORMALIZAÇÃO DE TEXTO
// Remove acentos, pontuação e espaços extras para comparação
// robusta independente de digitação do usuário
// ============================================================
function normalizeText(text) {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos
    .replace(/[^\w\s]/g, "")          // remove pontuação
    .replace(/\s+/g, " ")             // normaliza espaços
    .trim();
}

// Palavras de intenção que indicam interesse em Google Ads / marketing
const INTENT_KEYWORDS = [
  "google ads",
  "anuncio",
  "anuncios",
  "aparecer no google",
  "marketing",
  "divulgacao",
  "publicidade",
  "mais clientes",
  "novos clientes",
  "atrair clientes",
  "conquistar clientes",
  "quero clientes",
  "vender mais",
  "aumentar vendas",
  "quero saber mais",
  "quero mais informacoes",
  "como funciona",
  "quanto custa",
  "valor do servico",
  "preco do servico",
  "tenho interesse",
  "me interesso",
  "quero contratar",
  "preciso de ajuda com",
  "minha empresa",
];

// Debounce: agrupa mensagens em sequência por telefone
const pendingMessages = new Map();

// Mapa para evitar processamento duplicado de mensagens (mesmo messageId)
const processingMessages = new Map();

// Lock por telefone para evitar processamento paralelo
const processingLocks = new Map();

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
    .order("last_activity", { ascending: false })
    .limit(1)
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

async function callAgent(messages, leadPhone, leadId) {
  const res = await fetch(process.env.CHAT_AGENT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      workspace_id: process.env.WORKSPACE_ID,
      lead_phone: leadPhone,
      lead_id: leadId,
      conversation_history: messages,
    }),
  });
  if (!res.ok) throw new Error(`chat-agent ${res.status}: ${await res.text()}`);
  return res.json();
}

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
  // Mínimo de 4 segundos para garantir agrupamento de mensagens rápidas
  // mesmo quando chegam quase simultaneamente
  const debounceSeconds = Math.max(4, Math.min(10, cfg.message_debounce_seconds ?? 4));

  if (!debounceEnabled) {
    await processMessage({ phone, text, remoteJid }, sendReply);
    return;
  }

  const existing = pendingMessages.get(phone);
  if (existing) {
    // Cancela o timer anterior e adiciona a nova mensagem ao grupo
    clearTimeout(existing.timer);
    existing.messages.push(text);
    existing.sendReply = sendReply;
    existing.remoteJid = remoteJid;
    console.log(`[DEBOUNCE] Agrupando mensagem de ${phone}: "${text}" (total: ${existing.messages.length})`);
  } else {
    // Primeira mensagem — cria entrada no mapa
    pendingMessages.set(phone, { timer: null, messages: [text], sendReply, remoteJid });
    console.log(`[DEBOUNCE] Nova janela de agrupamento para ${phone}: "${text}"`);
  }

  // Reinicia o timer — só processa após debounceSeconds sem nova mensagem
  const entry = pendingMessages.get(phone);
  entry.timer = setTimeout(async () => {
    const pending = pendingMessages.get(phone);
    if (!pending) return;
    pendingMessages.delete(phone);

    // Junta todas as mensagens com espaço entre elas
    const fullText = pending.messages.join(" ");
    console.log(`[DEBOUNCE] Processando ${pending.messages.length} mensagem(ns) de ${phone}: "${fullText}"`);

    try {
      await processMessage({ phone, text: fullText, remoteJid: pending.remoteJid }, pending.sendReply);
    } catch (e) {
      console.error("[DEBOUNCE] processMessage error:", e);
    }
  }, debounceSeconds * 1000);
}

async function processMessage({ phone, text, remoteJid }, sendReply) {
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
  // 0) Verifica se o WhatsApp está conectado
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

  // FILTRO 1 — Blacklist
  const { data: blacklisted } = await supabase
    .from("whatsapp_blacklist")
    .select("id")
    .eq("workspace_id", process.env.WORKSPACE_ID)
    .eq("phone", phone)
    .maybeSingle();

  if (blacklisted) {
    console.log(`[FILTER] Número na blacklist, ignorando: ${phone}`);
    return;
  }

  // Carrega configurações de filtro
  const { data: agentCfg } = await supabase
    .from("agent_configs")
    .select("allowed_labels, blocked_labels, activation_keyword, keyword_enabled, keyword_reply, intent_keywords")
    .eq("workspace_id", process.env.WORKSPACE_ID)
    .maybeSingle();

  const allowedLabels = Array.isArray(agentCfg?.allowed_labels) ? agentCfg.allowed_labels : ["Lead Meta"];
  const blockedLabels = Array.isArray(agentCfg?.blocked_labels) ? agentCfg.blocked_labels : ["Cliente", "Perdido"];
  const activationKeyword = agentCfg?.activation_keyword ?? "Quero saber mais";
  const keywordEnabled = agentCfg?.keyword_enabled ?? true;
  const keywordReply = agentCfg?.keyword_reply ?? null;

  // Palavras de intenção: combina padrão com personalizadas do banco
  const customIntentKeywords = Array.isArray(agentCfg?.intent_keywords) ? agentCfg.intent_keywords : [];
  const allIntentKeywords = [...INTENT_KEYWORDS, ...customIntentKeywords.map(normalizeText)];

  // FILTRO 2 — Etiquetas do WhatsApp Business
  // Etiquetas bloqueantes SEMPRE vencem qualquer combinação
  let contactLabels = [];
  try {
    const jid = remoteJid || (phone.replace("+", "") + "@s.whatsapp.net");
    const contact = (typeof sock?.getContactInfo === "function")
      ? await sock.getContactInfo(jid)
      : null;
    contactLabels = Array.isArray(contact?.labels) ? contact.labels : [];
  } catch (e) {
    console.log(`[FILTER] Não foi possível buscar etiquetas: ${e.message}`);
    contactLabels = [];
  }

  const labelNameOf = (cl) =>
    (typeof cl === "string" ? cl : cl?.name ?? "").toString().toLowerCase();

  const hasBlockedLabel = blockedLabels.some((blockedLabel) =>
    contactLabels.some((cl) => labelNameOf(cl) === blockedLabel.toLowerCase())
  );

  if (hasBlockedLabel) {
    console.log(`[FILTER] ❌ Bloqueado por etiqueta — Phone: ${phone} | Labels: ${JSON.stringify(contactLabels)}`);
    return;
  }

  const hasAllowedLabel = allowedLabels.some((allowedLabel) =>
    contactLabels.some((cl) => labelNameOf(cl) === allowedLabel.toLowerCase())
  );

  // FILTRO 3 — Conversa ativa existente
  const { data: existingLead } = await supabase
    .from("leads")
    .select("id")
    .eq("workspace_id", process.env.WORKSPACE_ID)
    .eq("phone", phone)
    .maybeSingle();

  let hasActiveConversation = false;
  if (existingLead) {
    const { data: activeConv } = await supabase
      .from("conversations")
      .select("id")
      .eq("lead_id", existingLead.id)
      .eq("status", "active")
      .maybeSingle();
    hasActiveConversation = !!activeConv;
  }

  // FILTRO 4 — Palavra-chave e intenção (com normalização robusta)
  const normalizedMessage = normalizeText(text);
  const normalizedKeyword = normalizeText(activationKeyword);

  // Correspondência exata normalizada (ignora acentos, pontuação, maiúsculas)
  const exactMatch = normalizedMessage.includes(normalizedKeyword);

  // Correspondência por intenção — detecta interesse mesmo sem palavra-chave exata
  const intentMatch = allIntentKeywords.some((kw) => normalizedMessage.includes(kw));

  const keywordMatch = keywordEnabled && (exactMatch || intentMatch);

  // Log detalhado para diagnóstico
  console.log(
    `[FILTER] keyword check — msg: "${normalizedMessage}" | keyword: "${normalizedKeyword}" | exactMatch: ${exactMatch} | intentMatch: ${intentMatch} | keywordMatch: ${keywordMatch}`
  );

  const shouldEngage = hasAllowedLabel || hasActiveConversation || keywordMatch;

  if (!shouldEngage) {
    console.log(
      `[FILTER] Mensagem ignorada — sem etiqueta permitida, sem conversa ativa e sem palavra-chave. Phone: ${phone}`
    );
    return;
  }

  console.log(
    `[FILTER] ✅ Agente assumindo conversa — Phone: ${phone} | Label: ${hasAllowedLabel} | Keyword: ${keywordMatch} | ActiveConv: ${hasActiveConversation}`
  );

  // Resposta automática ao ativar via palavra-chave (apenas no primeiro contato)
  if (keywordMatch && !hasActiveConversation && !hasAllowedLabel && keywordReply && keywordReply.trim()) {
    try {
      await sendReply(keywordReply.trim());
    } catch (e) {
      console.error("[FILTER] Falha ao enviar keyword_reply:", e);
    }
  }

  // 1) Horário de atendimento
  const window = await isWithinBusinessHours();
  if (!window.allowed) {
    await sendReply(window.message ?? "Olá! Nosso atendimento está fora do horário. Retornamos em breve!");
    return;
  }

  // 2) Carrega/cria lead + conversa
  const { lead, conv } = await getOrCreateLeadAndConversation(phone);
  let updated = await appendMessage(conv, "user", text);

  // 3) Chama agente
  let agent;
  try {
    agent = await callAgent(updated.messages, phone, lead.id);
  } catch (e) {
    console.error("[AGENT] error:", e);
    await sendReply("Desculpe, tive um problema técnico. Pode repetir em instantes?");
    return;
  }

  // 4) Salva resposta com simulação de digitação
  if (agent.reply) {
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

  // 5) Atualiza lead com dados extraídos
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

  // 6) Marca conversa como finalizada se status terminal
  if (["qualified", "unqualified", "partial"].includes(agent.status) && agent.should_schedule !== true) {
    await supabase.from("conversations").update({ status: "finished" }).eq("id", updated.id);
  }
}
