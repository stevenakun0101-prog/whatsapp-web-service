require("dotenv").config();
const express = require("express");
const app = express();
const { Client, LocalAuth } = require("whatsapp-web.js");
const puppeteer = require("puppeteer");
const qrcode = require("qrcode-terminal");
const cors = require("cors");
const axios = require("axios");
const Joi = require("joi");

let latestQR = null;

// ——— Configuration ———
const PORT = process.env.PORT || 3000;
const GROUP_NAME = process.env.GROUP_NAME || "WEB CUNGS";
const API_ENDPOINT =
  process.env.API_ENDPOINT || "http://localhost:8000/api/orders/mark-as-done";

// ——— WhatsApp Client Setup ———
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

// Store group chat instance for notifications
let groupChatInstance = null;

const { toDataURL } = require("qrcode"); // install qrcode (bukan qrcode-terminal)

client.on("qr", async (qr) => {
  latestQR = await toDataURL(qr); // simpan base64 QR
  console.log("QR code received. Scan via browser at /qr");
});

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

app.get("/health", (req, res) => {
  res.send("OK");
});

client.on("ready", async () => {
  console.log("WhatsApp client is ready");
  try {
    const chats = await client.getChats();
    groupChatInstance = chats.find((c) => c.name === GROUP_NAME) || null;
    if (!groupChatInstance) {
      console.warn(`Group "${GROUP_NAME}" not found on ready.`);
    }
  } catch (e) {
    console.error("Error fetching chats on ready:", e.message);
  }
});

// ——— Keep-alive (heartbeat) ———
// Kirim ping berkala untuk menjaga koneksi tidak idle
setInterval(() => {
  client.getState().catch(() => {
    // ignore errors
  });
}, 1000 * 60 * 5); // setiap 5 menit

// Handle authentication failure (session expired)
client.on("auth_failure", async (msg) => {
  console.error("AUTH FAILURE:", msg);
  if (groupChatInstance) {
    try {
      await groupChatInstance.sendMessage(
        "⚠️ Sesi WhatsApp telah berakhir. Silakan scan ulang QR Code."
      );
    } catch (e) {
      console.error("Failed to notify group on auth failure:", e.message);
    }
  }
  // Re-initialize to prompt new QR
  client.destroy();
  client.initialize();
});

// Handle disconnection
client.on("disconnected", async (reason) => {
  console.warn("WhatsApp disconnected:", reason);
  if (groupChatInstance) {
    try {
      await groupChatInstance.sendMessage(
        "⚠️ WhatsApp terputus. Mencoba menyambung kembali..."
      );
    } catch (e) {
      console.error("Failed to notify group on disconnected:", e.message);
    }
  }
  // Attempt reconnection after short delay
  setTimeout(() => {
    client.destroy();
    client.initialize();
  }, 5000);
});

// ——— Event-driven Incoming Message Handler ———
client.on("message", async (msg) => {
  try {
    if (msg.fromMe) return;

    // Get the chat object
    const chat = await msg.getChat();
    if (!chat.isGroup || chat.name !== GROUP_NAME) return;

    // Match pattern d/123 or D/123
    const match = msg.body.match(/[dD]\/(\d+)/);
    if (!match) return;

    const orderId = match[1];
    console.log(`→ Found orderId: ${orderId}`);

    const payload = {
      order_id: orderId,
      group: GROUP_NAME,
      sender: msg.author || msg.from,
      message: msg.body,
      timestamp: msg.timestamp,
    };

    // Send to API
    try {
      await axios.post(API_ENDPOINT, payload);
    } catch (err) {
      const errMsg = err.response?.data?.message || err.message;
      console.error("API Error:", errMsg);
      return;
    }

    // Send confirmation back to group
    await chat.sendMessage(`Order dengan ID ${orderId} telah sukses.`);
  } catch (err) {
    console.error("Error processing incoming message:", err.message);
  }
});

// Initialize WhatsApp client
client.initialize();

// ——— Express App & Routes ———
app.use(cors());
app.use(express.json());

// Validation schema for send-message
const msgSchema = Joi.object({
  number: Joi.string()
    .pattern(/^\+?\d+$/)
    .optional(),
  groupTitle: Joi.string().optional(),
  message: Joi.string().min(1).required(),
}).xor("number", "groupTitle");

app.post("/send-message", async (req, res) => {
  const { error, value } = msgSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ success: false, error: error.message });
  }

  const { number, groupTitle, message } = value;
  try {
    let chatId;

    if (number) {
      const normalized = number.replace(/\D/g, "");
      chatId = `${normalized}@c.us`;
    } else {
      const chats = await client.getChats();
      const chat = chats.find((c) => c.name === groupTitle);
      if (!chat) {
        return res
          .status(404)
          .json({ success: false, error: "Group not found" });
      }
      chatId = chat.id._serialized;
    }

    await client.sendMessage(chatId, message);
    res.json({ success: true, to: chatId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// ——— Graceful Shutdown ———
async function shutdown() {
  console.log("Shutting down...");
  await client.destroy();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
