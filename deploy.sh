#!/bin/bash
# Exit on any error
set -e

echo "Starting Deployment..."

# Pull the latest code
echo "Pulling latest code..."
git pull origin master

# Update Backend
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

echo "Deployment Complete!"
