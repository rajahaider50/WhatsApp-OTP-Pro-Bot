# OTP Bot Server - Complete Guide

English + Roman Urdu. Section 0 is for a bot-hosting panel + GitHub. The other sections use Termux (Android) commands unless they say "VPS".

---

## 0. Host it on a bot-hosting panel (botkeep.cloud) with GitHub - runs without your phone

What I could see from your screenshots: the panel has **Overview / Console / Files / GitHub**, buttons **Stop / Restart / Redeploy / Kill**, Node.js 22, 2 GB RAM.
I could not find botkeep.cloud's own documentation, so the exact place of some settings (startup command, variables, ports) may differ.
Look in the panel's menu / Resources / Settings, or ask its support. The variable names below are the usual ones.

In this mode there is no pm2, no cloudflared and no `install.sh` - the panel runs `npm start` and restarts the app by itself.
(`install.sh` and `manage.sh` are only for Termux / VPS.)

### Step 1 - GitHub repository
1. Create a **private** repository, for example `whatsapp-otp-pro-bot`.
2. Upload the project files **with the same folders**:

        server.js
        package.json
        .gitignore
        README.md
        GUIDE.md
        install.sh   (optional, not used on the panel)
        manage.sh    (optional, not used on the panel)
        public/index.html
        public/admin.html

   **Never upload:** `config.json`, `auth/`, `node_modules/`, `otps.json`, `ADMIN-CODE.txt`, `PAIRING-CODE.txt` (the `.gitignore` already blocks them).
3. Phone tip: on GitHub choose **Add file -> Create new file**, type the name `public/admin.html` (the slash creates the folder), paste the content, **Commit**.
   To replace a file open it, press the pencil icon, paste the new content, **Commit**.
   Or edit/upload files directly in the panel's **Files** tab.

### Step 2 - connect the repo to the panel
Panel -> **GitHub** tab -> choose your repository and branch -> press **Redeploy**.
After you change a file on GitHub, press **Redeploy** again.

### Step 3 - startup command
Set it to `npm start` (or `node server.js`). Node 22 is fine (Node 20+ is required).

### Step 4 - variables (if the panel has an Environment / Variables section)
| Variable | Meaning |
|---|---|
| `PORT` or `SERVER_PORT` | the port the panel gives your app (read automatically; default 3000) |
| `PUBLIC_URL` | the public https link of your app (shown in Admin -> Links) |
| `BOT_NUMBER` | bot number, e.g. `03495031007` |
| `ADMIN_PASSWORD` | optional, 8+ characters: lets you log in to Admin even if the console is not working |
| `TRUST_PROXY` | set `1` when the panel puts a reverse proxy in front (so every visitor gets their own IP for the rate limits) |
| `DATA_DIR` | folder of a persistent volume, if the panel offers one (keeps the WhatsApp link across redeploys) |
| `CODE_FILES` | `0` to stop saving codes to files (default: on) |

### Step 5 - make the pages reachable from the internet
The signup page and the admin panel need an HTTP port that is reachable from outside.
If the panel has a **Network / Ports / Domains** section, expose the port your app listens on and use the address it gives you
(set that address as `PUBLIC_URL`). If the panel can only run a bot without web access, the pages cannot be opened from outside;
WhatsApp linking through the Console still works.

### Step 6 - what the Console should print
    OTP Bot Server v1.3.0
    12:00:01 Listening on 0.0.0.0:PORT | Node v22... | mode: hosting panel / standalone
    12:00:01 Data folder: ...
    12:00:01 Public link: https://...
    12:00:01 Admin login: open /admin.html and press "Request code". The code is printed in THIS console and saved in ADMIN-CODE.txt.
    12:00:04 PAIRING CODE: ABCD1234         <- type this in WhatsApp (see below)
    12:00:30 Connected as 92349...
    12:00:50 Ready
    12:10:01 Heartbeat: status=open ready=true ...   <- every 10 minutes

When you press **Request code** on the Admin page, a box with the 6-digit admin code appears in the same Console.
Colors are off by default so the panel console stays readable.

### Step 7 - link WhatsApp (first time)
1. Open WhatsApp **first** on the phone that has the bot number: Linked devices -> Link a device -> **Link with phone number instead**.
2. In the panel press **Restart**, wait for `PAIRING CODE: ...` in the Console and type it in WhatsApp quickly (codes expire fast).
3. After **Ready** the Admin panel shows **Online**.
If linking fails 5 times the app **pauses** (to protect the number from WhatsApp limits). Use Admin -> **New pairing code** or press **Restart**.

