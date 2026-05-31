BEGIN;

ALTER TABLE audit_command_log
  DROP CONSTRAINT ck_audit_command_log_action;

ALTER TABLE audit_command_log
  ADD CONSTRAINT ck_audit_command_log_action CHECK (
    action IN ('soft_reboot', 'hard_shutdown', 'set_hvac_mode', 'start_node')
  );

COMMIT;
