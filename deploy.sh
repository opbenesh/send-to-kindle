#!/bin/bash
# Exit on any error
set -e

echo "Starting Deployment..."

# 1. Pull the latest code
echo "Pulling latest code..."
git pull origin master

# 2. Update Backend
echo "Updating Backend..."
cd backend
npm install --omit=dev
# Restart or Reload with PM2
if pm2 show send-to-kindle-backend > /dev/null; then
  echo "Reloading Backend..."
  pm2 reload send-to-kindle-backend
else
  echo "Starting Backend..."
  pm2 start index.js --name send-to-kindle-backend
fi
cd ..

# 3. Build Frontend and publish artifacts outside the git repo
# This prevents .git directory exposure if the web root is ever served statically.
FRONTEND_WEB_ROOT="/var/www/send-to-kindle"
echo "Updating Frontend..."
cd frontend
npm install
npm run build
# Copy only the built artifacts — never serve directly from the git working tree
sudo mkdir -p "$FRONTEND_WEB_ROOT"
sudo rsync -a --delete dist/ "$FRONTEND_WEB_ROOT/"
cd ..
echo "Frontend artifacts deployed to $FRONTEND_WEB_ROOT"

echo "Deployment Complete!"
