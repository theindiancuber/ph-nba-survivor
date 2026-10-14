// Champion certificates, drawn on a canvas and saved as PNG.

import { LEAGUE } from './config.js';

const W = 2000, H = 1414;
const NAVY = '#0b1a33', RED = '#c8102e', BLUE = '#1d428a', GOLD = '#c9a227', PAPER = '#fbf7ee';

// kind: 'champion' (titles and crowns), 'award' (Hall of Fame) or 'shame' (Hall of Shame).
const KINDS = {
  champion: { header: 'CERTIFICATE OF CHAMPIONSHIP', seal: 'CHAMPION', to: 'is proudly awarded to', tagline: 'For bragging rights in perpetuity. No refunds.' },
  award: { header: 'CERTIFICATE OF ACHIEVEMENT', seal: 'HONOREE', to: 'is proudly awarded to', tagline: 'Recognised by the league, envied by the office.' },
  shame: { header: 'CERTIFICATE OF DUBIOUS DISTINCTION', seal: 'OOPS', to: 'is reluctantly awarded to', tagline: 'Awarded with love. To be framed and never spoken of again.' },
};

export async function drawCertificate({ title, name, detail, date, kind = 'champion' }) {
  const K = KINDS[kind] || KINDS.champion;
  await Promise.all([
    document.fonts.load('700 120px Oswald'), document.fonts.load('italic 700 150px "Playfair Display"'),
    document.fonts.load('500 36px Inter'),
  ]).catch(() => {});
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');

  // Paper and borders
  const bg = g.createRadialGradient(W / 2, H / 2, 200, W / 2, H / 2, 1200);
  bg.addColorStop(0, '#fffdf7'); bg.addColorStop(1, '#f1e9d6');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.fillStyle = NAVY; g.fillRect(0, 0, W, 28); g.fillRect(0, H - 28, W, 28); g.fillRect(0, 0, 28, H); g.fillRect(W - 28, 0, 28, H);
  g.fillStyle = RED; g.fillRect(28, 28, W / 2 - 28, 10); g.fillRect(28, H - 38, W / 2 - 28, 10);
  g.fillStyle = BLUE; g.fillRect(W / 2, 28, W / 2 - 28, 10); g.fillRect(W / 2, H - 38, W / 2 - 28, 10);
  g.strokeStyle = GOLD; g.lineWidth = 4; g.strokeRect(70, 80, W - 140, H - 160);
  g.lineWidth = 1.5; g.strokeRect(86, 96, W - 172, H - 192);

  // Court arc watermark
  g.save(); g.globalAlpha = 0.06; g.strokeStyle = NAVY; g.lineWidth = 10;
  g.beginPath(); g.arc(W / 2, H + 120, 760, Math.PI, 2 * Math.PI); g.stroke();
  g.beginPath(); g.arc(W / 2, H / 2, 180, 0, 2 * Math.PI); g.stroke();
  g.restore();

  // Ball badge
  ball(g, W / 2, 215, 62);

  g.textAlign = 'center';
  g.fillStyle = NAVY;
  g.font = '700 46px Oswald';
  spaced(g, LEAGUE.name.toUpperCase(), W / 2, 340, 10);
  g.fillStyle = RED;
  g.font = '600 30px Inter';
  spaced(g, `${K.header} · ${LEAGUE.season} SEASON`, W / 2, 395, 6);

  g.fillStyle = NAVY;
  g.font = '700 128px Oswald';
  fit(g, title.toUpperCase(), W / 2, 560, W - 360);

  g.fillStyle = '#5b6680';
  g.font = 'italic 400 40px "Playfair Display", Georgia, serif';
  g.fillText(K.to, W / 2, 650);

  g.fillStyle = BLUE;
  g.font = 'italic 700 150px "Playfair Display", Georgia, serif';
  fit(g, name, W / 2, 820, W - 400);
  g.strokeStyle = GOLD; g.lineWidth = 3;
  g.beginPath(); g.moveTo(W / 2 - 520, 860); g.lineTo(W / 2 + 520, 860); g.stroke();

  g.fillStyle = NAVY;
  g.font = '500 40px Inter';
  fit(g, detail, W / 2, 940, W - 420);
  g.fillStyle = '#5b6680';
  g.font = '400 30px Inter';
  g.fillText(K.tagline, W / 2, 995);

  // Seal
  seal(g, W / 2, 1160, K.seal);

  // Signature and date
  g.textAlign = 'center';
  g.strokeStyle = NAVY; g.lineWidth = 2;
  for (const x of [470, W - 470]) { g.beginPath(); g.moveTo(x - 230, 1180); g.lineTo(x + 230, 1180); g.stroke(); }
  g.fillStyle = NAVY;
  g.font = 'italic 700 58px "Playfair Display", Georgia, serif';
  g.fillText(LEAGUE.commissioner, 470, 1165);
  g.font = '600 26px Inter';
  spaced(g, 'COMMISSIONER', 470, 1225, 5);
  g.font = '500 44px Inter';
  g.fillText(date, W - 470, 1165);
  g.font = '600 26px Inter';
  spaced(g, 'DATE', W - 470, 1225, 5);
  return c;
}

export async function downloadCertificate(info) {
  const c = await drawCertificate(info);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${info.title}-${info.name}`.replace(/[^\w-]+/g, '-').replace(/-+/g, '-') + '.png';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function spaced(g, text, x, y, spacing) {
  if ('letterSpacing' in g) { g.letterSpacing = `${spacing}px`; g.fillText(text, x + spacing / 2, y); g.letterSpacing = '0px'; return; }
  g.fillText(text, x, y);
}

function fit(g, text, x, y, max) {
  let size = parseInt(g.font.match(/(\d+)px/)[1], 10);
  while (g.measureText(text).width > max && size > 20) {
    size -= 4;
    g.font = g.font.replace(/\d+px/, `${size}px`);
  }
  g.fillText(text, x, y);
}

function ball(g, x, y, r) {
  g.save();
  g.fillStyle = '#e8762c';
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = NAVY; g.lineWidth = 5;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.moveTo(x - r, y); g.lineTo(x + r, y); g.stroke();
  g.beginPath(); g.moveTo(x, y - r); g.lineTo(x, y + r); g.stroke();
  g.beginPath(); g.arc(x - r * 1.35, y, r * 0.95, -0.75, 0.75); g.stroke();
  g.beginPath(); g.arc(x + r * 1.35, y, r * 0.95, Math.PI - 0.75, Math.PI + 0.75); g.stroke();
  g.restore();
}

function seal(g, x, y, label) {
  g.save();
  const spikes = 28, outer = 118, inner = 104;
  g.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 ? inner : outer, a = (Math.PI * i) / spikes;
    g.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
  }
  g.closePath();
  const grad = g.createLinearGradient(x - outer, y - outer, x + outer, y + outer);
  grad.addColorStop(0, '#f3d36b'); grad.addColorStop(0.5, GOLD); grad.addColorStop(1, '#a37f12');
  g.fillStyle = grad; g.fill();
  g.strokeStyle = '#fff6d5'; g.lineWidth = 3;
  g.beginPath(); g.arc(x, y, 84, 0, Math.PI * 2); g.stroke();
  g.fillStyle = NAVY; g.textAlign = 'center';
  g.font = '700 54px Oswald'; g.fillText('PH', x, y + 4);
  g.font = '600 18px Inter'; spaced(g, label, x, y + 38, 4);
  g.restore();
}
