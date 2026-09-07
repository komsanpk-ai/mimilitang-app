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

// --- Recipe-based stock consumption — mirrors index.html's unitFactor/isWeightUnit/
// getIngredientUnitOptions/ingredientUnitToMaterialUnitFactor/computeConsumptionForOrder/
// applyConsumption exactly, so an order placed via LINE deducts raw-material stock the same
// way one placed through the web form does (the web app never recomputes this after the
// fact, so any order created without going through this math leaves stock permanently wrong).
function unitFactor(unitName) {
  if (unitName === 'กรัม') return { base: 'g', factor: 1 };
  if (unitName === 'กิโลกรัม') return { base: 'g', factor: 1000 };
  return { base: unitName, factor: 1 };
}
function isWeightUnit(unitName) { return unitFactor(unitName).base === 'g'; }
function isIngredientUnitAmbiguous(mat, ingUnit) {
  if (!mat) return false;
  let options;
  if (isWeightUnit(mat.unit)) {
    options = ['กรัม', 'กิโลกรัม'];
    if (Number(mat.pieceWeight) > 0) options.push('ชิ้น');
  } else if (mat.subUnitName && mat.subUnitCount > 0) {
    options = [mat.subUnitName, mat.unit];
  } else {
    options = [mat.unit];
  }
  return options.length > 1 && !options.includes(ingUnit);
}
function ingredientUnitToMaterialUnitFactor(mat, ingUnit) {
  if (!mat) return 1;
  if (isWeightUnit(mat.unit)) {
    if (ingUnit === 'ชิ้น' && Number(mat.pieceWeight) > 0) return Number(mat.pieceWeight) / unitFactor(mat.unit).factor;
    const ingF = unitFactor(ingUnit), matF = unitFactor(mat.unit);
    return ingF.factor / matF.factor;
  }
  if (mat.subUnitName && mat.subUnitCount > 0 && ingUnit === mat.subUnitName) return 1 / mat.subUnitCount;
  return 1;
}
function computeConsumptionForOrder(order, recipes, materialsById) {
  const usage = {};
  [['jarSmall', 'small'], ['jarLarge', 'large']].forEach(([field, size]) => {
    const qtyOrdered = Number(order[field]) || 0;
    if (qtyOrdered <= 0) return;
    const recipe = recipes.find(r => r.product === order.product && r.size === size);
    if (!recipe) return;
    const items = [...(recipe.ingredients || []), ...(recipe.otherCosts || []).filter(e => e.materialId !== undefined)];
    items.forEach(ing => {
      const mat = materialsById.get(ing.materialId);
      if (!mat) return;
      if (isIngredientUnitAmbiguous(mat, ing.unit)) return; // stale unit — skip rather than deduct a wrong amount
      const qtyInMatUnit = Number(ing.qty || 0) * ingredientUnitToMaterialUnitFactor(mat, ing.unit) * qtyOrdered;
      usage[mat.id] = (usage[mat.id] || 0) + qtyInMatUnit;
    });
  });
  return Object.keys(usage).map(id => ({ materialId: id, qty: usage[id] }));
}
// Writes the order AND applies its stock effect in one batch. For a fresh order pass no
// previousStockConsumed; for an edit pass the original order's _stockConsumed so that amount
// is restored before the newly-computed amount is deducted (exactly index.html's edit path:
// applyConsumption(old, +1) then applyConsumption(new, -1)).
async function commitOrderWithStockConsumption(order, previousStockConsumed) {
  const [recipesDoc, materialsSnap] = await Promise.all([
    db.collection('settings').doc('recipes').get(),
    db.collection('materials').get()
  ]);
  const recipes = (recipesDoc.exists && recipesDoc.data().value) || [];
  const materialsById = new Map(materialsSnap.docs.map(d => [d.id, d.data()]));

  const newConsumption = computeConsumptionForOrder(order, recipes, materialsById);

  const delta = {};
  (previousStockConsumed || []).forEach(c => { delta[c.materialId] = (delta[c.materialId] || 0) + c.qty; });
  newConsumption.forEach(c => { delta[c.materialId] = (delta[c.materialId] || 0) - c.qty; });

  const batch = db.batch();
  Object.entries(delta).forEach(([materialId, d]) => {
    if (!d) return;
    const mat = materialsById.get(materialId);
    if (!mat) return;
    const newStock = Math.round(((mat.currentStock || 0) + d) * 1e6) / 1e6;
    batch.update(db.collection('materials').doc(materialId), { currentStock: newStock });
  });

  const finalOrder = { ...order, _stockConsumed: newConsumption };
  batch.set(db.collection('orders').doc(finalOrder.id), finalOrder);
  await batch.commit();
  return finalOrder;
}

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

