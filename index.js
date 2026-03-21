// =====================================================
// Etsy-Pinterest Otomasyon Botu (Cookie-Based Auth)
// Etsy mağazasındaki ürünleri otomatik olarak
// Pinterest'e pin olarak paylaşır.
// Cookie tabanlı kimlik doğrulama kullanır —
// CAPTCHA/2FA sorunlarını tamamen ortadan kaldırır.
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
const TEMP_IMAGE_PATH = path.join(__dirname, 'temp_image.jpg');
const ETSY_API_BASE = 'https://openapi.etsy.com/v3/application';

// Çevresel değişkenlerden okunan değerler
const ETSY_API_KEY = process.env.ETSY_API_KEY;
const ETSY_SHOP_ID = process.env.ETSY_SHOP_ID;

// Pinterest cookie tabanlı kimlik doğrulama
// JSON formatında cookie string'i (GitHub Secrets'tan gelir)
const PINTEREST_COOKIES = process.env.PINTEREST_COOKIES;

// =====================================================
// Yardımcı Fonksiyonlar
// =====================================================

/**
 * Belirli bir süre beklemek için yardımcı fonksiyon (ms cinsinden).
 * Puppeteer işlemlerinde sayfanın yüklenmesini beklemek için kullanılır.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Daha önce paylaşılmış ürünlerin listesini dosyadan okur.
 * Dosya yoksa boş bir array döndürür.
 */
