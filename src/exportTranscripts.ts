// Export de toutes les transcriptions d’un audit dans une archive ZIP (sans dépendance, mode « store » sans compression).

type ExportParticipant = { name: string; role: string }
export type ExportInterview = { title: string; participants: ExportParticipant[]; date: string; transcript: string; createdAt: string }
export type ExportProject = { name: string; client: string; sector: string; missionType: string; description: string; brief: { objective: string; scope: string[]; stakeholders: string[]; keyQuestions: string[] } | null }

const encoder = new TextEncoder()
const crcTable = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0 } return table })()
function crc32(bytes: Uint8Array) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0 }
function dosDateTime(date: Date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

export function buildZip(files: { name: string; content: string }[]): Blob {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  const { time, day } = dosDateTime(new Date())
  let offset = 0
  for (const file of files) {
    const name = encoder.encode(file.name)
    const data = encoder.encode(file.content)
    const crc = crc32(data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true)
    local.setUint16(10, time, true); local.setUint16(12, day, true); local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, name.length, true); local.setUint16(28, 0, true)
    const header = new DataView(new ArrayBuffer(46))
    header.setUint32(0, 0x02014b50, true); header.setUint16(4, 20, true); header.setUint16(6, 20, true); header.setUint16(8, 0x0800, true); header.setUint16(10, 0, true)
    header.setUint16(12, time, true); header.setUint16(14, day, true); header.setUint32(16, crc, true)
    header.setUint32(20, data.length, true); header.setUint32(24, data.length, true); header.setUint16(28, name.length, true)
    header.setUint16(30, 0, true); header.setUint16(32, 0, true); header.setUint16(34, 0, true); header.setUint16(36, 0, true); header.setUint32(38, 0, true); header.setUint32(42, offset, true)
    parts.push(new Uint8Array(local.buffer), name, data)
    central.push(new Uint8Array(header.buffer), name)
    offset += 30 + name.length + data.length
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true)
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, centralSize, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true)
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[], { type: 'application/zip' })
}

const slug = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'sans-titre'
const longDate = (value: string) => value ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(new Date(`${value}T12:00:00`)) : 'Date non renseignée'
const bullets = (items: string[]) => items.length ? items.map((item) => `- ${item}`).join('\n') : '- (non renseigné)'

function contextText(project: ExportProject, interviews: ExportInterview[]) {
  const brief = project.brief
  const lines = [
    `CONTEXTE DE L’AUDIT — ${project.name}`,
    '='.repeat(60),
    '',
    `Entreprise : ${project.client || '(non renseignée)'}`,
    `Secteur : ${project.sector || '(non renseigné)'}`,
    `Type de mission : ${project.missionType || '(non renseigné)'}`,
    `Export généré le : ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' }).format(new Date())}`,
    '',
    'DESCRIPTION',
    '-'.repeat(60),
    project.description || '(aucune description)',
    '',
  ]
  if (brief) {
    lines.push('OBJECTIF', '-'.repeat(60), brief.objective || '(non renseigné)', '', 'PÉRIMÈTRE', '-'.repeat(60), bullets(brief.scope), '', 'PARTIES PRENANTES', '-'.repeat(60), bullets(brief.stakeholders), '', 'QUESTIONS CLÉS', '-'.repeat(60), bullets(brief.keyQuestions), '')
  }
  lines.push(`ENTRETIENS INCLUS (${interviews.length}, par ordre chronologique)`, '-'.repeat(60))
  interviews.forEach((item, index) => lines.push(`${String(index + 1).padStart(2, '0')}. ${longDate(item.date)} — ${item.title} — ${participantsLine(item)}`))
  lines.push('', 'Chaque entretien est fourni dans un fichier séparé (transcription intégrale, sans résumé IA).', 'Le fichier « entretiens-complets.txt » regroupe l’ensemble dans l’ordre chronologique.')
  return lines.join('\n')
}

function participantsLine(item: ExportInterview) {
  const people = item.participants.filter((person) => person.name.trim())
  return people.length ? people.map((person) => person.role.trim() ? `${person.name.trim()} (${person.role.trim()})` : person.name.trim()).join(', ') : 'Participant non renseigné'
}

function interviewText(item: ExportInterview, index: number, total: number) {
  return [
    `ENTRETIEN ${index + 1}/${total} — ${item.title}`,
    '='.repeat(60),
    `Date de l’entretien : ${longDate(item.date)}`,
    `Participant(s) : ${participantsLine(item)}`,
    '',
    'TRANSCRIPTION INTÉGRALE',
    '-'.repeat(60),
    item.transcript.trim() || '(transcription vide)',
    '',
  ].join('\n')
}

export function exportTranscripts(project: ExportProject, source: ExportInterview[]) {
  const interviews = [...source].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.createdAt.localeCompare(b.createdAt))
  const files = [{ name: '00-contexte-audit.txt', content: contextText(project, interviews) }]
  const texts = interviews.map((item, index) => interviewText(item, index, interviews.length))
  interviews.forEach((item, index) => files.push({ name: `${String(index + 1).padStart(2, '0')}-${item.date || 'sans-date'}-${slug(participantsLine(item).split(',')[0].replace(/\(.*\)/, ''))}.txt`, content: texts[index] }))
  files.push({ name: 'entretiens-complets.txt', content: [contextText(project, interviews), '', '', ...texts.map((text) => `${text}\n\n${'#'.repeat(60)}\n\n`)].join('\n') })
  const folder = `export-transcriptions-${slug(project.name)}`
  const blob = buildZip(files.map((file) => ({ ...file, name: `${folder}/${file.name}` })))
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a'); link.href = url; link.download = `${folder}.zip`; document.body.append(link); link.click(); link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 5000)
  return interviews.length
}
