# WhatsApp-OTP-Bot (OTP Bot Server)

WhatsApp OTP gateway: signup page + 6-digit OTP + admin panel + error console.

    bash install.sh                       # Termux / Ubuntu: install, start, public link
    bash install.sh --domain otp.me.com   # Ubuntu VPS: install + HTTPS (Caddy)

Pages:  `/` signup and OTP verify  |  `/admin.html` admin panel (login code is printed in the terminal)
Helper: `bash manage.sh status | logs | code | restart | url | tunnel | fixed-link | update`

Read GUIDE.md for the full guide.

Note: this uses an unofficial WhatsApp library (Baileys). WhatsApp can restrict the bot number.
For real production OTP traffic use the official WhatsApp Cloud API.
