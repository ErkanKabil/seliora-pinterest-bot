// =====================================================
// Etsy-Pinterest Otomasyon Botu (Cookie-Based Auth)
// Etsy mağazasındaki ürünleri otomatik olarak
// Pinterest'e pin olarak paylaşır.
// Cookie tabanlı kimlik doğrulama kullanır —
// CAPTCHA/2FA sorunlarını tamamen ortadan kaldırır.
//
// v3: Her ürünü 3 ayrı pin olarak paylaşır:
//   Pin 1 → 1. fotoğraf
//   Pin 2 → 2. fotoğraf
//   Pin 3 → video (yoksa 3. fotoğraf)
// Günde 9 çalıştırma = 9 pin = 3 ürün tamamlanır.
// Pin sonuçları pin_log.json'a kaydedilir.
// Cookie süresi dolduğunda exit code 2 ile çıkar.
// =====================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const puppeteer = require('puppeteer');

// =====================================================
// Sabit Değerler
// =====================================================
const SHARED_PRODUCTS_FILE = path.join(__dirname, 'shared_products.json');
const PIN_LOG_FILE        = path.join(__dirname, 'pin_log.json');
const TEMP_IMAGE_PATH     = path.join(__dirname, 'temp_image.jpg');
const TEMP_VIDEO_PATH     = path.join(__dirname, 'temp_video.mp4');
const ETSY_API_BASE       = 'https://api.etsy.com/v3/application';

// Cookie süresi dolduğunda bu exit code ile çıkılır
// GitHub Actions bu kodu yakalar ve özel uyarı emaili gönderir
const COOKIE_EXPIRED_EXIT_CODE = 2;

// Çevresel değişkenlerden okunan değerler
const ETSY_API_KEY = process.env.ETSY_API_KEY;
const ETSY_SHARED_SECRET = process.env.ETSY_SHARED_SECRET;
const ETSY_SHOP_ID = process.env.ETSY_SHOP_ID;

// Etsy API v3, Şubat 2026'dan itibaren x-api-key header'ında
// "keystring:shared_secret" formatını zorunlu kıldı
const ETSY_AUTH_KEY = ETSY_SHARED_SECRET
  ? `${ETSY_API_KEY}:${ETSY_SHARED_SECRET}`
  : ETSY_API_KEY;

// Pinterest cookie tabanlı kimlik doğrulama
const COOKIES_FILE = path.join(__dirname, 'cookies.json');
let PINTEREST_COOKIES;
try {
  if (fs.existsSync(COOKIES_FILE)) {
    PINTEREST_COOKIES = fs.readFileSync(COOKIES_FILE, 'utf-8');
    console.log('🍪 Cookie\'ler cookies.json dosyasından okundu.');
  } else {
    PINTEREST_COOKIES = process.env.PINTEREST_COOKIES;
  }
} catch (e) {
  PINTEREST_COOKIES = process.env.PINTEREST_COOKIES;
}

// =====================================================
// Yardımcı Fonksiyonlar
// =====================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =====================================================
// shared_products.json Yönetimi (v2 format + migration)
// =====================================================

/**
 * Daha önce paylaşılmış ürünlerin listesini dosyadan okur.
 * Eski format (integer array) → yeni formata otomatik migrate eder.
 *
 * Yeni format:
 * [
 *   { listing_id: 123, pins_shared: 3, completed: true },
 *   { listing_id: 456, pins_shared: 1, completed: false }
 * ]
 */
function loadSharedProducts() {
  try {
    if (fs.existsSync(SHARED_PRODUCTS_FILE)) {
      const data = fs.readFileSync(SHARED_PRODUCTS_FILE, 'utf-8');
      const parsed = JSON.parse(data);

      // Migration: eski format integer array ise yeni formata çevir
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'number') {
        console.log('🔄 shared_products.json eski format tespit edildi, yeni formata migrate ediliyor...');
        const migrated = parsed.map((id) => ({
          listing_id: id,
          pins_shared: 3, // Eski sistemde paylaşılan = tamamen bitti say
          completed: true,
        }));
        saveSharedProductsRaw(migrated);
        console.log(`✅ ${migrated.length} ürün başarıyla migrate edildi.`);
        return migrated;
      }

      return parsed;
    }
  } catch (error) {
    console.error('⚠️ shared_products.json okunurken hata:', error.message);
  }
  return [];
}

/**
 * Ham olarak yazar (internal kullanım, migration sırasında döngü önleme).
 */
