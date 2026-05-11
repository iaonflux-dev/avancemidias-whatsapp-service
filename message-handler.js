import { createClient } from "@supabase/supabase-js";
import { isWithinBusinessHours } from "./scheduler.js";
import { sock } from "./index.js";
import ws from "ws";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  realtime: { transport: ws },
});

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
    .replace(/[^\w\s]/g, "") // remove pontuação
    .replace(/\s+/g, " ") // normaliza espaços
    .trim();
}

// ============================================================
// NORMALIZAÇÃO DE TELEFONE
// ============================================================
function normalizePhone(phone) {
  const digits = (phone ?? "").replace(/\D/g, "");
  return "+" + digits;
}

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
  // ============================================================
  // DEDUPLICAÇÃO — ignora messageId já processado recentemente
  // ============================================================
  if (messageId && processingMessages.has(messageId)) {
    console.log(`[MSG] Duplicata ignorada: ${messageId}`);
    return;
  }
  if (messageId) {
    processingMessages.set(messageId, Date.now());
    setTimeout(() => processingMessages.delete(messageId), 10_000);
  }

  console.log(`[MSG] ← ${phone}: ${text}`);

  // ============================================================
  // DEBOUNCE — agrupa TODAS as mensagens do mesmo número ANTES
  // de qualquer filtro ou processamento.
  // ============================================================
  const cfg = await getAgentConfig();
  const debounceEnabled = cfg.message_debounce_enabled ?? true;
  const debounceSeconds = Math.max(10, Math.min(30, cfg.message_debounce_seconds ?? 12));

  if (!debounceEnabled) {
    await processMessage({ phone, text, remoteJid }, sendReply);
    return;
  }

  const existing = pendingMessages.get(phone);
  if (existing) {
    clearTimeout(existing.timer);
    existing.messages.push(text);
    existing.sendReply = sendReply;
    existing.remoteJid = remoteJid;
    console.log(`[DEBOUNCE] ➕ Agrupando "${text}" — total: ${existing.messages.length} mensagem(ns) de ${phone}`);
  } else {
    pendingMessages.set(phone, { timer: null, messages: [text], sendReply, remoteJid });
    console.log(`[DEBOUNCE] 🕐 Janela aberta para ${phone}: "${text}" — aguardando ${debounceSeconds}s`);
  }

  const normalizeForCheck = (s) =>
    (s ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const incompleteEndings = ["antes", "primeiro", "mas", "porem", "e", "tambem", "alem", "que", "se", "porque", "pois"];
  const lastWord = normalizeForCheck(text).split(" ").pop() ?? "";
  const likelyContinues = incompleteEndings.includes(lastWord);
  const effectiveDebounce = likelyContinues ? debounceSeconds * 2 : debounceSeconds;

  if (likelyContinues) {
    console.log(
      `[DEBOUNCE] ⏳ Mensagem provavelmente incompleta (termina em "${lastWord}") — estendendo para ${effectiveDebounce}s`,
    );
  }

  const entry = pendingMessages.get(phone);
  entry.timer = setTimeout(async () => {
    const pending = pendingMessages.get(phone);
    if (!pending) return;
    pendingMessages.delete(phone);

    const fullText = pending.messages.join(" ");
    console.log(`[DEBOUNCE] ✅ Janela fechada — ${pending.messages.length} mensagem(ns) de ${phone}: "${fullText}"`);

    try {
      await processMessage({ phone, text: fullText, remoteJid: pending.remoteJid }, pending.sendReply);
    } catch (e) {
      console.error("[DEBOUNCE] processMessage error:", e);
    }
  }, effectiveDebounce * 1000);
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
  const phoneDigits = (phone ?? "").replace(/\D/g, "");
  const { data: blacklisted } = await supabase
    .from("whatsapp_blacklist")
    .select("id")
    .eq("workspace_id", process.env.WORKSPACE_ID)
    .eq("phone_digits", phoneDigits)
    .maybeSingle();

  if (blacklisted) {
    console.log(`[FILTER] ❌ Blacklist — ignorando: ${phone}`);
    return;
  }

  // Carrega configurações de filtro
  const { data: agentCfg } = await supabase
    .from("agent_configs")
    .select("allowed_labels, blocked_labels, activation_keyword, keyword_enabled, keyword_reply")
    .eq("workspace_id", process.env.WORKSPACE_ID)
    .maybeSingle();

  const allowedLabels = Array.isArray(agentCfg?.allowed_labels) ? agentCfg.allowed_labels : ["Lead Meta"];
  const blockedLabels = Array.isArray(agentCfg?.blocked_labels) ? agentCfg.blocked_labels : ["Cliente", "Perdido"];
  const activationKeyword = agentCfg?.activation_keyword ?? "Olá, quero conquistar mais clientes com o Google Ads.";
  const keywordEnabled = agentCfg?.keyword_enabled ?? true;
  const keywordReply = agentCfg?.keyword_reply ?? null;

  // FILTRO 2 — Etiquetas do contato (via tabela contact_labels)
  let contactLabels = [];
  try {
    const { data: contactLabelData } = await supabase
      .from("contact_labels")
      .select("labels")
      .eq("workspace_id", process.env.WORKSPACE_ID)
      .eq("phone_digits", phoneDigits)
      .maybeSingle();
    contactLabels = Array.isArray(contactLabelData?.labels) ? contactLabelData.labels : [];
  } catch (e) {
    console.log(`[FILTER] Não foi possível buscar etiquetas: ${e.message}`);
    contactLabels = [];
  }
  console.log(`[FILTER] Labels de ${phone}: ${JSON.stringify(contactLabels)}`);

  const labelNameOf = (cl) => (typeof cl === "string" ? cl : (cl?.name ?? "")).toString().toLowerCase();

  // Etiquetas bloqueantes SEMPRE têm prioridade absoluta
  const hasBlockedLabel = blockedLabels.some((blockedLabel) =>
    contactLabels.some((cl) => labelNameOf(cl) === blockedLabel.toLowerCase()),
  );

  if (hasBlockedLabel) {
    console.log(`[FILTER] ❌ Bloqueado por etiqueta — Phone: ${phone} | Labels: ${JSON.stringify(contactLabels)}`);
    return;
  }

  const hasAllowedLabel = allowedLabels.some((allowedLabel) =>
    contactLabels.some((cl) => labelNameOf(cl) === allowedLabel.toLowerCase()),
  );

  // FILTRO 3 — Conversa ativa + pausa do agente
  const { data: existingLead } = await supabase
    .from("leads")
    .select("id, agent_paused, agent_paused_until")
    .eq("workspace_id", process.env.WORKSPACE_ID)
    .eq("phone", phone)
    .maybeSingle();

  let hasActiveConversation = false;
  if (existingLead) {
    const isPaused = existingLead.agent_paused === true;
    const pausedUntil = existingLead.agent_paused_until ? new Date(existingLead.agent_paused_until) : null;

    if (isPaused && (!pausedUntil || pausedUntil > new Date())) {
      console.log(`[FILTER] ⏸️ Agente pausado para ${phone} — usuário assumiu a conversa`);
      return;
    }

    if (isPaused && pausedUntil && pausedUntil <= new Date()) {
      await supabase
        .from("leads")
        .update({ agent_paused: false, agent_paused_until: null, agent_paused_reason: null })
        .eq("id", existingLead.id);
      console.log(`[FILTER] ▶️ Pausa expirada — agente reativado para ${phone}`);
    }

    const { data: activeConv } = await supabase
      .from("conversations")
      .select("id")
      .eq("lead_id", existingLead.id)
      .eq("status", "active")
      .maybeSingle();
    hasActiveConversation = !!activeConv;
  }

  // ============================================================
  // FILTRO 4 — PALAVRA-CHAVE DE ATIVAÇÃO (CORRESPONDÊNCIA EXATA)
  //
  // REGRA: o agente SÓ é ativado para novos contatos se a mensagem
  // for EXATAMENTE igual à palavra-chave configurada.
  // NÃO usa lógica de intenção ou palavras parciais.
  // A normalização apenas remove acentos, pontuação e espaços extras
  // para tolerância mínima de digitação.
  //
  // Exemplos com keyword = "Olá, quero conquistar mais clientes com o Google Ads.":
  // ✅ "Olá, quero conquistar mais clientes com o Google Ads." → ativa
  // ✅ "ola quero conquistar mais clientes com o google ads"  → ativa (normalização)
  // ❌ "Oi"                                                   → ignora
  // ❌ "quero mais clientes"                                  → ignora
  // ❌ "google ads"                                           → ignora
  // ❌ "quero saber mais"                                     → ignora
  // ============================================================
  const normalizedMessage = normalizeText(text);
  const normalizedKeyword = normalizeText(activationKeyword);

  // USA === (igualdade total) — NÃO usa .includes()
  const exactMatch = normalizedMessage === normalizedKeyword;
  const keywordMatch = keywordEnabled && exactMatch;

  console.log(
    `[FILTER] keyword check — msg: "${normalizedMessage}" | keyword: "${normalizedKeyword}" | exactMatch: ${exactMatch} | keywordMatch: ${keywordMatch}`,
  );

  // Decisão final de engajamento:
  // 1. Etiqueta permitida → ativa automaticamente (leads do anúncio)
  // 2. Conversa ativa → continua respondendo
  // 3. Palavra-chave exata → ativa novo contato
  // Qualquer outro caso → ignora silenciosamente
  const shouldEngage = hasAllowedLabel || hasActiveConversation || keywordMatch;

  if (!shouldEngage) {
    console.log(
      `[FILTER] 🔇 Mensagem ignorada — Phone: ${phone} | Label: ${hasAllowedLabel} | ActiveConv: ${hasActiveConversation} | Keyword: ${keywordMatch}`,
    );
    return;
  }

  console.log(
    `[FILTER] ✅ Agente assumindo — Phone: ${phone} | Label: ${hasAllowedLabel} | Keyword: ${keywordMatch} | ActiveConv: ${hasActiveConversation}`,
  );

  // Resposta automática ao ativar via palavra-chave (apenas primeiro contato)
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

  // ESPELHO INBOX — mensagem do usuário
  try {
    await supabase.from("inbox_messages").insert({
      workspace_id: process.env.WORKSPACE_ID,
      conversation_id: conv.id,
      lead_id: lead.id,
      role: "user",
      content: text,
      sent_by: "user",
      status: "delivered",
    });
    await supabase
      .from("leads")
      .update({
        last_message_at: new Date().toISOString(),
        last_message_preview: text.slice(0, 100),
      })
      .eq("id", lead.id);
    await supabase.rpc("increment_unread", { _lead_id: lead.id });
  } catch (e) {
    console.error("[INBOX] insert user message error:", e);
  }

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

    // ESPELHO INBOX — resposta do agente
    try {
      await supabase.from("inbox_messages").insert({
        workspace_id: process.env.WORKSPACE_ID,
        conversation_id: conv.id,
        lead_id: lead.id,
        role: "assistant",
        content: agent.reply,
        sent_by: "agent",
        status: "sent",
      });
      await supabase
        .from("leads")
        .update({
          last_message_at: new Date().toISOString(),
          last_message_preview: agent.reply.slice(0, 100),
        })
        .eq("id", lead.id);
    } catch (e) {
      console.error("[INBOX] insert assistant message error:", e);
    }
  }

  // 5) Atualiza lead com dados extraídos
  if (agent.extracted) {
    const e = agent.extracted;
    await supabase
      .from("leads")
      .update({
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
      })
      .eq("id", lead.id);
  }

  // 6) Marca conversa como finalizada se status terminal
  if (["qualified", "unqualified", "partial"].includes(agent.status) && agent.should_schedule !== true) {
    await supabase.from("conversations").update({ status: "finished" }).eq("id", updated.id);
  }
}
