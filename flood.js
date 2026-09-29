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
 *   alter table flood_subs add column lat float8, add column lon float8, add column local_state jsonb;
 *
 * น้ำใกล้บ้าน: พิมพ์ "ตั้งบ้าน" แล้วส่งตำแหน่ง → เตือนเมื่อคลอง/แม่น้ำใกล้บ้านสูงขึ้น-ลดลง หรือฝนหนักที่บ้าน
 *   "น้ำใกล้บ้าน" ดูการ์ดของบ้านตัวเอง, "ลบบ้าน" เลิกเตือนเฉพาะจุด
 */

const FLOOD_API = process.env.FLOOD_API || "https://worshipnight.life/flood2026/line_alert.php";
const FLOOD_CRON_KEY = process.env.FLOOD_CRON_KEY;

const SUBSCRIBE = ["เตือนน้ำ", "สมัครเตือนน้ำ", "รับแจ้งเตือน"];
const UNSUBSCRIBE = ["หยุดเตือน", "เลิกเตือน", "ยกเลิกเตือน"];
const STATUS = ["สถานะ", "สถานะน้ำ", "น้ำ", "เช็กน้ำ", "เช็คน้ำ"];
const SET_HOME = ["ตั้งบ้าน", "ตั้งตำแหน่ง", "ตั้งตำแหน่งบ้าน", "ส่งตำแหน่งบ้าน"];
const DEL_HOME = ["ลบบ้าน", "ลบตำแหน่ง", "ลบตำแหน่งบ้าน"];
const LOCAL = ["น้ำใกล้บ้าน", "น้ำแถวบ้าน"];

