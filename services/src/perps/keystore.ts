import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, writeFile, open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
const Context = z.strictObject({
  venue: z.string().min(1).max(120),
  account: z.string().min(1).max(120),
  keyIndex: z.number().int().min(2).max(254),
});
export type KeyContext = z.infer<typeof Context>;
const Envelope = z.strictObject({
  version: z.literal(1),
  context: Context,
  iv: z.string().regex(/^[0-9a-f]{24}$/),
  tag: z.string().regex(/^[0-9a-f]{32}$/),
  ciphertext: z
    .string()
    .regex(/^[0-9a-f]+$/)
    .max(32768),
});
const aad = (c: KeyContext) => Buffer.from(JSON.stringify(Context.parse(c)));
function key(k: Uint8Array) {
  if (k.byteLength !== 32)
    throw new Error("A 32-byte external encryption key is required");
  return k;
}
/** Local, per-account encrypted storage. No remote vault, environment fallback or key logging. */
export async function saveVenueKey(
  path: string,
  context: KeyContext,
  secret: Uint8Array,
  master: Uint8Array,
) {
  if (!secret.byteLength || secret.byteLength > 8192)
    throw new Error("Invalid venue key length");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(master), iv);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      context: Context.parse(context),
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      ciphertext: ciphertext.toString("hex"),
    }),
    { flag: "wx", mode: 0o600 },
  );
}
export async function loadVenueKey(
  path: string,
  context: KeyContext,
  master: Uint8Array,
) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let envelope: z.infer<typeof Envelope>;
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 40000)
      throw new Error("Key file must be a private regular file");
    envelope = Envelope.parse(JSON.parse(await file.readFile("utf8")));
  } finally {
    await file.close();
  }
  if (!aad(context).equals(aad(envelope.context)))
    throw new Error("Venue key belongs to a different account or key index");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    key(master),
    Buffer.from(envelope.iv, "hex"),
  );
  cipher.setAAD(aad(context));
  cipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
  return Buffer.concat([
    cipher.update(Buffer.from(envelope.ciphertext, "hex")),
    cipher.final(),
  ]);
}
