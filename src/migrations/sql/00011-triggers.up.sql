
-- =============================================================================
-- CROSS-TABLE SEMANTIC INTEGRITY TRIGGERS
-- =============================================================================

-- =============================================================================
-- IMMUTABILITY TRIGGERS
-- =============================================================================

-- Trigger: Enforce action_type immutability
CREATE FUNCTION {{schema}}.enforce_action_type_immutability()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.action_type != NEW.action_type THEN
        RAISE EXCEPTION 'action_type is immutable and cannot be changed from % to %', 
            OLD.action_type, NEW.action_type;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_enforce_action_type_immutability
BEFORE UPDATE ON {{schema}}.step_execution
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.enforce_action_type_immutability();

-- Prevent individual record deletion entirely
CREATE FUNCTION {{schema}}.prevent_stream_record_deletion()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Stream records cannot be deleted individually. Delete the workflow to cascade delete all records.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_prevent_stream_record_deletion
BEFORE DELETE ON {{schema}}.stream_record
FOR EACH ROW
WHEN (pg_trigger_depth() = 0)  -- Only prevent direct deletes, not cascades
EXECUTE FUNCTION {{schema}}.prevent_stream_record_deletion();

-- =============================================================================
-- STATUS STATE MACHINE TRIGGERS
-- =============================================================================

-- Trigger: Enforce workflow status state machine
CREATE FUNCTION {{schema}}.enforce_workflow_status_transitions()
RETURNS TRIGGER AS $$
BEGIN
    -- Define valid transitions
    -- pending -> running, cancelled, killed
    -- running -> cancelling, complete, failed, killed
    -- cancelling -> cancelled, killed
    -- Terminal states (complete, failed, cancelled, killed) cannot transition
    
    IF OLD.status = NEW.status THEN
        RETURN NEW; -- No change, allow
    END IF;
    
    -- From pending
    IF OLD.status = 'pending' THEN
        IF NEW.status NOT IN ('running', 'cancelled', 'killed') THEN
            RAISE EXCEPTION 'Invalid workflow status transition: pending -> %. Valid: running, cancelled, killed', NEW.status;
        END IF;
    -- From running
    ELSIF OLD.status = 'running' THEN
        IF NEW.status NOT IN ('cancelling', 'complete', 'failed', 'killed') THEN
            RAISE EXCEPTION 'Invalid workflow status transition: running -> %. Valid: cancelling, complete, failed, killed', NEW.status;
        END IF;
    -- From cancelling
    ELSIF OLD.status = 'cancelling' THEN
        IF NEW.status NOT IN ('cancelled', 'killed') THEN
            RAISE EXCEPTION 'Invalid workflow status transition: cancelling -> %. Valid: cancelled, killed', NEW.status;
        END IF;
    -- From terminal states - no transitions allowed
    ELSIF OLD.status IN ('complete', 'failed', 'cancelled', 'killed') THEN
        RAISE EXCEPTION 'Cannot transition from terminal workflow status %', OLD.status;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_enforce_workflow_status_transitions
BEFORE UPDATE ON {{schema}}.workflow
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.enforce_workflow_status_transitions();

-- Trigger: Enforce step_execution status state machine
CREATE FUNCTION {{schema}}.enforce_step_execution_status_transitions()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = NEW.status THEN
        RETURN NEW; -- No change, allow
    END IF;
    
    -- From pending
    IF OLD.status = 'pending' THEN
        IF NEW.status NOT IN ('running', 'cancelled', 'killed') THEN
            RAISE EXCEPTION 'Invalid step_execution status transition: pending -> %. Valid: running, cancelled, killed', NEW.status;
        END IF;
    -- From running
    ELSIF OLD.status = 'running' THEN
        IF NEW.status NOT IN ('cancelling', 'complete', 'failed', 'killed') THEN
            RAISE EXCEPTION 'Invalid step_execution status transition: running -> %. Valid: cancelling, complete, failed, killed', NEW.status;
        END IF;
    -- From cancelling
    ELSIF OLD.status = 'cancelling' THEN
        IF NEW.status NOT IN ('cancelled', 'killed') THEN
            RAISE EXCEPTION 'Invalid step_execution status transition: cancelling -> %. Valid: cancelled, killed', NEW.status;
        END IF;
    -- From terminal states - no transitions allowed
    ELSIF OLD.status IN ('complete', 'failed', 'cancelled', 'killed') THEN
        RAISE EXCEPTION 'Cannot transition from terminal step_execution status %', OLD.status;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_enforce_step_execution_status_transitions
BEFORE UPDATE ON {{schema}}.step_execution
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.enforce_step_execution_status_transitions();

