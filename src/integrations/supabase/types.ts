export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      absence_alert_dismissals: {
        Row: {
          dismissed_at: string
          dismissed_by: string | null
          dismissed_excused_count: number
          dismissed_unexcused_count: number
          enrollment_id: string
          id: string
          organization_id: string
        }
        Insert: {
          dismissed_at?: string
          dismissed_by?: string | null
          dismissed_excused_count: number
          dismissed_unexcused_count: number
          enrollment_id: string
          id?: string
          organization_id: string
        }
        Update: {
          dismissed_at?: string
          dismissed_by?: string | null
          dismissed_excused_count?: number
          dismissed_unexcused_count?: number
          enrollment_id?: string
          id?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "absence_alert_dismissals_dismissed_by_fkey"
            columns: ["dismissed_by"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "absence_alert_dismissals_enrollment_id_fkey"
            columns: ["enrollment_id"]
            isOneToOne: false
            referencedRelation: "enrollments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "absence_alert_dismissals_enrollment_id_fkey"
            columns: ["enrollment_id"]
            isOneToOne: false
            referencedRelation: "v_enrollment_absence_state"
            referencedColumns: ["enrollment_id"]
          },
          {
            foreignKeyName: "absence_alert_dismissals_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      activities: {
        Row: {
          business_node_id: string
          business_year_id: string
          created_at: string
          default_performance_method: Database["public"]["Enums"]["performance_method"]
          id: string
          is_active: boolean
          name: string
          organization_id: string
          sort_order: number
          unit_business_id: string
          updated_at: string
        }
        Insert: {
          business_node_id: string
          business_year_id: string
          created_at?: string
          default_performance_method?: Database["public"]["Enums"]["performance_method"]
          id?: string
          is_active?: boolean
          name: string
          organization_id: string
          sort_order?: number
          unit_business_id: string
          updated_at?: string
        }
        Update: {
          business_node_id?: string
          business_year_id?: string
          created_at?: string
          default_performance_method?: Database["public"]["Enums"]["performance_method"]
          id?: string
          is_active?: boolean
          name?: string
          organization_id?: string
          sort_order?: number
          unit_business_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "activities_business_node_id_fkey"
            columns: ["business_node_id"]
            isOneToOne: false
            referencedRelation: "business_nodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_business_year_id_fkey"
            columns: ["business_year_id"]
            isOneToOne: false
            referencedRelation: "business_years"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_unit_business_id_fkey"
            columns: ["unit_business_id"]
            isOneToOne: false
            referencedRelation: "unit_businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      activity_assignments: {
        Row: {
          activity_id: string
          created_at: string
          created_by: string | null
          effective_from: string
          effective_to: string | null
          id: string
          organization_id: string
          staff_principal_id: string
        }
        Insert: {
          activity_id: string
          created_at?: string
          created_by?: string | null
          effective_from?: string
          effective_to?: string | null
          id?: string
          organization_id: string
          staff_principal_id: string
        }
        Update: {
          activity_id?: string
          created_at?: string
          created_by?: string | null
          effective_from?: string
          effective_to?: string | null
          id?: string
          organization_id?: string
          staff_principal_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_assignments_activity_id_fkey"
            columns: ["activity_id"]
            isOneToOne: false
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_assignments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_assignments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_assignments_staff_principal_id_fkey"
            columns: ["staff_principal_id"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_evaluation_snapshots: {
        Row: {
          activity_id: string
          activity_name_snapshot: string
          ai_evaluation_id: string
          id: string
          period_count: number
          period_total_people: number
          period_unique_people: number
          plan_count: number | null
          plan_total_people: number | null
          plan_unique_people: number | null
          sort_order: number
          ytd_count: number
          ytd_total_people: number
          ytd_unique_people: number
        }
        Insert: {
          activity_id: string
          activity_name_snapshot: string
          ai_evaluation_id: string
          id?: string
          period_count: number
          period_total_people: number
          period_unique_people: number
          plan_count?: number | null
          plan_total_people?: number | null
          plan_unique_people?: number | null
          sort_order: number
          ytd_count: number
          ytd_total_people: number
          ytd_unique_people: number
        }
        Update: {
          activity_id?: string
          activity_name_snapshot?: string
          ai_evaluation_id?: string
          id?: string
          period_count?: number
          period_total_people?: number
          period_unique_people?: number
          plan_count?: number | null
          plan_total_people?: number | null
          plan_unique_people?: number | null
          sort_order?: number
          ytd_count?: number
          ytd_total_people?: number
          ytd_unique_people?: number
        }
        Relationships: [
          {
            foreignKeyName: "ai_evaluation_snapshots_activity_id_fkey"
            columns: ["activity_id"]
            isOneToOne: false
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_evaluation_snapshots_ai_evaluation_id_fkey"
            columns: ["ai_evaluation_id"]
            isOneToOne: false
            referencedRelation: "ai_evaluations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_evaluations: {
        Row: {
          business_year_id: string
          checkpoints: string
          created_at: string
          created_by: string | null
          future_direction: string
          id: string
          idempotency_key: string
          major_changes: string
          model_name: string | null
          operation_result: string
          organization_id: string
          period_count: number
          period_end: string
          period_start: string
          period_total_people: number
          period_type: Database["public"]["Enums"]["ai_evaluation_period_type"]
          period_unique_people: number
          plan_count: number | null
          plan_total_people: number | null
          plan_unique_people: number | null
          prompt_version: string | null
          reference_note: string | null
          unit_business_id: string
          ytd_count: number
          ytd_total_people: number
          ytd_unique_people: number
        }
        Insert: {
          business_year_id: string
          checkpoints: string
          created_at?: string
          created_by?: string | null
          future_direction: string
          id?: string
          idempotency_key: string
          major_changes: string
          model_name?: string | null
          operation_result: string
          organization_id: string
          period_count: number
          period_end: string
          period_start: string
          period_total_people: number
          period_type: Database["public"]["Enums"]["ai_evaluation_period_type"]
          period_unique_people: number
          plan_count?: number | null
          plan_total_people?: number | null
          plan_unique_people?: number | null
          prompt_version?: string | null
          reference_note?: string | null
          unit_business_id: string
          ytd_count: number
          ytd_total_people: number
          ytd_unique_people: number
        }
        Update: {
          business_year_id?: string
          checkpoints?: string
          created_at?: string
          created_by?: string | null
          future_direction?: string
          id?: string
          idempotency_key?: string
          major_changes?: string
          model_name?: string | null
          operation_result?: string
          organization_id?: string
          period_count?: number
          period_end?: string
          period_start?: string
          period_total_people?: number
          period_type?: Database["public"]["Enums"]["ai_evaluation_period_type"]
          period_unique_people?: number
          plan_count?: number | null
          plan_total_people?: number | null
          plan_unique_people?: number | null
          prompt_version?: string | null
          reference_note?: string | null
          unit_business_id?: string
          ytd_count?: number
          ytd_total_people?: number
          ytd_unique_people?: number
        }
        Relationships: [
          {
            foreignKeyName: "ai_evaluations_business_year_id_fkey"
            columns: ["business_year_id"]
            isOneToOne: false
            referencedRelation: "business_years"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_evaluations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_evaluations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_evaluations_unit_business_id_fkey"
            columns: ["unit_business_id"]
            isOneToOne: false
            referencedRelation: "unit_businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      annual_plans: {
        Row: {
          activity_id: string
          business_year_id: string
          count_basis: string | null
          count_target: number | null
          id: string
          organization_id: string
          total_basis: string | null
          total_target: number | null
          unique_basis: string | null
          unique_target: number | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          activity_id: string
          business_year_id: string
          count_basis?: string | null
          count_target?: number | null
          id?: string
          organization_id: string
          total_basis?: string | null
          total_target?: number | null
          unique_basis?: string | null
          unique_target?: number | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          activity_id?: string
          business_year_id?: string
          count_basis?: string | null
          count_target?: number | null
          id?: string
          organization_id?: string
          total_basis?: string | null
          total_target?: number | null
          unique_basis?: string | null
          unique_target?: number | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "annual_plans_activity_id_fkey"
            columns: ["activity_id"]
            isOneToOne: false
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "annual_plans_business_year_id_fkey"
            columns: ["business_year_id"]
            isOneToOne: false
            referencedRelation: "business_years"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "annual_plans_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "annual_plans_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_corrections: {
        Row: {
          after_mark: Database["public"]["Enums"]["attendance_mark"]
          before_mark: Database["public"]["Enums"]["attendance_mark"]
          corrected_at: string
          corrected_by: string | null
          enrollment_id: string
          final_attendance_id: string
          id: string
          organization_id: string
          reason: string
          session_id: string
        }
        Insert: {
          after_mark: Database["public"]["Enums"]["attendance_mark"]
          before_mark: Database["public"]["Enums"]["attendance_mark"]
          corrected_at?: string
          corrected_by?: string | null
          enrollment_id: string
          final_attendance_id: string
          id?: string
          organization_id: string
          reason: string
          session_id: string
        }
        Update: {
          after_mark?: Database["public"]["Enums"]["attendance_mark"]
          before_mark?: Database["public"]["Enums"]["attendance_mark"]
          corrected_at?: string
          corrected_by?: string | null
          enrollment_id?: string
          final_attendance_id?: string
          id?: string
          organization_id?: string
          reason?: string
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_corrections_corrected_by_fkey"
            columns: ["corrected_by"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_corrections_enrollment_id_fkey"
            columns: ["enrollment_id"]
            isOneToOne: false
            referencedRelation: "enrollments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_corrections_enrollment_id_fkey"
            columns: ["enrollment_id"]
            isOneToOne: false
            referencedRelation: "v_enrollment_absence_state"
            referencedColumns: ["enrollment_id"]
          },
          {
            foreignKeyName: "attendance_corrections_final_attendance_id_fkey"
            columns: ["final_attendance_id"]
            isOneToOne: false
            referencedRelation: "final_attendance"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_corrections_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_corrections_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_principal_id: string | null
          after_json: Json | null
          before_json: Json | null
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
          organization_id: string
          reason: string | null
        }
        Insert: {
          action: string
          actor_principal_id?: string | null
          after_json?: Json | null
          before_json?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: string
          organization_id: string
          reason?: string | null
        }
        Update: {
          action?: string
          actor_principal_id?: string | null
          after_json?: Json | null
          before_json?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          organization_id?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_principal_id_fkey"
            columns: ["actor_principal_id"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      business_nodes: {
        Row: {
          business_year_id: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          node_type: Database["public"]["Enums"]["business_node_type"]
          organization_id: string
          parent_id: string | null
          sort_order: number
          unit_business_id: string
          updated_at: string
        }
        Insert: {
          business_year_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          node_type: Database["public"]["Enums"]["business_node_type"]
          organization_id: string
          parent_id?: string | null
          sort_order?: number
          unit_business_id: string
          updated_at?: string
        }
        Update: {
          business_year_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          node_type?: Database["public"]["Enums"]["business_node_type"]
          organization_id?: string
          parent_id?: string | null
          sort_order?: number
          unit_business_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_nodes_business_year_id_fkey"
            columns: ["business_year_id"]
            isOneToOne: false
            referencedRelation: "business_years"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_nodes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_nodes_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "business_nodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_nodes_unit_business_id_fkey"
            columns: ["unit_business_id"]
            isOneToOne: false
            referencedRelation: "unit_businesses"
            referencedColumns: ["id"]
          },
        ]
      }
      business_years: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          status: Database["public"]["Enums"]["business_year_status"]
          updated_at: string
          year: number
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          status?: Database["public"]["Enums"]["business_year_status"]
          updated_at?: string
          year: number
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          status?: Database["public"]["Enums"]["business_year_status"]
          updated_at?: string
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "business_years_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      department_manager_scopes: {
        Row: {
          business_node_id: string
          created_at: string
          id: string
          organization_id: string
          principal_id: string
        }
        Insert: {
          business_node_id: string
          created_at?: string
          id?: string
          organization_id: string
          principal_id: string
        }
        Update: {
          business_node_id?: string
          created_at?: string
          id?: string
          organization_id?: string
          principal_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "department_manager_scopes_business_node_id_fkey"
            columns: ["business_node_id"]
            isOneToOne: false
            referencedRelation: "business_nodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "department_manager_scopes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "department_manager_scopes_principal_id_fkey"
            columns: ["principal_id"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
        ]
      }
      departments: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          name: string
          organization_id: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          organization_id: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          organization_id?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "departments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      enrollments: {
        Row: {
          created_at: string
          created_by: string | null
          end_session_no_exclusive: number | null
          ended_at: string | null
          ended_by: string | null
          ended_effective_date: string | null
          id: string
          operation_term_id: string
          organization_id: string
          participant_id: string
          start_session_no: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          end_session_no_exclusive?: number | null
          ended_at?: string | null
          ended_by?: string | null
          ended_effective_date?: string | null
          id?: string
          operation_term_id: string
          organization_id: string
          participant_id: string
          start_session_no?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          end_session_no_exclusive?: number | null
          ended_at?: string | null
          ended_by?: string | null
          ended_effective_date?: string | null
          id?: string
          operation_term_id?: string
          organization_id?: string
          participant_id?: string
          start_session_no?: number
        }
        Relationships: [
          {
            foreignKeyName: "enrollments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enrollments_ended_by_fkey"
            columns: ["ended_by"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enrollments_operation_term_id_fkey"
            columns: ["operation_term_id"]
            isOneToOne: false
            referencedRelation: "operation_terms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enrollments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enrollments_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: false
            referencedRelation: "participants"
            referencedColumns: ["id"]
          },
        ]
      }
      excused_absences: {
        Row: {
          cancelled_at: string | null
          created_at: string
          created_by: string | null
          enrollment_id: string
          id: string
          organization_id: string
          session_id: string
        }
        Insert: {
          cancelled_at?: string | null
          created_at?: string
          created_by?: string | null
          enrollment_id: string
          id?: string
          organization_id: string
          session_id: string
        }
        Update: {
          cancelled_at?: string | null
          created_at?: string
          created_by?: string | null
          enrollment_id?: string
          id?: string
          organization_id?: string
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "excused_absences_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "excused_absences_enrollment_id_fkey"
            columns: ["enrollment_id"]
            isOneToOne: false
            referencedRelation: "enrollments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "excused_absences_enrollment_id_fkey"
            columns: ["enrollment_id"]
            isOneToOne: false
            referencedRelation: "v_enrollment_absence_state"
            referencedColumns: ["enrollment_id"]
          },
          {
            foreignKeyName: "excused_absences_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "excused_absences_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      final_attendance: {
        Row: {
          enrollment_id: string
          finalization_method: Database["public"]["Enums"]["finalization_method"]
          finalized_at: string
          id: string
          mark: Database["public"]["Enums"]["attendance_mark"]
          organization_id: string
          session_id: string
          source_submission_id: string | null
          updated_at: string
        }
        Insert: {
          enrollment_id: string
          finalization_method: Database["public"]["Enums"]["finalization_method"]
          finalized_at?: string
          id?: string
          mark: Database["public"]["Enums"]["attendance_mark"]
          organization_id: string
          session_id: string
          source_submission_id?: string | null
          updated_at?: string
        }
        Update: {
          enrollment_id?: string
          finalization_method?: Database["public"]["Enums"]["finalization_method"]
          finalized_at?: string
          id?: string
          mark?: Database["public"]["Enums"]["attendance_mark"]
          organization_id?: string
          session_id?: string
          source_submission_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "final_attendance_enrollment_id_fkey"
            columns: ["enrollment_id"]
            isOneToOne: false
            referencedRelation: "enrollments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "final_attendance_enrollment_id_fkey"
            columns: ["enrollment_id"]
            isOneToOne: false
            referencedRelation: "v_enrollment_absence_state"
            referencedColumns: ["enrollment_id"]
          },
          {
            foreignKeyName: "final_attendance_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "final_attendance_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "final_attendance_source_submission_id_fkey"
            columns: ["source_submission_id"]
            isOneToOne: false
            referencedRelation: "instructor_attendance_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      instructor_attendance_entries: {
        Row: {
          enrollment_id: string
          id: string
          mark: Database["public"]["Enums"]["attendance_mark"]
          submission_id: string
        }
        Insert: {
          enrollment_id: string
          id?: string
          mark: Database["public"]["Enums"]["attendance_mark"]
          submission_id: string
        }
        Update: {
          enrollment_id?: string
          id?: string
          mark?: Database["public"]["Enums"]["attendance_mark"]
          submission_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "instructor_attendance_entries_enrollment_id_fkey"
            columns: ["enrollment_id"]
            isOneToOne: false
            referencedRelation: "enrollments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "instructor_attendance_entries_enrollment_id_fkey"
            columns: ["enrollment_id"]
            isOneToOne: false
            referencedRelation: "v_enrollment_absence_state"
            referencedColumns: ["enrollment_id"]
          },
          {
            foreignKeyName: "instructor_attendance_entries_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "instructor_attendance_submissions"
            referencedColumns: ["id"]
          },
        ]
      }
      instructor_attendance_submissions: {
        Row: {
          id: string
          idempotency_key: string
          instructor_principal_id: string
          organization_id: string
          session_id: string
          submitted_at: string
          version: number
        }
        Insert: {
          id?: string
          idempotency_key: string
          instructor_principal_id: string
          organization_id: string
          session_id: string
          submitted_at?: string
          version: number
        }
        Update: {
          id?: string
          idempotency_key?: string
          instructor_principal_id?: string
          organization_id?: string
          session_id?: string
          submitted_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "instructor_attendance_submissions_instructor_principal_id_fkey"
            columns: ["instructor_principal_id"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "instructor_attendance_submissions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "instructor_attendance_submissions_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      instructor_profiles: {
        Row: {
          created_at: string
          organization_id: string
          phone_last4: string | null
          pin_confirmed: boolean
          pin_failed_count: number
          pin_hash: string | null
          pin_locked_until: string | null
          principal_id: string
          start_code_expires_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          organization_id: string
          phone_last4?: string | null
          pin_confirmed?: boolean
          pin_failed_count?: number
          pin_hash?: string | null
          pin_locked_until?: string | null
          principal_id: string
          start_code_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          organization_id?: string
          phone_last4?: string | null
          pin_confirmed?: boolean
          pin_failed_count?: number
          pin_hash?: string | null
          pin_locked_until?: string | null
          principal_id?: string
          start_code_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "instructor_profiles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "instructor_profiles_principal_id_fkey"
            columns: ["principal_id"]
            isOneToOne: true
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
        ]
      }
      operation_cycle_programs: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          operation_cycle_id: string
          organization_id: string
          program_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          operation_cycle_id: string
          organization_id: string
          program_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          operation_cycle_id?: string
          organization_id?: string
          program_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "operation_cycle_programs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operation_cycle_programs_operation_cycle_id_fkey"
            columns: ["operation_cycle_id"]
            isOneToOne: false
            referencedRelation: "operation_cycles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operation_cycle_programs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operation_cycle_programs_program_id_fkey"
            columns: ["program_id"]
            isOneToOne: false
            referencedRelation: "programs"
            referencedColumns: ["id"]
          },
        ]
      }
      operation_cycles: {
        Row: {
          business_year_id: string
          created_at: string
          created_by: string | null
          end_date: string
          id: string
          idempotency_key: string
          name: string
          organization_id: string
          start_date: string
          status: Database["public"]["Enums"]["operation_cycle_status"]
        }
        Insert: {
          business_year_id: string
          created_at?: string
          created_by?: string | null
          end_date: string
          id?: string
          idempotency_key: string
          name: string
          organization_id: string
          start_date: string
          status?: Database["public"]["Enums"]["operation_cycle_status"]
        }
        Update: {
          business_year_id?: string
          created_at?: string
          created_by?: string | null
          end_date?: string
          id?: string
          idempotency_key?: string
          name?: string
          organization_id?: string
          start_date?: string
          status?: Database["public"]["Enums"]["operation_cycle_status"]
        }
        Relationships: [
          {
            foreignKeyName: "operation_cycles_business_year_id_fkey"
            columns: ["business_year_id"]
            isOneToOne: false
            referencedRelation: "business_years"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operation_cycles_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operation_cycles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      operation_terms: {
        Row: {
          business_year_id: string
          created_at: string
          created_by: string | null
          end_date: string
          holiday_auto_cancel: boolean
          id: string
          initial_roster_applied_at: string | null
          instructor_name_text: string | null
          instructor_principal_id: string | null
          name: string
          operation_cycle_id: string | null
          organization_id: string
          program_id: string
          schedule_mode: string
          session_end_time: string | null
          session_start_time: string | null
          start_date: string
          status: Database["public"]["Enums"]["operation_term_status"]
          updated_at: string
          weekdays: number[]
        }
        Insert: {
          business_year_id: string
          created_at?: string
          created_by?: string | null
          end_date: string
          holiday_auto_cancel?: boolean
          id?: string
          initial_roster_applied_at?: string | null
          instructor_name_text?: string | null
          instructor_principal_id?: string | null
          name: string
          operation_cycle_id?: string | null
          organization_id: string
          program_id: string
          schedule_mode?: string
          session_end_time?: string | null
          session_start_time?: string | null
          start_date: string
          status?: Database["public"]["Enums"]["operation_term_status"]
          updated_at?: string
          weekdays: number[]
        }
        Update: {
          business_year_id?: string
          created_at?: string
          created_by?: string | null
          end_date?: string
          holiday_auto_cancel?: boolean
          id?: string
          initial_roster_applied_at?: string | null
          instructor_name_text?: string | null
          instructor_principal_id?: string | null
          name?: string
          operation_cycle_id?: string | null
          organization_id?: string
          program_id?: string
          schedule_mode?: string
          session_end_time?: string | null
          session_start_time?: string | null
          start_date?: string
          status?: Database["public"]["Enums"]["operation_term_status"]
          updated_at?: string
          weekdays?: number[]
        }
        Relationships: [
          {
            foreignKeyName: "operation_terms_business_year_id_fkey"
            columns: ["business_year_id"]
            isOneToOne: false
            referencedRelation: "business_years"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operation_terms_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operation_terms_instructor_principal_id_fkey"
            columns: ["instructor_principal_id"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operation_terms_operation_cycle_id_fkey"
            columns: ["operation_cycle_id"]
            isOneToOne: false
            referencedRelation: "operation_cycles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operation_terms_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operation_terms_program_id_fkey"
            columns: ["program_id"]
            isOneToOne: false
            referencedRelation: "programs"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          attendance_enabled: boolean
          attendance_settings_saved_at: string | null
          created_at: string
          excused_absence_enabled: boolean
          excused_absence_threshold: number
          id: string
          include_annual_cycle: boolean
          instructor_login_listed: boolean
          name: string
          org_code: string
          operation_cycle_mode: string
          timezone: string
          unexcused_absence_threshold: number
          updated_at: string
        }
        Insert: {
          attendance_enabled?: boolean
          attendance_settings_saved_at?: string | null
          created_at?: string
          excused_absence_enabled?: boolean
          excused_absence_threshold?: number
          id?: string
          include_annual_cycle?: boolean
          instructor_login_listed?: boolean
          name: string
          org_code: string
          operation_cycle_mode?: string
          timezone?: string
          unexcused_absence_threshold?: number
          updated_at?: string
        }
        Update: {
          attendance_enabled?: boolean
          attendance_settings_saved_at?: string | null
          created_at?: string
          excused_absence_enabled?: boolean
          excused_absence_threshold?: number
          id?: string
          include_annual_cycle?: boolean
          instructor_login_listed?: boolean
          name?: string
          org_code?: string
          operation_cycle_mode?: string
          timezone?: string
          unexcused_absence_threshold?: number
          updated_at?: string
        }
        Relationships: []
      }
      participants: {
        Row: {
          created_at: string
          id: string
          member_code: string
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          member_code: string
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          member_code?: string
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "participants_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      performance_records: {
        Row: {
          activity_content: string | null
          activity_id: string
          business_year_id: string
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          count_value: number
          created_at: string
          created_by: string | null
          id: string
          method: Database["public"]["Enums"]["performance_method"]
          operation_date: string
          operation_term_id: string | null
          organization_id: string
          source_session_id: string | null
          status: Database["public"]["Enums"]["performance_status"]
          total_people_value: number
          unique_people_value: number
          updated_at: string
        }
        Insert: {
          activity_content?: string | null
          activity_id: string
          business_year_id: string
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          count_value: number
          created_at?: string
          created_by?: string | null
          id?: string
          method: Database["public"]["Enums"]["performance_method"]
          operation_date: string
          operation_term_id?: string | null
          organization_id: string
          source_session_id?: string | null
          status?: Database["public"]["Enums"]["performance_status"]
          total_people_value: number
          unique_people_value: number
          updated_at?: string
        }
        Update: {
          activity_content?: string | null
          activity_id?: string
          business_year_id?: string
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          count_value?: number
          created_at?: string
          created_by?: string | null
          id?: string
          method?: Database["public"]["Enums"]["performance_method"]
          operation_date?: string
          operation_term_id?: string | null
          organization_id?: string
          source_session_id?: string | null
          status?: Database["public"]["Enums"]["performance_status"]
          total_people_value?: number
          unique_people_value?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "performance_records_activity_id_fkey"
            columns: ["activity_id"]
            isOneToOne: false
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "performance_records_business_year_id_fkey"
            columns: ["business_year_id"]
            isOneToOne: false
            referencedRelation: "business_years"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "performance_records_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "performance_records_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "performance_records_operation_term_id_fkey"
            columns: ["operation_term_id"]
            isOneToOne: false
            referencedRelation: "operation_terms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "performance_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "performance_records_source_session_id_fkey"
            columns: ["source_session_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      principals: {
        Row: {
          auth_user_id: string | null
          created_at: string
          id: string
          is_active: boolean
          name: string | null
          organization_id: string
          principal_type: Database["public"]["Enums"]["principal_type"]
          updated_at: string
        }
        Insert: {
          auth_user_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string | null
          organization_id: string
          principal_type: Database["public"]["Enums"]["principal_type"]
          updated_at?: string
        }
        Update: {
          auth_user_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string | null
          organization_id?: string
          principal_type?: Database["public"]["Enums"]["principal_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "principals_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      program_schedule_defaults: {
        Row: {
          created_at: string
          end_time: string | null
          program_id: string
          start_time: string | null
          updated_at: string
          weekdays: number[]
        }
        Insert: {
          created_at?: string
          end_time?: string | null
          program_id: string
          start_time?: string | null
          updated_at?: string
          weekdays: number[]
        }
        Update: {
          created_at?: string
          end_time?: string | null
          program_id?: string
          start_time?: string | null
          updated_at?: string
          weekdays?: number[]
        }
        Relationships: [
          {
            foreignKeyName: "program_schedule_defaults_program_id_fkey"
            columns: ["program_id"]
            isOneToOne: true
            referencedRelation: "programs"
            referencedColumns: ["id"]
          },
        ]
      }
      programs: {
        Row: {
          activity_id: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          activity_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          activity_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "programs_activity_id_fkey"
            columns: ["activity_id"]
            isOneToOne: true
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "programs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      public_holidays: {
        Row: {
          holiday_date: string
          id: string
          name: string
        }
        Insert: {
          holiday_date: string
          id?: string
          name: string
        }
        Update: {
          holiday_date?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      roster_imports: {
        Row: {
          id: string
          idempotency_key: string
          imported_at: string
          imported_by: string | null
          operation_term_id: string
          organization_id: string
          row_count: number
        }
        Insert: {
          id?: string
          idempotency_key: string
          imported_at?: string
          imported_by?: string | null
          operation_term_id: string
          organization_id: string
          row_count: number
        }
        Update: {
          id?: string
          idempotency_key?: string
          imported_at?: string
          imported_by?: string | null
          operation_term_id?: string
          organization_id?: string
          row_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "roster_imports_imported_by_fkey"
            columns: ["imported_by"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_imports_operation_term_id_fkey"
            columns: ["operation_term_id"]
            isOneToOne: false
            referencedRelation: "operation_terms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_imports_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      sessions: {
        Row: {
          cancelled_at: string | null
          cancelled_by: string | null
          created_at: string
          ends_at: string
          finalized_at: string | null
          id: string
          operation_term_id: string
          organization_id: string
          session_no: number
          starts_at: string
          status: Database["public"]["Enums"]["session_status"]
        }
        Insert: {
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          ends_at: string
          finalized_at?: string | null
          id?: string
          operation_term_id: string
          organization_id: string
          session_no: number
          starts_at: string
          status?: Database["public"]["Enums"]["session_status"]
        }
        Update: {
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          ends_at?: string
          finalized_at?: string | null
          id?: string
          operation_term_id?: string
          organization_id?: string
          session_no?: number
          starts_at?: string
          status?: Database["public"]["Enums"]["session_status"]
        }
        Relationships: [
          {
            foreignKeyName: "sessions_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_operation_term_id_fkey"
            columns: ["operation_term_id"]
            isOneToOne: false
            referencedRelation: "operation_terms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_profiles: {
        Row: {
          business_role: Database["public"]["Enums"]["business_role"]
          created_at: string
          department_id: string | null
          is_system_admin: boolean
          must_change_password: boolean
          organization_id: string
          principal_id: string
          updated_at: string
        }
        Insert: {
          business_role: Database["public"]["Enums"]["business_role"]
          created_at?: string
          department_id?: string | null
          is_system_admin?: boolean
          must_change_password?: boolean
          organization_id: string
          principal_id: string
          updated_at?: string
        }
        Update: {
          business_role?: Database["public"]["Enums"]["business_role"]
          created_at?: string
          department_id?: string | null
          is_system_admin?: boolean
          must_change_password?: boolean
          organization_id?: string
          principal_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_profiles_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_profiles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_profiles_principal_id_fkey"
            columns: ["principal_id"]
            isOneToOne: true
            referencedRelation: "principals"
            referencedColumns: ["id"]
          },
        ]
      }
      unit_businesses: {
        Row: {
          business_year_id: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          organization_id: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          business_year_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          organization_id: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          business_year_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          organization_id?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "unit_businesses_business_year_id_fkey"
            columns: ["business_year_id"]
            isOneToOne: false
            referencedRelation: "business_years"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "unit_businesses_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_enrollment_absence_state: {
        Row: {
          alert_active: boolean | null
          dismissal_id: string | null
          dismissed_at: string | null
          dismissed_excused_count: number | null
          dismissed_unexcused_count: number | null
          enrollment_id: string | null
          excused_count: number | null
          excused_near: boolean | null
          excused_reached: boolean | null
          operation_term_id: string | null
          participant_id: string | null
          unexcused_count: number | null
          unexcused_near: boolean | null
          unexcused_reached: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "enrollments_operation_term_id_fkey"
            columns: ["operation_term_id"]
            isOneToOne: false
            referencedRelation: "operation_terms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enrollments_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: false
            referencedRelation: "participants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      activity_id_for_operation_term: {
        Args: { p_operation_term_id: string }
        Returns: string
      }
      activity_id_for_session: {
        Args: { p_session_id: string }
        Returns: string
      }
      add_enrollments: {
        Args: { p_operation_term_id: string; p_participants: Json }
        Returns: number
      }
      add_operation_cycle_programs: {
        Args: { p_operation_cycle_id: string; p_program_ids: string[] }
        Returns: number
      }
      add_session: {
        Args: {
          p_date: string
          p_end_time: string
          p_operation_term_id: string
          p_start_time: string
        }
        Returns: string
      }
      apply_bulk_roster_for_cycle: {
        Args: { p_operation_cycle_id: string; p_rows: Json }
        Returns: {
          out_enrollment_count: number
          out_participant_count: number
          out_program_count: number
        }[]
      }
      apply_business_structure_excel: {
        Args: { p_business_year_id: string; p_rows: Json }
        Returns: {
          out_activities_created: number
          out_majors_created: number
          out_middles_created: number
          out_units_created: number
        }[]
      }
      apply_initial_roster: {
        Args: {
          p_idempotency_key: string
          p_operation_term_id: string
          p_rows: Json
        }
        Returns: {
          enrollment_count: number
          participant_count: number
        }[]
      }
      assign_activity: {
        Args: { p_activity_id: string; p_staff_principal_id: string }
        Returns: string
      }
      begin_instructor_login: {
        Args: { p_name: string; p_phone_last4: string }
        Returns: {
          is_locked: boolean
          needs_pin_setup: boolean
          principal_id: string
        }[]
      }
      build_ai_evaluation_payload: {
        Args: {
          p_period_end: string
          p_period_start: string
          p_period_type: Database["public"]["Enums"]["ai_evaluation_period_type"]
          p_unit_business_id: string
        }
        Returns: Json
      }
      can_generate_ai_evaluation: {
        Args: { p_unit_business_id: string }
        Returns: boolean
      }
      can_manage_activity: { Args: { p_activity_id: string }; Returns: boolean }
      can_read_activity: { Args: { p_activity_id: string }; Returns: boolean }
      can_read_unit_business: {
        Args: { p_unit_business_id: string }
        Returns: boolean
      }
      cancel_excused_absence: {
        Args: { p_enrollment_id: string; p_session_id: string }
        Returns: undefined
      }
      cancel_performance: {
        Args: { p_id: string; p_reason: string }
        Returns: undefined
      }
      cancel_session: { Args: { p_session_id: string }; Returns: undefined }
      clear_must_change_password: { Args: never; Returns: undefined }
      complete_missing_session: {
        Args: { p_entries: Json; p_reason: string; p_session_id: string }
        Returns: number
      }
      compute_session_dates: {
        Args: { p_end: string; p_start: string; p_weekdays: number[] }
        Returns: string[]
      }
      confirm_instructor_current_pin: {
        Args: { p_name: string; p_org_code: string; p_phone_last4: string }
        Returns: {
          out_auth_user_id: string
          out_organization_id: string
          out_principal_id: string
        }[]
      }
      correct_final_attendance: {
        Args: {
          p_after_mark: Database["public"]["Enums"]["attendance_mark"]
          p_final_attendance_id: string
          p_reason: string
        }
        Returns: undefined
      }
      create_activity_with_program: {
        Args: {
          p_business_node_id: string
          p_business_year_id: string
          p_default_performance_method: Database["public"]["Enums"]["performance_method"]
          p_name: string
        }
        Returns: string
      }
      create_business_node: {
        Args: {
          p_business_year_id: string
          p_name: string
          p_node_type: Database["public"]["Enums"]["business_node_type"]
          p_parent_id: string
          p_unit_business_id?: string
        }
        Returns: string
      }
      create_business_year: { Args: { p_year: number }; Returns: string }
      create_department: { Args: { p_name: string }; Returns: string }
      create_operation_cycle: {
        Args: {
          p_business_year_id: string
          p_end_date: string
          p_name: string
          p_start_date: string
        }
        Returns: string
      }
      create_operation_cycle_with_programs: {
        Args: {
          p_business_year_id: string
          p_end_date: string
          p_idempotency_key: string
          p_name: string
          p_programs: Json
          p_start_date: string
        }
        Returns: {
          out_cycle_id: string
          out_session_count: number
          out_term_count: number
        }[]
      }
      create_operation_term: {
        Args: {
          p_business_year_id: string
          p_end_date: string
          p_end_time: string
          p_excluded_dates?: string[]
          p_name: string
          p_program_id: string
          p_start_date: string
          p_start_time: string
          p_weekdays: number[]
        }
        Returns: string
      }
      create_summary_performance: {
        Args: {
          p_activity_content: string
          p_activity_id: string
          p_count_value: number
          p_operation_date: string
          p_total_people_value: number
          p_unique_people_value: number
        }
        Returns: string
      }
      create_unit_business: {
        Args: { p_business_year_id: string; p_name: string }
        Returns: string
      }
      current_business_role: {
        Args: never
        Returns: Database["public"]["Enums"]["business_role"]
      }
      current_organization_id: { Args: never; Returns: string }
      current_principal_id: { Args: never; Returns: string }
      delete_activity: { Args: { p_id: string }; Returns: undefined }
      delete_business_node: { Args: { p_id: string }; Returns: undefined }
      delete_business_year: { Args: { p_id: string }; Returns: undefined }
      delete_operation_cycle: { Args: { p_id: string }; Returns: undefined }
      delete_session: { Args: { p_session_id: string }; Returns: undefined }
      delete_unit_business: { Args: { p_id: string }; Returns: undefined }
      dismiss_absence_alert: {
        Args: { p_enrollment_id: string }
        Returns: string
      }
      dismiss_absence_alerts: {
        Args: { p_enrollment_ids: string[] }
        Returns: number
      }
      finalize_due_sessions: {
        Args: never
        Returns: {
          out_result: string
          out_session_id: string
        }[]
      }
      get_activity_metrics: {
        Args: {
          p_activity_id: string
          p_period_end: string
          p_period_start: string
        }
        Returns: {
          count_value: number
          total_people_value: number
          unique_people_value: number
        }[]
      }
      get_performance_report: {
        Args: {
          p_business_year_id: string
          p_period_end: string
          p_period_start: string
          p_ytd_start: string
        }
        Returns: {
          label: string
          level: number
          node_id: string
          node_type: string
          parent_id: string
          period_count: number
          period_total: number
          period_unique: number
          plan_count: number
          plan_total: number
          plan_unique: number
          sort_order: number
          unit_business_id: string
          ytd_count: number
          ytd_total: number
          ytd_unique: number
        }[]
      }
      get_session_input_deadline: {
        Args: { p_session_id: string }
        Returns: string
      }
      get_session_input_opens_at: {
        Args: { p_session_id: string }
        Returns: string
      }
      get_session_attendance_roster: {
        Args: { p_session_id: string }
        Returns: {
          enrollment_id: string
          final_attendance_id: string
          final_mark: Database["public"]["Enums"]["attendance_mark"]
          is_pre_excused: boolean
          latest_instructor_mark: Database["public"]["Enums"]["attendance_mark"]
          member_code: string
          name: string
          participant_id: string
        }[]
      }
      get_unit_business_aggregate: {
        Args: {
          p_period_end: string
          p_period_start: string
          p_unit_business_id: string
        }
        Returns: {
          count_value: number
          total_people_value: number
          unique_people_value: number
        }[]
      }
      instructs_program: { Args: { p_program_id: string }; Returns: boolean }
      is_run_instructor: {
        Args: { p_operation_term_id: string }
        Returns: boolean
      }
      is_system_admin: { Args: never; Returns: boolean }
      issue_instructor_start_code: {
        Args: { p_principal_id: string }
        Returns: {
          out_code: string
          out_expires_at: string
          out_sessions_revoked: boolean
        }[]
      }
      list_absence_alert_states: {
        Args: { p_operation_cycle_ids: string[] }
        Returns: {
          out_alert_active: boolean
          out_enrollment_id: string
          out_excused_count: number
          out_excused_near: boolean
          out_excused_reached: boolean
          out_operation_term_id: string
          out_unexcused_count: number
          out_unexcused_near: boolean
          out_unexcused_reached: boolean
        }[]
      }
      list_ai_evaluation_unit_businesses: {
        Args: { p_business_year_id: string }
        Returns: {
          out_id: string
          out_name: string
          out_sort_order: number
        }[]
      }
      list_assignable_staff: {
        Args: never
        Returns: {
          out_name: string
          out_principal_id: string
        }[]
      }
      list_departments: {
        Args: never
        Returns: {
          out_id: string
          out_is_active: boolean
          out_name: string
          out_staff_count: number
        }[]
      }
      list_instructor_accounts: {
        Args: never
        Returns: {
          out_created_at: string
          out_is_active: boolean
          out_name: string
          out_phone_last4: string
          out_pin_confirmed: boolean
          out_pin_locked: boolean
          out_pin_set: boolean
          out_principal_id: string
          out_start_code_expires_at: string | null
        }[]
      }
      list_operation_cycle_program_status: {
        Args: { p_operation_cycle_id: string }
        Returns: {
          out_activity_id: string
          out_end_time: string
          out_enrollment_count: number
          out_has_term: boolean
          out_initial_roster_applied: boolean
          out_instructor_name: string
          out_instructor_name_text: string
          out_name: string
          out_operation_term_id: string
          out_program_id: string
          out_schedule_mode: string
          out_session_count: number
          out_start_time: string
          out_weekdays: number[]
        }[]
      }
      list_operation_cycles: {
        Args: { p_business_year_id?: string }
        Returns: {
          out_end_date: string
          out_id: string
          out_name: string
          out_program_count: number
          out_start_date: string
          out_status: Database["public"]["Enums"]["operation_cycle_status"]
        }[]
      }
      list_operation_term_sessions: {
        Args: { p_operation_term_id: string }
        Returns: {
          out_absent_excused_count: number
          out_absent_total_count: number
          out_ends_at: string
          out_enrolled_count: number
          out_has_correction: boolean
          out_has_submission: boolean
          out_id: string
          out_present_count: number
          out_session_no: number
          out_starts_at: string
          out_status: string
        }[]
      }
      list_programs_with_schedule: {
        Args: never
        Returns: {
          out_activity_id: string
          out_end_time: string
          out_name: string
          out_program_id: string
          out_sort_order: number
          out_start_time: string
          out_weekdays: number[]
        }[]
      }
      list_selectable_programs_for_cycle: {
        Args: { p_operation_cycle_id: string }
        Returns: {
          out_activity_id: string
          out_name: string
          out_program_id: string
        }[]
      }
      list_staff_accounts: {
        Args: never
        Returns: {
          out_business_role: Database["public"]["Enums"]["business_role"]
          out_created_at: string
          out_email: string
          out_is_active: boolean
          out_is_system_admin: boolean
          out_must_change_password: boolean
          out_name: string
          out_principal_id: string
        }[]
      }
      mark_staff_password_reset: {
        Args: { p_principal_id: string }
        Returns: undefined
      }
      preview_add_enrollments: {
        Args: { p_member_codes: string[]; p_operation_term_id: string }
        Returns: {
          out_active_in_term: boolean
          out_ended_in_term: boolean
          out_existing_name: string
          out_member_code: string
        }[]
      }
      preview_operation_term_sessions: {
        Args: {
          p_end_date: string
          p_excluded_dates?: string[]
          p_program_id: string
          p_start_date: string
          p_weekdays: number[]
        }
        Returns: {
          session_date: string
          session_no: number
        }[]
      }
      provision_instructor: {
        Args: {
          p_auth_user_id: string
          p_name: string
          p_organization_id: string
          p_phone_last4: string
        }
        Returns: string
      }
      provision_instructor_with_start_code: {
        Args: {
          p_auth_user_id: string
          p_name: string
          p_organization_id: string
          p_phone_last4: string
        }
        Returns: {
          out_code: string
          out_expires_at: string
          out_principal_id: string
        }[]
      }
      provision_staff: {
        Args: {
          p_auth_user_id: string
          p_business_role: Database["public"]["Enums"]["business_role"]
          p_is_system_admin: boolean
          p_name: string
          p_organization_id: string
        }
        Returns: string
      }
      reactivate_absence_alert: {
        Args: { p_enrollment_id: string }
        Returns: undefined
      }
      recompute_attendance_performance_for_session: {
        Args: { p_session_id: string }
        Returns: undefined
      }
      remove_operation_cycle_program: {
        Args: { p_operation_cycle_id: string; p_program_id: string }
        Returns: undefined
      }
      restore_performance: { Args: { p_id: string }; Returns: undefined }
      save_ai_evaluation_snapshot: {
        Args: {
          p_checkpoints: string
          p_future_direction: string
          p_idempotency_key: string
          p_major_changes: string
          p_model_name: string
          p_operation_result: string
          p_payload: Json
          p_prompt_version: string
          p_reference_note: string
        }
        Returns: string
      }
      save_instructor_attendance: {
        Args: {
          p_entries: Json
          p_idempotency_key: string
          p_session_id: string
        }
        Returns: {
          submission_id: string
          version: number
        }[]
      }
      session_input_deadline: {
        Args: { p_ends_at: string; p_starts_at: string }
        Returns: string
      }
      session_effective_enrollment_ids: {
        Args: { p_session_id: string }
        Returns: string[]
      }
      set_department_active: {
        Args: { p_id: string; p_is_active: boolean }
        Returns: undefined
      }
      set_excused_absence: {
        Args: { p_enrollment_id: string; p_session_id: string }
        Returns: string
      }
      set_instructor_active: {
        Args: { p_is_active: boolean; p_principal_id: string }
        Returns: undefined
      }
      set_instructor_pin: {
        Args: {
          p_name: string
          p_new_pin: string
          p_org_code: string
          p_phone_last4: string
        }
        Returns: {
          out_auth_user_id: string
          out_organization_id: string
          out_principal_id: string
        }[]
      }
      set_staff_active: {
        Args: { p_is_active: boolean; p_principal_id: string }
        Returns: undefined
      }
      set_staff_department: {
        Args: { p_department_id: string; p_principal_id: string }
        Returns: undefined
      }
      terminate_enrollments: {
        Args: { p_enrollment_ids: string[] }
        Returns: number
      }
      unassign_activity: {
        Args: { p_activity_id: string; p_staff_principal_id: string }
        Returns: undefined
      }
      uncancel_session: { Args: { p_session_id: string }; Returns: undefined }
      update_activity: {
        Args: { p_id: string; p_is_active: boolean; p_name: string }
        Returns: undefined
      }
      update_attendance_settings: {
        Args: {
          p_attendance_enabled: boolean
          p_excused_absence_enabled: boolean
          p_excused_absence_threshold: number
          p_unexcused_absence_threshold: number
        }
        Returns: undefined
      }
      update_business_node: {
        Args: { p_id: string; p_is_active: boolean; p_name: string }
        Returns: undefined
      }
      update_business_year: {
        Args: { p_id: string; p_year: number }
        Returns: undefined
      }
      update_enrollment_end_date: {
        Args: { p_end_date: string; p_enrollment_id: string }
        Returns: undefined
      }
      update_operation_cycle: {
        Args: {
          p_end_date: string
          p_id: string
          p_name: string
          p_start_date: string
        }
        Returns: undefined
      }
      update_operation_cycle_mode: {
        Args: { p_include_annual_cycle: boolean; p_mode: string }
        Returns: Json
      }
      update_organization_name: { Args: { p_name: string }; Returns: undefined }
      update_session: {
        Args: {
          p_date: string
          p_end_time: string
          p_session_id: string
          p_start_time: string
        }
        Returns: undefined
      }
      update_staff_info: {
        Args: { p_name: string; p_principal_id: string }
        Returns: undefined
      }
      update_staff_role: {
        Args: {
          p_business_role: Database["public"]["Enums"]["business_role"]
          p_is_system_admin: boolean
          p_principal_id: string
          p_reason: string
        }
        Returns: undefined
      }
      update_summary_performance: {
        Args: {
          p_activity_content: string
          p_count_value: number
          p_id: string
          p_operation_date: string
          p_total_people_value: number
          p_unique_people_value: number
        }
        Returns: undefined
      }
      update_unit_business: {
        Args: { p_id: string; p_name: string }
        Returns: undefined
      }
      upsert_annual_plan: {
        Args: {
          p_activity_id: string
          p_business_year_id: string
          p_count_basis: string
          p_count_target: number
          p_total_basis: string
          p_total_target: number
          p_unique_basis: string
          p_unique_target: number
        }
        Returns: string
      }
      upsert_annual_plan_batch: {
        Args: { p_business_year_id: string; p_rows: Json }
        Returns: number
      }
      upsert_operation_term_for_cycle: {
        Args: {
          p_end_time: string
          p_excluded_dates?: string[]
          p_explicit_dates?: string[]
          p_holiday_auto_cancel?: boolean
          p_instructor_name_text?: string
          p_instructor_principal_id: string
          p_operation_cycle_id: string
          p_program_id: string
          p_schedule_mode?: string
          p_start_time: string
          p_weekdays: number[]
        }
        Returns: {
          out_created: boolean
          out_sessions_regenerated: boolean
          out_term_id: string
        }[]
      }
      upsert_program_schedule_default: {
        Args: {
          p_end_time: string
          p_program_id: string
          p_start_time: string
          p_weekdays: number[]
        }
        Returns: undefined
      }
      upsert_program_schedule_defaults_batch: {
        Args: { p_rows: Json }
        Returns: number
      }
      verify_instructor_login: {
        Args: {
          p_name: string
          p_org_code: string
          p_phone_last4: string
          p_pin: string
        }
        Returns: {
          auth_user_id: string
          organization_id: string
          pin_confirmed: boolean
          principal_id: string
        }[]
      }
    }
    Enums: {
      ai_evaluation_period_type: "quarter" | "half_year" | "year" | "custom"
      attendance_mark: "present" | "absent" | "excused"
      business_node_type: "major" | "middle" | "minor"
      business_role:
        | "staff"
        | "department_manager"
        | "global_manager"
        | "global_viewer"
      business_year_status: "planning" | "active" | "closed"
      finalization_method:
        | "auto_latest_submission"
        | "staff_missing_completion"
        | "staff_correction"
      operation_cycle_status: "scheduled" | "active" | "ended"
      operation_term_status: "scheduled" | "active" | "ended"
      performance_method: "attendance" | "summary"
      performance_status: "active" | "cancelled"
      principal_type: "staff" | "instructor"
      session_status: "scheduled" | "completed" | "missing" | "cancelled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      ai_evaluation_period_type: ["quarter", "half_year", "year", "custom"],
      attendance_mark: ["present", "absent", "excused"],
      business_node_type: ["major", "middle", "minor"],
      business_role: [
        "staff",
        "department_manager",
        "global_manager",
        "global_viewer",
      ],
      business_year_status: ["planning", "active", "closed"],
      finalization_method: [
        "auto_latest_submission",
        "staff_missing_completion",
        "staff_correction",
      ],
      operation_cycle_status: ["scheduled", "active", "ended"],
      operation_term_status: ["scheduled", "active", "ended"],
      performance_method: ["attendance", "summary"],
      performance_status: ["active", "cancelled"],
      principal_type: ["staff", "instructor"],
      session_status: ["scheduled", "completed", "missing", "cancelled"],
    },
  },
} as const
