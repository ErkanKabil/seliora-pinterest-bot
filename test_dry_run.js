// =====================================================
// DRY-RUN TEST — Bir Günlük Rutin Simülasyonu
// Pinterest'e gerçekten bağlanmaz, medya indirmez.
// Sadece hangi ürünün, hangi pin'inin, hangi medyayla
// paylaşılacağını simüle eder (6 çalıştırma = 1 gün).
// =====================================================

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const axios = require('axios');

const SHARED_PRODUCTS_FILE = path.join(__dirname, 'shared_products.json');
const ETSY_API_BASE = 'https://api.etsy.com/v3/application';

const ETSY_API_KEY     = process.env.ETSY_API_KEY;
const ETSY_SHARED_SECRET = process.env.ETSY_SHARED_SECRET;
const ETSY_SHOP_ID     = process.env.ETSY_SHOP_ID;
const ETSY_AUTH_KEY    = ETSY_SHARED_SECRET
  ? `${ETSY_API_KEY}:${ETSY_SHARED_SECRET}`
  : ETSY_API_KEY;

// ─── Renkli log yardımcıları ───────────────────────
const c = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  dim:   '\x1b[2m',
  green: '\x1b[32m',
  cyan:  '\x1b[36m',
  yellow:'\x1b[33m',
  blue:  '\x1b[34m',
  magenta:'\x1b[35m',
  red:   '\x1b[31m',
  gray:  '\x1b[90m',
};
const log  = (msg) => console.log(msg);
const ok   = (msg) => console.log(`${c.green}✅${c.reset} ${msg}`);
const info = (msg) => console.log(`${c.cyan}ℹ️ ${c.reset} ${msg}`);
const warn = (msg) => console.log(`${c.yellow}⚠️ ${c.reset} ${msg}`);
const pin  = (msg) => console.log(`${c.magenta}📌${c.reset} ${msg}`);
const sep  = ()    => console.log(`${c.gray}${'─'.repeat(60)}${c.reset}`);

// ─── shared_products.json (geçici in-memory kopyası) ───
function loadSharedProducts() {
  try {
    if (fs.existsSync(SHARED_PRODUCTS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SHARED_PRODUCTS_FILE, 'utf-8'));
      // Migration: eski integer array
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'number') {
        return parsed.map((id) => ({ listing_id: id, pins_shared: 3, completed: true }));
      }
      return parsed;
    }
  } catch (e) {}
  return [];
}

function selectNextPinTarget(listings, sharedProducts) {
  const inProgress = sharedProducts.find((sp) => !sp.completed);
  if (inProgress) {
    const listing = listings.find((l) => l.listing_id === inProgress.listing_id);
    if (listing) return { listing, pinNumber: inProgress.pins_shared + 1 };
    inProgress.completed = true;
  }
  const completedIds = sharedProducts.filter((sp) => sp.completed).map((sp) => sp.listing_id);
  const newListing = listings.find((l) => !completedIds.includes(l.listing_id));
  return newListing ? { listing: newListing, pinNumber: 1 } : null;
}

// ─── Etsy API çağrıları ────────────────────────────
async function fetchAllActiveListings() {
  const allListings = [];
  let offset = 0;
  try {
    while (true) {
      const res = await axios.get(
        `${ETSY_API_BASE}/shops/${ETSY_SHOP_ID}/listings/active`,
        { headers: { 'x-api-key': ETSY_AUTH_KEY }, params: { limit: 100, offset, includes: 'images' } }
      );
      const { results, count } = res.data;
      if (!results || results.length === 0) break;
      allListings.push(...results);
      if (allListings.length >= count) break;
      offset += 100;
    }
  } catch (e) {
    console.error(`${c.red}❌${c.reset} Etsy API hatası:`, e.response?.data || e.message);
    process.exit(1);
  }
  return allListings;
}

async function getAllProductImages(product) {
  if (product.images && product.images.length > 0)
    return product.images.map((img) => img.url_fullxfull || img.url_570xN);
  try {
    const res = await axios.get(
      `${ETSY_API_BASE}/listings/${product.listing_id}/images`,
      { headers: { 'x-api-key': ETSY_AUTH_KEY } }
    );
    return (res.data.results || []).map((img) => img.url_fullxfull || img.url_570xN);
  } catch (e) { return []; }
}

async function getProductVideoUrl(product) {
  try {
    const res = await axios.get(
      `${ETSY_API_BASE}/listings/${product.listing_id}/videos`,
      { headers: { 'x-api-key': ETSY_AUTH_KEY } }
    );
    const videos = res.data.results;
    if (videos && videos.length > 0 && videos[0].video_url) return videos[0].video_url;
  } catch (e) {}
  return null;
}

async function getMediaForPin(product, pinNumber) {
  const images = await getAllProductImages(product);
  if (pinNumber === 1) return images[0] ? { url: images[0], type: 'image', label: '📸 1. Fotoğraf' } : null;
  if (pinNumber === 2) return images[1] ? { url: images[1], type: 'image', label: '📸 2. Fotoğraf' } : null;
  if (pinNumber === 3) {
    const videoUrl = await getProductVideoUrl(product);
    if (videoUrl) return { url: videoUrl, type: 'video', label: '🎬 Video' };
    if (images[2]) return { url: images[2], type: 'image', label: '📸 3. Fotoğraf (video yok → fallback)' };
    if (images[0]) return { url: images[0], type: 'image', label: '📸 1. Fotoğraf (son fallback)' };
  }
  return null;
}

