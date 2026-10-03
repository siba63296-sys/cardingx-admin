# CardingX Cloudflare Admin Panel

This package keeps the supplied static `index.html` as the public homepage and adds a Cloudflare Worker + D1 powered `/admin` panel.

## What is included
- `public/index.html` — original homepage from the supplied ZIP.
- `public/admin/index.html` — admin login + post editor.
- `src/worker.js` — API, session auth, D1 CRUD, and `/admin` routing.
- `migrations/0001_create_posts.sql` — D1 `posts` table.
- `wrangler.toml` — Worker, Assets and D1 configuration template.

## Important
The D1 database ID/name in `wrangler.toml` are placeholders. Replace them with your existing D1 database values. Do not put the admin password in this file.

## Deploy
1. Install Node.js and Wrangler: `npm install -g wrangler`
2. Run `wrangler login`.
3. Edit `wrangler.toml` and replace `REPLACE_WITH_YOUR_D1_DATABASE_NAME` and `REPLACE_WITH_YOUR_D1_DATABASE_ID`.
4. Apply the migration remotely: `npx wrangler d1 migrations apply REPLACE_WITH_YOUR_D1_DATABASE_NAME --remote`
5. Create secrets:
   - `npx wrangler secret put ADMIN_PASSWORD`
   - `npx wrangler secret put SESSION_SECRET`
   Use a long random value for `SESSION_SECRET`.
6. Deploy: `npx wrangler deploy`

## Domain
After deployment, attach the Worker to your Cloudflare zone/domain. If `cardingx.in` is already on Cloudflare, use the Worker custom domain/route for the site. The Worker serves the existing homepage and `/admin` from the same hostname.

## Current image handling
The editor stores an image URL in D1. This avoids putting binary files into D1. If you want a real `Upload Image` button, add an R2 bucket and bind it as `MEDIA`, then add an authenticated `/api/upload` endpoint.

## Public posts
The API already exposes published posts at `/api/posts`. The supplied homepage is intentionally left unchanged. To make newly published posts appear automatically on the homepage, add a small frontend fetch/render section to `public/index.html` after you confirm the admin is working.
