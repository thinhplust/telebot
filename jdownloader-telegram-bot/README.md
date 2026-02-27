# 🤖 JDownloader Telegram Bot

Control your [JDownloader](https://jdownloader.org/) remotely via Telegram using the [MyJDownloader API](https://my.jdownloader.org/developers/).

## ✨ Features

- 📥 Add download links directly from Telegram
- 📊 Monitor download progress with visual progress bars
- ▶️ Start / Stop / Pause / Resume downloads
- 🔗 Manage the Link Grabber
- 📱 List and manage multiple JDownloader devices
- 🔒 Restrict access to specific Telegram users
- 🔗 Auto-detect URLs sent to the bot

## 📋 Prerequisites

1. **JDownloader 2** installed and running on your computer/server
2. **MyJDownloader account** — Register at [my.jdownloader.org](https://my.jdownloader.org)
3. JDownloader connected to your MyJDownloader account:
   - Open JDownloader → Settings → MyJDownloader → Enter your credentials
4. **Telegram Bot Token** — Create a bot via [@BotFather](https://t.me/BotFather)
5. **Node.js** v16 or higher

## 🚀 Installation

### 1. Clone / Download the project

```bash
git clone <repo-url>
cd jdownloader-telegram-bot
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Telegram Bot Token (from @BotFather)
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ

# MyJDownloader credentials
JD_EMAIL=your@email.com
JD_PASSWORD=yourpassword

# Optional: Restrict to specific Telegram user IDs (comma-separated)
# Get your ID from @userinfobot
ALLOWED_USERS=123456789
```

### 4. Start the bot

```bash
npm start
```

## 🎮 Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Show welcome message and command list |
| `/help` | Show help |
| **📥 Downloads** | |
| `/add <url>` | Add one or more download links |
| `/downloads` | Show current download list with progress |
| `/start_dl` | Start all downloads |
| `/stop_dl` | Stop all downloads |
| `/pause_dl` | Pause downloads |
| `/resume_dl` | Resume paused downloads |
| `/speed` | Show current download speed |
| `/state` | Show download controller state |
| `/cleanup` | Remove finished downloads |
| **🔗 Link Grabber** | |
| `/grabber` | Show link grabber list |
| `/grab_start` | Move grabber links to download list |
| `/grab_clear` | Clear the link grabber |
| **📱 Devices** | |
| `/devices` | List all connected JDownloader devices |
| **📊 Status** | |
| `/status` | Full status overview (state, speed, downloads, grabber) |

### Auto URL Detection

Simply send any URL to the bot and it will automatically add it to JDownloader — no need to type `/add`!

## 🔒 Security

It is **strongly recommended** to set `ALLOWED_USERS` in your `.env` file to restrict bot access to your Telegram account only.

To find your Telegram user ID:
1. Message [@userinfobot](https://t.me/userinfobot) on Telegram
2. It will reply with your user ID
3. Add it to `ALLOWED_USERS` in `.env`

## 🐳 Docker (Optional)

Create a `Dockerfile`:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
CMD ["node", "index.js"]
```

Run with Docker:

```bash
docker build -t jd-telegram-bot .
docker run -d --env-file .env --name jd-bot jd-telegram-bot
```

## 🔧 How It Works

This bot uses the **MyJDownloader REST API** which allows remote control of JDownloader instances:

1. **Authentication**: Uses HMAC-SHA256 signed requests with session tokens
2. **Encryption**: Device communication is encrypted with AES-128-CBC
3. **Session Management**: Automatically reconnects if the session expires

The API flow:
```
Telegram → Bot → MyJDownloader API → JDownloader (on your PC/server)
```

## 📁 Project Structure

```
jdownloader-telegram-bot/
├── index.js          # Entry point
├── src/
│   ├── bot.js        # Telegram bot logic & commands
│   └── jdownloader.js # MyJDownloader API client
├── .env.example      # Environment variables template
├── .gitignore
├── package.json
└── README.md
```

## 🐛 Troubleshooting

**"Login failed"**
- Check your MyJDownloader email and password in `.env`
- Make sure your account is verified at [my.jdownloader.org](https://my.jdownloader.org)

**"No online devices found"**
- Make sure JDownloader is running on your computer
- Check that JDownloader is connected to MyJDownloader (Settings → MyJDownloader)
- Try `/devices` to see all devices and their status

**Bot not responding**
- Verify your Telegram bot token is correct
- Check that the bot is not blocked or stopped

## 📄 License

MIT
