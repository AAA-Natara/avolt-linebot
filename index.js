"use strict";

const express = require("express");
const line = require("@line/bot-sdk");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const cron = require("node-cron");

dotenv.config();

const app = express();

/**
 * ENV REQUIRED:
 * LINE_CHANNEL_SECRET
 * LINE_CHANNEL_ACCESS_TOKEN
 * SUPABASE_URL
 * SUPABASE_SERVICE_ROLE_KEY
 * BEACON_HWID  (Hardware ID ของ beacon — ดูได้ใน LINE Developers Console)
 */
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const config = {
  channelSecret: LINE_CHANNEL_SECRET,
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
};

const client = new line.Client(config);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// BEACON_HWID ของประตูงาน — ใส่ใน .env หรือแก้ตรงนี้
const BEACON_HWID = process.env.BEACON_HWID || "00000ac97b";

// ========== Flex JSON loader ==========
function loadJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, relPath), "utf8"));
}

function flexMessage(altText, bubbleJson) {
  return { type: "flex", altText, contents: bubbleJson };
}

function loadJsonWithFallback(primaryRelPath, fallbackRelPaths = []) {
  try { return loadJson(primaryRelPath); }
  catch (e1) {
    for (const rel of fallbackRelPaths) {
      try { return loadJson(rel); } catch (e2) {}
    }
    throw e1;
  }
}

const FLEX = {
  wedding: () => loadJsonWithFallback("flex/bubbles/wedding_details.json", ["flex/bubbles/event_details.json"]),
  travel:  () => loadJsonWithFallback("flex/bubbles/travel.json"),
  blessing:() => loadJsonWithFallback("flex/bubbles/blessing.json"),
  confirm: () => loadJsonWithFallback("flex/bubbles/confirm.json"),
  gift:    () => loadJsonWithFallback("flex/bubbles/gift.json"),
};

// ========== In-memory session ==========
const sessions = new Map();

