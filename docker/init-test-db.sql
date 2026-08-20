-- Creates the test database if it doesn't exist.
-- Runs automatically on first postgres container start (empty volume).
-- For existing containers, run manually:
--   docker exec -it orreryorchestrator-postgres-1 psql -U orrery -c "CREATE DATABASE orrery_test OWNER orrery"
SELECT 'CREATE DATABASE orrery_test OWNER orrery'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'orrery_test')\gexec
