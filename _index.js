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
  beaconWelcome: () => loadJsonWithFallback("flex/bubbles/beacon_welcome.json"),
  beaconAfternoon: () => loadJsonWithFallback("flex/bubbles/beacon_afternoon.json"),
  beaconEvening: () => loadJsonWithFallback("flex/bubbles/beacon_evening.json"),

  // ===== เมนูใหม่ (rich menu 2026-07) =====
  wishesHub: () => loadJsonWithFallback("flex/bubbles/wishes_hub.json"),
  afternoon: () => loadJsonWithFallback("flex/bubbles/afternoon.json"),
  evening: () => loadJsonWithFallback("flex/bubbles/evening.json"),
  thingsToDo: () => loadJsonWithFallback("flex/bubbles/things_to_do.json"),
};

// คำอวยพรเก็บที่เดียว: หน้าเว็บ /blessing/
const BLESSING_URL = "https://avoltwedding.worshipnight.life/blessing/";

// ===== Rich menu router =====
// key = ข้อความที่ rich menu ส่งเข้ามา (action type: message)
// value = [ชื่อ FLEX, altText]
const MENU_ROUTES = {
  "อวยพรและของขวัญ": ["wishesHub", "คำอวยพร และ ของขวัญ"],
  "งานช่วงบ่าย": ["afternoon", "งานช่วงบ่าย · พิธีมงคลสมรส"],
  "งานช่วงเย็น": ["evening", "งานช่วงเย็น · Gaysorn Urban Resort"],
  "กิจกรรมในงาน": ["thingsToDo", "กิจกรรมในงาน"],
};

// ========== Beacon helpers ==========
// แทน placeholder ใน Flex JSON (เช่น {{FIRST_NAME}})
function renderTemplate(bubbleJson, vars = {}) {
  let str = JSON.stringify(bubbleJson);
  for (const [key, val] of Object.entries(vars)) {
    const safe = String(val).replace(/"/g, '\\"');
    str = str.split(`{{${key}}}`).join(safe);
  }
  return JSON.parse(str);
}

// วันที่ปัจจุบันแบบเวลาไทย (YYYY-MM-DD) ใช้เป็น sent_date
function todayBangkok() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
}

// ชั่วโมงปัจจุบันแบบเวลาไทย (0–23)
function hourBangkok() {
  const h = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    hour12: false,
  });
  return parseInt(h, 10);
}

// พยายามบันทึก log ว่าส่งการ์ดนี้แล้ววันนี้
// คืน true = ยังไม่เคยส่ง (ส่งได้) / false = เคยส่งแล้ววันนี้ (ข้าม)
async function claimBeaconCard(userId, cardType) {
  const { error } = await supabase
    .from("beacon_logs")
    .insert([{ user_id: userId, card_type: cardType, sent_date: todayBangkok() }]);

  if (error) {
    // 23505 = unique violation = เคยส่งแล้ววันนี้
    if (error.code === "23505") return false;
    console.error("[BEACON] claim error:", error.message || error);
    return false; // error อื่น ๆ กันส่งซ้ำไว้ก่อน
  }
  return true;
}

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

// SECURITY: repo เป็น public และ URL ของ Render อยู่ในโค้ด
// route ที่คืนข้อมูลแขกต้องมี ADMIN_KEY เสมอ
const ADMIN_KEY = process.env.ADMIN_KEY;

function requireAdmin(req, res) {
  if (!ADMIN_KEY) {
    res.status(503).json({ ok: false, message: "ADMIN_KEY not set" });
    return false;
  }
  if (req.query.key !== ADMIN_KEY) {
    res.status(404).end();
    return false;
  }
  return true;
}

// export คำอวยพรที่เก็บผ่านแชทไว้ก่อนหน้า เพื่อย้ายไปรวมกับ /blessing/
// GET /export-blessings?key=xxx        -> JSON
// GET /export-blessings?key=xxx&f=csv  -> CSV
app.get("/export-blessings", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { data, error } = await supabase
      .from("blessings")
      .select("*")
      .order("created_at", { ascending: true });
    if (error) return res.status(500).json({ ok: false, error });

    if (req.query.f === "csv") {
      const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const cols = data.length ? Object.keys(data[0]) : ["id", "user_id", "message"];
      const csv = [
        cols.join(","),
        ...data.map((r) => cols.map((c) => esc(r[c])).join(",")),
      ].join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="blessings.csv"');
      return res.send("\uFEFF" + csv); // BOM กัน Excel อ่านภาษาไทยเพี้ยน
    }

    return res.json({ ok: true, count: data.length, rows: data });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || String(e) });
  }
});

