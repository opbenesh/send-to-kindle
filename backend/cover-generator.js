const { createCanvas, registerFont } = require('canvas');
const path = require('path');

async function generateCoverImage(title, author) {
  const width = 1200;
  const height = 1600;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background - Soft Cream/Paper color
  ctx.fillStyle = '#faf9f6';
  ctx.fillRect(0, 0, width, height);

  // Decorative Border
  ctx.strokeStyle = '#2c2c2c';
  ctx.lineWidth = 2;
  ctx.strokeRect(40, 40, width - 80, height - 80);
  
  ctx.lineWidth = 8;
  ctx.strokeRect(60, 60, width - 120, height - 120);

  // Text
  ctx.fillStyle = '#1a1a1a';
  ctx.textAlign = 'center';

  // Header branding
  ctx.font = 'bold 24px Arial';
  ctx.fillText("OPBENESH'S READER", width/2, 150);

  // Title
  ctx.font = 'bold 90px Georgia, serif';
  const words = title.split(' ');
  let line = '';
  let y = 450;
  const maxWidth = 950;
  
  for(let n = 0; n < words.length; n++) {
    let testLine = line + words[n] + ' ';
    let metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && n > 0) {
      ctx.fillText(line, width/2, y);
      line = words[n] + ' ';
      y += 110;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line, width/2, y);

  // Divider line
  ctx.beginPath();
  ctx.moveTo(width/2 - 150, y + 100);
  ctx.lineTo(width/2 + 150, y + 100);
  ctx.lineWidth = 3;
  ctx.stroke();

  // Author
  ctx.font = 'italic 55px Georgia, serif';
  ctx.fillText(author, width/2, y + 250);

  // Bottom Branding
  ctx.font = 'bold 28px "Arial Narrow", sans-serif';
  ctx.letterSpacing = "4px";
  ctx.fillText("A COLLECTION BY OPBENESH'S SEND TO KINDLE", width/2, height - 120);

  return canvas.toBuffer('image/jpeg');
}

module.exports = { generateCoverImage };
