const express = require('express');
const cors = require('cors');
const https = require('https');
const axios = require('axios').create({
  httpsAgent: new https.Agent({  
    rejectUnauthorized: false
  })
});
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const epubGenMemory = require('epub-gen-memory').default;
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { generateCoverImage } = require('./cover-generator');

const dotenvResult = dotenv.config({ path: path.join(__dirname, '.env') });
console.log('Dotenv Load Result:', dotenvResult.error ? 'ERROR: ' + dotenvResult.error : 'SUCCESS');
if (dotenvResult.parsed) {
  console.log('Loaded variables:', Object.keys(dotenvResult.parsed));
}

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 3003;
const TOKEN_PATH = path.join(__dirname, 'tokens.json');
const sessions = {}; // Moved to top level

// --- Google OAuth Setup ---
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `https://openclaw.tail5869ac.ts.net:${port}/auth/google/callback`
);

// Helper to load/save tokens
function loadTokens() {
  if (fs.existsSync(TOKEN_PATH)) {
    return JSON.parse(fs.readFileSync(TOKEN_PATH));
  }
  return {};
}

function saveToken(chatId, tokens) {
  const allTokens = loadTokens();
  allTokens[chatId] = { ...(allTokens[chatId] || {}), ...tokens };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(allTokens, null, 2));
}

// --- Helpers ---
function logInteraction(chatId, type, content) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] Chat: ${chatId} | ${type}: ${content}\n`;
  fs.appendFile(path.join(__dirname, 'interactions.log'), logEntry, (err) => {
    if (err) console.error('Error writing to interactions.log:', err);
  });
}

async function fetchArticle(url) {
  const response = await axios.get(url);
  const dom = new JSDOM(response.data, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  return article ? { ...article, url } : null;
}

// --- Core Logic ---
async function sendToKindle({ url, urls, kindleEmail, smtpSettings, authType, accessToken, userEmail, chatId, title: manualTitle, author: manualAuthor }) {
  // If we have a chatId and no token, try to load stored token
  let effectiveAccessToken = accessToken;
  let effectiveUserEmail = userEmail;

  if (chatId && !accessToken) {
    const tokens = loadTokens()[chatId];
    if (tokens) {
      oauth2Client.setCredentials(tokens);
      // Refresh if needed
      const { token } = await oauth2Client.getAccessToken();
      effectiveAccessToken = token;
      
      // Get user email if not provided
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const userInfo = await oauth2.userinfo.get();
      effectiveUserEmail = userInfo.data.email;
      authType = 'google';
    }
  }

  const targetUrls = urls || [url];
  const articles = [];
  
  for (const targetUrl of targetUrls) {
    const article = await fetchArticle(targetUrl);
    if (article) articles.push(article);
  }

  if (articles.length === 0) throw new Error('Could not extract content from any URL.');

  const mainArticle = articles[0];
  const finalTitle = manualTitle || (articles.length > 1 ? 'Combined Articles' : mainArticle.title) || 'Untitled Article';
  const finalAuthor = manualAuthor || mainArticle.byline || mainArticle.siteName || (mainArticle.url ? new URL(mainArticle.url).hostname : 'Unknown');

  const safeTitle = finalTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const coverBuffer = await generateCoverImage(finalTitle, finalAuthor);
  const coverPath = path.join(__dirname, `${safeTitle}_cover.jpg`);
  fs.writeFileSync(coverPath, coverBuffer);

  const customCss = `
    body { font-family: "Georgia", serif; }
    h1.h1 { 
      text-align: center; 
      text-transform: uppercase; 
      font-size: 1.2em; 
      letter-spacing: 2px; 
      margin-top: 50px;
      border-bottom: 1px solid #333;
      padding-bottom: 10px;
      width: 90%;
      margin-left: auto;
      margin-right: auto;
    }
    nav#toc ol { 
      list-style: none; 
      padding: 0; 
      width: 90%; 
      margin: 20px auto; 
    }
    li.table-of-content { 
      margin-bottom: 12px; 
      display: block; 
      font-family: sans-serif;
      font-size: 0.9em;
    }
    li.table-of-content a { 
      text-decoration: none; 
      color: #1a1a1a; 
      display: block;
    }
    .toc-author { color: #666; font-size: 0.8em; display: block; margin-top: 2px; }
  `;

  const option = { 
    title: finalTitle, 
    author: finalAuthor,
    publisher: "Opbenesh's Send to Kindle",
    cover: `file://${coverPath}`,
    css: customCss,
    tocTitle: "What's Inside", 
    tocInTOC: true,
    numberChaptersInTOC: false,
    prependChapterTitles: false
  };
  
  const chapters = articles.map((article, index) => ({
    title: `${(index + 1).toString().padStart(2, '0')}. ${article.title}`,
    content: `
      <div style="font-family: sans-serif; color: #666; font-size: 0.85em; border-bottom: 1px solid #eee; padding-bottom: 10px; margin-bottom: 20px;">
        ${article.siteName ? `${article.siteName} • ` : ''}${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
      </div>
      ${article.content}
    `,
    author: article.byline || article.siteName || undefined,
    excludeFromToc: false 
  }));
  
  const epubBuffer = await epubGenMemory(option, chapters);
  
  try { fs.unlinkSync(coverPath); } catch (e) {}

  const emailSubject = articles.length === 1 ? `Article: ${mainArticle.title}` : `Bundle: ${finalTitle}`;

  if (authType === 'google' && effectiveAccessToken && effectiveUserEmail) {
    const boundary = 'foo_bar_baz';
    const email = [
      `To: ${kindleEmail}`,
      `Subject: ${emailSubject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      'Here is your article.',
      '',
      `--${boundary}`,
      `Content-Type: application/epub+zip; name="${safeTitle}.epub"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${safeTitle}.epub"`,
      '',
      epubBuffer.toString('base64'),
      `--${boundary}--`
    ].join('\r\n');

    const encodedEmail = Buffer.from(email).toString('base64url');

    await axios.post(
      `https://gmail.googleapis.com/gmail/v1/users/${effectiveUserEmail}/messages/send`,
      { raw: encodedEmail },
      { headers: { Authorization: `Bearer ${effectiveAccessToken}` } }
    );
    return true;
  } else if (smtpSettings) {
    const transporter = nodemailer.createTransport({
      host: smtpSettings.host,
      port: Number(smtpSettings.port),
      secure: Number(smtpSettings.port) === 465,
      auth: { user: smtpSettings.user, pass: smtpSettings.pass },
    });

    await transporter.sendMail({
      from: smtpSettings.from,
      to: kindleEmail,
      subject: emailSubject,
      text: 'Here is your article.',
      attachments: [{ filename: `${safeTitle}.epub`, content: Buffer.from(epubBuffer) }],
    });
    return true;
  }
  throw new Error('No valid authentication provided. Use /login to sign in with Google.');
}

