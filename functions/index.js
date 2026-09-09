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

// Mirrors index.html's fmt() exactly (Thai locale grouping, up to 2 decimals).
function fmt(n) { return Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 }); }

// Mirrors recipeIngredientCost/computeRecipeCost in index.html — reuses the same
// isIngredientUnitAmbiguous/ingredientUnitToMaterialUnitFactor already defined above for
// stock consumption, so a recipe's per-cup cost is computed identically in both places.
function recipeIngredientCostServer(ing, materialsById) {
  const mat = materialsById.get(ing.materialId);
  if (!mat || mat.latestPrice == null) return { cost: 0, missingPrice: !!mat };
  if (isIngredientUnitAmbiguous(mat, ing.unit)) return { cost: 0, missingPrice: false };
  const qtyInMatUnit = Number(ing.qty || 0) * ingredientUnitToMaterialUnitFactor(mat, ing.unit);
  return { cost: qtyInMatUnit * mat.latestPrice, missingPrice: false };
}
function computeRecipeCostServer(recipe, materialsById) {
  let cost = 0, hasMissingPrice = false;
  (recipe.ingredients || []).forEach(ing => {
    const r = recipeIngredientCostServer(ing, materialsById);
    cost += r.cost; if (r.missingPrice) hasMissingPrice = true;
  });
  (recipe.otherCosts || []).forEach(entry => {
    if (entry.materialId !== undefined) {
      const r = recipeIngredientCostServer(entry, materialsById);
      cost += r.cost; if (r.missingPrice) hasMissingPrice = true;
    } else {
      cost += Number(entry.amount) || 0;
    }
  });
  return { cost, hasMissingPrice };
}

// Mirrors computeAmounts() in index.html exactly.
function computeAmountsServer(o, products) {
  const prod = products.find(p => p.name === o.product) || { priceSmall: 0, priceLarge: 0 };
  const small = Number(o.jarSmall) || 0, large = Number(o.jarLarge) || 0;
  const subtotal = small * prod.priceSmall + large * prod.priceLarge;
  const shipping = Number(o.shippingFee) || 0;
  const discountVal = Number(o.discountValue) || 0;
  const discountAmount = o.discountType === 'percent' ? subtotal * discountVal / 100 : discountVal;
  const grandTotal = Math.max(subtotal + shipping - discountAmount, 0);
  const deposit = Number(o.deposit) || 0;
  const amountReceived = o.paymentStatus === 'ได้รับเงินแล้ว' ? grandTotal : deposit;
  return { subtotal, shipping, discountAmount, grandTotal, deposit, amountReceived };
}

// Monday..Sunday of the week containing todayISOBangkok(), and the 1st..last day of the
// current calendar month — the two extra report windows alongside "today".
function startOfWeekISO(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return d.toISOString().slice(0, 10);
}
function monthRangeISO(iso) {
  const [y, m] = iso.split('-');
  const from = `${y}-${m}-01`;
  const lastDay = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
  const to = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
  return [from, to];
}
// "1"/"2"/"3" -> {from, to} for today / this week / this month, or null if not one of those.
function periodFromChoice(choice) {
  const today = todayISOBangkok();
  if (choice === '1') return { from: today, to: today };
  if (choice === '2') { const from = startOfWeekISO(today); return { from, to: addDaysISO(from, 6) }; }
  if (choice === '3') { const [from, to] = monthRangeISO(today); return { from, to }; }
  return null;
}