// ปุ่มลัดให้ส่งตำแหน่ง (LINE เปิดแผนที่ให้เลือกจุด)
const LOCATION_QR = { items: [{ type: "action", action: { type: "location", label: "ส่งตำแหน่งบ้าน" } }] };

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

  async function getLocalMessage(lat, lon) {
    const res = await fetch(`${FLOOD_API}?local=1&lat=${lat}&lon=${lon}`);
    if (!res.ok) throw new Error(`flood local HTTP ${res.status}`);
    return res.json(); // { state, message }
  }

  // น้ำใกล้บ้าน: ประเมินทุกคนที่ตั้งตำแหน่งไว้ในคำขอเดียว ส่งเฉพาะคนที่มีการเปลี่ยนแปลง
  async function checkLocal() {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from("flood_subs").select("user_id, lat, lon, local_state").not("lat", "is", null).range(from, from + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    if (!rows.length) return { local: 0, sent: 0 };
    const res = await fetch(`${FLOOD_API}?local=1&cron=${encodeURIComponent(FLOOD_CRON_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: rows.map((r) => ({ id: r.user_id, lat: r.lat, lon: r.lon, prev: r.local_state })) }),
    });
    if (!res.ok) throw new Error(`flood local cron HTTP ${res.status}`);
    const { items } = await res.json();
    const prevById = Object.fromEntries(rows.map((r) => [r.user_id, JSON.stringify(r.local_state)]));
    let sent = 0;
    for (const it of items) {
      if (it.push && it.message) {
        try { await client.pushMessage(it.id, [it.message]); sent++; } catch (e) { console.error("[FLOOD] local push error:", e.message || e); }
      }
      if (JSON.stringify(it.state) !== prevById[it.id]) {
        await supabase.from("flood_subs").update({ local_state: it.state }).eq("user_id", it.id);
      }
    }
    if (sent) console.log(`[FLOOD] น้ำใกล้บ้าน ส่ง ${sent} คน`);
    return { local: rows.length, sent };
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
      try {
        await checkLocal();
      } catch (e) {
        console.error("[FLOOD] local cron error:", e.message || e);
      }
    },
    { timezone: "Asia/Bangkok" }
  );

  // ทดสอบ: GET /flood-check?key=ADMIN_KEY  (สั่งเช็กทันที)
  app.get("/flood-check", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({ city: await checkAndNotify(), home: await checkLocal() });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message || String(e) });
    }
  });

  // ตรวจค่า Supabase ใน Environment โดยไม่เปิดเผยรหัส: GET /flood-diag?key=ADMIN_KEY
  app.get("/flood-diag", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const url = process.env.SUPABASE_URL || "";
    const k = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    let jwt = null;
    if (k.startsWith("eyJ")) {
      try {
        const p = JSON.parse(Buffer.from(k.split(".")[1], "base64url").toString("utf8"));
        jwt = { role: p.role, ref: p.ref, exp: p.exp ? new Date(p.exp * 1000).toISOString().slice(0, 10) : null };
      } catch (e) {
        jwt = "อ่านไม่ได้ (รหัสอาจไม่ครบ)";
      }
    }
    res.json({
      urlRef: (url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/) || [])[1] || `รูปแบบ URL ผิด: ${JSON.stringify(url.slice(0, 60))}`,
      keyLength: k.length,
      keyStartsWith: k.slice(0, 4),
      keyHasSpaceOrNewline: /\s/.test(k),
      keyHasQuote: /["']/.test(k),
      jwtPayload: jwt,
    });
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

    // ส่งตำแหน่งมา: บันทึกเป็นบ้าน (เฉพาะคนที่สมัครเตือนน้ำแล้ว ไม่งั้นปล่อยให้ส่วนอื่นของบอทจัดการ)
    if (event.type === "message" && event.message.type === "location") {
      return (async () => {
        const { data } = await supabase.from("flood_subs").select("user_id").eq("user_id", userId).maybeSingle();
        if (!data) return null;
        const { latitude: lat, longitude: lon } = event.message;
        try {
          const r = await getLocalMessage(lat, lon);
          await supabase.from("flood_subs").update({ lat, lon, local_state: r.state }).eq("user_id", userId);
          return client.replyMessage(event.replyToken, [
            { type: "text", text: "บันทึกตำแหน่งบ้านแล้วค่ะ\n\nจะเตือนเพิ่มเมื่อน้ำในคลองหรือแม่น้ำใกล้บ้านสูงขึ้นหรือลดลง และเมื่อฝนหนักกำลังมาที่บ้าน\n\nพิมพ์ \"น้ำใกล้บ้าน\" ดูได้ตลอด\nพิมพ์ \"ลบบ้าน\" เพื่อเลิกเตือนเฉพาะจุด" },
            r.message,
          ]);
        } catch (e) {
          console.error("[FLOOD] set home error:", e.message || e);
          return client.replyMessage(event.replyToken, { type: "text", text: "ขออภัยค่ะ ตอนนี้บันทึกตำแหน่งไม่สำเร็จ ลองส่งใหม่อีกครั้งนะคะ" });
        }
      })();
    }

    if (event.type !== "message" || event.message.type !== "text") return null;
    const text = (event.message.text || "").replace(/\s+/g, "");

    if (SET_HOME.includes(text)) {
      return (async () => {
        await supabase.from("flood_subs").upsert({ user_id: userId }, { onConflict: "user_id" });
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "กดปุ่ม \"ส่งตำแหน่งบ้าน\" ด้านล่าง แล้วเลือกจุดบ้านบนแผนที่ได้เลยค่ะ\n(ใช้เพื่อหาคลองและจุดวัดน้ำใกล้บ้านเท่านั้น)",
          quickReply: LOCATION_QR,
        });
      })();
    }

    if (DEL_HOME.includes(text)) {
      return (async () => {
        await supabase.from("flood_subs").update({ lat: null, lon: null, local_state: null }).eq("user_id", userId);
        return client.replyMessage(event.replyToken, { type: "text", text: "ลบตำแหน่งบ้านแล้วค่ะ ยังรับเตือนน้ำกรุงเทพฯ ตามปกติ" });
      })();
    }

    if (LOCAL.includes(text)) {
      return (async () => {
        const { data } = await supabase.from("flood_subs").select("lat, lon").eq("user_id", userId).maybeSingle();
        if (!data || data.lat == null) {
          return client.replyMessage(event.replyToken, { type: "text", text: "ยังไม่ได้ตั้งตำแหน่งบ้านค่ะ กดปุ่มด้านล่างเพื่อส่งตำแหน่ง", quickReply: LOCATION_QR });
        }
        try {
          return client.replyMessage(event.replyToken, (await getLocalMessage(data.lat, data.lon)).message);
        } catch (e) {
          return client.replyMessage(event.replyToken, { type: "text", text: "ตอนนี้ดึงข้อมูลน้ำไม่ได้ ลองใหม่อีกสักครู่นะคะ" });
        }
      })();
    }

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
            "จะส่งข้อความหาเมื่อระดับเตือนสูงขึ้นหรือลดลง และอัปเดตทุก 3 ชม. ตอนสถานการณ์หนัก\n\n" +
            "อยากได้เตือนเฉพาะบ้านตัวเอง (คลองใกล้บ้าน ฝนที่บ้าน) กดปุ่ม \"ส่งตำแหน่งบ้าน\" ด้านล่าง\n\n" +
            "พิมพ์ \"สถานะ\" ดูได้ตลอด\nพิมพ์ \"หยุดเตือน\" เพื่อเลิกรับ",
        }];
        try { msgs.push(await getStatusMessage()); } catch (e) { console.error("[FLOOD] status error:", e.message || e); }
        msgs[msgs.length - 1].quickReply = LOCATION_QR; // ปุ่มลัดต้องอยู่ที่ข้อความสุดท้าย
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

  return { handleFloodEvent, checkAndNotify, checkLocal };
}

module.exports = { setupFlood };
