// LINE Messaging API webhook — lets the shop owner text fixed-format commands from LINE
// to record a new order or a stock-in entry, writing straight into the same Firestore
// collections the web app (index.html) reads from — no separate data store.
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

const LINE_CHANNEL_SECRET = defineSecret('LINE_CHANNEL_SECRET');
const LINE_CHANNEL_ACCESS_TOKEN = defineSecret('LINE_CHANNEL_ACCESS_TOKEN');

// The Messaging API channel's numeric Channel ID (Basic settings tab in LINE Developers
// Console) — NOT a secret, just an identifier used to verify LIFF ID tokens actually came
// from our own LIFF app rather than an arbitrary caller of these public endpoints.
// TODO: replace with the real Channel ID after the LIFF app is registered.
const LINE_CHANNEL_ID = '2011483690';
const LIFF_ID = '2011483690-dOIJqY86';

async function verifyLiffIdToken(idToken) {
  const params = new URLSearchParams({ id_token: idToken, client_id: LINE_CHANNEL_ID });
  const res = await fetch('https://api.line.me/oauth2/v2.1/verify', { method: 'POST', body: params });
  if (!res.ok) return null;
  return res.json();
}

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

// Mirrors uid() in index.html so ids look the same whether an order/stock-in came from
// the web app or from LINE.
function uid() { return 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function todayISOBangkok() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function addDaysISO(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// "key: value" lines -> {key: value}, same free-form shape as the app's own settings/forms.
function parseKeyValueLines(lines) {
  const out = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

const SHIPPING_STATUSES = ['รอเตรียมส่ง', 'กำลังจัดส่ง', 'ส่งลูกค้าเรียบร้อย', 'ยกเลิก'];
const PAYMENT_STATUSES = ['ยังไม่ได้รับเงิน', 'มัดจำ', 'ได้รับเงินแล้ว'];

const HELP_TEXT = `พิมพ์คำสั่งตามแบบนี้ครับ

💡 พิมพ์คำว่า "ออเดอร์" เฉยๆ คำเดียว แล้วบอทจะบอกให้พิมพ์ข้อมูลทีละบรรทัดต่อเอง (ไม่ต้องจำชื่อฟิลด์)
💡 หรือพิมพ์คำว่า "ฟอร์ม" เพื่อเปิดหน้ากรอกข้อมูลแบบมีปุ่มกดแทนได้เลย

📦 บันทึกออเดอร์แบบพิมพ์รวดเดียว (จำเป็น: ลูกค้า, เบอร์, สินค้า, ถ้วยเล็ก/ถ้วยใหญ่ อย่างน้อย 1 อย่าง — ที่เหลือไม่ใส่ก็ได้ ระบบจะใช้ค่าเริ่มต้นให้):
ออเดอร์
ลูกค้า: ชื่อลูกค้า
เบอร์: 08xxxxxxxx
ที่อยู่: ที่อยู่จัดส่ง
สินค้า: ชื่อสินค้า
ถ้วยเล็ก: 2
ถ้วยใหญ่: 1
ช่องทาง: Facebook
วันที่จัดส่ง: 25/12/2026 (ไม่ใส่ = พรุ่งนี้)
สถานะจัดส่ง: ${SHIPPING_STATUSES.join('/')} (ไม่ใส่ = ${SHIPPING_STATUSES[0]})
การชำระเงิน: ${PAYMENT_STATUSES.join('/')} (ไม่ใส่ = ${PAYMENT_STATUSES[0]})
ประเภทการจ่ายเงิน: เงินสด/โอน (ตามที่ตั้งค่าไว้ในระบบ)
ค่าจัดส่ง: 20
ส่วนลด: 10
ประเภทส่วนลด: บาท/เปอร์เซ็นต์ (ไม่ใส่ = บาท)
มัดจำ: 100
หมายเหตุ: ข้อความเพิ่มเติม

ระบบจะสรุปให้ดูก่อน พิมพ์ "ยืนยัน" เพื่อบันทึกจริง หรือ "ยกเลิก" เพื่อยกเลิก

📥 รับวัตถุดิบเข้าสต๊อก:
รับสต๊อก
วัตถุดิบ: ชื่อวัตถุดิบ
จำนวน: 5
ราคาต่อหน่วย: 120 (ไม่ใส่ก็ได้)
ผู้ขาย: ชื่อร้าน (ไม่ใส่ก็ได้)
หมายเหตุ: (ไม่ใส่ก็ได้)`;

const CONFIRM_WINDOW_MS = 10 * 60 * 1000; // pending order draft / awaiting-input state expires after 10 minutes

// Positional paste flow: type "ออเดอร์" alone -> bot asks for these values, one per line,
// no labels -> next message is parsed by position. Lines split on '\n' only (never ',') so
// a Thai address's own commas can't shift every field after it out of alignment.
const ORDER_FIELD_SEQUENCE = ['ลูกค้า', 'เบอร์', 'ที่อยู่', 'สินค้า', 'ถ้วยเล็ก', 'ถ้วยใหญ่', 'วันที่จัดส่ง', 'ช่องทาง', 'ค่าจัดส่ง', 'ส่วนลด', 'มัดจำ'];

const ORDER_PASTE_PROMPT = `พิมพ์ข้อมูลเรียงทีละบรรทัดตามลำดับนี้ได้เลยครับ (ไม่ต้องใส่ชื่อหัวข้อนำหน้า) ถ้าอันไหนไม่มีข้อมูล เว้นบรรทัดว่างไว้แทนที่ เพื่อไม่ให้บรรทัดถัดไปเลื่อนตำแหน่งผิด:

1. ชื่อลูกค้า
2. เบอร์โทร
3. ที่อยู่
4. สินค้า
5. ถ้วยเล็ก
6. ถ้วยใหญ่
7. วันที่จัดส่ง (วัน/เดือน/ปี เช่น 7/9/2026 — เว้นว่าง = พรุ่งนี้)
8. ช่องทาง (เช่น Facebook — เว้นว่างได้)
9. ค่าจัดส่ง
10. ส่วนลด
11. มัดจำ

ตัวอย่าง:
สมชาย ใจดี
0812345678
123 หมู่ 4 ต.บางบัวทอง
ลี่ถัง 8 เซียน
5
5
7/9/2026
Facebook
20
39
100`;

function parsePositionalOrder(rawText) {
  const rows = rawText.split('\n').map(l => l.trim());
  const fields = {};
  ORDER_FIELD_SEQUENCE.forEach((key, i) => { if (rows[i]) fields[key] = rows[i]; });
  return fields;
}

async function setAwaitingInput(userId, type) {
  await db.collection('lineAwaitingInput').doc(userId).set({ type, createdAt: Date.now() });
}
async function popAwaitingInput(userId) {
  const ref = db.collection('lineAwaitingInput').doc(userId);
  const doc = await ref.get();
  if (!doc.exists) return null;
  await ref.delete();
  const { type, createdAt } = doc.data();
  return (Date.now() - createdAt <= CONFIRM_WINDOW_MS) ? type : null;
}

// DD/MM/YYYY (Gregorian) -> YYYY-MM-DD, or null if not a real calendar date.
function parseThaiDate(s) {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const iso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(dd) || d.getUTCMonth() + 1 !== Number(mm)) return null;
  return iso;
}

async function replyToLine(replyToken, text, accessToken) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
}

// Validates + builds the order object, but does not save it — the caller decides whether
// to hold it as a pending draft (awaiting "ยืนยัน") or write it straight to Firestore.
async function buildOrderDraft(fields) {
  const missing = [];
  if (!fields['ลูกค้า']) missing.push('ลูกค้า');
  if (!fields['เบอร์']) missing.push('เบอร์');
  if (!fields['สินค้า']) missing.push('สินค้า');
  if (missing.length) return { ok: false, message: `❌ ข้อมูลไม่ครบ: ขาด ${missing.join(', ')}\n\n${HELP_TEXT}` };

  const phoneDigits = fields['เบอร์'].replace(/[^0-9]/g, '');
  if (phoneDigits.length < 9 || phoneDigits.length > 10) {
    return { ok: false, message: `❌ เบอร์โทร "${fields['เบอร์']}" ดูไม่ถูกต้อง (ควรเป็นตัวเลข 9-10 หลัก)` };
  }

  const jarSmall = Number(fields['ถ้วยเล็ก']) || 0;
  const jarLarge = Number(fields['ถ้วยใหญ่']) || 0;
  if (jarSmall <= 0 && jarLarge <= 0) return { ok: false, message: '❌ กรุณาระบุจำนวนถ้วยเล็กหรือถ้วยใหญ่อย่างน้อย 1 อย่าง' };

  const productsDoc = await db.collection('settings').doc('products').get();
  const products = (productsDoc.exists && productsDoc.data().value) || [];
  const wanted = fields['สินค้า'].trim().toLowerCase();
  const productMatch = products.find(p => p.name && p.name.trim().toLowerCase() === wanted);
  if (!productMatch) {
    const names = products.map(p => p.name).join(', ') || '(ยังไม่มีสินค้าตั้งค่าไว้)';
    return { ok: false, message: `❌ ไม่พบสินค้า "${fields['สินค้า']}" ในระบบ\nสินค้าที่มี: ${names}` };
  }

  let channel = '';
  if (fields['ช่องทาง']) {
    const channelsDoc = await db.collection('settings').doc('channels').get();
    const channels = (channelsDoc.exists && channelsDoc.data().value) || [];
    const wantedChannel = fields['ช่องทาง'].trim().toLowerCase();
    channel = channels.find(c => c.trim().toLowerCase() === wantedChannel) || fields['ช่องทาง'];
  }

  let paymentMethod = '';
  if (fields['ประเภทการจ่ายเงิน']) {
    const pmDoc = await db.collection('settings').doc('paymentMethods').get();
    const methods = (pmDoc.exists && pmDoc.data().value) || [];
    const wantedMethod = fields['ประเภทการจ่ายเงิน'].trim().toLowerCase();
    paymentMethod = methods.find(m => m.trim().toLowerCase() === wantedMethod) || fields['ประเภทการจ่ายเงิน'];
  }

  const today = todayISOBangkok();
  let deliveryDate = addDaysISO(today, 1);
  if (fields['วันที่จัดส่ง']) {
    const parsed = parseThaiDate(fields['วันที่จัดส่ง']);
    if (!parsed) return { ok: false, message: `❌ วันที่จัดส่ง "${fields['วันที่จัดส่ง']}" ไม่ถูกต้อง (รูปแบบ วัน/เดือน/ปี เช่น 25/12/2026)` };
    deliveryDate = parsed;
  }

  let shippingStatus = SHIPPING_STATUSES[0];
  if (fields['สถานะจัดส่ง']) {
    const wanted = fields['สถานะจัดส่ง'].trim();
    if (!SHIPPING_STATUSES.includes(wanted)) return { ok: false, message: `❌ สถานะจัดส่ง "${wanted}" ไม่ถูกต้อง (เลือกจาก: ${SHIPPING_STATUSES.join('/')})` };
    shippingStatus = wanted;
  }

  let paymentStatus = PAYMENT_STATUSES[0];
  if (fields['การชำระเงิน']) {
    const wanted = fields['การชำระเงิน'].trim();
    if (!PAYMENT_STATUSES.includes(wanted)) return { ok: false, message: `❌ การชำระเงิน "${wanted}" ไม่ถูกต้อง (เลือกจาก: ${PAYMENT_STATUSES.join('/')})` };
    paymentStatus = wanted;
  }

  let discountType = 'baht';
  if (fields['ประเภทส่วนลด']) {
    const wanted = fields['ประเภทส่วนลด'].trim();
    if (wanted === 'บาท') discountType = 'baht';
    else if (wanted === 'เปอร์เซ็นต์' || wanted === '%' || wanted.toLowerCase() === 'percent') discountType = 'percent';
    else return { ok: false, message: `❌ ประเภทส่วนลด "${wanted}" ไม่ถูกต้อง (เลือกจาก: บาท/เปอร์เซ็นต์)` };
  }

  const numericFields = { 'ค่าจัดส่ง': 'shippingFee', 'ส่วนลด': 'discountValue', 'มัดจำ': 'deposit' };
  const numbers = {};
  for (const [thLabel, key] of Object.entries(numericFields)) {
    if (fields[thLabel] === undefined) { numbers[key] = 0; continue; }
    const n = Number(fields[thLabel]);
    if (Number.isNaN(n) || n < 0) return { ok: false, message: `❌ "${thLabel}" ต้องเป็นตัวเลขไม่ติดลบ (ได้รับ: ${fields[thLabel]})` };
    numbers[key] = n;
  }

  const order = {
    id: uid(),
    customerName: fields['ลูกค้า'],
    phone: phoneDigits,
    orderDate: today,
    deliveryDate,
    address: fields['ที่อยู่'] || '',
    product: productMatch.name,
    channel,
    jarSmall, jarLarge,
    shippingStatus,
    paymentStatus,
    paymentMethod,
    note: fields['หมายเหตุ'] || 'สั่งผ่านไลน์',
    shippingFee: numbers.shippingFee,
    discountValue: numbers.discountValue,
    discountType,
    deposit: numbers.deposit,
    paymentSlip: null
  };
  return { ok: true, order };
}

function formatOrderSummary(order) {
  const discountLabel = order.discountType === 'percent' ? `${order.discountValue}%` : `${order.discountValue} บาท`;
  return [
    `ลูกค้า: ${order.customerName}`,
    `เบอร์: ${order.phone}`,
    `สินค้า: ${order.product} (เล็ก ${order.jarSmall}, ใหญ่ ${order.jarLarge})`,
    `ที่อยู่: ${order.address || '-'}`,
    `ช่องทาง: ${order.channel || '-'}`,
    `วันที่จัดส่ง: ${order.deliveryDate}`,
    `สถานะจัดส่ง: ${order.shippingStatus}`,
    `การชำระเงิน: ${order.paymentStatus}${order.paymentMethod ? ' (' + order.paymentMethod + ')' : ''}`,
    `ค่าจัดส่ง: ${order.shippingFee} บาท`,
    `ส่วนลด: ${discountLabel}`,
    `มัดจำ: ${order.deposit} บาท`,
    `หมายเหตุ: ${order.note}`
  ].join('\n');
}

// "ออเดอร์" never writes to Firestore directly — it stages the parsed order as a pending
// draft (one per LINE user) so a typo doesn't become a permanent record; "ยืนยัน" commits it.
async function handleOrderCommand(fields, userId) {
  const result = await buildOrderDraft(fields);
  if (!result.ok) return result.message;

  await db.collection('linePendingOrders').doc(userId).set({ order: result.order, createdAt: Date.now() });
  return `📝 ตรวจสอบข้อมูลก่อนบันทึกครับ\n\n${formatOrderSummary(result.order)}\n\nถ้าถูกต้อง พิมพ์ "ยืนยัน" เพื่อบันทึกจริง หรือ "ยกเลิก" เพื่อยกเลิกรายการนี้`;
}

async function handleConfirmCommand(userId) {
  const ref = db.collection('linePendingOrders').doc(userId);
  const doc = await ref.get();
  if (!doc.exists) return 'ไม่มีรายการที่รอยืนยันครับ พิมพ์คำสั่ง "ออเดอร์" ใหม่ได้เลย';

  const { order, createdAt } = doc.data();
  await ref.delete();
  if (Date.now() - createdAt > CONFIRM_WINDOW_MS) {
    return 'รายการที่ค้างไว้หมดอายุแล้ว (เกิน 10 นาที) กรุณาพิมพ์คำสั่ง "ออเดอร์" ใหม่อีกครั้งครับ';
  }

  await db.collection('orders').doc(order.id).set(order);
  return `✅ บันทึกออเดอร์แล้ว\n\n${formatOrderSummary(order)}`;
}

async function handleCancelCommand(userId) {
  const ref = db.collection('linePendingOrders').doc(userId);
  const doc = await ref.get();
  if (!doc.exists) return 'ไม่มีรายการที่ค้างไว้ครับ';
  await ref.delete();
  return 'ยกเลิกรายการที่ค้างไว้แล้วครับ';
}

// Shared by the text-command bot and the LIFF form submit endpoint — validates + builds
// the stock-in object without saving it.
async function buildStockinDraft(fields) {
  const missing = [];
  if (!fields['วัตถุดิบ']) missing.push('วัตถุดิบ');
  if (!fields['จำนวน']) missing.push('จำนวน');
  if (missing.length) return { ok: false, message: `❌ ข้อมูลไม่ครบ: ขาด ${missing.join(', ')}\n\n${HELP_TEXT}` };

  const qty = Number(fields['จำนวน']) || 0;
  if (qty <= 0) return { ok: false, message: '❌ จำนวนต้องมากกว่า 0' };

  const materialsSnap = await db.collection('materials').get();
  const materials = materialsSnap.docs.map(d => d.data());
  const wanted = fields['วัตถุดิบ'].trim().toLowerCase();
  const mat = materials.find(m => m.name && m.name.trim().toLowerCase() === wanted);
  if (!mat) {
    const names = materials.map(m => m.name).join(', ') || '(ยังไม่มีวัตถุดิบตั้งค่าไว้)';
    return { ok: false, message: `❌ ไม่พบวัตถุดิบ "${fields['วัตถุดิบ']}" ในระบบ\nวัตถุดิบที่มี: ${names}` };
  }

  const pricePerUnit = Number(fields['ราคาต่อหน่วย']) || 0;
  const stockin = {
    id: uid(),
    date: todayISOBangkok(),
    materialId: mat.id,
    qty,
    unit: mat.unit,
    pricePerUnit,
    totalPrice: qty * pricePerUnit,
    supplier: fields['ผู้ขาย'] || '',
    note: fields['หมายเหตุ'] || 'รับเข้าผ่านไลน์'
  };
  return { ok: true, stockin, materialName: mat.name };
}

function formatStockinSummary(stockin, materialName) {
  return `วัตถุดิบ: ${materialName}\nจำนวน: ${stockin.qty} ${stockin.unit}\nราคาต่อหน่วย: ${stockin.pricePerUnit} บาท\nรวม: ${stockin.totalPrice} บาท\nผู้ขาย: ${stockin.supplier || '-'}\nหมายเหตุ: ${stockin.note}`;
}

async function handleStockinCommand(fields) {
  const result = await buildStockinDraft(fields);
  if (!result.ok) return result.message;
  await db.collection('stockins').doc(result.stockin.id).set(result.stockin);
  return `✅ บันทึกรับสต๊อกแล้ว\n\n${formatStockinSummary(result.stockin, result.materialName)}`;
}

exports.lineWebhook = onRequest(
  { secrets: [LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN], region: 'asia-southeast1', invoker: 'public' },
  async (req, res) => {
    const signature = req.get('x-line-signature');
    // .trim() guards against a stray trailing newline/space picked up when the secret
    // was copy-pasted into `firebase functions:secrets:set` — that alone would make
    // every signature check fail with no other symptom than a 401.
    const expected = crypto.createHmac('sha256', LINE_CHANNEL_SECRET.value().trim()).update(req.rawBody).digest('base64');
    if (signature !== expected) {
      console.error('Signature mismatch', { got: signature, expected });
      res.status(401).send('invalid signature');
      return;
    }

    const events = (req.body && req.body.events) || [];
    const accessToken = LINE_CHANNEL_ACCESS_TOKEN.value().trim();

    for (const event of events) {
      if (event.type !== 'message' || event.message.type !== 'text') continue;
      const userId = event.source && event.source.userId;
      const lines = event.message.text.split('\n').map(l => l.trim()).filter(Boolean);
      const cmd = (lines[0] || '').trim();
      const fields = parseKeyValueLines(lines.slice(1));

      let replyText;
      try {
        if (['ออเดอร์', 'ยืนยัน', 'ยกเลิก'].includes(cmd) && !userId) {
          replyText = '❌ ใช้คำสั่งนี้ได้เฉพาะแชทส่วนตัวกับร้านครับ';
        } else if (cmd === 'ออเดอร์' && lines.length === 1) {
          // "ออเดอร์" typed alone (no label:value lines attached) -> switch to the
          // positional paste flow instead of immediately complaining about missing fields.
          await setAwaitingInput(userId, 'order');
          replyText = ORDER_PASTE_PROMPT;
        } else if (cmd === 'ออเดอร์') replyText = await handleOrderCommand(fields, userId);
        else if (cmd === 'ยืนยัน') replyText = await handleConfirmCommand(userId);
        else if (cmd === 'ยกเลิก') replyText = await handleCancelCommand(userId);
        else if (cmd === 'รับสต๊อก') replyText = await handleStockinCommand(fields);
        else if (cmd === 'ฟอร์ม') replyText = `📝 เปิดฟอร์มบันทึกข้อมูลได้ที่นี่ครับ:\nhttps://liff.line.me/${LIFF_ID}`;
        else {
          const awaiting = userId ? await popAwaitingInput(userId) : null;
          if (awaiting === 'order') {
            replyText = await handleOrderCommand(parsePositionalOrder(event.message.text), userId);
          } else {
            replyText = HELP_TEXT;
          }
        }
      } catch (err) {
        console.error(err);
        replyText = '❌ เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง';
      }

      await replyToLine(event.replyToken, replyText, accessToken);
    }

    res.status(200).send('OK');
  }
);

// Serves the dropdown option lists (products, materials, channels, payment methods) that
// the LIFF form (liff/index.html) needs to render its <select> inputs — kept in sync with
// Settings automatically since it reads straight from Firestore on every load.
exports.getFormOptions = onRequest({ region: 'asia-southeast1', invoker: 'public' }, async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const [productsDoc, channelsDoc, paymentMethodsDoc, materialsSnap] = await Promise.all([
      db.collection('settings').doc('products').get(),
      db.collection('settings').doc('channels').get(),
      db.collection('settings').doc('paymentMethods').get(),
      db.collection('materials').get()
    ]);
    res.json({
      products: (productsDoc.exists && productsDoc.data().value) || [],
      channels: (channelsDoc.exists && channelsDoc.data().value) || [],
      paymentMethods: (paymentMethodsDoc.exists && paymentMethodsDoc.data().value) || [],
      materials: materialsSnap.docs.map(d => d.data()).filter(m => (m.category || 'food') === 'food'),
      shippingStatuses: SHIPPING_STATUSES,
      paymentStatuses: PAYMENT_STATUSES
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Submit endpoint for the LIFF form. Reuses the exact same validation as the text-command
// bot (buildOrderDraft / buildStockinDraft) — a <select> populated by getFormOptions always
// sends an exact name match, so the "product not found" style errors should never actually
// fire here, but keeping the same validation path means the two entry points can never drift.
exports.liffSubmit = onRequest({ region: 'asia-southeast1', invoker: 'public' }, async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const { idToken, type, fields } = req.body || {};
    if (!idToken || !(await verifyLiffIdToken(idToken))) {
      res.status(401).json({ ok: false, message: 'ยืนยันตัวตนไม่สำเร็จ กรุณาเปิดฟอร์มใหม่อีกครั้ง' });
      return;
    }

    if (type === 'order') {
      const result = await buildOrderDraft(fields || {});
      if (!result.ok) { res.json(result); return; }
      await db.collection('orders').doc(result.order.id).set(result.order);
      res.json({ ok: true, message: '✅ บันทึกออเดอร์สำเร็จ', summary: formatOrderSummary(result.order) });
    } else if (type === 'stockin') {
      const result = await buildStockinDraft(fields || {});
      if (!result.ok) { res.json(result); return; }
      await db.collection('stockins').doc(result.stockin.id).set(result.stockin);
      res.json({ ok: true, message: '✅ บันทึกรับสต๊อกสำเร็จ', summary: formatStockinSummary(result.stockin, result.materialName) });
    } else {
      res.status(400).json({ ok: false, message: 'ไม่รู้จักประเภทฟอร์มนี้' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, message: 'เกิดข้อผิดพลาดฝั่งเซิร์ฟเวอร์ กรุณาลองใหม่อีกครั้ง' });
  }
});