// --- Express Routes (Disabled for Web UI) ---
/*
app.get('/api/extract', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const response = await axios.get(url);
    const dom = new JSDOM(response.data, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article) return res.status(404).json({ error: 'Could not extract content' });

    res.json({
      title: article.title,
      author: article.byline,
      excerpt: article.excerpt,
      siteName: article.siteName
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/send-to-kindle', async (req, res) => {
  try {
    await sendToKindle(req.body);
    res.json({ success: true });
  } catch (error) {
    console.error('API Error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.error?.message || error.message });
  }
});
*/

app.get('/auth/google/callback', async (req, res) => {
  const { code, state: chatId } = req.query;
  console.log('Received OAuth callback for chatId:', chatId);
  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log('Successfully retrieved tokens');
    saveToken(chatId, tokens);
    
    // Notify user via Bot
    if (bot) {
      bot.telegram.sendMessage(chatId, "✅ Successfully signed in with Google! You can now send me links to push to your Kindle.")
        .catch(err => console.error('Error sending message to bot:', err));
    } else {
      console.error('Bot instance is not available to send success message');
    }
    
    res.send('<h1>Authentication Successful!</h1><p>You can close this window and return to Telegram.</p>');
  } catch (err) {
    console.error('OAuth Error:', err.response?.data || err.message);
    res.status(500).send(`<h1>Authentication failed</h1><p>${err.message}</p>`);
  }
});

// --- Telegram Bot ---
console.log('--- STARTING TELEGRAM BOT SECTION ---');
const botToken = process.env.TELEGRAM_BOT_TOKEN;
console.log('TELEGRAM_BOT_TOKEN from process.env:', botToken ? `FOUND (${botToken.substring(0, 5)}...)` : 'NOT FOUND');

