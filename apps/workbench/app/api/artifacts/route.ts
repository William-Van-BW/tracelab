import { ensureSchema, getEnv } from "../../../db";

function hex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function GET(request: Request) {
  await ensureSchema();
  const { DB, ARTIFACTS } = getEnv();
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (id) {
    const row = await DB.prepare("SELECT * FROM artifacts WHERE id = ?").bind(id).first();
    if (!row) return new Response("Not found", { status: 404 });
    const object = await ARTIFACTS.get(String(row.object_key));
    if (!object) return new Response("Object missing", { status: 404 });
    return new Response(object.body, {
      headers: {
        "content-type": String(row.media_type),
        "content-disposition": `inline; filename="${String(row.file_name).replaceAll('"', "")}"`,
      },
    });
  }
  const runId = url.searchParams.get("runId");
  const result = runId
    ? await DB.prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at DESC").bind(runId).all()
    : await DB.prepare("SELECT * FROM artifacts ORDER BY created_at DESC LIMIT 200").all();
  return Response.json({ artifacts: result.results });
}

export async function POST(request: Request) {
  await ensureSchema();
  const { DB, ARTIFACTS } = getEnv();
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "file is required" }, { status: 400 });
  const bytes = await file.arrayBuffer();
  const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
  const id = `sha256:${digest}`;
  const objectKey = `sha256/${digest.slice(0, 2)}/${digest}`;
  const runId = String(form.get("runId") ?? "") || null;
  const turnId = String(form.get("turnId") ?? "") || null;
  const stepId = String(form.get("stepId") ?? "") || null;
  const role = String(form.get("role") ?? "other");
  const description = String(form.get("description") ?? "") || null;
  const createdAt = new Date().toISOString();
  await ARTIFACTS.put(objectKey, bytes, { httpMetadata: { contentType: file.type || "application/octet-stream" } });
  await DB.prepare(`INSERT INTO artifacts (id, run_id, turn_id, step_id, file_name, media_type, size_bytes, object_key, role, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id, turn_id=excluded.turn_id, step_id=excluded.step_id, role=excluded.role, description=excluded.description`)
    .bind(id, runId, turnId, stepId, file.name, file.type || "application/octet-stream", file.size, objectKey, role, description, createdAt)
    .run();
  return Response.json({
    artifact: { id, role, fileName: file.name, mediaType: file.type || "application/octet-stream", sizeBytes: file.size, description, url: `/api/artifacts?id=${encodeURIComponent(id)}` },
  }, { status: 201 });
}
