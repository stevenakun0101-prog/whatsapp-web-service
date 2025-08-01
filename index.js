require("dotenv").config();
const express = require("express");
const { Client, LocalAuth } = require("whatsapp-web.js");
const { toDataURL } = require("qrcode");
const Joi = require("joi");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

// ——— Configuration ———
const PORT = process.env.PORT || 3000;
const GROUP_NAME = process.env.GROUP_NAME || "WEB CUNGS";
const API_ENDPOINT =
  process.env.API_ENDPOINT || "http://localhost:8000/api/orders/mark-as-done";

// ——— WhatsApp Client Setup ———
let latestQR = null;
let clientReady = false;
let groupChatInstance = null;
let cachedGroupId = null;

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("qr", async (qr) => {
  latestQR = await toDataURL(qr);
  console.log("[WA-BOT] QR code received. Scan via /qr");
});

client.on("ready", async () => {
  clientReady = true;
  console.log("[WA-BOT] WhatsApp client is ready");

  try {
    const chats = await client.getChats();
    const group = chats.find((c) => c.name === GROUP_NAME);
    if (group) {
      groupChatInstance = group;
      cachedGroupId = group.id._serialized;
      console.log(`[WA-BOT] Group "${GROUP_NAME}" found and cached`);
    } else {
      console.warn(`[WA-BOT] Group "${GROUP_NAME}" not found`);
    }
  } catch (e) {
    console.error("[WA-BOT] Error fetching group chats:", e.message);
  }
});

client.on("auth_failure", (msg) => {
  console.error("[WA-BOT] AUTH FAILURE:", msg);
  clientReady = false;
  notifyGroup("⚠️ Sesi WhatsApp berakhir. Silakan scan ulang QR Code.");
  client.destroy();
  client.initialize();
});

client.on("disconnected", (reason) => {
  console.warn("[WA-BOT] Disconnected:", reason);
  clientReady = false;
  notifyGroup("⚠️ WhatsApp terputus. Mencoba menyambung kembali...");
  setTimeout(() => {
    client.destroy();
    client.initialize();
  }, 5000);
});

// ——— QR Code Endpoint ———
app.get("/qr", (req, res) => {
  if (!latestQR) return res.send("QR belum tersedia");
  res.send(`
    <html>
      <body style="display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column;">
        <h2>Scan QR WhatsApp</h2>
        <img src="${latestQR}" style="width:300px;height:300px;" />
      </body>
    </html>
  `);
});

// ——— Health Check ———
app.get("/health", (req, res) => res.send("OK"));

// ——— WhatsApp Status Check ———
app.get("/status", (req, res) => {
  res.json({
    ready: clientReady,
    groupCached: Boolean(cachedGroupId),
    info: client.info || null,
  });
});

// ——— Incoming Message Handler ———
client.on("message", async (msg) => {
  try {
    if (msg.fromMe) return;

    const chat = await msg.getChat();
    if (!chat.isGroup || chat.name !== GROUP_NAME) return;

    const match = msg.body.match(/[dD]\/(\d+)/);
    if (!match) return;

    const orderId = match[1];
    console.log(`→ Detected order ID: ${orderId}`);

    const payload = {
      order_id: orderId,
      group: GROUP_NAME,
      sender: msg.author || msg.from,
      message: msg.body,
      timestamp: msg.timestamp,
    };

    try {
      await axios.post(API_ENDPOINT, payload);
      await chat.sendMessage(`✅ Order ID ${orderId} telah diproses.`);
    } catch (err) {
      console.error(
        "[WA-BOT] API Error:",
        err.response?.data?.message || err.message
      );
    }
  } catch (err) {
    console.error("[WA-BOT] Message handler error:", err.message);
  }
});

// ——— Send Message API ———
const msgSchema = Joi.object({
  number: Joi.string()
    .pattern(/^\+?\d+$/)
    .optional(),
  groupTitle: Joi.string().optional(),
  message: Joi.string().min(1).required(),
}).xor("number", "groupTitle");

app.post("/send-message", async (req, res) => {
  const { error, value } = msgSchema.validate(req.body);
  if (error)
    return res.status(400).json({ success: false, error: error.message });

  if (!clientReady) {
    return res
      .status(503)
      .json({ success: false, error: "WhatsApp client not ready" });
  }

  const { number, groupTitle, message } = value;
  let chatId;

  try {
    if (number) {
      const normalized = number.replace(/\D/g, "");
      chatId = `${normalized}@c.us`;
    } else if (
      groupTitle?.toLowerCase() === GROUP_NAME.toLowerCase() &&
      cachedGroupId
    ) {
      chatId = cachedGroupId;
    } else {
      return res
        .status(404)
        .json({
          success: false,
          error: "Group not cached or unknown groupTitle",
        });
    }

    res.json({ success: true, to: chatId, note: "Sending in background" });

    await client.sendMessage(chatId, message);
    console.log(`✅ Message sent to ${chatId}`);
  } catch (err) {
    console.error(`❌ Failed to send message to ${chatId}:`, err.message);
  }
});

// ——— Helper: Send message to group safely ———
async function notifyGroup(text) {
  try {
    if (groupChatInstance) await groupChatInstance.sendMessage(text);
  } catch (e) {
    console.error("[WA-BOT] Failed to notify group:", e.message);
  }
}

// ——— Keep-alive ping ———
setInterval(() => {
  client.getState().catch(() => {});
}, 1000 * 60 * 5);

// ——— Start & Shutdown ———
client.initialize();

const server = app.listen(PORT, () => {
  console.log(`[WA-BOT] Server running on http://0.0.0.0:${PORT}`);
});

async function shutdown() {
  console.log("[WA-BOT] Shutting down...");
  await client.destroy();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