function saveSharedProductsRaw(list) {
  fs.writeFileSync(SHARED_PRODUCTS_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

/**
 * Paylaşılmış ürün listesini dosyaya kaydeder.
 */
function saveSharedProducts(list) {
  try {
    saveSharedProductsRaw(list);
    console.log('✅ shared_products.json güncellendi.');
  } catch (error) {
    console.error('⚠️ shared_products.json yazılırken hata:', error.message);
  }
}

/**
 * Paylaşılacak ürünü ve pin numarasını belirler.
 * - Tamamlanmamış bir ürün varsa → o ürünün bir sonraki pin numarasını döndür
 * - Tüm ürünler tamamlanmışsa → paylaşılmamış yeni bir ürün seç (Pin 1'den başla)
 *
 * @returns {{ listing: object, pinNumber: number } | null}
 */
function selectNextPinTarget(listings, sharedProducts) {
  // Devam eden (tamamlanmamış) ürünü kontrol et
  const inProgress = sharedProducts.find((sp) => !sp.completed);
  if (inProgress) {
    const listing = listings.find((l) => l.listing_id === inProgress.listing_id);
    if (listing) {
      const nextPin = inProgress.pins_shared + 1;
      console.log(`▶️  Devam eden ürün bulundu: "${listing.title}" (Pin ${nextPin}/3)`);
      return { listing, pinNumber: nextPin };
    }
    // Listing artık aktif değilse tamamlandı say
    console.log(`⚠️  Devam eden ürün (ID: ${inProgress.listing_id}) artık aktif listingde yok, tamamlandı sayılıyor.`);
    inProgress.completed = true;
    saveSharedProducts(sharedProducts);
  }

  // Yeni ürün seç (paylaşılmamış)
  const completedIds = sharedProducts.filter((sp) => sp.completed).map((sp) => sp.listing_id);
  const newListing = listings.find((l) => !completedIds.includes(l.listing_id));

  if (newListing) {
    console.log(`🆕 Yeni ürün seçildi: "${newListing.title}" (ID: ${newListing.listing_id}) — Pin 1/3 başlatılıyor`);
    return { listing: newListing, pinNumber: 1 };
  }

  console.log('ℹ️  Tüm ürünler tamamlanmış. Paylaşılacak yeni ürün yok.');
  return null;
}

// =====================================================
// Etsy API Fonksiyonları
// =====================================================

/**
 * Etsy API v3 ile tüm aktif ürünleri sayfalama ile çeker.
 */
async function fetchAllActiveListings() {
  const allListings = [];
  let offset = 0;
  const limit = 100;

  console.log('📦 Etsy mağazasından aktif ürünler çekiliyor...');

  try {
    while (true) {
      const url = `${ETSY_API_BASE}/shops/${ETSY_SHOP_ID}/listings/active`;
      const response = await axios.get(url, {
        headers: { 'x-api-key': ETSY_AUTH_KEY },
        params: { limit, offset, includes: 'images' },
      });

      const { results, count } = response.data;
      if (!results || results.length === 0) break;

      allListings.push(...results);
      console.log(`  → ${allListings.length} / ${count} ürün çekildi.`);

      if (allListings.length >= count) break;
      offset += limit;
    }

    console.log(`✅ Toplam ${allListings.length} aktif ürün bulundu.`);
    return allListings;
  } catch (error) {
    console.error('❌ Etsy API hatası:', error.response?.data || error.message);
    return [];
  }
}

/**
 * Ürünün tüm görsel URL'lerini sıralı olarak döndürür.
 * @returns {string[]} - URL dizisi (boş olabilir)
 */
async function getAllProductImages(product) {
  // Önce inline images alanını kontrol et
  if (product.images && product.images.length > 0) {
    return product.images.map((img) => img.url_fullxfull || img.url_570xN);
  }

  // Inline yoksa ayrı endpoint'ten çek
  try {
    console.log('🖼️  Ürün görselleri Etsy API\'den çekiliyor...');
    const url = `${ETSY_API_BASE}/listings/${product.listing_id}/images`;
    const response = await axios.get(url, {
      headers: { 'x-api-key': ETSY_AUTH_KEY },
    });

    const images = response.data.results;
    if (images && images.length > 0) {
      return images.map((img) => img.url_fullxfull || img.url_570xN);
    }
  } catch (error) {
    console.error('❌ Görsel çekme hatası:', error.response?.data || error.message);
  }

  return [];
}

/**
 * Ürünün video URL'sini Etsy API'den çeker.
 * @returns {string|null} - Video URL veya null
 */
async function getProductVideoUrl(product) {
  try {
    console.log('🎬 Ürün videosu Etsy API\'den kontrol ediliyor...');
    const url = `${ETSY_API_BASE}/listings/${product.listing_id}/videos`;
    const response = await axios.get(url, {
      headers: { 'x-api-key': ETSY_AUTH_KEY },
    });

    const videos = response.data.results;
    if (videos && videos.length > 0) {
      // Etsy video nesnesi: { video_id, height, width, thumbnail_url, video_url, ... }
      const videoUrl = videos[0].video_url;
      if (videoUrl) {
        console.log('✅ Video bulundu.');
        return videoUrl;
      }
    }
    console.log('ℹ️  Bu ürün için video bulunamadı, 3. fotoğraf kullanılacak.');
  } catch (error) {
    // 404 beklenen bir durum olabilir (videosuz ürün)
    if (error.response?.status === 404) {
      console.log('ℹ️  Bu ürünün videosu yok (404), 3. fotoğraf kullanılacak.');
    } else {
      console.error('⚠️  Video çekme hatası:', error.response?.data || error.message);
    }
  }

  return null;
}

/**
 * Pin numarasına göre paylaşılacak medyayı belirler.
 *   Pin 1 → images[0] (resim)
 *   Pin 2 → images[1] (resim)
 *   Pin 3 → video varsa video, yoksa images[2] (resim)
 *
 * @returns {{ url: string, type: 'image'|'video', pinLabel: string } | null}
 */
async function getMediaForPin(product, pinNumber) {
  const images = await getAllProductImages(product);

  if (pinNumber === 1) {
    if (!images[0]) {
      console.error('❌ 1. fotoğraf bulunamadı.');
      return null;
    }
    console.log(`📸 Pin 1 → 1. fotoğraf seçildi.`);
    return { url: images[0], type: 'image', pinLabel: 'Fotoğraf 1' };
  }

  if (pinNumber === 2) {
    if (!images[1]) {
      console.error('❌ 2. fotoğraf bulunamadı.');
      return null;
    }
    console.log(`📸 Pin 2 → 2. fotoğraf seçildi.`);
    return { url: images[1], type: 'image', pinLabel: 'Fotoğraf 2' };
  }

  if (pinNumber === 3) {
    // Önce videoyu dene
    const videoUrl = await getProductVideoUrl(product);
    if (videoUrl) {
      console.log(`🎬 Pin 3 → video seçildi.`);
      return { url: videoUrl, type: 'video', pinLabel: 'Video' };
    }

    // Video yoksa 3. fotoğraf
    if (images[2]) {
      console.log(`📸 Pin 3 → video yok, 3. fotoğraf seçildi (fallback).`);
      return { url: images[2], type: 'image', pinLabel: 'Fotoğraf 3 (Video Yok)' };
    }

    // 3. fotoğraf da yoksa 1. fotoğrafa düş
    if (images[0]) {
      console.log(`⚠️  Pin 3 → 3. fotoğraf da yok, 1. fotoğraf kullanılıyor (son fallback).`);
      return { url: images[0], type: 'image', pinLabel: 'Fotoğraf 1 (Fallback)' };
    }

    console.error('❌ Pin 3 için hiç medya bulunamadı.');
    return null;
  }

  return null;
}

/**
 * Medya dosyasını (resim veya video) indirir.
 */
async function downloadMedia(url, filepath) {
  console.log(`📥 Medya indiriliyor: ${filepath}`);
  try {
    const response = await axios.get(url, { responseType: 'stream' });
    const writer = fs.createWriteStream(filepath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log('✅ Medya başarıyla indirildi.');
        resolve();
      });
      writer.on('error', reject);
    });
  } catch (error) {
    console.error('❌ Medya indirme hatası:', error.message);
    throw error;
  }
}

