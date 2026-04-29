-- Run once on first DB init (before migrations)
-- Creates the app_user role that RLS policies reference

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user;
  END IF;
END
$$;

-- Grant app_user access to the database
GRANT CONNECT ON DATABASE ecommerxe TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

-- Grant ecommerxe_user the app_user role
-- (ecommerxe_user is the application DB user; it inherits app_user's RLS policies)
GRANT app_user TO ecommerxe_user;