// รายงาน > 1 ยอดขาย > (period) — cup counts + revenue/cost/profit/shipping/discount, with a
// revenue-relative ratio (cost% + profit% = 100%, matching standard margin-of-revenue bookkeeping).
async function buildSalesSummaryReport(fromISO, toISO) {
  const [ordersSnap, productsDoc, recipesDoc, materialsSnap] = await Promise.all([
    db.collection('orders').where('orderDate', '>=', fromISO).where('orderDate', '<=', toISO).get(),
    db.collection('settings').doc('products').get(),
    db.collection('settings').doc('recipes').get(),
    db.collection('materials').get()
  ]);
  const periodOrders = ordersSnap.docs.map(d => d.data()).filter(o => o.shippingStatus !== 'ยกเลิก');
  const products = (productsDoc.exists && productsDoc.data().value) || [];
  const recipes = (recipesDoc.exists && recipesDoc.data().value) || [];
  const materialsById = new Map(materialsSnap.docs.map(d => [d.id, d.data()]));

  let totalSmall = 0, totalLarge = 0, totalRevenue = 0, totalCost = 0, totalShipping = 0, totalDiscount = 0;
  let hasMissingPrice = false, hasMissingRecipe = false;

  for (const o of periodOrders) {
    const small = Number(o.jarSmall) || 0, large = Number(o.jarLarge) || 0;
    totalSmall += small; totalLarge += large;

    const amt = computeAmountsServer(o, products);
    totalRevenue += Math.max(amt.subtotal - amt.discountAmount, 0);
    totalShipping += amt.shipping;
    totalDiscount += amt.discountAmount;

    for (const [field, size] of [['jarSmall', 'small'], ['jarLarge', 'large']]) {
      const qty = Number(o[field]) || 0;
      if (qty <= 0) continue;
      const recipe = recipes.find(r => r.product === o.product && r.size === size);
      if (!recipe) { hasMissingRecipe = true; continue; }
      const r = computeRecipeCostServer(recipe, materialsById);
      totalCost += r.cost * qty;
      if (r.hasMissingPrice) hasMissingPrice = true;
    }
  }

  const totalCups = totalSmall + totalLarge;
  const profit = totalRevenue - totalCost;
  const pct = (part, whole) => whole > 0 ? part / whole * 100 : 0;

  const lines = [
    `ถ้วยเล็ก ${fmt(totalSmall)} ถ้วย ${fmt(pct(totalSmall, totalCups))}%`,
    `ถ้วยใหญ่ ${fmt(totalLarge)} ถ้วย ${fmt(pct(totalLarge, totalCups))}%`,
    `รวม ${fmt(totalCups)} ถ้วย`,
    `ยอดขายรวม = ${fmt(totalRevenue)} บาท`,
    `ต้นทุนและค่าใช้จ่าย = ${fmt(totalCost)} บาท`,
    `กำไรรวม = ${fmt(profit)} บาท`,
    `ค่าจัดส่งรวม = ${fmt(totalShipping)} บาท`,
    `ส่วนลดรวม = ${fmt(totalDiscount)} บาท`,
    `สัดส่วน รายได้ 100% ต้นทุน ${fmt(pct(totalCost, totalRevenue))}% กำไร ${fmt(pct(profit, totalRevenue))}%`
  ];
  if (hasMissingPrice || hasMissingRecipe) {
    lines.push('⚠️ บางรายการยังไม่มีสูตร/ราคาวัตถุดิบครบ ต้นทุนจริงอาจสูงกว่านี้');
  }
  return lines.join('\n\n');
}

// รายงาน > 2 > 1 จำนวนลูกค้า > (period) — "new" means this phone's earliest-ever order (across
// all history, not just this window) falls inside the window; everyone else who ordered in
// the window is "repeat" — same first-order-date rule the app's own reports use elsewhere.
async function buildCustomerCountReport(fromISO, toISO) {
  const snap = await db.collection('orders').get();
  const allOrders = snap.docs.map(d => d.data()).filter(o => o.shippingStatus !== 'ยกเลิก' && o.phone);

  const firstOrderByPhone = new Map();
  allOrders.forEach(o => {
    const cur = firstOrderByPhone.get(o.phone);
    if (!cur || o.orderDate < cur) firstOrderByPhone.set(o.phone, o.orderDate);
  });

  const customersInPeriod = new Set(
    allOrders.filter(o => o.orderDate >= fromISO && o.orderDate <= toISO).map(o => o.phone)
  );

  let newCount = 0, oldCount = 0;
  customersInPeriod.forEach(phone => {
    const first = firstOrderByPhone.get(phone);
    if (first >= fromISO && first <= toISO) newCount++; else oldCount++;
  });
  const total = newCount + oldCount;
  const pct = (part) => total > 0 ? part / total * 100 : 0;

  return [
    `ลูกค้าใหม่ ${fmt(newCount)} คน ${fmt(pct(newCount))}%`,
    `ลูกค้าเก่า ${fmt(oldCount)} คน ${fmt(pct(oldCount))}%`,
    `รวม ${fmt(total)} คน`
  ].join('\n\n');
}

// รายงาน > 2 > 2 จำนวนครั้งที่ลูกค้าซื้อซ้ำ — all-time (not period-bound): how many distinct
// customers have placed exactly 2, 3, 4, or 5-or-more orders ever. 5+ (not "exactly 5") so a
// 10-order VIP still shows up somewhere instead of vanishing from every line.
async function buildRepeatCustomerReport() {
  const snap = await db.collection('orders').get();
  const orders = snap.docs.map(d => d.data()).filter(o => o.shippingStatus !== 'ยกเลิก' && o.phone);
  const countByPhone = {};
  orders.forEach(o => { countByPhone[o.phone] = (countByPhone[o.phone] || 0) + 1; });
  const counts = Object.values(countByPhone);

  const c2 = counts.filter(c => c === 2).length;
  const c3 = counts.filter(c => c === 3).length;
  const c4 = counts.filter(c => c === 4).length;
  const c5plus = counts.filter(c => c >= 5).length;

  return [
    `จำนวนลูกค้าที่ซื้อซ้ำ 2 ครั้ง ${fmt(c2)} คน`,
    `จำนวนลูกค้าที่ซื้อซ้ำ 3 ครั้ง ${fmt(c3)} คน`,
    `จำนวนลูกค้าที่ซื้อซ้ำ 4 ครั้ง ${fmt(c4)} คน`,
    `จำนวนลูกค้าที่ซื้อซ้ำ 5 ครั้งขึ้นไป ${fmt(c5plus)} คน`
  ].join('\n\n');
}

