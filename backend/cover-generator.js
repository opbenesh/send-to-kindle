const { createCanvas } = require('canvas');

function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function generateCoverImage(title, author) {
  const width = 1200;
  const height = 1600;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background — soft cream/paper
  ctx.fillStyle = '#faf9f6';
  ctx.fillRect(0, 0, width, height);

  // Decorative border: thin outer, thick inner
  ctx.strokeStyle = '#2c2c2c';
  ctx.lineWidth = 2;
  ctx.strokeRect(40, 40, width - 80, height - 80);
  ctx.lineWidth = 8;
  ctx.strokeRect(60, 60, width - 120, height - 120);

  ctx.fillStyle = '#1a1a1a';
  ctx.textAlign = 'center';

  // Header branding
  ctx.font = 'bold 24px Arial';
  ctx.fillStyle = '#555';
  ctx.fillText("OPBENESH'S READER", width / 2, 150);
  ctx.fillStyle = '#1a1a1a';

  // Title — pick font size based on character count so long titles stay readable
  const titleMaxWidth = 950;
  const titleFontSize = title.length > 60 ? 60 : title.length > 40 ? 72 : 90;
  ctx.font = `bold ${titleFontSize}px Georgia`;
  const titleLines = wrapText(ctx, title, titleMaxWidth);
  const lineHeight = titleFontSize * 1.28;

  // Vertically centre the title block around y=500
  let titleY = 500 - ((titleLines.length - 1) * lineHeight) / 2;
  for (const line of titleLines) {
    ctx.fillText(line, width / 2, titleY);
    titleY += lineHeight;
  }
  const afterTitle = titleY - lineHeight + titleFontSize * 0.25;

  // Divider line
  ctx.beginPath();
  ctx.moveTo(width / 2 - 160, afterTitle + 60);
  ctx.lineTo(width / 2 + 160, afterTitle + 60);
  ctx.lineWidth = 2;
  ctx.stroke();

  // Author — wrap if needed, truncate if extremely long
  const authorMaxWidth = 900;
  ctx.font = 'italic 52px Georgia';
  ctx.fillStyle = '#333';
  const authorDisplay = author.length > 70 ? author.substring(0, 67) + '…' : author;
  const authorLines = wrapText(ctx, authorDisplay, authorMaxWidth);
  let authorY = afterTitle + 140;
  for (const line of authorLines) {
    ctx.fillText(line, width / 2, authorY);
    authorY += 65;
  }

  // Bottom branding
  ctx.font = 'bold 22px Arial';
  ctx.fillStyle = '#555';
  ctx.fillText('SEND TO KINDLE', width / 2, height - 110);

  return canvas.toBuffer('image/jpeg', { quality: 0.92 });
}

module.exports = { generateCoverImage };
