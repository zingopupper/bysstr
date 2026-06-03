const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const url = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

// Helper: resolve relative URL to absolute
function resolveUrl(base, relative) {
  try {
    return new url.URL(relative, base).href;
  } catch {
    return null;
  }
}

// Helper: rewrite a URL to go through the proxy
function proxyUrl(targetUrl) {
  if (!targetUrl || targetUrl.startsWith('data:') || targetUrl.startsWith('javascript:') || targetUrl.startsWith('#') || targetUrl.startsWith('mailto:')) {
    return targetUrl;
  }
  return `/proxy?url=${encodeURIComponent(targetUrl)}`;
}

// Main proxy endpoint
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({ error: 'No URL provided' });
  }

  let fullUrl = targetUrl;
  if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
    fullUrl = 'https://' + fullUrl;
  }

  try {
    const response = await axios.get(fullUrl, {
      timeout: 15000,
      maxRedirects: 5,
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
      validateStatus: () => true,
    });

    const contentType = response.headers['content-type'] || '';
    const finalUrl = response.request?.res?.responseUrl || fullUrl;

    // If it's not HTML, stream it directly (images, CSS, fonts, etc.)
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'public, max-age=3600');
      // Remove security headers that would block embedding
      res.removeHeader('X-Frame-Options');
      res.removeHeader('Content-Security-Policy');
      return res.send(response.data);
    }

    // Parse HTML
    let html = response.data.toString('utf-8');
    const $ = cheerio.load(html);
    const baseUrl = finalUrl;

    // Remove CSP and X-Frame-Options meta tags
    $('meta[http-equiv="Content-Security-Policy"]').remove();
    $('meta[http-equiv="X-Frame-Options"]').remove();

    // Rewrite all links so they stay in the proxy
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const resolved = resolveUrl(baseUrl, href);
      if (resolved) {
        $(el).attr('href', proxyUrl(resolved));
        $(el).attr('target', '_self');
      }
    });

    // Rewrite src attributes (img, script, iframe, video, audio, source)
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
        if (resolved) return [proxyUrl(resolved), ...rest].join(' ');
        return part;
      }).join(', ');
      $(el).attr('srcset', rewritten);
    });

    // Rewrite CSS link hrefs
    $('link[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const resolved = resolveUrl(baseUrl, href);
      if (resolved) $(el).attr('href', proxyUrl(resolved));
    });

    // Rewrite action attributes on forms
    $('form[action]').each((_, el) => {
      const action = $(el).attr('action');
      if (!action) return;
      const resolved = resolveUrl(baseUrl, action);
      if (resolved) {
        $(el).attr('action', `/proxy?url=${encodeURIComponent(resolved)}`);
        $(el).attr('method', 'get');
      }
    });

    // Rewrite inline style background-image, etc.
    $('[style]').each((_, el) => {
      let style = $(el).attr('style');
      if (!style) return;
      style = style.replace(/url\(['"]?(.*?)['"]?\)/g, (match, u) => {
        const resolved = resolveUrl(baseUrl, u);
        return resolved ? `url('${proxyUrl(resolved)}')` : match;
      });
      $(el).attr('style', style);
    });

    // Inject script to intercept JS-driven navigation & notify parent frame of URL changes
    const interceptScript = `
      <script>
        (function() {
          // Override window.location changes
          const origPushState = history.pushState.bind(history);
          const origReplaceState = history.replaceState.bind(history);

          function notifyParent(u) {
            try { window.parent.postMessage({ type: 'navigate', url: u }, '*'); } catch(e) {}
          }

          history.pushState = function(state, title, u) {
            origPushState(state, title, u);
            if (u) notifyParent(new URL(u, window.location.href).href);
          };
          history.replaceState = function(state, title, u) {
            origReplaceState(state, title, u);
            if (u) notifyParent(new URL(u, window.location.href).href);
          };

          // Intercept fetch & XHR to rewrite outbound URLs through proxy
          const origFetch = window.fetch;
          window.fetch = function(input, init) {
            if (typeof input === 'string' && input.startsWith('http')) {
              input = '/proxy?url=' + encodeURIComponent(input);
            }
            return origFetch(input, init);
          };

          // Notify parent of current URL on load
          window.addEventListener('load', function() {
            notifyParent(window.location.href);
          });

          // Notify parent of page title
          window.addEventListener('load', function() {
            try { window.parent.postMessage({ type: 'title', title: document.title }, '*'); } catch(e) {}
          });
        })();
      </script>
    `;

    $('head').prepend(interceptScript);

    // Send rewritten HTML
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    return res.send($.html());

  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).send(`
      <html><body style="font-family:sans-serif;padding:2rem;background:#fff;">
        <h2>Could not load page</h2>
        <p><strong>URL:</strong> ${fullUrl}</p>
        <p><strong>Error:</strong> ${err.message}</p>
        <p>Some sites block proxy access. Try a different URL.</p>
      </body></html>
    `);
  }
});

// Search redirect endpoint — goes to Google through proxy
app.get('/search', (req, res) => {
  const query = req.query.q;
  if (!query) return res.redirect('/');
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  res.redirect(`/proxy?url=${encodeURIComponent(googleUrl)}`);
});

app.listen(PORT, () => {
  console.log(`Proxy browser running on port ${PORT}`);
});
