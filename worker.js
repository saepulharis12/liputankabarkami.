/**
 * ============================================================================
 * worker.js — LIPUTAN INEWS HRS.GRUP
 * ============================================================================
 *
 * TUGAS FILE INI:
 * Menyajikan seluruh file website (index.html, gambar, dll.) seperti biasa,
 * TAPI menambahkan meta Open Graph + Twitter Card + canonical yang SESUAI
 * dengan artikel yang sedang dibuka, langsung di sisi server.
 *
 * Kenapa perlu? WhatsApp, Facebook, Telegram, X/Twitter, dst. TIDAK menjalankan
 * JavaScript. Mereka hanya membaca HTML mentah dari server. Website ini adalah
 * aplikasi satu halaman (React), jadi tanpa worker, semua link berbagi akan
 * tampil sama / tanpa pratinjau.
 *
 * CARA KERJA:
 * 1. Setiap permintaan tetap dilayani dari aset statis (env.ASSETS) —
 *    desain, fitur, menu, pencarian, iklan, semuanya tidak berubah.
 * 2. Jika respons berupa HTML dan URL memuat ?berita=<slug>, worker membaca
 *    blok window.BERITA_DATA langsung dari index.html, mencari artikel yang
 *    cocok (berdasarkan slug atau id), lalu menyuntikkan meta tag artikel
 *    tersebut sebelum HTML dikirim.
 * 3. Jika artikel berasal dari feed berita (RSS), worker mencari artikelnya
 *    dari sumber feed yang sama dengan yang dipakai website (best effort,
 *    dengan cache dan batas waktu; jika gagal, dipakai meta default situs).
 * 4. Jika tidak ada ?berita= (halaman utama), dipakai meta default situs.
 *
 * URL artikel baru yang dibagikan tombol "Bagikan" berformat:
 *   https://<domain>/?berita=<slug>#<slug>
 *   - bagian ?berita= dibaca worker (dan bot media sosial) untuk meta tag.
 *   - bagian #slug dibaca website untuk membuka artikel seperti biasa.
 * Link lama berformat https://<domain>/#<slug> tetap berfungsi normal
 * untuk pengunjung (hanya pratinjau yang memakai meta default situs).
 *
 * PENTING — FOTO PRATINJAU (og:image):
 * Foto asli hasil foto HP bisa 1-5 MB. WhatsApp/Facebook MENOLAK mengunduh
 * og:image yang lebih besar dari ±600 KB, sehingga pratinjau tampil tanpa
 * foto (judul+deskripsi muncul, gambar kosong). Karena itu SEMUA foto artikel
 * dialirkan lewat proxy kompresi wsrv.nl (CDN gambar gratis images.weserv.nl):
 * dipotong 1200x630 (ukuran ideal Open Graph), diubah ke JPEG ±100-250 KB,
 * lalu di-cache global. Hasilnya foto SELALU tampil di pratinjau WA/FB/Telegram.
 * ============================================================================
 */

/* ============================== IDENTITAS SITUS ============================ */
const SITE_NAME = 'LIPUTAN INEWS HRS.GRUP';
const SITE_TITLE_HOME = SITE_NAME + ' - Portal Berita Nasional';
const SITE_DESC = 'LIPUTAN INEWS HRS.GRUP - Portal berita Indonesia dengan liputan terkini dari 38 provinsi.';
const SITE_AUTHOR = 'Redaksi ' + SITE_NAME;
const FALLBACK_IMAGE = '/logo-liputan-news.png';

/* ============== PROXY KOMPRESI GAMBAR (wsrv.nl / images.weserv.nl) ========= */
/* WhatsApp praktis gagal menampilkan og:image > ~600 KB (timeout crawler).
   wsrv.nl mengompres gambar apa pun (termasuk foto HP 5 MB) menjadi JPEG
   1200x630 ~100-250 KB dan menyimpannya di CDN — gratis, tanpa daftar.       */
const IMG_PROXY = 'https://wsrv.nl/';
const OG_W = 1200;
const OG_H = 630;
/* Dimensi logo situs (fallback) — logo kecil, dikirim langsung tanpa proxy */
const LOGO_W = 707;
const LOGO_H = 353;

