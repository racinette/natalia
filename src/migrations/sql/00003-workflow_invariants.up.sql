-- === UPDATE INVARIANTS ===

CREATE FUNCTION {{schema}}.enforce_workflow_update_invariants()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.id IS DISTINCT FROM NEW.id THEN
        RAISE EXCEPTION 'id is immutable and cannot be changed';
    END IF;

    IF OLD.parent_id IS DISTINCT FROM NEW.parent_id THEN
        IF NEW.parent_id IS NULL THEN
            -- old parent_id was not null, and now it's null
            IF EXISTS (SELECT 1 FROM {{schema}}.workflow WHERE id = OLD.parent_id) THEN
                -- the parent still exists, so we can't clear the parent_id
                RAISE EXCEPTION 'parent_id cannot be cleared if the workflow has a parent';
            END IF;
        ELSE
            -- in any other case we don't allow changing the parent_id
            -- it can only be set at insertion time and never changed
            RAISE EXCEPTION 'parent_id is immutable and cannot be changed';
        END IF;
    END IF;

    IF OLD.is_child IS DISTINCT FROM NEW.is_child THEN
        RAISE EXCEPTION 'is_child is immutable and cannot be changed';
    END IF;

    IF OLD.is_detached IS DISTINCT FROM NEW.is_detached THEN
        RAISE EXCEPTION 'is_detached is immutable and cannot be changed';
    END IF;

    IF OLD.function_name IS DISTINCT FROM NEW.function_name THEN
        RAISE EXCEPTION 'function_name is immutable and cannot be changed';
    END IF;
    
    IF OLD.arguments IS DISTINCT FROM NEW.arguments THEN
        RAISE EXCEPTION 'arguments is immutable and cannot be changed';
    END IF;

    IF OLD.created_at IS DISTINCT FROM NEW.created_at THEN
        RAISE EXCEPTION 'created_at is immutable and cannot be changed';
    END IF;

    IF OLD.seed IS DISTINCT FROM NEW.seed THEN
        RAISE EXCEPTION 'seed is immutable and cannot be changed';
    END IF;

    IF OLD.result IS NOT NULL AND NEW.result IS NULL THEN 
        RAISE EXCEPTION 'result is immutable and cannot be cleared';
    END IF;

    IF OLD.result IS NOT NULL AND NEW.result IS NOT NULL AND OLD.result IS DISTINCT FROM NEW.result THEN
        RAISE EXCEPTION 'result is immutable and cannot be changed';
    END IF;

    IF OLD.finished_at IS NOT NULL AND NEW.finished_at IS DISTINCT FROM OLD.finished_at THEN
        RAISE EXCEPTION 'finished_at is immutable and cannot be changed';
    END IF;

    IF OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
        RAISE EXCEPTION 'started_at is immutable and cannot be changed';
    END IF;

    IF OLD.started_by_step_execution_id IS DISTINCT FROM NEW.started_by_step_execution_id THEN
        IF NEW.started_by_step_execution_id IS NULL THEN
            -- old started_by_step_execution_id was not null, and now it's null
            IF EXISTS (SELECT 1 FROM {{schema}}.step_execution WHERE id = OLD.started_by_step_execution_id) THEN
                -- the step execution still exists, so we can't clear the started_by_step_execution_id
                RAISE EXCEPTION 'started_by_step_execution_id cannot be cleared if the step execution still exists';
            END IF;
        ELSE
            -- in any other case we don't allow changing the started_by_step_execution_id
            -- it can only be set at insertion time and never changed
            RAISE EXCEPTION 'started_by_step_execution_id is immutable and cannot be changed';
        END IF;
    END IF;

    IF OLD.terminal_status IS DISTINCT FROM NEW.terminal_status THEN
        IF OLD.terminal_status IS NOT NULL THEN 
            RAISE EXCEPTION 'terminal_status is immutable and cannot be changed';
        ELSE
            NEW.executor_id = NULL;
            IF NEW.terminal_status = 'complete' THEN
                -- need to make sure that there is no step execution that is running or pending
                IF EXISTS (SELECT 1 FROM {{schema}}.step_execution WHERE workflow_id = OLD.id AND terminal_status IS NULL) THEN
                    RAISE EXCEPTION 'There is a running step execution, cannot transition to complete';
                END IF;
            ELSIF NEW.terminal_status = 'failed' THEN
                -- need to make sure that there is no step execution that is running or pending
                IF EXISTS (SELECT 1 FROM {{schema}}.step_execution WHERE workflow_id = OLD.id AND terminal_status IS NULL) THEN
                    RAISE EXCEPTION 'There is a running step execution, cannot transition to failed';
                END IF;
            ELSIF NEW.terminal_status IN (
                'killed_by_parent', 
                'killed_externally', 
                'cancelled_externally', 
                'cancelled_by_parent', 
                'timed_out'
            ) THEN
                -- propagate the kill signal
                -- kill the currently running/pending step
                UPDATE {{schema}}.step_execution
                SET terminal_status = 'terminated'
                WHERE workflow_id = OLD.id AND terminal_status IS NULL;
            END IF;
        END IF;
    END IF;

    IF OLD.executor_id IS DISTINCT FROM NEW.executor_id THEN
        IF NEW.terminal_status IS NOT NULL AND NEW.executor_id IS NOT NULL THEN
            RAISE EXCEPTION 'executor_id cannot be set when terminal_status is not null';
        END IF;

        IF NEW.terminal_status IS NULL AND (OLD.executor_id IS NOT NULL AND NEW.executor_id IS NOT NULL) THEN
            -- the workflow is already being executed by another executor
            -- we can RELEASE the workflow by setting to NULL, but never explicitly steal it
            -- this ensures the workflow will be redistributed fairly
            RAISE EXCEPTION 'cannot steal workflow from another executor';
        END IF;
    END IF;

    -- if the record has been updated, but the updated_at is the same,
    -- we need to update the updated_at to the current time
    IF (OLD IS DISTINCT FROM NEW) AND (OLD.updated_at IS NOT DISTINCT FROM NEW.updated_at) THEN
        NEW.updated_at = NOW();
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_enforce_workflow_update_invariants
BEFORE UPDATE ON {{schema}}.workflow
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.enforce_workflow_update_invariants();


-- === INSERT INVARIANTS ===
CREATE FUNCTION {{schema}}.enforce_workflow_insert_invariants()
RETURNS TRIGGER AS $$
BEGIN

    IF NEW.status <> 'pending' THEN
        RAISE EXCEPTION 'workflow cannot be inserted with a status other than pending';
    END IF;

    IF NEW.result IS NOT NULL THEN
        RAISE EXCEPTION 'result cannot be set at insertion time';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


CREATE TRIGGER trigger_enforce_workflow_insert_invariants
BEFORE INSERT ON {{schema}}.workflow
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.enforce_workflow_insert_invariants();

-- === DELETE INVARIANTS ===
CREATE FUNCTION {{schema}}.enforce_workflow_delete_invariants()
RETURNS TRIGGER AS $$
DECLARE
    terminal_statuses TEXT[] := ARRAY['complete', 'failed', 'cancelled', 'killed'];
BEGIN
    IF OLD.status <> ALL(terminal_statuses) THEN
        RAISE EXCEPTION 'workflow cannot be deleted if the status is not a terminal status, allowed statuses: %', ARRAY_TO_STRING(terminal_statuses, ', ');
    END IF;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_enforce_workflow_delete_invariants
BEFORE DELETE ON {{schema}}.workflow
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.enforce_workflow_delete_invariants();
