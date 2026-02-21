
-- Query workflows by status (for claiming pending workflows)
CREATE INDEX idx_workflow_status 
ON {{schema}}.workflow(status, created_at) WHERE status = 'pending';

-- Query workflows by executor (for recovery on restart)
CREATE INDEX idx_workflow_executor_id
ON {{schema}}.workflow(executor_id) 
WHERE executor_id IS NOT NULL AND status IN ('running', 'cancelling');

CREATE INDEX idx_complete_retention_deadline_at
ON {{schema}}.workflow(complete_retention_deadline_at)
WHERE complete_retention_deadline_at IS NOT NULL AND status = 'complete';

CREATE INDEX idx_failed_retention_deadline_at
ON {{schema}}.workflow(failed_retention_deadline_at)
WHERE failed_retention_deadline_at IS NOT NULL AND status = 'failed';

CREATE INDEX idx_cancelled_retention_deadline_at
ON {{schema}}.workflow(cancelled_retention_deadline_at)
WHERE cancelled_retention_deadline_at IS NOT NULL AND status = 'cancelled';

CREATE INDEX idx_killed_retention_deadline_at
ON {{schema}}.workflow(killed_retention_deadline_at)
WHERE killed_retention_deadline_at IS NOT NULL AND status = 'killed';


CREATE INDEX idx_step_execution_workflow_id 
ON {{schema}}.step_execution(workflow_id);

-- Query step executions by status  
CREATE INDEX idx_step_execution_status 
ON {{schema}}.step_execution(workflow_id, status);


CREATE INDEX idx_step_execution_attempt_executor_id
ON {{schema}}.step_execution_attempt(executor_id)
WHERE executor_id IS NOT NULL;


CREATE INDEX idx_compensation_failure_decision_pending 
ON {{schema}}.compensation_failure(decision) 
WHERE decision = 'pending';


-- Find pending channel messages for a workflow
CREATE INDEX idx_channel_message_dest 
ON {{schema}}.channel_message(
    dest_workflow_id, 
    channel_name, 
    seq_num
);


-- Stream queries by workflow + stream name
CREATE INDEX idx_stream_record_workflow_stream 
ON {{schema}}.stream_record(workflow_id, stream_name, real_offset);
