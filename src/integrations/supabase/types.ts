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
      alertas_atendimento_parado: {
        Row: {
          atendimento_id: string
          company_id: string | null
          created_at: string
          id: string
          janela: string
        }
        Insert: {
          atendimento_id: string
          company_id?: string | null
          created_at?: string
          id?: string
          janela: string
        }
        Update: {
          atendimento_id?: string
          company_id?: string | null
          created_at?: string
          id?: string
          janela?: string
        }
        Relationships: [
          {
            foreignKeyName: "alertas_atendimento_parado_atendimento_id_fkey"
            columns: ["atendimento_id"]
            isOneToOne: false
            referencedRelation: "atendimentos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alertas_atendimento_parado_atendimento_id_fkey"
            columns: ["atendimento_id"]
            isOneToOne: false
            referencedRelation: "vw_pendentes"
            referencedColumns: ["atendimento_id"]
          },
        ]
      }
      app_secrets: {
        Row: {
          created_at: string
          key: string
          value: string
        }
        Insert: {
          created_at?: string
          key: string
          value: string
        }
        Update: {
          created_at?: string
          key?: string
          value?: string
        }
        Relationships: []
      }
      atendimento_leituras: {
        Row: {
          atendimento_id: string
          company_id: string
          last_read_at: string
          user_id: string
        }
        Insert: {
          atendimento_id: string
          company_id: string
          last_read_at?: string
          user_id: string
        }
        Update: {
          atendimento_id?: string
          company_id?: string
          last_read_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "atendimento_leituras_atend_same_company_fk"
            columns: ["atendimento_id", "company_id"]
            isOneToOne: false
            referencedRelation: "atendimentos"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "atendimento_leituras_atendimento_id_fkey"
            columns: ["atendimento_id"]
            isOneToOne: false
            referencedRelation: "atendimentos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "atendimento_leituras_atendimento_id_fkey"
            columns: ["atendimento_id"]
            isOneToOne: false
            referencedRelation: "vw_pendentes"
            referencedColumns: ["atendimento_id"]
          },
          {
            foreignKeyName: "atendimento_leituras_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "atendimento_leituras_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      atendimentos: {
        Row: {
          assigned_at: string | null
          assigned_to: string | null
          client_id: string
          close_reason: Database["public"]["Enums"]["close_reason"] | null
          closed_at: string | null
          closed_by_user_id: string | null
          company_id: string
          created_at: string
          current_department_id: string | null
          escalated_from_department_id: string | null
          escalated_from_user_id: string | null
          first_response_at: string | null
          id: string
          is_sessao: boolean
          last_message_at: string | null
          last_outbound_message_at: string | null
          status: Database["public"]["Enums"]["status_atendimento"]
          transferred_count: number
          triagem_estagio: Database["public"]["Enums"]["triagem_estagio"]
          triagem_finished_at: string | null
          triagem_last_processed_msg_id: string | null
          triagem_lembrete_enviado_at: string | null
          triagem_started_at: string | null
          triagem_tentativas: number
          updated_at: string
        }
        Insert: {
          assigned_at?: string | null
          assigned_to?: string | null
          client_id: string
          close_reason?: Database["public"]["Enums"]["close_reason"] | null
          closed_at?: string | null
          closed_by_user_id?: string | null
          company_id?: string
          created_at?: string
          current_department_id?: string | null
          escalated_from_department_id?: string | null
          escalated_from_user_id?: string | null
          first_response_at?: string | null
          id?: string
          is_sessao?: boolean
          last_message_at?: string | null
          last_outbound_message_at?: string | null
          status?: Database["public"]["Enums"]["status_atendimento"]
          transferred_count?: number
          triagem_estagio?: Database["public"]["Enums"]["triagem_estagio"]
          triagem_finished_at?: string | null
          triagem_last_processed_msg_id?: string | null
          triagem_lembrete_enviado_at?: string | null
          triagem_started_at?: string | null
          triagem_tentativas?: number
          updated_at?: string
        }
        Update: {
          assigned_at?: string | null
          assigned_to?: string | null
          client_id?: string
          close_reason?: Database["public"]["Enums"]["close_reason"] | null
          closed_at?: string | null
          closed_by_user_id?: string | null
          company_id?: string
          created_at?: string
          current_department_id?: string | null
          escalated_from_department_id?: string | null
          escalated_from_user_id?: string | null
          first_response_at?: string | null
          id?: string
          is_sessao?: boolean
          last_message_at?: string | null
          last_outbound_message_at?: string | null
          status?: Database["public"]["Enums"]["status_atendimento"]
          transferred_count?: number
          triagem_estagio?: Database["public"]["Enums"]["triagem_estagio"]
          triagem_finished_at?: string | null
          triagem_last_processed_msg_id?: string | null
          triagem_lembrete_enviado_at?: string | null
          triagem_started_at?: string | null
          triagem_tentativas?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "atendimentos_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "atendimentos_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "atendimentos_client_same_company_fk"
            columns: ["client_id", "company_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "atendimentos_closed_by_user_id_fkey"
            columns: ["closed_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "atendimentos_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "atendimentos_current_department_id_fkey"
            columns: ["current_department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "atendimentos_dept_same_company_fk"
            columns: ["current_department_id", "company_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "atendimentos_escalated_from_department_id_fkey"
            columns: ["escalated_from_department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "atendimentos_escalated_from_user_id_fkey"
            columns: ["escalated_from_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      business_hours: {
        Row: {
          company_id: string
          created_at: string
          dia_semana: number
          fim: string
          id: string
          inicio: string
          updated_at: string
        }
        Insert: {
          company_id?: string
          created_at?: string
          dia_semana: number
          fim: string
          id?: string
          inicio: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          dia_semana?: number
          fim?: string
          id?: string
          inicio?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_hours_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      cleanup_log: {
        Row: {
          acao: string
          client_id: string | null
          company_id: string
          executed_at: string
          id: string
          message_id: string | null
          motivo: string | null
          phone: string | null
          run_id: string
          zapi_message_id: string | null
          zapi_response: Json | null
        }
        Insert: {
          acao: string
          client_id?: string | null
          company_id?: string
          executed_at?: string
          id?: string
          message_id?: string | null
          motivo?: string | null
          phone?: string | null
          run_id: string
          zapi_message_id?: string | null
          zapi_response?: Json | null
        }
        Update: {
          acao?: string
          client_id?: string | null
          company_id?: string
          executed_at?: string
          id?: string
          message_id?: string | null
          motivo?: string | null
          phone?: string | null
          run_id?: string
          zapi_message_id?: string | null
          zapi_response?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "cleanup_log_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          chat_lid: string | null
          company_id: string
          created_at: string
          foto_atualizada_em: string | null
          foto_url: string | null
          id: string
          nome: string | null
          numero_whatsapp: string
          updated_at: string
        }
        Insert: {
          chat_lid?: string | null
          company_id?: string
          created_at?: string
          foto_atualizada_em?: string | null
          foto_url?: string | null
          id?: string
          nome?: string | null
          numero_whatsapp: string
          updated_at?: string
        }
        Update: {
          chat_lid?: string | null
          company_id?: string
          created_at?: string
          foto_atualizada_em?: string | null
          foto_url?: string | null
          id?: string
          nome?: string | null
          numero_whatsapp?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clients_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      companies: {
        Row: {
          ativo: boolean
          created_at: string
          id: string
          nome: string
          updated_at: string
          whatsapp_phone: string | null
          zapi_client_token: string | null
          zapi_instance_id: string | null
          zapi_token: string | null
        }
        Insert: {
          ativo?: boolean
          created_at?: string
          id?: string
          nome: string
          updated_at?: string
          whatsapp_phone?: string | null
          zapi_client_token?: string | null
          zapi_instance_id?: string | null
          zapi_token?: string | null
        }
        Update: {
          ativo?: boolean
          created_at?: string
          id?: string
          nome?: string
          updated_at?: string
          whatsapp_phone?: string | null
          zapi_client_token?: string | null
          zapi_instance_id?: string | null
          zapi_token?: string | null
        }
        Relationships: []
      }
      company_invitations: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          department_id: string | null
          email: string
          id: string
          nome: string
          role: Database["public"]["Enums"]["company_role"]
          status: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          email: string
          id?: string
          nome: string
          role: Database["public"]["Enums"]["company_role"]
          status?: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          email?: string
          id?: string
          nome?: string
          role?: Database["public"]["Enums"]["company_role"]
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_invitations_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_invitations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_invitations_dept_same_company_fk"
            columns: ["department_id", "company_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      company_members: {
        Row: {
          ativo: boolean
          company_id: string
          created_at: string
          created_by: string | null
          department_id: string | null
          id: string
          role: Database["public"]["Enums"]["company_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          ativo?: boolean
          company_id: string
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          id?: string
          role: Database["public"]["Enums"]["company_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          ativo?: boolean
          company_id?: string
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          id?: string
          role?: Database["public"]["Enums"]["company_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_members_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_members_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_members_dept_same_company_fk"
            columns: ["department_id", "company_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "company_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      config_audit_log: {
        Row: {
          campo: string
          company_id: string
          created_at: string
          entidade: string
          entidade_id: string
          id: string
          user_id: string | null
          valor_anterior: string | null
          valor_novo: string | null
        }
        Insert: {
          campo: string
          company_id?: string
          created_at?: string
          entidade: string
          entidade_id: string
          id?: string
          user_id?: string | null
          valor_anterior?: string | null
          valor_novo?: string | null
        }
        Update: {
          campo?: string
          company_id?: string
          created_at?: string
          entidade?: string
          entidade_id?: string
          id?: string
          user_id?: string | null
          valor_anterior?: string | null
          valor_novo?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "config_audit_log_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "config_audit_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      contatos: {
        Row: {
          company_id: string
          created_at: string
          emails: Json
          etag: string | null
          google_resource_name: string
          id: string
          nome: string | null
          numero_raw: string | null
          numero_whatsapp: string | null
          updated_at: string
        }
        Insert: {
          company_id?: string
          created_at?: string
          emails?: Json
          etag?: string | null
          google_resource_name: string
          id?: string
          nome?: string | null
          numero_raw?: string | null
          numero_whatsapp?: string | null
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          emails?: Json
          etag?: string | null
          google_resource_name?: string
          id?: string
          nome?: string | null
          numero_raw?: string | null
          numero_whatsapp?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agenda_contatos_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      conversa_interna_leituras: {
        Row: {
          company_id: string
          conversa_id: string
          last_read_at: string
          user_id: string
        }
        Insert: {
          company_id: string
          conversa_id: string
          last_read_at?: string
          user_id: string
        }
        Update: {
          company_id?: string
          conversa_id?: string
          last_read_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversa_interna_leituras_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversa_interna_leituras_conversa_id_fkey"
            columns: ["conversa_id"]
            isOneToOne: false
            referencedRelation: "conversas_internas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversa_interna_leituras_conversa_same_company_fk"
            columns: ["conversa_id", "company_id"]
            isOneToOne: false
            referencedRelation: "conversas_internas"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "conversa_interna_leituras_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      conversas_internas: {
        Row: {
          company_id: string
          created_at: string
          id: string
          last_message_at: string | null
          user_a_id: string
          user_b_id: string
        }
        Insert: {
          company_id?: string
          created_at?: string
          id?: string
          last_message_at?: string | null
          user_a_id: string
          user_b_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          last_message_at?: string | null
          user_a_id?: string
          user_b_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversas_internas_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversas_internas_user_a_id_fkey"
            columns: ["user_a_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversas_internas_user_b_id_fkey"
            columns: ["user_b_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      department_business_hours: {
        Row: {
          created_at: string
          department_id: string
          dia_semana: number
          fim: string
          id: string
          inicio: string
        }
        Insert: {
          created_at?: string
          department_id: string
          dia_semana: number
          fim: string
          id?: string
          inicio: string
        }
        Update: {
          created_at?: string
          department_id?: string
          dia_semana?: number
          fim?: string
          id?: string
          inicio?: string
        }
        Relationships: [
          {
            foreignKeyName: "department_business_hours_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      departments: {
        Row: {
          alert_recipient_user_id: string | null
          ativo: boolean
          company_id: string
          cor: string
          created_at: string
          id: string
          nome: string
          updated_at: string
        }
        Insert: {
          alert_recipient_user_id?: string | null
          ativo?: boolean
          company_id?: string
          cor?: string
          created_at?: string
          id?: string
          nome: string
          updated_at?: string
        }
        Update: {
          alert_recipient_user_id?: string | null
          ativo?: boolean
          company_id?: string
          cor?: string
          created_at?: string
          id?: string
          nome?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "departments_alert_recipient_user_id_fkey"
            columns: ["alert_recipient_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "departments_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      envios_internos_whatsapp: {
        Row: {
          criado_em: string
          uazapi_message_id: string
        }
        Insert: {
          criado_em?: string
          uazapi_message_id: string
        }
        Update: {
          criado_em?: string
          uazapi_message_id?: string
        }
        Relationships: []
      }
      google_integration: {
        Row: {
          access_token: string | null
          company_id: string
          connected: boolean
          connected_email: string | null
          contacts_count: number
          created_at: string
          id: string
          last_sync_at: string | null
          last_sync_error: string | null
          last_sync_status: string | null
          refresh_token: string | null
          scope: string | null
          sync_token: string | null
          token_expiry: string | null
          updated_at: string
        }
        Insert: {
          access_token?: string | null
          company_id?: string
          connected?: boolean
          connected_email?: string | null
          contacts_count?: number
          created_at?: string
          id?: string
          last_sync_at?: string | null
          last_sync_error?: string | null
          last_sync_status?: string | null
          refresh_token?: string | null
          scope?: string | null
          sync_token?: string | null
          token_expiry?: string | null
          updated_at?: string
        }
        Update: {
          access_token?: string | null
          company_id?: string
          connected?: boolean
          connected_email?: string | null
          contacts_count?: number
          created_at?: string
          id?: string
          last_sync_at?: string | null
          last_sync_error?: string | null
          last_sync_status?: string | null
          refresh_token?: string | null
          scope?: string | null
          sync_token?: string | null
          token_expiry?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "google_integration_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      grupo_leituras: {
        Row: {
          company_id: string
          grupo_id: string
          last_read_at: string
          user_id: string
        }
        Insert: {
          company_id: string
          grupo_id: string
          last_read_at?: string
          user_id: string
        }
        Update: {
          company_id?: string
          grupo_id?: string
          last_read_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "grupo_leituras_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grupo_leituras_grupo_id_fkey"
            columns: ["grupo_id"]
            isOneToOne: false
            referencedRelation: "grupos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grupo_leituras_grupo_same_company_fk"
            columns: ["grupo_id", "company_id"]
            isOneToOne: false
            referencedRelation: "grupos"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "grupo_leituras_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      grupo_mensagens: {
        Row: {
          company_id: string
          content: string | null
          created_at: string
          direction: Database["public"]["Enums"]["direction_mensagem"]
          grupo_id: string
          id: string
          media_metadata: Json | null
          media_url: string | null
          participante_nome: string | null
          participante_numero: string | null
          reply_to_message_id: string | null
          sender_type: Database["public"]["Enums"]["grupo_sender_type"]
          sent_by_user_id: string | null
          status_envio: Database["public"]["Enums"]["status_envio_mensagem"]
          status_whatsapp:
            | Database["public"]["Enums"]["status_whatsapp_mensagem"]
            | null
          tipo: Database["public"]["Enums"]["tipo_mensagem"]
          uazapi_message_id: string | null
        }
        Insert: {
          company_id?: string
          content?: string | null
          created_at?: string
          direction: Database["public"]["Enums"]["direction_mensagem"]
          grupo_id: string
          id?: string
          media_metadata?: Json | null
          media_url?: string | null
          participante_nome?: string | null
          participante_numero?: string | null
          reply_to_message_id?: string | null
          sender_type: Database["public"]["Enums"]["grupo_sender_type"]
          sent_by_user_id?: string | null
          status_envio?: Database["public"]["Enums"]["status_envio_mensagem"]
          status_whatsapp?:
            | Database["public"]["Enums"]["status_whatsapp_mensagem"]
            | null
          tipo: Database["public"]["Enums"]["tipo_mensagem"]
          uazapi_message_id?: string | null
        }
        Update: {
          company_id?: string
          content?: string | null
          created_at?: string
          direction?: Database["public"]["Enums"]["direction_mensagem"]
          grupo_id?: string
          id?: string
          media_metadata?: Json | null
          media_url?: string | null
          participante_nome?: string | null
          participante_numero?: string | null
          reply_to_message_id?: string | null
          sender_type?: Database["public"]["Enums"]["grupo_sender_type"]
          sent_by_user_id?: string | null
          status_envio?: Database["public"]["Enums"]["status_envio_mensagem"]
          status_whatsapp?:
            | Database["public"]["Enums"]["status_whatsapp_mensagem"]
            | null
          tipo?: Database["public"]["Enums"]["tipo_mensagem"]
          uazapi_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "grupo_mensagens_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grupo_mensagens_grupo_id_fkey"
            columns: ["grupo_id"]
            isOneToOne: false
            referencedRelation: "grupos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grupo_mensagens_grupo_same_company_fk"
            columns: ["grupo_id", "company_id"]
            isOneToOne: false
            referencedRelation: "grupos"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "grupo_mensagens_reply_same_grupo_fk"
            columns: ["reply_to_message_id", "grupo_id"]
            isOneToOne: false
            referencedRelation: "grupo_mensagens"
            referencedColumns: ["id", "grupo_id"]
          },
          {
            foreignKeyName: "grupo_mensagens_sent_by_user_id_fkey"
            columns: ["sent_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      grupos: {
        Row: {
          ativo: boolean
          company_id: string
          created_at: string
          foto_atualizada_em: string | null
          foto_url: string | null
          id: string
          last_message_at: string | null
          last_outbound_message_at: string | null
          nome: string | null
          participantes_total: number | null
          somente_admin_envia: boolean
          sou_admin: boolean
          synced_at: string | null
          topico: string | null
          updated_at: string
          wa_jid: string
        }
        Insert: {
          ativo?: boolean
          company_id?: string
          created_at?: string
          foto_atualizada_em?: string | null
          foto_url?: string | null
          id?: string
          last_message_at?: string | null
          last_outbound_message_at?: string | null
          nome?: string | null
          participantes_total?: number | null
          somente_admin_envia?: boolean
          sou_admin?: boolean
          synced_at?: string | null
          topico?: string | null
          updated_at?: string
          wa_jid: string
        }
        Update: {
          ativo?: boolean
          company_id?: string
          created_at?: string
          foto_atualizada_em?: string | null
          foto_url?: string | null
          id?: string
          last_message_at?: string | null
          last_outbound_message_at?: string | null
          nome?: string | null
          participantes_total?: number | null
          somente_admin_envia?: boolean
          sou_admin?: boolean
          synced_at?: string | null
          topico?: string | null
          updated_at?: string
          wa_jid?: string
        }
        Relationships: [
          {
            foreignKeyName: "grupos_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      historico_import_pedidos: {
        Row: {
          ancora_messageid: string | null
          ate: string
          chatid: string
          client_id: string
          company_id: string
          desde: string
          expira_em: string
          id: string
          inseridas: number
          recebidas: number
          solicitado_em: string
        }
        Insert: {
          ancora_messageid?: string | null
          ate: string
          chatid: string
          client_id: string
          company_id: string
          desde: string
          expira_em: string
          id?: string
          inseridas?: number
          recebidas?: number
          solicitado_em?: string
        }
        Update: {
          ancora_messageid?: string | null
          ate?: string
          chatid?: string
          client_id?: string
          company_id?: string
          desde?: string
          expira_em?: string
          id?: string
          inseridas?: number
          recebidas?: number
          solicitado_em?: string
        }
        Relationships: [
          {
            foreignKeyName: "historico_import_pedidos_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "historico_import_pedidos_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      holidays: {
        Row: {
          company_id: string
          created_at: string
          data: string
          descricao: string | null
          fim_override: string | null
          id: string
          inicio_override: string | null
          updated_at: string
        }
        Insert: {
          company_id?: string
          created_at?: string
          data: string
          descricao?: string | null
          fim_override?: string | null
          id?: string
          inicio_override?: string | null
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          data?: string
          descricao?: string | null
          fim_override?: string | null
          id?: string
          inicio_override?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "holidays_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      mensagens: {
        Row: {
          atendimento_id: string
          client_id: string
          company_id: string
          content: string | null
          content_original: string | null
          created_at: string
          department_id: string | null
          direction: Database["public"]["Enums"]["direction_mensagem"]
          id: string
          media_metadata: Json | null
          media_url: string | null
          otimizado_ia: boolean | null
          reply_to_message_id: string | null
          sender_type: Database["public"]["Enums"]["sender_type"]
          sent_by_user_id: string | null
          status_envio: Database["public"]["Enums"]["status_envio_mensagem"]
          status_whatsapp:
            | Database["public"]["Enums"]["status_whatsapp_mensagem"]
            | null
          tentativas_envio: number
          tipo: Database["public"]["Enums"]["tipo_mensagem"]
          zapi_message_id: string | null
        }
        Insert: {
          atendimento_id: string
          client_id: string
          company_id?: string
          content?: string | null
          content_original?: string | null
          created_at?: string
          department_id?: string | null
          direction: Database["public"]["Enums"]["direction_mensagem"]
          id?: string
          media_metadata?: Json | null
          media_url?: string | null
          otimizado_ia?: boolean | null
          reply_to_message_id?: string | null
          sender_type: Database["public"]["Enums"]["sender_type"]
          sent_by_user_id?: string | null
          status_envio?: Database["public"]["Enums"]["status_envio_mensagem"]
          status_whatsapp?:
            | Database["public"]["Enums"]["status_whatsapp_mensagem"]
            | null
          tentativas_envio?: number
          tipo: Database["public"]["Enums"]["tipo_mensagem"]
          zapi_message_id?: string | null
        }
        Update: {
          atendimento_id?: string
          client_id?: string
          company_id?: string
          content?: string | null
          content_original?: string | null
          created_at?: string
          department_id?: string | null
          direction?: Database["public"]["Enums"]["direction_mensagem"]
          id?: string
          media_metadata?: Json | null
          media_url?: string | null
          otimizado_ia?: boolean | null
          reply_to_message_id?: string | null
          sender_type?: Database["public"]["Enums"]["sender_type"]
          sent_by_user_id?: string | null
          status_envio?: Database["public"]["Enums"]["status_envio_mensagem"]
          status_whatsapp?:
            | Database["public"]["Enums"]["status_whatsapp_mensagem"]
            | null
          tentativas_envio?: number
          tipo?: Database["public"]["Enums"]["tipo_mensagem"]
          zapi_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "mensagens_atend_same_company_fk"
            columns: ["atendimento_id", "company_id"]
            isOneToOne: false
            referencedRelation: "atendimentos"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "mensagens_atendimento_id_fkey"
            columns: ["atendimento_id"]
            isOneToOne: false
            referencedRelation: "atendimentos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mensagens_atendimento_id_fkey"
            columns: ["atendimento_id"]
            isOneToOne: false
            referencedRelation: "vw_pendentes"
            referencedColumns: ["atendimento_id"]
          },
          {
            foreignKeyName: "mensagens_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mensagens_client_same_company_fk"
            columns: ["client_id", "company_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "mensagens_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mensagens_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mensagens_dept_same_company_fk"
            columns: ["department_id", "company_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "mensagens_reply_to_message_id_fkey"
            columns: ["reply_to_message_id"]
            isOneToOne: false
            referencedRelation: "mensagens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mensagens_sent_by_user_id_fkey"
            columns: ["sent_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      mensagens_internas: {
        Row: {
          company_id: string
          content: string | null
          conversa_id: string
          created_at: string
          id: string
          media_metadata: Json | null
          sender_user_id: string
          tipo: Database["public"]["Enums"]["tipo_mensagem"]
        }
        Insert: {
          company_id?: string
          content?: string | null
          conversa_id: string
          created_at?: string
          id?: string
          media_metadata?: Json | null
          sender_user_id: string
          tipo?: Database["public"]["Enums"]["tipo_mensagem"]
        }
        Update: {
          company_id?: string
          content?: string | null
          conversa_id?: string
          created_at?: string
          id?: string
          media_metadata?: Json | null
          sender_user_id?: string
          tipo?: Database["public"]["Enums"]["tipo_mensagem"]
        }
        Relationships: [
          {
            foreignKeyName: "mensagens_internas_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mensagens_internas_conversa_id_fkey"
            columns: ["conversa_id"]
            isOneToOne: false
            referencedRelation: "conversas_internas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mensagens_internas_conversa_same_company_fk"
            columns: ["conversa_id", "company_id"]
            isOneToOne: false
            referencedRelation: "conversas_internas"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "mensagens_internas_sender_user_id_fkey"
            columns: ["sender_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      notificacoes_admin: {
        Row: {
          atendimento_id: string
          company_id: string
          created_at: string
          id: string
          lida: boolean
          mensagem_texto: string
        }
        Insert: {
          atendimento_id: string
          company_id?: string
          created_at?: string
          id?: string
          lida?: boolean
          mensagem_texto: string
        }
        Update: {
          atendimento_id?: string
          company_id?: string
          created_at?: string
          id?: string
          lida?: boolean
          mensagem_texto?: string
        }
        Relationships: [
          {
            foreignKeyName: "notificacoes_admin_atendimento_id_fkey"
            columns: ["atendimento_id"]
            isOneToOne: false
            referencedRelation: "atendimentos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notificacoes_admin_atendimento_id_fkey"
            columns: ["atendimento_id"]
            isOneToOne: false
            referencedRelation: "vw_pendentes"
            referencedColumns: ["atendimento_id"]
          },
          {
            foreignKeyName: "notificacoes_admin_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      notificacoes_colaborador_pendente: {
        Row: {
          atendimento_id: string
          company_id: string | null
          created_at: string
          department_id: string
          id: string
        }
        Insert: {
          atendimento_id: string
          company_id?: string | null
          created_at?: string
          department_id: string
          id?: string
        }
        Update: {
          atendimento_id?: string
          company_id?: string | null
          created_at?: string
          department_id?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notificacoes_colaborador_pendente_atendimento_id_fkey"
            columns: ["atendimento_id"]
            isOneToOne: false
            referencedRelation: "atendimentos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notificacoes_colaborador_pendente_atendimento_id_fkey"
            columns: ["atendimento_id"]
            isOneToOne: false
            referencedRelation: "vw_pendentes"
            referencedColumns: ["atendimento_id"]
          },
          {
            foreignKeyName: "notificacoes_colaborador_pendente_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      numeros_sem_triagem: {
        Row: {
          ativo: boolean
          company_id: string
          created_at: string
          created_by: string | null
          id: string
          nome: string | null
          numero_whatsapp: string
          updated_at: string
        }
        Insert: {
          ativo?: boolean
          company_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          nome?: string | null
          numero_whatsapp: string
          updated_at?: string
        }
        Update: {
          ativo?: boolean
          company_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          nome?: string | null
          numero_whatsapp?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "numeros_sem_triagem_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "numeros_sem_triagem_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_config: {
        Row: {
          chave: string
          updated_at: string
          valor: string
        }
        Insert: {
          chave: string
          updated_at?: string
          valor: string
        }
        Update: {
          chave?: string
          updated_at?: string
          valor?: string
        }
        Relationships: []
      }
      repasse_notificacoes: {
        Row: {
          enviada_at: string
          timeline_event_id: string
        }
        Insert: {
          enviada_at?: string
          timeline_event_id: string
        }
        Update: {
          enviada_at?: string
          timeline_event_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "repasse_notificacoes_timeline_event_id_fkey"
            columns: ["timeline_event_id"]
            isOneToOne: true
            referencedRelation: "timeline_events"
            referencedColumns: ["id"]
          },
        ]
      }
      sessoes_triagem: {
        Row: {
          ativo: boolean
          company_id: string
          created_at: string
          created_by: string | null
          id: string
          nome: string | null
          numero_whatsapp: string
          updated_at: string
        }
        Insert: {
          ativo?: boolean
          company_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          nome?: string | null
          numero_whatsapp: string
          updated_at?: string
        }
        Update: {
          ativo?: boolean
          company_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          nome?: string | null
          numero_whatsapp?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sessoes_triagem_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessoes_triagem_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      system_config: {
        Row: {
          chave: string
          company_id: string
          descricao: string | null
          tipo: Database["public"]["Enums"]["tipo_system_config"]
          updated_at: string
          updated_by: string | null
          valor: string | null
        }
        Insert: {
          chave: string
          company_id?: string
          descricao?: string | null
          tipo: Database["public"]["Enums"]["tipo_system_config"]
          updated_at?: string
          updated_by?: string | null
          valor?: string | null
        }
        Update: {
          chave?: string
          company_id?: string
          descricao?: string | null
          tipo?: Database["public"]["Enums"]["tipo_system_config"]
          updated_at?: string
          updated_by?: string | null
          valor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "system_config_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "system_config_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      template_rotacao: {
        Row: {
          chave: string
          company_id: string
          destino: string
          ultimo_indice: number
          updated_at: string
        }
        Insert: {
          chave: string
          company_id: string
          destino: string
          ultimo_indice?: number
          updated_at?: string
        }
        Update: {
          chave?: string
          company_id?: string
          destino?: string
          ultimo_indice?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "template_rotacao_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      templates_mensagem: {
        Row: {
          ativo: boolean
          chave: string
          company_id: string
          created_at: string
          id: string
          texto: string
          updated_at: string
          updated_by: string | null
          variacoes: string[]
        }
        Insert: {
          ativo?: boolean
          chave: string
          company_id?: string
          created_at?: string
          id?: string
          texto: string
          updated_at?: string
          updated_by?: string | null
          variacoes?: string[]
        }
        Update: {
          ativo?: boolean
          chave?: string
          company_id?: string
          created_at?: string
          id?: string
          texto?: string
          updated_at?: string
          updated_by?: string | null
          variacoes?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "templates_mensagem_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "templates_mensagem_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      timeline_events: {
        Row: {
          actor_user_id: string | null
          atendimento_id: string
          company_id: string
          created_at: string
          from_department_id: string | null
          id: string
          notificacao_repasse_enviada_at: string | null
          payload: Json | null
          target_user_id: string | null
          tipo_evento: Database["public"]["Enums"]["tipo_evento_timeline"]
          to_department_id: string | null
        }
        Insert: {
          actor_user_id?: string | null
          atendimento_id: string
          company_id?: string
          created_at?: string
          from_department_id?: string | null
          id?: string
          notificacao_repasse_enviada_at?: string | null
          payload?: Json | null
          target_user_id?: string | null
          tipo_evento: Database["public"]["Enums"]["tipo_evento_timeline"]
          to_department_id?: string | null
        }
        Update: {
          actor_user_id?: string | null
          atendimento_id?: string
          company_id?: string
          created_at?: string
          from_department_id?: string | null
          id?: string
          notificacao_repasse_enviada_at?: string | null
          payload?: Json | null
          target_user_id?: string | null
          tipo_evento?: Database["public"]["Enums"]["tipo_evento_timeline"]
          to_department_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "timeline_atend_same_company_fk"
            columns: ["atendimento_id", "company_id"]
            isOneToOne: false
            referencedRelation: "atendimentos"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "timeline_events_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timeline_events_atendimento_id_fkey"
            columns: ["atendimento_id"]
            isOneToOne: false
            referencedRelation: "atendimentos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timeline_events_atendimento_id_fkey"
            columns: ["atendimento_id"]
            isOneToOne: false
            referencedRelation: "vw_pendentes"
            referencedColumns: ["atendimento_id"]
          },
          {
            foreignKeyName: "timeline_events_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timeline_events_from_department_id_fkey"
            columns: ["from_department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timeline_events_target_user_id_fkey"
            columns: ["target_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timeline_events_to_department_id_fkey"
            columns: ["to_department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      user_permissions: {
        Row: {
          created_at: string
          granted_at: string
          granted_by: string | null
          id: string
          permission: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          granted_at?: string
          granted_by?: string | null
          id?: string
          permission: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          granted_at?: string
          granted_by?: string | null
          id?: string
          permission?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_permissions_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_permissions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          ativo: boolean
          created_at: string
          department_id: string | null
          disponivel: boolean
          email: string | null
          id: string
          is_superadmin: boolean
          is_system_user: boolean
          nome: string
          updated_at: string
          whatsapp: string | null
        }
        Insert: {
          ativo?: boolean
          created_at?: string
          department_id?: string | null
          disponivel?: boolean
          email?: string | null
          id?: string
          is_superadmin?: boolean
          is_system_user?: boolean
          nome: string
          updated_at?: string
          whatsapp?: string | null
        }
        Update: {
          ativo?: boolean
          created_at?: string
          department_id?: string | null
          disponivel?: boolean
          email?: string | null
          id?: string
          is_superadmin?: boolean
          is_system_user?: boolean
          nome?: string
          updated_at?: string
          whatsapp?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "users_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      vw_pendentes: {
        Row: {
          atendimento_id: string | null
          client_id: string | null
          created_at: string | null
          current_department_id: string | null
          departamento_nome: string | null
          escalated_from_department_id: string | null
          escalated_from_user_id: string | null
          last_message_at: string | null
          nome_cliente: string | null
          numero_whatsapp: string | null
          tempo_aguardando_minutos: number | null
          transferred_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "atendimentos_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "atendimentos_current_department_id_fkey"
            columns: ["current_department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "atendimentos_escalated_from_department_id_fkey"
            columns: ["escalated_from_department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "atendimentos_escalated_from_user_id_fkey"
            columns: ["escalated_from_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      abrir_conversa_interna: {
        Args: { p_outro_user_id: string }
        Returns: string
      }
      admin_list_user_whatsapps: {
        Args: never
        Returns: {
          id: string
          whatsapp: string
        }[]
      }
      alterar_papel_membro: {
        Args: {
          p_company_id: string
          p_department_id: string
          p_is_admin: boolean
          p_user_id: string
        }
        Returns: undefined
      }
      assign_pendente_a_usuario: {
        Args: { p_atendimento_id: string; p_user_id: string }
        Returns: boolean
      }
      assumir_atendimento: {
        Args: { p_atendimento_id: string }
        Returns: boolean
      }
      auth_enforcement_enabled: { Args: never; Returns: boolean }
      can_manage_config_in: { Args: { p_company_id: string }; Returns: boolean }
      can_view_all_in: { Args: { p_company_id: string }; Returns: boolean }
      claim_pendente: { Args: { p_atendimento_id: string }; Returns: boolean }
      cron_reativar_bot: { Args: never; Returns: Json }
      current_department_in: { Args: { p_company_id: string }; Returns: string }
      current_user_can_view_all: { Args: never; Returns: boolean }
      current_user_department: { Args: never; Returns: string }
      current_user_is_superadmin: { Args: never; Returns: boolean }
      dashboard_company_do_chamador: { Args: never; Returns: string }
      dashboard_engajamento: {
        Args: { p_company_id: string; p_janela_dias: number; p_to: string }
        Returns: Json
      }
      dashboard_relacionamento: {
        Args: { p_from: string; p_to: string }
        Returns: Json
      }
      dentro_da_janela_continuidade: {
        Args: { p_client_id: string }
        Returns: string
      }
      encerrar_atendimento: {
        Args: { p_atendimento_id: string; p_motivo?: string }
        Returns: boolean
      }
      enviar_mensagem_interna: {
        Args: { p_content: string; p_conversa_id: string }
        Returns: string
      }
      enviar_midia_interna: {
        Args: {
          p_content?: string
          p_conversa_id: string
          p_duracao_seg?: number
          p_file_name?: string
          p_storage_path: string
          p_tamanho_bytes?: number
          p_tipo: string
        }
        Returns: string
      }
      esta_em_horario_comercial: { Args: { ts: string }; Returns: boolean }
      get_atendimentos_parados: {
        Args: { p_tempo_min: number }
        Returns: {
          atendimento_id: string
          business_min: number
          cliente_nome: string
          cliente_numero: string
          company_id: string
          current_department_id: string
          dept_nome: string
          recipient_user_id: string
        }[]
      }
      get_atendimentos_unread_counts: {
        Args: { p_atendimento_ids: string[] }
        Returns: {
          atendimento_id: string
          unread: number
        }[]
      }
      get_grupos_unread_counts: {
        Args: { p_grupo_ids: string[] }
        Returns: {
          grupo_id: string
          unread: number
        }[]
      }
      get_my_grupos_unread_total: { Args: never; Returns: number }
      get_my_inbox_unread_total: { Args: never; Returns: number }
      get_my_internas_unread_total: { Args: never; Returns: number }
      has_permission: { Args: { flag: string }; Returns: boolean }
      is_member_of: { Args: { p_company_id: string }; Returns: boolean }
      is_owner_of: { Args: { p_company_id: string }; Returns: boolean }
      listar_colegas_internos: {
        Args: never
        Returns: {
          conversa_id: string
          department_cor: string
          department_nome: string
          disponivel: boolean
          nome: string
          user_id: string
        }[]
      }
      listar_conversas_internas: {
        Args: never
        Returns: {
          conversa_id: string
          last_message_at: string
          last_message_content: string
          last_message_de_mim: boolean
          last_message_tipo: string
          outro_department_cor: string
          outro_department_nome: string
          outro_disponivel: boolean
          outro_nome: string
          outro_user_id: string
          unread: number
        }[]
      }
      marcar_atendimento_lido: {
        Args: { p_atendimento_id: string }
        Returns: undefined
      }
      marcar_conversa_interna_lida: {
        Args: { p_conversa_id: string }
        Returns: undefined
      }
      marcar_grupo_lido: { Args: { p_grupo_id: string }; Returns: undefined }
      minutos_uteis_decorridos: {
        Args: { p_department_id: string; p_fim: string; p_inicio: string }
        Returns: number
      }
      payload_notificacao_admin: {
        Args: { p_atendimento_id: string }
        Returns: Json
      }
      pendentes_abertos_a_todos:
        | { Args: never; Returns: boolean }
        | { Args: { p_company_id: string }; Returns: boolean }
      pode_conversar_internamente: {
        Args: { p_company_id: string; p_user_id: string }
        Returns: boolean
      }
      pode_escrever_midia_interna: {
        Args: { p_object_name: string }
        Returns: boolean
      }
      proximo_horario_abertura: { Args: { ts: string }; Returns: string }
      repassar_atendimento: {
        Args: {
          p_atendimento_id: string
          p_observacao?: string
          p_to_user_id: string
        }
        Returns: boolean
      }
      ultimo_atendente_no_departamento: {
        Args: { p_client_id: string; p_department_id: string }
        Returns: string
      }
    }
    Enums: {
      close_reason:
        | "manual_atendente"
        | "manual_supervisor"
        | "automatico_inatividade"
        | "migracao_inicial"
        | "triagem_expirada_dia"
      company_role: "dono" | "administrador" | "colaborador"
      direction_mensagem: "inbound" | "outbound"
      grupo_sender_type: "participante" | "atendente" | "sistema" | "externo"
      sender_type: "cliente" | "atendente" | "bot" | "sistema" | "externo"
      status_atendimento:
        | "em_triagem"
        | "reservado"
        | "pendente"
        | "em_atendimento"
        | "encerrado"
      status_envio_mensagem:
        | "aguardando_envio"
        | "enviando"
        | "enviado"
        | "falha"
      status_whatsapp_mensagem:
        | "enviado"
        | "entregue"
        | "lido"
        | "falha_whatsapp"
      tipo_evento_timeline:
        | "criado"
        | "triagem_iniciada"
        | "triagem_concluida"
        | "atribuido"
        | "reservado"
        | "iniciado_atendimento"
        | "repassado"
        | "escalado"
        | "encerrado"
        | "reabertura_automatica"
      tipo_mensagem:
        | "texto"
        | "imagem"
        | "audio"
        | "documento"
        | "video"
        | "sticker"
        | "localizacao"
        | "contato"
      tipo_system_config: "numero" | "texto" | "booleano" | "data"
      triagem_estagio:
        | "aguardando_inicio"
        | "aguardando_departamento"
        | "aguardando_assunto"
        | "concluida"
        | "aguardando_colaborador"
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
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
      close_reason: [
        "manual_atendente",
        "manual_supervisor",
        "automatico_inatividade",
        "migracao_inicial",
        "triagem_expirada_dia",
      ],
      company_role: ["dono", "administrador", "colaborador"],
      direction_mensagem: ["inbound", "outbound"],
      grupo_sender_type: ["participante", "atendente", "sistema", "externo"],
      sender_type: ["cliente", "atendente", "bot", "sistema", "externo"],
      status_atendimento: [
        "em_triagem",
        "reservado",
        "pendente",
        "em_atendimento",
        "encerrado",
      ],
      status_envio_mensagem: [
        "aguardando_envio",
        "enviando",
        "enviado",
        "falha",
      ],
      status_whatsapp_mensagem: [
        "enviado",
        "entregue",
        "lido",
        "falha_whatsapp",
      ],
      tipo_evento_timeline: [
        "criado",
        "triagem_iniciada",
        "triagem_concluida",
        "atribuido",
        "reservado",
        "iniciado_atendimento",
        "repassado",
        "escalado",
        "encerrado",
        "reabertura_automatica",
      ],
      tipo_mensagem: [
        "texto",
        "imagem",
        "audio",
        "documento",
        "video",
        "sticker",
        "localizacao",
        "contato",
      ],
      tipo_system_config: ["numero", "texto", "booleano", "data"],
      triagem_estagio: [
        "aguardando_inicio",
        "aguardando_departamento",
        "aguardando_assunto",
        "concluida",
        "aguardando_colaborador",
      ],
    },
  },
} as const
