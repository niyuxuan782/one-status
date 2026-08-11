BEGIN;

CREATE TABLE IF NOT EXISTS cloud_vault_credentials (
  user_id TEXT NOT NULL,
  id UUID NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  purposes JSONB NOT NULL DEFAULT '[]'::jsonb,
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  secret_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  source JSONB NOT NULL,
  access_policy JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  encryption_version SMALLINT NOT NULL DEFAULT 1,
  kms_provider TEXT NOT NULL,
  kms_key_id TEXT NOT NULL,
  wrapped_dek TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, id),
  CONSTRAINT cloud_vault_credentials_encryption_version
    CHECK (encryption_version = 1),
  CONSTRAINT cloud_vault_credentials_revision CHECK (revision > 0),
  CONSTRAINT cloud_vault_credentials_purposes_array
    CHECK (jsonb_typeof(purposes) = 'array'),
  CONSTRAINT cloud_vault_credentials_fields_object
    CHECK (jsonb_typeof(fields) = 'object'),
  CONSTRAINT cloud_vault_credentials_tags_array
    CHECK (jsonb_typeof(tags) = 'array'),
  CONSTRAINT cloud_vault_credentials_secret_keys_array
    CHECK (jsonb_typeof(secret_keys) = 'array'),
  CONSTRAINT cloud_vault_credentials_source_object
    CHECK (jsonb_typeof(source) = 'object'),
  CONSTRAINT cloud_vault_credentials_access_policy_object
    CHECK (jsonb_typeof(access_policy) = 'object')
);

CREATE INDEX IF NOT EXISTS cloud_vault_credentials_user_updated
  ON cloud_vault_credentials (user_id, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS cloud_vault_credentials_kind
  ON cloud_vault_credentials (user_id, kind)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS cloud_vault_credentials_purposes
  ON cloud_vault_credentials USING GIN (purposes jsonb_path_ops);
CREATE INDEX IF NOT EXISTS cloud_vault_credentials_tags
  ON cloud_vault_credentials USING GIN (tags jsonb_path_ops);
CREATE INDEX IF NOT EXISTS cloud_vault_credentials_fields
  ON cloud_vault_credentials USING GIN (fields jsonb_path_ops);

CREATE TABLE IF NOT EXISTS cloud_vault_agent_grants (
  user_id TEXT NOT NULL,
  id UUID NOT NULL,
  agent_id TEXT NOT NULL,
  credential_id UUID,
  purposes JSONB NOT NULL DEFAULT '[]'::jsonb,
  project_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, id),
  CONSTRAINT cloud_vault_agent_grants_credential
    FOREIGN KEY (user_id, credential_id)
    REFERENCES cloud_vault_credentials (user_id, id)
    ON DELETE CASCADE,
  CONSTRAINT cloud_vault_agent_grants_purposes_array
    CHECK (jsonb_typeof(purposes) = 'array'),
  CONSTRAINT cloud_vault_agent_grants_projects_array
    CHECK (jsonb_typeof(project_ids) = 'array')
);

CREATE INDEX IF NOT EXISTS cloud_vault_agent_grants_lookup
  ON cloud_vault_agent_grants (user_id, agent_id, credential_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS cloud_vault_agent_sessions (
  user_id TEXT NOT NULL,
  id UUID NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  agent_id TEXT NOT NULL,
  client_id TEXT,
  project_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, id),
  CONSTRAINT cloud_vault_agent_sessions_projects_array
    CHECK (jsonb_typeof(project_ids) = 'array')
);