const HELP_TEXT = `พิมพ์คำสั่งตามแบบนี้ค่ะ

💡 พิมพ์คำว่า "ออเดอร์" เฉยๆ คำเดียว แล้วบอทจะบอกให้พิมพ์ข้อมูลทีละบรรทัดต่อเอง (ไม่ต้องจำชื่อฟิลด์)
💡 พิมพ์คำว่า "แก้ออเดอร์" แล้วบอกชื่อลูกค้า เพื่อเรียกออเดอร์ล่าสุดของลูกค้าคนนั้นกลับมาแก้ไข
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
const ORDER_FIELD_SEQUENCE = ['ลูกค้า', 'เบอร์', 'ที่อยู่', 'สินค้า', 'ถ้วยเล็ก', 'ถ้วยใหญ่', 'วันที่จัดส่ง', 'สถานะจัดส่ง', 'การชำระเงิน', 'ประเภทการจ่ายเงิน', 'หมายเหตุ', 'ค่าจัดส่ง', 'ส่วนลด', 'มัดจำ'];

function parsePositionalOrder(rawText) {
  const rows = rawText.split('\n').map(l => l.trim());
  const fields = {};
  ORDER_FIELD_SEQUENCE.forEach((key, i) => { if (rows[i]) fields[key] = rows[i]; });
  return fields;
}

// ISO 'YYYY-MM-DD' -> 'D/M/YYYY', matching the plain style people actually type (no
// leading zeros) so a re-copied prefill round-trips through parseThaiDate unchanged.
function isoToThaiDateDisplay(iso) {
  const [y, m, d] = iso.split('-');
  return `${Number(d)}/${Number(m)}/${y}`;
}

// Renders an existing order back into the same line order as ORDER_FIELD_SEQUENCE, so
// "แก้ออเดอร์" can show the user its current values and mergeEditLines can fall back to
// them line-by-line for whatever the reply leaves unchanged.
function orderToPositionalText(order) {
  return [
    order.customerName, order.phone, order.address, order.product,
    String(order.jarSmall), String(order.jarLarge),
    isoToThaiDateDisplay(order.deliveryDate),
    order.shippingStatus, order.paymentStatus, order.paymentMethod || '', order.note || '',
    String(order.shippingFee), String(order.discountValue), String(order.deposit)
  ].join('\n');
}

async function setAwaitingInput(userId, data) {
  await db.collection('lineAwaitingInput').doc(userId).set({ ...data, createdAt: Date.now() });
}
// Returns the whole staged {type, ...} payload (not just the type) so callers like
// "edit-order" can carry along which orderId is being edited; null if none/expired.
async function popAwaitingInput(userId) {
  const ref = db.collection('lineAwaitingInput').doc(userId);
  const doc = await ref.get();
  if (!doc.exists) return null;
  await ref.delete();
  const data = doc.data();
  return (Date.now() - data.createdAt <= CONFIRM_WINDOW_MS) ? data : null;
}

// A payment-slip photo can arrive as its own message, before, during, or after the order's
// text — so it's staged separately per user and picked up whenever an order gets built/
// committed, rather than requiring a strict order of messages.
const MAX_SLIP_BYTES = 700 * 1000; // stays comfortably under Firestore's ~1MiB per-document cap
async function downloadLineImageAsDataUrl(messageId, accessToken) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error('LINE content download failed: ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_SLIP_BYTES) return { error: 'too_large' };
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  return { dataUrl: `data:${contentType};base64,${buf.toString('base64')}` };
}
async function stageSlipImage(userId, dataUrl) {
  await db.collection('lineSlipStaging').doc(userId).set({ dataUrl, createdAt: Date.now() });
}
async function popStagedSlip(userId) {
  const ref = db.collection('lineSlipStaging').doc(userId);
  const doc = await ref.get();
  if (!doc.exists) return null;
  await ref.delete();
  const { dataUrl, createdAt } = doc.data();
  return (Date.now() - createdAt <= CONFIRM_WINDOW_MS) ? dataUrl : null;
}

// Resolves shorthand against a canonical list: an explicit alias first, then an exact
// (case-insensitive) match, then a substring match either direction — so "สด" matches
// "เงินสด" and "ส่งแล้ว" (via the alias map) resolves to "ส่งลูกค้าเรียบร้อย". Null if nothing fits.
function resolveAgainstList(wanted, options, aliases = {}) {
  const w = wanted.trim();
  if (aliases[w]) return aliases[w];
  const wl = w.toLowerCase();
  const exact = options.find(o => o.trim().toLowerCase() === wl);
  if (exact) return exact;
  return options.find(o => { const ol = o.trim().toLowerCase(); return ol.includes(wl) || wl.includes(ol); }) || null;
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
    // Fuzzy so shorthand like "สด"/"โอน"/"สแกน" matches the real configured
    // "เงินสด"/"โอนเงิน"/"สแกนจ่าย" without needing the full name typed out.
    paymentMethod = resolveAgainstList(fields['ประเภทการจ่ายเงิน'], methods) || fields['ประเภทการจ่ายเงิน'];
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
    const resolved = resolveAgainstList(wanted, SHIPPING_STATUSES, { 'ส่งแล้ว': 'ส่งลูกค้าเรียบร้อย' });
    if (!resolved) return { ok: false, message: `❌ สถานะจัดส่ง "${wanted}" ไม่ถูกต้อง (เลือกจาก: ${SHIPPING_STATUSES.join('/')} หรือ "ส่งแล้ว")` };
    shippingStatus = resolved;
  }

  let paymentStatus = PAYMENT_STATUSES[0];
  if (fields['การชำระเงิน']) {
    const wanted = fields['การชำระเงิน'].trim();
    const resolved = resolveAgainstList(wanted, PAYMENT_STATUSES, { 'รับเงินแล้ว': 'ได้รับเงินแล้ว' });
    if (!resolved) return { ok: false, message: `❌ การชำระเงิน "${wanted}" ไม่ถูกต้อง (เลือกจาก: ${PAYMENT_STATUSES.join('/')})` };
    paymentStatus = resolved;
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
    `หมายเหตุ: ${order.note}`,
    `สลิป: ${order.paymentSlip ? '📎 แนบแล้ว' : '-'}`
  ].join('\n');
}

// "ออเดอร์" never writes to Firestore directly — it stages the parsed order as a pending
// draft (one per LINE user) so a typo doesn't become a permanent record; "ยืนยัน" commits it.
async function handleOrderCommand(fields, userId) {
  const result = await buildOrderDraft(fields);
  if (!result.ok) return result.message;

  const stagedSlip = await popStagedSlip(userId);
  if (stagedSlip) result.order.paymentSlip = stagedSlip;

  await db.collection('linePendingOrders').doc(userId).set({ order: result.order, createdAt: Date.now() });
  return `📝 ตรวจสอบข้อมูลก่อนบันทึกค่ะ\n\n${formatOrderSummary(result.order)}\n\nถ้าถูกต้อง พิมพ์ "ยืนยัน" เพื่อบันทึกจริง หรือ "ยกเลิก" เพื่อยกเลิกรายการนี้นะคะ`;
}

async function handleConfirmCommand(userId) {
  const ref = db.collection('linePendingOrders').doc(userId);
  const doc = await ref.get();
  if (!doc.exists) return 'ไม่มีรายการที่รอยืนยันค่ะ พิมพ์คำสั่ง "ออเดอร์" ใหม่ได้เลยนะคะ';

  const { order, createdAt, previousStockConsumed } = doc.data();
  await ref.delete();
  if (Date.now() - createdAt > CONFIRM_WINDOW_MS) {
    return 'รายการที่ค้างไว้หมดอายุแล้ว (เกิน 10 นาที) กรุณาพิมพ์คำสั่ง "ออเดอร์" ใหม่อีกครั้งนะคะ';
  }

  // Covers a slip photo sent after the order text but before "ยืนยัน" — it wasn't attached
  // yet when the draft above was staged.
  if (!order.paymentSlip) {
    const stagedSlip = await popStagedSlip(userId);
    if (stagedSlip) order.paymentSlip = stagedSlip;
  }

  const finalOrder = await commitOrderWithStockConsumption(order, previousStockConsumed);
  return `✅ บันทึกออเดอร์แล้ว\n\n${formatOrderSummary(finalOrder)}`;
}

async function handleCancelCommand(userId) {
  const ref = db.collection('linePendingOrders').doc(userId);
  const doc = await ref.get();
  if (!doc.exists) return 'ไม่มีรายการที่ค้างไว้ค่ะ';
  await ref.delete();
  return 'ยกเลิกรายการที่ค้างไว้แล้วนะคะ';
}

// "แก้ออเดอร์" step 2: finds the most recent order whose customer name contains what was
// typed. Good enough for a one-person/small-team shop; doesn't disambiguate multiple matches
// since picking "the latest one" is what you want almost every time you're fixing a typo.
// Accepts free text containing a name and, optionally, a phone number (any order/format,
// e.g. "คุณดาว 0812340000" or two lines) — the phone narrows the match when several
// customers share a name. Picks the most recent match.
async function findOrderByCustomerName(text) {
  const phoneMatch = text.match(/\d[\d\-\s]{7,}\d/);
  const phoneDigits = phoneMatch ? phoneMatch[0].replace(/\D/g, '') : '';
  const namePart = text.replace(phoneMatch ? phoneMatch[0] : '', '').trim().toLowerCase();
  if (!namePart && !phoneDigits) return null;

  const snap = await db.collection('orders').get();
  let matches = snap.docs.map(d => d.data()).filter(o =>
    (!namePart || (o.customerName || '').toLowerCase().includes(namePart)) &&
    (!phoneDigits || (o.phone || '').includes(phoneDigits))
  );
  if (!matches.length) return null;
  matches.sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || ''));
  return matches[0];
}

// Fills in any line the user left blank/omitted with that same line from the order's
// current value, so "just retype the lines you're changing" works without needing a
// copy-paste round trip.
function mergeEditLines(original, editedText) {
  const originalLines = orderToPositionalText(original).split('\n');
  const editedLines = editedText.split('\n').map(l => l.trim());
  return ORDER_FIELD_SEQUENCE.map((_, i) => editedLines[i] || originalLines[i] || '').join('\n');
}

// Re-validates the merged lines exactly like a fresh order, then overwrites the SAME order
// id — preserving orderDate, channel and discountType, the only order fields the positional
// format still doesn't cover (channel/discountType aren't askable from LINE at all, so an
// order that already has them set — e.g. created on the web — can't have them wiped by a
// LINE-side edit of some unrelated field).
async function handleEditOrderCommand(rawText, userId, orderId) {
  const origDoc = await db.collection('orders').doc(orderId).get();
  if (!origDoc.exists) return 'ไม่พบออเดอร์นี้ในระบบแล้วค่ะ (อาจถูกลบไปแล้ว) พิมพ์ "แก้ออเดอร์" ใหม่อีกครั้งนะคะ';
  const original = origDoc.data();

  const mergedText = mergeEditLines(original, rawText);
  const result = await buildOrderDraft(parsePositionalOrder(mergedText));
  if (!result.ok) return result.message;

  const stagedSlip = await popStagedSlip(userId);

  const merged = {
    ...result.order,
    id: original.id,
    orderDate: original.orderDate,
    channel: original.channel,
    discountType: original.discountType,
    paymentSlip: stagedSlip || original.paymentSlip
  };

  await db.collection('linePendingOrders').doc(userId).set({
    order: merged, createdAt: Date.now(), previousStockConsumed: original._stockConsumed || []
  });
  return `📝 ตรวจสอบข้อมูลที่แก้ไขก่อนบันทึกค่ะ\n\n${formatOrderSummary(merged)}\n\nถ้าถูกต้อง พิมพ์ "ยืนยัน" เพื่อบันทึกจริง หรือ "ยกเลิก" เพื่อยกเลิกนะคะ`;
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
      if (event.type !== 'message') continue;
      const userId = event.source && event.source.userId;

      if (event.message.type === 'image') {
        let imgReply;
        if (!userId) {
          imgReply = '❌ ส่งสลิปได้เฉพาะแชทส่วนตัวกับร้านนะคะ';
        } else {
          try {
            const { dataUrl, error } = await downloadLineImageAsDataUrl(event.message.id, accessToken);
            if (error === 'too_large') imgReply = '❌ ไฟล์รูปใหญ่เกินไปค่ะ ลองส่งรูปที่ขนาดเล็กลงอีกนิด';
            else { await stageSlipImage(userId, dataUrl); imgReply = '📎 รับสลิปแล้วค่ะ พิมพ์ข้อมูลออเดอร์ต่อได้เลย (หรือพิมพ์ "ยืนยัน" ถ้ารอยืนยันอยู่)'; }
          } catch (err) {
            console.error(err);
            imgReply = '❌ รับรูปไม่สำเร็จ ลองส่งใหม่อีกครั้งนะคะ';
          }
        }
        await replyToLine(event.replyToken, imgReply, accessToken);
        continue;
      }

      if (event.message.type !== 'text') continue;
      const lines = event.message.text.split('\n').map(l => l.trim()).filter(Boolean);
      const cmd = (lines[0] || '').trim();
      const fields = parseKeyValueLines(lines.slice(1));

      let replyText;
      try {
        if (['ออเดอร์', 'ยืนยัน', 'ยกเลิก', 'แก้ออเดอร์'].includes(cmd) && !userId) {
          replyText = '❌ ใช้คำสั่งนี้ได้เฉพาะแชทส่วนตัวกับร้านนะคะ';
        } else if (cmd === 'ออเดอร์' && lines.length === 1) {
          // "ออเดอร์" typed alone (no label:value lines attached) -> switch to the
          // positional paste flow instead of immediately complaining about missing fields.
          await setAwaitingInput(userId, { type: 'order' });
          replyText = 'มีมี่ยินดีรับใช้ค่ะ กรอกข้อมูลลูกค้าได้เลยค่ะ';
        } else if (cmd === 'ออเดอร์') replyText = await handleOrderCommand(fields, userId);
        else if (cmd === 'ยืนยัน') replyText = await handleConfirmCommand(userId);
        else if (cmd === 'ยกเลิก') replyText = await handleCancelCommand(userId);
        else if (cmd === 'รับสต๊อก') replyText = await handleStockinCommand(fields);
        else if (cmd === 'แก้ออเดอร์') {
          await setAwaitingInput(userId, { type: 'edit-lookup' });
          replyText = 'มีมี่ยินดีรับใช้ค่ะ แจ้งชื่อลูกค้าเพื่อแก้ไขได้เลยค่ะ';
        } else if (cmd === 'ฟอร์ม') replyText = `📝 เปิดฟอร์มบันทึกข้อมูลได้ที่นี่ค่ะ:\nhttps://liff.line.me/${LIFF_ID}`;
        else {
          const awaiting = userId ? await popAwaitingInput(userId) : null;
          if (awaiting && awaiting.type === 'order') {
            replyText = await handleOrderCommand(parsePositionalOrder(event.message.text), userId);
          } else if (awaiting && awaiting.type === 'edit-lookup') {
            const found = await findOrderByCustomerName(event.message.text);
            if (!found) {
              replyText = `ไม่พบออเดอร์ของ "${event.message.text.trim()}" ค่ะ พิมพ์ "แก้ออเดอร์" ใหม่อีกครั้งนะคะ`;
            } else {
              await setAwaitingInput(userId, { type: 'edit-order', orderId: found.id });
              replyText = orderToPositionalText(found);
            }
          } else if (awaiting && awaiting.type === 'edit-order') {
            replyText = await handleEditOrderCommand(event.message.text, userId, awaiting.orderId);
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
      const finalOrder = await commitOrderWithStockConsumption(result.order, null);
      res.json({ ok: true, message: '✅ บันทึกออเดอร์สำเร็จ', summary: formatOrderSummary(finalOrder) });
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
