export type Env = {
  DB: D1Database
  ASSETS: Fetcher
  APP_NAME: string
  APP_URL: string
  /** URL prefix the app is served under, e.g. "/abn" for raajsoftware.com/abn. Empty = domain root. */
  BASE_PATH?: string
  TIMEZONE: string
  MAIL_FROM?: string
  MAIL_FROM_NAME?: string
  SMTP_HOST?: string
  SMTP_PORT?: string
  SMTP_SECURE?: string
  SMTP_USER?: string
  SMTP_PASS?: string
  RESEND_API_KEY?: string
}

export type Role = 'coordinator' | 'head' | 'teacher'
export type UserStatus = 'pending' | 'active' | 'rejected' | 'disabled'
export type AttendanceScope = 'none' | 'section' | 'all'
export type AttendanceStatus = 'present' | 'absent' | 'casual_leave' | 'eval_absent'
export type LeaveKind = 'casual_leave' | 'eval_absent'
export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export type User = {
  id: number
  its: string
  password_hash: string
  using_default_password: number
  role: Role
  status: UserStatus
  full_name: string
  /** Legacy "primary" section; use section_ids (from user_sections) for access checks. */
  section_id: number | null
  /** All sections the user belongs to (hydrated from user_sections). */
  section_ids: number[]
  /** Comma-separated names of all the user's sections. */
  section_name?: string | null
  attendance_scope: AttendanceScope
  consent_at: string | null
  profile_complete: number
  phone: string | null
  email: string | null
  photo_key: string | null
  date_of_joining: string | null
  qualification: string | null
  designation: string | null
  subjects: string | null
  address: string | null
  created_at: string
  approved_at: string | null
}

export type Wing = { id: number; name: string; active: number; sort: number }
export type Section = { id: number; name: string; wing_id: number | null; wing_name: string | null; wing_active: number | null; grades: string | null }

export type PointRow = {
  id: number
  teacher_id: number
  kind: 'merit' | 'demerit'
  points: number
  reason: string
  event_date: string
  status: 'pending' | 'approved' | 'rejected'
  requested_by: number
  reviewed_at: string | null
  review_note: string | null
  created_at: string
  teacher_name?: string
  teacher_its?: string
  requester_name?: string
  section_name?: string | null
}

export type LeaveRow = {
  id: number
  teacher_id: number
  kind: LeaveKind
  start_date: string
  end_date: string
  reason: string
  status: LeaveStatus
  reviewed_at: string | null
  review_note: string | null
  created_at: string
  teacher_name?: string
  section_name?: string | null
}

export type AppEnv = {
  Bindings: Env
  Variables: { user: User }
}
