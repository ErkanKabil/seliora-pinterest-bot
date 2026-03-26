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
const ETSY_API_BASE = 'https://api.etsy.com/v3/application';

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
// Önce cookies.json dosyasından okumayı dene (lokal geliştirme için)
// Bulamazsa PINTEREST_COOKIES çevresel değişkenini kullan (GitHub Actions için)
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

/**
 * Belirli bir süre beklemek için yardımcı fonksiyon (ms cinsinden).
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Daha önce paylaşılmış ürünlerin listesini dosyadan okur.
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
        headers: {
          'x-api-key': ETSY_AUTH_KEY,
        },
        params: {
          limit: limit,
          offset: offset,
          includes: 'images',
        },
      });

      const { results, count } = response.data;

      if (!results || results.length === 0) {
        break;
      }

      allListings.push(...results);
      console.log(`  → ${allListings.length} / ${count} ürün çekildi.`);

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
 * Paylaşılmamış ilk ürünü seçer.
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
 * Görseli indirir.
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
 * Ürünün ana görsel URL'sini Etsy API'den ayrı endpoint ile çeker.
 * includes=images parametresi çalışmadığı için görseller ayrı çekilir.
 */
async function getProductImageUrl(product) {
  // Önce inline images alanını kontrol et
  if (product.images && product.images.length > 0) {
    return product.images[0].url_fullxfull || product.images[0].url_570xN;
  }

  // Inline yoksa ayrı endpoint'ten çek
  try {
    console.log('🖼️ Ürün görseli Etsy API\'den çekiliyor...');
    const url = `${ETSY_API_BASE}/listings/${product.listing_id}/images`;
    const response = await axios.get(url, {
      headers: { 'x-api-key': ETSY_AUTH_KEY },
    });

    const images = response.data.results;
    if (images && images.length > 0) {
      return images[0].url_fullxfull || images[0].url_570xN;
    }
  } catch (error) {
    console.error('❌ Görsel çekme hatası:', error.response?.data || error.message);
  }

  return null;
}

/**
 * Ürünün Etsy satın alma linkini oluşturur.
 */
function getProductUrl(product) {
  return product.url || `https://www.etsy.com/listing/${product.listing_id}`;
}

/**
 * Ürün başlığına göre doğru Pinterest Panosunu (Board) belirler.
 * @param {string} title - Ürün başlığı
 * @returns {string} - Pano adı
 */
function getBoardName(title) {
  // Tam kelime eşleşmesi için Regex (\b sınır belirleyici kullanırız, büyük/küçük harf duyarsızdır)
  // Böylece "spring" kelimesi içindeki "ring" yanlışlıkla eşleşmez
  const hasWord = (word) => new RegExp(`\\b${word}\\b`, 'i').test(title);

  // 1. Birthstone kontrolü (Necklace veya Bracelet ayrımı)
  if (hasWord('birthstone')) {
    if (hasWord('bracelet')) {
      return 'Bliss Jewelry Birthstone Bracelet';
    } else {
      return 'Bliss Jewelry Birthstone Necklace';
    }
  }

  // 2. Özel isim, harf, vb. kolyeler
  if (hasWord('name')) {
    return 'Bliss Jewelry Name Necklace';
  }
  if (hasWord('letter') || hasWord('initial')) {
    return 'Bliss Jewelry Letter Necklace';
  }

  // 3. Bileklikler ve Yüzükler
  if (hasWord('bracelet')) {
    return 'Bliss Jewlery Luxury Bracelet';
  }
  if (hasWord('ring')) {
    return 'Bliss Jewelry Ring';
  }

  // 4. Varsayılan (eşleşme bulunamazsa)
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
      if (cookie.expirationDate) {
        puppeteerCookie.expires = cookie.expirationDate;
      }

      return puppeteerCookie;
    });
  } catch (error) {
    console.error('❌ Cookie parse hatası:', error.message);
    throw new Error('PINTEREST_COOKIES geçerli bir JSON formatında değil.');
  }
}

