-- =============================================================================
-- WORKFLOW (Core Table)
-- =============================================================================

CREATE TABLE {{schema}}.workflow (
    id TEXT PRIMARY KEY,
    parent_id TEXT,

    is_child BOOLEAN NOT NULL DEFAULT FALSE,
    is_detached BOOLEAN,

    name TEXT NOT NULL,

    -- graceful shutdown with compensation
    -- current step terminates, all the compensations run, hooks run as well
    sigterm BOOLEAN,
    -- graceful shutdown without compensation (hooks still run)
    -- workflow is terminated, but is aware of the shutdown
    sigint BOOLEAN,
    -- immediate shutdown without compensation or hooks
    -- workflow is terminated immediately, unaware of the shutdown
    sigkill BOOLEAN,
    -- generic
    sigpause BOOLEAN,
    
    terminal_status TEXT,

    arguments JSONB,
    result JSONB,

    -- Executor ownership (for distributed execution)
    executor_id INTEGER,

    -- seed for deterministic rng (auto-generated if not provided)
    seed TEXT NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,

    count_deadline_from TIMESTAMPTZ,
    deadline_duration INTERVAL,
    deadline_at TIMESTAMPTZ GENERATED ALWAYS AS (
        count_deadline_from + deadline_duration
    ) STORED,

    -- Retention policy (null = never)
    count_retention_from TIMESTAMPTZ,

    complete_retention_duration INTERVAL,
    complete_retention_deadline_at TIMESTAMPTZ GENERATED ALWAYS AS (
        count_retention_from + complete_retention_duration
    ) STORED,

    failed_retention_duration INTERVAL,
    failed_retention_deadline_at TIMESTAMPTZ GENERATED ALWAYS AS (
        count_retention_from + failed_retention_duration
    ) STORED,

    terminated_retention_duration INTERVAL,
    terminated_retention_deadline_at TIMESTAMPTZ GENERATED ALWAYS AS (
        count_retention_from + terminated_retention_duration
    ) STORED,
    
    -- Parent tracking for nested workflows
    started_by_step_execution_id BIGINT,

    CONSTRAINT chk_terminal_status CHECK (
        terminal_status IS NULL OR terminal_status IN (
            'complete', 
            'failed', 
            'terminated'
        )
    ),

    CONSTRAINT chk_result_nullable CHECK (
        CASE 
        WHEN terminal_status IS NULL 
        THEN result IS NULL
        ELSE TRUE
        END
    ),

    CONSTRAINT chk_updated_at CHECK (updated_at >= created_at),
    CONSTRAINT chk_finished_at CHECK (finished_at >= created_at),
    CONSTRAINT chk_deadline_at CHECK (deadline_at >= created_at),
    CONSTRAINT chk_complete_retention_deadline_at CHECK (complete_retention_deadline_at >= created_at),
    CONSTRAINT chk_failed_retention_deadline_at CHECK (failed_retention_deadline_at >= created_at),
    CONSTRAINT chk_cancelled_retention_deadline_at CHECK (cancelled_retention_deadline_at >= created_at),
    CONSTRAINT chk_killed_retention_deadline_at CHECK (killed_retention_deadline_at >= created_at),

    CONSTRAINT chk_finished_at_is_not_null CHECK (
        CASE WHEN
            terminal_status IS NOT NULL
            THEN finished_at IS NOT NULL
            ELSE finished_at IS NULL
        END
    ),

    CONSTRAINT chk_parent_id_is_not_null CHECK (
        CASE WHEN
            is_child AND NOT is_detached
            THEN parent_id IS NOT NULL
            WHEN is_child AND is_detached
            THEN TRUE  -- can become null
            ELSE parent_id IS NULL
        END
    ),

    CONSTRAINT chk_is_detached_is_not_null CHECK (
        CASE WHEN
            is_child = TRUE
            THEN is_detached IS NOT NULL
            ELSE is_detached IS NULL
        END
    ),

    CONSTRAINT fk_parent_workflow 
    FOREIGN KEY (parent_id) 
    REFERENCES {{schema}}.workflow(id)
    ON DELETE SET NULL
    ON UPDATE RESTRICT
);

-- =============================================================================
-- STEP EXECUTIONS (Operation Outputs and current state)
-- =============================================================================

