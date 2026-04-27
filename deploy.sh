#!/bin/bash
# ─────────────────────────────────────────────────────────────────
# deploy.sh — pull latest code and restart the bot on the VPS
# Usage:  bash deploy.sh
# ─────────────────────────────────────────────────────────────────

set -e

echo "📦 Pulling latest code..."
git pull origin prod

echo "📥 Installing dependencies..."
npm install --omit=dev

echo "♻️  Restarting bot..."
pm2 restart marketing-bot

echo "✅ Deploy complete. Live status:"
pm2 status marketing-bot
