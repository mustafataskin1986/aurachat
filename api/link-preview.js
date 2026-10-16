import dns from 'node:dns/promises';
import net from 'node:net';
import { admin } from './_push.js';

// Giriş yapmış kullanıcı için bir linkin başlık / açıklama / resim bilgisini okur.
// Sunucu içi adreslere istek atılmasın diye (SSRF) her adım kontrol edilir.

const MAX_BYTES = 400 * 1024;
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')) return true;
    if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
    return false;
  }
  return true;
}

async function assertPublicHost(hostname) {
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('blocked-host');
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('blocked-host');
    return;
  }
  const addrs = await dns.lookup(hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('blocked-host');
}

async function fetchHtml(startUrl) {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad-protocol');
    await assertPublicHost(u.hostname);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AuraChatLinkPreview/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'tr,en;q=0.8'
        }
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url).toString();
      continue;
    }
    if (!res.ok) throw new Error('http-' + res.status);
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    if (!type.includes('text/html') && !type.includes('xhtml')) throw new Error('not-html');

    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    try { await reader.cancel(); } catch (e) {}
    return { html: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), finalUrl: url };
  }
  throw new Error('too-many-redirects');
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch (e) { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch (e) { return ''; } })
    .replace(/\s+/g, ' ')
    .trim();
}

function metaContent(html, keys) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const key of keys) {
    for (const tag of tags) {
      const nameMatch = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i);
      if (!nameMatch || nameMatch[1].toLowerCase() !== key) continue;
      const contentMatch = tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i);
      if (contentMatch && contentMatch[1].trim()) return decodeEntities(contentMatch[1]);
    }
  }
  return '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Yalnızca POST kabul edilir.' });

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!idToken) return res.status(401).json({ error: 'Yetkisiz.' });
  try {
    await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    return res.status(401).json({ error: 'Geçersiz oturum.' });
  }

  const rawUrl = String((req.body && req.body.url) || '').slice(0, 2000);
  let parsed;
  try {
    parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad');
  } catch (e) {
    return res.status(400).json({ error: 'Geçersiz link.' });
  }

  try {
    const { html, finalUrl } = await fetchHtml(parsed.toString());
    const head = html.slice(0, MAX_BYTES);

    let title = metaContent(head, ['og:title', 'twitter:title']);
    if (!title) {
      const t = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (t) title = decodeEntities(t[1]);
    }
    const description = metaContent(head, ['og:description', 'twitter:description', 'description']);
    let image = metaContent(head, ['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']);
    const site = metaContent(head, ['og:site_name']);

    if (image) {
      try {
        const abs = new URL(image, finalUrl);
        image = (abs.protocol === 'http:' || abs.protocol === 'https:') ? abs.toString() : '';
      } catch (e) {
        image = '';
      }
    }

    if (!title && !description && !image) {
      return res.status(200).json({ success: false, reason: 'empty' });
    }

    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.status(200).json({
      success: true,
      preview: {
        url: parsed.toString().slice(0, 500),
        title: title.slice(0, 140),
        description: description.slice(0, 220),
        image: image.slice(0, 500),
        site: site.slice(0, 60)
      }
    });
  } catch (err) {
    return res.status(200).json({ success: false, reason: String((err && err.message) || 'error').slice(0, 60) });
  }
}
