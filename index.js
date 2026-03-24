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
  console.error(
    "Missing LINE env vars. Please set LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN"
  );
}

const config = {
  channelSecret: LINE_CHANNEL_SECRET,
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
};

const client = new line.Client(config);

// Supabase (service role)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing Supabase env vars. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"
  );
}

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

// IMPORTANT: ชื่อไฟล์ต้องตรงจริงในโปรเจกต์
// (กันพลาด) ถ้าเคยตั้งชื่อไฟล์ไม่เหมือนกัน ให้ระบบลองชื่อสำรองให้ด้วย
function loadJsonWithFallback(primaryRelPath, fallbackRelPaths = []) {
  try {
    return loadJson(primaryRelPath);
  } catch (e1) {
    for (const rel of fallbackRelPaths) {
      try {
        return loadJson(rel);
      } catch (e2) {
        // try next
      }
    }
    throw e1;
  }
}

// IMPORTANT: ชื่อไฟล์ต้องตรงจริงในโปรเจกต์
const FLEX = {
  // event_details.json เคยใช้มาก่อน เลยใส่ fallback กันเงียบ
  wedding: () =>
    loadJsonWithFallback("flex/bubbles/wedding_details.json", [
      "flex/bubbles/event_details.json",
    ]),
  travel: () => loadJsonWithFallback("flex/bubbles/travel.json"),
  blessing: () => loadJsonWithFallback("flex/bubbles/blessing.json"),
  confirm: () => loadJsonWithFallback("flex/bubbles/confirm.json"),
  gift: () => loadJsonWithFallback("flex/bubbles/gift.json"),
};

