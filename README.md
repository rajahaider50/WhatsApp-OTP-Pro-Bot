# WhatsApp OTP Pro Bot Gateway (v2.0.0)

A powerful, multi-account WhatsApp OTP gateway and management server with an advanced Admin Panel, API key system for multiple web/app integrations, customizable OTP messages, rate limiting, and connection history.

## 🚀 Features

- **Multi-WhatsApp Accounts:** Connect and run multiple WhatsApp numbers simultaneously with automatic load balancing.
- **API Key System:** Generate dedicated API keys for different apps/websites with customizable daily quotas.
- **Professional Admin Panel:** Real-time Dashboard, WhatsApp Bot Management, API Key generation, OTP settings, and Live Logs.
- **Copy-to-Clipboard WhatsApp OTP:** Clean and professional OTP message formatting with copy prompt.
- **Easy Integration:** Ready-made code snippets for JavaScript / Node.js, Python, and PHP.
- **Flexible Deployment:** Works on hosting panels (like botkeep.cloud), VPS servers, or Termux.

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
    ├── admin.html     # Comprehensive Admin Dashboard
    └── app.html       # Demo/test application
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