CREATE TABLE {{schema}}.step_execution (
    id BIGSERIAL NOT NULL,
    workflow_id TEXT NOT NULL,

    max_attempts INTEGER,

    function_id INTEGER NOT NULL,  -- Monotonic sequence within workflow (0, 1, 2...)
    prev_function_id INTEGER GENERATED ALWAYS AS (
        CASE 
            WHEN function_id = 0 THEN NULL 
            ELSE function_id - 1 
        END
    ) STORED,
    _function_id INTEGER GENERATED ALWAYS AS (
        -- this says you cannot run next steps if your latest step 
        -- has not reached a terminal status
        CASE 
            WHEN terminal_status IS NULL
            THEN NULL
            ELSE function_id
        END
    ) STORED,

    function_name TEXT NOT NULL,
    action_type TEXT NOT NULL,

    terminal_status TEXT,
    result JSONB,

    compensation_to_step_execution_id BIGINT,
    waiting_for_child_workflow_id TEXT,

    -- Timing
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    
    count_deadline_from TIMESTAMPTZ,
    deadline_duration INTERVAL,
    deadline_at TIMESTAMPTZ GENERATED ALWAYS AS (
        count_deadline_from + deadline_duration
    ) STORED,
    
    -- constraints
    -- cannot use a conditional constraint
    -- because we'll use this for foreign key constraint
    CONSTRAINT unique_step_execution_function_id 
    UNIQUE (workflow_id, _function_id),

    CONSTRAINT unique_compensation_to_step_execution_id 
    UNIQUE (compensation_to_step_execution_id)
    WHERE compensation_to_step_execution_id IS NOT NULL,

    CONSTRAINT unique_non_terminal
    UNIQUE (workflow_id)
    WHERE terminal_status IS NULL,

    CONSTRAINT chk_terminal_status CHECK (
        terminal_status IS NULL OR terminal_status IN (
            'complete',
            'failed',
            'terminated',
            'max_attempts_exceeded',
            'timed_out'
        )
    ),

    CONSTRAINT chk_function_id CHECK (function_id >= 0),
    CONSTRAINT chk_action_type CHECK (action_type IN (
        'execute_step',
        'compensate_step',
        'execute_transaction',
        'compensate_transaction',
        'sleep',
        'send_to_channel',
        'receive_from_channel',
        'write_to_stream',
        'set_event',
        'start_child_workflow',
        'wait_for_child_workflow_result'
    )),

    CONSTRAINT chk_finished_at CHECK (finished_at >= created_at),
    CONSTRAINT chk_deadline_at CHECK (deadline_at >= created_at),
    CONSTRAINT chk_updated_at CHECK (updated_at >= created_at),
    CONSTRAINT chk_deadline_duration CHECK (deadline_duration >= INTERVAL '0 seconds'),
    CONSTRAINT chk_max_attempts CHECK (max_attempts > 0),

    CONSTRAINT chk_compensate_step_or_transaction CHECK (
        CASE WHEN
            action_type = 'compensate_transaction' OR action_type = 'compensate_step'
            THEN (
                compensation_to_step_execution_id IS NOT NULL
                AND result IS NULL
            )
            ELSE (
                compensation_to_step_execution_id IS NULL
            )
        END
    ),

    -- 1. send_to_channel constraint
    CONSTRAINT chk_send_to_channel CHECK (
        CASE 
            WHEN action_type = 'send_to_channel'
            THEN (
                result IS NULL
                AND
                -- cannot fail sending to a channel
                count_deadline_from IS NULL
                AND
                deadline_duration IS NULL
                AND
                terminal_status = 'complete'
            )
            ELSE TRUE
        END
    ),

    -- 2. write_to_stream constraint
    CONSTRAINT chk_write_to_stream CHECK (
        CASE
            WHEN action_type = 'write_to_stream'
            THEN (
                result IS NULL
                AND
                -- cannot fail writing to a stream
                count_deadline_from IS NULL
                AND
                deadline_duration IS NULL
                AND
                terminal_status = 'complete'
            )
            ELSE TRUE
        END
    ),

    -- 4. set_event constraint
    CONSTRAINT chk_set_event CHECK (
        CASE
            WHEN action_type = 'set_event'
            THEN (
                result IS NULL
                AND
                -- cannot fail setting an event
                count_deadline_from IS NULL
                AND
                deadline_duration IS NULL
                AND
                terminal_status = 'complete'
            )
            ELSE TRUE
        END
    ),

    -- 5. start_child_workflow constraint
    CONSTRAINT chk_start_child_workflow CHECK (
        CASE
            WHEN action_type = 'start_child_workflow'
            THEN (
                result IS NULL
                -- cannot fail starting a child workflow
                count_deadline_from IS NULL
                AND
                deadline_duration IS NULL
                AND
                terminal_status = 'complete'
            )
            ELSE TRUE
        END
    ),

    -- 8. sleep constraint
    CONSTRAINT chk_sleep CHECK (
        CASE
            WHEN action_type = 'sleep'
            THEN (
                result IS NULL 
                AND 
                count_deadline_from IS NOT NULL
                AND
                deadline_duration IS NOT NULL 
                AND
                (terminal_status IS NULL OR terminal_status = 'complete')
            )
            ELSE TRUE
        END
    ),

    -- 11. waiting_for_child_workflow_id must be non-null for wait operations in non-terminal states
    CONSTRAINT chk_waiting_for_child_workflow_result CHECK (
        CASE 
            WHEN action_type = 'wait_for_child_workflow_result'
            THEN (
                CASE
                    WHEN terminal_status IS NOT NULL
                    THEN waiting_for_child_workflow_id IS NOT NULL
                    ELSE TRUE
                END
            )
        ELSE waiting_for_child_workflow_id IS NULL
        END
    ),

    CONSTRAINT chk_finished_at_is_not_null CHECK (
        CASE WHEN
            terminal_status IS NOT NULL
            THEN finished_at IS NOT NULL
            ELSE finished_at IS NULL
        END
    ),

    CONSTRAINT fk_workflow 
    FOREIGN KEY (workflow_id) 
    REFERENCES {{schema}}.workflow(id)
    ON DELETE CASCADE
    ON UPDATE RESTRICT,

    -- constraint to ensure that we have a chain of step executions
    -- with monotonically increasing _function_id
    CONSTRAINT fk_prev_function 
    FOREIGN KEY (workflow_id, prev_function_id) 
    REFERENCES {{schema}}.step_execution(workflow_id, _function_id)
    ON DELETE SET NULL
    ON UPDATE RESTRICT,

    CONSTRAINT fk_compensation_to_step_execution 
    FOREIGN KEY (compensation_to_step_execution_id) 
    REFERENCES {{schema}}.step_execution(id)
    ON DELETE SET NULL
    ON UPDATE RESTRICT,

    CONSTRAINT fk_waiting_for_child_workflow
    FOREIGN KEY (waiting_for_child_workflow_id)
    REFERENCES {{schema}}.workflow(id)
    ON DELETE SET NULL
    ON UPDATE RESTRICT
);