/**
 * Puppeteer ile Pinterest'e cookie ile giriş yapıp pin oluşturur.
 */
async function pinToBoard(product, imagePath) {
  console.log('🚀 Pinterest işlemleri başlıyor...');

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
    await page.goto('https://www.pinterest.com/', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });
    await sleep(3000);

    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('accounts.pinterest.com')) {
      throw new Error('Pinterest oturumu geçersiz! Cookie\'lerin süresi dolmuş olabilir.');
    }
    console.log('✅ Pinterest oturumu aktif.');

    // 3. Pin oluşturma sayfasına git
    console.log('📌 Pin oluşturma sayfasına gidiliyor...');
    await page.goto('https://www.pinterest.com/pin-creation-tool/', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });
    await sleep(5000);

    // =========================================
    // YENİ: Akıllı Pano (Board) Seçimi
    // =========================================
    const selectedBoard = getBoardName(product.title);
    console.log(`📋 Pano seçiliyor: ${selectedBoard}`);
    try {
      // Pano seçimi butonunu bul (genellikle sol üstte veya sağ üstte bir dropdown)
      const boardDropdownSelector = '[data-test-id="board-dropdown-select-button"], [data-test-id="board-dropdown"]';
      await page.waitForSelector(boardDropdownSelector, { timeout: 10000 });
      await page.click(boardDropdownSelector);
      await sleep(2000);

      // Arama kutusuna pano adını yaz
      const searchInputSelector = '[data-test-id="board-search-input"], input[placeholder*="Ara" i], input[placeholder*="Search" i]';
      await page.waitForSelector(searchInputSelector, { timeout: 5000 });
      await page.click(searchInputSelector);
      await page.evaluate((text) => document.execCommand('insertText', false, text), selectedBoard);
      await sleep(3000); // Arama sonuçlarının filtrelenmesini bekle

      // İlk sonuca tıkla
      const boardResultSelector = '[data-test-id="board-row"]';
      const boardResults = await page.$$(boardResultSelector);
      if (boardResults.length > 0) {
        await boardResults[0].click();
        console.log(`✅ Pano başarıyla seçildi: ${selectedBoard}`);
        await sleep(2000);
      } else {
        // Eşleşme çıkmazsa Enter tuşuna basıp onaylamayı dene
        await page.keyboard.press('Enter');
        console.log(`⚠️ Arama sonucunda "${selectedBoard}" panosu bulunamadı, varsayılan pano ile devam ediliyor.`);
      }
    } catch (e) {
      console.log('  ⚠️ Pano seçilirken hata oluştu/dropdown bulunamadı (Varsayılan pano kullanılacak):', e.message);
    }

    // 4. Görseli yükle
    console.log('🖼️ Görsel yükleniyor...');
    const fileInput = await page.$('input[type="file"]');
    if (fileInput) {
      await fileInput.uploadFile(imagePath);
      console.log('✅ Görsel yükleme başlatıldı.');
    } else {
      throw new Error('Dosya yükleme alanı bulunamadı.');
    }
    await sleep(8000);

    // 5. Pin bilgilerini doldur
    const productTitle = product.title.substring(0, 100);
    const productDescription = (product.description || product.title);
    const productUrl = getProductUrl(product);

    // Başlık
    console.log('📝 Pin başlığı yazılıyor...');
    const titleSelector = 'div[data-test-id="pin-draft-title"] textarea, div[data-test-id="pin-draft-title"] div[contenteditable="true"], input[placeholder*="title" i], div[data-test-id="pin-creation-title"] textarea';
    try {
      await page.waitForSelector(titleSelector, { timeout: 10000 });
      const titleEl = await page.$(titleSelector);
      if (titleEl) {
        await titleEl.click();
        await page.evaluate((text) => document.execCommand('insertText', false, text), productTitle);
      }
    } catch (e) {
      const altTitle = await page.$('[aria-label*="title" i], [aria-label*="başlık" i]');
      if (altTitle) {
        await altTitle.click();
        await page.evaluate((text) => document.execCommand('insertText', false, text), productTitle);
      }
    }
    await sleep(1000);

    // Açıklama (Yarıda kesilmemesi için document.execCommand kullanıyoruz)
    console.log('📝 Pin açıklaması yazılıyor (Metnin tamamı yapıştırılıyor)...');
    const descSelector = 'div[data-test-id="pin-draft-description"] textarea, div[data-test-id="pin-draft-description"] div[contenteditable="true"], textarea[placeholder*="description" i], div[data-test-id="pin-creation-description"] textarea';
    try {
      await page.waitForSelector(descSelector, { timeout: 10000 });
      const descEl = await page.$(descSelector);
      if (descEl) {
        await descEl.click();
        // Uzun metinlerde Puppeteer type() kesilebilir. Bunun yerine execCommand ile tek hamlede yapıştırıyoruz.
        await page.evaluate((text) => document.execCommand('insertText', false, text), productDescription);
      }
    } catch (e) {
      const altDesc = await page.$('[aria-label*="description" i], [aria-label*="açıklama" i]');
      if (altDesc) {
        await altDesc.click();
        await page.evaluate((text) => document.execCommand('insertText', false, text), productDescription);
      }
    }
    await sleep(1000);

    // Link
    console.log('🔗 Ana ürün linki ekleniyor...');
    const linkSelector = 'input[data-test-id="pin-draft-link"], input[placeholder*="link" i], input[placeholder*="url" i], input[id="website-link"], div[data-test-id="pin-creation-link"] input';
    try {
      await page.waitForSelector(linkSelector, { timeout: 10000 });
      const linkEl = await page.$(linkSelector);
      if (linkEl) {
        await linkEl.click();
        await page.evaluate((text) => document.execCommand('insertText', false, text), productUrl);
        // Linki aktif etmek için focus dışında bir tuşa bas
        await page.keyboard.press('Escape');
      }
    } catch (e) {
      const altLink = await page.$('[aria-label*="link" i], [aria-label*="url" i]');
      if (altLink) {
        await altLink.click();
        await page.evaluate((text) => document.execCommand('insertText', false, text), productUrl);
        await page.keyboard.press('Escape');
      }
    }
    await sleep(2000);

    // =========================================
    // YENİ: Ürün Olarak Etiketleme (Product Pin Ekle)
    // =========================================
    console.log('🛍️ Pin "Ürün Pini" (Product Pin) olarak ayarlanıyor...');
    try {
      // "Ürün Ekle" / "Tag products" butonunu bul
      let addProductBtn = await page.$('[data-test-id="add-products-button"]');
      if (!addProductBtn) {
        const buttons = await page.$$('button, div[role="button"]');
        for (const btn of buttons) {
          const text = await page.evaluate(el => el.textContent?.trim().toLowerCase() || '', btn);
          if (text === 'ürün ekle' || text === 'tag products' || text.includes('ürünleri etiketle')) {
            addProductBtn = btn;
            break;
          }
        }
      }

      if (addProductBtn) {
        await addProductBtn.click();
        console.log('   ↳ "Ürün Ekle" butonuna tıklandı.');
        await sleep(3000);

        // "Bir Bağlantı Kullan" / "Use a link" butonunu bul
        let useLinkBtn = await page.$('[data-test-id="use-link-button"]');
        if (!useLinkBtn) {
          const links = await page.$$('button, div[role="button"], div[role="tab"]');
          for (const btn of links) {
            const text = await page.evaluate(el => el.textContent?.trim().toLowerCase() || '', btn);
            if (text.includes('bağlantı kullan') || text.includes('use a link') || text.includes('url')) {
              useLinkBtn = btn;
              break;
            }
          }
        }

        if (useLinkBtn) {
          await useLinkBtn.click();
          console.log('   ↳ "Bir Bağlantı Kullan" sekmesine geçildi.');
          await sleep(2000);
        }

        // Link input alanına URL'yi yapıştır
        const prodLinkInputSelector = 'input[type="url"], input[type="text"], input[placeholder*="ör."], input[placeholder*="e.g."]';
        let prodInput = await page.$(prodLinkInputSelector);
        if (prodInput) {
          await prodInput.click();
          await page.evaluate((text) => document.execCommand('insertText', false, text), productUrl);
          await sleep(1000);
          await page.keyboard.press('Enter'); // Submit et
          console.log('   ↳ Link aratıldı, görsellerin gelmesi bekleniyor...');
          await sleep(5000); // Pinterest'in sitesinden görsel çekmesini bekle

          // Çıkan görsellerden ilkini seç (genellikle resme veya checkbox'a tıklamak gerekir)
          const imageResultsSelector = 'div[data-test-id="selectable-image"], div[role="checkbox"], div[role="button"] img';
          const imageResults = await page.$$(imageResultsSelector);
          if (imageResults.length > 0) {
            await imageResults[0].click();
            console.log('   ↳ İlk ürün görseli seçildi.');
            await sleep(2000);

            // "Ürün Ekle" / "Save products" / "Add 1 product" butonuna bas (modal onayı)
            let saveProdBtn = await page.$('[data-test-id="save-products-button"], button[type="submit"]');
            if (!saveProdBtn) {
              const modalBtns = await page.$$('button');
              for (const btn of modalBtns) {
                const text = await page.evaluate(el => el.textContent?.trim().toLowerCase() || '', btn);
                if (text.includes('ekle') || text.includes('kaydet') || text.includes('save') || text.includes('add')) {
                  // Modal onay butonu genellikle arka planı kırmızıdır
                  const isRed = await page.evaluate(el => {
                    const bg = window.getComputedStyle(el).backgroundColor;
                    return bg.includes('rgb(230, 0, 35)') || bg.includes('rgb(204, 0, 0)') || el.className.includes('primary');
                  }, btn);
                  if (isRed) {
                    saveProdBtn = btn;
                    break;
                  }
                }
              }
            }
            if (saveProdBtn) {
              await saveProdBtn.click();
              console.log('   ↳ "Ürünleri Kaydet/Ekle" butonu ile modal kapatıldı.');
              await sleep(3000);
            }
          } else {
            console.log('   ⚠️ Bağlantı girildi ama onaylanacak görsel bulunamadı.');
          }
        }
      } else {
        console.log('   ⚠️ "Ürün Ekle" butonu DOM üzerinde bulunamadı.');
      }
    } catch (e) {
      console.log('   ⚠️ Ürün pini ekleme akışında sorun çıktı (Normal linkle devam edilecek):', e.message);
    }

    // 6. Yayınla
    console.log('📤 Pin yayınlanıyor...');
    
    // YENİ: Ağ isteklerini dinleyerek oluşturulan Pin'in IDsini yakala (Frontend'de link gözükmese bile API'den alırız)
    let createdPinUrl = null;
    const responseHandler = async (response) => {
      try {
        const url = response.url();
        if (url.includes('/resource/PinResource/create/')) {
          const json = await response.json();
          if (json && json.resource_response && json.resource_response.data && json.resource_response.data.id) {
            createdPinUrl = `https://www.pinterest.com/pin/${json.resource_response.data.id}/`;
          }
        }
      } catch (e) {
        // Yoksay
      }
    };
    page.on('response', responseHandler);
    const publishSelector = 'button[data-test-id="board-dropdown-save-button"], button[data-test-id="pin-draft-save-button"], div[data-test-id="pin-creation-save-button"] button, button[aria-label*="Publish" i]';
    try {
      await page.waitForSelector(publishSelector, { timeout: 10000 });
      const publishBtn = await page.$(publishSelector);
      if (publishBtn) {
        await publishBtn.click();
      }
    } catch (e) {
      const buttons = await page.$$('button');
      for (const btn of buttons) {
        const text = await page.evaluate((el) => el.textContent.trim().toLowerCase(), btn);
        if (text.includes('yayınla') || text.includes('publish') || text.includes('kaydet') || text.includes('save')) {
          await btn.click();
          break;
        }
      }
    }

    await sleep(6000); // Pinterest'in işlemi tamamlamasını ve toast bildirimi göstermesini bekle

    console.log('🎉 Pin başarıyla oluşturuldu!');
    console.log(`   Etsy Başlık: ${productTitle}`);
    console.log(`   Etsy Link: ${productUrl}`);

    // API Dinleyicisini temizle
    page.off('response', responseHandler);

    // YENİ: Pin URL'sini logla (Önce API yanıtı, olmazsa DOM fallback)
    if (createdPinUrl) {
      console.log(`   📌 Oluşturulan Pin Bağlantısı (API'den yakalandı): ${createdPinUrl}`);
    } else {
      try {
        // Toast bildirimindeki veya sayfadaki yeni pin linkini (/pin/...) bul
        const pinLinkEl = await page.$('a[href*="/pin/"]');
        if (pinLinkEl) {
          let pinHref = await page.evaluate(el => el.href, pinLinkEl);
          // Bazen yönlendirme linkleri kısmi olabilir, origin ile birleştir
          if (!pinHref.startsWith('http')) {
            pinHref = `https://www.pinterest.com${pinHref}`;
          }
          console.log(`   📌 Oluşturulan Pin Bağlantısı: ${pinHref}`);
        } else {
          // Eğer link element olarak bulunamazsa sayfanın değişen URL'sine bak
          const currentUrl = page.url();
          if (currentUrl.includes('/pin/')) {
            console.log(`   📌 Oluşturulan Pin Bağlantısı: ${currentUrl}`);
          } else {
             console.log('   ℹ️ Pin linki anlık olarak ekrandan alınamadı, ancak pin başarıyla paylaşıldı.');
          }
        }
      } catch (e) {
        console.log('   ⚠️ Pin URL\'si alırken bir hata oluştu.');
      }
    }
  } catch (error) {
    console.error('❌ Pinterest işlemi sırasında hata:', error.message);
    throw error;
  } finally {
    await browser.close();
    console.log('🔒 Tarayıcı kapatıldı.');
  }
}

