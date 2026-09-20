**
 * news-proxy.js
 * 热点新闻速览 · 本地代理服务器
 *
 * 启动方式：
 *   node news-proxy.js          # 默认端口 3210
 *   node news-proxy.js 8080     # 自定义端口
 *
 * 提供 API：
 *   GET /api/news          → { nation:[...], hunan:[...] }  今日新闻（全国 + 湖南）
 *   GET /api/status        → { nationFetched, hunanFetched, lastUpdate, uptime }
 *   GET /                  → 返回 hot-news-dashboard.html
 *
 * 数据来源：人民日报、新华网、中国政府网、央广网、光明网、中国经济网、中国新闻网
 * 注意：国内 RSS 源受网络环境影响，部分可能超时，服务器会降级返回缓存数据
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ── 配置 ─────────────────────────────────────────────────────────────
const PORT       = parseInt(process.argv[2]) || 3210;
const CACHE_TTL  = 30 * 60 * 1000;   // 缓存 30 分钟
const TIMEOUT    = 8000;             // 单个 RSS 请求超时 8s
const HTML_FILE  = 'hot-news-dashboard.html';

// ── RSS 源配置 ────────────────────────────────────────────────────────
const RSS_FEEDS = {
  // 全国新闻（政府/主流媒体）
  nation: [
    { name: '人民日报',   url: 'http://rss.people.com.cn/rss/people_main.xml' },
    { name: '新华网',     url: 'http://www.xinhuanet.com/rss/politics.xml' },
    { name: '中国政府网', url: 'http://www.gov.cn/rss/homepage.xml' },
    { name: '央广网',     url: 'http://www.cnr.cn/rss/china_news.xml' },
    { name: '光明网',     url: 'http://rss.gmw.cn/rss/guangming.xml' },
    { name: '中国经济网', url: 'http://rss.ce.cn/rss/rssrollnews.xml' },
    { name: '中国新闻网', url: 'http://www.chinanews.com.cn/rss/roll-news.xml' },
  ],
  // 湖南新闻
  hunan: [
    { name: '红网',       url: 'http://hunan.rednet.cn/rss/hunanNews.xml' },
    { name: '华声在线',   url: 'https://voc.com.cn/rss/hunansz.xml' },
    { name: '湖南日报',   url: 'http://hnrss.hnol.net/rss/hnrss.xml' },
    { name: '湖南省政府', url: 'https://www.hunan.gov.cn/rss/index.xml' },
  ],
};

// ── 内存缓存 ──────────────────────────────────────────────────────────
let cache = { nation: [], hunan: [], fetchedAt: null };

// ── 工具函数 ──────────────────────────────────────────────────────────
function nowISO()  { return new Date().toISOString(); }
function today()   { return new Date().toISOString().slice(0, 10); }
function yesterday(){ return new Date(Date.now() - 86400000).toISOString().slice(0, 10); }

// 解析 RSS XML → 新闻条目数组
function parseRSS(xml, sourceName) {
  const items = [];
  // 匹配 <item>...</item>
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title  = extract(block, 'title')?.trim() || '';
    const link   = extract(block, 'link') || '';
    const date   = extract(block, 'pubDate') || extract(block, 'dc:date') || '';
    const desc   = extract(block, 'description') || '';
    if (title && !title.startsWith('<?xml') && title.length > 6) {
      // 提取日期
      let cleanDate = '';
      const dateMatch = date.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/);
      if (dateMatch) cleanDate = dateMatch[0];
      items.push({
        title:  cleanHTML(title),
        source: sourceName,
        date:   cleanDate || today(),
        type:   inferType(title, sourceName),
        url:    link || '#',
        desc:   cleanHTML(desc.slice(0, 200)),
      });
    }
  }
  return items;
}

function extract(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m  = xml.match(re);
  return m ? m[1].trim() : null;
}

