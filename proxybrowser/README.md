# ProxyBrowser

A full browser-in-a-webpage proxy that keeps all navigation within your site. Built with Node.js + Express.

## Features
- Full tabbed browser UI (open, close, switch tabs)
- Back / Forward / Refresh / Home navigation
- URL bar + search (auto-routes queries to Google)
- All links rewritten to stay within the proxy — the URL never leaves your domain
- JS-driven navigation intercepted via injected scripts
- Loading progress bar + status bar

---

## Deploy to Render (Free)

### Step 1 — Push to GitHub

1. Create a new repo on [github.com](https://github.com)
2. In your terminal:

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### Step 2 — Deploy on Render

1. Go to [render.com](https://render.com) and sign up (free, no credit card)
2. Click **New → Web Service**
3. Connect your GitHub account and select your repo
4. Render will auto-detect `render.yaml` — just click **Deploy**
5. Wait ~2 minutes for the build to finish
6. Your proxy browser will be live at `https://your-app-name.onrender.com`

### Manual Setup (if render.yaml isn't picked up)
- **Environment**: Node
- **Build command**: `npm install`
- **Start command**: `node server.js`
- **Plan**: Free

---

## Local Development

```bash
npm install
npm run dev   # uses nodemon for auto-reload
```

Then open `http://localhost:3000`

---

## How It Works

1. User types a URL or search query in the browser UI
2. The frontend loads it into an `<iframe>` pointed at `/proxy?url=TARGET`
3. The server fetches the page server-side (bypassing client CORS/iframe restrictions)
4. Cheerio rewrites all `href`, `src`, `srcset`, `action`, and `style` attributes so every link/resource goes through `/proxy?url=...`
5. A script is injected to intercept `history.pushState` / `replaceState` and `fetch` calls
6. The rewritten HTML is returned — the URL in your browser's address bar never changes

---

## Limitations

- Some sites use heavy client-side JS that re-fetches URLs directly (e.g. SPAs) — these may partially break
- Sites with aggressive CSP headers may block some resources
- Free Render instances spin down after 15 min of inactivity (first load may take ~30s to wake up)
  - Fix: use [UptimeRobot](https://uptimerobot.com) (free) to ping your URL every 5 minutes

---

## File Structure

```
proxybrowser/
├── server.js          # Express proxy server
├── package.json
├── render.yaml        # Render deploy config
├── .gitignore
└── public/
    └── index.html     # Browser UI frontend
```