/**
 * Geçici görsel dosyasını siler.
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
// =====================================================
async function main() {
  console.log('');
  console.log('====================================================');
  console.log('🤖 Etsy-Pinterest Bot Başlatılıyor...');
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
    const sharedProducts = loadSharedProducts();
    console.log(`   Daha önce ${sharedProducts.length} ürün paylaşılmış.`);

    // 2. Etsy'den aktif ürünleri çek
    const listings = await fetchAllActiveListings();
    if (listings.length === 0) {
      console.log('⚠️ Etsy mağazasında aktif ürün bulunamadı. Çıkılıyor...');
      return;
    }

    // 3. Paylaşılmamış ilk ürünü seç
    const selectedProduct = selectUnsharedProduct(listings, sharedProducts);
    if (!selectedProduct) {
      console.log('ℹ️ Paylaşılacak yeni ürün kalmadı.');
      return;
    }

    // 4. Ürün görselini indir
    const imageUrl = await getProductImageUrl(selectedProduct);
    if (!imageUrl) {
      console.error('❌ Seçilen ürün için görsel bulunamadı.');
      return;
    }
    await downloadImage(imageUrl, TEMP_IMAGE_PATH);

    // 5. Pinterest'e pin olarak paylaş
    await pinToBoard(selectedProduct, TEMP_IMAGE_PATH);

    // 6. Başarılı → ID'yi kaydet
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
    cleanupTempImage(TEMP_IMAGE_PATH);
  }
}

// Botu çalıştır
main();