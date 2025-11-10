#!/usr/bin/env bash
set -e
sudo apt-get update
sudo apt-get install -y ca-certificates fonts-liberation libatk1.0-0 libatk-bridge2.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libfreetype6 libgcc-s1 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 wget unzip zip xdg-utils curl gnupg lsb-release xvfb pulseaudio pulseaudio-utils ffmpeg libsecret-1-0 gnome-keyring apt-transport-https ntp
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/v\([0-9]\+\).*/\1/')
  if [ "$NODE_MAJOR" -ge 18 ]; then
    NODE_OK=1
  fi
fi
if [ "$NODE_OK" -ne 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
echo "deb [signed-by=/usr/share/keyrings/google-chrome.gpg arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt-get update
sudo apt-get install -y google-chrome-stable || (wget -q -O /tmp/google-chrome-stable_current_amd64.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt-get install -y /tmp/google-chrome-stable_current_amd64.deb || true)
mkdir -p ./chrome-profile
CHROME_BIN=$(which google-chrome-stable || which google-chrome || which chromium-browser || which chromium || true)
echo "CHROME_PATH=${CHROME_BIN}" > .env.local
echo "USER_DATA_DIR=$(pwd)/chrome-profile" >> .env.local
echo "HEADFUL=1" >> .env.local
export DISPLAY=:99
nohup Xvfb :99 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &
pulseaudio --start 2>/tmp/pulse.log || true
eval $(/usr/bin/gnome-keyring-daemon --start --components=secrets 2>/dev/null || true)
sudo timedatectl set-ntp true || true
if [ ! -f package.json ]; then
  cat > package.json <<'JSON'
{
  "name": "puppeteer-screencast-proxy",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "archiver": "^5.3.1",
    "adm-zip": "^0.5.9",
    "express": "^4.18.2",
    "multer": "^2.0.2",
    "puppeteer": "^24.22.2",
    "puppeteer-extra": "^3.3.4",
    "puppeteer-extra-plugin-stealth": "^2.11.1",
    "tar": "^6.1.11",
    "unzipper": "^0.10.11",
    "ws": "^8.13.0"
  }
}
JSON
fi
npm install
echo "Setup finished. Run: npm start"
