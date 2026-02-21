-- === UPDATE INVARIANTS ===
CREATE FUNCTION {{schema}}.enforce_step_execution_update_invariants()
RETURNS TRIGGER AS $$
DECLARE
    workflow_status_when_pending TEXT[] := ARRAY['pending', 'paused', 'complete', 'running', 'cancelling'];
    workflow_status_when_running TEXT[] := ARRAY['running', 'cancelling'];
    workflow_status_when_complete TEXT[] := ARRAY[
        'running',
        'cancelling',
        'paused'  -- use case: paused the workflow to manually interfere with the step execution
    ];
    workflow_status_when_failed TEXT[] := ARRAY[
        'running',
        'cancelling',
        'paused'
    ];
    workflow_status_when_killed TEXT[] := ARRAY[
        'running',
        'cancelling',
        'paused',
        'killed'
    ];
BEGIN
    IF OLD.id IS DISTINCT FROM NEW.id THEN
        RAISE EXCEPTION 'id is immutable and cannot be changed';
    END IF;

    IF OLD.workflow_id IS DISTINCT FROM NEW.workflow_id THEN
        RAISE EXCEPTION 'workflow_id is immutable and cannot be changed';
    END IF;

    IF OLD.function_id IS DISTINCT FROM NEW.function_id THEN
        RAISE EXCEPTION 'function_id is immutable and cannot be changed';
    END IF;

    IF OLD.function_name IS DISTINCT FROM NEW.function_name THEN
        RAISE EXCEPTION 'function_name is immutable and cannot be changed';
    END IF;

    IF OLD.action_type IS DISTINCT FROM NEW.action_type THEN
        RAISE EXCEPTION 'action_type is immutable and cannot be changed';
    END IF;

    IF OLD.cause_of_death IS NOT NULL AND OLD.cause_of_death IS DISTINCT FROM NEW.cause_of_death THEN 
        RAISE EXCEPTION 'cause_of_death is immutable and cannot be changed';
    END IF;

    IF OLD.status IS DISTINCT FROM NEW.status THEN
        IF OLD.status = 'pending' THEN
            -- effectively allow change from pending to any status
        ELSIF OLD.status = 'running' THEN
            -- effectively allow change from running to any status
        ELSIF OLD.status = 'complete' THEN
            RAISE EXCEPTION 'complete is a terminal status and cannot be transitioned';
        ELSIF OLD.status = 'failed' THEN
            RAISE EXCEPTION 'failed is a terminal status and cannot be transitioned';
        ELSIF OLD.status = 'killed' THEN
            RAISE EXCEPTION 'killed is a terminal status and cannot be transitioned';
        END IF;

        IF NEW.status = 'pending' THEN
            IF NOT EXISTS (
                SELECT 1 
                FROM {{schema}}.workflow 
                WHERE id = OLD.workflow_id AND status = ANY(workflow_status_when_pending)
            ) THEN
                RAISE EXCEPTION 'step execution cannot be pending if the workflow is not in a % state', ARRAY_TO_STRING(workflow_status_when_pending, ', ');
            END IF;
            
            -- we need to stop the current attempt
            UPDATE {{schema}}.step_execution_attempt
            SET status = 'killed',
                cause_of_death = 'step_execution_pending'
            WHERE step_execution_id = OLD.id AND status IN ('pending', 'running');

        ELSIF NEW.status = 'running' THEN
            IF NOT EXISTS (
                SELECT 1 
                FROM {{schema}}.workflow 
                WHERE id = OLD.workflow_id AND status = ANY(workflow_status_when_running)
            ) THEN
                RAISE EXCEPTION 'step execution cannot be running if the workflow is not in a % state', ARRAY_TO_STRING(workflow_status_when_running, ', ');
            END IF;
            -- check deadline reached
            IF NEW.deadline_at IS NOT NULL AND NEW.deadline_at < NOW() THEN
                RAISE EXCEPTION 'step execution cannot be running if the deadline has been reached';
            END IF;
            -- check max attempts exceeded
            IF NEW.max_attempts IS NOT NULL AND (
                SELECT COUNT(*) FROM {{schema}}.step_execution_attempt 
                WHERE step_execution_id = OLD.id AND status = 'failed'
            ) >= NEW.max_attempts THEN
                RAISE EXCEPTION 'Max execution attempts (%s) has been reached', NEW.max_attempts;
            END IF;
            -- we do not take action here, we only prevent invalid state transition
        ELSIF NEW.status = 'complete' THEN
            IF NOT EXISTS (
                SELECT 1 
                FROM {{schema}}.workflow 
                WHERE id = OLD.workflow_id AND status = ANY(workflow_status_when_complete)
            ) THEN
                RAISE EXCEPTION 'step execution cannot be complete if the workflow is not in a % state', ARRAY_TO_STRING(workflow_status_when_complete, ', ');
            END IF;
        ELSIF NEW.status = 'failed' THEN
            IF NOT EXISTS (
                SELECT 1 
                FROM {{schema}}.workflow 
                WHERE id = OLD.workflow_id AND status = ANY(workflow_status_when_failed)
            ) THEN
                RAISE EXCEPTION 'step execution cannot be failed if the workflow is not in a % state', ARRAY_TO_STRING(workflow_status_when_failed, ', ');
            END IF;
        ELSIF NEW.status = 'killed' THEN
            IF NEW.cause_of_death = 'workflow_cancelled' THEN
                IF NOT EXISTS (
                    SELECT 1 
                    FROM {{schema}}.workflow 
                    WHERE id = OLD.workflow_id AND status IN ('cancelling', 'cancelled')
                ) THEN
                    RAISE EXCEPTION 'step execution cannot be killed with a workflow_cancelled cause of death if the workflow is not in a cancelling or cancelled state';
                END IF;
            ELSIF NEW.cause_of_death = 'workflow_killed' THEN
                IF NOT EXISTS (
                    SELECT 1 
                    FROM {{schema}}.workflow 
                    WHERE id = OLD.workflow_id AND status = 'killed'
                ) THEN
                    RAISE EXCEPTION 'step execution cannot be killed with a workflow_killed cause of death if the workflow is not in a killed state';
                END IF;
            END IF;
        END IF;
    END IF;

    IF OLD.result IS NOT NULL AND NEW.result IS NULL THEN 
        RAISE EXCEPTION 'result is immutable and cannot be cleared';
    END IF;

    IF OLD.result IS NOT NULL AND NEW.result IS NOT NULL AND OLD.result IS DISTINCT FROM NEW.result THEN
        RAISE EXCEPTION 'result is immutable and cannot be changed';
    END IF;

    IF OLD.compensation_to_step_execution_id IS DISTINCT FROM NEW.compensation_to_step_execution_id THEN
        RAISE EXCEPTION 'compensation_to_step_execution_id is immutable and cannot be changed';
    END IF;

    IF OLD.waiting_for_child_workflow_id IS DISTINCT FROM NEW.waiting_for_child_workflow_id THEN
        IF NEW.waiting_for_child_workflow_id IS NULL THEN
            -- old waiting_for_child_workflow_id was not null, and now it's null
            IF EXISTS (SELECT 1 FROM {{schema}}.workflow WHERE id = OLD.waiting_for_child_workflow_id) THEN
                -- the workflow still exists, so we can't clear the waiting_for_child_workflow_id
                RAISE EXCEPTION 'waiting_for_child_workflow_id cannot be cleared if the workflow still exists';
            END IF;
        ELSE
            -- in any other case we don't allow changing the waiting_for_child_workflow_id
            -- it can only be set at insertion time and never changed
            RAISE EXCEPTION 'waiting_for_child_workflow_id is immutable and cannot be changed';
        END IF;
    END IF;

    IF OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION 'created_at is immutable and cannot be changed';
    END IF;

    IF OLD.started_at IS DISTINCT FROM NEW.started_at THEN
        RAISE EXCEPTION 'started_at is immutable and cannot be changed';
    END IF;

    IF OLD.finished_at IS NOT NULL AND NEW.finished_at IS DISTINCT FROM OLD.finished_at THEN
        RAISE EXCEPTION 'finished_at is immutable and cannot be changed';
    END IF;

    -- if the record has been updated, but the updated_at is the same,
    -- we need to update the updated_at to the current time
    IF (OLD IS DISTINCT FROM NEW) AND (OLD.updated_at IS NOT DISTINCT FROM NEW.updated_at) THEN
        NEW.updated_at = NOW();
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