/* ============ DAFTAR FEED — SAMA PERSIS DENGAN index.html (REAL_NEWS_FEEDS) = */
const REAL_NEWS_FEEDS = [
  { url: 'https://www.antaranews.com/rss/news.xml', name: 'ANTARA News' },
  { url: 'https://rss.detik.com/index.php/detikcom', name: 'Detik.com' },
  { url: 'https://www.cnnindonesia.com/rss', name: 'CNN Indonesia' },
  { url: 'https://www.liputan6.com/rss/feed/terkini', name: 'Liputan6' },
  { url: 'https://www.kompas.com/navsource/rss/0', name: 'Kompas.com' },
  { url: 'https://feeds.bbci.co.uk/indonesian/rss.xml', name: 'BBC Indonesia' },
  { url: 'https://rss.tempo.co/nasional', name: 'Tempo' },
  { url: 'https://www.tribunnews.com/rss', name: 'Tribunnews' },
  { url: 'https://news.okezone.com/allrss', name: 'Okezone' },
  { url: 'https://www.jpnn.com/rss', name: 'JPNN' },
  { url: 'https://news.google.com/rss?hl=id&gl=ID&ceid=ID:id', name: 'Google News' },
  { url: 'https://www.tangerangnews.com/rss', name: 'TangerangNews' }
];
const RSS2JSON = 'https://api.rss2json.com/v1/api.json?rss_url=';
const FEED_TIMEOUT_MS = 9000;
const FEED_TTL_MS = 5 * 60 * 1000;    /* hasil feed sukses        */
const FEED_FAIL_TTL_MS = 2 * 60 * 1000; /* feed gagal: jangan buru-buru diulang */
const META_TTL_MS = 10 * 60 * 1000;   /* meta per artikel RSS     */
const META_NEG_TTL_MS = 60 * 1000;    /* slug RSS tak ditemukan   */
const DESC_MAX = 220;

/* ============================== CACHE MODULE =============================== */
const beritaCache = { fp: '', articles: null };  /* hasil parsing BERITA_DATA */
const feedCache = new Map();                     /* url feed -> items         */
const rssMetaCache = new Map();                  /* key -> meta | null        */

/* ========================= UTIL DASAR (parity dgn app) ===================== */
function hashStr(s) {
  let h = 0; const t = String(s);
  for (let i = 0; i < t.length; i++) { h = (h * 31 + t.charCodeAt(i)) >>> 0; }
  return h;
}
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ===================== PARSING window.BERITA_DATA (toleran) ================ */
/* Mengambil isi <script id="berita-data-src"> lalu memecah array berita.
   Parser ini sengaja toleran (sama seperti semangat parseBeritaToleran di
   index.html): record yang rusak dilewati, yang valid tetap dipakai.        */
function extractArticles(html) {
  const fp = html.length + ':' + hashStr(html.slice(0, 1500)) + ':' + hashStr(html.slice(-1500));
  if (beritaCache.articles && beritaCache.fp === fp) return beritaCache.articles;
  let articles = [];
  try {
    const sm = html.match(/<script[^>]*id=["']berita-data-src["'][^>]*>([\s\S]*?)<\/script>/i);
    if (sm) {
      const am = sm[1].match(/BERITA_DATA\s*=\s*([\s\S]*?);?\s*window\.BERITA_DATA_OK/);
      const arr = am ? am[1] : sm[1];
      const start = arr.indexOf('[');
      const end = arr.lastIndexOf(']');
      if (start >= 0 && end > start) {
        articles = parseBeritaRecords(arr.slice(start + 1, end));
      }
    }
  } catch (e) { articles = []; }
  beritaCache.fp = fp;
  beritaCache.articles = articles;
  return articles;
}

/* Memecah isi array menjadi record {...} tingkat atas dengan state machine
   yang sadar string ("..." '...' `...`) sehingga koma/kurung di dalam isi
   berita tidak salah dianggap pemisah.                                       */
function parseBeritaRecords(src) {
  const out = [];
  let depth = 0, inStr = null, esc = false, start = -1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const a = recordToArticle(src.slice(start, i + 1), out.length);
        if (a) out.push(a);
        start = -1;
      }
      continue;
    }
  }
  return out;
}

