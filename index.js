import "dotenv/config";
import express from "express";
import pino from "pino";
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
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

const logger = pino({ level: "warn" });
const AUTH_DIR = process.env.AUTH_DIR ?? "./auth";
let sock;

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

      const text =
        m.message.conversation ??
        m.message.extendedTextMessage?.text ??
        m.message.imageMessage?.caption ??
        null;
      if (!text) continue;

      const phone = "+" + remoteJid.split("@")[0];

      try {
        await handleIncomingMessage({ phone, text }, async (reply) => {
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
