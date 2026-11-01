-- Rollback for 20261101153800_atlas_service_role_select_signals_decisions.sql: back to prod's Nov 1, 2026 state (service_role INSERT only on both).
set lock_timeout = '3s';
revoke select on atlas.signals, atlas.decisions from service_role;