-- Trigger: Enforce step_execution_attempt status state machine
CREATE FUNCTION {{schema}}.enforce_step_execution_attempt_status_transitions()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = NEW.status THEN
        RETURN NEW; -- No change, allow
    END IF;
    
    -- From pending
    IF OLD.status = 'pending' THEN
        IF NEW.status NOT IN ('running', 'cancelled', 'killed') THEN
            RAISE EXCEPTION 'Invalid step_execution_attempt status transition: pending -> %. Valid: running, cancelled, killed', NEW.status;
        END IF;
    -- From running
    ELSIF OLD.status = 'running' THEN
        IF NEW.status NOT IN ('cancelling', 'complete', 'failed', 'killed') THEN
            RAISE EXCEPTION 'Invalid step_execution_attempt status transition: running -> %. Valid: cancelling, complete, failed, killed', NEW.status;
        END IF;
    -- From cancelling
    ELSIF OLD.status = 'cancelling' THEN
        IF NEW.status NOT IN ('cancelled', 'killed') THEN
            RAISE EXCEPTION 'Invalid step_execution_attempt status transition: cancelling -> %. Valid: cancelled, killed', NEW.status;
        END IF;
    -- From terminal states - no transitions allowed
    ELSIF OLD.status IN ('complete', 'failed', 'cancelled', 'killed') THEN
        RAISE EXCEPTION 'Cannot transition from terminal step_execution_attempt status %', OLD.status;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_enforce_step_execution_attempt_status_transitions
BEFORE UPDATE ON {{schema}}.step_execution_attempt
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.enforce_step_execution_attempt_status_transitions();

-- =============================================================================
-- ACTION TYPE SEMANTIC CONSTRAINTS (Simplified with immutable action_type)
-- =============================================================================

-- Trigger 1: Compensation Must Reference Correct Action Type
CREATE FUNCTION {{schema}}.check_compensation_target_action_type()
RETURNS TRIGGER AS $$
DECLARE
    target_action_type TEXT;
BEGIN
    -- Only check if this is a compensation action
    IF NEW.action_type NOT IN ('compensate_step', 'compensate_transaction') THEN
        RETURN NEW;
    END IF;
    
    -- Verify the referenced step has correct action_type
    SELECT action_type INTO target_action_type
    FROM {{schema}}.step_execution
    WHERE id = NEW.compensation_to_step_execution_id;
    
    IF NEW.action_type = 'compensate_step' AND target_action_type != 'execute_step' THEN
        RAISE EXCEPTION 'compensate_step must reference execute_step, but references %', target_action_type;
    END IF;
    
    IF NEW.action_type = 'compensate_transaction' AND target_action_type != 'execute_transaction' THEN
        RAISE EXCEPTION 'compensate_transaction must reference execute_transaction, but references %', target_action_type;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_check_compensation_target_action_type
BEFORE INSERT ON {{schema}}.step_execution
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.check_compensation_target_action_type();

-- Trigger 2: Previous Step Status State Machine (Forward vs Compensation)
CREATE FUNCTION {{schema}}.check_prev_step_status()
RETURNS TRIGGER AS $$
DECLARE
    prev_step_status TEXT;
    is_compensation BOOLEAN;
BEGIN
    -- Only check if there is a previous step
    IF NEW.prev_function_id IS NULL THEN
        RETURN NEW;
    END IF;
    
    -- Get previous step's status
    SELECT status INTO prev_step_status
    FROM {{schema}}.step_execution
    WHERE workflow_id = NEW.workflow_id 
      AND function_id = NEW.prev_function_id;
    
    -- Determine if current step is compensation (immutable, so safe to check)
    is_compensation := NEW.action_type IN ('compensate_step', 'compensate_transaction');
    
    IF is_compensation THEN
        -- Compensation: previous must be failed or cancelled
        IF prev_step_status NOT IN ('failed', 'cancelled') THEN
            RAISE EXCEPTION 'Compensation step (function_id=%) requires previous step to be failed/cancelled, but previous (function_id=%) has status=%',
                NEW.function_id, NEW.prev_function_id, prev_step_status;
        END IF;
    ELSE
        -- Forward execution: previous must be complete
        IF prev_step_status != 'complete' THEN
            RAISE EXCEPTION 'Forward execution step (function_id=%) requires previous step to be complete, but previous (function_id=%) has status=%',
                NEW.function_id, NEW.prev_function_id, prev_step_status;
        END IF;
    END IF;
    
    -- Nothing can come after killed
    IF prev_step_status = 'killed' THEN
        RAISE EXCEPTION 'No step can follow a killed step (function_id=%)', NEW.prev_function_id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_check_prev_step_status
BEFORE INSERT ON {{schema}}.step_execution
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.check_prev_step_status();