ALTER TABLE {{schema}}.workflow 
ADD CONSTRAINT fk_started_by_step_execution 
FOREIGN KEY (started_by_step_execution_id) 
REFERENCES {{schema}}.step_execution(id)
ON DELETE SET NULL
ON UPDATE RESTRICT;

-- =============================================================================
-- STEP EXECUTION ATTEMPTS
-- =============================================================================

CREATE TABLE {{schema}}.step_execution_attempt (
    id BIGSERIAL PRIMARY KEY,
    step_execution_id BIGINT NOT NULL,

    terminal_status TEXT,
    result JSONB,

    -- timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    
    count_deadline_from TIMESTAMPTZ,
    deadline_duration INTERVAL,
    deadline_at TIMESTAMPTZ GENERATED ALWAYS AS (
        count_deadline_from + deadline_duration
    ) STORED,
    
    -- make sure that there is only one complete for a step execution
    -- and make sure that there is only one attempt in progress for a step execution
    CONSTRAINT unique_complete_step_execution_attempt UNIQUE (
        step_execution_id
    ) WHERE terminal_status = 'complete' OR terminal_status IS NULL,
    
    CONSTRAINT chk_terminal_status CHECK (
        terminal_status IS NULL OR terminal_status IN (
            'complete',
            'failed',
            'terminated',
            'timed_out'
        )
    ),

    CONSTRAINT chk_finished_at_is_not_null CHECK (
        CASE WHEN
            terminal_status IS NOT NULL
            THEN finished_at IS NOT NULL
            ELSE finished_at IS NULL
        END
    ),

    CONSTRAINT fk_step_execution 
    FOREIGN KEY (step_execution_id) 
    REFERENCES {{schema}}.step_execution(id)
    ON DELETE CASCADE
    ON UPDATE RESTRICT,
    
    CONSTRAINT chk_finished_at CHECK (finished_at >= created_at),
    CONSTRAINT chk_deadline_at CHECK (deadline_at >= created_at),
    CONSTRAINT chk_updated_at CHECK (updated_at >= created_at),
    CONSTRAINT chk_deadline_duration CHECK (deadline_duration >= INTERVAL '0 seconds')
);

-- =============================================================================
-- COMPENSATION FAILURE RESOLUTION
-- =============================================================================

CREATE TABLE {{schema}}.compensation_failure (
    id BIGSERIAL PRIMARY KEY,
    step_execution_id BIGINT NOT NULL,
    decision TEXT,
    resolution_comment TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    
    CONSTRAINT chk_decision CHECK (
        decision IS NULL OR decision IN (
            'retry',
            'skip',
            'stop'
        )
    ),

    CONSTRAINT chk_resolution_comment_nullable CHECK (
        CASE WHEN
            decision IS NOT NULL
            THEN resolution_comment IS NOT NULL
            ELSE resolution_comment IS NULL
        END
    ),

    CONSTRAINT unique_step_execution_id 
    UNIQUE (step_execution_id)
    WHERE decision IS NULL,

    CONSTRAINT chk_resolved_at_is_not_null CHECK (
        CASE WHEN
            decision IS NOT NULL
            THEN resolved_at IS NOT NULL
            ELSE resolved_at IS NULL
        END
    ),

    CONSTRAINT fk_step_execution 
    FOREIGN KEY (step_execution_id) 
    REFERENCES {{schema}}.step_execution(id)
    ON DELETE CASCADE
    ON UPDATE RESTRICT
);