// ─── US Prime Time saatleri ────────────────────────
const US_PRIME_TIME_SLOTS = [
  '08:15 EDT (12:15 UTC)',
  '11:15 EDT (15:15 UTC)',
  '13:15 EDT (17:15 UTC)',
  '16:15 EDT (20:15 UTC)',
  '19:15 EDT (23:15 UTC) ⭐ Prime Time',
  '21:15 EDT (01:15 UTC) ⭐ Prime Time',
];

// ─── ANA TEST ─────────────────────────────────────
async function runDaySimulation() {
  log('');
  log(`${c.bold}╔══════════════════════════════════════════════════════════╗${c.reset}`);
  log(`${c.bold}║  🧪  DRY-RUN — 1 Günlük Rutin Simülasyonu (6 Çalışma)  ║${c.reset}`);
  log(`${c.bold}╚══════════════════════════════════════════════════════════╝${c.reset}`);
  log('');

  if (!ETSY_API_KEY || !ETSY_SHOP_ID) {
    console.error('❌ ETSY_API_KEY veya ETSY_SHOP_ID eksik! .env dosyasını kontrol edin.');
    process.exit(1);
  }

  info('Etsy\'den aktif ürünler çekiliyor...');
  const listings = await fetchAllActiveListings();
  ok(`${listings.length} aktif ürün bulundu.`);
  log('');

  // Mevcut shared_products.json'ı kopyala (in-memory sim için)
  let sharedProducts = loadSharedProducts();
  const originalSnapshot = JSON.stringify(sharedProducts);

  info(`Mevcut durum: ${sharedProducts.filter(s=>s.completed).length} tamamlandı, ${sharedProducts.filter(s=>!s.completed).length} devam ediyor`);
  log('');

  const results = [];

  for (let run = 1; run <= 6; run++) {
    sep();
    log(`${c.bold}${c.blue}▶ Çalıştırma ${run}/6  —  ${US_PRIME_TIME_SLOTS[run - 1]}${c.reset}`);
    sep();

    const target = selectNextPinTarget(listings, sharedProducts);

    if (!target) {
      warn('Paylaşılacak pin kalmadı — tüm ürünler tamamlanmış.');
      results.push({ run, status: 'SKIP', reason: 'no target' });
      log('');
      continue;
    }

    const { listing, pinNumber } = target;
    log(`${c.cyan}Ürün  :${c.reset} ${listing.title.substring(0, 65)}...`);
    log(`${c.cyan}Pin   :${c.reset} ${pinNumber}/3`);

    const media = await getMediaForPin(listing, pinNumber);

    if (!media) {
      warn(`Pin ${pinNumber} için medya bulunamadı — bu pin atlanıyor.`);
      results.push({ run, status: 'NO_MEDIA', listing: listing.title, pinNumber });
    } else {
      log(`${c.cyan}Medya :${c.reset} ${media.label}`);
      log(`${c.cyan}URL   :${c.reset} ${c.dim}${media.url.substring(0, 80)}...${c.reset}`);
      pin(`Bu çalıştırma → ${media.label} paylaşılacak`);
      results.push({ run, status: 'OK', listing: listing.title, pinNumber, media: media.label });
    }

    // shared_products güncelle (in-memory)
    let record = sharedProducts.find((sp) => sp.listing_id === listing.listing_id);
    if (!record) {
      record = { listing_id: listing.listing_id, pins_shared: 0, completed: false };
      sharedProducts.push(record);
    }
    record.pins_shared = pinNumber;
    if (record.pins_shared >= 3) {
      record.completed = true;
      ok(`"${listing.title.substring(0,40)}..." tamamlandı (3/3 pin)`);
    }

    log('');
  }

  // ─── ÖZET ────────────────────────────────────────
  log('');
  log(`${c.bold}╔══════════════════════════════════════════════════════════╗${c.reset}`);
  log(`${c.bold}║                    📊 GÜN SONU ÖZET                     ║${c.reset}`);
  log(`${c.bold}╚══════════════════════════════════════════════════════════╝${c.reset}`);
  log('');

  for (const r of results) {
    if (r.status === 'OK') {
      log(`  ${c.green}✅${c.reset} Çalışma ${r.run}: Pin ${r.pinNumber}/3 — ${r.media}`);
      log(`     ${c.dim}Ürün: ${r.listing.substring(0, 55)}...${c.reset}`);
    } else if (r.status === 'SKIP') {
      log(`  ${c.yellow}⏭️ ${c.reset} Çalışma ${r.run}: Hedef yok, atlandı`);
    } else {
      log(`  ${c.red}❌${c.reset} Çalışma ${r.run}: Medya bulunamadı — Pin ${r.pinNumber}`);
    }
  }

  log('');
  const okCount = results.filter((r) => r.status === 'OK').length;
  log(`${c.bold}Toplam: ${okCount} pin paylaşılacak (6 slot)${c.reset}`);

  // Simülasyon bitti — shared_products.json'a dokunmuyoruz
  log('');
  info('🔒 DRY-RUN: shared_products.json değiştirilmedi.');
  log('');
}

runDaySimulation().catch((e) => {
  console.error('❌ Test sırasında beklenmeyen hata:', e.message);
  process.exit(1);
});