-- Trigger 3: Step Execution Attempts Only For Retryable Actions
CREATE FUNCTION {{schema}}.check_step_execution_attempt_allowed()
RETURNS TRIGGER AS $$
DECLARE
    step_action_type TEXT;
BEGIN
    -- Get the action_type of the referenced step_execution
    SELECT action_type INTO step_action_type
    FROM {{schema}}.step_execution
    WHERE id = NEW.step_execution_id;
    
    -- Only retryable operations can have attempts
    IF step_action_type NOT IN (
        'execute_step',
        'compensate_step',
        'execute_transaction',
        'compensate_transaction'
    ) THEN
        RAISE EXCEPTION 'step_execution_attempt cannot be created for action_type=%. Only retryable actions (execute_step, compensate_step, execute_transaction, compensate_transaction) can have attempts.',
            step_action_type;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_check_step_execution_attempt_allowed
BEFORE INSERT ON {{schema}}.step_execution_attempt
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.check_step_execution_attempt_allowed();

-- =============================================================================
-- CROSS-TABLE REFERENCE CONSTRAINTS
-- =============================================================================

-- Trigger 5: Channel Message Sender Constraints
CREATE FUNCTION {{schema}}.check_channel_message_sender()
RETURNS TRIGGER AS $$
DECLARE
    sender_action_type TEXT;
    sender_workflow_id TEXT;
BEGIN
    -- If sent from a workflow, verify constraints
    IF NEW.sent_from_workflow AND NEW.sent_by_step_execution_id IS NOT NULL THEN
        SELECT action_type, workflow_id 
        INTO sender_action_type, sender_workflow_id
        FROM {{schema}}.step_execution
        WHERE id = NEW.sent_by_step_execution_id;
        
        -- Must be send_to_channel action
        IF sender_action_type != 'send_to_channel' THEN
            RAISE EXCEPTION 'channel_message.sent_by_step_execution_id must reference action_type=send_to_channel, but references %',
                sender_action_type;
        END IF;
        
        -- Cannot send to self
        IF sender_workflow_id = NEW.dest_workflow_id THEN
            RAISE EXCEPTION 'Workflow cannot send channel message to itself (workflow_id=%)', sender_workflow_id;
        END IF;
    END IF;
    
    -- Enforce sent_from_workflow flag consistency
    -- on insert only, because sender workflow might be deleted in the future
    -- but it must exist in the database at the time of sending the message
    IF NEW.sent_from_workflow AND NEW.sent_by_step_execution_id IS NULL THEN
        RAISE EXCEPTION 'If sent_from_workflow=true, sent_by_step_execution_id must be set';
    END IF;
    
    IF NOT NEW.sent_from_workflow AND NEW.sent_by_step_execution_id IS NOT NULL THEN
        RAISE EXCEPTION 'If sent_from_workflow=false, sent_by_step_execution_id must be NULL';
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_check_channel_message_sender
BEFORE INSERT ON {{schema}}.channel_message
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.check_channel_message_sender();

-- Trigger 6: Stream Record Writer Constraints
CREATE FUNCTION {{schema}}.check_stream_record_writer()
RETURNS TRIGGER AS $$
DECLARE
    writer_action_type TEXT;
    writer_workflow_id TEXT;
BEGIN
    SELECT action_type, workflow_id 
    INTO writer_action_type, writer_workflow_id
    FROM {{schema}}.step_execution
    WHERE id = NEW.written_by_step_execution_id;
    
    -- Must be write_to_stream
    IF writer_action_type != 'write_to_stream' THEN
        RAISE EXCEPTION 'stream_record.written_by_step_execution_id must reference write_to_stream, but references %',
            writer_action_type;
    END IF;
    
    -- Workflow ID must match
    IF writer_workflow_id != NEW.workflow_id THEN
        RAISE EXCEPTION 'stream_record.workflow_id (%) must match writer step_execution.workflow_id (%)',
            NEW.workflow_id, writer_workflow_id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_check_stream_record_writer
BEFORE INSERT ON {{schema}}.stream_record
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.check_stream_record_writer();

-- Trigger 7: Workflow Event Setter Constraints
CREATE FUNCTION {{schema}}.check_workflow_event_setter()
RETURNS TRIGGER AS $$
DECLARE
    setter_action_type TEXT;
    setter_workflow_id TEXT;
BEGIN
    SELECT action_type, workflow_id 
    INTO setter_action_type, setter_workflow_id
    FROM {{schema}}.step_execution
    WHERE id = NEW.set_by_step_execution_id;
    
    -- Must be set_event action
    IF setter_action_type != 'set_event' THEN
        RAISE EXCEPTION 'workflow_event.set_by_step_execution_id must reference action_type=set_event, but references %',
            setter_action_type;
    END IF;
    
    -- Workflow ID must match
    IF setter_workflow_id != NEW.workflow_id THEN
        RAISE EXCEPTION 'workflow_event.workflow_id (%) must match setter step_execution.workflow_id (%)',
            NEW.workflow_id, setter_workflow_id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_check_workflow_event_setter