// รายงาน > 3 — same red/"ต้องสั่งซื้อเพิ่ม" threshold as materialStatus() on the web stock page
// (currentStock <= reorderPoint, only when a reorder point is actually set).
async function buildLowStockReport() {
  const snap = await db.collection('materials').get();
  const danger = snap.docs.map(d => d.data()).filter(m => {
    const stock = Number(m.currentStock) || 0, rp = Number(m.reorderPoint) || 0;
    return rp > 0 && stock <= rp;
  });
  if (!danger.length) return '✅ ไม่มีวัตถุดิบที่ต้องสั่งซื้อเพิ่มตอนนี้ค่ะ';
  return '🔴 วัตถุดิบที่ต้องสั่งซื้อเพิ่ม:\n\n' + danger.map(m => `${m.name} เหลือ ${fmt(m.currentStock)} ${m.unit}`).join('\n\n');
}

// รายงาน > 4 > (period) — cash actually collected (amountReceived, same convention as the
// web app's payment breakdown) grouped by whatever payment methods are really configured.
async function buildPaymentReport(fromISO, toISO) {
  const [ordersSnap, pmDoc, productsDoc] = await Promise.all([
    db.collection('orders').where('orderDate', '>=', fromISO).where('orderDate', '<=', toISO).get(),
    db.collection('settings').doc('paymentMethods').get(),
    db.collection('settings').doc('products').get()
  ]);
  const orders = ordersSnap.docs.map(d => d.data()).filter(o => o.shippingStatus !== 'ยกเลิก');
  const methods = (pmDoc.exists && pmDoc.data().value) || [];
  const products = (productsDoc.exists && productsDoc.data().value) || [];

  const byMethod = {};
  let total = 0;
  orders.forEach(o => {
    const amt = computeAmountsServer(o, products);
    if (amt.amountReceived <= 0) return;
    const key = o.paymentMethod || '(ไม่ระบุ)';
    byMethod[key] = (byMethod[key] || 0) + amt.amountReceived;
    total += amt.amountReceived;
  });

  const lines = methods.map(m => `${m} = ${fmt(byMethod[m] || 0)} บาท ${fmt(total > 0 ? (byMethod[m] || 0) / total * 100 : 0)}%`);
  lines.push(`รวมเป็นยอดเงินรับทั้งหมด = ${fmt(total)} บาท`);
  return lines.join('\n\n');
}

// รายงาน > 5 — filtered by deliveryDate (not orderDate, unlike every other report here):
// this is a picking/delivery list for what has to physically go out today, not what was sold.
async function buildDeliveryReport(dateISO) {
  const [snap, productsDoc] = await Promise.all([
    db.collection('orders').where('deliveryDate', '==', dateISO).get(),
    db.collection('settings').doc('products').get()
  ]);
  const orders = snap.docs.map(d => d.data()).filter(o => o.shippingStatus !== 'ยกเลิก');
  const products = (productsDoc.exists && productsDoc.data().value) || [];
  const dateLabel = isoToThaiDateDisplay(dateISO);

  if (!orders.length) return `วันที่ ${dateLabel}\nยังไม่มีออเดอร์ที่ต้องเตรียมส่งค่ะ`;

  const productNames = [...new Set(orders.map(o => o.product))];
  const productSuffix = productNames.length === 1 ? ` ${productNames[0]}` : '';

  let totalSmall = 0, totalLarge = 0;
  const entries = orders.map((o, i) => {
    const small = Number(o.jarSmall) || 0, large = Number(o.jarLarge) || 0;
    totalSmall += small; totalLarge += large;
    const amt = computeAmountsServer(o, products);

    // Only listed when actually present on this order — a shipping/deposit/discount line
    // that's always "0 บาท" would just be noise on every single entry.
    const extras = [];
    if (amt.shipping > 0) extras.push(`ค่าจัดส่ง ${fmt(amt.shipping)} บาท`);
    if (amt.deposit > 0) extras.push(`มัดจำ ${fmt(amt.deposit)} บาท`);
    if (amt.discountAmount > 0) extras.push(`ส่วนลด ${fmt(amt.discountAmount)} บาท`);

    const rows = [
      `${i + 1}.${o.customerName}`,
      `ที่อยู่ ${o.address || '-'}`,
      `ถ้วยเล็ก ${fmt(small)} ถ้วย / ใหญ่ ${fmt(large)} ถ้วย`,
      `ยอดรวม ${fmt(amt.grandTotal)} บาท`
    ];
    if (extras.length) rows.push(`(${extras.join(' / ')})`);
    return rows.join('\n');
  });

  return [
    `วันที่ ${dateLabel}`,
    `รวม ${orders.length} ออเดอร์${productSuffix}`,
    entries.join('\n\n'),
    `แบ่งเป็น เล็ก ${fmt(totalSmall)} ถ้วย / ใหญ่ ${fmt(totalLarge)} ถ้วย`,
    `รวมทั้งหมด ${fmt(totalSmall + totalLarge)} ถ้วย`
  ].join('\n\n');
}

