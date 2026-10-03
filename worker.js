const SESSION_COOKIE = 'cx_admin_session';
const SESSION_TTL = 60 * 60 * 24 * 7;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function html(text, status = 200) {
  return new Response(text, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function parseCookies(request) {
  const raw = request.headers.get('Cookie') || '';
  return Object.fromEntries(raw.split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf('=');
    return [i < 0 ? v : v.slice(0, i), i < 0 ? '' : decodeURIComponent(v.slice(i + 1))];
  }));
}

function base64url(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return base64url(sig);
}

async function createSession(env) {
  const payload = `${Date.now() + SESSION_TTL * 1000}`;
  const sig = await hmac(env.SESSION_SECRET, payload);
  return `${base64url(new TextEncoder().encode(payload))}.${sig}`;
}

async function validSession(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token || !env.SESSION_SECRET) return false;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return false;
  try {
    const payload = new TextDecoder().decode(base64urlDecode(encoded));
    const expires = Number(payload);
    if (!Number.isFinite(expires) || expires < Date.now()) return false;
    const expected = await hmac(env.SESSION_SECRET, payload);
    const a = new TextEncoder().encode(sig);
    const b = new TextEncoder().encode(expected);
    if (a.length !== b.length) return false;
    return crypto.subtle.timingSafeEqual ? crypto.subtle.timingSafeEqual(a, b) : sig === expected;
  } catch { return false; }
}

function slugify(input) {
  return input.toLowerCase().trim().normalize('NFKD').replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || `post-${Date.now()}`;
}

function authHeaders(token) {
  return {
    'Set-Cookie': `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`
  };
}

async function requireAuth(request, env) {
  if (!(await validSession(request, env))) return json({ error: 'Unauthorized' }, 401);
  return null;
}

async function api(request, env, url) {
  if (url.pathname === '/api/login' && request.method === 'POST') {
    if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return json({ error: 'Admin secrets are not configured.' }, 500);
    const body = await request.json().catch(() => ({}));
    if (typeof body.password !== 'string' || body.password.length < 1) return json({ error: 'Password required.' }, 400);
    if (body.password !== env.ADMIN_PASSWORD) return json({ error: 'Invalid password.' }, 401);
    const token = await createSession(env);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', ...authHeaders(token) } });
  }

  if (url.pathname === '/api/logout' && request.method === 'POST') {
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } });
  }

  if (url.pathname === '/api/me' && request.method === 'GET') return json({ authenticated: await validSession(request, env) });

  if (url.pathname === '/api/posts' && request.method === 'GET') {
    const admin = await validSession(request, env);
    const status = url.searchParams.get('status');
    let result;
    if (admin) {
      result = status ? await env.DB.prepare('SELECT * FROM posts WHERE status = ? ORDER BY updated_at DESC').bind(status).all() : await env.DB.prepare('SELECT * FROM posts ORDER BY updated_at DESC').all();
    } else {
      result = await env.DB.prepare('SELECT id,title,slug,content,image_url,category,published_at FROM posts WHERE status = ? ORDER BY published_at DESC').bind('published').all();
    }
    return json(result.results || []);
  }

  if (url.pathname.startsWith('/api/posts/') && request.method === 'GET') {
    const slug = decodeURIComponent(url.pathname.slice('/api/posts/'.length));
    const post = await env.DB.prepare('SELECT * FROM posts WHERE slug = ?').bind(slug).first();
    if (!post || (post.status !== 'published' && !(await validSession(request, env)))) return json({ error: 'Not found' }, 404);
    return json(post);
  }

  if (url.pathname === '/api/posts' && request.method === 'POST') {
    const denied = await requireAuth(request, env); if (denied) return denied;
    const body = await request.json().catch(() => ({}));
    const title = String(body.title || '').trim();
    const content = String(body.content || '').trim();
    const category = String(body.category || 'General').trim().slice(0, 80) || 'General';
    const image_url = String(body.image_url || '').trim().slice(0, 2000) || null;
    const status = body.status === 'published' ? 'published' : 'draft';
    if (!title || !content) return json({ error: 'Title and content are required.' }, 400);
    let slug = slugify(body.slug || title);
    const collision = await env.DB.prepare('SELECT id FROM posts WHERE slug = ?').bind(slug).first();
    if (collision) slug = `${slug}-${Date.now()}`;
    const publishedAt = status === 'published' ? new Date().toISOString() : null;
    const result = await env.DB.prepare('INSERT INTO posts (title,slug,content,image_url,category,status,published_at) VALUES (?,?,?,?,?,?,?)')
      .bind(title, slug, content, image_url, category, status, publishedAt).run();
    return json({ ok: true, id: result.meta.last_row_id, slug }, 201);
  }

  if (url.pathname.startsWith('/api/posts/') && request.method === 'PUT') {
    const denied = await requireAuth(request, env); if (denied) return denied;
    const id = Number(url.pathname.split('/').pop());
    const body = await request.json().catch(() => ({}));
    const title = String(body.title || '').trim();
    const content = String(body.content || '').trim();
    const category = String(body.category || 'General').trim().slice(0, 80) || 'General';
    const image_url = String(body.image_url || '').trim().slice(0, 2000) || null;
    const status = body.status === 'published' ? 'published' : 'draft';
    if (!Number.isInteger(id) || !title || !content) return json({ error: 'Invalid post.' }, 400);
    const existing = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first();
    if (!existing) return json({ error: 'Post not found.' }, 404);
    const publishedAt = status === 'published' ? (existing.published_at || new Date().toISOString()) : null;
    await env.DB.prepare('UPDATE posts SET title=?,content=?,image_url=?,category=?,status=?,published_at=?,updated_at=datetime(\'now\') WHERE id=?')
      .bind(title, content, image_url, category, status, publishedAt, id).run();
    return json({ ok: true });
  }

  if (url.pathname.startsWith('/api/posts/') && request.method === 'DELETE') {
    const denied = await requireAuth(request, env); if (denied) return denied;
    const id = Number(url.pathname.split('/').pop());
    if (!Number.isInteger(id)) return json({ error: 'Invalid id.' }, 400);
    await env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return api(request, env, url);

    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      const asset = await env.ASSETS.fetch(new Request(new URL('/admin/index.html', request.url), request));
      return asset;
    }

    return env.ASSETS.fetch(request);
  }
};
