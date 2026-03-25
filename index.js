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
          offset: offset
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
 * Ürünün Etsy satın alma linkini oluşturur.
 */
function getProductUrl(product) {
  return product.url || `https://www.etsy.com/listing/${product.listing_id}`;
}

/**
 * Pano adını ürünün başlığına göre belirler.
 */
function determineBoardName(title) {
  const lowerTitle = title.toLowerCase();
  
  if (lowerTitle.includes('bracelet')) {
    if (lowerTitle.includes('birthstone')) return 'Birthstone Bracelet';
    return 'Bliss Jewelry Luxury Bracelet';
  }
  
  if (lowerTitle.includes('letter') || lowerTitle.includes('initial')) {
    return 'Bliss Jewelry Letter Necklace';
  }
  
  if (lowerTitle.includes('name')) {
    return 'Bliss Jewelry Name Necklace';
  }
  
  if (lowerTitle.includes('ring')) {
    return 'Bliss Jewelry Ring';
  }
  
  if (lowerTitle.includes('birthstone')) {
    return 'Bliss Birthstone Necklace';
  }
  
  // Varsayılan pano
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
 * Klavyeden yavaşça metin girmek için yardımcı fonksiyon
 */
async function typeVerySlowly(page, text) {
  // Metni panoya kopyalayıp yapıştırmak en güvenlisi ama direkt type da edebiliriz.
  await page.keyboard.type(text, { delay: 10 });
}

/**
 * Puppeteer ile Pinterest'e cookie ile giriş yapıp pin oluşturur.
 */
async function pinToBoard(product) {
  console.log('🚀 Pinterest işlemleri başlıyor...');

  const browser = await puppeteer.launch({
    headless: false, // GUI'ı görebilmek için lokalde false yapıp test edebiliriz
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
      waitUntil: 'domcontentloaded',
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
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await sleep(8000); // Sistemin iyice yüklenmesi için 

    const productTitle = product.title;
    const productDescription = product.description || product.title;
    const productUrl = getProductUrl(product);
    const boardName = determineBoardName(productTitle);
    
    console.log(`🎯 Belirlenen Pano (Board): ${boardName}`);

    // ==========================================
    // A. PANO (BOARD) SEÇİMİ
    // ==========================================
    console.log('📋 Pano seçiliyor...');
    try {
      // Pano açılır menüsü butonuna tıkla
      const boardDropdownSelectors = [
        'button[data-test-id="board-dropdown-select-button"]',
        '[data-tour-id="pin-builder-board-dropdown"] button',
        'div[data-test-id="board-dropdown"] div[role="button"]',
        'div[aria-haspopup="listbox"][role="button"]'
      ];
      
      let dropdownClicked = false;
      for (const selector of boardDropdownSelectors) {
        const btn = await page.$(selector);
        if (btn) {
          await btn.click();
          dropdownClicked = true;
          break;
        }
      }
      
      if (!dropdownClicked) {
        console.log('  ⚠️ Pano menüsü butonu bulunamadı, mevcut pano kullanılacak veya hata verecek.');
      } else {
        await sleep(2000);
        
        // Pano arama kutusuna pano adını yaz
        const searchInputSelector = 'input[placeholder*="Ara" i], input[placeholder*="Search" i], [data-test-id="board-search-input"] input';
        const searchInput = await page.$(searchInputSelector);
        if (searchInput) {
          await searchInput.click();
          await page.keyboard.type(boardName, { delay: 50 });
          await sleep(2000);
          
          // Çıkan sonucu seç
          // Pano adını içeren div'e veya list item'a tıkla
          const boardListItems = await page.$$('div[data-test-id="board-row"]');
          let selected = false;
          for (const item of boardListItems) {
            const text = await page.evaluate((el) => el.textContent.trim(), item);
            if (text.includes(boardName)) {
              await item.click();
              selected = true;
              break;
            }
          }
          if (!selected) {
             console.log(`  ⚠️ "${boardName}" panosu listede bulunamadı, enter'a basılıyor.`);
             await page.keyboard.press('Enter');
          }
          await sleep(2000);
        }
      }
    } catch (e) {
      console.log('  ⚠️ Pano seçimi sırasında bir hata oluştu:', e.message);
    }

    // ==========================================
    // B. LİNK ÜZERİNDEN GÖRSEL YÜKLEME
    // ==========================================
    console.log('🔗 Link üzerinden pin oluşturma arayüzüne geçiliyor...');
    try {
      // "Bir bağlantı kullan" (Save from site) butonunu bul ve tıkla
      let linkBtnClicked = false;
      
      // En kesin yol: id üzerinden bulmak
      const exactBtn = await page.$('#use-a-link-tab');
      if (exactBtn) {
         await exactBtn.click();
         linkBtnClicked = true;
      }

      if (!linkBtnClicked) {
        const linkButtons = await page.$$('button, div[role="button"], div[role="tab"], a');
        for (const btn of linkButtons) {
          const text = await page.evaluate((el) => el.textContent ? el.textContent.trim().toLowerCase() : '', btn);
          if (text.includes('bir bağlantı kullan') || text.includes('bağlantı kullan') || text.includes("url'den kaydet") || text.includes('save from site')) {
            await btn.click();
            linkBtnClicked = true;
            break;
          }
        }
      }
      
      if (!linkBtnClicked) {
        const altBtn = await page.$('button[data-test-id="save-from-site-button"]');
        if (altBtn) {
           await altBtn.click();
           linkBtnClicked = true;
        } else {
           const html = await page.content();
           fs.writeFileSync('pinterest_debug.html', html);
           throw new Error('"Bir bağlantı kullan" butonu bulunamadı! Sayfa kaynağı pinterest_debug.html dosyasına kaydedildi.');
        }
      }

      await sleep(2000);

      // Link giriş alanını bul (URL input)
      console.log('  ➡️ URL yazılıyor: ' + productUrl);
      const urlInputSelector = 'input[placeholder*="bağlantı" i], input[placeholder*="link" i]';
      const urlInput = await page.$(urlInputSelector);
      if (urlInput) {
        await urlInput.click();
        
        // Çok hızı yazarken sorun olabiliyor, panoya kopyala/yapıştır veya seri yazım
        // page.keyboard.type çok hızlı veya çok yavaş olursa sorun olabiliyor
        await page.evaluate((val, selector) => { document.querySelector(selector).value = val; }, productUrl, urlInputSelector);
        // Eventi tetikle
        await urlInput.type(' ');
        await page.keyboard.press('Backspace');
        
        await sleep(1000);
        await page.keyboard.press('Enter');
        
        console.log('  ➡️ Link gönderildi, görsellerin gelmesi bekleniyor...');
        await sleep(8000); // Siteden resimlerin parse edilmesini bekle
        
        // İlk görseli seç
        const images = await page.$$('div[data-test-id^="pin-builder-image-select"] img, img.GrowthUnauthPinImage');
        if (images.length > 0) {
          // Bazen resmin üzerine tıklamak yetmiyor, div'ine tıklamak gerekebiliyor
          const firstImageContainer = await page.$('div[data-test-id="website-image-picker-grid"] div[role="button"]');
          if (firstImageContainer) {
             await firstImageContainer.click();
          } else {
             await images[0].click();
          }
          console.log('  ✅ İlk görsel seçildi.');
          await sleep(1000);
          
          // "Pin ekle" / "Ekle" / "Add pin" butonuna tıkla
          const addPinBtns = await page.$$('button');
          for (const btn of addPinBtns) {
             const text = await page.evaluate((el) => el.textContent.trim().toLowerCase(), btn);
             if (text === 'pin ekle' || text === 'ekle' || text === 'add pin' || text === 'add 1 pin' || text === '1 pin ekle') {
               await btn.click();
               break;
             }
          }
          await sleep(3000);
        } else {
          throw new Error('Linkten herhangi bir görsel çekilemedi.');
        }

      }
    } catch (e) {
       console.log('❌ Link üzerinden görsel yükleme adımı başarısız oldu:', e.message);
       throw e; // Zaten hata varsa pin oluşturamayız
    }

    // ==========================================
    // C. PİN BİLGİLERİNİ DOLDURMA
    // ==========================================
    // Başlık
    console.log('📝 Pin başlığı yazılıyor...');
    const titleSelector = 'div[data-test-id="pin-draft-title"] textarea, div[data-test-id="pin-draft-title"] div[contenteditable="true"], input[placeholder*="title" i], div[data-test-id="pin-creation-title"] textarea';
    try {
      await page.waitForSelector(titleSelector, { timeout: 10000 });
      const titleEl = await page.$(titleSelector);
      if (titleEl) {
        await titleEl.click();
        await page.keyboard.type(productTitle.substring(0, 100), { delay: 50 }); // Başlık hala Pinterest sınırlarına (100) takılabilir
      }
    } catch (e) {
      const altTitle = await page.$('[aria-label*="title" i], [aria-label*="başlık" i]');
      if (altTitle) {
        await altTitle.click();
        await page.keyboard.type(productTitle.substring(0, 100), { delay: 50 });
      }
    }
    await sleep(1000);

    // Açıklama (TÜM AÇIKLAMA)
    console.log('📝 Pin tam açıklaması yazılıyor (' + productDescription.length + ' karakter)...');
    const descSelector = 'div[data-test-id="pin-draft-description"] textarea, div[data-test-id="pin-draft-description"] div[contenteditable="true"], textarea[placeholder*="description" i], div[data-test-id="pin-creation-description"] textarea';
    try {
      await page.waitForSelector(descSelector, { timeout: 10000 });
      const descEl = await page.$(descSelector);
      if (descEl) {
        await descEl.click();
        await page.keyboard.type(productDescription, { delay: 0 });
      } else {
        throw new Error('İlk seçici bulunamadı');
      }
    } catch (e) {
      console.log('⚠️ İlk açıklama seçicisi bulunamadı, alternatif deneniyor...');
      
      let altDesc = await page.$('div.public-DraftEditor-content, div[contenteditable="true"]');
      if (!altDesc) {
         // JavaScript ile sayfadaki tüm div/textarea/button elementlerini tara ve aria-label içinde açıklama geçeni bul
         const handles = await page.$$('div, textarea, span');
         for (const h of handles) {
            const aria = await page.evaluate(el => el.getAttribute('aria-label') || '', h);
            if (aria.toLowerCase().includes('açıklama') || aria.toLowerCase().includes('description')) {
               altDesc = h;
               break;
            }
         }
      }

      if (altDesc) {
        await altDesc.click();
        await sleep(500); // Click sonrası focus ve Draft.js state aktifleşmesini bekle
        await page.keyboard.type(productDescription, { delay: 0 });
      } else {
        console.log('❌ Tüm denemelere rağmen açıklama alanı bulunamadı.', e.message);
      }
    }
    await sleep(1000);

    // Link (eğer zaten dolu değilse, bazen 'Save from site' ile gelince otomatik doluyor)
    console.log('🔗 Link alanı kontrol ediliyor...');
    const linkSelector = 'input[data-test-id="pin-draft-link"], input[placeholder*="link" i], input[placeholder*="url" i], input[id="website-link"], div[data-test-id="pin-creation-link"] input';
    try {
      const linkEl = await page.$(linkSelector);
      if (linkEl) {
        const currentVal = await page.evaluate(el => el.value, linkEl);
        if (!currentVal || currentVal.length === 0) {
           await linkEl.click();
           await page.keyboard.type(productUrl, { delay: 30 });
        } else {
           console.log('  ℹ️ Link zaten otomatik dolmuş (' + currentVal + ')');
        }
      }
    } catch (e) {
       console.log('Link kontrolünde hata', e);
    }
    await sleep(2000);

    // ==========================================
    // D. YAYINLAMA
    // ==========================================
    console.log('📤 Pin yayınlanıyor...');
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

    await sleep(8000);

    console.log('🎉 Pin başarıyla oluşturuldu!');
    console.log(`   Başlık: ${productTitle.substring(0,50)}...`);
    console.log(`   Pano: ${boardName}`);
    console.log(`   Link: ${productUrl}`);
  } catch (error) {
    console.error('❌ Pinterest işlemi sırasında hata:', error.message);
    throw error;
  } finally {
    await browser.close();
    console.log('🔒 Tarayıcı kapatıldı.');
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

    // 5. Pinterest'e pin olarak paylaş (Artık kendi linkinden görsel çekecek)
    await pinToBoard(selectedProduct);

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
  }
}

// Botu çalıştır
main();