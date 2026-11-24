import { Hono } from 'hono'
import type { AppEnv, Env } from '../types'

// ZKTeco / eSSL "ADMS" push protocol (iclock), used by the X990 punching machine.
// The machine is configured with Server = raajsoftware.com, Port = 80 and then:
//   GET  /iclock/cdata?SN=…&options=all     handshake → we reply with push options
//   POST /iclock/cdata?SN=…&table=ATTLOG    punch records, one per line:
//                                           PIN \t YYYY-MM-DD HH:MM:SS \t status \t verify \t …
//   GET  /iclock/getrequest?SN=…            poll for commands → "OK" (we never send any)
//   POST /iclock/devicecmd?SN=…             command results → "OK"
// Only machines the Principal has approved on the Devices page have their punches stored.

const app = new Hono<AppEnv>()

const text = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/plain' } })

async function touchDevice(env: Env, sn: string, ip: string | null): Promise<{ approved: boolean }> {
  await env.DB.prepare(
    `INSERT INTO devices (serial, last_seen, last_ip) VALUES (?, datetime('now'), ?)
     ON CONFLICT(serial) DO UPDATE SET last_seen = excluded.last_seen, last_ip = excluded.last_ip`,
  ).bind(sn, ip).run()
  const row = await env.DB.prepare('SELECT approved FROM devices WHERE serial = ?').bind(sn).first<{ approved: number }>()
  return { approved: !!row?.approved }
}

function serial(c: { req: { query: (k: string) => string | undefined } }): string | null {
  const sn = (c.req.query('SN') ?? c.req.query('sn') ?? '').trim()
  return /^[A-Za-z0-9_-]{3,40}$/.test(sn) ? sn : null
}

const PUNCH_RE = /^(\S{1,24})\t(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\t(\d*))?(?:\t(\d*))?/

/** Parse ATTLOG lines and store punches, linking each to the teacher with that machine ID. */
export async function storePunches(env: Env, sn: string, body: string): Promise<number> {
  const rows = body.split(/\r?\n/).map((l) => l.match(PUNCH_RE)).filter((m): m is RegExpMatchArray => !!m)
  if (!rows.length) return 0
  const stmts = rows.map(([, pin, time, status, verify]) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO punches (device_sn, device_pin, punch_time, punch_date, status, verify, user_id)
       VALUES (?, ?, ?, ?, ?, ?, (SELECT id FROM users WHERE device_pin = ?))`,
    ).bind(sn, pin, time, time.slice(0, 10), status ?? null, verify ?? null, pin))
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50))
  return rows.length
}

app.get('/cdata', async (c) => {
  const sn = serial(c)
  if (!sn) return text('ERROR')
  await touchDevice(c.env, sn, c.req.header('CF-Connecting-IP') ?? null)
  return text([
    `GET OPTION FROM: ${sn}`,
    'ATTLOGStamp=None',
    'OPERLOGStamp=9999',
    'ATTPHOTOStamp=None',
    'ErrorDelay=60',
    'Delay=30',
    'TransTimes=00:00;14:05',
    'TransInterval=1',
    'TransFlag=TransData AttLog',
    'Realtime=1',
    'Encrypt=None',
  ].join('\n'))
})

app.post('/cdata', async (c) => {
  const sn = serial(c)
  if (!sn) return text('ERROR')
  const { approved } = await touchDevice(c.env, sn, c.req.header('CF-Connecting-IP') ?? null)
  const body = await c.req.text()
  const table = (c.req.query('table') ?? '').toUpperCase()
  const lines = body.split(/\r?\n/).filter(Boolean).length
  // Unapproved machines: acknowledge (so they don't retry forever) but store nothing.
  if (table === 'ATTLOG' && approved) await storePunches(c.env, sn, body)
  return text(`OK: ${lines}`)
})

app.get('/getrequest', async (c) => {
  const sn = serial(c)
  if (sn) await touchDevice(c.env, sn, c.req.header('CF-Connecting-IP') ?? null)
  return text('OK')
})

app.post('/devicecmd', (c) => text('OK'))
app.get('/ping', (c) => text('OK'))

export default app
