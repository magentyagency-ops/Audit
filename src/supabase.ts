import { createClient } from '@supabase/supabase-js'

/**
 * Client Supabase du navigateur. Seules des clés publiques transitent ici :
 * le cloisonnement réel est assuré par la RLS Supabase et par la vérification
 * du jeton côté API.
 */

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://bmguarnqwgqhzhcigdmj.supabase.co'
export const supabaseAnonKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtZ3Vhcm5xd2dxaHpoY2lnZG1qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwMDc0MTIsImV4cCI6MjEwMjU4MzQxMn0.GPxGdpr_Q1rH2OG3GUuQBoQkcPbid81ZNzUElEa9_ow'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