app.get("/test-db", async (req, res) => {
  if (!requireAdmin(req, res)) return;
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


async function handleEvent(event) {



  // ─── BEACON EVENT ───
  if (event.type === "beacon") {
    const userId = event.source?.userId;
    if (!userId) return;
    if (event.beacon.hwid !== BEACON_HWID) return;
    if (event.beacon.type !== "enter") return;

    const hour = hourBangkok();
    const messages = [];

    try {
      const profile = await client.getProfile(userId);
      const firstName = profile.displayName;

      // 1) Welcome อลังการ — ครั้งแรกของวัน
      if (await claimBeaconCard(userId, "welcome")) {
        const bubble = renderTemplate(FLEX.beaconWelcome(), {
          FIRST_NAME: `คุณ${firstName}`,
        });
        messages.push(flexMessage(`ยินดีต้อนรับ คุณ${firstName}`, bubble));
      }

      // 2) ข้อความตามช่วงเวลา (ช่วงละครั้งต่อวัน)
      if (hour >= 12 && hour < 18) {
        if (await claimBeaconCard(userId, "afternoon")) {
          messages.push(flexMessage("กำหนดการช่วงบ่าย", FLEX.beaconAfternoon()));
        }
      } else if (hour >= 18) {
        if (await claimBeaconCard(userId, "evening")) {
          messages.push(flexMessage("ร่วมเฉลิมฉลองช่วงค่ำ", FLEX.beaconEvening()));
        }
      }

      if (messages.length > 0) {
        await client.pushMessage(userId, messages);
        console.log(`[BEACON] ${firstName} → ส่ง ${messages.length} การ์ด (${hour}:00)`);
      } else {
        console.log(`[BEACON] ${firstName} → ได้ครบแล้ววันนี้ (${hour}:00)`);
      }
    } catch (err) {
      console.error("[BEACON] Error:", err.message || err);
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

      let saved;
      try {
        saved = await upsertRsvp(userId, sess.temp.fullName, n);
      } catch (e) {
        console.error("upsertRsvp error:", e.message || e);
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "ขออภัยค่ะ ตอนนี้บันทึกข้อมูลไม่สำเร็จ ลองใหม่อีกครั้งในอีกสักครู่นะคะ 🙏",
        });
      }
      sessions.delete(userId);

      return client.replyMessage(event.replyToken, {
        type: "text",
        text:
          `ขอบคุณที่ยืนยันนะคะ 🤍 \n`+
          `เราจะเตรียมที่นั่ง/การต้อนรับ ✅\n` +
          `ชื่อ: ${saved.full_name}\n` +
          `จำนวน: ${saved.guests_count} คน\n\n` +
          `ดูข้อมูลเพิ่มเติมได้ที่เมนูด้านล่างเลยนะคะ\n` +
          `หรือพิมพ์ก็ได้ค่ะ:\n` +
          `- รายละเอียดงาน\n` +
          `- งานช่วงบ่าย\n` +
          `- งานช่วงเย็น\n` +
          `- กิจกรรมในงาน\n` +
          `- อวยพรและของขวัญ`,
      });
    }

    // ASK_BLESSING (legacy)
    // ไม่มีทางเข้าใหม่แล้ว เหลือไว้กันคนที่ค้าง session ตอน deploy
    // ยังบันทึกลง Supabase เหมือนเดิม แล้วชี้ต่อไปหน้าเว็บ
    if (sess.step === "ASK_BLESSING") {
      const msg = text;
      if (msg.length < 2) {
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "พิมพ์คำอวยพรอีกครั้งได้ไหมคะ 🤍",
        });
      }

      try {
        await insertBlessing(userId, msg);
      } catch (e) {
        console.error("insertBlessing error:", e.message || e);
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "ขออภัยค่ะ ตอนนี้บันทึกคำอวยพรไม่สำเร็จ ลองส่งใหม่อีกครั้งนะคะ 🙏",
        });
      }
      sessions.delete(userId);

      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "รับคำอวยพรเรียบร้อยแล้วค่ะ 🥺🤍\nขอบคุณมากจริง ๆ นะคะ\n\nพระเจ้าอวยพรนะคะ",
      });
    }
  }

  // ===== 2) คำสั่งหลัก (ข้อความ) =====

  // --- ปุ่มจาก rich menu ชุดใหม่ ---
  if (MENU_ROUTES[text]) {
    const [flexKey, altText] = MENU_ROUTES[text];
    try {
      return client.replyMessage(
        event.replyToken,
        flexMessage(altText, FLEX[flexKey]())
      );
    } catch (e) {
      console.error(`Flex ${flexKey} load error:`, e);
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "ขออภัยค่ะ ตอนนี้เปิดการ์ดนี้ไม่ได้ ลองใหม่อีกครั้งนะคะ 🙏",
      });
    }
  }

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

  // กดปุ่ม "อวยพร" — ปุ่มเก่าจากการ์ดที่ส่งไปแล้ว
  // ไม่เก็บผ่านแชทอีกต่อไป ส่งไปหน้าเว็บ /blessing/ ที่เดียว
  if (text === "อวยพร") {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "ตอนนี้ย้ายไปเขียนคำอวยพรที่หน้านี้แล้วนะคะ 🤍\n" + BLESSING_URL,
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
    let existing = null;
    try {
      existing = await getRsvp(userId);
    } catch (e) {
      console.error("getRsvp error:", e.message || e);
    }
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
        "- ยืนยันมาร่วมงาน\n" +
        "- งานช่วงบ่าย\n" +
        "- งานช่วงเย็น\n" +
        "- กิจกรรมในงาน\n" +
        "- อวยพรและของขวัญ\n" +
        "- คำอวยพร\n" +
        "- ของขวัญ\n" +
        "- การเดินทาง",
    });
  }

  // fallback
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "พิมพ์ “เมนู” เพื่อดูคำสั่งทั้งหมดได้นะคะ 🤍",
  });
}



// Keep alive — กัน Render หลับ
setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL || "https://avolt-linebot.onrender.com";
  fetch(url).catch(() => {});
}, 5 * 60 * 1000);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

