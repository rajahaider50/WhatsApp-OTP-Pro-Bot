# WhatsApp OTP Pro - Complete Guide v2.0

## فہرست
1. [Overview](#overview)
2. [botkeep.cloud پر deploy کرنا](#botkeepcloud-پر-deploy)
3. [Admin Panel استعمال کرنا](#admin-panel)
4. [Multiple WhatsApp Bots](#multiple-bots)
5. [API Keys اور Integration](#api-keys)
6. [اپنی App میں OTP لگانا](#app-integration)
7. [Settings](#settings)
8. [Troubleshooting](#troubleshooting)

---

## Overview

**OTP Bot Pro v2.0** ایک مکمل WhatsApp OTP Gateway ہے جس میں:

| Feature | Details |
|---------|---------|
| Multiple Bots | ایک ساتھ 10 WhatsApp accounts |
| API Keys | ہر app کے لیے الگ API key |
| Admin Panel | مکمل control panel |
| Daily Limits | روزانہ کی OTP limit |
| Delivery Tracking | message کا status track |

**Pages:**
| URL | کون استعمال کرے |
|-----|----------------|
| `/` | آپ کے users (OTP ڈالیں) |
| `/admin.html` | آپ (admin panel) |
| `/health` | monitoring |

---

## botkeep.cloud پر Deploy

### Step 1: GitHub Repository بنائیں

**یہ فائلیں upload کریں:**
```
server.js
package.json
.gitignore
public/index.html
public/admin.html
manage.sh
```

**یہ کبھی upload نہ کریں:**
```
config.json, bots.json, apikeys.json, daily.json
auth/ (WhatsApp sessions)
node_modules/
ADMIN-CODE.txt, PAIRING-CODE.txt
```

### Step 2: Panel Settings

- **Runtime:** Node.js 22
- **Startup Command:** `npm start`

### Step 3: Environment Variables (Optional)

| Variable | مطلب |
|----------|-------|
| `BOT_NUMBER` | default bot کا نمبر جیسے `923001234567` |
| `ADMIN_PASSWORD` | 8+ حروف، console کے بغیر login |
| `PUBLIC_URL` | آپ کا public URL جیسے `https://mybot.botkeep.cloud` |
| `TRUST_PROXY` | `1` اگر panel reverse proxy استعمال کرے |
| `DATA_DIR` | persistent storage path |

### Step 4: Console Output (کیا نظر آنا چاہیے)

```
  OTP Bot Pro v2.0
  12:00:01 Listening on 0.0.0.0:PORT
  12:00:04 PAIRING CODE: ABCD1234
  12:00:30 Bot bot0: connected as 9234...
  12:00:50 Bot bot0: Ready
```

### Step 5: WhatsApp Link کریں

1. Admin panel کھولیں: `https://YOUR-URL/admin.html`
2. Login کریں (Request Code → console میں code آئے گا)
3. **Bots tab** میں جائیں
4. **New Pairing Code** دبائیں
5. WhatsApp → Linked Devices → Link with phone number
6. Code ٹائپ کریں
7. Status: 🟢 **Online** ہو جائے گا

---

## Admin Panel

### Login
1. `/admin.html` کھولیں
2. **Request Code** دبائیں
3. Console میں 6-digit code دیکھیں
4. Code ڈالیں → **Log In**

### Tabs

#### 📊 Dashboard
- Overall stats: Requests, Delivered, Failed
- Today's sends vs Daily limit
- Mini bot status cards
- Recent 10 messages

#### 📱 Bots Tab
- ہر bot کی status، uptime، آج کی sends
- Connection history (کتنے وقت سے connected ہے)
- **New Pairing Code** → WhatsApp link
- **Reconnect** → manual restart
- **Unlink** → session ختم کریں
- **Remove** → bot مکمل delete

#### 🔑 API Keys Tab
- **Generate Key** → label اور daily limit ڈالیں
- Key صرف ایک بار دکھتی ہے → Copy کریں!
- Integration guide: endpoints، JS/Python/PHP code snippets

#### ⚙️ Settings Tab
- OTP Lifetime, Cooldown, Hourly/Daily limits
- WhatsApp message template (پروفیشنل)
- Signup page on/off
- Public URL check

#### 📋 Logs Tab
- Error console (با hint)
- Live log (color coded)

---

## Multiple WhatsApp Bots

### نیا Bot ایڈ کریں
1. Bots tab → **+ Add Bot**
2. Label لکھیں (جیسے "Backup Account")
3. Bot بنے گا → New Pairing Code → WhatsApp link کریں

### Bot کیسے کام کرتا ہے
- **Auto load balancing:** OTP بھیجتے وقت سب سے پہلا ready bot استعمال ہوتا ہے
- **Specific bot:** API میں `botId` دیں تو وہی bot استعمال ہوگا

### Bot Remove کریں
Bots tab → **Remove** → سب کچھ مٹ جائے گا

---

## API Keys

### Key Generate کریں
1. API Keys tab → **Generate Key**
2. Label: "My Website", Daily Limit: 1000
3. Key دکھے گی → **ابھی Copy کریں!**

### API استعمال کریں

**Base URL:** آپ کا server کا URL (Settings tab میں دکھتا ہے)

#### OTP بھیجنا
```
POST {BASE_URL}/api/v1/send-otp
Headers:
  x-api-key: YOUR_API_KEY
  Content-Type: application/json
Body:
  {"number": "03001234567"}

Response (success):
  {"ok": true, "number": "923001234567", "state": "sent"}

Response (error):
  {"ok": false, "error": "No WhatsApp account found for this number."}
```

#### OTP Verify کرنا
```
POST {BASE_URL}/api/v1/verify-otp
Headers:
  x-api-key: YOUR_API_KEY
  Content-Type: application/json
Body:
  {"number": "03001234567", "otp": "123456"}

Response (success):
  {"ok": true, "message": "Verified successfully"}

Response (wrong code):
  {"ok": false, "error": "Wrong code."}
```

#### Gateway Status
```
GET {BASE_URL}/api/v1/status
Headers:
  x-api-key: YOUR_API_KEY

Response:
  {"name": "OTP Bot Pro", "ready": true, "bots": [...]}
```

---

## App Integration

### JavaScript (Browser/Node.js)

```javascript
const OTP_BASE = 'https://your-server-url.com';
const OTP_KEY  = 'your-api-key-here';

// Step 1: Send OTP
async function sendOTP(phoneNumber) {
  const res = await fetch(`${OTP_BASE}/api/v1/send-otp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': OTP_KEY
    },
    body: JSON.stringify({ number: phoneNumber })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  return data;
}

// Step 2: Verify OTP
async function verifyOTP(phoneNumber, otp) {
  const res = await fetch(`${OTP_BASE}/api/v1/verify-otp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': OTP_KEY
    },
    body: JSON.stringify({ number: phoneNumber, otp })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  return data;
}

// Usage:
try {
  await sendOTP('03001234567');
  console.log('OTP sent!');
  
  // After user enters OTP:
  const result = await verifyOTP('03001234567', userEnteredOtp);
  console.log('Verified!');
} catch (err) {
  console.error('OTP Error:', err.message);
}
```

### Python

```python
import requests

OTP_BASE = 'https://your-server-url.com'
OTP_KEY  = 'your-api-key-here'
HEADERS  = {'x-api-key': OTP_KEY, 'Content-Type': 'application/json'}

def send_otp(phone: str) -> dict:
    r = requests.post(
        f'{OTP_BASE}/api/v1/send-otp',
        headers=HEADERS,
        json={'number': phone},
        timeout=30
    )
    r.raise_for_status()
    return r.json()

def verify_otp(phone: str, otp: str) -> dict:
    r = requests.post(
        f'{OTP_BASE}/api/v1/verify-otp',
        headers=HEADERS,
        json={'number': phone, 'otp': otp},
        timeout=30
    )
    r.raise_for_status()
    return r.json()

# Django/Flask usage:
# result = send_otp('+923001234567')
# if result['ok']:
#     session['otp_phone'] = phone
```

### PHP

```php
<?php
define('OTP_BASE', 'https://your-server-url.com');
define('OTP_KEY',  'your-api-key-here');

function otp_request(string $endpoint, array $data): array {
    $ch = curl_init(OTP_BASE . $endpoint);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_HTTPHEADER => [
            'Content-Type: application/json',
            'x-api-key: ' . OTP_KEY
        ],
        CURLOPT_POSTFIELDS => json_encode($data)
    ]);
    $response = curl_exec($ch);
    curl_close($ch);
    return json_decode($response, true);
}

function send_otp(string $phone): array {
    return otp_request('/api/v1/send-otp', ['number' => $phone]);
}

function verify_otp(string $phone, string $otp): array {
    return otp_request('/api/v1/verify-otp', ['number' => $phone, 'otp' => $otp]);
}

// Laravel usage:
// $result = send_otp('03001234567');
// if ($result['ok']) { ... }
?>
```

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| OTP Lifetime | 300s (5 min) | کتنے وقت تک code valid ہو |
| Resend Cooldown | 60s | دوبارہ OTP کا انتظار |
| Max / Hour | 30 | ایک گھنٹے میں کل OTPs |
| Daily Limit | 500 | روزانہ کل OTPs |
| Max per IP / Hour | 10 | ایک IP سے گھنٹے میں |
| Warmup | 20s | نئے link کے بعد انتظار |

### WhatsApp Message Template

Variables:
- `{OTP}` - 6-digit code
- `{MINUTES}` - OTP کی validity منٹوں میں

Default (Professional):
```
🔐 *Your Verification Code*

┌─────────────────────┐
│      *{OTP}*        │
└─────────────────────┘

⏱ Valid for *{MINUTES} minutes*
🔒 Keep this code private

_Tap code to copy_
```

---

## Manage Commands (Termux/VPS)

```bash
bash manage.sh status          # server status دیکھیں
bash manage.sh logs [n]        # logs دیکھیں
bash manage.sh code            # admin code دیکھیں
bash manage.sh restart         # restart کریں
bash manage.sh stop/start      # stop/start کریں
bash manage.sh url             # links دیکھیں
bash manage.sh tunnel          # نئی public link بنائیں
bash manage.sh reset-wa        # سب bots کا WhatsApp ہٹائیں
bash manage.sh reset-bot bot0  # ایک bot کا session ہٹائیں
bash manage.sh update file.zip # نئی zip سے update کریں
```

---

## Troubleshooting

| مسئلہ | حل |
|-------|-----|
| Bot offline | Admin > Bots > Reconnect یا New Pairing Code |
| Pairing code expire | Termux split-screen میں link کریں |
| OTP نہیں آئی | Admin > Bots > Recent messages check کریں |
| API 401 error | x-api-key header صحیح ہے؟ Key enabled ہے؟ |
| Daily limit | Settings میں daily limit بڑھائیں |
| Console نہیں آتا | ADMIN_PASSWORD set کریں یا ADMIN-CODE.txt دیکھیں |
| Port busy | `pm2 stop all` پھر `bash manage.sh start` |

### Common Error Codes

| Error | مطلب |
|-------|-------|
| `connectionLost (408)` | Normal - خود reconnect ہو جائے گا |
| `loggedOut (401)` | WhatsApp نے session ختم کیا - نئی pairing code |
| `connectionReplaced (440)` | دو جگہ چل رہا ہے - `pm2 stop all` |
| `No WhatsApp found` | نمبر WhatsApp پر نہیں |

---

## Security Notes

- API keys صرف backend میں استعمال کریں - frontend میں نہیں
- Admin password 8+ حروف کا ہو
- Test mode on رکھیں جب تک testing نہ ہو
- ہر app کے لیے الگ API key بنائیں
- Revoke کریں جو keys استعمال نہیں ہوتیں

---

*WhatsApp OTP Pro v2.0 | Unofficial WhatsApp library - Production میں official WhatsApp Cloud API بہتر ہے*
