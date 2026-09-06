// Dumps Firestore into the same JSON shape as the app's own "ดาวน์โหลดไฟล์สำรอง" button
// (see downloadBackupBtn / restoreBackupBtn in index.html), so a file this script writes
// can be fed straight back into the app's "กู้ข้อมูลจากไฟล์" restore feature if ever needed.
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Collections stored as one Firestore doc per array item (id = doc id).
const ARRAY_COLLECTIONS = ['orders', 'materials', 'stockins', 'stockAdjustments'];
// Everything else lives as a single doc per key under the 'settings' collection,
// shaped {value: <the actual array/object>} — mirrors fsSyncValue() in index.html.
const SETTINGS_KEYS = ['products', 'channels', 'paymentMethods', 'units', 'recipes', 'startupCosts', 'operatingExpenses', 'logo'];

async function main() {
  const backup = {};

  for (const name of ARRAY_COLLECTIONS) {
    const snap = await db.collection(name).get();
    backup[name] = snap.docs.map(d => d.data());
  }

  for (const key of SETTINGS_KEYS) {
    const doc = await db.collection('settings').doc(key).get();
    backup[key] = doc.exists ? doc.data().value : (key === 'logo' ? null : []);
  }

  backup.exportedAt = new Date().toISOString();

  const dir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `mimilitang_backup_${backup.exportedAt.slice(0, 10)}.json`;
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(backup, null, 2));
  console.log('Wrote backups/' + fileName);
}

main().catch(err => { console.error(err); process.exit(1); });
