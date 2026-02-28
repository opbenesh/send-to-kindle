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

# 3. Update Frontend
echo "Updating Frontend..."
cd frontend
npm install
npm run build
# Serve frontend if needed, otherwise rely on your existing web server
# If you need PM2 to serve the frontend:
# pm2 serve dist 5173 --name send-to-kindle-frontend --spa || pm2 reload send-to-kindle-frontend
cd ..

echo "Deployment Complete!"
