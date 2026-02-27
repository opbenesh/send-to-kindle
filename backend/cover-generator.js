const { createCanvas, registerFont } = require('canvas');
const path = require('path');

async function generateCoverImage(title, author) {
  const width = 1200;
  const height = 1600;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#fdfdfd';
  ctx.fillRect(0, 0, width, height);

  // Border
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 40;
  ctx.strokeRect(60, 60, width - 120, height - 120);
  
  ctx.lineWidth = 10;
  ctx.strokeRect(100, 100, width - 200, height - 200);

  // Text
  ctx.fillStyle = '#1a1a1a';
  ctx.textAlign = 'center';

  // Title
  ctx.font = 'bold 80px Georgia, serif';
  const words = title.split(' ');
  let line = '';
  let y = 400;
  const maxWidth = 900;
  
  for(let n = 0; n < words.length; n++) {
    let testLine = line + words[n] + ' ';
    let metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && n > 0) {
      ctx.fillText(line, width/2, y);
      line = words[n] + ' ';
      y += 100;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line, width/2, y);

  // Author
  ctx.font = 'italic 50px Georgia, serif';
  ctx.fillText('by ' + author, width/2, height - 300);

  // Branding
  ctx.font = '30px Arial, sans-serif';
  ctx.fillText("A COLLECTION BY OPBENESH'S SEND TO KINDLE", width/2, height - 150);

  return canvas.toBuffer('image/jpeg');
}

module.exports = { generateCoverImage };