BEFORE INSERT ON {{schema}}.workflow_event
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.check_workflow_event_setter();

-- Trigger 8: Child Workflow Started By start_child_workflow
CREATE FUNCTION {{schema}}.check_child_workflow_starter()
RETURNS TRIGGER AS $$
DECLARE
    starter_action_type TEXT;
    starter_workflow_id TEXT;
BEGIN
    -- Only check if started_by_step_execution_id is set
    IF NEW.started_by_step_execution_id IS NULL THEN
        RETURN NEW;
    END IF;
    
    SELECT action_type, workflow_id 
    INTO starter_action_type, starter_workflow_id
    FROM {{schema}}.step_execution
    WHERE id = NEW.started_by_step_execution_id;
    
    -- Must be start_child_workflow action
    IF starter_action_type != 'start_child_workflow' THEN
        RAISE EXCEPTION 'workflow.started_by_step_execution_id must reference action_type=start_child_workflow, but references %',
            starter_action_type;
    END IF;
    
    -- Child cannot be its own parent
    IF starter_workflow_id = NEW.id THEN
        RAISE EXCEPTION 'Workflow cannot be its own child (workflow_id=%)', NEW.id;
    END IF;
    
    -- The starter's workflow_id should be set as parent_id
    IF NEW.parent_id IS NULL OR NEW.parent_id != starter_workflow_id THEN
        RAISE EXCEPTION 'If started by a step_execution, parent_id must match that step''s workflow_id (expected %, got %)',
            starter_workflow_id, NEW.parent_id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_check_child_workflow_starter
BEFORE INSERT ON {{schema}}.workflow
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.check_child_workflow_starter();

-- Trigger 9: Compensation Failure Must Reference Compensation Step
CREATE FUNCTION {{schema}}.check_compensation_failure_reference()
RETURNS TRIGGER AS $$
DECLARE
    comp_action_type TEXT;
BEGIN
    SELECT action_type INTO comp_action_type
    FROM {{schema}}.step_execution
    WHERE id = NEW.step_execution_id;
    
    -- Must reference a compensation action
    IF comp_action_type NOT IN ('compensate_step', 'compensate_transaction') THEN
        RAISE EXCEPTION 'compensation_failure.step_execution_id must reference compensate_step or compensate_transaction, but references %',
            comp_action_type;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_check_compensation_failure_reference
BEFORE INSERT ON {{schema}}.compensation_failure
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.check_compensation_failure_reference();

-- =============================================================================
-- LISTEN/NOTIFY TRIGGERS FOR REAL-TIME COORDINATION
-- =============================================================================