ALTER TABLE cloud_vault_agent_sessions
  ADD COLUMN IF NOT EXISTS project_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'cloud_vault_agent_sessions_projects_array'
  ) THEN
    ALTER TABLE cloud_vault_agent_sessions
      ADD CONSTRAINT cloud_vault_agent_sessions_projects_array
      CHECK (jsonb_typeof(project_ids) = 'array');
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS cloud_vault_agent_sessions_identity
  ON cloud_vault_agent_sessions (user_id, agent_id, expires_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS cloud_vault_agent_sessions_expiry
  ON cloud_vault_agent_sessions (expires_at);

CREATE TABLE IF NOT EXISTS cloud_vault_agent_approvals (
  user_id TEXT NOT NULL,
  id UUID NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  request_digest CHAR(64) NOT NULL,
  session_id UUID NOT NULL,
  agent_id TEXT NOT NULL,
  client_id TEXT,
  operation TEXT NOT NULL,
  summary JSONB NOT NULL,
  status TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, id),
  CONSTRAINT cloud_vault_agent_approvals_operation CHECK (
    operation IN (
      'credential.create',
      'credential.get',
      'credential.update',
      'credential.delete'
    )
  ),
  CONSTRAINT cloud_vault_agent_approvals_status CHECK (
    status IN ('pending', 'approved', 'denied', 'consumed')
  ),
  CONSTRAINT cloud_vault_agent_approvals_summary_object
    CHECK (jsonb_typeof(summary) = 'object')
);

CREATE INDEX IF NOT EXISTS cloud_vault_agent_approvals_user_created
  ON cloud_vault_agent_approvals (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cloud_vault_agent_approvals_pending
  ON cloud_vault_agent_approvals (user_id, status, expires_at)
  WHERE status IN ('pending', 'approved');

CREATE TABLE IF NOT EXISTS cloud_vault_audit_events (
  user_id TEXT NOT NULL,
  id UUID NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  session_id UUID,
  credential_id UUID,
  project_id TEXT,
  purpose TEXT,
  action TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, id),
  CONSTRAINT cloud_vault_audit_actor_type
    CHECK (actor_type IN ('user', 'agent', 'migration', 'system')),
  CONSTRAINT cloud_vault_audit_decision
    CHECK (decision IN ('allow', 'deny')),
  CONSTRAINT cloud_vault_audit_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS cloud_vault_audit_user_created
  ON cloud_vault_audit_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cloud_vault_audit_credential_created
  ON cloud_vault_audit_events (user_id, credential_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cloud_vault_wallet_pake (
  user_id TEXT PRIMARY KEY,
  registration_record TEXT NOT NULL,
  profile JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT cloud_vault_wallet_pake_profile_object
    CHECK (jsonb_typeof(profile) = 'object')
);

CREATE TABLE IF NOT EXISTS cloud_vault_migrations (
  user_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  local_count INTEGER,
  cloud_count INTEGER,
  local_digest TEXT,
  cloud_digest TEXT,
  verified_at TIMESTAMPTZ,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT cloud_vault_migration_state CHECK (
    state IN (
      'local_only',
      'backfilling',
      'dual_write',
      'validating',
      'cutover_ready',
      'cutover',
      'failed'
    )
  ),
  CONSTRAINT cloud_vault_migration_counts CHECK (
    (local_count IS NULL OR local_count >= 0)
    AND (cloud_count IS NULL OR cloud_count >= 0)
  )
);

CREATE TABLE IF NOT EXISTS cloud_vault_kms_binding (
  id TEXT PRIMARY KEY,
  kms_provider TEXT NOT NULL,
  kms_key_id TEXT NOT NULL,
  wrapped_dek TEXT NOT NULL,
  verification_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT cloud_vault_kms_binding_singleton
    CHECK (id = 'primary'),
  CONSTRAINT cloud_vault_kms_binding_provider_length
    CHECK (char_length(kms_provider) BETWEEN 1 AND 128),
  CONSTRAINT cloud_vault_kms_binding_key_id_length
    CHECK (char_length(kms_key_id) BETWEEN 1 AND 256),
  CONSTRAINT cloud_vault_kms_binding_wrapped_dek_length
    CHECK (char_length(wrapped_dek) BETWEEN 1 AND 16384),
  CONSTRAINT cloud_vault_kms_binding_hash_length
    CHECK (char_length(verification_hash) = 43)
);

COMMIT;
