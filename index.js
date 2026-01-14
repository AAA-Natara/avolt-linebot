"use strict";

const express = require("express");
const line = require("@line/bot-sdk");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

dotenv.config();

const app = express();

/**
 * ENV REQUIRED:
 * LINE_CHANNEL_SECRET
 * LINE_CHANNEL_ACCESS_TOKEN
 * SUPABASE_URL
 * SUPABASE_SERVICE_ROLE_KEY
 */
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

if (!LINE_CHANNEL_SECRET || !LINE_CHANNEL_ACCESS_TOKEN) {
  console.error("Missing LINE env vars. Please set LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN");
}

const config = {
  channelSecret: LINE_CHANNEL_SECRET,
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
};

const client = new line.Client(config);

// Supabase (service role)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ========== Flex JSON loader ==========
function loadJson(relPath) {
  const full = path.join(__dirname, relPath);
  const raw = fs.readFileSync(full, "utf8");
  return JSON.parse(raw);
}

function flexMessage(altText, bubbleJson) {
  return {
    type: "flex",
    altText,
    contents: bubbleJson,
  };
}

// แก้ชื่อไฟล์ให้ตรงกับที่คุณมีจริง
const FLEX = {
  wedding: () => loadJson("flex/bubbles/event_details.json"),
  travel: () => loadJson("flex/bubbles/travel.json"),
  blessing: () => loadJson("flex/bubbles/blessing.json"),
  confirm: () => loadJson("flex/bubbles/confirm.json"),
};

// ========== In-memory session (คุยถามชื่อ/จำนวน/อวยพร) ==========
/**
 * sessions Map:
 * userId -> { step: "ASK_NAME"|"ASK_COUNT"|"ASK_BLESSING", temp: {...} }
 */
const sessions = new Map();

// ========== Supabase helpers ==========
async function getRsvp(userId) {
  const { data, error } = await supabase
    .from("rsvps")
    .select("user_id, full_name, guests_count")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data; // null ถ้าไม่มี
}

async function upsertRsvp(userId, fullName, guestsCount) {
  const { data, error } = await supabase
    .from("rsvps")
    .upsert(
      {
        user_id: userId,
        full_name: fullName,
        guests_count: guestsCount,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function insertBlessing(userId, message) {
  const { data, error } = await supabase
    .from("blessings")
    .insert([{ user_id: userId, message }])
    .select()
    .single();

  if (error) throw error;
  return data;
}

// ========== Debug routes ==========
app.get("/", (req, res) => res.send("OK"));

app.get("/test-db", async (req, res) => {
  try {
    const hasUrl = !!process.env.SUPABASE_URL;
    const hasKey = !!process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!hasUrl || !hasKey) {
      return res.status(500).json({
        ok: false,
        env: {
          SUPABASE_URL: hasUrl ? "SET" : "MISSING",
          SUPABASE_SERVICE_ROLE_KEY: hasKey ? "SET" : "MISSING",
        },
      });
    }

    const { data, error } = await supabase.from("rsvps").select("*").limit(5);
    if (error) return res.status(500).json({ ok: false, error });

    return res.json({ ok: true, rows: data });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || String(e) });
  }
});

// ========== LINE webhook ==========
app.post("/line/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).end();
  }
});

function normalizeText(t) {
  return (t || "").trim();
}

function isNumberLike(text) {
  // รับทั้ง "2", "2คน", "2 คน", "สอง" (ไม่รองรับคำไทยแบบหนึ่งสองในเวอร์ชันนี้)
  const m = text.match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  if (Number.isNaN(n)) return null;
  return n;
}