function cleanHTML(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferType(title, source) {
  const t = title + ' ' + source;
  if (/北斗|人工智能|AI|科技|创新|研发|专利|芯片|量子/.test(t)) return 'tech';
  if (/习近平|两会|总书记|政策|国务院|中央|会议|外交/.test(t)) return 'poli';
  if (/文化|文艺|非遗|节日|历史|博物馆|旅游/.test(t)) return 'cult';
  if (/教育|医疗|社保|住房|就业|民生/.test(t)) return 'soc';
  return 'hot';
}

// 抓取单个 RSS（使用内置 http，不走代理）
async function fetchRSS(url, timeout = TIMEOUT) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    const protocol = url.startsWith('https') ? require('https') : require('http');
    protocol.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (res) => {
      clearTimeout(timer);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 跟随重定向（简单处理）
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        fetchRSS(redirectUrl, timeout).then(resolve);
        return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const xml = Buffer.isBuffer(data) ? data.toString('utf8') : data;
          resolve(xml);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ── 核心：获取新闻 ──────────────────────────────────────────────────────
async function fetchNews() {
  const results = { nation: [], hunan: [] };
  const todayStr = today();
  const yestStr  = yesterday();
  const cutoff   = new Date(todayStr).getTime() - 86400000 * 3; // 3天内的新闻

  // 并发抓取所有 RSS
  const tasks = [
    ...RSS_FEEDS.nation.map(f =>
      fetchRSS(f.url).then(xml => ({ key: 'nation', xml, source: f.name }))
    ),
    ...RSS_FEEDS.hunan.map(f =>
      fetchRSS(f.url).then(xml => ({ key: 'hunan', xml, source: f.name }))
    ),
  ];

  const responses = await Promise.allSettled(tasks);
  for (const r of responses) {
    if (r.status !== 'fulfilled' || !r.value.xml) continue;
    const { key, xml, source } = r.value;
    const items = parseRSS(xml, source);
    // 只保留今天或昨天的
    const filtered = items.filter(it => {
      const ts = new Date(it.date).getTime();
      return ts >= cutoff;
    });
    results[key] = results[key].concat(filtered);
  }

  // 去重（按标题相似度）
  results.nation = dedupe(results.nation, 30);
  results.hunan  = dedupe(results.hunan, 20);
  results.fetchedAt = nowISO();

  // 写入缓存
  cache = results;
  return results;
}

function dedupe(items, limit) {
  const seen = new Set();
  return items.filter(it => {
    const key = it.title.slice(0, 12);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

// ── HTTP 服务器 ─────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;

  // 设置 CORS
  const setCORS = () => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  };
  setCORS();

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── 首页：返回 HTML ──
  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(__dirname, HTML_FILE);
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(htmlPath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('hot-news-dashboard.html not found');
    }
    return;
  }

  // ── API：获取新闻 ──
  if (pathname === '/api/news') {
    // 如果缓存过期或为空，重新抓取
    const now = Date.now();
    if (!cache.fetchedAt || (now - new Date(cache.fetchedAt).getTime()) > CACHE_TTL) {
      console.log(`[${new Date().toLocaleTimeString()}] 正在获取最新新闻...`);
      try {
        await fetchNews();
      } catch (e) {
        console.error('获取新闻失败:', e.message);
      }
    }
    const resp = {
      nation:   cache.nation,
      hunan:    cache.hunan,
      meta: {
        nationCount: cache.nation.length,
        hunanCount:  cache.hunan.length,
        total:       cache.nation.length + cache.hunan.length,
        fetchedAt:   cache.fetchedAt || null,
        source:      'news-proxy',
        note:        cache.nation.length === 0 && cache.hunan.length === 0
          ? '网络环境限制，暂无实时数据。请检查网络连接或稍后重试。'
          : '',
      },
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(resp, null, 2));
    return;
  }

  // ── API：状态 ──
  if (pathname === '/api/status') {
    const resp = {
      nationFetched: cache.nation.length > 0,
      hunanFetched:  cache.hunan.length > 0,
      lastUpdate:    cache.fetchedAt || null,
      nationCount:   cache.nation.length,
      hunanCount:    cache.hunan.length,
      uptime:        Math.floor(process.uptime()),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(resp));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
});

// ── 启动 ────────────────────────────────────────────────────────────────
server.listen(PORT, '127.0.0.1', async () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║     热点新闻速览 · 本地代理服务器已启动                    ║
║                                                          ║
║  仪表盘地址:  http://127.0.0.1:${PORT}                    ║
║  API 端点:    http://127.0.0.1:${PORT}/api/news           ║
║  状态查询:    http://127.0.0.1:${PORT}/api/status         ║
║                                                          ║
║  数据源：人民日报 / 新华网 / 中国政府网 / 央广网            ║
║         红网 / 华声在线 / 湖南日报                         ║
║  更新频率：首次加载时抓取，每 30 分钟自动更新              ║
╚══════════════════════════════════════════════════════════╝
  `);
  // 初始抓取（后台执行）
  fetchNews().catch(e => console.error('初始抓取失败:', e.message));
});

// 定期刷新
setInterval(async () => {
  console.log(`[${new Date().toLocaleTimeString()}] 定时刷新新闻...`);
  try {
    await fetchNews();
  } catch (e) {
    console.error('定时刷新失败:', e.message);
  }
}, CACHE_TTL);

process.on('SIGINT', () => {
  console.log('\n服务器已停止');
  process.exit(0);
});
