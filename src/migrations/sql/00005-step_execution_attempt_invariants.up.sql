-- === UPDATE INVARIANTS ===
CREATE FUNCTION {{schema}}.enforce_step_execution_update_invariants()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.id IS DISTINCT FROM NEW.id THEN
        RAISE EXCEPTION 'id is immutable and cannot be changed';
    END IF;

    IF OLD.step_execution_id IS DISTINCT FROM NEW.step_execution_id THEN
        RAISE EXCEPTION 'step_execution_id is immutable and cannot be changed';
    END IF;

    IF OLD.executor_id IS DISTINCT FROM NEW.executor_id THEN
        IF NOT EXISTS (
            SELECT 1
            FROM {{schema}}.step_execution AS se
            INNER JOIN {{schema}}.workflow AS wf
            ON se.workflow_id = wf.id
        )

    END IF;


    -- if the record has been updated, but the updated_at is the same,
    -- we need to update the updated_at to the current time
    IF (OLD IS DISTINCT FROM NEW) AND (OLD.updated_at IS NOT DISTINCT FROM NEW.updated_at) THEN
        NEW.updated_at = NOW();
    END IF;






id BIGSERIAL PRIMARY KEY,
    step_execution_id BIGINT NOT NULL,

    executor_id INTEGER,

    -- timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    
    count_deadline_from TIMESTAMPTZ,
    deadline_duration INTERVAL,
    deadline_at TIMESTAMPTZ GENERATED ALWAYS AS (
        count_deadline_from + deadline_duration
    ) STORED,
    
    cancellation_reason TEXT,
    status TEXT NOT NULL,
    result JSONB,
    