function loadSharedProducts() {
  try {
    if (fs.existsSync(SHARED_PRODUCTS_FILE)) {
      const data = fs.readFileSync(SHARED_PRODUCTS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('⚠️ shared_products.json okunurken hata:', error.message);
  }
  return [];
}

/**
 * Paylaşılmış ürün listesini dosyaya kaydeder.
 * @param {Array} list - Paylaşılmış ürün ID'lerinin listesi
 */
function saveSharedProducts(list) {
  try {
    fs.writeFileSync(SHARED_PRODUCTS_FILE, JSON.stringify(list, null, 2), 'utf-8');
    console.log('✅ shared_products.json güncellendi.');
  } catch (error) {
    console.error('⚠️ shared_products.json yazılırken hata:', error.message);
  }
}

/**
 * Etsy API v3 kullanarak mağazadaki tüm aktif ürünleri sayfalama (pagination) ile çeker.
 * Her sayfada 100 ürün çekilir, tüm sayfalar tamamlanana kadar devam eder.
 * @returns {Array} Tüm aktif ürünlerin listesi
 */
async function fetchAllActiveListings() {
  const allListings = [];
  let offset = 0;
  const limit = 100; // Etsy API'nin sayfa başına maksimum değeri

  console.log('📦 Etsy mağazasından aktif ürünler çekiliyor...');

  try {
    while (true) {
      const url = `${ETSY_API_BASE}/shops/${ETSY_SHOP_ID}/listings/active`;
      const response = await axios.get(url, {
        headers: {
          'x-api-key': ETSY_API_KEY,
        },
        params: {
          limit: limit,
          offset: offset,
          includes: 'images', // Ürün görsellerini de dahil et
        },
      });

      const { results, count } = response.data;

      if (!results || results.length === 0) {
        break; // Daha fazla ürün yok
      }

      allListings.push(...results);
      console.log(`  → ${allListings.length} / ${count} ürün çekildi.`);

      // Tüm ürünler çekildiyse döngüyü kır
      if (allListings.length >= count) {
        break;
      }

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
 * Etsy'den gelen ürün listesini paylaşılmış ürünlerle karşılaştırır
 * ve henüz paylaşılmamış ilk ürünü seçer.
 * @param {Array} listings - Etsy'den gelen tüm aktif ürünler
 * @param {Array} sharedIds - Daha önce paylaşılmış ürün ID'leri
 * @returns {Object|null} Paylaşılacak ürün veya null
 */
function selectUnsharedProduct(listings, sharedIds) {
  const unshared = listings.find(
    (listing) => !sharedIds.includes(listing.listing_id)
  );

  if (unshared) {
    console.log(`🎯 Paylaşılacak ürün seçildi: "${unshared.title}" (ID: ${unshared.listing_id})`);
  } else {
    console.log('ℹ️ Tüm ürünler daha önce paylaşılmış. Paylaşılacak yeni ürün yok.');
  }

  return unshared || null;
}

/**
 * Verilen URL'den görseli indirip belirtilen dosya yoluna kaydeder.
 * Puppeteer'ın görseli Pinterest'e yükleyebilmesi için geçici dosya oluşturur.
 * @param {string} url - Görsel URL'si
 * @param {string} filepath - Kaydedilecek dosya yolu
 */
async function downloadImage(url, filepath) {
  console.log('📥 Görsel indiriliyor...');

  try {
    const response = await axios.get(url, { responseType: 'stream' });
    const writer = fs.createWriteStream(filepath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log('✅ Görsel başarıyla indirildi:', filepath);
        resolve();
      });
      writer.on('error', reject);
    });
  } catch (error) {
    console.error('❌ Görsel indirme hatası:', error.message);
    throw error;
  }
}

/**
 * Ürün görsel URL'sini çıkarır. Etsy API'den gelen images alanından
 * en yüksek çözünürlüklü görseli alır.
 * @param {Object} product - Etsy ürün nesnesi
 * @returns {string|null} Görsel URL'si
 */
function getProductImageUrl(product) {
  // Etsy API v3 includes=images ile gelen görseller
  if (product.images && product.images.length > 0) {
    // url_fullxfull en yüksek çözünürlüklü görsel
    return product.images[0].url_fullxfull || product.images[0].url_570xN;
  }
  return null;
}

/**
 * Ürünün Etsy satın alma linkini oluşturur.
 * @param {Object} product - Etsy ürün nesnesi
 * @returns {string} Ürün linki
 */
function getProductUrl(product) {
  return product.url || `https://www.etsy.com/listing/${product.listing_id}`;
}

/**
 * Pinterest cookie string'ini parse edip Puppeteer'ın anlayacağı formata dönüştürür.
 * Cookie-Editor eklentisinin JSON export formatını destekler.
 * @param {string} cookieString - JSON formatında cookie string'i
 * @returns {Array} Puppeteer uyumlu cookie dizisi
 */
function parsePinterestCookies(cookieString) {
  try {
    const cookies = JSON.parse(cookieString);

    // Cookie-Editor formatından Puppeteer formatına dönüştür
    return cookies.map((cookie) => {
      const puppeteerCookie = {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain || '.pinterest.com',
        path: cookie.path || '/',
      };

      // httpOnly, secure, sameSite gibi opsiyonel alanları ekle
      if (cookie.httpOnly !== undefined) puppeteerCookie.httpOnly = cookie.httpOnly;
      if (cookie.secure !== undefined) puppeteerCookie.secure = cookie.secure;
      if (cookie.sameSite) {
        // Puppeteer 'None', 'Lax', 'Strict' bekler
        const sameSiteMap = { no_restriction: 'None', lax: 'Lax', strict: 'Strict' };
        puppeteerCookie.sameSite = sameSiteMap[cookie.sameSite] || cookie.sameSite;
      }

      // Expiry tarihi varsa ekle (saniye cinsinden)
      if (cookie.expirationDate) {
        puppeteerCookie.expires = cookie.expirationDate;
      }

      return puppeteerCookie;
    });
  } catch (error) {
    console.error('❌ Cookie parse hatası:', error.message);
    throw new Error('PINTEREST_COOKIES değişkeni geçerli bir JSON formatında değil. Lütfen Cookie-Editor eklentisinden dışa aktarılan JSON\'u kullanın.');
  }
}

/**
 * Puppeteer ile Pinterest'e cookie tabanlı giriş yapıp, verilen ürünü pin olarak paylaşır.
 * 
 * Cookie-based auth avantajları:
 * - CAPTCHA sorunları yok
 * - 2FA engeli yok
 * - Bot algılaması riski çok düşük
 * - E-posta/şifre paylaşılmıyor
 * 
 * İşlem adımları:
 * 1. Tarayıcıyı headless modda başlat (GitHub Actions uyumlu)
 * 2. Pinterest cookie'lerini tarayıcıya yükle
 * 3. Oturum doğrulamasını kontrol et
 * 4. Pin oluşturma sayfasına git
 * 5. Görseli yükle, başlık/açıklama/link alanlarını doldur
 * 6. Pin'i yayınla
 * 
 * @param {Object} product - Paylaşılacak ürün bilgileri
 * @param {string} imagePath - İndirilmiş görselin dosya yolu
 */
async function pinToBoard(product, imagePath) {
  console.log('🚀 Pinterest işlemleri başlıyor...');

  // Tarayıcıyı GitHub Actions ortamına uygun ayarlarla başlat
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

    // User-Agent ayarı (bot algılamasını azaltmak için)
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    // =========================================
    // 1. ADIM: Cookie'leri Tarayıcıya Yükle
    // =========================================
    console.log('🍪 Pinterest cookie\'leri yükleniyor...');
    const cookies = parsePinterestCookies(PINTEREST_COOKIES);
    await page.setCookie(...cookies);
    console.log(`✅ ${cookies.length} adet cookie yüklendi.`);

    // =========================================
    // 2. ADIM: Oturum Doğrulaması
    // =========================================
    console.log('🔐 Pinterest oturumu doğrulanıyor...');
    await page.goto('https://www.pinterest.com/', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });
    await sleep(3000);

    // Giriş yapılmış mı kontrol et (login sayfasına yönlendirme oldu mu?)
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('accounts.pinterest.com')) {
      throw new Error(
        'Pinterest oturumu geçersiz! Cookie\'lerinizin süresi dolmuş olabilir. ' +
        'Lütfen tarayıcınızdan yeniden giriş yapıp cookie\'leri tekrar dışa aktarın.'
      );
    }
    console.log('✅ Pinterest oturumu aktif.');

    // =========================================
    // 3. ADIM: Pin Oluşturma Sayfasına Git
    // =========================================
    console.log('📌 Pin oluşturma sayfasına gidiliyor...');
    await page.goto('https://www.pinterest.com/pin-creation-tool/', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });

    await sleep(5000);

    // =========================================
    // 4. ADIM: Görseli Yükle
    // =========================================
    console.log('🖼️ Görsel yükleniyor...');

    // Dosya yükleme input'unu bul (gizli input[type=file] elementi)
    const fileInput = await page.$('input[type="file"]');
    if (fileInput) {
      await fileInput.uploadFile(imagePath);
      console.log('✅ Görsel yükleme başlatıldı.');
    } else {
      throw new Error('Dosya yükleme alanı bulunamadı.');
    }

    // Görselin yüklenmesini bekle
    await sleep(8000);

    // =========================================
    // 5. ADIM: Pin Bilgilerini Doldur
    // =========================================
    const productTitle = product.title.substring(0, 100); // Pinterest başlık limiti
    const productDescription = (product.description || product.title).substring(0, 500);
    const productUrl = getProductUrl(product);

    // Başlık alanını doldur
    console.log('📝 Pin başlığı yazılıyor...');
    const titleSelector = 'div[data-test-id="pin-draft-title"] textarea, div[data-test-id="pin-draft-title"] div[contenteditable="true"], input[placeholder*="Başlık"], input[placeholder*="title" i], div[data-test-id="pin-creation-title"] textarea';
    try {
      await page.waitForSelector(titleSelector, { timeout: 10000 });
      const titleEl = await page.$(titleSelector);
      if (titleEl) {
        await titleEl.click();
        await page.keyboard.type(productTitle, { delay: 50 });
      }
    } catch (e) {
      // Alternatif: aria-label ile başlık alanını bul
      console.log('  ℹ️ Alternatif başlık alanı aranıyor...');
      const altTitle = await page.$('[aria-label*="title" i], [aria-label*="başlık" i]');
      if (altTitle) {
        await altTitle.click();
        await page.keyboard.type(productTitle, { delay: 50 });
      }
    }

    await sleep(1000);

    // Açıklama alanını doldur
    console.log('📝 Pin açıklaması yazılıyor...');
    const descSelector = 'div[data-test-id="pin-draft-description"] textarea, div[data-test-id="pin-draft-description"] div[contenteditable="true"], textarea[placeholder*="açıklama" i], textarea[placeholder*="description" i], div[data-test-id="pin-creation-description"] textarea';
    try {
      await page.waitForSelector(descSelector, { timeout: 10000 });
      const descEl = await page.$(descSelector);
      if (descEl) {
        await descEl.click();
        await page.keyboard.type(productDescription, { delay: 20 });
      }
    } catch (e) {
      console.log('  ℹ️ Alternatif açıklama alanı aranıyor...');
      const altDesc = await page.$('[aria-label*="description" i], [aria-label*="açıklama" i]');
      if (altDesc) {
        await altDesc.click();
        await page.keyboard.type(productDescription, { delay: 20 });
      }
    }

    await sleep(1000);

    // Link alanını doldur
    console.log('🔗 Ürün linki ekleniyor...');
    const linkSelector = 'input[data-test-id="pin-draft-link"], input[placeholder*="link" i], input[placeholder*="url" i], input[placeholder*="bağlantı" i], input[id="website-link"], div[data-test-id="pin-creation-link"] input';
    try {
      await page.waitForSelector(linkSelector, { timeout: 10000 });
      const linkEl = await page.$(linkSelector);
      if (linkEl) {
        await linkEl.click();
        await page.keyboard.type(productUrl, { delay: 30 });
      }
    } catch (e) {
      console.log('  ℹ️ Alternatif link alanı aranıyor...');
      const altLink = await page.$('[aria-label*="link" i], [aria-label*="bağlantı" i], [aria-label*="url" i]');
      if (altLink) {
        await altLink.click();
        await page.keyboard.type(productUrl, { delay: 30 });
      }
    }

    await sleep(2000);

    // =========================================
    // 6. ADIM: Pin'i Yayınla
    // =========================================
    console.log('📤 Pin yayınlanıyor...');
    const publishSelector = 'button[data-test-id="board-dropdown-save-button"], button[data-test-id="pin-draft-save-button"], div[data-test-id="pin-creation-save-button"] button, button[aria-label*="Yayınla" i], button[aria-label*="Publish" i]';
    
    try {
      await page.waitForSelector(publishSelector, { timeout: 10000 });
      const publishBtn = await page.$(publishSelector);
      if (publishBtn) {
        await publishBtn.click();
      }
    } catch (e) {
      // Alternatif: "Yayınla" / "Publish" / "Kaydet" metin içeren buton ara
      console.log('  ℹ️ Alternatif yayınlama butonu aranıyor...');
      const buttons = await page.$$('button');
      for (const btn of buttons) {
        const text = await page.evaluate((el) => el.textContent.trim().toLowerCase(), btn);
        if (text.includes('yayınla') || text.includes('publish') || text.includes('kaydet') || text.includes('save')) {
          await btn.click();
          break;
        }
      }
    }

    // Paylaşımın tamamlanmasını bekle
    await sleep(8000);

    console.log('🎉 Pin başarıyla oluşturuldu!');
    console.log(`   Başlık: ${productTitle}`);
    console.log(`   Link: ${productUrl}`);
  } catch (error) {
    console.error('❌ Pinterest işlemi sırasında hata:', error.message);
    throw error;
  } finally {
    // Tarayıcıyı her durumda kapat
    await browser.close();
    console.log('🔒 Tarayıcı kapatıldı.');
  }
}