let bot;
if (botToken) {
  console.log('Initializing Telegraf bot with token...');
  try {
    bot = new Telegraf(botToken);
    
    // Register whitelist middleware
    const whitelistedUsers = (process.env.WHITELISTED_USERS || '').split(',').map(id => id.trim()).filter(id => id);
    bot.use((ctx, next) => {
      const chatId = ctx.chat?.id.toString();
      const userId = ctx.from?.id.toString();
      
      if (whitelistedUsers.length > 0 && !whitelistedUsers.includes(chatId) && !whitelistedUsers.includes(userId)) {
        console.warn(`Unauthorized access attempt from Chat ID: ${chatId}, User ID: ${userId}`);
        // Only reply if it's a message or command, not actions or others if they're not allowed
        if (ctx.updateType === 'message') {
          return ctx.reply("⛔ Sorry, you're not authorized to use this bot.");
        }
        return;
      }
      return next();
    });

    // Register commands for the "Menu" button
    bot.telegram.setMyCommands([
      { command: 'start', description: 'Show welcome message' },
      { command: 'bind', description: 'Start a multi-article collection' },
      { command: 'status', description: 'Check your settings' },
      { command: 'login', description: 'Sign in with Google' },
      { command: 'setemail', description: 'Set Kindle email' },
      { command: 'help', description: 'Show help' }
    ]);

    bot.start((ctx) => {
      logInteraction(ctx.chat.id, 'COMMAND', '/start');
      console.log('Bot /start command received from:', ctx.from.id);
      ctx.reply("📚 *Welcome to Opbenesh's Send to Kindle!*\n\nI can help you turn web articles into beautiful ebooks for your Kindle.\n\n*Quick Setup:*", {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📧 Set Kindle Email', callback_data: 'setup_email' }, { text: '🔑 Google Login', callback_data: 'setup_login' }],
            [{ text: '📋 Check Status', callback_data: 'check_status' }],
            [{ text: '📖 How to use?', callback_data: 'show_help' }]
          ]
        }
      });
    });

    // Handle the quick setup buttons
    bot.action('setup_email', (ctx) => ctx.reply('Usage: /setemail yourname@kindle.com'));
    bot.action('setup_login', (ctx) => {
      const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/userinfo.email'],
        state: ctx.chat.id.toString()
      });
      ctx.reply(`Please sign in with Google:\n\n${url}`);
    });
    bot.action('check_status', (ctx) => {
      const allTokens = loadTokens();
      const userData = allTokens[ctx.chat.id];
      let statusMsg = '*Current Status:*\n';
      if (userData) {
        statusMsg += `✅ Kindle Email: \`${userData.kindleEmail || 'Not set'}\`\n`;
        statusMsg += `✅ Google Auth: ${userData.access_token ? 'Linked' : 'Not linked'}`;
      } else {
        statusMsg += '❌ No user data found.';
      }
      ctx.reply(statusMsg, { parse_mode: 'Markdown' });
    });
    bot.action('show_help', (ctx) => {
      ctx.reply('Commands:\n/bind - Start a multi-article collection\n/status - Check settings\n/login - Google sign-in\n/setemail - Set Kindle email\n\nSimply send me any link to send it instantly!');
    });

    bot.help((ctx) => {
      ctx.reply('Commands:\n/setemail <email> - Set your Kindle email\n/login - Sign in with Google\n/status - Check your settings\n/bind - Start a multi-article session\n/done - Finish binding and send\n/cancel - Cancel binding session\n/help - Show this message');
    });

    bot.command('status', (ctx) => {
      logInteraction(ctx.chat.id, 'COMMAND', '/status');
      const allTokens = loadTokens();
      const userData = allTokens[ctx.chat.id];
      let statusMsg = 'Bot is running.\n';
      if (userData) {
        statusMsg += `✅ Kindle Email: ${userData.kindleEmail || 'Not set'}\n`;
        statusMsg += `✅ Google Auth: ${userData.access_token ? 'Linked' : 'Not linked'}`;
      } else {
        statusMsg += '❌ No user data found. Please use /setemail and /login.';
      }
      ctx.reply(statusMsg);
    });

    bot.command('debug_session', (ctx) => {
      ctx.reply(`Current Session: ${JSON.stringify(sessions[ctx.chat.id] || 'None')}`);
    });

    bot.command('login', (ctx) => {
      logInteraction(ctx.chat.id, 'COMMAND', '/login');
      console.log('Bot /login command received from:', ctx.from.id);
      const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/userinfo.email'],
        state: ctx.chat.id.toString()
      });
      console.log('Generated OAuth URL:', url);
      ctx.reply(`Please sign in with Google to allow me to send emails on your behalf:\n\n${url}`);
    });

    bot.command('setemail', (ctx) => {
      logInteraction(ctx.chat.id, 'COMMAND', `/setemail ${ctx.message.text.split(' ')[1] || ''}`);
      console.log('Bot /setemail command received from:', ctx.from.id);
      const email = ctx.message.text.split(' ')[1];
      if (email && email.includes('@')) {
        const allTokens = loadTokens();
        if (!allTokens[ctx.chat.id]) allTokens[ctx.chat.id] = {};
        allTokens[ctx.chat.id].kindleEmail = email;
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(allTokens, null, 2));
        ctx.reply(`✅ Kindle email set to: ${email}`);
      } else {
        ctx.reply('Usage: /setemail yourname@kindle.com');
      }
    });

    bot.command('bind', (ctx) => {
      logInteraction(ctx.chat.id, 'COMMAND', '/bind');
      console.log('DEBUG: /bind command received for chatId:', ctx.chat.id);
      sessions[ctx.chat.id] = { state: 'AWAITING_TITLE', urls: [] };
      console.log('DEBUG: Session created:', sessions[ctx.chat.id]);
      ctx.reply('📚 Binding mode activated! Please send me the TITLE for this collection.');
    });

    bot.action('done_binding', async (ctx) => {
      logInteraction(ctx.chat.id, 'ACTION', 'done_binding');
      const chatId = ctx.chat.id;
      const session = sessions[chatId];
      if (!session) return ctx.answerCbQuery('No active session.');
      if (session.urls.length === 0) return ctx.answerCbQuery('Add some links first!');

      await ctx.answerCbQuery('Processing bundle...');
      await ctx.editMessageText(`🚀 Processing ${session.urls.length} articles for "${session.title}"...`);
      
      const allTokens = loadTokens();
      const userData = allTokens[chatId];
      
      try {
        await sendToKindle({
          urls: session.urls,
          title: session.title,
          kindleEmail: userData.kindleEmail,
          chatId: chatId
        });
        await ctx.reply('✅ Collection sent to your Kindle!');
        delete sessions[chatId];
      } catch (err) {
        await ctx.reply(`❌ Failed to send collection: ${err.message}`);
      }
    });

    bot.command('done', async (ctx) => {
      logInteraction(ctx.chat.id, 'COMMAND', '/done');
      const chatId = ctx.chat.id;
      const session = sessions[chatId];
      if (!session) return ctx.reply('No active session.');
      if (session.urls.length === 0) return ctx.reply('Add some links first!');

      ctx.reply(`🚀 Processing ${session.urls.length} articles for "${session.title}"...`);
      
      const allTokens = loadTokens();
      const userData = allTokens[chatId];
      
      try {
        await sendToKindle({
          urls: session.urls,
          title: session.title,
          kindleEmail: userData.kindleEmail,
          chatId: chatId
        });
        ctx.reply('✅ Collection sent to your Kindle!');
        delete sessions[chatId];
      } catch (err) {
        ctx.reply(`❌ Failed to send collection: ${err.message}`);
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

    bot.on('text', async (ctx) => {
      const text = ctx.message.text;
      const chatId = ctx.chat.id;
      logInteraction(chatId, 'TEXT', text);
      const session = sessions[chatId];
      console.log(`DEBUG: Text received: "${text}" | ChatId: ${chatId} | Session State: ${session?.state || 'none'}`);

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

      console.log('Bot message received:', text);
      const urlRegex = /(https?:\/\/[^\s]+)/g;
      const match = text.match(urlRegex);

      if (match) {
        const url = match[0];
        
        if (session && session.state === 'COLLECTING_LINKS') {
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

        const allTokens = loadTokens();
        const userData = allTokens[ctx.chat.id];

        if (!userData || !userData.kindleEmail) {
          return ctx.reply('Please set your Kindle email first using /setemail yourname@kindle.com');
        }

        ctx.reply('Processing article...');
        
        try {
          await sendToKindle({
            url,
            kindleEmail: userData.kindleEmail,
            chatId: ctx.chat.id
          });
          ctx.reply('✅ Article sent to your Kindle!');
        } catch (err) {
          ctx.reply(`❌ Failed: ${err.message}`);
        }
      }
    });

    console.log('Calling bot.launch()...');
    bot.catch((err, ctx) => {
      console.error(`Telegraf error for ${ctx.updateType}`, err);
    });

    bot.launch()
      .then(() => console.log('Telegram Bot successfully launched and listening'))
      .catch(err => {
        console.error('CRITICAL ERROR launching Telegram Bot:');
        console.error(err);
      });
  } catch (initErr) {
    console.error('Error during Telegraf initialization:', initErr);
  }
} else {
  console.log('FAILED: No TELEGRAM_BOT_TOKEN found in environment. Bot will not start.');
}

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

console.log('--- END TELEGRAM BOT SECTION ---');

const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem'))
};

https.createServer(sslOptions, app).listen(port, () => {
  console.log(`HTTPS Server listening on ${port}`);
});
