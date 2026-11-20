-- 000008_add_worker_cordoned_state.down.sql

UPDATE workers SET state = 'idle' WHERE state = 'cordoned';
