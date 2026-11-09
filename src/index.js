const json = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });

const cleanText = (value, max) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const allowedThemes = new Set(["garden", "classic", "diary"]);
const allowedVisibility = new Set(["private", "public"]);

async function hashToken(token) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeMemories(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).map((item, index) => ({
    id: crypto.randomUUID(),
    title: cleanText(item?.title, 45),
    description: cleanText(item?.text, 180),
    position: index
  })).filter(item => item.title);
}

async function getAlbum(db, album, includePrivate = false) {
  const memories = await db.prepare(
    "SELECT id, title, description AS text, position FROM memories WHERE album_id = ? ORDER BY position ASC"
  ).bind(album.id).all();

  return {
    id: album.id,
    slug: album.slug,
    title: album.title,
    subtitle: album.subtitle,
    album_date: album.album_date,
    dedication: album.dedication,
    theme: album.theme,
    visibility: album.visibility,
    memories: memories.results || []
  };
}

async function handleApi(request, env, url) {
  if (url.pathname === "/api/health" && request.method === "GET") {
    try {
      const result = await env.DB.prepare("SELECT 1 AS ok").first();
      return json({
        ok: result?.ok === 1,
        service: "amore-api",
        database: "connected"
      });
    } catch {
      return json({ ok: false, error: "database_connection_failed" }, 500);
    }
  }

  if (url.pathname === "/api/albums" && request.method === "POST") {
    const length = Number(request.headers.get("content-length") || 0);
    if (length > 256_000) return json({ error: "payload_too_large" }, 413);

    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }

    const title = cleanText(body.title, 55);
    if (!title) return json({ error: "title_required" }, 400);

    const visibility = allowedVisibility.has(body.visibility) ? body.visibility : "private";
    const theme = allowedThemes.has(body.theme) ? body.theme : "classic";
    const memories = normalizeMemories(body.memories);
    const id = crypto.randomUUID();
    const slug = crypto.randomUUID().replaceAll("-", "");
    const editToken = crypto.randomUUID() + crypto.randomUUID();
    const tokenHash = await hashToken(editToken);

    const statements = [
      env.DB.prepare(
        `INSERT INTO albums
          (id, slug, title, subtitle, album_date, dedication, theme, status, visibility, edit_token_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
      ).bind(
        id, slug, title, cleanText(body.subtitle, 90),
        cleanText(body.album_date, 10) || null,
        cleanText(body.dedication, 240), theme, visibility, tokenHash
      ),
      ...memories.map(item => env.DB.prepare(
        "INSERT INTO memories (id, album_id, title, description, position) VALUES (?, ?, ?, ?, ?)"
      ).bind(item.id, id, item.title, item.description, item.position))
    ];

    await env.DB.batch(statements);
    return json({
      ok: true,
      album: { id, slug, title, visibility, memories },
      editToken,
      shareUrl: visibility === "public" ? `${url.origin}/album.html?slug=${slug}` : null
    }, 201);
  }

  const ownerMatch = url.pathname.match(/^\/api\/albums\/([a-f0-9-]{36})$/i);
  if (ownerMatch && (request.method === "GET" || request.method === "PUT")) {
    const id = ownerMatch[1];
    const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "edit_token_required" }, 401);
    const tokenHash = await hashToken(token);
    const album = await env.DB.prepare(
      "SELECT id, slug, title, subtitle, album_date, dedication, theme, visibility FROM albums WHERE id = ? AND edit_token_hash = ?"
    ).bind(id, tokenHash).first();
    if (!album) return json({ error: "album_not_found_or_forbidden" }, 404);

    if (request.method === "GET") {
      return json({ ok: true, album: await getAlbum(env.DB, album) });
    }

    const length = Number(request.headers.get("content-length") || 0);
    if (length > 256_000) return json({ error: "payload_too_large" }, 413);
    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }

    const title = cleanText(body.title, 55);
    if (!title) return json({ error: "title_required" }, 400);
    const visibility = allowedVisibility.has(body.visibility) ? body.visibility : "private";
    const theme = allowedThemes.has(body.theme) ? body.theme : "classic";
    const memories = normalizeMemories(body.memories);

    const statements = [
      env.DB.prepare(
        `UPDATE albums SET title = ?, subtitle = ?, album_date = ?, dedication = ?,
          theme = ?, visibility = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND edit_token_hash = ?`
      ).bind(
        title, cleanText(body.subtitle, 90), cleanText(body.album_date, 10) || null,
        cleanText(body.dedication, 240), theme, visibility, id, tokenHash
      ),
      env.DB.prepare("DELETE FROM memories WHERE album_id = ?").bind(id),
      ...memories.map(item => env.DB.prepare(
        "INSERT INTO memories (id, album_id, title, description, position) VALUES (?, ?, ?, ?, ?)"
      ).bind(item.id, id, item.title, item.description, item.position))
    ];
    await env.DB.batch(statements);
    return json({
      ok: true,
      album: { id, slug: album.slug, title, visibility, memories },
      shareUrl: visibility === "public" ? `${url.origin}/album.html?slug=${album.slug}` : null
    });
  }

  const publicMatch = url.pathname.match(/^\/api\/public\/([a-f0-9]{32})$/i);
  if (publicMatch && request.method === "GET") {
    const album = await env.DB.prepare(
      "SELECT id, slug, title, subtitle, album_date, dedication, theme, visibility FROM albums WHERE slug = ? AND visibility = 'public'"
    ).bind(publicMatch[1]).first();
    if (!album) return json({ error: "album_not_found" }, 404);
    return json({ ok: true, album: await getAlbum(env.DB, album) });
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (error) {
        console.error("Amore API error", error);
        return json({ error: "internal_error" }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