async function handleEvent(event) {
  // สนใจเฉพาะข้อความ
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source && event.source.userId;
  const text = normalizeText(event.message.text);

  // ถ้าไม่มี userId (บางกรณีในบาง source) ให้ตอบแบบเบาๆ
  if (!userId) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "ขออภัย ระบบอ่าน userId ไม่ได้ ลองพิมพ์ใหม่ในแชทส่วนตัวกับบอทอีกครั้งนะคะ",
    });
  }

  // ===== 1) ถ้ามี session ค้างอยู่ ให้ทำตาม step ก่อน =====
  const sess = sessions.get(userId);
  if (sess) {
    // ASK_NAME
    if (sess.step === "ASK_NAME") {
      const fullName = text;
      if (fullName.length < 2) {
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "ขอชื่อ-นามสกุลอีกครั้งได้ไหมคะ (เช่น Natara Thawattara)",
        });
      }
      sess.temp.fullName = fullName;
      sess.step = "ASK_COUNT";
      sessions.set(userId, sess);

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "มาทั้งหมดกี่คนคะ? (รวมตัวเอง) เช่น 1, 2, 3",
      });
    }

    // ASK_COUNT
    if (sess.step === "ASK_COUNT") {
      const n = isNumberLike(text);
      if (!n || n < 1 || n > 50) {
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "รบกวนพิมพ์เป็นตัวเลขนะคะ (รวมตัวเอง) เช่น 1,2",
        });
      }

      const saved = await upsertRsvp(userId, sess.temp.fullName, n);
      sessions.delete(userId);

      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          `ขอบคุณที่ยืนยันนะคะ 🤍 เราจะเตรียมที่นั่ง/การต้อนรับตามจำนวนนี้ค่ะ ✅\n` +
          `ชื่อ: ${saved.full_name}\n` +
          `จำนวน: ${saved.guests_count} คน\n\n` +
          `พิมพ์ดูข้อมูลได้เลย:\n` +
          `- รายละเอียดงาน\n` +
          `- การเดินทาง\n` +
          `- คำอวยพร`,
      });
    }

    // ASK_BLESSING
    if (sess.step === "ASK_BLESSING") {
      const msg = text;
      if (msg.length < 2) {
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "พิมพ์คำอวยพรอีกครั้งได้ไหมคะ 🤍",
        });
      }

      await insertBlessing(userId, msg);
      sessions.delete(userId);

      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "รับคำอวยพรเรียบร้อยแล้วค่ะ 🥺🤍\nขอบคุณมากจริง ๆ นะคะ\n\n" +
          "พระเจ้าอวยพรนะคะ",
      });
    }
  }

  // ===== 2) คำสั่งหลัก =====

  // รายละเอียดงาน
 if (text === "รายละเอียดงาน") {
    const bubble = FLEX.wedding();
    return client.replyMessage(event.replyToken, flexMessage("รายละเอียดงาน", bubble));
  }


  // การเดินทาง
  if (text === "การเดินทาง" || text.toLowerCase() === "travel") {
    const bubble = FLEX.travel();
    return client.replyMessage(event.replyToken, flexMessage("การเดินทาง", bubble));
  }

  // คำอวยพร (โชว์การ์ด)
  if (text === "คำอวยพร") {
    const bubble = FLEX.blessing();
    return client.replyMessage(event.replyToken, flexMessage("ฝากคำอวยพร", bubble));
  }

  // กดปุ่ม "อวยพร" ในการ์ด -> เริ่มรับข้อความอวยพร
  if (text === "อวยพร") {
    sessions.set(userId, { step: "ASK_BLESSING", temp: {} });
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "พิมพ์คำอวยพรของคุณได้เลยนะคะ 🤍 (ส่งมาเป็น 1 ข้อความได้เลย)",
    });
  }

  // ยืนยันมาร่วมงาน (โชว์การ์ด)
  if (text === "ยืนยันมาร่วมงาน" || text === "rsvp" || text.toLowerCase() === "rsvp") {
    const bubble = FLEX.confirm();
    return client.replyMessage(event.replyToken, flexMessage("ยืนยันมาร่วมงาน", bubble));
  }

  // เริ่ม flow RSVP (จากปุ่มในการ์ด)
  if (text === "ยืนยัน เจอกันแน่นอน" || text === "ยืนยันเจอกันแน่นอน") {
    const existing = await getRsvp(userId);
    if (existing) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          `คุณยืนยันมาแล้วค่ะ ✅\n` +
          `ชื่อ: ${existing.full_name}\n` +
          `จำนวน: ${existing.guests_count} คน\n\n` +
          `หากมีเหตุจำเป็นที่ต้องเปลี่ยนแปลง รบกวนพิมพ์ ‘แก้ไขการยืนยัน’ หรือทักเราในแชทนี้ได้เลยนะคะ`,
      });
    }

    sessions.set(userId, { step: "ASK_NAME", temp: {} });
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "ขอชื่อ-นามสกุลเพื่อยืนยันการมาร่วมงาน",
    });
  }

  // แก้ไข RSVP
  if (text === "แก้ไขการยืนยัน") {
    sessions.set(userId, { step: "ASK_NAME", temp: {} });
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "ได้เลยค่ะ ✨ ขอชื่อ-นามสกุลใหม่อีกครั้งนะคะ",
    });
  }

  // help เบา ๆ
  if (text === "help" || text === "ช่วยเหลือ" || text === "เมนู") {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "พิมพ์คำสั่งได้เลยค่ะ:\n" +
        "- รายละเอียดงาน\n" +
        "- การเดินทาง\n" +
        "- ยืนยันมาร่วมงาน\n" +
        "- คำอวยพร",
    });
  }

  // ไม่ match อะไร -> ไม่ตอบก็ได้ หรือจะตอบเบา ๆ
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "พิมพ์ “เมนู” เพื่อดูคำสั่งทั้งหมดได้นะคะ 🤍",
  });
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
