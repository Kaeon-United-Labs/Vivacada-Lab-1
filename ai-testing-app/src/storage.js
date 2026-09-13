'use strict';
// Segmented clips (one webcam + one screen recording per step) land here as
// soon as they're captured, and are deleted immediately after proctoring
// analysis runs — regardless of outcome. A superseded clip (the user clicked
// Retry) is deleted the moment it's superseded, not held until the end.

function client() {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region: process.env.S3_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE || 'false').toLowerCase() === 'true',
    credentials: process.env.S3_ACCESS_KEY_ID
      ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
      : undefined
  });
}
const BUCKET = process.env.S3_BUCKET;

function requireBucket() {
  if (!BUCKET) throw new Error('S3_BUCKET is required for real storage operations.');
}

async function uploadClip(key, buffer, contentType) {
  requireBucket();
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await client().send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType || 'video/webm' }));
}

// Returns raw bytes — the video model receives inline data, not a URL, so
// there's no dependency on the model being able to fetch from our bucket.
async function getClipBytes(key) {
  requireBucket();
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const out = await client().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of out.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function deleteClip(key) {
  requireBucket();
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  try { await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })); } catch (e) { console.warn('[storage] delete failed for', key, e.message); }
}

// Deletes every object under an attempt's prefix — the backstop cleanup call
// made once an attempt reaches any terminal state (approved, rejected, or
// failed-content-grading), in case any individual clip delete was missed.
async function deletePrefix(prefix) {
  requireBucket();
  const { ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
  const c = client();
  let ContinuationToken;
  do {
    const list = await c.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken }));
    const objects = (list.Contents || []).map((o) => ({ Key: o.Key }));
    if (objects.length) await c.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objects } }));
    ContinuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (ContinuationToken);
}

module.exports = { uploadClip, getClipBytes, deleteClip, deletePrefix };
