-- Discovery is retained separately from compactable model replay.
CREATE TABLE agent_conversation_tools (
  conversation_id INTEGER NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  PRIMARY KEY (conversation_id, name)
);
