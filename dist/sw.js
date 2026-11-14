/* 私房菜谱 service worker
 * 策略：
 *   页面        网络优先，断网时用缓存的 index.html（离线也能逛缓存过的菜谱）
 *   构建产物     缓存优先（文件名带 hash，换了自然失效）
 *   菜谱图片    先用缓存 + 后台更新（图片压缩换代后，下次访问就是新图）
 * 改了这份文件或图片换代时，把 VERSION 往上加一格。
 */

const VERSION = 'recipe-v2'
const SHELL_CACHE = `${VERSION}-shell`
const ASSET_CACHE = `${VERSION}-asset`
const IMG_CACHE = `${VERSION}-img`
const MAX_IMG = 500

const SHELL_URLS = [
  './',
  './manifest.webmanifest',
  './favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const c = await caches.open(SHELL_CACHE)
      await Promise.allSettled(
        SHELL_URLS.map((u) => c.add(new Request(u, { cache: 'reload' }))),
      )
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => !k.startsWith('recipe-')).map((k) => caches.delete(k)))
      await Promise.all(
        keys
          .filter((k) => k.startsWith('recipe-') && !k.startsWith(VERSION))
          .map((k) => caches.delete(k)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

function isImage(url) {
  return url.pathname.includes('/images/') || /\.(webp|png|jpe?g|gif|svg)$/i.test(url.pathname)
}

function isAsset(url) {
  return url.pathname.includes('/assets/')
}

async function put(c, req, res) {
  if (res && res.ok && res.type === 'basic') {
    try {
      await c.put(req, res.clone())
    } catch {
      /* 缓存写满或被拒，忽略 */
    }
  }
}

async function trim(c, max) {
  const keys = await c.keys()
  if (keys.length <= max) return
  await Promise.all(keys.slice(0, keys.length - max).map((k) => c.delete(k)))
}

async function cacheFirst(req, cacheName) {
  const c = await caches.open(cacheName)
  const hit = await c.match(req)
  if (hit) return hit
  return fetch(req)
    .then(async (res) => {
      await put(c, req, res)
      return res
    })
    .catch(() => Response.error())
}

async function staleWhileRevalidate(req, cacheName, max) {
  const c = await caches.open(cacheName)
  const hit = await c.match(req)
  const refreshing = fetch(req)
    .then(async (res) => {
      await put(c, req, res)
      if (max) await trim(c, max)
      return res
    })
    .catch(() => null)
  if (hit) return hit
  const res = await refreshing
  return res || Response.error()
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(async (res) => {
          const c = await caches.open(SHELL_CACHE)
          try {
            await c.put('./', res.clone())
          } catch {
            /* ignore */
          }
          return res
        })
        .catch(async () => (await caches.match('./')) || Response.error()),
    )
    return
  }

  if (isImage(url)) {
    event.respondWith(staleWhileRevalidate(req, IMG_CACHE, MAX_IMG))
    return
  }

  if (isAsset(url)) {
    event.respondWith(cacheFirst(req, ASSET_CACHE))
    return
  }

  event.respondWith(staleWhileRevalidate(req, SHELL_CACHE, 40))
})
