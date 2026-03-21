# 🤖 Etsy-Pinterest Otomasyon Botu

Etsy mağazanızdaki ürünleri her gün otomatik olarak Pinterest'e pin olarak paylaşır. **GitHub Actions** üzerinde tamamen ücretsiz çalışır.

## 🍪 Pinterest Cookie'lerini Nasıl Alırsınız?

Cookie tabanlı kimlik doğrulama kullanıyoruz. Bu sayede CAPTCHA, 2FA gibi sorunlar yaşanmaz.

### Adım Adım:

1. **Chrome'a "Cookie-Editor" eklentisini kurun:**
   - [Cookie-Editor — Chrome Web Store](https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm)

2. **Pinterest'e tarayıcınızdan giriş yapın:**
   - https://www.pinterest.com adresine gidin
   - E-posta ve şifrenizle normal giriş yapın

3. **Cookie'leri dışa aktarın:**
   - Tarayıcı adres çubuğunun sağında Cookie-Editor simgesine tıklayın
   - Altta **"Export"** butonuna tıklayın (JSON formatında)
   - Otomatik olarak panoya kopyalanacaktır

4. **Kopyalanan JSON'u GitHub Secret olarak kaydedin:**
   - GitHub repo → Settings → Secrets and variables → Actions
   - "New repository secret" → Ad: `PINTEREST_COOKIES`
   - Değer: panodaki JSON'u yapıştırın

> ⚠️ **Cookie'ler genellikle 1-3 ay geçerlidir.** Süreleri dolunca bot hata verir. Bu durumda yukarıdaki adımları tekrarlayıp yeni cookie'leri GitHub Secret olarak güncelleyin.

## 🚀 Kurulum

### 1. GitHub Secrets'a Değişkenleri Ekleyin

Repo → Settings → Secrets → Actions → aşağıdaki 3 secret'ı ekleyin:

| Secret Adı | Açıklama |
|---|---|
| `ETSY_API_KEY` | Etsy Developers'dan alınan API anahtarı |
| `ETSY_SHOP_ID` | Etsy mağaza ID'niz |
| `PINTEREST_COOKIES` | Yukarıda anlatılan JSON cookie |

### 2. İlk Çalıştırma

- GitHub → Actions sekmesi → **"Pinterest Bot"** → **"Run workflow"** ile manuel test yapın
- Her şey doğruysa bot her gün UTC 09:00 (Türkiye 12:00) otomatik çalışacaktır

## 📁 Dosya Yapısı

```
etsypinterest/
├── index.js                          # Ana otomasyon kodu
├── package.json                      # Bağımlılıklar
├── shared_products.json              # Paylaşılmış ürün takibi
├── .env.example                      # Çevresel değişken şablonu
├── .gitignore
└── .github/workflows/
    └── pinterest-bot.yml             # GitHub Actions workflow
```
