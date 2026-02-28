const axios = require('axios');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const epubGenMemory = require('epub-gen-memory').default;
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateCoverImage } = require('./cover-generator');

dotenv.config({ path: path.join(__dirname, '.env') });

const TOKEN_PATH = path.join(__dirname, 'tokens.json');
const BINDS_PATH = path.join(__dirname, 'binds.json');
const WHITELIST_PATH = path.join(__dirname, 'whitelist.json');
const sessions = {};
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(sessions)) {
    if (now - sessions[id].createdAt > SESSION_TTL_MS) delete sessions[id];
  }
}, 10 * 60 * 1000).unref();

// --- SMTP Setup ---
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

transporter.verify().then(() => console.log('SMTP connection verified.')).catch(err => console.error('SMTP connection failed:', err.message));

// Helper to load/save tokens (used for kindleEmail storage)
function loadTokens() {
  if (fs.existsSync(TOKEN_PATH)) {
    try { return JSON.parse(fs.readFileSync(TOKEN_PATH)); } catch (e) { return {}; }
  }
  return {};
}

function saveToken(chatId, tokens) {
  const allTokens = loadTokens();
  allTokens[chatId] = { ...(allTokens[chatId] || {}), ...tokens };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(allTokens, null, 2));
}

function loadBindHistory(chatId) {
  if (!fs.existsSync(BINDS_PATH)) return [];
  try {
    const all = JSON.parse(fs.readFileSync(BINDS_PATH));
    return all[String(chatId)] || [];
  } catch (e) { return []; }
}

function saveBindToHistory(chatId, { title, urls }) {
  let all = {};
  if (fs.existsSync(BINDS_PATH)) {
    try { all = JSON.parse(fs.readFileSync(BINDS_PATH)); } catch (e) {}
  }
  if (!all[chatId]) all[chatId] = [];
  all[chatId].unshift({ id: Date.now().toString(), title, urls, sentAt: new Date().toISOString() });
  if (all[chatId].length > 20) all[chatId].length = 20;
  fs.writeFileSync(BINDS_PATH, JSON.stringify(all, null, 2));
}

// --- Whitelist ---
function loadWhitelist() {
  if (!fs.existsSync(WHITELIST_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(WHITELIST_PATH)); } catch (e) { return []; }
}

function saveWhitelist(ids) {
  fs.writeFileSync(WHITELIST_PATH, JSON.stringify([...ids], null, 2));
}

// --- Helpers ---
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function validateUrl(urlString) {
  let parsed;
  try { parsed = new URL(urlString); } catch { throw new Error('Invalid URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS URLs are allowed.');
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host)
  ) throw new Error('URL points to a private or reserved address.');
}

