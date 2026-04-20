export type StatusCounts = {
  live: number;
  done: number;
  errored: number;
  idle: number;
};

export type ProjectInfo = {
  key: string;
  cwd: string;
  name: string;
  session_count: number;
  last_modified_ms: number;
  status_counts: StatusCounts;
  is_orka: boolean;
};

export type SessionStatus = "live" | "done" | "errored" | "idle";

export type SessionInfo = {
  id: string;
  path: string;
  project_key: string;
  project_cwd: string;
  modified_ms: number;
  size_bytes: number;
  first_user_preview: string | null;
  last_message_preview: string | null;
  last_user_preview: string | null;
  spawn_label: string | null;
  status: SessionStatus;
  turn_count: number;
  awaiting_user: boolean;
};

export type SessionLine = {
  line_no: number;
  role: string;
  text: string;
  session_id: string | null;
  uuid: string | null;
};
