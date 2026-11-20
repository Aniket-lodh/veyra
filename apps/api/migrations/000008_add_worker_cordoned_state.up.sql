-- 000008_add_worker_cordoned_state.up.sql

ALTER TYPE worker_state ADD VALUE IF NOT EXISTS 'cordoned';