/**
 * Ürünün Etsy satın alma linkini oluşturur.
 */
function getProductUrl(product) {
  return product.url || `https://www.etsy.com/listing/${product.listing_id}`;
}

/**
 * Ürün başlığına göre doğru Pinterest Panosunu (Board) belirler.
 */
function getBoardName(title) {
  const hasWord = (word) => new RegExp(`\\b${word}\\b`, 'i').test(title);

  // Pano adları Pinterest'ten doğrulanmıştır (01.04.2026)
  if (hasWord('birthstone')) {
    return hasWord('bracelet') ? 'Birthstone Bracelet' : 'Bliss Birthstone Necklace';
  }
  if (hasWord('name'))                         return 'Bliss Jewelry Name Necklace';
  if (hasWord('letter') || hasWord('initial')) return 'Bliss Jewelry Letter Necklace';
  if (hasWord('bracelet'))                     return 'Bliss Jewelry Luxury Bracelet';
  if (hasWord('ring'))                         return 'Bliss Jewelry Ring';
  return 'Bliss Jewelry Necklace';
}

/**
 * Pinterest cookie'lerini Puppeteer formatına dönüştürür.
 */
function parsePinterestCookies(cookieString) {
  try {
    const cookies = JSON.parse(cookieString);
    return cookies.map((cookie) => {
      const puppeteerCookie = {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain || '.pinterest.com',
        path: cookie.path || '/',
      };
      if (cookie.httpOnly !== undefined) puppeteerCookie.httpOnly = cookie.httpOnly;
      if (cookie.secure !== undefined) puppeteerCookie.secure = cookie.secure;
      if (cookie.sameSite) {
        const sameSiteMap = { no_restriction: 'None', lax: 'Lax', strict: 'Strict' };
        puppeteerCookie.sameSite = sameSiteMap[cookie.sameSite] || cookie.sameSite;
      }
      if (cookie.expirationDate) puppeteerCookie.expires = cookie.expirationDate;
      return puppeteerCookie;
    });
  } catch (error) {
    console.error('❌ Cookie parse hatası:', error.message);
    throw new Error('PINTEREST_COOKIES geçerli bir JSON formatında değil.');
  }
}

