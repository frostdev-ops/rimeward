-- Aggregate counters only; no contents, addresses or file paths.
ALTER TABLE remote_desktop_audit ADD COLUMN relay_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE remote_desktop_audit ADD COLUMN media_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE remote_desktop_audit ADD COLUMN rtt_ms_sum INTEGER NOT NULL DEFAULT 0;
ALTER TABLE remote_desktop_audit ADD COLUMN rtt_samples INTEGER NOT NULL DEFAULT 0;
ALTER TABLE remote_desktop_audit ADD COLUMN webrtc_failures INTEGER NOT NULL DEFAULT 0;
