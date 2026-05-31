# li-outreach

LinkedIn outreach otomasyonu. ConnectSafely API + Claude + Google Sheets.

## Mimari

```
GitHub Actions (cron, 30 dk)
  -> src/index.js
       -> Sheets'ten lead/list cek
       -> ConnectSafely'den son cevaplari poll et
       -> State machine: her lead icin "bugun ne yapilmali?"
       -> Aksiyon yap (view/follow/like/comment/connect/dm)
       -> Sheets'i guncellestir
```

## Setup adimlari

### 1. Repo kur

```bash
git clone <bu repo>
cd li-outreach
npm install
```

### 2. Google Sheet hazirla

Sheet ID'sini al (URL'den) ve service account email'ine **Editor** olarak paylas.

### 3. ConnectSafely API key al

https://connectsafely.ai/api-key -> kopyala.

### 4. Anthropic API key al

https://console.anthropic.com -> API Keys -> kopyala.

### 5. GitHub secrets ekle

Repo Settings > Secrets and variables > Actions > New repository secret:

| Secret | Deger |
|---|---|
| `SHEET_ID` | Sheet ID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | JSON dosyasinin tum icerigi |
| `CS_API_KEY` | ConnectSafely API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |

Opsiyonel variables (Settings > Variables):

| Var | Default |
|---|---|
| `DAILY_NEW_LEADS` | 5 |
| `DAILY_TOTAL_ACTIONS` | 40 |

### 6. Ilk run: Sheet sema'sini olustur

Actions sekmesinden `li-outreach runner` -> Run workflow -> mode = `init-sheet-only` sec.

Bu calistiktan sonra Sheet'inde su tab'lar otomatik olusur: Lists, Leads, ActionLog, Conversations, Dashboard. Tum dropdown'lar ve formatlama hazir gelir.

### 7. Liste ekle

Sheet'i ac -> `Lists` tab'ina git -> bir satir ekle:

```
list_id  | name              | target_side | service_type      | goal                              | tone        | region | active | created_at
L01      | investor_eu_seed  | investor    | private_placement | EU seed investors for fintech    | formal,warm | EU     | TRUE   | 2026-05-27
```

### 8. Lead ekle

`Leads` tab'ina git -> her satira en az sunlari yaz:

```
lead_id   | list_id | profile_url                          | status   | (gerisini bos birak)
L01-0001  | L01     | https://linkedin.com/in/somebody     | queued
```

`status = queued` olan her lead, bir sonraki run'da otomatik islenmeye baslar.

### 9. Calismayi izle

- Sheet'i ac, `Leads` tab'inda statuslerin degisimini gor
- `ActionLog`'ta her aksiyonun kaydi
- `Conversations`'ta gelen DM'ler
- GitHub Actions sayfasinda her run'in log'u

## Kullanim akisi

**Gunluk (10 dk):**
- `Conversations` tab'ina bak, yeni cevap var mi
- Cevaplari elle LinkedIn'de yaz (sistem otomatik durdurur)
- `status=error` lead'ler varsa kontrol et

**Haftada 1-2 kez (30 dk):**
- Yeni profilleri `Leads` tab'ina yapistir (`status=queued`)
- `Dashboard`'a bak, hangi liste calisiyor

## Test modu

```bash
# Lokalden dry-run (gercek aksiyon atilmaz, sadece Sheets'e log)
npm run dry-run
```

GitHub Actions'tan da `workflow_dispatch -> mode = dry-run` ile manuel calistirilabilir.

## Tuning

Tum parametreler `src/config.js` icinde. En cok dokunulan:

- `SEQUENCE` — faz adimlari, gunler, jitter
- `LIMITS` — gunluk volume
- `WORKING_HOURS` — aktif saatler, weekend olasiligi
- `CRITERIA` — timeout, drop kurallari

## ConnectSafely endpoint'leri

`src/connectsafely.js` icindeki endpoint path'leri **dokumantasyondan kopyalanmis varsayim**. Ilk gercek test'te ConnectSafely Live Playground'da her endpoint dogrulanip path'ler/body sema'lari guncellenmeli. TODO comment'leriyle isaretli.

## Gecmis run'larin temizligi

`status=dropped` veya `status=replied` lead'ler isleme alinmaz, ama Sheet'te birikir. Aylik bir kez baska bir tab'a tasinabilir veya silinebilir.
