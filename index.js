/**
 * AVOLT LINE Bot (no database version)
 * - Loads 4 bubble JSON files and wraps them into Flex messages
 * - RSVP flow: ask full name + guest count, store in memory
 * - Blessing flow: ask blessing text, store in memory
 *
 * NOTE: In-memory data will be lost if server restarts (Render redeploy/restart).
 */

require("dotenv").config();

const express = require("express");
const { Client, middleware } = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");

// -------------------- LINE Config --------------------
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(config);

// -------------------- App --------------------
const app = express();

app.get("/", (_, res) => res.status(200).send("OK"));

app.post("/line/webhook", middleware(config), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).end();
  }
});

// -------------------- Flex helpers --------------------
function bubbleFromFile(filename) {
  const filePath = path.join(__dirname, "flex", "bubbles", filename);
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function flexWrap(bubble, altText) {
  return { type: "flex", altText, contents: bubble };
}

// -------------------- In-memory storage --------------------
// RSVP saved by userId
// { fullName: string, guestsCount: number, updatedAt: ISO string }
const rsvpStore = new Map();

// Blessings saved by userId (array of messages)
const blessingStore = new Map();

// Conversation sessions (multi-step)
const sessions = new Map();
// sessions.set(userId, { step: "ASK_NAME" | "ASK_COUNT" | "ASK_BLESSING", fullName?: string })

// -------------------- Utilities --------------------
function isNumberInRange(n, min, max) {
  return Number.isFinite(n) && n >= min && n <= max;
}

function normalizeText(t) {
  return (t || "").trim();
}

// -------------------- Main handler --------------------
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return null;

  const userId = event.source?.userId || null;
  const text = normalizeText(event.message.text);

  // If we can't identify userId, we can still send flex info,
  // but cannot do RSVP/blessing saving.
  const canSave = Boolean(userId);

  // -------------------- 1) Continue session if ongoing --------------------
  const sess = canSave ? sessions.get(userId) : null;

  // ASK_NAME -> save full name then ask count
  if (sess?.step === "ASK_NAME") {
    const fullName = text;

    if (fullName.length < 3) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "ขอชื่อ-สกุลแบบเต็ม ๆ อีกครั้งได้ไหมคะ 😊",
      });
    }

    sessions.set(userId, { step: "ASK_COUNT", fullName });
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "ขอบคุณค่ะ 💗\nมาทั้งหมดกี่คนคะ? (ใส่ “จำนวนรวมตัวเอง” เช่น 1, 2, 3)",
    });
  }

  // ASK_COUNT -> parse number, store RSVP
  if (sess?.step === "ASK_COUNT") {
    const n = parseInt(text, 10);

    if (!isNumberInRange(n, 1, 20)) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "พิมพ์เป็นตัวเลข 1–20 ได้ไหมคะ เช่น 1 หรือ 2 😊",
      });
    }

    rsvpStore.set(userId, {
      fullName: sess.fullName,
      guestsCount: n,
      updatedAt: new Date().toISOString(),
    });
    sessions.delete(userId);

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        `ยืนยันเรียบร้อยแล้วค่ะ ✅\n` +
        `ชื่อ: ${sess.fullName}\n` +
        `จำนวน: ${n} คน\n\n` +
        `ดูรายละเอียดงานพิมพ์: รายละเอียดงาน\n` +
        `ดูการเดินทางพิมพ์: การเดินทาง\n` +
        `ฝากคำอวยพรพิมพ์: คำอวยพร`,
    });
  }

  // ASK_BLESSING -> store blessing message
  if (sess?.step === "ASK_BLESSING") {
    const msg = text;

    if (msg.length < 2) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "ส่งคำอวยพรอีกครั้งได้ไหมคะ 😊",
      });
    }

    const arr = blessingStore.get(userId) || [];
    arr.push({ message: msg, createdAt: new Date().toISOString() });
    blessingStore.set(userId, arr);
    sessions.delete(userId);

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "รับคำอวยพรเรียบร้อยแล้วค่ะ 🥺🤍\nขอบคุณมากจริง ๆ นะคะ\n\n" +
        "ดูรายละเอียดงานพิมพ์: รายละเอียดงาน\n" +
        "ยืนยันมาร่วมงานพิมพ์: ยืนยันมาร่วมงาน",
    });
  }

  // -------------------- 2) Flex commands (โหลดจากไฟล์) --------------------
  if (text.includes("รายละเอียดงาน")) {
    return client.replyMessage(
      event.replyToken,
      flexWrap(bubbleFromFile("event_details.json"), "รายละเอียดงานแต่งงาน")
    );
  }

  if (text.includes("การเดินทาง")) {
    return client.replyMessage(
      event.replyToken,
      flexWrap(bubbleFromFile("travel.json"), "การเดินทาง")
    );
  }

  // “คำอวยพร” = แสดงการ์ดเชิญอวยพร (ปุ่มในนั้นส่งคำว่า "อวยพร")
  if (text.includes("คำอวยพร") || text.includes("ฝากคำอวยพร")) {
    return client.replyMessage(
      event.replyToken,
      flexWrap(bubbleFromFile("blessing.json"), "ฝากคำอวยพรให้เรา")
    );
  }

  // “ยืนยันมาร่วมงาน” = แสดงการ์ด confirm (ปุ่มในนั้นส่ง "ยืนยัน เจอกันแน่นอน")
  if (text.includes("ยืนยันมาร่วมงาน")) {
    return client.replyMessage(
      event.replyToken,
      flexWrap(bubbleFromFile("confirm.json"), "ยืนยันมาร่วมงาน")
    );
  }

  // -------------------- 3) Start flows --------------------
  // Start blessing flow (user presses button "อวยพร")
  if (text === "อวยพร" || text.includes("เขียนอวยพร")) {
    if (!canSave) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "ขออนุญาตให้พิมพ์คำอวยพรในแชทส่วนตัวกับบอทนะคะ 😊",
      });
    }

    sessions.set(userId, { step: "ASK_BLESSING" });
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "พิมพ์คำอวยพรให้เราได้เลยนะคะ 🤍\n(ส่งมา 1 ข้อความยาว ๆ ได้เลย)",
    });
  }

  // Start RSVP flow (user presses button "ยืนยัน เจอกันแน่นอน")
  const startConfirm =
    text === "ยืนยัน" ||
    text.includes("ยืนยัน เจอกันแน่นอน") ||
    text.includes("ยืนยันการมาร่วมงาน") ||
    text.includes("กดยืนยัน");

  if (startConfirm) {
    if (!canSave) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "ขออนุญาตให้ยืนยันในแชทส่วนตัวกับบอทนะคะ 😊",
      });
    }

    const existing = rsvpStore.get(userId);
    if (existing) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          `คุณยืนยันมาแล้วค่ะ ✅\n` +
          `ชื่อ: ${existing.fullName}\n` +
          `จำนวน: ${existing.guestsCount} คน\n\n` +
          `ถ้าต้องการแก้ไข พิมพ์: แก้ไขการยืนยัน`,
      });
    }

    sessions.set(userId, { step: "ASK_NAME" });
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "ขอบคุณที่มาร่วมงานนะคะ 💗\nขอชื่อ-สกุลของคุณหน่อยค่ะ",
    });
  }

  // Edit RSVP
  if (text.includes("แก้ไขการยืนยัน")) {
    if (!canSave) return null;

    sessions.set(userId, { step: "ASK_NAME" });
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "ได้เลยค่ะ ✨\nขอชื่อ-สกุลใหม่ของคุณหน่อยค่ะ",
    });
  }

  // -------------------- 4) Default help --------------------
  return client.replyMessage(event.replyToken, {
    type: "text",
    text:
      "พิมพ์คำสั่งได้เลยค่ะ 😊\n" +
      "- รายละเอียดงาน\n" +
      "- การเดินทาง\n" +
      "- คำอวยพร\n" +
      "- ยืนยันมาร่วมงาน",
  });
}

// -------------------- Start server --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
