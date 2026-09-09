/** Parse read-only macOS ps data and select only a private run's identities. */
export function parseProcessRows(output) {
  return output.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/)
    if (!match) return []
    return [{ pid: Number(match[1]), parentPid: Number(match[2]), started: match[3].replace(/\s+/g, ' '), command: match[4] }]
  })
}

export function sameProcessIdentity(left, right) {
  return left.pid === right.pid && left.started === right.started && left.command === right.command
}

export function ownedProcessRows(rows, profile, known = []) {
  const owned = new Map()
  for (const row of rows) {
    if (row.command.split(/\s+/).includes(`--user-data-dir=${profile}`)
      || known.some((identity) => sameProcessIdentity(identity, row))) owned.set(row.pid, row)
  }
  // Capture children while ownership is observable; later orphaned children
  // remain identifiable by exact PID/start/command, never by PID alone.
  for (let changed = true; changed;) {
    changed = false
    for (const row of rows) if (!owned.has(row.pid) && owned.has(row.parentPid)) {
      owned.set(row.pid, row); changed = true
    }
  }
  return [...owned.values()]
}