function recordToArticle(rec, idx) {
  try {
    const judul = grabField(rec, 'judul');
    if (!judul) return null;
    return {
      id: 'seed-' + (idx + 1),
      title: judul,
      slug: slugify(judul),
      tanggal: grabField(rec, 'tanggal'),
      kategori: grabField(rec, 'kategori'),
      foto: grabField(rec, 'foto'),
      isi: grabField(rec, 'isi')
    };
  } catch (e) { return null; }
}

/* Ambil satu field gaya JS: judul: "..." / '...' / `...`                     */
function grabField(rec, key) {
  try {
    const re = new RegExp('[{,\\s]' + key + '\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`[^`]*`)', 's');
    const m = rec.match(re);
    if (!m) return '';
    const raw = m[1];
    if (raw.charAt(0) === '`') return raw.slice(1, -1);
    try { return JSON.parse(raw); } catch (e) { /* bukan JSON valid */ }
    return raw.slice(1, -1);
  } catch (e) { return ''; }
}

function findSeed(key, articles) {
  const k = String(key || '').toLowerCase();
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    if (a.slug === k || a.id === k) return a;
  }
  return null;
}

/* ============================== META BUILDER =============================== */
function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function tag(kind, name, value) {
  return '<meta ' + kind + '="' + name + '" content="' + escAttr(value) + '"/>';
}

/* Deskripsi artikel: kalimat pertama-tama dari isi berita, maks ~220 char    */
function buildDescription(text, fallback) {
  let t = stripHtml(text);
  if (!t) t = stripHtml(fallback);
  if (!t) return SITE_DESC;
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length <= DESC_MAX) return t;
  const cut = t.slice(0, DESC_MAX);
  const dot = cut.lastIndexOf('. ');
  if (dot > 60) return cut.slice(0, dot + 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > 60 ? cut.slice(0, sp) : cut) + '…';
}

/* Tanggal Indonesia -> ISO 8601 (untuk article:published_time).
   Menangani: "28 September 2026", "Senin, 5 Oktober 2026.", "2 Oktober 2026" */
const BULAN_INDO = { januari: 0, februari: 1, maret: 2, april: 3, mei: 4, juni: 5, juli: 6, agustus: 7, september: 8, oktober: 9, november: 10, desember: 11 };
function isoTanggal(str) {
  let s = String(str || '').trim();
  if (!s) return '';
  s = s.replace(/^[A-Za-z]+,\s*/, '').replace(/\.$/, '').trim();
  const m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const bulan = BULAN_INDO[m[2].toLowerCase()];
    if (bulan !== undefined) {
      const d = new Date(Date.UTC(Number(m[3]), bulan, Number(m[1])));
      if (!isNaN(d)) return d.toISOString();
    }
  }
  const d = new Date(s);
  return isNaN(d) ? '' : d.toISOString();
}
function isoDate(d) { return (d && !isNaN(d)) ? d.toISOString() : ''; }

/* URL absolut -> URL proxy kompresi 1200x630 JPEG (siap untuk og:image)     */
function proxify(absUrl) {
  return IMG_PROXY + '?url=' + encodeURIComponent(absUrl)
    + '&w=' + OG_W + '&h=' + OG_H + '&fit=cover&output=jpg&q=82';
}

/* Foto artikel -> URL og:image final.
   - URL http(s) / nama file lokal: dilewatkan proxy kompresi wsrv.nl agar
     ukurannya selalu kecil (foto HP 5 MB -> ~200 KB) sehingga WhatsApp,
     Facebook, Telegram SELALU berhasil menampilkan fotonya.
   - kosong / tidak ada  : logo situs (fallback yang layak, bukan foto palsu) */