CREATE TRIGGER trigger_enforce_step_execution_update_invariants
BEFORE UPDATE ON {{schema}}.step_execution
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.enforce_step_execution_update_invariants();


-- === INSERT INVARIANTS ===

CREATE FUNCTION {{schema}}.enforce_step_execution_insert_invariants()
RETURNS TRIGGER AS $$
DECLARE 
    step_execution_status_when_inserting TEXT[] := ARRAY['complete', 'pending'];
    workflow_status_when_inserting TEXT[] := ARRAY['running', 'cancelling'];
    executable_action_types TEXT[] := ARRAY['execute_step', 'execute_transaction', 'compensate_step', 'compensate_transaction'];
BEGIN
    IF NEW.status <> ALL(step_execution_status_when_inserting) THEN
        RAISE EXCEPTION 'step execution cannot be inserted with status %, allowed statuses: %', NEW.status, ARRAY_TO_STRING(step_execution_status_when_inserting, ', ');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM {{schema}}.workflow WHERE id = NEW.workflow_id AND status = ANY(workflow_status_when_inserting)) THEN
        RAISE EXCEPTION 'step execution cannot be inserted if the workflow is not in a % state', ARRAY_TO_STRING(workflow_status_when_inserting, ', ');
    END IF;

    IF NEW.action_type = ANY(executable_action_types) THEN
        IF NEW.status <> 'pending' THEN 
            RAISE EXCEPTION 'step execution cannot be inserted with status % if the action type is %', NEW.status, NEW.action_type;
        END IF;

        IF NEW.result IS NOT NULL THEN 
            RAISE EXCEPTION 'result cannot be set at insertion time for action type %', NEW.action_type;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_enforce_step_execution_insert_invariants
BEFORE INSERT ON {{schema}}.step_execution
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.enforce_step_execution_insert_invariants();

-- === DELETE INVARIANTS ===

CREATE FUNCTION {{schema}}.enforce_step_execution_delete_invariants()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM {{schema}}.workflow WHERE id = NEW.workflow_id) THEN
        RAISE EXCEPTION 'step execution cannot be deleted if the workflow still exists';
    END IF;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_enforce_step_execution_delete_invariants
BEFORE DELETE ON {{schema}}.step_execution
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.enforce_step_execution_delete_invariants();