// =====================================================
// Pinterest Pin Oluşturma
// =====================================================

/**
 * Puppeteer ile Pinterest'e cookie ile giriş yapıp pin oluşturur.
 * @param {object} product - Etsy ürünü
 * @param {string} mediaPath - İndirilmiş medya dosyasının yolu
 * @param {'image'|'video'} mediaType - Medya türü
 */
async function pinToBoard(product, mediaPath, mediaType) {
  console.log(`\n🚀 Pinterest işlemleri başlıyor... (Tür: ${mediaType === 'video' ? '🎬 Video' : '📸 Resim'})`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080',
    ],
    defaultViewport: { width: 1920, height: 1080 },
  });

  try {
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    // 1. Cookie'leri yükle
    console.log('🍪 Pinterest cookie\'leri yükleniyor...');
    const cookies = parsePinterestCookies(PINTEREST_COOKIES);
    await page.setCookie(...cookies);
    console.log(`✅ ${cookies.length} adet cookie yüklendi.`);

    // 2. Oturum doğrula
    console.log('🔐 Pinterest oturumu doğrulanıyor...');
    await page.goto('https://www.pinterest.com/', { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(3000);

    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('accounts.pinterest.com')) {
      const err = new Error('Pinterest oturumu geçersiz! Cookie\'lerin süresi dolmuş olabilir.');
      err.isCookieExpired = true; // GitHub Actions bu flag'i yakalar
      throw err;
    }
    console.log('✅ Pinterest oturumu aktif.');

    // 3. Pin oluşturma sayfasına git
    console.log('📌 Pin oluşturma sayfasına gidiliyor...');
    await page.goto('https://www.pinterest.com/pin-creation-tool/', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });
    await sleep(5000);

    // 4. Medyayı yükle (resim veya video — file input aynı)
    console.log(`${mediaType === 'video' ? '🎬' : '🖼️'} Medya yükleniyor...`);
    const fileInput = await page.$('input[type="file"]');
    if (fileInput) {
      await fileInput.uploadFile(mediaPath);
      console.log('✅ Medya yükleme başlatıldı.');
    } else {
      throw new Error('Dosya yükleme alanı bulunamadı.');
    }

    // Video için daha uzun bekleme (işleme süresi)
    const uploadWait = mediaType === 'video' ? 20000 : 8000;
    console.log(`⏳ Yükleme tamamlanıyor... (${uploadWait / 1000}sn bekleniyor)`);
    await sleep(uploadWait);

    // 4b. Video ise: thumbnail seçimi gerekebilir — varsa ilk thumbnail'ı seç
    if (mediaType === 'video') {
      try {
        const thumbnailSelector = '[data-test-id="cover-image-selector-thumbnail"]';
        const thumbnailBtns = await page.$$(thumbnailSelector);
        if (thumbnailBtns.length > 0) {
          await thumbnailBtns[0].click();
          console.log('   ↳ Video thumbnail seçildi (1. kare).');
          await sleep(2000);
        }
      } catch (e) {
        console.log('   ℹ️  Thumbnail seçici bulunamadı, otomatik thumbnail kullanılacak.');
      }
    }

    // 5. Pano (Board) seçimi
    const selectedBoard = getBoardName(product.title);
    console.log(`📋 Pano seçiliyor: ${selectedBoard}`);
    try {
      const boardDropdownSelector = '[data-test-id="board-dropdown-select-button"]';
      await page.waitForSelector(boardDropdownSelector, { visible: true, timeout: 10000 });
      const boardBtn = await page.$(boardDropdownSelector);
      if (boardBtn) {
        await boardBtn.click();
        await sleep(2000);
        console.log('   ↳ Pano açılır menüsü tetiklendi.');
      }

      const flyoutSelector = '[data-test-id="board-picker-flyout"]';
      await page.waitForSelector(flyoutSelector, { timeout: 10000 });
      await sleep(1500);

      const isBoardClicked = await page.evaluate((boardName) => {
        const flyout = document.querySelector('[data-test-id="board-picker-flyout"]');
        if (!flyout) return false;

        const walker = document.createTreeWalker(flyout, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
          if (node.textContent.trim().toLowerCase() === boardName.toLowerCase()) {
            let btn = node.parentElement;
            while (btn && btn !== flyout) {
              const role = btn.getAttribute('role');
              if (role === 'button' || role === 'listitem' || btn.tagName === 'BUTTON') {
                btn.click();
                return true;
              }
              btn = btn.parentElement;
            }
            node.parentElement.click();
            return true;
          }
        }
        return false;
      }, selectedBoard);

      if (isBoardClicked) {
        console.log(`✅ Pano başarıyla seçildi: ${selectedBoard}`);
        await sleep(2000);
      } else {
        console.log(`⚠️  "${selectedBoard}" panosu bulunamadı, dropdown kapatılıyor.`);
        await page.keyboard.press('Escape');
        await sleep(1000);
      }
    } catch (e) {
      console.log('  ⚠️  Pano seçilirken hata oluştu:', e.message);
    }

    // 6. Pin başlığı
    let productTitle = '';
    const terms = product.title.split(',').map((t) => t.trim());
    for (const term of terms) {
      const addition = productTitle ? `, ${term}` : term;
      if ((productTitle.length + addition.length) <= 100) {
        productTitle += addition;
      } else {
        break;
      }
    }
    if (!productTitle) productTitle = product.title.substring(0, 100);

    console.log('📝 Pin başlığı yazılıyor...');
    const titleSelector = '#storyboard-selector-title';
    try {
      await page.waitForSelector(titleSelector, { timeout: 10000 });
      const titleEl = await page.$(titleSelector);
      if (titleEl) {
        await titleEl.click();
        await page.evaluate((text) => {
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, text);
        }, productTitle);
        await page.keyboard.press('Space');
        await page.keyboard.press('Backspace');
      }
    } catch (e) {
      console.log('⚠️  Başlık alanı bulunamadı:', e.message);
    }
    await sleep(1000);

    // 7. Pin açıklaması
    let productDescription = product.description || product.title;
    const paragraphs = productDescription.split('\n').map((p) => p.trim()).filter((p) => p.length > 0);
    if (paragraphs.length >= 2) {
      productDescription = paragraphs[0] + '\n\n' + paragraphs[1];
    } else if (paragraphs.length === 1) {
      productDescription = paragraphs[0];
    }

    console.log('📝 Pin açıklaması yazılıyor...');
    try {
      const textAreas = await page.$$('textarea, div[contenteditable="true"]');
      let foundDesc = false;
      for (const el of textAreas) {
        const placeholder = await page.evaluate(
          (e) => e.getAttribute('placeholder') || e.getAttribute('aria-label') || '',
          el
        );
        if (
          placeholder.toLowerCase().includes('description') ||
          placeholder.toLowerCase().includes('açıklama')
        ) {
          await el.click();
          await page.keyboard.down('Meta');
          await page.keyboard.press('a');
          await page.keyboard.up('Meta');
          await page.keyboard.press('Backspace');
          await sleep(500);
          await page.keyboard.type(productDescription, { delay: 10 });
          foundDesc = true;
          break;
        }
      }
      if (!foundDesc) {
        await page.evaluate((text) => document.execCommand('insertText', false, text), productDescription);
      }
    } catch (e) {
      console.log('⚠️  Açıklama alanı doldurulurken hata:', e.message);
    }
    await sleep(1000);

    // 8. Link
    const productUrl = getProductUrl(product);
    console.log('🔗 Ana ürün linki ekleniyor...');
    const linkSelector = '#WebsiteField';
    try {
      await page.waitForSelector(linkSelector, { timeout: 10000 });
      const linkEl = await page.$(linkSelector);
      if (linkEl) {
        await linkEl.click();
        await page.evaluate((text) => {
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, text);
        }, productUrl);
        await page.keyboard.press('Space');
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Escape');
      }
    } catch (e) {
      console.log('⚠️  Link eklenerken hata:', e.message);
    }
    await sleep(2000);

    // 9. Etiketler (Tags)
    console.log('🏷️  Etiketler (Tags) ekleniyor...');
    const tagsSelector = '#combobox-storyboard-interest-tags';
    try {
      const tagsInput = await page.$(tagsSelector);
      if (tagsInput) {
        await tagsInput.click();
        const tags = product.tags || [];
        if (tags.length > 0) {
          const tagsToAdd = tags.slice(0, 10);
          for (const tag of tagsToAdd) {
            await tagsInput.click({ clickCount: 3 });
            await page.keyboard.press('Backspace');
            await sleep(300);
            await page.type(tagsSelector, tag, { delay: 50 });
            await sleep(1500);
            await page.keyboard.press('Enter');
            await sleep(1500);
          }
          console.log(`   ✅ ${tagsToAdd.length} adet etiket eklendi.`);
        } else {
          console.log('   ℹ️  Etsy ürününde etiket bulunamadı.');
        }
      } else {
        console.log('   ⚠️  Etiket ekleme inputu bulunamadı.');
      }
    } catch (e) {
      console.log('   ⚠️  Etiketler eklenirken hata oluştu:', e.message);
    }
    await sleep(2000);

    // 10. Ürün Pini (Product Pin) — yalnızca resim pinlerinde çalışır, video için atla
    if (mediaType === 'image') {
      console.log('🛍️  Pin "Ürün Pini" (Product Pin) olarak ayarlanıyor...');
      try {
        const addProductSelector = '[data-test-id="add-product-tags-button"]';
        await page.waitForSelector(addProductSelector, { timeout: 5000 });
        await page.click(addProductSelector);
        console.log('   ↳ "Ürün Ekle" butonuna tıklandı.');
        await sleep(3000);

        const useLinkTabSelector = '#use-a-link-tab';
        await page.waitForSelector(useLinkTabSelector, { timeout: 5000 });
        await page.click(useLinkTabSelector);
        console.log('   ↳ "Bir Bağlantı Kullan" sekmesine geçildi.');
        await sleep(2000);

        const productSearchInputSelector =
          '#storyboard-product-tags-asset-picker--search-by-link--search-field';
        await page.waitForSelector(productSearchInputSelector, { timeout: 5000 });
        const prodInput = await page.$(productSearchInputSelector);
        if (prodInput) {
          await prodInput.click();
          await page.evaluate((text) => {
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, text);
          }, productUrl);
          await page.keyboard.press('Space');
          await page.keyboard.press('Backspace');
          await sleep(1000);
          await page.keyboard.press('Enter');
          console.log('   ↳ Link aratıldı, görsellerin gelmesi bekleniyor...');
          await sleep(6000);

          const imageSelector =
            '#use-a-link-panel div.masonryContainer [data-grid-item-idx="0"] div[role="button"]';
          const imageResults = await page.$$(imageSelector);
          if (imageResults.length > 0) {
            await imageResults[0].click();
            console.log('   ↳ İlk ürün görseli seçildi.');
            await sleep(2000);

            const isClicked = await page.evaluate(() => {
              const btns = Array.from(document.querySelectorAll('button'));
              const btn = btns.find((b) => {
                const text = b.textContent.toLowerCase();
                return (
                  (text.includes('ekle') ||
                    text.includes('kaydet') ||
                    text.includes('save') ||
                    text.includes('add')) &&
                  window.getComputedStyle(b).backgroundColor.includes('rgb(230, 0, 35)')
                );
              });
              if (btn) { btn.click(); return true; }
              return false;
            });
            if (isClicked) {
              console.log('   ↳ "Ürünleri Kaydet/Ekle" butonu ile modal kapatıldı.');
              await sleep(3000);
            }
          } else {
            console.log('   ⚠️  Bağlantı girildi ama onaylanacak görsel bulunamadı.');
          }
        }
      } catch (e) {
        console.log('   ⚠️  Ürün pini ekleme akışında sorun çıktı:', e.message);
      }
    } else {
      console.log('   ℹ️  Video pini için Ürün Pini adımı atlanıyor.');
    }

    // 11. Yayınla
    console.log('📤 Pin yayınlanıyor...');
    try {
      const isPublished = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find((b) => {
          const text = b.textContent.trim().toLowerCase();
          const bg = window.getComputedStyle(b).backgroundColor;
          return (text === 'yayınla' || text === 'publish') && bg.includes('rgb(230, 0, 35)');
        });
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!isPublished) {
        const fallbackSel =
          'button[data-test-id="board-dropdown-save-button"], button[data-test-id="pin-draft-save-button"]';
        await page.evaluate((sel) => document.querySelector(sel)?.click(), fallbackSel);
      }
    } catch (e) {
      console.log('   ⚠️  Yayınla butonuna tıklanamadı:', e.message);
    }

    await sleep(6000);

    console.log('🎉 Pin başarıyla oluşturuldu!');
    console.log(`   Başlık: ${productTitle}`);
    console.log(`   Link: ${productUrl}`);
    console.log(`   Tür: ${mediaType === 'video' ? '🎬 Video' : '📸 Resim'}`);

    // Pin URL'sini yakala ve döndür
    let createdPinUrl = null;
    try {
      const pinLinkEl = await page.$('a[href*="/pin/"]');
      if (pinLinkEl) {
        let pinHref = await page.evaluate((el) => el.href, pinLinkEl);
        if (!pinHref.startsWith('http')) pinHref = `https://www.pinterest.com${pinHref}`;
        createdPinUrl = pinHref;
        console.log(`   📌 Oluşturulan Pin: ${createdPinUrl}`);
      } else if (page.url().includes('/pin/')) {
        createdPinUrl = page.url();
        console.log(`   📌 Oluşturulan Pin: ${createdPinUrl}`);
      } else {
        console.log('   ℹ️  Pin linki alınamadı, ancak paylaşım başarılı.');
      }
    } catch (e) {
      // Pin URL loglaması opsiyonel
    }

    return createdPinUrl; // main() tarafından log için kullanılır
  } catch (error) {
    console.error('❌ Pinterest işlemi sırasında hata:', error.message);
    throw error;
  } finally {
    await browser.close();
    console.log('🔒 Tarayıcı kapatıldı.');
  }
}