// Mirrors computePrepData()/renderPrepMaterialRows() in index.html exactly — same source
// data (orders by deliveryDate), same computeConsumptionForOrder aggregation, same
// pieceWeight/subUnit "estimated piece count" column logic, same food/supply split.
const PREP_SEPARATOR = '........................................................................';
function padPrepLabel(name, width = 22) {
  return name.length >= width ? name + ' ' : name.padEnd(width, ' ');
}
async function buildPrepChecklistReport(dateISO) {
  const [ordersSnap, recipesDoc, materialsSnap] = await Promise.all([
    db.collection('orders').where('deliveryDate', '==', dateISO).get(),
    db.collection('settings').doc('recipes').get(),
    db.collection('materials').get()
  ]);
  const list = ordersSnap.docs.map(d => d.data()).filter(o => o.shippingStatus !== 'ยกเลิก');
  const recipes = (recipesDoc.exists && recipesDoc.data().value) || [];
  const materialsById = new Map(materialsSnap.docs.map(d => [d.id, d.data()]));
  const dateLabel = isoToThaiDateDisplay(dateISO);

  if (!list.length) return `วันที่เตรียม (สำหรับส่ง) ${dateLabel}\nไม่มีออเดอร์ที่ต้องจัดส่งวันนี้ค่ะ`;

  let totalSmall = 0, totalLarge = 0, uncoveredCount = 0;
  const usage = {};
  list.forEach(o => {
    totalSmall += Number(o.jarSmall) || 0;
    totalLarge += Number(o.jarLarge) || 0;
    computeConsumptionForOrder(o, recipes, materialsById).forEach(item => {
      usage[item.materialId] = (usage[item.materialId] || 0) + item.qty;
    });
    [['jarSmall', 'small'], ['jarLarge', 'large']].forEach(([field, size]) => {
      if ((Number(o[field]) || 0) <= 0) return;
      if (!recipes.find(r => r.product === o.product && r.size === size)) uncoveredCount++;
    });
  });

  const materialsNeeded = Object.keys(usage)
    .map(id => ({ material: materialsById.get(id), qty: usage[id] }))
    .filter(x => x.material);
  const foodMaterials = materialsNeeded.filter(x => (x.material.category || 'food') === 'food');
  const supplyMaterials = materialsNeeded.filter(x => x.material.category === 'supply');

  const pieceEstimate = (x) => {
    const mat = x.material;
    if (Number(mat.pieceWeight) > 0) return `${fmt(x.qty / mat.pieceWeight)} ชิ้น`;
    if (mat.subUnitName && Number(mat.subUnitCount) > 0) return `${fmt(x.qty * mat.subUnitCount)} ${mat.subUnitName}`;
    return '-';
  };

  const cupsBlock = [
    `${padPrepLabel('ถ้วยเล็ก')}${fmt(totalSmall)} ถ้วย`,
    `${padPrepLabel('ถ้วยใหญ่')}${fmt(totalLarge)} ถ้วย`,
    `${padPrepLabel('รวมทั้งหมด (เล็ก+ใหญ่ทุกสินค้า)', 30)}${fmt(totalSmall + totalLarge)} ถ้วย`
  ].join('\n\n');
  const foodBlock = foodMaterials.length
    ? foodMaterials.map(x => `${x.material.name}\n${fmt(x.qty)} ${x.material.unit} , ${pieceEstimate(x)}`).join('\n\n')
    : 'ไม่มีวัตถุดิบอาหารที่ต้องเตรียม';
  const supplyBlock = supplyMaterials.length
    ? supplyMaterials.map(x => `${padPrepLabel(x.material.name)}${fmt(x.qty)} ${x.material.unit}`).join('\n\n')
    : 'ไม่มีอุปกรณ์/บรรจุภัณฑ์ที่ต้องเตรียม';

  const lines = [
    `🥣 สินค้าที่ต้องเตรียม/ผลิต\n\n${cupsBlock}`,
    PREP_SEPARATOR,
    `🥬 วัตถุดิบอาหารที่ต้องเตรียม\n\n${foodBlock}`,
    PREP_SEPARATOR,
    `📦 อุปกรณ์/บรรจุภัณฑ์ที่ต้องเตรียม\n\n${supplyBlock}`,
    PREP_SEPARATOR
  ];
  if (uncoveredCount > 0) {
    lines.push(`⚠️ มี ${uncoveredCount} รายการสินค้า/ขนาดที่ยังไม่ได้ตั้งสูตร รายการวัตถุดิบด้านบนอาจไม่ครบ`);
  }
  return lines.join('\n\n');
}

