"use strict";

/**
 * แจ้งเตือนสถานะน้ำกรุงเทพฯ
 * - พิมพ์ "เตือนน้ำ"  = สมัครรับแจ้งเตือน
 * - พิมพ์ "หยุดเตือน" = เลิกรับ
 * - พิมพ์ "สถานะ"    = ดูสถานะล่าสุด (reply ไม่เสียโควตา)
 * - ทุก 15 นาที ถามเว็บ worshipnight.life ว่าต้องแจ้งไหม ถ้าต้อง ส่งหาคนที่สมัคร (นับโควตาตามจำนวนผู้รับ)
 *
 * ENV:
 *   FLOOD_API       = https://worshipnight.life/flood2026/line_alert.php
 *   FLOOD_CRON_KEY  = รหัสลับ ต้องตรงกับ CRON_KEY ใน line_alert.php
 *
 * Supabase table (สร้างครั้งเดียว):
 *   create table flood_subs (user_id text primary key, created_at timestamptz default now());
 */

const FLOOD_API = process.env.FLOOD_API || "https://worshipnight.life/flood2026/line_alert.php";
const FLOOD_CRON_KEY = process.env.FLOOD_CRON_KEY;

const SUBSCRIBE = ["เตือนน้ำ", "สมัครเตือนน้ำ", "รับแจ้งเตือน"];
const UNSUBSCRIBE = ["หยุดเตือน", "เลิกเตือน", "ยกเลิกเตือน"];
const STATUS = ["สถานะ", "สถานะน้ำ", "น้ำ", "เช็กน้ำ", "เช็คน้ำ"];

function setupFlood({ app, client, supabase, cron, requireAdmin }) {
  async function getStatusMessage() {
    const res = await fetch(`${FLOOD_API}?status=1`);
    if (!res.ok) throw new Error(`flood status HTTP ${res.status}`);
    const j = await res.json();
    return j.message;
  }

  async function allSubscribers() {
    const ids = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from("flood_subs").select("user_id").range(from, from + 999);
      if (error) throw error;
      ids.push(...data.map((r) => r.user_id));
      if (data.length < 1000) break;
    }
    return ids;
  }

  // ถามเว็บว่าต้องแจ้งไหม แล้วส่งหาคนที่สมัคร
  async function checkAndNotify() {
    if (!FLOOD_CRON_KEY) return { ok: false, message: "FLOOD_CRON_KEY not set" };
    const res = await fetch(`${FLOOD_API}?cron=${encodeURIComponent(FLOOD_CRON_KEY)}`);
    if (!res.ok) throw new Error(`flood cron HTTP ${res.status}`);
    const j = await res.json();
    if (!j.message || !["up", "down", "update"].includes(j.action)) {
      return { ok: true, action: j.action, level: j.level, sent: 0 };
    }
    const ids = await allSubscribers();
    for (let i = 0; i < ids.length; i += 500) {
      await client.multicast(ids.slice(i, i + 500), [j.message]);
    }
    console.log(`[FLOOD] ${j.action} level ${j.level} → ส่ง ${ids.length} คน`);
    return { ok: true, action: j.action, level: j.level, sent: ids.length };
  }

  // ทุก 15 นาที
  cron.schedule(
    "*/15 * * * *",
    async () => {
      try {
        await checkAndNotify();
      } catch (e) {
        console.error("[FLOOD] cron error:", e.message || e);
      }
    },
    { timezone: "Asia/Bangkok" }
  );

  // ทดสอบ: GET /flood-check?key=ADMIN_KEY  (สั่งเช็กทันที)
  app.get("/flood-check", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      res.json(await checkAndNotify());
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message || String(e) });
    }
  });

  // ทดสอบ: GET /flood-test?key=ADMIN_KEY&to=USER_ID  (ส่งการ์ดสถานะหาคนเดียว)
  app.get("/flood-test", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      await client.pushMessage(String(req.query.to), [await getStatusMessage()]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message || String(e) });
    }
  });

  /**
   * เรียกจาก handleEvent ก่อน logic อื่น
   * คืน Promise ถ้าจัดการแล้ว, คืน null ถ้าไม่เกี่ยวกับเตือนน้ำ
   */
  function handleFloodEvent(event) {
    const userId = event.source && event.source.userId;
    if (!userId) return null;

    if (event.type === "unfollow") {
      return supabase.from("flood_subs").delete().eq("user_id", userId);
    }
    if (event.type !== "message" || event.message.type !== "text") return null;
    const text = (event.message.text || "").replace(/\s+/g, "");

    if (SUBSCRIBE.includes(text)) {
      return (async () => {
        const { error } = await supabase.from("flood_subs").upsert({ user_id: userId }, { onConflict: "user_id" });
        if (error) {
          console.error("[FLOOD] subscribe error:", error.message || error);
          return client.replyMessage(event.replyToken, { type: "text", text: "ขออภัยค่ะ ตอนนี้สมัครไม่สำเร็จ ลองใหม่อีกครั้งนะคะ" });
        }
        const msgs = [{
          type: "text",
          text:
            "สมัครรับแจ้งเตือนน้ำกรุงเทพฯ แล้วค่ะ\n\n" +
            "จะส่งข้อความหาเมื่อระดับเตือนสูงขึ้นหรือลดลง และอัปเดตเป็นระยะตอนสถานการณ์หนัก\n\n" +
            "พิมพ์ \"สถานะ\" ดูได้ตลอด\nพิมพ์ \"หยุดเตือน\" เพื่อเลิกรับ",
        }];
        try { msgs.push(await getStatusMessage()); } catch (e) { console.error("[FLOOD] status error:", e.message || e); }
        return client.replyMessage(event.replyToken, msgs);
      })();
    }

    if (UNSUBSCRIBE.includes(text)) {
      return (async () => {
        await supabase.from("flood_subs").delete().eq("user_id", userId);
        return client.replyMessage(event.replyToken, { type: "text", text: "หยุดส่งแจ้งเตือนน้ำแล้วค่ะ พิมพ์ \"เตือนน้ำ\" เมื่ออยากรับอีกครั้ง" });
      })();
    }

    if (STATUS.includes(text)) {
      return (async () => {
        try {
          return client.replyMessage(event.replyToken, await getStatusMessage());
        } catch (e) {
          console.error("[FLOOD] status error:", e.message || e);
          return client.replyMessage(event.replyToken, { type: "text", text: "ตอนนี้ดึงข้อมูลน้ำไม่ได้ ลองใหม่อีกสักครู่นะคะ หรือดูที่ https://worshipnight.life/flood2026/" });
        }
      })();
    }
    return null;
  }

  return { handleFloodEvent, checkAndNotify };
}

module.exports = { setupFlood };
