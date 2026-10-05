# WhatsApp OTP Pro Bot Gateway (v2.0.0)

A powerful, multi-account WhatsApp OTP gateway and management server with an advanced Admin Panel, API key system for multiple web/app integrations, customizable OTP messages, rate limiting, and connection history.

## 🚀 Features

- **Multi-WhatsApp Accounts:** Connect and run multiple WhatsApp numbers simultaneously with automatic load balancing.
- **Per-Bot Daily Limits & Progress Bar:** Configure individual message limits per bot with visual progress bar, quota percentage, and high-usage warning alerts (>=85%).
- **API Key System with Bot Assignment:** Generate dedicated API keys for different apps/services with customizable quotas and assign each key to a specific bot or auto load balance.
- **Professional Enterprise Admin Panel:** Modern UI powered by Font Awesome 6 icons and SVGs, responsive Android mobile bottom navigation, and desktop sidebar.
- **Dual Pairing Code & QR Scan Modes:** Link phone numbers via 8-digit code or scan QR code instantly with WhatsApp camera to bypass pairing rate-limits.
- **Copy-to-Clipboard WhatsApp OTP:** Clean and professional OTP message formatting with copy prompt.
- **Easy Integration:** Ready-made code snippets for JavaScript / Node.js, Python, and PHP.
- **Flexible Deployment:** Works on hosting panels (like botkeep.cloud), VPS servers, Docker, or Termux.

## 📁 Project Structure

```
├── server.js          # Core Express & Baileys Multi-Bot server
├── package.json       # Project dependencies & scripts
├── manage.sh          # Management CLI helper
├── install.sh         # Termux / VPS one-click installer
├── GUIDE.md           # Complete documentation & deployment guide
├── .gitignore         # Prevents secrets & session leaks
└── public/
    ├── index.html     # User verification page
    └── admin.html     # Comprehensive Admin Dashboard
```

## 🛠 Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the server:
   ```bash
   npm start
   ```
3. Open `http://localhost:3000/admin.html` to configure and link your WhatsApp bots!

See [GUIDE.md](GUIDE.md) for full instructions on botkeep.cloud, Termux, VPS deployment, and API documentation.
