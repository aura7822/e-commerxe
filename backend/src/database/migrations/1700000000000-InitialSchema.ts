import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1700000000000 implements MigrationInterface {
  name = 'InitialSchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ─── Enable required extensions ─────────────────────────────────
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    // ─── ENUM types ──────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TYPE user_role AS ENUM ('sudo_admin', 'business_owner', 'visitor');
      CREATE TYPE auth_provider AS ENUM ('local', 'google');
      CREATE TYPE business_status AS ENUM ('pending', 'active', 'flagged', 'suspended');
      CREATE TYPE media_file_type AS ENUM ('logo', 'banner', 'gallery');
      CREATE TYPE media_mime_type AS ENUM ('image/jpeg', 'image/png', 'image/webp', 'image/avif');
      CREATE TYPE event_type AS ENUM ('view', 'click', 'cta');
      CREATE TYPE audit_action AS ENUM (
        'user.register', 'user.login', 'user.logout', 'user.password_reset',
        'user.mfa_enable', 'user.suspended', 'user.deleted',
        'business.created', 'business.updated', 'business.deleted',
        'business.approved', 'business.flagged',
        'media.uploaded', 'media.deleted', 'admin.role_change'
      );
    `);

    // ─── USERS table ─────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE users (
        id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        email                       VARCHAR(255) NOT NULL UNIQUE,
        password_hash               TEXT,
        role                        user_role NOT NULL DEFAULT 'visitor',
        auth_provider               auth_provider NOT NULL DEFAULT 'local',
        google_id                   VARCHAR(255),
        email_verified              BOOLEAN NOT NULL DEFAULT FALSE,
        email_verification_token    TEXT,
        email_verification_expires  TIMESTAMPTZ,
        mfa_secret                  TEXT,
        mfa_enabled                 BOOLEAN NOT NULL DEFAULT FALSE,
        display_name                VARCHAR(200),
        avatar_url                  TEXT,
        is_suspended                BOOLEAN NOT NULL DEFAULT FALSE,
        failed_login_attempts       INTEGER NOT NULL DEFAULT 0,
        lockout_until               TIMESTAMPTZ,
        last_login_at               TIMESTAMPTZ,
        tenant_id                   UUID,
        deletion_requested_at       TIMESTAMPTZ,
        deletion_scheduled_at       TIMESTAMPTZ,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX idx_users_tenant_id ON users(tenant_id);
      CREATE INDEX idx_users_email ON users(email);
    `);

    // ─── CATEGORIES table ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE categories (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name        VARCHAR(100) NOT NULL,
        slug        VARCHAR(120) NOT NULL UNIQUE,
        description TEXT,
        icon        VARCHAR(100),
        parent_id   UUID REFERENCES categories(id) ON DELETE SET NULL,
        is_active   BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX idx_categories_slug ON categories(slug);
    `);

    // ─── BUSINESSES table ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE businesses (
        id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        owner_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tenant_id             UUID NOT NULL,
        name                  VARCHAR(200) NOT NULL,
        slug                  VARCHAR(120) NOT NULL,
        description           TEXT,
        status                business_status NOT NULL DEFAULT 'pending',
        verified              BOOLEAN NOT NULL DEFAULT FALSE,
        phone                 VARCHAR(50),
        email                 VARCHAR(255),
        website_url           TEXT,
        location              VARCHAR(300),
        logo_url              TEXT,
        banner_url            TEXT,
        search_vector         TSVECTOR,
        deleted_at            TIMESTAMPTZ,
        permanent_deletion_at TIMESTAMPTZ,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_businesses_slug_active UNIQUE NULLS NOT DISTINCT (slug, deleted_at)
      );
      CREATE INDEX idx_businesses_tenant ON businesses(tenant_id);
      CREATE INDEX idx_businesses_owner  ON businesses(owner_id);
      CREATE INDEX idx_businesses_slug   ON businesses(slug) WHERE deleted_at IS NULL;
      CREATE INDEX idx_businesses_status ON businesses(status) WHERE deleted_at IS NULL;

      -- GIN index for full-text search
      CREATE INDEX idx_businesses_search_vector ON businesses USING GIN(search_vector);
      -- Trigram index for fuzzy/typo-tolerant search
      CREATE INDEX idx_businesses_name_trgm    ON businesses USING GIN(name gin_trgm_ops);
    `);

    // ─── Auto-update search_vector on INSERT/UPDATE ─────────────────
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION update_business_search_vector()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.search_vector :=
          setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B');
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_business_search_vector
        BEFORE INSERT OR UPDATE ON businesses
        FOR EACH ROW EXECUTE FUNCTION update_business_search_vector();
    `);

    // ─── Auto-update updated_at ──────────────────────────────────────
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_businesses_updated_at
        BEFORE UPDATE ON businesses
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();

      CREATE TRIGGER trg_users_updated_at
        BEFORE UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    `);

    // ─── BUSINESS_CATEGORIES junction ────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE business_categories (
        business_id  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        category_id  UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        PRIMARY KEY (business_id, category_id)
      );
    `);

    // ─── BUSINESS_CARDS table ─────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE business_cards (
        id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        business_id  UUID NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
        slug         VARCHAR(120) NOT NULL UNIQUE,
        template_id  INTEGER NOT NULL DEFAULT 1,
        seo_metadata JSONB,
        cta_buttons  JSONB,
        custom_css   TEXT,
        is_published BOOLEAN NOT NULL DEFAULT TRUE,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX idx_business_cards_slug ON business_cards(slug);

      CREATE TRIGGER trg_cards_updated_at
        BEFORE UPDATE ON business_cards
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    `);

    // ─── SLUG_REDIRECTS table (301 redirect store) ────────────────────
    await queryRunner.query(`
      CREATE TABLE slug_redirects (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        old_slug    VARCHAR(120) NOT NULL,
        new_slug    VARCHAR(120) NOT NULL,
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX idx_slug_redirects_old ON slug_redirects(old_slug);
    `);

    // ─── MEDIA_FILES table ────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE media_files (
        id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        tenant_id        UUID NOT NULL,
        file_type        media_file_type NOT NULL,
        mime_type        media_mime_type NOT NULL,
        storage_key      TEXT NOT NULL,
        cdn_url          TEXT NOT NULL,
        variants         JSONB,
        size_bytes       INTEGER NOT NULL,
        malware_scanned  BOOLEAN NOT NULL DEFAULT FALSE,
        malware_clean    BOOLEAN NOT NULL DEFAULT FALSE,
        original_filename VARCHAR(255),
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX idx_media_files_business ON media_files(business_id);
      CREATE INDEX idx_media_files_tenant   ON media_files(tenant_id);
    `);

    // ─── ANALYTICS_EVENTS partitioned table ───────────────────────────
    await queryRunner.query(`
      CREATE TABLE analytics_events (
        event_id    UUID NOT NULL DEFAULT uuid_generate_v4(),
        tenant_id   UUID NOT NULL,
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        event_type  event_type NOT NULL,
        timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ip_hash     VARCHAR(64) NOT NULL,
        session_id  VARCHAR(64) NOT NULL,
        referrer    VARCHAR(200),
        cta_label   VARCHAR(100),
        PRIMARY KEY (event_id, timestamp)
      ) PARTITION BY RANGE (timestamp);

      -- Create initial monthly partitions (add future ones via cron)
      CREATE TABLE analytics_events_y2024_m01 PARTITION OF analytics_events
        FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
      CREATE TABLE analytics_events_y2024_m12 PARTITION OF analytics_events
        FOR VALUES FROM ('2024-12-01') TO ('2025-01-01');
      CREATE TABLE analytics_events_default PARTITION OF analytics_events DEFAULT;

      CREATE INDEX idx_analytics_biz_type ON analytics_events(business_id, event_type);
      CREATE INDEX idx_analytics_tenant   ON analytics_events(tenant_id);
      CREATE INDEX idx_analytics_ts       ON analytics_events(timestamp DESC);
    `);

    // ─── AUDIT_LOGS table — append-only ──────────────────────────────
    await queryRunner.query(`
      CREATE TABLE audit_logs (
        id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        actor_id      UUID,
        action        audit_action NOT NULL,
        resource_id   UUID,
        resource_type VARCHAR(100),
        metadata      JSONB,
        ip_hash       VARCHAR(64),
        user_agent    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX idx_audit_actor    ON audit_logs(actor_id);
      CREATE INDEX idx_audit_resource ON audit_logs(resource_id);
      CREATE INDEX idx_audit_action   ON audit_logs(action);
      CREATE INDEX idx_audit_ts       ON audit_logs(created_at DESC);

      -- Prevent TRUNCATE on audit_logs
      CREATE RULE no_truncate_audit AS ON DELETE TO audit_logs DO INSTEAD NOTHING;
    `);

    // ─── ROW-LEVEL SECURITY (RLS) ─────────────────────────────────────
    await queryRunner.query(`
      -- Enable RLS on tenant-scoped tables
      ALTER TABLE businesses      ENABLE ROW LEVEL SECURITY;
      ALTER TABLE media_files     ENABLE ROW LEVEL SECURITY;
      ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;

      -- Create application role (used by the NestJS app connection)
      -- sudo_admin bypasses RLS; app_user enforces it
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
          CREATE ROLE app_user;
        END IF;
      END $$;

      -- Businesses: owners see only their own; sudo_admin sees all
      CREATE POLICY tenant_isolation_businesses ON businesses
        AS PERMISSIVE FOR ALL TO app_user
        USING (
          tenant_id = current_setting('app.current_tenant', TRUE)::UUID
          OR current_setting('app.bypass_rls', TRUE) = 'true'
        );

      -- Media files
      CREATE POLICY tenant_isolation_media ON media_files
        AS PERMISSIVE FOR ALL TO app_user
        USING (
          tenant_id = current_setting('app.current_tenant', TRUE)::UUID
          OR current_setting('app.bypass_rls', TRUE) = 'true'
        );

      -- Analytics — owners see only their own data
      CREATE POLICY tenant_isolation_analytics ON analytics_events
        AS PERMISSIVE FOR ALL TO app_user
        USING (
          tenant_id = current_setting('app.current_tenant', TRUE)::UUID
          OR current_setting('app.bypass_rls', TRUE) = 'true'
        );

      -- Public read-only policy for business cards (no auth needed)
      CREATE POLICY public_read_businesses ON businesses
        AS PERMISSIVE FOR SELECT TO PUBLIC
        USING (status = 'active' AND deleted_at IS NULL);
    `);

    // ─── Seed categories ─────────────────────────────────────────────
    await queryRunner.query(`
      INSERT INTO categories (id, name, slug, icon, description) VALUES
        (uuid_generate_v4(), 'E-Commerce',          'ecommerce',     '🛒', 'Online shops and retail'),
        (uuid_generate_v4(), 'Housing & Real Estate','housing',       '🏠', 'Property sales and rentals'),
        (uuid_generate_v4(), 'Car Rental',           'car-rental',    '🚗', 'Vehicle hire services'),
        (uuid_generate_v4(), 'Car Sales',            'car-sales',     '🚙', 'New and used vehicle sales'),
        (uuid_generate_v4(), 'Food & Dining',        'food-dining',   '🍽️', 'Restaurants and eateries'),
        (uuid_generate_v4(), 'Services & Repair',    'services',      '🔧', 'Professional services'),
        (uuid_generate_v4(), 'Health & Wellness',    'health',        '💊', 'Clinics and wellness centres'),
        (uuid_generate_v4(), 'Education',            'education',     '📚', 'Schools and training');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS audit_logs CASCADE;
      DROP TABLE IF EXISTS analytics_events CASCADE;
      DROP TABLE IF EXISTS media_files CASCADE;
      DROP TABLE IF EXISTS slug_redirects CASCADE;
      DROP TABLE IF EXISTS business_cards CASCADE;
      DROP TABLE IF EXISTS business_categories CASCADE;
      DROP TABLE IF EXISTS businesses CASCADE;
      DROP TABLE IF EXISTS categories CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
      DROP TYPE IF EXISTS audit_action CASCADE;
      DROP TYPE IF EXISTS event_type CASCADE;
      DROP TYPE IF EXISTS media_mime_type CASCADE;
      DROP TYPE IF EXISTS media_file_type CASCADE;
      DROP TYPE IF EXISTS business_status CASCADE;
      DROP TYPE IF EXISTS auth_provider CASCADE;
      DROP TYPE IF EXISTS user_role CASCADE;
      DROP EXTENSION IF EXISTS "pg_trgm";
      DROP EXTENSION IF EXISTS "pgcrypto";
      DROP EXTENSION IF EXISTS "uuid-ossp";
    `);
  }
}