// ========== In-memory session ==========
/**
 * sessions Map:
 * userId -> { step: "ASK_NAME"|"ASK_COUNT"|"ASK_BLESSING"|"ASK_GIFT_SLIP", temp: {...} }
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
  const m = (text || "").match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  if (Number.isNaN(n)) return null;
  return n;
}

const BEACON_HWID = process.env.BEACON_HWID || "00000ac97b";

const beaconSentMap = new Map();

function canSendBeacon(userId) {
  const last = beaconSentMap.get(userId);
  if (!last) return true;
  return (Date.now() - last) > 1000;
}


async function handleEvent(event) {



  // ─── BEACON EVENT ───
  if (event.type === "beacon") {
    const userId = event.source?.userId;
    if (!userId) return;
    if (event.beacon.hwid !== BEACON_HWID) return;
    if (event.beacon.type !== "enter") return;
    if (!canSendBeacon(userId)) {
      console.log(`[BEACON] ${userId} — skip`);
      return;
    }
    beaconSentMap.set(userId, Date.now());
    try {
      const profile = await client.getProfile(userId);
const firstName = profile.displayName;
 await client.pushMessage(userId, {
  type: "text",
  text:
    `ยินดีต้อนรับสู่ AVOLT Homeee \n
     คุณ ${firstName} ✨\n\n\n\n` +
    `WiFi: WorshipHome\n` +
    `Password: PRAISE247\n\n` +
    `น้ำอยู่ในตู้เย็น เดินไปหยิบได้เลยนะคะ\n\n` +
    `บนตู้ทีวีมี\n` +
    `   · PS5\n` +
    `   · Nintendo\n` +
    `   · Board games\n` +
    `อยากเล่นไรหยิบมาได้เลย อย่าปาทิ้งก็พอ 55555 \n\n\n\n` +
    `✨ "เหตุฉะนั้น จงต้อนรับกันและกัน เหมือนอย่างที่พระคริสต์ทรงรับพวกท่าน เพื่อเป็นการถวายพระเกียรติแด่พระเจ้า" — โรม 15:7\n\n` +
    ` 🤍`,
});
      console.log(`[BEACON] Welcome → ${firstName}`);
    } catch (err) {
      console.error("[BEACON] Error:", err.message);
    }
    return;
  }

  if (event.type !== "message") return;

  const userId = event.source && event.source.userId;
  if (!userId) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "ขออภัย ระบบอ่าน userId ไม่ได้ ลองพิมพ์ใหม่ในแชทส่วนตัวกับบอทอีกครั้งนะคะ",
    });
  }

  const msgType = event.message.type; // "text" | "image" | "file" | ...
  const text = msgType === "text" ? normalizeText(event.message.text) : "";

  // ===== 1) ถ้ามี session ค้างอยู่ ให้ทำตาม step ก่อน =====
  const sess = sessions.get(userId);

  // --- โหมดรอรับสลิป (ของขวัญ) ---
  if (sess && sess.step === "ASK_GIFT_SLIP") {
    if (msgType === "image" || msgType === "file") {
      sessions.delete(userId);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          "ขอบคุณสำหรับของขวัญมาก ๆ นะคะ 🤍\n" +
          "ทางเรารับสลิปเรียบร้อยแล้วค่ะ\n\n" +
          "พระเจ้าอวยพรนะคะ",
      });
    }

    // ถ้าส่งเป็นข้อความมาแทน
    if (msgType === "text") {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "แนบสลิปเป็น “รูปภาพ” หรือ “ไฟล์” ได้เลยนะคะ 🤍",
      });
    }

    return; // message type อื่น ๆ ปล่อยผ่าน
  }

  // ถ้าไม่ใช่ข้อความ และไม่ได้อยู่ในโหมดรอรับสลิป -> ไม่ต้องตอบ
  if (msgType !== "text") return;

  // --- โหมดเก็บ RSVP / Blessing ---
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
          text: "รบกวนพิมพ์เป็นตัวเลข 1–50 นะคะ (รวมตัวเอง) เช่น 2",
        });
      }

      const saved = await upsertRsvp(userId, sess.temp.fullName, n);
      sessions.delete(userId);

      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          `ขอบคุณที่ยืนยันนะคะ 🤍 \n`+
          `เราจะเตรียมที่นั่ง/การต้อนรับ ✅\n` +
          `ชื่อ: ${saved.full_name}\n` +
          `จำนวน: ${saved.guests_count} คน\n\n` +
          `พิมพ์ดูข้อมูลได้เลย:\n` +
          `- รายละเอียดงาน\n` +
          `- การเดินทาง\n` +
          `- คำอวยพร\n` +
          `- ของขวัญ`,
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
        text: "รับคำอวยพรเรียบร้อยแล้วค่ะ 🥺🤍\nขอบคุณมากจริง ๆ นะคะ\n\nพระเจ้าอวยพรนะคะ",
      });
    }
  }

  // ===== 2) คำสั่งหลัก (ข้อความ) =====

  // รายละเอียดงาน
  if (text === "รายละเอียดงาน" || text === "รายละเอียดงานแต่งงาน") {
    try {
      const bubble = FLEX.wedding();
      return client.replyMessage(
        event.replyToken,
        flexMessage("รายละเอียดงานแต่งงาน", bubble)
      );
    } catch (e) {
      console.error("Flex wedding load error:", e);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "ขออภัยค่ะ ตอนนี้เปิดรายละเอียดงานไม่ได้ (ไฟล์ Flex อาจยังไม่ถูกต้อง) 🙏",
      });
    }
  }

  // การเดินทาง
  if (text === "การเดินทาง" || text.toLowerCase() === "travel") {
    try {
      const bubble = FLEX.travel();
      return client.replyMessage(event.replyToken, flexMessage("การเดินทาง", bubble));
    } catch (e) {
      console.error("Flex travel load error:", e);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "ขออภัยค่ะ ตอนนี้เปิดการเดินทางไม่ได้ 🙏",
      });
    }
  }

  // คำอวยพร (โชว์การ์ด)
  if (text === "คำอวยพร") {
    try {
      const bubble = FLEX.blessing();
      return client.replyMessage(event.replyToken, flexMessage("ฝากคำอวยพร", bubble));
    } catch (e) {
      console.error("Flex blessing load error:", e);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "ขออภัยค่ะ ตอนนี้เปิดการ์ดคำอวยพรไม่ได้ 🙏",
      });
    }
  }

  // กดปุ่ม "อวยพร"
  if (text === "อวยพร") {
    sessions.set(userId, { step: "ASK_BLESSING", temp: {} });
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "พิมพ์คำอวยพรของคุณได้เลยนะคะ 🤍 (ส่งมาเป็น 1 ข้อความได้เลย)",
    });
  }

  // ยืนยันมาร่วมงาน (โชว์การ์ด)
  if (text === "ยืนยันมาร่วมงาน" || text.toLowerCase() === "rsvp") {
    try {
      const bubble = FLEX.confirm();
      return client.replyMessage(event.replyToken, flexMessage("ยืนยันมาร่วมงาน", bubble));
    } catch (e) {
      console.error("Flex confirm load error:", e);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "ขออภัยค่ะ ตอนนี้เปิดการ์ดยืนยันมาร่วมงานไม่ได้ 🙏",
      });
    }
  }

  // เริ่ม flow RSVP (จากปุ่ม)
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

  // ของขวัญ (โชว์การ์ด QR)
  if (text === "ของขวัญ" || text.toLowerCase() === "gift") {
    try {
      const bubble = FLEX.gift();
      return client.replyMessage(event.replyToken, flexMessage("ของขวัญ", bubble));
    } catch (e) {
      console.error("Flex gift load error:", e);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "ขออภัยค่ะ ตอนนี้เปิดการ์ดของขวัญไม่ได้ 🙏",
      });
    }
  }

  // กดปุ่มแนบสลิป (มาจาก gift.json)
  // NOTE: รองรับหลายข้อความ เพราะบางคนตั้ง label/uri ต่างกัน เช่น "แนบ Payslip"
  const tLower = text.toLowerCase();
  const isPaySlipTrigger =
    text === "แนบสลิป / Pay Slip" ||
    text === "แนบ Payslip" ||
    text === "แนบ payslip" ||
    text === "แนบสลิป" ||
    tLower === "pay slip" ||
    tLower === "payslip" ||
    (tLower.includes("แนบ") && (tLower.includes("slip") || tLower.includes("payslip")));

  if (isPaySlipTrigger) {
    sessions.set(userId, { step: "ASK_GIFT_SLIP", temp: {} });
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "ได้เลยค่ะ 🤍 แนบสลิปเป็นรูปภาพหรือไฟล์เข้ามาในแชทนี้ได้เลยนะคะ",
    });
  }

  // help
  if (text === "help" || text === "ช่วยเหลือ" || text === "เมนู") {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        "พิมพ์คำสั่งได้เลยค่ะ:\n" +
        "- รายละเอียดงาน\n" +
        "- การเดินทาง\n" +
        "- ยืนยันมาร่วมงาน\n" +
        "- คำอวยพร\n" +
        "- ของขวัญ",
    });
  }

  // fallback
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
