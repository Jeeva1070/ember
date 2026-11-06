import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const maxSessionBatch = 50
const maxTimelinePage = 100
const maxReportDays = 366

interface IncomingSession {
  id: string
  startedAt: number
  lastActivityAt: number
  activeSeconds: number
  project: string
  languages: string[]
  eventCount: number
  dailyActiveSeconds: Record<string, number>
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authorization = request.headers.get('Authorization')
    if (!authorization?.startsWith('Bearer ')) {
      return jsonResponse({ error: 'Authorization required' }, 401)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      console.error('Required Supabase environment variables are not configured.')
      return jsonResponse({ error: 'Activity service is not configured' }, 500)
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authorization } },
    })
    const accessToken = authorization.slice('Bearer '.length)
    const { data: userData, error: authError } = await authClient.auth.getUser(accessToken)
    if (authError || !userData.user) {
      return jsonResponse({ error: 'Invalid or expired access token' }, 401)
    }

    const database = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const url = new URL(request.url)
    const route = url.pathname.replace(/\/+$/, '').split('/').at(-1)

    if (request.method === 'POST' && route === 'sync') {
      return await syncSessions(request, database, userData.user.id)
    }
    if (request.method === 'GET' && route === 'reports') {
      return await getReport(url, database, userData.user.id)
    }
    if (request.method === 'GET' && route === 'timeline') {
      return await getTimeline(url, database, userData.user.id)
    }

    return jsonResponse({ error: 'Not found' }, 404)
  }
  catch (error) {
    console.error('Activity request failed:', error)
    return jsonResponse({ error: 'Activity request failed' }, 500)
  }
})

async function syncSessions(request: Request, database: ReturnType<typeof createClient>, userId: string): Promise<Response> {
  const contentLength = Number(request.headers.get('Content-Length') ?? 0)
  if (contentLength > 1_000_000) {
    return jsonResponse({ error: 'Request body is too large' }, 413)
  }
  const rawBody = await request.text()
  if (new TextEncoder().encode(rawBody).byteLength > 1_000_000) {
    return jsonResponse({ error: 'Request body is too large' }, 413)
  }
  let parsedBody: unknown
  try {
    parsedBody = JSON.parse(rawBody)
  }
  catch {
    return jsonResponse({ error: 'Request body must be valid JSON' }, 400)
  }
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return jsonResponse({ error: 'Request body must be a JSON object' }, 400)
  }
  const body = parsedBody as { sessions?: unknown }
  if (!Array.isArray(body.sessions) || body.sessions.length === 0 || body.sessions.length > maxSessionBatch) {
    return jsonResponse({ error: `sessions must contain 1-${maxSessionBatch} items` }, 400)
  }

  const sessions: IncomingSession[] = []
  for (const candidate of body.sessions) {
    const session = validateSession(candidate)
    if (!session) {
      return jsonResponse({ error: 'Invalid session payload' }, 400)
    }
    sessions.push(session)
  }

  const { error } = await database.rpc('upsert_coding_sessions', {
    p_user_id: userId,
    p_sessions: sessions.map(session => ({
      id: session.id,
      started_at: new Date(session.startedAt).toISOString(),
      ended_at: new Date(session.lastActivityAt).toISOString(),
      active_seconds: session.activeSeconds,
      project: session.project,
      languages: session.languages,
      event_count: session.eventCount,
      daily_active_seconds: session.dailyActiveSeconds,
    })),
  })
  if (error) {
    console.error('Session upsert failed:', error.message)
    return jsonResponse({ error: 'Could not save coding activity' }, 500)
  }

  return jsonResponse({ synced: sessions.length })
}

