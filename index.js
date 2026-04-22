import "dotenv/config";
import express from "express";
import pino from "pino";
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import { publishQr, publishConnected, publishDisconnected, ping } from "./qr-handler.js";
import { handleIncomingMessage } from "./message-handler.js";

const REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "WORKSPACE_ID", "CHAT_AGENT_URL"];
for (const v of REQUIRED) {
  if (!process.env[v]) {
    console.error(`❌ Missing required env var: ${v}`);
    process.exit(1);
  }
}

// URL da função de transcrição (derivada do CHAT_AGENT_URL trocando o nome).
// Pode ser sobrescrita via env TRANSCRIBE_AUDIO_URL.
const TRANSCRIBE_AUDIO_URL =
  process.env.TRANSCRIBE_AUDIO_URL ??
  process.env.CHAT_AGENT_URL.replace(/\/chat-agent\/?$/, "/transcribe-audio");
console.log("[ENV] TRANSCRIBE_AUDIO_URL:", TRANSCRIBE_AUDIO_URL);

console.log('[ENV] SUPABASE_URL:', process.env.SUPABASE_URL ? '✅ definida' : '❌ ausente');
console.log('[ENV] SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? '✅ definida' : '❌ ausente');
console.log('[ENV] WORKSPACE_ID:', process.env.WORKSPACE_ID ? '✅ definida' : '❌ ausente');
console.log('[ENV] CHAT_AGENT_URL:', process.env.CHAT_AGENT_URL ? '✅ definida' : '❌ ausente');

const logger = pino({ level: "warn" });
const AUTH_DIR = process.env.AUTH_DIR ?? "./auth";
export let sock;

function unwrapMessageContent(message) {
  let current = message;

  while (current) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
      continue;
    }
    if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
      continue;
    }
    if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
      continue;
    }
    if (current.viewOnceMessageV2Extension?.message) {
      current = current.viewOnceMessageV2Extension.message;
      continue;
    }
    if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
      continue;
    }
    return current;
  }

  return message;
}

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`🚀 Starting Baileys v${version.join(".")}`);

  sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: false,
    browser: ["LeadPilot", "Chrome", "1.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try { await publishQr(qr); } catch (e) { console.error("[QR] publish error", e); }
    }

    if (connection === "open") {
      const phone = sock.user?.id?.split(":")[0] ?? null;
      try { await publishConnected(phone); } catch (e) { console.error("[CONN] publish error", e); }
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`[CONN] closed (code=${code}). reconnect=${shouldReconnect}`);
      try { await publishDisconnected(); } catch (e) { console.error("[CONN] publish error", e); }
      if (shouldReconnect) setTimeout(startSocket, 2000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;
      const remoteJid = m.key.remoteJid;
      // Ignora grupos e status
      if (!remoteJid || remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") continue;

      const content = unwrapMessageContent(m.message);

      let text =
        content.conversation ??
        content.extendedTextMessage?.text ??
        content.imageMessage?.caption ??
        null;

      // Se for mensagem de áudio (voice note ou áudio enviado), transcreve
      // antes de seguir o fluxo normal.
      const audioMsg = content.audioMessage;
      if (!text && audioMsg) {
        try {
          console.log(`[AUDIO] ← ${remoteJid} (${audioMsg.seconds ?? "?"}s, ${audioMsg.mimetype ?? "audio/ogg"})`);
          const mediaMessage = { ...m, message: content };
          const buffer = await downloadMediaMessage(mediaMessage, "buffer", {}, {
            logger,
            reuploadRequest: (msg) => sock.updateMediaMessage(msg),
          });
          const audio_base64 = buffer.toString("base64");
          const mime_type = audioMsg.mimetype?.split(";")[0] ?? "audio/ogg";

          const resp = await fetch(TRANSCRIBE_AUDIO_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            },
            body: JSON.stringify({
              workspace_id: process.env.WORKSPACE_ID,
              audio_base64,
              mime_type,
              language_hint: "pt-BR",
            }),
          });

          if (!resp.ok) {
            console.error(`[AUDIO] transcribe-audio ${resp.status}: ${await resp.text()}`);
            continue;
          }
          const data = await resp.json();
          text = (data?.text ?? "").trim();
          if (!text) {
            console.log("[AUDIO] transcrição vazia, ignorando");
            continue;
          }
          console.log(`[AUDIO] transcrito: ${text.slice(0, 120)}${text.length > 120 ? "…" : ""}`);
        } catch (e) {
          console.error("[AUDIO] erro ao transcrever:", e);
          continue;
        }
      }

      if (!text) continue;

      const phone = "+" + remoteJid.split("@")[0];
      const messageId = m.key.id;

      try {
        await handleIncomingMessage({ phone, text, remoteJid, messageId }, async (reply) => {
          await sock.sendMessage(remoteJid, { text: reply });
          console.log(`[MSG] → ${phone}: ${reply}`);
        });
      } catch (e) {
        console.error("[HANDLER] error:", e);
      }
    }
  });
}

// Heartbeat: atualiza last_ping a cada 30s
setInterval(() => {
  ping().catch(() => {});
}, 30_000);

// API HTTP minimalista
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    workspace_id: process.env.WORKSPACE_ID,
    connected: !!sock?.user,
    user: sock?.user?.id ?? null,
  });
});

app.post("/reconnect", async (_req, res) => {
  try { await sock?.logout(); } catch {}
  setTimeout(startSocket, 1000);
  res.json({ status: "reconnecting" });
});

app.post("/send", async (req, res) => {
  const { phone, text } = req.body ?? {};
  if (!phone || !text) return res.status(400).json({ error: "phone and text are required" });
  try {
    const jid = `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text });
    res.json({ status: "sent" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const PORT = Number(process.env.PORT ?? 3333);
app.listen(PORT, () => console.log(`🌐 HTTP listening on :${PORT}`));

startSocket().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