### If the Console says "Console connection unavailable. Reconnecting..."
That message comes from the panel's own console connection, not from this app (the app can be running fine - the Overview tab says Running).
Try: wait 1-2 minutes after Restart, reload the page, switch Wi-Fi/mobile data, turn VPN/data saver off, try the browser's desktop mode.
If it stays broken, tell the panel support. Meanwhile you do not need the console:
- open the panel **Files** tab: `ADMIN-CODE.txt` and `PAIRING-CODE.txt` appear there when a code is created (they are deleted after use), or
- set `ADMIN_PASSWORD` and log in to Admin with it.

### Keep the WhatsApp link across Redeploys
After a **Redeploy** the Admin should still say **Online** without a new pairing code.
If it asks to link again, the panel wipes files on redeploy: set `DATA_DIR` to a persistent volume path, or use **Restart** (not Redeploy) for small changes, and keep a copy of `auth/`.

### Honest warnings
- Hosting-panel servers use datacenter IPs. WhatsApp can be stricter with linking/sending from datacenter IPs than from a phone. If linking keeps failing or the number gets restricted, run the bot from Termux at home instead. I cannot promise either way.
- `npm install` needs `git` inside the container for one of the WhatsApp libraries. If the panel's build log shows a git error, send it to me.
- Free plans may have limits or sleep rules - check the panel's terms.

---

## 1. What you get

| Page | URL | Who uses it |
|---|---|---|
| Signup + OTP verify | `/` | your users |
| Admin panel | `/admin.html` | you (login code appears in the terminal) |
| Health check | `/health` | monitoring (`{"ok":true,...}`) |

The bot number is **+923495031007** (change it any time from the admin panel).

---

## 2. Install (one command)

First time only, give Termux storage permission and tap **Allow**:

    termux-setup-storage

Download `WhatsApp-OTP-Bot.zip` to your phone, then run this single line:

    pkg update -y && pkg install -y unzip && cd ~ && unzip -o ~/storage/downloads/WhatsApp-OTP-Bot.zip && cd WhatsApp-OTP-Bot && bash install.sh

The installer shows every step with **PASS / WARN / FAIL**, and a report with the totals at the end.
If something fails you see the reason on screen and the full log in `install.log`.
Fix the problem and run `bash install.sh` again - it is safe to repeat.

When it finishes you get three links: **Local**, **Public**, **Admin**.

---

## 3. Start / stop / status

| Command | What it does |
|---|---|
| `bash manage.sh status` | processes + health |
| `bash manage.sh logs` | live server log |
| `bash manage.sh code` | watch the log to read the admin code |
| `bash manage.sh restart` | restart the server |
| `bash manage.sh stop` / `start` | stop / start server and tunnel |
| `bash manage.sh url` | show Local / Public / Admin links |
| `bash manage.sh tunnel` | create a NEW quick public link |
| `bash manage.sh reset-wa` | remove the WhatsApp link (link again from admin) |
| `bash manage.sh update <zip>` | update from a new zip (keeps config + WhatsApp link) |

The server runs under **pm2**, so it keeps running after you close the Termux window.

---

## 4. Admin panel: how to get in

1. Open `https://YOUR-LINK/admin.html` (or `http://localhost:3000/admin.html` on the phone).
2. Press **Request code**.
3. In Termux run `bash manage.sh code`. A box like this appears:

        +----------------------------------------------------+
        | ADMIN VERIFICATION CODE                            |
        |    482913                                          |
        | Valid for 5 minutes                                |
        +----------------------------------------------------+

4. Type the 6 digits in the admin page and press **Log in**. The session lasts 2 hours.

*Code sirf server console mein aata hai (hosting panel ka Console tab / Termux), is liye koi bahar wala admin mein nahi ja sakta.*
On a hosting panel the same code is also saved in `ADMIN-CODE.txt` (Files tab) and you can set `ADMIN_PASSWORD` as a backup login.
After 5 wrong attempts from one IP the admin login is blocked for 10 minutes.

---

## 5. Link WhatsApp (pairing code / QR)

1. Admin panel -> **Link the bot** -> **New pairing code + QR**.
2. A pairing code (8 characters) appears in the admin page and in the terminal.
3. On the phone that has the bot number's WhatsApp: **Linked devices -> Link a device -> Link with phone number instead** -> type the code.
4. **Keep Termux visible (Android split-screen)** while linking. If Termux goes to the background Android can cut the network and linking fails with 401 / 428.
5. The status turns **Online**. After a new link the bot waits ~20 seconds before it sends the first OTP.

QR option: press **QR only** and scan from another phone (Linked devices -> Link a device).

### Change the main (bot) number
Admin -> **Change the main (bot) number** -> type the new number -> **Change + pairing code**.
The old link is removed and a new pairing code is created for the new number.

### Good habits for a new link
- Do not send many messages in the first hours.
- Ask the first test recipient to message the bot number first, and save the number.
- Do not request OTP again within 60 seconds for the same number.

---