function resolveImage(foto, origin) {
  const s = String(foto || '').trim();
  if (!s) return origin + FALLBACK_IMAGE;
  let abs;
  if (/^https?:\/\//i.test(s)) abs = s;
  else if (s.indexOf('/') === 0) abs = origin + s;
  else if (s.indexOf('./') === 0) abs = origin + s.slice(1);
  else abs = origin + '/' + s.replace(/ /g, '%20');
  return proxify(abs);
}

function seedMeta(a, origin) {
  const slug = a.slug || a.id;
  return {
    title: a.title,
    description: buildDescription(a.isi || '', a.title),
    image: resolveImage(a.foto, origin),
    imageW: OG_W,
    imageH: OG_H,
    imageType: 'image/jpeg',
    imageAlt: a.title,
    url: origin + '/?berita=' + encodeURIComponent(slug),
    type: 'article',
    publishedTime: isoTanggal(a.tanggal),
    author: SITE_AUTHOR
  };
}

function defaultMeta(origin) {
  return {
    title: SITE_NAME,
    description: SITE_DESC,
    image: origin + FALLBACK_IMAGE,
    imageW: LOGO_W,
    imageH: LOGO_H,
    imageType: 'image/png',
    imageAlt: SITE_NAME,
    url: origin + '/',
    type: 'website',
    publishedTime: '',
    author: ''
  };
}

/* ==================== RESOLUSI ARTIKEL DARI FEED (RSS) ===================== */
/* Paritas dengan index.html: hashId(item.guid||item.link||title) = 'real-'+hashStr */
function extractImage(item) {
  if (!item) return '';
  if (item.thumbnail) return String(item.thumbnail);
  if (item.enclosure && item.enclosure.link && /\.(jpg|jpeg|png|webp|gif)/i.test(item.enclosure.link)) return String(item.enclosure.link);
  const html = (item.content || '') + ' ' + (item.description || '');
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m && m[1].indexOf('news.google.com') === -1) return m[1];
  const m2 = html.match(/https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)/i);
  if (m2 && m2[0].indexOf('news.google.com') === -1) return m2[0];
  return '';
}

function withTimeout(p, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(undefined); }
    );
  });
}

async function getAllFeedItems() {
  const now = Date.now();
  const lists = await Promise.all(REAL_NEWS_FEEDS.map(async (feed) => {
    const c = feedCache.get(feed.url);
    if (c && c.exp > now) return c.items;
    try {
      const res = await withTimeout(
        fetch(RSS2JSON + encodeURIComponent(feed.url), { headers: { accept: 'application/json' } }),
        FEED_TIMEOUT_MS
      );
      const data = res ? await res.json() : null;
      const items = (data && data.status === 'ok' && Array.isArray(data.items)) ? data.items : [];
      feedCache.set(feed.url, { items, exp: Date.now() + (items.length ? FEED_TTL_MS : FEED_FAIL_TTL_MS) });
      return items;
    } catch (e) {
      feedCache.set(feed.url, { items: [], exp: Date.now() + FEED_FAIL_TTL_MS });
      return [];
    }
  }));
  return lists.flat();
}

async function resolveRssMeta(key, origin) {
  const now = Date.now();
  const hit = rssMetaCache.get(key);
  if (hit && hit.exp > now) return hit.meta;
  let meta = null;
  try {
    const items = await getAllFeedItems();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it) continue;
      const id = 'real-' + hashStr(it.guid || it.link || it.title || '');
      const slug = slugify(it.title || '');
      if (id === key || (slug && slug === key)) {
        const title = stripHtml(it.title || '');
        const img = extractImage(it);
        meta = {
          title,
          description: buildDescription(stripHtml(it.content || '') + ' ' + stripHtml(it.description || ''), title),
          image: /^https?:\/\//i.test(img || '') ? proxify(img) : origin + FALLBACK_IMAGE,
          imageW: OG_W,
          imageH: OG_H,
          imageType: 'image/jpeg',
          imageAlt: title,
          url: origin + '/?berita=' + encodeURIComponent(key),
          type: 'article',
          publishedTime: isoDate(it.pubDate ? new Date(it.pubDate) : null),
          author: it.author ? stripHtml(String(it.author)).slice(0, 80) : ''
        };
        break;
      }
    }
  } catch (e) { meta = null; }
  try { rssMetaCache.set(key, { meta, exp: now + (meta ? META_TTL_MS : META_NEG_TTL_MS) }); } catch (e) {}
  return meta;
}