// ========== Supabase helpers ==========
async function getRsvp(userId) {
  const { data, error } = await supabase
    .from("rsvps")
    .select("user_id, full_name, guests_count")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertRsvp(userId, fullName, guestsCount) {
  const { data, error } = await supabase
    .from("rsvps")
    .upsert(
      { user_id: userId, full_name: fullName, guests_count: guestsCount, updated_at: new Date().toISOString() },
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

// ดึงแขกทุกคนที่ RSVP แล้ว
async function getAllGuests() {
  const { data, error } = await supabase
    .from("rsvps")
    .select("user_id, full_name");
  if (error) throw error;
  return data || [];
}

// ========== Beacon: ป้องกันยิงซ้ำใน 10 นาที ==========
const beaconSentMap = new Map(); // userId -> timestamp

function canSendBeacon(userId) {
  const last = beaconSentMap.get(userId);
  if (!last) return true;
  return (Date.now() - last) > 10 * 60 * 1000; // 10 นาที
}

// ========== Scheduled: ป้องกันยิงซ้ำในวันเดียวกัน ==========
const scheduledSentToday = new Set(); // "jobName:userId"

function scheduledKey(jobName, userId) {
  return `${jobName}:${userId}`;
}

// ========== Broadcast helper ==========
async function broadcastToAllGuests(jobName, buildMessage) {
  const guests = await getAllGuests();
  console.log(`[BROADCAST] ${jobName} → ${guests.length} คน`);

  for (const guest of guests) {
    const key = scheduledKey(jobName, guest.user_id);
    if (scheduledSentToday.has(key)) {
      console.log(`[SKIP] ${guest.full_name} ได้รับแล้ว`);
      continue;
    }
    try {
      const msg = buildMessage(guest.full_name);
      await client.pushMessage(guest.user_id, msg);
      scheduledSentToday.add(key);
      console.log(`[SENT] ${guest.full_name}`);
      // หน่วงเล็กน้อยกันถูก rate limit
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`[ERROR] ส่งให้ ${guest.full_name} ไม่ได้:`, err.message);
    }
  }
}

// ========== Scheduled Messages (node-cron) ==========
// Timezone: Asia/Bangkok (UTC+7)
// Format: "วินาที นาที ชั่วโมง วันที่ เดือน วันในสัปดาห์"

// 1) ก่อนงาน VOW — 13:00 น. วันที่ 1 สิงหาคม 2026
cron.schedule("0 0 13 1 8 *", async () => {
  console.log("[CRON] ยิง message ก่อนงาน VOW 13:00");
  await broadcastToAllGuests("vow_start", (name) => ({
    type: "text",
    text:
      `สวัสดีค่ะคุณ${name} 🤍\n\n` +
      `พิธี VOW Ceremony กำลังจะเริ่มแล้วค่ะ\n` +
      `ขอเชิญเข้าสู่บริเวณงานได้เลยนะคะ\n\n` +
      `📍 คริสตจักรสดุดี กรุงเทพฯ\n` +
      `🕐 13:00 น.`,
  }));
}, { timezone: "Asia/Bangkok" });

// 2) ช่วง Celebration — 19:00 น. วันที่ 1 สิงหาคม 2026
cron.schedule("0 0 19 1 8 *", async () => {
  console.log("[CRON] ยิง message Celebration 19:00");
  await broadcastToAllGuests("celebration_start", (name) => ({
    type: "text",
    text:
      `คุณ${name} ค่ะ 🥂\n\n` +
      `ช่วงเฉลิมฉลองกำลังจะเริ่มแล้วค่ะ!\n` +
      `มาสนุกด้วยกันที่ Cloud 11 ได้เลยนะคะ ✨\n\n` +
      `📍 Cloud 11 (Melt Livehouse)\n` +
      `🕖 19:00 น.\n\n` +
      `#AVoltFlowTogether`,
  }));
}, { timezone: "Asia/Bangkok" });

// 3) ตอนงานจบ — 22:00 น. วันที่ 1 สิงหาคม 2026
cron.schedule("0 0 22 1 8 *", async () => {
  console.log("[CRON] ยิง message จบงาน 22:00");
  await broadcastToAllGuests("end_of_night", (name) => ({
    type: "text",
    text:
      `ขอบคุณมากเลยนะคะคุณ${name} 🤍\n\n` +
      `ขอบคุณที่มาร่วมเป็นส่วนหนึ่งในวันพิเศษของเราค่ะ\n` +
      `ทุกช่วงเวลาที่ผ่านมามีคุณ มีความหมายกับเรามาก\n\n` +
      `เดินทางกลับบ้านโดยสวัสดิภาพนะคะ 🙏\n\n` +
      `ด้วยรัก\nเอ & โวลท์ 🤍`,
  }));
}, { timezone: "Asia/Bangkok" });

// ========== Debug routes ==========
app.use(express.static("public"));
app.get("/", (req, res) => res.send("OK"));

app.get("/test-db", async (req, res) => {
  try {
    const { data, error } = await supabase.from("rsvps").select("*").limit(5);
    if (error) return res.status(500).json({ ok: false, error });
    return res.json({ ok: true, rows: data });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// ทดสอบ broadcast โดยไม่ต้องรอเวลาจริง (ลบออกก่อน deploy จริง)
app.get("/test-broadcast/:job", async (req, res) => {
  const job = req.params.job;
  const messages = {
    vow_start: (name) => ({ type:"text", text:`[TEST] สวัสดีค่ะคุณ${name} — VOW Ceremony กำลังจะเริ่มแล้วค่ะ 🤍` }),
    celebration_start: (name) => ({ type:"text", text:`[TEST] คุณ${name} — Celebration เริ่มแล้วค่ะ 🥂` }),
    end_of_night: (name) => ({ type:"text", text:`[TEST] ขอบคุณคุณ${name} ที่มาร่วมงานค่ะ 🤍` }),
  };
  if (!messages[job]) return res.status(400).json({ ok: false, error: "unknown job" });
  await broadcastToAllGuests(`test_${job}`, messages[job]);
  res.json({ ok: true, job });
});

// ========== LINE Webhook ==========
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

// ========== Event handler ==========
function normalizeText(t) { return (t || "").trim(); }
function isNumberLike(text) {
  const m = (text || "").match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isNaN(n) ? null : n;
}

async function handleEvent(event) {
  // ─── BEACON EVENT ───
  if (event.type === "beacon") {
    const userId = event.source?.userId;
    if (!userId) return;

    // รับเฉพาะ beacon ตัวที่กำหนด และ event type "enter"
    if (event.beacon.hwid !== BEACON_HWID) return;
    if (event.beacon.type !== "enter") return;

    // ป้องกันยิงซ้ำใน 10 นาที
    if (!canSendBeacon(userId)) {
      console.log(`[BEACON] ${userId} — skip (ยิงล่าสุดไปแล้ว)`);
      return;
    }
    beaconSentMap.set(userId, Date.now());

    // ดึงชื่อจาก rsvps
    try {
      const guest = await getRsvp(userId);
      const name = guest?.full_name || "คุณแขก";
      const firstName = name.split(" ")[0]; // เอาแค่ชื่อต้น

      await client.pushMessage(userId, {
        type: "text",
        text:
          `ยินดีต้อนรับค่ะคุณ${firstName} 🤍\n\n` +
          `เอ & โวลท์ดีใจมากที่คุณมาร่วมงานค่ะ\n` +
          `ขอให้สนุกและมีความสุขตลอดคืนนะคะ ✨\n\n` +
          `พิมพ์ "เมนู" เพื่อดูข้อมูลงานได้เลยค่ะ`,
      });
      console.log(`[BEACON] Welcome → ${name}`);
    } catch (err) {
      console.error("[BEACON] Error:", err.message);
    }
    return;
  }

  // ─── MESSAGE EVENT ───
  if (event.type !== "message") return;

  const userId = event.source?.userId;
  if (!userId) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "ขออภัย ระบบอ่าน userId ไม่ได้ค่ะ ลองพิมพ์ใหม่อีกครั้งนะคะ",
    });
  }

  const msgType = event.message.type;
  const text = msgType === "text" ? normalizeText(event.message.text) : "";
  const sess = sessions.get(userId);

  // --- โหมดรอรับสลิป ---
  if (sess?.step === "ASK_GIFT_SLIP") {
    if (msgType === "image" || msgType === "file") {
      sessions.delete(userId);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "ขอบคุณสำหรับของขวัญมาก ๆ นะคะ 🤍\nทางเรารับสลิปเรียบร้อยแล้วค่ะ\n\nพระเจ้าอวยพรนะคะ",
      });
    }
    if (msgType === "text") {
      return client.replyMessage(event.replyToken, {
        type: "text", text: "แนบสลิปเป็น "รูปภาพ" หรือ "ไฟล์" ได้เลยนะคะ 🤍",
      });
    }
    return;
  }

  if (msgType !== "text") return;

  // --- Session flows ---
  if (sess) {
    if (sess.step === "ASK_NAME") {
      if (text.length < 2) {
        return client.replyMessage(event.replyToken, {
          type: "text", text: "ขอชื่อ-นามสกุลอีกครั้งได้ไหมคะ (เช่น Natara Thawattara)",
        });
      }
      sess.temp.fullName = text;
      sess.step = "ASK_COUNT";
      sessions.set(userId, sess);
      return client.replyMessage(event.replyToken, {
        type: "text", text: "มาทั้งหมดกี่คนคะ? (รวมตัวเอง) เช่น 1, 2, 3",
      });
    }

    if (sess.step === "ASK_COUNT") {
      const n = isNumberLike(text);
      if (!n || n < 1 || n > 50) {
        return client.replyMessage(event.replyToken, {
          type: "text", text: "รบกวนพิมพ์เป็นตัวเลข 1–50 นะคะ เช่น 2",
        });
      }
      const saved = await upsertRsvp(userId, sess.temp.fullName, n);
      sessions.delete(userId);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          `ขอบคุณที่ยืนยันนะคะ 🤍\n` +
          `ชื่อ: ${saved.full_name}\n` +
          `จำนวน: ${saved.guests_count} คน ✅\n\n` +
          `พิมพ์ดูข้อมูลได้เลย:\n- รายละเอียดงาน\n- การเดินทาง\n- คำอวยพร\n- ของขวัญ`,
      });
    }

    if (sess.step === "ASK_BLESSING") {
      if (text.length < 2) {
        return client.replyMessage(event.replyToken, {
          type: "text", text: "พิมพ์คำอวยพรอีกครั้งได้ไหมคะ 🤍",
        });
      }
      await insertBlessing(userId, text);
      sessions.delete(userId);
      return client.replyMessage(event.replyToken, {
        type: "text", text: "รับคำอวยพรเรียบร้อยแล้วค่ะ 🥺🤍\nขอบคุณมากจริง ๆ นะคะ\n\nพระเจ้าอวยพรนะคะ",
      });
    }
  }

  // ─── คำสั่งหลัก ───

  if (text === "รายละเอียดงาน" || text === "รายละเอียดงานแต่งงาน") {
    try {
      return client.replyMessage(event.replyToken, flexMessage("รายละเอียดงานแต่งงาน", FLEX.wedding()));
    } catch (e) {
      return client.replyMessage(event.replyToken, { type:"text", text:"ขออภัยค่ะ เปิดรายละเอียดงานไม่ได้ 🙏" });
    }
  }

  if (text === "การเดินทาง" || text.toLowerCase() === "travel") {
    try {
      return client.replyMessage(event.replyToken, flexMessage("การเดินทาง", FLEX.travel()));
    } catch (e) {
      return client.replyMessage(event.replyToken, { type:"text", text:"ขออภัยค่ะ เปิดการเดินทางไม่ได้ 🙏" });
    }
  }

  if (text === "คำอวยพร") {
    try {
      return client.replyMessage(event.replyToken, flexMessage("ฝากคำอวยพร", FLEX.blessing()));
    } catch (e) {
      return client.replyMessage(event.replyToken, { type:"text", text:"ขออภัยค่ะ 🙏" });
    }
  }

  if (text === "อวยพร") {
    sessions.set(userId, { step: "ASK_BLESSING", temp: {} });
    return client.replyMessage(event.replyToken, {
      type: "text", text: "พิมพ์คำอวยพรของคุณได้เลยนะคะ 🤍",
    });
  }

  if (text === "ยืนยันมาร่วมงาน" || text.toLowerCase() === "rsvp") {
    try {
      return client.replyMessage(event.replyToken, flexMessage("ยืนยันมาร่วมงาน", FLEX.confirm()));
    } catch (e) {
      return client.replyMessage(event.replyToken, { type:"text", text:"ขออภัยค่ะ 🙏" });
    }
  }

  if (text === "ยืนยัน เจอกันแน่นอน" || text === "ยืนยันเจอกันแน่นอน") {
    const existing = await getRsvp(userId);
    if (existing) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          `คุณยืนยันมาแล้วค่ะ ✅\n` +
          `ชื่อ: ${existing.full_name}\n` +
          `จำนวน: ${existing.guests_count} คน\n\n` +
          `หากต้องการแก้ไข พิมพ์ 'แก้ไขการยืนยัน' ได้เลยค่ะ`,
      });
    }
    sessions.set(userId, { step: "ASK_NAME", temp: {} });
    return client.replyMessage(event.replyToken, {
      type: "text", text: "ขอชื่อ-นามสกุลเพื่อยืนยันการมาร่วมงานค่ะ",
    });
  }

  if (text === "แก้ไขการยืนยัน") {
    sessions.set(userId, { step: "ASK_NAME", temp: {} });
    return client.replyMessage(event.replyToken, {
      type: "text", text: "ได้เลยค่ะ ✨ ขอชื่อ-นามสกุลใหม่อีกครั้งนะคะ",
    });
  }

  if (text === "ของขวัญ" || text.toLowerCase() === "gift") {
    try {
      return client.replyMessage(event.replyToken, flexMessage("ของขวัญ", FLEX.gift()));
    } catch (e) {
      return client.replyMessage(event.replyToken, { type:"text", text:"ขออภัยค่ะ 🙏" });
    }
  }

  const tLower = text.toLowerCase();
  if (
    text === "แนบสลิป / Pay Slip" || text === "แนบสลิป" ||
    tLower === "pay slip" || tLower === "payslip" ||
    (tLower.includes("แนบ") && tLower.includes("slip"))
  ) {
    sessions.set(userId, { step: "ASK_GIFT_SLIP", temp: {} });
    return client.replyMessage(event.replyToken, {
      type: "text", text: "ได้เลยค่ะ 🤍 แนบสลิปเป็นรูปภาพหรือไฟล์ได้เลยนะคะ",
    });
  }

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

  return client.replyMessage(event.replyToken, {
    type: "text", text: "พิมพ์ "เมนู" เพื่อดูคำสั่งทั้งหมดได้นะคะ 🤍",
  });
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
