export type Verdict = "AC" | "WA" | "TLE" | "MLE" | "RE" | "CE" | "PENDING";

export interface Submission {
  id: number;
  user_id: number;
  problem_id: number;
  language: string;
  code: string;
  verdict: Verdict;
  runtime_ms: number | null;
  memory_kb: number | null;
  notes: string | null;
  submitted_at: string;
}

export interface CreateSubmissionRequest {
  problem_id: number;
  language: string;
  code: string;
  verdict: Verdict;
  runtime_ms?: number;
  memory_kb?: number;
  notes?: string;
}
