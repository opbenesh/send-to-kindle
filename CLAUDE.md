# Send to Kindle — Claude Instructions

## Architecture
- Telegram bot + HTTPS server in `backend/index.js` (single file, CommonJS)
- `backend/cover-generator.js` — Canvas-based EPUB cover image
- `backend/tokens.json` — OAuth tokens + Kindle email per chat ID
- `backend/binds.json` — bind history (up to 20 entries per chat ID)
- Frontend is static; served from `/var/www/send-to-kindle` (built artifacts only)

## Code Style
- CommonJS (`require`/`module.exports`), Node.js
- No TypeScript in runtime code (types are dev-only)
- Async/await throughout; minimal abstraction — prefer inline logic over new helpers

## Commands
- Run backend: `cd backend && node index.js`
- PM2 process name: `send-to-kindle-backend`
- Deploy: `./deploy.sh` (pulls master, npm install, pm2 reload, builds frontend)

## Git
- Conventional commits: `feat:`, `fix:`, `chore:`, `security:`, etc.
- Branch: `master`
- IMPORTANT: Always confirm before pushing

## Sensitive Files
- `backend/.env` — never commit
- `backend/tokens.json` — never commit
- `backend/binds.json` — never commit