-- =============================================================================
-- CHANNELS (Message Passing)
-- =============================================================================

CREATE TABLE {{schema}}.channel_message (
    id BIGSERIAL PRIMARY KEY,

    sent_from_workflow BOOLEAN NOT NULL,
    -- workflow source can be fetched from the step execution
    sent_by_step_execution_id BIGINT,

     -- Dedicated sequence for ordering (globally incrementing)
    seq_num BIGINT NOT NULL DEFAULT nextval('{{schema}}.channel_message_seq_num_seq'),

    dest_workflow_id TEXT NOT NULL,

    channel_name TEXT NOT NULL,
    data JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT sent_by_step_execution_id_nullable CHECK (
        CASE
        WHEN NOT sent_from_workflow
        THEN sent_by_step_execution_id IS NULL
        ELSE TRUE
        END
    ),

    CONSTRAINT unique_seq_num_per_channel
    UNIQUE (seq_num, channel_name),
    
    CONSTRAINT unique_sent_by_step_execution_id
    UNIQUE (sent_by_step_execution_id)
    WHERE sent_by_step_execution_id IS NOT NULL,

    CONSTRAINT fk_dest_workflow_id
    FOREIGN KEY (dest_workflow_id)
    REFERENCES {{schema}}.workflow(id)
    ON DELETE CASCADE
    ON UPDATE RESTRICT,

    CONSTRAINT fk_sent_by_step_execution
    FOREIGN KEY (sent_by_step_execution_id)
    REFERENCES {{schema}}.step_execution(id)
    ON DELETE SET NULL
    ON UPDATE RESTRICT
);

-- =============================================================================
-- STREAMS (Append-Only Logs)
-- =============================================================================

CREATE TABLE {{schema}}.stream_record (
    id BIGSERIAL PRIMARY KEY,

    written_by_step_execution_id BIGINT NOT NULL,

    record_offset INTEGER NOT NULL,

    prev_record_offset INTEGER GENERATED ALWAYS AS (
        CASE WHEN record_offset = 0 
            THEN NULL 
            ELSE record_offset - 1 
        END
    ) STORED,

    workflow_id TEXT NOT NULL,

    stream_name TEXT NOT NULL,
    data JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- cannot use a conditional constraint
    -- because we'll use this for foreign key constraint
    CONSTRAINT unique_streamrecord_offset UNIQUE (
        workflow_id, 
        stream_name, 
        record_offset
    ),

    CONSTRAINT unique_written_by_step_execution_id
    UNIQUE (written_by_step_execution_id)   
    WHERE written_by_step_execution_id IS NOT NULL,

    CONSTRAINT chk_record_offset CHECK (record_offset >= 0),

    CONSTRAINT fk_prev_record
    FOREIGN KEY (
        workflow_id, 
        stream_name, 
        prev_record_offset
    )
    REFERENCES {{schema}}.stream_record(
        workflow_id, 
        stream_name, 
        record_offset
    )
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,

    CONSTRAINT fk_workflow
    FOREIGN KEY (workflow_id)
    REFERENCES {{schema}}.workflow(id)
    ON DELETE CASCADE
    ON UPDATE RESTRICT,

    CONSTRAINT fk_written_by_step_execution
    FOREIGN KEY (written_by_step_execution_id)
    REFERENCES {{schema}}.step_execution(id)
    ON DELETE SET NULL
    ON UPDATE RESTRICT
);


-- =============================================================================
-- EVENTS (Write-Once Flags)
-- =============================================================================

CREATE TABLE {{schema}}.workflow_event (
    id BIGSERIAL PRIMARY KEY,
    set_by_step_execution_id BIGINT NOT NULL,
    workflow_id TEXT NOT NULL,
    event_name TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT unique_workflow_id_event_name 
    UNIQUE (workflow_id, event_name),

    CONSTRAINT unique_set_by_step_execution_id
    UNIQUE (set_by_step_execution_id)
    WHERE set_by_step_execution_id IS NOT NULL,

    CONSTRAINT fk_set_by_step_execution
    FOREIGN KEY (set_by_step_execution_id)
    REFERENCES {{schema}}.step_execution(id)
    ON DELETE CASCADE
    ON UPDATE RESTRICT,

    CONSTRAINT fk_workflow
    FOREIGN KEY (workflow_id)
    REFERENCES {{schema}}.workflow(id)
    ON DELETE CASCADE
    ON UPDATE RESTRICT
);
