export type UpdateOperation = {
  id: string;
  source_version: string;
  target_version: string;
  phase: 'downloading' | 'verifying' | 'awaiting_confirmation' | 'stopping' | 'restarting' | 'succeeded' | 'failed' | 'cancelled';
  error: string | null;
  started_at: number;
  updated_at: number;
};

export type SystemUpdateStatus = {
  running_version: string;
  selected_version: string | null;
  latest: { version: string; published_at: string; url: string; asset_ready: boolean } | null;
  checked_at: number | null;
  check_error: string | null;
  checking: boolean;
  can_upgrade: boolean;
  unavailable_reason: string | null;
  operation: UpdateOperation | null;
};