-- Notify when a new workflow is created (for workers to claim)
CREATE FUNCTION {{schema}}.notify_workflow_created()
RETURNS TRIGGER AS $$
BEGIN
    -- Only notify for pending workflows (ready to be claimed)
    IF NEW.status = 'pending' THEN
        PERFORM pg_notify(
            '{{schema}}_workflow_pending',
            NEW.id || '::' || NEW.name
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_notify_workflow_created
AFTER INSERT ON {{schema}}.workflow
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.notify_workflow_created();

-- Notify when workflow status changes (for getResult, external waiters)
CREATE FUNCTION {{schema}}.notify_workflow_status_change()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        PERFORM pg_notify(
            '{{schema}}_workflow_status',
            NEW.id || '::' || NEW.status
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_notify_workflow_status_change
AFTER UPDATE ON {{schema}}.workflow
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.notify_workflow_status_change();

-- Notify when a channel message is sent (for receive waiters)
CREATE FUNCTION {{schema}}.notify_channel_message()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify(
        '{{schema}}_channel',
        NEW.dest_workflow_id || '::' || NEW.channel_name
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_notify_channel_message
AFTER INSERT ON {{schema}}.channel_message
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.notify_channel_message();

-- Notify when an event is set (for event waiters)
CREATE FUNCTION {{schema}}.notify_workflow_event()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify(
        '{{schema}}_event',
        NEW.workflow_id || '::' || NEW.event_name
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_notify_workflow_event
AFTER INSERT ON {{schema}}.workflow_event
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.notify_workflow_event();

-- Notify when a stream record is written (for stream readers)
CREATE FUNCTION {{schema}}.notify_stream_record()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify(
        '{{schema}}_stream',
        NEW.workflow_id || '::' || NEW.stream_name || '::' || NEW.real_offset::text
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_notify_stream_record
AFTER INSERT ON {{schema}}.stream_record
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.notify_stream_record();

-- =============================================================================
-- STATE PROPAGATION TRIGGERS
-- =============================================================================

-- Trigger: Propagate workflow cancellation to non-detached children
CREATE FUNCTION {{schema}}.propagate_workflow_cancellation_to_children()
RETURNS TRIGGER AS $$
BEGIN
    -- Only act when transitioning TO cancelling
    IF NEW.status = 'cancelling' AND OLD.status != 'cancelling' THEN
        -- Cancel all non-detached children that are still running
        UPDATE {{schema}}.workflow
        SET 
            status = CASE 
                WHEN status = 'pending' THEN 'cancelled'
                WHEN status = 'running' THEN 'cancelling'
                ELSE status
            END,
            cancellation_reason = 'parent_cancelled',
            updated_at = NOW(),
            finished_at = CASE 
                WHEN status = 'pending' THEN NOW()
                ELSE finished_at
            END
        WHERE parent_id = NEW.id 
          AND is_child = TRUE 
          AND is_detached = FALSE
          AND status NOT IN ('complete', 'failed', 'cancelled', 'killed', 'cancelling');
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_propagate_cancellation_to_children
AFTER UPDATE ON {{schema}}.workflow
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.propagate_workflow_cancellation_to_children();

-- Trigger: Propagate workflow cancellation to all step executions
CREATE FUNCTION {{schema}}.propagate_workflow_cancellation_to_steps()
RETURNS TRIGGER AS $$
BEGIN
    -- Transition TO cancelling or cancelled
    IF NEW.status IN ('cancelling', 'cancelled') AND OLD.status NOT IN ('cancelling', 'cancelled') THEN
        UPDATE {{schema}}.step_execution
        SET 
            status = CASE 
                WHEN status = 'pending' THEN 'cancelled'
                WHEN status = 'running' THEN 'cancelling'
                ELSE status
            END,
            cancellation_reason = 'workflow_cancelled',
            updated_at = NOW(),
            finished_at = CASE 
                WHEN status = 'pending' THEN NOW()
                ELSE finished_at
            END
        WHERE workflow_id = NEW.id 
          AND status NOT IN ('complete', 'failed', 'cancelled', 'killed', 'cancelling');
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_propagate_cancellation_to_steps
AFTER UPDATE ON {{schema}}.workflow
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.propagate_workflow_cancellation_to_steps();

-- Trigger: Propagate step execution cancellation to active attempt
CREATE FUNCTION {{schema}}.propagate_step_cancellation_to_attempt()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IN ('cancelling', 'cancelled') AND OLD.status NOT IN ('cancelling', 'cancelled') THEN
        UPDATE {{schema}}.step_execution_attempt
        SET 
            status = CASE 
                WHEN status = 'pending' THEN 'cancelled'
                WHEN status = 'running' THEN 'cancelling'
                ELSE status
            END,
            cancellation_reason = 'step_execution_cancelled',
            updated_at = NOW(),
            finished_at = CASE 
                WHEN status = 'pending' THEN NOW()
                ELSE finished_at
            END
        WHERE step_execution_id = NEW.id 
          AND status IN ('pending', 'running');
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_propagate_cancellation_to_attempt
AFTER UPDATE ON {{schema}}.step_execution
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.propagate_step_cancellation_to_attempt();

-- Trigger: Propagate attempt result to step execution
CREATE FUNCTION {{schema}}.propagate_attempt_result_to_step()
RETURNS TRIGGER AS $$
DECLARE
    step_action_type TEXT;
BEGIN
    -- Only act when attempt reaches terminal state
    IF NEW.status IN ('complete', 'failed', 'cancelled', 'killed') 
       AND OLD.status NOT IN ('complete', 'failed', 'cancelled', 'killed') THEN
        
        -- Get the step's action type to determine if we should propagate
        SELECT action_type INTO step_action_type
        FROM {{schema}}.step_execution
        WHERE id = NEW.step_execution_id;
        
        -- Only propagate for retryable actions
        IF step_action_type IN ('execute_step', 'compensate_step', 
                                'execute_transaction', 'compensate_transaction') THEN
            
            -- For complete/cancelled/killed: always propagate
            IF NEW.status IN ('complete', 'cancelled', 'killed') THEN
                UPDATE {{schema}}.step_execution
                SET 
                    status = NEW.status,
                    result = NEW.result,
                    updated_at = NOW(),
                    finished_at = NEW.finished_at,
                    cancellation_reason = CASE 
                        WHEN NEW.status IN ('cancelled', 'cancelling') 
                        THEN 'workflow_cancelled'
                        ELSE cancellation_reason
                    END
                WHERE id = NEW.step_execution_id
                  AND status NOT IN ('complete', 'failed', 'cancelled', 'killed');
                  
            -- For failed: create compensation_failure record for manual resolution
            ELSIF NEW.status = 'failed' THEN
                -- Check if compensation_failure already exists
                IF NOT EXISTS (
                    SELECT 1 FROM {{schema}}.compensation_failure 
                    WHERE step_execution_id = NEW.step_execution_id
                ) THEN
                    INSERT INTO {{schema}}.compensation_failure (
                        step_execution_id,
                        decision,
                        created_at,
                        updated_at
                    ) VALUES (
                        NEW.step_execution_id,
                        'pending',
                        NOW(),
                        NOW()
                    );
                END IF;
            END IF;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_propagate_attempt_to_step
AFTER UPDATE ON {{schema}}.step_execution_attempt
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.propagate_attempt_result_to_step();

-- Trigger: Propagate final step terminal state to workflow
CREATE FUNCTION {{schema}}.propagate_final_step_to_workflow()
RETURNS TRIGGER AS $$
BEGIN
    -- Only act on final step reaching terminal state
    IF NEW.is_final 
       AND NEW.status IN ('complete', 'failed', 'cancelled', 'killed')
       AND OLD.status NOT IN ('complete', 'failed', 'cancelled', 'killed') THEN
        
        UPDATE {{schema}}.workflow
        SET 
            status = NEW.status,
            result = NEW.result,
            updated_at = NOW(),
            finished_at = NEW.finished_at,
            cancellation_reason = CASE 
                WHEN NEW.status = 'cancelled' AND cancellation_reason IS NULL
                THEN 'external'
                ELSE cancellation_reason
            END
        WHERE id = NEW.workflow_id
          AND status NOT IN ('complete', 'failed', 'cancelled', 'killed');
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_propagate_final_step_to_workflow
AFTER UPDATE ON {{schema}}.step_execution
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.propagate_final_step_to_workflow();

-- =============================================================================
-- ATOMIC OPERATION AUTO-COMPLETION
-- =============================================================================

-- Trigger: Auto-complete atomic operations upon creation
CREATE FUNCTION {{schema}}.auto_complete_atomic_operations()
RETURNS TRIGGER AS $$
BEGIN
    -- Atomic operations that should auto-complete
    IF NEW.action_type IN (
        'sleep',
        'send_to_channel', 
        'write_to_stream',
        'set_event',
        'start_child_workflow'
    ) THEN
        -- Set to complete immediately (these are side effects, not blocking ops)
        NEW.status := 'complete';
        NEW.started_at := NEW.created_at;
        NEW.finished_at := NEW.created_at;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_auto_complete_atomic_operations
BEFORE INSERT ON {{schema}}.step_execution
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.auto_complete_atomic_operations();

-- =============================================================================
-- CHILD WORKFLOW LIFECYCLE ENFORCEMENT
-- =============================================================================

-- Trigger: Prevent parent completion without awaiting non-detached children
CREATE FUNCTION {{schema}}.check_non_detached_children_awaited()
RETURNS TRIGGER AS $$
DECLARE
    unawaited_child_id TEXT;
BEGIN
    -- Only check when transitioning to terminal state
    IF NEW.status IN ('complete', 'failed', 'cancelled', 'killed')
       AND OLD.status NOT IN ('complete', 'failed', 'cancelled', 'killed') THEN
        
        -- Find any non-detached child that was started but not awaited
        SELECT c.id INTO unawaited_child_id
        FROM {{schema}}.workflow c
        WHERE c.parent_id = NEW.id
          AND c.is_child = TRUE
          AND c.is_detached = FALSE
          AND NOT EXISTS (
              -- Check if there's a wait_for_child_workflow_result for this child
              SELECT 1 
              FROM {{schema}}.step_execution se
              WHERE se.workflow_id = NEW.id
                AND se.action_type = 'wait_for_child_workflow_result'
                AND se.waiting_for_child_workflow_id = c.id
                AND se.status IN ('complete', 'failed', 'cancelled', 'killed')
          )
        LIMIT 1;
        
        IF unawaited_child_id IS NOT NULL THEN
            RAISE EXCEPTION 'Cannot complete workflow %: non-detached child workflow % was started but never awaited', 
                NEW.id, unawaited_child_id;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_check_children_awaited
BEFORE UPDATE ON {{schema}}.workflow
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.check_non_detached_children_awaited();

-- Trigger: Parent deletion cascades to non-detached children
CREATE FUNCTION {{schema}}.handle_parent_deletion()
RETURNS TRIGGER AS $$
BEGIN
    -- Recursively delete non-detached children
    -- This must happen BEFORE parent deletion to avoid constraint violations
    DELETE FROM {{schema}}.workflow
    WHERE parent_id = OLD.id 
      AND is_child = TRUE 
      AND is_detached = FALSE;
    
    -- Detached children will have parent_id set to NULL by FK ON DELETE SET NULL
    -- This is fine because constraint allows NULL for detached children
    
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_handle_parent_deletion
BEFORE DELETE ON {{schema}}.workflow
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.handle_parent_deletion();

-- Trigger: Check that waiting_for_child_workflow_id references our child
CREATE FUNCTION {{schema}}.check_waiting_for_child_is_our_child()
RETURNS TRIGGER AS $$
DECLARE
    child_parent_id TEXT;
    child_is_child BOOLEAN;
BEGIN
    IF NEW.waiting_for_child_workflow_id IS NOT NULL THEN
        -- Get the parent_id and is_child flag of the child we're waiting for
        SELECT parent_id, is_child INTO child_parent_id, child_is_child
        FROM {{schema}}.workflow
        WHERE id = NEW.waiting_for_child_workflow_id;
        
        -- Must be a child workflow
        IF child_is_child IS NULL OR child_is_child = FALSE THEN
            RAISE EXCEPTION 'waiting_for_child_workflow_id (%) must reference a child workflow, but is_child is %',
                NEW.waiting_for_child_workflow_id, child_is_child;
        END IF;
        
        -- Must be our child
        IF child_parent_id IS NULL OR child_parent_id != NEW.workflow_id THEN
            RAISE EXCEPTION 'waiting_for_child_workflow_id (%) must reference a child of workflow %, but its parent_id is %',
                NEW.waiting_for_child_workflow_id, NEW.workflow_id, child_parent_id;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_check_waiting_for_child_relationship
BEFORE INSERT OR UPDATE ON {{schema}}.step_execution
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.check_waiting_for_child_is_our_child();

-- =============================================================================
-- COMPENSATION FLOW AUTOMATION
-- =============================================================================

-- Trigger: Handle compensation failure resolution
CREATE FUNCTION {{schema}}.handle_compensation_failure_resolution()
RETURNS TRIGGER AS $$
BEGIN
    -- Only act when decision changes from 'pending' to something else
    IF OLD.decision = 'pending' AND NEW.decision != 'pending' THEN
        
        IF NEW.decision = 'retry' THEN
            -- Create a new attempt for the compensation step
            INSERT INTO {{schema}}.step_execution_attempt (
                step_execution_id,
                status,
                created_at,
                updated_at
            ) VALUES (
                NEW.step_execution_id,
                'pending',
                NOW(),
                NOW()
            );
            
        ELSIF NEW.decision = 'skip' THEN
            -- Mark the compensation step as complete (we're skipping it)
            UPDATE {{schema}}.step_execution
            SET 
                status = 'complete',
                updated_at = NOW(),
                finished_at = NOW()
            WHERE id = NEW.step_execution_id;
            
        ELSIF NEW.decision = 'stop' THEN
            -- Mark the step as failed and workflow as failed
            UPDATE {{schema}}.step_execution
            SET 
                status = 'failed',
                updated_at = NOW(),
                finished_at = NOW()
            WHERE id = NEW.step_execution_id;
            
            -- The workflow will be marked failed via the final step trigger
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_handle_compensation_resolution
AFTER UPDATE ON {{schema}}.compensation_failure
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.handle_compensation_failure_resolution();

-- =============================================================================
-- CHANNEL MESSAGE QUEUE SEMANTICS
-- =============================================================================

-- Trigger: Deliver message directly if receiver is waiting, otherwise queue
CREATE FUNCTION {{schema}}.deliver_or_queue_channel_message()
RETURNS TRIGGER AS $$
DECLARE
    pending_receive_id BIGINT;
BEGIN
    -- Look for pending receive operation
    SELECT se.id INTO pending_receive_id
    FROM {{schema}}.step_execution se
    WHERE se.workflow_id = NEW.dest_workflow_id
      AND se.action_type = 'receive_from_channel'
      AND se.function_name = NEW.channel_name
      AND se.status = 'pending'
    ORDER BY se.function_id ASC
    LIMIT 1;
    
    IF pending_receive_id IS NOT NULL THEN
        -- Deliver immediately to waiting receiver
        UPDATE {{schema}}.step_execution
        SET 
            status = 'complete',
            result = NEW.body,
            started_at = NEW.created_at,
            finished_at = NEW.created_at,
            updated_at = NOW()
        WHERE id = pending_receive_id;
        
        -- Prevent insertion - message was consumed
        RETURN NULL;
    END IF;
    
    -- No receiver waiting, queue the message
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_deliver_or_queue_message
BEFORE INSERT ON {{schema}}.channel_message
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.deliver_or_queue_channel_message();

-- Trigger: Consume queued message when receiver arrives
CREATE FUNCTION {{schema}}.consume_queued_message_on_receive()
RETURNS TRIGGER AS $$
DECLARE
    oldest_message_id BIGINT;
    oldest_message_body JSONB;
BEGIN
    -- Only for receive operations being created as pending
    IF NEW.action_type = 'receive_from_channel' AND NEW.status = 'pending' THEN
        -- Look for oldest queued message
        SELECT id, body INTO oldest_message_id, oldest_message_body
        FROM {{schema}}.channel_message
        WHERE dest_workflow_id = NEW.workflow_id
          AND channel_name = NEW.function_name
        ORDER BY seq_num ASC
        LIMIT 1;
        
        IF oldest_message_id IS NOT NULL THEN
            -- Complete immediately with queued message
            NEW.status := 'complete';
            NEW.result := oldest_message_body;
            NEW.started_at := NEW.created_at;
            NEW.finished_at := NEW.created_at;
            
            -- Delete consumed message
            DELETE FROM {{schema}}.channel_message WHERE id = oldest_message_id;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_consume_queued_message
BEFORE INSERT ON {{schema}}.step_execution
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.consume_queued_message_on_receive();

-- =============================================================================
-- CHILD WORKFLOW WAIT AUTO-COMPLETION
-- =============================================================================

-- Trigger: Auto-complete child workflow wait when child terminates
CREATE FUNCTION {{schema}}.auto_complete_child_workflow_wait()
RETURNS TRIGGER AS $$
DECLARE
    waiting_step_id BIGINT;
BEGIN
    -- Only act when child reaches terminal state
    IF NEW.status IN ('complete', 'failed', 'cancelled', 'killed')
       AND OLD.status NOT IN ('complete', 'failed', 'cancelled', 'killed') THEN
        
        -- Find parent's waiting step (if any)
        SELECT se.id INTO waiting_step_id
        FROM {{schema}}.step_execution se
        WHERE se.workflow_id = NEW.parent_id
          AND se.action_type = 'wait_for_child_workflow_result'
          AND se.waiting_for_child_workflow_id = NEW.id
          AND se.status IN ('pending', 'running')
        LIMIT 1;
        
        IF waiting_step_id IS NOT NULL THEN
            -- Complete the wait operation (result will be fetched from workflow table)
            UPDATE {{schema}}.step_execution
            SET 
                status = 'complete',
                result = NULL,
                finished_at = NOW(),
                updated_at = NOW()
            WHERE id = waiting_step_id;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_auto_complete_child_wait
AFTER UPDATE ON {{schema}}.workflow
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.auto_complete_child_workflow_wait();

-- =============================================================================
-- VALIDATION TRIGGERS
-- =============================================================================

-- Trigger: Prevent creating step executions for terminal workflows
CREATE FUNCTION {{schema}}.prevent_steps_on_terminal_workflow()
RETURNS TRIGGER AS $$
DECLARE
    wf_status TEXT;
BEGIN
    SELECT status INTO wf_status
    FROM {{schema}}.workflow
    WHERE id = NEW.workflow_id;
    
    IF wf_status IN ('complete', 'failed', 'cancelled', 'killed') THEN
        RAISE EXCEPTION 'Cannot create step_execution for workflow % in terminal status %', 
            NEW.workflow_id, wf_status;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_prevent_steps_on_terminal_workflow
BEFORE INSERT ON {{schema}}.step_execution
FOR EACH ROW
EXECUTE FUNCTION {{schema}}.prevent_steps_on_terminal_workflow();

-- =============================================================================
-- DEADLINE ENFORCEMENT
-- =============================================================================

-- Function: Enforce deadlines (called periodically by cron or worker)
CREATE FUNCTION {{schema}}.enforce_deadlines()
RETURNS void AS $$
BEGIN
    -- Cancel workflows past deadline
    UPDATE {{schema}}.workflow
    SET 
        status = 'cancelling',
        cancellation_reason = 'timeout',
        updated_at = NOW()
    WHERE status IN ('running')
      AND deadline_at IS NOT NULL
      AND deadline_at < NOW();
    
    -- Cancel step_executions past deadline
    UPDATE {{schema}}.step_execution
    SET 
        status = 'cancelling',
        cancellation_reason = 'step_execution_timeout',
        updated_at = NOW()
    WHERE status IN ('running')
      AND deadline_at IS NOT NULL
      AND deadline_at < NOW();
    
    -- Cancel attempts past deadline
    UPDATE {{schema}}.step_execution_attempt
    SET 
        status = 'cancelling',
        cancellation_reason = 'step_execution_attempt_timeout',
        updated_at = NOW()
    WHERE status IN ('running')
      AND deadline_at IS NOT NULL
      AND deadline_at < NOW();
END;
$$ LANGUAGE plpgsql;