const REPORT_TOP_MENU = 'มีมี่ มีรายงานที่คุณต้องการดังนี้ กดเลือกหมายเลขได้เลยค่ะ\n1. สรุปรายชื่อและออเดอร์เตรียมส่ง\n2. เช็คลิสต์เตรียมของ\n3. รายงานยอดขาย\n4. รายงานลูกค้า\n5. รายงานสินค้าใกล้หมดต้องซื้อ\n6. รายงานการจ่ายเงิน';
const REPORT_DELIVERY_SUBMENU = 'เลือกหมายเลขประเภทรายงานได้เลยค่ะ\n1 สรุปเตรียมส่งวันนี้\n2 สรุปเตรียมส่งพรุ่งนี้';
const REPORT_SALES_SUBMENU = 'เลือกหมายเลขประเภทรายงานได้เลยค่ะ\n1 ยอดขายรายวัน\n2 ยอดขายรายสัปดาห์\n3 ยอดขายรายเดือน';
const REPORT_CUSTOMER_SUBMENU = 'เลือกหมายเลขประเภทรายงานได้เลยค่ะ\n1 จำนวนลูกค้า\n2 จำนวนครั้งที่ลูกค้าซื้อซ้ำ';
const REPORT_CUSTOMER_COUNT_SUBMENU = 'เลือกหมายเลขประเภทรายงานได้เลยค่ะ\n1 จำนวนลูกค้ารายวัน\n2 รายสัปดาห์\n3 รายเดือน';
const REPORT_PAYMENT_SUBMENU = 'เลือกหมายเลขประเภทรายงานได้เลยค่ะ\n1 รายวัน\n2 สัปดาห์\n3 เดือน';
const REPORT_INVALID_CHOICE = 'กรุณาเลือกหมายเลขที่แสดงไว้ค่ะ';

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
// Left blank, "สินค้า"/"ช่องทาง" fall back to these rather than erroring or staying empty —
// the shop's overwhelming majority case, so typing them every single time is pure friction.
const DEFAULT_PRODUCT_NAME = 'ลี่ถัง 8 เซียน';
const DEFAULT_CHANNEL = 'Facebook';

// Kept short deliberately — this fires on every unrecognized message, so it must never be
// the long field-by-field reference that used to live here.
const HELP_TEXT = 'พิมพ์ "ออเดอร์" เพื่อบันทึกออเดอร์, "รับสต๊อก" เพื่อบันทึกวัตถุดิบเข้า, "รายงาน" เพื่อดูรายงาน, หรือ "ฟอร์ม" เพื่อเปิดหน้ากรอกแบบมีปุ่มกดค่ะ';

const CONFIRM_WINDOW_MS = 10 * 60 * 1000; // pending order draft / awaiting-input state expires after 10 minutes

// Copyable label+dash template flow: type "ออเดอร์" alone -> bot sends a template with every
// field already labeled ("ชื่อลูกค้า -", "สถานะการจัดส่ง -รอเตรียมส่ง", ...) -> the reply is
// parsed by matching each line's label, not its position, so leaving lines blank/reordering/
// skipping some can never misalign a later field the way pure positional parsing could.
const ORDER_TEMPLATE_FIELDS = [
  { label: 'ชื่อลูกค้า', key: 'ลูกค้า' },
  { label: 'เบอร์โทร', key: 'เบอร์' },
  { label: 'ที่อยู่', key: 'ที่อยู่' },
  { label: 'สินค้า', key: 'สินค้า', default: DEFAULT_PRODUCT_NAME },
  { label: 'ถ้วยเล็ก', key: 'ถ้วยเล็ก' },
  { label: 'ถ้วยใหญ่', key: 'ถ้วยใหญ่' },
  { label: 'วันที่จัดส่ง', key: 'วันที่จัดส่ง' },
  { label: 'ช่องทาง', key: 'ช่องทาง', default: DEFAULT_CHANNEL },
  { label: 'สถานะการจัดส่ง', key: 'สถานะจัดส่ง', default: 'รอเตรียมส่ง' },
  { label: 'การชำระเงิน', key: 'การชำระเงิน', default: 'ยังไม่ได้รับเงิน' },
  { label: 'ประเภทการจ่ายเงิน', key: 'ประเภทการจ่ายเงิน', default: 'เงินสด' },
  { label: 'หมายเหตุ', key: 'หมายเหตุ' },
  { label: 'ค่าจัดส่ง (บาท)', key: 'ค่าจัดส่ง' },
  { label: 'ส่วนลด', key: 'ส่วนลด' },
  { label: 'มัดจำ (บาท)', key: 'มัดจำ' }
];
// Longest label first so "ค่าจัดส่ง (บาท)" is matched whole rather than being shadowed by
// a shorter label that happens to be its prefix.
const TEMPLATE_FIELDS_BY_LABEL_LENGTH = [...ORDER_TEMPLATE_FIELDS].sort((a, b) => b.label.length - a.label.length);

function blankOrderTemplate() {
  return ORDER_TEMPLATE_FIELDS.map(f => `${f.label} -${f.default || ''}`).join('\n');
}

