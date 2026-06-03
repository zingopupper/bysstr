const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const url = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

function resolveUrl(base, relative) {
  try { return new url.URL(relative, base).href; } catch { return null; }
}

function proxyUrl(targetUrl) {
  if (!targetUrl || targetUrl.startsWith('data:') || targetUrl.startsWith('javascript:') || targetUrl.startsWith('#') || targetUrl.startsWith('mailto:')) return targetUrl;
  return `/proxy?url=${encodeURIComponent(targetUrl)}`;
}

// Rotate user agents to avoid blocks
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
];
function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }

app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'No URL provided' });

  let fullUrl = targetUrl;
  if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) fullUrl = 'https://' + fullUrl;

  try {
    const response = await axios.get(fullUrl, {
      timeout: 20000,
      maxRedirects: 10,
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': randomUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
        'DNT': '1',
      },
      validateStatus: () => true,
    });

    const contentType = response.headers['content-type'] || '';
    const finalUrl = response.request?.res?.responseUrl || fullUrl;

    // Non-HTML: pass through directly (images, CSS, JS, fonts, etc.)
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      res.removeHeader('X-Frame-Options');
      res.removeHeader('Content-Security-Policy');
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'public, max-age=3600');
      return res.send(response.data);
    }

    let html = response.data.toString('utf-8');
    const $ = cheerio.load(html);
    const baseUrl = finalUrl;

    // Strip security meta tags
    $('meta[http-equiv="Content-Security-Policy"]').remove();
    $('meta[http-equiv="X-Frame-Options"]').remove();
    $('meta[http-equiv="x-frame-options"]').remove();

    // Rewrite <a href>
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const resolved = resolveUrl(baseUrl, href);
      if (resolved) { $(el).attr('href', proxyUrl(resolved)); $(el).attr('target', '_self'); }
    });

    // Rewrite src
    $('[src]').each((_, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      const resolved = resolveUrl(baseUrl, src);
      if (resolved) $(el).attr('src', proxyUrl(resolved));
    });

    // Rewrite srcset
    $('[srcset]').each((_, el) => {
      const srcset = $(el).attr('srcset');
      if (!srcset) return;
      const rewritten = srcset.split(',').map(part => {
        const trimmed = part.trim();
        const [srcPart, ...rest] = trimmed.split(/\s+/);
        const resolved = resolveUrl(baseUrl, srcPart);
        return resolved ? [proxyUrl(resolved), ...rest].join(' ') : part;
      }).join(', ');
      $(el).attr('srcset', rewritten);
    });

    // Rewrite <link href>
    $('link[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const resolved = resolveUrl(baseUrl, href);
      if (resolved) $(el).attr('href', proxyUrl(resolved));
    });

    // Rewrite form actions
    $('form').each((_, el) => {
      const action = $(el).attr('action') || baseUrl;
      const resolved = resolveUrl(baseUrl, action);
      if (resolved) $(el).attr('action', `/proxy?url=${encodeURIComponent(resolved)}`);
      // Keep method as-is (GET forms will work; POST forms are harder)
    });

    // Rewrite inline style url()
    $('[style]').each((_, el) => {
      let style = $(el).attr('style') || '';
      style = style.replace(/url\(['"]?(.*?)['"]?\)/g, (match, u) => {
        const resolved = resolveUrl(baseUrl, u);
        return resolved ? `url('${proxyUrl(resolved)}')` : match;
      });
      $(el).attr('style', style);
    });

    // Rewrite <style> tag url() references
    $('style').each((_, el) => {
      let css = $(el).html() || '';
      css = css.replace(/url\(['"]?(.*?)['"]?\)/g, (match, u) => {
        if (u.startsWith('data:')) return match;
        const resolved = resolveUrl(baseUrl, u);
        return resolved ? `url('${proxyUrl(resolved)}')` : match;
      });
      $(el).html(css);
    });

    // Inject intercept script
    const interceptScript = `<script>
(function() {
  var BASE = ${JSON.stringify(baseUrl)};
  function proxyize(u) {
    if (!u || u.startsWith('data:') || u.startsWith('javascript:') || u.startsWith('#') || u.startsWith('mailto:') || u.startsWith('/proxy')) return u;
    try {
      var abs = new URL(u, BASE).href;
      return '/proxy?url=' + encodeURIComponent(abs);
    } catch(e) { return u; }
  }
  function notify(type, payload) {
    try { window.parent.postMessage(Object.assign({type: type}, payload), '*'); } catch(e) {}
  }
  // history interception
  var oPS = history.pushState.bind(history);
  var oRS = history.replaceState.bind(history);
  history.pushState = function(s,t,u) { oPS(s,t,u); if(u) notify('navigate',{url: new URL(u, location.href).href}); };
  history.replaceState = function(s,t,u) { oRS(s,t,u); if(u) notify('navigate',{url: new URL(u, location.href).href}); };
  // fetch interception
  var oFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') input = proxyize(input);
    else if (input instanceof Request) { input = new Request(proxyize(input.url), input); }
    return oFetch(input, init);
  };
  // XHR interception
  var oOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url2) {
    arguments[1] = proxyize(url2);
    return oOpen.apply(this, arguments);
  };
  // Send title + url on load
  window.addEventListener('load', function() {
    notify('title', {title: document.title});
    notify('navigate', {url: BASE});
  });
})();
</script>`;

    $('head').prepend(interceptScript);

    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    return res.send($.html());

  } catch (err) {
    console.error('Proxy error:', err.message);
    const statusCode = err.response?.status || 500;
    return res.status(statusCode).send(`<!DOCTYPE html>
<html><head><style>
  body { font-family: -apple-system, sans-serif; background: #0e0e10; color: #e8e8f0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .box { background: #18181c; border: 1px solid #2e2e38; border-radius: 12px; padding: 2rem 2.5rem; max-width: 480px; text-align: center; }
  h2 { font-size: 20px; margin-bottom: 12px; color: #f87171; }
  p { font-size: 14px; color: #7a7a8e; margin: 6px 0; }
  code { background: #222; padding: 2px 6px; border-radius: 4px; font-size: 12px; color: #a78bfa; }
  .reason { margin-top: 1rem; font-size: 13px; color: #f59e0b; }
</style></head><body>
<div class="box">
  <h2>⚠ Page could not be loaded</h2>
  <p><code>${escapeHtml(fullUrl)}</code></p>
  <p class="reason">${escapeHtml(err.message)}</p>
  <p style="margin-top:1rem">This site may block proxy access, require login, or use heavy JavaScript. Try another URL.</p>
</div>
</body></html>`);
  }
});

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Search endpoint — uses DuckDuckGo (allows server-side fetching unlike Google)
app.get('/search', (req, res) => {
  const query = req.query.q;
  if (!query) return res.redirect('/');
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  res.redirect(`/proxy?url=${encodeURIComponent(ddgUrl)}`);
});

app.listen(PORT, () => console.log(`Proxy browser running on port ${PORT}`));
