export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      try {
        const result = await env.DB.prepare("SELECT 1 AS ok").first();

        return Response.json({
          ok: result?.ok === 1,
          service: "amore-api",
          database: "connected"
        });
      } catch {
        return Response.json(
          { ok: false, error: "database_connection_failed" },
          { status: 500 }
        );
      }
    }

    return env.ASSETS.fetch(request);
  }
};