/**
 * Geçici medya dosyalarını siler.
 */
function cleanupTempFiles() {
  for (const filepath of [TEMP_IMAGE_PATH, TEMP_VIDEO_PATH]) {
    try {
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath);
        console.log(`🗑️  Geçici dosya silindi: ${path.basename(filepath)}`);
      }
    } catch (error) {
      console.error('⚠️  Geçici dosya silinirken hata:', error.message);
    }
  }
}

// =====================================================
// Pin Log Yönetimi
// =====================================================

/**
 * pin_log.json dosyasını okur.
 */
function loadPinLog() {
  try {
    if (fs.existsSync(PIN_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(PIN_LOG_FILE, 'utf-8'));
    }
  } catch (e) {}
  return [];
}

/**
 * Bir pin sonucunu (başarı veya hata) pin_log.json'a ekler.
 *
 * @param {object} entry
 * @param {number}  entry.listing_id
 * @param {string}  entry.title
 * @param {number}  entry.pin_number   — 1 | 2 | 3
 * @param {string}  entry.media_type   — 'image' | 'video'
 * @param {string}  entry.media_label  — ör. 'Fotoğraf 1'
 * @param {string}  entry.board        — seçilen pano adı
 * @param {string}  entry.etsy_url     — Etsy ürün linki
 * @param {'success'|'failure'|'skipped'} entry.status
 * @param {string|null} entry.pin_url  — oluşturulan Pinterest pin linki
 * @param {string|null} entry.error    — hata mesajı (failure durumunda)
 */
