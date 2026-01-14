require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");

const app = express();

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const client = new line.Client(config);

// ✅ จุดรับ webhook จาก LINE
app.post("/line/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  // รับเฉพาะข้อความ text
  if (event.type !== "message" || event.message.type !== "text") return null;

  const text = (event.message.text || "").trim().toLowerCase();

  if (text.includes("rsvp")) {
    return client.replyMessage(event.replyToken, flexRSVP());
  }

  // default: ส่งเมนู
  return client.replyMessage(event.replyToken, flexMenu());
}

// ===== Flex ตัวอย่าง (คุณเปลี่ยนเป็น JSON ของคุณได้ทีหลัง) =====
function flexMenu() {
  return {
    type: "flex",
    altText: "AVOLT Wedding Menu",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "AVOLT Wedding", weight: "bold", size: "xl" },
          {
            type: "text",
            text: "พิมพ์: rsvp เพื่อรับลิงก์ RSVP",
            wrap: true,
            color: "#666666",
          },
          {
            type: "button",
            style: "primary",
            action: { type: "message", label: "RSVP", text: "rsvp" },
          },
        ],
      },
    },
  };
}

function flexRSVP() {
  return {
    type: "flex",
    altText: "RSVP",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "RSVP", weight: "bold", size: "xl" },
          {
            type: "text",
            text: "กดปุ่มเพื่อไปหน้า RSVP บนเว็บไซต์",
            wrap: true,
            color: "#666666",
          },
          {
            type: "button",
            style: "primary",
            action: {
              type: "uri",
              label: "Open RSVP",
              uri: "https://avoltwedding.worshipnight.life/",
            },
          },
        ],
      },
    },
  };
}

// หน้าเช็กว่าเซิร์ฟเวอร์รันอยู่
app.get("/", (_, res) => res.send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port", port));
