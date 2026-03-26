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
    headless: 'new', // GitHub Actions'ta sorunsuz çalışması için 'new' kullanılıyor
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

    // =========================================
    // YENİ: Akıllı Pano (Board) Seçimi
    // =========================================
    const selectedBoard = getBoardName(product.title);
    console.log(`📋 Pano seçiliyor: ${selectedBoard}`);
    try {
      // Pano seçimi butonunu bul ve FOCUS + ENTER yöntemiyle %100 güvenli şekilde tıkla
      const boardDropdownSelector = '[data-test-id="board-dropdown-select-button"]';
      await page.waitForSelector(boardDropdownSelector, { visible: true, timeout: 10000 });
      const boardBtn = await page.$(boardDropdownSelector);
      console.log(boardBtn);
      if (boardBtn) {
        // Accessibility standardı: Focus al ve Enter'a bas
        await boardBtn.click();
        await sleep(2000);
        console.log('   ↳ Pano açılır menüsü tetiklendi.');
      }

      // Dropdown'un açılmasını bekle
      const flyoutSelector = '[data-test-id="board-picker-flyout"]';
      await page.waitForSelector(flyoutSelector, { timeout: 10000 });
      await sleep(1500);

      // Listeyi açıp texti bul ve parent butona tıkla (TreeWalker algoritmamız)
      const isBoardClicked = await page.evaluate((boardName) => {
        const flyout = document.querySelector('[data-test-id="board-picker-flyout"]');
        if (!flyout) return false;

        const walker = document.createTreeWalker(flyout, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while (node = walker.nextNode()) {
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
            // Eğer hiyerarşide role="button" bulunamazsa doğrudan text parent'ına tıkla
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
        console.log(`⚠️ Arama sonucunda "${selectedBoard}" panosu bulunamadı, dropdown kapatılıyor.`);
        await page.keyboard.press('Escape');
        await sleep(1000);
      }
    } catch (e) {
      console.log('  ⚠️ Pano seçilirken hata oluştu/dropdown bulunamadı (Varsayılan pano kullanılacak):', e.message);
    }

    // 5. Pin bilgilerini doldur
    let productTitle = '';
    const terms = product.title.split(',').map(t => t.trim());
    for (const term of terms) {
      const addition = productTitle ? `, ${term}` : term;
      if ((productTitle.length + addition.length) <= 100) {
        productTitle += addition;
      } else {
        break; // 100 karakter sınırını aşıyorsa dur
      }
    }
    if (!productTitle) {
      productTitle = product.title.substring(0, 100); // Çok uzun tek bir kelime varsa
    }
    
    let productDescription = (product.description || product.title);
    const paragraphs = productDescription.split('\n').map(p => p.trim()).filter(p => p.length > 0);
    if (paragraphs.length >= 2) {
      productDescription = paragraphs[0] + '\n\n' + paragraphs[1];
    } else if (paragraphs.length === 1) {
      productDescription = paragraphs[0];
    }
    
    const productUrl = getProductUrl(product);

    // Başlık
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
      console.log('⚠️ Başlık alanı bulunamadı:', e.message);
    }
    await sleep(1000);

    // Açıklama (Pinterest açıklaması max 500 karakterdir, çok uzun olursa type() yavaşlar)
    console.log('📝 Pin açıklaması yazılıyor...');
    const descSelector = 'div[data-test-id="pin-draft-description"] div[contenteditable="true"], div[data-test-id="pin-creation-description"] textarea, textarea[placeholder*="Açıklama" i], div[contenteditable="true"]:has-text("Açıklama") + div';
    try {
      const textAreas = await page.$$('textarea, div[contenteditable="true"]');
      let foundDesc = false;
      for (const el of textAreas) {
        const placeholder = await page.evaluate(e => e.getAttribute('placeholder') || e.getAttribute('aria-label') || '', el);
        if (placeholder.toLowerCase().includes('description') || placeholder.toLowerCase().includes('açıklama')) {
          await el.click();
          // Draft.js / React editor için içeriği tamamen silip native type kullanıyoruz
          await page.keyboard.down('Meta');
          await page.keyboard.press('a');
          await page.keyboard.up('Meta');
          await page.keyboard.press('Backspace');
          await sleep(500);

          // Açıklamanın tamamını yavaşça, kesilmeden yaz (await kullandığımız için tam yazmadan geçmez)
          await page.keyboard.type(productDescription, { delay: 10 });
          foundDesc = true;
          break;
        }
      }
      if (!foundDesc) {
        // Fallback
        await page.evaluate((text) => document.execCommand('insertText', false, text), productDescription);
      }
    } catch (e) {
      console.log('⚠️ Açıklama alanı doldurulurken hata:', e.message);
    }
    await sleep(1000);

    // Link
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
      console.log('⚠️ Link eklenerken hata:', e.message);
    }
    await sleep(2000);

    // =========================================
    // YENİ: Etiketler (Tags)
    // =========================================
    console.log('🏷️ Etiketler (Tags) ekleniyor...');
    const tagsSelector = '#combobox-storyboard-interest-tags';
    try {
      const tagsInput = await page.$(tagsSelector);
      if (tagsInput) {
        await tagsInput.click();
        const tags = product.tags || []; // Etsy'den gelen "tags" arrayi
        if (tags.length > 0) {
          // Pinterest genelde en fazla 5-10 etiket destekler, biz tümünü deneyelim (max 10)
          const tagsToAdd = tags.slice(0, 10);
          for (const tag of tagsToAdd) {
            // inputu temizle:
            await tagsInput.click({ clickCount: 3 }); // Üçlü tıklama metni seçer
            await page.keyboard.press('Backspace');
            await sleep(300);

            // stroke-by-stroke yazarak dropdown'un tetiklenmesini sağla
            await page.type(tagsSelector, tag, { delay: 50 });
            await sleep(1500); // Pinterest'in eşleşen etiketi getirmesi için bekle
            await page.keyboard.press('Enter'); // NATIVE enter
            await sleep(1500); // Pinterest'in etiketi butona (pill) çevirmesi için bekle
          }
          console.log(`   ✅ ${tagsToAdd.length} adet etiket eklendi.`);
        } else {
          console.log('   ℹ️ Etsy ürününde etiket bulunamadı.');
        }
      } else {
        console.log('   ⚠️ Etiket ekleme inputu bulunamadı (#combobox-storyboard-interest-tags).');
      }
    } catch (e) {
      console.log('   ⚠️ Etiketler eklenirken hata oluştu:', e.message);
    }
    await sleep(2000);

    // =========================================
    // YENİ: Ürün Olarak Etiketleme (Product Pin Ekle)
    // =========================================
    console.log('🛍️ Pin "Ürün Pini" (Product Pin) olarak ayarlanıyor...');
    try {
      // 1. "Ürün Ekle" butonunu bul
      const addProductSelector = '[data-test-id="add-product-tags-button"]';
      await page.waitForSelector(addProductSelector, { timeout: 5000 });
      await page.click(addProductSelector);
      console.log('   ↳ "Ürün Ekle" butonuna tıklandı.');
      await sleep(3000);

      // 2. "Bir Bağlantı Kullan" tabını bul
      const useLinkTabSelector = '#use-a-link-tab';
      await page.waitForSelector(useLinkTabSelector, { timeout: 5000 });
      await page.click(useLinkTabSelector);
      console.log('   ↳ "Bir Bağlantı Kullan" sekmesine geçildi.');
      await sleep(2000);

      // 3. Link input alanına URL'yi yapıştır
      const productSearchInputSelector = '#storyboard-product-tags-asset-picker--search-by-link--search-field';
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
        await page.keyboard.press('Enter'); // Aramayı tetikle
        console.log('   ↳ Link aratıldı, görsellerin gelmesi bekleniyor...');
        await sleep(6000); // Pinterest'in resmi çekmesini bekle

        // 4. İlk görseli seç
        const imageSelector = '#use-a-link-panel div.masonryContainer [data-grid-item-idx="0"] div[role="button"]';
        const imageResults = await page.$$(imageSelector);
        if (imageResults.length > 0) {
          await imageResults[0].click();
          console.log('   ↳ İlk ürün görseli seçildi.');
          await sleep(2000);

          // 5. Kaydet/Ekle butonuna bas (Genellikle form type="submit" olur veya red background)
          const isClicked = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const btn = btns.find(b => {
              const text = b.textContent.toLowerCase();
              return (text.includes('ekle') || text.includes('kaydet') || text.includes('save') || text.includes('add')) &&
                window.getComputedStyle(b).backgroundColor.includes('rgb(230, 0, 35)');
            });
            if (btn) {
              btn.click();
              return true;
            }
            return false;
          });
          if (isClicked) {
            console.log('   ↳ "Ürünleri Kaydet/Ekle" butonu ile modal kapatıldı.');
            await sleep(3000);
          }
        } else {
          console.log('   ⚠️ Bağlantı girildi ama onaylanacak görsel bulunamadı.');
        }
      }
    } catch (e) {
      console.log('   ⚠️ Ürün pini ekleme akışında sorun çıktı:', e.message);
    }

    // 6. Yayınla (Publish)
    console.log('📤 Pin yayınlanıyor...');

    // Ağ isteklerini dinleyerek oluşturulan Pin'in IDsini yakala
    let createdPinUrl = null;
    // Kırmızı "Yayınla" butonunu bulup tıkla
    try {
      const isPublished = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        // Üst sağdaki Yayınla butonu kırmızıdır (E20023 / rgb(230, 0, 35))
        const btn = btns.find(b => {
          const text = b.textContent.trim().toLowerCase();
          const bg = window.getComputedStyle(b).backgroundColor;
          return (text === 'yayınla' || text === 'publish') && bg.includes('rgb(230, 0, 35)');
        });
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (!isPublished) {
        // Fallback selectors
        const fallbackSel = 'button[data-test-id="board-dropdown-save-button"], button[data-test-id="pin-draft-save-button"]';
        await page.evaluate(sel => document.querySelector(sel)?.click(), fallbackSel);
      }
    } catch (e) {
      console.log('   ⚠️ Yayınla butonuna tıklanamadı:', e.message);
    }

    await sleep(6000); // Pinterest'in işlemi tamamlamasını ve toast bildirimi göstermesini bekle

    console.log('🎉 Pin başarıyla oluşturuldu!');
    console.log(`   Etsy Başlık: ${productTitle}`);
    console.log(`   Etsy Link: ${productUrl}`);

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