## 6. Test the signup flow

1. Open the Public (or Local) link.
2. Enter a WhatsApp number like `03XXXXXXXXX` and press **Send OTP**.
3. The page says "Code sent" and then "Code delivered" when WhatsApp confirms delivery.
   If the recipient phone is offline you see "delivery is not confirmed yet" - the code stays valid.
4. Type the 6-digit code -> **Verify** -> "Account created successfully".

Use **Settings -> Only send OTP to the numbers below (test mode)** while testing, so nobody else can trigger messages.

---

## 7. Admin panel tour

| Card | What it shows / does |
|---|---|
| Top card | status, server uptime, connection uptime, **reconnects in 24h**, counters (requests / delivered / unconfirmed / failed) |
| Link the bot | pairing code, QR, Unlink, Reconnect |
| Change the main number | switch the bot to another number |
| Links | Local / Public / Admin link, **reachable / NOT reachable** badge, Check now, Restart tunnel |
| Settings | signup on/off, test mode + allowed numbers, OTP lifetime, cooldown, per-hour limits, WhatsApp message text, tunnel auto-restart |
| Recent messages | last 10 messages with delivery status |
| Error console | every error with **time, where, file:line, message and a suggested fix** |
| Live log | the server log in your browser |

---

## 8. How to check errors

1. **Admin -> Error console**: each entry shows `[where]`, `File: server.js:123` (or a node_modules file), the message, and **Fix:** advice.
   Errors from the signup/admin pages in the browser are reported here too (`browser:signup`, `browser:admin`).
2. **Admin -> Live log**: normal events (connected, message accepted, delivered, reconnect).
3. **Terminal**: `bash manage.sh logs` (or `pm2 logs otp-bot-server`).
4. **Installer problems**: `tail -n 40 install.log`.
5. **Quick health**: `bash manage.sh status` or open `/health`.

### Common messages

| You see | Meaning | What to do |
|---|---|---|
| `connectionLost (408)` | WhatsApp socket dropped (phone network / Android power saving). Normal. | Nothing - it reconnects in seconds. Counted in "reconnects (24h)". |
| `connectionClosed (428)` | Socket closed. Same as above. | Nothing, unless it repeats every few seconds. |
| `restartRequired (515)` | Expected right after linking. | Nothing. |
| `loggedOut (401)` | WhatsApp removed the linked device, or linking failed. | Admin -> New pairing code. During linking keep Termux in split-screen. |
| `connectionReplaced (440)` | The same session runs somewhere else. | `pm2 stop all`, then start once. |
| `ECONNABORTED / ECONNRESET` | Android/network killed the connection. | Keep Termux visible, VPN off, see section 10. |
| `No WhatsApp account found` | The typed number is not on WhatsApp. | Check the number. |
| `SERVER_ACK` but never `DELIVERED` | Recipient phone offline (or bot restricted). | Wait; if it happens for many numbers the bot number may be restricted. |
| `Another instance is running` | A second copy started. | `pm2 stop all ; pkill -f server.js ; rm -f .lock` then `bash manage.sh start`. |

---

## 9. Disconnects: what is normal

Your log can show `connectionLost (408)` every 15-30 minutes and still be healthy: the bot reconnects in ~4 seconds and
OTP requests simply wait for it (up to 15 s). That is a normal WhatsApp-Web behaviour on phone networks.

It is **not** normal if:
- it drops every few seconds (the admin shows an error "Connection keeps dropping"), or
- the status stays **Reconnecting** for minutes.

Then follow section 10. For zero drops use a VPS (section 11).

---

## 10. Keep it running on a phone (24/7 checklist)

- Install Termux from **F-Droid** (not the old Play Store build).
- Keep the Termux notification (it says wake lock is held). Do **not** press *Exit* in that notification.
- Settings -> Apps -> Termux -> Battery -> **Unrestricted**.
- Settings -> Apps -> Termux -> turn **OFF** "Pause app activity if unused" (Android 12+).
- Lock Termux in the Recent apps list (long-press its card -> Lock).
- Wi-Fi settings -> Advanced -> keep Wi-Fi on during sleep (Always). Turn Data Saver off. Turn VPN off.
- Install **Termux:Boot** (F-Droid) and open it once - the installer already created the boot script.
- Keep the phone charging and on a stable connection.
- Advanced (Android 12+ only, needs adb): the "phantom process killer" can kill background processes. If pm2 dies by itself, search for "disable phantom process killer Termux".

Be honest with yourself: a phone is a hobby host. Android can still pause apps on some brands. For real 24/7 use a VPS.

---

## 11. Public link for people in other countries