/**
 * Geçici görsel dosyasını siler.
 * İşlem tamamlandıktan sonra disk alanını temizlemek için kullanılır.
 * @param {string} filepath - Silinecek dosya yolu
 */
function cleanupTempImage(filepath) {
  try {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      console.log('🗑️ Geçici görsel dosyası silindi.');
    }
  } catch (error) {
    console.error('⚠️ Geçici dosya silinirken hata:', error.message);
  }
}

// =====================================================
// Ana Fonksiyon
// Tüm işlem akışını yönetir ve hata durumlarını ele alır.
// =====================================================
async function main() {
  console.log('');
  console.log('====================================================');
  console.log('🤖 Etsy-Pinterest Bot Başlatılıyor...');
  console.log(`📅 Tarih: ${new Date().toLocaleString('tr-TR')}`);
  console.log('====================================================');
  console.log('');

  // Çevresel değişkenlerin varlığını kontrol et
  if (!ETSY_API_KEY || !ETSY_SHOP_ID || !PINTEREST_COOKIES) {
    console.error('❌ Gerekli çevresel değişkenler eksik! .env dosyasını kontrol edin.');
    console.error('   Gerekli değişkenler: ETSY_API_KEY, ETSY_SHOP_ID, PINTEREST_COOKIES');
    process.exit(1);
  }

  try {
    // 1. Daha önce paylaşılmış ürünlerin listesini yükle
    console.log('📂 Paylaşılmış ürünler listesi yükleniyor...');
    const sharedProducts = loadSharedProducts();
    console.log(`   Daha önce ${sharedProducts.length} ürün paylaşılmış.`);

    // 2. Etsy'den tüm aktif ürünleri çek
    const listings = await fetchAllActiveListings();
    if (listings.length === 0) {
      console.log('⚠️ Etsy mağazasında aktif ürün bulunamadı. Çıkılıyor...');
      return;
    }

    // 3. Paylaşılmamış ilk ürünü seç
    const selectedProduct = selectUnsharedProduct(listings, sharedProducts);
    if (!selectedProduct) {
      console.log('ℹ️ Paylaşılacak yeni ürün kalmadı. Program sonlandırılıyor.');
      return;
    }

    // 4. Ürün görselini indir
    const imageUrl = getProductImageUrl(selectedProduct);
    if (!imageUrl) {
      console.error('❌ Seçilen ürün için görsel bulunamadı.');
      return;
    }
    await downloadImage(imageUrl, TEMP_IMAGE_PATH);

    // 5. Puppeteer ile Pinterest'e pin olarak paylaş (cookie-based auth)
    await pinToBoard(selectedProduct, TEMP_IMAGE_PATH);

    // 6. Başarılı paylaşım → ürün ID'sini listeye ekle ve kaydet
    sharedProducts.push(selectedProduct.listing_id);
    saveSharedProducts(sharedProducts);

    console.log('');
    console.log('====================================================');
    console.log('✅ Bugünkü paylaşım başarıyla tamamlandı!');
    console.log('====================================================');
  } catch (error) {
    console.error('');
    console.error('====================================================');
    console.error('❌ Bot çalışırken bir hata oluştu:', error.message);
    console.error('====================================================');
  } finally {
    // Geçici dosyayı temizle (hata olsa bile)
    cleanupTempImage(TEMP_IMAGE_PATH);
  }
}

// Botu çalıştır
main();