/* ===================== INJEKSI META KE HTML (server-side) ================== */
function metaBlock(m) {
  const parts = [];
  parts.push(tag('property', 'og:title', m.title));
  parts.push(tag('property', 'og:description', m.description));
  parts.push(tag('property', 'og:image', m.image));
  if (m.imageW && m.imageH) {
    parts.push(tag('property', 'og:image:width', String(m.imageW)));
    parts.push(tag('property', 'og:image:height', String(m.imageH)));
  }
  if (m.imageType) parts.push(tag('property', 'og:image:type', m.imageType));
  parts.push(tag('property', 'og:image:alt', m.imageAlt || m.title));
  parts.push(tag('property', 'og:url', m.url));
  parts.push(tag('property', 'og:type', m.type || 'article'));
  parts.push(tag('property', 'og:site_name', SITE_NAME));
  parts.push(tag('property', 'og:locale', 'id_ID'));
  if (m.publishedTime) {
    parts.push(tag('property', 'article:published_time', m.publishedTime));
    parts.push(tag('property', 'article:author', m.author || SITE_AUTHOR));
  }
  parts.push('<meta name="twitter:card" content="summary_large_image"/>');
  parts.push(tag('name', 'twitter:title', m.title));
  parts.push(tag('name', 'twitter:description', m.description));
  parts.push(tag('name', 'twitter:image', m.image));
  parts.push('<link rel="canonical" href="' + escAttr(m.url) + '"/>');
  parts.push(tag('name', 'description', m.description));
  return '\n<!-- ===== OPEN GRAPH / TWITTER CARD: dibuat otomatis oleh worker.js sesuai artikel ===== -->\n'
    + parts.join('\n') + '\n';
}

function injectMeta(html, meta) {
  const fullTitle = (meta.type === 'article')
    ? (meta.title + ' - ' + SITE_NAME)
    : SITE_TITLE_HOME;
  let out = html
    .replace(/<meta[^>]+property=["']og:[^>]*>/gi, '')
    .replace(/<meta[^>]+property=["']article:[^>]*>/gi, '')
    .replace(/<meta[^>]+name=["']twitter:[^>]*>/gi, '')
    .replace(/<meta[^>]+name=["']description["'][^>]*>/gi, '')
    .replace(/<link[^>]+rel=["']canonical["'][^>]*>/gi, '')
    .replace(/<title>[\s\S]*?<\/title>/i, () => '<title>' + escAttr(fullTitle) + '</title>');
  const block = metaBlock(meta);
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, () => block + '</head>');
  else out = block + out;
  return out;
}

async function resolveMeta(key, articles, origin) {
  const k = String(key || '').trim().toLowerCase();
  if (k) {
    const seed = findSeed(k, articles);
    if (seed) return seedMeta(seed, origin);
    const rss = await resolveRssMeta(k, origin);
    if (rss) return rss;
  }
  return defaultMeta(origin);
}

/* ================================ HANDLER ================================== */
export default {
  async fetch(request, env, ctx) {
    let res;
    try {
      res = await env.ASSETS.fetch(request);
    } catch (e) {
      return new Response('Service Unavailable', { status: 503 });
    }
    try {
      if (request.method !== 'GET') return res;
      const ctype = (res.headers.get('content-type') || '').toLowerCase();
      if (!ctype.includes('text/html')) return res;
      const url = new URL(request.url);
      const html = await res.text();
      const articles = extractArticles(html);
      /* Artikel bisa diakses lewat ?berita=<slug> ATAU jalur /berita/<slug> */
      let key = url.searchParams.get('berita') || '';
      if (!key) {
        const pm = url.pathname.match(/^\/berita\/(.+)$/i);
        if (pm) { try { key = decodeURIComponent(pm[1]); } catch (e2) { key = pm[1]; } }
      }
      const meta = await resolveMeta(key, articles, url.origin);
      const out = injectMeta(html, meta);
      const headers = new Headers(res.headers);
      headers.delete('content-length');
      headers.delete('etag');
      headers.delete('last-modified');
      return new Response(out, { status: res.status, statusText: res.statusText, headers });
    } catch (e) {
      return res; /* apa pun yang terjadi, halaman asli tetap dikirim */
    }
  }
};

/* Diekspor khusus untuk pengujian lokal (Node). Tidak memengaruhi produksi.  */
export const _internals = {
  hashStr, slugify, stripHtml, extractArticles, parseBeritaRecords, grabField,
  findSeed, buildDescription, isoTanggal, resolveImage, proxify, injectMeta, metaBlock,
  extractImage, resolveMeta, seedMeta, defaultMeta,
  _resetCaches() {
    beritaCache.fp = ''; beritaCache.articles = null;
    feedCache.clear(); rssMetaCache.clear();
  }
};