async function getReport(url: URL, database: ReturnType<typeof createClient>, userId: string): Promise<Response> {
  const from = url.searchParams.get('from') ?? ''
  const to = url.searchParams.get('to') ?? ''
  if (!isDateKey(from) || !isDateKey(to)) {
    return jsonResponse({ error: 'from and to must use YYYY-MM-DD format' }, 400)
  }
  const fromDate = new Date(`${from}T00:00:00Z`)
  const toDate = new Date(`${to}T00:00:00Z`)
  const dayCount = (toDate.getTime() - fromDate.getTime()) / 86_400_000 + 1
  if (dayCount < 1 || dayCount > maxReportDays) {
    return jsonResponse({ error: `Date range must be between 1 and ${maxReportDays} days` }, 400)
  }

  const { data, error } = await database
    .from('coding_activity_daily')
    .select('activity_date, active_seconds, session_count')
    .eq('user_id', userId)
    .gte('activity_date', from)
    .lte('activity_date', to)
    .order('activity_date', { ascending: true })
  if (error) {
    console.error('Activity report query failed:', error.message)
    return jsonResponse({ error: 'Could not load coding activity' }, 500)
  }

  const { data: totalSessions, error: countError } = await database.rpc('count_coding_sessions', {
    p_user_id: userId,
    p_from: from,
    p_to: to,
  })
  if (countError) {
    console.error('Activity session count failed:', countError.message)
    return jsonResponse({ error: 'Could not load coding activity' }, 500)
  }

  const days = (data ?? []).map(row => ({
    date: row.activity_date,
    active_seconds: Number(row.active_seconds),
    session_count: Number(row.session_count),
  }))
  return jsonResponse({
    from,
    to,
    total_active_seconds: days.reduce((total, day) => total + day.active_seconds, 0),
    total_sessions: Number(totalSessions ?? 0),
    days,
  })
}

async function getTimeline(url: URL, database: ReturnType<typeof createClient>, userId: string): Promise<Response> {
  const from = url.searchParams.get('from') ?? ''
  const limitValue = Number(url.searchParams.get('limit') ?? 50)
  const fromDate = new Date(from)
  if (!from || Number.isNaN(fromDate.getTime()) || !Number.isInteger(limitValue) || limitValue < 1 || limitValue > maxTimelinePage) {
    return jsonResponse({ error: `from must be an ISO timestamp and limit must be 1-${maxTimelinePage}` }, 400)
  }

  let query = database
    .from('coding_sessions')
    .select('id, started_at, ended_at, active_seconds, project, languages, event_count')
    .eq('user_id', userId)
    .gte('ended_at', fromDate.toISOString())
    .order('started_at', { ascending: false })
    .limit(limitValue)
  const before = url.searchParams.get('before')
  if (before) {
    const beforeDate = new Date(before)
    if (Number.isNaN(beforeDate.getTime())) {
      return jsonResponse({ error: 'before must be an ISO timestamp' }, 400)
    }
    query = query.lt('started_at', beforeDate.toISOString())
  }

  const { data, error } = await query
  if (error) {
    console.error('Activity timeline query failed:', error.message)
    return jsonResponse({ error: 'Could not load coding timeline' }, 500)
  }
  const sessions = data ?? []
  return jsonResponse({
    sessions,
    next_before: sessions.length === limitValue ? sessions.at(-1)?.started_at ?? null : null,
  })
}

function validateSession(value: unknown): IncomingSession | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const session = value as Partial<IncomingSession>
  if (typeof session.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(session.id)
    || !Number.isSafeInteger(session.startedAt)
    || !Number.isSafeInteger(session.lastActivityAt)
    || !Number.isInteger(session.activeSeconds)
    || session.activeSeconds! < 0
    || session.activeSeconds! > 31 * 86_400
    || !Number.isInteger(session.eventCount)
    || session.eventCount! < 1
    || session.eventCount! > 1_000_000
    || typeof session.project !== 'string'
    || session.project.length > 256
    || !Array.isArray(session.languages)
    || session.languages.length > 100
    || !session.languages.every(language => typeof language === 'string' && language.length <= 64)
    || !session.dailyActiveSeconds
    || typeof session.dailyActiveSeconds !== 'object'
    || Array.isArray(session.dailyActiveSeconds)) {
    return undefined
  }

  const start = session.startedAt!
  const end = session.lastActivityAt!
  if (end < start || end > Date.now() + 5 * 60 * 1000) {
    return undefined
  }

  const dailyEntries = Object.entries(session.dailyActiveSeconds)
  if (dailyEntries.length > 370
    || dailyEntries.some(([date, seconds]) => !isDateKey(date) || !Number.isInteger(seconds) || seconds < 0 || seconds > 86_400)) {
    return undefined
  }

  return {
    id: session.id,
    startedAt: start,
    lastActivityAt: end,
    activeSeconds: session.activeSeconds!,
    project: session.project,
    languages: session.languages,
    eventCount: session.eventCount!,
    dailyActiveSeconds: session.dailyActiveSeconds as Record<string, number>,
  }
}

function isDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