// "label -value" (space before the dash optional, space after optional) on each line, in any
// order — a line whose label doesn't match anything known, or whose value is empty, is simply
// skipped, leaving that field absent so buildOrderDraft's own default applies.
function parseTemplateOrder(rawText) {
  const fields = {};
  for (const rawLine of rawText.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = TEMPLATE_FIELDS_BY_LABEL_LENGTH.find(f => line.startsWith(f.label));
    if (!match) continue;
    let rest = line.slice(match.label.length).trim();
    if (rest.startsWith('-')) rest = rest.slice(1).trim();
    if (rest) fields[match.key] = rest;
  }
  return fields;
}

// ISO 'YYYY-MM-DD' -> 'D/M/YY', matching the plain style people actually type (no leading
// zeros, 2-digit year) so a re-copied prefill round-trips through parseThaiDate unchanged.
function isoToThaiDateDisplay(iso) {
  const [y, m, d] = iso.split('-');
  return `${Number(d)}/${Number(m)}/${y.slice(2)}`;
}

// An existing order's current values keyed the same way buildOrderDraft's `fields` are, so
// they can seed a template pre-filled with "what's on file now" and be merged with whatever
// the edited reply actually supplies.
function orderToFieldsMap(order) {
  return {
    'ลูกค้า': order.customerName,
    'เบอร์': order.phone,
    'ที่อยู่': order.address || '',
    'สินค้า': order.product,
    'ถ้วยเล็ก': String(order.jarSmall),
    'ถ้วยใหญ่': String(order.jarLarge),
    'วันที่จัดส่ง': isoToThaiDateDisplay(order.deliveryDate),
    'ช่องทาง': order.channel || '',
    'สถานะจัดส่ง': order.shippingStatus,
    'การชำระเงิน': order.paymentStatus,
    'ประเภทการจ่ายเงิน': order.paymentMethod || '',
    'หมายเหตุ': order.note || '',
    'ค่าจัดส่ง': String(order.shippingFee),
    'ส่วนลด': String(order.discountValue),
    'มัดจำ': String(order.deposit)
  };
}
// Same template shape as blankOrderTemplate, but pre-filled with an existing order's values
// instead of the fresh-order defaults — what "แก้ออเดอร์" hands back to edit.
function orderToTemplateText(order) {
  const values = orderToFieldsMap(order);
  return ORDER_TEMPLATE_FIELDS.map(f => `${f.label} -${values[f.key] || ''}`).join('\n');
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

// D/M/YY or D/M/YYYY (Gregorian) -> YYYY-MM-DD, or null if not a real calendar date.
// A 2-digit year is treated as 20YY — this app has no plausible dates before 2000.
function parseThaiDate(s) {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyRaw] = m;
  const yyyy = yyRaw.length === 2 ? '20' + yyRaw : yyRaw;
  const iso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(dd) || d.getUTCMonth() + 1 !== Number(mm)) return null;
  return iso;
}

// `textOrTexts` is either one string or an array of up to 5 — e.g. the short greeting as its
// own bubble followed by the copyable template as a separate one, so pasting the template
// doesn't drag the greeting sentence along with it.
async function replyToLine(replyToken, textOrTexts, accessToken) {
  const texts = Array.isArray(textOrTexts) ? textOrTexts : [textOrTexts];
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({ replyToken, messages: texts.map(text => ({ type: 'text', text })) })
  });
}

