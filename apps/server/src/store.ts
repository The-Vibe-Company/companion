import { SQL } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { config, encrypt } from "./config";
export const db = new SQL(config.databaseUrl, { max: 8, connectionTimeout: 10 });
const migrationNames = ["schema.sql", "auth-schema.sql", "product.sql", "plugins.sql", "storage-schema.sql", "task-runtime.sql", "lifecycle.sql", "desktop.sql", "box-observation.sql", "billing.sql", "delivery.sql", "maintenance.sql", "delivery-skills.sql", "model-gateway.sql", "admission.sql", "conversation.sql", "events.sql", "chat.sql", "managed-base-image.sql", "runtime-updates.sql", "discussions.sql", "legacy-removal.sql", "composio.sql"] as const;

async function migrationFiles() {
  return Promise.all(migrationNames.map(async name => ({ name, sql: await Bun.file(new URL(`./${name}`, import.meta.url)).text() })));
}

export async function migrationFingerprint() {
  const files = await migrationFiles();
  return createHash("sha256").update(files.map(file => `${file.name}\0${file.sql}\0`).join("")).digest("hex");
}

export async function migrate(sql = db) {
  const files = await migrationFiles();
  const fingerprint = createHash("sha256").update(files.map(file => `${file.name}\0${file.sql}\0`).join("")).digest("hex");
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(721440138)`;
    const [stateTable] = await tx`SELECT to_regclass('public.companions_schema_state') AS name`;
    if (stateTable.name) {
      const [state] = await tx`SELECT fingerprint FROM companions_schema_state WHERE singleton=true`;
      if (state?.fingerprint === fingerprint) return { applied: false, fingerprint };
    }
    for (const file of files) await tx.unsafe(file.sql);
    const localId = "00000000-0000-4000-8000-000000000001";
    if (process.env.NODE_ENV !== "production") {
      await tx`INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt")
        VALUES (${localId},${"Local developer"},${config.localDevEmail},true,now(),now())
        ON CONFLICT ("id") DO NOTHING`;
    }
    const [{ count }] = await tx`SELECT count(*)::int AS count FROM companions WHERE owner_id IS NULL`;
    if (count > 0) {
      if (process.env.NODE_ENV === "production") {
        throw new Error("Existing Companions have no owner; assign owner_id before starting hosted mode");
      }
      await tx`UPDATE companions SET owner_id=${localId} WHERE owner_id IS NULL`;
    }
    await tx`ALTER TABLE companions ALTER COLUMN owner_id SET NOT NULL`;
    await tx`CREATE TABLE IF NOT EXISTS companions_schema_state (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      fingerprint text NOT NULL,
      migrated_at timestamptz NOT NULL DEFAULT now()
    )`;
    await tx`INSERT INTO companions_schema_state (singleton,fingerprint,migrated_at) VALUES (true,${fingerprint},now())
      ON CONFLICT (singleton) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,migrated_at=EXCLUDED.migrated_at`;
    return { applied: true, fingerprint };
  });
}

export async function assertMigrated(sql = db) {
  const fingerprint = await migrationFingerprint();
  const [stateTable] = await sql`SELECT to_regclass('public.companions_schema_state') AS name`;
  if (!stateTable.name) throw new Error("Database schema has not been prepared; run bun run migrate before starting services");
  const [state] = await sql`SELECT fingerprint FROM companions_schema_state WHERE singleton=true`;
  if (state?.fingerprint !== fingerprint) throw new Error("Database schema is stale; run bun run migrate before starting services");
  return fingerprint;
}

export async function migrateForService(sql = db) {
  if (process.env.COMPANIONS_SCHEMA_PREPARED === "1") {
    await assertMigrated(sql);
    return;
  }
  await migrate(sql);
}
export const companionColumns = `runtime_version AS "runtimeVersion",runtime_update_target AS "runtimeUpdateTarget",runtime_update_status AS "runtimeUpdateStatus",runtime_update_error AS "runtimeUpdateError",id,name,instructions,avatar,model_id AS "modelId",provider,status,error,desktop_taken AS "desktopTaken",desktop_paused_at AS "desktopPausedAt",prepare_requested AS "prepareRequested",ready_at AS "readyAt",retired_at AS "retiredAt",box_id AS "boxId",created_at AS "createdAt"`;
export async function listCompanions(ownerId: string) { return db.unsafe(`SELECT ${companionColumns} FROM companions WHERE owner_id=$1 AND retired_at IS NULL ORDER BY created_at,id`, [ownerId]); }
export async function createCompanion(ownerId: string, input: { name: string; instructions?: string; provider?: "local" | "box"; prepare?:boolean; avatar?: {shape:number;color:number;face:number}; clientCreationId?:string }) {
  input={...input,provider:input.provider??config.defaultProvider};
  const fingerprint=input.clientCreationId?createHash("sha256").update(JSON.stringify({name:input.name,instructions:input.instructions??null,provider:input.provider,prepare:input.prepare??false,avatar:input.avatar??null})).digest("hex"):null;
  return db.begin(async sql => {
    if(input.clientCreationId){
      const [prior]=await sql`SELECT creation_fingerprint FROM companions WHERE owner_id=${ownerId} AND client_creation_id=${input.clientCreationId}`;
      if(prior){
        if(prior.creation_fingerprint!==fingerprint)throw new Conflict("This creation identifier was already used with different details.");
        return (await sql.unsafe(`SELECT ${companionColumns} FROM companions WHERE owner_id=$1 AND client_creation_id=$2`,[ownerId,input.clientCreationId]))[0];
      }
    }
    if(input.provider==="local"&&!config.localAvailable)throw new Conflict("Local runtime is disabled. Set LOCAL_RUNTIME=1 for local testing.");
    const id = crypto.randomUUID();
    const inserted=await sql`INSERT INTO companions (id,owner_id,name,instructions,provider,create_key,agent_secret,avatar,prepare_requested,client_creation_id,creation_fingerprint)
      VALUES (${id},${ownerId},${input.name},${input.instructions??""},${input.provider},${crypto.randomUUID()},${encrypt(randomBytes(32).toString("hex"))},${input.avatar??{shape:Math.floor(Math.random()*8),color:Math.floor(Math.random()*11),face:Math.floor(Math.random()*5)}},${input.prepare??false},${input.clientCreationId??null},${fingerprint})
      ON CONFLICT(owner_id,client_creation_id) WHERE client_creation_id IS NOT NULL DO NOTHING RETURNING id`;
    if(!inserted.length){
      const [winner]=await sql`SELECT creation_fingerprint FROM companions WHERE owner_id=${ownerId} AND client_creation_id=${input.clientCreationId}`;
      if(!winner||winner.creation_fingerprint!==fingerprint)throw new Conflict("This creation identifier was already used with different details.");
      return (await sql.unsafe(`SELECT ${companionColumns} FROM companions WHERE owner_id=$1 AND client_creation_id=$2`,[ownerId,input.clientCreationId!]))[0];
    }
    return (await sql.unsafe(`SELECT ${companionColumns} FROM companions WHERE id=$1 AND owner_id=$2`, [id, ownerId]))[0];
  });
}
export async function detail(ownerId: string, id: string) {
  const [companion] = await db.unsafe(`SELECT ${companionColumns} FROM companions WHERE id=$1 AND owner_id=$2`, [id, ownerId]);
  if (!companion) return null;
  const [messages, runs] = await Promise.all([
    db`SELECT id,role,content,sequence,complete,created_at AS "createdAt",run_id AS "runId" FROM messages WHERE companion_id=${id} ORDER BY created_at,sequence,id`,
    db`SELECT id,status,error,lane,source,started_at AS "startedAt",result_text AS "resultText",preview_text AS "previewText",message_version AS "messageVersion",thinking_text AS "thinkingText",publish_to_chat AS "publishToChat",response_root_id AS "responseRootId",created_at AS "createdAt",prepared_at AS "preparedAt",finished_at AS "finishedAt" FROM runs WHERE companion_id=${id} ORDER BY created_at,id`,
  ]);
  return { companion, messages, runs, activity: runs.filter((run:any)=>run.lane === "background") };
}
export class Conflict extends Error {}
export async function acceptMessage(ownerId: string, companionId: string, clientMessageId: string, content: string, attachmentCount = 0) {
  return db.begin(async sql => {
    // Lock companion to serialize duplicate admission with cancellation and FIFO claims.
    await sql`SELECT pg_advisory_xact_lock(721440140)`;
    const [companion] = await sql`SELECT id FROM companions WHERE id=${companionId} AND owner_id=${ownerId} AND retired_at IS NULL AND archive_requested_at IS NULL FOR UPDATE`;
    if (!companion) return null;
    const [existing] = await sql`SELECT id,content,attachment_count FROM runs WHERE companion_id=${companionId} AND client_message_id=${clientMessageId}`;
    if (existing) {
      if (existing.content !== content || existing.attachment_count !== attachmentCount) throw new Conflict("This message identifier was already used with different content or attachments.");
      return existing.id as string;
    }
    const id = crypto.randomUUID();
    await sql`INSERT INTO runs (id,companion_id,client_message_id,content,attachment_count) VALUES (${id},${companionId},${clientMessageId},${content},${attachmentCount})`;
    await sql`INSERT INTO messages (id,companion_id,run_id,role,content) VALUES (${crypto.randomUUID()},${companionId},${id},'user',${content})`;
    return id;
  });
}
export async function cancel(ownerId: string, companionId: string) {
  return db.begin(async sql => {
    const [companion] = await sql`SELECT id FROM companions WHERE id=${companionId} AND owner_id=${ownerId} FOR UPDATE`;
    if (!companion) return false;
    await sql`UPDATE runs SET status='cancelled',finished_at=now() WHERE companion_id=${companionId} AND lane='main' AND status='queued'`;
    await sql`UPDATE runs SET cancel_requested=true WHERE companion_id=${companionId} AND lane='main' AND status IN ('preparing','running','needs_input')`;
    return true;
  });
}