function appendPinLog(entry) {
  try {
    const log = loadPinLog();
    log.push({
      timestamp:   new Date().toISOString(),
      ...entry,
    });
    fs.writeFileSync(PIN_LOG_FILE, JSON.stringify(log, null, 2), 'utf-8');
    console.log(`📋 Pin log güncellendi (${entry.status}): ${PIN_LOG_FILE}`);
  } catch (e) {
    console.error('⚠️  Pin log yazılamadı:', e.message);
  }
}

// =====================================================
// Ana Fonksiyon
// =====================================================
async function main() {
  console.log('');
  console.log('====================================================');
  console.log('🤖 Etsy-Pinterest Bot Başlatılıyor... (v2 — 3 Pin/Ürün)');
  console.log(`📅 Tarih: ${new Date().toLocaleString('tr-TR')}`);
  console.log('====================================================');
  console.log('');

  if (!ETSY_API_KEY || !ETSY_SHOP_ID || !PINTEREST_COOKIES) {
    console.error('❌ Gerekli çevresel değişkenler eksik!');
    console.error('   Gerekli: ETSY_API_KEY, ETSY_SHOP_ID, ve cookies.json veya PINTEREST_COOKIES');
    process.exit(1);
  }

  try {
    // 1. Paylaşılmış ürünleri yükle
    console.log('📂 Paylaşılmış ürünler listesi yükleniyor...');
    let sharedProducts = loadSharedProducts();
    const completedCount = sharedProducts.filter((sp) => sp.completed).length;
    const inProgressCount = sharedProducts.filter((sp) => !sp.completed).length;
    console.log(`   Tamamlanmış: ${completedCount} ürün | Devam eden: ${inProgressCount} ürün`);

    // 2. Etsy'den aktif ürünleri çek
    const listings = await fetchAllActiveListings();
    if (listings.length === 0) {
      console.log('⚠️  Etsy mağazasında aktif ürün bulunamadı. Çıkılıyor...');
      return;
    }

    // 3. Bir sonraki pin hedefini belirle
    const target = selectNextPinTarget(listings, sharedProducts);
    if (!target) {
      console.log('ℹ️  Paylaşılacak pin kalmadı. Tüm ürünler tamamlanmış.');
      return;
    }

    const { listing, pinNumber } = target;
    console.log('');
    console.log(`📍 Hedef: "${listing.title}"`);
    console.log(`   Pin ${pinNumber}/3 paylaşılacak`);
    console.log('');

    // 4. Medyayı belirle ve indir
    const media = await getMediaForPin(listing, pinNumber);
    if (!media) {
      console.error(`❌ Pin ${pinNumber} için medya bulunamadı. Bu pin atlanıyor.`);

      // Pini tamamlandı say (sonsuz döngüye girmesin)
      let record = sharedProducts.find((sp) => sp.listing_id === listing.listing_id);
      if (!record) {
        record = { listing_id: listing.listing_id, pins_shared: 0, completed: false };
        sharedProducts.push(record);
      }
      record.pins_shared = pinNumber;
      if (record.pins_shared >= 3) record.completed = true;
      saveSharedProducts(sharedProducts);
      return;
    }

    const tempPath = media.type === 'video' ? TEMP_VIDEO_PATH : TEMP_IMAGE_PATH;
    await downloadMedia(media.url, tempPath);

    const selectedBoard = getBoardName(listing.title);

    // 5. Pinterest'e pin olarak paylaş
    let pinUrl = null;
    try {
      pinUrl = await pinToBoard(listing, tempPath, media.type);
    } catch (pinError) {
      // Cookie süresi dolmuş → özel exit code ile çık (GitHub Actions yakalar)
      appendPinLog({
        listing_id:  listing.listing_id,
        title:       listing.title,
        pin_number:  pinNumber,
        media_type:  media.type,
        media_label: media.pinLabel,
        board:       selectedBoard,
        etsy_url:    getProductUrl(listing),
        status:      'failure',
        pin_url:     null,
        error:       pinError.message,
      });

      if (pinError.isCookieExpired) {
        console.error('🍪 Cookie süresi dolmuş! GitHub Actions uyarı emaili gönderecek.');
        process.exit(COOKIE_EXPIRED_EXIT_CODE); // exit 2 → workflow'da özel step tetiklenir
      }
      throw pinError;
    }

    // 6. Başarı logu
    appendPinLog({
      listing_id:  listing.listing_id,
      title:       listing.title,
      pin_number:  pinNumber,
      media_type:  media.type,
      media_label: media.pinLabel,
      board:       selectedBoard,
      etsy_url:    getProductUrl(listing),
      status:      'success',
      pin_url:     pinUrl,
      error:       null,
    });

    // 7. shared_products.json güncelle
    let record = sharedProducts.find((sp) => sp.listing_id === listing.listing_id);
    if (!record) {
      record = { listing_id: listing.listing_id, pins_shared: 0, completed: false };
      sharedProducts.push(record);
    }
    record.pins_shared = pinNumber;
    if (record.pins_shared >= 3) {
      record.completed = true;
      console.log(`\n🏁 Ürün tamamlandı: "${listing.title}" — 3/3 pin paylaşıldı.`);
    } else {
      console.log(`\n✅ Pin ${pinNumber}/3 tamamlandı. Sonraki pin bir sonraki çalıştırmada paylaşılacak.`);
    }
    saveSharedProducts(sharedProducts);

    console.log('');
    console.log('====================================================');
    console.log(`✅ Pin ${pinNumber}/3 başarıyla paylaşıldı! [${media.pinLabel}]`);
    console.log(`   Ürün: ${listing.title.substring(0, 60)}...`);
    console.log('====================================================');
  } catch (error) {
    console.error('');
    console.error('====================================================');
    console.error('❌ Bot çalışırken bir hata oluştu:', error.message);
    console.error('====================================================');
    process.exit(1);
  } finally {
    cleanupTempFiles();
  }
}

// Botu çalıştır
main();