function logInteraction(chatId, type, content) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] Chat: ${chatId} | ${type}: ${content}\n`;
  const logPath = path.join(__dirname, 'interactions.log');
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 5 * 1024 * 1024) {
      fs.renameSync(logPath, logPath + '.old');
    }
  } catch (e) {}
  fs.appendFileSync(logPath, logEntry);
}

async function fetchArticle(url) {
  const response = await axios.get(url, { timeout: 15000, maxContentLength: 10 * 1024 * 1024 });
  // Validate final URL after redirects to prevent SSRF via redirect chains
  const finalUrl = response.request?.res?.responseUrl;
  if (finalUrl && finalUrl !== url) validateUrl(finalUrl);
  const dom = new JSDOM(response.data, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  return article ? { ...article, url } : null;
}

// --- EPUB Helpers ---
function cleanArticleContent(htmlContent, articleUrl) {
  const { window } = new JSDOM(`<div id="root">${htmlContent}</div>`);
  const doc = window.document;
  const container = doc.getElementById('root');

  // Helper: resolve a URL (absolute, protocol-relative, or relative) against the article base
  function resolveUrl(val, base) {
    if (!val || val.startsWith('data:')) return null;
    if (val.startsWith('//')) val = 'https:' + val;
    if (val.startsWith('http')) return val;
    try { return new URL(val, base).href; } catch (e) { return null; }
  }

  // Helper: if URL is a Next.js /_next/image proxy, extract the real image URL
  function unwrapNextImage(url) {
    if (!url || !url.includes('/_next/image')) return url;
    try {
      const u = new URL(url);
      const inner = u.searchParams.get('url');
      return inner ? decodeURIComponent(inner) : url;
    } catch (e) { return url; }
  }

  // Fix lazy-loaded images
  container.querySelectorAll('img').forEach(img => {
    const lazyAttrs = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-url', 'data-hi-res-src', 'data-original-src', 'data-image-src'];
    for (const attr of lazyAttrs) {
      const resolved = resolveUrl(img.getAttribute(attr), articleUrl);
      if (resolved) { img.src = resolved; break; }
    }

    // Fall back to srcset (or data-srcset) if src is missing/broken — handles relative paths too
    if (!img.src || img.src.startsWith('data:')) {
      const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
      if (srcset) {
        const firstSrc = srcset.split(',')[0].trim().split(' ')[0];
        const resolved = resolveUrl(firstSrc, articleUrl);
        if (resolved) img.src = resolved;
      }
    }

    // Resolve relative URLs (including /_next/image paths)
    const src = img.getAttribute('src') || '';
    if (src && !src.startsWith('data:')) {
      const resolved = resolveUrl(src, articleUrl);
      if (resolved) img.src = resolved;
    }

    // Unwrap Next.js image proxy to get direct CDN URL
    const proxied = img.getAttribute('src') || '';
    if (proxied.includes('/_next/image')) {
      const direct = unwrapNextImage(proxied);
      if (direct) img.src = direct;
    }

    // Remove broken placeholder images (empty src, anchors, tiny SVG/GIF spinners)
    const finalSrc = img.getAttribute('src') || '';
    const isBroken = !finalSrc || finalSrc === '#'
      || finalSrc.startsWith('data:image/svg')
      || /data:image\/gif;base64,R0lGOD/.test(finalSrc);
    if (isBroken) {
      const parent = img.parentElement;
      img.remove();
      if (parent && ['FIGURE', 'P', 'DIV'].includes(parent.tagName) && !parent.innerHTML.trim()) {
        parent.remove();
      }
      return;
    }

    img.removeAttribute('width');
    img.removeAttribute('height');
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    if (!img.getAttribute('alt')) img.setAttribute('alt', '');
  });

  // Remove noscript (often contain duplicate img tags), scripts, and stray styles
  container.querySelectorAll('noscript, script, style').forEach(el => el.remove());

  return container.innerHTML;
}

// --- Core Logic ---
async function sendToKindle({ url, urls, kindleEmail, title: manualTitle, author: manualAuthor }) {
  const targetUrls = urls || [url];
  const articles = [];

  const failedUrls = [];
  for (const targetUrl of targetUrls) {
    try {
      validateUrl(targetUrl);
      const article = await fetchArticle(targetUrl);
      if (article) articles.push(article);
      else failedUrls.push(targetUrl);
    } catch (e) {
      failedUrls.push(targetUrl);
    }
  }

  if (articles.length === 0) throw new Error('Could not extract content from any URL.');

  const mainArticle = articles[0];
  const finalTitle = manualTitle || (articles.length > 1 ? 'Combined Articles' : mainArticle.title) || 'Untitled Article';
  const finalAuthor = manualAuthor || mainArticle.byline || mainArticle.siteName || (mainArticle.url ? new URL(mainArticle.url).hostname : 'Unknown');

  const safeTitle = finalTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const coverBuffer = await generateCoverImage(finalTitle, finalAuthor);
  const coverPath = path.join(__dirname, `${safeTitle}_${crypto.randomBytes(4).toString('hex')}_cover.jpg`);
  fs.writeFileSync(coverPath, coverBuffer);

  const customCss = `
    body { font-family: Georgia, "Times New Roman", serif; font-size: 1em; line-height: 1.7; color: #1a1a1a; margin: 0; padding: 0; }
    p { margin: 0 0 1em 0; orphans: 2; widows: 2; }
    h1, h2, h3, h4, h5, h6 { font-family: Georgia, serif; line-height: 1.3; margin: 1.5em 0 0.6em 0; font-weight: bold; }
    h1 { font-size: 1.6em; } h2 { font-size: 1.3em; } h3 { font-size: 1.1em; } h4, h5, h6 { font-size: 1em; }
    a { color: #1a1a1a; text-decoration: underline; }
    blockquote { border-left: 3px solid #999; margin: 1.2em 0; padding: 0.4em 1em; color: #444; font-style: italic; }
    img { max-width: 100%; height: auto; display: block; margin: 1em auto; }
    figure { margin: 1.5em 0; text-align: center; }
    figcaption { font-size: 0.85em; color: #666; font-style: italic; margin-top: 0.4em; }
    pre, code { font-family: "Courier New", Courier, monospace; font-size: 0.85em; }
    pre { background: #f5f5f5; padding: 0.8em 1em; white-space: pre-wrap; word-wrap: break-word; border-left: 3px solid #ccc; margin: 1em 0; }
    code { background: #f0f0f0; padding: 0.1em 0.3em; }
    pre code { background: none; padding: 0; }
    table { border-collapse: collapse; width: 100%; font-size: 0.9em; margin: 1.2em 0; }
    th, td { border: 1px solid #ccc; padding: 0.4em 0.6em; text-align: left; }
    th { background: #f5f5f5; font-weight: bold; }
    ul, ol { margin: 0.8em 0; padding-left: 1.8em; }
    li { margin-bottom: 0.3em; }
    .article-meta { font-family: Arial, Helvetica, sans-serif; font-size: 0.85em; color: #666; border-bottom: 1px solid #ddd; padding-bottom: 12px; margin-bottom: 20px; }
    .article-source { font-weight: bold; color: #444; }
    .article-byline { font-style: italic; margin-top: 3px; }
    .article-excerpt { font-size: 1.05em; color: #333; font-style: italic; line-height: 1.6; margin: 0 0 1.5em 0; padding-bottom: 1em; border-bottom: 1px solid #eee; }
    h1.h1 { text-align: center; text-transform: uppercase; font-size: 1.2em; letter-spacing: 2px; margin-top: 50px; border-bottom: 1px solid #333; padding-bottom: 10px; width: 90%; margin-left: auto; margin-right: auto; }
    nav#toc ol { list-style: none; padding: 0; width: 90%; margin: 20px auto; }
    li.table-of-content { margin-bottom: 12px; display: block; font-family: Arial, sans-serif; font-size: 0.9em; }
    li.table-of-content a { text-decoration: none; color: #1a1a1a; display: block; }
    .toc-author { color: #666; font-size: 0.8em; display: block; margin-top: 2px; }
  `;

  const option = {
    title: finalTitle,
    author: finalAuthor,
    publisher: "Send to Kindle",
    cover: `file://${coverPath}`,
    css: customCss,
    lang: 'en',
    description: articles[0].excerpt || '',
    tocTitle: articles.length > 1 ? "What's Inside" : 'Contents',
    tocInTOC: true,
    numberChaptersInTOC: false,
    prependChapterTitles: articles.length > 1
  };

  const isMulti = articles.length > 1;
  const chapters = articles.map((article, index) => {
    const chapterTitle = isMulti
      ? `${(index + 1).toString().padStart(2, '0')}. ${article.title}`
      : article.title;

    const source = article.siteName || (article.url ? new URL(article.url).hostname : '');
    const datePart = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const metaLine = [source, datePart].filter(Boolean).join(' · ');
    const bylinePart = article.byline ? `<div class="article-byline">By ${article.byline}</div>` : '';
    const excerptPart = article.excerpt ? `<p class="article-excerpt">${article.excerpt}</p>` : '';

    return {
      title: chapterTitle,
      content: `
        <div class="article-meta">
          <span class="article-source">${metaLine}</span>
          ${bylinePart}
        </div>
        ${excerptPart}
        ${cleanArticleContent(article.content, article.url)}
      `,
      author: article.byline || article.siteName || undefined,
      excludeFromToc: false
    };
  });

  const epubBuffer = await epubGenMemory(option, chapters);

  try { fs.unlinkSync(coverPath); } catch (e) {}

  const EPUB_MAX_BYTES = 10 * 1024 * 1024;
  if (epubBuffer.length > EPUB_MAX_BYTES) {
    throw new Error(`EPUB is too large (${(epubBuffer.length / 1024 / 1024).toFixed(1)} MB). Try fewer or shorter articles.`);
  }

  const emailSubject = articles.length === 1 ? `Article: ${mainArticle.title}` : `Bundle: ${finalTitle}`;

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: kindleEmail,
    subject: emailSubject,
    text: 'Here is your article.',
    attachments: [{ filename: `${safeTitle}.epub`, content: Buffer.from(epubBuffer) }],
  });
  return { failedUrls };
}

// --- Telegram Bot ---
const botToken = process.env.TELEGRAM_BOT_TOKEN;

let bot;
if (botToken) {
  try {
    bot = new Telegraf(botToken);

    // Bootstrap whitelist from env if file doesn't exist yet
    if (!fs.existsSync(WHITELIST_PATH)) {
      const seed = (process.env.WHITELISTED_USERS || '').split(',').map(id => id.trim()).filter(id => id);
      if (seed.length === 0) {
        console.error('FATAL: whitelist.json not found and WHITELISTED_USERS is not set. Cannot start without access control.');
        process.exit(1);
      }
      saveWhitelist(seed);
      console.log(`Seeded whitelist.json with ${seed.length} user(s) from WHITELISTED_USERS.`);
    }
    const whitelistedUsers = new Set(loadWhitelist());
    if (whitelistedUsers.size === 0) {
      console.error('FATAL: whitelist.json is empty. Refusing to start bot without access control.');
      process.exit(1);
    }
    const adminId = process.env.ADMIN_USER_ID;
    if (!adminId) {
      console.error('FATAL: ADMIN_USER_ID is not set in .env.');
      process.exit(1);
    }
    const isAdmin = (userId) => userId?.toString() === adminId;

    const unauthorizedAttempts = {};
    // Clean up silenced entries daily to prevent unbounded growth
    setInterval(() => {
      for (const key of Object.keys(unauthorizedAttempts)) {
        if (unauthorizedAttempts[key] > 3) delete unauthorizedAttempts[key];
      }
    }, 24 * 60 * 60 * 1000).unref();

    bot.use((ctx, next) => {
      const chatId = ctx.chat?.id.toString();
      const userId = ctx.from?.id.toString();

      if (!whitelistedUsers.has(chatId) && !whitelistedUsers.has(userId)) {
        const key = userId || chatId;
        unauthorizedAttempts[key] = (unauthorizedAttempts[key] || 0) + 1;
        const cmd = ctx.message?.text?.split(' ')[0] || ctx.updateType;
        console.warn(`Unauthorized: userId=${userId} chatId=${chatId} type=${ctx.updateType} cmd=${cmd} attempts=${unauthorizedAttempts[key]}`);
        if (unauthorizedAttempts[key] > 3) return; // silently drop after 3 attempts
        if (ctx.updateType === 'message') return ctx.reply("⛔ Sorry, you're not authorized to use this bot.");
        if (ctx.updateType === 'callback_query') return ctx.answerCbQuery('⛔ Not authorized.');
        return;
      }
      return next();
    });

    // Register commands for the "Menu" button
    bot.telegram.setMyCommands([
      { command: 'start', description: 'Show welcome message' },
      { command: 'bind', description: 'Start a multi-article collection' },
      { command: 'done', description: 'Finish and send current collection' },
      { command: 'cancel', description: 'Cancel active session' },
      { command: 'history', description: 'View and resend past collections' },
      { command: 'status', description: 'Check your settings' },
      { command: 'setemail', description: 'Set Kindle email' },
      { command: 'unsetemail', description: 'Clear Kindle email' },
      { command: 'help', description: 'Show help' }
    ]);

    bot.start((ctx) => {
      logInteraction(ctx.chat.id, 'COMMAND', '/start');
      ctx.reply("📚 *Welcome to Send to Kindle!*\n\nI can help you turn web articles into beautiful ebooks for your Kindle.\n\n*Quick Setup:*", {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📧 Set Kindle Email', callback_data: 'setup_email' }],
            [{ text: '📋 Check Status', callback_data: 'check_status' }],
            [{ text: '📚 Bind History', callback_data: 'show_history' }],
            [{ text: '📖 How to use?', callback_data: 'show_help' }]
          ]
        }
      });
    });

    bot.command('whitelist', (ctx) => {
      logInteraction(ctx.chat.id, 'COMMAND', ctx.message.text);
      if (!isAdmin(ctx.from?.id)) return ctx.reply('⛔ Admin only.');
      const parts = ctx.message.text.trim().split(/\s+/);
      const sub = parts[1];
      const targetId = parts[2];

      if (sub === 'list') {
        const ids = [...whitelistedUsers];
        return ctx.reply(ids.length ? `*Whitelisted IDs (${ids.length}):*\n\`${ids.join('\n')}\`` : 'Whitelist is empty.', { parse_mode: 'Markdown' });
      }
      if ((sub === 'add' || sub === 'remove') && !targetId) {
        return ctx.reply(`Usage: /whitelist ${sub} <user_id>`);
      }
      if (sub === 'add') {
        if (whitelistedUsers.has(targetId)) return ctx.reply(`${targetId} is already whitelisted.`);
        whitelistedUsers.add(targetId);
        saveWhitelist(whitelistedUsers);
        return ctx.reply(`✅ Added \`${targetId}\` to whitelist.`, { parse_mode: 'Markdown' });
      }
      if (sub === 'remove') {
        if (targetId === adminId) return ctx.reply('⛔ Cannot remove the admin.');
        if (!whitelistedUsers.has(targetId)) return ctx.reply(`${targetId} is not in the whitelist.`);
        whitelistedUsers.delete(targetId);
        saveWhitelist(whitelistedUsers);
        return ctx.reply(`✅ Removed \`${targetId}\` from whitelist.`, { parse_mode: 'Markdown' });
      }
      return ctx.reply('Usage:\n`/whitelist list`\n`/whitelist add <id>`\n`/whitelist remove <id>`', { parse_mode: 'Markdown' });
    });

    bot.action('setup_email', (ctx) => {
      sessions[ctx.chat.id] = { state: 'AWAITING_EMAIL', createdAt: Date.now() };
      ctx.reply('Please type your Kindle email address (e.g. yourname@kindle.com):');
    });
    function statusText(chatId) {
      const userData = loadTokens()[chatId];
      if (userData?.kindleEmail) return `*Status:*\n✅ Kindle Email: \`${userData.kindleEmail}\``;
      return '*Status:*\n❌ No Kindle email set. Use /setemail yourname@kindle.com';
    }

    bot.action('check_status', (ctx) => {
      ctx.reply(statusText(ctx.chat.id), { parse_mode: 'Markdown' });
    });
    const HELP_TEXT = 'Commands:\n/setemail <email> — Set your Kindle email\n/unsetemail — Clear your Kindle email\n/bind — Start a multi-article collection\n/done — Finish and send collection\n/cancel — Cancel active session\n/history — View and resend past collections\n/status — Check your settings\n\nOr just send any link to send it instantly!';

    bot.action('show_help', (ctx) => { ctx.reply(HELP_TEXT); });
    bot.help((ctx) => { ctx.reply(HELP_TEXT); });

    bot.command('status', (ctx) => {
      logInteraction(ctx.chat.id, 'COMMAND', '/status');
      ctx.reply(statusText(ctx.chat.id), { parse_mode: 'Markdown' });
    });

    bot.command('debug_session', (ctx) => {
      if (!isAdmin(ctx.from?.id)) return ctx.reply('⛔ Admin only.');
      ctx.reply(`Current Session: ${JSON.stringify(sessions[ctx.chat.id] || 'None')}`);
    });

    bot.command('unsetemail', (ctx) => {
      logInteraction(ctx.chat.id, 'COMMAND', '/unsetemail');
      const allTokens = loadTokens();
      const chatId = String(ctx.chat.id);
      if (!allTokens[chatId]?.kindleEmail) return ctx.reply('No Kindle email is currently set.');
      delete allTokens[chatId].kindleEmail;
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(allTokens, null, 2));
      ctx.reply('✅ Kindle email cleared.');
    });

    bot.command('setemail', (ctx) => {
      logInteraction(ctx.chat.id, 'COMMAND', `/setemail`);
      const email = ctx.message.text.split(' ')[1];
      if (email && isValidEmail(email)) {
        saveToken(String(ctx.chat.id), { kindleEmail: email });
        ctx.reply(`✅ Kindle email set to: ${email}`);
      } else {
        ctx.reply('Usage: /setemail yourname@kindle.com');
      }
    });

    bot.command('bind', (ctx) => {
      logInteraction(ctx.chat.id, 'COMMAND', '/bind');
      if (sessions[ctx.chat.id]) {
        return ctx.reply('You already have an active session. Finish it or cancel it first.', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Finish & Send', callback_data: 'done_binding' }],
              [{ text: '❌ Cancel', callback_data: 'cancel_binding' }]
            ]
          }
        });
      }
      sessions[ctx.chat.id] = { state: 'AWAITING_TITLE', urls: [], createdAt: Date.now() };
      ctx.reply('📚 Binding mode activated! Please send me the TITLE for this collection.');
    });

    bot.action('done_binding', async (ctx) => {
      logInteraction(ctx.chat.id, 'ACTION', 'done_binding');
      const chatId = ctx.chat.id;
      const session = sessions[chatId];
      if (!session) return ctx.answerCbQuery('No active session.');
      if (session.urls.length === 0) return ctx.answerCbQuery('Add some links first!');

      const userData = loadTokens()[chatId];
      if (!userData?.kindleEmail) return ctx.answerCbQuery('❌ Set your Kindle email first (/setemail).');

      await ctx.answerCbQuery('Processing bundle...');
      await ctx.editMessageText(`🚀 Processing ${session.urls.length} articles for "${session.title}"...`);

      try {
        const { failedUrls } = await sendToKindle({
          urls: session.urls,
          title: session.title,
          kindleEmail: userData.kindleEmail,
        });
        saveBindToHistory(chatId, { title: session.title, urls: session.urls });
        await ctx.reply('✅ Collection sent to your Kindle!' +
          (failedUrls.length ? `\n⚠️ ${failedUrls.length} URL(s) could not be fetched and were skipped.` : ''));
        delete sessions[chatId];
      } catch (err) {
        console.error('done_binding error:', err);
        await ctx.reply('❌ Failed to send collection. Please check the URLs and try again.');
      }
    });

    bot.command('done', async (ctx) => {
      logInteraction(ctx.chat.id, 'COMMAND', '/done');
      const chatId = ctx.chat.id;
      const session = sessions[chatId];
      if (!session) return ctx.reply('No active session.');
      if (session.urls.length === 0) return ctx.reply('Add some links first!');

      const userData = loadTokens()[chatId];
      if (!userData?.kindleEmail) return ctx.reply('❌ Please set your Kindle email first: /setemail yourname@kindle.com');

      ctx.reply(`🚀 Processing ${session.urls.length} articles for "${session.title}"...`);

      try {
        const { failedUrls } = await sendToKindle({
          urls: session.urls,
          title: session.title,
          kindleEmail: userData.kindleEmail,
        });
        saveBindToHistory(chatId, { title: session.title, urls: session.urls });
        ctx.reply('✅ Collection sent to your Kindle!' +
          (failedUrls.length ? `\n⚠️ ${failedUrls.length} URL(s) could not be fetched and were skipped.` : ''));
        delete sessions[chatId];
      } catch (err) {
        console.error('/done error:', err);
        ctx.reply('❌ Failed to send collection. Please check the URLs and try again.');
      }
    });

    bot.action('cancel_binding', (ctx) => {
      logInteraction(ctx.chat.id, 'ACTION', 'cancel_binding');
      delete sessions[ctx.chat.id];
      ctx.answerCbQuery('Cancelled');
      ctx.editMessageText('❌ Binding session cancelled.');
    });

    bot.command('cancel', (ctx) => {
      logInteraction(ctx.chat.id, 'COMMAND', '/cancel');
      if (sessions[ctx.chat.id]) {
        delete sessions[ctx.chat.id];
        ctx.reply('❌ Binding session cancelled.');
      } else {
        ctx.reply('No active session to cancel.');
      }
    });

    function buildHistoryKeyboard(chatId) {
      const binds = loadBindHistory(chatId);
      if (!binds.length) return null;
      return binds.slice(0, 8).map(b => [{
        text: `📖 ${b.title} (${b.urls.length})`,
        callback_data: `vb_${b.id}`
      }]);
    }

    function historyText(chatId) {
      const binds = loadBindHistory(chatId);
      if (!binds.length) return '📚 No past collections yet.\n\nUse /bind to create one!';
      return `📚 *Past Collections* (${binds.length})\n\nTap one to view details:`;
    }

    bot.command('history', (ctx) => {
      logInteraction(ctx.chat.id, 'COMMAND', '/history');
      const keyboard = buildHistoryKeyboard(ctx.chat.id);
      if (!keyboard) return ctx.reply('📚 No past collections yet.\n\nUse /bind to create one!');
      ctx.reply(historyText(ctx.chat.id), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    });

    bot.action('show_history', (ctx) => {
      const chatId = ctx.chat.id;
      const keyboard = buildHistoryKeyboard(chatId);
      if (!keyboard) return ctx.editMessageText('📚 No past collections yet.\n\nUse /bind to create one!');
      ctx.editMessageText(historyText(chatId), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    });

    bot.action(/^vb_(.+)$/, (ctx) => {
      const bindId = ctx.match[1];
      const chatId = ctx.chat.id;
      const binds = loadBindHistory(chatId);
      const bind = binds.find(b => b.id === bindId);
      if (!bind) return ctx.answerCbQuery('Collection not found.');

      const date = new Date(bind.sentAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const urlList = bind.urls.map((u, i) => {
        let display;
        try { display = new URL(u).hostname + new URL(u).pathname; } catch { display = u; }
        if (display.length > 45) display = display.slice(0, 44) + '…';
        return `${i + 1}. ${display}`;
      }).join('\n');

      ctx.editMessageText(
        `📖 *${bind.title}*\n_Sent ${date} · ${bind.urls.length} article${bind.urls.length !== 1 ? 's' : ''}_\n\n${urlList}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✉️ Resend', callback_data: `rb_${bind.id}` }, { text: '➕ Add Articles', callback_data: `eb_${bind.id}` }],
              [{ text: '« Back to History', callback_data: 'show_history' }]
            ]
          }
        }
      );
    });

    bot.action(/^rb_(.+)$/, async (ctx) => {
      const bindId = ctx.match[1];
      const chatId = ctx.chat.id;
      const binds = loadBindHistory(chatId);
      const bind = binds.find(b => b.id === bindId);
      if (!bind) return ctx.answerCbQuery('Collection not found.');

      const userData = loadTokens()[chatId];
      if (!userData?.kindleEmail) return ctx.answerCbQuery('❌ Set your Kindle email first (/setemail).');

      await ctx.answerCbQuery('Resending…');
      await ctx.editMessageText(`🚀 Resending "${bind.title}" (${bind.urls.length} articles)…`);

      try {
        const { failedUrls } = await sendToKindle({
          urls: bind.urls,
          title: bind.title,
          kindleEmail: userData.kindleEmail,
        });
        saveBindToHistory(chatId, { title: bind.title, urls: bind.urls });
        await ctx.reply(`✅ "${bind.title}" resent to your Kindle!` +
          (failedUrls.length ? `\n⚠️ ${failedUrls.length} URL(s) could not be fetched and were skipped.` : ''));
      } catch (err) {
        console.error('resend error:', err);
        await ctx.reply('❌ Failed to resend. Please try again.');
      }
    });

    bot.action(/^eb_(.+)$/, (ctx) => {
      const bindId = ctx.match[1];
      const chatId = ctx.chat.id;
      const binds = loadBindHistory(chatId);
      const bind = binds.find(b => b.id === bindId);
      if (!bind) return ctx.answerCbQuery('Collection not found.');

      sessions[chatId] = { state: 'COLLECTING_LINKS', title: bind.title, urls: [...bind.urls], createdAt: Date.now() };
      ctx.editMessageText(
        `➕ *Extending "${bind.title}"*\n\n${bind.urls.length} article${bind.urls.length !== 1 ? 's' : ''} already loaded. Send more links, then tap Finish.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Finish & Send', callback_data: 'done_binding' }],
              [{ text: '❌ Cancel', callback_data: 'cancel_binding' }]
            ]
          }
        }
      );
    });

    bot.on('text', async (ctx) => {
      const text = ctx.message.text;
      const chatId = ctx.chat.id;
      logInteraction(chatId, 'TEXT', text);
      const session = sessions[chatId];

      if (session && session.state === 'AWAITING_EMAIL' && !text.startsWith('/')) {
        if (!isValidEmail(text.trim())) {
          return ctx.reply("That doesn't look like a valid email. Please try again:");
        }
        saveToken(String(chatId), { kindleEmail: text.trim() });
        delete sessions[chatId];
        return ctx.reply(`✅ Kindle email set to: ${text.trim()}`);
      }

      if (session && session.state === 'AWAITING_TITLE' && !text.startsWith('/')) {
        session.title = text;
        session.state = 'COLLECTING_LINKS';
        return ctx.reply(`Title set: "${text}".\n\nNow send me the links one by one.`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '❌ Cancel', callback_data: 'cancel_binding' }]
            ]
          }
        });
      }

      const urlRegex = /(https?:\/\/[^\s]+)/g;
      const match = text.match(urlRegex);

      if (match) {
        const url = match[0].replace(/[.,;:!?)"']+$/, '');

        if (session && session.state === 'COLLECTING_LINKS') {
          if (session.urls.length >= 20) {
            return ctx.reply('Maximum 20 articles per collection. Tap ✅ Finish & Send to proceed.', {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '✅ Finish & Send', callback_data: 'done_binding' }],
                  [{ text: '❌ Cancel', callback_data: 'cancel_binding' }]
                ]
              }
            });
          }
          session.urls.push(url);
          return ctx.reply(`Added (${session.urls.length}): ${url}`, {
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Finish & Send', callback_data: 'done_binding' }],
                [{ text: '❌ Cancel', callback_data: 'cancel_binding' }]
              ]
            }
          });
        }

        const userData = loadTokens()[ctx.chat.id];

        if (!userData?.kindleEmail) {
          return ctx.reply('❌ Please set your Kindle email first: /setemail yourname@kindle.com');
        }

        ctx.reply('Processing article...');

        try {
          await sendToKindle({
            url,
            kindleEmail: userData.kindleEmail,
          });
          ctx.reply('✅ Article sent to your Kindle!');
        } catch (err) {
          console.error('sendToKindle error:', err);
          ctx.reply('❌ Failed to send article. Please check the URL and try again.');
        }
      }
    });

    bot.catch((err, ctx) => {
      console.error(`Telegraf error for ${ctx.updateType}`, err);
    });

    bot.launch()
      .then(() => console.log('Telegram Bot launched'))
      .catch(err => console.error('CRITICAL ERROR launching Telegram Bot:', err));

  } catch (initErr) {
    console.error('Error during Telegraf initialization:', initErr);
  }
} else {
  console.log('No TELEGRAM_BOT_TOKEN found. Bot will not start.');
}

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully...`);
  if (bot) bot.stop(signal);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
