-- 0001_storage.sql — object storage (R2 / S3-compatible) and its metadata.
--
-- Generated alongside db/schema.ts.
--
-- Henna's server never stores attachment *bytes*. It stores an object key, a
-- size and a content type, and issues presigned URLs so the browser can read and
-- write the bucket directly. That distinction is why this migration adds two
-- small tables and nothing that could hold mail content.

CREATE TABLE "storage_config" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "provider" text NOT NULL DEFAULT 'r2',
  "enabled" integer NOT NULL DEFAULT 0,
  -- Origin only. Derived from r2_account_id when empty and provider = 'r2'.
  "endpoint" text,
  "r2_account_id" text,
  -- 'auto' for R2; a real region for S3 and most S3-compatible services.
  "region" text NOT NULL DEFAULT 'auto',
  "bucket" text,
  -- Bucket credentials, AES-256-GCM encrypted with the credential keyring.
  "access_key_id_enc" text,
  "access_key_id_key_id" text,
  "secret_access_key_enc" text,
  "secret_access_key_key_id" text,
  "force_path_style" integer NOT NULL DEFAULT 1,
  "max_upload_bytes" integer NOT NULL DEFAULT 26214400,
  "signed_url_ttl_seconds" integer NOT NULL DEFAULT 300,
  "public_base_url" text,
  "updated_by" uuid,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "storage_config_singleton" CHECK ("id" = 1),
  CONSTRAINT "storage_config_provider_valid" CHECK ("provider" IN ('r2', 's3')),
  CONSTRAINT "storage_config_endpoint_https" CHECK (
    "endpoint" IS NULL OR "endpoint" LIKE 'https://%'
  )
);

CREATE TABLE "storage_objects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  -- Every key begins with users/<user_id>/; enforced in the DAL before signing.
  "object_key" text NOT NULL,
  "purpose" text NOT NULL DEFAULT 'attachment',
  -- Display name only. The stored key carries a UUID, so names cannot collide
  -- and cannot be guessed.
  "filename" text NOT NULL,
  "content_type" text,
  "size_bytes" integer,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "storage_objects_key_unique" ON "storage_objects" ("object_key");
CREATE INDEX "storage_objects_user_idx" ON "storage_objects" ("user_id");
CREATE INDEX "storage_objects_created_idx" ON "storage_objects" ("created_at");
