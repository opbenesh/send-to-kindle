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

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 3003;

app.post('/api/send-to-kindle', async (req, res) => {
  console.log('Received request for URL:', req.body.url);
  const { url, kindleEmail, smtpSettings, authType, accessToken, userEmail } = req.body;

  try {
    const response = await axios.get(url);
    const dom = new JSDOM(response.data, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article) return res.status(400).json({ error: 'Could not extract content.' });

    const option = { title: article.title || 'Kindle Article', author: article.byline || 'Unknown' };
    const chapters = [{ title: article.title, content: article.content }];
    const epubBuffer = await epubGenMemory(option, chapters);

    if (authType === 'google' && accessToken && userEmail) {
      console.log('Sending via GMAIL API (HTTP):', userEmail);
      
      const safeTitle = (article.title || 'article').replace(/[^a-z0-9]/gi, '_').toLowerCase();
      
      // Construct raw email for Gmail API
      const boundary = 'foo_bar_baz';
      const email = [
        `To: ${kindleEmail}`,
        `Subject: Article: ${article.title}`,
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

      const gmailResponse = await axios.post(
        `https://gmail.googleapis.com/gmail/v1/users/${userEmail}/messages/send`,
        { raw: encodedEmail },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      console.log('Gmail API Success:', gmailResponse.data.id);
      return res.json({ success: true });
    } else if (smtpSettings) {
      const transporter = nodemailer.createTransport({
        host: smtpSettings.host,
        port: Number(smtpSettings.port),
        secure: Number(smtpSettings.port) === 465,
        auth: { user: smtpSettings.user, pass: smtpSettings.pass },
      });

      const safeTitle = (article.title || 'article').replace(/[^a-z0-9]/gi, '_').toLowerCase();
      await transporter.sendMail({
        from: smtpSettings.from,
        to: kindleEmail,
        subject: `Article: ${article.title}`,
        text: 'Here is your article.',
        attachments: [{ filename: `${safeTitle}.epub`, content: Buffer.from(epubBuffer) }],
      });
      console.log('SMTP Success');
      return res.json({ success: true });
    }

    throw new Error('No valid authentication provided.');
  } catch (error) {
    console.error('Final Error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.error?.message || error.message });
  }
});

app.listen(port, () => console.log(`Server listening on ${port}`));
