import { ensureSchema, getEnv } from "../../../db";

type RecordPayload = {
  id?: string;
  kind?: string;
  name?: string;
  payload?: unknown;
  createdAt?: string;
  updatedAt?: string;
};

export async function GET(request: Request) {
  await ensureSchema();
  const { DB } = getEnv();
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  const result = kind
    ? await DB.prepare("SELECT * FROM records WHERE kind = ? ORDER BY updated_at DESC").bind(kind).all()
    : await DB.prepare("SELECT * FROM records ORDER BY updated_at DESC").all();
  const records = result.results.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    payload: JSON.parse(String(row.payload)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  return Response.json({ records });
}

export async function POST(request: Request) {
  await ensureSchema();
  const { DB } = getEnv();
  const body = (await request.json()) as RecordPayload;
  if (!body.id || !body.kind || !body.name) {
    return Response.json({ error: "id, kind and name are required" }, { status: 400 });
  }
  const now = new Date().toISOString();
  const createdAt = body.createdAt ?? now;
  const updatedAt = body.updatedAt ?? now;
  await DB.prepare(`INSERT INTO records (id, kind, name, payload, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, name=excluded.name, payload=excluded.payload, updated_at=excluded.updated_at`)
    .bind(body.id, body.kind, body.name, JSON.stringify(body.payload ?? {}), createdAt, updatedAt)
    .run();
  return Response.json({ ok: true, id: body.id, updatedAt }, { status: 201 });
}

export async function DELETE(request: Request) {
  await ensureSchema();
  const { DB } = getEnv();
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  await DB.prepare("DELETE FROM records WHERE id = ?").bind(id).run();
  return Response.json({ ok: true });
}