// Validates + builds the order object, but does not save it — the caller decides whether
// to hold it as a pending draft (awaiting "ยืนยัน") or write it straight to Firestore.
async function buildOrderDraft(fields) {
  const missing = [];
  if (!fields['ลูกค้า']) missing.push('ลูกค้า');
  if (!fields['เบอร์']) missing.push('เบอร์');
  if (missing.length) return { ok: false, message: `❌ ข้อมูลไม่ครบ: ขาด ${missing.join(', ')}ค่ะ` };

  const phoneDigits = fields['เบอร์'].replace(/[^0-9]/g, '');
  if (phoneDigits.length < 9 || phoneDigits.length > 10) {
    return { ok: false, message: `❌ เบอร์โทร "${fields['เบอร์']}" ดูไม่ถูกต้อง (ควรเป็นตัวเลข 9-10 หลัก)` };
  }

  const jarSmall = Number(fields['ถ้วยเล็ก']) || 0;
  const jarLarge = Number(fields['ถ้วยใหญ่']) || 0;
  if (jarSmall <= 0 && jarLarge <= 0) return { ok: false, message: '❌ กรุณาระบุจำนวนถ้วยเล็กหรือถ้วยใหญ่อย่างน้อย 1 อย่าง' };

  const productsDoc = await db.collection('settings').doc('products').get();
  const products = (productsDoc.exists && productsDoc.data().value) || [];
  const wantedProduct = fields['สินค้า'] || DEFAULT_PRODUCT_NAME;
  const productMatch = products.find(p => p.name && p.name.trim().toLowerCase() === wantedProduct.trim().toLowerCase());
  if (!productMatch) {
    const names = products.map(p => p.name).join(', ') || '(ยังไม่มีสินค้าตั้งค่าไว้)';
    return { ok: false, message: `❌ ไม่พบสินค้า "${wantedProduct}" ในระบบ\nสินค้าที่มี: ${names}` };
  }

  const channelsDoc = await db.collection('settings').doc('channels').get();
  const channels = (channelsDoc.exists && channelsDoc.data().value) || [];
  const wantedChannel = fields['ช่องทาง'] || DEFAULT_CHANNEL;
  const channel = resolveAgainstList(wantedChannel, channels) || wantedChannel;

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
    if (!parsed) return { ok: false, message: `❌ วันที่จัดส่ง "${fields['วันที่จัดส่ง']}" ไม่ถูกต้อง (รูปแบบ วัน/เดือน/ปี เช่น 25/12/26)` };
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
  let doc = await ref.get();

  if (!doc.exists) {
    // Nothing staged yet — if an order was pulled up for editing and the only thing sent
    // since was a slip photo (no text edit), treat "ยืนยัน" as confirming it unchanged
    // rather than making the user resend the whole template just to attach a slip.
    const awaiting = await popAwaitingInput(userId);
    if (awaiting && awaiting.type === 'edit-order') {
      const orderDoc = await db.collection('orders').doc(awaiting.orderId).get();
      if (orderDoc.exists) {
        const stageResult = await handleEditOrderCommand(orderToTemplateText(orderDoc.data()), userId, awaiting.orderId);
        doc = await ref.get();
        if (!doc.exists) return stageResult; // staging itself failed — surface why
      } else {
        return 'ไม่มีรายการที่รอยืนยันค่ะ พิมพ์คำสั่ง "ออเดอร์" ใหม่ได้เลยนะคะ';
      }
    } else {
      return 'ไม่มีรายการที่รอยืนยันค่ะ พิมพ์คำสั่ง "ออเดอร์" ใหม่ได้เลยนะคะ';
    }
  }

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

// Re-validates the merged fields exactly like a fresh order, then overwrites the SAME order
// id — preserving orderDate and discountType, the only order field the template still
// doesn't cover (an order that already has a percent-based discount set on the web can't
// have that silently reset to "baht" by a LINE-side edit of some unrelated field).
async function handleEditOrderCommand(rawText, userId, orderId) {
  const origDoc = await db.collection('orders').doc(orderId).get();
  if (!origDoc.exists) return 'ไม่พบออเดอร์นี้ในระบบแล้วค่ะ (อาจถูกลบไปแล้ว) พิมพ์ "แก้ออเดอร์" ใหม่อีกครั้งนะคะ';
  const original = origDoc.data();

  // Values from the reply override the order's current ones; anything not present in the
  // reply (blank/removed line, or an unrecognized label) keeps its current value — a
  // template line left untouched already carries that current value verbatim anyway.
  const mergedFields = { ...orderToFieldsMap(original), ...parseTemplateOrder(rawText) };
  const result = await buildOrderDraft(mergedFields);
  if (!result.ok) return result.message;

  const stagedSlip = await popStagedSlip(userId);

  const merged = {
    ...result.order,
    id: original.id,
    orderDate: original.orderDate,
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
  if (missing.length) return { ok: false, message: `❌ ข้อมูลไม่ครบ: ขาด ${missing.join(', ')}ค่ะ` };

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
        if (['ออเดอร์', 'ยืนยัน', 'ยกเลิก', 'แก้ออเดอร์', 'รายงาน'].includes(cmd) && !userId) {
          replyText = '❌ ใช้คำสั่งนี้ได้เฉพาะแชทส่วนตัวกับร้านนะคะ';
        } else if (cmd === 'ออเดอร์' && lines.length === 1) {
          // "ออเดอร์" typed alone (no label:value lines attached) -> send the copyable
          // template as its own bubble instead of immediately complaining about missing fields.
          await setAwaitingInput(userId, { type: 'order' });
          replyText = ['มีมี่ยินดีรับใช้ค่ะ กรอกข้อมูลลูกค้าได้เลยค่ะ', blankOrderTemplate()];
        } else if (cmd === 'ออเดอร์') replyText = await handleOrderCommand(fields, userId);
        else if (cmd === 'ยืนยัน') replyText = await handleConfirmCommand(userId);
        else if (cmd === 'ยกเลิก') replyText = await handleCancelCommand(userId);
        else if (cmd === 'รับสต๊อก') replyText = await handleStockinCommand(fields);
        else if (cmd === 'แก้ออเดอร์') {
          await setAwaitingInput(userId, { type: 'edit-lookup' });
          replyText = 'มีมี่ยินดีรับใช้ค่ะ แจ้งชื่อลูกค้าเพื่อแก้ไขได้เลยค่ะ';
        } else if (cmd === 'ฟอร์ม') replyText = `📝 เปิดฟอร์มบันทึกข้อมูลได้ที่นี่ค่ะ:\nhttps://liff.line.me/${LIFF_ID}`;
        else if (cmd === 'รายงาน') {
          await setAwaitingInput(userId, { type: 'report-menu' });
          replyText = REPORT_TOP_MENU;
        } else {
          // Recognized by its own labels, independent of whether an "ออเดอร์"/"แก้ออเดอร์"
          // trigger happened first (or its 10-minute window already lapsed) — pasting a
          // filled-in template should always work, not just right after asking for one.
          // Require 2+ matched labels, not just 1 — a casual one-liner like "สินค้าหมดยัง"
          // would otherwise falsely match the "สินค้า" label on its own.
          const templateFields = parseTemplateOrder(event.message.text);
          const looksLikeOrderTemplate = Object.keys(templateFields).length >= 2;
          const awaiting = userId ? await popAwaitingInput(userId) : null;

          if (looksLikeOrderTemplate && awaiting && awaiting.type === 'edit-order') {
            replyText = await handleEditOrderCommand(event.message.text, userId, awaiting.orderId);
          } else if (looksLikeOrderTemplate) {
            replyText = await handleOrderCommand(templateFields, userId);
          } else if (awaiting && awaiting.type === 'edit-lookup') {
            const found = await findOrderByCustomerName(event.message.text);
            if (!found) {
              replyText = `ไม่พบออเดอร์ของ "${event.message.text.trim()}" ค่ะ พิมพ์ "แก้ออเดอร์" ใหม่อีกครั้งนะคะ`;
            } else {
              await setAwaitingInput(userId, { type: 'edit-order', orderId: found.id });
              replyText = orderToTemplateText(found);
            }
          } else if (awaiting && awaiting.type === 'edit-order') {
            replyText = await handleEditOrderCommand(event.message.text, userId, awaiting.orderId);
          } else if (awaiting && awaiting.type === 'report-menu') {
            const choice = event.message.text.trim();
            if (choice === '1') { await setAwaitingInput(userId, { type: 'report-delivery-period' }); replyText = REPORT_DELIVERY_SUBMENU; }
            else if (choice === '2') replyText = await buildPrepChecklistReport(addDaysISO(todayISOBangkok(), 1));
            else if (choice === '3') { await setAwaitingInput(userId, { type: 'report-sales-period' }); replyText = REPORT_SALES_SUBMENU; }
            else if (choice === '4') { await setAwaitingInput(userId, { type: 'report-customer-menu' }); replyText = REPORT_CUSTOMER_SUBMENU; }
            else if (choice === '5') replyText = await buildLowStockReport();
            else if (choice === '6') { await setAwaitingInput(userId, { type: 'report-payment-period' }); replyText = REPORT_PAYMENT_SUBMENU; }
            else { await setAwaitingInput(userId, { type: 'report-menu' }); replyText = `${REPORT_INVALID_CHOICE}\n\n${REPORT_TOP_MENU}`; }
          } else if (awaiting && awaiting.type === 'report-delivery-period') {
            const choice = event.message.text.trim();
            const today = todayISOBangkok();
            if (choice === '1') replyText = await buildDeliveryReport(today);
            else if (choice === '2') replyText = await buildDeliveryReport(addDaysISO(today, 1));
            else { await setAwaitingInput(userId, { type: 'report-delivery-period' }); replyText = `${REPORT_INVALID_CHOICE}\n\n${REPORT_DELIVERY_SUBMENU}`; }
          } else if (awaiting && awaiting.type === 'report-sales-period') {
            const period = periodFromChoice(event.message.text.trim());
            if (!period) { await setAwaitingInput(userId, { type: 'report-sales-period' }); replyText = `${REPORT_INVALID_CHOICE}\n\n${REPORT_SALES_SUBMENU}`; }
            else replyText = await buildSalesSummaryReport(period.from, period.to);
          } else if (awaiting && awaiting.type === 'report-customer-menu') {
            const choice = event.message.text.trim();
            if (choice === '1') { await setAwaitingInput(userId, { type: 'report-customer-count-period' }); replyText = REPORT_CUSTOMER_COUNT_SUBMENU; }
            else if (choice === '2') replyText = await buildRepeatCustomerReport();
            else { await setAwaitingInput(userId, { type: 'report-customer-menu' }); replyText = `${REPORT_INVALID_CHOICE}\n\n${REPORT_CUSTOMER_SUBMENU}`; }
          } else if (awaiting && awaiting.type === 'report-customer-count-period') {
            const period = periodFromChoice(event.message.text.trim());
            if (!period) { await setAwaitingInput(userId, { type: 'report-customer-count-period' }); replyText = `${REPORT_INVALID_CHOICE}\n\n${REPORT_CUSTOMER_COUNT_SUBMENU}`; }
            else replyText = await buildCustomerCountReport(period.from, period.to);
          } else if (awaiting && awaiting.type === 'report-payment-period') {
            const period = periodFromChoice(event.message.text.trim());
            if (!period) { await setAwaitingInput(userId, { type: 'report-payment-period' }); replyText = `${REPORT_INVALID_CHOICE}\n\n${REPORT_PAYMENT_SUBMENU}`; }
            else replyText = await buildPaymentReport(period.from, period.to);
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