### Why your friend saw `ERR_NAME_NOT_RESOLVED`
The installer's link (`https://something.trycloudflare.com`) is a **quick tunnel**:
- Cloudflare gives **no uptime guarantee** for quick tunnels.
- The address **changes** every time the tunnel restarts (old links stop working).
- Some ISPs / countries / DNS servers **block or fail to resolve** `*.trycloudflare.com`.
- A brand-new link can take a minute before every DNS server knows it.

### Step 1 - find out who is the problem
1. Open the same link on your own phone using **mobile data** (not Wi-Fi). Also check **Admin -> Links**: the badge must say **reachable**.
2. **Does not open for you either** -> the tunnel is dead or changed. Run `bash manage.sh url` (shows the current link) or `bash manage.sh tunnel` (creates a new one) and send the new link.
3. **Opens for you but not for your friend** -> his DNS/ISP is the problem. He can set Android **Private DNS** to `one.one.one.one`, or use a VPN, or try mobile data. This proves the link is fine.

The server also checks its own public link every minute. If the phone has internet but the link stays dead for 5 minutes, it restarts the tunnel by itself (switch off in Settings).
A restarted quick tunnel gets a **new** link - look in Admin -> Links.

### Step 2 - a permanent link (recommended)
**Option A: Cloudflare named tunnel (fixed hostname, works from the phone)**
Needs a domain that is on Cloudflare (the free Cloudflare plan is enough; the domain itself usually costs money).

1. Cloudflare dashboard -> **Zero Trust** -> **Networks -> Tunnels** -> **Create a tunnel** -> *Cloudflared* -> give it a name.
2. Copy the **token** (the long text after `--token` in the install command shown there).
3. On the tunnel's **Public Hostname** tab add: subdomain `otp`, your domain, service **HTTP**, URL `localhost:3000`.
4. On the phone:

        bash manage.sh fixed-link PASTE_TOKEN_HERE otp.yourdomain.com

5. Open `https://otp.yourdomain.com` and `/admin.html`. This link never changes.
   (Dashboard labels change over time; look for "Tunnels" and "Public hostname".)
   Go back to a quick link any time with `bash manage.sh quick-link`.
   The token is stored in pm2's local files on your phone - do not share your phone's files.

**Option B: VPS + domain (most reliable, no phone needed)**
1. Get an Ubuntu 22.04/24.04 server with a public IP (a cheap VPS, or a free-tier cloud VM).
2. Point a domain/subdomain **A record** to the server IP (a free DuckDNS subdomain also works).
3. Open ports **80 and 443** in the provider's firewall.
4. Copy the zip to the server and run:

        sudo apt-get update && sudo apt-get install -y unzip
        unzip WhatsApp-OTP-Bot.zip && cd WhatsApp-OTP-Bot
        bash install.sh --domain otp.yourdomain.com

   The installer installs Node, pm2 and Caddy, and Caddy gets a free HTTPS certificate automatically.
   (The VPS path could not be tested from here - the installer reports every step as PASS/FAIL so you will see exactly what needs fixing.)
5. On the server, auto-start after reboot: `pm2 startup` and run the command it prints, then `pm2 save`.

---

## 12. Update, backup, reset

- **Update**: put the new zip in Downloads, then `bash manage.sh update ~/storage/downloads/WhatsApp-OTP-Bot.zip`.
  Your `config.json` (settings, bot number) and `auth/` (WhatsApp link) are kept.
- **Backup**: copy `config.json` and the `auth/` folder.
- **Settings file**: `config.json`. You can also change everything from the admin panel.
- **Remove the WhatsApp link**: `bash manage.sh reset-wa`.
- **Uninstall**: `pm2 delete all && pm2 save && cd ~ && rm -rf WhatsApp-OTP-Bot`.

---

## 13. Safety notes

- Never share the admin code or your tunnel token.
- Keep the **test mode** (allowed numbers) on while testing; turn it off only when you are ready for real users.
- Built-in limits: 1 code per number per 60 s, 5 wrong attempts per code, 10 requests per IP per hour, 30 OTPs per hour overall (all editable in Settings).
- This uses an unofficial WhatsApp library. WhatsApp can restrict or ban the bot number. For production OTP traffic use the official **WhatsApp Cloud API**.

---

## 14. Quick troubleshooting

| Problem | Try this |
|---|---|
| Admin page says "Request a code first" | Press **Request code** again, then read the code with `bash manage.sh code` |
| Public link does not open | Section 11 -> Step 1 |
| Status stays "Waiting for link" | Admin -> New pairing code; keep Termux in split-screen |
| OTP not delivered | Recipient offline? Check Admin -> Recent messages and Live log |
| Everything is stuck | `bash manage.sh restart`; then `bash manage.sh status` |
| Port busy | `pm2 stop all` then `bash manage.sh start` |
| Installer FAIL | read the reason on screen, `tail -n 40 install.log`, fix, run `bash install.sh` again |
